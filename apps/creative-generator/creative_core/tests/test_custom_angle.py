"""Fase D.1 — custom angles actually influence the compiled prompt (not just route to a legacy angle_id).

The core never touches `creative_angles`: every test here builds the `custom_angle` payload exactly as the panel
would after resolving the row — the "resolved definition" the direction (§3) asks the plan to be self-sufficient
with. Casos do documento: dois Custom Angles produzem prompts diferentes (§1/§6), versionamento não afeta o
histórico (§3/§6), regras obrigatórias têm precedência (§2/§6), Copiar Dados recupera o ângulo (§6), feedback
guarda identidade + versão (§3/§6), os 13 ângulos legados e o golden V1 continuam intactos (§6 — cobertos também em
test_angle_catalog.py).
"""
from __future__ import annotations

import copy
import json

from _support import load_fixture, run
from golden_prompt_v1 import ROUTER

from creative_core import contracts
from creative_core.compiler import compile_prompt
from creative_core.drafts import feedback_snapshot, generation_draft_from_plan
from creative_core.engines import plan_creative
from creative_core.errors import GenerationError

NOW = "2026-09-22T00:00:00Z"


def _req(**extra) -> dict:
    request = copy.deepcopy(load_fixture("fixture-clean-single")["input"])
    request.update(extra)
    return request


def custom_angle(**overrides) -> dict:
    base = {
        "id": "11111111-1111-4111-8111-111111111111", "scope": "organization", "organization_id": "org-1",
        "store_id": None, "slug": "cafe-editorial", "name": "Café editorial", "description": None,
        "family": "lifestyle", "people_mode": "optional", "preset": None, "definition": {},
        "allowed_interactions": None, "allowed_product_modes": None, "default_gaze": None,
        "active": True, "version": 1, "created_by": None, "created_at": NOW, "updated_at": NOW,
    }
    base.update(overrides)
    return base


CAFE = custom_angle(definition={
    "framing": "plano médio, corpo até a cintura", "photographic_direction": "pessoa sentada à mesa de um café",
    "lighting": "luz natural lateral, mesa de madeira", "composition": "produto claramente visível, olhando para a câmera",
})
URBANO = custom_angle(id="22222222-2222-4222-8222-222222222222", slug="editorial-urbano", name="Editorial urbano", definition={
    "framing": "plano aberto, corpo inteiro", "photographic_direction": "pessoa caminhando, foto espontânea",
    "composition": "cena de rua cotidiana", "visual_notes": ["não olha para a câmera"],
})


def _plan(angle: dict, **extra) -> dict:
    return plan_creative(_req(angle_id="auto", plan_schema_version=2, custom_angle=angle, **extra), router=ROUTER)


# ------------------------------------------------------------------ §1/§6: different definitions -> different prompts
def test_given_two_custom_angles_of_the_same_family_then_the_prompts_are_different():
    p1, p2 = _plan(CAFE), _plan(URBANO)
    assert p1["angle_recommendation"]["family"] == p2["angle_recommendation"]["family"] == "lifestyle"
    assert p1["angle"]["id"] == p2["angle"]["id"] == "LIFESTYLE_COTIDIANO", "same legacy base — compatibility, §1"
    assert p1["prompt"]["sha256"] != p2["prompt"]["sha256"]
    assert p1["prompt"]["text"] != p2["prompt"]["text"]
    assert "DIREÇÃO DO ÂNGULO PERSONALIZADO (Café editorial):" in p1["prompt"]["text"]
    assert "Enquadramento: plano médio, corpo até a cintura" in p1["prompt"]["text"]
    assert "Direção fotográfica: pessoa sentada à mesa de um café" in p1["prompt"]["text"]
    assert "Iluminação: luz natural lateral, mesa de madeira" in p1["prompt"]["text"]
    assert "DIREÇÃO DO ÂNGULO PERSONALIZADO (Editorial urbano):" in p2["prompt"]["text"]
    assert "- não olha para a câmera" in p2["prompt"]["text"]
    assert "Café editorial" not in p2["prompt"]["text"] and "Editorial urbano" not in p1["prompt"]["text"]


def test_given_a_custom_angle_with_no_definition_fields_then_no_section_is_added():
    plan = _plan(custom_angle(definition={}))
    assert "DIREÇÃO DO ÂNGULO PERSONALIZADO" not in plan["prompt"]["text"]
    assert "custom_angle_direction" not in [s["section"] for s in plan["compiler"]["sections"]]


def test_given_a_system_angle_then_it_never_gets_a_custom_angle_direction_section():
    plan = plan_creative(_req(angle_id="LIFESTYLE_COTIDIANO", plan_schema_version=2), router=ROUTER)
    assert plan["angle_recommendation"]["custom_angle"] is None
    assert "DIREÇÃO DO ÂNGULO PERSONALIZADO" not in plan["prompt"]["text"]


# ------------------------------------------------------------------ §2/§6: mandatory rules keep precedence
def test_given_a_custom_angle_then_fidelity_minor_safety_and_text_rules_still_come_first_and_are_untouched():
    plan = _plan(CAFE, subjects=[{"id": "s1", "role": "primary", "persona": {"label": "menina 7 anos", "age_band": "child_6_9"}}])
    names = [s["section"] for s in plan["compiler"]["sections"]]
    assert names[:3] == ["fidelity_rules", "minor_safety", "reference_roles"] or names[0] == "fidelity_rules"
    assert names.index("fidelity_rules") < names.index("custom_angle_direction")
    assert names.index("minor_safety") < names.index("custom_angle_direction") or "minor_safety" not in names
    assert names.index("scene_action") < names.index("custom_angle_direction")
    assert plan["minor_safety"]["applies"] is True, "a custom angle cannot turn off minor safety"


def test_given_a_custom_angle_then_interaction_subjects_and_context_still_decide_what_who_and_where():
    request = _req(angle_id="auto", plan_schema_version=2, custom_angle=CAFE, subjects=[
        {"id": "s1", "role": "primary", "persona": {"label": "menina 7 anos", "age_band": "child_6_9"}},
        {"id": "s2", "role": "supporting", "persona": {"label": "homem 35 anos", "age_band": "adult"}, "relation_to_primary": "father"},
    ], interaction="playing")
    plan = plan_creative(request, router=ROUTER)
    assert plan["scene"]["interaction"] == "playing", "interaction still decides the action, not the angle"
    assert len(plan["subjects"]) == 2, "subjects still decide who is in frame"
    assert plan["context"]["scene"], "context still decides the environment"


# ------------------------------------------------------------------ §3/§6: self-sufficient, editing does not touch history
def test_given_a_persisted_plan_then_recompiling_it_never_needs_the_database_and_editing_the_row_does_not_change_it():
    plan = _plan(CAFE)
    persisted = json.loads(json.dumps(plan))  # round trip through storage, exactly like a real persisted plan
    recompiled = compile_prompt(persisted)
    assert recompiled["sha256"] == plan["prompt"]["sha256"]
    # "editing" the angle later means the CALLER would send a DIFFERENT custom_angle on the NEXT generation —
    # recompiling this specific persisted plan never reads a "current" row, so nothing here could reflect an edit.
    edited = {**CAFE, "name": "Café editorial (v2)", "version": 2, "definition": {"framing": "outro enquadramento"}}
    assert compile_prompt(persisted)["sha256"] == plan["prompt"]["sha256"], "recompiling the OLD plan ignores any 'current' row entirely"
    assert edited != persisted["angle_recommendation"]["custom_angle"], "the persisted plan kept the version used AT THE TIME"
    assert persisted["angle_recommendation"]["custom_angle"]["version"] == 1


def test_given_the_frozen_stored_shape_then_a_custom_angle_survives_a_full_json_round_trip():
    plan = _plan(URBANO)
    assert contracts.validate("CreativePlan", plan) == []
    again = json.loads(json.dumps(plan))
    assert again["angle_recommendation"]["custom_angle"] == URBANO
    assert compile_prompt(again)["text"] == plan["prompt"]["text"]


# ------------------------------------------------------------------ §4: compatibility now actually enforced
def test_given_allowed_product_modes_then_an_incompatible_product_mode_is_refused_not_silently_ignored():
    request = _req(angle_id="auto", plan_schema_version=2,
                   custom_angle=custom_angle(allowed_product_modes=["multi_product"]))
    err = None
    try:
        plan_creative(request, router=ROUTER)
    except GenerationError as exc:
        err = exc
    assert err is not None and err.code == "UNSUPPORTED_ANGLE"
    assert err.details["custom_angle_id"] == "11111111-1111-4111-8111-111111111111"


def test_given_allowed_interactions_then_a_mismatch_warns_but_the_users_explicit_choice_still_wins():
    request = _req(angle_id="auto", plan_schema_version=2, custom_angle=custom_angle(allowed_interactions=["reading_together"]),
                   subjects=[{"id": "s1", "role": "primary", "persona": {"label": "menina 7 anos", "age_band": "child_6_9"}},
                             {"id": "s2", "role": "supporting", "persona": {"label": "menino 5 anos", "age_band": "child_3_5"}, "relation_to_primary": "sibling"}],
                   interaction="playing")
    plan = plan_creative(request, router=ROUTER)
    assert plan["scene"]["interaction"] == "playing", "the explicit choice always wins — never blocked"
    assert "angle_interaction_mismatch:11111111-1111-4111-8111-111111111111:playing" in plan["warnings"]


def test_given_a_people_mode_mismatch_then_it_is_a_warning_not_a_block():
    request = _req(angle_id="auto", plan_schema_version=2, custom_angle=custom_angle(people_mode="none"), persona_mode="automatic")
    plan = plan_creative(request, router=ROUTER)
    assert "angle_people_mode_mismatch:none:1" in plan["warnings"]
    assert plan["subjects"], "still not blocked — the angle only warns"


def test_given_a_default_gaze_then_it_wins_over_the_legacy_angles_own_default_but_not_over_interaction_or_user():
    plan = _plan(custom_angle(default_gaze="product"))
    assert plan["scene"]["gaze"] == {"mode": "product", "requested": "auto", "source": "angle",
                                     "reason": "custom_angle:11111111-1111-4111-8111-111111111111"}
    forced = _plan(custom_angle(default_gaze="product"), gaze_mode="camera")
    assert forced["scene"]["gaze"]["mode"] == "camera", "explicit user gaze still wins"
    request = _req(angle_id="auto", plan_schema_version=2, custom_angle=custom_angle(default_gaze="product"), subjects=[
        {"id": "s1", "role": "primary", "persona": {"label": "menina 7 anos", "age_band": "child_6_9"}},
        {"id": "s2", "role": "supporting", "persona": {"label": "homem 35 anos", "age_band": "adult"}, "relation_to_primary": "father"},
    ], interaction="playing")
    with_interaction = plan_creative(request, router=ROUTER)
    assert with_interaction["scene"]["gaze"]["mode"] == "interaction", "interaction still wins over the custom default"


def test_given_custom_angle_without_auto_then_the_request_is_refused():
    request = _req(angle_id="LIFESTYLE_COTIDIANO", plan_schema_version=2, custom_angle=CAFE)
    err = None
    try:
        plan_creative(request, router=ROUTER)
    except GenerationError as exc:
        err = exc
    assert err is not None and 'requires angle_id "auto"' in err.details["errors"][0]


# ------------------------------------------------------------------ §5: minimal cadastro, definition is free structured data
def test_given_a_minimal_custom_angle_then_only_name_description_and_family_are_required_the_rest_defaults():
    minimal = custom_angle(definition={}, allowed_interactions=None, allowed_product_modes=None, default_gaze=None)
    assert contracts.validate("CustomAngle", minimal) == []
    plan = _plan(minimal)
    assert plan["angle_recommendation"]["family"] == "lifestyle"


# ------------------------------------------------------------------ §6: Copiar Dados recovers the custom angle
def test_given_a_plan_with_a_custom_angle_then_the_draft_carries_it_for_again_and_variation():
    plan = _plan(CAFE)
    draft = generation_draft_from_plan(plan)
    assert draft["custom_angle"] == CAFE
    assert contracts.validate("GenerationDraft", draft) == []


def test_given_a_system_angle_plan_then_the_draft_custom_angle_is_null():
    plan = plan_creative(_req(angle_id="LIFESTYLE_COTIDIANO", plan_schema_version=2), router=ROUTER)
    assert generation_draft_from_plan(plan)["custom_angle"] is None


# ------------------------------------------------------------------ §6: feedback carries identity + version
def test_given_a_plan_with_a_custom_angle_then_the_feedback_snapshot_carries_its_identity_and_version():
    plan = _plan(URBANO)
    snap = feedback_snapshot(plan)
    assert (snap["angle_custom_id"], snap["angle_custom_slug"], snap["angle_custom_name"]) == (
        "22222222-2222-4222-8222-222222222222", "editorial-urbano", "Editorial urbano")
    assert (snap["angle_family"], snap["angle_scope"], snap["angle_version"]) == ("lifestyle", "organization", 1)
    assert contracts.validate("FeedbackSnapshot", snap) == []


def test_given_a_system_angle_plan_then_the_snapshot_custom_identity_fields_are_null():
    plan = plan_creative(_req(angle_id="CAIMENTO", plan_schema_version=2), router=ROUTER)
    snap = feedback_snapshot(plan)
    assert (snap["angle_custom_id"], snap["angle_custom_slug"], snap["angle_custom_name"]) == (None, None, None)
    assert snap["angle_scope"] == "system"


if __name__ == "__main__":
    run(globals())
