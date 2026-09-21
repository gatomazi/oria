"""HTTP adapter of the creative core (integration option B — service/API).

Stateless WSGI app, standard library only. The Oria backend (Node) calls it
server-to-server; browsers never do.

    GET  /v1/health        liveness + versions
    GET  /v1/contracts     strategies, multi-product rules, versions, catalog, JSON Schemas
    POST /v1/validate/<C>  {payload} -> {valid, errors}   (C = exported contract, e.g. BrandKit)
    POST /v1/plans         CreativeRequest            -> CreativePlan
    POST /v1/generations   {plan, references, openai_api_key[, generation_attempt, normalize_references]} -> CreativeResult
    POST /v1/copies        {request, openai_api_key}  -> {variants: CopyVariant[], usage}

Security controls:
  * service-to-service auth: `Authorization: Bearer <CREATIVE_CORE_SERVICE_TOKEN>`,
    compared in constant time; the service refuses to build without a token;
  * BYOK: the tenant key arrives in the JSON body of a single request, is used to
    build a client for that request only, and is never stored, logged or echoed;
  * bodies are size-capped, JSON only, unknown top-level fields rejected;
  * references are inline base64 validated by magic bytes — the service never
    fetches URLs (no SSRF surface);
  * errors are GenerationError dicts (safe messages, no stack traces).

Local run (development only):
    CREATIVE_CORE_SERVICE_TOKEN=... venv/bin/python -m creative_core.service --port 8765
"""
from __future__ import annotations

import hmac
import json
import os
from typing import Callable, Iterable

from . import contracts
from .angles import ANGLE_IDS, CORE_ANGLES
from .engines import generate_copy_with_usage, generate_creative, plan_creative
from .errors import GenerationError
from .kits import list_builtin_kits, load_brand_kit, load_niche_kit
from .model_router import ModelRouter
from .placements import PUBLIC_PLACEMENTS, placement_descriptor
from .references import decode_reference
from .strategies import MULTI_PRODUCT_RULES, SAAS_STRATEGIES, compatibility_matrix
from .versions import version_manifest

MAX_BODY_BYTES = 60 * 1024 * 1024
TOKEN_ENV = "CREATIVE_CORE_SERVICE_TOKEN"
NORMALIZE_REFERENCES_ENV = "CREATIVE_NORMALIZE_REFERENCES"
_TRUTHY = {"1", "true", "yes", "on"}


def _env_flag(name: str, env: dict | None = None) -> bool:
    return str((os.environ if env is None else env).get(name, "")).strip().lower() in _TRUTHY

ClientFactory = Callable[[str], object]


def openai_client_factory(api_key: str):
    """Default BYOK client factory. Imported lazily so the core itself never
    depends on the SDK; max_retries=0 because retry is the job system's call."""
    from openai import OpenAI  # noqa: PLC0415

    return OpenAI(api_key=api_key, max_retries=0)


class CreativeCoreService:
    def __init__(self, token: str, client_factory: ClientFactory = openai_client_factory,
                 router: ModelRouter | None = None, normalize_references: bool = False):
        if not token or len(token) < 32:
            raise ValueError(f"{TOKEN_ENV} must be set with at least 32 characters")
        self._token = token.encode()
        self._client_factory = client_factory
        self._router = router or ModelRouter()
        # Default for POST /v1/generations; a request may override it with `normalize_references`.
        self._normalize_references = normalize_references

    # ------------------------------------------------------------ plumbing
    def __call__(self, environ: dict, start_response) -> Iterable[bytes]:
        try:
            status, payload = self._dispatch(environ)
        except GenerationError as err:
            status, payload = (422 if err.cause == "validation" else 400), {"error": err.to_dict()}
        except Exception:  # noqa: BLE001 — never leak internals
            status, payload = 500, {"error": GenerationError("GENERATION_FAILED").to_dict()}
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        reasons = {200: "OK", 400: "Bad Request", 401: "Unauthorized", 404: "Not Found", 405: "Method Not Allowed",
                   413: "Payload Too Large", 415: "Unsupported Media Type", 422: "Unprocessable Entity",
                   500: "Internal Server Error"}
        start_response(f"{status} {reasons.get(status, 'Error')}", [
            ("Content-Type", "application/json; charset=utf-8"),
            ("Content-Length", str(len(body))),
            ("Cache-Control", "no-store"),
        ])
        return [body]

    def _authorized(self, environ: dict) -> bool:
        header = environ.get("HTTP_AUTHORIZATION", "")
        if not header.startswith("Bearer "):
            return False
        return hmac.compare_digest(header[7:].encode(), self._token)

    @staticmethod
    def _read_json(environ: dict, allowed: set[str], required: set[str]) -> dict:
        if not (environ.get("CONTENT_TYPE") or "").startswith("application/json"):
            raise _HttpError(415, "content type must be application/json")
        try:
            length = int(environ.get("CONTENT_LENGTH") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY_BYTES:
            raise _HttpError(413, "body missing or too large")
        try:
            body = json.loads(environ["wsgi.input"].read(length))
        except (ValueError, UnicodeDecodeError):
            raise GenerationError("INVALID_INPUT", {"errors": ["body: invalid JSON"]}) from None
        if not isinstance(body, dict):
            raise GenerationError("INVALID_INPUT", {"errors": ["body: expected object"]})
        unknown = sorted(set(body) - allowed)
        missing = sorted(required - set(body))
        if unknown or missing:
            raise GenerationError("INVALID_INPUT", {"errors": [f"{k}: unknown field" for k in unknown]
                                                    + [f"{k}: required" for k in missing]})
        return body

    @staticmethod
    def _api_key(body: dict) -> str:
        key = body.get("openai_api_key")
        if not isinstance(key, str) or not (20 <= len(key) <= 300) or any(c.isspace() for c in key):
            raise GenerationError("MODEL_AUTHENTICATION_FAILED", {"reason": "missing_or_malformed_key"})
        return key

    # ------------------------------------------------------------ routes
    def _dispatch(self, environ: dict) -> tuple[int, dict]:
        method = environ.get("REQUEST_METHOD", "GET")
        path = environ.get("PATH_INFO", "")
        routes = {
            ("GET", "/v1/health"): self._health,
            ("GET", "/v1/contracts"): self._contracts,
            ("POST", "/v1/plans"): self._plans,
            ("POST", "/v1/generations"): self._generations,
            ("POST", "/v1/copies"): self._copies,
        }
        if path == "/v1/health" and method == "GET":
            return self._health(environ)
        if not self._authorized(environ):
            return 401, {"error": {"code": "UNAUTHORIZED", "message": "Não autorizado.", "retryable": False,
                                   "cause": "auth", "details": {}}}
        handler = routes.get((method, path))
        if method == "POST" and path.startswith("/v1/validate/"):
            contract = path[len("/v1/validate/"):]

            def handler(env, contract=contract):
                return self._validate(env, contract)
        if handler is None:
            known_paths = {p for _, p in routes}
            return (405 if path in known_paths else 404), {"error": {"code": "NOT_FOUND", "message": "Rota inexistente.",
                                                                     "retryable": False, "cause": "routing", "details": {}}}
        try:
            return handler(environ)
        except _HttpError as err:
            return err.status, {"error": {"code": "INVALID_INPUT", "message": err.reason, "retryable": False,
                                          "cause": "validation", "details": {}}}

    def _health(self, _environ: dict) -> tuple[int, dict]:
        return 200, {"status": "ok", "versions": version_manifest()}

    def _contracts(self, _environ: dict) -> tuple[int, dict]:
        return 200, {
            "versions": version_manifest(),
            "strategies": list(SAAS_STRATEGIES),
            "product_modes": list(contracts.PRODUCT_MODES),
            "multi_product_rules": MULTI_PRODUCT_RULES,
            "compatibility_matrix": compatibility_matrix(),
            "models": self._router.describe(),
            "catalog": self._catalog(),
            "schemas": {name: contracts.json_schema(name) for name in contracts.EXPORTED_CONTRACTS},
        }

    @staticmethod
    def _catalog() -> dict:
        """Everything a panel needs to build the engine forms without hardcoding core data."""
        builtin = list_builtin_kits()
        return {
            "angles": [
                {"id": a, "label": CORE_ANGLES[a]["label"], "description": CORE_ANGLES[a]["description"],
                 "uses_person": CORE_ANGLES[a]["uses_person"], "apparel_only": CORE_ANGLES[a]["apparel_only"]}
                for a in ANGLE_IDS
            ],
            "placements": [placement_descriptor(p) for p in PUBLIC_PLACEMENTS],
            "funnel_stages": list(contracts.FUNNEL_STAGES),
            "remarketing_intents": list(contracts.REMARKETING_INTENTS),
            "qualities": list(contracts.QUALITIES),
            "text_densities": list(contracts.TEXT_DENSITIES),
            "cta_emphases": list(contracts.CTA_EMPHASES),
            "clean_modes": list(contracts.CLEAN_MODES),
            "context_modes": list(contracts.CONTEXT_MODES),
            "builtin_kits": {
                "brand": [load_brand_kit(k) for k in builtin["brand"]],
                "niche": [load_niche_kit(k) for k in builtin["niche"]],
            },
        }

    def _validate(self, environ: dict, contract: str) -> tuple[int, dict]:
        if contract not in contracts.EXPORTED_CONTRACTS:
            return 404, {"error": {"code": "NOT_FOUND", "message": "Contrato inexistente.", "retryable": False,
                                   "cause": "routing", "details": {}}}
        body = self._read_json(environ, allowed={"payload"}, required={"payload"})
        errors = contracts.validate(contract, body["payload"])
        return 200, {"contract": contract, "valid": not errors, "errors": errors[:100]}

    def _plans(self, environ: dict) -> tuple[int, dict]:
        body = self._read_json(environ, allowed={"request"}, required={"request"})
        return 200, {"plan": plan_creative(body["request"], router=self._router)}

    def _generations(self, environ: dict) -> tuple[int, dict]:
        body = self._read_json(environ, allowed={"plan", "references", "openai_api_key", "generation_attempt",
                                                 "normalize_references"},
                               required={"plan", "references", "openai_api_key"})
        refs = body["references"]
        if not isinstance(refs, list) or not refs or len(refs) > 10:
            raise GenerationError("INVALID_REFERENCE", {"reason": "references must be a list of 1-10 items"})
        decoded: dict[str, bytes] = {}
        for item in refs:
            if not isinstance(item, dict) or set(item) != {"ref", "data_base64"}:
                raise GenerationError("INVALID_REFERENCE", {"reason": "each reference needs exactly ref and data_base64"})
            decoded[str(item["ref"])], _mime = decode_reference(str(item["data_base64"]))
        attempt = body.get("generation_attempt", 1)
        if not isinstance(attempt, int) or attempt < 1:
            raise GenerationError("INVALID_INPUT", {"errors": ["generation_attempt: must be a positive integer"]})
        normalize = body.get("normalize_references", self._normalize_references)
        if not isinstance(normalize, bool):
            raise GenerationError("INVALID_INPUT", {"errors": ["normalize_references: must be a boolean"]})
        client = self._client_factory(self._api_key(body))
        result = generate_creative(body["plan"], client=client, references=decoded, router=self._router, attempt=attempt,
                                   normalize_references=normalize)
        return 200, {"result": result}

    def _copies(self, environ: dict) -> tuple[int, dict]:
        body = self._read_json(environ, allowed={"request", "openai_api_key"}, required={"request", "openai_api_key"})
        client = self._client_factory(self._api_key(body))
        variants, usage = generate_copy_with_usage(body["request"], client=client, router=self._router)
        # `usage` acompanha a resposta para o painel poder somar o custo da copy junto ao da imagem.
        return 200, {"variants": variants, "usage": usage}


class _HttpError(Exception):
    def __init__(self, status: int, reason: str):
        super().__init__(reason)
        self.status = status
        self.reason = reason


def create_app() -> CreativeCoreService:
    return CreativeCoreService(os.environ.get(TOKEN_ENV, ""), normalize_references=_env_flag(NORMALIZE_REFERENCES_ENV))


if __name__ == "__main__":
    import argparse
    from wsgiref.simple_server import make_server

    parser = argparse.ArgumentParser(description="creative core HTTP adapter (development server)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    with make_server(args.host, args.port, create_app()) as server:
        print(f"creative core service on http://{args.host}:{args.port}")
        server.serve_forever()
