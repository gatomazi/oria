"""Generation trace (Fase A1): what the provider call really did, recorded without changing it."""
from __future__ import annotations

import base64
import io
import json

from _support import FakeClient, FakeImages, NotFoundError, RateLimitError, _Obj, load_fixture, png_bytes, run

from creative_core import model_router as mr
from creative_core.engines import generate_creative, plan_creative

ROUTER = mr.ModelRouter(env={})


def _plan():
    return plan_creative(load_fixture("fixture-clean-single")["input"], router=ROUTER)


def _jpeg_bytes() -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (64, 80), (10, 120, 200)).save(buf, format="JPEG")
    return buf.getvalue()


class _TracedImages(FakeImages):
    """Provider double whose response carries a request id, like the SDK's."""

    def edit(self, **kwargs):
        response = super().edit(**kwargs)
        response._request_id = "req_test_123"
        return response


def _trace(result: dict) -> dict:
    return result["metadata"]["trace"]


def test_given_successful_generation_then_trace_records_model_params_prompt_and_timing():
    plan = _plan()
    client = FakeClient(images=_TracedImages())
    result = generate_creative(plan, client=client, references={r["ref"]: png_bytes() for r in plan["references"]},
                               router=ROUTER, attempt=2)
    trace = _trace(result)
    assert result["status"] == "completed"
    assert trace["trace_version"] == 1 and trace["attempt"] == 2
    assert trace["model_requested"] == "gpt-image-2" and trace["model_served"] == "gpt-image-2"
    assert trace["models_tried"] == ["gpt-image-2"]
    assert trace["params"] == {"size": plan["model"]["size"], "quality": plan["model"]["quality"]}
    assert trace["prompt"] == {"sha256": plan["prompt"]["sha256"], "version": plan["prompt"]["prompt_version"],
                               "length": len(plan["prompt"]["text"])}
    assert trace["provider_request_id"] == "req_test_123"
    assert isinstance(trace["duration_ms"], int) and isinstance(trace["provider_ms"], int)
    assert trace["outcome"] == "completed" and trace["error_code"] is None


def test_given_jpeg_reference_then_trace_shows_original_and_announced_type_differ():
    plan = _plan()
    jpeg = _jpeg_bytes()
    result = generate_creative(plan, client=FakeClient(), references={r["ref"]: jpeg for r in plan["references"]},
                               router=ROUTER)
    ref = _trace(result)["references"]
    assert ref["count"] == 1 == len(ref["items"])
    item = ref["items"][0]
    assert item["order"] == 1 and item["sent_name"] == "reference_1.png"
    assert item["original_mime"] == "image/jpeg"
    assert item["sent_mime"] == "image/png", "announced under the .png name"
    assert item["sent_actual_mime"] == "image/jpeg", "but the bytes are still JPEG (A1 changes nothing)"
    assert item["original_bytes"] == item["sent_bytes"] == len(jpeg)


def test_given_fallback_model_answers_then_trace_names_the_model_that_served():
    plan = _plan()
    router = mr.ModelRouter(env={"OPENAI_IMAGE_MODEL_FALLBACKS": "gpt-image-1"})

    class Fallback(FakeImages):
        def edit(self, **kwargs):
            if kwargs["model"] == "gpt-image-2":
                self.calls.append(kwargs)
                raise NotFoundError("no such model")
            return super().edit(**kwargs)

    result = generate_creative(plan, client=FakeClient(images=Fallback()),
                               references={r["ref"]: png_bytes() for r in plan["references"]}, router=router)
    trace = _trace(result)
    assert result["status"] == "completed"
    assert trace["model_requested"] == "gpt-image-2", "requested stays the primary"
    assert trace["model_served"] == "gpt-image-1"
    assert trace["models_tried"] == ["gpt-image-2", "gpt-image-1"]
    assert result["metadata"]["model"] == "gpt-image-2", "existing metadata field keeps its meaning"


def test_given_provider_error_then_failed_result_still_carries_the_trace():
    plan = _plan()
    client = FakeClient(images=FakeImages(error=RateLimitError("slow down")))
    result = generate_creative(plan, client=client, references={r["ref"]: png_bytes() for r in plan["references"]},
                               router=ROUTER)
    trace = _trace(result)
    assert result["status"] == "failed"
    assert trace["outcome"] == "failed" and trace["error_code"] == result["error"]["code"]
    assert trace["model_served"] is None and trace["models_tried"] == ["gpt-image-2"]
    assert isinstance(trace["provider_ms"], int)
    assert trace["references"]["count"] == 1


def test_given_missing_reference_bytes_then_trace_is_still_returned_without_a_provider_call():
    plan = _plan()
    client = FakeClient()
    result = generate_creative(plan, client=client, references={}, router=ROUTER)
    trace = _trace(result)
    assert result["status"] == "failed" and client.images.calls == []
    assert trace["outcome"] == "failed" and trace["provider_ms"] is None and trace["models_tried"] == []


def test_given_trace_then_it_never_carries_prompt_text_or_secrets():
    plan = _plan()
    result = generate_creative(plan, client=FakeClient(), references={r["ref"]: png_bytes() for r in plan["references"]},
                               router=ROUTER)
    blob = json.dumps(_trace(result), ensure_ascii=False)
    assert plan["prompt"]["text"][:80] not in blob
    assert "sk-" not in blob and "api_key" not in blob.lower()


def test_given_trace_added_then_the_provider_call_is_exactly_the_same_as_before():
    plan = _plan()
    client = FakeClient()
    generate_creative(plan, client=client, references={r["ref"]: png_bytes() for r in plan["references"]}, router=ROUTER)
    (call,) = client.images.calls
    assert set(call) == {"model", "image", "prompt", "size", "quality"}
    assert call["model"] == "gpt-image-2" and call["prompt"] == plan["prompt"]["text"]
    assert call["size"] == plan["model"]["size"] and call["quality"] == plan["model"]["quality"]
    assert [b.name for b in call["image"]] == ["reference_1.png"]


def test_given_router_run_when_a_candidate_answers_then_run_keeps_returning_only_the_result():
    router = mr.ModelRouter(env={"OPENAI_IMAGE_MODEL_FALLBACKS": "gpt-image-1"})

    def call(model):
        if model == "gpt-image-2":
            raise NotFoundError("gone")
        return _Obj(model=model)

    assert router.run(mr.IMAGE_GENERATION, call).model == "gpt-image-1"
    result, served = router.run_traced(mr.IMAGE_GENERATION, call)
    assert (result.model, served) == ("gpt-image-1", "gpt-image-1")


def test_given_result_with_trace_then_it_still_satisfies_the_creative_result_contract():
    from creative_core.contracts import validate

    plan = _plan()
    result = generate_creative(plan, client=FakeClient(), references={r["ref"]: png_bytes() for r in plan["references"]},
                               router=ROUTER)
    assert validate("CreativeResult", result) == []
    assert base64.b64decode(result["asset"]["data_base64"])[:4] == b"\x89PNG"


if __name__ == "__main__":
    run(globals())
