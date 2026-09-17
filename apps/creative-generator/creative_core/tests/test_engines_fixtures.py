"""Public engines against the 7 integration fixtures + engine business rules."""
from __future__ import annotations

import copy
import json

from _support import (
    AuthenticationError,
    FakeClient,
    FakeImages,
    FakeResponses,
    NotFoundError,
    all_fixtures,
    dig,
    load_fixture,
    png_bytes,
    run,
)

from creative_core import model_router as mr
from creative_core.contracts import validate
from creative_core.engines import build_copy_prompt, generate_copy, generate_creative, plan_creative
from creative_core.errors import GenerationError

EXPECTED_FIXTURES = {
    "fixture-clean-single", "fixture-clean-multi", "fixture-remarketing-single", "fixture-remarketing-multi",
    "fixture-funnel-tofu-single", "fixture-funnel-mofu-multi", "fixture-funnel-bofu-single",
}
ROUTER = mr.ModelRouter(env={})


def _refs(plan: dict) -> dict:
    return {r["ref"]: png_bytes() for r in plan["references"]}


def _expect_error(code: str, request: dict) -> GenerationError:
    try:
        plan_creative(request, router=ROUTER)
    except GenerationError as err:
        assert err.code == code, f"expected {code}, got {err.code} {err.details}"
        return err
    raise AssertionError(f"expected {code}")


# ─── fixtures ─────────────────────────────────────────────────────────────────

def test_given_fixture_folder_then_the_7_minimum_fixtures_exist():
    assert {f["name"] for f in all_fixtures()} == EXPECTED_FIXTURES


def test_given_each_fixture_when_planned_then_expected_plan_fields_match():
    for fx in all_fixtures():
        plan = plan_creative(fx["input"], router=ROUTER)
        assert validate("CreativePlan", plan) == [], fx["name"]
        for path, expected in fx["expected_plan"].items():
            actual = dig(plan, path)
            assert actual == expected, f"{fx['name']}: {path} = {actual!r}, expected {expected!r}"


def test_given_each_fixture_when_planned_then_declared_validations_pass():
    for fx in all_fixtures():
        plan = plan_creative(fx["input"], router=ROUTER)
        by_rule = {v["rule"]: v["passed"] for v in plan["validations"]}
        for rule in fx["validations"]:
            assert by_rule.get(rule) is True, f"{fx['name']}: {rule} -> {by_rule.get(rule)}"


def test_given_each_fixture_when_planned_then_prompt_content_rules_hold():
    for fx in all_fixtures():
        text = plan_creative(fx["input"], router=ROUTER)["prompt"]["text"]
        for needle in fx["prompt_must_contain"]:
            assert needle in text, f"{fx['name']}: missing {needle!r}"
        for needle in fx["prompt_must_not_contain"]:
            assert needle not in text, f"{fx['name']}: must not contain {needle!r}"
        assert "{" not in text.replace("{\"", ""), f"{fx['name']}: unresolved placeholder"


def test_given_each_fixture_when_generated_with_fake_client_then_expected_output_matches():
    for fx in all_fixtures():
        plan = plan_creative(fx["input"], router=ROUTER)
        client = FakeClient()
        result = generate_creative(plan, client=client, references=_refs(plan), router=ROUTER, now="2026-09-14T00:00:00+00:00")
        assert validate("CreativeResult", result) == [], (fx["name"], validate("CreativeResult", result))
        for path, expected in fx["expected_output"].items():
            assert dig(result, path) == expected, f"{fx['name']}: {path} = {dig(result, path)!r}"
        call = client.images.calls[0]
        assert call["prompt"] == plan["prompt"]["text"] and call["size"] == plan["model"]["size"]
        assert len(call["image"]) == len(plan["references"])


def test_given_same_request_when_planned_twice_then_plan_is_identical():
    fx = load_fixture("fixture-remarketing-multi")
    assert plan_creative(fx["input"], router=ROUTER) == plan_creative(fx["input"], router=ROUTER)


def test_given_prompt_when_planned_then_sections_follow_canonical_order():
    plan = plan_creative(load_fixture("fixture-funnel-bofu-single")["input"], router=ROUTER)
    names = [s["name"] for s in plan["prompt"]["sections"]]
    assert names == ["core_rules", "strategy_rules", "brand_kit", "niche_kit", "context_profile", "product",
                     "angle", "persona", "placement", "strategy_communication", "avoid"], names


# ─── clean angles ─────────────────────────────────────────────────────────────

def test_given_clean_angles_with_overlay_options_then_rejected():
    request = copy.deepcopy(load_fixture("fixture-clean-single")["input"])
    request["funnel"] = {"headline": "Compre já"}
    _expect_error("INVALID_INPUT", request)


def test_given_clean_angles_every_angle_then_no_overlay_ever():
    base = load_fixture("fixture-clean-single")["input"]
    for angle in ("IDENTIDADE_ORIGEM", "CABIDE", "PRODUTO_ESTAMPA", "CLOSE_BOLSO", "PRESENTE_AFETO"):
        request = copy.deepcopy(base)
        request["angle_id"] = angle
        plan = plan_creative(request, router=ROUTER)
        assert plan["overlay"]["allowed"] is False and plan["funnel_stage"] is None
        assert "TEXTO NO CRIATIVO" not in plan["prompt"]["text"], angle


# ─── product mode ─────────────────────────────────────────────────────────────

def test_given_single_product_mode_with_two_products_then_out_of_range():
    request = copy.deepcopy(load_fixture("fixture-clean-multi")["input"])
    request["product_mode"] = "single_product"
    _expect_error("PRODUCT_COUNT_OUT_OF_RANGE", request)


def test_given_multi_product_mode_with_one_product_then_out_of_range():
    request = copy.deepcopy(load_fixture("fixture-clean-single")["input"])
    request["product_mode"] = "multi_product"
    _expect_error("PRODUCT_COUNT_OUT_OF_RANGE", request)


def test_given_duplicate_product_ids_then_invalid_product():
    request = copy.deepcopy(load_fixture("fixture-clean-multi")["input"])
    request["products"][1]["id"] = request["products"][0]["id"]
    _expect_error("INVALID_PRODUCT", request)


def test_given_apparel_angle_for_non_apparel_niche_then_unsupported_angle():
    request = copy.deepcopy(load_fixture("fixture-clean-multi")["input"])
    request["angle_id"] = "CABIDE"
    _expect_error("UNSUPPORTED_ANGLE", request)


# ─── remarketing ──────────────────────────────────────────────────────────────

def _rmk_multi(intent: str, n: int = 3, source: str | None = None) -> dict:
    request = copy.deepcopy(load_fixture("fixture-remarketing-multi")["input"])
    request["products"] = request["products"][:n] if n <= 4 else request["products"] + [
        {"id": f"extra-{i}", "name": f"Extra {i}", "type": "top fitness", "referenceImages": [f"fit/p/extra-{i}.png"]}
        for i in range(n - 4)
    ]
    request["remarketing"] = {"intent": intent}
    if source:
        request["remarketing"]["products_source"] = source
    return request


def test_given_product_view_multi_then_unsupported_product_mode():
    err = _expect_error("UNSUPPORTED_PRODUCT_MODE", _rmk_multi("product_view"))
    assert err.details["reason"] == "single_product_intent"


def test_given_cart_multi_from_catalog_then_rejected_but_from_real_basket_then_allowed():
    _expect_error("UNSUPPORTED_PRODUCT_MODE", _rmk_multi("cart", 3))
    for intent in ("cart", "checkout"):
        for n in (2, 3, 4):
            plan = plan_creative(_rmk_multi(intent, n, "basket"), router=ROUTER)
            assert plan["product_mode"] == "multi_product" and plan["layout"], (intent, n)


def test_given_allowed_intents_multi_then_layout_fits_product_count():
    for intent in ("site_visitor", "collection_discovery", "social_proof", "objection"):
        for n in (2, 3):
            request = _rmk_multi(intent, n)
            request["angle_id"] = "PERTENCIMENTO"
            plan = plan_creative(request, router=ROUTER)
            assert plan["layout"] in ("hero_support_models", "multi_model_same_scene"), (intent, n, plan["layout"])


def test_given_remarketing_with_6_products_then_out_of_range():
    _expect_error("PRODUCT_COUNT_OUT_OF_RANGE", _rmk_multi("collection_discovery", 6))


def test_given_social_proof_without_real_facts_then_prompt_forbids_fabrication():
    request = _rmk_multi("social_proof", 2)
    request["angle_id"] = "PERTENCIMENTO"
    text = plan_creative(request, router=ROUTER)["prompt"]["text"]
    assert "SEM prova real informada" in text


# ─── funnel ───────────────────────────────────────────────────────────────────

def test_given_funnel_without_stage_then_invalid_input():
    request = copy.deepcopy(load_fixture("fixture-funnel-tofu-single")["input"])
    del request["funnel_stage"]
    _expect_error("INVALID_INPUT", request)


def test_given_tofu_with_badges_and_chips_then_they_are_dropped():
    request = copy.deepcopy(load_fixture("fixture-funnel-tofu-single")["input"])
    request["funnel"] = {"badges": ["Frete grátis"], "chips": ["A"], "search_bar_text": "busca"}
    plan = plan_creative(request, router=ROUTER)
    assert plan["overlay"]["badges"] == [] and plan["overlay"]["chips"] == [] and plan["overlay"]["search_bar_text"] is None


def test_given_funnel_without_benefits_then_none_are_invented():
    for stage in ("TOFU", "MOFU", "BOFU"):
        request = copy.deepcopy(load_fixture("fixture-funnel-tofu-single")["input"])
        request["funnel_stage"] = stage
        plan = plan_creative(request, router=ROUTER)
        assert plan["overlay"]["benefits"] == [] and plan["overlay"]["badges"] == [], stage


# ─── generation / errors ──────────────────────────────────────────────────────

def test_given_provider_auth_error_with_secret_then_failed_result_without_leak():
    plan = plan_creative(load_fixture("fixture-clean-single")["input"], router=ROUTER)
    client = FakeClient(images=FakeImages(error=AuthenticationError("Incorrect API key: sk-live-SECRET")))
    result = generate_creative(plan, client=client, references=_refs(plan), router=ROUTER)
    assert result["status"] == "failed" and result["asset"] is None
    assert result["error"]["code"] == "MODEL_AUTHENTICATION_FAILED"
    assert "SECRET" not in json.dumps(result)


def test_given_missing_reference_bytes_then_failed_invalid_reference_without_provider_call():
    plan = plan_creative(load_fixture("fixture-clean-multi")["input"], router=ROUTER)
    client = FakeClient()
    result = generate_creative(plan, client=client, references={}, router=ROUTER)
    assert result["error"]["code"] == "INVALID_REFERENCE" and client.images.calls == []


def test_given_retry_attempt_then_result_keeps_creative_id_and_attempt():
    plan = plan_creative(load_fixture("fixture-clean-single")["input"], router=ROUTER)
    result = generate_creative(plan, client=FakeClient(), references=_refs(plan), router=ROUTER, attempt=3)
    assert result["creative_id"] == plan["creative_id"] and result["generation_attempt"] == 3


def test_given_primary_model_not_found_then_router_falls_back():
    router = mr.ModelRouter(env={"OPENAI_IMAGE_MODEL_FALLBACKS": "gpt-image-1"})
    plan = plan_creative(load_fixture("fixture-clean-single")["input"], router=router)

    class FlakyImages(FakeImages):
        def edit(self, **kwargs):
            if kwargs["model"] == "gpt-image-2":
                self.calls.append(kwargs)
                raise NotFoundError("model not found")
            return super().edit(**kwargs)

    client = FakeClient(images=FlakyImages())
    result = generate_creative(plan, client=client, references=_refs(plan), router=router)
    assert result["status"] == "completed"
    assert [c["model"] for c in client.images.calls] == ["gpt-image-2", "gpt-image-1"]


def test_given_invalid_plan_then_failed_result_not_exception():
    result = generate_creative({"plan_id": "x"}, client=FakeClient(), references={}, router=ROUTER)
    assert result["status"] == "failed" and result["error"]["code"] == "INVALID_INPUT"


# ─── copy ─────────────────────────────────────────────────────────────────────

def test_given_clean_request_when_copy_generated_then_variants_per_stage():
    request = load_fixture("fixture-clean-single")["input"]
    payload = {"variants": [
        {"funnel_stage": s, "primary_text": f"texto {s}", "headline": f"h {s}", "description": "d"}
        for s in ("TOFU", "MOFU", "BOFU")
    ]}
    client = FakeClient(responses=FakeResponses(output_text="aqui: " + json.dumps(payload)))
    variants = generate_copy(request, client=client, router=ROUTER)
    assert [v["funnel_stage"] for v in variants] == ["TOFU", "MOFU", "BOFU"]
    assert client.responses.calls[0]["model"] == "gpt-5.6"
    assert "A headline é do anúncio, não da imagem" in build_copy_prompt(request)


def test_given_unparseable_copy_then_generation_failed():
    request = load_fixture("fixture-clean-single")["input"]
    try:
        generate_copy(request, client=FakeClient(responses=FakeResponses(output_text="sem json")), router=ROUTER)
    except GenerationError as err:
        assert err.code == "GENERATION_FAILED"
    else:
        raise AssertionError("expected GENERATION_FAILED")


if __name__ == "__main__":
    run(globals())
