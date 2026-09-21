"""CreativePlan v2 planner (Fase B): what the image model used to decide by itself becomes plan data.

Each decision here is a field of the plan with its origin, resolved BEFORE the prompt is compiled:

  * gaze          — `auto` is resolved to a concrete mode (camera / interaction / off_camera / product / none);
  * picks         — the pool entry (action, photo format, gift scenario) the scene uses;
  * subjects      — who is in the frame, derived from today's persona/people (Subjects proper is Fase C);
  * minor safety  — a GLOBAL layer (not configurable towards permissive) and a BRAND wardrobe layer (only adds);
  * semantics     — what the product means for the scene, used to cast the supporting person; a mismatch is a
                    warning, never a block;
  * provenance    — which source (user, product, brand, ...) gave each field.

Pure and deterministic: same inputs, same plan. No provider call, no randomness beyond the seed.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from .prompt_v2 import GIFT_ANGLE, _fold, choose_picks

_TEMPLATES = Path(__file__).parent / "templates"
with open(_TEMPLATES / "planner_v2.json", encoding="utf-8") as _f:
    DATA: dict = json.load(_f)
with open(_TEMPLATES / "minor_safety.json", encoding="utf-8") as _f:
    MINOR: dict = json.load(_f)

_AGE_RE = re.compile(r"(\d{1,2})\s*anos?")
_RANGE_RE = re.compile(r"(\d{1,2})\s*[-–a]\s*(\d{1,2})")
_OBJECTIVES = {"CLEAN_ANGLES": "clean_creative", "REMARKETING": "remarketing", "FUNNEL_VISUAL": "funnel_visual"}


def _rotate(options: list, seed: int):
    """Deterministic pick that also works for dicts (context_intelligence.deterministic_pick hashes its options)."""
    return options[seed % len(options)] if options else None


def _words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", _fold(text))


# ------------------------------------------------------------------ age / minors
def _band(years: int) -> str:
    for band, (low, high) in DATA["minor"]["bands"].items():
        if low <= years <= high:
            return band
    return "unknown"


def detect_age(persona: dict | None) -> tuple[str, str | None]:
    """(age_band, source). A number of years in the label wins, then age_range, then words. Unknown is not a minor."""
    if not persona:
        return "unknown", None
    label = persona.get("label") or ""
    match = _AGE_RE.search(_fold(label))
    if match:
        return _band(int(match.group(1))), "persona.label"
    age_range = persona.get("age_range") or ""
    match = _RANGE_RE.search(age_range)
    if match:
        return _band(int(match.group(2))), "persona.age_range"
    words = _words(label)
    adult = {_fold(w) for w in DATA["minor"]["adult_starts"]}
    if words and words[0] in adult:
        return "adult", "persona.label"
    minor = {_fold(w) for w in DATA["minor"]["minor_words"]}
    if minor & set(words):
        return "child", "persona.label"
    return "unknown", None


def infant_product(product: dict) -> bool:
    text = _fold(f"{product.get('type', '')}")
    return any(_fold(w) in text for w in DATA["minor"]["infant_product_types"])


def role_hint(label: str) -> str | None:
    """Role read from a persona label (mãe, pai, irmã, ...), or None. Whole words, accent-insensitive."""
    words = _words(label)
    for word in words:
        for role, keywords in DATA["roles"]["keywords"].items():
            if word in keywords:
                return role
    return None


# ------------------------------------------------------------------ subjects (legacy adapter, Fase C replaces it)
def derive_subjects(
    *, angle_id: str, products: list, persona: dict | None, people: list, people_needed: int, prompt_version: int,
    apparel: bool, picks: dict, persona_source: str, pool_source: str = "planner_default",
    supporting_source: str | None = None,
) -> list[dict]:
    """Who is in the frame, from what the v1 core already knows (persona + people). `relation_to_primary` and
    `interaction` are left null: they are the slots Fase C (Subjects/Relations) fills."""
    if people_needed <= 0:
        return []
    cast = list(people) if len(people) > 1 else [persona or {"label": "uma pessoa"}]
    gift = angle_id == GIFT_ANGLE and prompt_version == 2 and len(cast) == 2
    wears_index = 0 if not gift else (0 if picks.get("cena", {}).get("index") == 1 else None)
    use_verb = "wears" if apparel else "uses"
    subjects = []
    for i, person in enumerate(cast):
        band, source = detect_age(person)
        product = products[i] if len(products) > 1 and i < len(products) else products[0]
        uses = (i == wears_index) if gift else True
        if band == "unknown" and i == 0 and infant_product(products[0]) and uses:
            band, source = "child", "product.type"  # primary wearer of an infant garment is treated as a minor
        subjects.append({
            "id": f"s{i + 1}", "role": "primary" if i == 0 else "supporting",
            "label": person.get("label") or "uma pessoa", "persona": dict(person) if person.get("label") else None,
            "age_band": band, "is_minor": band in ("baby", "child", "teen"), "age_source": source,
            "minor_source": source if band in ("baby", "child", "teen") else None,
            "product_use": use_verb if uses else "none", "product_id": product.get("id") if uses else None,
            "role_hint": role_hint(person.get("label") or ""), "relation_to_primary": None,
            "prominence": "hero" if i == 0 else "secondary",
            # Each subject carries the origin of ITS OWN cast: the supporting person recast from the product's
            # semantics is `product`, not whatever gave the primary. The aggregate (`mixed`) is built from these.
            "source": persona_source if i == 0 else (supporting_source or pool_source),
        })
    return subjects


# ------------------------------------------------------------------ semantics / supporting person
def _semantic_of(products: list) -> dict | None:
    for product in products:
        semantic = product.get("semantic_context")
        if semantic:
            return semantic
    return None


def cast_supporting(*, people: list, pool: list, products: list, seed: int) -> tuple[list, dict | None]:
    """For a two-person scene, choose the supporting person with the product's semantics in mind.

    Automatic recommendations respect the semantics: a pool persona whose role is recommended wins; if none is in the
    pool, a person is cast from the recommended role; personas whose role is listed as incompatible are avoided when
    there is any alternative. Returns (people, info). Nothing here blocks: a mismatch is reported by `semantic_warnings`."""
    semantic = _semantic_of(products)
    if len(people) != 2 or not semantic:
        return people, None
    primary, current = people[0], people[1]
    recommended = list(semantic.get("recommended_supporting_roles") or [])
    incompatible = set(semantic.get("incompatible_auto_supporting_roles") or [])
    candidates = [p for p in pool if p.get("label") != primary.get("label")]
    matching = [p for p in candidates if role_hint(p.get("label", "")) in recommended]
    info = {"role": None, "source": "pool", "matched_role": None}
    if matching:
        chosen = _rotate(matching, seed)
        info.update(role=role_hint(chosen["label"]), source="product")
    elif recommended and recommended[0] in DATA["roles"]["labels"]:
        role = recommended[0]
        chosen = {"label": DATA["roles"]["labels"][role], "source": "automatic"}
        info.update(role=role, source="product")
    else:
        allowed = [p for p in candidates if role_hint(p.get("label", "")) not in incompatible] or candidates
        chosen = _rotate(allowed, seed) if allowed else current
        info.update(role=role_hint(chosen.get("label", "")), source="pool")
    info["matched_role"] = info["role"] if info["role"] in recommended else None
    return [primary, chosen], info


def semantic_warnings(products: list, subjects: list) -> list[dict]:
    """Informative warnings: the scene's supporting person contradicts the product's semantics. Never blocks."""
    out = []
    for product in products:
        semantic = product.get("semantic_context") or {}
        incompatible = set(semantic.get("incompatible_auto_supporting_roles") or [])
        themes = semantic.get("relationship_themes") or []
        for subject in subjects:
            if subject["role"] == "supporting" and subject.get("role_hint") in incompatible:
                out.append({"code": "semantic_mismatch", "theme": themes[0] if themes else None,
                            "supporting_role": subject["role_hint"], "product_id": product.get("id")})
    return out


# ------------------------------------------------------------------ gaze
def resolve_gaze(requested: str | None, angle_id: str, people_count: int, picks: dict) -> dict:
    """`auto` (or absent) becomes a concrete mode here — the compiler never sees `auto`."""
    requested = requested or "auto"
    if people_count == 0:
        return {"mode": "none", "requested": requested, "source": "angle", "reason": "no_people_in_frame"}
    if requested != "auto":
        return {"mode": requested, "requested": requested, "source": "user", "reason": "requested"}
    if people_count == 1:
        for pool, index_entry in picks.items():
            table = DATA["pool_gaze"].get(angle_id, {}).get(pool)
            if table:
                return {"mode": table[index_entry["index"]], "requested": "auto", "source": "angle",
                        "reason": f"pool:{pool}:{index_entry['index']}"}
    defaults = DATA["gaze_defaults"].get(angle_id)
    if defaults:
        key = "single" if people_count == 1 else "multi"
        return {"mode": defaults[key], "requested": "auto", "source": "angle", "reason": f"angle_default:{angle_id}:{key}"}
    mode = "interaction" if people_count > 1 else "off_camera"
    return {"mode": mode, "requested": "auto", "source": "planner_default", "reason": "generic_default"}


# ------------------------------------------------------------------ composition risk
def composition(angle_id: str, people_count: int, picks: dict) -> dict:
    weights = DATA["pose_risk"]
    score, reasons = 0, []
    if people_count >= 2:
        score += weights["people"][str(min(people_count, 4))]
        reasons.append(f"people:{people_count}")
    for pool, entry in picks.items():
        held = DATA["pool_held_objects"].get(angle_id, {}).get(pool)
        if held and held[entry["index"]]:
            score += weights["held_object"]
            reasons.append(f"held_object:{pool}")
        contact = DATA["pool_contact"].get(angle_id, {}).get(pool)
        if contact and contact[entry["index"]]:
            score += weights["contact"]
            reasons.append(f"contact:{pool}")
    levels = weights["levels"]
    level = "low" if score <= levels["low"] else "medium" if score <= levels["medium"] else "high"
    return {"people_count": people_count, "pose_risk": level, "risk_reasons": reasons}


# ------------------------------------------------------------------ minor safety
def minor_safety(subjects: list, brand_policy: dict | None, products: list) -> tuple[dict, list[str]]:
    """The two layers. GLOBAL applies whenever a minor is in the frame and cannot be made more permissive. BRAND is the
    brand's wardrobe preference: it only ADDS restrictions, and `allow_revealing_clothing` is ignored."""
    minors = [s["id"] for s in subjects if s["is_minor"]]
    has_adult = any(s["age_band"] == "adult" for s in subjects)
    glob = MINOR["global"]
    result = {
        "applies": bool(minors), "minor_subject_ids": minors,
        "global": {"policy": glob["policy"], "version": MINOR["version"], "rules": [r["id"] for r in glob["rules"]],
                   "adult_child_rule": glob["adult_child_rule"]["id"] if minors and has_adult else None},
        "brand": None,
    }
    warnings: list[str] = []
    if brand_policy and brand_policy.get("enabled") and minors:
        defaults = MINOR["brand"]["defaults"]
        effective = {**defaults, **{k: v for k, v in brand_policy.items() if k in defaults}}
        ignored = []
        if effective["allow_revealing_clothing"]:
            ignored.append("allow_revealing_clothing")
            effective["allow_revealing_clothing"] = False
        result["brand"] = {"policy": MINOR["brand"]["policy"], "source": "brand", "requested": dict(brand_policy),
                           "effective": effective, "ignored": ignored}
        blocked = {_fold(w) for w in MINOR["brand"]["conflicting_product_words"]}
        for product in products:
            if not effective["allow_short_shorts"] and blocked & set(_words(f"{product.get('type', '')} {product.get('name', '')}")):
                warnings.append(f"brand_wardrobe_conflicts_with_product:{product.get('id')}")
    return result, warnings


# ------------------------------------------------------------------ provenance
def _persona_origin(request: dict, brand: dict, niche: dict) -> str:
    mode = request.get("persona_mode", "automatic")
    if mode == "custom":
        return "user"
    if brand.get("suggestedPersonas"):
        return "brand"
    if niche.get("suggestedPersonas"):
        return "niche"
    return "planner_default"


def _pool_origin(brand: dict, niche: dict) -> str:
    """Where a persona drawn from the automatic pool comes from (independent of the persona mode of the primary)."""
    return "brand" if brand.get("suggestedPersonas") else "niche" if niche.get("suggestedPersonas") else "planner_default"


def persona_origin(request: dict, brand: dict, niche: dict) -> str:
    return _persona_origin(request, brand, niche)


MIXED = "mixed"


def _aggregate(origins: list[str]) -> str:
    """One origin when every leaf agrees, `mixed` when they do not. Never collapses a composed section into the
    origin of a single part (a supporting subject cast from the product must not be attributed to the user)."""
    unique = sorted(set(origins))
    return unique[0] if len(unique) == 1 else (MIXED if unique else "planner_default")


def _age_origin(subject: dict) -> str:
    """Origin of the age evidence. Age read from a persona label the USER or the brand provided is `persona`; age
    read from a label the planner itself generated (a supporting person cast from the product) follows that person."""
    source = subject.get("age_source") or ""
    if source.startswith(("subject.", "request.")):
        return "user"
    if source.startswith("persona."):
        return "persona" if subject["source"] in ("user", "brand", "niche", "persona") else subject["source"]
    if source.startswith("product."):
        return "product"
    return "planner_default"


def build_provenance(*, request: dict, plan: dict, brand: dict, niche: dict, semantics_source: str | None) -> tuple[dict, dict]:
    """(provenance, provenance_sources).

    `provenance` maps each plan field to ONE origin — a leaf when the field has a single source, `mixed` when a
    composed section (subjects, scene) has parts from different sources. The parts stay as their own leaf entries
    (`subjects.s1`, `subjects.s2`, `subjects.s2.age_band`, `scene.gaze`, `scene.picks`), so nothing is lost by the
    aggregate. `provenance_sources` lists, for each aggregate, the distinct origins behind it — what feedback,
    "Copiar Dados" and any future recommender read to tell what the user chose from what was inferred."""
    context_mode = (request.get("context") or {"mode": "automatic"}).get("mode", "automatic")
    provider = plan["context"]["provider"]
    out = {
        "mode": "planner_default", "objective": "user", "strategy": "user", "products": "user", "angle": "user",
        "placement": "user", "quality": "user" if request.get("quality") else "planner_default",
        "brand_kit": "user", "niche_kit": "user" if (request.get("niche_kit") or request.get("niche_kit_id")) else "brand",
        "persona": _persona_origin(request, brand, niche) if plan.get("persona") else "planner_default",
        "context": "user" if context_mode != "automatic" else ("brand" if provider == "geographic" else "niche"),
        "references": "product", "model": "planner_default",
        "scene.gaze": plan["scene"]["gaze"]["source"], "scene.picks": "planner_default", "scene.prompt_version": "planner_default",
        "composition": "planner_default", "minor_safety.global": "safety_policy",
        "minor_safety.brand": "brand" if plan["minor_safety"]["brand"] else "planner_default",
        "semantics": semantics_source or "planner_default",
        "resolved_inputs": "brand", "compiler": "planner_default",
    }
    sources: dict[str, list[str]] = {}
    for subject in plan["subjects"]:
        out[f"subjects.{subject['id']}"] = subject["source"]
        out[f"subjects.{subject['id']}.age_band"] = _age_origin(subject)
    subject_origins = [s["source"] for s in plan["subjects"]]
    out["subjects"] = _aggregate(subject_origins)
    if subject_origins:
        sources["subjects"] = sorted(set(subject_origins))
    scene_parts = [plan["scene"]["gaze"]["source"]] + (["planner_default"] if plan["scene"]["picks"] else [])
    out["scene"] = _aggregate(scene_parts)
    sources["scene"] = sorted(set(scene_parts))
    return dict(sorted(out.items())), dict(sorted(sources.items()))


def objective_for(strategy: str) -> str:
    return _OBJECTIVES[strategy]


def build(
    *, request: dict, angle_id: str, strategy: str, products: list, brand: dict, niche: dict, persona: dict | None,
    people: list, people_needed: int, prompt_version: int, seed: int, apparel: bool, pool: list, engine: dict,
) -> dict:
    """All the v2-only plan fields (everything except the prompt and the compiler record, which need the assembled
    plan). `people` is the v1 cast; a two-person scene may recast its supporting person from the product's semantics."""
    picks = choose_picks(angle_id, seed) if prompt_version == 2 else {}
    supporting = None
    if prompt_version == 2 and angle_id == GIFT_ANGLE:
        people, supporting = cast_supporting(people=people, pool=pool, products=products, seed=seed)
    persona_source = _persona_origin(request, brand, niche)
    semantic = _semantic_of(products)
    semantic_origin = None if not semantic else ("product_enrichment" if semantic.get("source") == "enrichment" else "product")
    subjects = derive_subjects(angle_id=angle_id, products=products, persona=persona, people=people,
                               people_needed=people_needed, prompt_version=prompt_version, apparel=apparel, picks=picks,
                               persona_source=persona_source, pool_source=_pool_origin(brand, niche),
                               supporting_source=semantic_origin if supporting and supporting.get("source") == "product" else None)
    gaze = resolve_gaze(request.get("gaze_mode"), angle_id, len(subjects), picks)
    safety, safety_warnings = minor_safety(subjects, brand.get("minorWardrobePolicy"), products)
    semantic_products = [{"product_id": p.get("id"), "semantic_context": p.get("semantic_context")} for p in products]
    warnings = semantic_warnings(products, subjects)
    return {
        "people": people, "supporting": supporting,
        "fields": {
            "mode": "creative", "objective": objective_for(strategy), "subjects": subjects,
            "scene": {"gaze": gaze, "picks": picks, "prompt_version": prompt_version, "interaction": None},
            "composition": composition(angle_id, len(subjects), picks),
            "minor_safety": safety,
            "semantics": {"products": semantic_products, "supporting": supporting, "warnings": warnings},
            "resolved_inputs": {
                "brand": {k: brand[k] for k in ("name", "positioning", "visualStyle", "colors", "manualNotes") if brand.get(k)},
                "niche": {k: niche[k] for k in ("name", "materials", "audienceBehaviors") if niche.get(k)},
                "strategy": {"text_rule": engine["text_rule"], "communication": engine["communication"]},
            },
        },
        "warnings": [f"{w['code']}:{w['theme']}:{w['supporting_role']}" for w in warnings] + safety_warnings
        + ([f"people_count_risk:{len(subjects)}"] if len(subjects) >= 3 else []),
        "semantics_source": semantic_origin,
    }
