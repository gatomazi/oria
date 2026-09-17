"""Runs the creative core suites (script-style, one process each).

    python run_tests.py

Needs Pillow in the interpreter (openai/gunicorn are not needed for tests:
the service tests inject a fake client factory). Exit code 0 only if every
suite passes.
"""
from __future__ import annotations

import compileall
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def main() -> int:
    built = compileall.compile_dir(str(ROOT / "creative_core"), quiet=1)
    print(f"build (compileall): {'OK' if built else 'FALHOU'}")
    failed = 0
    suites = sorted((ROOT / "creative_core" / "tests").glob("test_*.py"))
    for suite in suites:
        proc = subprocess.run([sys.executable, str(suite)], cwd=ROOT, capture_output=True, text=True)
        last = (proc.stdout.strip().splitlines() or ["(sem saída)"])[-1]
        print(f"{'OK ' if proc.returncode == 0 else 'ERR'} {suite.relative_to(ROOT)} :: {last}")
        if proc.returncode:
            failed += 1
            print(proc.stdout[-2000:], proc.stderr[-2000:], sep="\n")
    print(f"\nsuítes: {len(suites) - failed}/{len(suites)} OK")
    return 0 if built and not failed else 1


if __name__ == "__main__":
    sys.exit(main())
