"""A/B harness: prepared and testable WITHOUT a paid call — the provider is always a test double here."""
from __future__ import annotations

import base64
import csv
import io
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from _support import ROOT, FakeClient, FakeImages, NotFoundError, RateLimitError, _Obj, run

sys.path.insert(0, str(ROOT / "scripts"))
import ab_harness as ab  # noqa: E402

from creative_core import model_router as mr  # noqa: E402

SCENARIO = ROOT / "scripts" / "ab_scenarios" / "entre_nos_pipa_menina.json"
STREAMLIT = {"CAIMENTO": "STREAMLIT-CAIMENTO texto do gerador interno", "PRESENTE_AFETO": "STREAMLIT-PRESENTE texto do gerador interno"}
ENV_OK = {ab.KEY_ENV: "k" * 24, ab.PAID_ENV: "1"}
ARM_WORDS = (r"streamlit", r"oria", r"prompt_version", r"normaliz", r"gpt-image", r"\barm\b", r"\bv1\b", r"\bv2\b")


def _webp() -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (80, 82), (240, 240, 240)).save(buf, format="WEBP")
    return buf.getvalue()


def _setup(tmp: Path) -> tuple[Path, Path]:
    ref = tmp / "pipa.webp"
    ref.write_bytes(_webp())
    prompts = tmp / "streamlit_prompts"
    prompts.mkdir()
    for angle, text in STREAMLIT.items():
        (prompts / f"{angle}.txt").write_text(text)
    return ref, prompts


def _argv(tmp: Path, *extra: str, command: str = "plan") -> list[str]:
    ref, prompts = _setup(tmp) if not (tmp / "pipa.webp").exists() else (tmp / "pipa.webp", tmp / "streamlit_prompts")
    return [command, "--out", str(tmp / "ab"), "--scenario", str(SCENARIO), "--reference", str(ref),
            "--streamlit-prompts-dir", str(prompts), *extra]


class Provider(FakeImages):
    """Provider double: records every call, returns usage, and can fail or fall back on chosen calls."""

    def __init__(self, fail_all: bool = False, unavailable_on: set[int] | None = None):
        super().__init__()
        self.fail_all, self.unavailable_on, self.n = fail_all, unavailable_on or set(), 0

    def edit(self, **kw):
        self.n += 1
        self.calls.append({"prompt": kw["prompt"], "model": kw["model"], "size": kw["size"], "quality": kw["quality"],
                           "sent": kw["image"][0].getvalue()[:4], "name": kw["image"][0].name})
        if self.fail_all:
            raise RateLimitError("slow down")
        if kw["model"] == "gpt-image-2" and self.n in self.unavailable_on:
            raise NotFoundError("model not available for this key")
        response = _Obj(data=[_Obj(b64_json=base64.b64encode(self._png).decode())],
                        usage={"input_tokens": 1500, "output_tokens": 1584,
                               "input_tokens_details": {"text_tokens": 300, "image_tokens": 1200, "cached_tokens": 0}})
        response._request_id = f"req_{self.n:03d}"
        return response


def _run_round1(tmp: Path, provider: Provider | None = None, *extra: str):
    provider = provider or Provider()
    code = ab.main(_argv(tmp, "--execute", *extra, command="run"), client_factory=lambda k: FakeClient(images=provider), env=ENV_OK)
    return code, provider


def test_given_the_real_scenario_then_round_one_is_five_arms_two_angles_four_images_and_never_more_than_forty():
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        _setup(tmp)
        jobs = ab.build_jobs(arms="ABCDE", angles=["CAIMENTO", "PRESENTE_AFETO"], round_no=1, per_round=4,
                             references=[_webp()], scenario=ab.load_scenario(SCENARIO), streamlit_prompts_dir=tmp / "streamlit_prompts")
        assert len(jobs) == 40 == ab.HARD_CAP_PER_RUN
        spec = {j["arm"]: (j["normalize"], j["plan"]["prompt"]["prompt_version"]) for j in jobs}
        assert spec == {"A": (True, 0), "B": (False, 1), "C": (True, 1), "D": (False, 0), "E": (True, 2)}
        assert {(j["arm"], j["angle"]) for j in jobs} == {(a, g) for a in "ABCDE" for g in ("CAIMENTO", "PRESENTE_AFETO")}
        assert all(sum(1 for j in jobs if (j["arm"], j["angle"]) == k) == 4 for k in {(j["arm"], j["angle"]) for j in jobs})


def test_given_any_configuration_then_a_run_above_forty_images_is_refused_before_anything_is_built_or_sent():
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        sent: list = []
        for extra in (["--per-round", "5"], ["--per-round", "8"], ["--per-round", "4", "--round", "2", "--arms", "ABCDE"]):
            code = ab.main(_argv(tmp, *extra, "--execute", command="run"), client_factory=lambda k: sent.append(k), env=ENV_OK)
            assert code == 2 and sent == [], extra
        assert ab.main(_argv(tmp, "--per-round", "5", "--max-images", "500")) == 2, "--max-images can only lower the cap"
        assert ab.main(_argv(tmp, "--max-images", "20")) == 2
        assert ab.main(_argv(tmp)) == 0


def test_given_the_scenario_then_every_arm_shares_reference_bytes_seed_and_the_child_and_mother_cast():
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        _setup(tmp)
        ref = _webp()
        jobs = ab.build_jobs(arms="ABCDE", angles=["CAIMENTO", "PRESENTE_AFETO"], round_no=1, per_round=4, references=[ref],
                             scenario=ab.load_scenario(SCENARIO), streamlit_prompts_dir=tmp / "streamlit_prompts")
        assert {b for j in jobs for b in j["references"].values()} == {ref}, "the very same bytes in the five arms"
        for angle in ("CAIMENTO", "PRESENTE_AFETO"):
            for image in range(4):
                same = [j for j in jobs if j["angle"] == angle and j["index"] == image]
                assert len({j["seed"] for j in same}) == 1 and len(same) == 5
        oria = {j["arm"]: j["plan"] for j in jobs if j["angle"] == "PRESENTE_AFETO" and j["index"] == 0 and j["arm"] in "BCE"}
        assert {p["persona"]["label"] for p in oria.values()} == {"menina 6 anos"}
        assert all(p["context"]["scene"] == "sala de estar acolhedora com sofá, manta e luz natural lateral" for p in oria.values())
        assert "Pessoa A VESTE" in oria["E"]["prompt"]["text"] and "Pessoa B NÃO veste a peça" in oria["E"]["prompt"]["text"]
        assert "mulher 35 anos, mãe da menina" in oria["E"]["prompt"]["text"]
        assert "menina 6 anos entrega ou recebe o produto" in oria["B"]["prompt"]["text"], "v1: the second person is undefined"
        assert oria["B"]["prompt"]["sha256"] == oria["C"]["prompt"]["sha256"] != oria["E"]["prompt"]["sha256"]
        assert oria["B"]["product_mode"] == "single_product" and len(oria["B"]["products"]) == 1


def test_given_the_scenario_seeds_then_prompt_v2_always_renders_the_child_wears_scenario_for_the_gift():
    scenario = ab.load_scenario(SCENARIO)
    assert all(len(scenario["seeds"][a]) >= 8 for a in ("CAIMENTO", "PRESENTE_AFETO"))
    for seed in scenario["seeds"]["PRESENTE_AFETO"]:
        request = ab._scenario_request(scenario, "PRESENTE_AFETO", seed, "ref/product.bin")
        from creative_core.engines import plan_creative

        text = plan_creative({**request, "prompt_version": 2}, router=mr.ModelRouter(env={}))["prompt"]["text"]
        assert "Pessoa A VESTE" in text and "Pessoa A entrega" not in text, seed


def test_given_missing_streamlit_prompt_then_the_harness_says_so_instead_of_guessing():
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        (tmp / "empty").mkdir()
        try:
            ab.build_jobs(arms="A", angles=["CAIMENTO"], round_no=1, per_round=1, references=[_webp()],
                          scenario=ab.load_scenario(SCENARIO), streamlit_prompts_dir=tmp / "empty")
        except ab.HarnessError as exc:
            assert "CAIMENTO.txt" in str(exc)
        else:
            raise AssertionError("built a Streamlit arm without a Streamlit prompt")


def test_given_plan_command_then_it_is_a_dry_run_that_writes_only_plan_files_and_creates_no_client():
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        created: list = []
        code = ab.main(_argv(tmp), client_factory=lambda k: created.append(k), env={})
        out = tmp / "ab"
        assert code == 0 and not created
        assert sorted(p.name for p in out.iterdir()) == ["plan"], "no private/ and no blind/ before any spend"
        manifest = json.loads((out / "plan" / "plan_manifest_round1.json").read_text())
        assert manifest["images"] == 40 and manifest["reference"]["mime"] == "image/webp"
        prompts = sorted(p.name for p in (out / "plan" / "prompts").iterdir())
        assert "A-CAIMENTO-seed101.txt" in prompts and "E-PRESENTE_AFETO-seed100.txt" in prompts
        assert (out / "plan" / "prompts" / "A-CAIMENTO-seed101.txt").read_text() == STREAMLIT["CAIMENTO"]


def test_given_run_without_execute_paid_env_key_or_reference_then_nothing_is_sent():
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        created: list = []
        factory = lambda k: created.append(k) or FakeClient()  # noqa: E731
        base = _argv(tmp, command="run")
        assert ab.main(base, client_factory=factory, env=ENV_OK) == 2, "no --execute"
        assert ab.main([*base, "--execute"], client_factory=factory, env={ab.KEY_ENV: "k" * 24}) == 2, "no paid env"
        assert ab.main([*base, "--execute"], client_factory=factory, env={ab.PAID_ENV: "1"}) == 2, "no key"
        no_ref = [a for i, a in enumerate(base) if a != "--reference" and base[i - 1] != "--reference"]
        assert ab.main([*no_ref, "--execute"], client_factory=factory, env=ENV_OK) == 2, "no reference"
        assert created == [] and not (tmp / "ab" / "private").exists()


def test_given_harness_module_then_importing_it_never_loads_the_provider_sdk():
    code = f"import sys; sys.path.insert(0, {str(ROOT / 'scripts')!r}); import ab_harness; print('openai' in sys.modules)"
    assert subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True).stdout.strip() == "False"


def test_given_a_full_round_one_with_a_double_then_forty_calls_are_made_and_each_arm_sends_what_it_claims():
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        code, provider = _run_round1(tmp)
        out = tmp / "ab"
        assert code == 0 and len(provider.calls) == 40
        ledger = json.loads((out / "private" / "ledger.json").read_text())
        assert ledger["calls"] == 40 and ledger["rounds"]["1"]["attempted"] == 40 and ledger["rounds"]["1"]["finished"]
        entries = json.loads((out / "private" / "manifest_private.json").read_text())
        assert len(entries) == 40 and sorted(entries) == [f"IMG-{n:03d}" for n in range(1, 41)]
        by_prompt = {"streamlit": [], "oria": []}
        for image_id, e in entries.items():
            trace = e["trace"]
            assert trace["model_served"] == trace["model_requested"] == "gpt-image-2" and trace["models_tried"] == ["gpt-image-2"]
            assert trace["params"] == {"size": "1088x1360", "quality": "medium"}
            item = trace["references"]["items"][0]
            assert item["original_mime"] == "image/webp" and item["normalized"] is e["normalized"]
            assert item["sent_actual_mime"] == ("image/png" if e["normalized"] else "image/webp")
            assert e["reference"]["sha256"] == entries["IMG-001"]["reference"]["sha256"]
            assert trace["provider_request_id"].startswith("req_") and e["cost_usd_estimate"] == 0.05862 == ab.estimate_cost(e["usage"])
            assert (out / "private" / "prompts" / f"{image_id}.txt").read_text()
            by_prompt["streamlit" if e["prompt_version"] == 0 else "oria"].append(e["arm"])
        assert set(by_prompt["streamlit"]) == {"A", "D"} and set(by_prompt["oria"]) == {"B", "C", "E"}
        assert {(c["model"], c["size"], c["quality"]) for c in provider.calls} == {("gpt-image-2", "1088x1360", "medium")}
        assert sum(1 for c in provider.calls if c["prompt"] in STREAMLIT.values()) == 16, "arms A and D: 2 arms × 2 angles × 4 images"
        contamination = json.loads((out / "private" / "contamination.json").read_text())
        assert contamination["contaminated"] is False and contamination["all_same_model"] and contamination["served_models"] == ["gpt-image-2"]


def test_given_a_round_one_then_the_blind_package_reveals_nothing_and_is_in_random_order():
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        _run_round1(tmp)
        blind = tmp / "ab" / "blind"
        names = sorted(p.name for p in blind.iterdir())
        assert names == sorted(["evaluation.html", "ratings.csv", *[f"IMG-{n:03d}.png" for n in range(1, 41)]])
        page = (blind / "evaluation.html").read_text()
        sheet = (blind / "ratings.csv").read_text()
        visible = re.sub(r"<script>.*?</script>|<style>.*?</style>", "", page, flags=re.S)
        for word in ARM_WORDS:
            assert not re.search(word, sheet, re.I), word
            assert not re.search(word, visible, re.I), word
            assert not re.search(word, " ".join(names), re.I), f"file names carry no information either: {word}"
        header = sheet.splitlines()[0].split(",")
        assert header == list(ab.RATING_COLUMNS) and "arm" not in header
        shown = re.search(r"const IDS=(\[.*?\])", page).group(1)
        order = json.loads(shown)
        assert sorted(order) == [f"IMG-{n:03d}" for n in range(1, 41)] and order != sorted(order)
        entries = json.loads((tmp / "ab" / "private" / "manifest_private.json").read_text())
        arms_in_order = [entries[i]["arm"] for i in order[:10]]
        assert len(set(arms_in_order)) > 1, "not grouped by arm"
        # the ids follow the (shuffled) call order, so they do not line up with the arms either
        assert len({entries[f"IMG-{n:03d}"]["arm"] for n in range(1, 11)}) > 1
        for name in ("hand_problem", "finger_problem", "limb_problem", "fused_people", "other_anatomy", "composition",
                     "people_count_ok", "people_roles_ok", "people_interaction_ok", "garment_ok", "print_ok", "color_fit_ok", "commercial"):
            assert name in page


def test_given_round_one_finished_then_round_two_is_refused_without_confirmation_and_when_run_twice():
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        _run_round1(tmp)
        refused = []
        factory = lambda k: refused.append(k) or FakeClient()  # noqa: E731
        assert ab.main(_argv(tmp, "--round", "2", "--execute", command="run"), client_factory=factory, env=ENV_OK) == 2
        assert ab.main(_argv(tmp, "--round", "1", "--execute", command="run"), client_factory=factory, env=ENV_OK) == 2, "round 1 twice"
        assert refused == []
        provider = Provider()
        code = ab.main(_argv(tmp, "--round", "2", "--confirm-round-2", "--execute", command="run"),
                       client_factory=lambda k: FakeClient(images=provider), env=ENV_OK)
        assert code == 0 and len(provider.calls) == 40
        assert json.loads((tmp / "ab" / "private" / "ledger.json").read_text())["calls"] == 80
        assert sorted(json.loads((tmp / "ab" / "private" / "manifest_private.json").read_text()))[-1] == "IMG-080"
        third = ab.main(_argv(tmp, "--round", "2", "--confirm-round-2", "--execute", command="run"), client_factory=factory, env=ENV_OK)
        assert third == 2 and refused == [], "the 80-call ceiling holds"


def test_given_round_two_without_round_one_then_it_is_refused():
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        created: list = []
        code = ab.main(_argv(tmp, "--round", "2", "--confirm-round-2", "--execute", command="run"),
                       client_factory=lambda k: created.append(k), env=ENV_OK)
        assert code == 2 and created == []


def test_given_a_fallback_model_answers_then_the_round_is_flagged_contaminated_and_round_two_is_refused():
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        provider = Provider(unavailable_on={7, 19})
        code, _ = _run_round1(tmp, provider, "--image-fallbacks", "gpt-image-1")
        assert code == 0
        contamination = json.loads((tmp / "ab" / "private" / "contamination.json").read_text())
        assert contamination["contaminated"] is True and not contamination["all_same_model"]
        assert contamination["served_models"] == ["gpt-image-1", "gpt-image-2"]
        assert sum(r.startswith("fallback_used") for r in contamination["reasons"]) == 2
        assert any(r.startswith("mixed_models_served") for r in contamination["reasons"])
        refused = []
        code = ab.main(_argv(tmp, "--round", "2", "--confirm-round-2", "--execute", command="run", *[]),
                       client_factory=lambda k: refused.append(k), env=ENV_OK)
        assert code == 2 and refused == []


def test_given_no_fallback_configured_and_an_unavailable_model_then_the_run_fails_fast_and_stops_after_three():
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        provider = Provider(fail_all=True)
        code, _ = _run_round1(tmp, provider)
        assert code == 0 and len(provider.calls) == ab.MAX_CONSECUTIVE_FAILURES == 3
        summary = json.loads((tmp / "ab" / "private" / "summary_round1.json").read_text())
        assert summary["aborted"] is True and summary["attempted"] == 3
        assert json.loads((tmp / "ab" / "private" / "ledger.json").read_text())["calls"] == 3


def test_given_usage_then_cost_is_estimated_from_the_price_table_and_absent_usage_stays_none():
    usage = {"input_tokens": 1500, "output_tokens": 1584, "text_input_tokens": 300, "image_input_tokens": 1200, "cached_input_tokens": 0}
    assert ab.estimate_cost(usage) == round((300 * 5 + 1200 * 8 + 1584 * 30) / 1e6, 5)
    assert ab.estimate_cost(usage) == 0.05862
    assert ab.estimate_cost({"input_tokens": 1000, "output_tokens": 0}) == 0.008, "no split: uncached input at the image price"
    assert ab.estimate_cost(None) is None and ab.estimate_cost({}) is None


def test_given_filled_ratings_then_report_aggregates_per_arm_and_angle_and_lists_the_five_comparisons():
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        _run_round1(tmp)
        out = tmp / "ab"
        entries = json.loads((out / "private" / "manifest_private.json").read_text())
        rows = []
        for image_id, e in sorted(entries.items()):
            bad = e["arm"] in "BD" and e["index"] < 2
            rows.append({"image_id": image_id, "hand_problem": "1" if bad else "0", "finger_problem": "0", "limb_problem": "0",
                         "fused_people": "0", "other_anatomy": "0", "composition": "correct",
                         "people_count_ok": "na" if e["angle"] == "CAIMENTO" else "yes",
                         "people_roles_ok": "na" if e["angle"] == "CAIMENTO" else "yes",
                         "people_interaction_ok": "na" if e["angle"] == "CAIMENTO" else "no",
                         "garment_ok": "yes", "print_ok": "partial", "color_fit_ok": "yes",
                         "commercial": "unusable" if bad else "usable", "notes": ""})
        rows[0]["commercial"] = ""  # one left unrated
        with open(out / "blind" / "ratings.csv", "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=ab.RATING_COLUMNS)
            writer.writeheader()
            writer.writerows(rows)
        result = ab.report(out)
        cell = result["cells"]["B/CAIMENTO"]
        assert cell["rated"] == 4 and cell["any_anatomy_defect"] == 2 and cell["anatomy_defect_rate"] == 0.5
        assert cell["anatomy"]["hand_problem"] == 2 and cell["commercial"] == {"unusable": 2, "usable": 2}
        assert cell["people_ok"]["applicable"] == 0 and result["cells"]["B/PRESENTE_AFETO"]["people_ok"]["interaction"] == 0
        assert result["cells"]["A/CAIMENTO"]["anatomy_defect_rate"] == 0.0 and cell["cost_usd_estimate"] == round(4 * 0.05862, 5)
        assert len(result["unrated_images"]) == 1 and result["contamination"]["contaminated"] is False
        assert {c["comparison"] for c in result["comparisons"]} == {"A×B", "B×C", "A×D", "C×E", "A×E"}
        ab_cmp = next(c for c in result["comparisons"] if c["comparison"] == "A×B" and c["angle"] == "CAIMENTO")
        assert ab_cmp["anatomy_defect_rate"] == [0.0, 0.5] and "winner" not in json.dumps(result).lower()


if __name__ == "__main__":
    run(globals())
