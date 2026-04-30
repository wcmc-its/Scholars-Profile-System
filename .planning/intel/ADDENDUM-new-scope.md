# New-Scope Addendum

These items are NEW scope, not present in the ingested source docs. Captured here so they propagate into PROJECT.md / REQUIREMENTS.md / ROADMAP.md alongside the ingested intel.

_Last updated: 2026-04-30_

---

## Locked decisions (additions to intel/decisions.md)

### ADR-009: Headshot integration — mirror ReCiter-Publication-Manager

**Status:** LOCKED 2026-04-30 by user.

**Decision:** Integrate ED's headshot API using the exact pattern from sibling project ReCiter-Publication-Manager.

- Endpoint syntax: `https://directory.weill.cornell.edu/api/v1/person/profile/{cwid}.png?returnGenericOn404=false`
- Server-side, the scholar API response includes an `identityImageEndpoint` string field — built by substituting the scholar's CWID into the syntax template.
- The 404 case is handled server-side: if WCM directory returns 404 for the CWID, the API returns `identityImageEndpoint: ""` (empty string).
- The browser sets `<img src>` to `identityImageEndpoint` when non-empty; otherwise renders a local generic-headshot placeholder asset.
- No server-side proxying, no ETL pre-fetching, no caching layer in Phase 1. Browser hits `directory.weill.cornell.edu` directly. Matches PubMan exactly.

**Surfaces requiring headshots (per design spec v1.7.1):**
- Profile page header (large, primary)
- Search result rows (people tab)
- Home page Recent contributions cards (6 cards in 3×2 grid)
- Topic page Top scholars chip row (7 faculty chips)
- Topic page Recent highlights (publication cards with author chips)
- Department page Faculty grid (TBD count)

**Reference implementation:** `~/Dropbox/GitHub/ReCiter-Publication-Manager/config/report.js` line 113 (syntax template) and `src/components/elements/Search/Search.js` lines 547–552 (render pattern).

**Future enhancement (deferred):** Optional `/api/headshot/:cwid` proxy with cache headers if browser-direct hits to WCM directory become a perf or availability issue post-launch.

---

## New requirements (additions to intel/requirements.md)

### REQ-headshot-integration

- **source:** New scope, locked 2026-04-30 by user. Reference implementation in ReCiter-Publication-Manager.
- **scope:** Scholar headshot display across all surfaces.
- **description:** All scholar API responses include `identityImageEndpoint` populated from the WCM directory syntax template. Renderers across profile, search, home, topic, and department pages use this field as the `<img src>`, falling back to a local generic-headshot.png asset when the field is empty.
- **acceptance:**
  - Server-side: scholar API responses include `identityImageEndpoint: string` for every scholar.
  - Server-side: if `cwid` resolution returns 404 from WCM directory, the field is set to empty string.
  - Client-side: rendering checks `identityImageEndpoint.length > 0` before using; otherwise loads `/static/generic-headshot.png` (or equivalent project asset).
  - All six surfaces listed in ADR-009 render headshots using this pattern.
  - No server-side proxy, no ETL pre-fetch, no extra caching layer in Phase 1.
- **status:** NEW — not yet shipped.
- **dependencies:** none (only depends on CWID resolution which already works per HANDOFF).

### REQ-page-types-design-spec-additions

- **source:** Design spec v1.7.1 §2 (Topic detail), §"Department" (Department detail), §"Browse" (Browse hub), §"About" (About page) — auto-resolved from intel as in-scope (per orchestrator instruction; INFO entry in INGEST-CONFLICTS).
- **scope:** Four new top-level page types not enumerated in the functional spec.
- **description:** Build out the four page types added by design spec v1.7.1 that are NOT present in the functional spec or HANDOFF current-state.
- **page list:**
  - **Topic detail** (`/topics/{slug}`): Hero with topic name + description. "Top scholars in this area" chip row (7 faculty chips, eligibility carve applies). "View all N scholars in this area →" affordance to a directory listing scoped to the topic. Recent highlights (3 papers, no citations). Layout B (rail + main): subtopic rail sorted by pub count desc with "Less common" divider for n≤10. Single feed header in main with publication feed.
  - **Department detail** (`/departments/{slug}`): Department description, faculty grid (eligibility carve applies — Full-time + Postdoc + Fellow + Doctoral), department-scoped search affordance. Detail layout per design spec sketch 006.
  - **Browse hub** (`/browse`): Top-level browse navigation entry point. 67 parent topics + departments + counts, multi-column grid per design spec sketch 005.
  - **About page** (`/about`): Methodology page that algorithmic surfaces link to ("must exist before launch" per design spec). Explains ranking formulas, data sources, refresh cadence, role model categories. Sketch 008.
- **acceptance:** All four pages routable, render with real data, link from home page browse grid (Browse hub) and topic/department surfaces (detail pages). Methodology page linked from every algorithmic surface that uses ranking weights.
- **status:** NEW — not yet shipped.

---

## Scope of next milestone (per user 2026-04-30)

The next milestone covers:

1. **REQ-headshot-integration** — port from PubMan, all six surfaces.
2. **REQ-page-types-design-spec-additions** — Topic detail, Department detail, Browse hub, About.
3. **BUILD-PLAN Phase 5 — SEO + URL machinery.** sitemap.xml, robots.txt, full VIVO 301 mapping (URL middleware does slug→cwid→alias resolution but sitemap and bulk VIVO 301 audit aren't wired).
4. **BUILD-PLAN Phase 6 — Polish, analytics, docs.** Page-view tracking, search-query logging, OpenAPI artifact, the deferred Q6 ADR (DAL = ETL transform). Functional spec analytics signals (lines 277–283).
5. **BUILD-PLAN Phase 7 — Self-edit + auth.** SAML wiring, `/api/edit` route, WYSIWYG, "What's missing" checklist for authenticated owners, edit-event logging.

Plus the new algorithmic surfaces locked under REQ-publications-ranking that aren't shipped yet (home page Recent contributions section, topic page Recent highlights, Top scholars chip row).

---

## Workflow config

- **Mode:** interactive
- **Granularity:** standard (5–8 phases)
- **Parallelization:** on
- **Branching strategy:** none (single branch)
- **AI model profile:** balanced (Sonnet)
- **Workflow agents:** research, plan-check, verifier, nyquist-validation, ui-phase, ui-safety-gate — all enabled
- **Worktrees:** enabled
