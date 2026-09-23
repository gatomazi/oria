"""Product Enrichment (Fase F.1) — a PROPOSAL about a product's `semantic_context`, never applied
automatically. Three pure functions:

    propose(product, brand=None, niche=None, provider="fake", now=None)
        -> a validated EnrichmentProposal (dict). The only provider implemented in this phase is
           "fake": a deterministic, keyword-based heuristic over the product's OWN text — never a
           real model call, never a network call, never a cost. See _FakeProvider below for exactly
           what it does and does not infer.

    snapshot_hash(product) -> str
        Hash of the product fields a proposal was made FROM (name/type/description/metadata).
        The caller (the panel) re-hashes the CURRENT product before merging an approval; a mismatch
        means the product changed since the proposal and the merge must be refused (§4 of the
        brief — "exigir revalidação/revisão, sem aprovação silenciosa"), never silently re-based.

    merge(current, proposed, accepted_fields) -> merged ProductSemanticContext (dict)
        Field-by-field: only fields the caller explicitly listed in `accepted_fields` come from
        `proposed`; everything else keeps whatever `current` already had (a prior manual value, a
        prior enrichment, or nothing). This is the "preservar campos manuais não autorizados para
        substituição" rule, enforced structurally: a field CANNOT end up overwritten unless the
        caller named it.

Product text (name/type/description/metadata) is treated as untrusted data throughout: the fake
provider only matches it against a closed keyword vocabulary, never interprets it as instructions,
and whatever it (or, later, a real provider) proposes is re-validated against ProductSemanticContext/
EnrichmentProposal before being handed back — a provider bug can't smuggle an oversized or
wrongly-shaped value past `contracts.ensure_valid`. No provider here ever reads or writes brand/store
secrets, safety policy, or tenancy — those stay entirely the caller's concern, as everywhere else in
the core.
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone

from . import composition as comp
from . import contracts

# ------------------------------------------------------------------ snapshot hash (freshness check)
# Only the fields a proposal is actually MADE FROM — not created_at/id/references (a new reference
# photo doesn't change what the text says, and a proposal is about the text+existing metadata, not
# about pixels the fake provider never looks at).
_SNAPSHOT_FIELDS = ("name", "type", "description", "metadata")


def snapshot_hash(product: dict) -> str:
    payload = {k: product.get(k) for k in _SNAPSHOT_FIELDS}
    blob = json.dumps(payload, sort_keys=True, ensure_ascii=True, default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


# ------------------------------------------------------------------ the fake provider
# Closed vocabulary, folded (no accent/case) — same technique as composition.fold/words. A word not
# in this list contributes NOTHING: it is never echoed back, never used as a label, never treated as
# an instruction. This is deliberately narrow; see the module docstring for why.
_RELATION_WORDS = {
    "pai": "father", "mae": "mother", "filho": "son", "filha": "daughter",
    "avo": "grandparent", "irma": "sibling", "irmao": "sibling",
    "amigo": "friend", "amiga": "friend", "namorado": "partner", "namorada": "partner",
}
_ADULT_RELATIONS = {"father", "mother", "grandparent", "partner"}
_CHILD_RELATIONS = {"son", "daughter"}
# Age-group words that are NOT relation words on their own (a product can say "infantil" without
# naming any specific relation) — kept separate so "child" is never inferred from a relation word
# alone (e.g. "pai" alone never implies "there is also a child"; that would be inventing a person
# the text never mentioned).
_CHILD_SIGNAL_WORDS = {"crianca", "criancas", "infantil", "kids"}
_ADULT_SIGNAL_WORDS = {"adulto", "adultos"}
# folded product word -> composition.INTERACTIONS id (only ids that actually exist in the catalog).
_ACTIVITY_WORDS = {
    "brincar": "playing", "brincando": "playing",
    "presente": "gifting", "presentear": "gifting", "presenteando": "gifting",
    "ler": "reading_together", "leitura": "reading_together", "lendo": "reading_together",
    "cozinhar": "cooking", "cozinhando": "cooking",
    "conversa": "talking", "conversando": "talking",
    "caminhada": "walking", "caminhar": "walking", "caminhando": "walking",
    "abraco": "hugging", "abracar": "hugging", "abracando": "hugging",
}
_KNOWN_INTERACTIONS = frozenset(comp.INTERACTIONS.keys())


class _FakeProvider:
    """Deterministic, no network, no cost, no randomness — same input always yields the same
    proposal (a real requirement for reproducible tests, not just a nicety)."""

    name = "fake"

    def propose(self, product: dict, brand: dict | None, niche: dict | None) -> dict:
        text = " ".join(str(product.get(k) or "") for k in ("name", "type", "description"))
        tokens = set(comp.words(text))

        relations_found = sorted({_RELATION_WORDS[t] for t in tokens if t in _RELATION_WORDS})
        activities_found = sorted({_ACTIVITY_WORDS[t] for t in tokens if t in _ACTIVITY_WORDS})

        wearer_roles: list[str] = []
        if any(r in _ADULT_RELATIONS for r in relations_found) or (tokens & _ADULT_SIGNAL_WORDS):
            wearer_roles.append("adult")
        if any(r in _CHILD_RELATIONS for r in relations_found) or (tokens & _CHILD_SIGNAL_WORDS):
            wearer_roles.append("child")

        relationship_themes: list[str] = []
        parent_word = {"father", "mother"} & set(relations_found)
        child_present = ({"son", "daughter"} & set(relations_found)) or (tokens & _CHILD_SIGNAL_WORDS)
        if parent_word and child_present:
            relationship_themes.append("family")
        elif "friend" in relations_found:
            relationship_themes.append("friendship")
        elif "partner" in relations_found:
            relationship_themes.append("romantic")

        recommended_supporting_roles = [r for r in relations_found]

        scene_intents = list(activities_found)

        field_notes: dict[str, dict] = {}
        for field, found in (
            ("wearer_roles", wearer_roles), ("relationship_themes", relationship_themes),
            ("recommended_supporting_roles", recommended_supporting_roles), ("scene_intents", scene_intents),
        ):
            if found:
                field_notes[field] = {
                    "justification": f"palavras-chave no texto do produto: {', '.join(sorted(tokens & set(_RELATION_WORDS) | (tokens & set(_ACTIVITY_WORDS))))[:200]}",
                    "source": "heuristic_fake",
                }

        has_signal = bool(wearer_roles or relationship_themes or activities_found)
        confidence = 0.6 if has_signal else 0.1

        recommended_angle_families: list[str] = []
        if relationship_themes:
            recommended_angle_families.append("connection")
        elif not has_signal:
            recommended_angle_families = []  # no invented family — §2 of the brief, verbatim

        proposed = {
            "wearer_roles": wearer_roles,
            "relationship_themes": relationship_themes,
            "recommended_supporting_roles": recommended_supporting_roles,
            "incompatible_auto_supporting_roles": [],
            "scene_intents": scene_intents,
            # visible_text: the fake provider never reads pixels — only ever proposed from metadata
            # that already CLAIMS to be a transcription, never guessed from the name/description.
            "visible_text": _visible_text_from_metadata(product),
            "source": "enrichment",
            "confidence": confidence,
        }
        return {
            "proposed": proposed,
            "recommended_angle_families": recommended_angle_families,
            "recommended_interactions": [a for a in activities_found if a in _KNOWN_INTERACTIONS],
            "field_notes": field_notes,
        }


def _visible_text_from_metadata(product: dict) -> list[str]:
    metadata = product.get("metadata") or {}
    declared = metadata.get("visible_text_transcript")
    if isinstance(declared, list) and all(isinstance(x, str) for x in declared):
        return declared[:10]
    return []


_PROVIDERS = {"fake": _FakeProvider()}


def propose(product: dict, *, brand: dict | None = None, niche: dict | None = None,
            provider: str = "fake", now: datetime | None = None) -> dict:
    """Builds and validates an EnrichmentProposal for ONE product. Raises GenerationError
    (INVALID_INPUT) if the provider somehow produced something that doesn't fit the contract —
    this is the "estritamente validado no core" gate the brief asks for; it never trusts a
    provider's own idea of what it returned."""
    if provider not in _PROVIDERS:
        raise contracts.GenerationError("INVALID_INPUT", {"errors": [f"provider: unknown ({provider})"]})
    if not isinstance(product, dict) or not product.get("id"):
        raise contracts.GenerationError("INVALID_INPUT", {"errors": ["product: required"]})

    result = _PROVIDERS[provider].propose(product, brand, niche)
    contracts.ensure_valid("ProductSemanticContext", result["proposed"])

    envelope = {
        "id": f"enr_{snapshot_hash(product)[:16]}_{provider}",
        "product_id": product["id"],
        "schema_version": 1,
        "proposed": result["proposed"],
        "recommended_angle_families": result["recommended_angle_families"],
        "recommended_interactions": result["recommended_interactions"],
        "field_notes": result["field_notes"],
        "provider": provider,
        "product_snapshot_hash": snapshot_hash(product),
        "created_at": (now or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    return contracts.ensure_valid("EnrichmentProposal", envelope)


# ------------------------------------------------------------------ approval merge
_MERGEABLE_FIELDS = (
    "wearer_roles", "relationship_themes", "recommended_supporting_roles",
    "incompatible_auto_supporting_roles", "scene_intents", "visible_text",
)


def merge(current: dict | None, proposed: dict, accepted_fields: list[str]) -> dict:
    """Field-by-field merge: ONLY `accepted_fields` come from `proposed`; everything else keeps
    `current` untouched (a prior manual value, a prior enrichment, or absence). `source`/
    `confidence` always come from the proposal when ANY field was accepted (the merged object IS
    an enrichment result at that point) — with zero fields accepted, `current` is returned as-is,
    unchanged, not even re-serialized (an explicit no-op, not a same-value overwrite)."""
    unknown = [f for f in accepted_fields if f not in _MERGEABLE_FIELDS]
    if unknown:
        raise contracts.GenerationError("INVALID_INPUT", {"errors": [f"accepted_fields: campo desconhecido: {f}" for f in unknown]})
    if not accepted_fields:
        return dict(current or {})
    merged = dict(current or {})
    for field in accepted_fields:
        merged[field] = proposed.get(field, [])
    merged["source"] = "enrichment"
    merged["confidence"] = proposed.get("confidence")
    contracts.ensure_valid("ProductSemanticContext", merged)
    return merged
