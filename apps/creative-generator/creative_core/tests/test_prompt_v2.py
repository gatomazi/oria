"""PROMPT_VERSION=2 (Fase A3): person scenes with one action, defined roles and hand positions — opt-in,
touching only four angles, with v1 frozen by golden hashes."""
from __future__ import annotations

import copy
import json
import re

from _support import all_fixtures, load_fixture, run
from golden_prompt_v1 import GOLDEN, PLACEMENTS, ROUTER, SEED_OFFSETS
from test_service import TOKEN, Factory, _call

from creative_core import prompt_v2
from creative_core.angles import ANGLE_IDS
from creative_core.contracts import validate
from creative_core.engines import plan_creative
from creative_core.errors import GenerationError
from creative_core.model_router import ModelRouter
from creative_core.service import CreativeCoreService, _env_prompt_version

GOLDEN_V1 = json.loads(GOLDEN.read_text(encoding="utf-8"))
V2_ANGLES = ("CAIMENTO", "CREATOR_STYLE", "LIFESTYLE_COTIDIANO", "PRESENTE_AFETO")
SECTION_ORDER = ("core_rules", "strategy_rules", "brand_kit", "niche_kit", "context_profile", "product", "angle",
                 "persona", "placement", "strategy_communication", "avoid")


def _request(fixture: str = "fixture-clean-single", angle: str = "LIFESTYLE_COTIDIANO", **extra) -> dict:
    request = copy.deepcopy(load_fixture(fixture)["input"])
    request.update(angle_id=angle, **extra)
    return request


def _plan(fixture="fixture-clean-single", angle="LIFESTYLE_COTIDIANO", **extra) -> dict:
    return plan_creative(_request(fixture, angle, **extra), router=ROUTER)


def _sections(plan: dict) -> dict:
    """The prompt split back into its named sections (they are joined by a blank line, in a fixed order)."""
    text = plan["prompt"]["text"]
    parts, out, cursor = plan["prompt"]["sections"], {}, 0
    for part in parts:
        out[part["name"]] = text[cursor:cursor + part["length"]]
        cursor += part["length"] + 2
    return out


def test_given_v2_requested_when_planning_the_whole_matrix_then_only_person_scenes_of_the_four_angles_change():
    checked = changed = 0
    for fixture in all_fixtures():
        base = fixture["input"]
        for angle in ANGLE_IDS:
            for placement in PLACEMENTS:
                for offset in SEED_OFFSETS:
                    key = f"{fixture['name']}/{angle}/{placement}/seed+{offset}"
                    request = copy.deepcopy(base)
                    request.update(angle_id=angle, placement_id=placement, seed=int(base.get("seed", 0)) + offset, prompt_version=2)
                    try:
                        plan = plan_creative(request, router=ROUTER)
                    except GenerationError as err:
                        assert GOLDEN_V1[key] == {"error": err.code}
                        continue
                    checked += 1
                    same = plan["prompt"]["sha256"] == GOLDEN_V1[key]["sha256"]
                    if plan["prompt"]["prompt_version"] == 2:
                        changed += 1
                        assert angle in V2_ANGLES and base["strategy"] != "REMARKETING", key
                        assert not same, f"{key}: v2 reported but the prompt is identical"
                    else:
                        assert same, f"{key}: reports v1 but the prompt changed"
    assert checked > 200 and changed > 20, (checked, changed)


def test_given_v2_then_only_the_angle_and_persona_sections_differ_from_v1():
    for fixture, angle in (("fixture-clean-single", a) for a in V2_ANGLES):
        v1, v2 = _plan(fixture, angle, prompt_version=1), _plan(fixture, angle, prompt_version=2)
        s1, s2 = _sections(v1), _sections(v2)
        assert list(s1) == list(s2)
        differing = {name for name in s1 if s1[name] != s2[name]}
        assert differing <= {"angle", "persona", "core_rules"}, (angle, differing)
        assert {"angle", "persona"} <= differing
        assert v1["context"] == v2["context"] and v1["persona"] == v2["persona"] or angle == "PRESENTE_AFETO"


def test_given_version_selection_then_request_overrides_default_and_plan_reports_the_version_used():
    assert _plan(prompt_version=2)["prompt"]["prompt_version"] == 2
    assert _plan(prompt_version=2)["versions"]["prompt_version"] == 2
    assert _plan()["prompt"]["prompt_version"] == 1 and _plan()["versions"]["prompt_version"] == 1
    request = _request()
    assert plan_creative(request, router=ROUTER, default_prompt_version=2)["prompt"]["prompt_version"] == 2
    assert plan_creative({**request, "prompt_version": 1}, router=ROUTER, default_prompt_version=2)["prompt"]["prompt_version"] == 1
    other = _plan(angle="CABIDE", prompt_version=2)
    assert other["prompt"]["prompt_version"] == 1, "an angle outside the v2 set reports the version it used"
    for value in (0, 3, "2"):
        try:
            plan_creative(_request(prompt_version=value), router=ROUTER)
        except GenerationError as err:
            assert err.code == "INVALID_INPUT"
        else:
            raise AssertionError(f"accepted prompt_version={value!r}")


def test_given_remarketing_strategy_then_v2_is_not_applied_because_the_layout_owns_the_scene():
    plan = _plan("fixture-remarketing-single", "CAIMENTO", prompt_version=2)
    assert plan["prompt"]["prompt_version"] == 1


def test_given_same_request_then_v2_is_deterministic_and_version_does_not_move_scene_or_persona():
    assert _plan(prompt_version=2)["prompt"]["sha256"] == _plan(prompt_version=2)["prompt"]["sha256"]
    request = _request(angle="CAIMENTO")
    request.pop("seed", None)  # derived seed: must not depend on prompt_version
    v1 = plan_creative({**request, "prompt_version": 1}, router=ROUTER)
    v2 = plan_creative({**request, "prompt_version": 2}, router=ROUTER)
    assert v1["context"]["scene"] == v2["context"]["scene"] and v1["persona"] == v2["persona"]
    assert v1["plan_id"] != v2["plan_id"], "the plan id still tells the versions apart"


def test_given_different_seeds_then_the_single_action_and_formats_vary_but_each_plan_has_exactly_one():
    actions, formats = set(), set()
    for seed in range(24):
        life = _sections(_plan(angle="LIFESTYLE_COTIDIANO", prompt_version=2, seed=seed))["angle"]
        (action,) = [a for a in prompt_v2.ANGLES["LIFESTYLE_COTIDIANO"]["pools"]["acao"] if a in life]
        actions.add(action)
        creator = _sections(_plan(angle="CREATOR_STYLE", prompt_version=2, seed=seed))["angle"]
        (fmt,) = [i for i, f in enumerate(prompt_v2.ANGLES["CREATOR_STYLE"]["pools"]["formato"]) if f[:18] in creator]
        formats.add(fmt)
    assert len(actions) >= 3 and len(formats) == 3


def test_given_gift_angle_then_both_people_have_roles_and_only_one_scenario_is_rendered():
    seen = set()
    for seed in range(12):
        plan = _plan(angle="PRESENTE_AFETO", prompt_version=2, seed=seed)
        text = plan["prompt"]["text"]
        angle = _sections(plan)["angle"]
        assert "EXATAMENTE 2 pessoas" in angle and "Pessoa A:" in angle and "Pessoa B:" in angle
        handing = "Pessoa A entrega" in angle
        wearing = "Pessoa A VESTE" in angle
        assert handing != wearing, "exactly one of the two scenarios, never both"
        assert ("NINGUÉM veste a peça nesta versão" in angle) == handing
        assert ("Pessoa B NÃO veste a peça" in angle) == wearing
        assert "Ação principal:" in angle and "Mãos:" in angle
        assert "duas pessoas" not in text.lower().replace("as duas convivem", "")
        assert "Pessoa A:" in _sections(plan)["persona"] and "Pessoa B:" in _sections(plan)["persona"]
        seen.add(handing)
    assert seen == {True, False}, "both scenarios are reachable through the seed"


def test_given_gift_angle_when_person_mode_is_none_then_two_people_still_come_from_the_pool():
    plan = _plan(angle="PRESENTE_AFETO", prompt_version=2, persona_mode="none")
    assert "Pessoa A:" in _sections(plan)["persona"] and "Pessoa B:" in _sections(plan)["persona"]


def test_given_multi_product_gift_then_it_is_a_kit_with_nobody_in_the_frame():
    plan = _plan("fixture-clean-multi", "PRESENTE_AFETO", prompt_version=2)
    text = plan["prompt"]["text"]
    assert plan["prompt"]["prompt_version"] == 2 and plan["persona"] is None
    assert "PESSOAS" not in text and "NENHUMA pessoa em quadro" in text and "duas pessoas" not in text.lower()
    assert "ATMOSFERA" in text, "context block switches to the person-less form"


def test_given_v2_person_angles_then_persona_refines_and_the_angle_wins_the_conflict():
    for angle in ("CAIMENTO", "LIFESTYLE_COTIDIANO", "CREATOR_STYLE"):
        persona = _sections(_plan(angle=angle, prompt_version=2))["persona"]
        assert "SEMPRE vencem" in persona
        assert "só se não contrariar a ação ou a pose pedida pelo ângulo" in persona
        assert persona.count("gestos naturais, em movimento") == 1
    v1_persona = _sections(_plan(angle="CAIMENTO", prompt_version=1))["persona"]
    assert "SEMPRE vencem" not in v1_persona, "v1 has no precedence rule"


def test_given_caimento_v2_then_arms_and_hands_are_placed_and_the_technical_priority_is_kept():
    angle = _sections(_plan(angle="CAIMENTO", prompt_version=2))["angle"]
    for expected in ("braços em posição natural e relaxada ao lado do corpo (NUNCA cruzados)", "sem objetos nas mãos",
                     "NÃO mostrar a pessoa mexendo, ajeitando, puxando ou segurando", "PRIORIDADE VISUAL ESTRITA"):
        assert expected in angle, expected


def test_given_creator_style_v2_then_the_phone_is_concrete_and_hand_positions_are_stated():
    for seed in range(12):
        angle = _sections(_plan(angle="CREATOR_STYLE", prompt_version=2, seed=seed))["angle"]
        assert "{" not in angle and "}" not in angle
        assert "PROIBIDO" in angle and "Apenas essa pessoa em quadro" in angle
        if "celular" in angle.split("Formato da foto:")[1].split("Luz doméstica")[0].replace("celular dele", ""):
            assert "celular com" in angle and "nenhum logotipo de marca visível" in angle
        assert re.search(r"outra mão|sem segurar nada", angle)


def test_given_v2_person_angles_then_no_generic_anatomy_negatives_were_added():
    banned = ("dedo", "anatomi", "extra finger", "fingers", "deform", "mãos perfeitas")
    for angle in V2_ANGLES:
        for fixture in ("fixture-clean-single", "fixture-clean-multi"):
            try:
                plan = _plan(fixture, angle, prompt_version=2)
            except GenerationError:
                continue
            added = _sections(plan)["angle"] + _sections(plan).get("persona", "")
            assert not [b for b in banned if b in added.lower()], (angle, fixture)


def test_given_any_v2_template_then_no_placeholder_is_left_unformatted():
    for fixture in ("fixture-clean-single", "fixture-clean-multi", "fixture-funnel-tofu-single", "fixture-funnel-mofu-multi"):
        for angle in V2_ANGLES:
            for seed in range(6):
                try:
                    plan = _plan(fixture, angle, prompt_version=2, seed=seed)
                except GenerationError:
                    continue
                sections = _sections(plan)
                assert not re.search(r"\{[a-z_]+\}", sections["angle"] + sections.get("persona", "")), (fixture, angle)
                assert validate("CreativePlan", plan) == []


def test_given_infant_garment_in_a_gift_scene_then_the_model_rule_narrows_to_who_wears_it():
    request = _request(angle="PRESENTE_AFETO", prompt_version=2)
    request["products"][0]["type"] = "camiseta infantil"
    core_v2 = _sections(plan_creative(request, router=ROUTER))["core_rules"]
    assert "Quem VESTE a peça é SEMPRE uma criança" in core_v2 and "O MODELO da cena é SEMPRE" not in core_v2
    core_v1 = _sections(plan_creative({**request, "prompt_version": 1}, router=ROUTER))["core_rules"]
    assert "O MODELO da cena é SEMPRE uma criança" in core_v1, "v1 keeps the original wording"
    other = request | {"angle_id": "LIFESTYLE_COTIDIANO"}
    assert "O MODELO da cena é SEMPRE" in _sections(plan_creative(other, router=ROUTER))["core_rules"]


def test_given_service_then_default_version_comes_from_env_or_constructor_and_is_advertised():
    for raw, expected in (("2", 2), ("1", 1), ("", 1), ("3", 1), ("two", 1), ("2 ", 2)):
        assert _env_prompt_version({"CREATIVE_PROMPT_VERSION": raw}) == expected, raw
    assert _env_prompt_version({}) == 1
    for default in (1, 2):
        app = CreativeCoreService(TOKEN, client_factory=Factory(), router=ModelRouter(env={}), prompt_version=default)
        body = _call(app, "GET", "/v1/contracts")[1]
        assert body["prompt_versions"] == {"supported": [1, 2], "default": default, "v2_angles": list(V2_ANGLES)}
        request = _request(angle="CAIMENTO")
        plan = _call(app, "POST", "/v1/plans", {"request": request})[1]["plan"]
        assert plan["prompt"]["prompt_version"] == default
        forced = _call(app, "POST", "/v1/plans", {"request": {**request, "prompt_version": 1}})[1]["plan"]
        assert forced["prompt"]["prompt_version"] == 1
    bad = CreativeCoreService(TOKEN, client_factory=Factory(), prompt_version=9)
    assert bad._prompt_version == 1


if __name__ == "__main__":
    run(globals())
