# Scholars @ WCM — Phase 1 Design Decisions

_Last updated: 2026-04-29_

## Purpose

This document captures eight architectural and design decisions made during the Phase 1 design-review brainstorm. It is a companion to:

- `Scholars Functional Spec - Phase 1 - 2026-04-28.md` (the WHAT — user-facing behavior)
- `Scholars Project Charter - 2026-04-28.md` (the WHY — business case, scope, success criteria)

This document covers the **HOW at the architectural level** — decisions that the functional spec leaves implicit, ambiguous, or silent, and that downstream technical planning needs as inputs. It does not duplicate spec content; it resolves it.

Audience: ITS development team, Mohammad's team, VIVO/ASMS Steering Committee, AAC, CAB.

Relationship to existing artifacts: where a decision below modifies or sharpens spec language, the affected spec section is cited. The functional spec is **not** edited in place — this decisions doc is the diff. If a contradiction arises between this document and the spec, this document supersedes (later-dated, more specific).

## Summary of decisions

| # | Topic | Decision |
|---|---|---|
| 1 | API architecture | Single Next.js deploy; API exposed via `/api/*` routes; separate OpenAPI contract artifact |
| 2 | Canonical scholar identity | CWID-canonical with `cwid_aliases` table sourced from ED `replacement_cwid` |
| 3 | URL strategy | Slug-primary HTML URLs (`/scholars/:slug`) with `slug_history` table; API stays CWID-keyed |
| 4 | Departed faculty | Strict delete on loss of active appointment; 60-day data retention; VIVO URLs 301 to `/search?q=<name>` for departed scholars |
| 5 | Daily refresh failure modes | Per-source independent refresh; ED-first chain with abort-cascade; CloudWatch monitoring; no user-visible staleness UI |
| 6 | DynamoDB integration | Minimal-projection ETL into MySQL (score + topic assignments only); separate Lambda triggered by ReCiterAI completion |
| 7 | Search engine | OpenSearch (AWS-managed); dense embeddings deferred to Phase 2 |
| 8 | Render strategy | Next.js ISR with on-demand revalidation for profiles; CSR for search via `/api/search` proxy |

The decisions are presented below in order of architectural blast radius — broadest first.

---

## 1. API architecture: single deploy with Next.js API routes

### Decision

Phase 1 ships as a single Next.js application on Fargate. The "Scholar API" promised in Charter line 25 is exposed via Next.js `/api/*` route handlers within the same deploy. Internal Next.js pages call these handlers as direct function invocations during SSR/ISR (no HTTP hop in the build pipeline). External consumers hit the same routes over HTTPS at `scholars.weill.cornell.edu/api/scholars/:cwid`.

A **separate OpenAPI specification artifact** documents the API contract independently from the Next.js source. Future-app onboarding documentation references the OpenAPI spec, not the implementation code.

### Rationale

The Charter explicitly promises a "reusable Scholar API as the backend for current and future researcher-facing applications." A standalone microservice (Express/NestJS/Fastify) would honor that language but build infrastructure ahead of demand: the only known second consumer is the Data & Analytics product, and per Charter line 13 that product is expected to *take over* faculty self-edit, not run alongside it. Phase 1 has exactly one near-term API consumer — the Scholars website itself.

A single-deploy Next.js application with `/api/*` routes satisfies the "reusable backend" requirement (the API is real, discoverable, documented, and HTTP-accessible) without standing up a second service. Migration path is clean: when a future consumer justifies separating the API, route handlers lift into a standalone service with no contract change.

### Refinements

- **OpenAPI artifact lives in the repo** alongside the Next.js source. The implementation and contract are versioned together but documented independently — preventing the slow drift where a "reusable API" decays into "whatever Next.js currently exposes."
- **Performance:** Next.js can invoke API route handlers as plain function calls during SSR and ISR. ISR daily revalidation pays no HTTP cost. External callers pay the HTTP cost; internal callers don't.
- **Future migration cost:** if a future app requires the API to scale or deploy independently of the website, the route handlers move into a standalone Node service. The OpenAPI contract stays stable; clients see no break.

### Implications for Mohammad's team

Slide-21 architecture remains a single Fargate service for the Scholars application (UI + API), one MySQL on RDS, one OpenSearch domain, plus the ETL Lambdas described in decisions #5 and #6. No separate API tier to provision **in the prototype**.

### Status note (added 2026-04-29 after stakeholder feedback)

This decision applies to the local prototype only. In email correspondence following the brainstorm, Mohammad expressed a preliminary preference for a **separate Scholar API service** in production ("I expect it would be a separate service so it can be consumed"), hedged with "could change when we officially kick off the design."

Production architecture for the Scholar API is therefore **deferred to Mohammad's official design kickoff.** The prototype implements (D) for build velocity but adopts an implementation discipline — API route handlers are pure functions in `lib/api/*` with route files as thin delegators — that makes lifting handlers into a standalone Node service a copy-paste, not a rewrite. The OpenAPI contract documented in `openapi.yaml` is the durable artifact; both implementation paths satisfy the same contract.

---

## 2. Canonical scholar identity: CWID-canonical with aliases

### Decision

The Scholars MySQL read store uses **CWID as the primary key** for the `scholar` table. Foreign keys throughout the schema reference `scholar.cwid` directly. A `cwid_aliases (old_cwid PRIMARY KEY, current_cwid FOREIGN KEY)` table handles edge cases.

Aliases are **auto-populated from Enterprise Directory's `replacement_cwid` field** by the daily ED ETL. Manual aliases — e.g., merging duplicate CWIDs that ED itself does not know are duplicates — are inserted by the admin role described in spec line 226, audit-logged.

Records lacking a CWID do not enter Scholars. Per stakeholder confirmation: "We don't have any need to publish profiles without it."

### Rationale

CWID is the WCM-wide identity primary key. Every other tool at WCM joins on CWID; using a Scholars-internal surrogate ID would isolate Scholars from cross-system debugging and force constant `scholar_id ↔ cwid` translation in cross-team conversations. The duplicate-CWID and CWID-change cases are uncommon enough that a true surrogate-key architecture would be paying premium for a problem that surfaces a handful of times per year.

The alias-as-redirect mechanism (described below) addresses both edge cases without the constant tax of join-time resolution.

### Refinements

- **Alias-as-redirect, not alias-as-join-resolver.** When ED reports `cwid_old → cwid_new`, the daily ETL performs a real migration: rewrite all FKs from old to new across `scholar`, `appointment`, `publication_author`, `grant`, `topic_assignment`, `publication_score`, etc.; drop the old `scholar` row; insert into `cwid_aliases` for historical lookup. The result is one live row per person (clean joins, no resolve-on-read tax). The aliases table becomes a URL-redirect / historical-lookup table — used by the URL middleware for 301s, not by the data layer at query time.

- **ReCiter is the source of truth for CWID↔pmid joins.** Author disambiguation is consumed as-is from ReCiter; Scholars does not reinvent it.

- **`publication_authors.cwid` is nullable** for non-WCM coauthors (per spec line 200, external authors render as plain text without a profile link).

- **Provisioning lag is tolerated:** a CWID present in ED but not yet in ReCiter (e.g., new hire with no publications attributed) produces a sparse but valid profile. Only ED presence is required at ETL time, since ED is the identity authority.

### URL behavior

- `GET /api/scholars/:old_cwid` → 301 → `/api/scholars/:new_cwid`
- `GET /scholars/:old_slug_or_cwid_path` → 301 chain via `cwid_aliases` and `slug_history` (decision #3) → current canonical URL
- Old VIVO 301 chains continue to resolve through the alias mechanism

### Migration path to a true surrogate key

If duplicate-CWID volume ever justifies a true surrogate `scholar_id`, the migration is a single-day refactor: add `scholar_id` column, populate from CWID, switch FKs. The aliases table makes the merge history queryable. CWID-canonical is therefore a forward-compatible default, not a corner-painting choice.

---

## 3. URL strategy: slug-primary HTML, CWID-keyed API

### Decision

**HTML URLs are slug-primary.** Canonical: `/scholars/:slug`, e.g., `/scholars/jane-smith`. A `slug_history (old_slug PRIMARY KEY, current_cwid FOREIGN KEY)` table handles name changes.

**API URLs are CWID-keyed.** `/api/scholars/:cwid` — stable, identity-driven, machine-friendly.

**CWID-anchored HTML fallback:** `/scholars/by-cwid/:cwid` → 301 → current canonical slug URL. For API discoverability and recovery from broken links.

`sitemap.xml` lists only canonical slug URLs.

### Slug derivation

- Source: `preferred_name` from Enterprise Directory (NOT legal name — the spec's "Full name" reference at line 27 should be confirmed with ED owners as the public-facing field)
- NFKD normalize, strip combining marks, ASCII-fold
- Lowercase, replace whitespace with hyphen, drop punctuation
- Examples:
  - `María José García-López` → `maria-jose-garcia-lopez`
  - `李明` → `li-ming` (using ED's romanization field — ASCII slug is preferable to URL-encoded UTF-8 for a public-facing system)
  - `O'Brien-Smith, Jane Q.` → `jane-obrien-smith`

### Collision handling

Numeric suffix in CWID-creation order: `jane-smith`, `jane-smith-2`, `jane-smith-3`, etc. Resolution is one-time at first collision: Jane #1 keeps her unsuffixed slug; new arrivals get the suffix. Established profiles never get renamed by a new collision.

### Name-change handling

When ED reports a name change, the slug auto-regenerates. If the new slug differs from the old, the old slug writes to `slug_history` and a 301 is emitted thereafter. Faculty do not opt in — semantically, the URL tracks the name, and the 301 ensures nothing breaks. This handles the common case of marriage/divorce/name correction without faculty action.

### URL middleware resolution order

1. Try `scholar.slug` direct match → 200
2. Try `slug_history` → 301 to current canonical slug
3. Try `/scholars/by-cwid/:cwid` route → resolve `cwid_aliases` → 301 to current canonical slug
4. Else 404 (rendering the home page with prominent search per spec line 213)

### Rationale

Faculty share their profile URL on business cards, ORCID profiles, NIH biosketches, and email signatures. They care what the URL says. VIVO used name-slug URLs; coming from VIVO, anything else is a regression. CWID-only URLs forfeit modest but free SEO benefit from name-bearing URLs and produce dead-end 301 chains (`/scholars/jds9001`) that look like internal IDs. Stack-Overflow-style `/scholars/:cwid/:slug` is technically clean but loses faculty-facing shareability.

API stays CWID-keyed because the API contract should be identity-driven and stable. Slugs are a presentation concern, not a contract concern.

### VIVO 301 chain

The VIVO URL audit (spec line 308 open item) produces `vivo_url → cwid` mappings. The redirect host then resolves through:

`vivo_url → cwid → resolve aliases → resolve to current slug → 301 to canonical Scholars URL`

A three-step chain, well-defined.

---

## 4. Departed faculty: strict delete with retention window

### Decision

**Phase 1 inclusion criterion:** active academic appointment in Enterprise Directory.

**Phase 2+ extension (deferred):** active doctoral program enrollment will also qualify. ED already has this signal; it is not consumed in Phase 1.

**Lifecycle on loss of active appointment:**

1. Next daily ETL flips `scholar.deleted_at = now()`.
2. Immediately: URL returns 410 Gone, profile removed from sitemap, document removed from OpenSearch, ISR cache invalidated.
3. **No user-visible grace period.** Departure is reflected in the public site within 24 hours.
4. **60-day data retention.** All related rows preserved for 60 days. Admin can restore (clear `deleted_at`) within window. Daily ETL detecting reactivation also clears `deleted_at` automatically.
5. After 60 days: cleanup job hard-deletes all related rows.

### Admin override

The spec line 226 admin role gains one action: **suppress**. For in-flight sensitive cases on currently-active scholars (legal, fired-with-cause, etc.). Sets `deleted_at` regardless of appointment status. Same 60-day window applies.

No tombstone UX. No memorial banner. No "Active at WCM" search filter — everyone in the index is active by definition.

### Rationale

Scholars is a current-affiliation system, not a historical record. The institutional policy is binary: active appointment → profile; otherwise → no profile. Tombstone variants and emeritus-style preservation introduce ambiguity about who is currently at WCM, undermining the "current scholars" promise of the system. Peer institutions vary on this; WCM's choice is the unambiguous version.

The 60-day retention window addresses operational concerns (paperwork-driven gaps between appointments, restoration after departure mistakes, audit windows for "what happened to X" investigations) without compromising the user-facing rule.

### SEO mitigation

Inbound-link equity from PubMed, ResearchGate, NIH biosketches, and news mentions is real and unrecoverable on hard deletion. Mitigation:

- The VIVO domain (`vivo.weill.cornell.edu`) is kept alive as a redirect-only host (no app — nginx/CloudFront rules).
- VIVO URL audit produces `vivo_url → cwid` mappings.
- For active scholars: 301 to current canonical Scholars slug URL.
- For deleted scholars: **301 to `/search?q=<name-extracted-from-vivo-url-slug>`**.

The `/search?q=<name>` redirect is contextually relevant for SEO (Google reads it as a meaningful redirect, not a soft-404), preserves inbound traffic, lets visitors land somewhere actionable, and works regardless of whether the scholar is in soft-delete or hard-deleted (because the name is extracted from the inbound VIVO URL itself, not from Scholars data).

For unrecognized VIVO URLs (audit gap, hand-curated forms): same `/search?q=<fragment>` redirect if a name fragment can be extracted; else 404 to the home page with prominent search.

### Schema implications

- `scholar.deleted_at TIMESTAMP NULL` (soft-delete marker; indexed for cleanup)
- All public read paths filter `WHERE deleted_at IS NULL`
- Daily ETL: detect newly-departed (no active appointments) → set `deleted_at`; detect reactivation → clear `deleted_at`
- Cleanup job: nightly, hard-delete `WHERE deleted_at < now() - INTERVAL 60 DAY`
- Admin restore: `UPDATE scholar SET deleted_at = NULL WHERE cwid = ?` (audit-logged)

### Reactivation

If a scholar returns within the 60-day window, the daily ETL clears `deleted_at` automatically when ED reports a fresh active appointment. URL, slug, and overview text are restored.

If a scholar returns after the 60-day window, they re-enter as a fresh ETL record. Same CWID produces the same canonical slug (no URL regression), but the self-edited overview text is gone. Acceptable for the rare case.

---

## 5. Daily refresh failure modes

### Decision

Each upstream source — ED, ASMS, InfoEd, ReCiter (and the Q6 DynamoDB minimal-projection step), COI — runs its own daily ETL job and commits independently. **No user-visible staleness signals on the public site.** Internal observability via dedicated endpoints and CloudWatch alarms.

### Per-source atomicity

Each ETL stages to a shadow table, validates row counts and required-field nulls (the spec's per-source filtering logic provides validation rules — e.g., "ED data with 0 active scholars = abort"), then atomic-swaps to the live tables. Prevents intra-source half-applied state without coupling sources to each other.

### Chain order with ED-first abort-cascade

Daily ETL run order: **ED → ASMS → InfoEd → ReCiter (+ DynamoDB minimal-projection) → COI**.

ED failure aborts the rest of the chain for that day. Other sources fail independently of one another. Rationale: ED is the identity authority (decision #2). ED failure means "we don't know who exists." Other sources' failures only mean "we don't know all the attributes" — appointments stay current with the grants stale, or vice versa, but the CWID set is intact.

### Interaction with decision #4 (departed faculty)

The "all appointments terminated" check that triggers `deleted_at` runs only against successful ED refreshes. Transient ED outages cannot cause spurious soft-deletes.

### Monitoring and observability

- `last_successful_refresh_at` timestamp tracked per source
- Internal endpoint `/api/health/refresh-status` (admin SAML auth, not public) — canonical answer to "is the refresh healthy right now?"
- Each ETL emits structured success/failure log entries with row counts
- CloudWatch alarm: `last_successful_refresh_at < now() - 26h` per source (1-hour grace for the daily window)
- Alarm pages Mohammad's team on red. Yellow conditions do not page.
- 3+ consecutive failures of any source → escalation procedure (TBD with operations)

### Rationale

All-or-nothing daily transactions mean Scholars goes fully stale across-the-board ~2x/month at conservative source MTBF. Per-source independence preserves freshness on the working sources at the cost of mild intra-day inconsistency between sections — which is invisible to users in practice, since profile sections don't cross-reference each other.

User-visible staleness UI ("last updated 3 days ago") was rejected: it turns invisible-OK into visible-suspicious for the common 1-day-late case, producing a UX regression. Section-hiding fallback ("temporarily unavailable") was rejected as worse — faculty checking their own profile would panic.

### Recovery procedure (closes spec line 300 open item)

| Failure | Priority | Action |
|---|---|---|
| ED | Highest (blocks downstream) | Page on-call; manual rerun |
| ASMS / InfoEd / ReCiter / COI single-day | 24h-tolerable | Auto-recover on next day's run |
| Any source 3+ consecutive failures | Escalate | Procedure TBD |

---

## 6. DynamoDB integration: minimal-projection ETL

### Decision

ReCiterAI's DynamoDB output is consumed via a **minimal-projection ETL** into the Scholars MySQL read store. The Scholars application reads only MySQL at runtime — there is no runtime DynamoDB read path.

The data-access-layer pattern called for in spec language (`getPublicationScore(pmid)` in particular) applies at the **ETL transform**, not at the runtime read. This is a real departure from the spec's verbatim language and is documented in a separate ADR (see Open items).

### Minimal fields list (Phase 1 only)

Exactly two fields flow from DynamoDB → MySQL:

- `publication_score` — per scholar+pmid pair
- `topic_assignments` — per scholar (MeSH terms or topic clusters with weights)

Other ReCiterAI outputs (identity-disambiguation confidence, inferred coauthorship, etc.) are explicitly out of scope for the v1 ETL. They may be added later as "future ETL extensions" if downstream features require them. The principle: every flowing field is a contract-test surface, so default to no.

### ETL trigger and ownership

A separate Lambda function reads from DynamoDB (via stream or scheduled scan), transforms, and writes to MySQL. The Lambda is triggered by ReCiterAI's weekly run completion via EventBridge.

This separation (rather than having ReCiterAI itself write the MySQL projection at end of its run) preserves ownership boundaries. ReCiterAI is owned by a different team; coupling Scholars MySQL schema changes to ReCiterAI deploys would create cross-team friction. The Lambda is small (~100 lines: read DynamoDB, transform, write MySQL) and Mohammad's team is already running Lambda-grade infrastructure.

Failure isolation: if the projection breaks, ReCiterAI's own weekly run is unaffected.

### Rationale

The functional spec is genuinely ambiguous between a "Scholars-owned read store populated via scheduled ETL" reading and a "thin DAL abstracts DynamoDB calls behind domain methods" reading. The minimal-projection approach resolves the ambiguity by:

- Keeping a single read store at runtime (operational simplicity, simpler local dev with one connection string, contract tests run against MySQL with no DynamoDB credentials in CI)
- Preserving the DAL discipline where it actually matters — at the ETL boundary, where ReCiterAI schema changes would otherwise propagate uncontrolled

### Implications for Mohammad's team

Slide-21 replication architecture (SSIS + MS SQL Mirror DB) covers ED, reciter-db, and Jenzabar cleanly but does **not** natively cover DynamoDB. The DynamoDB → MySQL projection Lambda is a distinct pipeline class that needs to be added to the architecture.

### Staleness window

The data-staleness window for ReCiterAI scores is bounded by ReCiterAI's *weekly* cadence, not by the ETL latency. The daily Scholars build sees consistent scores all week; scores update once weekly when ReCiterAI runs.

---

## 7. Search engine: OpenSearch

### Decision

**OpenSearch (AWS-managed)** is the search engine for Phase 1.

### Rationale

The functional spec demands features MySQL FULLTEXT cannot natively provide:

- Per-field boosting (Name 10× / AOI 6× / Title 4× / Department 3× / Overview 2× / Publication title 1× / MeSH 0.5×) — spec line 156
- Authorship-weighted contributions (×1.0 first/last, ×0.4 second/penultimate, ×0.1 middle) — spec line 165
- Two indices (people + publications) — spec line 179
- Faceted filters and autocomplete on 2 characters — spec lines 184, 195

Spec line 171 explicitly flags Postgres FULLTEXT as inadequate for these requirements ("`setweight()` workarounds"). MySQL FULLTEXT has the same limitations.

OpenSearch provides all of the above natively (`multi_match` for per-field boosting, `function_score` / `script_score` for authorship weighting, aggregations for faceting, edge n-grams or completion suggester for autocomplete). It is AWS-managed and IAM-integrated, fitting WCM's existing infrastructure conventions. The slide-21 replication architecture extends cleanly with OpenSearch as another sink. Estimated cost: ~$100–300/month for a small cluster.

### Why not the alternatives

- **Algolia (SaaS)** — best-in-class autocomplete but data-residency review at an academic medical center is a real institutional cost; the autocomplete edge does not justify it.
- **Postgres + pgvector** — `tsvector setweight()` provides only 4 levels (A/B/C/D); the spec requires 7 distinct boost values. Fails the requirement literally.
- **Typesense / Meilisearch** — too small for an institutional bet; no AWS-managed offering means Mohammad's team owns the operations.
- **Elasticsearch** — same featureset as OpenSearch (forked from the same root); SSPL license complexity at academic medical centers tends to push selection to OpenSearch anyway.

### Dense embeddings deferred to Phase 2

The v1.1 spec floats "BM25 + dense biomedical embedding + faculty-status boost" pending consultation with the ReCiter lead. Phase 1 ships **without** dense embeddings:

- BM25 with the spec's per-field boosting and authorship weighting is genuinely strong for 7-field weighted retrieval
- Faculty-status boost is implementable as a `function_score` multiplier without embeddings
- No way to evaluate whether hybrid retrieval improves over BM25 without an evaluation harness, which itself is not yet built
- ReCiter lead consultation on biomedical embedding model selection (PubMedBERT vs BioBERT vs SapBERT vs MedCPT) is a hard prerequisite that has not occurred
- Re-indexing 510K documents to add embeddings later is a one-day operation, not a one-way door
- OpenSearch's k-NN plugin sits dormant until needed

Phase 1 search ships as: BM25 + per-field boost + authorship weighting + faculty-status boost (all `function_score`-driven).

### Indexing pipeline

A Lambda (or Fargate task) reads from MySQL after the daily ETL completes and writes to OpenSearch. Daily reindex covers the bulk of changes. On-demand reindex on self-edit is triggered by the same webhook that fires page revalidation (decision #8) — one trigger, two consumers.

OpenSearch credentials never leave the server. The browser-facing search experience proxies through `/api/search` (decision #1), which both keeps credentials safe and provides a place for query logging, rate limiting, and per-field-boost enforcement.

---

## 8. Render strategy: Next.js ISR with on-demand revalidation

### Decision

**Profile pages: Incremental Static Regeneration (ISR) with on-demand revalidation.** Profiles render statically on first visit, are cached by Next.js, and are revalidated either on a TTL or on-demand when a self-edit fires a revalidation webhook.

**Search and directory pages: Client-side rendering (CSR)** through the `/api/search` proxy to OpenSearch.

### Rationale

The Charter lists SEO preservation as a success criterion (line 87). The functional spec mandates `sitemap.xml`, canonical URLs, 301 redirects from VIVO, and indexability of profile and search pages. Profiles are content-heavy and SEO-critical; search results, faceted filters, and "show all" expanders are interactive and CSR-friendly. The boundary needs to be a deliberate decision, not a Next.js default.

ISR is the right fit because:

1. **Spec compatibility.** Spec line 236 locks "self-edits write through immediately." Full SSG would make self-edits invisible until the next nightly rebuild. ISR with on-demand revalidation lets self-edits fire a webhook and the public page updates within seconds.
2. **SEO equivalence.** Once warmed, ISR pages are statically served. Googlebot sees fully rendered HTML. `sitemap.xml`, canonical URLs, and 301s from VIVO work identically to full SSG.
3. **Failure tolerance.** A MySQL hiccup with full SSR takes the site down. With ISR, cached pages keep serving; only revalidations fail.
4. **Build velocity.** No 10K-profile full-rebuild wall-clock cost.

### Search-page CSR is forced, not chosen

Autocomplete on 2 characters (spec line 184) and faceted filtering both require interactive client-side behavior. The decision is not "should the search page be CSR" but rather "how is OpenSearch reached from the browser." The answer is: through a thin Next.js API route at `/api/search` that proxies the OpenSearch query, keeping credentials server-side and providing a place for query logging, rate limiting, and server-side enforcement of per-field boost weights.

### Self-edit pipeline (the unifying webhook)

A self-edit hits `/api/edit`, which:

1. Authenticates the SAML session
2. Validates the edit (character limit, allowed formatting per spec line 234)
3. Writes to MySQL
4. Fires `revalidatePath` for the profile URL (and the slug-history alias if the slug just changed)
5. Upserts the OpenSearch document (since the overview field is part of the people index per spec line 159)
6. Returns

One handler, three side effects, atomic from the caller's perspective. This unifies decisions #1, #4, #7, and #8 into a single coherent write path.

### Indexing cadence (closes Q7 sub-decision)

Daily reindex after the MySQL ETL covers the bulk. On-demand reindex on self-edit uses the same webhook as page revalidation. Search staleness window equals build staleness window.

### Build-time and CDN strategy

ISR pages are cached by Next.js's built-in cache and can be additionally fronted by CloudFront (already in the Charter line 44 dependency list). On-demand revalidation invalidates the Next.js cache; CloudFront cache invalidation is fired by the same webhook for the affected paths. This works for both the canonical slug URL and any historical slug aliases (slug_history rows).

---

## Cross-cutting summary: how the decisions fit together

A single self-edit illustrates how decisions #1, #2, #3, #4, #7, and #8 interlock:

1. Faculty member with CWID `abc1234`, slug `jane-smith`, edits her overview
2. Browser POSTs to `/api/edit` (decision #1: Next.js API route, not separate service)
3. Route handler validates SAML session — only `abc1234` can edit `abc1234`'s profile
4. MySQL write to `scholar.overview WHERE cwid = 'abc1234'` (decision #2: CWID-canonical PK)
5. Handler fires `revalidatePath('/scholars/jane-smith')` and any historical slug paths from `slug_history` (decisions #3, #8)
6. Handler upserts the OpenSearch document for `abc1234`, including the new overview text (decision #7)
7. CloudFront cache invalidation for the affected paths
8. Handler returns 200; Next.js page re-renders with updated content within seconds

A daily refresh illustrates how decisions #2, #4, #5, #6, and #7 interlock:

1. ED ETL runs first (decision #5 ED-first chain order)
2. ED ETL stages and validates; if valid, atomic swap (decision #5 per-source atomicity)
3. ED ETL detects `replacement_cwid` rows; rewrites FKs from old to new CWIDs and writes to `cwid_aliases` (decision #2 alias-as-redirect)
4. ED ETL detects scholars with no remaining active appointments; sets `deleted_at` (decision #4 strict departure)
5. If ED succeeded: ASMS, InfoEd, ReCiter, COI run independently (decision #5 per-source independence)
6. ReCiter step includes the DynamoDB minimal-projection Lambda for `publication_score` and `topic_assignments` (decision #6)
7. After all ETLs complete: OpenSearch reindex job runs against the updated MySQL state (decision #7 indexing pipeline)
8. CloudFront cache invalidates for all paths affected by changed data
9. Cleanup job hard-deletes scholar rows past the 60-day soft-delete window (decision #4 retention)
10. Monitoring records `last_successful_refresh_at` per source (decision #5 observability)

## Open items

These decisions create downstream tasks not yet tracked elsewhere:

| Item | Owner | Notes |
|---|---|---|
| Q6 ADR — "DAL = ETL transform" architectural decision record | Project lead | Documents the departure from spec's verbatim DAL language; protects against re-litigation by reviewers reading spec-only |
| OpenAPI specification artifact for `/api/*` routes | Engineering | Decision #1 refinement; live in repo |
| Confirm `preferred_name` vs legal name as ED slug source | Project lead | Decision #3; confirm with ED owners |
| Surface to Mohammad's team: extend slide-21 to cover OpenSearch sink and DynamoDB-projection Lambda | Project lead | Decisions #6, #7 |
| Confirm citation-count refresh cadence in reciterdb-prod meets ≥ weekly target | Project lead with Mohammad's team | Spec open item, line 319 |
| Define escalation procedure for 3+ consecutive ETL failures of any source | Operations | Decision #5 |

## Items considered and rejected

For traceability, the alternatives weighed and rejected during this decision sequence:

- **API:** standalone microservice rejected (over-investment for one consumer); direct-DB-only rejected (misses charter objective); read-direct-write-through-API hybrid rejected (operational complexity without clear gain over single-deploy)
- **Identity:** Scholars-internal surrogate ID rejected (cross-system debugging cost); CWID-only-no-aliases rejected (does not handle ED replacement_cwid signal)
- **URL:** CWID-only HTML URLs rejected (regression vs VIVO, modest SEO loss); slug-only without history rejected (collision and name-change handling needed anyway); `slug-cwid` blob URLs rejected (delimiter parsing fragile); Stack-Overflow-style `/cwid/slug` rejected (loses faculty-facing shareability)
- **Departed faculty:** hard 410 with no mitigation rejected (catastrophic SEO loss); soft tombstone rejected (ambiguity about current affiliation); emeritus-style preservation rejected (misleading); 410 for departed VIVO redirects rejected (preferred contextual `/search?q=<name>` redirect)
- **Daily refresh:** all-or-nothing transactions rejected (~2× per month full-stale); user-visible staleness signals rejected (UX regression); section-hiding fallback rejected (panic for self-viewers)
- **DynamoDB:** full ETL of all DynamoDB fields rejected (every field is a contract surface; default to no); runtime DAL with two stores rejected (operational surface for no Phase 1 benefit); ReCiterAI-writes-MySQL coupling rejected (cross-team ownership)
- **Search:** Algolia rejected (data-residency review); pgvector rejected (`setweight` only 4 levels, spec needs 7); Typesense / Meili rejected (institutional bet too small); Elasticsearch rejected (SSPL license complexity vs OpenSearch)
- **Render:** full SSG rejected (self-edits would lag a day); full SSR rejected (DB hiccup → site down); SSG with separate preview path rejected (public still lags self-edits)

## History

- **2026-04-29:** Document created. All eight decisions ratified during the design-review brainstorm session.
