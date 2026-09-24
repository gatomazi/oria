"""Fase F.2.A — the real (OpenAI) Product Enrichment provider. ZERO real calls anywhere in this file
or in enrichment.py itself: every test injects a fake `OpenAIClient` (see enrichment.OpenAIClient) —
nothing here imports the `openai` package or reads OPENAI_API_KEY. `test_enrichment.py` covers the
"fake" provider and the merge/provenance rules; this file is only the OpenAI-specific surface: model
allowlist/fallback, request shape, response parsing, the visible_text hallucination guard, and error
classification (§4 of the brief: sucesso, ausência de referência, saída parcial, payload inválido,
timeout, 429, 5xx, resposta vazia, duas referências, limite de custo, concorrência)."""
from __future__ import annotations

import base64
import sys
from pathlib import Path

import pytest

# Mesmo truque de _support.py: este arquivo roda tanto por `pytest` (rootdir cuida disso sozinho)
# quanto por `run_tests.py` (script solto — precisa do repo do core no sys.path na mão).
_ROOT = Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from creative_core import contracts, enrichment
from creative_core import model_router as mr
from creative_core.errors import GenerationError

# Magic-byte-valid fixtures (enrichment.py now runs the SAME real decode_reference() validation the
# /v1/generations route uses — a placeholder string like "AAAA" no longer passes). Two distinct
# 1x1-ish payloads, PNG and JPEG signatures, so tests can tell which reference was actually used.
_PNG_B64 = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x00" * 32).decode()
_JPEG_B64 = base64.b64encode(b"\xff\xd8\xff" + b"\x00" * 32).decode()


def produto(**over):
    base = {"id": "prod-1", "name": "Camiseta Pai e Filho", "type": "camiseta infantil",
            "description": "presente para brincar com o pai"}
    base.update(over)
    return base


def _saida(**over):
    # Fase F.2.B.1 — `field_confidence`/`field_basis` are now REQUIRED by `_request_schema()` (a real
    # Structured Outputs strict-mode response always carries them); every field this default output
    # populates gets a specific, non-generic basis and a confidence above `_LOW_CONFIDENCE_THRESHOLD`
    # so tests unrelated to the evidence gates (allowlist, fallback, error classification, reference
    # handling) don't accidentally exercise them and see fields disappear. Tests that exist TO exercise
    # the gates build their own `field_confidence`/`field_basis` explicitly — see the
    # "evidence gates" section below.
    base = {
        "wearer_roles": ["adult", "child"], "relationship_themes": ["family"],
        "recommended_supporting_roles": ["father"], "incompatible_auto_supporting_roles": [],
        "scene_intents": ["play"], "visible_text": [], "confidence": 0.8,
        "justification": "nome e descrição mencionam pai e filho brincando", "used_reference_image": False,
        "field_confidence": {
            "wearer_roles": 0.8, "relationship_themes": 0.8, "recommended_supporting_roles": 0.8,
            "incompatible_auto_supporting_roles": 0.0, "scene_intents": 0.8, "visible_text": 0.0,
        },
        "field_basis": {
            "wearer_roles": "text_or_metadata", "relationship_themes": "text_or_metadata",
            "recommended_supporting_roles": "text_or_metadata", "incompatible_auto_supporting_roles": "no_evidence",
            "scene_intents": "text_or_metadata", "visible_text": "no_evidence",
        },
    }
    base.update(over)
    return base


class ClienteFalso:
    """Injeta uma resposta fixa OU uma exceção — nunca uma chamada real. `chamadas` registra o
    `model` de cada tentativa, para os testes de allowlist/fallback."""

    def __init__(self, *, saida=None, usage=None, excecao=None, latency_ms=5.0):
        self.saida, self.usage, self.excecao, self.latency_ms = saida, usage, excecao, latency_ms
        self.chamadas: list[str] = []

    def create(self, *, model, system, user_text, images_b64, schema, timeout):
        self.chamadas.append(model)
        if self.excecao:
            raise self.excecao
        return enrichment.OpenAIResult(output_json=self.saida, model=model, usage=self.usage, latency_ms=self.latency_ms)


def _router(model="gpt-4o-mini", fallbacks=None):
    env = {"OPENAI_TEXT_MODEL": model}
    if fallbacks:
        env["OPENAI_TEXT_MODEL_FALLBACKS"] = ",".join(fallbacks)
    return mr.ModelRouter(env=env)


# ------------------------------------------------------------------ nenhuma chamada real, por construção
def test_given_no_client_then_propose_refuses_before_touching_anything():
    with pytest.raises(GenerationError) as exc:
        enrichment.propose(produto(), provider="openai")
    assert exc.value.code == "INVALID_INPUT"


# ------------------------------------------------------------------ sucesso
def test_given_a_successful_call_then_the_proposal_validates_and_carries_provider_meta():
    cliente = ClienteFalso(saida=_saida(), usage={"input_tokens": 120, "output_tokens": 40})
    proposta = enrichment.propose(produto(), provider="openai", client=cliente, router=_router())
    assert contracts.validate("EnrichmentProposal", proposta) == []
    assert proposta["provider"] == "openai"
    assert proposta["proposed"]["relationship_themes"] == ["family"]
    assert proposta["proposed"]["source"] == "enrichment"
    meta = proposta["provider_meta"]
    assert meta["model_requested"] == meta["model_served"] == "gpt-4o-mini"
    assert meta["usage"] == {"input_tokens": 120, "output_tokens": 40}
    assert meta["attempts"] == 1 and meta["references_used"] == 0
    assert cliente.chamadas == ["gpt-4o-mini"]


def test_given_a_fake_proposal_then_provider_meta_is_absent_not_an_empty_object():
    proposta = enrichment.propose(produto())
    assert proposta["provider_meta"] is None


# ------------------------------------------------------------------ allowlist / fallback (roteador existente)
def test_given_the_routers_current_default_then_it_is_not_allowlisted_and_the_call_never_happens():
    """`gpt-5.6` É um alias real (roteia para gpt-5.6-sol — confirmado na F.2.B, corrigindo uma leitura
    errada da F.2.A), mas não está na allowlist ESPECÍFICA do enrichment (escolha deliberada de
    custo/escopo, não por invalidez): o provider não confia no default do router às cegas de qualquer
    forma, então o comportamento — recusar antes de qualquer chamada — é o mesmo por um motivo correto."""
    cliente = ClienteFalso(saida=_saida())
    with pytest.raises(GenerationError) as exc:
        enrichment.propose(produto(), provider="openai", client=cliente, router=mr.ModelRouter(env={}))
    assert exc.value.code == "MODEL_NOT_ALLOWLISTED"
    assert exc.value.details["tried"] == ["gpt-5.6"]
    assert cliente.chamadas == [], "nenhuma chamada foi feita — o modelo nunca chegou a ser tentado no cliente"


def test_given_a_non_allowlisted_primary_with_an_allowlisted_fallback_then_the_fallback_is_used():
    cliente = ClienteFalso(saida=_saida())
    roteador = _router(model="gpt-5.6", fallbacks=["gpt-4o-mini"])
    proposta = enrichment.propose(produto(), provider="openai", client=cliente, router=roteador)
    assert proposta["provider_meta"]["model_served"] == "gpt-4o-mini"
    assert proposta["provider_meta"]["model_requested"] == "gpt-5.6", "o pedido original fica registrado mesmo quando o fallback responde"
    assert cliente.chamadas == ["gpt-4o-mini"], "gpt-5.6 nunca chega ao cliente — barrado antes pela allowlist"


# ------------------------------------------------------------------ classificação de erro (reusa errors.classify_provider_exception)
def test_given_a_429_then_the_error_is_model_rate_limited_and_retryable():
    class RateLimitError(Exception):
        status_code = 429
    cliente = ClienteFalso(excecao=RateLimitError("nope"))
    with pytest.raises(GenerationError) as exc:
        enrichment.propose(produto(), provider="openai", client=cliente, router=_router())
    assert exc.value.code == "MODEL_RATE_LIMITED" and exc.value.retryable


def test_given_a_5xx_then_the_error_is_model_unavailable():
    class InternalServerError(Exception):
        status_code = 503
    cliente = ClienteFalso(excecao=InternalServerError("nope"))
    with pytest.raises(GenerationError) as exc:
        enrichment.propose(produto(), provider="openai", client=cliente, router=_router())
    assert exc.value.code == "MODEL_UNAVAILABLE" and exc.value.retryable


def test_given_a_timeout_then_the_error_is_model_unavailable():
    class APITimeoutError(Exception):
        pass
    cliente = ClienteFalso(excecao=APITimeoutError("timeout"))
    with pytest.raises(GenerationError) as exc:
        enrichment.propose(produto(), provider="openai", client=cliente, router=_router())
    assert exc.value.code == "MODEL_UNAVAILABLE"


def test_given_an_authentication_error_then_the_error_is_model_authentication_failed_never_retryable():
    class AuthenticationError(Exception):
        status_code = 401
    cliente = ClienteFalso(excecao=AuthenticationError("bad key"))
    with pytest.raises(GenerationError) as exc:
        enrichment.propose(produto(), provider="openai", client=cliente, router=_router())
    assert exc.value.code == "MODEL_AUTHENTICATION_FAILED" and not exc.value.retryable


def test_given_an_empty_response_then_generation_failed_with_a_clear_reason():
    cliente = ClienteFalso(saida={})
    with pytest.raises(GenerationError) as exc:
        enrichment.propose(produto(), provider="openai", client=cliente, router=_router())
    assert exc.value.code == "GENERATION_FAILED" and exc.value.details["reason"] == "enrichment_empty_response"


def test_given_a_non_dict_response_then_generation_failed_not_a_crash():
    cliente = ClienteFalso(saida="isto não é um objeto")
    with pytest.raises(GenerationError) as exc:
        enrichment.propose(produto(), provider="openai", client=cliente, router=_router())
    assert exc.value.code == "GENERATION_FAILED"


# ------------------------------------------------------------------ saída parcial / conservadora
def test_given_a_partial_output_then_missing_fields_default_to_empty_not_an_error():
    cliente = ClienteFalso(saida={"confidence": 0.2, "justification": "", "used_reference_image": False})
    proposta = enrichment.propose(produto(), provider="openai", client=cliente, router=_router())
    assert proposta["proposed"]["wearer_roles"] == []
    assert proposta["proposed"]["relationship_themes"] == []
    assert proposta["proposed"]["confidence"] == 0.2
    assert contracts.validate("EnrichmentProposal", proposta) == []


def test_given_no_signal_at_all_then_nothing_is_invented_and_confidence_stays_low():
    cliente = ClienteFalso(saida=_saida(
        wearer_roles=[], relationship_themes=[], recommended_supporting_roles=[], scene_intents=[],
        confidence=0.05, justification="",
    ))
    proposta = enrichment.propose(produto(name="Produto genérico", type="x", description=""), provider="openai", client=cliente, router=_router())
    assert proposta["recommended_angle_families"] == [], "nenhuma família inventada sem tema"
    assert proposta["field_notes"] == {}, "sem justificativa e sem campo populado, nenhuma nota é criada"


# ------------------------------------------------------------------ visible_text: nunca inventado
def test_given_the_model_claims_it_saw_text_but_no_image_was_sent_then_visible_text_is_dropped():
    """O guard mais importante do provider real: um modelo que alucina `used_reference_image=true`
    sem nenhuma referência de verdade enviada não pode fazer `visible_text` (estampa) aparecer."""
    cliente = ClienteFalso(saida=_saida(visible_text=["ALGO INVENTADO"], used_reference_image=True))
    proposta = enrichment.propose(produto(), provider="openai", client=cliente, router=_router())  # sem `references`
    assert proposta["proposed"]["visible_text"] == []


def test_given_a_real_reference_image_and_the_model_reports_legible_text_then_visible_text_is_kept():
    referencias = [{"data_base64": _PNG_B64}]
    saida = _saida(visible_text=["FEITO À MÃO"], used_reference_image=True)
    saida["field_confidence"]["visible_text"] = 0.95  # genuinely read off the image — high, image-basis evidence
    saida["field_basis"]["visible_text"] = "observed_reference_image"
    cliente = ClienteFalso(saida=saida)
    proposta = enrichment.propose(produto(), provider="openai", client=cliente, router=_router(), references=referencias)
    assert proposta["proposed"]["visible_text"] == ["FEITO À MÃO"]
    assert proposta["provider_meta"]["references_used"] == 1


# ------------------------------------------------------------------ duas referências (precedente do bug da Fase C)
def test_given_exactly_two_references_then_both_reach_the_client_as_an_array():
    referencias = [{"data_base64": _PNG_B64}, {"data_base64": _JPEG_B64}]
    cliente = ClienteFalso(saida=_saida(used_reference_image=True))
    proposta = enrichment.propose(produto(), provider="openai", client=cliente, router=_router(), references=referencias)
    assert proposta["provider_meta"]["references_used"] == 2


def test_given_more_than_the_reference_cap_then_only_the_first_ones_are_sent():
    referencias = [{"data_base64": _PNG_B64}] * 5
    cliente = ClienteFalso(saida=_saida())
    proposta = enrichment.propose(produto(), provider="openai", client=cliente, router=_router(), references=referencias)
    assert proposta["provider_meta"]["references_used"] == enrichment._MAX_REFERENCES


def test_given_a_reference_that_is_not_a_real_image_then_it_is_silently_skipped_not_sent_malformed():
    """Nem toda entrada malformada é ausência de chave — um `data_base64` presente mas cujos bytes
    não batem nenhuma assinatura conhecida (o `mime` que o chamador alega é sempre ignorado; só os
    BYTES decidem) também é excluído em silêncio, sem derrubar a proposta inteira."""
    lixo_b64 = base64.b64encode(b"isto nao e uma imagem de verdade").decode()
    referencias = [{"data_base64": "nem-base64-valido"}, {"data_base64": lixo_b64}, {"data_base64": _PNG_B64}]
    cliente = ClienteFalso(saida=_saida())
    proposta = enrichment.propose(produto(), provider="openai", client=cliente, router=_router(), references=referencias)
    assert proposta["provider_meta"]["references_used"] == 1


# ------------------------------------------------------------------ vocabulário fechado nos enums do schema
def test_given_the_request_schema_then_role_fields_are_enum_constrained_to_the_planners_own_catalog():
    schema = enrichment._request_schema()
    assert set(schema["required"]) == set(schema["properties"].keys()), "strict mode exige todo campo em required"
    assert schema["additionalProperties"] is False
    assert schema["properties"]["wearer_roles"]["items"]["enum"] == list(enrichment._WEARER_ROLE_VALUES)
    assert schema["properties"]["recommended_supporting_roles"]["items"]["enum"] == list(enrichment._PERSON_ROLE_VALUES)
    assert "enum" not in schema["properties"]["relationship_themes"]["items"], "vocabulário livre — sugestão só no prompt, valor não reconhecido é ignorado a jusante, não recusado"
    assert "enum" not in schema["properties"]["scene_intents"]["items"]


# ==================================================================================================
# Fase F.2.B.1 — evidência por campo e os gates pós-modelo (§1/§2 do brief). O piloto real (F.2.B,
# prompt_version 1) mostrou um padrão de falha consistente nos 3 casos: um campo bem evidenciado
# (nome claro, texto legível na imagem) produzia confidence=1 GLOBAL, que então cobria campos SEM
# evidência própria (lista mecânica de "todo mundo exceto o recomendado", roster completo de papéis,
# valores genéricos do vocabulário). As regras abaixo são testadas tanto CONTRA os 3 casos reais
# (`creative-generator-fase-f2b-pilot-results.json`, usado como fixture, nunca como gabarito) quanto
# contra vocabulário/valores que NUNCA apareceram no piloto — a segunda metade é a prova de
# generalização que o brief exige ("mostre que as restrições se generalizam a equivalentes não
# vistos").
# ==================================================================================================

def test_given_the_request_schema_then_field_confidence_and_field_basis_are_required_and_closed():
    schema = enrichment._request_schema()
    assert "field_confidence" in schema["required"] and "field_basis" in schema["required"]
    fc, fb = schema["properties"]["field_confidence"], schema["properties"]["field_basis"]
    assert set(fc["required"]) == set(enrichment._MERGEABLE_FIELDS) == set(fc["properties"].keys())
    assert set(fb["required"]) == set(enrichment._MERGEABLE_FIELDS) == set(fb["properties"].keys())
    assert fc["additionalProperties"] is False and fb["additionalProperties"] is False
    for field in enrichment._MERGEABLE_FIELDS:
        assert fb["properties"][field]["enum"] == list(enrichment._FIELD_BASIS_VALUES)
        assert fc["properties"][field]["minimum"] == 0 and fc["properties"][field]["maximum"] == 1


def test_given_f2b1_then_prompt_and_request_schema_versions_are_bumped_but_the_stored_contract_is_not():
    """`provider_meta.prompt_version`/`schema_version` marcam esta geração de propostas como distinta
    do piloto F.2.B real (ambos eram 1 lá). `EnrichmentProposal.schema_version` (o formato ARMAZENADO
    de `proposed`) continua 1 — nenhum dado histórico muda de forma."""
    cliente = ClienteFalso(saida=_saida())
    proposta = enrichment.propose(produto(), provider="openai", client=cliente, router=_router())
    assert proposta["provider_meta"]["prompt_version"] == 2
    assert proposta["provider_meta"]["schema_version"] == 2
    assert proposta["schema_version"] == 1


# ------------------------------------------------------------------ _apply_evidence_gates: unidade, sem rede/roteador
def test_given_field_confidence_below_threshold_then_the_field_is_cleared_not_kept_as_a_guess():
    proposed = {"wearer_roles": ["adult", "child", "teen"], "scene_intents": ["everyday"]}
    fc = {"wearer_roles": 0.3, "scene_intents": 0.4}
    fb = {"wearer_roles": "generic_inference", "scene_intents": "generic_inference"}
    effective, cleared = enrichment._apply_evidence_gates(proposed, fc, fb)
    assert cleared == {"wearer_roles", "scene_intents"}


def test_given_a_generic_inference_basis_then_confidence_is_capped_even_if_the_model_claims_certainty():
    """O modelo não pode contornar o gate só declarando confiança alta para uma inferência genérica —
    o teto é sobre a CATEGORIA da evidência, não sobre o número que o modelo escolhe reportar."""
    proposed = {"scene_intents": ["gift"]}
    fc = {"scene_intents": 0.99}
    fb = {"scene_intents": "generic_inference"}
    effective, cleared = enrichment._apply_evidence_gates(proposed, fc, fb)
    assert effective["scene_intents"] == enrichment._GENERIC_INFERENCE_CONFIDENCE_CAP
    assert "scene_intents" in cleared


def test_given_incompatible_roles_exactly_complement_recommended_then_it_is_cleared_structurally():
    """Caso 1 do piloto real: `incompatible_auto_supporting_roles` era mecanicamente 'todo mundo
    exceto o recomendado' — detectado aqui pela FORMA (complemento exato do catálogo), nunca por
    citar 'mother'/'sibling'/etc. como palavras específicas."""
    all_roles = set(enrichment._PERSON_ROLE_VALUES)
    recommended = ["father"]
    proposed = {
        "recommended_supporting_roles": recommended,
        "incompatible_auto_supporting_roles": sorted(all_roles - {"father"}),
    }
    fc = {"recommended_supporting_roles": 0.9, "incompatible_auto_supporting_roles": 0.9}
    fb = {"recommended_supporting_roles": "text_or_metadata", "incompatible_auto_supporting_roles": "generic_inference"}
    effective, cleared = enrichment._apply_evidence_gates(proposed, fc, fb)
    assert "incompatible_auto_supporting_roles" in cleared
    assert "recommended_supporting_roles" not in cleared, "o campo bem evidenciado não é penalizado pelo vizinho"


def test_given_recommended_roles_is_the_whole_catalog_then_it_is_cleared_structurally():
    """Caso 3 do piloto real: `recommended_supporting_roles` trazia os 6 papéis do catálogo inteiro —
    'recomendar todo mundo' não é uma recomendação. Mesmo check do teste acima, espelhado."""
    proposed = {"recommended_supporting_roles": list(enrichment._PERSON_ROLE_VALUES), "incompatible_auto_supporting_roles": []}
    fc = {"recommended_supporting_roles": 0.6}
    fb = {"recommended_supporting_roles": "generic_inference"}
    effective, cleared = enrichment._apply_evidence_gates(proposed, fc, fb)
    assert "recommended_supporting_roles" in cleared


def test_given_an_explicit_high_confidence_non_generic_override_then_a_full_roster_exclusion_survives():
    """O gate estrutural não é absoluto: um produto cujo TEXTO diz explicitamente 'só para X' é uma
    razão concreta, não uma lista mecânica — precisa sobreviver quando o modelo reporta isso com
    confiança alta e uma base não-genérica."""
    all_roles = set(enrichment._PERSON_ROLE_VALUES)
    proposed = {
        "recommended_supporting_roles": ["father"],
        "incompatible_auto_supporting_roles": sorted(all_roles - {"father"}),
    }
    fc = {"recommended_supporting_roles": 0.95, "incompatible_auto_supporting_roles": 0.95}
    fb = {"recommended_supporting_roles": "text_or_metadata", "incompatible_auto_supporting_roles": "text_or_metadata"}
    effective, cleared = enrichment._apply_evidence_gates(proposed, fc, fb)
    assert "incompatible_auto_supporting_roles" not in cleared
    assert effective["incompatible_auto_supporting_roles"] == 0.95


def test_given_a_completely_unseen_catalog_then_the_same_structural_checks_apply_unmodified(monkeypatch):
    """Prova de generalização exigida pelo brief F.2.B.1 §1: um catálogo de papéis TOTALMENTE
    diferente (nada de father/mother/sibling — um vocabulário esportivo hipotético) aciona a MESMA
    regra estrutural, sem nenhuma palavra específica hardcoded no código de produção."""
    monkeypatch.setattr(enrichment, "_PERSON_ROLE_VALUES", ("coach", "teammate", "rival", "sponsor"))
    proposed = {
        "recommended_supporting_roles": ["coach"],
        "incompatible_auto_supporting_roles": ["teammate", "rival", "sponsor"],  # complemento mecânico
    }
    fc = {"recommended_supporting_roles": 0.9, "incompatible_auto_supporting_roles": 0.9}
    fb = {"recommended_supporting_roles": "text_or_metadata", "incompatible_auto_supporting_roles": "generic_inference"}
    effective, cleared = enrichment._apply_evidence_gates(proposed, fc, fb)
    assert "incompatible_auto_supporting_roles" in cleared
    assert "recommended_supporting_roles" not in cleared


def test_given_an_unrecognized_or_missing_basis_value_then_it_is_treated_as_unevidenced_not_trusted():
    """Um `field_basis` ausente ou fora do vocabulário fechado (resposta malformada, nunca deveria
    acontecer sob strict mode, mas o código não confia cegamente) é tratado como a categoria mais
    fraca, nunca como se fosse `observed_reference_image`."""
    proposed = {"scene_intents": ["play"]}
    fc = {"scene_intents": 0.9}
    fb = {}  # ausente
    effective, cleared = enrichment._apply_evidence_gates(proposed, fc, fb)
    assert effective["scene_intents"] == enrichment._GENERIC_INFERENCE_CONFIDENCE_CAP
    assert "scene_intents" in cleared


# ------------------------------------------------------------------ regressão: os 3 casos reais do piloto F.2.B
# `creative-generator-fase-f2b-pilot-results.json` é evidência real (3/3 chamadas reais, F.2.B), mas o
# schema daquele piloto (prompt_version 1) NUNCA coletou field_confidence/field_basis por campo — os
# valores abaixo são uma RECONSTRUÇÃO plausível, consistente com a própria justificativa que o modelo
# real escreveu em cada `field_notes` do JSON (ex.: caso 2 admite "não há informações suficientes" —
# isso é o que uma resposta HONESTA sob o novo schema reportaria como confiança baixa/generic_inference
# para aquele campo). Isto NUNCA é apresentado como uma nova chamada real à OpenAI — é uma simulação
# do pipeline NOVO sobre uma saída de modelo hipotética, documentada como tal no relatório da F.2.B.1.
def test_given_case1_reconstructed_with_honest_field_evidence_then_the_mechanical_exclusion_is_dropped():
    saida = _saida(
        wearer_roles=["child"], relationship_themes=["father_child"], recommended_supporting_roles=["father"],
        incompatible_auto_supporting_roles=["mother", "sibling", "grandparent", "partner", "friend"],
        scene_intents=["play", "bond", "family", "everyday"], visible_text=[], confidence=1,
        used_reference_image=False,
        justification="descrição menciona brincar com o pai; vínculo pai-filho explícito no texto",
        field_confidence={
            "wearer_roles": 0.9, "relationship_themes": 0.9, "recommended_supporting_roles": 0.9,
            "incompatible_auto_supporting_roles": 0.9, "scene_intents": 0.7, "visible_text": 0.0,
        },
        field_basis={
            "wearer_roles": "text_or_metadata", "relationship_themes": "text_or_metadata",
            "recommended_supporting_roles": "text_or_metadata",
            "incompatible_auto_supporting_roles": "generic_inference",  # mecânico — não uma exclusão explícita do texto
            "scene_intents": "text_or_metadata", "visible_text": "no_evidence",
        },
    )
    cliente = ClienteFalso(saida=saida)
    proposta = enrichment.propose(produto(name="Brincar com Meu Pai"), provider="openai", client=cliente, router=_router())
    proposed = proposta["proposed"]
    assert proposed["wearer_roles"] == ["child"]
    assert proposed["relationship_themes"] == ["father_child"]
    assert proposed["recommended_supporting_roles"] == ["father"]
    assert proposed["incompatible_auto_supporting_roles"] == [], "exclusão mecânica não sobrevive sem evidência própria"
    assert proposed["scene_intents"] == ["play", "bond", "family", "everyday"]
    assert proposed["confidence"] < 1.0, "confiança agregada não fica presa em 1 por causa de um campo genérico"
    assert proposta["field_notes"]["wearer_roles"]["source"] == "openai_text"
    assert "incompatible_auto_supporting_roles" not in proposta["field_notes"], "campo limpo não recebe nota"


def test_given_case2_reconstructed_with_honest_low_confidence_then_wearer_roles_is_not_guessed():
    saida = _saida(
        wearer_roles=["adult", "child", "teen"], relationship_themes=[], recommended_supporting_roles=[],
        incompatible_auto_supporting_roles=[], scene_intents=["everyday"], visible_text=[], confidence=0.5,
        used_reference_image=False,
        justification="sem metadados de tamanho/idade confiáveis para afirmar o público",
        field_confidence={
            "wearer_roles": 0.3,  # a própria justificativa admite falta de evidência
            "relationship_themes": 0.0, "recommended_supporting_roles": 0.0,
            "incompatible_auto_supporting_roles": 0.0, "scene_intents": 0.3, "visible_text": 0.0,
        },
        field_basis={
            "wearer_roles": "generic_inference", "relationship_themes": "no_evidence",
            "recommended_supporting_roles": "no_evidence", "incompatible_auto_supporting_roles": "no_evidence",
            "scene_intents": "generic_inference", "visible_text": "no_evidence",
        },
    )
    cliente = ClienteFalso(saida=saida)
    proposta = enrichment.propose(produto(name="Camiseta Listrada Azul"), provider="openai", client=cliente, router=_router())
    proposed = proposta["proposed"]
    assert proposed["wearer_roles"] == [], "sem categoria/tamanho confiável, o campo fica desconhecido — não adult+child+teen"
    assert proposed["scene_intents"] == [], "'everyday' sem sinal específico não é tratado como descoberta"
    assert proposed["relationship_themes"] == [] and proposed["recommended_supporting_roles"] == [], "abstenção correta preservada"
    assert proposta["field_notes"] == {}, "nenhum campo sobreviveu — nenhuma nota falsa é criada"


def test_given_case3_reconstructed_then_visible_text_survives_but_unrelated_fields_do_not():
    referencias = [{"data_base64": _PNG_B64}]
    saida = _saida(
        wearer_roles=["adult", "child", "teen"], relationship_themes=["family", "friends"],
        recommended_supporting_roles=list(enrichment._PERSON_ROLE_VALUES),
        incompatible_auto_supporting_roles=[], scene_intents=["everyday", "gift", "outing"],
        visible_text=["FEITO A MAO"], confidence=1, used_reference_image=True,
        justification="a imagem de referência apresenta o texto 'FEITO A MAO'",
        field_confidence={
            "wearer_roles": 0.3, "relationship_themes": 0.4, "recommended_supporting_roles": 0.4,
            "incompatible_auto_supporting_roles": 0.0, "scene_intents": 0.4, "visible_text": 0.95,
        },
        field_basis={
            "wearer_roles": "generic_inference", "relationship_themes": "generic_inference",
            "recommended_supporting_roles": "generic_inference", "incompatible_auto_supporting_roles": "no_evidence",
            "scene_intents": "generic_inference", "visible_text": "observed_reference_image",
        },
    )
    cliente = ClienteFalso(saida=saida)
    proposta = enrichment.propose(produto(name="Feito à Mão"), provider="openai", client=cliente, router=_router(), references=referencias)
    proposed = proposta["proposed"]
    assert proposed["visible_text"] == ["FEITO A MAO"], "leitura legível na imagem sintética permanece válida para este fixture"
    assert proposed["relationship_themes"] == [], "family/friends não decorrem necessariamente do texto lido"
    assert proposed["recommended_supporting_roles"] == [], "roster completo (todos os 6 papéis) sem sinal próprio é limpo"
    assert proposed["scene_intents"] == [], "gift/outing não decorrem necessariamente do texto lido"
    assert proposed["wearer_roles"] == []
    assert proposta["field_notes"]["visible_text"]["source"] == "openai_vision"
    assert proposta["field_notes"]["visible_text"]["confidence"] == 0.95
    assert proposed["confidence"] < 1.0, "a leitura correta do texto não empresta confiança=1 aos demais campos"


def test_given_the_historical_pilot_json_shape_then_it_still_validates_as_a_stored_contract_object():
    """Os 3 objetos reais do piloto (`docs/features/creative-generator-fase-f2b-pilot-results.json`)
    não têm `field_confidence`/`field_basis` — schema da REQUISIÇÃO mudou, mas o formato ARMAZENADO
    (`ProductSemanticContext`/`EnrichmentProposal`) não. Isto prova compatibilidade retroativa: um
    objeto histórico continua validando sem qualquer migração, mesmo sem ser re-executado."""
    proposed_historico = {
        "wearer_roles": ["child"], "relationship_themes": ["father_child"],
        "recommended_supporting_roles": ["father"],
        "incompatible_auto_supporting_roles": ["mother", "sibling", "grandparent", "partner", "friend"],
        "scene_intents": ["play", "bond", "family", "everyday"], "visible_text": [],
        "source": "enrichment", "confidence": 1,
    }
    assert contracts.validate("ProductSemanticContext", proposed_historico) == [], (
        "histórico do piloto (prompt_version 1) continua um ProductSemanticContext válido — "
        "nenhum dado antigo é invalidado pela mudança de schema da F.2.B.1"
    )


# ------------------------------------------------------------------ Fase F.2.B: adaptador SDK real (client fake, ZERO rede)
class _FakeSDKResponses:
    """Simula `openai.OpenAI().responses` — `.create(**kwargs)` captura exatamente o que seria
    mandado pela rede de verdade, sem nunca tocar em uma. `object()` no lugar do client real garante
    que nada aqui pode, por acidente, ser um client de verdade."""

    def __init__(self, output_json, model="gpt-4o-mini", usage=None):
        self.captured_kwargs = None
        self._output_json = output_json
        self._model = model
        self._usage = usage

    def create(self, **kwargs):
        self.captured_kwargs = kwargs
        import json as _json
        return _FakeSDKResponse(_json.dumps(self._output_json) if self._output_json is not None else "", self._model, self._usage)


class _FakeSDKResponse:
    def __init__(self, output_text, model, usage):
        self.output_text = output_text
        self.model = model
        self.usage = usage


class _FakeSDKClient:
    def __init__(self, output_json, model="gpt-4o-mini", usage=None):
        self.responses = _FakeSDKResponses(output_json, model, usage)


def test_given_the_real_adapter_then_it_sends_the_exact_structured_outputs_request_shape():
    saida = _saida()
    sdk = _FakeSDKClient(saida)
    client = enrichment.real_openai_client(sdk)
    schema = enrichment._request_schema()
    resultado = client.create(model="gpt-4o-mini", system="regras do sistema", user_text="texto do produto",
                              images_b64=[], schema=schema, timeout=12.5)
    enviado = sdk.responses.captured_kwargs
    assert enviado["model"] == "gpt-4o-mini"
    assert enviado["input"][0] == {"role": "system", "content": [{"type": "input_text", "text": "regras do sistema"}]}
    assert enviado["input"][1]["role"] == "user"
    assert enviado["input"][1]["content"][0] == {"type": "input_text", "text": "texto do produto"}
    assert enviado["text"]["format"]["type"] == "json_schema"
    assert enviado["text"]["format"]["strict"] is True
    assert enviado["text"]["format"]["schema"] is schema
    assert isinstance(enviado["text"]["format"]["name"], str) and enviado["text"]["format"]["name"]
    assert set(schema["required"]) == set(schema["properties"].keys()), "strict mode exige todo campo em required"
    assert schema["additionalProperties"] is False
    assert isinstance(enviado["max_output_tokens"], int) and 0 < enviado["max_output_tokens"] <= 2000, "finito e pequeno — nunca mais tokens do que o schema pede"
    assert enviado["timeout"] == 12.5
    assert resultado.output_json == saida
    assert resultado.model == "gpt-4o-mini"


def test_given_two_reference_images_then_both_become_input_image_parts_with_explicit_low_detail():
    sdk = _FakeSDKClient(_saida())
    client = enrichment.real_openai_client(sdk)
    client.create(model="gpt-4o-mini", system="s", user_text="u",
                  images_b64=[("image/png", "AAAA"), ("image/jpeg", "BBBB")], schema=enrichment._request_schema(), timeout=10.0)
    content = sdk.responses.captured_kwargs["input"][1]["content"]
    assert content[0] == {"type": "input_text", "text": "u"}
    assert content[1] == {"type": "input_image", "image_url": "data:image/png;base64,AAAA", "detail": "low"}
    assert content[2] == {"type": "input_image", "image_url": "data:image/jpeg;base64,BBBB", "detail": "low"}


def test_given_a_response_with_usage_then_it_is_extracted_via_the_shared_usage_reader():
    sdk = _FakeSDKClient(_saida(), usage={"input_tokens": 210, "output_tokens": 55, "total_tokens": 265})
    resultado = enrichment.real_openai_client(sdk).create(model="gpt-4o-mini", system="s", user_text="u",
                                                          images_b64=[], schema=enrichment._request_schema(), timeout=10.0)
    assert resultado.usage == {"input_tokens": 210, "output_tokens": 55, "total_tokens": 265}


def test_given_an_empty_or_malformed_output_text_then_the_adapter_returns_an_empty_dict_not_a_crash():
    sdk = _FakeSDKClient(None)  # output_text vira ""
    resultado = enrichment.real_openai_client(sdk).create(model="gpt-4o-mini", system="s", user_text="u",
                                                          images_b64=[], schema=enrichment._request_schema(), timeout=10.0)
    assert resultado.output_json == {}


def test_given_the_real_adapter_wired_through_propose_then_the_full_path_works_with_zero_network():
    """Fim a fim, incluindo `_OpenAIProvider.propose()` inteiro — o único componente real ainda fora
    deste teste é `openai.OpenAI()` em si (nunca importado aqui)."""
    sdk = _FakeSDKClient(_saida(used_reference_image=False), usage={"input_tokens": 100, "output_tokens": 40})
    client = enrichment.real_openai_client(sdk)
    proposta = enrichment.propose(produto(), provider="openai", client=client, router=_router())
    assert contracts.validate("EnrichmentProposal", proposta) == []
    assert proposta["provider_meta"]["usage"] == {"input_tokens": 100, "output_tokens": 40}
    assert proposta["provider_meta"]["model_served"] == "gpt-4o-mini"
