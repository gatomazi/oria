"""
cabide — regra permanente de posicionamento da estampa em peças penduradas.

Módulo puro (sem Streamlit, sem OpenAI), usado por TODOS os modos que geram
Cabide: FUNIL_VISUAL (templates "Modo CABIDE"), ANGULOS_LIMPOS, ANGULOS_MULTIPECA,
COLECAO_ESTADO e o ângulo `hanger` do ORGANICO — nas duas lojas.

Por que existe: em peça pendurada o modelo de imagem tende a centralizar a arte
no CANVAS, no cabide ou no bounding box da camiseta inteira. Com a peça
levemente girada, ou com a manga projetando pra um lado, esse "centro" cai fora
do eixo da gola e a estampa sai puxada pra lateral. A regra ancora o centro no
único referencial que não se mexe com a pose da peça: o eixo gola → barra do
painel frontal.

Fica num módulo só (e não copiada nos ~20 templates de Cabide dos bancos JSON)
pra ser uma regra do GERADOR, não de um template: edita-se em um lugar e vale
pra tudo que pendura camiseta.
"""
from __future__ import annotations

# Marcador usado pelos templates do FUNIL_VISUAL (prompts*.json), que não têm
# ID de ângulo — a única forma de saber que a variante sorteada é de cabide.
MARCADOR_TEMPLATE_CABIDE = "Modo CABIDE"

REGRA_CENTRALIZACAO_CABIDE = (
    "\n\n- POSICIONAMENTO DA ESTAMPA NO CABIDE (regra permanente, prioridade máxima):\n"
    "  · IMPORTANTE: NÃO centralize a estampa no canvas, no cabide nem no "
    "bounding box completo da camiseta. Centralize-a EXCLUSIVAMENTE no painel "
    "frontal do tronco da própria camiseta, usando o centro da gola como eixo.\n"
    "  · Eixo de referência: a linha vertical que passa pelo centro da gola e "
    "pelo centro da barra. O centro horizontal da estampa coincide com o "
    "centro da gola.\n"
    "  · Pra achar o centro, considere SÓ o painel frontal do tronco, entre as "
    "duas costuras laterais — ignore mangas, sombras, inclinação do cabide e a "
    "área total da peça.\n"
    "  · Todos os elementos da arte (ex.: título + mapa + marcador) formam UM "
    "único grupo visual: movem-se juntos, sem nenhum deslocamento relativo "
    "entre eles.\n"
    "  · A estampa nunca fica puxada pra esquerda ou pra direita e nunca "
    "acompanha a posição aparente da manga. Não invade lateral, axila nem "
    "dobra de manga.\n"
    "  · A arte permanece frontal à camiseta, só com a deformação natural do "
    "tecido e da perspectiva.\n"
    "  · Estampa central grande: largura de aproximadamente 45–55% da largura "
    "útil do tronco (entre as costuras laterais).\n"
    "  · Altura: o conjunto fica na região do peito/torso, começando "
    "aproximadamente 12–18% do comprimento do tronco abaixo da gola, mantendo o "
    "equilíbrio vertical da peça.\n"
    "  · Com várias camisetas na cena, aplique esta regra INDIVIDUALMENTE em "
    "cada peça — mesmo parcialmente sobreposta ou em perspectiva, cada estampa "
    "fica centrada na gola da SUA camiseta.\n"
    "  · Exceção: se a arte de referência for deliberadamente fora do centro "
    "(bolso, peito esquerdo, mini print), preserve a posição mostrada na "
    "referência — esta regra é para estampa frontal central.\n"
    "  · VERIFICAÇÃO ANTES DE FINALIZAR: trace mentalmente uma linha vertical a "
    "partir do centro da gola de cada camiseta. Ela deve atravessar "
    "aproximadamente o centro da estampa. Se houver desvio lateral "
    "perceptível, a composição está errada — corrija antes de entregar a imagem."
)


def template_e_cabide(template: str) -> bool:
    """True quando um template sem ID de ângulo (FUNIL_VISUAL) é de cabide."""
    return MARCADOR_TEMPLATE_CABIDE in (template or "")
