"""PROMPT_VERSION=2 — scene contracts for the angles that put people in the frame.

v1 stays the default and is frozen (golden hashes in tests/golden). v2 is opt-in and changes ONLY four
angles (LIFESTYLE_COTIDIANO, CAIMENTO, CREATOR_STYLE, PRESENTE_AFETO), and only in CLEAN_ANGLES / FUNNEL_VISUAL
plans that have people in the frame: their angle block and their persona block (plus, for a gift scene, the
infant-garment wording in core_rules). Everything else in the prompt, every other angle, REMARKETING and
person-less plans are byte-identical to v1, and the plan reports the version it really used.

What v2 does instead of adding "no extra fingers" text:
  * one action per scene, chosen in the plan (deterministically, from the seed) rather than left to the model;
  * where the arms and hands are, stated as what is visible (relaxed at the sides, one hand on X), not as a ban;
  * every person in the frame has a role — no template mentions "two people" and leaves one implicit;
  * the persona refines WHO the person is; the angle decides pose, action and framing (precedence stated), and a
    persona behavior that directly contradicts the angle is filtered out at compile time (compatible_behavior).

Pure and deterministic: no randomness, no I/O beyond loading the template file once.
"""
from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from pathlib import Path

from .context_intelligence import deterministic_pick

_PATH = Path(__file__).parent / "templates" / "angles_v2.json"
with open(_PATH, encoding="utf-8") as _f:
    _V2: dict = json.load(_f)

ANGLES: dict = _V2["angles"]
PERSONA: dict = _V2["persona"]
PROMPT_V2_ANGLES = frozenset(ANGLES)
GIFT_ANGLE = "PRESENTE_AFETO"

# v1's infant-garment rule says "O MODELO da cena é SEMPRE uma criança". In a gift scene with a child and an
# adult that contradicts the cast, so v2 narrows it to the person who wears the piece.
_MODEL_RULE = "O MODELO da cena é SEMPRE"
_WEARER_RULE = "Quem VESTE a peça é SEMPRE"


def _pick(options: list, seed: int, angle_id: str, pool: str) -> str:
    """Stable per (seed, angle, pool): two pools of the same plan do not move in lockstep."""
    salt = int(hashlib.sha256(f"{seed}:{angle_id}:{pool}".encode()).hexdigest()[:8], 16)
    return deterministic_pick(options, salt)


def choose_picks(angle_id: str, seed: int) -> dict:
    """The pool entries the plan picks for this angle: {pool: {"index", "text"}}. Same choice `angle_block` makes
    from the seed, but made visible so a v2 plan can store it — the image model never picks the action/format,
    and the compiler does not need the seed to reproduce the prompt."""
    picks = {}
    for name, options in ANGLES[angle_id].get("pools", {}).items():
        text = _pick(options, seed, angle_id, name)
        picks[name] = {"index": options.index(text), "text": text}
    return picks


# In REMARKETING the layout owns the composition (how many people, where), and a v2 scene that also declares its
# own cast would contradict it. v2 therefore only applies where the angle owns the scene.
V2_STRATEGIES = frozenset({"CLEAN_ANGLES", "FUNNEL_VISUAL"})


def resolve_prompt_version(requested: int | None, default: int, angle_id: str, people_needed: int, strategy: str) -> int:
    """The version actually applied. v2 only rewrites person scenes: an angle outside the v2 set, a strategy whose
    layout owns the scene, or a plan with nobody in the frame keeps its v1 prompt and reports 1."""
    version = default if requested is None else requested
    applies = angle_id in PROMPT_V2_ANGLES and strategy in V2_STRATEGIES and people_needed > 0
    return 2 if version == 2 and applies else 1


def people_needed(angle_id: str, product_count: int, v1_people: int) -> int:
    """People the v2 scene needs. Only the gift angle differs from v1: a single product is handed over between
    exactly two people, and a multi-product gift is a kit with nobody in the frame."""
    if angle_id != GIFT_ANGLE:
        return v1_people
    return 0 if product_count > 1 else 2


def narrow_model_rule(core_rules: str, angle_id: str, product_count: int) -> str:
    return core_rules.replace(_MODEL_RULE, _WEARER_RULE) if angle_id == GIFT_ANGLE and product_count == 1 else core_rules


def _label(person: dict | None, fallback: str) -> str:
    return person["label"] if person else fallback


def angle_block(
    angle_id: str, *, product: str, products: str, count: int, scene: str, apparel: bool, seed: int,
    persona: dict | None, people: list, picks: dict | None = None,
) -> str:
    spec = ANGLES[angle_id]
    multi = count > 1
    template = spec["scene_multi"] if multi else spec["scene"]
    variables = {
        "produto": product,
        "produtos": products,
        "n": count,
        "cenario": scene,
        "uso": "vestindo" if apparel else "usando",
        "persona": _label(persona, "uma pessoa"),
        "pessoa_a": _label(people[0] if people else persona, "uma pessoa"),
        "pessoa_b": _label(people[1] if len(people) > 1 else None, "uma segunda pessoa"),
        "pessoas": f"{len(people) or count} pessoas diferentes (" + "; ".join(p["label"] for p in people) + ")"
        if people else f"{count} pessoas diferentes",
    }
    # Pools render in file order, so a later pool (formato) can use an earlier pick (celular).
    chosen = picks if picks is not None else choose_picks(angle_id, seed)
    for name in spec.get("pools", {}):
        variables[name] = chosen[name]["text"].format(**variables)
    return template.format(**variables)


def _fold(text: str) -> str:
    """Lowercase without accents, so 'Dança' and 'danca' match the same drop term."""
    return "".join(c for c in unicodedata.normalize("NFKD", text.lower()) if not unicodedata.combining(c))


def compatible_behavior(angle_id: str, behavior: str) -> str:
    """The persona behavior clauses that do not contradict the angle.

    The persona complements the angle only with compatible attributes. A clause that directly contradicts an
    explicit instruction of the angle ('em movimento' under CAIMENTO, which asks for a still person) is dropped
    here, at compile time — not stated with an "only if it does not contradict" caveat. The behavior is split
    into its comma/semicolon clauses and each is tested against the angle's `behavior_drop` terms (accent-
    insensitive, matched at the start of a word: 'caminh' drops 'caminhando' but 'corre' does not touch 'correto').
    Returns "" when nothing compatible is left."""
    terms = [_fold(t) for t in ANGLES[angle_id].get("behavior_drop", [])]
    if not terms:
        return behavior.strip()
    conflict = re.compile(r"(?<!\w)(?:" + "|".join(re.escape(t) for t in terms) + ")")
    kept = [c.strip() for c in re.split(r"[;,]", behavior) if c.strip() and not conflict.search(_fold(c))]
    return ", ".join(kept)


def _identity_and_behavior(angle_id: str, person: dict, describe_identity) -> tuple[str, str]:
    return describe_identity(person), compatible_behavior(angle_id, person.get("behavior") or "")


def persona_block(angle_id: str, count: int, persona: dict | None, people: list, describe_identity) -> str:
    """Persona text for a v2 scene. `describe_identity` renders label/appearance/style/notes WITHOUT behavior:
    behavior is stated as conditional on the pose the angle asks for."""
    if angle_id == GIFT_ANGLE and count > 1:
        return ""  # kit: nobody in the frame
    if len(people) > 1:
        head = PERSONA["pair"] if angle_id == GIFT_ANGLE else PERSONA["group"]
        lines = []
        for i, person in enumerate(people, 1):
            name = ("Pessoa A", "Pessoa B")[i - 1] if angle_id == GIFT_ANGLE and i <= 2 else f"Pessoa {i}"
            identity, behavior = _identity_and_behavior(angle_id, person, describe_identity)
            extra = PERSONA["behavior"].format(comportamento=behavior) if behavior else ""
            lines.append(f"  · {name}: {identity}.{extra}")
        return head + "\n" + "\n".join(lines)
    if persona:
        identity, behavior = _identity_and_behavior(angle_id, persona, describe_identity)
        extra = PERSONA["behavior"].format(comportamento=behavior) if behavior else ""
        return PERSONA["single"].format(identidade=identity, comportamento=extra)
    return ""
