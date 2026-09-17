"""Prompt rules shared across strategies.

REGRA_ZERO_TEXTO_ANGULOS_LIMPOS moved verbatim from app.py (Etapa 1) — it is
the textual form of the CLEAN_ANGLES_HAS_NO_OVERLAY contract and is used by the
internal Ângulos Limpos / Multipeça strategies and by the public CLEAN_ANGLES
engine.
"""
from __future__ import annotations

CLEAN_ANGLES_HAS_NO_OVERLAY = True

REGRA_ZERO_TEXTO_ANGULOS_LIMPOS = (
    "\n- MODO ÂNGULOS LIMPOS (regra absoluta, prioridade máxima): NÃO adicione "
    "headline, CTA, preço, desconto, cupom, selo, benefício, ícone de frete, "
    "frase promocional, texto simulando postagem/depoimento/avaliação/"
    "comentário, ou botão gráfico — nenhum texto gráfico sobreposto de "
    "qualquer tipo. O ÚNICO texto permitido na imagem é aquele que já existe "
    "na estampa fornecida como referência. Não invente, reescreva ou "
    "complemente qualquer texto. Esta imagem representa só um ângulo "
    "criativo — ela pode ser usada depois com copy de TOFU, MOFU ou BOFU "
    "igualmente, então não deve conter nada que amarre a peça a uma etapa "
    "específica do funil."
)

# Terms that must never be requested as image overlay in CLEAN_ANGLES. Used by
# the engine validation to prove the plan carries no overlay instruction.
CLEAN_ANGLES_FORBIDDEN_OVERLAY = (
    "headline", "subheadline", "cta", "botão", "badge", "preço", "oferta", "benefício", "selo",
)
