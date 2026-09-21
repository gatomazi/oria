"""CreativePlan v2 (Fase B): gaze, minor safety, semantics, subjects, provenance — as plan data, resolved before the
prompt is compiled. v1 plans stay exactly as they were."""
from __future__ import annotations

import copy
import json
from pathlib import Path

from _support import all_fixtures, load_fixture, run
from golden_prompt_v1 import ROUTER

from creative_core import contracts, planner_v2
from creative_core.angles import ANGLE_IDS
from creative_core.compiler import SECTION_ORDER, compile_prompt
from creative_core.engines import plan_creative
from creative_core.errors import GenerationError
from creative_core.kits import load_brand_kit
from creative_core.plan_sources import FIELD_SOURCES, required_user_fields, user_input_fields

V2_FIXTURES = Path(__file__).resolve().parents[1] / "fixtures_v2"
CHILD = {"label": "menina 6 anos"}
SEMANTIC_FATHER = {"wearer_roles": ["child"], "relationship_themes": ["father_child"], "recommended_supporting_roles": ["father"],
                   "incompatible_auto_supporting_roles": ["mother"], "scene_intents": ["play", "bond"], "source": "manual"}
POLICY_FULL = {"enabled": True, "legs_coverage": "full", "allow_short_shorts": False, "allow_short_skirts": False,
               "allow_revealing_clothing": False, "style": "casual_age_appropriate"}


def _req(fixture="fixture-clean-single", angle="CAIMENTO", **extra) -> dict:
    request = copy.deepcopy(load_fixture(fixture)["input"])
    request.update(angle_id=angle, **extra)
    return request


def _plan(fixture="fixture-clean-single", angle="CAIMENTO", **extra) -> dict:
    extra.setdefault("plan_schema_version", 2)
    return plan_creative(_req(fixture, angle, **extra), router=ROUTER)


def _child_request(angle="CAIMENTO", *, semantic=None, policy=None, pool=None, seed=7, **extra) -> dict:
    request = _req("fixture-clean-single", angle, persona_mode="custom", persona=dict(CHILD), plan_schema_version=2,
                   prompt_version=2, seed=seed, **extra)
    request["products"][0]["type"] = "camiseta infantil"
    if semantic:
        request["products"][0]["semantic_context"] = semantic
    brand = {**load_brand_kit(request.pop("brand_kit_id"))}
    if policy is not None:
        brand["minorWardrobePolicy"] = policy
    if pool is not None:
        brand["suggestedPersonas"] = pool
    request["brand_kit"] = brand
    return request


def _sections(plan: dict) -> dict:
    return {s["section"]: s for s in plan["compiler"]["sections"]}


# ------------------------------------------------------------------ compatibility
def test_given_no_plan_schema_then_the_plan_is_the_v1_plan_with_none_of_the_v2_fields():
    plan = plan_creative(_req(), router=ROUTER)
    assert plan["schema_version"] == 1
    for field in ("mode", "objective", "subjects", "scene", "composition", "minor_safety", "semantics", "provenance",
                  "resolved_inputs", "compiler", "seed"):
        assert field not in plan, field
    assert "compiler_version" not in plan["versions"]
    explicit = plan_creative(_req(plan_schema_version=1), router=ROUTER)
    assert explicit["prompt"]["sha256"] == plan["prompt"]["sha256"] and explicit["schema_version"] == 1


def test_given_every_fixture_when_planned_as_v2_then_plan_is_valid_and_carries_every_v1_field_unchanged():
    for fixture in all_fixtures():
        request = fixture["input"]
        v1 = plan_creative(request, router=ROUTER)
        v2 = plan_creative({**request, "plan_schema_version": 2}, router=ROUTER)
        assert contracts.validate("CreativePlan", v2) == [], fixture["name"]
        assert v2["schema_version"] == 2 and v2["mode"] == "creative"
        for field in ("strategy", "product_mode", "products", "angle", "placement", "persona", "context", "brand_kit",
                      "niche_kit", "funnel_stage", "remarketing_intent", "layout", "overlay", "copy", "references", "model"):
            assert v2[field] == v1[field], (fixture["name"], field)
        assert v2["versions"]["compiler_version"] == 1 and v2["versions"]["schema_version"] == v1["versions"]["schema_version"]


def test_given_a_v2_plan_then_recompiling_it_reproduces_the_prompt_exactly_even_after_a_json_round_trip():
    for fixture in all_fixtures():
        plan = plan_creative({**fixture["input"], "plan_schema_version": 2}, router=ROUTER)
        compiled = compile_prompt(plan)
        assert compiled["text"] == plan["prompt"]["text"] and compiled["sha256"] == plan["prompt"]["sha256"], fixture["name"]
        stored = json.loads(json.dumps(plan, ensure_ascii=False))
        assert compile_prompt(stored)["sha256"] == plan["prompt"]["sha256"]
        assert contracts.validate("CompiledPrompt", compiled) == []


def test_given_a_v1_plan_then_the_v2_compiler_refuses_it():
    try:
        compile_prompt(plan_creative(_req(), router=ROUTER))
    except ValueError as exc:
        assert "schema_version 2" in str(exc)
    else:
        raise AssertionError("compiled a v1 plan")


def test_given_v2_plan_then_the_plan_is_deterministic():
    request = _child_request(semantic=SEMANTIC_FATHER, policy=POLICY_FULL)
    assert plan_creative(request, router=ROUTER) == plan_creative(copy.deepcopy(request), router=ROUTER)


def test_given_gaze_mode_on_a_v1_plan_then_it_is_reported_not_dropped_silently():
    plan = plan_creative(_req(gaze_mode="camera"), router=ROUTER)
    assert "gaze_mode_ignored_needs_plan_schema_2" in plan["warnings"] and "scene" not in plan


# ------------------------------------------------------------------ gaze
def test_given_the_requested_defaults_then_gaze_is_resolved_per_angle_and_people_count():
    for fixture, angle, expected in (
        ("fixture-clean-single", "CAIMENTO", "camera"), ("fixture-clean-single", "CLOSE_ESTAMPA", "camera"),
        ("fixture-clean-single", "IDENTIDADE_ORIGEM", "off_camera"), ("fixture-clean-single", "PRESENTE_AFETO", "none"),
    ):
        plan = _plan(fixture, angle, prompt_version=2)
        if angle == "PRESENTE_AFETO":
            assert plan["scene"]["gaze"]["mode"] == "interaction" and len(plan["subjects"]) == 2
        else:
            assert plan["scene"]["gaze"]["mode"] == expected, angle
    kit = _plan("fixture-clean-multi", "PRESENTE_AFETO", prompt_version=2)
    assert kit["subjects"] == [] and kit["scene"]["gaze"] == {"mode": "none", "requested": "auto", "source": "angle", "reason": "no_people_in_frame"}
    group = _plan("fixture-clean-multi", "LIFESTYLE_COTIDIANO", prompt_version=2)
    assert len(group["subjects"]) == 3 and group["scene"]["gaze"]["mode"] == "interaction"


def test_given_lifestyle_and_creator_then_the_gaze_follows_the_preset_the_plan_picked():
    seen = {"LIFESTYLE_COTIDIANO": set(), "CREATOR_STYLE": set()}
    for angle, pool in (("LIFESTYLE_COTIDIANO", "acao"), ("CREATOR_STYLE", "formato")):
        table = planner_v2.DATA["pool_gaze"][angle][pool]
        for seed in range(30):
            plan = _plan(angle=angle, prompt_version=2, seed=seed)
            index = plan["scene"]["picks"][pool]["index"]
            gaze = plan["scene"]["gaze"]
            assert gaze["mode"] == table[index] and gaze["reason"] == f"pool:{pool}:{index}" and gaze["source"] == "angle"
            seen[angle].add(gaze["mode"])
    assert seen["LIFESTYLE_COTIDIANO"] == {"camera", "off_camera"} and seen["CREATOR_STYLE"] == {"camera", "off_camera"}


def test_given_an_explicit_gaze_then_the_user_value_wins_and_auto_never_reaches_the_plan():
    for mode in ("camera", "interaction", "off_camera", "product"):
        plan = _plan(gaze_mode=mode)
        assert plan["scene"]["gaze"] == {"mode": mode, "requested": mode, "source": "user", "reason": "requested"}
    resolved = set(contracts.GAZE_RESOLVED)
    for fixture in all_fixtures():
        for angle in ANGLE_IDS:
            try:
                plan = plan_creative({**fixture["input"], "angle_id": angle, "plan_schema_version": 2, "gaze_mode": "auto"}, router=ROUTER)
            except GenerationError:
                continue
            assert plan["scene"]["gaze"]["mode"] in resolved and plan["scene"]["gaze"]["requested"] == "auto"


def test_given_gaze_then_the_compiler_writes_one_section_per_mode_and_exposes_source_and_value():
    texts = {}
    for mode in ("camera", "interaction", "off_camera", "product"):
        plan = _plan(gaze_mode=mode)
        section = _sections(plan)["gaze"]
        assert section["value"] == mode and section["source"] == "user"
        texts[mode] = plan["prompt"]["text"][plan["prompt"]["text"].index("OLHAR"):].split("\n\n")[0]
    assert len(set(texts.values())) == 4 and "para a câmera" in texts["camera"] and "não para a câmera" in texts["interaction"]
    assert "gaze" not in _sections(_plan("fixture-clean-multi", "PRESENTE_AFETO", prompt_version=2)), "nobody in frame -> no gaze section"
    group = _plan("fixture-clean-multi", "LIFESTYLE_COTIDIANO", prompt_version=2, gaze_mode="camera")
    assert "OLHAR: as pessoas olham diretamente para a câmera" in group["prompt"]["text"], "plural wording for a group"


# ------------------------------------------------------------------ minor safety
def test_given_a_child_persona_then_the_global_policy_applies_and_is_compiled_as_an_absolute_section():
    plan = plan_creative(_child_request(), router=ROUTER)
    safety = plan["minor_safety"]
    assert safety["applies"] and safety["minor_subject_ids"] == ["s1"] and safety["brand"] is None
    assert safety["global"]["policy"] == "global_minor_safety_policy" and safety["global"]["adult_child_rule"] is None
    assert safety["global"]["rules"] == ["age_appropriate_clothing", "nothing_revealing", "not_sexualized", "no_adult_aesthetic",
                                         "age_appropriate_poses", "normal_fit_no_body_focus", "commercial_family_context"]
    sections = _sections(plan)
    assert sections["minor_safety"]["source"] == "safety_policy" and "minor_wardrobe_policy" not in sections
    text = plan["prompt"]["text"]
    assert "PROTEÇÃO DE MENORES (regra absoluta" in text and "nada revelador" in text and "nada sexualizado" in text
    order = [s["section"] for s in plan["compiler"]["sections"]]
    assert order.index("fidelity_rules") < order.index("text_rules") < order.index("minor_safety") < order.index("reference_roles")


def test_given_only_adults_then_no_minor_text_is_emitted():
    plan = _plan(prompt_version=2)
    assert plan["minor_safety"]["applies"] is False and "minor_safety" not in _sections(plan)
    assert "PROTEÇÃO DE MENORES" not in plan["prompt"]["text"] and "VESTUÁRIO DAS CRIANÇAS" not in plan["prompt"]["text"]
    assert all(not s["is_minor"] for s in plan["subjects"])


def test_given_a_brand_policy_then_it_adds_the_wardrobe_section_on_top_of_the_global_one():
    plan = plan_creative(_child_request(policy=POLICY_FULL), router=ROUTER)
    brand = plan["minor_safety"]["brand"]
    assert brand["policy"] == "brand_minor_wardrobe_policy" and brand["source"] == "brand" and brand["ignored"] == []
    section = _sections(plan)["minor_wardrobe_policy"]
    assert section["source"] == "brand" and section["value"] == "full"
    text = plan["prompt"]["text"]
    for expected in ("VESTUÁRIO DAS CRIANÇAS (política da marca)", "pernas totalmente cobertas", "calça, jeans, sarja, legging apropriada",
                     "sem shorts curtos", "sem saias curtas", "roupas casuais infantis"):
        assert expected in text, expected
    assert "PROTEÇÃO DE MENORES" in text, "the global layer is still there"
    off = plan_creative(_child_request(policy={**POLICY_FULL, "enabled": False}), router=ROUTER)
    assert off["minor_safety"]["brand"] is None and "minor_wardrobe_policy" not in _sections(off)
    adults = _req(prompt_version=2, plan_schema_version=2)
    brand = {**load_brand_kit(adults.pop("brand_kit_id")), "minorWardrobePolicy": POLICY_FULL}
    adult_plan = plan_creative({**adults, "brand_kit": brand}, router=ROUTER)
    assert "VESTUÁRIO DAS CRIANÇAS" not in adult_plan["prompt"]["text"], "no minors, no wardrobe section"


def test_given_a_brand_that_tries_to_loosen_the_global_layer_then_it_cannot():
    policy = {"enabled": True, "legs_coverage": "full", "allow_short_shorts": True, "allow_short_skirts": True,
              "allow_revealing_clothing": True, "style": "casual_age_appropriate"}
    plan = plan_creative(_child_request(policy=policy), router=ROUTER)
    brand = plan["minor_safety"]["brand"]
    assert brand["ignored"] == ["allow_revealing_clothing"] and brand["effective"]["allow_revealing_clothing"] is False
    assert brand["requested"]["allow_revealing_clothing"] is True, "what was asked stays auditable"
    text = plan["prompt"]["text"]
    assert "sem shorts curtos" not in text and "nada revelador" in text
    assert plan["minor_safety"]["global"]["rules"], "the global rules do not depend on the brand at all"


def test_given_a_short_product_and_a_no_shorts_policy_then_a_warning_is_raised_and_nothing_is_blocked():
    request = _child_request(policy=POLICY_FULL)
    request["products"][0]["name"] = "Bermuda Infantil Verão"
    plan = plan_creative(request, router=ROUTER)
    assert any(w.startswith("brand_wardrobe_conflicts_with_product:") for w in plan["warnings"])


def test_given_age_evidence_then_minor_detection_follows_label_then_range_then_words_then_product():
    detect = planner_v2.detect_age
    assert detect({"label": "menina 6 anos"}) == ("child", "persona.label")
    assert detect({"label": "mulher 35 anos, mãe da menina"}) == ("adult", "persona.label"), "the number wins over 'menina'"
    assert detect({"label": "jovem", "age_range": "15-17"}) == ("teen", "persona.age_range")
    assert detect({"label": "Mulher 30 anos", "age_range": "3-5"}) == ("adult", "persona.label")
    assert detect({"label": "bebê sorrindo"}) == ("child", "persona.label") and detect({"label": "homem de barba"}) == ("adult", "persona.label")
    assert detect({"label": "pessoa estilosa"}) == ("unknown", None) and detect(None) == ("unknown", None)
    assert detect({"label": "criança"})[0] == "child" and detect({"label": "bebe 1 ano"})[0] == "baby"
    request = _req(persona_mode="custom", persona={"label": "modelo"}, plan_schema_version=2)
    request["products"][0]["type"] = "body infantil"
    plan = plan_creative(request, router=ROUTER)
    assert plan["subjects"][0]["is_minor"] and plan["subjects"][0]["minor_source"] == "product.type"


def test_given_an_adult_and_a_child_then_the_adult_child_contact_rule_is_part_of_the_plan_and_the_prompt():
    plan = plan_creative(_child_request("PRESENTE_AFETO", seed=100), router=ROUTER)
    assert plan["minor_safety"]["global"]["adult_child_rule"] == "adult_child_contact_family_only"
    assert "Contato físico entre adulto e criança apenas em situação familiar" in plan["prompt"]["text"]


# ------------------------------------------------------------------ semantics
def test_given_a_father_and_child_print_then_the_supporting_person_is_the_father_not_the_brand_pool_mother():
    pool = [{"label": "menina 6 anos"}, {"label": "mulher 35 anos, mãe da menina"}]
    for seed in (100, 102, 103):
        plan = plan_creative(_child_request("PRESENTE_AFETO", semantic=SEMANTIC_FATHER, pool=pool, seed=seed), router=ROUTER)
        supporting = [s for s in plan["subjects"] if s["role"] == "supporting"]
        assert len(supporting) == 1 and supporting[0]["role_hint"] == "father", seed
        assert plan["semantics"]["supporting"] == {"role": "father", "source": "product", "matched_role": "father"}
        assert not plan["semantics"]["warnings"] and not any(w.startswith("semantic_mismatch") for w in plan["warnings"])
    without = plan_creative(_child_request("PRESENTE_AFETO", pool=pool, seed=100), router=ROUTER)
    assert [s["role_hint"] for s in without["subjects"]] == [None, "mother"], "no semantics -> the pool decides, as before"


def test_given_a_father_persona_in_the_pool_then_it_is_preferred_over_a_synthesized_one():
    pool = [{"label": "menina 6 anos"}, {"label": "mulher 35 anos, mãe da menina"}, {"label": "homem 38 anos, pai de família"}]
    plan = plan_creative(_child_request("PRESENTE_AFETO", semantic=SEMANTIC_FATHER, pool=pool, seed=100), router=ROUTER)
    assert plan["subjects"][1]["label"] == "homem 38 anos, pai de família" and plan["subjects"][1]["role_hint"] == "father"


def test_given_only_incompatible_candidates_then_the_scene_proceeds_with_a_warning_and_never_blocks():
    semantic = {**SEMANTIC_FATHER, "recommended_supporting_roles": []}
    pool = [{"label": "menina 6 anos"}, {"label": "mulher 35 anos, mãe da menina"}]
    plan = plan_creative(_child_request("PRESENTE_AFETO", semantic=semantic, pool=pool, seed=100), router=ROUTER)
    assert contracts.validate("CreativePlan", plan) == []
    assert plan["subjects"][1]["role_hint"] == "mother"
    assert plan["semantics"]["warnings"] == [{"code": "semantic_mismatch", "theme": "father_child", "supporting_role": "mother", "product_id": plan["products"][0]["id"]}]
    assert "semantic_mismatch:father_child:mother" in plan["warnings"]


def test_given_a_manual_choice_that_contradicts_the_print_then_only_a_warning_comes_back():
    products = [{"id": "p1", "semantic_context": SEMANTIC_FATHER}]
    mother = [{"role": "supporting", "role_hint": "mother"}]
    father = [{"role": "supporting", "role_hint": "father"}]
    assert planner_v2.semantic_warnings(products, mother)[0]["code"] == "semantic_mismatch"
    assert planner_v2.semantic_warnings(products, father) == []
    assert planner_v2.semantic_warnings([{"id": "p2"}], mother) == [], "no semantics, no warning"


def test_given_semantic_context_then_the_prompt_uses_human_labels_and_never_asks_for_a_person_the_frame_lacks():
    single = plan_creative(_child_request("CAIMENTO", semantic=SEMANTIC_FATHER), router=ROUTER)
    text = single["prompt"]["text"]
    assert "SEMÂNTICA DO PRODUTO" in text and "tema: pai e filho(a)" in text and "quem veste: criança" in text
    assert "pessoa de apoio recomendada" not in text and "não altera a pose, o enquadramento nem a quantidade de pessoas" in text
    assert _sections(single)["product_semantic_context"]["value"] == "father_child" and _sections(single)["product_semantic_context"]["source"] == "product"
    pair = plan_creative(_child_request("PRESENTE_AFETO", semantic=SEMANTIC_FATHER, seed=100), router=ROUTER)
    assert "pessoa de apoio recomendada: pai" in pair["prompt"]["text"]
    enriched = plan_creative(_child_request(semantic={**SEMANTIC_FATHER, "source": "enrichment"}), router=ROUTER)
    assert _sections(enriched)["product_semantic_context"]["source"] == "product_enrichment"
    assert "product_semantic_context" not in _sections(plan_creative(_child_request(), router=ROUTER))


def test_given_semantic_context_on_a_v1_plan_then_it_is_carried_but_changes_nothing():
    request = _child_request(semantic=SEMANTIC_FATHER)
    request.update(plan_schema_version=1)
    request.pop("prompt_version")
    without = copy.deepcopy(request)
    del without["products"][0]["semantic_context"]
    assert plan_creative(request, router=ROUTER)["prompt"]["sha256"] == plan_creative(without, router=ROUTER)["prompt"]["sha256"]


# ------------------------------------------------------------------ subjects / composition / provenance
def test_given_the_gift_scenarios_then_subjects_say_who_wears_and_the_scenario_is_a_plan_field():
    seen = set()
    for seed in range(12):
        plan = _plan(angle="PRESENTE_AFETO", prompt_version=2, seed=seed)
        index = plan["scene"]["picks"]["cena"]["index"]
        a, b = plan["subjects"]
        assert (a["product_use"], b["product_use"]) == (("wears", "none") if index == 1 else ("none", "none")), seed
        assert (a["role"], b["role"]) == ("primary", "supporting") and a["relation_to_primary"] is None and b["relation_to_primary"] is None
        assert plan["scene"]["interaction"] is None
        seen.add(index)
    assert seen == {0, 1}


def test_given_multi_product_people_then_each_subject_wears_its_own_product_and_three_people_warn():
    plan = _plan("fixture-clean-multi", "LIFESTYLE_COTIDIANO", prompt_version=2)
    assert [s["product_id"] for s in plan["subjects"]] == [p["id"] for p in plan["products"]]
    assert all(s["product_use"] == "uses" for s in plan["subjects"]) or all(s["product_use"] == "wears" for s in plan["subjects"])
    assert plan["composition"]["people_count"] == 3 and plan["composition"]["pose_risk"] == "medium"
    assert "people_count_risk:3" in plan["warnings"]


def test_given_pose_risk_then_it_is_a_deterministic_function_of_people_props_and_contact():
    risk = planner_v2.composition
    assert risk("CAIMENTO", 1, {}) == {"people_count": 1, "pose_risk": "low", "risk_reasons": []}
    assert risk("CAIMENTO", 2, {})["pose_risk"] == "low" and risk("CAIMENTO", 3, {})["pose_risk"] == "medium"
    assert risk("CAIMENTO", 4, {})["pose_risk"] == "high" and risk("CAIMENTO", 6, {})["pose_risk"] == "high"
    holding = {"acao": {"index": 1, "text": "x"}}
    assert risk("LIFESTYLE_COTIDIANO", 1, holding) == {"people_count": 1, "pose_risk": "low", "risk_reasons": ["held_object:acao"]}
    handover = {"cena": {"index": 0, "text": "x"}}
    assert risk("PRESENTE_AFETO", 2, handover)["pose_risk"] == "medium"
    assert risk("PRESENTE_AFETO", 2, {"cena": {"index": 1, "text": "x"}})["pose_risk"] == "low"


def test_given_a_plan_then_provenance_names_the_origin_of_the_resolved_fields_from_the_known_vocabulary():
    custom = plan_creative(_child_request(policy=POLICY_FULL, semantic=SEMANTIC_FATHER), router=ROUTER)
    prov = custom["provenance"]
    assert set(prov.values()) <= set(contracts.VALUE_ORIGINS)
    assert prov["persona"] == "user" and prov["subjects"] == "user" and prov["scene.gaze"] == "angle"
    assert prov["minor_safety.global"] == "safety_policy" and prov["minor_safety.brand"] == "brand" and prov["semantics"] == "product"
    assert prov["context"] == "user", "the fixture picks its context explicitly"
    automatic = _plan()
    assert automatic["provenance"]["persona"] in ("brand", "niche", "planner_default") and automatic["provenance"]["minor_safety.brand"] == "planner_default"
    explicit = _plan(gaze_mode="product")
    assert explicit["provenance"]["scene.gaze"] == "user"
    enriched = plan_creative(_child_request(semantic={**SEMANTIC_FATHER, "source": "enrichment"}), router=ROUTER)
    assert enriched["provenance"]["semantics"] == "product_enrichment"


def test_given_a_composed_subjects_section_then_provenance_is_mixed_and_the_leaves_keep_their_own_origin():
    pool = [{"label": "menina 6 anos"}, {"label": "mulher 35 anos, mãe da menina"}]
    plan = plan_creative(_child_request("PRESENTE_AFETO", semantic=SEMANTIC_FATHER, pool=pool, seed=100), router=ROUTER)
    prov, sources = plan["provenance"], plan["provenance_sources"]
    assert prov["subjects"] == "mixed" and sources["subjects"] == ["product", "user"]
    assert (prov["subjects.s1"], prov["subjects.s2"]) == ("user", "product"), "the father cast from the product is not the user's decision"
    assert plan["subjects"][0]["source"] == "user" and plan["subjects"][1]["source"] == "product"
    assert prov["subjects.s1.age_band"] == "persona", "age read from the persona the user gave"
    assert prov["subjects.s2.age_band"] == "product", "age read from a label the planner generated from the product's semantics"
    section = _sections(plan)["people_composition_contract"]
    assert section["source"] == "mixed" and section["sources"] == ["product", "user"]
    assert contracts.validate("CreativePlan", plan) == []
    assert (set(prov.values()) - set(contracts.VALUE_ORIGINS)) <= {contracts.MIXED_ORIGIN}


def test_given_a_single_source_then_the_aggregate_is_that_source_and_the_section_carries_no_sources():
    plan = plan_creative(_child_request("CAIMENTO"), router=ROUTER)
    assert plan["provenance"]["subjects"] == "user" and plan["provenance_sources"]["subjects"] == ["user"]
    assert "sources" not in _sections(plan)["people_composition_contract"]
    explicit = plan_creative(_child_request("CAIMENTO", gaze_mode="product"), router=ROUTER)
    assert explicit["provenance"]["scene"] == "user" and "scene_action" in _sections(explicit) and _sections(explicit)["scene_action"]["source"] == "angle"


def test_given_scene_picks_then_the_scene_section_is_mixed_between_the_angle_and_the_planner():
    plan = _plan(angle="LIFESTYLE_COTIDIANO", prompt_version=2, seed=4)
    scene = _sections(plan)["scene_action"]
    assert scene["source"] == "mixed" and scene["sources"] == ["angle", "planner_default"]
    assert plan["provenance"]["scene"] == "mixed" and plan["provenance_sources"]["scene"] == ["angle", "planner_default"]
    assert _sections(_plan(angle="CAIMENTO"))["scene_action"]["source"] == "angle", "no picks, single origin"


def test_given_where_the_supporting_person_came_from_then_the_subject_says_so():
    pool = [{"label": "menina 6 anos"}, {"label": "mulher 35 anos, mãe da menina"}]
    from_pool = plan_creative(_child_request("PRESENTE_AFETO", pool=pool, seed=100), router=ROUTER)
    assert from_pool["subjects"][1]["source"] == "brand"
    enriched = plan_creative(_child_request("PRESENTE_AFETO", semantic={**SEMANTIC_FATHER, "source": "enrichment"}, pool=pool, seed=100), router=ROUTER)
    assert enriched["subjects"][1]["source"] == "product_enrichment" and enriched["provenance"]["subjects.s2"] == "product_enrichment"


def test_given_the_field_source_map_then_only_strategy_and_products_are_required_from_the_user():
    assert required_user_fields() == ["strategy / objective", "products"]
    origins = {o for entry in FIELD_SOURCES.values() for o in entry["origins"]}
    assert origins <= set(contracts.VALUE_ORIGINS)
    for hidden in ("scene.picks", "minor_safety.global", "minor_safety.brand", "composition (people_count, pose_risk)", "compiler (version, sections)"):
        assert FIELD_SOURCES[hidden]["user"] == "never", hidden
    assert len(user_input_fields()) <= 12, "the ceiling of what a form may ever show"


def test_given_a_v2_plan_then_every_top_level_field_is_covered_by_the_source_map_or_is_bookkeeping():
    bookkeeping = {"plan_id", "creative_id", "schema_version", "internal_strategy_id", "product_mode", "funnel_stage",
                   "remarketing_intent", "layout", "overlay", "copy", "prompt", "versions", "validations", "warnings",
                   "provenance", "provenance_sources", "resolved_inputs", "semantics", "mode", "objective"}
    covered = {key.split(" ")[0].split(".")[0].split("[")[0] for key in FIELD_SOURCES}
    covered |= {"strategy", "products", "references", "angle", "placement", "quality", "persona", "subjects", "scene", "composition",
                "minor_safety", "context", "model", "seed", "compiler", "brand_kit", "niche_kit"}
    plan = plan_creative(_child_request(), router=ROUTER)
    uncovered = sorted(set(plan) - covered - bookkeeping)
    assert not uncovered, f"add these plan fields to plan_sources.FIELD_SOURCES: {uncovered}"


# ------------------------------------------------------------------ contracts
def test_given_new_request_and_kit_fields_then_the_contracts_accept_valid_values_and_reject_bad_ones():
    ok = _req(plan_schema_version=2, gaze_mode="interaction")
    assert contracts.validate("CreativeRequest", ok) == []
    for field, value in (("plan_schema_version", 3), ("plan_schema_version", 0), ("gaze_mode", "stare"), ("gaze_mode", 1)):
        assert contracts.validate("CreativeRequest", {**_req(), field: value}), (field, value)
    assert contracts.validate("MinorWardrobePolicy", POLICY_FULL) == []
    assert contracts.validate("MinorWardrobePolicy", {"legs_coverage": "bare"}) and contracts.validate("MinorWardrobePolicy", {"nope": 1})
    assert contracts.validate("ProductSemanticContext", SEMANTIC_FATHER) == []
    assert contracts.validate("ProductSemanticContext", {"wearer_roles": "child"}) and contracts.validate("ProductSemanticContext", {"unknown": []})
    assert contracts.validate("ProductSemanticContext", {"confidence": 1.5})
    kit = {**load_brand_kit("use_origens"), "minorWardrobePolicy": POLICY_FULL}
    assert contracts.validate("BrandKit", kit) == []


def test_given_the_entre_nos_fixtures_then_they_plan_as_documented():
    caimento = json.loads((V2_FIXTURES / "fixture-v2-entre-nos-caimento.json").read_text(encoding="utf-8"))["input"]
    presente = json.loads((V2_FIXTURES / "fixture-v2-entre-nos-presente.json").read_text(encoding="utf-8"))["input"]
    for request in (caimento, presente):
        assert contracts.validate("CreativeRequest", request) == []
    a = plan_creative(caimento, router=ROUTER)
    assert a["minor_safety"]["applies"] and _sections(a)["minor_wardrobe_policy"]["value"] == "full"
    assert a["scene"]["gaze"]["mode"] == "camera" and len(a["subjects"]) == 1 and a["composition"]["pose_risk"] == "low"
    b = plan_creative(presente, router=ROUTER)
    assert [s["role_hint"] for s in b["subjects"]] == [None, "father"] and b["scene"]["gaze"]["mode"] == "interaction"
    assert b["subjects"][0]["product_use"] == "wears" and b["subjects"][1]["product_use"] == "none"
    assert "homem adulto, pai da criança" in b["prompt"]["text"] and "mãe da menina" not in b["prompt"]["text"]
    assert not b["semantics"]["warnings"]


if __name__ == "__main__":
    run(globals())
