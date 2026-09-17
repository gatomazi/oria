"""Refreshes the regional catalog snapshot shipped with the core.

The internal generator (project estamparia-criativos) owns and edits
config/regioes.json and config/cidades.json at runtime. The service ships a
snapshot in creative_core/data/. Run this after changing the generator data:

    python scripts/sync_data.py /path/to/estamparia-criativos          # copy
    python scripts/sync_data.py /path/to/estamparia-criativos --check  # exit 1 if stale
"""
from __future__ import annotations

import filecmp
import shutil
import sys
from pathlib import Path

DATA = Path(__file__).resolve().parents[1] / "creative_core" / "data"
FILES = ("regioes.json", "cidades.json")


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    source = Path(argv[1]).expanduser().resolve() / "config"
    check = "--check" in argv
    stale = [f for f in FILES if not filecmp.cmp(source / f, DATA / f, shallow=False)]
    if check:
        print("stale: " + ", ".join(stale) if stale else "data in sync")
        return 1 if stale else 0
    for name in stale:
        shutil.copyfile(source / name, DATA / name)
        print(f"updated {name}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
