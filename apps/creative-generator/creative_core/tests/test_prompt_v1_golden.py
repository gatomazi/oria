"""PROMPT_VERSION=1 must keep producing, byte for byte, the prompts that shipped before Fase A."""
from __future__ import annotations

import json

from _support import run
from golden_prompt_v1 import GOLDEN, build_matrix

_EXPECTED = json.loads(GOLDEN.read_text(encoding="utf-8"))


def _diff(actual: dict) -> list[str]:
    return sorted(k for k in set(_EXPECTED) | set(actual) if _EXPECTED.get(k) != actual.get(k))


def test_given_golden_matrix_when_planned_with_defaults_then_every_v1_prompt_is_byte_identical():
    changed = _diff(build_matrix())
    assert not changed, f"{len(changed)} v1 prompts changed, e.g. {changed[:3]}"


def test_given_golden_matrix_when_planned_with_explicit_version_1_then_every_v1_prompt_is_byte_identical():
    changed = _diff(build_matrix(prompt_version=1))
    assert not changed, f"{len(changed)} v1 prompts changed with prompt_version=1, e.g. {changed[:3]}"


def test_given_golden_matrix_when_planned_with_explicit_plan_schema_1_then_every_v1_prompt_is_byte_identical():
    changed = _diff(build_matrix(plan_schema_version=1))
    assert not changed, f"{len(changed)} v1 prompts changed with plan_schema_version=1, e.g. {changed[:3]}"


def test_given_golden_file_then_it_covers_every_fixture_angle_placement_and_seed():
    assert len(_EXPECTED) == 7 * 13 * 2 * 3
    assert sum(1 for v in _EXPECTED.values() if "sha256" in v) > 200


if __name__ == "__main__":
    run(globals())
