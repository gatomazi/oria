"""Fase D — Angles V2: family/preset metadata on the 13 existing angles (additive, V1 byte-identical),
`recommend_angle` (pure), `angle_id: "auto"`, `angle_family_hint`, and the legacy alias layer.

Casos 1, 2, 3, 4, 5 and 8 of the Fase D direction live here (core-testable, no DB). Casos 6 and 7 (custom
angle scoped to a Store / an Organization) are in the panel's tenancy tests — a custom angle is a row the
panel resolves from `creative_angles`, not something this module reads.
"""
from __future__ import annotations

import copy
import json

from _support import load_fixture, run
from golden_prompt_v1 import ROUTER

from creative_core import contracts
from creative_core.angle_catalog import (
    DISCONTINUED_AS_TOP_LEVEL,
    FAMILIES,
    LEGACY_ALIASES,
    SYSTEM_ANGLES,
    canonical_legacy_angle_id,
    recommend_angle,
    resolve_angle_meta,
)
from creative_core.angles import ANGLE_IDS
from creative_core.compiler import compile_prompt
from creative_core.engines import plan_creative
from creative_core.errors import GenerationError


def _req(**extra) -> dict:
    request = copy.deepcopy(load_fixture("fixture-clean-single")["input"])
    request.update(extra)
    return request


def _plan(**extra) -> dict:
    return plan_creative(_req(**extra), router=ROUTER)


# ------------------------------------------------------------------ catalog integrity
def test_given_the_catalog_then_every_legacy_angle_has_exactly_one_family_and_the_families_match_contracts():
    assert set(LEGACY_ALIASES) == set(ANGLE_IDS)
    assert set(contracts.ANGLE_FAMILIES) == set(FAMILIES), "contracts.ANGLE_FAMILIES must mirror angle_catalog.FAMILIES"
    for angle_id in ANGLE_IDS:
        meta = resolve_angle_meta(angle_id)
        assert meta["family"] in FAMILIES, angle_id
    assert FAMILIES["action_movement"].get("reserved") is True, "no legacy angle maps here yet — it must stay reserved, not silently populated"
    assert not any(resolve_angle_meta(a)["family"] == "action_movement" for a in ANGLE_IDS)


def test_given_a_system_angle_then_round_tripping_through_its_family_returns_the_same_legacy_id():
    for angle_id, spec in SYSTEM_ANGLES.items():
        routed = canonical_legacy_angle_id(spec["family"], spec.get("preset"))
        assert LEGACY_ALIASES[routed]["angle_id"] == angle_id, (angle_id, routed)


def test_given_the_discontinued_set_then_each_one_still_resolves_and_folds_into_a_family_with_another_legacy_angle():
    for angle_id in DISCONTINUED_AS_TOP_LEVEL:
        meta = resolve_angle_meta(angle_id)
        assert meta["family"] is not None
        siblings = [a for a in ANGLE_IDS if resolve_angle_meta(a)["family"] == meta["family"]]
        assert len(siblings) >= 2, f"{angle_id} is discontinued as a top-level card only because its family still has another legacy angle"


# ------------------------------------------------------------------ V1 byte-identical (the whole point of "additive")
def test_given_the_new_catalog_then_v1_prompts_are_still_byte_identical_for_every_legacy_angle():
    for angle_id in ANGLE_IDS:
        plan = plan_creative(_req(angle_id=angle_id, plan_schema_version=1, prompt_version=1), router=ROUTER)
        assert plan["schema_version"] == 1
        # the family layer changes nothing about what gets compiled for v1
        assert "family" not in json.dumps(plan["angle"])


def test_given_a_v2_plan_with_an_explicit_legacy_angle_then_the_recommendation_says_source_user():
    plan = _plan(angle_id="LIFESTYLE_COTIDIANO", plan_schema_version=2)
    assert plan["angle_recommendation"] == {
        "angle_id": "LIFESTYLE_COTIDIANO", "family": "lifestyle", "preset": None, "objective_hints": ["daily_life"],
        "scope": "system", "version": 1, "reason": [], "source": "user", "custom_angle": None,
    }
    assert plan["provenance"]["angle"] == "user"


# ------------------------------------------------------------------ Caso 1: single person, adult tee
def test_case_1_single_person_then_editorial_portrait_and_camera_gaze():
    plan = _plan(angle_id="auto", plan_schema_version=2)
    assert plan["angle_recommendation"]["family"] == "editorial_portrait"
    assert plan["angle_recommendation"]["source"] == "planner_default"
    assert "single_person_default" in plan["angle_recommendation"]["reason"]
    assert plan["scene"]["gaze"]["mode"] == "camera"
    assert plan["angle"]["id"] == "ORGULHO_DISCRETO"


# ------------------------------------------------------------------ Caso 2 / 3: connection, interaction-driven
def test_case_2_father_and_daughter_playing_then_connection_with_playing_and_interaction_gaze():
    request = _req(angle_id="auto", plan_schema_version=2, subjects=[
        {"id": "s1", "role": "primary", "persona": {"label": "menina 7 anos", "age_band": "child_6_9"}},
        {"id": "s2", "role": "supporting", "persona": {"label": "homem 35 anos", "age_band": "adult"}, "relation_to_primary": "father"},
    ], interaction="playing")
    plan = plan_creative(request, router=ROUTER)
    assert plan["angle_recommendation"]["family"] == "connection"
    assert "interaction:playing" in plan["angle_recommendation"]["reason"]
    assert plan["scene"]["interaction"] == "playing" and plan["scene"]["gaze"]["mode"] == "interaction"


def test_case_3_mother_and_son_reading_then_connection_with_reading_together():
    request = _req(angle_id="auto", plan_schema_version=2, subjects=[
        {"id": "s1", "role": "primary", "persona": {"label": "menino 7 anos", "age_band": "child_6_9"}},
        {"id": "s2", "role": "supporting", "persona": {"label": "mulher 34 anos", "age_band": "adult"}, "relation_to_primary": "mother"},
    ], interaction="reading_together")
    plan = plan_creative(request, router=ROUTER)
    assert plan["angle_recommendation"]["family"] == "connection"
    assert "interaction:reading_together" in plan["angle_recommendation"]["reason"]
    assert plan["scene"]["interaction"] == "reading_together"


# ------------------------------------------------------------------ Caso 4: product without person
def test_case_4_no_person_requested_then_product_without_person():
    plan = _plan(angle_id="auto", plan_schema_version=2, persona_mode="none")
    assert plan["angle_recommendation"]["family"] == "product_no_person"
    assert "no_person_requested" in plan["angle_recommendation"]["reason"]
    assert plan["angle"]["id"] == "PRODUTO_ESTAMPA"


# ------------------------------------------------------------------ Caso 5: creator/social
def test_case_5_creator_intent_hint_then_creator_social_with_its_own_gaze_preset():
    plan = _plan(angle_id="auto", plan_schema_version=2, angle_intent_hint="creator")
    assert plan["angle_recommendation"]["family"] == "creator_social"
    assert plan["angle"]["id"] == "CREATOR_STYLE"
    assert plan["scene"]["gaze"]["mode"] in ("camera", "off_camera"), "creator's own pool (mirror/camera) still decides, unchanged"


# ------------------------------------------------------------------ Caso 8: legacy alias keeps working, unchanged job
def test_case_8_presente_afeto_alias_keeps_working_exactly_as_before():
    plan_legacy = plan_creative(_req(angle_id="PRESENTE_AFETO", plan_schema_version=1, prompt_version=1), router=ROUTER)
    assert plan_legacy["schema_version"] == 1 and plan_legacy["angle"]["id"] == "PRESENTE_AFETO"
    meta = resolve_angle_meta("PRESENTE_AFETO")
    assert meta == {"id": "PRESENTE_AFETO", "family": "connection", "name": "Conexão / vínculo", "scope": "system",
                    "preset": None, "objective_hints": ["gifting"], "version": 1}
    assert "PRESENTE_AFETO" in DISCONTINUED_AS_TOP_LEVEL, "still an alias, just not offered as its own card"


# ------------------------------------------------------------------ angle_family_hint (how a custom/org/store angle, or a direct family pick, reaches the core)
def test_given_an_angle_family_hint_then_it_is_used_directly_with_source_user_no_heuristic():
    plan = _plan(angle_id="auto", plan_schema_version=2, angle_family_hint={"family": "product_focus", "preset": "print_closeup"})
    assert plan["angle"]["id"] == "CLOSE_ESTAMPA"
    assert plan["angle_recommendation"] == {
        "angle_id": "CLOSE_ESTAMPA", "family": "product_focus", "preset": "print_closeup",
        "objective_hints": ["print_detail"], "scope": "system", "version": 1,
        "reason": ["angle_family_hint:product_focus"], "source": "user", "custom_angle": None,
    }
    assert plan["provenance"]["angle"] == "user"


def test_given_the_reserved_family_then_auto_and_the_hint_both_refuse_instead_of_guessing():
    err = None
    try:
        plan_creative(_req(angle_id="auto", plan_schema_version=2, angle_family_hint={"family": "action_movement"}), router=ROUTER)
    except GenerationError as exc:
        err = exc
    assert err is not None and err.code == "UNSUPPORTED_ANGLE" and err.details["family"] == "action_movement"


def test_given_an_unknown_family_in_the_hint_then_the_contract_refuses_it():
    from creative_core.contracts import validate
    request = _req(angle_id="auto", angle_family_hint={"family": "not_a_family"})
    assert validate("CreativeRequest", request) == [], "angle_family_hint is a free object at the contract layer"
    err = None
    try:
        plan_creative(request, router=ROUTER)
    except GenerationError as exc:
        err = exc
    assert err is not None and err.code == "UNSUPPORTED_ANGLE"


# ------------------------------------------------------------------ recommend_angle is pure (no request/DB access)
def test_given_recommend_angle_then_it_is_a_pure_function_of_its_inputs():
    a = recommend_angle({"subjects": [{"id": "s1"}, {"id": "s2"}], "interaction": "playing"})
    b = recommend_angle({"subjects": [{"id": "s1"}, {"id": "s2"}], "interaction": "playing"})
    assert a == b
    assert recommend_angle({}) == recommend_angle({})


def test_given_gifting_then_connection_routes_to_presente_afeto_specifically():
    rec = recommend_angle({"subjects": [{"id": "s1"}, {"id": "s2"}], "interaction": "gifting"})
    assert rec == {"angle_id": "PRESENTE_AFETO", "family": "connection", "preset": None, "objective_hints": ["gifting"],
                   "reason": ["interaction:gifting"], "source": "planner_default"}


def test_given_two_people_and_no_interaction_but_a_relationship_theme_then_connection_from_semantic_context():
    rec = recommend_angle({"subjects": [{"id": "s1"}, {"id": "s2"}],
                           "products": [{"semantic_context": {"relationship_themes": ["father_child"]}}]})
    assert rec["family"] == "connection" and "relationship_theme:father_child" in rec["reason"]


def test_given_two_people_and_no_bonding_signal_then_lifestyle_not_connection():
    rec = recommend_angle({"subjects": [{"id": "s1"}, {"id": "s2"}]})
    assert rec["family"] == "lifestyle" and rec["angle_id"] == "LIFESTYLE_COTIDIANO"


# ------------------------------------------------------------------ recompiled byte-identically regardless of family layer
def test_given_an_auto_resolved_plan_then_recompiling_it_is_still_byte_identical():
    plan = _plan(angle_id="auto", plan_schema_version=2, persona_mode="none")
    assert compile_prompt(json.loads(json.dumps(plan)))["sha256"] == plan["prompt"]["sha256"]


# ------------------------------------------------------------------ FeedbackSnapshot carries the family (Fase D §15)
def test_given_a_plan_then_the_feedback_snapshot_carries_family_preset_scope_and_version():
    from creative_core.drafts import feedback_snapshot

    plan = _plan(angle_id="auto", plan_schema_version=2, subjects=[
        {"id": "s1", "role": "primary", "persona": {"label": "menina 7 anos", "age_band": "child_6_9"}},
        {"id": "s2", "role": "supporting", "persona": {"label": "homem 35 anos", "age_band": "adult"}, "relation_to_primary": "father"},
    ], interaction="playing")
    snap = feedback_snapshot(plan)
    assert (snap["angle_family"], snap["angle_preset"], snap["angle_scope"], snap["angle_version"]) == ("connection", None, "system", 1)
    assert contracts.validate("FeedbackSnapshot", snap) == []


def test_given_a_v1_plan_then_the_snapshot_still_carries_the_family_metadata_additively():
    from creative_core.drafts import feedback_snapshot

    plan = plan_creative(_req(angle_id="CAIMENTO", plan_schema_version=1, prompt_version=1), router=ROUTER)
    snap = feedback_snapshot(plan)
    assert (snap["angle_family"], snap["angle_preset"]) == ("product_focus", "fit_full_body")
    assert contracts.validate("FeedbackSnapshot", snap) == []


if __name__ == "__main__":
    run(globals())
