"""Renders the FULL prompt v1 and v2 side by side for the four person angles (no network, no provider call).

    python scripts/render_prompt_examples.py [--fixture fixture-clean-single] [--seed 3] > examples.md
"""
from __future__ import annotations

import argparse
import copy
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from creative_core import model_router as mr  # noqa: E402
from creative_core.engines import plan_creative  # noqa: E402

ANGLES = ("CAIMENTO", "PRESENTE_AFETO", "CREATOR_STYLE", "LIFESTYLE_COTIDIANO")


def _sections(plan: dict) -> dict:
    text, out, cursor = plan["prompt"]["text"], {}, 0
    for part in plan["prompt"]["sections"]:
        out[part["name"]] = text[cursor:cursor + part["length"]]
        cursor += part["length"] + 2
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture", default="fixture-clean-single")
    parser.add_argument("--seed", type=int, default=None)
    args = parser.parse_args()
    base = json.loads((ROOT / "creative_core" / "fixtures" / f"{args.fixture}.json").read_text(encoding="utf-8"))["input"]
    router = mr.ModelRouter(env={})
    print(f"# Prompt V1 × V2 — {args.fixture}, ângulos com pessoa\n")
    print("Gerado por `apps/creative-generator/scripts/render_prompt_examples.py` (sem rede). Mesmo request, mesma seed:\n"
          "só muda `prompt_version`. As seções que diferem estão marcadas com ◀ (todas as outras são idênticas byte a byte).\n")
    for angle in ANGLES:
        request = copy.deepcopy(base)
        request["angle_id"] = angle
        if args.seed is not None:
            request["seed"] = args.seed
        plans = {v: plan_creative({**request, "prompt_version": v}, router=router) for v in (1, 2)}
        s1, s2 = _sections(plans[1]), _sections(plans[2])
        print(f"## {angle}\n")
        print(f"- V1: {len(plans[1]['prompt']['text'])} caracteres · sha256 `{plans[1]['prompt']['sha256'][:16]}…` · prompt_version {plans[1]['prompt']['prompt_version']}")
        print(f"- V2: {len(plans[2]['prompt']['text'])} caracteres · sha256 `{plans[2]['prompt']['sha256'][:16]}…` · prompt_version {plans[2]['prompt']['prompt_version']}")
        print(f"- Seções que diferem: {', '.join(sorted(k for k in s1 if s1[k] != s2.get(k))) or 'nenhuma'}\n")
        for version, plan in ((1, plans[1]), (2, plans[2])):
            print(f"### {angle} — V{version} (prompt completo)\n\n```text\n{plan['prompt']['text']}\n```\n")
        print("### Diferenças (seções `angle`, `persona`, `core_rules`)\n")
        for name in ("core_rules", "angle", "persona"):
            if s1.get(name) != s2.get(name):
                print(f"**{name} · V1**\n\n```text\n{s1.get(name, '')}\n```\n\n**{name} · V2** ◀\n\n```text\n{s2.get(name, '')}\n```\n")


if __name__ == "__main__":
    main()
