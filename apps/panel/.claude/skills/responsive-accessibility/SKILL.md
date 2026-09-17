---
name: responsive-accessibility
description: Use when implementing or reviewing responsive frontend layouts, dashboards, tables, drawers, forms, modals, or navigation. Ensures layouts remain usable across viewport sizes and meet practical accessibility standards without sacrificing visual quality.
---

# Responsive & Accessibility Frontend

Design responsive behavior intentionally rather than letting elements wrap randomly.

## Useful viewport classes
Respect project breakpoints. Otherwise reason around:
- >=1440 large desktop;
- 1280–1439 desktop;
- 1024–1279 compact desktop/tablet landscape;
- 768–1023 tablet;
- <768 mobile.

## Sidebar
- full on large desktop;
- collapsible on compact desktop;
- off-canvas on mobile.

## Tables
At smaller widths:
1. preserve critical columns;
2. move secondary data into row detail;
3. use drawers/details;
4. use horizontal scrolling only when truly necessary.
Never shrink text until everything barely fits.

## KPI grids
Prefer 4 columns large, 2 columns compact, 1 column mobile while preserving scan order.

## Drawers
Side drawer on desktop; full/near-full-screen sheet on mobile.

## Forms
Stack fields below their useful minimum width. Avoid forced multi-column forms.

## Accessibility
Ensure:
- keyboard navigation;
- visible focus;
- semantic buttons/links;
- meaningful labels;
- associated errors;
- adequate contrast;
- status not communicated by color alone;
- accessible names for icon buttons;
- focus trapping and keyboard close for dialogs;
- reduced-motion support.

## Validation
Test intermediate widths, long names, large currency values, long statuses, empty/error/loading states, drawer overflow and dense table data.
