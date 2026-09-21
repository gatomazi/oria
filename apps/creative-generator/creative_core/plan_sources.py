"""Field -> origin map of the CreativePlan (Fase B, UX rule 9.11).

For every plan field: which sources can give its value and whether the user has to type anything. This is the
contract behind "the interface must not mirror the plan": only the `user: required/optional` rows can become visible
controls; everything else is derived by the planner and, at most, offered as a suggestion the user can accept.

Origins (contracts.VALUE_ORIGINS): user · product · product_enrichment · brand · niche · persona · angle ·
planner_default · safety_policy. A plan also records the origin each field actually had (plan["provenance"]).
`user` values: "required" (nothing else can supply it), "optional" (a default exists), "never" (derived only).
"""
from __future__ import annotations

FIELD_SOURCES: dict[str, dict] = {
    "strategy / objective": {"origins": ["user"], "user": "required", "note": "the type of creative (clean, remarketing, funnel)"},
    "products": {"origins": ["user"], "user": "required", "note": "the product(s) picked"},
    "references": {"origins": ["product"], "user": "never", "note": "the product's reference images, in order"},
    "product.semantic_context": {"origins": ["product", "product_enrichment"], "user": "never", "note": "manual today; proposed by GPT enrichment later, saved only after approval"},
    "brand_kit": {"origins": ["user", "brand"], "user": "optional", "note": "defaults to the store's brand"},
    "niche_kit": {"origins": ["user", "brand", "niche"], "user": "optional", "note": "brand's default niche"},
    "angle": {"origins": ["user", "product_enrichment", "brand", "niche", "planner_default"], "user": "optional", "note": "recommended from the product; the user only changes it"},
    "placement": {"origins": ["user", "planner_default"], "user": "optional", "note": "the store's usual format"},
    "quality": {"origins": ["user", "planner_default"], "user": "never", "note": "advanced"},
    "persona": {"origins": ["user", "brand", "niche", "planner_default"], "user": "optional", "note": "brand/niche pool; custom only on request"},
    "subjects": {"origins": ["persona", "brand", "niche", "product", "product_enrichment", "planner_default", "user"], "user": "optional", "note": "who appears; recommended from the product, changed only in 'Personalizar cena'"},
    "subjects[].age_band / is_minor": {"origins": ["persona", "product", "safety_policy"], "user": "never", "note": "detected from persona label/age and the product type"},
    "scene.gaze": {"origins": ["user", "angle", "planner_default"], "user": "optional", "note": "resolved from the angle and the picked preset; shown as 'Olhar' only when the user customizes"},
    "scene.picks": {"origins": ["planner_default"], "user": "never", "note": "action / photo format / gift scenario, chosen from the seed"},
    "scene.prompt_version": {"origins": ["planner_default"], "user": "never", "note": "wording version of the scene text"},
    "composition (people_count, pose_risk)": {"origins": ["planner_default"], "user": "never", "note": "derived; at most shown as a plain-language warning"},
    "minor_safety.global": {"origins": ["safety_policy"], "user": "never", "note": "always applied when a minor is in the frame; not configurable towards permissive"},
    "minor_safety.brand": {"origins": ["brand"], "user": "never", "note": "the brand's wardrobe policy; only adds restrictions"},
    "semantics (supporting, warnings)": {"origins": ["product", "product_enrichment"], "user": "never", "note": "recommendations respect it; a manual choice can contradict it and only gets a warning"},
    "context": {"origins": ["user", "brand", "niche"], "user": "optional", "note": "automatic from brand/niche; explicit choice in 'Avançado'"},
    "overlay / copy / funnel_stage / remarketing": {"origins": ["user", "planner_default"], "user": "optional", "note": "text on the art and external copy; defaults per objective"},
    "model / size": {"origins": ["planner_default"], "user": "never", "note": "router + placement"},
    "seed": {"origins": ["planner_default"], "user": "never", "note": "new per generation; reused only to regenerate the same scene"},
    "compiler (version, sections)": {"origins": ["planner_default"], "user": "never", "note": "engine/debug only"},
}


def user_input_fields() -> list[str]:
    """The plan fields a user may have to type or pick (required or optional): the ceiling for a visible form."""
    return [k for k, v in FIELD_SOURCES.items() if v["user"] in ("required", "optional")]


def required_user_fields() -> list[str]:
    return [k for k, v in FIELD_SOURCES.items() if v["user"] == "required"]
