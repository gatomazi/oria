"""Angles — stable IDs shared by every strategy.

The ID is a slot of the engine (it decides intensity, close framing,
multi-product limit and template key); what a slot MEANS is configuration:
brand kits and niche kits override the label through `angleLabels`.

Internal constants below were moved verbatim from app.py (Etapa 1). The
generic, product-agnostic catalog used by the public engines lives in
templates/angles.json.
"""
from __future__ import annotations

import json
from pathlib import Path

# Lista oficial dos 13 ângulos (ordem também usada nos checkboxes da UI).
# CABIDE e PRODUTO_ESTAMPA ("Flatlay" na UI) têm uma pergunta extra de
# intensidade (Clean/Lifestyle) que resolve pra uma chave de template
# diferente — ver _resolver_template_key_angulo_limpo().
ANGULOS_LIMPOS = [
    "IDENTIDADE_ORIGEM",
    "LIFESTYLE_COTIDIANO",
    "ORGULHO_DISCRETO",
    "PERTENCIMENTO",
    "NOSTALGIA_ORIGEM",
    "CABIDE",
    "PRODUTO_ESTAMPA",
    "CAIMENTO",
    "CLOSE_ESTAMPA",
    "CLOSE_BOLSO",
    "PREMIUM_ESTILO",
    "CREATOR_STYLE",
    "PRESENTE_AFETO",
]

# Ângulos que abrem uma pergunta extra de intensidade (Clean x Lifestyle) na
# UI — o valor escolhido decide qual chave de template é usada de fato.
ANGULOS_COM_INTENSIDADE = {"CABIDE", "PRODUTO_ESTAMPA", "CLOSE_ESTAMPA", "CLOSE_BOLSO"}

# Ângulos de close com pessoa vestindo — mesma dupla dos ângulos
# person_close_estampa / person_close_pocket_print do modo ORGANICO.
# Aqui o par ANGULOS_LIMPOS/MULTIPECA usa IDs de template, não configs JSON.
ANGULOS_CLOSE = {"CLOSE_ESTAMPA", "CLOSE_BOLSO"}

# ---------- Modo ANGULOS_MULTIPECA (N produtos no mesmo criativo) ----------
# Reaproveita 100% o motor de templates do ANGULOS_LIMPOS (mesmos IDs de
# ângulo, mesmos arquivos JSON, mesma _montar_variavel_base) — só adiciona
# a dimensão "N peças" nos 3 ângulos que fazem sentido replicar em série sem
# virar bagunça visual (produto puro, sem cenário/emoção específica de 1
# pessoa só). Os outros 8 ângulos de ANGULOS_LIMPOS continuam existindo só
# no modo single-product.

# Limite de segurança de PRODUTO (não é limite da API/modelo — gpt-image-2
# já aceita várias imagens de referência numa chamada). Configurável aqui,
# nunca hardcoded dentro da lógica de distribuição/prompt.
MAX_PRODUCTS_PER_CREATIVE = 6

# Multipeça suporta os mesmos 13 ângulos de ANGULOS_LIMPOS — cada um com sua
# versão "_MULTI" de template (ver ads/templates/angulos_limpos_*.json).
# Ângulos com pessoa (todos exceto CABIDE/PRODUTO_ESTAMPA/PREMIUM_ESTILO/
# PRESENTE_AFETO) usam N pessoas diferentes, cada uma vestindo 1 peça
# diferente — mesmo padrão já estabelecido em CAIMENTO_MULTI. Nos ângulos de
# close (CLOSE_ESTAMPA/CLOSE_BOLSO) as N pessoas aparecem em plano fechado,
# o que limita a quantidade útil de peças (ver LIMITE_RECOMENDADO_MULTIPECA).
ANGULOS_MULTIPECA_SUPORTADOS = list(ANGULOS_LIMPOS)

# Acima desse número de peças o ângulo tende a ficar poluído/ilegível —
# soft warning na UI, nunca bloqueia a geração. Ângulos só-produto (sem
# pessoa) toleram mais peças que ângulos com pessoa.
LIMITE_RECOMENDADO_MULTIPECA = {
    "CABIDE": 6,
    "PRODUTO_ESTAMPA": 6,
    "PREMIUM_ESTILO": 6,
    "PRESENTE_AFETO": 6,
    "CAIMENTO": 4,
    # Plano fechado com muita gente vira colagem de torsos — teto mais baixo.
    "CLOSE_ESTAMPA": 3,
    "CLOSE_BOLSO": 2,
    "IDENTIDADE_ORIGEM": 4,
    "LIFESTYLE_COTIDIANO": 4,
    "ORGULHO_DISCRETO": 4,
    "PERTENCIMENTO": 4,
    "NOSTALGIA_ORIGEM": 4,
    "CREATOR_STYLE": 4,
}

ANGLE_IDS = tuple(ANGULOS_LIMPOS)

_CATALOG_PATH = Path(__file__).parent / "templates" / "angles.json"
with open(_CATALOG_PATH, encoding="utf-8") as _f:
    CORE_ANGLES: dict = json.load(_f)["angles"]


def resolve_angle_label(angle_id: str, brand_kit: dict | None = None, niche_kit: dict | None = None) -> str:
    """Brand label > niche label > core default label > the ID itself."""
    for kit in (brand_kit, niche_kit):
        label = ((kit or {}).get("angleLabels") or {}).get(angle_id)
        if label:
            return label
    return CORE_ANGLES.get(angle_id, {}).get("label", angle_id)


def angle_is_available(angle_id: str, brand_kit: dict | None, niche_kit: dict | None) -> bool:
    """An angle is available when the brand enabled it (or enables all) and,
    for apparel-only angles, when the niche supports apparel angles."""
    spec = CORE_ANGLES.get(angle_id)
    if spec is None:
        return False
    enabled = (brand_kit or {}).get("enabledAngles")
    if enabled and angle_id not in enabled:
        return False
    if spec["apparel_only"] and not (niche_kit or {}).get("supportsApparelAngles", False):
        return False
    return True


def available_angles(brand_kit: dict | None, niche_kit: dict | None) -> list[str]:
    return [a for a in ANGLE_IDS if angle_is_available(a, brand_kit, niche_kit)]


def angle_descriptor(angle_id: str, brand_kit: dict | None = None, niche_kit: dict | None = None) -> dict:
    """Angle contract (contracts.CONTRACTS["Angle"])."""
    spec = CORE_ANGLES[angle_id]
    return {
        "id": angle_id,
        "label": resolve_angle_label(angle_id, brand_kit, niche_kit),
        "description": spec["description"],
        "uses_person": spec["uses_person"],
        "apparel_only": spec["apparel_only"],
        "multi_product_limit": min(LIMITE_RECOMENDADO_MULTIPECA.get(angle_id, MAX_PRODUCTS_PER_CREATIVE),
                                   MAX_PRODUCTS_PER_CREATIVE),
    }
