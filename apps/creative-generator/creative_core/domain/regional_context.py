"""
regional_context — módulo puro de domínio.

Resolve a hierarquia UF -> CONTEXTO REGIONAL -> CENA / ELEMENTO DE APOIO do
schema de config/regioes.json:

    {"UF": {"regiao": "...", "contextos": {
        "<context_id>": {
            "descricao": "...",
            "cenario": [...],
            "elementos_culturais": [...],
            "usar_com_cuidado": [...],
            "evitar": [...],
        }, ...
    }, "paleta": [...]}}

Sem Streamlit, sem OpenAI. Testável isoladamente (ver
organico/tests/test_regional_context.py).

Regra central: um contexto regional NUNCA mistura cenário/elemento de outro
contexto da mesma UF — toda resolução automática que não conseguir
determinar um único contexto retorna None em vez de sortear entre eles.
"""
from __future__ import annotations


def listar_contextos(regioes: dict, uf: str) -> dict:
    """{context_id: {descricao, cenario, elementos_culturais, usar_com_cuidado,
    evitar}} de todos os contextos regionais da UF. {} se a UF não tiver
    contextos cadastrados."""
    return regioes.get(uf, {}).get("contextos", {})


def obter_contexto(regioes: dict, uf: str, contexto_id: str | None) -> dict:
    """Dict de 1 contexto regional, ou {} se contexto_id for None/inválido
    pra essa UF — nunca cai num contexto de outra UF."""
    if not contexto_id:
        return {}
    return listar_contextos(regioes, uf).get(contexto_id, {})


def label_contexto(contexto_id: str) -> str:
    """Rótulo amigável a partir do ID (ex: 'vale_europeu' -> 'Vale Europeu')."""
    return contexto_id.replace("_", " ").title()


def resolver_contexto_legado(
    regioes: dict, uf: str, cenario_legado: str = "", elemento_legado: str = "",
) -> str | None:
    """Tenta inferir o contexto regional de um cadastro ANTIGO (cenario/
    elemento_cultural como string livre, sem regional_context_id associado).
    Só resolve se EXATAMENTE 1 contexto contiver o valor legado numa das
    suas listas — caso contrário retorna None (ambíguo ou não encontrado),
    nunca escolhe por aproximação. Preserva 'não misturar contextos' mesmo
    pra dados legados."""
    candidatos = set()
    for context_id, contexto in listar_contextos(regioes, uf).items():
        if cenario_legado and cenario_legado in contexto.get("cenario", []):
            candidatos.add(context_id)
        if elemento_legado and elemento_legado in contexto.get("elementos_culturais", []):
            candidatos.add(context_id)
    if len(candidatos) == 1:
        return next(iter(candidatos))
    return None


def resolver_contexto_para_cidade(regioes: dict, uf: str, perfil_cidade: dict | None) -> str | None:
    """Resolve o contexto regional de uma cidade, na ordem:
    1. regional_context_id explícito no perfil (CityContext aprovado ou
       cadastro manual anterior)
    2. inferência a partir de cenario/elemento_cultural legados — só quando
       inequívoca (ver resolver_contexto_legado)
    3. não resolvido -> None (a UI deve avisar e pedir escolha manual, NUNCA
       sortear entre os contextos da UF)."""
    if not perfil_cidade:
        return None
    context_id = perfil_cidade.get("regional_context_id")
    if context_id and context_id in listar_contextos(regioes, uf):
        return context_id
    return resolver_contexto_legado(
        regioes, uf, perfil_cidade.get("cenario", ""), perfil_cidade.get("elemento_cultural", "")
    )
