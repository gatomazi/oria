"""Personas — automatic pools and custom personas.

The internal generator keeps its structured personas (config/personas_cena.json
+ organico/personas_cena.py in the generator app) untouched. The core contract is flatter:
label, age_range, appearance, style, behavior, notes, source.

Automatic persona = first non-recent persona of: Brand Kit suggestedPersonas >
Niche Kit suggestedPersonas > DEFAULT_PERSONAS, rotated by seed.
"""
from __future__ import annotations

from .contracts import ensure_valid

DEFAULT_PERSONAS = (
    {"id": "default_adult_f", "label": "Mulher 30-40 anos, estilo casual", "age_range": "30-40",
     "appearance": "aparência natural, cabelo preso", "style": "casual contemporâneo",
     "behavior": "gestos naturais", "source": "automatic"},
    {"id": "default_adult_m", "label": "Homem 30-40 anos, estilo casual", "age_range": "30-40",
     "appearance": "aparência natural, cabelo curto", "style": "casual contemporâneo",
     "behavior": "postura relaxada", "source": "automatic"},
)


def persona_pool(brand_kit: dict | None, niche_kit: dict | None) -> list[dict]:
    return list((brand_kit or {}).get("suggestedPersonas") or (niche_kit or {}).get("suggestedPersonas") or DEFAULT_PERSONAS)


def resolve_persona(mode: str, persona: dict | None, *, brand_kit: dict, niche_kit: dict, seed: int,
                    recent_labels: list | None = None, uses_person: bool = True) -> dict | None:
    if not uses_person or mode == "none":
        return None
    if mode == "custom":
        custom = ensure_valid("Persona", dict(persona or {}))
        return {**custom, "source": "custom"}
    pool = persona_pool(brand_kit, niche_kit)
    recent = set(recent_labels or [])
    fresh = [p for p in pool if p["label"] not in recent] or pool
    return dict(fresh[seed % len(fresh)])


def describe(persona: dict) -> str:
    parts = [persona["label"]]
    for key in ("appearance", "style", "behavior", "notes"):
        if persona.get(key):
            parts.append(persona[key])
    return "; ".join(parts)
