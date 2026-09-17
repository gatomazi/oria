---
name: reference-ui-implementation
description: Use when a screenshot, mockup, Figma export, or visual target is provided and the user asks to implement or restyle frontend to match it. Converts references into measurable layout, typography, color, spacing, and component decisions, then verifies implementation against the reference.
---

# Reference UI Implementation

Treat the supplied visual reference as a design specification, not loose inspiration.

## 1. Inspect before coding
Extract approximate:
- shell dimensions;
- sidebar width;
- header height;
- content max width;
- grid structure;
- surface hierarchy;
- spacing rhythm;
- radii;
- border/shadow treatment;
- primary/secondary colors;
- typography hierarchy;
- button hierarchy;
- control heights;
- table density;
- icon style;
- chart style;
- drawer/modal proportions.

Write these as design tokens before coding.

## 2. Separate system from page content
Identify shared components such as AppShell, Sidebar, Topbar, Card, DataTable, StatusBadge, Button, Input, FilterBar, Drawer and KPI.
Do not rebuild the same visual pattern independently per page.

## 3. Match composition first
Priority:
1. composition;
2. proportions;
3. spacing;
4. typography hierarchy;
5. surface/background relationships;
6. color;
7. borders/shadows;
8. iconography;
9. micro-details.

Do not obsess over tiny icon differences while the grid is wrong.

## 4. Preserve usability
If a generated reference conflicts with readability, accessibility, real data constraints or responsive behavior, preserve its visual intent while implementing the better functional behavior.

## 5. Use real domain content
Do not use lorem ipsum if the application has real labels, statuses, actions and data structures.

## 6. Screenshot review loop
After implementation:
1. run the app;
2. capture at the target viewport;
3. compare to the reference;
4. list the five largest visual mismatches;
5. fix them;
6. repeat.

Do not stop after the first pass.

## Comparison checklist
Check shell width, sidebar proportions, section positions, alignment, card heights, row heights, control spacing, text contrast, chart proportions, icon size, border intensity, button prominence and whitespace balance.

If multiple reference screenshots exist, infer one shared design system from all of them before implementing individual pages.
