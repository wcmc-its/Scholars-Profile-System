# Constraints (intel)

Synthesized from SPEC-class sources during ingest. Two SPEC sources contribute: design spec v1.7.1 (precedence 1, treated as locked UI/UX contract per orchestrator instruction) and functional spec Phase 1 (precedence 3). Where they overlap on UI/UX, design spec v1.7.1 wins.

---

## NFR / cross-cutting constraints

### CON-mobile-responsive

- **type:** nfr
- **source:** `.planning/source-docs/functional-spec-phase-1.md` line 270
- **content:** All Phase 1 pages must render usably on phones (single-column collapse for profile and search results).

### CON-daily-refresh-cadence

- **type:** nfr
- **source:** `.planning/source-docs/functional-spec-phase-1.md` line 271 + `.planning/source-docs/design-spec-v1.7.1.md` "Refresh cadences"
- **content:** Daily refresh cadence for identity, appointments, role/person-type, publication attribution, publication metadata, Jenzabar (thesis advisor), COI disclosures (working assumption — confirm with COI office). Weekly cadence for ReCiterAI scores and topic assignments (matches ReCiterAI's write cadence to DynamoDB). Self-edits bypass the daily refresh and write through immediately (documented exception).

### CON-read-only-source-systems

- **type:** protocol
- **source:** `.planning/source-docs/charter.md` Constraints
- **content:** Source systems are consumed read-only. No write-back to upstream systems. No functional duplication of upstream systems.

### CON-credentials-via-env

- **type:** protocol
- **source:** `.planning/source-docs/HANDOFF-2026-04-30.md` "Environment variables" + global security policy
- **content:** All credentials live in `~/.zshenv` (so they propagate to non-interactive shells, npm child processes). Project-namespaced as `SCHOLARS_*` to avoid collisions. Production should rely on AWS Secrets Manager / SSM Parameter Store rather than shell exports. **Never commit `.env` files or secrets**, never hardcode credentials, never display credential values.
- **HANDOFF-listed env vars:** `DATABASE_URL`, `OPENSEARCH_NODE`, `SCHOLARS_LDAP_URL`, `SCHOLARS_LDAP_BIND_DN`, `SCHOLARS_LDAP_BIND_PASSWORD`, `SCHOLARS_RECITERDB_*`, `SCHOLARS_ASMS_*`, `SCHOLARS_INFOED_*`, `SCHOLARS_COI_*`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_DEFAULT_REGION`.

### CON-public-repo-discipline

- **type:** protocol
- **source:** `.planning/source-docs/BUILD-PLAN.md` "Scope shape"
- **content:** Code committed to public `wcmc-its/Scholars-Profile-System`. Real data, credentials, and identifiers stay local. Seed/test fixtures are synthetic or anonymized. `.gitignore` `.env*`, `data/`, `*.dump`, `*.sql.gz`. Pre-commit hook scanning for CWID-shaped strings (4 letters + 4 digits regex).

---

## Schema constraints

### CON-schema-cwid-canonical

- **type:** schema
- **source:** `.planning/source-docs/phase-1-design-decisions.md` ADR-002 (LOCKED) + Prisma schema implied by `.planning/source-docs/BUILD-PLAN.md` Phase 1
- **content:** `scholar` table uses CWID as primary key. All FKs throughout the schema (`appointment`, `education`, `grant`, `publication_author`, `topic_assignment`, `publication_score`) reference `scholar.cwid` directly. `cwid_aliases (old_cwid PRIMARY KEY, current_cwid FOREIGN KEY)` table for historical lookup only (URL middleware uses it; data layer never resolves at query time — alias-as-redirect, not alias-as-join-resolver). `publication_authors.cwid` is nullable for non-WCM coauthors.

### CON-schema-soft-delete

- **type:** schema
- **source:** `.planning/source-docs/phase-1-design-decisions.md` ADR-004 (LOCKED)
- **content:** `scholar.deleted_at TIMESTAMP NULL` (indexed for cleanup). All public read paths filter `WHERE deleted_at IS NULL`. Cleanup job: nightly, hard-delete `WHERE deleted_at < now() - INTERVAL 60 DAY`. Admin restore: `UPDATE scholar SET deleted_at = NULL WHERE cwid = ?` (audit-logged).

### CON-schema-slug-history

- **type:** schema
- **source:** `.planning/source-docs/phase-1-design-decisions.md` ADR-003 (LOCKED)
- **content:** `slug_history (old_slug PRIMARY KEY, current_cwid FOREIGN KEY)`. Slug auto-regenerates on ED name change; old slug writes to `slug_history` and a 301 is emitted thereafter.

### CON-schema-refresh-tracking

- **type:** schema
- **source:** `.planning/source-docs/phase-1-design-decisions.md` ADR-005 (LOCKED)
- **content:** Per-source `last_successful_refresh_at` timestamp tracked.

### CON-schema-codes-as-join-keys

- **type:** schema
- **source:** `.planning/source-docs/design-spec-v1.7.1.md` "Codes are the stable join key"
- **content:** Org unit codes (`weillCornellEduOrgUnitCode`), department codes (`weillCornellEduDepartmentCode`), program codes (`weillCornellEduProgramCode`) are stable identifiers. Display names (`weillCornellEduOrgUnit`, `weillCornellEduDepartment`) may change. Implementation must always join on codes, never on display names. When "Medicine" is renamed to "Internal Medicine," the code stays the same; only the display string updates.

---

## API contract constraints

### CON-api-cwid-keyed

- **type:** api-contract
- **source:** `.planning/source-docs/phase-1-design-decisions.md` ADR-003 (LOCKED)
- **content:** API URLs are CWID-keyed: `/api/scholars/:cwid`. Stable, identity-driven, machine-friendly. Slugs are a presentation concern, not a contract concern. `GET /api/scholars/:old_cwid` → 301 → `/api/scholars/:new_cwid` via `cwid_aliases`.

### CON-api-openapi-artifact

- **type:** api-contract
- **source:** `.planning/source-docs/phase-1-design-decisions.md` ADR-001 (PROVISIONAL but binding for the artifact requirement)
- **content:** A separate OpenAPI specification artifact (`openapi.yaml`) lives in the repo alongside Next.js source. Implementation and contract versioned together but documented independently. Future-app onboarding documentation references the OpenAPI spec, not the implementation code.
- **status:** Phase 6 deferred per HANDOFF — `openapi.yaml` not yet written.

### CON-api-search-proxy

- **type:** api-contract
- **source:** `.planning/source-docs/phase-1-design-decisions.md` ADR-007 + ADR-008
- **content:** Browser-facing search experience proxies through `/api/search` (not direct OpenSearch from browser). Keeps OpenSearch credentials server-side; provides a place for query logging, rate limiting, and per-field-boost enforcement.

### CON-api-revalidate-webhook

- **type:** api-contract
- **source:** `.planning/source-docs/phase-1-design-decisions.md` ADR-008 + `.planning/source-docs/BUILD-PLAN.md` Phase 4
- **content:** `/api/revalidate` webhook route fires `revalidatePath` and OpenSearch upsert. Same handler self-edit (`/api/edit`) and ETL writes both reuse. One webhook → two consumers (Next.js cache + OpenSearch + CloudFront cache invalidation).

### CON-api-health-refresh-status

- **type:** api-contract
- **source:** `.planning/source-docs/phase-1-design-decisions.md` ADR-005
- **content:** `/api/health/refresh-status` (admin SAML auth, not public) is the canonical answer to "is the refresh healthy right now?" Returns per-source `last_successful_refresh_at` plus row counts per the most recent run.

---

## Search-engine protocol constraints

### CON-search-per-field-boosts

- **type:** protocol
- **source:** `.planning/source-docs/functional-spec-phase-1.md` line 156 (LOCKED — Phase 1 functional spec)
- **content:** People index field weights:
  - Name: 10×
  - Areas of interest: 6×
  - Primary title: 4×
  - Department: 3×
  - Overview statement: 2×
  - Publication titles (per scholar): 1×
  - Publication MeSH terms (per scholar): 0.5×

### CON-search-authorship-weighting

- **type:** protocol
- **source:** `.planning/source-docs/functional-spec-phase-1.md` lines 165–171 (LOCKED — Phase 1 functional spec)
- **content:** Authorship-weighted contributions for publication-derived signal:
  - First or last author: ×1.0
  - Second or penultimate author: ×0.4
  - Middle author: ×0.1
- Implementation may use repeated indexing (term-repetition) or per-document field boosts at index time. Either is acceptable. Search engine must support per-field boosting and either term-repetition or per-document field weighting.

### CON-search-min-evidence

- **type:** protocol
- **source:** `.planning/source-docs/functional-spec-phase-1.md` line 173
- **content:** A topical term contributes to a scholar's index only if EITHER (a) it appears in ≥2 of their publications OR (b) it appears in ≥1 first/last-author publication. Reduces noise on common topics; prevents one-off middle-author co-authorships from misclassifying scholars.

### CON-search-pagination

- **type:** protocol
- **source:** `.planning/source-docs/functional-spec-phase-1.md` line 197 (explicitly marked "Locked")
- **content:** Pagination is **numbered, 20 per page**. Locked: numbered pagination supports deep-linking, predictable analytics, and accessibility better than infinite-scroll for a directory-style product.
- **rendering pattern (design spec v1.7.1):** Small (≤6 pages) numbered with prev/next; Large (≥7 pages) ellipsis pattern `‹ Prev | 1 2 3 4 5 … 84 85 | Next ›`. Active page: slate background, white text.

### CON-search-autocomplete

- **type:** protocol
- **source:** `.planning/source-docs/functional-spec-phase-1.md` line 184
- **content:** Autocomplete fires after 2 characters. Suggests scholar name + primary title (Stanford-style). Submitted on Enter or click.

### CON-search-no-abstracts-indexed

- **type:** protocol
- **source:** `.planning/source-docs/functional-spec-phase-1.md` line 181
- **content:** Abstracts are NOT indexed in Phase 1. Publications index fields: publication title, MeSH terms, journal name, author names.

---

## Schema-change protocol constraint

### CON-schema-change-protocol

- **type:** protocol
- **source:** `.planning/source-docs/design-spec-v1.7.1.md` "Schema-change protocol for upstream sources"
- **content:** Two complementary commitments mitigate breaking changes (renamed fields, dropped tables, restructured documents) in upstream sources (ED, reciter-db, ReCiterAI DynamoDB, Jenzabar, COI):
  1. **Advance notice:** ReCiterAI team commits to **30 days advance notice** on DynamoDB schema changes affecting fields Scholars reads. Data team and Jenzabar integration owner commit to similar notice for ED, reciter-db, and Jenzabar field changes. Notice goes through a shared changelog or mailing list (implementation owner TBD with each team).
  2. **Contract tests:** Scholars maintains contract tests in CI that validate expected response shapes from each upstream source. Tests fail loudly when a field is missing, renamed, or restructured. Scoped into Phase 1; runs on every Scholars build plus a daily scheduled run against live source data.
- Belt-and-suspenders: notice when sources play well, contract-test failures when they don't.

---

## Algorithmic-surface protocol constraints

### CON-algorithmic-surface-rules

- **type:** protocol
- **source:** `.planning/source-docs/design-spec-v1.7.1.md` "Algorithmic surface guidelines"
- **content:** Whenever an algorithmic rule drives the content of a surface, three requirements:
  1. **The rule is visible on the page** in plain English, not buried in a methodology page. Example: *"Eight subtopics with the strongest recent activity at WCM, one per parent area, refreshed weekly."*
  2. **A "How this works" / "methodology" link points to a real page** that explains the rule, the data, and the scoring scope. **The methodology page must exist before launch.** A dead methodology link is the single most credibility-damaging element on these pages.
  3. **Citation counts are not displayed on "recent" surfaces.** Recent papers haven't accumulated citations; showing the count creates a perverse bias toward older work and makes the surface feel stale. Applies to: Topic page Recent highlights, Home page Recent contributions, any future "recent" surface. Citation counts are still appropriate elsewhere (full publication feed sort by citations, profile Selected highlights, search publication results).

### CON-letters-editorials-errata-excluded

- **type:** protocol
- **source:** `.planning/source-docs/design-spec-v1.7.1.md` v1.7 changelog
- **content:** Letters, Editorials, Errata are **hard-excluded** from highlight surfaces (weight = 0). A 10× score gap can no longer rescue an erratum onto the home page contributions surface. (Note: this is the design-spec v1.7.1 stance; functional spec Phase 1 had different ranking weights — see WARNINGS in INGEST-CONFLICTS.md.)

### CON-default-sorts

- **type:** protocol
- **source:** `.planning/source-docs/design-spec-v1.7.1.md` "Default sorts"
- **content:**
  - Topic page publication feed: **Newest** (deterministic; reproducibility — a paper at position 3 today should be at position 3 tomorrow; AI sort is opt-in)
  - Search results: **Relevance** (algorithm TBD pending ReCiter lead consultation)
  - Department faculty list: **Relevance**
  - Profile publication list (year-grouped): Most-recent year expanded (section-level interaction, not a sort)
  - Browse A-Z: Alphabetical

---

## Component-level UI constraints

### CON-status-pill-absence-as-default

- **type:** protocol
- **source:** `.planning/source-docs/design-spec-v1.7.1.md` "Status pill" component
- **content:** Status pill is **absent for default-active scholars**. Renders only when status is non-default (Emeritus, On leave, Sabbatical) AND when ED `weillCornellEduStatus` field freshness threshold is met (record's modify timestamp younger than 6 months). Stale data falls back to no pill (rather than risking an Emeritus pill on a working faculty member).

### CON-aoi-pill-threshold

- **type:** protocol
- **source:** `.planning/source-docs/design-spec-v1.7.1.md` "Areas of interest pills"
- **content:** A pill renders only when 3 or more of the scholar's publications are indexed with the keyword. Below threshold, the keyword is dropped silently. Per-pill counts shown (`Hospital quality & safety 87`). Counts use tabular numerals.

### CON-author-chip-unlinked-variant

- **type:** protocol
- **source:** `.planning/source-docs/design-spec-v1.7.1.md` "Author chip"
- **content:** When an author exists in publication metadata but doesn't have a Scholars profile page, render the chip as a `<span>` instead of an `<a>` — same visual (avatar + name), no hover state, no link. Honest degradation: user sees the author participated without a 404-prone link.

### CON-large-author-list-truncation

- **type:** protocol
- **source:** `.planning/source-docs/design-spec-v1.7.1.md` "Large author lists"
- **content:** Triggered when publication has 6+ WCM authors OR 10+ total authors. Vancouver-style byline truncation: first 3 + ellipsis + last 2, with self-highlight on current scholar. Below byline: collapsible "+N WCM authors" expander showing flex-wrap row of author chips for all WCM-attributed authors only (not non-WCM authors).

### CON-citations-format-phase-1

- **type:** protocol
- **source:** `.planning/source-docs/design-spec-v1.7.1.md` "Copy citations" component
- **content:** Phase 1 supports **Vancouver and BibTeX only.** AMA, APA, RIS deferred to Phase 2. Vancouver is the medical-school standard. Modal pattern: format dropdown + scope dropdown ("Current view" / "All publications") + preview pane (first ~3 entries) + Copy/Download actions. Single-paper citation copy: small clipboard icon next to DOI/PubMed links, one-click copy in Vancouver format.

---

## Design-token constraints

### CON-palette-placeholder

- **type:** protocol
- **source:** `.planning/source-docs/design-spec-v1.7.1.md` "Palette"
- **content:** Cornell Big Red is the institutional accent, reserved for high-prominence moments only (full-bleed header band, brand mark, "Curated" tag on ReCiterAI-driven surfaces). **Slate (`#2c4f6e`) is the working accent** for everything else (links, focus rings, rail-active states, hover colors, active filter chips, page-internal eyebrow labels). Concentrating red lets the rest of the page read as a refined research database, not Cornell undergrad recruiting.
- **CSS variable structure:** `--color-bg`, `--color-surface`, `--color-surface-alt`, `--color-surface-tint`, `--color-border`, `--color-border-strong`, `--color-text`, `--color-text-secondary`, `--color-text-muted`, `--color-primary` (`#B31B1B`), `--color-primary-hover` (`#8c1414`), `--color-primary-light` (`#faf3f3`), `--color-accent` (`#2c4f6e`), `--color-accent-light` (`#eaf0f5`), `--color-accent-hover` (`#1f3b53`), `--color-link`, `--color-link-hover`, `--color-success`, `--color-success-light`, `--color-warning`, `--color-warning-light`.
- **placeholder until WCM brand standards are published.** When real standards land, swap the values; the variable structure stays.

### CON-typography

- **type:** protocol
- **source:** `.planning/source-docs/design-spec-v1.7.1.md` "Typography"
- **content:** Two faces.
  - **Inter** for body text, navigation, UI controls, paragraphs, lists. Default `--font-sans` stack: `'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`.
  - **Charter** (with fallbacks) for the brand mark, page H1s, hero titles. Default `--font-display` stack: `'Charter', 'Tiempos Headline', Georgia, serif`. Charter is preinstalled on macOS/iOS; Georgia is universal fallback.
- Apply serif only to: Brand mark "Scholars" line in header, page H1s on Browse / Department / Profile (NOT topic — already applied), Hero titles on Topic detail and Department detail.
- Do NOT apply serif to body text, lists, table content, or buttons.

### CON-header-spec

- **type:** protocol
- **source:** `.planning/source-docs/design-spec-v1.7.1.md` "Header"
- **content:** Full-bleed Cornell red band, sticky at top of every page, **60px tall**. CSS:
  ```css
  .wcm-header {
    position: sticky; top: 0; z-index: 50;
    background: var(--color-primary);
    border-bottom: 1px solid rgba(0, 0, 0, 0.15);
    box-shadow: inset 0 -1px 0 rgba(255, 255, 255, 0.08);
    height: 60px;
  }
  ```
- Contents (left to right): brand mark (always present), search input (present on most pages, absent on home where hero search is primary), nav links (Browse, About, Support).
- Search on red: white background, transparent border, translucent white border + white shadow ring on focus. Nav links: 85% white opacity default, full white on hover, current page bold with 2px white underline 22px below baseline.

### CON-brand-mark

- **type:** protocol
- **source:** `.planning/source-docs/design-spec-v1.7.1.md` "Brand mark"
- **content:** Two-line typographic lockup. **No square monogram, no W icon.** Top line "Scholars" Charter serif 20px weight 600 white line-height 1 letter-spacing -0.005em. Bottom line "WEILL CORNELL MEDICINE" Inter sans 10px weight 600 letter-spacing 0.12em uppercase white at 82% opacity line-height 1. 4px spacing between lines, vertically centered in 60px header.

---

## ETL / runtime data-flow constraints

### CON-runtime-mysql-only

- **type:** protocol
- **source:** `.planning/source-docs/phase-1-design-decisions.md` ADR-006 (LOCKED)
- **content:** The Scholars application reads only MySQL at runtime. There is no runtime DynamoDB read path. ReCiterAI's DynamoDB output is consumed via minimal-projection ETL into MySQL. Single read store at runtime → operational simplicity, simpler local dev with one connection string, contract tests run against MySQL with no DynamoDB credentials in CI.

### CON-etl-staging-then-swap

- **type:** protocol
- **source:** `.planning/source-docs/phase-1-design-decisions.md` ADR-005 (LOCKED)
- **content:** Each ETL stages to a shadow table → validates row counts and required-field nulls → atomic-swaps to live tables. Validation rules from spec's per-source filtering logic — e.g., "ED data with 0 active scholars = abort". Prevents intra-source half-applied state without coupling sources to each other.

### CON-etl-chain-order

- **type:** protocol
- **source:** `.planning/source-docs/phase-1-design-decisions.md` ADR-005 (LOCKED)
- **content:** Daily ETL run order: **ED → ASMS → InfoEd → ReCiter (+ DynamoDB minimal-projection) → COI**. ED failure aborts the rest of the chain for that day. Other sources fail independently of one another.

### CON-etl-dynamodb-minimal-fields

- **type:** protocol
- **source:** `.planning/source-docs/phase-1-design-decisions.md` ADR-006 (LOCKED)
- **content:** Exactly two fields flow from DynamoDB → MySQL in Phase 1: `publication_score` (per scholar+pmid) and `topic_assignments` (per scholar — MeSH terms or topic clusters with weights). Other ReCiterAI outputs (identity-disambiguation confidence, inferred coauthorship, etc.) are explicitly out of scope for the v1 ETL. Principle: every flowing field is a contract-test surface, default to no.

---

## ED-field constraints (org units, appointments, status)

### CON-ed-org-unit-hierarchy

- **type:** protocol
- **source:** `.planning/source-docs/design-spec-v1.7.1.md` "Org unit and appointment fields"
- **content:** `weillCornellEduOrgUnit` has two levels: `level1` is parent unit, `level2` is sub-unit. Codes (`weillCornellEduOrgUnitCode`) are stable identifiers for joins; names are display values that may change.
- **For faculty (under `ou=faculty`):** `level1` = department name (e.g., "Medicine"); `level2` = division name when applicable (e.g., "General Internal Medicine") OR empty when only department-level appointment. `level1` always equals `weillCornellEduDepartment` for canonical case.
- **For doctoral students (under `ou=students`):** `level1` = "Graduate School" — uninformative, every PhD student has this. `level2` = educational program name (e.g., "Cell & Developmental Biology"). The `weillCornellEduProgram` field is the same as `level2` and is the meaningful display unit.

### CON-ed-fte-field

- **type:** protocol
- **source:** `.planning/source-docs/design-spec-v1.7.1.md` "Org unit and appointment fields"
- **content:** `weillCornellEduFTE` is numeric value 0–100 representing percent effort. Used in conjunction with ED person-type class to derive chip-row category. **Compound rule, not class-only:** Full-Time WCMC Faculty + FTE=100 → "Full-time faculty"; everything else with a faculty class → "Affiliated faculty".

### CON-ed-primary-entry-flag

- **type:** protocol
- **source:** `.planning/source-docs/design-spec-v1.7.1.md` "Org unit and appointment fields"
- **content:** `weillCornellEduPrimaryEntry` is boolean. Scholars with multiple appointments have one record marked TRUE; that record drives default sidebar display. The Appointments card on the profile lists all records, with the primary one marked.

### CON-ed-status-field

- **type:** protocol
- **source:** `.planning/source-docs/design-spec-v1.7.1.md` "Org unit and appointment fields"
- **content:** `weillCornellEduStatus` is colon-separated `{class}:{state}`. Class ∈ {`faculty`, `student`, ...}. State ∈ {`active`, `emeritus`, `on_leave`, `sabbatical`, ...} — full enumeration TBD with the data team. Used to derive the Status pill on profiles.

### CON-ed-title-field-students

- **type:** protocol
- **source:** `.planning/source-docs/design-spec-v1.7.1.md` "Org unit and appointment fields"
- **content:** For faculty, `title` is the personal academic title (e.g., "Professor of Clinical Medicine"). For students, it's a generic class label (e.g., "PhD Student") that is **not** display-worthy on its own. Display-time derivation rule for students: prefer `weillCornellEduTitleCode` (e.g., "G6") plus `weillCornellEduProgram` to produce a more informative line ("PhD candidate · Cell & Developmental Biology"). An "Expected {weillCornellEduExpectedGradYear}" suffix may appear when meaningful.

### CON-clinical-profile-link

- **type:** protocol
- **source:** `.planning/source-docs/design-spec-v1.7.1.md` "Data sources" + "Clinical profile URLs come from Enterprise Directory"
- **content:** When ED has a `webpage` attribute pointing to `weillcornell.org/{cwid}`, Scholars renders a "Clinical profile →" link in the profile Contact card. ED is the canonical source; Scholars does not validate or follow the link. Most full-time faculty with clinical practice have these; postdocs, doctoral students, basic-science-only faculty typically do not.

---

## Reciter-DB constraints

### CON-reciterdb-cwid-no-prefix

- **type:** protocol
- **source:** `.planning/source-docs/HANDOFF-2026-04-30.md` Lessons learned #3
- **content:** ReciterDB `personIdentifier` is **plain CWID — no `cwid_` prefix.** The `cwid_` prefix in the ReciterAI integration project is **DynamoDB-only** (PK uses `FACULTY#cwid_<cwid>`). The CLAUDE.md note about `WCM_FACULTY_UID_PREFIX` is DynamoDB-specific; ReciterDB does not share the convention.

### CON-reciterdb-modern-tables

- **type:** protocol
- **source:** `.planning/source-docs/HANDOFF-2026-04-30.md` "What I'd recommend" #3
- **content:** Use `analysis_summary_*` tables for ReciterDB joins (modern path). The institutional client uses `wcmc_*` legacy tables which don't exist in current ReciterDB. The `analysis_summary_*` join shape is documented in `etl/reciter/index.ts`.

### CON-coi-mysql-not-mssql

- **type:** protocol
- **source:** `.planning/source-docs/HANDOFF-2026-04-30.md` Lessons learned #5
- **content:** COI is on a **MySQL** RDS instance, not MSSQL. Hostname pattern `*-mysql-db.*` is the give-away. Worth being explicit in any new ETL inventory. Connection details: `v_coi_vivo_activity_group` view; reads only disclosure category and disclosed entity name.

### CON-infoed-query-runtime

- **type:** protocol
- **source:** `.planning/source-docs/HANDOFF-2026-04-30.md` Lessons learned #4
- **content:** InfoEd's full institutional grant query is a 30-table join across DBs and runs **~6 minutes**. `requestTimeout` needs to be 10+ minutes. In production, this should be batched, cached, or rewritten as a materialized view in the InfoEd-side warehouse.

---

## External-relationships (COI) constraints

### CON-external-relationships-scope

- **type:** protocol
- **source:** `.planning/source-docs/design-spec-v1.7.1.md` v1.5 changelog + "WCM COI disclosure system" data sources entry
- **content:** WCM's COI office manages disclosures of consulting, board service, equity holdings, royalties, and other external financial relationships per institutional policy and federal FCOI requirements. Phase 1 reads only the disclosure category and disclosed entity name (e.g., "Leadership Roles: ENYX Therapeutics LLC"). Other COI-system fields — disclosure dates, dollar amounts, management plans — are NOT surfaced on Scholars and are NOT requested in the integration.
- **categories (data-driven, defined by COI office):** Leadership Roles, Professional Services, Other Interests, Ownership, Proprietary Interest, with potentially additional categories per institutional policy.
- **section behavior:** Renders only when at least one disclosure exists. Disclosed entities are plain text — not linkable.
- **preamble committee-language treatment:** Per design spec v1.7.1 changelog, External relationships preamble moved to a content-constants treatment with a "do not edit without committee review" flag. Committee-authored language stays preserved verbatim.

---

## Pre-build open items (must close before build)

These are functional-spec-level open items the spec demands closure on prior to build start. They are NOT locked decisions.

| Item | Source | Status |
|---|---|---|
| Service-desk ticketing target on Support page (ServiceNow form vs email) | Functional spec line 307 | Open |
| VIVO URL-pattern audit | Functional spec line 308 | Open |
| Methodology page owner named | Design spec v1.2 changelog | Owner: TBD |
| Confirm `appointment_status_updated_at` availability with data team | Design spec v1.2 changelog | Open (binary commit-by-date answer requested) |
| ReCiter lead consultation on text relevance algorithm | Design spec v1.2 changelog | Target: 2 weeks out, before search-build kickoff |
| COI office conversation: integration pattern, refresh cadence, category vocabulary for External relationships | Design spec v1.5 changelog | Open |

---

## Implementation lessons (carry forward)

These are concrete technical findings from the prototype build that production must respect.

| Lesson | Source |
|---|---|
| Prisma 7 broke embedded engine model; driver adapter required (`@prisma/adapter-mariadb` works for both MySQL 8 and MariaDB Aurora) | HANDOFF Lessons #1 |
| Local MySQL needs CREATE/DROP at global level for Prisma's shadow-database migration drift detection. In production, dedicated migration user; runtime app user stays scoped to its own database. | HANDOFF Lessons #2 |
| Several password formats required unwinding (K8s Secret YAML base64-folded, `$` triggering shell expansion). Production should use AWS Secrets Manager / SSM Parameter Store. | HANDOFF Lessons #6 |
| Use single quotes for env values containing `$`, `` ` ``, `!`, or `\` — double quotes let zsh interpret. | HANDOFF "Environment variables" |
