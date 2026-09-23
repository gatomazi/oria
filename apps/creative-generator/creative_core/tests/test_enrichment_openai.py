"""Fase F.2.A — the real (OpenAI) Product Enrichment provider. ZERO real calls anywhere in this file
or in enrichment.py itself: every test injects a fake `OpenAIClient` (see enrichment.OpenAIClient) —
nothing here imports the `openai` package or reads OPENAI_API_KEY. `test_enrichment.py` covers the
"fake" provider and the merge/provenance rules; this file is only the OpenAI-specific surface: model
allowlist/fallback, request shape, response parsing, the visible_text hallucination guard, and error
classification (§4 of the brief: sucesso, ausência de referência, saída parcial, payload inválido,
timeout, 429, 5xx, resposta vazia, duas referências, limite de custo, concorrência)."""
from __future__ import annotations

import base64

import pytest

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
    base = {
        "wearer_roles": ["adult", "child"], "relationship_themes": ["family"],
        "recommended_supporting_roles": ["father"], "incompatible_auto_supporting_roles": [],
        "scene_intents": ["play"], "visible_text": [], "confidence": 0.8,
        "justification": "nome e descrição mencionam pai e filho brincando", "used_reference_image": False,
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
    """Confirma o achado da auditoria de documentação: o default do router (`gpt-5.6`) não é um
    model id real hoje — o provider não confia nele às cegas."""
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
    cliente = ClienteFalso(saida=_saida(visible_text=["FEITO À MÃO"], used_reference_image=True))
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
