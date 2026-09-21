"""A/B harness (Fase A7): prepared and testable WITHOUT a paid call — the provider is always a test double here."""
from __future__ import annotations

import base64
import csv
import io
import json
import sys
import tempfile
from pathlib import Path

from _support import ROOT, FakeClient, FakeImages, _Obj, run

sys.path.insert(0, str(ROOT / "scripts"))
import ab_harness as ab  # noqa: E402

STREAMLIT_TEXT = {"CAIMENTO": "STREAMLIT-CAIMENTO: braços relaxados ao lado do corpo",
                  "PRESENTE_AFETO": "STREAMLIT-PRESENTE: escolha UMA das duas cenas"}


def _jpeg() -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (48, 64), (20, 90, 160)).save(buf, format="JPEG")
    return buf.getvalue()


def _golden(tmp: Path) -> Path:
    path = tmp / "internal_prompts.json"
    path.write_text(json.dumps({f"angulos_limpos/regional/FEED_4X5/{a}/None": t for a, t in STREAMLIT_TEXT.items()}))
    return path


def _jobs(tmp: Path, **overrides):
    args = dict(fixture="fixture-clean-single", angles=["CAIMENTO", "PRESENTE_AFETO"], arms="ABCD", n=3,
                placement="FEED_4X5", seed=100, quality=None, references=[_jpeg()], streamlit_golden=_golden(tmp),
                streamlit_prompts_dir=None, streamlit_store="regional")
    args.update(overrides)
    return ab.build_jobs(**args)


class Recorder(FakeImages):
    """Keeps what each call sent, to prove the arms differ only where they should."""

    def edit(self, **kwargs):
        self.calls.append({"prompt": kwargs["prompt"], "first_bytes": kwargs["image"][0].getvalue()[:4],
                           "model": kwargs["model"], "size": kwargs["size"], "quality": kwargs["quality"]})
        return _Obj(data=[_Obj(b64_json=base64.b64encode(self._png).decode())])


def test_given_default_arms_then_manifest_has_four_arms_with_the_intended_prompt_and_reference_handling():
    with tempfile.TemporaryDirectory() as d:
        jobs = _jobs(Path(d))
        assert len(jobs) == 4 * 2 * 3
        spec = {(j["arm"]): (j["normalize"], j["plan"]["prompt"]["prompt_version"]) for j in jobs}
        assert spec == {"A": (True, 0), "B": (False, 1), "C": (True, 1), "D": (False, 0)}
        manifest = ab.manifest(jobs)
        assert manifest["images"] == 24 and sorted(manifest["arms"]) == list("ABCD")
        assert all(m["model"]["model"] == "gpt-image-2" and m["model"]["size"] == "1088x1360" for m in manifest["jobs"])


def test_given_same_index_then_every_arm_shares_the_seed_and_the_oria_arms_share_scene_and_persona():
    with tempfile.TemporaryDirectory() as d:
        jobs = [j for j in _jobs(Path(d), arms="BCE", angles=["CAIMENTO"]) if j["index"] == 1]
        assert {j["seed"] for j in jobs} == {101}
        scenes = {(j["plan"]["context"]["scene"], (j["plan"]["persona"] or {}).get("label")) for j in jobs}
        assert len(scenes) == 1
        assert {j["arm"]: j["plan"]["prompt"]["prompt_version"] for j in jobs} == {"B": 1, "C": 1, "E": 2}
        b, c = (next(j for j in jobs if j["arm"] == a) for a in "BC")
        assert b["plan"]["prompt"]["sha256"] == c["plan"]["prompt"]["sha256"], "B and C differ only in the reference"


def test_given_streamlit_arm_then_only_the_prompt_is_swapped_and_the_rest_of_the_plan_is_the_same():
    with tempfile.TemporaryDirectory() as d:
        jobs = _jobs(Path(d), angles=["CAIMENTO"], arms="AC", n=1)
        a, c = jobs
        assert a["plan"]["prompt"]["text"] == STREAMLIT_TEXT["CAIMENTO"]
        for field in ("model", "references", "placement", "angle", "persona", "context"):
            assert a["plan"][field] == c["plan"][field], field


def test_given_missing_streamlit_source_then_the_harness_says_so_instead_of_guessing():
    with tempfile.TemporaryDirectory() as d:
        for kwargs in ({"streamlit_golden": None}, {"streamlit_store": "entre_nos"}):
            try:
                _jobs(Path(d), arms="A", **kwargs)
            except ab.HarnessError as exc:
                assert "golden" in str(exc) or "streamlit" in str(exc).lower()
            else:
                raise AssertionError("built a Streamlit arm without a Streamlit prompt")
        prompts = Path(d) / "prompts"
        prompts.mkdir()
        (prompts / "CAIMENTO.txt").write_text("from the app's Ver prompts\n")
        (job,) = _jobs(Path(d), arms="A", angles=["CAIMENTO"], n=1, streamlit_golden=None, streamlit_prompts_dir=prompts)
        assert job["plan"]["prompt"]["text"] == "from the app's Ver prompts"


def test_given_unknown_arm_or_too_many_images_then_it_refuses_before_building_anything_paid():
    with tempfile.TemporaryDirectory() as d:
        try:
            _jobs(Path(d), arms="AZ")
        except ab.HarnessError:
            pass
        else:
            raise AssertionError("accepted an unknown arm")
        code = ab.main(["plan", "--out", str(Path(d) / "o"), "--streamlit-golden", str(_golden(Path(d))), "-n", "40", "--max-images", "10"])
        assert code == 2


def test_given_plan_command_then_it_is_a_dry_run_that_writes_only_a_manifest():
    with tempfile.TemporaryDirectory() as d:
        out = Path(d) / "run"
        created: list = []
        code = ab.main(["plan", "--out", str(out), "--streamlit-golden", str(_golden(Path(d))), "-n", "2"],
                       client_factory=lambda k: created.append(k), env={})
        assert code == 0 and not created
        assert sorted(p.name for p in out.iterdir()) == ["manifest.json"]
        assert json.loads((out / "manifest.json").read_text())["images"] == 2 * 2 * 4


def test_given_run_without_execute_or_without_the_paid_env_then_nothing_is_sent():
    with tempfile.TemporaryDirectory() as d:
        ref = Path(d) / "art.jpg"
        ref.write_bytes(_jpeg())
        base = ["run", "--out", str(Path(d) / "run"), "--reference", str(ref), "--streamlit-golden", str(_golden(Path(d))), "-n", "1"]
        created: list = []
        factory = lambda k: created.append(k) or FakeClient()  # noqa: E731
        assert ab.main(base, client_factory=factory, env={ab.KEY_ENV: "sk-x" * 10, ab.PAID_ENV: "1"}) == 2, "no --execute"
        assert ab.main([*base, "--execute"], client_factory=factory, env={ab.KEY_ENV: "sk-x" * 10}) == 2, "no paid env"
        assert ab.main([*base, "--execute"], client_factory=factory, env={ab.PAID_ENV: "1"}) == 2, "no dedicated key"
        assert created == []


def test_given_harness_module_then_importing_it_never_loads_the_provider_sdk():
    import subprocess

    code = f"import sys; sys.path.insert(0, {str(ROOT / 'scripts')!r}); import ab_harness; print('openai' in sys.modules)"
    assert subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True).stdout.strip() == "False"


def test_given_execute_with_a_test_double_then_arms_send_exactly_what_they_claim_and_the_sheet_is_blind():
    with tempfile.TemporaryDirectory() as d:
        ref = Path(d) / "art.jpg"
        ref.write_bytes(_jpeg())
        out = Path(d) / "run"
        images = Recorder()
        client = FakeClient(images=images)
        code = ab.main(["run", "--out", str(out), "--reference", str(ref), "--streamlit-golden", str(_golden(Path(d))),
                        "--angles", "CAIMENTO", "-n", "2", "--execute"],
                       client_factory=lambda k: client, env={ab.KEY_ENV: "k" * 24, ab.PAID_ENV: "1"})
        assert code == 0 and len(images.calls) == 8
        key = json.loads((out / "key.json").read_text())
        traces = {b: json.loads((out / "traces" / f"{b}.json").read_text()) for b in key}
        by_arm: dict = {}
        for blind, meta in key.items():
            trace = traces[blind]["trace"]
            by_arm.setdefault(meta["arm"], []).append((trace["references"]["normalized"], trace["references"]["items"][0]["sent_actual_mime"],
                                                       trace["prompt"]["version"]))
        assert {a: set(v) for a, v in by_arm.items()} == {
            "A": {(True, "image/png", 0)}, "B": {(False, "image/jpeg", 1)},
            "C": {(True, "image/png", 1)}, "D": {(False, "image/jpeg", 0)}}
        streamlit_prompts = [c for c in images.calls if c["prompt"] == STREAMLIT_TEXT["CAIMENTO"]]
        assert len(streamlit_prompts) == 4, "arms A and D send the Streamlit prompt"
        assert {(c["model"], c["size"], c["quality"]) for c in images.calls} == {("gpt-image-2", "1088x1360", "medium")}
        header = (out / "ratings.csv").read_text().splitlines()[0]
        assert header == ",".join(ab.RATING_COLUMNS) and "arm" not in header
        sheet = (out / "ratings.csv").read_text()
        assert not any(word in sheet for word in ("Streamlit", "oria", '"A"')), "the sheet must not reveal the arm"
        assert sorted(key) == sorted(f"img{n:03d}" for n in range(1, 9))


def test_given_filled_ratings_then_report_aggregates_defects_per_arm_and_skips_unrated_rows():
    with tempfile.TemporaryDirectory() as d:
        out = Path(d)
        (out / "key.json").write_text(json.dumps({f"img00{n}": {"arm": arm} for n, arm in enumerate("AABBB", 1)}))
        rows = [("img001", "0", "0", "0"), ("img002", "1", "1", "0"), ("img003", "0", "0", "0"), ("img004", "1", "0", "0"), ("img005", "", "", "")]
        with open(out / "ratings.csv", "w", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(ab.RATING_COLUMNS)
            for blind, hands, fingers, other in rows:
                writer.writerow([blind, f"images/{blind}.png", hands, fingers, other, ""])
        result = ab.report(out)
        assert result["A"] == {"rated": 2, "wrong_hands": 1, "extra_fingers": 1, "other_anatomy": 0, "any_defect": 1, "defect_rate": 0.5}
        assert result["B"]["rated"] == 2 and result["B"]["defect_rate"] == 0.5


if __name__ == "__main__":
    run(globals())
