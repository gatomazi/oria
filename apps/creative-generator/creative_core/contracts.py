"""Public contracts of the creative core — schema first.

Contracts are declared once as field specs and used for three things:
  1. runtime validation (unknown fields rejected — whitelist strategy);
  2. JSON Schema export (schemas/*.schema.json) for any consumer runtime;
  3. TypeScript declaration export (schemas/contracts.d.ts) for the Oria panel.

Naming: the four interfaces defined verbatim by the Etapa 1 spec (BrandKit,
NicheKit, ContextProfile, CreativeProduct) keep the spec's camelCase. Contracts
created by the core (request, plan, result, history, persona...) use
snake_case, matching the persistence fields listed in the Etapa 2 spec.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .errors import GenerationError

ANGLE_IDS = (
    "IDENTIDADE_ORIGEM", "LIFESTYLE_COTIDIANO", "ORGULHO_DISCRETO", "PERTENCIMENTO",
    "NOSTALGIA_ORIGEM", "CABIDE", "PRODUTO_ESTAMPA", "CAIMENTO", "CLOSE_ESTAMPA",
    "CLOSE_BOLSO", "PREMIUM_ESTILO", "CREATOR_STYLE", "PRESENTE_AFETO",
)
PUBLIC_STRATEGIES = ("CLEAN_ANGLES", "REMARKETING", "FUNNEL_VISUAL")
INTERNAL_STRATEGIES = (
    "FUNNEL_VISUAL", "STATE_COLLECTION", "REMARKETING", "CLEAN_ANGLES", "MULTI_PRODUCT_INTERNAL", "ORGANIC",
)
PRODUCT_MODES = ("single_product", "multi_product")
PUBLIC_PLACEMENTS = ("FEED_4X5", "STORY_9X16")
FUNNEL_STAGES = ("TOFU", "MOFU", "BOFU")
REMARKETING_INTENTS = (
    "site_visitor", "product_view", "collection_discovery", "cart", "checkout", "social_proof", "objection",
)
CONTEXT_TYPES = ("geographic", "niche", "custom", "bond", "neutral")
CONTEXT_MODES = ("automatic", "geographic", "niche", "custom")
CONTEXT_PROVIDERS = ("geographic", "niche", "custom")
PROFILE_STATUS = ("draft", "approved", "rejected")
QUALITIES = ("low", "medium", "high")
TEXT_DENSITIES = ("minimal", "balanced", "commercial")
CTA_EMPHASES = ("subtle", "medium", "strong")
CLEAN_MODES = ("auto", "always", "never")
PRODUCTS_SOURCES = ("catalog", "basket")
PERSONA_MODES = ("automatic", "custom", "none")
PERSONA_SOURCES = ("automatic", "custom")
RESULT_STATUS = ("completed", "failed")
REFERENCE_ROLES = ("product_art", "layout_only")
MAX_PRODUCTS = 6

# --- Fase B (CreativePlan v2). All additive: a v1 plan/request stays valid and unchanged.
PLAN_SCHEMA_VERSIONS = (1, 2)
# The gaze the caller may ask for. `auto` is a REQUEST value only: the planner resolves it to a concrete mode
# (GAZE_RESOLVED) before the prompt is compiled — it never means "let the image model decide".
GAZE_MODES = ("camera", "interaction", "off_camera", "product", "auto")
GAZE_RESOLVED = ("camera", "interaction", "off_camera", "product", "none")
# Where the value of a plan field came from (see plan_sources.py for the field -> origin map).
VALUE_ORIGINS = ("user", "product", "product_enrichment", "brand", "niche", "persona", "angle", "planner_default", "safety_policy")
# Aggregate marker for a composed section whose parts come from different origins (never a leaf origin).
MIXED_ORIGIN = "mixed"
# Fase C: finer bands. `child` (no range) stays valid: it is what Fase B plans stored and what word-only evidence yields.
AGE_BANDS = ("baby", "child", "child_3_5", "child_6_9", "child_10_12", "teen", "adult", "senior", "unknown")
MINOR_BANDS = ("baby", "child", "child_3_5", "child_6_9", "child_10_12", "teen")
# How a supporting person relates to the PRIMARY subject ("mother" = this subject is the primary's mother).
RELATION_TYPES = ("mother", "father", "daughter", "son", "sibling", "partner", "friend", "grandparent", "custom")
MAX_SUBJECTS = 4
COMPOSITION_SOURCES = ("explicit", "recommended", "legacy")
SCENE_MODES = ("template", "frame")
LEGS_COVERAGES = ("full", "knee", "default")
POSE_RISKS = ("low", "medium", "high")
PRODUCT_USES = ("wears", "uses", "none")
SUBJECT_ROLES = ("primary", "supporting")
SUBJECT_PROMINENCE = ("hero", "secondary", "background")
PLAN_MODES = ("creative",)
OBJECTIVES = ("clean_creative", "remarketing", "funnel_visual")
FEEDBACK_VERDICTS = ("liked", "disliked")


@dataclass(frozen=True)
class F:
    """Field spec. `type` is one of string/integer/number/boolean/object/array/ref/map."""

    type: str
    required: bool = False
    nullable: bool = False
    enum: tuple | None = None
    items: "F | None" = None
    ref: str | None = None
    minimum: float | None = None
    maximum: float | None = None
    min_items: int | None = None
    max_items: int | None = None
    min_length: int | None = None
    max_length: int | None = None
    description: str = ""


def S(**kw) -> F:
    return F("string", **kw)


def I(**kw) -> F:
    return F("integer", **kw)


def B(**kw) -> F:
    return F("boolean", **kw)


def N(**kw) -> F:
    return F("number", **kw)


def A(items: F, **kw) -> F:
    return F("array", items=items, **kw)


def R(ref: str, **kw) -> F:
    return F("ref", ref=ref, **kw)


def O(**kw) -> F:
    """Free-form object (Record<string, unknown>)."""
    return F("object", **kw)


def M(**kw) -> F:
    """Map of string -> string."""
    return F("map", **kw)


STR_LIST = A(S(max_length=500), max_items=100)
ID = S(required=True, min_length=1, max_length=120)

CONTRACTS: dict[str, dict[str, F]] = {
    "Persona": {
        "id": S(max_length=120),
        "label": S(required=True, min_length=1, max_length=200),
        "age_range": S(max_length=80),
        "appearance": S(max_length=1000),
        "style": S(max_length=1000),
        "behavior": S(max_length=1000),
        "notes": S(max_length=1000),
        "source": S(enum=PERSONA_SOURCES),
        "age_band": S(enum=AGE_BANDS),  # structured age; preferred over guessing from the label (Fase C)
    },
    # The brand's wardrobe preference for minors. It can only ADD restrictions to the global minor policy:
    # `allow_revealing_clothing` is accepted for the shape but has no effect (the global layer forbids it).
    "MinorWardrobePolicy": {
        "enabled": B(),
        "legs_coverage": S(enum=LEGS_COVERAGES),
        "allow_short_shorts": B(),
        "allow_short_skirts": B(),
        "allow_revealing_clothing": B(),
        "style": S(max_length=60),
    },
    "BrandKit": {
        "id": ID,
        "name": S(required=True, min_length=1, max_length=200),
        "description": S(max_length=2000),
        "positioning": STR_LIST,
        "audience": STR_LIST,
        "tone": STR_LIST,
        "visualStyle": STR_LIST,
        "colors": STR_LIST,
        "typographyNotes": STR_LIST,
        "preferredContexts": STR_LIST,
        "avoid": STR_LIST,
        "manualNotes": STR_LIST,
        "enabledAngles": A(S(enum=ANGLE_IDS)),
        "angleLabels": M(),
        "headlineStyle": STR_LIST,
        "ctaStyle": STR_LIST,
        "strategyRules": O(),
        "defaultNicheKitId": S(max_length=120),
        "defaultContextProvider": S(enum=CONTEXT_PROVIDERS),
        "suggestedPersonas": A(R("Persona"), max_items=50),
        "minorWardrobePolicy": R("MinorWardrobePolicy"),
        "schemaVersion": I(required=True, minimum=1),
        "version": I(required=True, minimum=1),
    },
    "NicheKit": {
        "id": ID,
        "name": S(required=True, min_length=1, max_length=200),
        "audienceBehaviors": STR_LIST,
        "commonUsageScenarios": STR_LIST,
        "activities": STR_LIST,
        "sceneContexts": STR_LIST,
        "materials": STR_LIST,
        "visualCliches": STR_LIST,
        "avoid": STR_LIST,
        "recommendedAngles": A(S(enum=ANGLE_IDS)),
        "strategyRules": O(),
        "angleLabels": M(),
        "productTypes": STR_LIST,
        "supportsApparelAngles": B(),
        "suggestedPersonas": A(R("Persona"), max_items=50),
        "schemaVersion": I(required=True, minimum=1),
        "version": I(required=True, minimum=1),
    },
    "ContextSubject": {
        "name": S(required=True, min_length=1, max_length=200),
        "metadata": O(),
    },
    "ContextProfile": {
        "contextId": ID,
        "contextType": S(required=True, enum=CONTEXT_TYPES),
        "subject": R("ContextSubject", required=True),
        "summary": S(max_length=2000),
        "sceneContexts": STR_LIST,
        "visualSignatures": STR_LIST,
        "activities": STR_LIST,
        "materials": STR_LIST,
        "environment": STR_LIST,
        "domainElements": STR_LIST,
        "avoid": STR_LIST,
        "sources": STR_LIST,
        "confidence": N(minimum=0, maximum=1),
        "status": S(required=True, enum=PROFILE_STATUS),
        "schemaVersion": I(required=True, minimum=1),
        "promptVersion": I(required=True, minimum=1),
        "profileVersion": I(required=True, minimum=1),
    },
    # What the print/product MEANS for the scene (Fase B leaves the space typed; nothing fills it automatically yet —
    # the GPT enrichment that proposes it is a later phase and never saves without approval).
    "ProductSemanticContext": {
        "wearer_roles": A(S(min_length=1, max_length=40), max_items=10),
        "relationship_themes": A(S(min_length=1, max_length=40), max_items=10),
        "recommended_supporting_roles": A(S(min_length=1, max_length=40), max_items=10),
        "incompatible_auto_supporting_roles": A(S(min_length=1, max_length=40), max_items=10),
        "scene_intents": A(S(min_length=1, max_length=40), max_items=10),
        "visible_text": A(S(min_length=1, max_length=200), max_items=10),
        "source": S(enum=("manual", "enrichment")),
        "confidence": N(minimum=0, maximum=1),
    },
    "CreativeProduct": {
        "id": ID,
        "brandId": S(max_length=120),
        "name": S(required=True, min_length=1, max_length=200),
        "type": S(required=True, min_length=1, max_length=120),
        "description": S(max_length=2000),
        "referenceImages": A(S(min_length=1, max_length=500), required=True, min_items=1, max_items=4),
        "metadata": O(),
        "semantic_context": R("ProductSemanticContext"),
    },
    "Angle": {
        "id": S(required=True, enum=ANGLE_IDS),
        "label": S(required=True),
        "description": S(),
        "uses_person": B(required=True),
        "apparel_only": B(required=True),
        "multi_product_limit": I(required=True, minimum=1),
    },
    "Placement": {
        "id": S(required=True, enum=PUBLIC_PLACEMENTS),
        "label": S(required=True),
        "width": I(required=True),
        "height": I(required=True),
        "api_size": S(required=True),
    },
    "ContextSelection": {
        "mode": S(required=True, enum=CONTEXT_MODES),
        "profile": R("ContextProfile"),
        "subject": R("ContextSubject"),
        "context_id": S(max_length=120),
    },
    "RemarketingOptions": {
        "intent": S(required=True, enum=REMARKETING_INTENTS),
        "products_source": S(enum=PRODUCTS_SOURCES),
        "stage_override": S(enum=FUNNEL_STAGES),
        "text_density": S(enum=TEXT_DENSITIES),
        "cta_emphasis": S(enum=CTA_EMPHASES),
        "clean_mode": S(enum=CLEAN_MODES),
        "headline": S(max_length=120),
        "subheadline": S(max_length=200),
        "cta": S(max_length=60),
        "benefits": A(S(max_length=80), max_items=3),
        "social_proof_facts": A(S(max_length=200), max_items=5),
    },
    "FunnelOptions": {
        "headline": S(max_length=120),
        "subheadline": S(max_length=200),
        "cta": S(max_length=60),
        "badges": A(S(max_length=40), max_items=3),
        "benefits": A(S(max_length=80), max_items=3),
        "search_bar_text": S(max_length=80),
        "chips": A(S(max_length=40), max_items=6),
        "text_density": S(enum=TEXT_DENSITIES),
        "cta_emphasis": S(enum=CTA_EMPHASES),
        "clean_mode": B(),
    },
    "CopyOptions": {
        "generate": B(required=True),
        "funnel_stages": A(S(enum=FUNNEL_STAGES), max_items=3),
    },
    "HistoryHints": {
        "recent_scenes": A(S(max_length=500), max_items=50),
        "recent_personas": A(S(max_length=200), max_items=50),
    },
    # One person of the scene as the caller states it (Fase C). Optional: without `subjects` the planner recommends a
    # composition (from the product's semantics) or falls back to the persona alone. Nothing here is required.
    "RequestSubject": {
        "id": S(min_length=1, max_length=20),
        "role": S(enum=SUBJECT_ROLES),
        "persona": R("Persona", required=True),
        "age_band": S(enum=AGE_BANDS),
        "relation_to_primary": S(enum=RELATION_TYPES),
        "relation_label": S(max_length=60),  # the free text of a `custom` relation
        # absent = the planner assigns; null = explicitly wears nothing; an id = wears/uses that product
        "wears_product_id": S(nullable=True, max_length=120),
        "prominence": S(enum=SUBJECT_PROMINENCE),
    },
    "CreativeRequest": {
        "creative_id": S(max_length=120),
        "strategy": S(required=True, enum=PUBLIC_STRATEGIES),
        "product_mode": S(required=True, enum=PRODUCT_MODES),
        "products": A(R("CreativeProduct"), required=True, min_items=1, max_items=MAX_PRODUCTS),
        "brand_kit": R("BrandKit"),
        "brand_kit_id": S(max_length=120),
        "niche_kit": R("NicheKit"),
        "niche_kit_id": S(max_length=120),
        "angle_id": S(required=True, enum=ANGLE_IDS),
        "placement_id": S(required=True, enum=PUBLIC_PLACEMENTS),
        "persona_mode": S(enum=PERSONA_MODES),
        "persona": R("Persona"),
        "context": R("ContextSelection"),
        "funnel_stage": S(enum=FUNNEL_STAGES),
        "remarketing": R("RemarketingOptions"),
        "funnel": R("FunnelOptions"),
        "copy": R("CopyOptions"),
        "quality": S(enum=QUALITIES),
        "seed": I(minimum=0),
        "history_hints": R("HistoryHints"),
        "prompt_version": I(minimum=1, maximum=2),
        # Fase B: 2 builds a CreativePlan v2 and compiles it with the v2 compiler; default 1 = the v1 builder.
        "plan_schema_version": I(minimum=1, maximum=2),
        "gaze_mode": S(enum=GAZE_MODES),
        # Fase C: explicit composition. `interaction` is an id of templates/interactions.json (validated by the planner,
        # so the catalog can grow without a schema change); `scene_picks` replays the exact pool entries of an earlier plan.
        "subjects": A(R("RequestSubject"), max_items=MAX_SUBJECTS),
        "interaction": S(min_length=1, max_length=40),
        "scene_picks": O(),
    },
    "KitRef": {
        "id": S(required=True),
        "version": I(required=True),
    },
    "ResolvedContext": {
        "context_id": S(required=True),
        "context_type": S(required=True, enum=CONTEXT_TYPES),
        "provider": S(required=True),
        "scene": S(required=True),
        "supporting_element": S(nullable=True),
        "avoid": A(S()),
        "status": S(required=True, enum=PROFILE_STATUS),
        "profile_version": I(required=True),
    },
    "OverlaySpec": {
        "allowed": B(required=True),
        "headline": S(nullable=True),
        "subheadline": S(nullable=True),
        "cta": S(nullable=True),
        "badges": A(S()),
        "benefits": A(S()),
        "search_bar_text": S(nullable=True),
        "chips": A(S()),
        "text_density": S(nullable=True, enum=TEXT_DENSITIES),
        "cta_emphasis": S(nullable=True, enum=CTA_EMPHASES),
        "clean": B(required=True),
    },
    "ReferenceRole": {
        "ref": S(required=True),
        "product_id": S(required=True),
        "role": S(required=True, enum=REFERENCE_ROLES),
        "order": I(required=True, minimum=1),
    },
    "PromptSection": {
        "name": S(required=True),
        "length": I(required=True),
        # v2 compiler only: which part of the plan fed the section and its resolved value (inspectable).
        "source": S(),
        "value": S(),
    },
    "PromptInfo": {
        "text": S(required=True),
        "sections": A(R("PromptSection"), required=True),
        "sha256": S(required=True),
        "prompt_version": I(required=True),
    },
    "ModelSelection": {
        "task": S(required=True),
        "model": S(required=True),
        "quality": S(required=True, enum=QUALITIES),
        "size": S(required=True),
    },
    "ValidationCheck": {
        "rule": S(required=True),
        "passed": B(required=True),
    },
    "PlanSubject": {
        "id": S(required=True, min_length=1, max_length=20),
        "role": S(required=True, enum=SUBJECT_ROLES),
        "label": S(required=True, min_length=1, max_length=300),
        "persona": O(nullable=True),
        "age_band": S(required=True, enum=AGE_BANDS),
        "is_minor": B(required=True),
        "minor_source": S(nullable=True),
        "age_source": S(nullable=True),  # where the age band was read from (any age, not only minors)
        "product_use": S(required=True, enum=PRODUCT_USES),
        "product_id": S(nullable=True),
        "role_hint": S(nullable=True),
        "relation_to_primary": S(nullable=True, enum=RELATION_TYPES),  # to the primary; null for the primary itself
        "relation_label": S(nullable=True),
        "prominence": S(required=True, enum=SUBJECT_PROMINENCE),
        "source": S(required=True, enum=VALUE_ORIGINS),
    },
    "GazeResolution": {
        "mode": S(required=True, enum=GAZE_RESOLVED),
        "requested": S(required=True, enum=GAZE_MODES),
        "source": S(required=True, enum=VALUE_ORIGINS),
        "reason": S(required=True),
    },
    "PlanScene": {
        "gaze": R("GazeResolution", required=True),
        "picks": O(required=True),  # pool -> {"index", "text"}: the choices the image model used to make on its own
        "prompt_version": I(required=True),  # wording version of the scene text (1 generic, 2 person scenes)
        "interaction": S(nullable=True),  # id in templates/interactions.json; null when there is none
        "interaction_source": S(nullable=True, enum=VALUE_ORIGINS),
        "interaction_detail": O(nullable=True),  # the catalog entry as resolved, so the plan recompiles on its own
        "scene_mode": S(enum=SCENE_MODES),  # template = the angle's own person scene; frame = angle frame + subjects + interaction
        "composition_source": S(enum=COMPOSITION_SOURCES),  # who decided the cast: the request, the planner from the product, or the legacy persona
    },
    "PlanComposition": {
        "people_count": I(required=True, minimum=0),
        "pose_risk": S(required=True, enum=POSE_RISKS),
        "risk_reasons": A(S(), required=True),
    },
    "MinorSafety": {
        "applies": B(required=True),
        "minor_subject_ids": A(S(), required=True),
        "global": O(required=True),  # {policy, version, rules[], adult_child_rule|null}
        "brand": O(nullable=True),  # {policy, source, requested, effective, ignored[]} — null when the brand set none
        "basis": O(),  # {"explicit": [subject ids whose age was declared], "heuristic": [ids inferred from text/product]}
    },
    "PlanSemantics": {
        "products": A(O(), required=True),  # [{product_id, semantic_context|null}]
        "supporting": O(nullable=True),  # {role, source, matched_role|null} when a supporting person was cast
        "warnings": A(O(), required=True),  # [{code, theme, supporting_role, product_id}] — informative, never blocking
    },
    "ResolvedInputs": {
        "brand": O(required=True),
        "niche": O(required=True),
        "strategy": O(required=True),  # {text_rule, communication}
    },
    "CompilerSection": {
        "section": S(required=True),
        "source": S(required=True),  # an origin, or `mixed` when `sources` lists the parts
        "sources": A(S()),  # only for a `mixed` section: the distinct origins behind it
        "value": S(required=True),
        "length": I(required=True, minimum=0),
    },
    "CompilerInfo": {
        "version": I(required=True, minimum=1),
        "sections": A(R("CompilerSection"), required=True),
    },
    "CreativePlan": {
        "plan_id": S(required=True),
        "creative_id": S(required=True),
        "schema_version": I(required=True),
        "strategy": S(required=True, enum=PUBLIC_STRATEGIES),
        "internal_strategy_id": S(required=True),
        "product_mode": S(required=True, enum=PRODUCT_MODES),
        "products": A(R("CreativeProduct"), required=True, min_items=1),
        "angle": R("Angle", required=True),
        "placement": R("Placement", required=True),
        "persona": R("Persona", nullable=True),
        "context": R("ResolvedContext", required=True),
        "brand_kit": R("KitRef", required=True),
        "niche_kit": R("KitRef", required=True),
        "funnel_stage": S(nullable=True, enum=FUNNEL_STAGES),
        "remarketing_intent": S(nullable=True, enum=REMARKETING_INTENTS),
        "layout": S(nullable=True),
        "overlay": R("OverlaySpec", required=True),
        "copy": R("CopyOptions", required=True),
        "references": A(R("ReferenceRole"), required=True),
        "prompt": R("PromptInfo", required=True),
        "model": R("ModelSelection", required=True),
        "versions": O(required=True),
        "validations": A(R("ValidationCheck"), required=True),
        "warnings": A(S(), required=True),
        # --- schema_version 2 only (all optional, so a v1 plan is unchanged) ---
        "mode": S(enum=PLAN_MODES),
        "objective": S(enum=OBJECTIVES),
        "subjects": A(R("PlanSubject")),
        "scene": R("PlanScene"),
        "composition": R("PlanComposition"),
        "minor_safety": R("MinorSafety"),
        "semantics": R("PlanSemantics"),
        "provenance": M(),  # plan field -> origin (VALUE_ORIGINS, or `mixed` for a composed section)
        "provenance_sources": O(),  # aggregate field -> the distinct origins behind it, e.g. {"subjects": ["persona", "product"]}
        "resolved_inputs": R("ResolvedInputs"),
        "compiler": R("CompilerInfo"),
        "seed": I(nullable=True, minimum=0),  # the seed the plan was built with: same request + seed = same plan
    },
    "CompiledPrompt": {
        "text": S(required=True),
        "sections": A(R("CompilerSection"), required=True),
        "sha256": S(required=True),
        "compiler_version": I(required=True, minimum=1),
        "prompt_version": I(required=True),
    },
    # Input of the generator rebuilt from a persisted plan ("Copiar Dados"). Not a CreativeRequest: it mirrors what
    # the user chose (ids and options), never execution ids.
    "GenerationDraft": {
        "mode": S(required=True, enum=PLAN_MODES),
        "objective": S(required=True, enum=OBJECTIVES),
        "strategy": S(required=True, enum=PUBLIC_STRATEGIES),
        "product_mode": S(required=True, enum=PRODUCT_MODES),
        "product_ids": A(S(), required=True),
        "angle_id": S(required=True),
        "placement_id": S(required=True),
        "quality": S(required=True, enum=QUALITIES),
        "brand_kit": R("KitRef", required=True),
        "niche_kit": R("KitRef", required=True),
        "persona_mode": S(required=True, enum=PERSONA_MODES),
        "persona": O(nullable=True),
        "subjects": A(R("PlanSubject"), required=True),
        "context": O(required=True),  # {mode, context_id, provider, scene}
        "funnel_stage": S(nullable=True),
        "remarketing": O(nullable=True),
        "funnel": O(nullable=True),
        "copy": R("CopyOptions", required=True),
        "gaze_mode": S(required=True, enum=GAZE_MODES),
        "plan_schema_version": I(required=True, minimum=1),
        "prompt_version": I(required=True, minimum=1),
        "seed": I(nullable=True),
        "carried": A(S(), required=True),  # names of the fields brought over, for the "what came along" summary
        "source": O(required=True),  # {creative_id, plan_id, plan_schema_version, compiler_version}
    },
    # What is worth remembering about a creative when the user marks liked/disliked. The panel adds who/where/when
    # (organization_id, store_id, job_id, user_id, verdict, timestamp) — those are not plan facts.
    "FeedbackSnapshot": {
        "creative_id": S(required=True),
        "plan_id": S(required=True),
        "plan_schema_version": I(required=True, minimum=1),
        "compiler_version": I(nullable=True),
        "prompt_version": I(required=True),
        "prompt_sha256": S(required=True),
        "mode": S(required=True, enum=PLAN_MODES),
        "objective": S(required=True, enum=OBJECTIVES),
        "strategy": S(required=True),
        "angle": S(required=True),
        "product_ids": A(S(), required=True),
        "subjects": A(O(), required=True),  # [{role, label, age_band, is_minor, product_use, role_hint}]
        "people_count": I(required=True, minimum=0),
        "context": O(required=True),  # {context_id, context_type, provider, scene}
        "placement": S(required=True),
        "quality": S(nullable=True),
        "gaze_mode": S(nullable=True),
        "minor_safety_applied": B(required=True),
        "flags": O(required=True),  # {normalize_references, ...} read from the result trace when there is one
        "model": O(required=True),  # {requested, served}
        "asset_sha256": S(nullable=True),
    },
    "GenerationError": {
        "code": S(required=True),
        "message": S(required=True),
        "retryable": B(required=True),
        "cause": S(required=True),
        "details": O(),
    },
    "AssetInfo": {
        "mime_type": S(required=True),
        "width": I(required=True),
        "height": I(required=True),
        "byte_size": I(required=True),
        "sha256": S(required=True),
        "data_base64": S(required=True),
    },
    "CreativeResult": {
        "creative_id": S(required=True),
        "plan_id": S(required=True),
        "status": S(required=True, enum=RESULT_STATUS),
        "generation_attempt": I(required=True, minimum=1),
        "asset": R("AssetInfo", nullable=True),
        "metadata": O(required=True),
        "versions": O(required=True),
        "error": R("GenerationError", nullable=True),
        "created_at": S(required=True),
    },
    "CopyVariant": {
        "funnel_stage": S(required=True, enum=FUNNEL_STAGES),
        "primary_text": S(required=True),
        "headline": S(required=True),
        "description": S(required=True),
    },
    "GenerationRecord": {
        "creative_id": S(required=True),
        "strategy": S(required=True),
        "internal_strategy_id": S(nullable=True),
        "product_mode": S(nullable=True),
        "product_ids": A(S(), nullable=True),
        "angle": S(nullable=True),
        "context": S(nullable=True),
        "persona": S(nullable=True),
        "placement": S(nullable=True),
        "brand_kit": S(nullable=True),
        "niche_kit": S(nullable=True),
        "funnel_stage": S(nullable=True),
        "remarketing_intent": S(nullable=True),
        "quality": S(nullable=True),
        "asset": S(nullable=True),
        "schema_version": I(nullable=True),
        "prompt_version": I(nullable=True),
        "brand_kit_version": I(nullable=True),
        "niche_kit_version": I(nullable=True),
        "context_profile_version": I(nullable=True),
        "strategy_version": I(nullable=True),
        "core_version": S(nullable=True),
        "extra": O(nullable=True),
        "created_at": S(required=True),
    },
}

# Contracts whose schema file is exported (sub-objects are embedded via $defs).
EXPORTED_CONTRACTS = (
    "BrandKit", "NicheKit", "ContextProfile", "CreativeProduct", "Persona", "Angle", "Placement",
    "CreativeRequest", "CreativePlan", "CreativeResult", "GenerationError", "GenerationRecord", "CopyVariant",
    "CompiledPrompt", "GenerationDraft", "FeedbackSnapshot",
)

_PY_TYPES = {
    "string": str, "integer": int, "number": (int, float), "boolean": bool, "object": dict, "map": dict,
    "array": list,
}


def _check(spec: F, value: Any, path: str, errors: list[str]) -> None:
    if value is None:
        if not spec.nullable:
            errors.append(f"{path}: must not be null")
        return
    if spec.type == "ref":
        _validate_object(spec.ref or "", value, path, errors)
        return
    expected = _PY_TYPES[spec.type]
    # bool is a subclass of int — reject it where a number is expected.
    if isinstance(value, bool) and spec.type in ("integer", "number"):
        errors.append(f"{path}: expected {spec.type}")
        return
    if not isinstance(value, expected):
        errors.append(f"{path}: expected {spec.type}")
        return
    if spec.enum is not None and value not in spec.enum:
        errors.append(f"{path}: value not allowed")
    if spec.type == "string":
        if spec.min_length is not None and len(value) < spec.min_length:
            errors.append(f"{path}: too short")
        if spec.max_length is not None and len(value) > spec.max_length:
            errors.append(f"{path}: too long")
    if spec.type in ("integer", "number"):
        if spec.minimum is not None and value < spec.minimum:
            errors.append(f"{path}: below minimum")
        if spec.maximum is not None and value > spec.maximum:
            errors.append(f"{path}: above maximum")
    if spec.type == "array":
        if spec.min_items is not None and len(value) < spec.min_items:
            errors.append(f"{path}: too few items")
        if spec.max_items is not None and len(value) > spec.max_items:
            errors.append(f"{path}: too many items")
        for i, item in enumerate(value):
            _check(spec.items, item, f"{path}[{i}]", errors)  # type: ignore[arg-type]
    if spec.type == "map":
        for k, v in value.items():
            if not isinstance(k, str) or not isinstance(v, str):
                errors.append(f"{path}: map entries must be string -> string")
                break


def _validate_object(name: str, payload: Any, path: str, errors: list[str]) -> None:
    fields = CONTRACTS[name]
    if not isinstance(payload, dict):
        errors.append(f"{path or name}: expected object")
        return
    for key in payload:
        if key not in fields:
            # Whitelist: unknown fields are rejected, never silently carried along.
            errors.append(f"{path + '.' if path else ''}{key}: unknown field")
    for key, spec in fields.items():
        field_path = f"{path + '.' if path else ''}{key}"
        if key not in payload:
            if spec.required:
                errors.append(f"{field_path}: required")
            continue
        _check(spec, payload[key], field_path, errors)


def validate(name: str, payload: Any) -> list[str]:
    """Returns a list of error strings (field paths + reason, never values)."""
    if name not in CONTRACTS:
        raise KeyError(name)
    errors: list[str] = []
    _validate_object(name, payload, "", errors)
    return errors


def ensure_valid(name: str, payload: Any, code: str = "INVALID_INPUT") -> dict:
    errors = validate(name, payload)
    if errors:
        raise GenerationError(code, {"contract": name, "errors": errors[:50]})
    return payload


# ------------------------------------------------------------------ export
def _schema_for(spec: F) -> dict:
    if spec.type == "ref":
        base: dict = {"$ref": f"#/$defs/{spec.ref}"}
    elif spec.type == "object":
        base = {"type": "object", "additionalProperties": True}
    elif spec.type == "map":
        base = {"type": "object", "additionalProperties": {"type": "string"}}
    elif spec.type == "array":
        base = {"type": "array", "items": _schema_for(spec.items)}  # type: ignore[arg-type]
        if spec.min_items is not None:
            base["minItems"] = spec.min_items
        if spec.max_items is not None:
            base["maxItems"] = spec.max_items
    else:
        base = {"type": spec.type}
        if spec.enum is not None:
            base["enum"] = list(spec.enum)
        if spec.min_length is not None:
            base["minLength"] = spec.min_length
        if spec.max_length is not None:
            base["maxLength"] = spec.max_length
        if spec.minimum is not None:
            base["minimum"] = spec.minimum
        if spec.maximum is not None:
            base["maximum"] = spec.maximum
    if spec.nullable:
        return {"anyOf": [base, {"type": "null"}]}
    return base


def _refs(name: str, seen: set[str]) -> None:
    if name in seen:
        return
    seen.add(name)
    for spec in CONTRACTS[name].values():
        cur: F | None = spec
        while cur is not None:
            if cur.type == "ref" and cur.ref:
                _refs(cur.ref, seen)
            cur = cur.items


def _object_schema(name: str) -> dict:
    fields = CONTRACTS[name]
    return {
        "type": "object",
        "additionalProperties": False,
        "required": [k for k, f in fields.items() if f.required],
        "properties": {k: _schema_for(f) for k, f in fields.items()},
    }


def json_schema(name: str) -> dict:
    from .versions import SCHEMA_VERSION

    deps: set[str] = set()
    _refs(name, deps)
    deps.discard(name)
    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": f"creative-core/v{SCHEMA_VERSION}/{name}.schema.json",
        "title": name,
        **_object_schema(name),
    }
    if deps:
        schema["$defs"] = {d: _object_schema(d) for d in sorted(deps)}
    return schema


def _ts_type(spec: F) -> str:
    if spec.type == "ref":
        t = spec.ref or "unknown"
    elif spec.type == "object":
        t = "Record<string, unknown>"
    elif spec.type == "map":
        t = "Record<string, string>"
    elif spec.type == "array":
        inner = _ts_type(spec.items)  # type: ignore[arg-type]
        t = f"Array<{inner}>"
    elif spec.enum is not None:
        t = " | ".join(json.dumps(v) for v in spec.enum)
    else:
        t = {"string": "string", "integer": "number", "number": "number", "boolean": "boolean"}[spec.type]
    return f"{t} | null" if spec.nullable else t


def typescript_declarations() -> str:
    from .versions import CORE_VERSION, SCHEMA_VERSION

    lines = [
        "// Generated by creative_core.contracts.export_all — do not edit by hand.",
        f"// core_version {CORE_VERSION} · schema_version {SCHEMA_VERSION}",
        "",
        f"export type ProductMode = {' | '.join(json.dumps(m) for m in PRODUCT_MODES)};",
        f"export type PublicStrategy = {' | '.join(json.dumps(m) for m in PUBLIC_STRATEGIES)};",
        f"export type AngleId = {' | '.join(json.dumps(m) for m in ANGLE_IDS)};",
        "",
    ]
    for name, fields in CONTRACTS.items():
        lines.append(f"export interface {name} {{")
        for key, spec in fields.items():
            opt = "" if spec.required else "?"
            lines.append(f"  {key}{opt}: {_ts_type(spec)};")
        lines.append("}")
        lines.append("")
    return "\n".join(lines)


def export_all(target: Path | None = None) -> list[Path]:
    target = target or Path(__file__).parent / "schemas"
    target.mkdir(parents=True, exist_ok=True)
    written = []
    for name in EXPORTED_CONTRACTS:
        path = target / f"{name}.schema.json"
        path.write_text(json.dumps(json_schema(name), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        written.append(path)
    ts = target / "contracts.d.ts"
    ts.write_text(typescript_declarations(), encoding="utf-8")
    written.append(ts)
    return written


if __name__ == "__main__":
    for p in export_all():
        print(p)
