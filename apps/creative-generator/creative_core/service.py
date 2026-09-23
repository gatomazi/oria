"""HTTP adapter of the creative core (integration option B — service/API).

Stateless WSGI app, standard library only. The Oria backend (Node) calls it
server-to-server; browsers never do.

    GET  /v1/health        liveness + versions
    GET  /v1/contracts     strategies, multi-product rules, versions, catalog, JSON Schemas
    POST /v1/validate/<C>  {payload} -> {valid, errors}   (C = exported contract, e.g. BrandKit)
    POST /v1/plans         {request}                  -> {plan: CreativePlan}   (request.prompt_version / plan_schema_version 1|2, optional)
    POST /v1/compile       {plan}                     -> {compiled: CompiledPrompt}   (schema_version 2 plans; pure)
    POST /v1/draft         {plan}                     -> {draft: GenerationDraft}   (any persisted plan; pure — "Copiar dados")
    POST /v1/feedback-snapshot {plan[, result_metadata, asset_sha256]} -> {snapshot: FeedbackSnapshot}   (pure — "Gostei / Não gostei")
    POST /v1/generations   {plan, references, openai_api_key[, generation_attempt, normalize_references]} -> CreativeResult
    POST /v1/copies        {request, openai_api_key}  -> {variants: CopyVariant[], usage}
    POST /v1/enrichment/propose {product[, brand, niche, provider, references]} -> {proposal: EnrichmentProposal}
        (pure; `provider` "fake" (default) or "openai" — "openai" is implemented but makes no real
        call this round: this route never wires a client, see _enrichment_propose)

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
from . import angle_catalog, composition
from .compiler import compile_prompt
from .drafts import feedback_snapshot, generation_draft_from_plan
from .engines import generate_copy_with_usage, generate_creative, plan_creative
from . import enrichment
from .errors import GenerationError
from .kits import list_builtin_kits, load_brand_kit, load_niche_kit
from .model_router import ModelRouter
from .placements import PUBLIC_PLACEMENTS, placement_descriptor
from .prompt_v2 import PROMPT_V2_ANGLES
from .references import decode_reference
from .strategies import MULTI_PRODUCT_RULES, SAAS_STRATEGIES, compatibility_matrix
from .versions import COMPILER_VERSION, SUPPORTED_PLAN_SCHEMA_VERSIONS, SUPPORTED_PROMPT_VERSIONS, version_manifest

MAX_BODY_BYTES = 60 * 1024 * 1024
TOKEN_ENV = "CREATIVE_CORE_SERVICE_TOKEN"
NORMALIZE_REFERENCES_ENV = "CREATIVE_NORMALIZE_REFERENCES"
PROMPT_VERSION_ENV = "CREATIVE_PROMPT_VERSION"
PLAN_SCHEMA_VERSION_ENV = "CREATIVE_PLAN_SCHEMA_VERSION"
_TRUTHY = {"1", "true", "yes", "on"}


def _env_flag(name: str, env: dict | None = None) -> bool:
    return str((os.environ if env is None else env).get(name, "")).strip().lower() in _TRUTHY


def _env_plan_schema_version(env: dict | None = None) -> int:
    """CREATIVE_PLAN_SCHEMA_VERSION: 2 builds CreativePlan v2 by default; anything else (unset, garbage) is 1."""
    raw = str((os.environ if env is None else env).get(PLAN_SCHEMA_VERSION_ENV, "")).strip()
    return int(raw) if raw.isdigit() and int(raw) in SUPPORTED_PLAN_SCHEMA_VERSIONS else 1


def _env_prompt_version(env: dict | None = None) -> int:
    """CREATIVE_PROMPT_VERSION: 2 turns the v2 person scenes on by default; anything else (unset, garbage) is 1."""
    raw = str((os.environ if env is None else env).get(PROMPT_VERSION_ENV, "")).strip()
    return int(raw) if raw.isdigit() and int(raw) in SUPPORTED_PROMPT_VERSIONS else 1

ClientFactory = Callable[[str], object]


def openai_client_factory(api_key: str):
    """Default BYOK client factory. Imported lazily so the core itself never
    depends on the SDK; max_retries=0 because retry is the job system's call."""
    from openai import OpenAI  # noqa: PLC0415

    return OpenAI(api_key=api_key, max_retries=0)


class CreativeCoreService:
    def __init__(self, token: str, client_factory: ClientFactory = openai_client_factory,
                 router: ModelRouter | None = None, normalize_references: bool = False, prompt_version: int = 1,
                 plan_schema_version: int = 1):
        if not token or len(token) < 32:
            raise ValueError(f"{TOKEN_ENV} must be set with at least 32 characters")
        self._token = token.encode()
        self._client_factory = client_factory
        self._router = router or ModelRouter()
        # Default for POST /v1/generations; a request may override it with `normalize_references`.
        self._normalize_references = normalize_references
        # Default for POST /v1/plans when the request carries no `prompt_version`.
        self._prompt_version = prompt_version if prompt_version in SUPPORTED_PROMPT_VERSIONS else 1
        # Default for POST /v1/plans when the request carries no `plan_schema_version`.
        self._plan_schema_version = plan_schema_version if plan_schema_version in SUPPORTED_PLAN_SCHEMA_VERSIONS else 1

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
            ("POST", "/v1/compile"): self._compile,
            ("POST", "/v1/draft"): self._draft,
            ("POST", "/v1/feedback-snapshot"): self._feedback_snapshot,
            ("POST", "/v1/generations"): self._generations,
            ("POST", "/v1/copies"): self._copies,
            ("POST", "/v1/enrichment/propose"): self._enrichment_propose,
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
            "prompt_versions": {"supported": list(SUPPORTED_PROMPT_VERSIONS), "default": self._prompt_version,
                                "v2_angles": sorted(PROMPT_V2_ANGLES)},
            "plan_schema_versions": {"supported": list(SUPPORTED_PLAN_SCHEMA_VERSIONS), "default": self._plan_schema_version,
                                     "compiler_version": COMPILER_VERSION},
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
            # Scene composition (Fase C): what a screen needs to name and offer people and interactions.
            "interactions": [{"id": k, "label": v["label"], "min_people": v["min_people"], "max_people": v["max_people"]}
                             for k, v in composition.INTERACTIONS.items()],
            "relations": [{"id": k, "label": v} for k, v in composition.CATALOG["relation_labels"].items() if k != "_doc"],
            # Fase D: family cards for a V2 screen (§6 — no ids/hints/prompt internals below `label`/`description`),
            # plus the legacy angle -> family/preset map so the panel can show "this batch used <family>" for history
            # generated before Fase D, and the discontinued-as-top-level set (still valid as angle_id, not offered as a card).
            "angle_families": [{"id": k, "label": v["label"], "description": v["description"], "reserved": bool(v.get("reserved"))}
                               for k, v in angle_catalog.FAMILIES.items()],
            "angle_legacy_map": {aid: angle_catalog.resolve_angle_meta(aid) for aid in ANGLE_IDS},
            "angle_discontinued": sorted(angle_catalog.DISCONTINUED_AS_TOP_LEVEL),
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
        return 200, {"plan": plan_creative(body["request"], router=self._router, default_prompt_version=self._prompt_version,
                                           default_plan_schema_version=self._plan_schema_version)}

    def _compile(self, environ: dict) -> tuple[int, dict]:
        """Recompiles a persisted schema_version 2 plan (debug/audit/reproduction): same plan + compiler version = same
        prompt. Pure — no provider call, no key."""
        body = self._read_json(environ, allowed={"plan"}, required={"plan"})
        errors = contracts.validate("CreativePlan", body["plan"])
        if errors:
            raise GenerationError("INVALID_INPUT", {"contract": "CreativePlan", "errors": errors[:20]})
        if body["plan"].get("schema_version") != 2:
            raise GenerationError("INVALID_INPUT", {"errors": ["plan: only schema_version 2 plans are compiled here"]})
        return 200, {"compiled": compile_prompt(body["plan"])}

    @staticmethod
    def _persisted_plan(body: dict) -> dict:
        errors = contracts.validate("CreativePlan", body["plan"])
        if errors:
            raise GenerationError("INVALID_INPUT", {"contract": "CreativePlan", "errors": errors[:20]})
        return body["plan"]

    def _draft(self, environ: dict) -> tuple[int, dict]:
        """The generator input that produced a persisted plan, with "again" / "variation" prepared. Pure: no provider
        call, no key, and no state — the panel decides what of the draft still exists (products, profiles)."""
        body = self._read_json(environ, allowed={"plan"}, required={"plan"})
        return 200, {"draft": generation_draft_from_plan(self._persisted_plan(body))}

    def _enrichment_propose(self, environ: dict) -> tuple[int, dict]:
        """A PROPOSAL about one product's semantic_context. Pure: no persistence — the panel stores
        the returned envelope as a pending row and decides approval.

        Fase F.2.A — `provider="openai"` is now accepted (validated against the same
        `EnrichmentProposal.provider` enum the "fake" path always used), and `references` follows
        the EXACT shape/validation `/v1/generations` already uses (`{"ref", "data_base64"}`, decoded
        by magic bytes here — never a caller-supplied MIME label, never a URL: no SSRF surface).

        This round still makes ZERO real OpenAI calls, structurally: this route deliberately does
        NOT accept an `openai_api_key` field and never calls `self._client_factory` for this route,
        so `enrichment.propose(..., client=None)` always refuses `provider="openai"` with a clean
        INVALID_INPUT ("no client configured") before anything resembling a network call — see
        enrichment.py's module note on `_OpenAIProvider` for the full reasoning. Wiring a real,
        request-scoped client (mirroring `_generations`'/`_copies`' BYOK pattern) is explicit F.2.B
        work, authorized separately."""
        body = self._read_json(environ, allowed={"product", "brand", "niche", "provider", "references"}, required={"product"})
        provider = body.get("provider", "fake")
        if provider not in enrichment._PROVIDER_NAMES:
            raise GenerationError("INVALID_INPUT", {"errors": [f"provider: unknown ({provider})"]})
        raw_refs = body.get("references") or []
        if not isinstance(raw_refs, list) or len(raw_refs) > enrichment._MAX_REFERENCES:
            raise GenerationError("INVALID_REFERENCE", {"reason": f"references must be a list of at most {enrichment._MAX_REFERENCES} items"})
        references = []
        for item in raw_refs:
            if not isinstance(item, dict) or set(item) != {"ref", "data_base64"}:
                raise GenerationError("INVALID_REFERENCE", {"reason": "each reference needs exactly ref and data_base64"})
            decode_reference(str(item["data_base64"]))  # fail fast on a malformed reference — never a silent drop at this boundary
            references.append({"data_base64": str(item["data_base64"])})
        proposal = enrichment.propose(body["product"], brand=body.get("brand"), niche=body.get("niche"),
                                      provider=provider, references=references, router=self._router)
        return 200, {"proposal": proposal}

    def _feedback_snapshot(self, environ: dict) -> tuple[int, dict]:
        """What to remember about a creative when the user says liked/disliked, read from its persisted plan. The
        panel adds organization/store/job/user/verdict/timestamps; the snapshot logic lives only here."""
        body = self._read_json(environ, allowed={"plan", "result_metadata", "asset_sha256"}, required={"plan"})
        plan = self._persisted_plan(body)
        metadata, asset = body.get("result_metadata"), body.get("asset_sha256")
        if metadata is not None and not isinstance(metadata, dict):
            raise GenerationError("INVALID_INPUT", {"errors": ["result_metadata: expected object"]})
        if asset is not None and not (isinstance(asset, str) and len(asset) == 64 and all(c in "0123456789abcdef" for c in asset)):
            raise GenerationError("INVALID_INPUT", {"errors": ["asset_sha256: expected 64 hex characters"]})
        return 200, {"snapshot": feedback_snapshot(plan, metadata, asset)}

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
    return CreativeCoreService(os.environ.get(TOKEN_ENV, ""), normalize_references=_env_flag(NORMALIZE_REFERENCES_ENV),
                               prompt_version=_env_prompt_version(),
                               plan_schema_version=_env_plan_schema_version())


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
