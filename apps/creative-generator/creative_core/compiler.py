"""Prompt compiler v2 (Fase B): CreativePlan (schema_version 2) -> CompiledPrompt.

A pure function of the plan: same plan + same COMPILER_VERSION = same text, so a persisted plan can be recompiled and
compared. The prompt is a list of named sections, and every section says which part of the plan fed it and the value it
carries — so "what was the gaze of this creative, and where did it come from" is a lookup, not a search through
thousands of characters:

    {"section": "gaze", "source": "angle", "value": "camera", "length": 74}

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
from .personas import describe_identity
from .planner_v2 import DATA as PLANNER, MINOR
from .products import garment_for_type
from .versions import COMPILER_VERSION

_TEMPLATES = Path(__file__).parent / "templates"
with open(_TEMPLATES / "compiler_v2.json", encoding="utf-8") as _f:
    TEXT: dict = json.load(_f)

SECTION_ORDER = (
    "fidelity_rules", "text_rules", "minor_safety", "reference_roles", "product_semantic_context",
    "people_composition_contract", "gaze", "scene_action", "minor_wardrobe_policy", "strategy_communication",
    "brand", "niche", "context", "avoid", "output_format",
)


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
    return text, plan["provenance"].get("subjects", "planner_default"), str(len(subjects))


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


def compile_prompt(plan: dict) -> dict:
    """CompiledPrompt for a schema_version 2 plan. Raises ValueError for anything else: v1 plans keep the v1 builder."""
    if plan.get("schema_version") != 2:
        raise ValueError("compile_prompt needs a CreativePlan with schema_version 2")
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
    sections, texts = [], []
    for name in SECTION_ORDER:
        text, source, value = builders[name]()
        if not text:
            continue
        texts.append(text)
        sections.append({"section": name, "source": source, "value": value, "length": len(text)})
    text = "\n\n".join(texts)
    return {
        "text": text, "sections": sections, "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "compiler_version": COMPILER_VERSION, "prompt_version": plan["scene"]["prompt_version"],
    }


def prompt_info(compiled: dict) -> dict:
    """The compiled prompt in the PromptInfo shape every consumer of `plan.prompt` already reads (name/length), plus
    the source and value of each section."""
    return {
        "text": compiled["text"],
        "sections": [{"name": s["section"], "length": s["length"], "source": s["source"], "value": s["value"]}
                     for s in compiled["sections"]],
        "sha256": compiled["sha256"], "prompt_version": compiled["prompt_version"],
    }
