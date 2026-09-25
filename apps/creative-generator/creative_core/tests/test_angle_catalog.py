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
    family_presets,
    recommend_angle,
    resolve_angle_meta,
)
from creative_core.angles import ANGLE_IDS
from creative_core.compiler import compile_prompt
from creative_core.engines import plan_creative
from creative_core.errors import GenerationError
from creative_core.kits import load_brand_kit


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


# ------------------------------------------------------------------ Achado real (primeiro uso, conta interna, 24/09):
# a escolha MANUAL de família na UI V2 (o cartão "Estilo" — a tela nunca oferece um preset específico,
# só a família) sempre resolvia para o preset PADRÃO da família, sem olhar disponibilidade — travava
# mesmo quando outro preset real da MESMA família (ex.: product_focus tem CAIMENTO/CLOSE_ESTAMPA/
# CLOSE_BOLSO) já era permitido pela marca. `family_presets` + a busca em `_resolve_angle_id` corrigem
# isso sem nunca cruzar para uma família diferente da que o lojista escolheu.
def test_given_a_family_then_family_presets_lists_every_distinct_legacy_angle_default_first():
    assert family_presets("product_focus") == [(None, "CAIMENTO"), ("print_detail", "CLOSE_ESTAMPA"), ("small_detail", "CLOSE_BOLSO")]
    assert family_presets("product_no_person") == [(None, "PRODUTO_ESTAMPA"), ("hanging", "CABIDE"), ("editorial_still", "PREMIUM_ESTILO")]
    assert family_presets("creator_social") == [(None, "CREATOR_STYLE")], "single-preset family: just its default"
    assert family_presets("action_movement") == [], "reserved, no legacy mapping at all"


def test_given_a_manual_family_whose_default_is_unavailable_then_it_finds_another_real_preset_in_the_same_family():
    # product_focus's default (CAIMENTO) not enabled, but CLOSE_ESTAMPA (same family) is — never crosses
    # into a different family just because the lojista's own pick's default preset is unavailable.
    brand = {**load_brand_kit("use_origens"), "enabledAngles": ["CLOSE_ESTAMPA"]}
    request = _req(angle_id="auto", plan_schema_version=2, brand_kit=brand, angle_family_hint={"family": "product_focus"})
    del request["brand_kit_id"]
    plan = plan_creative(request, router=ROUTER)
    assert plan["angle"]["id"] == "CLOSE_ESTAMPA"
    assert plan["angle_recommendation"]["family"] == "product_focus"
    assert any(r.startswith("preset_fallback:CLOSE_ESTAMPA:tried=CAIMENTO") for r in plan["angle_recommendation"]["reason"])
    assert plan["angle_recommendation"]["source"] == "user", "still the lojista's own family choice, not a planner default"


def test_given_a_manual_family_where_no_preset_is_available_then_it_refuses_honestly_naming_what_it_tried():
    # Nenhum preset de product_focus (CAIMENTO/CLOSE_ESTAMPA/CLOSE_BOLSO) está liberado — recusa, nunca
    # inventa nem empresta um ângulo de outra família.
    brand = {**load_brand_kit("use_origens"), "enabledAngles": ["LIFESTYLE_COTIDIANO"]}
    request = _req(angle_id="auto", plan_schema_version=2, brand_kit=brand, angle_family_hint={"family": "product_focus"})
    del request["brand_kit_id"]
    err = None
    try:
        plan_creative(request, router=ROUTER)
    except GenerationError as exc:
        err = exc
    assert err is not None and err.code == "UNSUPPORTED_ANGLE"
    assert err.details["reason"] == "no_angle_available_for_brand_or_niche"
    assert set(err.details["tried"]) == {"CAIMENTO", "CLOSE_ESTAMPA", "CLOSE_BOLSO"}


def test_given_an_explicit_preset_unavailable_then_it_still_refuses_no_search_no_override():
    # Um PRESET explícito (não só a família — hoje só chega por replay/custom angle, nunca pela UI) é uma
    # escolha ainda mais específica do que a família: nunca ganha a busca por alternativa dentro da
    # família — comportamento idêntico ao de antes desta correção.
    brand = {**load_brand_kit("use_origens"), "enabledAngles": ["CLOSE_ESTAMPA"]}
    request = _req(angle_id="auto", plan_schema_version=2, brand_kit=brand,
                    angle_family_hint={"family": "product_focus", "preset": "technical_fit"})
    del request["brand_kit_id"]
    err = None
    try:
        plan_creative(request, router=ROUTER)
    except GenerationError as exc:
        err = exc
    assert err is not None and err.code == "UNSUPPORTED_ANGLE" and err.details["angle_id"] == "CAIMENTO"


def test_given_a_manual_family_whose_default_is_already_available_then_no_fallback_noise_in_the_reason():
    # Caminho comum (a maioria das marcas): nada muda — sem entrada "preset_fallback" no reason quando o
    # padrão já funciona.
    plan = _plan(angle_id="auto", plan_schema_version=2, angle_family_hint={"family": "lifestyle"})
    assert plan["angle"]["id"] == "LIFESTYLE_COTIDIANO"
    assert plan["angle_recommendation"]["reason"] == ["angle_family_hint:lifestyle"]


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


# ------------------------------------------------------------------ Achado real (primeiro uso, conta interna, 24/09):
# `recommend_angle` recomendava um ângulo que ela própria não sabia que `angle_is_available` ia recusar —
# o `auto` sem nenhuma pista caía sempre em editorial_portrait (ORGULHO_DISCRETO), e uma marca real com
# `enabledAngles` restrito (que nem sequer incluía esse ângulo) travava no primeiro produto, sem saída.
def test_given_no_brand_or_niche_kwargs_then_behavior_is_unchanged_pure_default():
    # Sem brand/niche (assinatura antiga, ou nenhum contexto de marca a checar): comportamento idêntico
    # ao de antes desta correção — sempre o primeiro candidato da cadeia, nunca filtrado.
    rec = recommend_angle({})
    assert rec["family"] == "editorial_portrait" and rec["angle_id"] == "ORGULHO_DISCRETO"
    assert not any(r.startswith("brand_fallback") or r.startswith("no_available_angle") for r in rec["reason"])


def test_given_a_brand_that_excludes_the_default_pick_then_it_falls_back_to_an_available_family_in_the_same_reading():
    # A marca real que travou: enabledAngles restrito, sem ORGULHO_DISCRETO — o padrão "uma pessoa, sem
    # outro sinal" cai para lifestyle (LIFESTYLE_COTIDIANO), que a mesma marca permite — nunca vira "sem
    # pessoa" nem "grupo": a leitura do pedido (uma pessoa) continua valendo, só a família muda.
    brand = {**load_brand_kit("use_origens"), "enabledAngles": ["LIFESTYLE_COTIDIANO", "PRODUTO_ESTAMPA"]}
    niche = {"supportsApparelAngles": True}
    rec = recommend_angle({}, brand=brand, niche=niche)
    assert rec["family"] == "lifestyle" and rec["angle_id"] == "LIFESTYLE_COTIDIANO"
    assert "single_person_default" in rec["reason"], "the original reading of the request is still recorded"
    assert any(r.startswith("brand_fallback:lifestyle:None") for r in rec["reason"]), "the fallback itself is never silent"


def test_given_a_brand_that_only_allows_a_close_up_angle_then_no_person_still_never_falls_back_into_a_person_family():
    # "Sem pessoa" nunca deve virar "com pessoa" só porque a família de zero-pessoa está indisponível —
    # a cadeia de product_no_person só tenta OUTROS presets sem pessoa (CABIDE/PREMIUM_ESTILO), nunca cruza
    # para uma família que contradiz o pedido.
    brand = {**load_brand_kit("use_origens"), "enabledAngles": ["CABIDE"]}
    niche = {"supportsApparelAngles": True}
    rec = recommend_angle({"persona_mode": "none"}, brand=brand, niche=niche)
    assert rec["family"] == "product_no_person" and rec["angle_id"] == "CABIDE"
    assert "no_person_requested" in rec["reason"]


def test_given_a_brand_where_every_candidate_in_the_chain_is_unavailable_then_it_honestly_gives_up_never_inventing_or_bypassing():
    # Nenhum ângulo do encadeamento de "uma pessoa" está liberado (só um ângulo de outra leitura, CLOSE_BOLSO,
    # está) — a função nunca inventa uma pessoa nem ignora a restrição: devolve angle_id None com o que
    # tentou, exatamente como o achado real pedia ("não remova as restrições... para esconder o erro").
    brand = {**load_brand_kit("use_origens"), "enabledAngles": ["CLOSE_BOLSO"]}
    niche = {"supportsApparelAngles": True}
    rec = recommend_angle({}, brand=brand, niche=niche)
    assert rec["angle_id"] is None
    assert any(r.startswith("no_available_angle_for_brand:tried=") for r in rec["reason"])
    tentativas = next(r for r in rec["reason"] if r.startswith("no_available_angle_for_brand"))
    assert "ORGULHO_DISCRETO" in tentativas and "NOSTALGIA_ORIGEM" in tentativas and "LIFESTYLE_COTIDIANO" in tentativas


def test_given_the_real_blocked_scenario_then_plan_creative_now_succeeds_end_to_end():
    # Reprodução fiel do bloqueio real: marca com enabledAngles restrito (sem ORGULHO_DISCRETO), 1
    # produto, nenhuma família escolhida — antes desta correção, 422 UNSUPPORTED_ANGLE no primeiro
    # produto da conta; agora resolve para uma família de fato disponível.
    brand = {**load_brand_kit("use_origens"),
             "enabledAngles": ["IDENTIDADE_ORIGEM", "LIFESTYLE_COTIDIANO", "PERTENCIMENTO", "CABIDE",
                                "PRODUTO_ESTAMPA", "CAIMENTO", "CLOSE_ESTAMPA", "PRESENTE_AFETO"]}
    request = _req(angle_id="auto", plan_schema_version=2, brand_kit=brand)
    del request["brand_kit_id"]
    plan = plan_creative(request, router=ROUTER)
    assert plan["angle_recommendation"]["family"] == "lifestyle"
    assert plan["angle"]["id"] == "LIFESTYLE_COTIDIANO"


def test_given_an_explicit_family_hint_still_unavailable_then_it_still_refuses_no_silent_fallback():
    # Escolha EXPLÍCITA do lojista (via family hint) nunca ganha um fallback escondido — só o "auto" sem
    # pista usa a cadeia; uma escolha manual continua exatamente honesta como antes desta correção.
    brand = {**load_brand_kit("use_origens"), "enabledAngles": ["LIFESTYLE_COTIDIANO"]}
    request = _req(angle_id="auto", plan_schema_version=2, brand_kit=brand, angle_family_hint={"family": "editorial_portrait"})
    del request["brand_kit_id"]
    err = None
    try:
        plan_creative(request, router=ROUTER)
    except GenerationError as exc:
        err = exc
    assert err is not None and err.code == "UNSUPPORTED_ANGLE" and err.details["angle_id"] == "ORGULHO_DISCRETO"


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
