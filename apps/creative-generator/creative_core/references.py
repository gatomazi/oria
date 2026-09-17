"""Reference handling rules.

Priority when sources disagree (Etapa 1 spec §19):
    current product > current data > Brand Kit > Niche Kit > Context Intelligence > layout reference

Inspiration images teach composition only (§20). The flag is re-exported from
the pure remarketing module, where it was first introduced, so there is a
single source of truth.
"""
from __future__ import annotations

import base64
import binascii
import hashlib

from .domain.remarketing import REFERENCE_IMAGES_ARE_LAYOUT_ONLY  # noqa: F401 — public re-export

from .errors import GenerationError

REFERENCE_PRIORITY = (
    "current_product",
    "current_data",
    "brand_kit",
    "niche_kit",
    "context_intelligence",
    "layout_reference",
)

LAYOUT_REFERENCE_MAY_COPY = ("composição", "hierarquia", "densidade", "linguagem visual", "posição de elementos")
LAYOUT_REFERENCE_NEVER_COPY = ("estampa", "cidade", "logo", "nome", "produto", "modelo", "copy literal")

MAX_REFERENCE_BYTES = 10 * 1024 * 1024
_SIGNATURES = {
    b"\x89PNG\r\n\x1a\n": "image/png",
    b"\xff\xd8\xff": "image/jpeg",
    b"RIFF": "image/webp",
}


def reference_roles(products: list) -> list[dict]:
    """Order of the images sent to the model: each product's reference images,
    product by product. Every one of them is product art (authority on design
    and position) — layout-only inspiration is never sent by the public engines."""
    roles = []
    for product in products:
        for ref in product["referenceImages"]:
            roles.append({"ref": ref, "product_id": product["id"], "role": "product_art", "order": len(roles) + 1})
    return roles


def layout_only_rule() -> str:
    return (
        "IMAGENS DE INSPIRAÇÃO (quando houver): servem SOMENTE para "
        + ", ".join(LAYOUT_REFERENCE_MAY_COPY)
        + ". Nunca copie delas: " + ", ".join(LAYOUT_REFERENCE_NEVER_COPY) + "."
    )


def decode_reference(data_base64: str) -> tuple[bytes, str]:
    """Decodes an inline reference image and checks size and magic bytes.
    The core never downloads references from URLs (no SSRF surface): the
    consumer resolves its storage and sends the bytes."""
    try:
        raw = base64.b64decode(data_base64, validate=True)
    except (binascii.Error, ValueError):
        raise GenerationError("INVALID_REFERENCE", {"reason": "invalid_base64"}) from None
    if not raw or len(raw) > MAX_REFERENCE_BYTES:
        raise GenerationError("INVALID_REFERENCE", {"reason": "size", "max_bytes": MAX_REFERENCE_BYTES})
    for signature, mime in _SIGNATURES.items():
        if raw.startswith(signature):
            if mime == "image/webp" and raw[8:12] != b"WEBP":
                break
            return raw, mime
    raise GenerationError("INVALID_REFERENCE", {"reason": "unsupported_type"})


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()
