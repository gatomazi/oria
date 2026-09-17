"""
remarketing — módulo puro de domínio do modo REMARKETING.

O modo gera criativos de REMARKETING com o funil no criativo: quem já viu a marca
volta a ver o produto com uma mensagem da etapa em que parou (visitou o site,
viu o produto, abandonou o carrinho...). Serve às duas famílias de estampa da
loja regional: CIDADE (mapa, nome, coordenadas) e ESTAMPA (desenho/ilustração
temática, sem cidade).

Especificação: docs/claude-ajuste-gerador-criativos-layouts-remarketing.md.
As regras daquele doc que decidem QUAL criativo sai e COMO a camada de texto se
comporta moram aqui; o texto de prompt (composições, cenas, headlines, CTAs)
mora no banco ads/templates/remarketing.json, que as funções recebem por
parâmetro.

Sem Streamlit, sem OpenAI, sem leitura de disco — testável isoladamente (ver
organico/tests/test_remarketing.py).

Vocabulário:
    intent    remarketingIntent do doc (site_visitor, product_view, cart...)
    layout    família de composição (single_model, flatlay_grid...) — nunca
              template pixel-perfect
    angulo    o que a cena comunica (lifestyle, premium, creator...)
    slot      dict de 1 produto já resolvido pra uma posição do criativo:
              {"arquivo", "cidade", "uf", "tema", "cor", "cenario",
               "elemento", "evitar", "persona"}
    plano     lista de criativos a gerar, com intent/layout/ângulo/etapa resolvidos
"""
from __future__ import annotations

import json

# Regra global do doc (seção 2): imagem de inspiração só ensina composição.
REFERENCE_IMAGES_ARE_LAYOUT_ONLY = True

TIPO_CIDADE = "CIDADE"
TIPO_ESTAMPA = "ESTAMPA"

ETAPAS = ("TOFU", "MOFU", "BOFU")

DENSIDADES = ("minimal", "balanced", "commercial")
ENFASES = ("subtle", "medium", "strong")

# Etapa -> camada de texto padrão (seções 5 e 6 do doc).
PERFIL_POR_ETAPA = {
    "TOFU": {"densidade": "minimal", "enfase": "subtle"},
    "MOFU": {"densidade": "balanced", "enfase": "medium"},
    "BOFU": {"densidade": "commercial", "enfase": "strong"},
}

# --------------------------------------------------------------- intents
INTENTS = (
    "site_visitor",
    "product_view",
    "collection_discovery",
    "cart",
    "checkout",
    "social_proof",
    "objection",
)

# Etapa em que cada intent vive por padrão. Remarketing nunca é TOFU puro: a
# pessoa já conhece a marca — o TOFU só entra por override explícito na UI.
ETAPA_POR_INTENT = {
    "site_visitor": "MOFU",
    "product_view": "BOFU",
    "collection_discovery": "MOFU",
    "cart": "BOFU",
    "checkout": "BOFU",
    "social_proof": "MOFU",
    "objection": "MOFU",
}

# Checkout pede "pouco texto" (11.5): mesmo em BOFU, sem lista de benefícios.
DENSIDADE_MAXIMA_POR_INTENT = {"checkout": "balanced"}

# Layouts que fazem sentido pra cada intent: `recomendados` saem marcados na UI,
# `permitidos` são o universo que o usuário pode marcar. Um layout fora de
# `permitidos` contradiz a mensagem (ex.: flatlay de 5 peças em "Ainda pensando
# NELA?", que fala de UM produto).
LAYOUTS_POR_INTENT = {
    "site_visitor": {
        "recomendados": ("single_model", "multi_model_same_scene", "flatlay_grid"),
        "permitidos": ("single_model", "hero_support_models", "multi_model_same_scene",
                       "flatlay_grid", "flatlay_hero_stack", "full_body_fit"),
    },
    "product_view": {
        "recomendados": ("single_model", "product_closeup", "single_hanger"),
        "permitidos": ("single_model", "product_closeup", "single_hanger", "full_body_fit"),
    },
    "collection_discovery": {
        "recomendados": ("flatlay_grid", "flatlay_hero_stack", "hero_support_models"),
        "permitidos": ("flatlay_grid", "flatlay_hero_stack", "hero_support_models",
                       "multi_model_same_scene"),
    },
    "cart": {
        "recomendados": ("single_hanger", "product_closeup", "flatlay_hero_stack"),
        "permitidos": ("single_hanger", "product_closeup", "flatlay_hero_stack",
                       "single_model", "full_body_fit"),
    },
    "checkout": {
        "recomendados": ("single_hanger", "single_model"),
        "permitidos": ("single_hanger", "single_model", "product_closeup", "full_body_fit"),
    },
    "social_proof": {
        "recomendados": ("single_model",),
        "permitidos": ("single_model", "product_closeup", "multi_model_same_scene"),
    },
    "objection": {
        "recomendados": ("single_model", "full_body_fit"),
        "permitidos": ("single_model", "full_body_fit", "hero_support_models", "single_hanger"),
    },
}

# --------------------------------------------------------------- layouts
LAYOUTS = (
    "single_model",
    "hero_support_models",
    "multi_model_same_scene",
    "flatlay_grid",
    "flatlay_hero_stack",
    "single_hanger",
    "product_closeup",
    "full_body_fit",
)

# pessoas: (mín, máx) de gente no quadro. produtos: (mín, máx) de peças
# estampadas VISÍVEIS. Nos layouts com pessoa cada pessoa veste 1 produto.
# Teto de 3 pessoas (22. Multi-modelos) e de 1 peça no Cabide (8.4) são regra
# do doc, não preferência — por isso vivem aqui e não na UI.
ESPEC_LAYOUT = {
    "single_model":           {"pessoas": (1, 1), "produtos": (1, 1)},
    "hero_support_models":    {"pessoas": (2, 3), "produtos": (2, 3)},
    "multi_model_same_scene": {"pessoas": (2, 3), "produtos": (2, 3)},
    "flatlay_grid":           {"pessoas": (0, 0), "produtos": (4, 5)},
    "flatlay_hero_stack":     {"pessoas": (0, 0), "produtos": (3, 5)},
    "single_hanger":          {"pessoas": (0, 0), "produtos": (1, 1)},
    "product_closeup":        {"pessoas": (1, 1), "produtos": (1, 1)},
    "full_body_fit":          {"pessoas": (1, 1), "produtos": (1, 1)},
}

HANGER_MAX_PRODUCTS = 1
MAX_PESSOAS = 3

LAYOUTS_MULTI_MODELO = frozenset({"hero_support_models", "multi_model_same_scene"})
LAYOUTS_FLATLAY = frozenset({"flatlay_grid", "flatlay_hero_stack"})
LAYOUTS_SEM_PESSOA = frozenset(l for l, e in ESPEC_LAYOUT.items() if e["pessoas"][1] == 0)

# --------------------------------------------------------------- ângulos
ANGULOS = (
    "identity_origin",
    "lifestyle",
    "belonging",
    "nostalgia",
    "creator",
    "gift",
    "premium",
    "hanger",
    "flatlay",
    "fit",
    "print_closeup",
)

# Compatibilidade ângulo -> layouts (seção 20 do doc, completada com os
# ângulos que ela não lista: nostalgia, creator e gift).
LAYOUTS_POR_ANGULO = {
    "identity_origin": ("single_model", "hero_support_models"),
    "lifestyle": ("single_model", "multi_model_same_scene"),
    "belonging": ("multi_model_same_scene", "hero_support_models"),
    "nostalgia": ("single_model",),
    "creator": ("single_model",),
    "gift": ("multi_model_same_scene",),
    "premium": ("single_model", "single_hanger", "full_body_fit"),
    "hanger": ("single_hanger",),
    "flatlay": ("flatlay_grid", "flatlay_hero_stack"),
    "fit": ("full_body_fit",),
    "print_closeup": ("product_closeup",),
}

# Ângulos cuja narrativa é "lugar de origem". Numa ESTAMPA temática (desenho sem cidade)
# eles não têm o que contar — saem desmarcados por padrão, mesma decisão do
# ANGULOS_ORIGEM das estampas temáticas nos Ângulos Limpos.
ANGULOS_ORIGEM = frozenset({"identity_origin", "nostalgia"})

# Seção 12: cleanMode é priorizado nestes ângulos.
ANGULOS_CLEAN = frozenset({"lifestyle", "creator", "identity_origin", "belonging", "nostalgia"})

# "Presente / Afeto" é sempre de 2 pessoas (seção 10).
PESSOAS_FIXAS_POR_ANGULO = {"gift": 2}

CLEAN_AUTO = "auto"
CLEAN_SEMPRE = "sempre"
CLEAN_NUNCA = "nunca"

# Assinatura em TEXTO (nunca logotipo desenhado) — o nome da marca vem da
# região da UF, a mesma divisão dos brand packs do Orgânico.
ASSINATURA_POR_REGIAO = {"Sul": "USE SUL", "Centro-Oeste": "USE CENTRO", "Norte": "USE NORTE"}


# --------------------------------------------------------------- compat
def angulos_do_layout(layout: str) -> list:
    """Ângulos que cabem num layout, na ordem canônica de ANGULOS."""
    return [a for a in ANGULOS if layout in LAYOUTS_POR_ANGULO.get(a, ())]


def angulos_padrao(tipo_estampa: str) -> list:
    """Seleção inicial de ângulos na UI: todos, menos os de origem na ESTAMPA."""
    if tipo_estampa == TIPO_ESTAMPA:
        return [a for a in ANGULOS if a not in ANGULOS_ORIGEM]
    return list(ANGULOS)


def layouts_recomendados(intent: str) -> list:
    return list(LAYOUTS_POR_INTENT.get(intent, {}).get("recomendados", ()))


def layouts_permitidos(intent: str) -> list:
    return list(LAYOUTS_POR_INTENT.get(intent, {}).get("permitidos", ()))


# --------------------------------------------------------------- texto
def _limitar_densidade(densidade: str, teto: str | None) -> str:
    if not teto:
        return densidade
    return DENSIDADES[min(DENSIDADES.index(densidade), DENSIDADES.index(teto))]


def resolver_etapa(intent: str, override: str | None = None) -> str:
    """Etapa do criativo: o override da UI vence; senão, a etapa natural do intent."""
    if override in ETAPAS:
        return override
    return ETAPA_POR_INTENT.get(intent, "MOFU")


def clean_ativo(modo_clean: str, angulo: str, etapa: str) -> bool:
    """`auto` liga o modo limpo nos ângulos da seção 12, exceto no BOFU — ali o
    doc pede clareza de ação (CTA forte, benefícios), o oposto de 'limpo'."""
    if modo_clean == CLEAN_SEMPRE:
        return True
    if modo_clean == CLEAN_NUNCA:
        return False
    return angulo in ANGULOS_CLEAN and etapa != "BOFU"


def perfil_texto(
    etapa: str,
    intent: str = "",
    clean: bool = False,
    densidade: str | None = None,
    enfase: str | None = None,
) -> dict:
    """Camada de texto de 1 criativo: densidade, ênfase do CTA e o que entra.

    Ordem de decisão: etapa dá o padrão -> override da UI -> teto do intent
    (checkout nunca é 'commercial') -> cleanMode, que manda em tudo: 1
    headline + 1 CTA, sem subtítulo nem benefícios (seção 12)."""
    base = PERFIL_POR_ETAPA.get(etapa, PERFIL_POR_ETAPA["MOFU"])
    densidade_final = densidade if densidade in DENSIDADES else base["densidade"]
    densidade_final = _limitar_densidade(densidade_final, DENSIDADE_MAXIMA_POR_INTENT.get(intent))
    enfase_final = enfase if enfase in ENFASES else base["enfase"]
    if clean:
        densidade_final = "minimal"
    return {
        "densidade": densidade_final,
        "enfase": enfase_final,
        "clean": clean,
        "subheadline": densidade_final in ("balanced", "commercial"),
        "max_beneficios": 3 if densidade_final == "commercial" else 0,
    }


def resolver_textos(banco: dict, intent: str, tipo_estampa: str, indice: int) -> dict:
    """Headline/subheadline/CTA do criativo `indice` daquele intent.

    Headlines e CTAs rotacionam com o MESMO índice mas pools de tamanhos
    diferentes, pra dois criativos vizinhos não repetirem a mesma dupla. Tipo sem
    pool próprio cai no de CIDADE — melhor texto genérico do que criativo mudo."""
    copy = banco.get("intents", {}).get(intent, {})
    pool = copy.get(tipo_estampa) or copy.get(TIPO_CIDADE) or {}
    headlines = pool.get("headlines") or []
    ctas = pool.get("ctas") or []
    if not headlines:
        return {}
    escolhida = headlines[indice % len(headlines)]
    return {
        "headline": escolhida.get("headline", ""),
        "subheadline": escolhida.get("subheadline", ""),
        "cta": ctas[indice % len(ctas)] if ctas else "",
    }


def assinatura_marca(regioes: dict, ufs) -> str:
    """'USE SUL' quando todas as UFs são da mesma região; '' quando não há UF
    ou quando as regiões se misturam (uma assinatura errada é pior que
    nenhuma)."""
    regioes_criativo = {regioes.get(u, {}).get("regiao") for u in ufs if u}
    if len(regioes_criativo) != 1:
        return ""
    return ASSINATURA_POR_REGIAO.get(regioes_criativo.pop() or "", "")


def bloco_texto_criativo(
    textos: dict, perfil: dict, beneficios: list | None = None, assinatura: str = "",
) -> str:
    """Lista LITERAL do texto permitido no criativo. O que a densidade corta não
    entra na lista — pedir 'sem subtítulo' com o subtítulo escrito no prompt
    faz o modelo desenhá-lo mesmo assim."""
    if not textos:
        return ""
    linhas = [f'  · HEADLINE: "{textos["headline"]}"']
    if perfil.get("subheadline") and textos.get("subheadline"):
        linhas.append(f'  · SUBHEADLINE: "{textos["subheadline"]}"')
    if textos.get("cta"):
        linhas.append(f'  · CTA: "{textos["cta"]}"')
    beneficios_criativo = [b.strip() for b in (beneficios or []) if b and b.strip()]
    beneficios_criativo = beneficios_criativo[: perfil.get("max_beneficios", 0)]
    if beneficios_criativo:
        linhas.append(
            "  · BENEFÍCIOS (2–3 itens curtos, linha discreta com ícone de traço "
            "fino, abaixo do CTA ou entre subheadline e CTA): "
            + " | ".join(f'"{b}"' for b in beneficios_criativo)
        )
    if assinatura:
        linhas.append(
            f'  · ASSINATURA: "{assinatura}" — em texto pequeno, caixa alta '
            "espaçada, num canto do quadro. Só as letras: sem símbolo, sem "
            "logotipo desenhado, sem slogan inventado."
        )

    densidade = perfil.get("densidade", "balanced")
    hierarquia = {
        "minimal": "só headline + micro CTA; imagem domina, muito respiro.",
        "balanced": "headline, subheadline curta e CTA; ainda editorial.",
        "commercial": "headline, subheadline, CTA e benefícios — claro e "
                      "direto, mas NUNCA uma landing page dentro da imagem.",
    }[densidade]
    extra_clean = (
        "\n  · MODO LIMPO: máximo 1 headline e 1 CTA; sem ícones, sem selos, "
        "sem subtítulo; grande área de imagem."
        if perfil.get("clean") else ""
    )
    return (
        "TEXTO NO CRIATIVO (reproduza exatamente, com acentos; nada além disso):\n"
        + "\n".join(linhas)
        + f"\n  · Densidade de texto: {densidade} — {hierarquia}{extra_clean}\n"
        "  · Tipografia editorial premium (serifada de alto contraste ou sans "
        "geométrica limpa), no máximo 2 famílias; a headline pode ter 1 palavra "
        "de destaque em cor de acento. O texto vive numa zona de respiro do "
        "fundo — nunca sobre rosto, nunca sobre a estampa."
    )


def bloco_cta(enfase: str, vermelho_experimental: bool = False) -> str:
    """Tratamento visual do CTA (seções 6 e 21): intensidade pela etapa e cor
    por contraste com o fundo onde o botão pousa — nunca vermelho por padrão."""
    forma = {
        "subtle": "só texto + seta (→), sem caixa; peso médio, legível, "
                  "discreto — pode ter um fio fino sublinhando.",
        "medium": "botão discreto mas visível: contorno fino (outline) ou pílula "
                  "de preenchimento sóbrio, cantos arredondados, texto em caixa "
                  "alta espaçada + seta.",
        "strong": "botão SÓLIDO, alto contraste, pílula de cantos arredondados, "
                  "texto em caixa alta + seta, com área de respiro ao redor de "
                  "pelo menos 1× a altura do botão — percebido em menos de 1 segundo.",
    }.get(enfase, "")
    if vermelho_experimental:
        cor = (
            "  · COR (variação experimental A/B): vermelho/coral é permitido "
            "neste criativo, mantendo contraste alto com o fundo."
        )
    else:
        cor = (
            "  · COR POR CONTRASTE com a região do fundo onde o botão pousa: "
            "fundo claro -> preto, grafite, dourado escuro ou a cor primária "
            "forte da marca; fundo escuro -> creme, dourado claro, branco ou tom "
            "claro de alta legibilidade. NUNCA vermelho nem coral."
        )
    return (
        f"CTA — ênfase {enfase}: {forma}\n{cor}\n"
        "  · Posição: com espaço livre ao redor; nunca sobre a estampa, sobre "
        "rosto, sobre área visualmente complexa ou colado nas bordas."
    )


# --------------------------------------------------------------- produtos
def rotulo_produto(slot: dict, tipo_estampa: str) -> str:
    """Como o prompt nomeia o produto de um slot. Na ESTAMPA temática não existe cidade:
    o que identifica é o tema do desenho."""
    if tipo_estampa == TIPO_ESTAMPA:
        tema = (slot.get("tema") or "").strip()
        return f'estampa "{tema}"' if tema else "estampa/desenho da referência"
    cidade = (slot.get("cidade") or "").strip()
    uf = (slot.get("uf") or "").strip()
    if cidade and uf:
        return f"estampa de {cidade}/{uf}"
    return f"estampa de {cidade or uf or 'cidade da referência'}"


def bloco_referencias(slots: list, tipo_estampa: str, referencia_layout: bool = False) -> str:
    """Declara qual imagem anexada é qual produto — e, quando houver, que a
    ÚLTIMA é só referência de layout. Prioridade do doc (seção 14): produto
    atual > dados atuais > configuração > referência de layout."""
    if not slots:
        return ""
    linhas = []
    for i, slot in enumerate(slots, 1):
        cor = (slot.get("cor") or "").strip()
        sufixo_cor = f" — cor da peça: {cor} (obrigatório)" if cor else " — cor da peça: a mesma da referência"
        linhas.append(f"  · {i}ª imagem = {rotulo_produto(slot, tipo_estampa)}{sufixo_cor}")
    trava_origem = (
        "  · NUNCA invente, troque ou acrescente nome de cidade: a cidade de cada "
        "peça é exatamente a que está na estampa correspondente."
        if tipo_estampa == TIPO_CIDADE else
        "  · As estampas são desenhos SEM cidade: nunca acrescente nome de cidade, "
        "mapa ou coordenada que não esteja na estampa."
    )
    abertura = (
        "a 1ª imagem anexada é o produto deste criativo:"
        if len(slots) == 1 else
        f"as {len(slots)} primeiras imagens anexadas são os produtos deste criativo, nesta ordem:"
    )
    texto = (
        "\n\n- PRODUTOS (autoridade absoluta sobre qualquer outra imagem): "
        f"{abertura}\n" + "\n".join(linhas) + "\n"
        "  · Reproduza cada estampa com fidelidade total na peça correspondente — "
        "cores, traço, tipografia, posição e proporção idênticas; nunca troque "
        "estampas entre peças nem funda desenhos.\n" + trava_origem
    )
    if referencia_layout:
        texto += "\n\n" + bloco_referencia_layout(len(slots) + 1)
    return texto


def bloco_referencia_layout(posicao: int) -> str:
    """Seção 2 do doc, literal: a referência ensina composição e só."""
    return (
        f"- REFERÊNCIA DE LAYOUT ({posicao}ª imagem, a última) — SOMENTE COMPOSIÇÃO:\n"
        "  · Use apenas: proporção, posição do produto/modelo, zona do texto, "
        "hierarquia, tamanho relativo dos elementos, profundidade, ritmo, "
        "iluminação e tratamento do CTA.\n"
        "  · IGNORE por completo: a estampa da referência, cidades escritas nela, "
        "nomes de coleção, logos, cor da camiseta, rosto/identidade da modelo, "
        "copy literal e qualquer indicação geográfica.\n"
        "  · Nada da referência pode aparecer no criativo final — nenhuma letra, "
        "nenhum mapa, nenhum desenho. É inspiração de layout, não template."
    )


def bloco_distribuicao(layout: str, slots: list, tipo_estampa: str, cenario: str = "", elemento: str = "") -> str:
    """Quem veste o quê (layouts com pessoa) ou qual peça é qual (sem pessoa),
    mais o contexto da cena. Cena regional como contexto, não caricatura
    (seção 17); em layout sem pessoa a região é só atmosfera — o set é o do
    layout, senão a mesa de flatlay acaba plantada num campo com neblina."""
    cenario_txt = cenario or "cenário contemporâneo neutro, sem elementos regionais fortes"
    elemento_txt = elemento or "nenhum objeto específico — omitir"
    anti_cliche = (
        "Contexto coerente e contemporâneo, sem caricatura: nada de cenário "
        "turístico óbvio, fantasia ou 'souvenir visual'."
    )
    if layout in LAYOUTS_SEM_PESSOA:
        linhas = []
        for i, slot in enumerate(slots, 1):
            marca = " — PEÇA HERO, estampa 100% legível" if i == 1 and len(slots) > 1 else ""
            linhas.append(f"- Peça {i}{marca}: {rotulo_produto(slot, tipo_estampa)} ({i}ª imagem).")
        return (
            f"ATMOSFERA (luz, paleta e materiais — NÃO leve o set pra este lugar): "
            f"inspirada em \"{cenario_txt}\". Elemento de apoio, discreto e na "
            f"borda: {elemento_txt}. {anti_cliche}\n"
            "PEÇAS (respeite exatamente):\n" + "\n".join(linhas)
        )
    linhas = []
    for i, slot in enumerate(slots, 1):
        papel = ""
        if layout == "hero_support_models":
            papel = " (PRINCIPAL, 50–65% do peso visual)" if i == 1 else " (apoio)"
        persona = slot.get("persona") or "adulto(a) 25-40 anos"
        linhas.append(
            f"- Pessoa {i}{papel}: {persona}, vestindo a {rotulo_produto(slot, tipo_estampa)} ({i}ª imagem)."
        )
    return (
        f"CENÁRIO: {cenario_txt}. Elemento de apoio: {elemento_txt}. {anti_cliche}\n"
        "QUEM VESTE O QUÊ (respeite exatamente — não troque estampa de pessoa):\n"
        + "\n".join(linhas)
    )


REGRA_ESTAMPA_CONTIDA = (
    "\n\n- ESTAMPA DENTRO DA PEÇA (regra obrigatória, prioridade máxima):\n"
    "  · A estampa inteira fica CONTIDA no painel frontal da peça, com margem "
    "livre até a gola, as costuras laterais e a barra. Ela NUNCA ultrapassa a "
    "barra, nunca continua na calça, saia, casaco ou pele e nunca é cortada "
    "pela borda da peça.\n"
    "  · Estampa alta ou vertical: mantenha a proporção original do desenho e "
    "ajuste o tamanho pra caber no tronco com margem acima da barra — nunca "
    "estique, corte ou deixe transbordar."
)

# Só nos layouts com pessoa: é quando o modelo vira o corpo (pose de costas,
# caminhando pra longe) e quando a peça some dentro da calça — dois casos reais
# do 1º lote: estampa nas costas no hero + apoios e arte escorrendo pra calça
# de cintura alta numa selfie de espelho.
REGRA_ESTAMPA_VESTIDA = (
    "\n  · A peça é usada SOLTA, por fora da calça ou saia, com a barra inteira "
    "visível — nunca enfiada no cós, amarrada ou escondida por calça de "
    "cintura alta. Casaco, cardigã ou camisa por cima ficam abertos e "
    "afastados, sem cobrir nenhuma parte da estampa.\n"
    "- ESTAMPA DE FRENTE (regra obrigatória, prioridade máxima): a estampa é "
    "FRONTAL — fica na frente da peça, nunca nas costas, e nunca é duplicada "
    "frente e costas. Toda pessoa que veste um produto (inclusive as de apoio) "
    "fica com o PEITO voltado pra câmera — frontal ou no máximo 3/4 — e a "
    "estampa inteira visível. Proibido: pessoa de costas, caminhando pra longe "
    "da câmera, de perfil total, ou braço/objeto/cabelo escondendo a estampa. "
    "O rosto e o olhar podem virar pro lado; o tronco não."
)


def bloco_estampa_na_peca(layout: str) -> str:
    """Onde a estampa pode estar: sempre contida na peça; com pessoa, também
    na FRENTE e com a peça solta."""
    if layout in LAYOUTS_SEM_PESSOA:
        return REGRA_ESTAMPA_CONTIDA
    return REGRA_ESTAMPA_CONTIDA + REGRA_ESTAMPA_VESTIDA


REGRA_CABIDE_UNICO = (
    "\n\n- CABIDE ÚNICO (regra obrigatória): exatamente UMA camiseta estampada "
    "protagonista, pendurada em cabide central, peça inteira visível e estampa "
    "grande. Roupas ao fundo só desfocadas e SEM estampa aparente; peças "
    "dobradas em prateleira, se houver, também sem estampa visível. Nunca "
    "várias camisetas estampadas lado a lado."
)


def bloco_prova_social(provas_reais: list | None) -> str:
    """Seção 11.6: só prova real. Sem prova informada, o criativo fica no visual
    de UGC/embalagem e o prompt proíbe explicitamente estrelas e números."""
    provas = [p.strip() for p in (provas_reais or []) if p and p.strip()]
    proibicao = (
        "Nunca fabrique depoimento, nota, estrelas, quantidade de clientes ou "
        "volume de vendas."
    )
    if not provas:
        return (
            "PROVA SOCIAL: SEM prova real informada — comunique só pelo visual "
            "(cliente real vestindo, embalagem, cara de UGC espontâneo). Nenhum "
            f"review, citação, estrela ou número no criativo. {proibicao}"
        )
    return (
        "PROVA SOCIAL (somente estes dados reais, texto literal, sem adaptar): "
        + " | ".join(f'"{p}"' for p in provas)
        + f". {proibicao}"
    )


def bloco_validacao(layout: str, intent: str, tipo_estampa: str) -> str:
    """Autochecagem da seção 22 — o que o modelo confere antes de entregar."""
    itens = [
        "cada estampa corresponde à imagem de produto certa; cor da peça e "
        + ("cidade" if tipo_estampa == TIPO_CIDADE else "desenho")
        + " batem com o input; nada veio da referência de layout",
        "headline e CTA legíveis no tamanho do feed; produto não cortado de forma "
        "errada; nenhum rosto coberto; estampa sem deformação",
        "cada estampa inteira DENTRO da peça, acima da barra — nada invadindo "
        "calça, pele ou fundo",
    ]
    if layout not in LAYOUTS_SEM_PESSOA:
        itens.append(
            "toda estampa na FRENTE da peça e todo tronco voltado pra câmera — "
            "nenhuma pessoa de costas; peça solta por fora da calça"
        )
    if layout == "single_hanger":
        itens.append(
            "apenas 1 camiseta estampada; linha vertical do centro da gola "
            "atravessa o centro da estampa; nada puxado pra manga/lateral"
        )
    if layout in LAYOUTS_MULTI_MODELO:
        itens.append(
            f"no máximo {MAX_PESSOAS} pessoas; pelo menos 1 estampa claramente "
            "legível; sem pose de catálogo com todos olhando pra câmera"
        )
    if layout in LAYOUTS_FLATLAY:
        itens.append("nenhuma peça importante encoberta; peça hero identificável; estampas legíveis")
    itens.append(
        "o CTA combina com a etapa e a linguagem soa como retorno de quem já "
        "conhece a marca — não como prospecção genérica"
    )
    return (
        "VERIFICAÇÃO ANTES DE FINALIZAR (se algo falhar, corrija antes de "
        "entregar):\n" + "\n".join(f"  · {i}" for i in itens)
    )


# --------------------------------------------------------------- plano
def pessoas_do_criativo(layout: str, angulo: str, qtd_multi: int) -> int:
    """Quantas pessoas o criativo leva. `qtd_multi` só vale nos multi-modelos e é
    presa a 2-3; 'gift' é sempre 2."""
    minimo, maximo = ESPEC_LAYOUT[layout]["pessoas"]
    if maximo == 0:
        return 0
    if angulo in PESSOAS_FIXAS_POR_ANGULO and minimo <= PESSOAS_FIXAS_POR_ANGULO[angulo] <= maximo:
        return PESSOAS_FIXAS_POR_ANGULO[angulo]
    if minimo == maximo:
        return minimo
    return max(minimo, min(int(qtd_multi), maximo, MAX_PESSOAS))


def produtos_do_criativo(layout: str, angulo: str, qtd_multi: int, qtd_flatlay: int) -> int:
    """Quantas estampas entram no criativo, sempre dentro do intervalo do layout."""
    minimo, maximo = ESPEC_LAYOUT[layout]["produtos"]
    if layout == "single_hanger":
        return HANGER_MAX_PRODUCTS
    if layout in LAYOUTS_FLATLAY:
        return max(minimo, min(int(qtd_flatlay), maximo))
    if ESPEC_LAYOUT[layout]["pessoas"][1] > 0:
        return pessoas_do_criativo(layout, angulo, qtd_multi)
    return minimo


def montar_plano(
    layouts_por_intent: dict,
    qtd_por_combinacao: int,
    angulos_selecionados: list,
) -> list:
    """Lista de criativos: para cada intent (ordem de INTENTS) × layout marcado,
    `qtd_por_combinacao` criativos.

    Cada item traz intent, layout, angulo e três índices de rotação
    independentes, pra criativos do mesmo lote não saírem iguais (seção 18):
      indice_texto   posição dentro do intent -> rotaciona headline/CTA
      indice_layout  posição dentro do layout -> rotaciona a variação de composição
      angulo         rotaciona entre os ângulos marcados que cabem no layout
    Layout sem nenhum ângulo marcado compatível cai no 1º ângulo dele — o
    usuário marcou o layout, o criativo sai; o ângulo é refinamento."""
    selecionados = set(angulos_selecionados or [])
    plano: list = []
    cursor_texto: dict = {}
    cursor_layout: dict = {}
    cursor_angulo: dict = {}
    qtd = max(int(qtd_por_combinacao or 0), 0)
    for intent in INTENTS:
        permitidos = set(layouts_permitidos(intent))
        for layout in LAYOUTS:
            if layout not in (layouts_por_intent.get(intent) or ()) or layout not in permitidos:
                continue
            compativeis = angulos_do_layout(layout)
            opcoes = [a for a in compativeis if a in selecionados] or compativeis[:1]
            for _ in range(qtd):
                n_ang = cursor_angulo.get(layout, 0)
                cursor_angulo[layout] = n_ang + 1
                indice_texto = cursor_texto.get(intent, 0)
                cursor_texto[intent] = indice_texto + 1
                indice_layout = cursor_layout.get(layout, 0)
                cursor_layout[layout] = indice_layout + 1
                plano.append({
                    "seq": len(plano) + 1,
                    "intent": intent,
                    "layout": layout,
                    "angulo": opcoes[n_ang % len(opcoes)],
                    "indice_texto": indice_texto,
                    "indice_layout": indice_layout,
                })
    return plano


def escolher_referencia_layout(banco: dict, layout: str, angulo: str, indice: int) -> str:
    """Arquivo de assets/remarketing/ que serve de referência de LAYOUT pro
    criativo. Prefere mesmo layout + mesmo ângulo, depois só mesmo layout; ''
    quando não há referência daquele layout — melhor sem referência do que com
    uma de composição errada, que puxaria o modelo pro layout dela."""
    refs = banco.get("referencias_layout") or []
    exatas = [r["arquivo"] for r in refs if r.get("layout") == layout and r.get("angulo") == angulo]
    candidatas = exatas or [r["arquivo"] for r in refs if r.get("layout") == layout]
    if not candidatas:
        return ""
    return candidatas[indice % len(candidatas)]


def validar_config(layout: str, n_produtos: int, n_pessoas: int) -> list:
    """Erros de regra dura do doc pra 1 criativo. Lista vazia = pode gerar."""
    erros = []
    if layout == "single_hanger" and n_produtos > HANGER_MAX_PRODUCTS:
        erros.append("Cabide aceita apenas 1 camiseta estampada protagonista.")
    if n_pessoas > MAX_PESSOAS:
        erros.append(f"Multi-modelos aceita no máximo {MAX_PESSOAS} pessoas.")
    minimo, maximo = ESPEC_LAYOUT.get(layout, {"produtos": (1, 1)})["produtos"]
    if not minimo <= n_produtos <= maximo:
        erros.append(f"{layout} pede entre {minimo} e {maximo} produto(s); recebeu {n_produtos}.")
    return erros


# --------------------------------------------------------------- QA visual
def montar_prompt_qa(layout: str, slots: list, tipo_estampa: str, textos: dict) -> str:
    """Pede a um modelo de visão o checklist da seção 22 como JSON. A 1ª imagem
    é o criativo; as seguintes, as estampas na ordem dos slots."""
    produtos = "\n".join(
        f"- Produto {i}: {rotulo_produto(s, tipo_estampa)}"
        + (f", peça {s['cor']}" if s.get("cor") else "")
        for i, s in enumerate(slots, 1)
    )
    checks = [
        "estampa_fiel: cada estampa visível corresponde a uma das imagens de produto (sem estampa inventada ou trocada)",
        "texto_legivel: headline e CTA legíveis e escritos exatamente como pedido",
        "sem_texto_extra: nenhum texto além do pedido e do que já existe nas estampas",
        "rosto_e_estampa_livres: nenhum texto/CTA sobre rosto ou estampa",
        "sem_deformacao: estampas sem deformação grave",
        "estampa_contida: cada estampa inteira dentro da peça, sem ultrapassar a barra nem invadir calça, pele ou fundo",
    ]
    if layout not in LAYOUTS_SEM_PESSOA:
        checks.append("estampa_na_frente: toda estampa na frente da peça, nenhuma pessoa de costas mostrando a estampa")
    if layout == "single_hanger":
        checks.append("cabide_unico_centralizado: exatamente 1 camiseta estampada e estampa centrada no eixo da gola")
    if layout in LAYOUTS_MULTI_MODELO:
        checks.append("multi_modelos: no máximo 3 pessoas e pelo menos 1 estampa legível")
    if layout in LAYOUTS_FLATLAY:
        checks.append("flatlay: nenhuma peça importante encoberta e peça hero identificável")
    textos_esperados = " | ".join(
        f"{k}: \"{v}\"" for k, v in (textos or {}).items() if v
    )
    return (
        "Você é QA de criativos de anúncio. A 1ª imagem é o criativo gerado; as "
        "seguintes são as estampas de referência, na ordem.\n"
        f"Produtos esperados:\n{produtos}\n"
        f"Textos esperados: {textos_esperados or '—'}\n\n"
        "Avalie cada item e responda SÓ um JSON no formato "
        '{"checks": {"<id>": true|false}, "falhas": ["<descrição curta>"]}.\n'
        "Itens:\n" + "\n".join(f"- {c}" for c in checks)
    )


def interpretar_qa(texto: str) -> dict:
    """{'aprovado': bool, 'falhas': [...]} a partir da resposta do QA.

    Resposta ilegível NÃO reprova: o QA é uma rede de segurança opcional, e
    reprovar por erro de parse jogaria fora (ou regeraria, pagando de novo)
    um criativo possivelmente bom. A falha de parse volta em `erro` pra UI mostrar."""
    bruto = (texto or "").strip()
    inicio, fim = bruto.find("{"), bruto.rfind("}")
    try:
        dados = json.loads(bruto[inicio:fim + 1]) if inicio != -1 and fim > inicio else None
    except (ValueError, TypeError):
        dados = None
    if not isinstance(dados, dict):
        return {"aprovado": True, "falhas": [], "erro": "resposta do QA ilegível"}
    checks = dados.get("checks") or {}
    reprovados = [k for k, v in checks.items() if v is False]
    falhas = [str(f) for f in (dados.get("falhas") or []) if str(f).strip()]
    if reprovados and not falhas:
        falhas = reprovados
    return {"aprovado": not reprovados and not falhas, "falhas": falhas}


def bloco_correcao(falhas: list) -> str:
    """Prefixo do prompt na regeração após reprovação no QA."""
    if not falhas:
        return ""
    return (
        "CORREÇÃO OBRIGATÓRIA — a tentativa anterior foi reprovada por:\n"
        + "\n".join(f"  · {f}" for f in falhas)
        + "\nCorrija estes pontos mantendo todas as demais regras.\n\n"
    )
