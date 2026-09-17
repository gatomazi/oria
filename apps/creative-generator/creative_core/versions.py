"""Version registry of the creative core.

Every generated creative records these numbers so a result can always be traced
back to the exact contract, prompt and kit revisions that produced it. Bump the
matching constant whenever the behaviour it names changes.
"""
from __future__ import annotations

CORE_VERSION = "1.1.0"

# Shape of the public contracts (contracts.py / schemas/).
SCHEMA_VERSION = 1

# Text of the prompts assembled by the core engines (templates + rules).
PROMPT_VERSION = 1

# Revision of the internal prompt banks (ads/templates, lojas/*/templates) used
# by the 6 internal strategies of app.py. Recorded in the local history.
INTERNAL_PROMPT_BANK_VERSION = 1

# Default schema/revision for kits and context profiles created by the core.
BRAND_KIT_SCHEMA_VERSION = 1
NICHE_KIT_SCHEMA_VERSION = 1
CONTEXT_PROFILE_SCHEMA_VERSION = 1
CONTEXT_PROMPT_VERSION = 1

# Behaviour version per strategy. Internal-only strategies are versioned too so
# the local history can tell regressions apart from intentional changes.
STRATEGY_VERSIONS = {
    "FUNNEL_VISUAL": 1,
    "STATE_COLLECTION": 1,
    "REMARKETING": 1,
    "CLEAN_ANGLES": 1,
    "MULTI_PRODUCT_INTERNAL": 1,
    "ORGANIC": 1,
}


def version_manifest() -> dict:
    """Flat dict with every version the handoff contract asks the consumer to persist."""
    return {
        "core_version": CORE_VERSION,
        "schema_version": SCHEMA_VERSION,
        "prompt_version": PROMPT_VERSION,
        "brand_kit_schema_version": BRAND_KIT_SCHEMA_VERSION,
        "niche_kit_schema_version": NICHE_KIT_SCHEMA_VERSION,
        "context_profile_schema_version": CONTEXT_PROFILE_SCHEMA_VERSION,
        "clean_angles_version": STRATEGY_VERSIONS["CLEAN_ANGLES"],
        "remarketing_version": STRATEGY_VERSIONS["REMARKETING"],
        "funnel_visual_version": STRATEGY_VERSIONS["FUNNEL_VISUAL"],
    }
