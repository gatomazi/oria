"""HTTP adapter (WSGI) — auth, BYOK handling, validation and happy paths."""
from __future__ import annotations

import base64
import io
import json

from _support import AuthenticationError, FakeClient, FakeImages, load_fixture, png_bytes, run

from creative_core.model_router import ModelRouter
from creative_core.service import CreativeCoreService

TOKEN = "t" * 40
KEY = "sk-test-BYOK-key-0123456789abcdef"


class Factory:
    def __init__(self, client=None):
        self.keys: list[str] = []
        self.client = client or FakeClient()

    def __call__(self, api_key: str):
        self.keys.append(api_key)
        return self.client


def _app(factory=None):
    factory = factory or Factory()
    return CreativeCoreService(TOKEN, client_factory=factory, router=ModelRouter(env={})), factory


def _call(app, method, path, body=None, token=TOKEN, content_type="application/json", raw=None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else b"")
    environ = {
        "REQUEST_METHOD": method, "PATH_INFO": path, "CONTENT_TYPE": content_type,
        "CONTENT_LENGTH": str(len(data)), "wsgi.input": io.BytesIO(data),
    }
    if token:
        environ["HTTP_AUTHORIZATION"] = f"Bearer {token}"
    captured = {}

    def start_response(status, headers):
        captured["status"] = int(status.split()[0])
        captured["headers"] = dict(headers)

    payload = b"".join(app(environ, start_response))
    return captured["status"], json.loads(payload), captured["headers"]


def test_given_short_token_when_building_service_then_refuses():
    try:
        CreativeCoreService("short")
    except ValueError:
        pass
    else:
        raise AssertionError("service accepted weak token")


def test_given_health_then_public_and_has_versions():
    app, _ = _app()
    status, body, headers = _call(app, "GET", "/v1/health", token=None)
    assert status == 200 and body["versions"]["core_version"]
    assert headers["Cache-Control"] == "no-store"


def test_given_missing_or_wrong_token_then_401():
    app, _ = _app()
    assert _call(app, "GET", "/v1/contracts", token=None)[0] == 401
    assert _call(app, "GET", "/v1/contracts", token="x" * 40)[0] == 401


def test_given_contracts_then_only_public_engines_and_schemas_exposed():
    app, _ = _app()
    status, body, _ = _call(app, "GET", "/v1/contracts")
    assert status == 200
    assert body["strategies"] == ["CLEAN_ANGLES", "REMARKETING", "FUNNEL_VISUAL"]
    assert body["product_modes"] == ["single_product", "multi_product"]
    assert "CreativePlan" in body["schemas"] and "REMARKETING" in body["multi_product_rules"]


def test_given_contracts_then_catalog_lets_panel_build_forms():
    app, _ = _app()
    catalog = _call(app, "GET", "/v1/contracts")[1]["catalog"]
    assert len(catalog["angles"]) == 13 and {"id", "label", "uses_person", "apparel_only"} <= set(catalog["angles"][0])
    assert [p["id"] for p in catalog["placements"]] == ["FEED_4X5", "STORY_9X16"]
    assert "cart" in catalog["remarketing_intents"] and catalog["funnel_stages"] == ["TOFU", "MOFU", "BOFU"]
    assert {k["id"] for k in catalog["builtin_kits"]["niche"]} == {"fashion", "generic_commerce"}


def test_given_validate_endpoint_then_reports_errors_without_values():
    app, _ = _app()
    status, body, _ = _call(app, "POST", "/v1/validate/BrandKit", {"payload": {"id": "x", "name": "X", "schemaVersion": 1, "version": 1}})
    assert status == 200 and body["valid"] is True
    status, body, _ = _call(app, "POST", "/v1/validate/BrandKit", {"payload": {"id": "x", "evil": "sk-SECRET"}})
    assert status == 200 and body["valid"] is False and "evil: unknown field" in body["errors"]
    assert "sk-SECRET" not in json.dumps(body)
    assert _call(app, "POST", "/v1/validate/Nope", {"payload": {}})[0] == 404
    assert _call(app, "POST", "/v1/validate/BrandKit", {"payload": {}}, token=None)[0] == 401


def test_given_plan_request_then_plan_returned():
    app, _ = _app()
    status, body, _ = _call(app, "POST", "/v1/plans", {"request": load_fixture("fixture-clean-multi")["input"]})
    assert status == 200 and body["plan"]["product_mode"] == "multi_product"


def test_given_unknown_top_level_field_or_invalid_request_then_422():
    app, _ = _app()
    status, body, _ = _call(app, "POST", "/v1/plans", {"request": {}, "debug": True})
    assert status == 422 and "debug: unknown field" in body["error"]["details"]["errors"]
    status, body, _ = _call(app, "POST", "/v1/plans", {"request": {"strategy": "ORGANIC"}})
    assert status == 422 and body["error"]["code"] == "INVALID_INPUT"


def test_given_non_json_content_type_or_empty_body_then_rejected():
    app, _ = _app()
    assert _call(app, "POST", "/v1/plans", {"request": {}}, content_type="text/plain")[0] == 415
    assert _call(app, "POST", "/v1/plans", raw=b"")[0] == 413


def test_given_unknown_route_or_wrong_method_then_404_or_405():
    app, _ = _app()
    assert _call(app, "GET", "/v1/nope")[0] == 404
    assert _call(app, "GET", "/v1/plans")[0] == 405


def test_given_generation_with_byok_then_key_used_once_and_never_echoed():
    app, factory = _app()
    plan = _call(app, "POST", "/v1/plans", {"request": load_fixture("fixture-clean-single")["input"]})[1]["plan"]
    refs = [{"ref": r["ref"], "data_base64": base64.b64encode(png_bytes()).decode()} for r in plan["references"]]
    status, body, _ = _call(app, "POST", "/v1/generations", {"plan": plan, "references": refs, "openai_api_key": KEY})
    assert status == 200 and body["result"]["status"] == "completed"
    assert factory.keys == [KEY]
    assert KEY not in json.dumps(body)


def test_given_provider_rejects_key_then_safe_failed_result_without_key():
    client = FakeClient(images=FakeImages(error=AuthenticationError(f"Incorrect API key provided: {KEY}")))
    app, _ = _app(Factory(client))
    plan = _call(app, "POST", "/v1/plans", {"request": load_fixture("fixture-clean-single")["input"]})[1]["plan"]
    refs = [{"ref": r["ref"], "data_base64": base64.b64encode(png_bytes()).decode()} for r in plan["references"]]
    status, body, _ = _call(app, "POST", "/v1/generations", {"plan": plan, "references": refs, "openai_api_key": KEY})
    assert status == 200 and body["result"]["error"]["code"] == "MODEL_AUTHENTICATION_FAILED"
    assert KEY not in json.dumps(body)


def test_given_malformed_key_or_reference_then_rejected_before_provider():
    app, factory = _app()
    plan = _call(app, "POST", "/v1/plans", {"request": load_fixture("fixture-clean-single")["input"]})[1]["plan"]
    good_ref = [{"ref": plan["references"][0]["ref"], "data_base64": base64.b64encode(png_bytes()).decode()}]
    status, body, _ = _call(app, "POST", "/v1/generations", {"plan": plan, "references": good_ref, "openai_api_key": "x"})
    assert status == 400 and body["error"]["code"] == "MODEL_AUTHENTICATION_FAILED"
    svg = [{"ref": "r", "data_base64": base64.b64encode(b"<svg/>").decode()}]
    status, body, _ = _call(app, "POST", "/v1/generations", {"plan": plan, "references": svg, "openai_api_key": KEY})
    assert status == 422 and body["error"]["code"] == "INVALID_REFERENCE"
    url_ref = [{"ref": "r", "url": "http://169.254.169.254/latest"}]
    status, body, _ = _call(app, "POST", "/v1/generations", {"plan": plan, "references": url_ref, "openai_api_key": KEY})
    assert status == 422 and factory.keys == []


def test_given_unexpected_internal_error_then_500_without_details():
    app, _ = _app()

    def boom(_environ):
        raise RuntimeError("secret internal path /etc/passwd")

    app._plans = boom  # noqa: SLF001 — test double
    status, body, _ = _call(app, "POST", "/v1/plans", {"request": {}})
    assert status == 500 and "passwd" not in json.dumps(body)


if __name__ == "__main__":
    run(globals())
