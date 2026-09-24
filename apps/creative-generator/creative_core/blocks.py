"""Prompt blocks shared by the v1 prompt builder (engines.plan_creative) and the v2 prompt compiler.

Moved verbatim out of engines.py in Fase B so both paths render the same text from the same code; the golden
matrix (tests/golden/prompt_v1.json) is what proves the move changed nothing.
"""
from __future__ import annotations

import json
from pathlib import Path

from .angles import CORE_ANGLES
from .domain.cabide import REGRA_CENTRALIZACAO_CABIDE
from .personas import describe as describe_persona
from .products import garment_for_type
from .prompt_builder import bullet_block

_TEMPLATES = Path(__file__).parent / "templates"
with open(_TEMPLATES / "communication.json", encoding="utf-8") as _f:
    COMMUNICATION: dict = json.load(_f)


def _product_label(product: dict) -> str:
    return f"\"{product['name']}\" ({product['type']})"


def _product_block(products: list, roles: list) -> str:
    by_product: dict[str, list[int]] = {}
    for role in roles:
        by_product.setdefault(role["product_id"], []).append(role["order"])

    def images(pid: str) -> str:
        orders = by_product[pid]
        return f"imagem {orders[0]}" if len(orders) == 1 else "imagens " + ", ".join(map(str, orders))

    if len(products) == 1:
        p = products[0]
        desc = f" — {p['description']}" if p.get("description") else ""
        extra = (
            "\n  · As imagens de referência mostram o MESMO produto por ângulos diferentes: gere uma única unidade."
            if len(by_product[p["id"]]) > 1 else ""
        )
        return f"PRODUTO (autoridade absoluta sobre qualquer outra regra): {images(p['id'])} = {_product_label(p)}{desc}.{extra}"
    lines = [
        f"  · Produto {i} ({images(p['id'])}): {_product_label(p)}" + (f" — {p['description']}" if p.get("description") else "")
        for i, p in enumerate(products, 1)
    ]
    return (
        f"PRODUTOS (autoridade absoluta), {len(products)} produtos DIFERENTES nesta ordem:\n" + "\n".join(lines)
        + "\n  · Cada produto aparece exatamente uma vez; nunca troque, funda ou duplique produtos."
    )


def _brand_block(brand: dict) -> str:
    parts = [f"MARCA ({brand['name']}):"]
    if brand.get("positioning"):
        parts.append("  · Posicionamento: " + "; ".join(brand["positioning"]) + ".")
    if brand.get("visualStyle"):
        parts.append("  · Linguagem visual: " + ", ".join(brand["visualStyle"]) + ".")
    if brand.get("colors"):
        parts.append("  · Paleta da marca (guia de cor da CENA, nunca do produto): " + "; ".join(brand["colors"]) + ".")
    if brand.get("manualNotes"):
        parts.extend(f"  · {note}" for note in brand["manualNotes"])
    return "\n".join(parts) if len(parts) > 1 else ""


def _niche_block(niche: dict) -> str:
    items = []
    if niche.get("materials"):
        items.append("Materiais e sinais de uso real: " + ", ".join(niche["materials"]) + ".")
    if niche.get("audienceBehaviors"):
        items.append("Público: " + "; ".join(niche["audienceBehaviors"][:3]) + ".")
    return bullet_block(f"NICHO ({niche['name']}):", items)


def _context_block(context: dict, uses_person: bool) -> str:
    element = context.get("supporting_element")
    if uses_person:
        text = f"CONTEXTO DA CENA: {context['scene']}."
        if element:
            text += f" Elemento de apoio, discreto: {element}."
    else:
        text = f"ATMOSFERA (luz, paleta e materiais — não leve o set para este lugar): inspirada em \"{context['scene']}\"."
        if element:
            text += f" Detalhe de apoio: {element}."
    return text + " Contexto coerente e contemporâneo, sem caricatura nem cenário turístico óbvio."


def _angle_block(angle_id: str, products: list, persona: dict | None, people: list, scene: str, apparel: bool) -> str:
    spec = CORE_ANGLES[angle_id]
    multi = len(products) > 1
    template = spec["scene_multi"] if multi else spec["scene"]
    text = template.format(
        produto=_product_label(products[0]),
        produtos="; ".join(_product_label(p) for p in products),
        n=len(products),
        cenario=scene,
        persona=persona["label"] if persona else "uma pessoa",
        pessoas=f"{len(people)} pessoas diferentes ("
        + "; ".join(p["label"] for p in people) + ")" if people else f"{len(products)} pessoas diferentes",
    )
    if angle_id == "CABIDE" and apparel:
        text += REGRA_CENTRALIZACAO_CABIDE
    return text


def _persona_block(persona: dict | None, people: list) -> str:
    if len(people) > 1:
        return bullet_block("PESSOAS (cada uma com 1 produto, na ordem dos produtos):",
                            [f"Pessoa {i}: {describe_persona(p)}" for i, p in enumerate(people, 1)])
    if persona:
        return f"PERSONA: {describe_persona(persona)}. Aparência natural, sem rosto padrão de banco de imagem."
    return ""


def _avoid_block(avoid: list) -> str:
    return ("EVITAR (não incluir na cena, mesmo que outra regra sugira algo parecido): " + "; ".join(avoid) + ".") if avoid else ""


def _core_rules(products: list, stage: str | None, strategy: str) -> tuple[str, bool]:
    rules = list(COMMUNICATION["core_rules"])
    garments = [garment_for_type(p["type"]) for p in products]
    apparel = any(garments)
    for garment in dict.fromkeys(g["regra_preservacao"] for g in garments if g):
        rules.append(garment)
    if apparel:
        rules.extend(COMMUNICATION["apparel_rules"])
    if strategy == "FUNNEL_VISUAL" and stage == "TOFU":
        rules.append(COMMUNICATION["tofu_rule"])
    return "REGRAS OBRIGATÓRIAS (nunca ignore):\n" + "\n".join(f"- {r}" for r in rules), apparel
