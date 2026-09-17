---
name: dashboard-ui-director
description: Use when designing or refactoring SaaS dashboards, admin panels, operational tools, tables, data-heavy pages, navigation shells, cards, KPIs, filters, drawers, and dark-mode application layouts. Focuses on premium visual hierarchy, information density, usability, and avoiding generic AI dashboard aesthetics.
---

# Dashboard UI Director

Act as a senior product designer and frontend design lead for a production SaaS application.

Your job is not merely to make the interface "clean". Create a coherent, premium, highly usable operational product with a clear visual point of view.

## Before coding
Identify:
1. the primary job of the page;
2. highest-priority information;
3. most common user action;
4. dangerous/consequential actions;
5. what needs immediate visibility vs progressive disclosure;
6. whether the content is best expressed as table, dashboard, form, split view, drawer, wizard or timeline.

Do not default to a grid of identical cards.

## Preferred aesthetic for this project
Premium dark operational SaaS:
- deep charcoal / blue-black app background;
- layered dark surfaces instead of one flat black;
- restrained borders and shadows;
- high-contrast text;
- selective saturated accents.

Semantic accents:
- green = healthy/success/primary operational action;
- cyan/blue = information/transit;
- amber = pending/recovery/attention;
- red = errors/critical;
- violet = premium/advanced/tertiary.

Do not distribute all colors evenly. Color must encode meaning.

Avoid:
- bright white app backgrounds;
- beige SaaS aesthetic;
- huge empty cards;
- identical radius everywhere;
- gradients without purpose;
- neon/glow everywhere;
- excessive glassmorphism;
- card-within-card-within-card;
- decorative charts that do not answer a question.

## Density
Operational software should be information-dense without feeling cramped.
Prefer:
- compact KPI cards;
- 48–60px table rows;
- 36–42px controls;
- 12–16px internal spacing in dense controls;
- 20–24px card padding;
- 24–32px between major sections.

Large empty zones are a design failure unless deliberate.

## Page hierarchy
Typical structure:

```text
Page title + one-line purpose + primary action
Optional KPI strip
Search + filters + secondary actions
Main operational content
Contextual drawer/detail panel
Pagination or summary
```

## Tables
Use tables for operational lists. Provide:
- clear column priority;
- sticky header where useful;
- human-readable statuses;
- hover state;
- row selection only if batch actions exist;
- contextual action menu;
- row click when a detail drawer exists;
- pagination;
- loading, empty and error states.

## Cards
Use cards only when grouping creates structure. Vary hierarchy between KPI, information, alert, detail and tool panels. Do not style every panel identically.

## Drawers
Use drawers for order/customer/payment/cart/event/template detail and quick configuration. Desktop width roughly 520–680px depending on content.

## Forms
- group related fields;
- use short labels;
- avoid giant inputs;
- separate destructive actions visually;
- show validation near the field;
- use a wizard only when the workflow is genuinely multi-step.

## Navigation
Group by user job, not backend architecture. For this product:
- Overview
- Operation
- Catalog
- WhatsApp
- Instagram
- Finance
- Tools
- System

Technical payloads/webhooks belong under System.

## Typography
Use type as hierarchy, not decoration:
- page title: 24–30px;
- section: 17–20px;
- card title: 14–16px;
- body/table: 13–14px;
- metadata: 11–12px.
Avoid excessive uppercase.

## Status system
Create one centralized semantic status mapping. Do not hardcode status colors inside pages.

## Interactions
Every interactive element needs default, hover, focus, active, disabled and loading states where applicable.

## Workflow
Before implementation, write a short UI plan with hierarchy, page skeleton, component reuse and responsive behavior.
After implementation, review hierarchy, density, alignment, spacing, contrast, readability, action priority and consistency.
If it still looks like a generic admin template, iterate before finishing.
