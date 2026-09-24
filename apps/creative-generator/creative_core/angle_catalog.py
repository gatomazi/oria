"""Angles V2 (Fase D) — family/preset metadata layered on the 13 existing angle ids, and a pure
`recommend_angle` function.

This module changes NO prompt text and NO compiler output: `angle_descriptor`, `CORE_ANGLES` and the
compiler stay exactly as they were (V1 golden, 546 cases, is untouched). What it adds is additive
metadata (`family`, `preset`, `objective_hints`, scope) resolved from `templates/angle_catalog_v2.json`,
and a router — `recommend_angle` picks a FAMILY (+ an objective hint when needed to disambiguate), then
`canonical_legacy_angle_id` turns that back into the ONE legacy `angle_id` that actually drives
generation, so the existing engine needs no change at all to support `angle_id: "auto"`.

    resolve_angle_meta(angle_id, custom=None)   -> family/preset/scope/version/objective_hints for ANY
                                                    angle id — a legacy id (via alias), a system.* id, or
                                                    a custom organization/store angle (passed in, since
                                                    those live in the panel's database, not here)
    recommend_angle(inputs)                     -> AngleRecommendation (pure; no request/DB access)
    canonical_legacy_angle_id(family, hint)     -> the legacy angle_id recommend_angle ultimately routes to
"""
from __future__ import annotations

import json
from pathlib import Path

from .angles import angle_is_available

_PATH = Path(__file__).parent / "templates" / "angle_catalog_v2.json"
with open(_PATH, encoding="utf-8") as _f:
    _CATALOG: dict = json.load(_f)

FAMILIES: dict = _CATALOG["families"]
SYSTEM_ANGLES: dict = _CATALOG["angles"]
LEGACY_ALIASES: dict = _CATALOG["legacy_aliases"]
CANONICAL_LEGACY_FOR: dict = _CATALOG["canonical_legacy_for"]
DISCONTINUED_AS_TOP_LEVEL: frozenset = frozenset(_CATALOG["discontinued_as_top_level"]["ids"])
FAMILY_IDS = tuple(k for k in FAMILIES if k != "_doc")

# Interactions this module treats as "gifting-flavored" for recommend_angle's connection routing.
_GIFTING_INTERACTIONS = frozenset({"gifting"})
# Interactions that read as a shared/bonding moment between two or more people (connection family).
_BONDING_INTERACTIONS = frozenset({
    "reading_together", "playing", "hugging", "cooking", "doing_activity", "talking", "walking",
    "looking_at_each_other", "candid", "group_photo",
})


def resolve_angle_meta(angle_id: str, custom: dict | None = None) -> dict:
    """Family/preset/scope/version/objective_hints for ANY angle id. `custom` is an organization/store
    angle record (the panel reads it from `creative_angles`); this module never touches the database."""
    if custom is not None:
        return {
            "id": angle_id, "family": custom["family"], "name": custom.get("name", angle_id),
            "scope": custom["scope"], "preset": custom.get("preset"),
            "objective_hints": list(custom.get("objective_hints") or []), "version": custom.get("version", 1),
        }
    if angle_id in SYSTEM_ANGLES:
        spec = SYSTEM_ANGLES[angle_id]
        return {"id": angle_id, "family": spec["family"], "name": spec["name"], "scope": "system",
                "preset": spec.get("preset"), "objective_hints": list(spec.get("objective_hints") or []),
                "version": spec["version"]}
    alias = LEGACY_ALIASES.get(angle_id)
    if alias is None:
        return {"id": angle_id, "family": None, "name": angle_id, "scope": "system", "preset": None,
                "objective_hints": [], "version": 1}
    system_spec = SYSTEM_ANGLES[alias["angle_id"]]
    return {"id": angle_id, "family": system_spec["family"], "name": system_spec["name"], "scope": "system",
            "preset": system_spec.get("preset"), "objective_hints": list(alias.get("objective_hints") or []),
            "version": system_spec["version"]}


def canonical_legacy_angle_id(family: str, objective_hint: str | None = None) -> str | None:
    """The one legacy angle_id a family (+ optional disambiguating hint) routes to. None for a family
    with no legacy mapping (`action_movement`, still reserved and empty — see the catalog's own doc)."""
    routing = CANONICAL_LEGACY_FOR.get(family)
    if routing is None:
        return None
    if objective_hint and objective_hint in routing.get("by_hint", {}):
        return routing["by_hint"][objective_hint]
    return routing["default"]


def _people_count(inputs: dict) -> int:
    subjects = inputs.get("subjects")
    if subjects:
        return len(subjects)
    if inputs.get("persona_mode") == "none":
        return 0
    return int(inputs.get("people_count_hint") or 1)


def _semantic_of(inputs: dict) -> dict | None:
    for product in inputs.get("products") or []:
        semantic = product.get("semantic_context")
        if semantic:
            return semantic
    return None


# Achado real (primeiro uso, conta interna): a escolha abaixo nunca soube de `enabledAngles`/
# `supportsApparelAngles` — podia recomendar (e só depois `plan_creative` recusar) um ângulo que o
# próprio motor considera indisponível para a marca. Cada caso agora tem uma cadeia de alternativas —
# a preferida primeiro, depois variações razoáveis dentro da mesma leitura do pedido (nunca uma família
# que contradiga o sinal, como "sem pessoa" cair para uma família com pessoa) — e usa a PRIMEIRA
# (family, hint) cujo ângulo legado é realmente disponível para esta marca/nicho. Sem `brand`/`niche`
# (chamadas antigas, ou pureza total quando não há contexto de marca a checar), usa sempre a primeira
# da cadeia, igual ao comportamento anterior.
_FALLBACKS: dict[str, list[tuple[str, str | None]]] = {
    "no_person": [("product_no_person", None), ("product_no_person", "hanging"), ("product_no_person", "editorial_still")],
    "gifting": [("connection", "gifting"), ("connection", None), ("lifestyle", None)],
    "connection": [("connection", None), ("lifestyle", None)],
    "lifestyle": [("lifestyle", None), ("lifestyle", "brand_identity"), ("connection", None)],
    "creator": [("creator_social", None), ("lifestyle", None), ("editorial_portrait", None)],
    "single_default": [("editorial_portrait", None), ("editorial_portrait", "reflective"), ("lifestyle", None)],
}


def recommend_angle(inputs: dict, *, brand: dict | None = None, niche: dict | None = None) -> dict:
    """Pure recommendation from what the request already states — never a provider call, never feedback
    (Gostei/Não gostei is not read here; see docs/features/creative-generator-fase-d.md §7).

    Reads (all optional, all already in a CreativeRequest-shaped dict): `subjects`, `interaction`,
    `persona_mode`, `people_count_hint` (used only when there are no subjects and persona_mode is not
    'none' — a rough single/multi guess before subjects exist), `products` (for `semantic_context`),
    `intent_hint` (explicit seam for a future GPT-authored brief — see §5; today only a plain string like
    "creator" a caller may pass, never inferred).

    `brand`/`niche`: optional, so a caller with no kit context still gets the pure, deterministic pick
    (same as before this fix). When given, the picked family/preset is checked against
    `angles.angle_is_available` — falling through `_FALLBACKS[case]` in order — before being returned, so
    this never hands back something `plan_creative` would immediately reject as UNSUPPORTED_ANGLE for a
    reason this function could see for itself. The chain never crosses into a family that contradicts the
    request's own signal (e.g. "no person requested" never falls back to a family with a person) — if
    every candidate in the chain is unavailable, `angle_id` comes back `None` with `reason` explaining
    exactly what was tried and rejected, never a silent/invented pick and never a bypassed restriction.

    Returns `{angle_id (family scoped, e.g. "family:connection"), family, preset, objective_hints, reason,
    source}` — `source` is always "planner_default" here; the caller sets "user" when the request named an
    angle_id explicitly instead of "auto" (recommend_angle is never called in that case)."""
    reasons: list[str] = []
    count = _people_count(inputs)
    interaction = inputs.get("interaction")
    semantic = _semantic_of(inputs)

    if count == 0:
        reasons.append("no_person_requested")
        case = "no_person"
    elif interaction in _GIFTING_INTERACTIONS:
        reasons.append(f"interaction:{interaction}")
        case = "gifting"
    elif count >= 2 and (interaction in _BONDING_INTERACTIONS or (semantic and semantic.get("relationship_themes"))):
        if interaction:
            reasons.append(f"interaction:{interaction}")
        if semantic and semantic.get("relationship_themes"):
            reasons.append(f"relationship_theme:{semantic['relationship_themes'][0]}")
        reasons.append(f"people_count:{count}")
        case = "connection"
    elif count >= 2:
        reasons.append(f"people_count:{count}")
        case = "lifestyle"
    elif inputs.get("intent_hint") == "creator":
        reasons.append("intent_hint:creator")
        case = "creator"
    else:
        reasons.append("single_person_default")
        case = "single_default"

    candidates = _FALLBACKS[case]
    family, hint = candidates[0]
    legacy_id = canonical_legacy_angle_id(family, hint)
    if brand is not None or niche is not None:
        tried: list[str] = []
        chosen = None
        for fam, hnt in candidates:
            lid = canonical_legacy_angle_id(fam, hnt)
            if lid and angle_is_available(lid, brand, niche):
                chosen = (fam, hnt, lid)
                break
            tried.append(lid or f"{fam}:{hnt}")
        if chosen:
            family, hint, legacy_id = chosen
            if (family, hint) != candidates[0]:
                reasons.append(f"brand_fallback:{family}:{hint}:tried={','.join(tried)}")
        else:
            # Toda a cadeia é indisponível para esta marca/nicho — nunca inventa pessoa nem remove a
            # restrição para "resolver" às escondidas; a tela mostra isso como recomendação vazia
            # (ver GerarTabV2 "Escolher o estilo manualmente") em vez de um 422 genérico.
            reasons.append(f"no_available_angle_for_brand:tried={','.join(tried)}")
            return {"angle_id": None, "family": family, "preset": None, "objective_hints": [], "reason": reasons, "source": "planner_default"}

    spec = SYSTEM_ANGLES[LEGACY_ALIASES[legacy_id]["angle_id"]] if legacy_id else None
    return {
        "angle_id": legacy_id, "family": family, "preset": spec.get("preset") if spec else None,
        "objective_hints": ([hint] if hint else (spec.get("objective_hints") if spec else [])) or [],
        "reason": reasons, "source": "planner_default",
    }
