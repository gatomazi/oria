"""A/B harness for the anatomy regression (Fase A). DRY-RUN by default: nothing here calls a provider unless
you pass `--execute` AND set CREATIVE_AB_ALLOW_PAID=1 AND provide a key in CREATIVE_AB_OPENAI_API_KEY.

Arms

    A  prompt Streamlit  + PNG normalized     (local baseline)
    B  prompt Oria v1    + original bytes     (what production does today)
    C  prompt Oria v1    + PNG normalized     (isolates the normalization)
    D  prompt Streamlit  + original bytes     (cross-check of the normalization on the baseline)
    E  prompt Oria v2    + PNG normalized     (the corrected candidate)

Main comparisons: A×B total regression · B×C normalization · A×D normalization on the baseline · C×E prompt v2
alone · A×E how close v2 gets to the validated baseline.

Rounds and cost limits (enforced in code, not by convention)

    round 1 = images 1-4 of every arm × angle  → at most 40 generations per invocation (HARD_CAP_PER_RUN)
    round 2 = images 5-8                       → refused unless round 1 finished, is NOT contaminated and
                                                 --confirm-round-2 is given; total across rounds ≤ 80
    Every provider call is written to private/ledger.json before the next one starts. Three consecutive failed
    generations abort the run.

Experimental control

    * one reference, the same bytes in all five arms (its sha256 is in the manifest);
    * the Oria arms share the seed of each image index, so scene/persona/pool picks are identical across them;
    * every image goes through generate_creative (the production path), so each has its trace: model requested
      and served, quality, size, MIME/bytes sent, request id, duration, usage;
    * the round is flagged CONTAMINATED — and round 2 is refused — if the images were not all served by the same
      model, if a fallback answered, or if the parameters or the reference differ across arms.

Blind evaluation

    <out>/blind/     images named IMG-001..; evaluation.html (static, offline) and ratings.csv. Nothing here says
                     which arm, prompt version, normalization, generator or model made an image.
    <out>/private/   key manifest (IMG-id → arm), traces, prompts, ledger. Do not open before rating.
    <out>/plan/      dry-run manifest and the exact prompts of every arm (they carry no image id).

    python scripts/ab_harness.py plan   --scenario scripts/ab_scenarios/entre_nos_pipa_menina.json \
        --reference "<pipa menina>.webp" --streamlit-prompts-dir streamlit_prompts --out ab_run
    python scripts/ab_harness.py run    (same arguments) --execute        # needs the paid guard + key
    python scripts/ab_harness.py report --out ab_run                      # AFTER rating; reveals the arms

The Streamlit prompts come from the internal generator's own code (scripts/export_streamlit_prompts.py) or, for
tests, from its golden file (--streamlit-golden).
"""
from __future__ import annotations

import argparse
import copy
import csv
import hashlib
import io
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
from creative_core.references import sniff_mime  # noqa: E402

ARMS = {
    "A": {"prompt": "streamlit", "normalize": True, "label": "prompt Streamlit + PNG normalizado"},
    "B": {"prompt": "oria_v1", "normalize": False, "label": "Oria v1 + bytes originais"},
    "C": {"prompt": "oria_v1", "normalize": True, "label": "Oria v1 + PNG normalizado"},
    "D": {"prompt": "streamlit", "normalize": False, "label": "prompt Streamlit + bytes originais"},
    "E": {"prompt": "oria_v2", "normalize": True, "label": "Oria v2 + PNG normalizado"},
}
DEFAULT_ARMS = "ABCDE"
COMPARISONS = (("A", "B", "regressão total local × atual"), ("B", "C", "efeito da normalização"),
               ("A", "D", "normalização no baseline"), ("C", "E", "efeito isolado do prompt v2"),
               ("A", "E", "quão perto o v2 chegou do baseline"))
PER_ROUND = 4
HARD_CAP_PER_RUN = 40
HARD_CAP_TOTAL = 80
MAX_CONSECUTIVE_FAILURES = 3
PAID_ENV = "CREATIVE_AB_ALLOW_PAID"
KEY_ENV = "CREATIVE_AB_OPENAI_API_KEY"

# Oria's default gpt-image-2 price table (apps/panel/lib/custos/precos.js), USD per 1M tokens. An ESTIMATE from
# the usage the provider reports — the provider's invoice is the truth.
PRICES_PER_M = {"text_in": 5.0, "image_in": 8.0, "cache_in": 2.0, "out": 30.0}

RATING_FIELDS = (
    # anatomy: 1 = the defect is present, 0 = absent
    ("hand_problem", "Mão problemática", "flag"),
    ("finger_problem", "Dedo extra ou faltando", "flag"),
    ("limb_problem", "Braço/membro problemático", "flag"),
    ("fused_people", "Pessoas fundidas", "flag"),
    ("other_anatomy", "Outro problema anatômico", "flag"),
    ("composition", "Composição", ("correct:correta", "acceptable:aceitável", "incorrect:incorreta")),
    ("people_count_ok", "Pessoas: quantidade correta?", ("yes:sim", "no:não", "na:não se aplica")),
    ("people_roles_ok", "Pessoas: papéis coerentes?", ("yes:sim", "no:não", "na:não se aplica")),
    ("people_interaction_ok", "Pessoas: interação coerente?", ("yes:sim", "no:não", "na:não se aplica")),
    ("garment_ok", "Produto: peça preservada?", ("yes:sim", "partial:em parte", "no:não")),
    ("print_ok", "Produto: estampa preservada?", ("yes:sim", "partial:em parte", "no:não")),
    ("color_fit_ok", "Produto: cor/modelagem preservadas?", ("yes:sim", "partial:em parte", "no:não")),
    ("commercial", "Qualidade comercial", ("usable:utilizável sem edição", "minor_edit:utilizável com pequena edição", "unusable:inutilizável")),
)
RATING_COLUMNS = ("image_id", *(f[0] for f in RATING_FIELDS), "notes")
ANATOMY_FLAGS = ("hand_problem", "finger_problem", "limb_problem", "fused_people", "other_anatomy")


class HarnessError(Exception):
    pass


# ------------------------------------------------------------------ prompts
def load_streamlit_prompt(angle: str, placement: str, *, golden: Path | None, prompts_dir: Path | None, store: str) -> str:
    if prompts_dir is not None:
        path = Path(prompts_dir) / f"{angle}.txt"
        if not path.is_file():
            raise HarnessError(f"missing Streamlit prompt file: {path}")
        return path.read_text(encoding="utf-8").strip()
    if golden is None:
        raise HarnessError("arms A/D need --streamlit-prompts-dir (or --streamlit-golden)")
    cases = json.loads(Path(golden).read_text(encoding="utf-8"))
    key = f"angulos_limpos/{store}/{placement}/{angle}/None"
    if key not in cases:
        raise HarnessError(f"golden has no case {key!r}")
    return cases[key]


def _streamlit_plan(plan: dict, text: str) -> dict:
    """The Oria plan with only its prompt swapped for the Streamlit text (model, size, quality and references stay)."""
    swapped = copy.deepcopy(plan)
    swapped["prompt"] = {
        "text": text, "sections": [{"name": "streamlit_prompt", "length": len(text)}],
        "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "prompt_version": 0,  # 0 = not an Oria prompt
    }
    return swapped


# ------------------------------------------------------------------ requests
def load_scenario(path: Path) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _scenario_request(scenario: dict, angle: str, seed: int, ref_name: str) -> dict:
    return {
        "strategy": "CLEAN_ANGLES", "product_mode": "single_product",
        "products": [{**scenario["product"], "referenceImages": [ref_name]}],
        "brand_kit": scenario["brand_kit"], "niche_kit_id": scenario["niche_kit_id"],
        "angle_id": angle, "placement_id": scenario["placement"],
        "persona_mode": "custom", "persona": scenario["persona"],
        "context": {"mode": "custom", "profile": scenario["context_profile"]},
        "quality": scenario.get("quality", "medium"), "seed": seed,
    }


def _fixture_request(fixture: str) -> dict:
    return json.loads((ROOT / "creative_core" / "fixtures" / f"{fixture}.json").read_text(encoding="utf-8"))["input"]


def reference_info(data: bytes) -> dict:
    info = {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data), "mime": sniff_mime(data)}
    try:
        from PIL import Image  # noqa: PLC0415

        with Image.open(io.BytesIO(data)) as img:
            info.update(width=img.size[0], height=img.size[1], mode=img.mode)
    except Exception:  # noqa: BLE001 — an empty/undecodable placeholder (dry run without --reference)
        pass
    return info


# ------------------------------------------------------------------ jobs
def build_jobs(
    *, arms: str, angles: list[str], round_no: int, per_round: int, references: list[bytes],
    scenario: dict | None = None, fixture: str = "fixture-clean-single", placement: str = "FEED_4X5", seed: int = 100,
    quality: str | None = None, streamlit_golden: Path | None = None, streamlit_prompts_dir: Path | None = None,
    streamlit_store: str = "regional", router: mr.ModelRouter | None = None,
) -> list[dict]:
    router = router or mr.ModelRouter()
    unknown = [a for a in arms if a not in ARMS]
    if unknown:
        raise HarnessError(f"unknown arm(s): {unknown}")
    if round_no not in (1, 2):
        raise HarnessError("round must be 1 or 2")
    first = (round_no - 1) * per_round
    ref_name = "ref/product.bin"
    jobs: list[dict] = []
    for angle in angles:
        if scenario is not None:
            seeds = scenario["seeds"][angle][first:first + per_round]
            if len(seeds) < per_round:
                raise HarnessError(f"scenario has {len(seeds)} seeds for {angle} in round {round_no}, need {per_round}")
        else:
            seeds = [seed + first + i for i in range(per_round)]
        streamlit_text = None
        for offset, image_seed in enumerate(seeds):
            request = (_scenario_request(scenario, angle, image_seed, ref_name) if scenario is not None
                       else {**copy.deepcopy(_fixture_request(fixture)), "angle_id": angle, "placement_id": placement,
                             "seed": image_seed})
            if quality:
                request["quality"] = quality
            plans = {v: plan_creative({**request, "prompt_version": v}, router=router) for v in (1, 2)}
            for arm in arms:
                spec = ARMS[arm]
                plan = plans[2] if spec["prompt"] == "oria_v2" else plans[1]
                if spec["prompt"] == "streamlit":
                    if streamlit_text is None:
                        streamlit_text = load_streamlit_prompt(
                            angle, scenario["placement"] if scenario else placement, golden=streamlit_golden,
                            prompts_dir=streamlit_prompts_dir, store=streamlit_store)
                    plan = _streamlit_plan(plan, streamlit_text)
                refs = {role["ref"]: references[min(i, len(references) - 1)] if references else b""
                        for i, role in enumerate(plan["references"])}
                jobs.append({"arm": arm, "angle": angle, "index": first + offset, "seed": image_seed,
                             "normalize": spec["normalize"], "plan": plan, "references": refs})
    return jobs


def plan_manifest(jobs: list[dict], reference: dict | None, round_no: int) -> dict:
    return {
        "round": round_no, "images": len(jobs), "hard_cap_per_run": HARD_CAP_PER_RUN,
        "arms": {a: ARMS[a] for a in sorted({j["arm"] for j in jobs})},
        "reference": reference,
        "jobs": [{
            "arm": j["arm"], "angle": j["angle"], "index": j["index"], "seed": j["seed"],
            "normalize_references": j["normalize"], "prompt_sha256": j["plan"]["prompt"]["sha256"],
            "prompt_version": j["plan"]["prompt"]["prompt_version"], "prompt_chars": len(j["plan"]["prompt"]["text"]),
            "model": j["plan"]["model"],
        } for j in jobs],
    }


# ------------------------------------------------------------------ cost / contamination (pure)
def estimate_cost(usage: dict | None) -> float | None:
    """USD estimate from the provider-reported usage, or None when the provider reported none."""
    if not usage:
        return None
    text, image, cache = usage.get("text_input_tokens"), usage.get("image_input_tokens"), usage.get("cached_input_tokens") or 0
    if text is None and image is None:  # no split: charge the uncached input at the image price (the dearer one)
        text, image = 0, max((usage.get("input_tokens") or 0) - cache, 0)
    return round(((text or 0) * PRICES_PER_M["text_in"] + (image or 0) * PRICES_PER_M["image_in"]
                  + cache * PRICES_PER_M["cache_in"] + (usage.get("output_tokens") or 0) * PRICES_PER_M["out"]) / 1e6, 5)


def analyze_contamination(entries: dict) -> dict:
    """Is the run clean enough to be compared? `entries` = the private manifest ({image_id: {...}})."""
    done = {k: v for k, v in entries.items() if v.get("status") == "completed"}
    reasons: list[str] = []
    served = sorted({v["trace"]["model_served"] for v in done.values() if v.get("trace")})
    if len(served) > 1:
        reasons.append(f"mixed_models_served:{served}")
    for image_id, v in sorted(done.items()):
        trace = v.get("trace") or {}
        if len(trace.get("models_tried", [])) > 1 or trace.get("model_served") != trace.get("model_requested"):
            reasons.append(f"fallback_used:{image_id}")
    if len({json.dumps(v["trace"].get("params"), sort_keys=True) for v in done.values() if v.get("trace")}) > 1:
        reasons.append("params_differ_across_images")
    if len({(v.get("reference") or {}).get("sha256") for v in done.values()}) > 1:
        reasons.append("reference_differs_across_images")
    by_arm: dict = {}
    for v in done.values():
        by_arm.setdefault(v["arm"], set()).add(v["trace"]["model_served"])
    failed = sorted(k for k, v in entries.items() if v.get("status") != "completed")
    return {"contaminated": bool(reasons), "reasons": reasons, "served_models": served,
            "served_by_arm": {a: sorted(m) for a, m in sorted(by_arm.items())}, "failed_images": failed,
            "all_same_model": len(served) == 1 and not any(r.startswith("fallback_used") for r in reasons)}


# ------------------------------------------------------------------ ledger
def _ledger_path(out: Path) -> Path:
    return out / "private" / "ledger.json"


def read_ledger(out: Path) -> dict:
    path = _ledger_path(out)
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {"calls": 0, "rounds": {}}


def _write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=1, ensure_ascii=False, sort_keys=True), encoding="utf-8")


def check_round_allowed(out: Path, round_no: int, planned: int, confirm_round_2: bool) -> None:
    """The code-level brakes: per-run cap, total cap, and the round-2 gate."""
    if planned > HARD_CAP_PER_RUN:
        raise HarnessError(f"{planned} images exceed the per-run cap of {HARD_CAP_PER_RUN}")
    ledger = read_ledger(out)
    if ledger["calls"] + planned > HARD_CAP_TOTAL:
        raise HarnessError(f"{ledger['calls']} calls already made + {planned} planned exceed the total cap of {HARD_CAP_TOTAL}")
    if str(round_no) in ledger["rounds"]:
        raise HarnessError(f"round {round_no} was already run in {out}; refusing to spend it twice")
    if round_no == 2:
        if not confirm_round_2:
            raise HarnessError("round 2 is never automatic: pass --confirm-round-2 after reviewing round 1")
        contamination = out / "private" / "contamination.json"
        if "1" not in ledger["rounds"] or not contamination.is_file():
            raise HarnessError("round 2 needs a finished round 1 in the same --out")
        if json.loads(contamination.read_text(encoding="utf-8"))["contaminated"]:
            raise HarnessError("round 1 is CONTAMINATED (see private/contamination.json): round 2 refused")


def _guard_paid(execute: bool, env: dict) -> None:
    if not execute:
        raise HarnessError("dry run: pass --execute to send anything")
    if env.get(PAID_ENV) != "1":
        raise HarnessError(f"refusing to spend: set {PAID_ENV}=1 to confirm this run calls the paid provider")


# ------------------------------------------------------------------ run
def run_round(jobs: list[dict], client, out: Path, *, round_no: int, reference: dict, router: mr.ModelRouter | None = None,
              blind_seed: int = 0) -> dict:
    """Generates every job through generate_creative. Writes blind images + private traces; returns the summary."""
    import base64  # noqa: PLC0415

    router = router or mr.ModelRouter()
    priv, blind = out / "private", out / "blind"
    for d in (priv / "traces", priv / "prompts", blind):
        d.mkdir(parents=True, exist_ok=True)
    manifest_path = priv / "manifest_private.json"
    entries: dict = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.is_file() else {}
    used = {int(k.split("-")[1]) for k in entries}
    rng = random.Random(blind_seed + round_no)
    order = list(range(len(jobs)))
    rng.shuffle(order)
    ledger = read_ledger(out)
    ledger["rounds"][str(round_no)] = {"planned": len(jobs), "attempted": 0, "started_at": time.strftime("%Y-%m-%dT%H:%M:%S")}
    _write_json(_ledger_path(out), ledger)
    next_id = max(used, default=0)
    consecutive_failures, aborted = 0, False
    for position, idx in enumerate(order):
        job = jobs[idx]
        next_id += 1
        image_id = f"IMG-{next_id:03d}"
        # The ledger is written BEFORE the call: a crash mid-call still counts it.
        ledger["calls"] += 1
        ledger["rounds"][str(round_no)]["attempted"] += 1
        _write_json(_ledger_path(out), ledger)
        started = time.monotonic()
        result = generate_creative(job["plan"], client=client, references=job["references"], router=router,
                                   normalize_references=job["normalize"])
        trace = result["metadata"]["trace"]
        usage = result["metadata"].get("usage")
        entries[image_id] = {
            "arm": job["arm"], "arm_label": ARMS[job["arm"]]["label"], "angle": job["angle"], "index": job["index"],
            "seed": job["seed"], "round": round_no, "status": result["status"], "error": result["error"],
            "prompt_version": job["plan"]["prompt"]["prompt_version"], "prompt_sha256": job["plan"]["prompt"]["sha256"],
            "normalized": job["normalize"], "reference": reference, "trace": trace, "usage": usage,
            "cost_usd_estimate": estimate_cost(usage), "wall_ms": int((time.monotonic() - started) * 1000),
        }
        (priv / "prompts" / f"{image_id}.txt").write_text(job["plan"]["prompt"]["text"], encoding="utf-8")
        _write_json(priv / "traces" / f"{image_id}.json", entries[image_id])
        _write_json(manifest_path, entries)
        if result["asset"]:
            (blind / f"{image_id}.png").write_bytes(base64.b64decode(result["asset"]["data_base64"]))
            consecutive_failures = 0
        else:
            consecutive_failures += 1
            print(f"  ! {image_id} failed: {result['error']['code'] if result['error'] else 'unknown'}", file=sys.stderr)
            if consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
                aborted = True
                print(f"  ! {MAX_CONSECUTIVE_FAILURES} consecutive failures: aborting the run", file=sys.stderr)
                break
        print(f"  [{position + 1}/{len(jobs)}] {image_id} {result['status']}")
    contamination = analyze_contamination(entries)
    _write_json(priv / "contamination.json", contamination)
    write_blind_material(out, entries)
    summary = {"round": round_no, "attempted": ledger["rounds"][str(round_no)]["attempted"], "aborted": aborted,
               "images_total": len(entries), **contamination}
    ledger["rounds"][str(round_no)]["finished"] = True
    _write_json(_ledger_path(out), ledger)
    _write_json(priv / f"summary_round{round_no}.json", summary)
    return summary


# ------------------------------------------------------------------ blind material
def write_blind_material(out: Path, entries: dict) -> None:
    """ratings.csv (template) + evaluation.html for every completed image, in random order. No arm information."""
    blind = out / "blind"
    ids = sorted(k for k, v in entries.items() if v.get("status") == "completed" and (blind / f"{k}.png").is_file())
    random.Random(len(ids)).shuffle(ids)  # shown in random order, not by arm or by id
    csv_path = blind / "ratings.csv"
    existing = {}
    if csv_path.is_file():
        with open(csv_path, newline="", encoding="utf-8") as f:
            existing = {r["image_id"]: r for r in csv.DictReader(f)}
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=RATING_COLUMNS)
        writer.writeheader()
        for image_id in sorted(ids):
            writer.writerow(existing.get(image_id) or {"image_id": image_id})
    (blind / "evaluation.html").write_text(_evaluation_html(ids), encoding="utf-8")


def _evaluation_html(ids: list[str]) -> str:
    fields = json.dumps([{"name": n, "label": l, "type": ("flag" if t == "flag" else "choice"),
                          "options": [] if t == "flag" else [o.split(":") for o in t]} for n, l, t in RATING_FIELDS], ensure_ascii=False)
    columns = json.dumps(list(RATING_COLUMNS))
    return f"""<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Avaliação cega</title>
<style>
body{{font:14px system-ui,sans-serif;margin:0;background:#f4f2ee;color:#1d1b18}}
header{{position:sticky;top:0;z-index:2;background:#1d1b18;color:#fff;padding:10px 16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}}
header button{{padding:6px 12px;border:0;border-radius:6px;cursor:pointer}} main{{padding:16px;display:grid;gap:16px}}
.card{{background:#fff;border-radius:10px;padding:12px;display:grid;grid-template-columns:minmax(220px,420px) 1fr;gap:16px}}
.card img{{width:100%;height:auto;border-radius:6px;background:#ddd}} fieldset{{border:1px solid #ddd;border-radius:8px;margin:0 0 8px;padding:6px 10px}}
legend{{font-weight:600;padding:0 4px}} label{{margin-right:12px;white-space:nowrap}} h3{{margin:0 0 8px}} textarea{{width:100%;min-height:44px}}
.done{{outline:2px solid #2e7d32}} @media(max-width:800px){{.card{{grid-template-columns:1fr}}}}
</style></head><body>
<header><strong>Avaliação cega</strong><span id="prog"></span>
<button id="dl">Baixar ratings.csv</button><button id="cp">Copiar CSV</button>
<span>Salva sozinho no navegador. Nada aqui diz qual versão gerou cada imagem.</span></header>
<main id="main"></main>
<script>
const IDS={json.dumps(ids)}, FIELDS={fields}, COLS={columns}, KEY='ab-blind-ratings-v1';
let state=JSON.parse(localStorage.getItem(KEY)||'{{}}');
const q=(t,a={{}},c=[])=>{{const e=document.createElement(t);for(const k in a)e.setAttribute(k,a[k]);c.forEach(x=>e.append(x));return e}};
function save(){{localStorage.setItem(KEY,JSON.stringify(state));prog()}}
function complete(id){{const s=state[id]||{{}};return FIELDS.every(f=>s[f.name]!==undefined&&s[f.name]!=='')}}
function prog(){{document.getElementById('prog').textContent=IDS.filter(complete).length+' / '+IDS.length+' avaliadas';IDS.forEach(id=>{{const c=document.getElementById(id);if(c)c.classList.toggle('done',complete(id))}})}}
function set(id,n,v){{(state[id]=state[id]||{{}})[n]=v;save()}}
IDS.forEach(id=>{{
  const card=q('section',{{class:'card',id}}), form=q('div');
  card.append(q('img',{{src:id+'.png',alt:id}}), form); form.append(q('h3',{{}},[id]));
  FIELDS.forEach(f=>{{
    const fs=q('fieldset'); fs.append(q('legend',{{}},[f.label]));
    const opts=f.type==='flag'?[['0','não'],['1','sim']]:f.options;
    opts.forEach(([v,l])=>{{const r=q('input',{{type:'radio',name:id+'|'+f.name,value:v}});
      if((state[id]||{{}})[f.name]===v)r.checked=true; r.onchange=()=>set(id,f.name,v);
      fs.append(q('label',{{}},[r,' '+l]))}});
    form.append(fs)}});
  const ta=q('textarea',{{placeholder:'notas'}}); ta.value=(state[id]||{{}}).notes||''; ta.oninput=()=>set(id,'notes',ta.value); form.append(ta);
  document.getElementById('main').append(card)}});
function csv(){{const esc=v=>'"'+String(v??'').replace(/"/g,'""')+'"';
  return [COLS.join(',')].concat([...IDS].sort().map(id=>COLS.map(c=>c==='image_id'?esc(id):esc((state[id]||{{}})[c])).join(','))).join('\\n')+'\\n'}}
document.getElementById('dl').onclick=()=>{{const a=q('a',{{href:URL.createObjectURL(new Blob([csv()],{{type:'text/csv'}})),download:'ratings.csv'}});a.click()}};
document.getElementById('cp').onclick=()=>navigator.clipboard.writeText(csv());
prog();
</script></body></html>
"""


# ------------------------------------------------------------------ report
def _load_ratings(path: Path) -> dict:
    with open(path, newline="", encoding="utf-8") as f:
        return {r["image_id"]: r for r in csv.DictReader(f)}


def report(out: Path, ratings_path: Path | None = None) -> dict:
    """Per arm × angle aggregates from the private manifest and the filled ratings. Reveals the arms — run it
    AFTER rating. It reports numbers and never names a winner."""
    entries = json.loads((out / "private" / "manifest_private.json").read_text(encoding="utf-8"))
    ratings = _load_ratings(ratings_path or out / "blind" / "ratings.csv")
    cells: dict = {}
    for image_id, entry in entries.items():
        rating = ratings.get(image_id)
        cell = cells.setdefault(f"{entry['arm']}/{entry['angle']}", {
            "generated": 0, "rated": 0, "any_anatomy_defect": 0, "anatomy": dict.fromkeys(ANATOMY_FLAGS, 0),
            "composition": {}, "people_ok": {"count": 0, "roles": 0, "interaction": 0, "applicable": 0},
            "product_ok": {"garment": 0, "print": 0, "color_fit": 0}, "commercial": {}, "cost_usd_estimate": 0.0})
        if entry["status"] == "completed":
            cell["generated"] += 1
        cell["cost_usd_estimate"] = round(cell["cost_usd_estimate"] + (entry.get("cost_usd_estimate") or 0), 5)
        if not rating or any((rating.get(f[0]) or "") == "" for f in RATING_FIELDS):
            continue
        cell["rated"] += 1
        flags = [int(rating[k] == "1") for k in ANATOMY_FLAGS]
        for key, value in zip(ANATOMY_FLAGS, flags):
            cell["anatomy"][key] += value
        cell["any_anatomy_defect"] += int(any(flags))
        cell["composition"][rating["composition"]] = cell["composition"].get(rating["composition"], 0) + 1
        cell["commercial"][rating["commercial"]] = cell["commercial"].get(rating["commercial"], 0) + 1
        if rating["people_count_ok"] != "na":
            cell["people_ok"]["applicable"] += 1
            cell["people_ok"]["count"] += int(rating["people_count_ok"] == "yes")
            cell["people_ok"]["roles"] += int(rating["people_roles_ok"] == "yes")
            cell["people_ok"]["interaction"] += int(rating["people_interaction_ok"] == "yes")
        for key, column in (("garment", "garment_ok"), ("print", "print_ok"), ("color_fit", "color_fit_ok")):
            cell["product_ok"][key] += int(rating[column] == "yes")
    for cell in cells.values():
        cell["anatomy_defect_rate"] = round(cell["any_anatomy_defect"] / cell["rated"], 3) if cell["rated"] else None
        cell["usable_without_edit_rate"] = round(cell["commercial"].get("usable", 0) / cell["rated"], 3) if cell["rated"] else None
    comparisons = []
    for left, right, meaning in COMPARISONS:
        for angle in sorted({k.split("/")[1] for k in cells}):
            a, b = cells.get(f"{left}/{angle}"), cells.get(f"{right}/{angle}")
            if a and b and a["rated"] and b["rated"]:
                comparisons.append({"comparison": f"{left}×{right}", "meaning": meaning, "angle": angle,
                                    "anatomy_defect_rate": [a["anatomy_defect_rate"], b["anatomy_defect_rate"]],
                                    "usable_without_edit_rate": [a["usable_without_edit_rate"], b["usable_without_edit_rate"]],
                                    "n": [a["rated"], b["rated"]]})
    contamination = out / "private" / "contamination.json"
    return {"cells": {k: cells[k] for k in sorted(cells)}, "comparisons": comparisons,
            "unrated_images": sorted(k for k in entries if entries[k]["status"] == "completed" and k not in {
                r for r, v in ratings.items() if all((v.get(f[0]) or "") != "" for f in RATING_FIELDS)}),
            "contamination": json.loads(contamination.read_text(encoding="utf-8")) if contamination.is_file() else None}


# ------------------------------------------------------------------ CLI
def _read_references(paths: list[str]) -> list[bytes]:
    return [Path(p).read_bytes() for p in paths]


def _router_from(args) -> mr.ModelRouter:
    return mr.ModelRouter(env={"OPENAI_IMAGE_MODEL": args.image_model, "OPENAI_IMAGE_MODEL_FALLBACKS": args.image_fallbacks})


def _jobs_from_args(args, references: list[bytes]) -> list[dict]:
    scenario = load_scenario(Path(args.scenario)) if args.scenario else None
    angles = [a.strip() for a in (args.angles or ",".join(scenario["angles"] if scenario else ("CAIMENTO", "PRESENTE_AFETO"))).split(",") if a.strip()]
    return build_jobs(
        arms=args.arms, angles=angles, round_no=args.round, per_round=args.per_round, references=references, scenario=scenario,
        fixture=args.fixture, placement=args.placement, seed=args.seed, quality=args.quality,
        streamlit_golden=Path(args.streamlit_golden) if args.streamlit_golden else None,
        streamlit_prompts_dir=Path(args.streamlit_prompts_dir) if args.streamlit_prompts_dir else None,
        streamlit_store=args.streamlit_store, router=_router_from(args))


def main(argv: list[str] | None = None, *, client_factory=None, env: dict | None = None) -> int:
    env = os.environ if env is None else env
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("plan", "run"):
        p = sub.add_parser(name)
        p.add_argument("--out", required=True)
        p.add_argument("--scenario", help="scenario JSON (product, persona, scene, seeds); default: the fixture")
        p.add_argument("--fixture", default="fixture-clean-single")
        p.add_argument("--angles", default=None)
        p.add_argument("--arms", default=DEFAULT_ARMS, help="letters among A-E (default ABCDE)")
        p.add_argument("--round", type=int, default=1, choices=(1, 2))
        p.add_argument("--per-round", type=int, default=PER_ROUND, help="images per arm × angle in a round")
        p.add_argument("--placement", default="FEED_4X5")
        p.add_argument("--seed", type=int, default=100)
        p.add_argument("--quality", default=None, choices=("low", "medium", "high"))
        p.add_argument("--reference", action="append", help="product reference image (the same file goes to every arm)")
        p.add_argument("--streamlit-golden")
        p.add_argument("--streamlit-prompts-dir")
        p.add_argument("--streamlit-store", default="regional", choices=("regional", "entre_nos"))
        p.add_argument("--image-model", default="gpt-image-2")
        p.add_argument("--image-fallbacks", default="", help="comma list; empty (default) = no fallback, so a missing model fails fast")
        p.add_argument("--max-images", type=int, default=HARD_CAP_PER_RUN, help=f"can only LOWER the hard cap of {HARD_CAP_PER_RUN}")
        p.add_argument("--confirm-round-2", action="store_true")
        if name == "run":
            p.add_argument("--execute", action="store_true")
    rep = sub.add_parser("report")
    rep.add_argument("--out", required=True)
    rep.add_argument("--ratings")
    args = parser.parse_args(argv)
    out = Path(args.out)

    try:
        if args.command == "report":
            print(json.dumps(report(out, Path(args.ratings) if args.ratings else None), indent=1, ensure_ascii=False))
            return 0
        references = _read_references(args.reference or [])
        jobs = _jobs_from_args(args, references)
        limit = min(args.max_images, HARD_CAP_PER_RUN)
        if len(jobs) > limit:
            raise HarnessError(f"{len(jobs)} images exceed the limit of {limit} per run")
        if args.command == "run":
            check_round_allowed(out, args.round, len(jobs), args.confirm_round_2)
        reference = reference_info(references[0]) if references else None
        (out / "plan" / "prompts").mkdir(parents=True, exist_ok=True)
        _write_json(out / "plan" / f"plan_manifest_round{args.round}.json", plan_manifest(jobs, reference, args.round))
        for j in jobs:  # the exact prompt of every arm × angle × seed (no image id: safe to read before rating)
            (out / "plan" / "prompts" / f"{j['arm']}-{j['angle']}-seed{j['seed']}.txt").write_text(j["plan"]["prompt"]["text"], encoding="utf-8")
        if args.command == "plan":
            print(f"DRY RUN — round {args.round}: {len(jobs)} images planned "
                  f"({len(args.arms)} arms × {len(jobs) // max(len(args.arms), 1)} per arm), none sent. Cap per run: {HARD_CAP_PER_RUN}.")
            print(f"Plan: {out / 'plan'}")
            return 0
        _guard_paid(args.execute, env)
        if not references:
            raise HarnessError("a real run needs --reference (the same image goes to every arm)")
        key = env.get(KEY_ENV, "")
        if not key:
            raise HarnessError(f"set {KEY_ENV} (a key provided for this experiment)")
        if client_factory is None:
            from openai import OpenAI  # noqa: PLC0415 — imported only when a paid run is really happening

            client_factory = lambda k: OpenAI(api_key=k, max_retries=0)  # noqa: E731
        summary = run_round(jobs, client_factory(key), out, round_no=args.round, reference=reference, router=_router_from(args))
        print(json.dumps(summary, indent=1))
        print(f"Blind material: {out / 'blind'} (open evaluation.html). Do NOT open {out / 'private'} before rating.")
        return 0
    except HarnessError as exc:
        print(f"ab_harness: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
