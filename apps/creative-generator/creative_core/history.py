"""Generation history — one versioned record per generated creative.

The internal generator appends records to a local JSONL file
(outputs/_history/generations.jsonl, ignored by git/deploy). A SaaS consumer
persists the same record shape in its own database; the core never assumes
where history lives. Non-applicable fields are null.
"""
from __future__ import annotations

import json
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .contracts import CONTRACTS, validate
from .versions import CORE_VERSION, PROMPT_VERSION, SCHEMA_VERSION

RECORD_FIELDS = tuple(CONTRACTS["GenerationRecord"].keys())


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_creative_id() -> str:
    return str(uuid.uuid4())


def build_record(**fields) -> dict:
    """Fills every field of GenerationRecord (missing -> null) and the versions
    the core owns. Unknown keys go to `extra`, so callers cannot break the shape."""
    extra = {k: v for k, v in fields.items() if k not in RECORD_FIELDS}
    record = {name: fields.get(name) for name in RECORD_FIELDS}
    record["creative_id"] = record["creative_id"] or new_creative_id()
    record["created_at"] = record["created_at"] or utc_now()
    record["schema_version"] = record["schema_version"] or SCHEMA_VERSION
    record["core_version"] = record["core_version"] or CORE_VERSION
    if record["prompt_version"] is None:
        record["prompt_version"] = PROMPT_VERSION
    if extra:
        record["extra"] = {**(record.get("extra") or {}), **extra}
    return record


def record_from_plan(plan: dict, asset: str | None = None) -> dict:
    from .strategies import strategy_version

    return build_record(
        creative_id=plan["creative_id"],
        strategy=plan["strategy"],
        internal_strategy_id=plan["internal_strategy_id"],
        product_mode=plan["product_mode"],
        product_ids=[p["id"] for p in plan["products"]],
        angle=plan["angle"]["id"],
        context=plan["context"]["context_id"],
        persona=(plan.get("persona") or {}).get("label"),
        placement=plan["placement"]["id"],
        brand_kit=plan["brand_kit"]["id"],
        niche_kit=plan["niche_kit"]["id"],
        funnel_stage=plan.get("funnel_stage"),
        remarketing_intent=plan.get("remarketing_intent"),
        quality=plan["model"]["quality"],
        asset=asset,
        prompt_version=plan["prompt"]["prompt_version"],
        brand_kit_version=plan["brand_kit"]["version"],
        niche_kit_version=plan["niche_kit"]["version"],
        context_profile_version=plan["context"]["profile_version"],
        strategy_version=strategy_version(plan["strategy"]),
    )


class JsonlHistoryStore:
    """Append-only local store. Thread-safe within one process."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self._lock = threading.Lock()

    def append(self, record: dict) -> dict:
        errors = validate("GenerationRecord", record)
        if errors:
            raise ValueError(f"invalid generation record: {errors}")
        line = json.dumps(record, ensure_ascii=False)
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with open(self.path, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        return record

    def read(self, limit: int | None = None) -> list[dict]:
        if not self.path.is_file():
            return []
        with open(self.path, encoding="utf-8") as f:
            rows = [json.loads(line) for line in f if line.strip()]
        return rows[-limit:] if limit else rows

    def recent_values(self, field: str, limit: int = 20) -> list:
        return [r.get(field) for r in self.read(limit) if r.get(field)]
