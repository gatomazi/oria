"""Fase C1: subjects, relations and interactions as plan data (explicit, recommended or legacy), with the five product
cases as fixtures. The compiler version 1 (Fase B) stays compilable, byte for byte."""
from __future__ import annotations

import copy
import glob
import json
from pathlib import Path

from _support import run
from golden_prompt_v1 import ROUTER

from creative_core import composition, contracts, planner_v2
from creative_core.compiler import SECTION_ORDER_V2, compile_prompt
from creative_core.engines import plan_creative
from creative_core.errors import GenerationError

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures_v2"


def _fixture(name: str) -> dict:
    return json.loads((FIXTURES / f"fixture-c1-{name}.json").read_text(encoding="utf-8"))["input"]


def _plan(name: str, **extra) -> dict:
    return plan_creative({**copy.deepcopy(_fixture(name)), **extra}, router=ROUTER)


def _sections(plan: dict) -> dict:
    return {s["section"]: s for s in plan["compiler"]["sections"]}


def _person(label, band=None):
    return {"label": label, **({"age_band": band} if band else {})}


def _explicit(fixture="b-menino-e-mae", **changes) -> dict:
    request = copy.deepcopy(_fixture(fixture))
    request.update(changes)
    if len(request.get("subjects") or []) < 2 and "interaction" not in changes:
        request.pop("interaction", None)  # the fixture's interaction needs its two people
    return request


def _error(request: dict) -> GenerationError:
    try:
        plan_creative(request, router=ROUTER)
    except GenerationError as err:
        return err
    raise AssertionError("expected a GenerationError")


# ------------------------------------------------------------------ the five cases
def test_case_a_father_child_print_is_recommended_from_the_semantic_context_without_any_subject_in_the_request():
    request = _fixture("a-pai-e-filha")
    assert "subjects" not in request and "interaction" not in request
    plan = plan_creative(request, router=ROUTER)
    assert contracts.validate("CreativePlan", plan) == []
    scene = plan["scene"]
    assert (scene["composition_source"], scene["scene_mode"], scene["interaction"]) == ("recommended", "frame", "playing")
    girl, father = plan["subjects"]
    assert (girl["role"], girl["age_band"], girl["product_use"], girl["source"]) == ("primary", "child_6_9", "wears", "product")
    assert (father["role"], father["relation_to_primary"], father["role_hint"], father["product_use"]) == ("supporting", "father", "father", "none")
    assert scene["gaze"] == {"mode": "interaction", "requested": "auto", "source": "planner_default", "reason": "interaction:playing"}
    assert plan["provenance"]["scene.interaction"] == "product" and plan["provenance"]["subjects"] == "product"
    assert plan["warnings"] == [] and plan["minor_safety"]["applies"] and plan["minor_safety"]["global"]["adult_child_rule"]


def test_case_b_boy_and_mother_reading_the_mother_does_not_wear_the_product():
    plan = _plan("b-menino-e-mae")
    boy, mother = plan["subjects"]
    assert (boy["age_band"], boy["product_use"], boy["is_minor"], boy["minor_source"]) == ("child_6_9", "wears", True, "persona.age_band")
    assert (mother["age_band"], mother["relation_to_primary"], mother["product_use"], mother["product_id"]) == ("adult", "mother", "none", None)
    assert plan["scene"]["interaction"] == "reading_together" and plan["scene"]["composition_source"] == "explicit"
    assert plan["scene"]["gaze"]["mode"] == "interaction" and plan["composition"]["pose_risk"] == "medium"
    text = plan["prompt"]["text"]
    assert "mulher 34 anos, mãe da Pessoa 1 — não usa o produto" in text and "INTERAÇÃO (lendo juntos)" in text
    assert plan["provenance"]["subjects.s1.age_band"] == "persona" and plan["minor_safety"]["basis"] == {"explicit": ["s1"], "heuristic": []}


def test_case_c_two_sisters_wear_different_products_and_are_related_as_siblings():
    plan = _plan("c-duas-irmas")
    a, b = plan["subjects"]
    assert (a["product_id"], b["product_id"]) == ("irmas-rosa", "irmas-azul") and a["product_id"] != b["product_id"]
    assert b["relation_to_primary"] == "sibling" and (a["age_band"], b["age_band"]) == ("child_6_9", "child_3_5")
    assert plan["scene"]["interaction"] == "candid" and plan["scene"]["gaze"]["mode"] == "off_camera"
    assert "irmão ou irmã da Pessoa 1 — veste" in plan["prompt"]["text"]
    assert plan["semantics"]["warnings"] == [] and plan["composition"]["pose_risk"] == "low"


def test_case_d_a_couple_two_adults_with_paired_products_and_a_partner_relation():
    plan = _plan("d-casal")
    a, b = plan["subjects"]
    assert not a["is_minor"] and not b["is_minor"] and plan["minor_safety"]["applies"] is False
    assert (b["relation_to_primary"], a["product_id"], b["product_id"]) == ("partner", "casal-ela", "casal-ele")
    assert "PROTEÇÃO DE MENORES" not in plan["prompt"]["text"] and "parceiro ou parceira da Pessoa 1" in plan["prompt"]["text"]
    assert plan["scene"]["gaze"]["mode"] == "interaction" and plan["scene"]["interaction"] == "looking_at_each_other"


def test_case_e_a_family_of_four_is_high_risk_with_a_warning_and_a_simple_group_pose():
    plan = _plan("e-familia")
    assert [s["relation_to_primary"] for s in plan["subjects"]] == [None, "sibling", "mother", "father"]
    assert [s["product_use"] for s in plan["subjects"]] == ["wears", "wears", "none", "none"]
    assert plan["composition"]["pose_risk"] == "high" and "people_count_risk:4" in plan["warnings"]
    assert plan["scene"]["interaction"] == "group_photo" and plan["scene"]["gaze"]["mode"] == "camera"
    assert "ninguém segura objetos" in plan["prompt"]["text"] and "exatamente 4 pessoas" in plan["prompt"]["text"]
    assert plan["minor_safety"]["minor_subject_ids"] == ["s1", "s2"] and plan["minor_safety"]["global"]["adult_child_rule"]


def test_given_the_five_fixtures_then_each_plan_is_valid_recompiles_and_lists_the_interaction_section():
    for path in sorted(glob.glob(str(FIXTURES / "fixture-c1-*.json"))):
        request = json.loads(Path(path).read_text(encoding="utf-8"))["input"]
        plan = plan_creative(request, router=ROUTER)
        assert contracts.validate("CreativePlan", plan) == [] and contracts.validate("CreativeRequest", request) == [], path
        assert compile_prompt(json.loads(json.dumps(plan, ensure_ascii=False)))["sha256"] == plan["prompt"]["sha256"], path
        names = [s["section"] for s in plan["compiler"]["sections"]]
        assert names == [n for n in SECTION_ORDER_V2 if n in names] and "interaction" in names, path
        assert names.index("gaze") + 1 == names.index("interaction") < names.index("scene_action")
        assert plan["compiler"]["version"] == 3 and plan["scene"]["scene_mode"] == "frame"  # Fase D.1 bumped the default


# ------------------------------------------------------------------ explicit subjects: validation
def test_given_invalid_subjects_then_the_request_is_refused_with_the_field_that_is_wrong():
    two_primaries = _explicit(subjects=[{"role": "primary", "persona": _person("a")}, {"role": "primary", "persona": _person("b")}])
    assert "only one primary" in str(_error(two_primaries).details["errors"])
    dup = _explicit(subjects=[{"id": "x", "persona": _person("a")}, {"id": "x", "persona": _person("b")}])
    assert "duplicate id" in str(_error(dup).details["errors"])
    unknown = _explicit(subjects=[{"persona": _person("a"), "wears_product_id": "nope"}])
    assert "subjects[0].wears_product_id" in str(_error(unknown).details["errors"])
    self_relation = _explicit(subjects=[{"role": "primary", "persona": _person("a"), "relation_to_primary": "mother"}])
    assert "primary subject has no relation" in str(_error(self_relation).details["errors"])
    custom = _explicit(subjects=[{"persona": _person("a")}, {"persona": _person("b"), "relation_to_primary": "custom"}])
    assert "relation_label" in str(_error(custom).details["errors"])
    too_many = _explicit(subjects=[{"persona": _person(str(i))} for i in range(5)])
    assert contracts.validate("CreativeRequest", too_many), "the contract itself caps the scene at 4 people"
    product_only = _explicit(angle_id="CABIDE", subjects=[{"persona": _person("a")}])
    assert "product-only angle" in str(_error(product_only).details["errors"])


def test_given_a_custom_relation_then_its_label_is_kept_and_compiled():
    request = _explicit(subjects=[{"persona": _person("menina 7 anos", "child_6_9")},
                                  {"persona": _person("mulher 60 anos", "senior"), "relation_to_primary": "custom", "relation_label": "madrinha"}])
    plan = plan_creative(request, router=ROUTER)
    assert plan["subjects"][1]["relation_to_primary"] == "custom" and plan["subjects"][1]["relation_label"] == "madrinha"
    assert "pessoa idosa" in plan["prompt"]["text"] and ", madrinha —" in plan["prompt"]["text"]


def test_given_a_request_subject_without_a_primary_then_the_first_one_is_the_primary():
    request = _explicit(subjects=[{"persona": _person("menina 7 anos", "child_6_9")}, {"persona": _person("mulher 30 anos", "adult"), "relation_to_primary": "mother"}])
    plan = plan_creative(request, router=ROUTER)
    assert [s["role"] for s in plan["subjects"]] == ["primary", "supporting"] and plan["subjects"][0]["product_id"] == "abelhinhas-leitura"
    assert plan["subjects"][1]["product_use"] == "none", "single product: only the primary wears it unless the request says otherwise"


def test_given_two_subjects_wearing_the_default_products_in_multi_product_then_the_ith_gets_the_ith():
    request = _explicit("c-duas-irmas")
    for subject in request["subjects"]:
        subject.pop("wears_product_id")
    plan = plan_creative(request, router=ROUTER)
    assert [s["product_id"] for s in plan["subjects"]] == ["irmas-rosa", "irmas-azul"]


# ------------------------------------------------------------------ relations
def test_given_a_structured_relation_then_semantic_matching_uses_it_and_not_the_label():
    request = _explicit("a-pai-e-filha", subjects=[
        {"persona": _person("Ana", "child_6_9"), "wears_product_id": "pipa-menina"},
        {"persona": _person("Carla", "adult"), "relation_to_primary": "mother", "wears_product_id": None}])
    plan = plan_creative(request, router=ROUTER)
    assert plan["subjects"][1]["role_hint"] == "mother", "the label says nothing; the relation does"
    assert plan["semantics"]["warnings"][0] == {"code": "semantic_mismatch", "theme": "father_child", "supporting_role": "mother", "product_id": "pipa-menina"}
    assert "semantic_mismatch:father_child:mother" in plan["warnings"] and contracts.validate("CreativePlan", plan) == []
    assert composition.relation_role("daughter") == "child" == composition.relation_role("son") and composition.relation_role(None) is None


def test_given_a_manual_composition_that_contradicts_the_print_then_the_scene_is_still_generated_with_a_warning():
    request = _explicit("a-pai-e-filha", subjects=[
        {"persona": _person("menina 7 anos", "child_6_9")}, {"persona": _person("mulher 34 anos", "adult"), "relation_to_primary": "mother"}])
    plan = plan_creative(request, router=ROUTER)
    assert plan["scene"]["composition_source"] == "explicit" and plan["subjects"][1]["relation_to_primary"] == "mother"
    assert plan["semantics"]["warnings"] and plan["prompt"]["text"], "never blocked by semantics alone"


def test_given_a_wearer_that_does_not_fit_the_print_semantics_then_it_is_a_warning_and_nothing_blocks():
    # A NON-infant garment whose print says "child": semantics only warn (an infant garment is a hard rule, see test_infant_wearer.py).
    request = _explicit("a-pai-e-filha", subjects=[{"persona": _person("mulher 30 anos", "adult")}])
    request["products"][0]["type"] = "camiseta"
    plan = plan_creative(request, router=ROUTER)
    assert plan["semantics"]["warnings"][0]["code"] == "wearer_role_mismatch" and "wearer_role_mismatch:None:child" in plan["warnings"]


# ------------------------------------------------------------------ interactions
def test_given_the_catalog_then_every_entry_declares_its_metadata_and_only_valid_values():
    for name, spec in composition.INTERACTIONS.items():
        assert {"label", "min_people", "max_people", "excluded_bands", "contact", "hand_complexity", "object_use",
                "gaze_default", "pose_risk", "scene", "hands"} <= set(spec), name
        assert 1 <= spec["min_people"] <= spec["max_people"] <= contracts.MAX_SUBJECTS
        assert spec["contact"] in ("none", "light", "physical") and spec["object_use"] in ("none", "light", "heavy")
        assert spec["gaze_default"] in contracts.GAZE_RESOLVED and 0 <= spec["hand_complexity"] <= 3 and 0 <= spec["pose_risk"] <= 3
        assert set(spec["excluded_bands"]) <= set(contracts.AGE_BANDS) and spec["scene"].endswith(".") and spec["hands"].endswith(".")
    mapped = {v for k, v in composition.CATALOG["intent_map"].items() if k != "_doc"}
    assert mapped <= set(composition.INTERACTIONS) and composition.CATALOG["default_for_group"] in composition.INTERACTIONS
    assert {"candid", "talking", "looking_at_each_other", "walking", "hugging", "reading_together", "playing", "cooking",
            "doing_activity", "gifting", "group_photo"} == set(composition.INTERACTIONS)


def test_given_a_new_catalog_entry_then_the_planner_and_compiler_use_it_without_any_code_change():
    composition.INTERACTIONS["stargazing"] = {**composition.INTERACTIONS["candid"], "label": "olhando as estrelas", "min_people": 2,
                                              "gaze_default": "product", "pose_risk": 3, "scene": "olham o céu juntas.", "hands": "mãos no colo."}
    try:
        plan = plan_creative(_explicit(interaction="stargazing"), router=ROUTER)
        assert plan["scene"]["interaction"] == "stargazing" and plan["scene"]["gaze"]["mode"] == "product"
        assert "INTERAÇÃO (olhando as estrelas): olham o céu juntas. Mãos: mãos no colo." in plan["prompt"]["text"]
        assert plan["composition"]["pose_risk"] == "high" and "interaction:stargazing" in plan["composition"]["risk_reasons"]
    finally:
        del composition.INTERACTIONS["stargazing"]


def test_given_the_people_count_outside_an_interactions_range_then_it_is_an_error_but_an_unsuited_age_is_only_a_warning():
    one = _explicit(subjects=[{"persona": _person("menina 7 anos", "child_6_9")}], interaction="hugging")
    err = _error(one)
    assert err.code == "INTERACTION_INCOMPATIBLE" and err.details == {"interaction": "hugging", "people": 1, "min_people": 2, "max_people": 3}
    assert _error(_explicit(interaction="teleporting")).code == "INVALID_INPUT"
    baby = _explicit(subjects=[{"persona": _person("bebê", "baby")}, {"persona": _person("mulher 30 anos", "adult"), "relation_to_primary": "mother"}], interaction="cooking")
    plan = plan_creative(baby, router=ROUTER)
    assert "interaction_age_mismatch:cooking:baby" in plan["warnings"] and plan["scene"]["interaction"] == "cooking"
    too_many = _explicit("e-familia", interaction="hugging")
    assert _error(too_many).code == "INTERACTION_INCOMPATIBLE"


def test_given_no_interaction_then_it_comes_from_the_products_scene_intents_or_the_group_default_and_never_for_one_person():
    plan = _plan("b-menino-e-mae")
    request = _explicit()
    request.pop("interaction", None)
    reading = plan_creative(request, router=ROUTER)
    assert (reading["scene"]["interaction"], reading["provenance"]["scene.interaction"]) == ("reading_together", "product"), "intent: reading"
    request["products"][0].pop("semantic_context")
    default = plan_creative(request, router=ROUTER)
    assert (default["scene"]["interaction"], default["provenance"]["scene.interaction"]) == ("candid", "planner_default")
    single = _explicit(subjects=[{"persona": _person("menina 7 anos", "child_6_9")}])
    single.pop("interaction", None)
    assert plan_creative(single, router=ROUTER)["scene"]["interaction"] is None
    baby = _explicit(subjects=[{"persona": _person("bebê", "baby")}, {"persona": _person("mulher 30 anos", "adult"), "relation_to_primary": "mother"}])
    baby.pop("interaction", None)
    other = plan_creative(baby, router=ROUTER)
    assert (other["scene"]["interaction"], other["provenance"]["scene.interaction"]) == ("looking_at_each_other", "product"), \
        "reading excludes babies, so the product's next intent (bond) wins"
    assert plan["scene"]["interaction"] == "reading_together"


def test_given_field_origin_then_it_prefers_the_per_field_record_and_falls_back_to_the_aggregate():
    """Fase F.2.A: composition.field_origin is the single place that resolves ONE field's provenance."""
    assert composition.field_origin(None, "wearer_roles") is None, "no semantic_context at all"
    old_style = {"wearer_roles": ["child"], "source": "enrichment"}
    assert composition.field_origin(old_style, "wearer_roles") == "product_enrichment", "no field_sources — old aggregate rules, unchanged"
    mixed = {"wearer_roles": ["child"], "recommended_supporting_roles": ["father"], "source": "enrichment",
             "field_sources": {"wearer_roles": "manual"}}
    assert composition.field_origin(mixed, "wearer_roles") == "product", "explicit per-field record wins over the aggregate"
    assert composition.field_origin(mixed, "recommended_supporting_roles") == "product_enrichment", "no per-field record for THIS field — falls back to the aggregate"
    assert composition.field_origin(mixed, "scene_intents") == "product_enrichment", "unpopulated field, same fallback rule"


def test_given_the_gaze_then_the_interaction_implies_it_unless_the_user_asked_for_another():
    assert _plan("c-duas-irmas")["scene"]["gaze"]["reason"] == "interaction:candid"
    walking = plan_creative(_explicit(interaction="walking"), router=ROUTER)
    assert walking["scene"]["gaze"]["mode"] == "off_camera" and walking["scene"]["gaze"]["source"] == "planner_default"
    forced = plan_creative(_explicit(interaction="walking", gaze_mode="camera"), router=ROUTER)
    assert forced["scene"]["gaze"] == {"mode": "camera", "requested": "camera", "source": "user", "reason": "requested"}
    assert forced["provenance"]["scene.gaze"] == "user"
    assert plan_creative(_explicit(interaction="hugging"), router=ROUTER)["scene"]["gaze"]["mode"] == "interaction"


def test_given_pose_risk_then_the_interaction_adds_to_it_and_four_people_are_never_the_safe_configuration():
    risk = planner_v2.composition
    hug = composition.interaction_detail("hugging")
    assert risk("LIFESTYLE_COTIDIANO", 2, {}, hug) == {"people_count": 2, "pose_risk": "medium", "risk_reasons": ["people:2", "interaction:hugging"]}
    assert risk("LIFESTYLE_COTIDIANO", 3, {}, composition.interaction_detail("candid"))["pose_risk"] == "medium"
    assert risk("LIFESTYLE_COTIDIANO", 4, {}, composition.interaction_detail("candid"))["pose_risk"] == "high"
    for fixture in ("a-pai-e-filha",):
        assert len(_plan(fixture)["subjects"]) <= 2, "the planner recommends at most a primary and one supporting person"
    three = _explicit("e-familia", subjects=_fixture("e-familia")["subjects"][:3], interaction="group_photo")
    plan = plan_creative(three, router=ROUTER)
    assert "people_count_risk:3" in plan["warnings"] and plan["composition"]["pose_risk"] == "medium"
    assert "people_count_risk:4" in _plan("e-familia")["warnings"]


def test_given_scene_composition_fields_on_a_v1_plan_then_they_are_refused_instead_of_silently_dropped():
    for field, value in (("subjects", _fixture("b-menino-e-mae")["subjects"]), ("interaction", "playing"), ("scene_picks", {"acao": 0})):
        request = {**_explicit(), "plan_schema_version": 1, field: value}
        request.pop("prompt_version", None)
        assert f"{field}: requires plan_schema_version 2" in _error(request).details["errors"], field
    v1_prompt = {**_explicit(), "prompt_version": 1, "scene_picks": {"acao": 0}}
    assert "scene_picks: requires prompt_version 2 (picks belong to the v2 scene pools)" in _error(v1_prompt).details["errors"]
    default = {k: v for k, v in _explicit().items() if k != "plan_schema_version"}
    assert "subjects: requires plan_schema_version 2" in _error(default).details["errors"], "the service default is v1"
    assert plan_creative({**default, "plan_schema_version": 2}, router=ROUTER)["schema_version"] == 2


# ------------------------------------------------------------------ minors: explicit age first
def test_given_a_declared_age_then_it_wins_over_the_text_and_the_heuristic_is_only_the_fallback():
    request = _explicit(subjects=[{"persona": _person("Ana"), "age_band": "child_3_5"}, {"persona": _person("mulher 30 anos", "adult"), "relation_to_primary": "mother"}])
    plan = plan_creative(request, router=ROUTER)
    assert plan["subjects"][0]["is_minor"] and plan["subjects"][0]["age_source"] == "subject.age_band"
    assert plan["minor_safety"]["basis"] == {"explicit": ["s1"], "heuristic": []}
    contradicting = _explicit(subjects=[{"persona": _person("mulher 30 anos"), "age_band": "child_6_9"}])
    assert plan_creative(contradicting, router=ROUTER)["subjects"][0]["is_minor"] is True, "the declared band beats the label"
    from_persona = _explicit(subjects=[{"persona": {"label": "Ana", "age_band": "child_10_12"}}])
    plan = plan_creative(from_persona, router=ROUTER)
    assert plan["subjects"][0]["age_source"] == "persona.age_band" and plan["minor_safety"]["basis"]["explicit"] == ["s1"]
    assert plan["provenance"]["subjects.s1.age_band"] == "persona"
    heuristic = _explicit(subjects=[{"persona": _person("menina 6 anos")}])
    plan = plan_creative(heuristic, router=ROUTER)
    assert plan["subjects"][0]["age_source"] == "persona.label" and plan["minor_safety"]["basis"] == {"explicit": [], "heuristic": ["s1"]}


def test_given_an_undeclared_age_and_an_infant_product_then_the_primary_is_still_treated_as_a_minor_for_safety():
    single = _explicit(subjects=[{"persona": _person("modelo")}])
    single.pop("interaction", None)
    plan = plan_creative(single, router=ROUTER)
    assert plan["subjects"][0]["is_minor"] and plan["subjects"][0]["age_source"] == "product.type"
    assert plan["minor_safety"]["basis"]["heuristic"] == ["s1"] and plan["minor_safety"]["applies"]


# ------------------------------------------------------------------ recommendation rules
def test_given_the_recommendation_rules_then_it_only_applies_where_it_may():
    base = _fixture("a-pai-e-filha")
    assert plan_creative(base, router=ROUTER)["scene"]["composition_source"] == "recommended"
    for angle, reason in (("CAIMENTO", "single-person fit"), ("CLOSE_ESTAMPA", "close shot"), ("PRESENTE_AFETO", "has its own template"), ("CREATOR_STYLE", "selfie")):
        plan = plan_creative({**base, "angle_id": angle}, router=ROUTER)
        assert plan["scene"]["composition_source"] == "legacy", reason
        assert len(plan["subjects"]) <= 2
    explicit = {**base, "subjects": [{"persona": _person("menina 7 anos", "child_6_9")}]}
    plan = plan_creative(explicit, router=ROUTER)
    assert plan["scene"]["composition_source"] == "explicit" and len(plan["subjects"]) == 1, "the request wins over the recommendation"
    no_semantic = copy.deepcopy(base)
    no_semantic["products"][0].pop("semantic_context")
    assert plan_creative(no_semantic, router=ROUTER)["scene"]["composition_source"] == "legacy"


def test_given_a_custom_persona_then_the_recommendation_keeps_it_as_the_primary():
    request = {**_fixture("a-pai-e-filha"), "persona_mode": "custom", "persona": _person("menino 8 anos", "child_6_9")}
    plan = plan_creative(request, router=ROUTER)
    assert plan["scene"]["composition_source"] == "recommended" and plan["subjects"][0]["label"] == "menino 8 anos"
    assert plan["subjects"][0]["source"] == "user" and plan["subjects"][1]["source"] == "product" and plan["provenance"]["subjects"] == "mixed"
    assert plan["persona"]["label"] == "menino 8 anos", "plan.persona follows the primary subject"


def test_given_an_enrichment_sourced_semantic_context_then_the_recommended_cast_is_attributed_to_the_enrichment():
    request = _fixture("a-pai-e-filha")
    request["products"][0]["semantic_context"]["source"] = "enrichment"
    plan = plan_creative(request, router=ROUTER)
    assert plan["subjects"][1]["source"] == "product_enrichment" and plan["provenance"]["scene.interaction"] == "product_enrichment"


def test_given_a_partially_approved_proposal_then_only_the_accepted_fields_are_attributed_to_the_enrichment():
    """Fase F.2.A audit: a partial approval (`recommended_supporting_roles`/`scene_intents` accepted,
    `wearer_roles` preserved manual) used to flip the object's aggregate `source`, which made this SAME fixture's
    primary subject (cast from `wearer_roles`) read as `product_enrichment` — wrong, since the lojista never
    touched that field. `field_sources` is what the real merge (enrichment.merge / mergeSemanticContext) would
    have written for exactly this decision."""
    request = _fixture("a-pai-e-filha")
    semantic = request["products"][0]["semantic_context"]
    semantic["source"] = "enrichment"
    semantic["field_sources"] = {
        "wearer_roles": "manual", "relationship_themes": "manual",
        "incompatible_auto_supporting_roles": "manual", "visible_text": "manual",
        "recommended_supporting_roles": "enrichment", "scene_intents": "enrichment",
    }
    plan = plan_creative(request, router=ROUTER)
    assert plan["subjects"][0]["source"] == "product", "wearer_roles was never accepted — stays attributed to the product, not the enrichment"
    assert plan["subjects"][1]["source"] == "product_enrichment", "recommended_supporting_roles WAS accepted"
    assert plan["provenance"]["scene.interaction"] == "product_enrichment", "scene_intents WAS accepted"
    assert plan["provenance"]["semantics"] == "mixed", "populated fields genuinely disagree on origin"
    assert contracts.validate("CreativePlan", plan) == []


# ------------------------------------------------------------------ legacy stays legacy; frozen compiler v1
def test_given_a_request_without_subjects_or_interaction_then_the_scene_keeps_the_angles_own_template():
    from test_plan_v2 import _plan as legacy_plan

    plan = legacy_plan(angle="LIFESTYLE_COTIDIANO", prompt_version=2, seed=4)
    assert (plan["scene"]["composition_source"], plan["scene"]["scene_mode"], plan["scene"]["interaction"]) == ("legacy", "template", None)
    assert "EM AÇÃO, numa única situação" in plan["prompt"]["text"] and "interaction" not in _sections(plan)
    assert plan["scene"]["picks"]["acao"]["text"] in plan["prompt"]["text"]


def test_given_the_frozen_fase_b_plans_then_the_versioned_compiler_recompiles_each_one_byte_for_byte():
    stored = sorted(glob.glob(str(FIXTURES / "plans_fase_b" / "*.json")))
    assert len(stored) == 18
    for path in stored:
        plan = json.loads(Path(path).read_text(encoding="utf-8"))["plan"]
        assert plan["compiler"]["version"] == 1
        compiled = compile_prompt(plan)
        assert compiled["text"] == plan["prompt"]["text"] and compiled["compiler_version"] == 1, path
        assert "interaction" not in [s["section"] for s in compiled["sections"]]
    from test_plan_v2 import _plan as legacy_plan

    fresh = legacy_plan(angle="LIFESTYLE_COTIDIANO", prompt_version=2, seed=4)
    assert compile_prompt(fresh, version=1)["compiler_version"] == 1 and compile_prompt(fresh)["compiler_version"] == 3


def test_given_an_unknown_compiler_version_then_the_compiler_refuses_it():
    plan = _plan("b-menino-e-mae")
    try:
        compile_prompt({**plan, "compiler": {"version": 99, "sections": []}})
    except ValueError as exc:
        assert "unknown compiler version 99" in str(exc)
    else:
        raise AssertionError("compiled with an unknown version")


# ------------------------------------------------------------------ scene picks replay
def test_given_scene_picks_from_an_earlier_plan_then_they_replay_the_same_scene_with_another_seed():
    from test_plan_v2 import _req as base_request

    request = {**base_request(angle="LIFESTYLE_COTIDIANO"), "plan_schema_version": 2, "prompt_version": 2, "seed": 4}
    first = plan_creative(request, router=ROUTER)
    picks = {name: entry["index"] for name, entry in first["scene"]["picks"].items()}
    replay = plan_creative({**request, "seed": 999, "scene_picks": picks}, router=ROUTER)
    assert replay["scene"]["picks"] == first["scene"]["picks"] and replay["seed"] == 999
    assert first["scene"]["picks"]["acao"]["text"] in replay["prompt"]["text"], "the replayed action is in the new prompt"
    again = plan_creative({**request, "scene_picks": picks}, router=ROUTER)
    assert again["prompt"]["sha256"] == first["prompt"]["sha256"], "same seed and same picks: same prompt"
    for bad in ({"nope": 0}, {"acao": 99}, {"acao": -1}, {"acao": "x"}, {"acao": True}):
        assert _error({**request, "scene_picks": bad}).code == "INVALID_INPUT", bad


# ------------------------------------------------------------------ scene picks x interaction
def test_given_a_frame_scene_then_it_persists_no_scene_picks_and_they_do_not_move_gaze_or_risk():
    for name in ("a-pai-e-filha", "b-menino-e-mae", "c-duas-irmas", "d-casal", "e-familia"):
        plan = _plan(name)
        assert plan["scene"]["scene_mode"] == "frame" and plan["scene"]["picks"] == {}, name
        assert not [r for r in plan["composition"]["risk_reasons"] if r.startswith(("held_object", "contact"))], name
        assert "pool:" not in plan["scene"]["gaze"]["reason"], name
    assert "a chegar" not in _plan("a-pai-e-filha")["prompt"]["text"] and "saindo de" not in _plan("a-pai-e-filha")["prompt"]["text"]


def test_given_a_template_scene_then_its_picks_are_the_scene_and_are_still_persisted_and_priced():
    from test_plan_v2 import _plan as legacy_plan

    plan = legacy_plan(angle="LIFESTYLE_COTIDIANO", prompt_version=2, seed=4)
    assert plan["scene"]["scene_mode"] == "template" and plan["scene"]["picks"]["acao"]["text"] in plan["prompt"]["text"]
    assert "held_object:acao" in plan["composition"]["risk_reasons"] and plan["scene"]["gaze"]["reason"].startswith("pool:acao")


def test_given_picks_sent_with_a_frame_scene_then_they_are_ignored_out_loud_and_the_prompt_is_the_same():
    request = _fixture("b-menino-e-mae")
    base = plan_creative(request, router=ROUTER)
    sent = plan_creative({**request, "scene_picks": {"acao": 2}}, router=ROUTER)
    assert "scene_picks_ignored:frame_scene" in sent["warnings"] and sent["scene"]["picks"] == {}
    assert sent["prompt"]["sha256"] == base["prompt"]["sha256"], "a pick nobody reads cannot change the creative"


def test_given_a_recommended_or_explicit_cast_then_again_and_the_snapshot_carry_no_picks():
    from creative_core.drafts import feedback_snapshot, generation_draft_from_plan

    for name in ("a-pai-e-filha", "b-menino-e-mae", "e-familia"):
        plan = _plan(name)
        draft = generation_draft_from_plan(plan)
        assert draft["scene_picks"] is None and draft["actions"]["again"]["scene_picks"] is None, name
        assert "scene_picks" not in json.dumps(feedback_snapshot(plan)), name


# ------------------------------------------------------------------ contracts
def test_given_the_new_request_and_persona_fields_then_the_contracts_accept_them_and_reject_bad_values():
    request = _fixture("b-menino-e-mae")
    assert contracts.validate("CreativeRequest", request) == []
    assert contracts.validate("Persona", {"label": "x", "age_band": "child_6_9"}) == [] and contracts.validate("Persona", {"label": "x", "age_band": "kid"})
    assert contracts.validate("RequestSubject", {"persona": {"label": "x"}, "wears_product_id": None}) == []
    for bad in ({"relation_to_primary": "cousin"}, {"age_band": "toddler"}, {"role": "extra"}, {"unknown": 1}):
        assert contracts.validate("RequestSubject", {"persona": {"label": "x"}, **bad}), bad
    assert contracts.validate("RequestSubject", {"role": "primary"}), "a subject needs its persona"
    assert contracts.validate("CreativeRequest", {**request, "interaction": ""}) and contracts.validate("CreativeRequest", {**request, "scene_picks": []})


if __name__ == "__main__":
    run(globals())
