"""Fase C · a peça infantil decide QUEM a veste, não como é a cena: quem veste precisa ser criança; adultos podem
aparecer como apoio, mas nunca vestem a peça infantil. Regra estrutural do plano (validação) + wording do compiler v2
por wearer. O V1 (546 casos golden) continua com a frase antiga, congelada."""
from __future__ import annotations

import copy
import json
from pathlib import Path

from _support import run
from golden_prompt_v1 import ROUTER

from creative_core import compiler as compiler_module
from creative_core import composition
from creative_core.compiler import compile_prompt
from creative_core.engines import plan_creative
from creative_core.errors import GenerationError

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures_v2"
OLD_RULE = "O MODELO da cena é SEMPRE"
NEW_RULE = "Qualquer pessoa que VESTE esta peça deve ser uma criança compatível com a faixa do produto. Adultos podem aparecer na cena como pessoas de apoio, mas NUNCA vestem esta peça infantil."


def _fixture(name: str) -> dict:
    return json.loads((FIXTURES / f"fixture-c1-{name}.json").read_text(encoding="utf-8"))["input"]


def _person(label, band=None):
    return {"label": label, **({"age_band": band} if band else {})}


def _plan(request: dict) -> dict:
    return plan_creative(request, router=ROUTER)


def _error(request: dict) -> list[str]:
    try:
        _plan(request)
    except GenerationError as err:
        return err.details["errors"]
    raise AssertionError("expected a GenerationError")


def _wearers(plan: dict) -> list[tuple[str, str | None]]:
    return [(s["age_band"], s["product_id"]) for s in plan["subjects"] if s["product_use"] != "none"]


def _adult_product(request: dict, product_id: str = "camiseta-adulto") -> dict:
    return {**copy.deepcopy(request["products"][0]), "id": product_id, "name": "Camiseta adulto", "type": "camiseta"}


# ------------------------------------------------------------------ valid casts
def test_given_child_and_father_then_the_child_wears_the_infant_piece_and_the_father_only_supports():
    plan = _plan(_fixture("a-pai-e-filha"))
    assert [(s["role"], s["age_band"], s["product_use"]) for s in plan["subjects"]] == [("primary", "child_6_9", "wears"), ("supporting", "adult", "none")]
    assert plan["warnings"] == []


def test_given_child_and_mother_then_the_child_wears_and_the_mother_does_not():
    plan = _plan(_fixture("b-menino-e-mae"))
    assert [(s["age_band"], s["product_use"]) for s in plan["subjects"]] == [("child_6_9", "wears"), ("adult", "none")]


def test_given_two_children_then_each_wears_its_own_infant_piece():
    plan = _plan(_fixture("c-duas-irmas"))
    assert [(s["age_band"], s["product_use"]) for s in plan["subjects"]] == [("child_6_9", "wears"), ("child_3_5", "wears")]
    assert len({s["product_id"] for s in plan["subjects"]}) == 2


def test_given_a_family_of_four_then_the_two_children_wear_infant_pieces_and_the_adults_do_not():
    plan = _plan(_fixture("e-familia"))
    assert [(s["age_band"], s["product_use"]) for s in plan["subjects"]] == [
        ("child_6_9", "wears"), ("child_3_5", "wears"), ("adult", "none"), ("adult", "none")]


# ------------------------------------------------------------------ invalid casts
def test_given_an_adult_explicitly_wearing_the_infant_piece_then_the_request_is_refused_before_any_prompt():
    request = _fixture("b-menino-e-mae")
    product_id = request["products"][0]["id"]
    request["subjects"][1]["wears_product_id"] = product_id
    errors = _error(request)
    assert len(errors) == 1 and errors[0].startswith("subjects[1]:") and "infant garment" in errors[0] and "adult" in errors[0]
    assert "may be in the scene as support without wearing it" in errors[0]


def test_given_a_product_swap_that_hands_the_infant_piece_to_an_adult_then_only_that_assignment_is_refused():
    request = _fixture("c-duas-irmas")
    infant_id = request["products"][0]["id"]
    request["products"][1] = _adult_product(request)
    adult_id = request["products"][1]["id"]
    request["subjects"] = [
        {"id": "s1", "role": "primary", "persona": _person("menina 7 anos", "child_6_9"), "wears_product_id": adult_id},   # child in an ADULT piece: valid
        {"id": "s2", "role": "supporting", "persona": _person("mulher 34 anos", "adult"), "relation_to_primary": "mother", "wears_product_id": infant_id},
    ]
    errors = _error(request)
    assert len(errors) == 1 and errors[0].startswith("subjects[1]:"), "each assignment is validated on its own"
    request["subjects"][0]["wears_product_id"], request["subjects"][1]["wears_product_id"] = infant_id, adult_id  # swapped back: valid
    plan = _plan(request)
    assert [(s["age_band"], s["product_id"]) for s in plan["subjects"]] == [("child_6_9", infant_id), ("adult", adult_id)]


def test_given_an_adult_piece_then_no_infant_restriction_applies_to_any_age():
    request = _fixture("b-menino-e-mae")
    request["products"][0] = _adult_product(request)
    request["subjects"] = [{"id": "s1", "role": "primary", "persona": _person("mulher 34 anos", "adult"), "wears_product_id": request["products"][0]["id"]},
                           {"id": "s2", "role": "supporting", "persona": _person("menino 8 anos", "child_6_9"), "relation_to_primary": "son", "wears_product_id": None}]
    request.pop("interaction", None)
    plan = _plan(request)
    assert _wearers(plan) == [("adult", "camiseta-adulto")] and "infant_wearer" not in " ".join(plan["warnings"])


def test_given_the_garment_bands_then_a_teen_cannot_wear_an_infant_tee_and_a_body_is_for_small_children_only():
    request = _fixture("b-menino-e-mae")
    request["subjects"] = [{"persona": _person("Ana", "teen"), "wears_product_id": request["products"][0]["id"]}]
    request.pop("interaction", None)
    assert "infant garment" in _error(request)[0] and "teen" in _error(request)[0]
    request["subjects"][0]["persona"] = _person("Ana", "child_10_12")
    assert _wearers(_plan(request)) == [("child_10_12", request["products"][0]["id"])]
    body = copy.deepcopy(request)
    body["products"][0] = {**body["products"][0], "type": "body infantil", "name": "Body Abelha"}
    assert "infant garment" in _error(body)[0], "10-12 years is not a body's size"
    body["subjects"][0]["persona"] = _person("Bia", "child_3_5")
    assert _wearers(_plan(body))[0][0] == "child_3_5"
    assert composition.infant_bands({"type": "body infantil"}) == {"baby", "child", "child_3_5"}
    assert composition.infant_bands({"type": "camiseta infantil"}) >= {"child_6_9", "child_10_12"}


def test_given_an_unknown_age_on_a_wearer_of_an_infant_piece_then_it_is_read_as_a_child_for_any_subject():
    request = _fixture("c-duas-irmas")
    for subject in request["subjects"]:
        subject["persona"] = {"label": "modelo"}
        subject.pop("age_band", None)
    plan = _plan(request)
    assert all(s["is_minor"] and s["age_source"] == "product.type" for s in plan["subjects"]), "the second wearer too, not only the primary"
    assert plan["minor_safety"]["basis"]["heuristic"] == ["s1", "s2"]


# ------------------------------------------------------------------ planner-chosen casts are corrected, user-chosen are not
def test_given_an_automatic_persona_then_an_adult_from_the_pool_never_wears_the_infant_piece():
    request = _fixture("b-menino-e-mae")
    for key in ("subjects", "interaction"):
        request.pop(key, None)
    request["products"][0].pop("semantic_context", None)
    request["angle_id"] = "CAIMENTO"
    recast = 0
    for seed in range(60):
        plan = _plan({**request, "seed": seed})
        assert all(band in composition.infant_bands(request["products"][0]) for band, _ in _wearers(plan)), seed
        recast += "infant_wearer_recast:s1" in plan["warnings"]
        assert plan["persona"]["label"] == plan["subjects"][0]["label"], "the plan's persona follows the recast wearer"
    assert recast > 0, "the pool does offer adults, so the correction is exercised (and shown as a warning)"


def test_given_a_custom_adult_persona_for_the_infant_piece_then_the_user_choice_is_refused_not_rewritten():
    request = _fixture("b-menino-e-mae")
    for key in ("subjects", "interaction"):
        request.pop(key, None)
    request["angle_id"] = "CAIMENTO"
    request.update({"persona_mode": "custom", "persona": {"label": "mulher 35 anos", "source": "custom"}})
    errors = _error(request)
    assert "infant garment" in errors[0] and errors[0].startswith("subjects[0]:")


# ------------------------------------------------------------------ the prompt says it per wearer (compiler v2), V1 stays frozen
def test_given_compiler_v2_then_the_prompt_never_says_the_scenes_model_is_always_a_child():
    for name in ("a-pai-e-filha", "b-menino-e-mae", "c-duas-irmas", "d-casal", "e-familia"):
        plan = _plan(_fixture(name))
        text = plan["prompt"]["text"]
        assert OLD_RULE not in text, name
        if name != "d-casal":
            assert NEW_RULE in text, name
        assert compile_prompt(json.loads(json.dumps(plan)))["sha256"] == plan["prompt"]["sha256"], name


def test_given_a_body_then_the_rule_is_about_who_wears_it_too():
    request = _fixture("b-menino-e-mae")
    request["products"][0] = {**request["products"][0], "type": "body infantil", "name": "Body Abelha"}
    request["subjects"][0]["persona"] = _person("Bia", "child_3_5")
    text = _plan(request)["prompt"]["text"]
    assert OLD_RULE not in text and "Qualquer pessoa que VESTE esta peça deve ser um bebê ou criança pequena." in text


def _template_plan() -> dict:
    """A plan of the angle's own person scene (legacy cast, `template`): the only kind a v1 compile can rebuild."""
    request = _fixture("b-menino-e-mae")
    for key in ("subjects", "interaction"):
        request.pop(key, None)
    request["products"][0].pop("semantic_context", None)
    return _plan({**request, "angle_id": "LIFESTYLE_COTIDIANO", "seed": 4})


def test_given_the_same_plan_compiled_as_v1_then_the_frozen_sentence_is_still_there():
    plan = _template_plan()
    assert plan["scene"]["scene_mode"] == "template" and plan["scene"]["picks"]
    assert OLD_RULE in compile_prompt(plan, version=1)["text"], "V1 keeps its sentence; that is what the 546 golden cases and stored plans rely on"
    assert OLD_RULE not in compile_prompt(plan, version=2)["text"]


def test_given_a_garment_rule_the_compiler_does_not_know_then_it_refuses_instead_of_bringing_the_old_idea_back():
    saved = list(compiler_module.TEXT["wearer_rules"]["rules"])
    compiler_module.TEXT["wearer_rules"]["rules"].clear()
    try:
        try:
            compile_prompt(_plan_without_recompile())
        except ValueError as exc:
            assert "wearer_rules" in str(exc)
        else:
            raise AssertionError("compiled with the old rule still in the text")
    finally:
        compiler_module.TEXT["wearer_rules"]["rules"][:] = saved


def _plan_without_recompile() -> dict:
    plan = _plan(_fixture("a-pai-e-filha"))
    return json.loads(json.dumps(plan))


if __name__ == "__main__":
    run(globals())
