"""Public engines of the core: CLEAN_ANGLES, REMARKETING, FUNNEL_VISUAL.

    plan_creative(request)            -> CreativePlan    (pure, deterministic, no provider call)
    generate_creative(plan, client)   -> CreativeResult  (one provider call, never raises)
    generate_copy(request, client)    -> list[CopyVariant]

Multi-product is `product_mode` inside each engine, never a separate engine.
The internal strategies (app.py) keep their own prompt banks; these engines
use the product-agnostic templates in creative_core/templates/.
"""
from __future__ import annotations

import copy
import hashlib
import io
import json
import mimetypes
import time
import uuid
from pathlib import Path

from .domain.cabide import REGRA_CENTRALIZACAO_CABIDE
from .domain.remarketing import (
    CLEAN_AUTO,
    CLEAN_NUNCA,
    CLEAN_SEMPRE,
    ESPEC_LAYOUT,
    LAYOUTS_POR_ANGULO,
    LAYOUTS_SEM_PESSOA,
    bloco_cta,
    bloco_prova_social,
    bloco_texto_criativo,
    clean_ativo,
    layouts_permitidos,
    perfil_texto,
    resolver_etapa,
)

from . import model_router as mr
from .angles import CORE_ANGLES, angle_descriptor, angle_is_available
from .assets import asset_from_provider_b64
from .context_intelligence import GeographicContextProvider, deterministic_pick, resolve_context
from .contracts import ensure_valid, validate
from .errors import GenerationError, classify_provider_exception
from .history import utc_now
from .kits import kit_ref, resolve_kits
from .personas import describe as describe_persona
from .personas import persona_pool, resolve_persona
from .placements import placement_descriptor
from .products import garment_for_type, validate_products
from .prompt_builder import PromptBuilder, bullet_block
from .references import reference_roles, sniff_mime
from .rules import CLEAN_ANGLES_FORBIDDEN_OVERLAY
from .strategies import (
    MULTI_PRODUCT_RULES,
    REMARKETING_BASKET_INTENTS,
    internal_id,
    product_limits,
    strategy_version,
)
from .versions import PROMPT_VERSION, SCHEMA_VERSION, version_manifest

_TEMPLATES = Path(__file__).parent / "templates"
with open(_TEMPLATES / "communication.json", encoding="utf-8") as _f:
    COMMUNICATION: dict = json.load(_f)

MAX_REFERENCE_IMAGES = 10
_CLEAN_MODE_MAP = {"auto": CLEAN_AUTO, "always": CLEAN_SEMPRE, "never": CLEAN_NUNCA}


# ------------------------------------------------------------------ helpers
def _seed(request: dict) -> int:
    if isinstance(request.get("seed"), int):
        return request["seed"]
    digest = hashlib.sha256(json.dumps(request, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    return int(digest[:8], 16)


def _plan_id(request: dict) -> str:
    digest = hashlib.sha256(json.dumps(request, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    return f"plan_{digest[:24]}"


def _product_label(product: dict) -> str:
    return f"\"{product['name']}\" ({product['type']})"


def _people(n: int, pool: list, seed: int, first: dict | None) -> list[dict]:
    people = [first] if first else []
    rotation = [p for p in pool if not first or p.get("label") != first.get("label")] or pool
    i = 0
    while len(people) < n and rotation:
        people.append(rotation[(seed + i) % len(rotation)])
        i += 1
    return people[:n]


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


# ------------------------------------------------------------------ remarketing
def _choose_remarketing_layout(angle_id: str, intent: str, n: int, basket: bool, apparel: bool, seed: int) -> tuple[str, list[str]]:
    warnings: list[str] = []
    allowed = list(layouts_permitidos(intent))
    if basket and n > 1:
        allowed += [l for l in COMMUNICATION["remarketing"]["basket_layouts"] if l not in allowed]
    if not apparel:
        allowed = [l for l in allowed if l not in COMMUNICATION["remarketing"]["apparel_layouts"]]

    def fits(layout: str) -> bool:
        low, high = ESPEC_LAYOUT[layout]["produtos"]
        return low <= n <= high

    rmk_angle = CORE_ANGLES[angle_id]["remarketing_angle"]
    preferred = [l for l in LAYOUTS_POR_ANGULO.get(rmk_angle, ()) if l in allowed and fits(l)]
    if not preferred:
        preferred = [l for l in allowed if fits(l)]
        if preferred:
            warnings.append("layout_fallback_angle_not_compatible")
    if not preferred:
        raise GenerationError("PRODUCT_COUNT_OUT_OF_RANGE", {"intent": intent, "products": n})
    return deterministic_pick(preferred, seed), warnings


def _remarketing_parts(request: dict, products: list, angle: dict, apparel: bool, seed: int):
    opts = request["remarketing"]
    intent = opts["intent"]
    n = len(products)
    basket = opts.get("products_source") == "basket"
    if request["product_mode"] == "multi_product":
        rule = MULTI_PRODUCT_RULES["REMARKETING"]
        if intent in rule["singleOnlyIntents"]:
            raise GenerationError("UNSUPPORTED_PRODUCT_MODE", {"intent": intent, "reason": "single_product_intent"})
        if intent in REMARKETING_BASKET_INTENTS and not basket:
            raise GenerationError("UNSUPPORTED_PRODUCT_MODE", {"intent": intent, "reason": "requires_products_source_basket"})
    layout, warnings = _choose_remarketing_layout(angle["id"], intent, n, basket, apparel, seed)
    stage = resolver_etapa(intent, opts.get("stage_override"))
    rmk_angle = CORE_ANGLES[angle["id"]]["remarketing_angle"]
    clean = clean_ativo(_CLEAN_MODE_MAP[opts.get("clean_mode", "auto")], rmk_angle, stage)
    profile = perfil_texto(stage, intent, clean, opts.get("text_density"), opts.get("cta_emphasis"))
    defaults = COMMUNICATION["remarketing"]["intents"][intent]
    texts = {
        "headline": opts.get("headline") or defaults["headline"],
        "subheadline": opts.get("subheadline") or defaults["subheadline"],
        "cta": opts.get("cta") or defaults["cta"],
    }
    benefits = list(opts.get("benefits") or [])
    layout_text = COMMUNICATION["remarketing"]["layouts"][layout].format(
        n=n, n_apoios=max(n - 1, 1), n_restantes=max(n - 1, 1),
    )
    parts = [COMMUNICATION["remarketing"]["direction"], layout_text]
    if intent == "social_proof":
        parts.append(bloco_prova_social(opts.get("social_proof_facts")))
    parts.append(bloco_texto_criativo(texts, profile, benefits))
    parts.append(bloco_cta(profile["enfase"]))
    overlay = {
        "allowed": True,
        "headline": texts["headline"],
        "subheadline": texts["subheadline"] if profile["subheadline"] else None,
        "cta": texts["cta"] or None,
        "badges": [],
        "benefits": benefits[: profile["max_beneficios"]],
        "search_bar_text": None,
        "chips": [],
        "text_density": profile["densidade"],
        "cta_emphasis": profile["enfase"],
        "clean": clean,
    }
    people_needed = 0 if layout in LAYOUTS_SEM_PESSOA else ESPEC_LAYOUT[layout]["pessoas"][0] if n == 1 else n
    return {
        "stage": stage, "intent": intent, "layout": layout, "overlay": overlay,
        "communication": "\n\n".join(p for p in parts if p), "warnings": warnings,
        "people_needed": people_needed, "text_rule": COMMUNICATION["text_rule"],
    }


# ------------------------------------------------------------------ funnel
def _funnel_parts(request: dict, products: list):
    stage = request.get("funnel_stage")
    if not stage:
        raise GenerationError("INVALID_INPUT", {"errors": ["funnel_stage: required for FUNNEL_VISUAL"]})
    opts = request.get("funnel") or {}
    clean = bool(opts.get("clean_mode"))
    profile = perfil_texto(stage, "", clean, opts.get("text_density"), opts.get("cta_emphasis"))
    defaults = COMMUNICATION["funnel"]["defaults"][request["product_mode"]][stage]
    texts = {
        "headline": opts.get("headline") or defaults["headline"],
        "subheadline": opts.get("subheadline") or defaults["subheadline"],
        "cta": opts.get("cta") or defaults["cta"],
    }
    benefits = list(opts.get("benefits") or [])
    badges = list(opts.get("badges") or []) if stage != "TOFU" and not clean else []
    chips = list(opts.get("chips") or []) if stage != "TOFU" and not clean else []
    search = opts.get("search_bar_text") if stage != "TOFU" and not clean else None
    extras_cfg = COMMUNICATION["funnel"]["extras"]
    extras = []
    if badges:
        extras.append(extras_cfg["badges"].format(itens=" | ".join(f'"{b}"' for b in badges)))
    if search:
        extras.append(extras_cfg["search_bar"].format(texto=search))
    if chips:
        extras.append(extras_cfg["chips"].format(itens=" | ".join(f'"{c}"' for c in chips)))
    parts = [
        COMMUNICATION["funnel"]["stages"][stage],
        bloco_texto_criativo(texts, profile, benefits),
        "\n".join(extras),
        bloco_cta(profile["enfase"]) if texts["cta"] else "",
    ]
    overlay = {
        "allowed": True,
        "headline": texts["headline"],
        "subheadline": texts["subheadline"] if profile["subheadline"] and texts["subheadline"] else None,
        "cta": texts["cta"] or None,
        "badges": badges,
        "benefits": benefits[: profile["max_beneficios"]],
        "search_bar_text": search,
        "chips": chips,
        "text_density": profile["densidade"],
        "cta_emphasis": profile["enfase"],
        "clean": clean,
    }
    return {"stage": stage, "overlay": overlay, "communication": "\n\n".join(p for p in parts if p),
            "text_rule": COMMUNICATION["text_rule"]}


# ------------------------------------------------------------------ plan
def plan_creative(
    request: dict,
    *,
    router: mr.ModelRouter | None = None,
    geographic: GeographicContextProvider | None = None,
) -> dict:
    """Validates a CreativeRequest and returns a CreativePlan. Raises GenerationError."""
    ensure_valid("CreativeRequest", request)
    request = copy.deepcopy(request)
    router = router or mr.ModelRouter()
    strategy = request["strategy"]
    product_mode = request["product_mode"]
    products = request["products"]
    seed = _seed(request)
    warnings: list[str] = []

    brand, niche = resolve_kits(request)

    limits = product_limits(strategy, product_mode)
    product_errors = validate_products(products, product_mode, limits)
    if product_errors:
        raise GenerationError(product_errors[0], {"product_mode": product_mode, "limits": limits, "received": len(products)})
    roles = reference_roles(products)
    if len(roles) > MAX_REFERENCE_IMAGES:
        raise GenerationError("INVALID_REFERENCE", {"reason": "too_many_reference_images", "max": MAX_REFERENCE_IMAGES})

    angle_id = request["angle_id"]
    if not angle_is_available(angle_id, brand, niche):
        raise GenerationError("UNSUPPORTED_ANGLE", {"angle_id": angle_id, "brand_kit": brand["id"], "niche_kit": niche["id"]})
    angle = angle_descriptor(angle_id, brand, niche)
    if product_mode == "multi_product" and len(products) > angle["multi_product_limit"]:
        warnings.append(f"above_recommended_products_for_angle:{angle['multi_product_limit']}")

    stage = request.get("funnel_stage")
    _, apparel = _core_rules(products, stage, strategy)
    if strategy == "CLEAN_ANGLES":
        if request.get("funnel") or request.get("remarketing"):
            # Clean angles never accept overlay options — the funnel lives in the copy.
            raise GenerationError("INVALID_INPUT", {"errors": ["CLEAN_ANGLES does not accept funnel/remarketing overlay options"]})
        engine = {"stage": stage, "overlay": {
            "allowed": False, "headline": None, "subheadline": None, "cta": None, "badges": [], "benefits": [],
            "search_bar_text": None, "chips": [], "text_density": None, "cta_emphasis": None, "clean": True,
        }, "communication": "", "text_rule": COMMUNICATION["clean_angles_rule"]}
        people_needed = len(products) if angle["uses_person"] and len(products) > 1 else int(angle["uses_person"])
        intent, layout = None, None
    elif strategy == "REMARKETING":
        if not request.get("remarketing"):
            raise GenerationError("INVALID_INPUT", {"errors": ["remarketing: required for REMARKETING"]})
        if request.get("funnel"):
            raise GenerationError("INVALID_INPUT", {"errors": ["funnel: not accepted by REMARKETING"]})
        engine = _remarketing_parts(request, products, angle, apparel, seed)
        warnings += engine["warnings"]
        stage, intent, layout = engine["stage"], engine["intent"], engine["layout"]
        people_needed = engine["people_needed"]
    else:
        if request.get("remarketing"):
            raise GenerationError("INVALID_INPUT", {"errors": ["remarketing: not accepted by FUNNEL_VISUAL"]})
        engine = _funnel_parts(request, products)
        stage, intent, layout = engine["stage"], None, None
        people_needed = len(products) if angle["uses_person"] and len(products) > 1 else int(angle["uses_person"])

    core_rules, apparel = _core_rules(products, stage, strategy)
    hints = request.get("history_hints") or {}
    context, _profile = resolve_context(
        request.get("context"), brand_kit=brand, niche_kit=niche, products=products, angle=angle,
        seed=seed, recent_scenes=hints.get("recent_scenes"), geographic=geographic,
    )
    if (request.get("context") or {"mode": "automatic"}).get("mode") == "automatic" \
            and brand.get("defaultContextProvider") == "geographic" and context["provider"] == "niche":
        # Never guessed: an unresolved city falls back to the niche context, visibly.
        warnings.append("geographic_context_unresolved_used_niche_context")
    uses_person = people_needed > 0
    persona = resolve_persona(
        request.get("persona_mode", "automatic"), request.get("persona"), brand_kit=brand, niche_kit=niche,
        seed=seed, recent_labels=hints.get("recent_personas"), uses_person=uses_person,
    )
    people = _people(people_needed, persona_pool(brand, niche), seed, persona) if people_needed > 1 else []

    builder = PromptBuilder(ordered=True, separator="\n\n")
    builder.add("core_rules", core_rules)
    builder.add("strategy_rules", engine["text_rule"])
    builder.add("brand_kit", _brand_block(brand))
    builder.add("niche_kit", _niche_block(niche))
    builder.add("context_profile", _context_block(context, uses_person))
    builder.add("product", _product_block(products, roles))
    builder.add("angle", _angle_block(angle_id, products, persona, people, context["scene"], apparel))
    builder.add("persona", _persona_block(persona, people))
    builder.add("placement", COMMUNICATION["placements"][request["placement_id"]])
    builder.add("strategy_communication", engine["communication"])
    builder.add("avoid", _avoid_block(context["avoid"]))
    prompt = builder.info(PROMPT_VERSION)

    overlay = engine["overlay"]
    validations = [
        {"rule": "product_count_within_limits", "passed": True},
        {"rule": "angle_available_for_brand_and_niche", "passed": True},
        {"rule": "context_profile_approved", "passed": context["status"] == "approved"},
        {"rule": "references_are_product_art_only", "passed": all(r["role"] == "product_art" for r in roles)},
    ]
    if strategy == "CLEAN_ANGLES":
        overlay_free = not overlay["allowed"] and not any(
            overlay[k] for k in ("headline", "subheadline", "cta", "badges", "benefits", "search_bar_text", "chips")
        )
        comm_free = not engine["communication"] and not any(
            f"· {term.upper()}:" in prompt["text"] for term in CLEAN_ANGLES_FORBIDDEN_OVERLAY
        )
        validations.append({"rule": "clean_angles_has_no_overlay", "passed": overlay_free and comm_free})
    if strategy == "FUNNEL_VISUAL":
        validations.append({"rule": "funnel_stage_in_image", "passed": bool(stage)})
    if strategy == "REMARKETING":
        validations.append({"rule": "remarketing_multi_product_allowed_for_intent", "passed": True})

    if context["status"] != "approved":
        raise GenerationError("CONTEXT_RESOLUTION_FAILED", {"reason": "context_not_approved"})

    copy_opts = request.get("copy") or {"generate": False}
    copy_plan = {"generate": bool(copy_opts.get("generate")),
                 "funnel_stages": list(copy_opts.get("funnel_stages") or ([stage] if stage else ["TOFU", "MOFU", "BOFU"]))}

    plan = {
        "plan_id": _plan_id(request),
        "creative_id": request.get("creative_id") or str(uuid.uuid4()),
        "schema_version": SCHEMA_VERSION,
        "strategy": strategy,
        "internal_strategy_id": internal_id(strategy),
        "product_mode": product_mode,
        "products": products,
        "angle": angle,
        "placement": placement_descriptor(request["placement_id"]),
        "persona": persona,
        "context": context,
        "brand_kit": kit_ref(brand),
        "niche_kit": kit_ref(niche),
        # CLEAN_ANGLES: the funnel stage belongs to the external copy, never to the image.
        "funnel_stage": None if strategy == "CLEAN_ANGLES" else stage,
        "remarketing_intent": intent,
        "layout": layout,
        "overlay": overlay,
        "copy": copy_plan,
        "references": roles,
        "prompt": prompt,
        "model": {
            "task": mr.IMAGE_GENERATION,
            "model": router.model_for(mr.IMAGE_GENERATION),
            "quality": request.get("quality", "medium"),
            "size": placement_descriptor(request["placement_id"])["api_size"],
        },
        "versions": {**version_manifest(), "strategy_version": strategy_version(strategy),
                     "brand_kit_version": brand["version"], "niche_kit_version": niche["version"],
                     "context_profile_version": context["profile_version"]},
        "validations": validations,
        "warnings": warnings,
    }
    if not all(v["passed"] for v in validations):
        raise GenerationError("PROMPT_BUILD_FAILED", {"failed": [v["rule"] for v in validations if not v["passed"]]})
    ensure_valid("CreativePlan", plan, code="PROMPT_BUILD_FAILED")
    return plan


# ------------------------------------------------------------------ generate
def usage_from_response(response) -> dict | None:
    """Token usage of one provider call, as a plain dict — the only basis for a real cost number.

    Without this the panel can only guess what a creative cost. Both `responses.create` and
    `images.edit` (gpt-image-*) report usage in the same shape, so one reader serves the two.

    Never raises and never fails a generation: usage is accounting, and an image that was produced
    and paid for must not be discarded because the provider omitted a counter. Absent usage comes
    back as None, which the panel shows as "sem medição" rather than as zero — zero would quietly
    understate the bill.
    """
    usage = getattr(response, "usage", None)
    if usage is None:
        return None
    if not isinstance(usage, dict):
        usage = getattr(usage, "model_dump", None) and usage.model_dump() or {
            k: getattr(usage, k, None) for k in ("input_tokens", "output_tokens", "total_tokens")
        }
    out = {}
    for campo in ("input_tokens", "output_tokens", "total_tokens"):
        valor = usage.get(campo)
        if isinstance(valor, int):
            out[campo] = valor
    # A entrada não tem preço único: no gpt-image-2 o token de imagem custa mais caro que o de
    # texto, e token em cache custa menos que os dois. Somar tudo como "entrada" erra o custo para
    # cima ou para baixo dependendo da mistura, então cada fatia vem separada.
    detalhes = usage.get("input_tokens_details")
    if isinstance(detalhes, dict):
        for origem, destino in (
            ("cached_tokens", "cached_input_tokens"),
            ("text_tokens", "text_input_tokens"),
            ("image_tokens", "image_input_tokens"),
        ):
            valor = detalhes.get(origem)
            if isinstance(valor, int):
                out[destino] = valor
    return out or None


def _result(
    plan: dict,
    attempt: int,
    asset: dict | None,
    error: GenerationError | None,
    now: str | None,
    usage: dict | None = None,
    trace: dict | None = None,
) -> dict:
    return {
        "creative_id": plan.get("creative_id", ""),
        "plan_id": plan.get("plan_id", ""),
        "status": "completed" if asset else "failed",
        "generation_attempt": attempt,
        "asset": asset,
        "metadata": {
            "strategy": plan.get("strategy"),
            "internal_strategy_id": plan.get("internal_strategy_id"),
            "product_mode": plan.get("product_mode"),
            "product_ids": [p.get("id") for p in plan.get("products", [])],
            "angle": (plan.get("angle") or {}).get("id"),
            "placement": (plan.get("placement") or {}).get("id"),
            "funnel_stage": plan.get("funnel_stage"),
            "remarketing_intent": plan.get("remarketing_intent"),
            "layout": plan.get("layout"),
            "context_id": (plan.get("context") or {}).get("context_id"),
            "persona": (plan.get("persona") or {}).get("label"),
            "brand_kit": plan.get("brand_kit"),
            "niche_kit": plan.get("niche_kit"),
            "model": (plan.get("model") or {}).get("model"),
            "quality": (plan.get("model") or {}).get("quality"),
            "prompt_sha256": (plan.get("prompt") or {}).get("sha256"),
            # Consumo real cobrado pelo provedor. None quando ele não reportou — ver usage_from_response.
            "usage": usage,
            # What actually happened in the provider call (see generation_trace). None only when the
            # caller passed no trace; generate_creative always does.
            "trace": trace,
        },
        "versions": plan.get("versions", {}),
        "error": error.to_dict() if error else None,
        "created_at": now or utc_now(),
    }


TRACE_VERSION = 1


def _new_trace(plan: dict, router: mr.ModelRouter, attempt: int) -> dict:
    """Skeleton of the generation trace. Purely observational and never raises: it is built before
    the plan is validated, so it must survive a malformed plan."""
    plan = plan if isinstance(plan, dict) else {}
    model = plan.get("model") if isinstance(plan.get("model"), dict) else {}
    prompt = plan.get("prompt") if isinstance(plan.get("prompt"), dict) else {}
    text = prompt.get("text") if isinstance(prompt.get("text"), str) else ""
    return {
        "trace_version": TRACE_VERSION,
        "attempt": attempt,
        "model_requested": router.model_for(mr.IMAGE_GENERATION),
        "model_served": None,
        "models_tried": [],
        "params": {"size": model.get("size"), "quality": model.get("quality")},
        "prompt": {"sha256": prompt.get("sha256"), "version": prompt.get("prompt_version"), "length": len(text)},
        "references": {"count": 0, "items": []},
        "provider_request_id": None,
        "provider_ms": None,
        "duration_ms": None,
        "outcome": None,
        "error_code": None,
    }


def _reference_trace(order: int, data: bytes, sent_name: str) -> dict:
    """One reference as it went out: what the bytes really are, and what they were announced as.
    The two differ when the original is JPEG/WebP but is sent under a `.png` name."""
    declared = mimetypes.guess_type(sent_name)[0]
    return {
        "order": order,
        "original_mime": sniff_mime(data),
        "sent_name": sent_name,
        "sent_mime": declared,
        "sent_actual_mime": sniff_mime(data),
        "original_bytes": len(data),
        "sent_bytes": len(data),
    }


def _finish_trace(trace: dict, started: float, err: GenerationError | None) -> dict:
    trace["duration_ms"] = int((time.monotonic() - started) * 1000)
    trace["outcome"] = "failed" if err else "completed"
    trace["error_code"] = err.code if err else None
    trace["references"]["count"] = len(trace["references"]["items"])
    return trace


def generate_creative(
    plan: dict,
    *,
    client,
    references: dict[str, bytes],
    router: mr.ModelRouter | None = None,
    attempt: int = 1,
    now: str | None = None,
) -> dict:
    """Runs one image generation for a plan. `client` must expose
    `images.edit(model, image, prompt, size, quality)` (OpenAI SDK shape) and is
    created by the caller with the tenant's credential. `references` maps each
    plan reference ref to its image bytes. Never raises: failures come back as a
    `failed` CreativeResult with a safe GenerationError."""
    router = router or mr.ModelRouter()
    # Fora do try: uma chamada que já foi cobrada precisa sobreviver ao caminho de erro, senão o
    # painel subestima a fatura justamente nas gerações que falharam depois de gastar.
    usage = None
    started = time.monotonic()
    trace = _new_trace(plan, router, attempt)
    try:
        errors = validate("CreativePlan", plan)
        if errors:
            raise GenerationError("INVALID_INPUT", {"contract": "CreativePlan", "errors": errors[:20]})
        images = []
        for role in plan["references"]:
            data = references.get(role["ref"])
            if not data:
                raise GenerationError("INVALID_REFERENCE", {"ref_order": role["order"], "reason": "missing_bytes"})
            buf = io.BytesIO(data)
            buf.name = f"reference_{role['order']}.png"
            images.append(buf)
            trace["references"]["items"].append(_reference_trace(role["order"], data, buf.name))

        def call(model: str):
            return client.images.edit(
                model=model, image=images, prompt=plan["prompt"]["text"],
                size=plan["model"]["size"], quality=plan["model"]["quality"],
            )

        provider_started = time.monotonic()
        try:
            response, served = router.run_traced(mr.IMAGE_GENERATION, call, trace["models_tried"])
        except GenerationError:
            raise
        except Exception as exc:  # noqa: BLE001 — provider errors are classified, never echoed
            raise classify_provider_exception(exc) from None
        finally:
            trace["provider_ms"] = int((time.monotonic() - provider_started) * 1000)
        trace["model_served"] = served
        request_id = getattr(response, "_request_id", None)
        if isinstance(request_id, str) and 0 < len(request_id) <= 120:
            trace["provider_request_id"] = request_id
        # Lido ANTES de processar o asset: a chamada já foi cobrada neste ponto, e falha no
        # processamento não deve apagar o registro de um gasto que existiu.
        usage = usage_from_response(response)
        try:
            b64 = response.data[0].b64_json
            asset = asset_from_provider_b64(b64, plan["placement"]["width"], plan["placement"]["height"])
        except Exception:  # noqa: BLE001
            raise GenerationError("ASSET_PROCESSING_FAILED") from None
        return _result(plan, attempt, asset, None, now, usage, _finish_trace(trace, started, None))
    except GenerationError as err:
        return _result(plan if isinstance(plan, dict) else {}, attempt, None, err, now, usage, _finish_trace(trace, started, err))


# ------------------------------------------------------------------ copy
def build_copy_prompt(request: dict, stages: list[str] | None = None) -> str:
    ensure_valid("CreativeRequest", request)
    brand, niche = resolve_kits(request)
    stages = stages or list((request.get("copy") or {}).get("funnel_stages") or ["TOFU", "MOFU", "BOFU"])
    products = "; ".join(_product_label(p) for p in request["products"])
    stage_rules = "\n".join(f"- {s}: {COMMUNICATION['copy']['stages'][s]}" for s in stages)
    tone = ", ".join(brand.get("tone") or []) or "claro e direto"
    return (
        "Você escreve copies de anúncio para Meta Ads em português do Brasil.\n"
        f"Marca: {brand['name']}. Tom: {tone}.\n"
        + (f"Evitar: {'; '.join(brand.get('avoid') or [])}.\n" if brand.get("avoid") else "")
        + f"Nicho: {niche['name']}.\nProduto(s): {products}.\n"
        f"Ângulo criativo da imagem: {angle_descriptor(request['angle_id'], brand, niche)['label']}.\n"
        f"Etapas:\n{stage_rules}\n"
        "Regras: sem urgência falsa, sem prova social inventada, sem preço ou desconto que não tenha sido informado. "
        "A headline é do anúncio, não da imagem.\n"
        "Responda SOMENTE com JSON no formato "
        '{"variants": [{"funnel_stage": "TOFU", "primary_text": "...", "headline": "...", "description": "..."}]}, '
        "uma variante por etapa."
    )


def generate_copy_with_usage(
    request: dict, *, client, router: mr.ModelRouter | None = None
) -> tuple[list[dict], dict | None]:
    """Same as generate_copy, but also reports what the call consumed.

    A copy call is cheap next to an image, yet it is billed on every generation — leaving it out
    would make the panel's total quietly low. Kept as a separate entry point so `generate_copy`
    keeps its shape for callers that do not do accounting."""
    router = router or mr.ModelRouter()
    prompt = build_copy_prompt(request)
    try:
        response = router.run(mr.COPY, lambda model: client.responses.create(model=model, input=prompt))
    except Exception as exc:  # noqa: BLE001
        raise classify_provider_exception(exc) from None
    usage = usage_from_response(response)
    text = getattr(response, "output_text", "") or ""
    start, end = text.find("{"), text.rfind("}")
    try:
        variants = json.loads(text[start:end + 1])["variants"]
    except (ValueError, KeyError, TypeError):
        raise GenerationError("GENERATION_FAILED", {"reason": "copy_unparseable"}) from None
    valid = [v for v in variants if isinstance(v, dict) and not validate("CopyVariant", v)]
    if not valid:
        raise GenerationError("GENERATION_FAILED", {"reason": "copy_invalid"})
    return valid, usage


def generate_copy(request: dict, *, client, router: mr.ModelRouter | None = None) -> list[dict]:
    """External ad copy (primary_text / headline / description) per funnel stage.
    Raises GenerationError with a safe message on provider or parsing failure."""
    variants, _ = generate_copy_with_usage(request, client=client, router=router)
    return variants
