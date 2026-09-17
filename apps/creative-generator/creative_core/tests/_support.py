"""Shared test support: script runner (same output style as the project's
existing suites) and provider test doubles. Test functions are plain
`test_*` functions with asserts, so pytest can also collect them."""
from __future__ import annotations

import base64
import io
import json
import sys
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

FIXTURES_DIR = ROOT / "creative_core" / "fixtures"


def run(module_globals: dict) -> None:
    tests = [(n, f) for n, f in module_globals.items() if n.startswith("test_") and callable(f)]
    print(f"\nrodando {len(tests)} testes...\n")
    ok = 0
    for name, fn in tests:
        try:
            fn()
            print(f"  ✓ {name}")
            ok += 1
        except AssertionError as e:
            print(f"  ✗ {name}: {e}")
        except Exception as e:  # noqa: BLE001
            print(f"  ✗ {name}: EXCEPTION — {type(e).__name__}: {e}")
            traceback.print_exc()
    falhas = len(tests) - ok
    print("\n───────────────────────────────────────────────────────")
    print(f"Resultado: {ok}/{len(tests)} passaram" + (" — todos OK ✓" if not falhas else f" — {falhas} falharam"))
    sys.exit(0 if not falhas else 1)


def png_bytes(width: int = 64, height: int = 80, color=(200, 180, 150)) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (width, height), color).save(buf, format="PNG")
    return buf.getvalue()


def load_fixture(name: str) -> dict:
    with open(FIXTURES_DIR / f"{name}.json", encoding="utf-8") as f:
        return json.load(f)


def all_fixtures() -> list[dict]:
    return [json.load(open(p, encoding="utf-8")) for p in sorted(FIXTURES_DIR.glob("fixture-*.json"))]


def dig(obj, dotted: str):
    cur = obj
    for part in dotted.split("."):
        if isinstance(cur, list):
            cur = cur[int(part)]
        else:
            cur = cur[part]
    return cur


class _Obj:
    def __init__(self, **kw):
        self.__dict__.update(kw)


class FakeImages:
    def __init__(self, error: Exception | None = None, width: int = 1024, height: int = 1536):
        self.calls: list[dict] = []
        self._error = error
        self._png = png_bytes(width, height)

    def edit(self, **kwargs):
        self.calls.append(kwargs)
        if self._error:
            raise self._error
        return _Obj(data=[_Obj(b64_json=base64.b64encode(self._png).decode())])


class FakeResponses:
    def __init__(self, output_text: str = "", error: Exception | None = None):
        self.calls: list[dict] = []
        self._text = output_text
        self._error = error

    def create(self, **kwargs):
        self.calls.append(kwargs)
        if self._error:
            raise self._error
        return _Obj(output_text=self._text)


class FakeClient:
    def __init__(self, images: FakeImages | None = None, responses: FakeResponses | None = None):
        self.images = images or FakeImages()
        self.responses = responses or FakeResponses()


class AuthenticationError(Exception):
    """Mimics the SDK class name; message deliberately contains a secret."""

    status_code = 401


class RateLimitError(Exception):
    status_code = 429


class NotFoundError(Exception):
    status_code = 404
