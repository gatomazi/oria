"""Funil por Criativo · preset promo_offer (oferta/promoção) + multi-wearer (uma peça vestida por várias pessoas).

Multi-wearer NÃO é multipeça: é UM produto aplicado a várias pessoas da cena. No contrato:
  * pedido explícito: `subjects[i].wears_product_id` com o MESMO id em mais de uma pessoa (já existia);
  * pedido automático: `multi_wearer: {group: one|pair|family, share: auto|all|primary_only}` — o planner monta o
    elenco e decide quem veste;
  * no plano: `composition.multi_wearer = true` + `composition.wearers_by_product = {product_id: [subject ids]}`,
    e o compiler v4 escreve a linha "MESMA PEÇA EM VÁRIAS PESSOAS".
O preset nunca inventa oferta: só imprime o que o lojista escreveu."""
from __future__ import annotations

import copy
import json
from pathlib import Path

from _support import run
from golden_prompt_v1 import ROUTER

from creative_core.compiler import compile_prompt
from creative_core.engines import plan_creative
from creative_core.errors import GenerationError

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures_v2"
ADULT = {"id": "tmd", "name": "Camiseta Todo Mundo é Diferente", "type": "camiseta", "referenceImages": ["demo/tmd/front.png"]}
INFANT = {"id": "tmd-kids", "name": "Camiseta Infantil Todo Mundo é Diferente", "type": "camiseta infantil", "referenceImages": ["demo/tmd-kids/front.png"]}
PROMO = {"preset": "promo_offer", "headline": "LEVE 3", "discount": "15% OFF", "benefits": ["FRETE GRÁTIS"], "cta": "EU QUERO"}


def _request(**overrides) -> dict:
    """Entre Nós (brand kit real das fixtures v2), Funil BOFU, plano v2 — o caminho do Gerador V2."""
    request = copy.deepcopy(json.loads((FIXTURES / "fixture-v2-entre-nos-caimento.json").read_text(encoding="utf-8"))["input"])
    request.pop("persona", None)
    request.update(strategy="FUNNEL_VISUAL", product_mode="single_product", products=[dict(ADULT)], angle_id="auto",
                   funnel_stage="BOFU", plan_schema_version=2, prompt_version=2, placement_id="FEED_4X5",
                   persona_mode="automatic", funnel=dict(PROMO), seed=7)
    request.update(overrides)
    return request


def _use_origens(**overrides) -> dict:
    """Use Origens (kit embutido, sem semantic_context), uma pessoa — o preset não pode depender de família."""
    request = {
        "strategy": "FUNNEL_VISUAL", "product_mode": "single_product", "brand_kit_id": "use_origens", "niche_kit_id": "fashion",
        "products": [{"id": "roca", "name": "Camiseta Roca Sales", "type": "camiseta premium", "referenceImages": ["demo/roca/front.png"]}],
        "angle_id": "auto", "placement_id": "STORY_9X16", "funnel_stage": "BOFU", "persona_mode": "automatic",
        "plan_schema_version": 2, "prompt_version": 2, "seed": 3,
        "funnel": {"preset": "promo_offer", "discount": "15% OFF", "benefits": ["Frete grátis acima de R$ 199"], "cta": "VER CAMISETA"},
    }
    request.update(overrides)
    return request


def _plan(request: dict) -> dict:
    return plan_creative(request, router=ROUTER)


def _errors(request: dict) -> list[str]:
    try:
        _plan(request)
    except GenerationError as err:
        return err.details["errors"]
    raise AssertionError("expected a GenerationError")


def _wear(plan: dict) -> list[tuple[str, str | None]]:
    return [(s["age_band"], s["product_id"]) for s in plan["subjects"]]


# ------------------------------------------------------------------ multi-wearer
def test_family_sharing_the_same_product_puts_it_on_the_three_subjects_and_the_plan_says_so():
    plan = _plan(_request(multi_wearer={"group": "family", "share": "all"}))
    assert [pid for _, pid in _wear(plan)] == ["tmd", "tmd", "tmd"]
    assert plan["product_mode"] == "single_product" and len(plan["products"]) == 1  # not multi-product
    assert plan["composition"]["multi_wearer"] is True
    assert plan["composition"]["wearers_by_product"] == {"tmd": ["s1", "s2", "s3"]}
    assert plan["scene"]["composition_source"] == "recommended"
    assert "MESMA PEÇA EM VÁRIAS PESSOAS: Pessoa 1, Pessoa 2 e Pessoa 3 vestem a MESMA peça" in plan["prompt"]["text"]
    assert "Isto não é duplicar nem inventar produto." in plan["prompt"]["text"]


def test_explicit_subjects_wearing_the_same_product_are_multi_wearer_too():
    subjects = [
        {"role": "primary", "persona": {"label": "mãe", "age_band": "adult"}, "wears_product_id": "tmd"},
        {"persona": {"label": "pai", "age_band": "adult"}, "relation_to_primary": "partner", "wears_product_id": "tmd"},
        {"persona": {"label": "criança", "age_band": "child_6_9"}, "relation_to_primary": "daughter", "wears_product_id": "tmd"},
    ]
    plan = _plan(_request(subjects=subjects))
    assert plan["composition"]["wearers_by_product"] == {"tmd": ["s1", "s2", "s3"]}
    assert plan["scene"]["composition_source"] == "explicit"


def test_an_adult_never_wears_an_infant_piece_in_an_automatic_family_cast():
    plan = _plan(_request(products=[dict(INFANT)], multi_wearer={"group": "family", "share": "all"}))
    assert _wear(plan) == [("child_6_9", "tmd-kids"), ("adult", None), ("adult", None)]
    assert "multi_wearer" not in plan["composition"]  # only the child wears it: nothing is shared


def test_an_adult_explicitly_wearing_an_infant_piece_is_refused_before_any_prompt():
    subjects = [
        {"role": "primary", "persona": {"label": "menina", "age_band": "child_6_9"}, "wears_product_id": "tmd-kids"},
        {"persona": {"label": "pai", "age_band": "adult"}, "relation_to_primary": "father", "wears_product_id": "tmd-kids"},
    ]
    errors = _errors(_request(products=[dict(INFANT)], subjects=subjects))
    assert any("infant garment" in e for e in errors)


def test_adult_and_infant_versions_are_distinct_products_each_on_its_own_wearers():
    plan = _plan(_request(product_mode="multi_product", products=[dict(ADULT), dict(INFANT)],
                          multi_wearer={"group": "family", "share": "all"}))
    assert _wear(plan) == [("adult", "tmd"), ("adult", "tmd"), ("child_6_9", "tmd-kids")]
    assert plan["composition"]["wearers_by_product"] == {"tmd": ["s1", "s2"]}


def test_support_without_the_piece_stays_valid():
    plan = _plan(_request(multi_wearer={"group": "family", "share": "primary_only"}))
    assert [s["product_use"] for s in plan["subjects"]] == ["wears", "none", "none"]
    assert "multi_wearer" not in plan["composition"]
    explicit = [
        {"role": "primary", "persona": {"label": "criança", "age_band": "child_6_9"}, "wears_product_id": "tmd"},
        {"persona": {"label": "pai", "age_band": "adult"}, "relation_to_primary": "father", "wears_product_id": "tmd"},
        {"persona": {"label": "mãe", "age_band": "adult"}, "relation_to_primary": "mother", "wears_product_id": None},
    ]
    plan = _plan(_request(subjects=explicit))
    assert [s["product_use"] for s in plan["subjects"]] == ["wears", "wears", "none"]
    assert plan["composition"]["wearers_by_product"] == {"tmd": ["s1", "s2"]}


def test_automatic_share_follows_the_products_wearer_roles():
    product = {**ADULT, "semantic_context": {"wearer_roles": ["adult"], "source": "manual"}}
    plan = _plan(_request(products=[product], multi_wearer={"group": "family"}))  # share defaults to auto
    assert _wear(plan) == [("adult", "tmd"), ("adult", "tmd"), ("child_6_9", None)]


def test_multi_wearer_needs_people_and_the_v2_plan():
    assert _errors(_request(persona_mode="none", multi_wearer={"group": "pair"})) == [
        "multi_wearer: needs people in the scene (persona_mode is none)"]
    assert _errors(_request(plan_schema_version=1, multi_wearer={"group": "pair"})) == ["multi_wearer: requires plan_schema_version 2"]
    plan = _plan(_request(angle_id="CABIDE", multi_wearer={"group": "pair"}))
    assert plan["subjects"] == [] and "multi_wearer_ignored:no_person_scene:CABIDE" in plan["warnings"]


def test_the_auto_angle_takes_the_people_the_group_asks_for():
    plan = _plan(_request(multi_wearer={"group": "pair", "share": "all"}))
    assert plan["composition"]["people_count"] == 2
    assert "people_count:2" in plan["angle_recommendation"]["reason"]


# ------------------------------------------------------------------ promo_offer
def test_promo_texts_reach_the_plan_and_the_prompt_with_the_commercial_hierarchy():
    plan = _plan(_request(multi_wearer={"group": "family", "share": "all"}))
    overlay = plan["overlay"]
    assert (overlay["preset"], overlay["discount"], overlay["headline"], overlay["benefits"], overlay["cta"]) == (
        "promo_offer", "15% OFF", "LEVE 3", ["FRETE GRÁTIS"], "EU QUERO")
    assert plan["layout"] == "promo_offer_split"
    text = plan["prompt"]["text"]
    assert 'DESTAQUE (o MAIOR texto da peça' in text and '"15% OFF"' in text
    assert 'OFERTA PRINCIPAL' in text and 'BENEFÍCIO' in text and 'CTA (botão destacado' in text
    assert text.index('"15% OFF"') < text.index('"LEVE 3"') < text.index('"FRETE GRÁTIS"') < text.index('"EU QUERO"')
    assert "subject_zone: esquerda e centro" in text and "cta_zone: terço direito" in text
    assert "Nenhum texto, selo ou botão cobre rostos" in text


def test_promo_never_invents_an_offer_that_was_not_given():
    plan = _plan(_request(funnel={"preset": "promo_offer", "discount": "15% OFF"}))
    overlay = plan["overlay"]
    assert overlay["headline"] is None and overlay["cta"] is None and overlay["benefits"] == [] and overlay["subheadline"] is None
    text = plan["prompt"]["text"]
    for absent in ("OFERTA PRINCIPAL", "BENEFÍCIO (selo", "CTA (botão", "Garanta o seu", "Comprar agora", "Frete", "Leve"):
        assert absent not in text, absent
    assert _errors(_request(funnel={"preset": "promo_offer"})) == [
        "funnel: promo_offer needs at least one of discount, headline, benefits or cta — the offer is never invented"]


def test_promo_refuses_what_would_contradict_it():
    assert any("TOFU forbids" in e for e in _errors(_request(funnel_stage="TOFU")))
    assert any("clean_mode" in e for e in _errors(_request(funnel={**PROMO, "clean_mode": True})))
    assert _errors(_request(funnel={**PROMO, "badges": ["novo"]})) == ["funnel.badges: not used by preset promo_offer"]
    assert _errors(_request(funnel={"headline": "Oi", "discount": "10% OFF"})) == ["funnel.discount: only used by preset promo_offer"]


def test_promo_works_with_one_person_and_no_family_signal():
    plan = _plan(_use_origens())
    assert len(plan["subjects"]) == 1 and plan["layout"] == "promo_offer_stacked"
    assert plan["overlay"]["discount"] == "15% OFF" and plan["overlay"]["cta"] == "VER CAMISETA"
    assert "offer_zone: faixa superior" in plan["prompt"]["text"]
    assert "MESMA PEÇA" not in plan["prompt"]["text"]
    one = _plan(_use_origens(multi_wearer={"group": "one"}))
    assert len(one["subjects"]) == 1


def test_promo_also_compiles_on_the_v1_plan():
    plan = _plan(_use_origens(plan_schema_version=1, prompt_version=1))
    assert plan["overlay"]["preset"] == "promo_offer" and "DESTAQUE (o MAIOR texto da peça" in plan["prompt"]["text"]


# ------------------------------------------------------------------ nothing else moves
def test_a_funnel_without_preset_keeps_its_exact_overlay_and_text():
    plan = _plan(_use_origens(funnel={"headline": "A sua cidade no peito"}))
    assert "preset" not in plan["overlay"] and "discount" not in plan["overlay"] and plan["layout"] is None
    assert "PRESET OFERTA" not in plan["prompt"]["text"]
    assert "multi_wearer" not in plan["composition"]


def test_the_shared_wear_line_only_exists_from_compiler_v4():
    plan = _plan(_request(multi_wearer={"group": "pair", "share": "all"}))
    assert plan["compiler"]["version"] == 4
    assert "MESMA PEÇA" in compile_prompt(plan)["text"]
    assert "MESMA PEÇA" not in compile_prompt(plan, version=3)["text"]


def test_same_request_same_plan():
    request = _request(multi_wearer={"group": "family", "share": "all"})
    assert _plan(request)["prompt"]["sha256"] == _plan(copy.deepcopy(request))["prompt"]["sha256"]


if __name__ == "__main__":
    run(globals())
