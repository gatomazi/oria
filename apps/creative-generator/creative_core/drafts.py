"""Plan -> draft helpers (Fase B): the base for "Copiar Dados" and for the liked/disliked history.

Both read a PERSISTED CreativePlan, never the screen: the plan is the source of truth for what generated a creative.

    generation_draft_from_plan(plan)          -> GenerationDraft   what to pre-fill in the generator
    feedback_snapshot(plan, result_metadata)  -> FeedbackSnapshot  what to remember when the user marks liked/disliked

Neither touches execution ids (job, attempt, asset). The panel adds who/where/when to the snapshot; the panel maps a
draft onto its own form (product ids, brand/niche/persona/context ids). Works for schema_version 1 and 2 plans: a v1
plan simply has no subjects, gaze or compiler.

Two ways to go on from a draft, both prepared in `draft["actions"]` as patches over the draft's own fields:

    again      the same creative: keeps the seed, the scene picks and the resolved gaze. Same seed + same picks + same
               choices rebuild the same prompt.
    variation  a new take: drops the seed, the rerollable scene picks and a gaze the planner (not the user) chose; keeps
               product, subjects, relations, interaction, angle, context, format and every other human choice.
"""
from __future__ import annotations

from .planner_v2 import objective_for

_FUNNEL_KEYS = ("headline", "subheadline", "cta", "benefits", "badges", "chips", "search_bar_text", "text_density", "cta_emphasis")
_REMARKETING_KEYS = ("headline", "subheadline", "cta", "benefits", "text_density", "cta_emphasis")


def _persona_mode(plan: dict) -> tuple[str, dict | None]:
    persona = plan.get("persona")
    if persona is None:
        return "automatic", None  # "none" cannot be told apart from "the angle has nobody in the frame": not recoverable
    if persona.get("source") == "custom":
        return "custom", dict(persona)
    return "automatic", None


def _context(plan: dict) -> dict:
    ctx = plan["context"]
    mode = {"custom": "custom", "geographic": "geographic"}.get(ctx["provider"], "niche")
    return {"mode": mode, "context_id": ctx["context_id"], "provider": ctx["provider"], "scene": ctx["scene"]}


def _request_subjects(plan: dict) -> list[dict]:
    """The plan's cast as request subjects, ready to be sent back as `subjects`. A cast the planner drew from the
    persona/pool alone (legacy) is not a choice of the user: it comes back through the seed, not as explicit subjects."""
    if plan["scene"]["composition_source"] == "legacy":
        return []
    cast = []
    for subject in plan["subjects"]:
        entry = {"id": subject["id"], "role": subject["role"], "persona": dict(subject["persona"] or {"label": subject["label"]}),
                 "wears_product_id": subject["product_id"] if subject["product_use"] != "none" else None,
                 "prominence": subject["prominence"]}
        if subject["age_band"] != "unknown":
            entry["age_band"] = subject["age_band"]  # explicit from here on, wherever it was first read
        if subject.get("relation_to_primary"):
            entry["relation_to_primary"] = subject["relation_to_primary"]
        if subject.get("relation_label"):
            entry["relation_label"] = subject["relation_label"]
        cast.append(entry)
    return cast


def generation_draft_from_plan(plan: dict, result_metadata: dict | None = None) -> dict:
    """The generator input that produced `plan`, rebuilt from the plan alone. `seed` is the original seed: reuse it to
    regenerate the same scene, or drop it to ask for a variation. `result_metadata` is accepted for symmetry with
    feedback_snapshot; nothing operational (job, attempt, asset, usage) is copied."""
    v2 = plan["schema_version"] >= 2
    persona_mode, persona = _persona_mode(plan)
    overlay = plan.get("overlay") or {}
    strategy = plan["strategy"]
    funnel = remarketing = None
    if strategy == "FUNNEL_VISUAL":
        funnel = {k: overlay[k] for k in _FUNNEL_KEYS if overlay.get(k)} | {"clean_mode": bool(overlay.get("clean"))}
    if strategy == "REMARKETING":
        remarketing = {"intent": plan["remarketing_intent"], "clean_mode": "always" if overlay.get("clean") else "never",
                       **{k: overlay[k] for k in _REMARKETING_KEYS if overlay.get(k)}}
        if plan.get("funnel_stage"):
            remarketing["stage_override"] = plan["funnel_stage"]
    gaze = plan["scene"]["gaze"]["mode"] if v2 else "auto"
    gaze = gaze if gaze != "none" else "auto"
    subjects = _request_subjects(plan) if v2 else []
    interaction = plan["scene"]["interaction"] if v2 and subjects else None
    picks = {name: pick["index"] for name, pick in plan["scene"]["picks"].items()} if v2 and plan["scene"].get("picks") else None
    user_gaze = v2 and plan["scene"]["gaze"]["source"] == "user"
    draft = {
        "mode": plan.get("mode", "creative"), "objective": plan.get("objective") or objective_for(strategy), "strategy": strategy,
        "product_mode": plan["product_mode"], "product_ids": [p["id"] for p in plan["products"]],
        "angle_id": plan["angle"]["id"],
        # Fase D.1: "de novo"/"variação" reproduce the SAME custom angle, not just the legacy id it routed to.
        "custom_angle": (plan.get("angle_recommendation") or {}).get("custom_angle"),
        "placement_id": plan["placement"]["id"], "quality": plan["model"]["quality"],
        "brand_kit": dict(plan["brand_kit"]), "niche_kit": dict(plan["niche_kit"]),
        "persona_mode": persona_mode, "persona": persona, "subjects": subjects, "interaction": interaction, "scene_picks": picks,
        "context": _context(plan), "funnel_stage": plan.get("funnel_stage"), "remarketing": remarketing, "funnel": funnel,
        "copy": dict(plan["copy"]), "gaze_mode": gaze,
        "plan_schema_version": plan["schema_version"], "prompt_version": plan["prompt"]["prompt_version"],
        "seed": plan.get("seed"), "plan_warnings": list(plan.get("warnings") or []),
        "actions": {
            "again": {"seed": plan.get("seed"), "scene_picks": picks, "gaze_mode": gaze},
            "variation": {"seed": None, "scene_picks": None, "gaze_mode": gaze if user_gaze else "auto"},
        },
        "source": {"creative_id": plan["creative_id"], "plan_id": plan["plan_id"], "plan_schema_version": plan["schema_version"],
                   "compiler_version": (plan.get("compiler") or {}).get("version")},
    }
    empty = (None, [], {})
    carried = [k for k in ("mode", "objective", "product_ids", "angle_id", "placement_id", "quality", "brand_kit", "niche_kit",
                           "persona", "subjects", "interaction", "context", "funnel_stage", "funnel", "remarketing", "copy", "gaze_mode",
                           "scene_picks", "seed")
               if draft.get(k) not in empty and not (k == "gaze_mode" and draft[k] == "auto")]
    draft["carried"] = carried
    return draft


def composition_key(plan: dict) -> str:
    """One indexable string for "who is in the scene doing what": `p<people>|<primary band>+<supporting relations>|<interaction>`,
    e.g. `p2|child_6_9+father|playing`. Built from data the plan already has; a supporting person with no structured
    relation counts by its role hint, then as `other`. Stable across runs, so a store's approvals can be grouped by it."""
    cast = plan.get("subjects") or []
    if not cast:
        return "p0|-|-"
    parts = [cast[0]["age_band"]] + [s.get("relation_to_primary") or s.get("role_hint") or "other" for s in cast[1:]]
    return f"p{len(cast)}|{'+'.join(parts)}|{plan['scene'].get('interaction') or '-'}"


def feedback_snapshot(plan: dict, result_metadata: dict | None = None, asset_sha256: str | None = None) -> dict:
    """What is worth remembering about a creative when the user says liked/disliked: the plan-level facts that let a
    later recommender ask "which angles/contexts/compositions does this store approve"."""
    v2 = plan["schema_version"] >= 2
    trace = ((result_metadata or {}).get("trace")) or {}
    references = trace.get("references") or {}
    subjects = [{k: s.get(k) for k in ("role", "label", "age_band", "is_minor", "product_use", "role_hint", "relation_to_primary")}
                for s in plan.get("subjects") or []]
    ctx = plan["context"]
    scene = plan["scene"] if v2 else {}
    interaction = scene.get("interaction")
    return {
        "creative_id": plan["creative_id"], "plan_id": plan["plan_id"], "plan_schema_version": plan["schema_version"],
        "compiler_version": (plan.get("compiler") or {}).get("version"), "prompt_version": plan["prompt"]["prompt_version"],
        "prompt_sha256": plan["prompt"]["sha256"], "mode": plan.get("mode", "creative"),
        "objective": plan.get("objective") or objective_for(plan["strategy"]), "strategy": plan["strategy"],
        "angle": plan["angle"]["id"], "product_ids": [p["id"] for p in plan["products"]], "subjects": subjects,
        # Fase D: family/preset/scope/version the angle resolved to, so approval can be grouped by family
        # later (e.g. "connection" vs "editorial_portrait") without opening the plan JSON. Absent (all None)
        # on a plan built before Fase D — never backfilled, the plan itself is the only source of truth.
        "angle_family": (plan.get("angle_recommendation") or {}).get("family"),
        "angle_preset": (plan.get("angle_recommendation") or {}).get("preset"),
        "angle_scope": (plan.get("angle_recommendation") or {}).get("scope"),
        "angle_version": (plan.get("angle_recommendation") or {}).get("version"),
        # Fase D.1: the custom angle's OWN identity, not just the family/version it shares with siblings.
        "angle_custom_id": ((plan.get("angle_recommendation") or {}).get("custom_angle") or {}).get("id"),
        "angle_custom_slug": ((plan.get("angle_recommendation") or {}).get("custom_angle") or {}).get("slug"),
        "angle_custom_name": ((plan.get("angle_recommendation") or {}).get("custom_angle") or {}).get("name"),
        "people_count": len(subjects) if v2 else (1 if plan.get("persona") else 0),
        "interaction": interaction, "composition_source": scene.get("composition_source"),
        "composition_key": composition_key(plan) if v2 else None,
        "pose_risk": plan["composition"]["pose_risk"] if v2 else None,
        "warnings": list(plan.get("warnings") or []),
        "context": {k: ctx[k] for k in ("context_id", "context_type", "provider", "scene")}, "placement": plan["placement"]["id"],
        "quality": plan["model"]["quality"], "gaze_mode": plan["scene"]["gaze"]["mode"] if v2 else None,
        "minor_safety_applied": bool(v2 and plan["minor_safety"]["applies"]),
        "flags": {"normalize_references": bool(references.get("normalized")) if trace else None},
        "model": {"requested": trace.get("model_requested") or plan["model"]["model"], "served": trace.get("model_served")},
        "asset_sha256": asset_sha256,
    }
