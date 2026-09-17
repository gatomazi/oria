"""Image asset helpers shared by the internal generator and the core engines.

converter_para_png / redimensionar_cover moved verbatim from app.py (Etapa 1).
Pure Pillow — no Streamlit, no provider SDK.
"""
from __future__ import annotations

import base64
import hashlib
import io

from PIL import Image


def converter_para_png(bytes_arquivo: bytes) -> io.BytesIO:
    """Converte qualquer formato suportado (webp, jpg, png...) para PNG em memória.
    Garante compatibilidade com a API independente do formato original da estampa."""
    img = Image.open(io.BytesIO(bytes_arquivo))
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGBA")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    buf.name = "estampa.png"  # ajuda o client a inferir o content-type correto
    return buf


def redimensionar_cover(png_bytes: bytes, largura=1080, altura=1350) -> bytes:
    """Redimensiona pra proporção EXATA via crop-to-fit (nunca distorce),
    funciona corretamente seja qual for o tamanho realmente retornado pela
    API. Se a imagem já vier na proporção 4:5 (ex: 1088x1360), o crop
    calculado é zero — vira um resize limpo. Se vier em outra proporção
    (ex: 1024x1536, 2:3, retornado por endpoints/; modos que só aceitam
    tamanhos legados), corta o excesso central antes de redimensionar.
    Usado em AMBOS os modos (Instantâneo e Batch) — não assume qual
    dimensão exata a API devolve, só garante o resultado final correto."""
    img = Image.open(io.BytesIO(png_bytes))
    img_w, img_h = img.size
    target_ratio = largura / altura
    img_ratio = img_w / img_h

    if img_ratio > target_ratio:
        new_w = int(img_h * target_ratio)
        left = (img_w - new_w) // 2
        img_cropped = img.crop((left, 0, left + new_w, img_h))
    else:
        new_h = int(img_w / target_ratio)
        top = (img_h - new_h) // 2
        img_cropped = img.crop((0, top, img_w, top + new_h))

    img_final = img_cropped.resize((largura, altura), Image.LANCZOS)
    buf = io.BytesIO()
    img_final.save(buf, format="PNG")
    return buf.getvalue()


def asset_from_provider_b64(b64_png: str, width: int, height: int) -> dict:
    """Provider base64 PNG -> AssetInfo (resized to the exact placement size)."""
    final = redimensionar_cover(base64.b64decode(b64_png), largura=width, altura=height)
    return {
        "mime_type": "image/png",
        "width": width,
        "height": height,
        "byte_size": len(final),
        "sha256": hashlib.sha256(final).hexdigest(),
        "data_base64": base64.b64encode(final).decode("ascii"),
    }
