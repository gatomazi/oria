"""Products shared by the strategies.

Two layers:
  * CreativeProduct (contracts.py) — the generic, public product contract. It
    never assumes a t-shirt: `type` is free text and the core only reads the
    garment catalog below when the product type matches one of its entries.
  * PECAS — the apparel catalog used by the internal strategies and by the
    `fashion` niche. Moved verbatim from app.py in Etapa 1 (grammar agreement,
    preservation rule per garment).
"""
from __future__ import annotations

PECAS = {
    "Camiseta (Algodão Normal)": {
        "tipo_peca": "camiseta", "tipo_peca_cap": "Camiseta",
        "tipo_peca_plural": "camisetas", "tipo_peca_plural_cap": "Camisetas",
        "artigo_peca": "a", "artigo_indef_peca": "uma",
        "peca_dobrada": "dobrada", "peca_pendurada": "pendurada", "peca_dobradas_pl": "dobradas",
        "regra_preservacao": (
            "Preserve o TIPO DE PEÇA original: camiseta de MANGA CURTA, gola redonda, "
            "tecido de algodão comum (não premium). NUNCA transforme em manga longa, "
            "moletom, camisa de botão ou qualquer outra peça — mesmo que o cenário "
            "sugira frio, a peça continua sendo camiseta de manga curta (a pessoa pode "
            "usar um casaco/jaqueta POR CIMA se o clima pedir, mas a camiseta em si "
            "nunca muda de manga)."
        ),
    },
    "Camiseta (Algodão Peruano Premium)": {
        "tipo_peca": "camiseta", "tipo_peca_cap": "Camiseta",
        "tipo_peca_plural": "camisetas", "tipo_peca_plural_cap": "Camisetas",
        "artigo_peca": "a", "artigo_indef_peca": "uma",
        "peca_dobrada": "dobrada", "peca_pendurada": "pendurada", "peca_dobradas_pl": "dobradas",
        "regra_preservacao": (
            "Preserve o TIPO DE PEÇA original: camiseta de MANGA CURTA, gola redonda, "
            "tecido de algodão peruano premium. NUNCA transforme em manga longa, moletom, "
            "camisa de botão ou qualquer outra peça — mesmo que o cenário sugira frio, a "
            "peça continua sendo camiseta de manga curta (a pessoa pode usar um "
            "casaco/jaqueta POR CIMA se o clima pedir, mas a camiseta em si nunca muda de manga)."
        ),
    },
    "Regata": {
        "tipo_peca": "regata", "tipo_peca_cap": "Regata",
        "tipo_peca_plural": "regatas", "tipo_peca_plural_cap": "Regatas",
        "artigo_peca": "a", "artigo_indef_peca": "uma",
        "peca_dobrada": "dobrada", "peca_pendurada": "pendurada", "peca_dobradas_pl": "dobradas",
        "regra_preservacao": (
            "Preserve o TIPO DE PEÇA original: regata SEM MANGA (ombros e braços à mostra), "
            "gola redonda ou careca. NUNCA adicione mangas — mesmo em cenário frio, a peça "
            "continua sendo regata (a pessoa pode usar um casaco/jaqueta por cima se quiser, "
            "mas a peça em si nunca ganha manga)."
        ),
    },
    "Camiseta Oversized": {
        "tipo_peca": "camiseta oversized", "tipo_peca_cap": "Camiseta oversized",
        "tipo_peca_plural": "camisetas oversized", "tipo_peca_plural_cap": "Camisetas oversized",
        "artigo_peca": "a", "artigo_indef_peca": "uma",
        "peca_dobrada": "dobrada", "peca_pendurada": "pendurada", "peca_dobradas_pl": "dobradas",
        "regra_preservacao": (
            "Preserve o TIPO DE PEÇA original: camiseta OVERSIZED — manga curta mas corte "
            "LARGO e SOLTO (não ajustado ao corpo), comprimento levemente mais longo que uma "
            "camiseta comum. NUNCA aperte o corte nem transforme em peça ajustada ao corpo."
        ),
    },
    "Body Infantil": {
        "tipo_peca": "body infantil", "tipo_peca_cap": "Body infantil",
        "tipo_peca_plural": "bodies infantis", "tipo_peca_plural_cap": "Bodies infantis",
        "artigo_peca": "o", "artigo_indef_peca": "um",
        "peca_dobrada": "dobrado", "peca_pendurada": "pendurado", "peca_dobradas_pl": "dobrados",
        "regra_preservacao": (
            "Preserve o TIPO DE PEÇA original: body infantil (roupa de bebê) com manga curta, "
            "gola tipo envelope nos ombros, fechamento por botões de pressão na parte inferior "
            "(entre as pernas). O MODELO da cena é SEMPRE um bebê ou criança pequena, NUNCA "
            "um adulto. Elementos culturais/objetos de adulto (ex: cuia de mate) NÃO devem "
            "ficar nas mãos do bebê — podem aparecer só discretamente no cenário ao fundo, "
            "se fizer sentido."
        ),
    },
    "Suéter Moletom": {
        "tipo_peca": "moletom", "tipo_peca_cap": "Moletom",
        "tipo_peca_plural": "moletons", "tipo_peca_plural_cap": "Moletons",
        "artigo_peca": "o", "artigo_indef_peca": "um",
        "peca_dobrada": "dobrado", "peca_pendurada": "pendurado", "peca_dobradas_pl": "dobrados",
        "regra_preservacao": (
            "Preserve o TIPO DE PEÇA original: moletom de manga longa, gola redonda (careca, "
            "SEM capuz). NUNCA transforme em camiseta, manga curta ou adicione capuz — o "
            "moletom continua moletom careca em qualquer cenário, mesmo em cenas de calor/praia."
        ),
    },
    "Cropped Moletom": {
        "tipo_peca": "moletom cropped", "tipo_peca_cap": "Moletom cropped",
        "tipo_peca_plural": "moletons cropped", "tipo_peca_plural_cap": "Moletons cropped",
        "artigo_peca": "o", "artigo_indef_peca": "um",
        "peca_dobrada": "dobrado", "peca_pendurada": "pendurado", "peca_dobradas_pl": "dobrados",
        "regra_preservacao": (
            "Preserve o TIPO DE PEÇA original: moletom CROPPED — manga longa, gola redonda, "
            "SEM capuz, comprimento CURTO até a cintura (barriga pode aparecer à mostra). "
            "NUNCA alongue o comprimento nem adicione capuz."
        ),
    },
    "Hoodie Moletom": {
        "tipo_peca": "moletom com capuz", "tipo_peca_cap": "Moletom com capuz",
        "tipo_peca_plural": "moletons com capuz", "tipo_peca_plural_cap": "Moletons com capuz",
        "artigo_peca": "o", "artigo_indef_peca": "um",
        "peca_dobrada": "dobrado", "peca_pendurada": "pendurado", "peca_dobradas_pl": "dobrados",
        "regra_preservacao": (
            "Preserve o TIPO DE PEÇA original: moletom COM CAPUZ (hoodie) — manga longa, "
            "capuz com cordões visível, bolso canguru frontal opcional. NUNCA remova o capuz "
            "nem transforme em moletom careca ou camiseta."
        ),
    },
    "Camiseta Infantil": {
        "tipo_peca": "camiseta infantil", "tipo_peca_cap": "Camiseta infantil",
        "tipo_peca_plural": "camisetas infantis", "tipo_peca_plural_cap": "Camisetas infantis",
        "artigo_peca": "a", "artigo_indef_peca": "uma",
        "peca_dobrada": "dobrada", "peca_pendurada": "pendurada", "peca_dobradas_pl": "dobradas",
        "regra_preservacao": (
            "Preserve o TIPO DE PEÇA original: camiseta infantil, manga curta, gola redonda, "
            "tamanho de criança. O MODELO da cena é SEMPRE uma criança, NUNCA um adulto. "
            "Elementos culturais de adulto (ex: cuia de mate) NÃO devem ficar nas mãos da "
            "criança — podem aparecer só discretamente no cenário ao fundo, se fizer sentido."
        ),
    },
    "Cropped": {
        "tipo_peca": "camiseta cropped", "tipo_peca_cap": "Camiseta cropped",
        "tipo_peca_plural": "camisetas cropped", "tipo_peca_plural_cap": "Camisetas cropped",
        "artigo_peca": "a", "artigo_indef_peca": "uma",
        "peca_dobrada": "dobrada", "peca_pendurada": "pendurada", "peca_dobradas_pl": "dobradas",
        "regra_preservacao": (
            "Preserve o TIPO DE PEÇA original: camiseta CROPPED — manga curta, comprimento "
            "CURTO até a cintura (barriga à mostra). NUNCA alongue o comprimento pro padrão "
            "de camiseta comum."
        ),
    },
}

# Peças em que uma camada por cima (jaqueta, cardigan) esconderia o produto.
PECAS_SEM_CAMADA = {
    "Regata", "Cropped", "Cropped Moletom", "Suéter Moletom", "Hoodie Moletom", "Body Infantil",
}

PECA_PADRAO = "Camiseta (Algodão Peruano Premium)"

# Aliases so a SaaS product type ("t-shirt", "camiseta") finds its garment rule.
APPAREL_TYPE_ALIASES = {
    "camiseta": "Camiseta (Algodão Normal)",
    "t-shirt": "Camiseta (Algodão Normal)",
    "tshirt": "Camiseta (Algodão Normal)",
    "camiseta premium": "Camiseta (Algodão Peruano Premium)",
    "regata": "Regata",
    "tank top": "Regata",
    "camiseta oversized": "Camiseta Oversized",
    "oversized": "Camiseta Oversized",
    "body infantil": "Body Infantil",
    "moletom": "Suéter Moletom",
    "sweatshirt": "Suéter Moletom",
    "moletom cropped": "Cropped Moletom",
    "hoodie": "Hoodie Moletom",
    "moletom com capuz": "Hoodie Moletom",
    "camiseta infantil": "Camiseta Infantil",
    "cropped": "Cropped",
}


def garment_for_type(product_type: str) -> dict | None:
    """Garment catalog entry for a product type, or None for non-apparel products."""
    if not product_type:
        return None
    if product_type in PECAS:
        return PECAS[product_type]
    label = APPAREL_TYPE_ALIASES.get(product_type.strip().lower())
    return PECAS.get(label) if label else None


def validate_products(products: list, product_mode: str, limits: dict) -> list[str]:
    """Business rules on top of the contract validation. Returns error codes."""
    errors: list[str] = []
    ids = [p.get("id") for p in products]
    if len(set(ids)) != len(ids):
        errors.append("INVALID_PRODUCT")
    n = len(products)
    if product_mode == "single_product" and n != 1:
        errors.append("PRODUCT_COUNT_OUT_OF_RANGE")
    if product_mode == "multi_product" and not limits["min"] <= n <= limits["max"]:
        errors.append("PRODUCT_COUNT_OUT_OF_RANGE")
    return errors
