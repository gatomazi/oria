"""Prompt compiler v2 (Fase B): named sections, each with its source and value, compiled from the plan alone."""
from __future__ import annotations

import copy
import hashlib
import json

from _support import all_fixtures, load_fixture, run
from golden_prompt_v1 import ROUTER
from test_plan_v2 import CHILD, POLICY_FULL, SEMANTIC_FATHER, _child_request  # noqa: F401
from test_service import TOKEN, Factory, _call

from creative_core import contracts
from creative_core.compiler import SECTION_ORDER, compile_prompt, prompt_info
from creative_core.engines import plan_creative
from creative_core.model_router import ModelRouter
from creative_core.service import CreativeCoreService, _env_plan_schema_version
from creative_core.versions import COMPILER_VERSION


def _v2(fixture="fixture-clean-single", **extra) -> dict:
    request = copy.deepcopy(load_fixture(fixture)["input"])
    request.update(plan_schema_version=2, **extra)
    return plan_creative(request, router=ROUTER)


def test_given_a_full_child_plan_then_the_sections_come_in_the_documented_order_with_source_and_value():
    plan = plan_creative(_child_request("PRESENTE_AFETO", semantic=SEMANTIC_FATHER, policy=POLICY_FULL, seed=100), router=ROUTER)
    compiled = compile_prompt(plan)
    names = [s["section"] for s in compiled["sections"]]
    assert names == [n for n in SECTION_ORDER if n in names], "always in SECTION_ORDER"
    assert names == ["fidelity_rules", "text_rules", "minor_safety", "reference_roles", "product_semantic_context",
                     "people_composition_contract", "gaze", "scene_action", "minor_wardrobe_policy", "brand", "niche",
                     "context", "avoid", "output_format"]
    by = {s["section"]: s for s in compiled["sections"]}
    assert by["gaze"] == {"section": "gaze", "source": "angle", "value": "interaction", "length": by["gaze"]["length"]}
    assert (by["minor_safety"]["source"], by["minor_wardrobe_policy"]["source"], by["reference_roles"]["source"]) == ("safety_policy", "brand", "product")
    assert by["people_composition_contract"]["value"] == "2" and by["scene_action"]["value"] == "PRESENTE_AFETO"
    assert by["output_format"]["value"] == "FEED_4X5" and by["text_rules"]["value"] == "clean_creative"


def test_given_a_compiled_prompt_then_lengths_and_hash_add_up_and_the_text_is_the_sections_in_order():
    for fixture in all_fixtures():
        plan = plan_creative({**fixture["input"], "plan_schema_version": 2}, router=ROUTER)
        compiled = compile_prompt(plan)
        assert sum(s["length"] for s in compiled["sections"]) + 2 * (len(compiled["sections"]) - 1) == len(compiled["text"])
        assert compiled["sha256"] == hashlib.sha256(compiled["text"].encode("utf-8")).hexdigest()
        assert compiled["compiler_version"] == COMPILER_VERSION == plan["compiler"]["version"]
        cursor = 0
        for s in compiled["sections"]:
            assert len(compiled["text"][cursor:cursor + s["length"]]) == s["length"]
            cursor += s["length"] + 2
        assert plan["compiler"]["sections"] == compiled["sections"]


def test_given_plan_prompt_then_it_keeps_the_promptinfo_shape_and_adds_source_and_value_per_section():
    plan = _v2()
    assert set(plan["prompt"]) == {"text", "sections", "sha256", "prompt_version"}
    for section in plan["prompt"]["sections"]:
        assert set(section) == {"name", "length", "source", "value"}
    assert plan["prompt"] == prompt_info(compile_prompt(plan))
    assert contracts.validate("PromptInfo", plan["prompt"]) == []


def test_given_absolute_rules_then_they_stay_ahead_of_the_scene_as_in_v1_and_avoid_and_format_stay_last():
    text_sections = [s["section"] for s in _v2()["compiler"]["sections"]]
    assert text_sections[:2] == ["fidelity_rules", "text_rules"] and text_sections[-2:] == ["avoid", "output_format"]
    assert text_sections.index("scene_action") > text_sections.index("reference_roles")


def test_given_the_compiler_then_it_never_calls_the_seed_or_reads_anything_outside_the_plan():
    plan = _v2(seed=5)
    other = copy.deepcopy(plan)
    other["seed"] = 999  # the seed is a record, not an input of the compiler
    assert compile_prompt(other)["sha256"] == plan["prompt"]["sha256"]
    changed = copy.deepcopy(plan)
    changed["scene"]["gaze"]["mode"] = "product"
    assert compile_prompt(changed)["sha256"] != plan["prompt"]["sha256"], "but the plan's own fields drive it"


def test_given_v2_scene_wording_then_the_compiler_reuses_the_picks_stored_in_the_plan():
    plan = _v2(angle_id="LIFESTYLE_COTIDIANO", prompt_version=2, seed=4)
    pick = plan["scene"]["picks"]["acao"]
    assert pick["text"] in plan["prompt"]["text"]
    other = copy.deepcopy(plan)
    other["scene"]["picks"]["acao"] = {"index": 0, "text": planner_first_action()}
    assert planner_first_action() in compile_prompt(other)["text"] and pick["text"] not in compile_prompt(other)["text"]


def planner_first_action() -> str:
    from creative_core import prompt_v2

    return prompt_v2.ANGLES["LIFESTYLE_COTIDIANO"]["pools"]["acao"][0]


def test_given_v1_scene_wording_in_a_v2_plan_then_the_generic_angle_text_is_used():
    plan = _v2(angle_id="CAIMENTO")  # prompt_version defaults to 1
    assert plan["scene"]["prompt_version"] == 1 and plan["prompt"]["prompt_version"] == 1
    assert "ÂNGULO CAIMENTO: " in plan["prompt"]["text"] and "PRIORIDADE VISUAL ESTRITA" not in plan["prompt"]["text"]


def test_given_clean_angles_then_the_v2_prompt_still_carries_no_overlay_instruction():
    plan = _v2()
    assert all(v["passed"] for v in plan["validations"])
    assert {"rule": "clean_angles_has_no_overlay", "passed": True} in plan["validations"]


# ------------------------------------------------------------------ service
def _app(**kwargs):
    return CreativeCoreService(TOKEN, client_factory=Factory(), router=ModelRouter(env={}), **kwargs)


def test_given_service_then_plan_schema_default_comes_from_constructor_or_env_and_a_request_overrides_it():
    for raw, expected in (("2", 2), ("1", 1), ("", 1), ("3", 1), ("x", 1)):
        assert _env_plan_schema_version({"CREATIVE_PLAN_SCHEMA_VERSION": raw}) == expected, raw
    request = copy.deepcopy(load_fixture("fixture-clean-single")["input"])
    for default in (1, 2):
        app = _app(plan_schema_version=default)
        contracts_body = _call(app, "GET", "/v1/contracts")[1]
        assert contracts_body["plan_schema_versions"] == {"supported": [1, 2], "default": default, "compiler_version": COMPILER_VERSION}
        assert _call(app, "POST", "/v1/plans", {"request": request})[1]["plan"]["schema_version"] == default
        forced = _call(app, "POST", "/v1/plans", {"request": {**request, "plan_schema_version": 1}})[1]["plan"]
        assert forced["schema_version"] == 1
    assert _app(plan_schema_version=7)._plan_schema_version == 1


def test_given_a_persisted_v2_plan_when_posted_to_compile_then_the_same_prompt_comes_back():
    app = _app()
    request = {**copy.deepcopy(load_fixture("fixture-clean-single")["input"]), "plan_schema_version": 2}
    plan = _call(app, "POST", "/v1/plans", {"request": request})[1]["plan"]
    status, body, _ = _call(app, "POST", "/v1/compile", {"plan": plan})
    assert status == 200 and body["compiled"]["sha256"] == plan["prompt"]["sha256"] and body["compiled"]["text"] == plan["prompt"]["text"]
    assert _call(app, "POST", "/v1/compile", {"plan": {**plan, "schema_version": 1}})[0] == 422
    v1 = _call(app, "POST", "/v1/plans", {"request": {**request, "plan_schema_version": 1}})[1]["plan"]
    assert _call(app, "POST", "/v1/compile", {"plan": v1})[0] == 422
    assert _call(app, "POST", "/v1/compile", {"plan": {"nope": 1}})[0] == 422
    assert _call(app, "POST", "/v1/compile", {"plan": plan}, token="x" * 40)[0] == 401
    assert _call(app, "GET", "/v1/compile")[0] == 405


def test_given_the_plan_json_when_serialized_then_it_is_plain_json():
    plan = _v2()
    assert json.loads(json.dumps(plan, ensure_ascii=False)) == plan


if __name__ == "__main__":
    run(globals())
