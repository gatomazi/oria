"""Renders, with the internal generator's OWN code, the prompt it would build for an A/B scenario.

Run it with the internal generator's interpreter (it imports its `app.py`, which needs streamlit):

    <streamlit-root>/venv/bin/python scripts/export_streamlit_prompts.py \
        --streamlit-root <streamlit-root> --scenario scripts/ab_scenarios/entre_nos_pipa_menina.json --out streamlit_prompts

It writes one `<ANGLE>.txt` per angle, which ab_harness.py takes with --streamlit-prompts-dir. Scene and
supporting element are forced to the scenario's values (cenario_override / elemento_override), so the only
randomness left in the internal prompt — the affect gesture — is fixed by `random.seed`. Nothing is sent anywhere.
The path to the internal generator is an argument: nothing in this monorepo assumes where that project lives.
"""
from __future__ import annotations

import argparse
import contextlib
import io
import json
import random
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--streamlit-root", required=True)
    parser.add_argument("--scenario", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--random-seed", type=int, default=1)
    args = parser.parse_args()

    scenario = json.loads(Path(args.scenario).read_text(encoding="utf-8"))
    cfg = scenario["streamlit"]
    sys.path.insert(0, str(Path(args.streamlit_root).resolve()))
    with contextlib.redirect_stderr(io.StringIO()):
        import app  # noqa: PLC0415 — the internal generator

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    app.ativar_loja(cfg["loja"])
    for angle in scenario["angles"]:
        random.seed(args.random_seed)
        text = app.montar_prompt_angulo_limpo(
            "", "", cfg["personas"][angle], angle, scenario["placement"], app.TIPO_REF_TEMATICA, cfg["tipo_peca_label"],
            cenario_override=scenario["scene"], elemento_override=scenario["supporting_element"],
            contexto_override=cfg["contexto_override"], vinculo_id=cfg["vinculo_id"], tema_estampa=cfg["tema_estampa"],
        )
        if not text:
            print(f"empty prompt for {angle}", file=sys.stderr)
            return 1
        (out / f"{angle}.txt").write_text(text, encoding="utf-8")
        print(f"{angle}: {len(text)} chars -> {out / (angle + '.txt')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
