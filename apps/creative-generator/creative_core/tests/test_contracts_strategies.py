"""Contracts (validation + exported schemas) and the strategy registry."""
from __future__ import annotations

import json

from _support import ROOT, all_fixtures, run

from creative_core import contracts, strategies
from creative_core.errors import ERROR_CATALOG, GenerationError, classify_provider_exception
from creative_core.versions import STRATEGY_VERSIONS, version_manifest

SCHEMAS = ROOT / "creative_core" / "schemas"


# ─── contracts ────────────────────────────────────────────────────────────────

def test_given_unknown_field_when_validating_then_it_is_rejected():
    errors = contracts.validate("Persona", {"label": "x", "hacker": True})
    assert "hacker: unknown field" in errors


def test_given_missing_required_and_bad_enum_when_validating_then_both_reported():
    errors = contracts.validate("CreativeProduct", {"id": "p", "name": "n", "type": "t", "referenceImages": []})
    assert any("referenceImages" in e and "too few" in e for e in errors), errors
    errors = contracts.validate("ContextProfile", {"contextId": "c", "contextType": "planet", "subject": {"name": "x"},
                                                   "status": "approved", "schemaVersion": 1, "promptVersion": 1,
                                                   "profileVersion": 1})
    assert "contextType: value not allowed" in errors


def test_given_bool_where_integer_expected_when_validating_then_rejected():
    errors = contracts.validate("KitRef", {"id": "x", "version": True})
    assert "version: expected integer" in errors


def test_given_validation_error_when_raised_then_message_never_contains_values():
    try:
        contracts.ensure_valid("Persona", {"label": "sk-SECRET-value-123", "age_range": 5})
    except GenerationError as err:
        dumped = json.dumps(err.to_dict())
        assert "sk-SECRET" not in dumped
        assert err.code == "INVALID_INPUT"
    else:
        raise AssertionError("expected GenerationError")


def test_given_every_fixture_input_when_validated_then_matches_creative_request():
    for fx in all_fixtures():
        assert contracts.validate("CreativeRequest", fx["input"]) == [], fx["name"]


def test_given_exported_schemas_when_compared_then_no_drift_from_code():
    for name in contracts.EXPORTED_CONTRACTS:
        on_disk = json.loads((SCHEMAS / f"{name}.schema.json").read_text(encoding="utf-8"))
        assert on_disk == contracts.json_schema(name), f"{name}: run python -m creative_core.contracts"
    assert (SCHEMAS / "contracts.d.ts").read_text(encoding="utf-8") == contracts.typescript_declarations()


def test_given_schema_when_exported_then_is_closed_and_has_refs_resolved():
    schema = contracts.json_schema("CreativePlan")
    assert schema["additionalProperties"] is False
    for dep in ("Angle", "Placement", "ResolvedContext", "OverlaySpec", "PromptInfo", "CreativeProduct"):
        assert dep in schema["$defs"], dep


def test_given_typescript_export_then_product_mode_is_a_type_not_a_strategy():
    ts = contracts.typescript_declarations()
    assert 'export type ProductMode = "single_product" | "multi_product";' in ts
    assert 'export type PublicStrategy = "CLEAN_ANGLES" | "REMARKETING" | "FUNNEL_VISUAL";' in ts


# ─── strategies ───────────────────────────────────────────────────────────────

def test_given_registry_then_the_6_internal_strategies_are_preserved_in_ui_order():
    assert strategies.MODO_CRIACAO == [
        "FUNIL_VISUAL", "COLECAO_ESTADO", "REMARKETING", "ANGULOS_LIMPOS", "ANGULOS_MULTIPECA", "ORGANICO",
    ]
    assert set(strategies.LABEL_POR_ESTRATEGIA) == set(strategies.MODO_CRIACAO)
    assert set(STRATEGY_VERSIONS) == set(strategies.INTERNAL_STRATEGIES)


def test_given_registry_then_saas_exposes_only_3_engines_and_no_multi_product_strategy():
    assert strategies.SAAS_STRATEGIES == ("CLEAN_ANGLES", "REMARKETING", "FUNNEL_VISUAL")
    for hidden in ("STATE_COLLECTION", "MULTI_PRODUCT_INTERNAL", "ORGANIC"):
        assert not strategies.is_public(hidden)
    assert contracts.PUBLIC_STRATEGIES == strategies.SAAS_STRATEGIES
    assert "MULTI_PRODUCT_INTERNAL" not in contracts.CONTRACTS["CreativeRequest"]["strategy"].enum


def test_given_internal_or_canonical_id_then_both_resolve():
    assert strategies.canonical_id("ANGULOS_LIMPOS") == "CLEAN_ANGLES"
    assert strategies.canonical_id("CLEAN_ANGLES") == "CLEAN_ANGLES"
    assert strategies.internal_id("FUNNEL_VISUAL") == "FUNIL_VISUAL"


def test_given_multi_product_rules_then_limits_and_intents_match_spec():
    assert strategies.product_limits("CLEAN_ANGLES", "multi_product") == {"min": 2, "max": 6}
    assert strategies.product_limits("FUNNEL_VISUAL", "multi_product") == {"min": 2, "max": 6}
    assert strategies.product_limits("REMARKETING", "single_product") == {"min": 1, "max": 1}
    rule = strategies.MULTI_PRODUCT_RULES["REMARKETING"]
    assert set(rule["allowedIntents"]) == {"site_visitor", "collection_discovery", "social_proof", "objection"}
    assert rule["singleOnlyIntents"] == ["product_view"]


def test_given_versions_then_manifest_has_every_handoff_field():
    manifest = version_manifest()
    for key in ("core_version", "schema_version", "prompt_version", "clean_angles_version",
                "remarketing_version", "funnel_visual_version"):
        assert key in manifest


# ─── errors ───────────────────────────────────────────────────────────────────

def test_given_provider_exception_with_secret_when_classified_then_safe_code_only():
    class AuthenticationError(Exception):
        status_code = 401

    err = classify_provider_exception(AuthenticationError("Incorrect API key provided: sk-proj-abc123"))
    assert err.code == "MODEL_AUTHENTICATION_FAILED" and not err.retryable
    assert "sk-proj" not in json.dumps(err.to_dict())


def test_given_rate_limit_and_server_errors_then_retryable():
    class RateLimitError(Exception):
        pass

    class Boom(Exception):
        status_code = 503

    assert classify_provider_exception(RateLimitError()).retryable
    assert classify_provider_exception(Boom()).code == "MODEL_UNAVAILABLE"


def test_given_catalog_then_every_code_has_safe_message_and_flags():
    for code, (message, retryable, cause) in ERROR_CATALOG.items():
        assert message and isinstance(retryable, bool) and cause, code


if __name__ == "__main__":
    run(globals())
