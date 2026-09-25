"""Copiar Dados / Gostei-Não gostei base (Fase B): a draft and a feedback snapshot rebuilt from a PERSISTED plan."""
from __future__ import annotations

import copy
import json
from pathlib import Path

from _support import all_fixtures, load_fixture, run
from golden_prompt_v1 import ROUTER
from test_plan_v2 import POLICY_FULL, SEMANTIC_FATHER, _child_request

from creative_core import contracts
from creative_core.drafts import feedback_snapshot, generation_draft_from_plan
from creative_core.engines import plan_creative
from creative_core.versions import COMPILER_VERSION

EXECUTION_KEYS = {"job_id", "attempt", "generation_attempt", "asset", "asset_id", "usage", "trace", "organization_id", "user_id"}


def _request_from_draft(original: dict, draft: dict, action: str | None = None) -> dict:
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
    if draft["subjects"]:
        request["subjects"] = copy.deepcopy(draft["subjects"])
    if draft["interaction"]:
        request["interaction"] = draft["interaction"]
    if draft["scene_picks"]:
        request["scene_picks"] = dict(draft["scene_picks"])
    if action:  # "again" / "variation": a patch over the draft's own fields (a null drops the field)
        for key, value in draft["actions"][action].items():
            if value is None or (key == "gaze_mode" and value == "auto"):
                request.pop(key, None)
            else:
                request[key] = value
        if action == "variation":
            request.pop("creative_id", None)
    return request


def test_given_a_v2_plan_then_the_draft_carries_generation_inputs_and_no_execution_ids():
    request = _child_request("PRESENTE_AFETO", semantic=SEMANTIC_FATHER, policy=POLICY_FULL, seed=100)
    plan = plan_creative(request, router=ROUTER)
    draft = generation_draft_from_plan(plan, {"trace": {"model_served": "gpt-image-2"}})
    assert contracts.validate("GenerationDraft", draft) == []
    assert draft["mode"] == "creative" and draft["objective"] == "clean_creative" and draft["angle_id"] == "PRESENTE_AFETO"
    assert draft["persona_mode"] == "custom" and draft["persona"]["label"] == "menina 6 anos"
    assert draft["subjects"] == [] and draft["interaction"] is None, "a cast the planner drew is rederived from the product's semantics + seed"
    assert [s["role_hint"] for s in plan["subjects"]] == [None, "father"]
    assert draft["gaze_mode"] == "interaction" and draft["seed"] == 100 and draft["plan_schema_version"] == 2 and draft["prompt_version"] == 2
    assert draft["source"] == {"creative_id": plan["creative_id"], "plan_id": plan["plan_id"], "plan_schema_version": 2, "compiler_version": COMPILER_VERSION}
    assert {"gaze_mode", "seed", "angle_id"} <= set(draft["carried"])
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
    assert (snap["plan_schema_version"], snap["compiler_version"], snap["prompt_version"]) == (2, COMPILER_VERSION, 2)
    assert snap["angle"] == "PRESENTE_AFETO" and snap["mode"] == "creative" and snap["objective"] == "clean_creative"
    assert snap["people_count"] == 2 and snap["minor_safety_applied"] is True and snap["gaze_mode"] == "interaction"
    assert snap["subjects"][1] == {"role": "supporting", "label": "homem adulto, pai da criança", "age_band": "adult",
                                   "is_minor": False, "product_use": "none", "role_hint": "father", "relation_to_primary": "father"}
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


C1_CASES = ("a-pai-e-filha", "b-menino-e-mae", "c-duas-irmas", "d-casal", "e-familia")


def _c1(name: str) -> dict:
    return json.loads((Path(__file__).resolve().parents[1] / "fixtures_v2" / f"fixture-c1-{name}.json").read_text(encoding="utf-8"))["input"]


def test_given_a_cast_then_the_draft_carries_it_as_request_subjects_with_relations_and_the_interaction():
    plan = plan_creative(_c1("a-pai-e-filha"), router=ROUTER)
    draft = generation_draft_from_plan(plan)
    assert contracts.validate("GenerationDraft", draft) == [] and all(contracts.validate("RequestSubject", s) == [] for s in draft["subjects"])
    girl, father = draft["subjects"]
    assert (girl["age_band"], girl["wears_product_id"], girl["role"]) == ("child_6_9", "pipa-menina", "primary")
    assert (father["relation_to_primary"], father["wears_product_id"], father["age_band"]) == ("father", None, "adult")
    assert draft["interaction"] == "playing" and {"subjects", "interaction"} <= set(draft["carried"])
    assert draft["scene_picks"] is None and "scene_picks" not in draft["carried"], "a frame scene has no picks to carry"
    assert not any(k in json.dumps(draft) for k in ("pose_risk", "minor_source", "compiler_version\": 2, \"sections"))


def test_given_a_legacy_cast_then_the_draft_carries_no_explicit_subjects_and_no_interaction():
    plan = plan_creative(_child_request("PRESENTE_AFETO", semantic=SEMANTIC_FATHER, policy=POLICY_FULL, seed=100), router=ROUTER)
    draft = generation_draft_from_plan(plan)
    assert plan["scene"]["composition_source"] != "explicit"
    if plan["scene"]["composition_source"] == "legacy":
        assert draft["subjects"] == [] and draft["interaction"] is None and "subjects" not in draft["carried"]


def test_given_again_then_rebuilding_from_the_draft_reproduces_the_same_prompt_for_every_case():
    for name in C1_CASES:
        original = _c1(name)
        plan = plan_creative(original, router=ROUTER)
        draft = generation_draft_from_plan(json.loads(json.dumps(plan)))
        plan2 = plan_creative(_request_from_draft({**original, "subjects": None, "interaction": None}, draft, "again"), router=ROUTER)
        assert plan2["prompt"]["sha256"] == plan["prompt"]["sha256"], name
        assert plan2["seed"] == plan["seed"] and plan2["scene"]["picks"] == plan["scene"]["picks"], name
        assert [(s["age_band"], s["relation_to_primary"], s["product_id"]) for s in plan2["subjects"]] == \
               [(s["age_band"], s["relation_to_primary"], s["product_id"]) for s in plan["subjects"]], name


def test_given_again_on_a_recommended_and_a_legacy_plan_then_the_prompt_is_the_same_too():
    for request in (_c1("a-pai-e-filha"), _child_request("LIFESTYLE_COTIDIANO", policy=POLICY_FULL, seed=7)):
        plan = plan_creative(request, router=ROUTER)
        draft = generation_draft_from_plan(plan)
        original = {k: v for k, v in request.items() if k not in ("subjects", "interaction")}
        plan2 = plan_creative(_request_from_draft(original, draft, "again"), router=ROUTER)
        assert plan2["prompt"]["sha256"] == plan["prompt"]["sha256"], plan["scene"]["composition_source"]


def test_given_variation_then_seed_and_picks_are_dropped_and_every_human_choice_stays():
    plan = plan_creative(_child_request("LIFESTYLE_COTIDIANO", policy=POLICY_FULL, seed=7), router=ROUTER)
    draft = generation_draft_from_plan(plan)
    assert draft["actions"]["variation"] == {"seed": None, "scene_picks": None, "gaze_mode": "auto"}
    assert draft["actions"]["again"] == {"seed": 7, "scene_picks": draft["scene_picks"], "gaze_mode": draft["gaze_mode"]}
    for name in C1_CASES:
        original = _c1(name)
        plan = plan_creative(original, router=ROUTER)
        draft = generation_draft_from_plan(plan)
        request = _request_from_draft({**original, "subjects": None, "interaction": None}, draft, "variation")
        assert "seed" not in request and "scene_picks" not in request, name
        varied = plan_creative({**request, "seed": 91}, router=ROUTER)
        assert [(s["age_band"], s["relation_to_primary"], s["product_id"]) for s in varied["subjects"]] == \
               [(s["age_band"], s["relation_to_primary"], s["product_id"]) for s in plan["subjects"]], name
        assert varied["scene"]["interaction"] == plan["scene"]["interaction"] and varied["angle"]["id"] == plan["angle"]["id"], name
        assert varied["context"]["context_id"] == plan["context"]["context_id"] and varied["placement"] == plan["placement"], name
        assert [p["id"] for p in varied["products"]] == [p["id"] for p in plan["products"]], name


def test_given_a_gaze_the_user_asked_for_then_variation_keeps_it_and_a_planner_gaze_is_released():
    asked = plan_creative({**_c1("b-menino-e-mae"), "gaze_mode": "camera"}, router=ROUTER)
    assert generation_draft_from_plan(asked)["actions"]["variation"]["gaze_mode"] == "camera"
    derived = plan_creative(_c1("b-menino-e-mae"), router=ROUTER)
    draft = generation_draft_from_plan(derived)
    assert draft["gaze_mode"] == "interaction" and draft["actions"]["again"]["gaze_mode"] == "interaction"
    assert draft["actions"]["variation"]["gaze_mode"] == "auto", "the interaction gaze is not a human choice: it is rederived"


def test_given_a_composition_then_the_snapshot_has_interaction_source_risk_and_a_stable_key():
    expected = {"a-pai-e-filha": ("p2|child_6_9+father|playing", "recommended", "medium"),
                "b-menino-e-mae": ("p2|child_6_9+mother|reading_together", "explicit", "medium"),
                "c-duas-irmas": ("p2|child_6_9+sibling|candid", "explicit", "low"),
                "d-casal": ("p2|adult+partner|looking_at_each_other", "explicit", None),
                "e-familia": ("p4|child_6_9+sibling+mother+father|group_photo", "explicit", "high")}
    for name, (key, source, risk) in expected.items():
        snap = feedback_snapshot(plan_creative(_c1(name), router=ROUTER))
        assert contracts.validate("FeedbackSnapshot", snap) == [], name
        assert (snap["composition_key"], snap["composition_source"]) == (key, source), name
        assert snap["interaction"] == key.split("|")[2] and snap["people_count"] == int(key[1]), name
        assert risk is None or snap["pose_risk"] == risk, name
    assert feedback_snapshot(plan_creative(_c1("e-familia"), router=ROUTER))["warnings"] == ["people_count_risk:4"]
    solo = feedback_snapshot(plan_creative(load_fixture("fixture-clean-single")["input"], router=ROUTER))
    assert solo["composition_key"] is None and solo["interaction"] is None and solo["pose_risk"] is None


if __name__ == "__main__":
    run(globals())
