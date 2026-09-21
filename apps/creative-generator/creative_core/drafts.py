"""Plan -> draft helpers (Fase B): the base for "Copiar Dados" and for the liked/disliked history.

Both read a PERSISTED CreativePlan, never the screen: the plan is the source of truth for what generated a creative.

    generation_draft_from_plan(plan)          -> GenerationDraft   what to pre-fill in the generator
    feedback_snapshot(plan, result_metadata)  -> FeedbackSnapshot  what to remember when the user marks liked/disliked

Neither touches execution ids (job, attempt, asset). The panel adds who/where/when to the snapshot; the panel maps a
draft onto its own form (product ids, brand/niche/persona/context ids). Works for schema_version 1 and 2 plans: a v1
plan simply has no subjects, gaze or compiler.
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
    draft = {
        "mode": plan.get("mode", "creative"), "objective": plan.get("objective") or objective_for(strategy), "strategy": strategy,
        "product_mode": plan["product_mode"], "product_ids": [p["id"] for p in plan["products"]],
        "angle_id": plan["angle"]["id"], "placement_id": plan["placement"]["id"], "quality": plan["model"]["quality"],
        "brand_kit": dict(plan["brand_kit"]), "niche_kit": dict(plan["niche_kit"]),
        "persona_mode": persona_mode, "persona": persona, "subjects": list(plan.get("subjects") or []),
        "context": _context(plan), "funnel_stage": plan.get("funnel_stage"), "remarketing": remarketing, "funnel": funnel,
        "copy": dict(plan["copy"]), "gaze_mode": gaze if gaze != "none" else "auto",
        "plan_schema_version": plan["schema_version"], "prompt_version": plan["prompt"]["prompt_version"],
        "seed": plan.get("seed"),
        "source": {"creative_id": plan["creative_id"], "plan_id": plan["plan_id"], "plan_schema_version": plan["schema_version"],
                   "compiler_version": (plan.get("compiler") or {}).get("version")},
    }
    empty = (None, [], {})
    carried = [k for k in ("mode", "objective", "product_ids", "angle_id", "placement_id", "quality", "brand_kit", "niche_kit",
                           "persona", "subjects", "context", "funnel_stage", "funnel", "remarketing", "copy", "gaze_mode", "seed")
               if draft.get(k) not in empty and not (k == "gaze_mode" and draft[k] == "auto")]
    draft["carried"] = carried
    return draft


def feedback_snapshot(plan: dict, result_metadata: dict | None = None, asset_sha256: str | None = None) -> dict:
    """What is worth remembering about a creative when the user says liked/disliked: the plan-level facts that let a
    later recommender ask "which angles/contexts/compositions does this store approve"."""
    v2 = plan["schema_version"] >= 2
    trace = ((result_metadata or {}).get("trace")) or {}
    references = trace.get("references") or {}
    subjects = [{k: s[k] for k in ("role", "label", "age_band", "is_minor", "product_use", "role_hint")} for s in plan.get("subjects") or []]
    ctx = plan["context"]
    return {
        "creative_id": plan["creative_id"], "plan_id": plan["plan_id"], "plan_schema_version": plan["schema_version"],
        "compiler_version": (plan.get("compiler") or {}).get("version"), "prompt_version": plan["prompt"]["prompt_version"],
        "prompt_sha256": plan["prompt"]["sha256"], "mode": plan.get("mode", "creative"),
        "objective": plan.get("objective") or objective_for(plan["strategy"]), "strategy": plan["strategy"],
        "angle": plan["angle"]["id"], "product_ids": [p["id"] for p in plan["products"]], "subjects": subjects,
        "people_count": len(subjects) if v2 else (1 if plan.get("persona") else 0),
        "context": {k: ctx[k] for k in ("context_id", "context_type", "provider", "scene")}, "placement": plan["placement"]["id"],
        "quality": plan["model"]["quality"], "gaze_mode": plan["scene"]["gaze"]["mode"] if v2 else None,
        "minor_safety_applied": bool(v2 and plan["minor_safety"]["applies"]),
        "flags": {"normalize_references": bool(references.get("normalized")) if trace else None},
        "model": {"requested": trace.get("model_requested") or plan["model"]["model"], "served": trace.get("model_served")},
        "asset_sha256": asset_sha256,
    }
