"""Placements (delivery formats) shared by every strategy.

Moved verbatim from app.py in Etapa 1. The internal generator supports Feed,
Story and Carousel; the public SaaS contract exposes Feed and Story only
(PUBLIC_PLACEMENTS) — carousel stays internal until its multi-card flow has
a contract of its own.
"""
from __future__ import annotations

# ---------- Placements suportados ----------
# Cada placement define: tamanho pedido à API no modo Instantâneo (multipart,
# aceita tamanhos flexíveis múltiplos de 16 conforme guia do gpt-image-2),
# tamanho pedido no modo Batch (schema JSON só aceita os 4 tamanhos legados —
# usamos sempre 1024x1536 e deixamos o crop-to-fit resolver a proporção
# final), e a dimensão FINAL exata desejada.
PLACEMENTS = ["FEED_4X5", "STORY_9X16", "CARROSSEL_4X5"]

PLACEMENT_CONFIG = {
    "FEED_4X5": {
        "api_size_instant": "1088x1360",
        "api_size_batch": "1024x1536",
        "largura_final": 1080,
        "altura_final": 1350,
        "label": "Feed (4:5 — 1080×1350)",
    },
    "STORY_9X16": {
        "api_size_instant": "1024x1824",
        "api_size_batch": "1024x1536",
        "largura_final": 1080,
        "altura_final": 1920,
        "label": "Stories (9:16 — 1080×1920)",
    },
    "CARROSSEL_4X5": {
        "api_size_instant": "1088x1360",
        "api_size_batch": "1024x1536",
        "largura_final": 1080,
        "altura_final": 1350,
        "label": "Carrossel (4:5 por card — 1080×1350)",
    },
}

PUBLIC_PLACEMENTS = ("FEED_4X5", "STORY_9X16")


def placement_descriptor(placement_id: str) -> dict:
    """Placement contract (see contracts.CONTRACTS["Placement"])."""
    cfg = PLACEMENT_CONFIG[placement_id]
    return {
        "id": placement_id,
        "label": cfg["label"],
        "width": cfg["largura_final"],
        "height": cfg["altura_final"],
        "api_size": cfg["api_size_instant"],
    }
