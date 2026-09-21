"""A/B harness for the anatomy regression (Fase A). DRY-RUN by default: nothing here calls a provider unless
you pass `--execute` AND set CREATIVE_AB_ALLOW_PAID=1 — the guard exists so a paid run is always deliberate.

Arms (the four of the audit, plus an optional fifth for prompt v2):

    A  prompt Streamlit      + PNG normalized      (local baseline)
    B  prompt Oria v1        + original bytes      (what production does today)
    C  prompt Oria v1        + PNG normalized      (isolates the reference handling)
    D  prompt Streamlit      + original bytes      (cross-check of the reference handling)
    E  prompt Oria v2        + PNG normalized      (optional: measures the Fase A3 prompt)

Reading the result: A vs B = size of the regression; C vs B = effect of the reference; A vs C = effect of the
prompt; D vs A = cross-check; E vs C = effect of prompt v2.

Every image goes through generate_creative — the production code path — so the trace (model served, sent MIME,
bytes, duration) is recorded for each one. Oria arms use the SAME seed per index, so scene and persona are
identical across arms and only the variable under test moves.

    python scripts/ab_harness.py plan   --reference art.jpg --out ab_run            # dry run: manifest, nothing sent
    python scripts/ab_harness.py run    --reference art.jpg --out ab_run --execute  # needs CREATIVE_AB_ALLOW_PAID=1
    python scripts/ab_harness.py report --out ab_run                                # after filling ratings.csv

The Streamlit prompt comes from the internal generator's own rendered prompts: either its golden file
(app_tests/golden/internal_prompts.json, via --streamlit-golden) or one `<ANGLE>.txt` per angle exported with the
"Ver prompts" button of the app (via --streamlit-prompts-dir). The path is an argument: nothing in this repo
assumes where that project lives.
"""
from __future__ import annotations

import argparse
import copy
import csv
import hashlib
import json
import os
import random
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from creative_core import model_router as mr  # noqa: E402
from creative_core.engines import generate_creative, plan_creative  # noqa: E402

ARMS = {
    "A": {"prompt": "streamlit", "normalize": True, "label": "prompt Streamlit + PNG normalizado"},
    "B": {"prompt": "oria_v1", "normalize": False, "label": "Oria v1 + bytes originais"},
    "C": {"prompt": "oria_v1", "normalize": True, "label": "Oria v1 + PNG normalizado"},
    "D": {"prompt": "streamlit", "normalize": False, "label": "prompt Streamlit + bytes originais"},
    "E": {"prompt": "oria_v2", "normalize": True, "label": "Oria v2 + PNG normalizado"},
}
DEFAULT_ARMS = "ABCD"
DEFAULT_ANGLES = ("CAIMENTO", "PRESENTE_AFETO")
PAID_ENV = "CREATIVE_AB_ALLOW_PAID"
KEY_ENV = "CREATIVE_AB_OPENAI_API_KEY"
MAX_IMAGES_DEFAULT = 80
RATING_COLUMNS = ("blind_id", "file", "wrong_hands", "extra_fingers", "other_anatomy", "notes")


class HarnessError(Exception):
    pass


# ------------------------------------------------------------------ prompts
def load_streamlit_prompt(angle: str, placement: str, *, golden: Path | None, prompts_dir: Path | None, store: str) -> str:
    """The prompt the internal generator renders for this angle. Raises HarnessError when it is not available."""
    if prompts_dir is not None:
        path = Path(prompts_dir) / f"{angle}.txt"
        if not path.is_file():
            raise HarnessError(f"missing Streamlit prompt file: {path}")
        return path.read_text(encoding="utf-8").strip()
    if golden is None:
        raise HarnessError("arms A/D need --streamlit-golden or --streamlit-prompts-dir")
    cases = json.loads(Path(golden).read_text(encoding="utf-8"))
    key = f"angulos_limpos/{store}/{placement}/{angle}/None"
    if key not in cases:
        raise HarnessError(f"golden has no case {key!r}")
    return cases[key]


def _streamlit_plan(plan: dict, text: str) -> dict:
    """The Oria plan with its prompt swapped for the Streamlit text. Everything else (model, size, quality,
    references) is the plan's, so the arm differs only in the prompt."""
    swapped = copy.deepcopy(plan)
    swapped["prompt"] = {
        "text": text,
        "sections": [{"name": "streamlit_prompt", "length": len(text)}],
        "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "prompt_version": 0,  # 0 = not an Oria prompt
    }
    return swapped


# ------------------------------------------------------------------ jobs
def _fixture_request(fixture: str) -> dict:
    path = ROOT / "creative_core" / "fixtures" / f"{fixture}.json"
    return json.loads(path.read_text(encoding="utf-8"))["input"]


def build_jobs(
    *, fixture: str, angles: list[str], arms: str, n: int, placement: str, seed: int, quality: str | None,
    references: list[bytes], streamlit_golden: Path | None, streamlit_prompts_dir: Path | None, streamlit_store: str,
    router: mr.ModelRouter | None = None,
) -> list[dict]:
    router = router or mr.ModelRouter()
    unknown = [a for a in arms if a not in ARMS]
    if unknown:
        raise HarnessError(f"unknown arm(s): {unknown}")
    base = _fixture_request(fixture)
    jobs: list[dict] = []
    for angle in angles:
        streamlit_text = None
        for i in range(n):
            request = copy.deepcopy(base)
            request.update(angle_id=angle, placement_id=placement, seed=seed + i)
            if quality:
                request["quality"] = quality
            plans = {v: plan_creative({**request, "prompt_version": v}, router=router) for v in (1, 2)}
            for arm in arms:
                spec = ARMS[arm]
                plan = plans[2] if spec["prompt"] == "oria_v2" else plans[1]
                if spec["prompt"] == "streamlit":
                    if streamlit_text is None:
                        streamlit_text = load_streamlit_prompt(angle, placement, golden=streamlit_golden,
                                                               prompts_dir=streamlit_prompts_dir, store=streamlit_store)
                    plan = _streamlit_plan(plan, streamlit_text)
                refs = {role["ref"]: references[min(idx, len(references) - 1)] if references else b""
                        for idx, role in enumerate(plan["references"])}
                jobs.append({"arm": arm, "angle": angle, "index": i, "seed": seed + i, "normalize": spec["normalize"],
                             "plan": plan, "references": refs})
    return jobs


def manifest(jobs: list[dict]) -> dict:
    return {
        "arms": {a: ARMS[a] for a in sorted({j["arm"] for j in jobs})},
        "images": len(jobs),
        "jobs": [{
            "arm": j["arm"], "angle": j["angle"], "index": j["index"], "seed": j["seed"], "normalize_references": j["normalize"],
            "prompt_sha256": j["plan"]["prompt"]["sha256"], "prompt_version": j["plan"]["prompt"]["prompt_version"],
            "prompt_chars": len(j["plan"]["prompt"]["text"]), "model": j["plan"]["model"],
            "references": [{"order": r["order"], "bytes": len(j["references"].get(r["ref"], b""))} for r in j["plan"]["references"]],
        } for j in jobs],
    }


# ------------------------------------------------------------------ execution
def _guard_paid(execute: bool, env: dict) -> None:
    if not execute:
        raise HarnessError("dry run: pass --execute to send anything")
    if env.get(PAID_ENV) != "1":
        raise HarnessError(f"refusing to spend: set {PAID_ENV}=1 to confirm this run calls the paid provider")


def run_jobs(jobs: list[dict], client, out: Path, *, router: mr.ModelRouter | None = None, blind_seed: int = 0) -> dict:
    """Generates every job through generate_creative and writes images, traces and a BLIND rating sheet."""
    import base64  # noqa: PLC0415

    router = router or mr.ModelRouter()
    out.mkdir(parents=True, exist_ok=True)
    rng = random.Random(blind_seed)
    order = list(range(len(jobs)))
    rng.shuffle(order)
    blind_ids = {idx: f"img{n + 1:03d}" for n, idx in enumerate(order)}
    key: dict = {}
    rows: list[dict] = []
    for idx, job in enumerate(jobs):
        blind = blind_ids[idx]
        started = time.monotonic()
        result = generate_creative(job["plan"], client=client, references=job["references"], router=router,
                                   normalize_references=job["normalize"])
        meta = {"arm": job["arm"], "angle": job["angle"], "index": job["index"], "seed": job["seed"],
                "status": result["status"], "error": result["error"], "trace": result["metadata"]["trace"],
                "usage": result["metadata"].get("usage"), "wall_ms": int((time.monotonic() - started) * 1000)}
        (out / "traces").mkdir(exist_ok=True)
        (out / "traces" / f"{blind}.json").write_text(json.dumps(meta, indent=1, ensure_ascii=False), encoding="utf-8")
        key[blind] = {"arm": job["arm"], "angle": job["angle"], "index": job["index"], "status": result["status"]}
        if result["asset"]:
            (out / "images").mkdir(exist_ok=True)
            (out / "images" / f"{blind}.png").write_bytes(base64.b64decode(result["asset"]["data_base64"]))
            rows.append({"blind_id": blind, "file": f"images/{blind}.png", "wrong_hands": "", "extra_fingers": "",
                         "other_anatomy": "", "notes": ""})
    # The key (arm behind each blind id) is written apart from the sheet the rater fills in.
    (out / "key.json").write_text(json.dumps(key, indent=1, sort_keys=True), encoding="utf-8")
    rows.sort(key=lambda r: r["blind_id"])
    with open(out / "ratings.csv", "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=RATING_COLUMNS)
        writer.writeheader()
        writer.writerows(rows)
    return key


def report(out: Path) -> dict:
    """Per-arm anatomy failure rates from the filled-in ratings.csv (1 = defect seen, 0 = clean, blank = unrated)."""
    key = json.loads((out / "key.json").read_text(encoding="utf-8"))
    per_arm: dict = {}
    with open(out / "ratings.csv", newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            arm = key[row["blind_id"]]["arm"]
            bucket = per_arm.setdefault(arm, {"rated": 0, "wrong_hands": 0, "extra_fingers": 0, "other_anatomy": 0, "any_defect": 0})
            flags = {c: row[c].strip() for c in ("wrong_hands", "extra_fingers", "other_anatomy")}
            if any(v == "" for v in flags.values()):
                continue
            bucket["rated"] += 1
            for column, value in flags.items():
                bucket[column] += int(value == "1")
            bucket["any_defect"] += int("1" in flags.values())
    for bucket in per_arm.values():
        bucket["defect_rate"] = round(bucket["any_defect"] / bucket["rated"], 3) if bucket["rated"] else None
    return {arm: per_arm[arm] for arm in sorted(per_arm)}


# ------------------------------------------------------------------ CLI
def _read_references(paths: list[str]) -> list[bytes]:
    return [Path(p).read_bytes() for p in paths]


def _build_from_args(args) -> list[dict]:
    return build_jobs(
        fixture=args.fixture, angles=[a.strip() for a in args.angles.split(",") if a.strip()], arms=args.arms, n=args.n,
        placement=args.placement, seed=args.seed, quality=args.quality, references=_read_references(args.reference or []),
        streamlit_golden=Path(args.streamlit_golden) if args.streamlit_golden else None,
        streamlit_prompts_dir=Path(args.streamlit_prompts_dir) if args.streamlit_prompts_dir else None,
        streamlit_store=args.streamlit_store,
    )


def main(argv: list[str] | None = None, *, client_factory=None, env: dict | None = None) -> int:
    env = os.environ if env is None else env
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("plan", "run"):
        p = sub.add_parser(name)
        p.add_argument("--out", required=True)
        p.add_argument("--fixture", default="fixture-clean-single")
        p.add_argument("--angles", default=",".join(DEFAULT_ANGLES))
        p.add_argument("--arms", default=DEFAULT_ARMS, help="letters among A-E (default ABCD)")
        p.add_argument("-n", type=int, default=8, help="images per arm per angle")
        p.add_argument("--placement", default="FEED_4X5")
        p.add_argument("--seed", type=int, default=100)
        p.add_argument("--quality", default=None, choices=("low", "medium", "high"))
        p.add_argument("--reference", action="append", help="product reference image (repeat for several)")
        p.add_argument("--streamlit-golden")
        p.add_argument("--streamlit-prompts-dir")
        p.add_argument("--streamlit-store", default="regional", choices=("regional", "entre_nos"))
        p.add_argument("--max-images", type=int, default=MAX_IMAGES_DEFAULT)
        if name == "run":
            p.add_argument("--execute", action="store_true")
    rep = sub.add_parser("report")
    rep.add_argument("--out", required=True)
    args = parser.parse_args(argv)
    out = Path(args.out)

    try:
        if args.command == "report":
            print(json.dumps(report(out), indent=1))
            return 0
        jobs = _build_from_args(args)
        if len(jobs) > args.max_images:
            raise HarnessError(f"{len(jobs)} images exceed --max-images {args.max_images}")
        out.mkdir(parents=True, exist_ok=True)
        (out / "manifest.json").write_text(json.dumps(manifest(jobs), indent=1, ensure_ascii=False), encoding="utf-8")
        if args.command == "plan":
            print(f"DRY RUN — {len(jobs)} images planned, none sent. Manifest: {out / 'manifest.json'}")
            return 0
        _guard_paid(args.execute, env)
        if not args.reference:
            raise HarnessError("a real run needs at least one --reference image")
        key = env.get(KEY_ENV, "")
        if not key:
            raise HarnessError(f"set {KEY_ENV} (a key dedicated to this experiment)")
        if client_factory is None:
            from openai import OpenAI  # noqa: PLC0415 — imported only when a paid run is really happening

            client_factory = lambda k: OpenAI(api_key=k, max_retries=0)  # noqa: E731
        run_jobs(jobs, client_factory(key), out)
        print(f"done: {len(jobs)} images. Fill {out / 'ratings.csv'} blind, then: report --out {out}")
        return 0
    except HarnessError as exc:
        print(f"ab_harness: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
