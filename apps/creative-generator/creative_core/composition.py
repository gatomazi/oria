"""Subjects, relations and interactions (Fase C1): the composition of a scene as structured data.

Replaces the implicit "one persona plus a second person the template invents" with a list of subjects, each with
an age band, a relation to the primary subject, the product it wears (or none), and a prominence — plus an
interaction taken from a catalog (templates/interactions.json). All of it is plan data, resolved before compiling:
the compiler and the planner read it, nobody re-derives it from prompt text.

  * explicit_subjects      — what the request states (validated; ids, one primary, products, relations);
  * recommend              — what the planner proposes from the product's semantic_context when the request states
                             nothing (recommendations respect the semantics; nothing here ever blocks the user);
  * resolve_interaction    — explicit > recommended from the product's scene intents > a default for groups;
  * age / relation helpers — explicit age band first, the text heuristic only as a fallback.

Pure and deterministic. Catalog and vocabulary are data; there are no per-interaction `if` chains.
"""
from __future__ import annotations

import json
import re
import unicodedata
from pathlib import Path

from .contracts import MAX_SUBJECTS, RELATION_TYPES
from .errors import GenerationError
from .products import garment_for_type

_TEMPLATES = Path(__file__).parent / "templates"
with open(_TEMPLATES / "planner_v2.json", encoding="utf-8") as _f:
    DATA: dict = json.load(_f)
with open(_TEMPLATES / "interactions.json", encoding="utf-8") as _f:
    CATALOG: dict = json.load(_f)

INTERACTIONS: dict = CATALOG["interactions"]
MINOR_BANDS = frozenset(DATA["minor"]["minor_bands"])
ADULT_BANDS = frozenset(DATA["minor"]["adult_bands"])
_AGE_RE = re.compile(r"(\d{1,2})\s*anos?")
_RANGE_RE = re.compile(r"(\d{1,2})\s*[-–a]\s*(\d{1,2})")


def fold(text: str) -> str:
    """Lowercase without accents, so 'Mãe' and 'mae' are the same word."""
    return "".join(c for c in unicodedata.normalize("NFKD", text.lower()) if not unicodedata.combining(c))


def words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", fold(text))


# ------------------------------------------------------------------ age
def band_for_years(years: int) -> str:
    for band, (low, high) in DATA["minor"]["bands"].items():
        if low <= years <= high:
            return band
    return "unknown"


def is_minor_band(band: str) -> bool:
    return band in MINOR_BANDS


def detect_age(persona: dict | None) -> tuple[str, str | None]:
    """(age_band, source). Preference: the persona's structured `age_band`, then a number of years in the label, then
    `age_range`, then words. The text heuristics are the FALLBACK for personas that carry no structured age; an
    explicit Subject age band is applied before this function is called. Unknown is not a minor."""
    if not persona:
        return "unknown", None
    if persona.get("age_band") and persona["age_band"] != "unknown":
        return persona["age_band"], "persona.age_band"
    label = persona.get("label") or ""
    match = _AGE_RE.search(fold(label))
    if match:
        return band_for_years(int(match.group(1))), "persona.label"
    match = _RANGE_RE.search(persona.get("age_range") or "")
    if match:
        return band_for_years(int(match.group(2))), "persona.age_range"
    tokens = words(label)
    adult = {fold(w) for w in DATA["minor"]["adult_starts"]}
    if tokens and tokens[0] in adult:
        return "adult", "persona.label"
    minor = {fold(w) for w in DATA["minor"]["minor_words"]}
    if minor & set(tokens):
        return "child", "persona.label"
    return "unknown", None


def infant_product(product: dict) -> bool:
    text = fold(f"{product.get('type', '')}")
    return any(fold(w) in text for w in DATA["minor"]["infant_product_types"])


def infant_bands(product: dict) -> set[str]:
    """The age bands allowed to WEAR this infant garment (data: planner_v2.json minor.infant_wearer_bands)."""
    table = DATA["minor"]["infant_wearer_bands"]
    text = fold(f"{product.get('type', '')} {product.get('name', '')}")
    for key, bands in table.items():
        if key not in ("_doc", "default") and fold(key) in text:
            return set(bands)
    return set(table["default"])


# Who the planner (not the user) picked: it may be corrected. A person the user chose is never silently changed.
PLANNER_ORIGINS = frozenset({"planner_default", "brand", "niche", "product", "product_enrichment"})


def enforce_infant_wearers(subjects: list[dict], products: list, *, pool: list, seed: int) -> tuple[list[dict], list[str], dict | None]:
    """Whoever WEARS an infant garment must be a child in the garment's bands; adults in the scene are fine as long as
    they do not wear it. Returns (subjects, warnings, new primary persona or None).

    * a wearer the USER chose (explicit subject, custom persona) who does not fit -> error, no contradictory prompt;
    * a wearer the planner chose: the primary is recast from the pool (a child entry, else the neutral child persona),
      a supporting person simply stops wearing it;
    * an unknown age on a wearer of an infant garment is read as a child (from the product type)."""
    by_id = {p.get("id"): p for p in products}
    out: list[dict] = []
    warnings: list[str] = []
    recast: dict | None = None
    errors: list[str] = []
    for index, subject in enumerate(subjects):
        product = by_id.get(subject["product_id"]) if subject["product_use"] != "none" else None
        if not product or not infant_product(product):
            out.append(subject)
            continue
        allowed = infant_bands(product)
        band = subject["age_band"]
        if band == "unknown":
            band, source = "child", "product.type"
            if band not in allowed:
                band = sorted(allowed)[0]
            out.append(_subject(index, subject["persona"] or {"label": subject["label"]}, role=subject["role"], band=band,
                                age_source=source, relation=subject["relation_to_primary"], relation_label=subject["relation_label"],
                                product=product, prominence=subject["prominence"], source=subject["source"]))
            continue
        if band in allowed:
            out.append(subject)
            continue
        if subject["source"] not in PLANNER_ORIGINS:
            errors.append(f"subjects[{index}]: {product.get('name') or product.get('type')} is an infant garment and can only be worn by a child, "
                          f"but this subject is {band}; an adult may be in the scene as support without wearing it")
            out.append(subject)
            continue
        if subject["role"] == "primary":
            options = [person for person in pool if detect_age(person)[0] in allowed]
            fallbacks = DATA["roles"]["wearer_personas"]
            person = dict(options[seed % len(options)]) if options else dict(fallbacks["child" if "child_6_9" in allowed else "baby"])
            new_band, new_source = detect_age(person)
            recast = person
            warnings.append(f"infant_wearer_recast:{subject['id']}")
            out.append(_subject(index, person, role="primary", band=new_band, age_source=new_source, relation=None, relation_label=None,
                                product=product, prominence=subject["prominence"], source=subject["source"]))
        else:
            warnings.append(f"infant_wearer_removed:{subject['id']}")
            out.append(_subject(index, subject["persona"] or {"label": subject["label"]}, role=subject["role"], band=band,
                                age_source=subject["age_source"], relation=subject["relation_to_primary"], relation_label=subject["relation_label"],
                                product=None, prominence=subject["prominence"], source=subject["source"]))
    if errors:
        raise _err(errors)
    return out, warnings, recast


# ------------------------------------------------------------------ relations
def role_hint(label: str) -> str | None:
    """Role read from a persona label (mãe, pai, irmã, ...), or None. Whole words, accent-insensitive. Only used when
    no structured relation is given."""
    for word in words(label):
        for role, keywords in DATA["roles"]["keywords"].items():
            if word in keywords:
                return role
    return None


def relation_role(relation: str | None) -> str | None:
    """The role a relation stands for when matching against a product's semantic context (daughter/son -> child)."""
    return DATA["roles"]["relation_roles"].get(relation) if relation else None


# ------------------------------------------------------------------ interactions
def interaction_detail(interaction_id: str) -> dict:
    """The catalog entry as it is stored in the plan (self-sufficient: the plan recompiles without the catalog)."""
    spec = INTERACTIONS[interaction_id]
    return {"id": interaction_id, "catalog_version": CATALOG["version"], **{k: spec[k] for k in (
        "label", "min_people", "max_people", "excluded_bands", "contact", "hand_complexity", "object_use",
        "gaze_default", "pose_risk", "scene", "hands")}}


def _excluded(spec: dict, subjects: list) -> list[str]:
    excluded = set(spec["excluded_bands"])
    return sorted({s["age_band"] for s in subjects if s["age_band"] in excluded})


def resolve_interaction(requested: str | None, subjects: list, semantic: dict | None) -> tuple[str | None, str | None, list[str]]:
    """(interaction id, origin, warnings).

    Explicit: the caller's choice. The people count is a technical constraint (a hug needs two people): outside the
    entry's range it is an error. An age that does not suit the interaction is only a warning — the user decides.
    Otherwise, for two or more people: the first scene intent of the product whose interaction fits (origin: the
    product / its enrichment), then the catalog's group default (origin: planner_default). One person: none."""
    count = len(subjects)
    if requested:
        spec = INTERACTIONS.get(requested)
        if spec is None:
            raise GenerationError("INVALID_INPUT", {"errors": [f"interaction: unknown id {requested!r}"]})
        if not spec["min_people"] <= count <= spec["max_people"]:
            raise GenerationError("INTERACTION_INCOMPATIBLE", {
                "interaction": requested, "people": count, "min_people": spec["min_people"], "max_people": spec["max_people"]})
        return requested, "user", [f"interaction_age_mismatch:{requested}:{band}" for band in _excluded(spec, subjects)]
    if count < 2:
        return None, None, []
    origin = None if not semantic else ("product_enrichment" if semantic.get("source") == "enrichment" else "product")
    for intent in (semantic or {}).get("scene_intents") or []:
        candidate = CATALOG["intent_map"].get(intent)
        spec = INTERACTIONS.get(candidate or "")
        if spec and spec["min_people"] <= count <= spec["max_people"] and not _excluded(spec, subjects):
            return candidate, origin, []
    return CATALOG["default_for_group"], "planner_default", []


# ------------------------------------------------------------------ explicit subjects
def _err(errors: list[str]) -> GenerationError:
    return GenerationError("INVALID_INPUT", {"errors": errors[:20]})


def _use_for(product: dict) -> str:
    return "wears" if garment_for_type(product.get("type", "")) else "uses"


def _subject(index: int, person: dict, *, role: str, band: str, age_source: str | None, relation: str | None,
             relation_label: str | None, product: dict | None, prominence: str, source: str) -> dict:
    minor = is_minor_band(band)
    return {
        "id": f"s{index + 1}", "role": role, "label": person.get("label") or "uma pessoa",
        "persona": dict(person) if person.get("label") else None,
        "age_band": band, "is_minor": minor, "age_source": age_source, "minor_source": age_source if minor else None,
        "product_use": _use_for(product) if product else "none", "product_id": product.get("id") if product else None,
        "role_hint": relation_role(relation) or role_hint(person.get("label") or ""),
        "relation_to_primary": relation, "relation_label": relation_label,
        "prominence": prominence, "source": source,
    }


def explicit_subjects(request_subjects: list, products: list) -> list[dict]:
    """Subjects as the request states them. Validates ids, exactly one primary, the products worn and the relations.
    Never validates against the product's semantics: a contradicting choice is allowed and only warned about later."""
    errors: list[str] = []
    if len(request_subjects) > MAX_SUBJECTS:
        raise _err([f"subjects: at most {MAX_SUBJECTS} people"])
    ids = [s.get("id") for s in request_subjects if s.get("id")]
    if len(set(ids)) != len(ids):
        errors.append("subjects: duplicate id")
    primaries = [i for i, s in enumerate(request_subjects) if s.get("role") == "primary"]
    if len(primaries) > 1:
        errors.append("subjects: only one primary subject")
    if errors:
        raise _err(errors)
    # The primary first; everything else keeps the caller's order.
    order = ([primaries[0]] if primaries else [0]) + [i for i in range(len(request_subjects)) if i != (primaries[0] if primaries else 0)]
    by_id = {p["id"]: p for p in products}
    subjects: list[dict] = []
    for position, index in enumerate(order):
        rs = request_subjects[index]
        path = f"subjects[{index}]"
        is_primary = position == 0
        relation, label = rs.get("relation_to_primary"), rs.get("relation_label")
        if is_primary and relation:
            errors.append(f"{path}.relation_to_primary: the primary subject has no relation to itself")
        if relation == "custom" and not label:
            errors.append(f"{path}.relation_label: required for a custom relation")
        if "wears_product_id" in rs:
            pid = rs["wears_product_id"]
            if pid is not None and pid not in by_id:
                errors.append(f"{path}.wears_product_id: not one of the plan's products")
            product = by_id.get(pid) if pid is not None else None
        elif is_primary:
            product = products[0]
        else:  # multi-product: the i-th person gets the i-th product; single product: only the primary wears it
            product = products[position] if len(products) > 1 and position < len(products) else None
        persona = rs["persona"]
        if rs.get("age_band") and rs["age_band"] != "unknown":
            band, age_source = rs["age_band"], "subject.age_band"
        else:
            band, age_source = detect_age(persona)
            if band == "unknown" and product and infant_product(product):
                band, age_source = "child", "product.type"
        subjects.append(_subject(position, persona, role="primary" if is_primary else "supporting", band=band,
                                 age_source=age_source, relation=None if is_primary else relation,
                                 relation_label=None if is_primary else label, product=product,
                                 prominence=rs.get("prominence") or ("hero" if is_primary else "secondary"), source="user"))
    if errors:
        raise _err(errors)
    # A subject the request says wears an infant garment must be a child (checked per subject and per product, so a
    # multi-product cast is validated garment by garment). The error names the subject; no contradictory prompt is built.
    subjects, _warnings, _recast = enforce_infant_wearers(subjects, products, pool=[], seed=0)
    return subjects


# ------------------------------------------------------------------ recommended composition
def _fit(band: str, wearer_roles: list) -> bool | None:
    """Does the primary's age fit the product's wearer roles? None when either is unknown."""
    if band == "unknown" or not wearer_roles:
        return None
    expected = set()
    for role in wearer_roles:
        expected |= {"child": {"child", "child_3_5", "child_6_9", "child_10_12"}, "baby": {"baby"}, "teen": {"teen"},
                     "adult": ADULT_BANDS}.get(role, set())
    return band in expected if expected else None


def wearer_warnings(products: list, subjects: list) -> list[dict]:
    """The primary does not look like the product's wearer (a child print worn by an adult). Informative only."""
    if not subjects:
        return []
    out = []
    for product in products:
        roles = (product.get("semantic_context") or {}).get("wearer_roles") or []
        if _fit(subjects[0].get("age_band", "unknown"), roles) is False:
            out.append({"code": "wearer_role_mismatch", "theme": None, "supporting_role": None,
                        "product_id": product.get("id"), "expected": roles[0], "actual": subjects[0].get("age_band")})
    return out


def recommend(*, angle_id: str, products: list, persona: dict | None, persona_is_custom: bool, pool: list, seed: int,
              persona_source: str) -> tuple[list[dict], dict] | None:
    """A composition proposed from the product's semantic_context, or None when there is nothing to propose.

    Only for a single product, only for angles that may take a supporting person, and only when the product names a
    supporting role we can cast. The primary is the persona the request resolved (a custom persona always stays:
    the user's choice); an automatic persona is replaced by the product's wearer role when it names one. The
    recommendation respects the semantics and is only a proposal: the request's own `subjects` always win."""
    limits = DATA["angle_people"].get(angle_id) or {}
    semantic = products[0].get("semantic_context") if len(products) == 1 else None
    if not semantic or not limits.get("recommend") or limits.get("max", 1) < 2:
        return None
    recommended = [r for r in semantic.get("recommended_supporting_roles") or [] if r in DATA["roles"]["person_labels"]]
    if not recommended:
        return None
    origin = "product_enrichment" if semantic.get("source") == "enrichment" else "product"
    wearer_role = (semantic.get("wearer_roles") or [None])[0]
    if not persona_is_custom and wearer_role in DATA["roles"]["wearer_personas"]:
        primary, primary_source = dict(DATA["roles"]["wearer_personas"][wearer_role]), origin
    else:
        primary, primary_source = dict(persona or {"label": "uma pessoa"}), persona_source
    role = recommended[0]
    candidates = [p for p in pool if p.get("label") != primary.get("label") and role_hint(p.get("label", "")) == role]
    supporting = candidates[seed % len(candidates)] if candidates else (
        {"label": DATA["roles"]["person_labels"][role], "source": "automatic"} if role in DATA["roles"]["person_labels"] else None)
    if supporting is None:
        return None
    product = products[0]
    p_band, p_src = (primary.get("age_band"), "persona.age_band") if primary.get("age_band") else detect_age(primary)
    if p_band == "unknown" and infant_product(product):
        p_band, p_src = "child", "product.type"
    s_band, s_src = detect_age(supporting)
    if s_band == "unknown":  # a supporting role cast from the product is an adult unless the role says otherwise
        s_band, s_src = ("child", "planner_default") if role == "sibling" else ("adult", "planner_default")
    subjects = [
        _subject(0, primary, role="primary", band=p_band, age_source=p_src, relation=None, relation_label=None,
                 product=product, prominence="hero", source=primary_source),
        _subject(1, supporting, role="supporting", band=s_band, age_source=s_src,
                 relation=role if role in RELATION_TYPES else None, relation_label=None, product=None,
                 prominence="secondary", source=origin),
    ]
    return subjects, {"role": role, "source": "product", "matched_role": role, "recommended": True}
