"""Prompt compiler v2 (Fase B): CreativePlan (schema_version 2) -> CompiledPrompt.

A pure function of the plan: same plan + same COMPILER_VERSION = same text, so a persisted plan can be recompiled and
compared. The prompt is a list of named sections, and every section says which part of the plan fed it and the value it
carries — so "what was the gaze of this creative, and where did it come from" is a lookup, not a search through
thousands of characters:

    {"section": "gaze", "source": "angle", "value": "camera", "length": 74}

Compiler versions: 1 (Fase B) is frozen and stays compilable, so a stored Fase B plan recompiles byte for byte; 2
(Fase C1) writes the subjects contract with ages and relations, adds the `interaction` section and, for scenes that are
not the angle's own template, an angle `frame`. `compile_prompt` reads the version from the plan (`plan["compiler"]`)
and uses the current one for a plan that has not been compiled yet.

Section order (justified, not the audit's first draft): the absolute rules stay first, as in v1 — fidelity_rules,
text_rules, minor_safety — because they are the ones the model must not lose; then what is in the frame (references,
product meaning, people, gaze, scene, wardrobe), then brand/niche/context, and avoid + output_format last, as in v1.

Wording of the v1 blocks (core rules, product, brand, niche, context, avoid, angle text) is reused from blocks.py; the
person scenes come from prompt_v2/angles_v2.json when the plan asks for scene wording version 2. The v1 PromptBuilder
is untouched and still builds every schema_version 1 plan.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from . import prompt_v2
from .blocks import (
    COMMUNICATION,
    _angle_block,
    _avoid_block,
    _brand_block,
    _context_block,
    _core_rules,
    _niche_block,
    _persona_block,
    _product_block,
    _product_label,
)
from .composition import fold
from .personas import describe_identity
from .planner_v2 import DATA as PLANNER, MINOR
from .products import garment_for_type
from .versions import COMPILER_VERSION, SUPPORTED_COMPILER_VERSIONS

_TEMPLATES = Path(__file__).parent / "templates"
with open(_TEMPLATES / "compiler_v2.json", encoding="utf-8") as _f:
    TEXT: dict = json.load(_f)

SECTION_ORDER = (
    "fidelity_rules", "text_rules", "minor_safety", "reference_roles", "product_semantic_context",
    "people_composition_contract", "gaze", "scene_action", "minor_wardrobe_policy", "strategy_communication",
    "brand", "niche", "context", "avoid", "output_format",
)
# Version 2 adds the interaction, right after the gaze it may imply.
SECTION_ORDER_V2 = (
    "fidelity_rules", "text_rules", "minor_safety", "reference_roles", "product_semantic_context",
    "people_composition_contract", "gaze", "interaction", "scene_action", "minor_wardrobe_policy",
    "strategy_communication", "brand", "niche", "context", "avoid", "output_format",
)
# Version 3 (Fase D.1) adds custom_angle_direction, right after scene_action: the legacy angle's own frame text
# stays the base (compatibility, §1 of the direction), a custom angle's structured definition COMPLEMENTS it —
# never replaces fidelity_rules/text_rules/minor_safety, which stay first as in every version.
SECTION_ORDER_V3 = (
    "fidelity_rules", "text_rules", "minor_safety", "reference_roles", "product_semantic_context",
    "people_composition_contract", "gaze", "interaction", "scene_action", "custom_angle_direction",
    "minor_wardrobe_policy", "strategy_communication", "brand", "niche", "context", "avoid", "output_format",
)


def _custom_angle_direction(plan: dict) -> tuple[str, str, str]:
    """Structured `definition` fields of a custom angle, each its own labeled line, in a fixed order — never a
    free block the model could read as overriding the obligatory rules above it. Empty (no section at all) for
    a system angle or a custom angle with no fields set; NEVER touches fidelity/minor_safety/text_rules, which
    are compiled earlier and are the ones `_core_rules` marks "REGRAS OBRIGATÓRIAS (nunca ignore)"."""
    custom = (plan.get("angle_recommendation") or {}).get("custom_angle")
    if not custom:
        return "", "planner_default", ""
    cfg = TEXT["custom_angle"]
    definition = custom.get("definition") or {}
    lines = [f"{cfg['labels'][field]}: {definition[field]}" for field in
             ("framing", "photographic_direction", "lighting", "composition") if definition.get(field)]
    lines += [f"- {note}" for note in (definition.get("visual_notes") or [])[:6] if note]
    if not lines:
        return "", "planner_default", ""
    text = cfg["header"].format(name=custom["name"]) + "\n" + "\n".join(lines)
    return text, custom["scope"], custom["id"]


def _label_list(values: list, table: dict) -> str:
    return ", ".join(table.get(v, v) for v in values)


def _people_dicts(subjects: list) -> tuple[dict | None, list]:
    personas = [s["persona"] or {"label": s["label"]} for s in subjects]
    return (personas[0] if personas else None), (personas if len(personas) > 1 else [])


def _fidelity(plan: dict) -> tuple[str, str, str]:
    text, _apparel = _core_rules(plan["products"], plan.get("funnel_stage"), plan["strategy"])
    if plan["scene"]["prompt_version"] == 2:
        text = prompt_v2.narrow_model_rule(text, plan["angle"]["id"], len(plan["products"]))
    return text, "product", str(text.count("\n- "))


def _fidelity_v2(plan: dict) -> tuple[str, str, str]:
    """Same rules as v1, with the infant-garment sentence about the scene's MODEL replaced by the rule about who WEARS it."""
    text, _apparel = _core_rules(plan["products"], plan.get("funnel_stage"), plan["strategy"])
    cfg = TEXT["wearer_rules"]
    for rule in cfg["rules"]:
        text = text.replace(rule["old"], rule["new"])
    if cfg["guard"] in text:
        raise ValueError("a garment rule still says the scene's model is always a child; add it to compiler_v2.json wearer_rules")
    return text, "product", str(text.count("\n- "))


def _minor_safety(plan: dict) -> tuple[str, str, str]:
    safety = plan["minor_safety"]
    if not safety["applies"]:
        return "", "safety_policy", ""
    rules = MINOR["global"]["rules"]
    text = MINOR["global"]["header"] + " Sempre: " + "; ".join(r["text"] for r in rules) + "."
    if safety["global"].get("adult_child_rule"):
        text += " " + MINOR["global"]["adult_child_rule"]["text"][0].upper() + MINOR["global"]["adult_child_rule"]["text"][1:] + "."
    return text, "safety_policy", "minors:" + ",".join(safety["minor_subject_ids"])


def _references(plan: dict) -> tuple[str, str, str]:
    return _product_block(plan["products"], plan["references"]), "product", f"refs:{len(plan['references'])}"


def _semantics(plan: dict) -> tuple[str, str, str]:
    cfg = TEXT["semantics"]
    roles, themes, names = PLANNER["roles"], PLANNER["roles"]["theme_labels"], PLANNER["roles"]["role_names"]
    has_supporting = any(s["role"] == "supporting" for s in plan["subjects"])
    lines, all_themes = [], []
    for entry in plan["semantics"]["products"]:
        semantic = entry.get("semantic_context")
        if not semantic:
            continue
        product = next(p for p in plan["products"] if p["id"] == entry["product_id"])
        parts = []
        if semantic.get("relationship_themes"):
            parts.append(cfg["theme"].format(value=_label_list(semantic["relationship_themes"], themes)))
            all_themes += semantic["relationship_themes"]
        if semantic.get("wearer_roles"):
            parts.append(cfg["wearer"].format(value=_label_list(semantic["wearer_roles"], names)))
        if semantic.get("scene_intents"):
            parts.append(cfg["intent"].format(value=_label_list(semantic["scene_intents"], roles["intent_labels"])))
        if semantic.get("recommended_supporting_roles") and has_supporting:  # never ask for a person the frame does not have
            parts.append(cfg["supporting"].format(value=_label_list(semantic["recommended_supporting_roles"], names)))
        if semantic.get("visible_text"):
            parts.append(cfg["visible_text"].format(value="; ".join(f'"{t}"' for t in semantic["visible_text"])))
        lines.append(cfg["line"].format(product=_product_label(product)) + " — " + "; ".join(parts) + ".")
    if not lines:
        return "", "product", ""
    return cfg["header"] + "\n" + "\n".join(lines), plan["provenance"].get("semantics", "product"), ",".join(dict.fromkeys(all_themes))


def _people(plan: dict) -> tuple[str, str, str]:
    subjects = plan["subjects"]
    if not subjects:
        return "", "planner_default", "0"
    cfg = TEXT["people"]
    products = {p["id"]: p for p in plan["products"]}
    gift = plan["angle"]["id"] == prompt_v2.GIFT_ANGLE and plan["scene"]["prompt_version"] == 2 and len(subjects) == 2
    count = cfg["count_one"] if len(subjects) == 1 else cfg["count_many"].format(n=len(subjects))
    lines = []
    for i, subject in enumerate(subjects):
        name = ("Pessoa A", "Pessoa B")[i] if gift else f"Pessoa {i + 1}"
        use = cfg["uses"][subject["product_use"]].format(product=_product_label(products[subject["product_id"]]) if subject["product_id"] else "")
        lines.append(cfg["line"].format(name=name, role=cfg["roles"][subject["role"]], label=subject["label"], use=use))
    contract = cfg["header"].format(count=count) + "\n" + "\n".join(lines)
    persona, people = _people_dicts(subjects)
    apparel_persona = (prompt_v2.persona_block(plan["angle"]["id"], len(plan["products"]), persona, people, describe_identity)
                       if plan["scene"]["prompt_version"] == 2 else _persona_block(persona, people))
    text = contract + ("\n\n" + apparel_persona if apparel_persona else "")
    origin = plan["provenance"].get("subjects", "planner_default")
    return text, origin, str(len(subjects)), (plan.get("provenance_sources") or {}).get("subjects")


def _gaze(plan: dict) -> tuple[str, str, str]:
    gaze = plan["scene"]["gaze"]
    mode = gaze["mode"]
    if mode == "none":
        return "", gaze["source"], "none"
    key = "camera_group" if mode == "camera" and len(plan["subjects"]) > 1 else mode
    return TEXT["gaze"][key], gaze["source"], mode


def _scene(plan: dict) -> tuple[str, str, str]:
    angle_id, products = plan["angle"]["id"], plan["products"]
    apparel = any(garment_for_type(p["type"]) for p in products)
    persona, people = _people_dicts(plan["subjects"])
    if plan["scene"]["prompt_version"] == 2:
        text = prompt_v2.angle_block(
            angle_id, product=_product_label(products[0]), products="; ".join(_product_label(p) for p in products),
            count=len(products), scene=plan["context"]["scene"], apparel=apparel, seed=0, persona=persona, people=people,
            picks=plan["scene"]["picks"])
    else:
        text = _angle_block(angle_id, products, persona, people, plan["context"]["scene"], apparel)
    # The angle's text and the picks the planner made for it (action, photo format, gift scenario) are two origins.
    if plan["scene"]["picks"]:
        return text, "mixed", angle_id, ["angle", "planner_default"]
    return text, "angle", angle_id


def _wardrobe(plan: dict) -> tuple[str, str, str]:
    brand = plan["minor_safety"]["brand"]
    if not brand or not plan["minor_safety"]["applies"]:
        return "", "brand", ""
    cfg, effective = MINOR["brand"], brand["effective"]
    parts = []
    if effective["legs_coverage"] in cfg["legs_coverage"]:
        parts.append(cfg["legs_coverage"][effective["legs_coverage"]])
    if not effective["allow_short_shorts"]:
        parts.append(cfg["no_short_shorts"])
    if not effective["allow_short_skirts"]:
        parts.append(cfg["no_short_skirts"])
    if effective["style"] in cfg["styles"]:
        parts.append(cfg["styles"][effective["style"]])
    if not parts:
        return "", "brand", ""
    return cfg["header"] + " " + "; ".join(parts) + ".", "brand", effective["legs_coverage"]


# ------------------------------------------------------------------ compiler version 2 (Fase C1)
def _name(plan: dict, index: int, count: int) -> str:
    gift = plan["angle"]["id"] == prompt_v2.GIFT_ANGLE and plan["scene"]["prompt_version"] == 2 and count == 2 \
        and plan["scene"]["scene_mode"] == "template"
    return ("Pessoa A", "Pessoa B")[index] if gift else f"Pessoa {index + 1}"


def _people_v2(plan: dict) -> tuple[str, str, str, list | None]:
    """The subjects contract: how many people, and for each one its role, age, relation to the primary and what it
    wears — then, only where a persona says more than its label, a details block. Nothing here is inferred from text."""
    subjects = plan["subjects"]
    if not subjects:
        return "", "planner_default", "0", None
    cfg = TEXT["people"]
    sub = TEXT["subjects"]
    products = {p["id"]: p for p in plan["products"]}
    count = cfg["count_one"] if len(subjects) == 1 else cfg["count_many"].format(n=len(subjects))
    names = [_name(plan, i, len(subjects)) for i in range(len(subjects))]
    lines = []
    for i, subject in enumerate(subjects):
        band = subject["age_band"]
        # The age is printed where it adds something (minors, seniors) and when the label does not already say it;
        # an adult is the default and needs no phrase.
        phrase_age = PLANNER["roles"]["age_phrases"].get(band, "")
        redundant = not phrase_age or band not in PLANNER["roles"]["age_printed_for"] \
            or fold(phrase_age.split(" ")[0]) in fold(subject["label"])
        age = "" if redundant else sub["age"].format(value=phrase_age)
        relation = subject.get("relation_to_primary")
        phrase = ""
        if relation == "custom":
            phrase = sub["relation"].format(value=subject.get("relation_label") or "")
        elif relation:
            phrase = sub["relation"].format(value=PLANNER["roles"]["relation_phrases"][relation].format(ref=names[0]))
        use = cfg["uses"][subject["product_use"]].format(product=_product_label(products[subject["product_id"]]) if subject["product_id"] else "")
        lines.append(sub["line"].format(name=names[i], role=cfg["roles"][subject["role"]], label=subject["label"],
                                        age=age, relation=phrase, use=use))
    contract = sub["header"].format(count=count) + "\n" + "\n".join(lines)
    angle_id = plan["angle"]["id"]
    detail_lines = []
    for i, subject in enumerate(subjects):
        person = subject["persona"] or {}
        identity = "; ".join(person[k] for k in ("appearance", "style", "notes") if person.get(k))
        behavior = prompt_v2.compatible_behavior(angle_id, person.get("behavior") or "") if angle_id in prompt_v2.PROMPT_V2_ANGLES else (person.get("behavior") or "")
        if identity or behavior:
            detail_lines.append(sub["details_line"].format(
                name=names[i], identity=identity or subject["label"],
                behavior=sub["details_behavior"].format(value=behavior) if behavior else ""))
    text = contract + ("\n\n" + sub["details_header"] + "\n" + "\n".join(detail_lines) if detail_lines else "")
    return text, plan["provenance"].get("subjects", "planner_default"), str(len(subjects)), (plan.get("provenance_sources") or {}).get("subjects")


def _interaction(plan: dict) -> tuple[str, str, str, list | None]:
    detail = plan["scene"].get("interaction_detail")
    if not detail:
        return "", "planner_default", "", None
    text = TEXT["interaction"]["line"].format(label=detail["label"], scene=detail["scene"], hands=detail["hands"])
    return text, plan["scene"]["interaction_source"] or "planner_default", detail["id"]


def _scene_v2(plan: dict) -> tuple[str, str, str, list | None]:
    """The angle's own person scene (`template`, Fase B behavior) or an angle frame — the angle's description and the
    setting — leaving the people to the subjects contract and the interaction section."""
    if plan["scene"].get("scene_mode", "template") == "template":
        return _scene(plan)
    angle = plan["angle"]
    frame = TEXT["frames"].get(angle["id"])
    text = frame.format(scene=plan["context"]["scene"]) if frame else TEXT["frame"]["line"].format(
        label=angle["label"].upper(), description=angle["description"], scene=plan["context"]["scene"])
    return text, "angle", angle["id"]


def _builders(plan: dict, version: int) -> dict:
    resolved = plan["resolved_inputs"]
    uses_person = bool(plan["subjects"])
    strategy_text = resolved["strategy"]
    provenance = plan["provenance"]
    builders = {
        "fidelity_rules": lambda: _fidelity(plan),
        "text_rules": lambda: (strategy_text["text_rule"], "user", plan["objective"]),
        "minor_safety": lambda: _minor_safety(plan),
        "reference_roles": lambda: _references(plan),
        "product_semantic_context": lambda: _semantics(plan),
        "people_composition_contract": lambda: _people(plan),
        "gaze": lambda: _gaze(plan),
        "scene_action": lambda: _scene(plan),
        "minor_wardrobe_policy": lambda: _wardrobe(plan),
        "strategy_communication": lambda: (strategy_text["communication"], "user", plan["objective"]),
        "brand": lambda: (_brand_block(resolved["brand"]), "brand", resolved["brand"].get("name", "")),
        "niche": lambda: (_niche_block(resolved["niche"]), "niche", resolved["niche"].get("name", "")),
        "context": lambda: (_context_block(plan["context"], uses_person), provenance.get("context", "niche"), plan["context"]["context_id"]),
        "avoid": lambda: (_avoid_block(plan["context"]["avoid"]), "brand", str(len(plan["context"]["avoid"]))),
        "output_format": lambda: (COMMUNICATION["placements"][plan["placement"]["id"]], "user", plan["placement"]["id"]),
    }
    if version >= 2:
        builders["fidelity_rules"] = lambda: _fidelity_v2(plan)
        builders["people_composition_contract"] = lambda: _people_v2(plan)
        builders["interaction"] = lambda: _interaction(plan)
        builders["scene_action"] = lambda: _scene_v2(plan)
    if version >= 3:
        builders["custom_angle_direction"] = lambda: _custom_angle_direction(plan)
    return builders


def compile_prompt(plan: dict, version: int | None = None) -> dict:
    """CompiledPrompt for a schema_version 2 plan. Raises ValueError for anything else: v1 plans keep the v1 builder.

    The compiler version is the plan's own (`plan["compiler"]["version"]`), so a persisted plan recompiles with the
    compiler that produced it; a plan not compiled yet gets the current version (or the one asked for)."""
    if plan.get("schema_version") != 2:
        raise ValueError("compile_prompt needs a CreativePlan with schema_version 2")
    version = version or (plan.get("compiler") or {}).get("version") or COMPILER_VERSION
    if version not in SUPPORTED_COMPILER_VERSIONS:
        raise ValueError(f"unknown compiler version {version}")
    builders = _builders(plan, version)
    order = SECTION_ORDER_V3 if version >= 3 else (SECTION_ORDER_V2 if version >= 2 else SECTION_ORDER)
    sections, texts = [], []
    for name in order:
        text, source, value, *parts = builders[name]()
        if not text:
            continue
        texts.append(text)
        section = {"section": name, "source": source, "value": value, "length": len(text)}
        if source == "mixed" and parts and parts[0]:
            section["sources"] = list(parts[0])
        sections.append(section)
    text = "\n\n".join(texts)
    return {
        "text": text, "sections": sections, "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "compiler_version": version, "prompt_version": plan["scene"]["prompt_version"],
    }


def prompt_info(compiled: dict) -> dict:
    """The compiled prompt in the PromptInfo shape every consumer of `plan.prompt` already reads (name/length), plus
    the source and value of each section."""
    return {
        "text": compiled["text"],
        "sections": [{"name": s["section"], "length": s["length"], "source": s["source"], "value": s["value"]}
                     for s in compiled["sections"]],  # `sources` of a mixed section lives in plan.compiler.sections
        "sha256": compiled["sha256"], "prompt_version": compiled["prompt_version"],
    }
