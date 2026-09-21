"""Copiar Dados / Gostei-Não gostei base (Fase B): a draft and a feedback snapshot rebuilt from a PERSISTED plan."""
from __future__ import annotations

import copy
import json

from _support import all_fixtures, load_fixture, run
from golden_prompt_v1 import ROUTER
from test_plan_v2 import POLICY_FULL, SEMANTIC_FATHER, _child_request

from creative_core import contracts
from creative_core.drafts import feedback_snapshot, generation_draft_from_plan
from creative_core.engines import plan_creative

EXECUTION_KEYS = {"job_id", "attempt", "generation_attempt", "asset", "asset_id", "usage", "trace", "organization_id", "user_id"}


def _request_from_draft(original: dict, draft: dict) -> dict:
    """What the panel would do: map the draft back onto a request (ids -> stored records). Only the fields that the
    draft carries are read; the records themselves (products, brand kit, context) come from `original`."""
    request = {
        "strategy": draft["strategy"], "product_mode": draft["product_mode"],
        "products": [p for p in original["products"] if p["id"] in draft["product_ids"]],
        "angle_id": draft["angle_id"], "placement_id": draft["placement_id"], "quality": draft["quality"],
        "persona_mode": draft["persona_mode"], "context": original["context"], "copy": draft["copy"],
        "gaze_mode": draft["gaze_mode"], "plan_schema_version": draft["plan_schema_version"], "prompt_version": draft["prompt_version"],
        "creative_id": original["creative_id"],
    }
    for key in ("brand_kit", "brand_kit_id", "niche_kit", "niche_kit_id"):
        if key in original:
            request[key] = original[key]
    if draft["persona"]:
        request["persona"] = draft["persona"]
    if draft["funnel_stage"] and draft["strategy"] == "FUNNEL_VISUAL":
        request["funnel_stage"] = draft["funnel_stage"]
    if draft["funnel"] is not None:
        request["funnel"] = draft["funnel"]
    if draft["seed"] is not None:
        request["seed"] = draft["seed"]
    return request


def test_given_a_v2_plan_then_the_draft_carries_generation_inputs_and_no_execution_ids():
    request = _child_request("PRESENTE_AFETO", semantic=SEMANTIC_FATHER, policy=POLICY_FULL, seed=100)
    plan = plan_creative(request, router=ROUTER)
    draft = generation_draft_from_plan(plan, {"trace": {"model_served": "gpt-image-2"}})
    assert contracts.validate("GenerationDraft", draft) == []
    assert draft["mode"] == "creative" and draft["objective"] == "clean_creative" and draft["angle_id"] == "PRESENTE_AFETO"
    assert draft["persona_mode"] == "custom" and draft["persona"]["label"] == "menina 6 anos"
    assert [s["role_hint"] for s in draft["subjects"]] == [None, "father"], "the recast supporting person comes along"
    assert draft["gaze_mode"] == "interaction" and draft["seed"] == 100 and draft["plan_schema_version"] == 2 and draft["prompt_version"] == 2
    assert draft["source"] == {"creative_id": plan["creative_id"], "plan_id": plan["plan_id"], "plan_schema_version": 2, "compiler_version": 1}
    assert {"subjects", "gaze_mode", "seed", "angle_id"} <= set(draft["carried"])
    assert not (EXECUTION_KEYS & set(draft)) and "trace" not in json.dumps(draft) and "gpt-image" not in json.dumps(draft)


def test_given_a_v1_plan_then_the_draft_works_too_with_no_subjects_and_an_auto_gaze():
    plan = plan_creative(load_fixture("fixture-clean-single")["input"], router=ROUTER)
    draft = generation_draft_from_plan(plan)
    assert contracts.validate("GenerationDraft", draft) == []
    assert draft["plan_schema_version"] == 1 and draft["subjects"] == [] and draft["gaze_mode"] == "auto" and draft["seed"] is None
    assert draft["source"]["compiler_version"] is None


def test_given_a_draft_then_rebuilding_the_request_from_it_reproduces_the_prompt_for_clean_and_funnel_plans():
    checked = 0
    for fixture in all_fixtures():
        original = fixture["input"]
        if original["strategy"] == "REMARKETING":
            continue
        for schema in (1, 2):
            request = {**copy.deepcopy(original), "plan_schema_version": schema}
            plan = plan_creative(request, router=ROUTER)
            draft = generation_draft_from_plan(plan)
            request2 = _request_from_draft({**request, "seed": request.get("seed")}, {**draft, "seed": request.get("seed")})
            plan2 = plan_creative(request2, router=ROUTER)
            assert plan2["prompt"]["sha256"] == plan["prompt"]["sha256"], (fixture["name"], schema)
            checked += 1
    assert checked >= 10


def test_given_a_remarketing_plan_then_the_draft_keeps_intent_and_text_options():
    fixture = next(f for f in all_fixtures() if f["input"]["strategy"] == "REMARKETING")
    plan = plan_creative({**fixture["input"], "plan_schema_version": 2}, router=ROUTER)
    draft = generation_draft_from_plan(plan)
    assert draft["remarketing"]["intent"] == plan["remarketing_intent"] and draft["objective"] == "remarketing"
    assert contracts.validate("RemarketingOptions", draft["remarketing"]) == [], "the options are valid request options"
    assert contracts.validate("GenerationDraft", draft) == []


def test_given_a_funnel_plan_then_the_draft_options_are_valid_funnel_options():
    fixture = next(f for f in all_fixtures() if f["input"]["strategy"] == "FUNNEL_VISUAL")
    draft = generation_draft_from_plan(plan_creative({**fixture["input"], "plan_schema_version": 2}, router=ROUTER))
    assert contracts.validate("FunnelOptions", draft["funnel"]) == [] and draft["funnel_stage"] in ("TOFU", "MOFU", "BOFU")


def test_given_a_persisted_plan_as_json_then_the_draft_is_the_same_as_from_the_live_plan():
    plan = plan_creative(_child_request(policy=POLICY_FULL), router=ROUTER)
    assert generation_draft_from_plan(json.loads(json.dumps(plan))) == generation_draft_from_plan(plan)


def test_given_a_plan_and_a_result_then_the_feedback_snapshot_has_what_history_needs():
    plan = plan_creative(_child_request("PRESENTE_AFETO", semantic=SEMANTIC_FATHER, policy=POLICY_FULL, seed=100), router=ROUTER)
    metadata = {"trace": {"model_requested": "gpt-image-2", "model_served": "gpt-image-2", "references": {"normalized": True}}}
    snap = feedback_snapshot(plan, metadata, asset_sha256="ab" * 32)
    assert contracts.validate("FeedbackSnapshot", snap) == []
    assert (snap["plan_schema_version"], snap["compiler_version"], snap["prompt_version"]) == (2, 1, 2)
    assert snap["angle"] == "PRESENTE_AFETO" and snap["mode"] == "creative" and snap["objective"] == "clean_creative"
    assert snap["people_count"] == 2 and snap["minor_safety_applied"] is True and snap["gaze_mode"] == "interaction"
    assert snap["subjects"][1] == {"role": "supporting", "label": "homem adulto, pai da criança", "age_band": "adult",
                                   "is_minor": False, "product_use": "none", "role_hint": "father"}
    assert snap["flags"] == {"normalize_references": True} and snap["model"] == {"requested": "gpt-image-2", "served": "gpt-image-2"}
    assert snap["asset_sha256"] == "ab" * 32 and snap["prompt_sha256"] == plan["prompt"]["sha256"]
    for panel_field in ("organization_id", "store_id", "job_id", "user_id", "verdict", "timestamp"):
        assert panel_field not in snap, f"{panel_field} is added by the panel, it is not a plan fact"


def test_given_a_v1_plan_and_no_result_then_the_snapshot_still_validates():
    plan = plan_creative(load_fixture("fixture-clean-single")["input"], router=ROUTER)
    snap = feedback_snapshot(plan)
    assert contracts.validate("FeedbackSnapshot", snap) == []
    assert snap["plan_schema_version"] == 1 and snap["compiler_version"] is None and snap["gaze_mode"] is None
    assert snap["flags"] == {"normalize_references": None} and snap["model"]["served"] is None and snap["subjects"] == []


if __name__ == "__main__":
    run(globals())
