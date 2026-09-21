"""Renders the Fase C cases (subjects, relations, interactions) with their plan, prompt, snapshot and draft. No network.

    python scripts/render_fase_c_examples.py > docs/features/creative-generator-fase-c-examples.md
    python scripts/render_fase_c_examples.py --panel-fixtures ../panel/test/fixtures/creative-fase-c.json

`--panel-fixtures` writes real core outputs (plan, draft, snapshot) for the panel tests, so they never guess a shape.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from creative_core import model_router as mr  # noqa: E402
from creative_core.drafts import feedback_snapshot, generation_draft_from_plan  # noqa: E402
from creative_core.engines import plan_creative  # noqa: E402

FIXTURES = ROOT / "creative_core" / "fixtures_v2"
CASES = (
    ("A", "a-pai-e-filha", "Pai e filha (recomendado pelo contexto semântico da estampa; nenhum subject no request)"),
    ("B", "b-menino-e-mae", "Menino veste, mãe presente sem vestir, lendo juntos"),
    ("C", "c-duas-irmas", "Duas irmãs com produtos diferentes"),
    ("D", "d-casal", "Casal, duas pessoas adultas com peças combinando"),
    ("E", "e-familia", "Família de 4: aviso, risco alto e pose simples"),
)


def _load(name: str) -> dict:
    return json.loads((FIXTURES / f"fixture-c1-{name}.json").read_text(encoding="utf-8"))["input"]


def _slim(plan: dict) -> dict:
    view = json.loads(json.dumps(plan))
    view["prompt"] = {**view["prompt"], "text": f"<{len(view['prompt']['text'])} caracteres; ver abaixo>"}
    view.pop("references", None)
    view["products"] = [{"id": p["id"], "name": p["name"], "type": p["type"]} for p in view["products"]]
    view["compiler"] = {"version": view["compiler"]["version"], "sections": [
        {k: s[k] for k in ("section", "source", "sources", "length") if k in s} for s in view["compiler"]["sections"]]}
    return view


def build() -> list[dict]:
    router = mr.ModelRouter(env={})
    out = []
    for letter, name, title in CASES:
        request = _load(name)
        plan = plan_creative(request, router=router)
        out.append({"case": letter, "name": name, "title": title, "request": request, "plan": plan,
                    "draft": generation_draft_from_plan(plan), "snapshot": feedback_snapshot(plan)})
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--panel-fixtures")
    args = parser.parse_args()
    cases = build()
    if args.panel_fixtures:
        Path(args.panel_fixtures).write_text(json.dumps(
            {c["case"]: {"plan": c["plan"], "draft": c["draft"], "snapshot": c["snapshot"]} for c in cases},
            ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        return
    print("# Fase C — casos de Subjects, Relations e Interactions\n")
    print("Gerado por `apps/creative-generator/scripts/render_fase_c_examples.py`, sem rede e sem OpenAI. Cada caso mostra o "
          "request, o CreativePlan (sem o texto do prompt), o prompt compilado, o `FeedbackSnapshot` e o `GenerationDraft`.\n")
    for c in cases:
        plan = c["plan"]
        print(f"## Caso {c['case']} — {c['title']}\n")
        print("### Request\n\n```json\n" + json.dumps(c["request"], ensure_ascii=False, indent=2) + "\n```\n")
        print("### CreativePlan\n\n```json\n" + json.dumps(_slim(plan), ensure_ascii=False, indent=2) + "\n```\n")
        print("### Prompt compilado\n\n```text\n" + plan["prompt"]["text"] + "\n```\n")
        print("### FeedbackSnapshot\n\n```json\n" + json.dumps(c["snapshot"], ensure_ascii=False, indent=2) + "\n```\n")
        print("### GenerationDraft\n\n```json\n" + json.dumps(c["draft"], ensure_ascii=False, indent=2) + "\n```\n")


if __name__ == "__main__":
    main()
