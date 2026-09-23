"""Error contract of the creative core.

Every failure that crosses the core boundary is a GenerationError with a stable
`code`, a message that is safe to show to an end user, a `retryable` flag and a
coarse `cause`. Raw exception text, prompts and credentials never go into the
safe message: provider errors can echo request data (including API keys), so
they are classified by type/status only.
"""
from __future__ import annotations

from dataclasses import dataclass, field

# code -> (safe message, retryable, cause)
ERROR_CATALOG: dict[str, tuple[str, bool, str]] = {
    "INVALID_INPUT": ("A requisição tem campos inválidos.", False, "validation"),
    "INVALID_PRODUCT": ("Produto inválido ou incompleto.", False, "validation"),
    "INVALID_REFERENCE": ("Imagem de referência ausente ou em formato não suportado.", False, "validation"),
    "UNSUPPORTED_STRATEGY": ("Estratégia não disponível.", False, "validation"),
    "UNSUPPORTED_ANGLE": ("Ângulo não disponível para esta marca, nicho ou estratégia.", False, "validation"),
    "INTERACTION_INCOMPATIBLE": ("A interação escolhida não cabe na quantidade de pessoas da cena.", False, "validation"),
    "UNSUPPORTED_PRODUCT_MODE": ("Modo de produto não suportado para esta combinação.", False, "validation"),
    "PRODUCT_COUNT_OUT_OF_RANGE": ("Quantidade de produtos fora do limite permitido.", False, "validation"),
    "INVALID_KIT": ("Brand Kit ou Niche Kit inválido.", False, "validation"),
    "CONTEXT_RESOLUTION_FAILED": ("Não foi possível resolver o contexto da cena.", False, "context"),
    "PROMPT_BUILD_FAILED": ("Não foi possível montar o plano do criativo.", False, "internal"),
    "MODEL_AUTHENTICATION_FAILED": ("A credencial do provedor de IA foi recusada.", False, "provider_auth"),
    "MODEL_RATE_LIMITED": ("Limite de uso do provedor de IA atingido. Tente novamente em instantes.", True, "provider_rate_limit"),
    "MODEL_UNAVAILABLE": ("Provedor de IA indisponível no momento.", True, "provider_unavailable"),
    "CONTENT_POLICY_REJECTED": ("O provedor de IA recusou gerar este conteúdo.", False, "provider_policy"),
    "GENERATION_FAILED": ("Falha ao gerar o criativo.", True, "provider_error"),
    "ASSET_PROCESSING_FAILED": ("Falha ao processar a imagem gerada.", True, "asset"),
    # Fase F.2.A: distinct from MODEL_UNAVAILABLE (the provider is reachable but reported the model
    # unavailable) — this is a LOCAL configuration problem: every candidate the router resolved for
    # the task is missing from this codebase's own versioned allowlist (see
    # enrichment.py::_OPENAI_MODEL_ALLOWLIST). Never retryable by itself — retrying without fixing
    # the allowlist/env var produces the same refusal.
    "MODEL_NOT_ALLOWLISTED": ("Nenhum modelo configurado para esta tarefa está na lista aprovada.", False, "configuration"),
}


@dataclass
class GenerationError(Exception):
    """Domain error with a user-safe message. `details` carries only
    non-sensitive structured data (field names, limits, ids)."""

    code: str
    details: dict = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.code not in ERROR_CATALOG:
            raise ValueError(f"unknown error code: {self.code}")
        super().__init__(self.code)

    @property
    def message(self) -> str:
        return ERROR_CATALOG[self.code][0]

    @property
    def retryable(self) -> bool:
        return ERROR_CATALOG[self.code][1]

    @property
    def cause(self) -> str:
        return ERROR_CATALOG[self.code][2]

    def to_dict(self) -> dict:
        return {
            "code": self.code,
            "message": self.message,
            "retryable": self.retryable,
            "cause": self.cause,
            "details": dict(self.details),
        }


_AUTH_ERRORS = {"AuthenticationError", "PermissionDeniedError"}
_RATE_LIMIT_ERRORS = {"RateLimitError"}
_UNAVAILABLE_ERRORS = {"APIConnectionError", "APITimeoutError", "InternalServerError", "ServiceUnavailableError"}


def classify_provider_exception(exc: BaseException) -> GenerationError:
    """Maps an SDK/provider exception to a GenerationError without reading its
    message (it may contain request data). Uses class name and HTTP status only,
    so the core never needs to import the provider SDK."""
    if isinstance(exc, GenerationError):
        return exc
    name = type(exc).__name__
    status = getattr(exc, "status_code", None)
    if name in _AUTH_ERRORS or status in (401, 403):
        return GenerationError("MODEL_AUTHENTICATION_FAILED", {"provider_status": status})
    if name in _RATE_LIMIT_ERRORS or status == 429:
        return GenerationError("MODEL_RATE_LIMITED", {"provider_status": status})
    if name in _UNAVAILABLE_ERRORS or (isinstance(status, int) and status >= 500):
        return GenerationError("MODEL_UNAVAILABLE", {"provider_status": status})
    code = getattr(exc, "code", None)
    if code in ("content_policy_violation", "moderation_blocked"):
        return GenerationError("CONTENT_POLICY_REJECTED", {"provider_status": status})
    return GenerationError("GENERATION_FAILED", {"provider_status": status, "error_type": name})
