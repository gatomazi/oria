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
from pathlib import Path

from . import composition as comp
from .errors import GenerationError
from .composition import DATA, detect_age, infant_product, role_hint  # noqa: F401 — re-exported for callers/tests
from .prompt_v2 import ANGLES as _ANGLES_V2
from .prompt_v2 import GIFT_ANGLE, choose_picks

_TEMPLATES = Path(__file__).parent / "templates"
with open(_TEMPLATES / "minor_safety.json", encoding="utf-8") as _f:
    MINOR: dict = json.load(_f)

_OBJECTIVES = {"CLEAN_ANGLES": "clean_creative", "REMARKETING": "remarketing", "FUNNEL_VISUAL": "funnel_visual"}


def _rotate(options: list, seed: int):
    """Deterministic pick that also works for dicts (context_intelligence.deterministic_pick hashes its options)."""
    return options[seed % len(options)] if options else None


# ------------------------------------------------------------------ subjects (legacy adapter)
def derive_subjects(
    *, angle_id: str, products: list, persona: dict | None, people: list, people_needed: int, prompt_version: int,
    apparel: bool, picks: dict, persona_source: str, pool_source: str = "planner_default",
    supporting_source: str | None = None,
) -> list[dict]:
    """The composition when the request states no subjects: the persona (and, for a group or the gift scene, the people
    the v1 core already picks), read as subjects. Same behavior as Fase B; the relation of a supporting person is now
    structured when its role is known."""
    if people_needed <= 0:
        return []
    cast = list(people) if len(people) > 1 else [persona or {"label": "uma pessoa"}]
    gift = angle_id == GIFT_ANGLE and prompt_version == 2 and len(cast) == 2
    wears_index = 0 if not gift else (0 if picks.get("cena", {}).get("index") == 1 else None)
    subjects = []
    for i, person in enumerate(cast):
        band, source = detect_age(person)
        product = products[i] if len(products) > 1 and i < len(products) else products[0]
        uses = (i == wears_index) if gift else True
        if band == "unknown" and i == 0 and infant_product(products[0]) and uses:
            band, source = "child", "product.type"  # primary wearer of an infant garment is treated as a minor
        hint = role_hint(person.get("label") or "")
        subjects.append(comp._subject(
            i, person, role="primary" if i == 0 else "supporting", band=band, age_source=source,
            relation=(hint if i > 0 and hint in comp.RELATION_TYPES else None), relation_label=None,
            product=product if uses else None, prominence="hero" if i == 0 else "secondary",
            # Each subject carries the origin of ITS OWN cast: the supporting person recast from the product's
            # semantics is `product`, not whatever gave the primary. The aggregate (`mixed`) is built from these.
            source=persona_source if i == 0 else (supporting_source or pool_source)))
    return subjects


# ------------------------------------------------------------------ semantics / supporting person
def _semantic_of(products: list) -> dict | None:
    for product in products:
        semantic = product.get("semantic_context")
        if semantic:
            return semantic
    return None


def _rotate(options: list, seed: int):
    """Deterministic pick that also works for dicts (context_intelligence.deterministic_pick hashes its options)."""
    return options[seed % len(options)] if options else None


def cast_supporting(*, people: list, pool: list, products: list, seed: int) -> tuple[list, dict | None]:
    """For the legacy two-person gift scene, choose the supporting person with the product's semantics in mind.

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
    """Informative warnings: the scene contradicts the product's semantics — the supporting person is one the print
    marks as incompatible, or the primary does not look like the print's wearer. Never blocks: the user decides."""
    out = []
    for product in products:
        semantic = product.get("semantic_context") or {}
        incompatible = set(semantic.get("incompatible_auto_supporting_roles") or [])
        themes = semantic.get("relationship_themes") or []
        for subject in subjects:
            role = subject.get("role_hint")
            if subject["role"] == "supporting" and role in incompatible:
                out.append({"code": "semantic_mismatch", "theme": themes[0] if themes else None,
                            "supporting_role": role, "product_id": product.get("id")})
    return out + comp.wearer_warnings(products, subjects)


# ------------------------------------------------------------------ custom angle definition vs. structured gaze
#
# D.1.1 §3: `definition` (free text a person typed when creating a Custom Angle — `photographic_direction`,
# `framing`, `composition`, `visual_notes`) is NEVER a second authority. `resolve_gaze` above never reads it —
# only `custom_angle["default_gaze"]` (a structured field) feeds gaze resolution, and only below `interaction`
# and the user's own explicit choice. The same holds for people count, who wears the product, structured
# action and context: all of those come exclusively from `subjects`/`interaction`/`context`/products, and
# `definition` text is compiled into the prompt as photographic STYLE guidance only (framing/light/composition),
# never parsed back into any of those decisions.
#
# What follows is the ONE narrow exception: a best-effort, purely advisory lexical check for the specific case
# the brief calls out (a `definition` that talks about looking at/away from camera in words that read as the
# opposite of the gaze this plan actually resolved to). It is intentionally NOT a general natural-language
# contradiction detector — that would be a false sense of security (ReDoS-shaped regex, brittle keyword coverage,
# no real language understanding) which is exactly what was asked not to build. Limits, explicit:
#   - only covers gaze-related wording; people count / wearer / action / context / fidelity / safety have no
#     text-based check at all, because nothing text-based ever influences them (there is no channel for a
#     conflict to exist through);
#   - a small, fixed Portuguese phrase list, folded (no accents/case) — anything phrased differently, in another
#     language, or requiring real understanding is silently missed;
#   - the result is a `warnings` entry the UI can surface as a human-readable heads-up — it NEVER blocks
#     generation, never changes the resolved `gaze` field, and never rewrites `definition` (existing human
#     decisions are never silently overridden; see docs/features/creative-generator-fase-d1-1.md).
_GAZE_DEFINITION_HINTS: dict[str, tuple[str, ...]] = {
    # Checked in THIS order: the negated/off-camera phrases are checked first because they contain the positive
    # "olha(ndo) para a camera" wording as a substring ("nao olha para a camera") — checking camera first would
    # misread a negation as agreement.
    "off_camera": ("nao olha para a camera", "sem olhar para a camera", "longe da camera", "de costas para a camera",
                   "de perfil", "olhando para longe", "sem contato visual com a camera"),
    "product": ("olhando para o produto", "olha para o produto", "atencao no produto", "foco visual no produto"),
    "interaction": ("olhando um para o outro", "se olhando", "trocando olhares", "olhar entre os dois"),
    "camera": ("olha para a camera", "olhando para a camera", "olhar direto para a camera",
               "contato visual com a camera", "encara a camera", "olhando direto para a camera"),
}


def _definition_gaze_hint(definition: dict | None) -> str | None:
    if not definition:
        return None
    texto = " ".join(str(definition.get(campo) or "") for campo in ("photographic_direction", "framing", "composition"))
    notas = definition.get("visual_notes")
    if isinstance(notas, list):
        texto += " " + " ".join(str(n) for n in notas)
    texto = comp.fold(texto)
    if not texto.strip():
        return None
    for mode, frases in _GAZE_DEFINITION_HINTS.items():
        if any(frase in texto for frase in frases):
            return mode
    return None


# ------------------------------------------------------------------ gaze
def resolve_gaze(requested: str | None, angle_id: str, people_count: int, picks: dict,
                 interaction: dict | None = None, custom_angle: dict | None = None) -> dict:
    """`auto` (or absent) becomes a concrete mode here — the compiler never sees `auto`.

    Precedence: nobody in frame (none) > the caller's explicit mode > the gaze the chosen interaction implies >
    a custom angle's OWN default (Fase D.1 — still below interaction/user, but ahead of the legacy angle it
    routes to) > the preset the plan picked (lifestyle action, creator format) > the angle's default for one /
    several people."""
    requested = requested or "auto"
    if people_count == 0:
        return {"mode": "none", "requested": requested, "source": "angle", "reason": "no_people_in_frame"}
    if requested != "auto":
        return {"mode": requested, "requested": requested, "source": "user", "reason": "requested"}
    if interaction:
        return {"mode": interaction["gaze_default"], "requested": "auto", "source": "planner_default",
                "reason": f"interaction:{interaction['id']}"}
    if custom_angle and custom_angle.get("default_gaze"):
        return {"mode": custom_angle["default_gaze"], "requested": "auto", "source": "angle",
                "reason": f"custom_angle:{custom_angle['id']}"}
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
def composition(angle_id: str, people_count: int, picks: dict, interaction: dict | None = None) -> dict:
    """Deterministic pose risk: people count, held objects / contact of the picked presets, and the interaction's own
    contribution (catalog data). Four or more people are always high: never the safe configuration."""
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
    if interaction and interaction["pose_risk"]:
        score += interaction["pose_risk"]
        reasons.append(f"interaction:{interaction['id']}")
    levels = weights["levels"]
    level = "low" if score <= levels["low"] else "medium" if score <= levels["medium"] else "high"
    return {"people_count": people_count, "pose_risk": level, "risk_reasons": reasons}


# ------------------------------------------------------------------ minor safety
def minor_safety(subjects: list, brand_policy: dict | None, products: list) -> tuple[dict, list[str]]:
    """The two layers. GLOBAL applies whenever a minor is in the frame and cannot be made more permissive. BRAND is the
    brand's wardrobe preference: it only ADDS restrictions, and `allow_revealing_clothing` is ignored.

    `basis` says which subjects were recognised as minors from a DECLARED age (subject or persona `age_band`) and which
    from the text/product heuristic (the compatibility fallback)."""
    minors = [s["id"] for s in subjects if s["is_minor"]]
    has_adult = any(s["age_band"] in comp.ADULT_BANDS for s in subjects)
    glob = MINOR["global"]
    declared = ("subject.age_band", "persona.age_band")
    result = {
        "applies": bool(minors), "minor_subject_ids": minors,
        "global": {"policy": glob["policy"], "version": MINOR["version"], "rules": [r["id"] for r in glob["rules"]],
                   "adult_child_rule": glob["adult_child_rule"]["id"] if minors and has_adult else None},
        "brand": None,
        "basis": {"explicit": [s["id"] for s in subjects if s["is_minor"] and s.get("age_source") in declared],
                  "heuristic": [s["id"] for s in subjects if s["is_minor"] and s.get("age_source") not in declared]},
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
        blocked = {comp.fold(w) for w in MINOR["brand"]["conflicting_product_words"]}
        for product in products:
            if not effective["allow_short_shorts"] and blocked & set(comp.words(f"{product.get('type', '')} {product.get('name', '')}")):
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


_SEMANTIC_ARRAY_FIELDS = (
    "wearer_roles", "relationship_themes", "recommended_supporting_roles",
    "incompatible_auto_supporting_roles", "scene_intents", "visible_text",
)


def _semantics_source_summary(semantic: dict | None) -> str | None:
    """Fase F.2.A: `plan["semantics_source"]` used to be one value derived straight from the aggregate
    `semantic["source"]`, so a partial enrichment approval (some fields accepted, some preserved manual) painted
    every populated field the same color. This now aggregates the REAL per-field origins through
    `comp.field_origin` — which itself falls back to the old aggregate whenever a field has no `field_sources`
    entry, so a semantic_context from before this phase collapses to exactly the single value it always
    produced. One origin when every populated field agrees, `contracts.MIXED_ORIGIN` ("mixed", same constant
    `_aggregate` above uses for subjects/scene) when they genuinely differ. With no populated field at all, falls
    back to the old whole-object read (nothing to disagree about)."""
    if not semantic:
        return None
    origins = [comp.field_origin(semantic, field) for field in _SEMANTIC_ARRAY_FIELDS if semantic.get(field)]
    if origins:
        return _aggregate(origins)
    return "product_enrichment" if semantic.get("source") == "enrichment" else "product"


def _age_origin(subject: dict) -> str:
    """Origin of the age evidence. Age the USER declared (subject age_band) is `user`; age read from a persona label or
    structured field the user or the brand provided is `persona`; age read from a label the planner itself generated
    (a supporting person cast from the product) follows that person."""
    source = subject.get("age_source") or ""
    if source.startswith(("subject.", "request.")):
        return "user"
    if source.startswith("persona."):
        return "persona" if subject["source"] in ("user", "brand", "niche", "persona") else subject["source"]
    if source.startswith("product."):
        return "product"
    return "planner_default"


def build_provenance(*, request: dict, plan: dict, brand: dict, niche: dict, semantics_source: str | None,
                    angle_source: str = "user") -> tuple[dict, dict]:
    """(provenance, provenance_sources).

    `provenance` maps each plan field to ONE origin — a leaf when the field has a single source, `mixed` when a
    composed section (subjects, scene) has parts from different sources. The parts stay as their own leaf entries
    (`subjects.s1`, `subjects.s2`, `subjects.s2.age_band`, `scene.gaze`, `scene.picks`, `scene.interaction`), so
    nothing is lost by the aggregate. `provenance_sources` lists, for each aggregate, the distinct origins behind it —
    what feedback, "Copiar Dados" and any future recommender read to tell what the user chose from what was inferred."""
    context_mode = (request.get("context") or {"mode": "automatic"}).get("mode", "automatic")
    provider = plan["context"]["provider"]
    scene = plan["scene"]
    out = {
        "mode": "planner_default", "objective": "user", "strategy": "user", "products": "user", "angle": angle_source,
        "placement": "user", "quality": "user" if request.get("quality") else "planner_default",
        "brand_kit": "user", "niche_kit": "user" if (request.get("niche_kit") or request.get("niche_kit_id")) else "brand",
        "persona": _persona_origin(request, brand, niche) if plan.get("persona") else "planner_default",
        "context": "user" if context_mode != "automatic" else ("brand" if provider == "geographic" else "niche"),
        "references": "product", "model": "planner_default",
        "scene.gaze": scene["gaze"]["source"], "scene.picks": "planner_default", "scene.prompt_version": "planner_default",
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
    scene_parts = [scene["gaze"]["source"]] + (["planner_default"] if scene["picks"] else [])
    if scene.get("interaction"):
        out["scene.interaction"] = scene["interaction_source"]
        scene_parts.append(scene["interaction_source"])
    out["scene"] = _aggregate(scene_parts)
    sources["scene"] = sorted(set(scene_parts))
    return dict(sorted(out.items())), dict(sorted(sources.items()))


def objective_for(strategy: str) -> str:
    return _OBJECTIVES[strategy]


def _picks(angle_id: str, seed: int, replay: dict | None) -> dict:
    """The pool entries the scene uses: replayed from an earlier plan when `scene_picks` is given, else chosen from the
    seed. A replay names indexes only; the text comes from the pool, and an unknown pool or index is an error."""
    picks = choose_picks(angle_id, seed)
    for name, index in (replay or {}).items():
        options = (_ANGLES_V2.get(angle_id) or {}).get("pools", {}).get(name)
        entry = index.get("index") if isinstance(index, dict) else index
        if options is None or not isinstance(entry, int) or isinstance(entry, bool) or not 0 <= entry < len(options):
            raise GenerationError("INVALID_INPUT", {"errors": [f"scene_picks.{name}: not a valid pick for {angle_id}"]})
        picks[name] = {"index": entry, "text": options[entry]}
    return picks


def build(
    *, request: dict, angle_id: str, strategy: str, products: list, brand: dict, niche: dict, persona: dict | None,
    people: list, people_needed: int, prompt_version: int, seed: int, apparel: bool, pool: list, engine: dict,
    custom_angle: dict | None = None,
) -> dict:
    """All the v2-only plan fields (everything except the prompt and the compiler record, which need the assembled
    plan).

    The cast comes from one of three places, recorded as `composition_source`: the request's own `subjects`
    (explicit), the planner's recommendation from the product's semantic_context (recommended), or the persona alone /
    the people the v1 core picks (legacy — Fase B behavior). The interaction is explicit, recommended or a group
    default. A scene with a legacy cast and no interaction keeps the angle's own person scene (`template`); any other
    scene is an angle frame plus the subjects and the interaction (`frame`)."""
    picks = _picks(angle_id, seed, request.get("scene_picks")) if prompt_version == 2 else {}
    limits = DATA["angle_people"].get(angle_id) or {}
    persona_source = _persona_origin(request, brand, niche)
    semantic = _semantic_of(products)
    supporting_info = None
    warnings: list[str] = []

    source = "legacy"
    requested = request.get("subjects")
    recommended = None
    if requested:
        if limits.get("max", 1) == 0:
            raise GenerationError("INVALID_INPUT", {"errors": [f"subjects: {angle_id} is a product-only angle and takes no people"]})
        subjects, source = comp.explicit_subjects(requested, products), "explicit"
    else:
        recommended = comp.recommend(angle_id=angle_id, products=products, persona=persona,
                                     persona_is_custom=request.get("persona_mode") == "custom", pool=pool, seed=seed,
                                     persona_source=persona_source)
        if recommended:
            subjects, supporting_info = recommended
            source = "recommended"
        else:
            if prompt_version == 2 and angle_id == GIFT_ANGLE:
                people, supporting_info = cast_supporting(people=people, pool=pool, products=products, seed=seed)
            subjects = derive_subjects(
                angle_id=angle_id, products=products, persona=persona, people=people, people_needed=people_needed,
                prompt_version=prompt_version, apparel=apparel, picks=picks, persona_source=persona_source,
                pool_source=_pool_origin(brand, niche),
                supporting_source=comp.field_origin(semantic, "recommended_supporting_roles")
                if supporting_info and supporting_info.get("source") == "product" else None)

    # Whoever wears an infant garment must be a child (structural, not a sentence in the prompt).
    subjects, wearer_fixes, recast = comp.enforce_infant_wearers(subjects, products, pool=pool, seed=seed)
    warnings += wearer_fixes
    if recast is not None and source == "legacy":
        persona = recast
    interaction_id, interaction_source, interaction_warnings = comp.resolve_interaction(
        request.get("interaction"), subjects, semantic) if source != "legacy" or request.get("interaction") else (None, None, [])
    interaction = comp.interaction_detail(interaction_id) if interaction_id else None
    warnings += interaction_warnings
    scene_mode = "template" if source == "legacy" and not interaction else "frame"
    if scene_mode == "frame":
        # A frame scene is the angle's setting + the subjects + the interaction: the pools' action/format sentences are NOT
        # in its prompt. Keeping the picks would leave a decision that says nothing (an "arriving at a place" action next to
        # `playing`) yet still moves the gaze and the pose risk, and that "Gerar de novo" / the feedback would carry as
        # if it were part of the scene. They are used only while the cast is being derived (the gift scenario picks who
        # wears the piece, and that outcome lives in the subjects), then dropped.
        if request.get("scene_picks"):
            warnings.append("scene_picks_ignored:frame_scene")
        picks = {}
    count = len(subjects)
    if source != "legacy" and count and not limits.get("min", 1) <= count <= limits.get("max", 4):
        warnings.append(f"angle_people_mismatch:{angle_id}:{count}")
    if custom_angle:
        # Compatibility the planner now actually enforces (Fase D.1 §4). allowed_interactions is a recommendation:
        # the explicit choice (or the one the product/interaction machinery already resolved) always wins, this
        # only warns. people_mode is checked the same way — Subjects/interaction still own who is in the scene.
        if custom_angle.get("allowed_interactions") and interaction_id and interaction_id not in custom_angle["allowed_interactions"]:
            warnings.append(f"angle_interaction_mismatch:{custom_angle['id']}:{interaction_id}")
        expected_people = custom_angle.get("people_mode")
        if (expected_people == "none" and count > 0) or (expected_people == "required" and count == 0):
            warnings.append(f"angle_people_mode_mismatch:{expected_people}:{count}")
    gaze = resolve_gaze(request.get("gaze_mode"), angle_id, count, picks, interaction, custom_angle)
    if custom_angle:
        # Advisory only — see _definition_gaze_hint's docstring above for exactly what this does and does not
        # cover. Never changes `gaze`, never touches `definition`.
        hint = _definition_gaze_hint(custom_angle.get("definition"))
        if hint and hint != gaze["mode"]:
            warnings.append(f"custom_angle_definition_gaze_conflict:{custom_angle['id']}:definition_suggests={hint}:resolved={gaze['mode']}")
    safety, safety_warnings = minor_safety(subjects, brand.get("minorWardrobePolicy"), products)
    semantic_products = [{"product_id": p.get("id"), "semantic_context": p.get("semantic_context")} for p in products]
    structured_warnings = semantic_warnings(products, subjects)
    primary = subjects[0]["persona"] if subjects else None
    return {
        "persona": primary if source != "legacy" else persona, "supporting": supporting_info,
        "fields": {
            "mode": "creative", "objective": objective_for(strategy), "subjects": subjects,
            "scene": {"gaze": gaze, "picks": picks, "prompt_version": prompt_version, "interaction": interaction_id,
                      "interaction_detail": interaction, "interaction_source": interaction_source,
                      "scene_mode": scene_mode,
                      "composition_source": source},
            "composition": composition(angle_id, count, picks, interaction),
            "minor_safety": safety,
            "semantics": {"products": semantic_products, "supporting": supporting_info, "warnings": structured_warnings},
            "resolved_inputs": {
                "brand": {k: brand[k] for k in ("name", "positioning", "visualStyle", "colors", "manualNotes") if brand.get(k)},
                "niche": {k: niche[k] for k in ("name", "materials", "audienceBehaviors") if niche.get(k)},
                "strategy": {"text_rule": engine["text_rule"], "communication": engine["communication"]},
            },
        },
        "warnings": [f"{w['code']}:{w.get('theme')}:{w.get('supporting_role') or w.get('expected')}" for w in structured_warnings]
        + warnings + safety_warnings + ([f"people_count_risk:{count}"] if count >= 3 else []),
        "semantics_source": _semantics_source_summary(semantic),
    }
