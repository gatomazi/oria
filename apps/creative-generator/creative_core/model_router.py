"""Model Router — the single place that decides which model serves which task.

Tasks: copy, structured output, context intelligence, prompt planning, vision
QA and image generation. Defaults can be overridden by environment variables
(the internal generator already used OPENAI_TEXT_MODEL) or by an explicit
mapping (a SaaS tenant setting). Fallback models are tried only for errors
that mean "this model is not available", never for auth/policy errors.

The router never creates a client and never reads an API key: credentials are
the caller's concern (internal app: global client; SaaS: BYOK per tenant).
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Callable, Mapping, TypeVar

T = TypeVar("T")

COPY = "copy"
STRUCTURED_OUTPUT = "structured_output"
CONTEXT_INTELLIGENCE = "context_intelligence"
PROMPT_PLANNING = "prompt_planning"
VISION_QA = "vision_qa"
IMAGE_GENERATION = "image_generation"
TASKS = (COPY, STRUCTURED_OUTPUT, CONTEXT_INTELLIGENCE, PROMPT_PLANNING, VISION_QA, IMAGE_GENERATION)

DEFAULT_TEXT_MODEL = "gpt-5.6"
DEFAULT_IMAGE_MODEL = "gpt-image-2"

# task -> env var holding the model override (text tasks share OPENAI_TEXT_MODEL,
# as the internal generator always did).
ENV_BY_TASK = {
    COPY: "OPENAI_TEXT_MODEL",
    STRUCTURED_OUTPUT: "OPENAI_TEXT_MODEL",
    CONTEXT_INTELLIGENCE: "OPENAI_TEXT_MODEL",
    PROMPT_PLANNING: "OPENAI_TEXT_MODEL",
    VISION_QA: "OPENAI_TEXT_MODEL",
    IMAGE_GENERATION: "OPENAI_IMAGE_MODEL",
}
FALLBACK_ENV_SUFFIX = "_FALLBACKS"

_MODEL_UNAVAILABLE_TYPES = {"NotFoundError"}


@dataclass(frozen=True)
class ModelRoute:
    task: str
    model: str
    fallbacks: tuple[str, ...] = ()


class ModelRouter:
    def __init__(self, overrides: Mapping[str, str] | None = None, env: Mapping[str, str] | None = None):
        env = os.environ if env is None else env
        overrides = overrides or {}
        routes: dict[str, ModelRoute] = {}
        for task in TASKS:
            default = DEFAULT_IMAGE_MODEL if task == IMAGE_GENERATION else DEFAULT_TEXT_MODEL
            var = ENV_BY_TASK[task]
            model = overrides.get(task) or env.get(var) or default
            fallbacks = tuple(
                m.strip() for m in (env.get(var + FALLBACK_ENV_SUFFIX) or "").split(",") if m.strip() and m.strip() != model
            )
            routes[task] = ModelRoute(task, model, fallbacks)
        self._routes = routes

    def route(self, task: str) -> ModelRoute:
        if task not in self._routes:
            raise KeyError(task)
        return self._routes[task]

    def model_for(self, task: str) -> str:
        return self.route(task).model

    def candidates(self, task: str) -> list[str]:
        route = self.route(task)
        return [route.model, *route.fallbacks]

    def run(self, task: str, call: Callable[[str], T]) -> T:
        """Calls `call(model)` with the primary model, falling back only when the
        provider reports the model itself as unavailable (404 / NotFoundError)."""
        return self.run_traced(task, call)[0]

    def run_traced(self, task: str, call: Callable[[str], T], tried: list[str] | None = None) -> tuple[T, str]:
        """Same as `run`, but also says WHICH candidate answered. `tried` (when given) is filled, in
        order, with every model attempted — including the ones that failed as unavailable — so a
        caller can still record them when the whole chain ends in an error."""
        last_exc: BaseException | None = None
        for model in self.candidates(task):
            if tried is not None:
                tried.append(model)
            try:
                return call(model), model
            except Exception as exc:  # noqa: BLE001 — classified below, re-raised otherwise
                unavailable = type(exc).__name__ in _MODEL_UNAVAILABLE_TYPES or getattr(exc, "status_code", None) == 404
                if not unavailable:
                    raise
                last_exc = exc
        assert last_exc is not None
        raise last_exc

    def describe(self) -> dict:
        return {t: {"model": r.model, "fallbacks": list(r.fallbacks)} for t, r in self._routes.items()}
