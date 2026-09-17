"""Medição de consumo das chamadas ao provedor (base do custo mostrado ao cliente).

O que estes testes protegem: o painel informa ao cliente quanto a geração custou, e a única fonte
honesta desse número é o `usage` que a OpenAI devolve. Duas confusões custariam caro aqui —
tratar "não medido" como zero (subestima a fatura) e perder a medição de uma chamada que falhou
depois de já ter sido cobrada.
"""
from __future__ import annotations

import base64

from _support import FakeClient, FakeImages, _Obj, load_fixture, png_bytes, run

from creative_core import model_router as mr
from creative_core.engines import generate_creative, plan_creative, usage_from_response

ROUTER = mr.ModelRouter(env={})


def _refs(plan):
    return {role["ref"]: png_bytes(64, 64) for role in plan["references"]}


class ImagensComUsage(FakeImages):
    """Provedor que reporta consumo, como gpt-image-* faz de verdade."""

    def __init__(self, usage, **kw):
        super().__init__(**kw)
        self._usage = usage

    def edit(self, **kwargs):
        self.calls.append(kwargs)
        return _Obj(
            data=[_Obj(b64_json=base64.b64encode(self._png).decode())],
            usage=self._usage,
        )


# ── leitura do usage ────────────────────────────────────────────────────────────────────────

def test_given_response_without_usage_then_returns_none_not_zero():
    # "Não medido" e "custou zero" são coisas diferentes: zero some na soma e subestima a fatura.
    assert usage_from_response(_Obj()) is None
    assert usage_from_response(_Obj(usage=None)) is None


def test_given_usage_dict_then_reads_token_counts():
    lido = usage_from_response(_Obj(usage={"input_tokens": 120, "output_tokens": 4096, "total_tokens": 4216}))
    assert lido == {"input_tokens": 120, "output_tokens": 4096, "total_tokens": 4216}


def test_given_cached_input_tokens_then_they_are_kept_apart():
    # Token de entrada em cache é cobrado mais barato; somado junto, o custo sai inflado.
    lido = usage_from_response(_Obj(usage={
        "input_tokens": 1000,
        "output_tokens": 50,
        "input_tokens_details": {"cached_tokens": 800},
    }))
    assert lido["cached_input_tokens"] == 800
    assert lido["input_tokens"] == 1000


def test_given_text_and_image_input_split_then_both_are_kept():
    # No gpt-image-2 o token de imagem custa mais caro que o de texto. Somados, o custo erra.
    lido = usage_from_response(_Obj(usage={
        "input_tokens": 1500,
        "output_tokens": 1584,
        "input_tokens_details": {"text_tokens": 300, "image_tokens": 1200},
    }))
    assert lido["text_input_tokens"] == 300
    assert lido["image_input_tokens"] == 1200


def test_given_usage_object_instead_of_dict_then_still_read():
    # O SDK devolve um modelo, não um dict — e a versão muda com o tempo.
    class Usage:
        input_tokens = 10
        output_tokens = 20
        total_tokens = 30

    assert usage_from_response(_Obj(usage=Usage())) == {
        "input_tokens": 10, "output_tokens": 20, "total_tokens": 30,
    }


def test_given_garbage_usage_then_never_raises():
    # Medição é contabilidade: nunca pode derrubar uma geração que já foi paga.
    assert usage_from_response(_Obj(usage={"input_tokens": "muitos"})) is None
    assert usage_from_response(_Obj(usage=123)) is None


# ── usage no resultado da geração ───────────────────────────────────────────────────────────

def test_given_generation_then_usage_lands_in_metadata():
    plan = plan_creative(load_fixture("fixture-clean-single")["input"], router=ROUTER)
    client = FakeClient(images=ImagensComUsage({"input_tokens": 300, "output_tokens": 1584}))
    result = generate_creative(plan, client=client, references=_refs(plan), router=ROUTER)
    assert result["status"] == "completed"
    assert result["metadata"]["usage"] == {"input_tokens": 300, "output_tokens": 1584}


def test_given_provider_without_usage_then_metadata_says_none_and_generation_succeeds():
    plan = plan_creative(load_fixture("fixture-clean-single")["input"], router=ROUTER)
    result = generate_creative(plan, client=FakeClient(), references=_refs(plan), router=ROUTER)
    assert result["status"] == "completed"
    assert result["metadata"]["usage"] is None


def test_given_asset_processing_fails_after_a_billed_call_then_usage_survives():
    # A chamada já foi cobrada. Perder o usage aqui esconderia gasto real do cliente.
    plan = plan_creative(load_fixture("fixture-clean-single")["input"], router=ROUTER)

    class ImagemCorrompida(ImagensComUsage):
        def edit(self, **kwargs):
            self.calls.append(kwargs)
            return _Obj(data=[_Obj(b64_json="nao-e-base64-de-imagem")], usage=self._usage)

    client = FakeClient(images=ImagemCorrompida({"input_tokens": 300, "output_tokens": 1584}))
    result = generate_creative(plan, client=client, references=_refs(plan), router=ROUTER)
    assert result["status"] == "failed"
    assert result["metadata"]["usage"] == {"input_tokens": 300, "output_tokens": 1584}


if __name__ == "__main__":
    run(globals())
