"""Strategy registry — the 6 internal strategies and the 3 public engines.

Internal IDs (FUNIL_VISUAL, COLECAO_ESTADO, ...) are kept exactly as they are
used in app.py, config/lojas.json and the CSV manifests; the core refers to
them by canonical English IDs. Nothing here removes or hides an internal
strategy: the public subset is a filter over the same registry, not a fork.

In the public product (Oria) multi-product is a capability of each engine
(`product_mode`), never a fourth strategy.
"""
from __future__ import annotations

from .versions import STRATEGY_VERSIONS

# canonical id -> descriptor
STRATEGIES: dict[str, dict] = {
    "FUNNEL_VISUAL": {
        "internal_id": "FUNIL_VISUAL",
        "label": "Funil por Criativo",
        "funnel_lives_in": "image",
        "public": True,
    },
    "STATE_COLLECTION": {
        "internal_id": "COLECAO_ESTADO",
        "label": "Coleção do Estado (funil na arte, várias cidades)",
        "funnel_lives_in": "image",
        "public": False,
    },
    "REMARKETING": {
        "internal_id": "REMARKETING",
        "label": "Remarketing (layouts editoriais, cidades ou estampas)",
        "funnel_lives_in": "image",
        "public": True,
    },
    "CLEAN_ANGLES": {
        "internal_id": "ANGULOS_LIMPOS",
        "label": "Ângulos Limpos / Funil na Copy",
        "funnel_lives_in": "copy",
        "public": True,
    },
    "MULTI_PRODUCT_INTERNAL": {
        "internal_id": "ANGULOS_MULTIPECA",
        "label": "Ângulos Multipeça / Multiestampa",
        "funnel_lives_in": "copy",
        "public": False,
    },
    "ORGANIC": {
        "internal_id": "ORGANICO",
        "label": "Orgânico (Creative Studio multi-marca)",
        "funnel_lives_in": "none",
        "public": False,
    },
}

# Order of the internal selector in app.py (do not reorder: UI contract).
INTERNAL_STRATEGIES = (
    "FUNNEL_VISUAL", "STATE_COLLECTION", "REMARKETING", "CLEAN_ANGLES", "MULTI_PRODUCT_INTERNAL", "ORGANIC",
)
SAAS_STRATEGIES = ("CLEAN_ANGLES", "REMARKETING", "FUNNEL_VISUAL")

# Internal ids in selector order — what app.py calls MODO_CRIACAO.
MODO_CRIACAO = [STRATEGIES[s]["internal_id"] for s in INTERNAL_STRATEGIES]
# Internal id -> UI label — what app.py calls LABEL_POR_ESTRATEGIA.
LABEL_POR_ESTRATEGIA = {STRATEGIES[s]["internal_id"]: STRATEGIES[s]["label"] for s in INTERNAL_STRATEGIES}

_BY_INTERNAL = {d["internal_id"]: canonical for canonical, d in STRATEGIES.items()}

# Remarketing intents where several products tell the same story. product_view
# is about ONE product; cart/checkout only when the real basket has several
# (products_source == "basket") — never a hard ban on real multi-item carts.
REMARKETING_MULTI_INTENTS = ("site_visitor", "collection_discovery", "social_proof", "objection")
REMARKETING_BASKET_INTENTS = ("cart", "checkout")

MULTI_PRODUCT_RULES: dict[str, dict] = {
    "CLEAN_ANGLES": {"enabled": True, "min": 2, "max": 6},
    # max 5: the remarketing layout families accept at most 5 products
    # (flatlay_grid / flatlay_hero_stack) and at most 3 people (multi-model).
    "REMARKETING": {
        "enabled": True, "min": 2, "max": 5,
        "allowedIntents": list(REMARKETING_MULTI_INTENTS),
        "basketIntents": list(REMARKETING_BASKET_INTENTS),
        "singleOnlyIntents": ["product_view"],
    },
    "FUNNEL_VISUAL": {"enabled": True, "min": 2, "max": 6},
}

SINGLE_PRODUCT_LIMITS = {"min": 1, "max": 1}


def canonical_id(strategy_id: str) -> str:
    """Accepts canonical or internal id and returns the canonical one."""
    if strategy_id in STRATEGIES:
        return strategy_id
    if strategy_id in _BY_INTERNAL:
        return _BY_INTERNAL[strategy_id]
    raise KeyError(strategy_id)


def internal_id(strategy_id: str) -> str:
    return STRATEGIES[canonical_id(strategy_id)]["internal_id"]


def is_public(strategy_id: str) -> bool:
    return canonical_id(strategy_id) in SAAS_STRATEGIES


def strategy_version(strategy_id: str) -> int:
    return STRATEGY_VERSIONS[canonical_id(strategy_id)]


def product_limits(strategy_id: str, product_mode: str) -> dict:
    if product_mode == "single_product":
        return dict(SINGLE_PRODUCT_LIMITS)
    rule = MULTI_PRODUCT_RULES[canonical_id(strategy_id)]
    return {"min": rule["min"], "max": rule["max"]}


def compatibility_matrix() -> list[dict]:
    """Compatibility matrix published in the handoff contract."""
    return [
        {"engine": "CLEAN_ANGLES", "single": True, "multi": True, "headline_in_image": False,
         "funnel_visual": None, "external_copy": "optional"},
        {"engine": "REMARKETING", "single": True, "multi": "when_applicable", "headline_in_image": True,
         "funnel_visual": "intent_driven", "external_copy": "optional"},
        {"engine": "FUNNEL_VISUAL", "single": True, "multi": True, "headline_in_image": True,
         "funnel_visual": "TOFU/MOFU/BOFU", "external_copy": "optional"},
    ]
