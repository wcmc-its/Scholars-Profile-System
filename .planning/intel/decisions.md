# Decisions (intel)

Synthesized from ADR sources during ingest. Each decision retains its source attribution. "Locked" status is the contract for downstream synthesis (`gsd-roadmapper` should not auto-override locked items without an explicit user-driven follow-up).

Per orchestrator instruction: ADR #1 is treated as **PROVISIONAL** (preliminary for the local prototype only; production architecture deferred to Mohammad's design kickoff). ADRs #2–#8 are **LOCKED** for the prototype path and are confirmed as implemented by HANDOFF.

---

## ADR-001 — API architecture (PROVISIONAL)

- **status:** provisional (prototype-only); production deferred to Mohammad's design kickoff
- **source:** `.planning/source-docs/phase-1-design-decisions.md` §1
- **confirmed-by:** `.planning/source-docs/HANDOFF-2026-04-30.md` (current state — single Next.js deploy implemented)
- **decision:** Phase 1 ships as a single Next.js application on Fargate. The "Scholar API" is exposed via Next.js `/api/*` route handlers within the same deploy. Internal Next.js pages call these handlers as direct function invocations during SSR/ISR. External consumers hit the same routes over HTTPS at `scholars.weill.cornell.edu/api/scholars/:cwid`. A separate OpenAPI specification artifact (`openapi.yaml`) documents the API contract independently from the Next.js source.
- **scope:** API tier topology, Next.js route handler placement, OpenAPI artifact ownership
- **rationale:** Charter promises a "reusable Scholar API" but only one near-term consumer exists (the Scholars site itself). Single-deploy Next.js with `/api/*` satisfies the contract without standing up a second service; migration path to a standalone Node service is a copy-paste of route handlers (already disciplined as pure functions in `lib/api/*` with route files as thin delegators).
- **provisional clause:** Mohammad expressed preliminary preference for a separate Scholar API service in production ("I expect it would be a separate service so it can be consumed", hedged with "could change when we officially kick off the design"). Production architecture deferred to Mohammad's official design kickoff. The OpenAPI contract is the durable artifact regardless of implementation choice.
- **implementation discipline (binding even though provisional):** API route handlers MUST be pure functions in `lib/api/*` with route files as thin delegators, so lifting handlers into a standalone Node service stays a copy-paste, not a rewrite.

---

## ADR-002 — Canonical scholar identity: CWID-canonical with aliases (LOCKED)

- **status:** locked (prototype path)
- **source:** `.planning/source-docs/phase-1-design-decisions.md` §2
- **confirmed-by:** `.planning/source-docs/HANDOFF-2026-04-30.md` ("CWID-canonical identity with `cwid_aliases` table for replacement-CWID handling")
- **decision:** Scholars MySQL read store uses **CWID as the primary key** for the `scholar` table. Foreign keys throughout the schema reference `scholar.cwid` directly. A `cwid_aliases (old_cwid PRIMARY KEY, current_cwid FOREIGN KEY)` table handles edge cases. Aliases are auto-populated from Enterprise Directory's `replacement_cwid` field by the daily ED ETL. Manual aliases are inserted by the admin role, audit-logged. Records lacking a CWID do not enter Scholars.
- **scope:** primary-key strategy, FK strategy, alias table semantics, identity ingestion gate
- **refinements:**
  - **Alias-as-redirect, not alias-as-join-resolver.** Daily ETL performs FK rewrite; aliases table is for URL redirect / historical lookup only.
  - ReCiter is the source of truth for CWID↔pmid joins.
  - `publication_authors.cwid` is nullable for non-WCM coauthors.
  - Provisioning lag tolerated: ED presence required at ETL time; ReCiter coverage may lag.
- **URL behavior:** `GET /api/scholars/:old_cwid` → 301 → `/api/scholars/:new_cwid`; HTML routes resolve through `cwid_aliases` and `slug_history` (see ADR-003).

---

## ADR-003 — URL strategy: slug-primary HTML, CWID-keyed API (LOCKED)

- **status:** locked (prototype path)
- **source:** `.planning/source-docs/phase-1-design-decisions.md` §3
- **confirmed-by:** `.planning/source-docs/HANDOFF-2026-04-30.md` ("Slug-primary URLs with collision suffixing and slug-history 301 redirects")
- **decision:** HTML URLs are slug-primary (`/scholars/:slug`). A `slug_history (old_slug PRIMARY KEY, current_cwid FOREIGN KEY)` table handles name changes. API URLs are CWID-keyed (`/api/scholars/:cwid`). CWID-anchored HTML fallback `/scholars/by-cwid/:cwid` → 301 → current canonical slug URL. `sitemap.xml` lists only canonical slug URLs.
- **scope:** HTML URL space, API URL space, sitemap content, redirect middleware
- **slug derivation:** Source = `preferred_name` from ED (TBD-confirm with ED owners). NFKD normalize, strip combining marks, ASCII-fold, lowercase, hyphenate whitespace, drop punctuation. Examples: `María José García-López` → `maria-jose-garcia-lopez`; `李明` → `li-ming` (using ED's romanization); `O'Brien-Smith, Jane Q.` → `jane-obrien-smith`.
- **collision handling:** Numeric suffix in CWID-creation order. Established profiles never get renamed by a new collision.
- **name-change handling:** ED name change → slug auto-regenerates → old slug writes to `slug_history` → 301 thereafter. No faculty opt-in.
- **URL middleware resolution order:** `scholar.slug` → `slug_history` → `/scholars/by-cwid/:cwid` → 404.
- **VIVO 301 chain:** `vivo_url → cwid → resolve aliases → resolve to current slug → 301`. Three-step chain.

---

## ADR-004 — Departed faculty: strict delete with retention window (LOCKED)

- **status:** locked (prototype path)
- **source:** `.planning/source-docs/phase-1-design-decisions.md` §4
- **confirmed-by:** `.planning/source-docs/HANDOFF-2026-04-30.md` ("Soft-delete of departed scholars with 60-day retention window")
- **decision:** Phase 1 inclusion criterion is active academic appointment in ED. On loss of active appointment: next daily ETL flips `scholar.deleted_at = now()`; URL returns 410 Gone, profile removed from sitemap, document removed from OpenSearch, ISR cache invalidated. **No user-visible grace period.** **60-day data retention.** Admin can restore within window. Daily ETL detecting reactivation also clears `deleted_at` automatically. After 60 days: cleanup job hard-deletes.
- **scope:** profile lifecycle, soft-delete semantics, retention policy, admin override, departed-VIVO 301 target
- **admin override:** the admin role gains a **suppress** action (sets `deleted_at` regardless of appointment status; same 60-day window).
- **No tombstone UX. No memorial banner. No "Active at WCM" search filter** (everyone in the index is active by definition).
- **SEO mitigation:** VIVO domain kept alive as redirect-only host. For active scholars: 301 → current canonical Scholars slug URL. **For deleted scholars: 301 to `/search?q=<name-extracted-from-vivo-url-slug>`.**
- **schema implications:**
  - `scholar.deleted_at TIMESTAMP NULL` (indexed for cleanup)
  - All public read paths filter `WHERE deleted_at IS NULL`
  - Cleanup job: nightly, hard-delete `WHERE deleted_at < now() - INTERVAL 60 DAY`
- **doctoral students:** Phase 2+ extension — active doctoral program enrollment will also qualify.

---

## ADR-005 — Daily refresh failure modes (LOCKED)

- **status:** locked (prototype path)
- **source:** `.planning/source-docs/phase-1-design-decisions.md` §5
- **confirmed-by:** `.planning/source-docs/HANDOFF-2026-04-30.md` ("Daily ETL chain with ED-first abort cascade, per-source independence, and `/api/health/refresh-status` admin endpoint")
- **decision:** Each upstream source (ED, ASMS, InfoEd, ReCiter + DynamoDB minimal projection, COI) runs its own daily ETL job and commits independently. **No user-visible staleness signals on the public site.** Internal observability via dedicated endpoints and CloudWatch alarms.
- **scope:** ETL atomicity, chain order, abort cascade, monitoring
- **per-source atomicity:** stage to a shadow table → validate row counts and required-field nulls → atomic-swap to live tables.
- **chain order with ED-first abort-cascade:** **ED → ASMS → InfoEd → ReCiter (+ DynamoDB minimal-projection) → COI**. ED failure aborts the rest of the chain for that day. Other sources fail independently of one another.
- **interaction with ADR-004:** the "all appointments terminated" check that triggers `deleted_at` runs only against successful ED refreshes.
- **monitoring:**
  - `last_successful_refresh_at` timestamp tracked per source
  - `/api/health/refresh-status` endpoint (admin SAML auth, not public)
  - CloudWatch alarm: `last_successful_refresh_at < now() - 26h` per source
  - Alarm pages Mohammad's team on red. Yellow conditions do not page.
  - 3+ consecutive failures → escalation procedure (TBD with operations)

---

## ADR-006 — DynamoDB integration: minimal-projection ETL (LOCKED)

- **status:** locked (prototype path)
- **source:** `.planning/source-docs/phase-1-design-decisions.md` §6
- **confirmed-by:** `.planning/source-docs/HANDOFF-2026-04-30.md` ("Minimal-projection ETL (publication_score + topic_assignments only); ReciterDB for publication metadata")
- **decision:** ReCiterAI's DynamoDB output is consumed via a **minimal-projection ETL** into the Scholars MySQL read store. **The Scholars application reads only MySQL at runtime — there is no runtime DynamoDB read path.** The data-access-layer pattern called for in spec language applies at the **ETL transform**, not at the runtime read.
- **scope:** runtime read store, DynamoDB consumption, ETL ownership boundary
- **explicit departure from spec:** ADR text states this is "a real departure from the spec's verbatim language and is documented in a separate ADR" (the open-item ADR-001 / Q6 ADR called out in the decisions doc and BUILD-PLAN Phase 6 deferred work).
- **minimal fields list (Phase 1 only):** Exactly two fields flow from DynamoDB → MySQL — `publication_score` (per scholar+pmid pair) and `topic_assignments` (per scholar; MeSH terms or topic clusters with weights). Other ReCiterAI outputs are explicitly out of scope for the v1 ETL.
- **trigger and ownership:** A separate Lambda function reads from DynamoDB (via stream or scheduled scan), transforms, and writes to MySQL. Triggered by ReCiterAI's weekly run completion via EventBridge. Failure isolation: if the projection breaks, ReCiterAI's own weekly run is unaffected.
- **staleness window:** ReCiterAI scores update once weekly when ReCiterAI runs. Daily Scholars build sees consistent scores all week.

---

## ADR-007 — Search engine: OpenSearch (LOCKED)

- **status:** locked (prototype path)
- **source:** `.planning/source-docs/phase-1-design-decisions.md` §7
- **confirmed-by:** `.planning/source-docs/HANDOFF-2026-04-30.md` ("OpenSearch 2.x (Docker) … OpenSearch Service (managed)")
- **decision:** **OpenSearch (AWS-managed)** is the search engine for Phase 1. Dense embeddings deferred to Phase 2.
- **scope:** search engine selection, query-side feature set, embeddings posture
- **rationale (rejected alternatives):** Algolia rejected (data-residency review at AMC); pgvector rejected (`tsvector setweight()` only 4 levels, spec needs 7); Typesense / Meilisearch rejected (institutional bet too small, no AWS-managed offering); Elasticsearch rejected (SSPL license complexity).
- **Phase 1 ships as:** BM25 + per-field boost + authorship weighting + faculty-status boost (all `function_score`-driven). OpenSearch's k-NN plugin sits dormant until Phase 2.
- **indexing pipeline:** A Lambda (or Fargate task) reads from MySQL after the daily ETL completes and writes to OpenSearch. Daily reindex covers the bulk; on-demand reindex on self-edit triggered by the same webhook that fires page revalidation (one trigger, two consumers).
- **credentials posture:** OpenSearch credentials never leave the server. Browser-facing search proxies through `/api/search`.

---

## ADR-008 — Render strategy: Next.js ISR with on-demand revalidation (LOCKED)

- **status:** locked (prototype path)
- **source:** `.planning/source-docs/phase-1-design-decisions.md` §8
- **confirmed-by:** `.planning/source-docs/HANDOFF-2026-04-30.md` (implicitly — site renders profiles, search is CSR via `/api/search`)
- **decision:** **Profile pages: Incremental Static Regeneration (ISR) with on-demand revalidation.** Profiles render statically on first visit, are cached by Next.js, and are revalidated either on a TTL or on-demand when a self-edit fires a revalidation webhook. **Search and directory pages: Client-side rendering (CSR)** through the `/api/search` proxy to OpenSearch.
- **scope:** SSR/CSR boundary, revalidation pipeline, search-page render mode
- **self-edit pipeline (the unifying webhook):** `/api/edit` → SAML auth → validate edit → write MySQL → `revalidatePath` → OpenSearch upsert → return. One handler, three side effects, atomic from the caller's perspective. This unifies ADR-001, ADR-004, ADR-007, and ADR-008.
- **indexing cadence:** Daily reindex after the MySQL ETL covers the bulk. On-demand reindex on self-edit uses the same webhook as page revalidation. Search staleness window equals build staleness window.
- **CDN strategy:** ISR pages cached by Next.js's built-in cache, additionally fronted by CloudFront. On-demand revalidation invalidates the Next.js cache; CloudFront cache invalidation is fired by the same webhook for the affected paths.

---

## Cross-cutting decision interactions

The eight decisions interlock around two canonical flows: (a) a single self-edit (ADR-001 → ADR-002 → ADR-003 → ADR-007 → ADR-008) and (b) the daily refresh (ADR-002 → ADR-004 → ADR-005 → ADR-006 → ADR-007). See `.planning/source-docs/phase-1-design-decisions.md` "Cross-cutting summary" for the full walkthrough.

---

## Open ADR-derived items (downstream tasks, not yet tracked elsewhere)

These items are listed by ADR-source as work follow-ons; they belong in the roadmap, not under "decisions" per se.

| Item | Owner | Source |
|---|---|---|
| Q6 ADR — "DAL = ETL transform" architectural decision record (`docs/ADR-001-runtime-dal-vs-etl-transform.md`) | Project lead | ADR-006 + BUILD-PLAN Phase 6 |
| OpenAPI specification artifact for `/api/*` routes (`openapi.yaml`) | Engineering | ADR-001 + BUILD-PLAN Phase 6 |
| Confirm `preferred_name` vs legal name as ED slug source | Project lead | ADR-003 |
| Surface to Mohammad's team: extend slide-21 to cover OpenSearch sink and DynamoDB-projection Lambda | Project lead | ADR-006, ADR-007 |
| Confirm citation-count refresh cadence in reciterdb-prod meets ≥ weekly target | Project lead with Mohammad's team | ADR + Functional Spec line 319 |
| Define escalation procedure for 3+ consecutive ETL failures of any source | Operations | ADR-005 |
