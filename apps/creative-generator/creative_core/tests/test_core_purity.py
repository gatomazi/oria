"""The shared core must not depend on the internal UI, the SaaS panel or a
provider SDK at import time (Etapa 1 spec §28)."""
from __future__ import annotations

import ast
import subprocess
import sys

from _support import ROOT, run

CORE = ROOT / "creative_core"
FORBIDDEN_TOP_LEVEL = {"streamlit", "openai", "app", "react", "sqlalchemy", "django", "flask"}


def _top_level_imports(path):
    tree = ast.parse(path.read_text(encoding="utf-8"))
    names = set()
    for node in tree.body:
        if isinstance(node, ast.Import):
            names.update(a.name.split(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            names.add(node.module.split(".")[0])
    return names


def test_given_core_modules_then_no_forbidden_top_level_imports():
    offenders = {}
    for path in CORE.glob("*.py"):
        bad = _top_level_imports(path) & FORBIDDEN_TOP_LEVEL
        if bad:
            offenders[path.name] = sorted(bad)
    assert not offenders, offenders


def test_given_fresh_interpreter_when_importing_whole_core_then_streamlit_and_openai_not_loaded():
    code = (
        "import sys; sys.path.insert(0, %r)\n"
        "import creative_core.engines, creative_core.service, creative_core.history, creative_core.kits\n"
        "print(sorted(m for m in ('streamlit', 'openai', 'app') if m in sys.modules))\n"
    ) % str(ROOT)
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True).stdout.strip()
    assert out == "[]", out


def test_given_core_source_then_no_global_api_key_lookup():
    for path in CORE.glob("*.py"):
        text = path.read_text(encoding="utf-8")
        assert "OPENAI_API_KEY" not in text, f"{path.name} reads a global key"
        assert "load_dotenv" not in text, f"{path.name} loads .env"


def test_given_core_source_then_no_tenant_billing_or_feature_flag_coupling():
    for path in CORE.glob("*.py"):
        text = path.read_text(encoding="utf-8").lower()
        for token in ("tenant_id", "billing", "feature_flag", "entitlement"):
            assert token not in text, f"{path.name}: {token}"


if __name__ == "__main__":
    run(globals())
