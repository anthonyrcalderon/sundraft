# SunDraft — Project Overview

**Status:** Scoping complete. No code written yet.
**Last updated:** August 12, 2026

---

## What is SunDraft?

A residential solar design tool: pull up a real map, trace a roof outline, and lay out solar modules on it — the same core workflow used by production tools at companies like Vivint Solar and Sunrun, built as a personal full-stack portfolio piece.

## Purpose

This is a portfolio project meant to demonstrate full-stack skill to potential employers, with a frontend-focused full-stack role in mind. It is explicitly **not** an attempt to fill an unmet gap in the solar software market — that market (design tools like Aurora/OpenSolar/HelioScope, and land marketplaces like LandApp/LandGate) is already well-served by established, well-funded players. The goal here is a well-built, complete demonstration of skill, not a commercial land-grab.

*(Earlier direction: the project started as a solar land marketplace, working name "SunPlot." After market research showed that space is already covered by LandApp/LandGate, Landmodo, and others, the project pivoted back to a design tool — closer to the author's actual professional background.)*

---

## MVP (near-term build target)

The smallest version that proves the core interaction loop:

- Map with address search — type an address, see a real map centered on it
- Roof outline tool — trace a polygon boundary around a roof, stored as GeoJSON
- Module placement tool — add, move, and rotate rectangles (solar panels) within the traced outline
- Persistence — designs are saved and tied to an anonymous browser session (no login/email required)
- 2-3 pre-built example designs, viewable and editable by any visitor, where each visitor gets their own private copy on edit — the shared original is never modified
- Admin mode for creating/editing the example templates directly

**Explicitly out of scope for MVP:** shading data, production (kWh) estimates, sharing links, email-based accounts, commercial/utility-scale mode.

## End Goal (long-term vision)

- Shading-aware production estimates via the Google Solar API (US-only coverage is sufficient — no international fallback needed)
- "Share my design" links
- Optional email-based project claiming, layered on top of the existing anonymous-session model
- A separate commercial/utility-scale design mode alongside the residential one

---

## High-Level Work Outline & Milestones

1. **Foundation** — AWS account setup, Amplify project scaffolding, CDK stack for Lambda/DynamoDB/API Gateway, DynamoDB table design, local Express+JSON mock for early frontend dev.
   *Milestone: app runs fully locally against the mock backend; a placeholder deploy is reachable on Amplify.*

2. **Map + address search** — MapLibre GL JS + Esri World Imagery + Nominatim, geocode a typed address, center/zoom the map.
   *Milestone: type an address, see a real map centered on it.*

3. **Roof outline tool** — drawing UI layered on the map, stored as GeoJSON.
   *Milestone: trace a rough outline around any visible roof and see it rendered as a clean polygon.*

4. **Module placement tool** — add/move/rotate panel rectangles constrained to the outline, basic overlap handling.
   *Milestone: a traced roof can be filled with a layout that looks like a real design.*

5. **Persistence layer** — anonymous session handling; project CRUD through API Gateway → Lambda → DynamoDB.
   *Milestone: close the tab, come back, the design is still there.*

6. **Templates + admin mode** — 2-3 seeded example designs, fork-on-open logic for regular users, admin CRUD for the templates.
   *Milestone: any visitor can freely edit an example without affecting what the next visitor sees.*

7. **Deploy + polish** — production Amplify deployment, custom domain, AWS budget alert, UI cleanup.
   *Milestone: portfolio-ready link.*

*(Follow-on, post-MVP: Google Solar API shading/production estimate, share-a-design links, email-based project claiming, commercial/utility-scale mode.)*

Scope is expected to shift somewhat as work progresses — this is a working outline, not a fixed contract.

---

## Hosting Costs & Platforms

Stack decided: **Amplify** (frontend hosting, already familiar) + **Lambda / DynamoDB / API Gateway** (backend, via CDK) + **MapLibre GL JS / Esri World Imagery / Nominatim** (map tiles + geocoding — switched from an original Mapbox plan after discovering Mapbox now requires a credit card on file even for its free tier) + **Google Solar API** (follow-on shading/production feature, US-only).

Realistic cost for a low-traffic demo:

| Piece | Service | Cost |
|---|---|---|
| Frontend hosting | Amplify | $0 during account's Free-plan window (new AWS accounts get 6 months + signup credits, not the old 12-month model); ~$0-5/month after, at demo traffic |
| Backend compute | Lambda | $0 — permanent "Always Free" tier: 1M requests + 400,000 GB-seconds/month, never expires |
| Database | DynamoDB | $0 — permanent "Always Free" tier: 25GB storage / 200M requests/month, never expires |
| API layer | API Gateway | $0 during Free-plan window; pay-per-use after (fractions of a cent per call — use HTTP APIs, not REST, for ~71% lower cost) |
| Map tiles + geocoding | MapLibre GL JS + Esri World Imagery + Nominatim | $0, no account/card required for any of the three — see note below |
| Shading/production (follow-on) | Google Solar API | $0 — 10,000 Building Insights calls/month free |
| Domain name | Registrar (e.g. Cloudflare, Route 53, Namecheap) | ~$10-15/year |

**Important AWS account note:** new accounts (created 2026 or later) are on AWS's newer **Free plan** model — 6 months of free usage/credits, after which the account auto-closes rather than silently billing. This is safer than the old model (no risk of a surprise bill from forgetting to cancel), but it does mean a decision is needed around month 6 on whether to upgrade to a paid plan to keep the demo live long-term. Watch for two classic traps regardless of plan: don't provision a NAT Gateway (~$32/month just for being on) and set a $1 AWS budget alert on day one.

**Map stack note:** originally planned around Mapbox, but Mapbox now requires a credit card on file to activate its free tier at all — switched to a zero-signup stack instead: MapLibre GL JS (open-source, API-compatible fork of Mapbox's old open-source SDK) for rendering, Esri's public World Imagery tiles for satellite/aerial view, and OpenStreetMap's Nominatim for address search. Esri's tiles have no formal published limit (unlike Mapbox's numeric free tier) but also no guaranteed SLA — an acceptable trade for a low-traffic demo with zero billing risk. Nominatim has a soft ~1 request/second usage policy, comfortably covered by the debounced search box.

Domain names are cheap and low-risk to change later — the name isn't tied to code or data, so renaming later just means buying a new domain and repointing DNS.

---

## Tech Stack (as decided)

- **Frontend:** React + Redux, TypeScript
- **Backend:** AWS (Lambda, DynamoDB, CDK for infra-as-code), hosted via Amplify
- **Local dev:** Express + JSON mock server, to build against before deploying real AWS infra
- **Maps:** MapLibre GL JS + Esri World Imagery (satellite tiles) + Nominatim (geocoding) — all free, no API key or card required
- **Follow-on:** Google Solar API (shading + production estimates, US-only)

## Open Questions / Not Yet Decided

- Whether the "share my design" feature makes the MVP-adjacent cut or stays a pure follow-on
- Exact roof-outline input UX details beyond "trace a polygon" (snapping, editing existing points, etc.)
- Domain name itself (mechanics are settled — see Hosting Costs above — but the actual name hasn't been picked)
