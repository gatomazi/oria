# Product

<!-- impeccable:product-schema 1 -->

> Scope: the **admin panel** (`admin/`, served at `/admin/*`) only. The public city-search site (`index.html`), the personalized store (`loja.html`) and the PIX hotpage (`pedido.html`) are separate surfaces and are not covered by this record.

## Platform

web

## Users

**Today:** one operator — the owner of Use Sul, Use Centro and Use Norte, three Reserva Ink print-on-demand stores. Knows every flow, runs the whole operation alone (orders, recovery, catalog, WhatsApp, campaigns, finances) from this panel.

**Target (SaaS, decided and in preparation):** small or solo Reserva Ink merchants, in the same situation the owner is in today. They did not build the system, so connecting integrations and reaching a first useful state must work without the builder's knowledge.

**Licensing model (confirmed 2026-09-13):** 1 license = 1 store. A merchant with 2 stores holds 2 subscriptions. There is no multi-user access: each license has a single operator, no team members or roles.

Product type: App UI / SaaS operational dashboard. The job is completing operational tasks, not browsing.

## Product Purpose

An operations hub for Reserva Ink stores. It exposes everything the Reserva Ink API allows, adds what Ink itself does not offer (recovery, WhatsApp automation, segmented campaigns, PIX hotpages, bulk catalog operations, a visual dashboard), for one store per license.

Success: the merchant runs the store's daily operation from this panel, recovers revenue that would otherwise be lost (abandoned carts, pending PIX), and never needs the Ink back-office for routine work.

## Positioning

Built specifically and exclusively for Reserva Ink. The mechanism a generic e-commerce tool cannot truthfully copy:

- Direct Reserva Ink API connection plus webhook listening for order status, driving automations in real time.
- WhatsApp integration by either the official Meta API or WhatsApp Web (the lower-cost option), per the merchant's choice.
- Full coverage of the Ink API surface: financial (balance, movements, advances, withdrawals), exchanges/returns, refunds, promotions, categories, products.
- Recovery of abandoned carts and pending PIX, including a PIX creation screen with QR code and copy-and-paste.
- Dynamic segmented campaigns with batch-controlled sending and no duplicate delivery.
- Visual dashboard of store data.

## Operating Context

- Brazilian market: pt-BR interface, BRL, PIX as a primary payment method, WhatsApp as the main customer channel.
- Store sales come through the Reserva Ink storefronts; traffic for those stores is largely Meta Ads / Instagram.
- Ink owns some decisions (e.g. exchange approval); the panel creates and tracks, it does not override Ink.
- Store scope: the SaaS unit is one store per license. The current internal deployment still runs three stores with a store selector (`all` or single) behind `multiStoreMode`; that is the owner's setup, not the SaaS model.
- Campaign sending is operator-paced: a batch is released, delivery is evaluated, the next batch is released.
- Background jobs (sync, follow-ups, campaign queue, feed sync) run continuously; integration health and webhook deliveries are visible in the panel.

## Capabilities and Constraints

**Shipped:** dashboard (KPIs, charts, order pipeline); unified orders with detail drawer; exchanges/returns; cart and PIX recovery; stock (dedicated control vs. inferred from orders, deliberately separate); customers; products, categories (incl. bulk association jobs), groupings, promotions; WhatsApp overview, Meta templates, event automations, WhatsApp Web sending mode with message variations; segments and campaigns; financial and refunds; freight simulation; PIX hotpages (create, link to Ink order); custom fields; webhook log; integrations health; settings; plan entitlements; conditional internal tools.

**Not yet built (must not be presented as working):** global header search (disabled), WhatsApp history, campaign reports, revenue attribution to campaigns (shows "Indisponível"), Instagram automation (placeholder), GA4 integration (planned), header notifications and help (decorative).

**Constraints:**
- Reserva Ink is a mandatory integration; WhatsApp is expected to be optional per plan.
- Stack is established: React 18 + TypeScript + Vite SPA with Radix and Recharts, backed by a single Express `server.js`; Postgres for state that must survive deploys.
- Single-password auth today; multi-tenant (per-store licenses, per-store integrations, secrets, onboarding, billing) is being designed in `docs/levantamento-productizacao-saas-painel.md`. No multi-user or roles by product decision; the account menu shows the store and "Sair", not a person.
- Dashboard is known to need improvement.

**Open decisions:** SaaS product name (currently a configurable "product name" setting); plans and pricing; onboarding shape (wizard vs. free configuration); whether an owner holding several licenses gets any cross-store view or switches between separate store accounts.

## Brand Commitments

- The SaaS brand is not yet named; Use Sul / Use Centro / Use Norte are the owner's stores, not the product brand, and must become tenant data rather than product identity.
- An incumbent visual system exists and is established (`src/components/ds/`); `DESIGN.md` is the visual source of truth for the panel.
- The tenant's brand (store name, wordmark, logo) appears as context inside the product; it does not define the SaaS identity.

## Evidence on Hand

- Real operational data from three live stores (orders, carts, campaigns, financial) — usable for realistic demos only with customer PII removed.
- Current-state documentation: `docs/painel-estado-atual.md`; productization audit: `docs/levantamento-productizacao-saas-painel.md`.
- No external customers, testimonials, case studies, pricing or usage metrics exist yet. Do not fabricate them.

## Product Principles

1. **Ink-native, not generic.** Use Reserva Ink's real vocabulary, statuses and limits; never imply capabilities the Ink API does not provide.
2. **Recovered revenue is the headline.** Recovery, PIX and campaign flows are where the product earns its keep; they get priority in attention and polish.
3. **Operator control over automation.** Anything that messages customers at scale stays reviewable, pausable and free of duplicate sends.
4. **Honest states.** Unavailable data and unbuilt features are labeled as such, never faked or silently empty.
5. **Built for a solo merchant who did not build it.** Density and speed for daily use, with integration setup and failures explained in plain language.

## Accessibility & Inclusion

- Target WCAG 2.2 AA across operational flows (contrast, keyboard operation with visible focus, programmatic form labels), confirmed as a priority in the 2026-09-13 UI refinement brief.
- Interface language is pt-BR for Brazilian merchants; technical infrastructure terms (environment variables, database, cache) are not user-facing copy.
