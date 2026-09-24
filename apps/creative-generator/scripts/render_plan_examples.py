"""Renders a CreativePlan v1 and v2 for the SAME request, and the full CompiledPrompt of the v2 plan (no network).

    python scripts/render_plan_examples.py [--fixture creative_core/fixtures_v2/fixture-v2-entre-nos-presente.json]
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
from creative_core.compiler import compile_prompt  # noqa: E402
from creative_core.engines import plan_creative  # noqa: E402


def _without_text(plan: dict) -> dict:
    slim = copy.deepcopy(plan)
    slim["prompt"] = {**slim["prompt"], "text": f"<{len(slim['prompt']['text'])} caracteres; ver o CompiledPrompt>"}
    return slim


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture", default=str(ROOT / "creative_core" / "fixtures_v2" / "fixture-v2-entre-nos-presente.json"))
    args = parser.parse_args()
    request = json.loads(Path(args.fixture).read_text(encoding="utf-8"))["input"]
    router = mr.ModelRouter(env={})
    v1 = plan_creative({**request, "plan_schema_version": 1, "prompt_version": 1}, router=router)
    v1_prompt2 = plan_creative({**request, "plan_schema_version": 1}, router=router)
    v2 = plan_creative({**request, "plan_schema_version": 2}, router=router)
    print(f"# CreativePlan V1 × V2 — {Path(args.fixture).stem}\n")
    print("Mesmo request (seed, produto, persona, contexto e Brand Kit iguais); só muda `plan_schema_version`. Gerado por "
          "`apps/creative-generator/scripts/render_plan_examples.py`, sem rede.\n")
    print("## Request\n\n```json\n" + json.dumps({**request, "products": [{**p, "referenceImages": p["referenceImages"]} for p in request["products"]]}, ensure_ascii=False, indent=2) + "\n```\n")
    print("## CreativePlan V1 (`plan_schema_version=1`, `prompt_version=1`)\n\n```json\n" + json.dumps(_without_text(v1), ensure_ascii=False, indent=2) + "\n```\n")
    print("## CreativePlan V2 (`plan_schema_version=2`)\n\n```json\n" + json.dumps(_without_text(v2), ensure_ascii=False, indent=2) + "\n```\n")
    compiled = compile_prompt(v2)
    print("## CompiledPrompt do plano V2\n")
    print(f"`compiler_version={compiled['compiler_version']}` · `prompt_version={compiled['prompt_version']}` · {len(compiled['text'])} caracteres · sha256 `{compiled['sha256']}`\n")
    print("### Seções\n\n| # | section | source | value | length |\n|---|---|---|---|---|")
    for i, s in enumerate(compiled["sections"], 1):
        print(f"| {i} | `{s['section']}` | `{s['source']}` | `{s['value']}` | {s['length']} |")
    print("\n### Texto completo\n\n```text\n" + compiled["text"] + "\n```\n")
    print("### Como o V1 escreveria o mesmo request (para comparação)\n")
    print(f"Plano V1 com o texto de cena V2 (`plan_schema_version=1`, `prompt_version=2`): {len(v1_prompt2['prompt']['text'])} caracteres, "
          f"sha256 `{v1_prompt2['prompt']['sha256'][:16]}…`; plano V1 puro: {len(v1['prompt']['text'])} caracteres, sha256 `{v1['prompt']['sha256'][:16]}…`.\n")
    print("```text\n" + v1["prompt"]["text"] + "\n```")


if __name__ == "__main__":
    main()
