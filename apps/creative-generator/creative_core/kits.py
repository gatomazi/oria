"""Brand Kit and Niche Kit — permanent configuration layers.

Kits are plain JSON documents validated against contracts.BrandKit /
contracts.NicheKit. Built-in kits live in creative_core/kits/{brand,niche}/;
a SaaS consumer passes its own (tenant-owned) kits inline in the request, so
the core never needs a database. No brand name is special-cased in code.
"""
from __future__ import annotations

import copy
import json
from functools import lru_cache
from pathlib import Path

from .contracts import ensure_valid
from .errors import GenerationError

KITS_DIR = Path(__file__).parent / "kits"
DEFAULT_NICHE_KIT_ID = "generic_commerce"


def _kit_path(kind: str, kit_id: str) -> Path:
    # Kit ids come from requests: only a plain slug may reach the filesystem.
    if not kit_id or not all(c.isalnum() or c in "_-" for c in kit_id):
        raise GenerationError("INVALID_KIT", {"kind": kind})
    return KITS_DIR / kind / f"{kit_id}.json"


@lru_cache(maxsize=32)
def _load(kind: str, kit_id: str) -> dict:
    path = _kit_path(kind, kit_id)
    if not path.is_file():
        raise GenerationError("INVALID_KIT", {"kind": kind, "kit_id": kit_id, "reason": "not_found"})
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    ensure_valid("BrandKit" if kind == "brand" else "NicheKit", data, code="INVALID_KIT")
    return data


def load_brand_kit(kit_id: str) -> dict:
    return copy.deepcopy(_load("brand", kit_id))


def load_niche_kit(kit_id: str) -> dict:
    return copy.deepcopy(_load("niche", kit_id))


def list_builtin_kits() -> dict:
    return {
        kind: sorted(p.stem for p in (KITS_DIR / kind).glob("*.json"))
        for kind in ("brand", "niche")
    }


def validate_brand_kit(kit: dict) -> dict:
    return ensure_valid("BrandKit", kit, code="INVALID_KIT")


def validate_niche_kit(kit: dict) -> dict:
    return ensure_valid("NicheKit", kit, code="INVALID_KIT")


def resolve_kits(request: dict) -> tuple[dict, dict]:
    """Brand kit: inline > built-in id (required, one of them). Niche kit:
    inline > id > brand.defaultNicheKitId > generic_commerce."""
    if request.get("brand_kit"):
        brand = validate_brand_kit(copy.deepcopy(request["brand_kit"]))
    elif request.get("brand_kit_id"):
        brand = load_brand_kit(request["brand_kit_id"])
    else:
        raise GenerationError("INVALID_KIT", {"kind": "brand", "reason": "missing"})

    if request.get("niche_kit"):
        niche = validate_niche_kit(copy.deepcopy(request["niche_kit"]))
    else:
        niche = load_niche_kit(request.get("niche_kit_id") or brand.get("defaultNicheKitId") or DEFAULT_NICHE_KIT_ID)
    return brand, niche


def kit_ref(kit: dict) -> dict:
    return {"id": kit["id"], "version": kit["version"]}


def brand_kit_from_store_pack(brand_pack: dict, angle_labels_pack: dict | None = None, version: int = 1) -> dict:
    """Adapter from the internal store pack format (lojas/<loja>/brand.json +
    angulos.json) to a BrandKit. Proves the existing packs fit the generic
    contract without changing the files the internal generator reads."""
    visual = brand_pack.get("visual") or {}
    rules = brand_pack.get("brandGuardianRules") or []
    if isinstance(rules, dict):
        rules = [r for group in rules.values() if isinstance(group, list) for r in group]
    labels = {
        angle_id: spec["nome"]
        for angle_id, spec in (angle_labels_pack or {}).items()
        if not angle_id.startswith("_") and isinstance(spec, dict) and spec.get("nome")
    }
    kit = {
        "id": brand_pack["id"],
        "name": brand_pack.get("nome") or brand_pack.get("name") or brand_pack["id"],
        "description": brand_pack.get("promise", ""),
        "positioning": [p for p in (brand_pack.get("positioning"), brand_pack.get("manifesto")) if p],
        "tone": list(brand_pack.get("tone") or []),
        "visualStyle": [v for v in (visual.get("referencia"), visual.get("luz"), visual.get("textura")) if v],
        "colors": list(visual.get("paleta") or []),
        "avoid": list(brand_pack.get("avoidWords") or []),
        "manualNotes": list(rules),
        "angleLabels": labels,
        "schemaVersion": 1,
        "version": version,
    }
    return validate_brand_kit(kit)
