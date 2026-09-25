"""Reference normalization (Fase A2): real PNG, EXIF-oriented, never resized — and strictly opt-in."""
from __future__ import annotations

import base64
import io
import json

from _support import FakeClient, load_fixture, png_bytes, run
from test_service import KEY, TOKEN, Factory, _call

from creative_core import model_router as mr
from creative_core.assets import MAX_REFERENCE_PIXELS, ReferenceNormalizationError, normalize_reference_png
from creative_core.engines import generate_creative, plan_creative
from creative_core.model_router import ModelRouter
from creative_core.service import CreativeCoreService, create_app

ROUTER = mr.ModelRouter(env={})


def _image_bytes(fmt: str, size=(64, 80), mode="RGB", color=(200, 30, 30), **save_kwargs) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new(mode, size, color).save(buf, format=fmt, **save_kwargs)
    return buf.getvalue()


def _jpeg_with_orientation(orientation: int, size=(64, 32)) -> bytes:
    from PIL import Image

    exif = Image.Exif()
    exif[0x0112] = orientation
    return _image_bytes("JPEG", size=size, exif=exif)


def _open(buf: io.BytesIO):
    from PIL import Image

    return Image.open(io.BytesIO(buf.getvalue()))


def _plan():
    return plan_creative(load_fixture("fixture-clean-single")["input"], router=ROUTER)


def _generate(reference: bytes, **kwargs):
    plan = _plan()
    client = FakeClient()
    result = generate_creative(plan, client=client, references={r["ref"]: reference for r in plan["references"]},
                               router=ROUTER, **kwargs)
    return result, client


def test_given_jpeg_when_normalized_then_bytes_are_a_real_png_with_the_same_pixels():
    jpeg = _image_bytes("JPEG", size=(120, 90))
    buf, info = normalize_reference_png(jpeg, "reference_1.png")
    assert buf.getvalue()[:8] == b"\x89PNG\r\n\x1a\n" and buf.name == "reference_1.png"
    assert _open(buf).format == "PNG" and _open(buf).size == (120, 90)
    assert (info["width"], info["height"], info["mode_in"], info["mode_out"]) == (120, 90, "RGB", "RGB")


def test_given_large_image_when_normalized_then_it_is_never_resized():
    buf, info = normalize_reference_png(_image_bytes("PNG", size=(3000, 2000)))
    assert _open(buf).size == (3000, 2000) == (info["width"], info["height"])


def test_given_exif_orientation_when_normalized_then_pixels_are_rotated_upright():
    buf, info = normalize_reference_png(_jpeg_with_orientation(6, size=(64, 32)))
    assert _open(buf).size == (32, 64), "orientation 6 swaps width and height"
    assert info["exif_orientation"] == 6
    upright, info_ok = normalize_reference_png(_jpeg_with_orientation(1, size=(64, 32)))
    assert _open(upright).size == (64, 32) and info_ok["exif_orientation"] == 1


def test_given_webp_alpha_png_and_palette_png_then_modes_are_kept_or_lifted_to_rgba():
    webp, _ = normalize_reference_png(_image_bytes("WEBP"))
    assert _open(webp).format == "PNG"
    rgba, info = normalize_reference_png(_image_bytes("PNG", mode="RGBA", color=(1, 2, 3, 128)))
    assert info["mode_out"] == "RGBA" and _open(rgba).getpixel((0, 0)) == (1, 2, 3, 128), "alpha is preserved"
    palette, info_p = normalize_reference_png(_image_bytes("PNG", mode="P", color=5))
    assert info_p["mode_in"] == "P" and info_p["mode_out"] == "RGBA"


def test_given_corrupt_or_oversized_input_then_normalization_raises_a_safe_reason():
    for data, reason in ((b"\x89PNG\r\n\x1a\nnot really", "undecodable"), (b"", "undecodable")):
        try:
            normalize_reference_png(data)
        except ReferenceNormalizationError as exc:
            assert exc.reason == reason
        else:
            raise AssertionError("accepted a corrupt image")
    from PIL import Image

    side = int(MAX_REFERENCE_PIXELS ** 0.5) + 10
    bomb = io.BytesIO()
    Image.new("1", (side, side)).save(bomb, format="PNG")
    try:
        normalize_reference_png(bomb.getvalue())
    except ReferenceNormalizationError as exc:
        assert exc.reason == "image_too_large"
    else:
        raise AssertionError("accepted an image over the pixel ceiling")


def test_given_default_engine_call_then_original_jpeg_bytes_still_go_out_under_a_png_name():
    jpeg = _image_bytes("JPEG")
    result, client = _generate(jpeg)
    (sent,) = client.images.calls[0]["image"]
    assert sent.getvalue() == jpeg and sent.name == "reference_1.png", "legacy behavior preserved"
    item = result["metadata"]["trace"]["references"]["items"][0]
    assert item["normalized"] is False and item["sent_mime"] == "image/png" and item["sent_actual_mime"] == "image/jpeg"
    assert result["metadata"]["trace"]["references"]["normalized"] is False


def test_given_normalize_flag_then_png_bytes_go_out_and_trace_shows_matching_types():
    jpeg = _jpeg_with_orientation(6, size=(64, 32))
    result, client = _generate(jpeg, normalize_references=True)
    (sent,) = client.images.calls[0]["image"]
    assert result["status"] == "completed"
    assert sent.getvalue()[:4] == b"\x89PNG" and sent.name == "reference_1.png"
    trace = result["metadata"]["trace"]["references"]
    item = trace["items"][0]
    assert trace["normalized"] is True and item["normalized"] is True
    assert item["original_mime"] == "image/jpeg" and item["sent_mime"] == item["sent_actual_mime"] == "image/png"
    assert item["original_bytes"] == len(jpeg) and item["sent_bytes"] == len(sent.getvalue())
    assert (item["width"], item["height"], item["exif_orientation"]) == (32, 64, 6)


def test_given_normalize_flag_and_undecodable_reference_then_generation_fails_before_the_provider_call():
    result, client = _generate(b"\x89PNG\r\n\x1a\ngarbage", normalize_references=True)
    assert result["status"] == "failed" and result["error"]["code"] == "INVALID_REFERENCE"
    assert result["error"]["details"]["reason"] == "undecodable"
    assert client.images.calls == [], "no silent fallback to the original bytes"


def test_given_flag_on_or_off_then_prompt_size_quality_and_model_are_identical():
    off, c_off = _generate(png_bytes())
    on, c_on = _generate(png_bytes(), normalize_references=True)
    a, b = c_off.images.calls[0], c_on.images.calls[0]
    assert {k: a[k] for k in ("model", "prompt", "size", "quality")} == {k: b[k] for k in ("model", "prompt", "size", "quality")}
    assert off["asset"]["sha256"] == on["asset"]["sha256"]


def _generation_body(plan: dict, **extra) -> dict:
    refs = [{"ref": r["ref"], "data_base64": base64.b64encode(_image_bytes("JPEG")).decode()} for r in plan["references"]]
    return {"plan": plan, "references": refs, "openai_api_key": KEY, **extra}


def _service(normalize: bool):
    factory = Factory()
    return CreativeCoreService(TOKEN, client_factory=factory, router=ModelRouter(env={}), normalize_references=normalize), factory


def test_given_service_flag_then_it_is_the_default_and_a_request_can_override_it():
    for default, override, expected in ((False, None, False), (True, None, True), (False, True, True), (True, False, False)):
        app, factory = _service(default)
        plan = _call(app, "POST", "/v1/plans", {"request": load_fixture("fixture-clean-single")["input"]})[1]["plan"]
        extra = {} if override is None else {"normalize_references": override}
        status, body, _ = _call(app, "POST", "/v1/generations", _generation_body(plan, **extra))
        assert status == 200 and body["result"]["metadata"]["trace"]["references"]["normalized"] is expected
        sent = factory.client.images.calls[0]["image"][0].getvalue()
        assert (sent[:4] == b"\x89PNG") is expected, "JPEG stays JPEG unless normalized"


def test_given_non_boolean_override_then_service_rejects_it_before_any_provider_call():
    app, factory = _service(False)
    plan = _call(app, "POST", "/v1/plans", {"request": load_fixture("fixture-clean-single")["input"]})[1]["plan"]
    status, body, _ = _call(app, "POST", "/v1/generations", _generation_body(plan, normalize_references="yes"))
    assert status == 422 and body["error"]["code"] == "INVALID_INPUT"
    assert factory.client.images.calls == [] and factory.keys == []


def test_given_env_flag_then_create_app_reads_it():
    import os

    saved = {k: os.environ.get(k) for k in ("CREATIVE_CORE_SERVICE_TOKEN", "CREATIVE_NORMALIZE_REFERENCES")}
    try:
        os.environ["CREATIVE_CORE_SERVICE_TOKEN"] = TOKEN
        for value, expected in (("1", True), ("TRUE", True), ("on", True), ("0", False), ("", False), ("nope", False)):
            os.environ["CREATIVE_NORMALIZE_REFERENCES"] = value
            assert create_app()._normalize_references is expected, value
        del os.environ["CREATIVE_NORMALIZE_REFERENCES"]
        assert create_app()._normalize_references is False
    finally:
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def test_given_trace_with_normalization_then_it_stays_free_of_prompt_text():
    result, _ = _generate(_image_bytes("JPEG"), normalize_references=True)
    assert _plan()["prompt"]["text"][:60] not in json.dumps(result["metadata"]["trace"], ensure_ascii=False)


if __name__ == "__main__":
    run(globals())
