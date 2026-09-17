"""Prompt Builder — modular composition of image prompts.

A prompt is an ordered list of named sections. The canonical order is the one
of the Etapa 1 spec (§24):

    core_rules -> strategy_rules -> brand_kit -> niche_kit -> context_profile ->
    product -> angle -> persona -> placement -> strategy_communication -> avoid

Builders keep the exact concatenation of each part (no separator is inserted
unless the caller adds it), so the internal strategies can migrate to the
builder without changing a single byte of their prompts. `sections()` exposes
the manifest (section name + length) that is stored in the CreativePlan.
"""
from __future__ import annotations

import hashlib

CANONICAL_ORDER = (
    "core_rules",
    "strategy_rules",
    "brand_kit",
    "niche_kit",
    "context_profile",
    "product",
    "angle",
    "persona",
    "placement",
    "strategy_communication",
    "avoid",
)


class PromptBuilder:
    """Collects named sections and renders them.

    `ordered=True` renders in CANONICAL_ORDER (unknown section names go last in
    insertion order); `ordered=False` keeps insertion order, which is what the
    internal strategies use to preserve their historical layout.
    """

    def __init__(self, *, ordered: bool = True, separator: str = ""):
        self._parts: list[tuple[str, str]] = []
        self._ordered = ordered
        self._separator = separator

    def add(self, name: str, text: str | None) -> "PromptBuilder":
        if text:
            self._parts.append((name, text))
        return self

    def _in_order(self) -> list[tuple[str, str]]:
        if not self._ordered:
            return list(self._parts)
        rank = {name: i for i, name in enumerate(CANONICAL_ORDER)}
        indexed = list(enumerate(self._parts))
        indexed.sort(key=lambda item: (rank.get(item[1][0], len(CANONICAL_ORDER)), item[0]))
        return [part for _, part in indexed]

    def build(self) -> str:
        return self._separator.join(text for _, text in self._in_order())

    def sections(self) -> list[dict]:
        return [{"name": name, "length": len(text)} for name, text in self._in_order()]

    def info(self, prompt_version: int) -> dict:
        text = self.build()
        return {
            "text": text,
            "sections": self.sections(),
            "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
            "prompt_version": prompt_version,
        }


def bullet_block(title: str, items: list | None, prefix: str = "  · ") -> str:
    items = [i for i in (items or []) if i]
    if not items:
        return ""
    return f"{title}\n" + "\n".join(f"{prefix}{i}" for i in items)
