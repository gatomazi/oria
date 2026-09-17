"""Context Intelligence — Brand + Niche + Context, kept as separate layers.

Three providers produce a ContextProfile (contracts.ContextProfile):

  GeographicContextProvider  UF -> regional context -> scenes/elements, backed by
                             config/regioes.json + config/cidades.json and the
                             pure domain.regional_context rules (a context never
                             mixes scenes of another context of the same UF).
  NicheContextProvider       scenes, activities and materials of a Niche Kit,
                             with the brand's preferred contexts first.
  CustomContextProvider      a profile authored by the consumer (tenant). Only
                             `approved` profiles are usable.

`Contexto = Automático` is resolved by resolve_context(): Brand Kit -> Niche
Kit -> product -> angle -> providers -> history (the engine adds strategy and
persona on top: engines.plan_creative passes them in the same seed). The
final scene choice is deterministic (seed + rotation away from recently used
scenes) — automatic never means a random scenario.
"""
from __future__ import annotations

import json
import unicodedata
from pathlib import Path

from .domain.regional_context import label_contexto, listar_contextos, obter_contexto, resolver_contexto_para_cidade
from .errors import GenerationError
from .versions import CONTEXT_PROFILE_SCHEMA_VERSION, CONTEXT_PROMPT_VERSION

# Snapshot of the generator's regional catalog (config/regioes.json + config/cidades.json),
# shipped with the package so the service is self-contained. Refresh with scripts/sync_data.py.
DATA_DIR = Path(__file__).resolve().parent / "data"
NEUTRAL_SCENE = "ambiente contemporâneo neutro, luz natural suave, sem elementos que dominem o produto"


def _profile(context_id: str, context_type: str, subject: dict, **fields) -> dict:
    profile = {
        "contextId": context_id,
        "contextType": context_type,
        "subject": subject,
        "status": fields.pop("status", "approved"),
        "schemaVersion": CONTEXT_PROFILE_SCHEMA_VERSION,
        "promptVersion": CONTEXT_PROMPT_VERSION,
        "profileVersion": fields.pop("profileVersion", 1),
    }
    profile.update({k: v for k, v in fields.items() if v not in (None, [], "")})
    return profile


def _normalize(text: str) -> str:
    return unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode().strip().lower()


class GeographicContextProvider:
    name = "geographic"

    def __init__(self, regioes: dict, cidades: dict | None = None):
        self._regioes = regioes
        self._cidades = cidades or {}

    @classmethod
    def from_package(cls, data_dir: Path = DATA_DIR) -> "GeographicContextProvider":
        with open(data_dir / "regioes.json", encoding="utf-8") as f:
            regioes = json.load(f)
        cidades_path = data_dir / "cidades.json"
        cidades = {}
        if cidades_path.is_file():
            with open(cidades_path, encoding="utf-8") as f:
                cidades = json.load(f)
        return cls(regioes, cidades)

    def _city_profile(self, city: str, state: str) -> dict | None:
        target = _normalize(city)
        for name, profile in (self._cidades.get(state, {}) or {}).items():
            if _normalize(name) == target:
                return profile
        return None

    def resolve(self, subject: dict, context_id: str | None = None) -> dict | None:
        meta = subject.get("metadata") or {}
        state = (meta.get("state") or meta.get("uf") or "").upper()
        city = meta.get("city") or meta.get("cidade") or ""
        if state not in self._regioes:
            return None
        status, confidence = "approved", 1.0
        if context_id:
            if context_id not in listar_contextos(self._regioes, state):
                return None
        else:
            context_id = resolver_contexto_para_cidade(self._regioes, state, self._city_profile(city, state))
            if not context_id:
                # Unresolved city: never pick one of the UF contexts at random.
                return None
            confidence = 0.8
        ctx = obter_contexto(self._regioes, state, context_id)
        return _profile(
            f"geo:{state}:{context_id}", "geographic", subject,
            status=status,
            summary=f"{label_contexto(context_id)} — {ctx.get('descricao', '')}".strip(" —"),
            sceneContexts=list(ctx.get("cenario") or []),
            domainElements=list(ctx.get("elementos_culturais") or []),
            visualSignatures=list(self._regioes[state].get("paleta") or []),
            avoid=list(ctx.get("evitar") or []) + [f"usar com cuidado: {x}" for x in ctx.get("usar_com_cuidado") or []],
            sources=["data/regioes.json"] + (["data/cidades.json"] if city else []),
            confidence=confidence,
        )


class NicheContextProvider:
    name = "niche"

    def resolve(self, niche_kit: dict, brand_kit: dict | None = None) -> dict:
        brand_kit = brand_kit or {}
        scenes = list(brand_kit.get("preferredContexts") or []) + list(niche_kit.get("sceneContexts") or [])
        return _profile(
            f"niche:{niche_kit['id']}", "niche", {"name": niche_kit["name"], "metadata": {"niche_kit_id": niche_kit["id"]}},
            summary=f"Contexto do nicho {niche_kit['name']}",
            sceneContexts=list(dict.fromkeys(scenes)),
            activities=list(niche_kit.get("activities") or []),
            materials=list(niche_kit.get("materials") or []),
            avoid=list(niche_kit.get("avoid") or []) + list(niche_kit.get("visualCliches") or []),
            sources=[f"niche_kit:{niche_kit['id']}@{niche_kit['version']}"],
            profileVersion=niche_kit["version"],
            confidence=0.7,
        )


class CustomContextProvider:
    name = "custom"

    def resolve(self, profile: dict) -> dict:
        from .contracts import ensure_valid

        ensure_valid("ContextProfile", profile, code="CONTEXT_RESOLUTION_FAILED")
        if profile["status"] != "approved":
            # Drafts (e.g. AI suggestions not yet reviewed) never reach a prompt.
            raise GenerationError("CONTEXT_RESOLUTION_FAILED", {"reason": "profile_not_approved"})
        if not profile.get("sceneContexts"):
            raise GenerationError("CONTEXT_RESOLUTION_FAILED", {"reason": "profile_without_scenes"})
        return profile


def deterministic_pick(options: list, seed: int, recent: list | None = None) -> str | None:
    """Stable choice: rotate by seed, skipping recently used values when possible."""
    if not options:
        return None
    recent_set = set(recent or [])
    fresh = [o for o in options if o not in recent_set] or list(options)
    return fresh[seed % len(fresh)]


def _product_location(products: list) -> dict | None:
    for product in products:
        meta = product.get("metadata") or {}
        if meta.get("state") or meta.get("uf"):
            return meta
    return None


def resolve_context(
    selection: dict | None,
    *,
    brand_kit: dict,
    niche_kit: dict,
    products: list,
    angle: dict,
    seed: int,
    recent_scenes: list | None = None,
    geographic: GeographicContextProvider | None = None,
) -> tuple[dict, dict]:
    """Returns (ResolvedContext, ContextProfile)."""
    selection = selection or {"mode": "automatic"}
    mode = selection.get("mode", "automatic")
    profile: dict | None = None
    provider = ""

    if mode in ("custom", "automatic") and selection.get("profile"):
        profile, provider = CustomContextProvider().resolve(selection["profile"]), "custom"
    elif mode == "custom":
        raise GenerationError("CONTEXT_RESOLUTION_FAILED", {"reason": "custom_profile_missing"})

    if profile is None and mode in ("geographic", "automatic"):
        wants_geo = mode == "geographic" or brand_kit.get("defaultContextProvider") == "geographic"
        subject = selection.get("subject")
        location = (subject or {}).get("metadata") if subject else _product_location(products)
        if wants_geo and location:
            geographic = geographic or GeographicContextProvider.from_package()
            subj = subject or {
                "name": location.get("city") or location.get("cidade") or location.get("state") or location.get("uf"),
                "metadata": {k: v for k, v in location.items() if k in ("city", "cidade", "state", "uf")},
            }
            profile = geographic.resolve(subj, selection.get("context_id"))
            provider = "geographic" if profile else ""
        if profile is None and mode == "geographic":
            raise GenerationError("CONTEXT_RESOLUTION_FAILED", {"reason": "geographic_context_unresolved"})

    if profile is None:
        profile, provider = NicheContextProvider().resolve(niche_kit, brand_kit), "niche"

    scenes = list(profile.get("sceneContexts") or []) or [NEUTRAL_SCENE]
    scene = deterministic_pick(scenes, seed, recent_scenes)
    if angle.get("uses_person"):
        pool = profile.get("activities") if provider == "niche" else profile.get("domainElements")
    else:
        # Product-only angles take the context as atmosphere (materials), not as a set.
        pool = profile.get("materials") if provider == "niche" else profile.get("visualSignatures")
    element = deterministic_pick([e for e in (pool or []) if "nenhum" not in e.lower()], seed // 7)
    avoid = list(dict.fromkeys(
        list(profile.get("avoid") or []) + list(brand_kit.get("avoid") or []) + list(niche_kit.get("avoid") or [])
    ))
    resolved = {
        "context_id": profile["contextId"],
        "context_type": profile["contextType"],
        "provider": provider,
        "scene": scene,
        "supporting_element": element,
        "avoid": avoid,
        "status": profile["status"],
        "profile_version": profile["profileVersion"],
    }
    return resolved, profile
