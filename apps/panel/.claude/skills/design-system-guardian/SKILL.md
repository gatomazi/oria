---
name: design-system-guardian
description: Use when creating, refactoring, or reviewing frontend components across multiple pages. Enforces consistent tokens, typography, spacing, semantic colors, component variants, states, and reusable patterns so the application feels like one coherent product.
---

# Design System Guardian

Prioritize system-level consistency over page-specific CSS patches.

## Centralize tokens
Define:
- app/surface colors;
- text colors;
- border colors;
- semantic colors;
- spacing;
- radii;
- shadows;
- control heights;
- type scale;
- z-index;
- motion durations.

Use CSS variables or the project's theme system.

## Dark surface hierarchy
Define distinct levels for:
- app background;
- sidebar;
- primary surface;
- elevated surface;
- subtle surface;
- hover surface;
- active surface;
- default/emphasized borders.

Do not use one dark hex everywhere.

## Semantic colors
Use roles: success, info, warning, danger, premium/accent, neutral. Components consume semantic roles, not arbitrary hex values.

## Shared primitives
Prefer shared:
`PageHeader`, `SectionHeader`, `Card`, `KpiCard`, `StatusBadge`, `Button`, `IconButton`, `Input`, `Select`, `SearchInput`, `FilterBar`, `DataTable`, `Pagination`, `EmptyState`, `ErrorState`, `Skeleton`, `Drawer`, `Modal`, `Tabs`, `Tooltip`, `DropdownMenu`, `Timeline`.

## Variants
Use intentional variants such as primary, secondary, ghost and destructive rather than creating a new button component per page.

## Tables
Use shared row height, header style, hover/selected states, action column, pagination, skeleton and empty state.

## Status registry
Maintain one central mapping of domain state -> label + semantic tone.

## Refactoring rule
When 20 pages share a visual flaw, fix the primitive first, not 20 pages independently.

Before finishing, inspect adjacent pages and confirm the new work has not introduced a new visual dialect.
