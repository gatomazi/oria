"""Prompt Builder, Model Router, generation history, references and assets."""
from __future__ import annotations

import base64
import tempfile
from pathlib import Path

from _support import AuthenticationError, NotFoundError, load_fixture, png_bytes, run

from creative_core import model_router as mr
from creative_core.assets import asset_from_provider_b64, redimensionar_cover
from creative_core.contracts import validate
from creative_core.engines import plan_creative
from creative_core.errors import GenerationError
from creative_core.history import JsonlHistoryStore, build_record, record_from_plan
from creative_core.prompt_builder import CANONICAL_ORDER, PromptBuilder
from creative_core.references import decode_reference, reference_roles


# ─── prompt builder ───────────────────────────────────────────────────────────

def test_given_sections_out_of_order_when_ordered_then_canonical_order_is_used():
    b = PromptBuilder(separator="|")
    b.add("avoid", "A").add("core_rules", "C").add("product", "P").add("custom_extra", "X")
    assert b.build() == "C|P|A|X"
    assert [s["name"] for s in b.sections()] == ["core_rules", "product", "avoid", "custom_extra"]


def test_given_unordered_builder_then_output_equals_plain_concatenation():
    parts = [("core_rules", "R"), ("references", ""), ("angle", "\n\nT"), ("angle_rules", "Z")]
    b = PromptBuilder(ordered=False)
    for name, text in parts:
        b.add(name, text)
    assert b.build() == "R" + "" + "\n\nT" + "Z"
    assert [s["name"] for s in b.sections()] == ["core_rules", "angle", "angle_rules"]


def test_given_builder_info_then_hash_and_version_are_recorded():
    info = PromptBuilder().add("core_rules", "abc").info(prompt_version=7)
    assert info["prompt_version"] == 7 and len(info["sha256"]) == 64 and info["text"] == "abc"


def test_given_canonical_order_then_matches_spec_section_24():
    assert CANONICAL_ORDER == ("core_rules", "strategy_rules", "brand_kit", "niche_kit", "context_profile",
                               "product", "angle", "persona", "placement", "strategy_communication", "avoid")


# ─── model router ─────────────────────────────────────────────────────────────

def test_given_no_env_then_defaults_are_the_generator_models():
    router = mr.ModelRouter(env={})
    assert router.model_for(mr.IMAGE_GENERATION) == "gpt-image-2"
    for task in (mr.COPY, mr.STRUCTURED_OUTPUT, mr.CONTEXT_INTELLIGENCE, mr.PROMPT_PLANNING, mr.VISION_QA):
        assert router.model_for(task) == "gpt-5.6"


def test_given_env_and_tenant_overrides_then_override_wins_over_env():
    router = mr.ModelRouter(overrides={mr.COPY: "tenant-model"}, env={"OPENAI_TEXT_MODEL": "env-model"})
    assert router.model_for(mr.COPY) == "tenant-model"
    assert router.model_for(mr.VISION_QA) == "env-model"


def test_given_auth_error_then_router_does_not_try_fallback():
    router = mr.ModelRouter(env={"OPENAI_TEXT_MODEL_FALLBACKS": "backup"})
    calls = []

    def call(model):
        calls.append(model)
        raise AuthenticationError("bad key")

    try:
        router.run(mr.COPY, call)
    except AuthenticationError:
        pass
    assert calls == ["gpt-5.6"]


def test_given_every_candidate_not_found_then_last_error_is_raised():
    router = mr.ModelRouter(env={"OPENAI_TEXT_MODEL_FALLBACKS": "b1, b2"})
    calls = []

    def call(model):
        calls.append(model)
        raise NotFoundError(model)

    try:
        router.run(mr.COPY, call)
    except NotFoundError:
        pass
    assert calls == ["gpt-5.6", "b1", "b2"]


# ─── history ──────────────────────────────────────────────────────────────────

def test_given_partial_fields_when_record_built_then_every_field_present_and_nulls_kept():
    record = build_record(strategy="ORGANIC", angle=None, loja="regional")
    assert validate("GenerationRecord", record) == []
    assert record["funnel_stage"] is None and record["remarketing_intent"] is None
    assert record["schema_version"] == 1 and record["core_version"] and record["prompt_version"] == 1
    assert record["extra"] == {"loja": "regional"}


def test_given_plan_when_record_derived_then_versions_and_product_mode_are_recorded():
    plan = plan_creative(load_fixture("fixture-remarketing-multi")["input"], router=mr.ModelRouter(env={}))
    record = record_from_plan(plan, asset="tenant/t1/creatives/c1/image.png")
    assert record["product_mode"] == "multi_product" and record["remarketing_intent"] == "collection_discovery"
    assert record["brand_kit"] == "fitness_brand_x" and record["context_profile_version"] == 2
    assert record["product_ids"] == ["top-azul", "top-verde", "legging-preta", "shorts-cinza"]
    assert validate("GenerationRecord", record) == []


def test_given_store_when_appending_then_reads_back_and_rejects_invalid():
    with tempfile.TemporaryDirectory() as tmp:
        store = JsonlHistoryStore(Path(tmp) / "h" / "generations.jsonl")
        store.append(build_record(strategy="CLEAN_ANGLES", persona="p1"))
        store.append(build_record(strategy="CLEAN_ANGLES", persona="p2"))
        assert [r["persona"] for r in store.read()] == ["p1", "p2"]
        assert store.recent_values("persona", limit=1) == ["p2"]
        try:
            store.append({"strategy": "x"})
        except ValueError:
            pass
        else:
            raise AssertionError("invalid record accepted")


# ─── references / assets ──────────────────────────────────────────────────────

def test_given_png_jpeg_and_garbage_when_decoding_then_only_images_accepted():
    raw, mime = decode_reference(base64.b64encode(png_bytes()).decode())
    assert mime == "image/png" and raw.startswith(b"\x89PNG")
    for bad in ("not-base64!!", base64.b64encode(b"<svg></svg>").decode(), ""):
        try:
            decode_reference(bad)
        except GenerationError as err:
            assert err.code == "INVALID_REFERENCE"
        else:
            raise AssertionError(f"accepted {bad[:10]}")


def test_given_products_then_reference_roles_follow_product_order():
    roles = reference_roles([
        {"id": "a", "referenceImages": ["a1", "a2"]},
        {"id": "b", "referenceImages": ["b1"]},
    ])
    assert [(r["ref"], r["order"], r["product_id"]) for r in roles] == [("a1", 1, "a"), ("a2", 2, "a"), ("b1", 3, "b")]
    assert {r["role"] for r in roles} == {"product_art"}


def test_given_provider_image_in_other_ratio_then_asset_has_exact_placement_size():
    b64 = base64.b64encode(png_bytes(1024, 1536)).decode()
    asset = asset_from_provider_b64(b64, 1080, 1920)
    assert (asset["width"], asset["height"]) == (1080, 1920)
    from PIL import Image
    import io
    img = Image.open(io.BytesIO(base64.b64decode(asset["data_base64"])))
    assert img.size == (1080, 1920)
    assert redimensionar_cover(png_bytes(100, 100), 40, 50)[:8] == b"\x89PNG\r\n\x1a\n"


if __name__ == "__main__":
    run(globals())
