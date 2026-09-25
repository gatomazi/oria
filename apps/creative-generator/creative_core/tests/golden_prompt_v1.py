"""Golden matrix of the PROMPT_VERSION=1 prompts (every fixture x every angle x placement x seed).

The hashes in golden/prompt_v1.json were captured from the code as it stood BEFORE the Fase A work
(commit c57aa29). test_prompt_v1_golden.py replays this matrix on every run, so any change that
alters a single byte of a v1 prompt fails the suite.

    python creative_core/tests/golden_prompt_v1.py --write     # only when a v1 change is intentional
"""
from __future__ import annotations

import copy
import hashlib
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1]))

from _support import all_fixtures  # noqa: E402

from creative_core import model_router as mr  # noqa: E402
from creative_core.angles import ANGLE_IDS  # noqa: E402
from creative_core.engines import plan_creative  # noqa: E402
from creative_core.errors import GenerationError  # noqa: E402

GOLDEN = HERE / "golden" / "prompt_v1.json"
ROUTER = mr.ModelRouter(env={})
PLACEMENTS = ("FEED_4X5", "STORY_9X16")
SEED_OFFSETS = (0, 1, 2)


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def build_matrix(**request_extra) -> dict:
    """{case: {"sha256", "length"} | {"error"}}. `request_extra` is merged into every request, so the
    same matrix can be replayed with an explicit prompt_version=1."""
    cases: dict = {}
    for fixture in all_fixtures():
        base = fixture["input"]
        for angle in ANGLE_IDS:
            for placement in PLACEMENTS:
                for offset in SEED_OFFSETS:
                    request = copy.deepcopy(base)
                    request.update(angle_id=angle, placement_id=placement, seed=int(base.get("seed", 0)) + offset)
                    request.update(request_extra)
                    key = f"{fixture['name']}/{angle}/{placement}/seed+{offset}"
                    try:
                        plan = plan_creative(request, router=ROUTER)
                    except GenerationError as err:
                        cases[key] = {"error": err.code}
                        continue
                    text = plan["prompt"]["text"]
                    cases[key] = {"sha256": _sha(text), "length": len(text)}
    return cases


if __name__ == "__main__":
    if "--write" not in sys.argv:
        sys.exit("usage: golden_prompt_v1.py --write")
    matrix = build_matrix()
    GOLDEN.parent.mkdir(exist_ok=True)
    GOLDEN.write_text(json.dumps(matrix, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    ok = sum(1 for v in matrix.values() if "sha256" in v)
    print(f"{len(matrix)} cases written ({ok} prompts, {len(matrix) - ok} expected errors) -> {GOLDEN}")
