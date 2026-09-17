"""Brand Kit, Niche Kit, angles/labels, Context Intelligence and personas."""
from __future__ import annotations

import json

from _support import run

from creative_core import angles, kits
from creative_core.context_intelligence import (
    CustomContextProvider,
    GeographicContextProvider,
    NicheContextProvider,
    deterministic_pick,
    resolve_context,
)
from creative_core.errors import GenerationError
from creative_core.personas import resolve_persona

from creative_core.context_intelligence import DATA_DIR

GEO = GeographicContextProvider.from_package()
REGIOES = json.loads((DATA_DIR / "regioes.json").read_text(encoding="utf-8"))


# ─── kits ─────────────────────────────────────────────────────────────────────

def test_given_builtin_kits_then_all_validate_and_are_listed():
    listed = kits.list_builtin_kits()
    assert listed == {"brand": ["use_origens"], "niche": ["fashion", "generic_commerce"]}
    for kit_id in listed["brand"]:
        assert kits.load_brand_kit(kit_id)["schemaVersion"] == 1
    for kit_id in listed["niche"]:
        assert kits.load_niche_kit(kit_id)["schemaVersion"] == 1


def test_given_use_origens_kit_then_labels_equal_the_regional_labels_of_the_generator():
    labels = kits.load_brand_kit("use_origens")["angleLabels"]
    assert set(labels) == set(angles.ANGLE_IDS)
    assert labels["PRODUTO_ESTAMPA"] == "Flatlay" and labels["IDENTIDADE_ORIGEM"] == "Identidade / Origem"


def test_given_path_traversal_kit_id_when_loading_then_rejected():
    try:
        kits.load_brand_kit("../../config/lojas")
    except GenerationError as err:
        assert err.code == "INVALID_KIT"
    else:
        raise AssertionError("expected INVALID_KIT")


def test_given_request_without_niche_then_brand_default_niche_is_used():
    brand, niche = kits.resolve_kits({"brand_kit_id": "use_origens"})
    assert niche["id"] == "fashion"
    _, niche = kits.resolve_kits({"brand_kit": {"id": "x", "name": "X", "schemaVersion": 1, "version": 1}})
    assert niche["id"] == "generic_commerce"


def test_given_store_pack_when_adapted_then_valid_brand_kit_with_store_labels():
    brand = {"id": "loja_x", "nome": "Loja X", "positioning": "p", "tone": ["leve"],
             "visual": {"paleta": ["creme"], "luz": "janela"}, "brandGuardianRules": ["Sem clichê."]}
    labels = {"_doc": "x", "IDENTIDADE_ORIGEM": {"nome": "Retrato do laço"}}
    kit = kits.brand_kit_from_store_pack(brand, labels)
    assert kit["id"] == "loja_x" and kit["name"] == "Loja X"
    assert kit["angleLabels"] == {"IDENTIDADE_ORIGEM": "Retrato do laço"}
    assert kit["manualNotes"] == ["Sem clichê."] and kit["colors"] == ["creme"]


def test_given_core_source_then_no_brand_is_hardcoded_in_python():
    offenders = []
    from pathlib import Path

    for path in Path(kits.__file__).parent.glob("*.py"):
        text = path.read_text(encoding="utf-8").lower()
        for token in ("use_origens", "use origens", "entre_nos", "use sul", "blumenau"):
            if token in text:
                offenders.append(f"{path.name}:{token}")
    assert not offenders, offenders


# ─── angles ───────────────────────────────────────────────────────────────────

def test_given_13_angle_ids_then_catalog_is_complete_and_ids_are_stable():
    assert angles.ANGLE_IDS == (
        "IDENTIDADE_ORIGEM", "LIFESTYLE_COTIDIANO", "ORGULHO_DISCRETO", "PERTENCIMENTO", "NOSTALGIA_ORIGEM",
        "CABIDE", "PRODUTO_ESTAMPA", "CAIMENTO", "CLOSE_ESTAMPA", "CLOSE_BOLSO", "PREMIUM_ESTILO",
        "CREATOR_STYLE", "PRESENTE_AFETO",
    )
    assert set(angles.CORE_ANGLES) == set(angles.ANGLE_IDS)


def test_given_label_sources_then_brand_beats_niche_beats_core():
    brand = {"angleLabels": {"CABIDE": "Arara da marca"}}
    niche = {"angleLabels": {"CABIDE": "Cabide do nicho", "CAIMENTO": "Vestibilidade"}}
    assert angles.resolve_angle_label("CABIDE", brand, niche) == "Arara da marca"
    assert angles.resolve_angle_label("CAIMENTO", brand, niche) == "Vestibilidade"
    assert angles.resolve_angle_label("PREMIUM_ESTILO", brand, niche) == "Premium / Estilo"


def test_given_non_apparel_niche_then_apparel_angles_are_unavailable():
    generic = kits.load_niche_kit("generic_commerce")
    fashion = kits.load_niche_kit("fashion")
    for apparel in ("CABIDE", "CAIMENTO", "CLOSE_ESTAMPA", "CLOSE_BOLSO"):
        assert not angles.angle_is_available(apparel, {}, generic)
        assert angles.angle_is_available(apparel, {}, fashion)
    assert angles.angle_is_available("PRODUTO_ESTAMPA", {}, generic)


def test_given_brand_enabled_angles_then_others_are_unavailable():
    brand = {"enabledAngles": ["PREMIUM_ESTILO"]}
    assert angles.available_angles(brand, kits.load_niche_kit("fashion")) == ["PREMIUM_ESTILO"]


# ─── context intelligence ─────────────────────────────────────────────────────

def test_given_explicit_regional_context_then_profile_uses_only_that_context():
    profile = GEO.resolve({"name": "Blumenau", "metadata": {"city": "Blumenau", "state": "SC"}}, "vale_europeu")
    ctx = REGIOES["SC"]["contextos"]["vale_europeu"]
    assert profile["contextId"] == "geo:SC:vale_europeu"
    assert profile["sceneContexts"] == ctx["cenario"]
    other = {c for cid, data in REGIOES["SC"]["contextos"].items() if cid != "vale_europeu" for c in data["cenario"]}
    assert not set(profile["sceneContexts"]) & (other - set(ctx["cenario"]))


def test_given_city_without_registered_context_then_provider_never_guesses():
    assert GEO.resolve({"name": "Maringá", "metadata": {"city": "Maringá", "state": "PR"}}) is None
    assert GEO.resolve({"name": "X", "metadata": {"state": "ZZ"}}, "litoral") is None
    assert GEO.resolve({"name": "Blumenau", "metadata": {"state": "SC"}}, "context_of_other_uf") is None


def test_given_automatic_mode_without_geographic_resolution_then_niche_context_is_used():
    brand = kits.load_brand_kit("use_origens")
    niche = kits.load_niche_kit("fashion")
    resolved, profile = resolve_context(
        {"mode": "automatic"}, brand_kit=brand, niche_kit=niche,
        products=[{"id": "p", "metadata": {"city": "Maringá", "state": "PR"}}],
        angle={"uses_person": True}, seed=1, geographic=GEO,
    )
    assert resolved["provider"] == "niche" and profile["contextType"] == "niche"
    assert resolved["scene"] in profile["sceneContexts"]


def test_given_geographic_mode_unresolved_then_context_resolution_failed():
    try:
        resolve_context({"mode": "geographic", "subject": {"name": "Maringá", "metadata": {"state": "PR", "city": "Maringá"}}},
                        brand_kit={}, niche_kit=kits.load_niche_kit("fashion"), products=[],
                        angle={"uses_person": True}, seed=0, geographic=GEO)
    except GenerationError as err:
        assert err.code == "CONTEXT_RESOLUTION_FAILED"
    else:
        raise AssertionError("expected CONTEXT_RESOLUTION_FAILED")


def test_given_custom_profile_not_approved_then_it_never_reaches_a_prompt():
    draft = {"contextId": "c", "contextType": "custom", "subject": {"name": "s"}, "sceneContexts": ["x"],
             "status": "draft", "schemaVersion": 1, "promptVersion": 1, "profileVersion": 1}
    try:
        CustomContextProvider().resolve(draft)
    except GenerationError as err:
        assert err.details["reason"] == "profile_not_approved"
    else:
        raise AssertionError("expected rejection")


def test_given_same_seed_then_scene_is_deterministic_and_rotates_away_from_recent():
    options = ["a", "b", "c"]
    assert deterministic_pick(options, 4) == deterministic_pick(options, 4)
    assert deterministic_pick(options, 0, recent=["a"]) == "b"
    assert deterministic_pick(options, 0, recent=["a", "b", "c"]) == "a"
    assert deterministic_pick([], 3) is None


def test_given_niche_provider_then_brand_preferred_contexts_come_first():
    brand = {"preferredContexts": ["cozinha da marca"]}
    profile = NicheContextProvider().resolve(kits.load_niche_kit("generic_commerce"), brand)
    assert profile["sceneContexts"][0] == "cozinha da marca"


# ─── personas ─────────────────────────────────────────────────────────────────

def test_given_automatic_persona_then_kit_pool_is_used_and_recent_is_skipped():
    niche = kits.load_niche_kit("fashion")
    first = resolve_persona("automatic", None, brand_kit={}, niche_kit=niche, seed=0)
    assert first["label"] == niche["suggestedPersonas"][0]["label"]
    second = resolve_persona("automatic", None, brand_kit={}, niche_kit=niche, seed=0, recent_labels=[first["label"]])
    assert second["label"] != first["label"]


def test_given_custom_persona_or_product_only_angle_then_rules_apply():
    custom = resolve_persona("custom", {"label": "Avó 70 anos"}, brand_kit={}, niche_kit={}, seed=0)
    assert custom == {"label": "Avó 70 anos", "source": "custom"}
    assert resolve_persona("automatic", None, brand_kit={}, niche_kit={}, seed=0, uses_person=False) is None
    assert resolve_persona("none", None, brand_kit={}, niche_kit={}, seed=0) is None


if __name__ == "__main__":
    run(globals())
