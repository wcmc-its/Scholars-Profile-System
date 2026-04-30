# Scholars @ WCM — Design Spec (Phase 1)

_Last updated: 2026-04-29 (v1.7)_

## Executive summary

Scholars is the public-facing read-only research-information system at Weill Cornell Medicine, replacing VIVO. It surfaces three things: the people doing research at WCM, the publications they've produced, and the topics those publications cover. Phase 1 scope covers Profile, Search, Topic detail, Department detail, Browse hub, Home / Landing, and About pages — see [Status](#status) for the page-by-page sketch mapping.

**The five primitives that touch every page:** scholars (the umbrella term for everyone with a WCM appointment), publications (sourced via reciter-db's `analysis_summary_*` tables), topics (a 67-parent / ~2,000-subtopic taxonomy from ReCiterAI), departments and divisions (sourced from Enterprise Directory's org-unit hierarchy), and external relationships (sourced from WCM's COI disclosure system).

**Five chip-row role categories** govern how scholars are filtered and listed: Full-time faculty, Affiliated faculty, Postdocs & non-faculty, Doctoral students, and All. Per-row tags show the actual ED person-type for taxonomic detail. Algorithmic surfaces (Recent contributions, Top scholars in this area) are restricted to a smaller eligibility carve — Full-time faculty + Postdoc + Fellow + Doctoral student — even when other roles are co-authors on scored publications. The carve is deliberate and named explicitly throughout.

**Where to look first:** Cross-cutting decisions for the design tokens, role model, scoring rules, and data sources. Page specs for per-page structure. Components for shared patterns (role tag, scholar chip, status pill, External relationships section, Highlight selection formula). Open questions for unresolved items requiring outside input. Conversations in flight for cross-team work owed by named owners with target dates.

**Spec-precedence stack** when in doubt: this spec → sketches under `.planning/sketches/` → `DESIGN-FORKS.md` → Functional Spec.

## Changelog

### v1.7 — 2026-04-29

- **Curated tag tooltip forks by surface type.** Publication-centric surfaces (Topic Recent highlights, ReCiterAI sort options) keep the existing wording about co-author inheritance. Scholar-centric surfaces (Recent contributions, Top scholars chip row) get tooltip language that names the eligibility carve explicitly. Eliminates a contradiction with the methodology page.
- **Highlight formula calibration discipline.** Worked examples (three concrete cases) added to the formula component. Calibration owner named (ReCiter lead, in concert with the methodology page owner). Six-month post-launch review trigger committed to. Eliminates the "two engineers interpret the curve differently" risk.
- **Letters, Editorials, Errata hard-excluded** from highlight surfaces. Weight = 0 instead of 0.1. A 10× score gap can no longer rescue an erratum onto the home page contributions surface.
- **Conversations-in-flight target dates filled.** All four conversations now have committed target dates (subject to other-team bandwidth as appropriate).
- **Schema-change protocol for ReCiterAI integration.** New paragraph in Data sources committing to (a) ReCiterAI team giving 30 days advance notice on DynamoDB schema changes and (b) Scholars maintaining contract tests against expected DynamoDB response shapes that fail loudly in CI.
- **Search filter at leaf-level role:** decided as Phase 2. Phase 1 ships with the five chip categories as flat checkboxes; users wanting Voluntary Faculty specifically can free-text search "voluntary faculty cardiology" and rely on per-row role tag matching. Documented as a stated decision, not an oversight.
- **Absence-as-default monitoring.** Spec acknowledges the tradeoff of absence-as-default patterns (status pill, advisor card, AOI pills, External relationships, clinical profile link) for monitoring; commits to component-render logging in application logs for launch-day debugging. An OFA-facing coverage dashboard is deferred to Phase 2.
- **Sketch mapping table updated** with sketches 007 (Postdoc profile) and 008 (About page).
- **External relationships preamble** moved to a content-constants treatment with a "do not edit without committee review" flag. The committee-authored language stays preserved verbatim.
- **Org unit rename handling.** One-line note that codes (`weillCornellEduOrgUnitCode`) are the stable join key; renames update display names only and do not break attribution.
- **Division URL pre-selection** added as an explicit acceptance criterion (#19 expanded), so the Phase 1 routing behavior is tested on launch day rather than just spec'd.
- **Doctoral student count** flagged as a working assumption pending registrar confirmation.
- **Editorial copy ownership.** Top-300 division/subtopic descriptions assigned to "ITS plus an editor seconded from Comms (or contractor)"; two-week window committed for May 2026.
- **Executive summary** added at the top — the spec is now 100K+ characters and senior readers will skim. Anchors the skim.

### v1.6 — 2026-04-29

- **Highlight selection formula documented.** New component spec covering the shared formula (`reciterai_impact × authorship_weight × pub_type_weight × recency_weight`) and four surface-specific recency curves (Selected highlights, Recent highlights, Recent contributions, Top scholars chip row).
- **Authorship-position filter** for scholar-attributed surfaces. First or senior author only on profile Selected highlights and home page Recent contributions. Publication-centric surfaces (Topic page Recent highlights, Top scholars chip row) do not apply this filter.
- **Publication-type weighting** as soft preference. Academic Article = 1.0, Review = 0.7, Case Report = 0.5, Letter/Editorial/Erratum = 0.1 (effectively excluded). A transformative Review can still surface but must clear a higher bar than an Academic Article of equivalent score.
- **Two-stage recency curves keyed to surface intent.** "Recent" surfaces (home page contributions, topic page highlights) penalize papers under 3 months old (insufficient signal maturity) and peak at 3–18 months. Selected highlights skew older deliberately — peaks 18 months–10 years, excludes papers under 6 months entirely to avoid duplication with the most-recent-papers view immediately below.
- **Selected highlights and most-recent-papers dedup.** The two surfaces sit adjacent on the profile page and answer different questions ("what is this scholar known for" vs. "what is this scholar working on"). The recency curve for Selected highlights is shaped to avoid feature overlap rather than dedup-by-suppression.

### v1.5 — 2026-04-29

- **External relationships section added.** Major section on profile pages, near the bottom (after Publications and Grants, before any footer). Categories are data-driven from WCM's COI disclosure system — known categories include Leadership Roles, Professional Services, Other Interests, Ownership, and Proprietary Interest, with more category names defined by the COI office. Section renders only when at least one disclosure exists. Disclosed entities are plain text — not linkable.
- **WCM COI disclosure system** added as a fifth data source. Scoped narrowly to External relationships data. Refresh cadence TBD with the COI office; daily is the working assumption.
- **Clinical profile link.** New affordance in the Contact card: when Enterprise Directory carries a `weillcornell.org/{cwid}` clinical profile URL, render a "Clinical profile →" link below the email. Absent for scholars without a clinical profile (postdocs, doctoral students, most basic-science faculty).
- **Division detail pages added as a Phase 2 deliverable** — see [Open Questions](#open-questions). Phase 1 surfaces division-level information through the department detail page's divisions rail; users who land on a division URL get redirected to the parent department page with the corresponding division pre-selected.
- **Conversations in flight gains a fourth entry:** confer with the COI office on integration pattern, refresh cadence, and category vocabulary for External relationships ingestion.

### v1.4 — 2026-04-29

- **Jenzabar added as a fourth data source.** Scoped narrowly for Phase 1 to thesis advisor for doctoral students; Phase 2 may expand to committee members, dissertation title, and milestone progress. Refresh cadence daily.
- **Org unit and appointment fields documented.** New subsection under Data sources covering the Enterprise Directory `weillCornellEduOrgUnit;level1` / `level2` convention, FTE-based full-time derivation, primary-entry flag behavior, status field structure (`faculty:active` / `student:active` / etc.), and educational-program handling for students.
- **Compound chip-mapping rule for full-time vs. part-time faculty.** Mapping derives from the ED person-type class AND the FTE field, not class alone: Full-Time WCMC Faculty + FTE=100 → "Full-time faculty"; everything else with a faculty class → "Affiliated faculty" (with sub-cases for Part-Time, Voluntary, Adjunct, Courtesy, Lecturer, Emeritus, Instructor).
- **Student title derivation rule.** The ED `title` field for students is generic ("PhD Student") and not display-worthy. Display-time derivation prefers `weillCornellEduTitleCode` plus `weillCornellEduProgram` for a more informative line ("PhD candidate · Cell & Developmental Biology").
- **Department/division line component.** Three rendering modes specified under Components — faculty with level2, faculty without level2, students — plus the per-context middle-dot vs. em-dash separator convention.
- **Department/division facet rule.** The Search facet uses an adaptive flat list with em-dash disambiguation when collisions occur (`Cardiology — Medicine`). Departments and divisions are peer entries; not hierarchical. Filter semantics specified — checking a department matches everyone in it including all divisions.
- **Mentor / Advisor card component.** Documented under Components. Postdoc profiles show a "Postdoctoral mentor" card; doctoral student profiles show an "Advisor" card sourced from Jenzabar. Same component shape, different label and source.
- **Status pill behavior flip.** Acceptance criteria #9 updated: the pill is **absent** for default-active scholars and renders **only** when status is non-default (Emeritus, On leave, Sabbatical) AND ED data is fresh. Stale data renders nothing rather than falling back to "Active."
- **Copy citations component spec.** Vancouver as default format (medical school standard), with AMA, APA, BibTeX, and RIS as alternates. Modal pattern with format dropdown plus scope dropdown (current view / all). Phase 1 supports Vancouver + BibTeX; other formats deferred.
- **Areas of interest threshold rule.** AOI pills render only when 3+ publications are indexed with the keyword. Below threshold, the keyword is dropped from the pill set silently. Section-level "?" tooltip explains the derivation. Per-pill counts shown.
- **Large-author-list pattern.** New component spec — Vancouver-style truncation in the byline (first 3 + ellipsis + last 2) with a separate collapsible "+N WCM authors" expand showing only WCM-attributed authors as chips. Applies to publications with 6+ WCM authors or 10+ total authors.
- **About page existence as a Phase 1 deliverable.** Sketch 008 demonstrates structure; spec confirms it as a required page, not optional.

### v1.3 — 2026-04-29

- **Data sources:** new "Data sources" subsection under Cross-cutting decisions. Scholars reads from a Scholars-owned read store, populated via ETL from three upstream sources: Enterprise Directory (identity, role, appointments), reciter-db (publication attribution and metadata via `analysis_summary_author` and `analysis_summary_article`), and DynamoDB (ReCiterAI scoring and topic assignments). Scholars does NOT call ReCiter or ReCiterAI applications at request time.
- **Role model rewrite:** the four-category v1.1 model (Faculty / Postdocs / Research staff / Trainees) is replaced by a five-category model derived from Enterprise Directory's actual person-type taxonomy:
  - Full-time faculty
  - Affiliated faculty
  - Postdocs & non-faculty
  - Doctoral students
  - (plus "All" on chip rows)

  Per-row role tags show the actual ED type (Postdoc, Voluntary Faculty, Senior Research Scientist, etc.), so the underlying taxonomy stays visible at the individual level. Search filter uses the same four categories as flat checkboxes, not a two-tier hierarchy.
- **ReCiterAI scoring scope rewrite:** scoring is per-publication, not per-scholar. A publication is scored if at least one of its WCM-attributed authors holds a Full-Time WCMC Faculty appointment. Once scored, the score propagates to all WCM-attributed authors of that publication, regardless of role. Practical consequence: postdocs and other co-authors of full-time faculty publications inherit visibility on publication-centric algorithmic surfaces.
- **Algorithmic surface eligibility carve:** scholar-centric algorithmic surfaces (Recent contributions, Top scholars in this area) are restricted to Full-time faculty + Postdoc + Fellow + Doctoral student — even when other roles are attributed co-authors on scored publications. This carve cuts across the chip categories (Postdocs & non-faculty includes four ED types; only Postdoc and Fellow qualify) and is named explicitly in the spec.
- **Voluntary / Adjunct / Courtesy faculty visibility:** these scholars never appear on scholar-centric algorithmic surfaces. They appear on enumerative surfaces (search, browse, department lists, non-AI sorts on topic pages). The spec makes this consequence visible rather than burying it.
- **Status pill data source:** moves from MARIA to Enterprise Directory. The freshness threshold (non-default status renders only when the appointment record was updated in the last 6 months) now references ED's appointment-status fields rather than MARIA's.
- **Conversations in flight rescoped:** the data team conversation is now about Enterprise Directory's appointment-currency attributes, not MARIA APIs.
- **Recent contributions surface labels and tags:** the "Six WCM faculty..." rule reverts to "Six WCM scholars..." (the v1.0 framing) because postdocs and doctoral students legitimately appear here. Role tags added to contribution cards so the role mix is user-visible. Topic page hero label "TOP FACULTY IN THIS AREA" reverts to "TOP SCHOLARS IN THIS AREA."
- **Curated tag tooltip:** updated to reflect publication-level scoring + co-author inheritance: *"Ranked by ReCiterAI weekly. Scoring covers publications co-authored by full-time WCM faculty; co-authors inherit visibility regardless of role."*

### v1.2 — 2026-04-29

- **Publication-type filter scope (Open Q #11):** decided. Filter applies to the entire topic page consistently, regardless of sort — not just Newest. A visible toggle lets users opt into the full corpus.
- **Toggle wording:** affirmative phrasing — "Including research articles, reviews, case reports, and preprints. [Show editorials and other types →]" — replaces the originally drafted "Show all · N hidden" framing. Toggle state is per-page, not session-sticky.
- **Acceptance criteria backfilled:** items extended to cover the publication-type filter, unlinked author chip variant, status pill freshness threshold, and the centers placeholder route. New items added for Lighthouse accessibility audits.
- **Editorial copy strategy:** added "Suggest an edit →" affordance for hand-curated descriptions on top-tier pages, routing to a generic Comms / OFA feedback form. Stub pages (long tail) do not surface this affordance.
- **Methodology page owner:** named as a circulation blocker — this document does not get circulated to Mohammad's team until the methodology-page owner is named.
- **Conversations owed (in flight):** data team for `appointment_status_updated_at` availability (binary commit-by-date answer requested); ReCiter lead for text relevance algorithm (consultation target: two weeks out, before search-build kickoff).

### v1.1 — 2026-04-28 (post-review pass)

- **Curated tag:** tooltip now discloses freshness ("ranked weekly") alongside scope.
- **Status pill:** added MARIA freshness rule — non-default status renders only when appointment data updated in last 6 months; otherwise falls back to "Active." Conversation owed to data team.
- **Recent contributions citations:** decided. Citations stripped from home page contribution cards, matching topic page Recent highlights.
- **Trainee author chips (in v1.2 framing):** spec'd a non-clickable variant — same visual (avatar + name), no link, no hover. v1.3 generalizes this to any author without a profile page, since the v1.3 role model removed Trainees as a distinct category.
- **Methodology page:** owner field added (TBD, name before circulation). Decision-by date placeholder.
- **Editorial copy strategy:** consolidated department, division, and subtopic descriptions into one Open Question. Decided approach: top ~300 entries hand-written in-house (~2 weeks), long tail gets stub treatment, no "help us describe →" prompt on tail pages.
- **Search relevance:** restructured as process-first — confer with ReCiter lead before committing to algorithm. Default proposal (BM25 + dense biomedical embedding + faculty-status boost) flagged as pending consultation.
- **Center / institute detail pages:** decided as Phase 2. Phase 1 ships a thin placeholder route at `/centers/{slug}` so browse-hub links don't break. Rationale: centers don't have a clean parent-child structure (no equivalent of "divisions"), so reusing the department template would build on a different / less-tested data model.
- **"View all N scholars in this area →":** new affordance language replacing "+ N more scholars →"; uses explicit total count to signal a different denominator, not "more of the same."
- **What's-missing dismissal:** clarified — dismissal persists per-user; checklist re-appears when a new "missing" item enters scope.
- **Open Q #11 added:** Publication-type filter on topic page Newest sort. Decided in principle ("research articles only" — Academic Article / Review / Case Report / Preprint; not Letter / Editorial / Erratum). Scope of filter (Newest sort only vs. topic page consistently) pending decision.

## Status

This document captures **implementation-level design decisions** for the Scholars @ WCM Phase 1 build (the read-mostly, public-facing replacement for VIVO). It is the layer below the [Charter](Scholars%20Project%20Charter.docx) and the [Functional Spec](Scholars%20Functional%20Spec%20-%20Phase%201.md), and the layer above the working sketches in `.planning/sketches/`.

Decisions here override anything that conflicts in `DESIGN-FORKS.md` (April 2026), which captured the major fork choices but predates the implementation review pass.

**Coding agent's source-of-truth precedence (highest first):**
1. This spec (decisions)
2. The HTML sketches under `.planning/sketches/` (visual ground truth for layout, spacing, transitions)
3. DESIGN-FORKS.md (background and rationale)
4. Functional Spec (data model and routes)

When there's a conflict between the spec and the sketches, file an issue rather than picking one — the spec should be updated to match the intended visual, or the sketch was mistaken.

**Sketch → page mapping:**

| Sketch | Page type | Status |
|---|---|---|
| `001-revised-senior` | Profile (senior faculty case) | Reviewed |
| `002-revised` | Search results | Reviewed |
| `003-revised` | Home / landing | Reviewed |
| `004-revised` | Topic detail | Reviewed |
| `005-browse` | Browse hub | Reviewed |
| `006-department` | Department detail | Reviewed |
| `007-profile-postdoc` | Profile (postdoc, thin record case) | Reviewed |
| `008-about` | About page | Reviewed |

---

## Cross-cutting decisions

### Data sources

Scholars reads from a **Scholars-owned read store**, not from upstream applications at request time. The read store is populated via scheduled ETL from five upstream sources, plus event-driven refresh on data that changes quickly.

| Source | Tables / endpoints | What Scholars uses it for |
|---|---|---|
| Enterprise Directory | (existing sync pattern, likely via Janus or direct LDAP) | Identity: name, title, primary appointment, department, division, email, role / person-type, appointment-status freshness, clinical profile URL when populated |
| reciter-db (MySQL) | `analysis_summary_author`, `analysis_summary_article` | Author–publication attribution and publication metadata |
| DynamoDB (ReCiterAI) | scoring + topic/subtopic assignment tables | Per-publication ReCiterAI scores, topic/subtopic assignments, anything driving Curated surfaces |
| Jenzabar | (integration pattern TBD — REST API or nightly export) | Doctoral student-specific fields: thesis advisor (Phase 1); committee members, dissertation title, milestone progress (Phase 2 candidates) |
| WCM COI disclosure system | (integration pattern TBD with COI office) | External relationships disclosures — categories and disclosed entities per scholar |

**Scholars does NOT call** ReCiter the application or ReCiterAI the application directly. Both are write-side compute pipelines; their outputs reach Scholars via the databases they write to. This decoupling protects page latency from the noise of pipeline runs and gives Scholars a stable read contract.

**Identity is sourced from Enterprise Directory, not reciter-db.** ReCiter's `identity` table is a derived view that exists for ReCiter's attribution purposes. Enterprise Directory is the institutional source of truth — Scholars pulls from there directly so it sees the same identity data that downstream consumers (MARIA, IDM) see, without an extra hop.

**Jenzabar handles student-specific data only.** Doctoral students appear in Enterprise Directory under `ou=students` with their educational program in `weillCornellEduOrgUnit;level2`, but the thesis advisor relationship is not in ED. It lives in Jenzabar (WCM's student information system) alongside enrollment, grades, and program milestones. Phase 1 ingests thesis advisor only; the broader Jenzabar surface area (committee, dissertation title, etc.) remains a Phase 2 candidate. Faculty, postdocs, and research staff have no dependency on Jenzabar.

**The COI disclosure system is scoped to External Relationships only.** WCM's COI office manages disclosures of consulting, board service, equity holdings, royalties, and other external financial relationships per institutional policy and federal FCOI requirements. Phase 1 reads only the disclosure category and disclosed entity name (e.g., "Leadership Roles: ENYX Therapeutics LLC"). Other COI-system fields — disclosure dates, dollar amounts, management plans — are not surfaced on Scholars and are not requested in the integration. The category vocabulary is data-driven (defined by the COI office, not hardcoded in the spec) and includes at least Leadership Roles, Professional Services, Other Interests, Ownership, and Proprietary Interest with potentially additional categories per institutional policy.

**Clinical profile URLs come from Enterprise Directory.** When ED has a `webpage` attribute pointing to `weillcornell.org/{cwid}`, Scholars renders a "Clinical profile →" link in the profile Contact card. ED is the canonical source; Scholars does not validate or follow the link, just surfaces it. Most full-time faculty with clinical practice have these; postdocs, doctoral students, and basic-science-only faculty typically do not.

**A thin data-access layer abstracts DynamoDB calls** behind domain methods (`getPublicationScore(pmid)`, `getTopicAssignmentsForPublication(pmid)`, etc.) so a future DynamoDB schema change is a one-file fix in Scholars rather than scattered across components. Same pattern for the reciter-db queries and the Jenzabar pull.

**Schema-change protocol for upstream sources.** The decoupling above protects Scholars from minor source changes but does not prevent breaking changes (renamed fields, dropped tables, restructured documents). Two complementary commitments mitigate this:

1. **Advance notice.** The ReCiterAI team commits to 30 days advance notice on DynamoDB schema changes that affect fields Scholars reads. The data team and Jenzabar integration owner commit to similar notice for Enterprise Directory, reciter-db, and Jenzabar field changes. Notice goes through a shared changelog or mailing list — implementation owner TBD with each team.
2. **Contract tests.** Scholars maintains contract tests in CI that validate expected response shapes from each upstream source. Tests fail loudly when a field is missing, renamed, or restructured, surfacing schema drift before it reaches production. Contract tests are scoped into Phase 1 and run on every Scholars build plus a daily scheduled run against live source data.

The combination is belt-and-suspenders: notice when the sources play well, contract-test failures when they don't.

**Codes are the stable join key.** Org unit codes (`weillCornellEduOrgUnitCode`), department codes (`weillCornellEduDepartmentCode`), program codes (`weillCornellEduProgramCode`), and similar are stable identifiers. Display names (`weillCornellEduOrgUnit`, `weillCornellEduDepartment`) may change — when "Medicine" is renamed to "Internal Medicine," the code stays the same and Scholars's join keys are unaffected; only the display string updates on the next sync. Implementation should always join on codes, never on display names.

**Refresh cadences:**

| Data | Cadence |
|---|---|
| Identity, appointments, role / person-type | Daily |
| Publication attribution (`analysis_summary_author`) | Daily |
| Publication metadata (`analysis_summary_article`) | Daily |
| Jenzabar (thesis advisor) | Daily |
| COI disclosures | Daily (working assumption; confirm with COI office) |
| ReCiterAI scores and topic assignments | Weekly (matches ReCiterAI write cadence to DynamoDB) |

**Implication for the "Curated" tag tooltip:** the spec contracts on what's in DynamoDB at read time, not on the latest computation by ReCiterAI. If ReCiterAI ever decouples its scoring cadence from its DynamoDB write cadence, Scholars sees the flushed view.

### Org unit and appointment fields

Enterprise Directory exposes a structured view of each scholar's appointment that Scholars's display logic depends on. Documented here so the implementation doesn't have to derive these rules from individual sketches.

**Org unit hierarchy (`weillCornellEduOrgUnit`).** Two levels: `level1` is the parent unit, `level2` is the sub-unit. Codes (`weillCornellEduOrgUnitCode`) are stable identifiers for joins; names are display values that may change.

For faculty (records under `ou=faculty`):
- `level1` = department name (e.g., "Medicine")
- `level2` = division name when applicable (e.g., "General Internal Medicine") OR empty when the scholar has only a department-level appointment (e.g., department chairs, smaller departments without divisions)
- `level1` always equals `weillCornellEduDepartment` for the canonical case

For doctoral students (records under `ou=students`):
- `level1` = "Graduate School" — uninformative, every PhD student has this
- `level2` = educational program name (e.g., "Cell & Developmental Biology")
- The `weillCornellEduProgram` field is the same as `level2` and is the meaningful display unit

**FTE field (`weillCornellEduFTE`).** Numeric value 0–100 representing percent effort. Used in conjunction with the ED person-type class to derive the chip-row category (see [Scholar role model](#scholar-role-model)).

**Primary entry flag (`weillCornellEduPrimaryEntry`).** Boolean. Scholars with multiple appointments (joint appointments, secondary affiliations) have one record marked TRUE; that record drives default sidebar display. The Appointments card on the profile lists all records, with the primary one marked.

**Status field (`weillCornellEduStatus`).** Colon-separated structure: `{class}:{state}`. Class is one of `faculty`, `student`, etc. State is one of `active`, `emeritus`, `on_leave`, `sabbatical`, etc. — full enumeration TBD with the data team. Used to derive the Status pill on profiles.

**Title field (`title`).** For faculty, this is the personal academic title (e.g., "Professor of Clinical Medicine"). For students, it's a generic class label (e.g., "PhD Student") that is **not** display-worthy on its own. Display-time derivation rule for students: prefer `weillCornellEduTitleCode` (e.g., "G6" for sixth-year PhD) plus `weillCornellEduProgram` to produce a more informative line such as "PhD candidate · Cell & Developmental Biology". An "Expected {weillCornellEduExpectedGradYear}" suffix may appear when meaningful.

**Role classification (`weillCornellEduRole`).** WCM-internal role classification within faculty (Clinical Excellence / Research-track / Teacher-track / etc.). Ingested into the read store as a secondary attribute but not surfaced in Phase 1 UI. Phase 2 may use it for filtering (e.g., "research-track faculty in Cardiology" for funding committees).

### Palette

Cornell Big Red is the **institutional accent**, reserved for high-prominence moments only:

- The full-bleed header band
- The brand mark
- The "Curated" tag on ReCiterAI-driven surfaces

**Slate (`#2c4f6e`) is the working accent** for everything else: links, focus rings, rail-active states, hover colors, active filter chips, page-internal eyebrow labels.

This is a deliberate concentration. The original "Cornell red across all interactive elements" treatment made the page feel like Cornell undergrad recruiting; concentrating red to header + curated moments lets the rest of the page read as a refined research database.

CSS variables (canonical, used across all sketches):

```css
:root {
  /* Surfaces */
  --color-bg: #ffffff;
  --color-surface: #ffffff;
  --color-surface-alt: #f7f6f3;
  --color-surface-tint: #fafaf8;
  --color-border: #e3e2dd;
  --color-border-strong: #c8c6be;

  /* Text */
  --color-text: #1a1a1a;
  --color-text-secondary: #4a4a4a;
  --color-text-muted: #757575;

  /* Cornell red - reserved use */
  --color-primary: #B31B1B;
  --color-primary-hover: #8c1414;
  --color-primary-light: #faf3f3;

  /* Slate - the workhorse */
  --color-accent: #2c4f6e;
  --color-accent-light: #eaf0f5;
  --color-accent-hover: #1f3b53;
  --color-link: #2c4f6e;
  --color-link-hover: #1f3b53;

  /* Status */
  --color-success: #2f7d3f;
  --color-success-light: #ebf5ed;
  --color-warning: #b07300;
  --color-warning-light: #fdf6e3;
}
```

**This palette is a placeholder until WCM brand standards are published.** When real standards land, swap the values. The variable structure stays — components reference `--color-accent` and `--color-primary`, not raw hex.

### Typography

Two faces.

**Inter** for all body text, navigation, UI controls, paragraphs, lists. The default `--font-sans` stack is:

```css
--font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI',
             Roboto, 'Helvetica Neue', Arial, sans-serif;
```

**Charter** (with fallbacks) for the brand mark, page H1s, and hero titles. The default `--font-display` stack is:

```css
--font-display: 'Charter', 'Tiempos Headline', Georgia, serif;
```

Charter is preinstalled on macOS and iOS (the majority of academic users). Georgia is the universal fallback. If a real web font is licensed (Tiempos Headline, Lyon Display, Source Serif), it should replace the first stack entry; the fallbacks stay.

The serif treatment is the single visual element distinguishing Scholars from generic medical school sites. Apply only to:
- Brand mark "Scholars" line in the header
- Page H1s on browse, department, profile (not topic, see below)
- Hero titles on topic detail and department detail (already applied)

Do not apply serif to body text, lists, table content, or buttons.

### Header

Full-bleed Cornell red band, sticky at the top of every page, 60px tall.

```css
.wcm-header {
  position: sticky; top: 0; z-index: 50;
  background: var(--color-primary);
  border-bottom: 1px solid rgba(0, 0, 0, 0.15);
  box-shadow: inset 0 -1px 0 rgba(255, 255, 255, 0.08);
  height: 60px;
}
```

Contents (left to right):
1. Brand mark (always present)
2. Search input (present on most pages; absent on home where the hero search is the primary)
3. Nav links: Browse, About, Support

**Search input on red background:**
- White background, transparent border by default
- Translucent white border + white shadow ring on focus (`rgba(255, 255, 255, 0.6)` border, `0 0 0 3px rgba(255, 255, 255, 0.25)` shadow)
- Search-icon glyph (⌕) inset 12px from left, muted text color

**Nav links:**
- 85% white opacity by default
- Full white on hover
- Current page (`.is-current`): full white, bold weight, with a 2px white underline 22px below the link baseline

### Brand mark

Two-line typographic lockup. **No square monogram, no W icon.** The icon was decorative and added no information.

```html
<a href="/" class="wcm-header__brand">
  <span class="wcm-header__brand-mark">Scholars</span>
  <span class="wcm-header__brand-tag">Weill Cornell Medicine</span>
</a>
```

Top line ("Scholars"): Charter serif, 20px, weight 600, white, line-height 1, letter-spacing -0.005em.

Bottom line ("WEILL CORNELL MEDICINE"): Inter sans, 10px, weight 600, letter-spacing 0.12em, uppercase, white at 82% opacity, line-height 1.

Stacked with 4px spacing between lines, vertically centered in the 60px header.

The mark is always a link to the site root.

### Scholar role model

This is the data-model decision that touches every list-of-people surface in the system.

The umbrella term throughout the UI is **scholars**. It encompasses everyone who holds a WCM appointment of any kind. Counts on aggregate surfaces ("872 scholars in the Department of Medicine") use this term unless explicitly filtered.

Each scholar's role is sourced from Enterprise Directory's person-type taxonomy, which has 12 leaf-level categories. For UI purposes, these are grouped into **five chip-row categories**:

| Chip / filter | Derivation rule | Approx count |
|---|---|---|
| Full-time faculty | `Full-Time WCMC Faculty` class AND `weillCornellEduFTE = 100` | ~2,211 |
| Affiliated faculty | Any faculty class not meeting the Full-time rule above. Includes: Part-Time WCMC Faculty, Voluntary Faculty, Adjunct Faculty, Courtesy Faculty, Faculty Member Emeritus, Instructor, Lecturer. Also catches the rare edge case of `Full-Time WCMC Faculty` with FTE<100. | ~5,000 |
| Postdocs & non-faculty | `Postdoc`, `Fellow`, `Non-Faculty Academic`, `Non-Academic` classes | ~1,731 |
| Doctoral students | Records under `ou=students` in Enterprise Directory (distinct from `ou=faculty`); identifies via `weillCornellEduDegreeCode = PHD` or similar | ~500 — working assumption pending registrar confirmation |
| All | (chip row only — search filter expresses "all" as no checkboxes selected) | — |

**The chip mapping is a compound rule, not a class-only lookup.** The ED person-type class alone is insufficient to determine "Full-time faculty" because a scholar may hold a Full-Time WCMC Faculty appointment with FTE<100 (transitional or partial cases). The implementation must check both fields. Same caution applies if ED ever distinguishes "Postdoc on training fellowship" from "Postdoc as career step" — the chip mapping is a UI grouping, not a one-to-one shadow of ED's structure.

**Per-row role tags show the actual ED type, not the chip category.** A row for Marcus Vargas shows "Postdoc" specifically, not "Postdocs & non-faculty." A row for a Voluntary Faculty member shows "Voluntary Faculty," not "Affiliated faculty." This keeps the chip-row coarse for navigation while the per-row tag preserves taxonomic detail.

**Why these particular groupings:**

The Full-time / Affiliated split is the most institutionally meaningful one at WCM. Full-Time WCMC Faculty are on WCM payroll, on the formal academic ladder, with the central research-and-teaching mandate. Affiliated faculty (Voluntary, Adjunct, Courtesy, etc.) hold faculty appointments but their primary work is elsewhere — NYP-employed clinical practice, cross-institutional appointments, retired emeritus status, or teaching-focused Instructor/Lecturer roles. Conflating them as "Faculty" loses information that matters; surfacing them as a separate chip lets the UI be honest.

Postdocs & non-faculty groups four ED types (Postdoc, Fellow, Non-Faculty Academic, Non-Academic) because the institutional differences between them (training appointment vs. career staff appointment) matter less to the average user than the practical fact that all four are doing research work without a faculty title. The per-row tag preserves the distinction for users who care.

Doctoral students are surfaced as their own category because they're a distinct stage in the research-training pipeline and because their appearance on algorithmic surfaces (Recent contributions, Top scholars in this area) is part of the inclusivity story Scholars is trying to tell.

**Implementation expectations:**

- Every list view that shows people displays role tags on each row (see [Components](#components) for the role tag spec).
- Filters that select on role appear as chip-row controls above the list (`[All N] [Full-time faculty N] [Affiliated faculty N] [Postdocs & non-faculty N] [Doctoral students N]`), with "All" as default.
- The Search results filter uses the same five categories as **flat checkboxes** (no two-tier hierarchy), with "All" expressed as no checkboxes selected. See [Search results](#4-search-results-searchqquery).
- Counts on aggregate stats (department hero, topic stats) use "scholars" unless context explicitly filters to a role.

**Algorithmic surface eligibility carve.** Scholar-centric algorithmic surfaces — Recent contributions on the home page and Top scholars in this area on the topic page — are restricted to a smaller population than the chip categories suggest:

- Full-Time WCMC Faculty
- Postdoc
- Fellow
- Doctoral student

This carve cuts across the chip categories. The "Postdocs & non-faculty" chip groups four ED types but only Postdoc and Fellow qualify for these surfaces. The "Affiliated faculty" chip doesn't qualify at all — voluntary faculty members who first-author Nature papers with full-time PIs do not appear on Recent contributions, even though their paper is scored. This is a deliberate scoping choice (the surface celebrates research-mandate scholars, not clinical or affiliated contributors) and the spec names it explicitly so it isn't a surprise.

The methodology page covers this carve in plain English; see [Open Q #1](#1-methodology-page-content).

**Open question (spec-level):** Does every role get a profile page? Full-time faculty: yes. Postdocs and Fellows: yes. Affiliated faculty: yes (they're real WCM appointments). Non-Faculty Academic and Non-Academic: probably yes (often de facto lab leads). Doctoral students: yes. Pure ED-only entries with no `analysis_summary_author` rows: arguably no. See [Open Questions](#open-questions).

### ReCiterAI scoring scope

**ReCiterAI scoring is per-publication, not per-scholar.**

A publication is scored by ReCiterAI if at least one of its WCM-attributed authors holds a Full-Time WCMC Faculty appointment in Enterprise Directory. Once a publication is scored, the score propagates to all WCM-attributed authors of that publication — including non-full-time co-authors.

Three rules fall out of this:

1. **Publication-centric algorithmic surfaces** (Topic page Recent highlights, Topic page sort options "ReCiterAI Impact" and "Curated by ReCiterAI") show all scored publications regardless of who the authors are. Author chips on those publications include all attributed WCM authors at their actual roles.

2. **Scholar-centric algorithmic surfaces** (Home page Recent contributions, Topic page hero scholars row) are restricted to a smaller eligibility set: Full-time faculty + Postdoc + Fellow + Doctoral student. A scholar must hold one of these four roles AND be an attributed first or senior author on a recently scored publication. See [Scholar role model](#scholar-role-model) for the rationale.

3. **Voluntary, Adjunct, Courtesy, Instructor, Lecturer, and Emeritus faculty** never appear on scholar-centric algorithmic surfaces. They appear on enumerative surfaces (search, browse, department lists, non-AI sorts on topic pages) like everyone else. A voluntary faculty member who first-authors a Nature paper with a full-time PI: their paper is scored and surfaces under publication-centric algorithmic sorts, but the scholar themselves does not surface on Recent contributions.

**Surface-by-surface application:**

| Surface | Eligibility |
|---|---|
| Home Recent contributions | Scholar-centric carve (Full-time faculty + Postdoc + Fellow + Doctoral student) |
| Topic page hero scholars row | Same scholar-centric carve |
| Topic page Recent highlights | All scored publications; author chips show actual attributed WCM authors at their actual roles |
| Topic page sort: "ReCiterAI Impact" | Same — publication-centric |
| Topic page sort: "Curated by ReCiterAI" | Same |

Surfaces that do NOT depend on ReCiterAI and handle all scholars equally:
- Search results (text-match indexing)
- Browse A-Z directory (enumeration)
- Department scholar list (enumeration with role chip)
- Topic page subtopic rail and full publication feed Newest / Most-cited sorts
- Per-publication author chips on enumerative surfaces

**The methodology page** ([Open Q #1](#1-methodology-page-content)) explains all three rules in plain English so users hovering "How this works" can understand why a given page shows what it shows.

### Algorithmic surface guidelines

Whenever an algorithmic rule drives the content of a surface, three requirements:

1. **The rule is visible on the page** in plain English, not buried in a methodology page. Example: *"Eight subtopics with the strongest recent activity at WCM, one per parent area, refreshed weekly."*

2. **A "How this works" / "methodology" link points to a real page** that explains the rule, the data, and the scoring scope. **This methodology page must exist before launch.** A dead methodology link is the single most credibility-damaging element on these pages.

3. **Citation counts are not displayed on "recent" surfaces.** Recent papers haven't accumulated citations; showing the count creates a perverse bias toward older work and makes the surface feel stale. This applies to:
   - Topic page Recent highlights
   - Home page Recent contributions
   - Any future "recent" surface

   Citation counts are still appropriate elsewhere (full publication feed sort by citations, profile page Selected highlights, search publication results) where the comparison is among papers of varying ages.

### "Curated" tag

The visible UI element that signals AI-driven selection on a surface. The tooltip language **forks by surface type** because the eligibility rules differ — see [ReCiterAI scoring scope](#reciterai-scoring-scope) for the underlying carve.

**Publication-centric surfaces** — Topic page Recent highlights, Topic page sort options ("ReCiterAI Impact", "Curated by ReCiterAI"). The selection is over publications, not scholars; all attributed WCM authors appear on returned publications regardless of role.

```html
<!-- Publication-centric tooltip -->
<span class="curated-tag">
  Curated
  <span class="curated-tag__info" title="Ranked by ReCiterAI weekly. Scoring covers
    publications co-authored by full-time WCM faculty; co-authors of those publications
    appear regardless of role.">i</span>
</span>
```

**Scholar-centric surfaces** — Home page Recent contributions, Topic page Top scholars in this area chip row. The selection is over scholars, restricted to the eligibility carve (Full-time faculty + Postdoc + Fellow + Doctoral student). Voluntary, Adjunct, Courtesy, Instructor, Lecturer, and Emeritus faculty never appear on these surfaces even when they are co-authors on scored publications.

```html
<!-- Scholar-centric tooltip -->
<span class="curated-tag">
  Curated
  <span class="curated-tag__info" title="Ranked by ReCiterAI weekly. Surfaces full-time
    faculty, postdocs, fellows, and doctoral students whose recent first-author or
    senior-author work has been scored.">i</span>
</span>
```

The freshness disclosure ("weekly") matters for the same credibility reason as the scope disclosure: a user who refreshes hourly and sees no change should understand why. The eligibility disclosure on scholar-centric surfaces matters because otherwise a user wonders "why isn't Dr. X (Voluntary Faculty) on Recent contributions when their NEJM paper appears on the Topic page?" — and the methodology page has to do the explaining work that the tooltip should do inline.

Visual: title-case "Curated" (not all-caps), slate-light background, slate text, small "i" info icon. Same component class regardless of which tooltip variant is active.

**Avoid:**
- "RECITERAI" or "AI" in the visible tag (engineering-flavored, alarming)
- All-caps treatments (system-warning feel)
- Red color (overloads the brand red and creates urgency the surface doesn't warrant)

The tag appears only when an AI sort or AI selection is active. On the topic page publication feed, it appears when sort = "ReCiterAI Impact" or "Curated by ReCiterAI"; it disappears for "Newest" or "Most cited."

### Default sorts

| Surface | Default sort | Rationale |
|---|---|---|
| Topic page publication feed | **Newest** | Reproducibility (deterministic ordering across visits). User can opt into AI sort. |
| Search results | **Relevance** | Standard expectation for search. (See open question on relevance algorithm.) |
| Department faculty list | **Relevance** | Same. Surfaces division leadership and most-active first. |
| Profile publication list (year-grouped) | Most-recent year expanded | Section-level interaction, not a sort. |
| Browse A-Z | Alphabetical | Definitional. |

The earlier consideration to default the topic page to "Curated by ReCiterAI" was rejected for reproducibility reasons: a user who finds a paper at position 3 today should find it at position 3 tomorrow. AI-curated rankings can shift with retraining and recency decay; they should be opt-in.

---

## Page specs

### 1. Home / Landing (`/`)

**Sketch:** `003-revised`

**Purpose:** Front door. Two distinct discovery surfaces (curated research + structured taxonomy) plus a third (people behind recent contributions).

**Page structure:**
1. Header
2. Hero: large H1 "Scholars at Weill Cornell Medicine", subtitle, big search input, search-suggestion chips
3. Stats strip: `3,247 scholars · 184,512 publications · 67 research areas`. Single-line, muted, centered.
4. **Selected research** (carousel): 8 subtopic cards in a horizontal scroll-snap carousel. Each card shows parent topic, subtopic name, count, and 2 representative publications.
5. **Recent contributions** (faculty grid): 6 faculty cards in a 3×2 grid (responsive: 2×3 on tablet, single column on mobile). Each card shows photo, name, title, the contribution itself (paper title), and journal · year · authorship role. **No citation counts.** (This is now a decision, not an open question — same logic as Recent highlights on the topic page: recent papers haven't accumulated citations, so the metric biases toward older work and makes the surface feel stale.)
6. **Browse all research areas** (topic grid): All 67 parent topic names + counts, in 4 columns.
7. Footer

**Selection rules (visible on page):**

- Carousel: *"Eight subtopics with the strongest recent activity at WCM, one per parent area, refreshed weekly."*
- Recent contributions: *"Six WCM scholars whose recent first-author or senior-author work appeared in top-tier venues, one per research area. Refreshed weekly."* Eligibility: Full-time faculty + Postdoc + Fellow + Doctoral student (see [ReCiterAI scoring scope](#reciterai-scoring-scope)). Selection driven by the [Highlight selection formula](#highlight-selection-formula) with the Recent contributions recency curve and a one-per-parent-research-area dedup constraint. Cards show a per-row role tag next to each scholar's name so the role mix (faculty, postdoc, doctoral student) is user-visible — this is the inclusivity story the surface is telling.

Both link to a "How this works" methodology page.

**Key behaviors:**
- Carousel arrows visible (white circles with shadow, hover-grow), scroll by 2 cards per click, scroll-snap to start of next card.
- Search input has slate focus ring (not red) — the hero is on a tinted gradient surface, not the red header band.
- Search suggestions are pill chips, clickable, prefilling the search.

**Open question for this page:** see [Recent contributions citation strip](#open-questions).

### 2. Topic detail (`/topics/{slug}`)

**Sketch:** `004-revised`

**Purpose:** A user lands on a research topic ("Aging & Geroscience"). Surface the people, the recent work, and the substructure (subtopics).

**Page structure:**
1. Header
2. Crumbs: Home › Topics › Aging & Geroscience
3. **Hero:**
   - Eyebrow: "RESEARCH AREA" (slate uppercase)
   - H1 in serif: topic name
   - Description (1 paragraph, 70ch max)
   - Eyebrow: "TOP SCHOLARS IN THIS AREA"
   - Scholar chip row: 7 faculty chips (photo, name, sub-area), plus a **"View all N scholars in this area →"** affordance leading to a full directory listing scoped to this topic
   - Stats line (dashed-divider top): publications · subtopics · active funding (if available)
4. **Recent highlights:** 3 papers in a 3-column row. Each shows subtopic kicker, paper title, author, journal · year. **No citations.** Caveat line: "Three publications surfaced by ReCiterAI · how this works". Selection driven by the [Highlight selection formula](#highlight-selection-formula) with the Recent highlights recency curve.
5. **Layout B** (rail + main column):
   - **Rail:** Subtopic list, sorted by pub count descending. n≤10 subtopics get muted opacity (`0.6`) and sit below a "Less common" divider. Filter input at top.
   - **Main:** Single feed header (subtopic title + description as one paragraph + count + sort dropdown right-aligned). Below: publication feed.
6. Footer

**The "View all N scholars in this area →" affordance** correctly uses "scholars" because it leads to a directory listing that includes postdocs and research staff, who are first-class in enumerative views. The hero chip row is faculty-only by selection rule (ReCiterAI scope). The link wording explicitly uses the **total** count (not "+ N more") so users don't expect the larger list to be more of the same — it's a different denominator (all roles vs. faculty), and the explicit number signals that.

**Sort options (in order):** Newest (default), Most cited, By impact (ReCiterAI), Curated by ReCiterAI. The "Curated" tag appears next to the section title only when one of the AI sorts is active.

**Subtopic descriptions** (in the consolidated feed header) — these need to be hand-curated. There are roughly 30 × 67 = 2,010 of them across the system. Phase 1 plan: launch with descriptions for the top ~300 (by pub count), surface a "help us describe this subtopic →" affordance for the rest. See [Open Questions](#open-questions).

### 3. Profile (`/profiles/{cwid}`)

**Sketches:** `001-revised-senior` (senior faculty case at 412 pubs / 28 grants / 35-year career)

**Purpose:** Per-scholar landing. Identity, research narrative, publications, grants.

**Page structure (faculty case):**
- Two-column with sticky left sidebar
- **Sidebar:** photo, name, title, primary appointment, status pill (only when non-default), Contact card (email, plus Clinical profile link when populated in ED), Appointments card (with "Show all N →" if more than 3), Education card, action buttons (Copy citations, Print)
- **Main column:**
  - Optional: dismissible "what's missing" checklist (owner-only). Dismissal persists per-user; checklist re-appears when a new "missing" item enters scope (e.g., a previously-confirmed publication becomes unconfirmed).
  - Overview prose (with "Show more ↓" if longer than ~6 lines)
  - Areas of interest (pills)
  - Selected highlights (3 ranked publications selected by the [Highlight selection formula](#highlight-selection-formula); citation counts are appropriate here because the formula skews toward older, settled papers)
  - Publications (year-collapsed, see below)
  - Grants (split into Active and Completed, see below)
  - External relationships (only when at least one disclosure exists — see [Components](#external-relationships-section))

**Publications — year-collapsed:**
- Toolbar: filter chips (All / Articles / Reviews / Editorials) + search input
- Year groups, each a click-to-expand accordion
- Most recent 2 years expanded by default
- Years 3–5 ago collapsed but populated
- Older work grouped into half-decades (2015–2019, 2010–2014, 2000–2009, etc.) — these expand to show "most-cited from this period: [link], [link] · expand all N" rather than the full list
- Any year showing a partial sample appends "…and N more from {year} — expand all"

**Grants — split:**
- Active: listed inline with role pills (PI / MPI / Co-I) and dates
- Completed: collapsed, "Show all N completed →"

**External relationships placement.** Major section at the bottom of the main column, after Grants and before any footer. Renders only when at least one disclosure exists; absent for scholars with no disclosures (no "No external relationships" placeholder, which would be passive-aggressive and potentially misleading — absence of disclosure is not the same as zero relationships). See [External relationships section](#external-relationships-section) under Components.

**Profile pages for non-faculty:** the same template, with section-level graceful degradation:
- Hide Grants section if zero
- Hide Selected highlights if fewer than 3
- Hide External relationships section if no disclosures (the common case for postdocs and doctoral students)
- Don't year-collapse Publications below 20 entries — render flat
- Hide "Show all N →" when the count is small enough that the section already shows everything

**Status pill:** the pill is **absent for default-active scholars**. It renders only when status is non-default (Emeritus, On leave, Sabbatical) AND when the Enterprise Directory record is fresh. See [Status pill component](#status-pill).

### 4. Search results (`/search?q={query}`)

**Sketch:** `002-revised`

**Purpose:** Faceted search across people and publications.

**Page structure:**
1. Header (with the page-level search input — same one, reflects the current query)
2. Query echo + counts: `Results for "cardio-oncology" / 14 people · 847 publications`
3. Mode tabs: People (count) / Publications (count). Slate accent on active.
4. Layout (sidebar + main):
   - **Filter sidebar:** Person type, Department / division, Research area, Activity. "Clear all" link in sidebar header.
   - **Main:**
     - Active filter chips row: each applied filter as a removable chip (× icon), plus a "Clear all" link
     - Toolbar: result count + sort dropdown
     - Result rows
     - Pagination (with ellipsis pattern for large result sets)

**Active filter chips** are mandatory. Without them, users can't tell what filters are applied without scanning the sidebar.

**Person type filter** uses the five chip-row categories as **flat checkboxes** (not a two-tier hierarchy):

```
Person type
  ☐ Full-time faculty (N)
  ☐ Affiliated faculty (N)
  ☐ Postdocs & non-faculty (N)
  ☐ Doctoral students (N)
```

"All" is expressed as no checkboxes selected — leaving the filter unchecked returns the full population, no "All" checkbox needed. Counts reflect the search-scoped subset (i.e., the count for "Full-time faculty" is the number of full-time faculty matching the current query, not the global total). Sketch `002-revised` has only three categories — that's a known gap to update during implementation.

The actual ED person-type (Voluntary Faculty, Postdoc, Senior Research Scientist, etc.) appears as a per-row role tag on each result row. This keeps the filter taxonomy simple while preserving taxonomic detail at the individual level. See [Scholar role model](#scholar-role-model) for the full mapping.

**Leaf-level role filter is a Phase 2 candidate, not a Phase 1 feature.** The five chip categories are deliberately coarser than the underlying ED person-type taxonomy (12 leaf-level categories). A user wanting to filter to "Voluntary Faculty only" — common at WCM given the NYP relationship — has two Phase 1 paths:

1. Check "Affiliated faculty" and scan the per-row role tags for "Voluntary Faculty" entries.
2. Free-text search "voluntary faculty {topic}" — the per-row role tag is a matchable string.

If the leaf-level filter use case proves common in practice, Phase 2 may add a "More" expander on the Person type chip row that exposes leaf-level ED types as a secondary checkbox group. Documented as a stated decision rather than an oversight.

**Department / division filter** is a single combined facet with **adaptive flat checkboxes**, not hierarchical. Both departments and divisions are listed as peer entries; the user can filter at either level.

```
Department / division
  ☐ Anesthesiology (N)
  ☐ Cardiology — Medicine (N)
  ☐ Cardiology — Pediatrics (N)
  ☐ Hematology & Oncology — Medicine (N)
  ☐ Medicine (N)
  ☐ Pediatrics (N)
  ...
```

Three rules govern the rendering and behavior:

1. **Adaptive disambiguation.** Division names render plainly when unambiguous across WCM (`Anesthesiology`, `Dermatology`). When the same division name exists in multiple departments — Cardiology, Hematology & Oncology, Infectious Diseases, Endocrinology, etc. — the parent department is appended with an em-dash separator (`Cardiology — Medicine`, `Cardiology — Pediatrics`).
2. **Departments and divisions as peers.** Departments appear in the list alongside divisions. A user wanting "anyone in Medicine" checks the Medicine entry; a user wanting "Cardiology specifically" checks Cardiology — Medicine. The two answer different questions and both are valid filters.
3. **Filter semantics.**
   - Checking a department entry (e.g., Medicine) matches anyone whose `weillCornellEduOrgUnit;level1 = Medicine`, regardless of level2. **Includes** all divisions within the department.
   - Checking a division entry (e.g., Cardiology — Medicine) matches anyone whose `level1 = Medicine AND level2 = Cardiology`.
   - This means counts overlap by design — Medicine's count is the sum of all its divisions plus department-only assignees. Selecting both Medicine and Cardiology — Medicine is harmless (Cardiology is a subset).

**Per-row display** of department/division uses a parallel convention with a middle-dot separator: `Cardiology · Department of Medicine`. Same hierarchy-revealing rule (level2 · level1) but a different visual separator from the facet's em-dash, so the two contexts are distinguishable. When level2 is empty, render department only: `Department of Medicine`. See [Components](#person-row).

**Doctoral students** are treated differently because their `level1` is always "Graduate School" (uninformative). For the Department / division facet, students are filterable via the Person type facet only in Phase 1; their educational program (the meaningful org unit) does not appear in the Department / division list. Phase 2 may add a separate Educational program facet for student-scoped queries.

**Match highlights:** Bold (`font-weight: 600`) on matched terms. **Do not use background colors** (the original yellow `#fff5cc` highlight was Post-it-loud). Bold-only matches the convention of PubMed and Google Scholar.

**Publication results include a 1–2 sentence abstract excerpt** with bold matches, set off with a 2px left border so it reads as a quotation.

**Pagination:**
- Small result sets: numbered pages with prev/next arrows
- Large result sets: ellipsis pattern: `‹ Prev | 1 2 3 4 5 … 84 85 | Next ›`
- Spec the breakpoint between the two patterns (suggested: 7+ pages → ellipsis)

**Open: Relevance sort.** The default is "Relevance" but how relevance is computed is unspecified. Lexical match? Embedding similarity? Boost for high-citation senior authors? Needs spec-level definition before launch.

### 5. Browse hub (`/browse`)

**Sketch:** `005-browse`

**Purpose:** The page someone lands on when they click "Browse" in the nav. Navigate WCM by structure rather than by query.

**Page structure:**
1. Header (with "Browse" nav link in `is-current` state)
2. Page header: serif H1 "Browse", subtitle ("Navigate Weill Cornell Medicine by department, center, or alphabetically."), anchor strip
3. **Departments:** 3-column grid of all 29 WCM departments. Each tile shows name, scholar count (right-aligned), and chair name.
4. **Centers & institutes:** 2-column grid of cross-disciplinary research centers. Each card has name, 1-sentence scope, director, scholar count.
5. **A-Z directory:** flat letter strip (no per-letter counts). Active letter shows expanded results below: 2-column list of names with academic titles, capped at 10, with "view all in {letter}" link.

The Leadership section was removed during review (chairs and directors are already on every department/center card).

The cross-link to Research areas (carousel/topic grid live on the home page) is a small "Research areas →" link at the right end of the anchor strip.

### 6. Department detail (`/departments/{slug}`)

**Sketch:** `006-department`

**Purpose:** Per-department landing. Identity, leadership, divisions, faculty.

**Page structure:**
1. Header
2. Crumbs: Home › Browse › Departments › Medicine
3. **Hero:**
   - Eyebrow: "DEPARTMENT"
   - H1 in serif: department name
   - Description paragraph (mentions scholar mix: full-time faculty, affiliated faculty, postdocs & non-faculty, doctoral students)
   - **Chair card** (embedded, prominent): photo + role label + name + endowed-chair title. Links to the chair's profile.
   - **Top research areas** pill row: 8–10 topics with pub counts. Click-throughs land on topic pages.
   - Stats line (dashed divider): scholars · divisions · publications · active grants
4. Layout (rail + main):
   - **Divisions rail:** "All scholars" + each division. Sorted by scholar count descending. (For small departments without divisions, the rail collapses or is omitted.)
   - **Main:**
     - Section header: division name + "Chief: {name}" with link to chief's profile
     - Division description (1 paragraph)
     - **Role chip row:** `[All N] [Full-time faculty N] [Affiliated faculty N] [Postdocs & non-faculty N] [Doctoral students N]`. Active chip = "All" by default.
     - Toolbar: count + sort
     - Person rows with role tags
     - Pagination (ellipsis pattern for large divisions)

**The role chip row defaults to "All"** — not "Faculty." This is a deliberate inclusivity choice. Users who want only faculty are one click away; the default communicates that postdocs and research staff are part of the directory.

**Person rows** use the same component spec as search results (see [Components](#components)) with role tags inline next to names.

---

## Components

**A note on absence-as-default behavior.** Several components in this section use an absence-as-default pattern — they render only when meaningful data is present, and produce no output otherwise. Status pill is absent for default-active scholars; Mentor / Advisor card is absent when no mentor relationship is recorded; AOI pills below the 3-publication threshold are dropped silently; External relationships section is absent when no disclosures exist; Clinical profile link is absent when ED has no `weillcornell.org` URL.

This pattern is honest about uncertainty and avoids confidently-wrong displays (an "Active" pill on a scholar whose appointment ended six months ago is worse than no pill). The tradeoff is that **users cannot distinguish "this scholar legitimately has no advisor" from "the data is missing."** For most surfaces this ambiguity is acceptable — the scholar's profile is read-only, and a confused user can contact the scholar or their department directly.

For operational debugging at launch and beyond, **the application emits component-render logs** for every profile rendered: which components rendered, which were absent-by-default, which were absent-because-data-missing. Logs are accessible to the Scholars dev team but not a user-facing surface in Phase 1. An OFA-facing coverage dashboard (showing "% of profiles with each component populated, weighted by role") is a Phase 2 candidate if usage warrants. See [Out of scope](#out-of-scope-phase-2).

### Person row

The shared component for any list of people: search results, department faculty list, browse A-Z, etc.

```html
<div class="person-row">
  <div class="person-photo">{initials or img}</div>
  <div>
    <div class="person-name">
      <a href="/profiles/{cwid}">{Full Name}, {credentials}</a>
      <span class="role-tag">{Full-time faculty | Affiliated faculty (or specific subtype) | Postdoc | Fellow | Research staff | Doctoral student}</span>
    </div>
    <div class="person-title">{Academic title}</div>
    <div class="person-dept">{Department or division}</div>
    <div class="person-snippet">{Research focus snippet, with <em>bold</em> match highlights}</div>
  </div>
  <div class="person-meta-right">
    <span><span class="stat-num">{N}</span> pubs</span>
    <span><span class="stat-num">{N}</span> grants</span>
  </div>
</div>
```

Layout: 3-column grid (`56px 1fr auto`). Photo left, content middle, stats right.

Mobile: collapse to 2 columns (photo + content), stats reflow below content padded under the photo column.

Stats column: omit individual stat lines when the value is zero (don't render `0 pubs` or `0 grants`).

### Role tag

Small uppercase label appearing inline next to a scholar's name in any list view. The tag value is the **actual Enterprise Directory person-type**, not the chip-row grouping. Examples:

```html
<span class="role-tag">Full-time faculty</span>
<span class="role-tag">Voluntary faculty</span>
<span class="role-tag">Adjunct faculty</span>
<span class="role-tag">Courtesy faculty</span>
<span class="role-tag">Faculty emeritus</span>
<span class="role-tag">Instructor</span>
<span class="role-tag">Lecturer</span>
<span class="role-tag">Postdoc</span>
<span class="role-tag">Fellow</span>
<span class="role-tag">Research staff</span>
<span class="role-tag">Doctoral student</span>
```

(`Research staff` is a single user-facing label that covers Non-Faculty Academic and Non-Academic. The two ED categories are merged at display time because their distinction isn't user-meaningful.)

Visual:
- 18px height, 6px horizontal padding
- 10px font, weight 600, uppercase, letter-spacing 0.06em
- `--color-surface-alt` background, `--color-text-muted` text
- 1px `--color-border` border, 3px border radius

**All role tags use the same neutral styling.** Color-coding role would create a hierarchy users would have to learn; uniform treatment communicates "these are all scholars."

**Why per-row tags use ED person-types and chip rows use chip categories:** a chip row is a navigation aid — five categories are enough granularity to filter a list. A per-row tag is identifying information about a specific scholar, where the actual title carries real meaning (a Voluntary Faculty member is a different kind of scholar from an Emeritus, even though both fall under "Affiliated faculty" in the chip row). The chip-row-vs-tag granularity difference is intentional.

### Scholar chip

Inline person reference with photo + name, used in topic page hero scholars row, faculty avatar rows, and similar.

```html
<a href="/profiles/{cwid}" class="scholar-chip">
  <span class="scholar-chip__avatar">{initials}</span>
  <span class="scholar-chip__name">
    {Full Name}
    <span class="scholar-chip__title">{Sub-area or short context}</span>
  </span>
</a>
```

Visual: 26px avatar circle on the left, name and one-line subtitle on the right. White background with 1px border, slate-blue border on hover.

### Author chip

Compact inline person reference for publication metadata.

```html
<a href="/profiles/{cwid}" class="author-chip">
  <span class="author-chip__avatar">{initials}</span>
  {Full Name}
</a>
```

Visual: smaller (22px avatar), tighter padding. Used in publication results, topic page publication feed, profile selected highlights.

**Unlinked variant (when no profile page exists):** when an author exists in publication metadata but doesn't have a Scholars profile page, render the chip as a `<span>` instead of an `<a>` — same visual (avatar + name), no hover state, no link. Honest degradation: the user sees the author participated without a 404-prone link. This applies to any scholar without a profile, not a specific role — under v1.3 the Phase 1 default is that all profiled ED person-types get profiles, so unlinked chips are a corner case rather than a common pattern.

### Sticky rail

Used on topic detail (subtopics) and department detail (divisions).

Layout: 280px wide, sticky positioned at `top: calc(headerH + space-4)`, max-height of viewport minus header, internal scroll.

Pattern:
- Rail title (small uppercase eyebrow)
- Filter input (where applicable)
- List items: text label + count, hover state, active state with `--color-accent-light` background
- Optional divider + "less common" subhead for items below a count threshold

### Filter chip row

Used above lists to scope by category.

```html
<div class="role-chips">
  <a href="?role=all" class="role-chip active">All <span class="role-chip__count">N</span></a>
  <a href="?role=faculty" class="role-chip">Faculty <span class="role-chip__count">N</span></a>
  ...
</div>
```

Visual: pill-shaped, white background by default, slate when active. Counts in slightly muted text inside the pill.

### Active filter chip (removable)

Used above search results to reflect applied filters.

```html
<span class="active-filter-chip">
  Full-time faculty
  <span class="active-filter-chip__remove">×</span>
</span>
```

Visual: slate-light background, slate text, small × icon for individual removal. Plus a "Clear all" link adjacent.

### Pagination

Two patterns based on result-set size:

**Small (≤6 pages):** numbered with prev/next.

```
‹ Prev  1  2  3  4  Next ›
```

**Large (≥7 pages):** ellipsis pattern.

```
‹ Prev  1  2  3  4  5  …  84  85  Next ›
```

Active page: slate background, white text. Inactive: white background, slate text, slate-border hover.

### Page header (sketch chrome — REMOVE before production)

The dark bar at the very top of each sketch (`#variant-nav`) is review-only chrome. **Strip it from production builds.** Same with `#sketch-tools`.

### Curated tag

See [Cross-cutting decisions / "Curated" tag](#curated-tag).

### Status pill

Small pill below name in profile sidebar. **Renders only when the scholar's appointment status is non-default** (Emeritus, On leave, Sabbatical) AND when the Enterprise Directory `weillCornellEduStatus` field freshness threshold is met. Default-active scholars get **no pill** — the absence of a pill is the active state.

```html
<!-- Rendered example (Emeritus) -->
<div class="status-pill status-pill--emeritus">
  <span class="status-pill__dot"></span>
  Emeritus
</div>
```

**Variants:**
- `status-pill--on-leave` — warning palette (`--color-warning-light` background, `--color-warning` text and dot). Optional date suffix: "On leave through 2026."
- `status-pill--emeritus` — muted gray (neutral border, `--color-text-muted` text). Optional date: "Emeritus since 2019."
- `status-pill--sabbatical` — same warning palette as on-leave, label "On sabbatical."

**Behavior rules:**

1. The pill is **absent** when status is `{class}:active`. No green dot, no "Active" label — the page just doesn't render the component.
2. The pill is **absent** when status is non-default but the ED record's modify timestamp is older than 6 months. Stale data falls back to no pill (rather than risking an Emeritus pill on a working faculty member).
3. The pill renders **only** when status is non-default AND data is fresh.

This is a deliberate absence-as-default design. An "Active" pill on every profile would be wallpaper; surfacing the pill only for deviations makes its presence meaningful.

### Department / division line

Small text appearing in profile sidebars and list rows, showing the scholar's org-unit context. Three rendering modes depending on the scholar's role and `weillCornellEduOrgUnit` fields:

**Mode 1 — Faculty with `level2`:**
```
Cardiology · Department of Medicine
```
Middle-dot separator. Sub-unit on the left, parent on the right. The "Department of" prefix is added at display time; ED stores the bare name.

**Mode 2 — Faculty without `level2`** (chairs, smaller departments without divisions):
```
Department of Medicine
```
Just the parent. No middle-dot.

**Mode 3 — Doctoral students:**
```
PhD candidate · Cell & Developmental Biology
```
Middle-dot separator. Title-derived label on the left (from `weillCornellEduTitleCode` plus context), program name on the right (from `weillCornellEduProgram` / `level2`). The `level1` ("Graduate School") is dropped — uninformative for display.

The same line may have an "Expected {year}" suffix for doctoral students when meaningful: `PhD candidate · Cell & Developmental Biology · Expected 2027`.

**Disambiguation context note.** The middle-dot separator used for inline display deliberately differs from the em-dash used in the Search Department/division facet (`Cardiology — Medicine`). Two different visual conventions because the contexts differ — but both convey the same level2-level1 hierarchy. See [Search results](#4-search-results-searchqquery) for the facet treatment.

**Dense-row variant.** On compact list surfaces — Browse A-Z, in particular — the dept/div line can be folded into the title slot rather than rendered as a separate row. The academic title already carries the department signal for faculty cases ("Asst Prof of Surgery" implies Department of Surgery), so a separate dept/div line would be redundant. For non-faculty list entries, the title slot can absorb the program context inline ("Postdoctoral Associate · OB/GYN"). The full multi-line treatment is reserved for search results, profile sidebars, and other surfaces where row density is not the constraint.

### Mentor / Advisor card

Postdoc and doctoral student profiles surface their primary research-relationship in the sidebar. Same component shape, different label and source.

**Postdoc profiles** show a "Postdoctoral mentor" card. Source: derived from postdoc's lab affiliation in Enterprise Directory or reciter-db (TBD which is more reliable for the lab-PI relationship).

**Doctoral student profiles** show an "Advisor" card. Source: Jenzabar `thesis_advisor` field (or equivalent — exact field name TBD pending data team conversation).

```html
<a href="/profiles/{advisor-cwid}" class="mentor-card">
  <span class="mentor-card__photo">{initials}</span>
  <span class="mentor-card__body">
    <span class="mentor-card__name">{Advisor Full Name}</span>
    <span class="mentor-card__role">{Advisor's title or role}</span>
  </span>
</a>
```

Visual: 36px avatar circle on the left, name and title on the right. Hover state lifts to slate-light background. Click-through to the advisor's profile.

When data is unavailable (e.g., postdoc whose lab assignment isn't in the read store, or doctoral student whose Jenzabar record is missing thesis advisor), the card is omitted entirely. Same absence-as-default logic as the status pill.

### Copy citations

Bulk export of a scholar's publications in standard citation format. Button in profile sidebar opens a modal:

- **Format dropdown** with Vancouver as default. Vancouver is the medical-school standard and what every WCM grant application and CV expects. Alternates: AMA, APA, BibTeX, RIS.
- **Scope dropdown:** "Current view" (default if any filter is applied) or "All publications."
- **Preview pane** showing the first ~3 formatted entries.
- **Two actions:** "Copy to clipboard" and "Download {.txt | .bib | .ris}" depending on format.

**Phase 1 supports Vancouver and BibTeX only.** AMA, APA, and RIS deferred to Phase 2 — they cover thinner use cases and the formatting logic for each is real implementation work.

**Single-paper citation copy:** small clipboard icon appears next to DOI / PubMed links on each pub row. One-click copy in Vancouver format. Pairs with the bulk export — different task (one paper vs. many) handled with proportional UI.

### Areas of interest pills

Pills displayed in profile pages showing keywords that summarize a scholar's research focus. Sourced from publication keyword indexing (PubMed `keyword` field plus `mesh` terms for biomedical papers, aggregated across the scholar's WCM-attributed publications).

**Threshold rule.** A pill renders only when 3 or more of the scholar's publications are indexed with the keyword. Below threshold, the keyword is dropped silently — no "low-confidence" indicator, no separate display tier. This avoids pills that look like AOIs but are actually noise (single mentions, peripheral keywords).

**Per-pill counts.** Each pill displays the count of publications indexed with that keyword: `Hospital quality & safety 87`. The count is the credibility argument for the surface — users can see at a glance which AOIs are densely or thinly attested. Counts use tabular numerals for clean alignment.

**Section-level help icon.** A small "?" icon appears next to the section title with a tooltip: *"Derived automatically from publication keywords. The number on each pill is the count of attributed publications indexed with that keyword."* The tooltip explains derivation once at the section level rather than tooltipping every pill (which would be redundant).

### Large author lists

Publications with many authors (consortium papers, multi-center clinical trials, GWAS papers) need a different treatment than the standard byline format. Triggered when the publication has 6+ WCM authors OR 10+ total authors.

**Byline truncation.** Vancouver-style: first 3 authors, ellipsis, last 2 authors. Self-highlight on the current scholar:
```
Petrov MM, Goldman LR, Sato Y, ..., Foster A, [Whitcomb MR]. JAMA.
```

**Collapsible WCM-author affordance.** Below the byline, a small button shows "+N WCM authors" with a caret. Clicking expands a flex-wrap row of author chips for all WCM-attributed authors of the publication (not the non-WCM authors — they don't have profiles in Scholars). Each chip is a 22px avatar plus name, clickable to the author's profile.

```html
<div class="wcm-authors">
  <button class="wcm-authors__toggle">
    <span class="wcm-authors__caret">▶</span>
    <span>+ 8 WCM authors</span>
  </button>
  <div class="wcm-authors__chips">
    <a href="..." class="wcm-author-chip">{avatar} {Name}</a>
    ...
  </div>
</div>
```

**Stats line context.** The pub-row stats line surfaces total author count for context: `312 citations · 247 total authors · Senior author · DOI`. The "247 total authors" tells the user the scale they're looking at; the chip expand only enumerates the small WCM-attributed subset.

**Why only WCM authors get chips.** The 239 non-WCM authors on a 247-author Cell paper don't have Scholars profiles, never will, and listing them as chips would be misleading (the chip implies a navigable entity). Plain comma-separated text in the truncated byline handles them honestly.

### External relationships section

A major section on profile pages, near the bottom of the main column. Discloses external financial and advisory relationships per WCM's COI policy. The section name is "External relationships" — **not** "Conflicts of interest" — preserving WCM's institutional framing that legitimate consulting and advisory work is a relationship to be transparent about, not a conflict to be flagged.

**Render rule.** The section appears **only when at least one disclosure exists** for the scholar. No placeholder ("No external relationships disclosed") for scholars with zero disclosures — absence of disclosure is not the same as zero relationships, and a placeholder would imply otherwise. Postdocs, doctoral students, and most basic-science faculty will not see this section on their profiles.

**Structure:**

```html
<section class="external-relationships">
  <h2>External relationships</h2>

  <p class="external-relationships__preamble">
    Relationships and collaborations with for-profit and not-for-profit organizations
    are of vital importance to our faculty because these exchanges of scientific
    information foster innovation. As experts in their fields, WCM physicians and
    scientists are sought after by many organizations to consult and educate. WCM
    and its faculty make this information available to the public, thus creating a
    transparent environment.
  </p>

  <!-- One block per category that has disclosures -->
  <div class="er-category">
    <h3 class="er-category__label">{Category name}</h3>
    <p class="er-category__entities">{Entity}; {Entity}; {Entity}</p>
  </div>

  <p class="external-relationships__footer">
    <a href="...">About these disclosures →</a>
  </p>
</section>
```

**Preamble.** The italic introduction paragraph above the categories is the WCM-authored framing language — committee-produced, institutional voice, deliberately preserved verbatim. Do not edit, paraphrase, or summarize.

**Implementation: content-constants treatment.** The preamble string lives in a content-constants module (or strings table — `content/external-relationships.ts` or equivalent) flagged with a `// DO NOT EDIT WITHOUT COMMITTEE REVIEW` comment header. The string is not edited inline in component templates. This protects against editor drift — a developer cleaning up "wordy" copy could inadvertently rewrite institutional disclosure language. The string is also part of legal compliance verification with the COI office before launch.

**On change.** Any edit to the preamble — even punctuation — requires sign-off from the COI office or whoever is the current owner of the institutional disclosure framing. The change is logged in the spec changelog. The same constraint applies to the per-category explanatory tooltips when they are added in Phase 1 (currently tracked as TBD, requiring confirmation of the WCM definitions for each category).

**Categories are data-driven.** The set of category names is defined by the WCM COI office, not hardcoded in this spec. Known categories from sample profiles include:

- Leadership Roles
- Professional Services
- Other Interests
- Ownership
- Proprietary Interest

Additional categories may exist depending on COI office taxonomy. The implementation reads category names from the COI source and renders whatever is present; new categories added by the COI office surface automatically without code changes.

**Disclosed entities.** Listed as plain text, semicolon-separated when multiple appear in the same category. **Not linkable** in Phase 1 — Scholars does not have entity pages, and outbound links to company websites would be doing something the spec hasn't decided. The disclosure value is the entity name as the COI office records it.

**Footer link.** "About these disclosures →" routes to the institutional COI policy or explanation page (URL TBD with the COI office). Provides users who want the full institutional framing — not just the per-scholar disclosures — a path to it.

**Visual treatment.** Section title in serif H2 (matching other major profile sections). Preamble paragraph italicized in muted text color. Category labels small uppercase eyebrow style (matching `.section__title` convention). Entity lists in normal text, semicolon-separated. Section sits with extra top padding to visually separate it from Grants above.

**Owner edits.** The "what's missing" checklist (top of profile, owner-only) does not surface External relationships — disclosure management is the COI office's workflow, not Scholars's. Profile owners who notice incorrect disclosures should be routed to the COI office, not to a Scholars edit form. The About page covers this.

### Highlight selection formula

Several surfaces in Scholars rank publications by a composite score to surface high-quality work — Profile Selected highlights, Topic page Recent highlights, Home page Recent contributions, Topic page Top scholars chip row. They share a base formula with surface-specific tunings.

**Base formula:**

```
score = reciterai_impact × authorship_weight × pub_type_weight × recency_weight
```

Top-N papers (or, for the Top scholars chip row, top-N scholars after aggregating per-scholar scores) by score, with surface-specific filters and dedup constraints layered on top.

**Factor 1: ReCiterAI impact.** Already exists in DynamoDB. Incorporates citation count, journal venue, and other quality signals. Score updates weekly. This is the core quality signal; the other factors are filters and adjustments.

**Factor 2: Authorship weight.** Binary, applied as a multiplicative filter:

| Authorship position | Weight |
|---|---|
| First author | 1.0 |
| Senior (last) author | 1.0 |
| Co-corresponding author | 1.0 |
| Middle author | 0 (filtered out) |

The middle-author filter applies on **scholar-centric surfaces** — Profile Selected highlights and Home page Recent contributions — where the question is "what is this scholar's own work." On **publication-centric surfaces** (Topic page Recent highlights, Topic page sort options), authorship position is not filtered; all attributed authors appear in bylines per the standard publication metadata display. Scholar-centric surfaces want narrative; publication-centric surfaces want completeness.

**Factor 3: Publication type weight.** Soft preference for original research, hard exclusion for non-substantive types, applied across all four surfaces:

| `publicationTypeCanonical` | Weight |
|---|---|
| Academic Article | 1.0 |
| Review | 0.7 |
| Case Report | 0.5 |
| Preprint | 0.7 |
| Letter | 0 |
| Editorial Article | 0 |
| Erratum | 0 |

A transformative Review can still surface as a highlight, but must clear a substantially higher bar than an Academic Article of equivalent ReCiterAI score. Letters, Editorials, and Errata are hard-excluded — they don't lose anything by sitting under "Most cited" or "Newest" in the publication feed instead of appearing on a curated surface, and the failure mode of a high-scoring Erratum landing on the home page Recent contributions surface is bad enough ("why is my erratum featured?") that allowing the edge case isn't worth the conceptual purity. Preprints get the same weight as Reviews because in fast-moving fields (genomics, ML methods) a high-impact preprint can be the most consequential output.

**Factor 4: Recency weight.** This is where the four surfaces diverge meaningfully — each surface answers a different question and the recency curve reflects that.

**Selected highlights (profile)** — the surface answers "what is this scholar known for." Sits adjacent to the most-recent-papers view in the Publications section (last 2 years expanded by default), so it should *not* duplicate that surface. Skews older deliberately:

| Paper age | Weight |
|---|---|
| 0–6 months | 0 (excluded — appears in most-recent-papers view above/below; no double-feature) |
| 6–18 months | 0.7 |
| 18 months–10 years | 1.0 (peak) |
| 10–20 years | 0.7 |
| 20+ years | 0.5 |

**Recent highlights (topic page)** — the surface answers "what notable work in this topic has appeared recently." Heavy recency weight, with the under-3-months penalty to avoid premature promotion of papers without signal maturity:

| Paper age | Weight |
|---|---|
| 0–3 months | 0.4 (penalty — ReCiterAI score not yet stable) |
| 3–6 months | 0.7 |
| 6–18 months | 1.0 (peak) |
| 18 months–3 years | 0.8 |
| 3+ years | 0.4 |

**Recent contributions (home page)** — same shape as Topic page Recent highlights, scoped to the eligibility carve (full-time faculty + postdoc + fellow + doctoral student).

**Top scholars chip row (topic page)** — scholar-centric, not publication-centric. Score is **aggregated per scholar** as a sum of their scored publications in the topic, each contribution weighted by the per-publication formula above using the Recent highlights recency curve:

```
scholar_score = SUM over scholar's papers in topic of (
    reciterai_impact × authorship_weight × pub_type_weight × recency_weight_recent
)
```

The aggregation rewards both volume and quality: a scholar with one Cell paper and a scholar with twelve solid Academic Articles can both rank highly, depending on their respective score totals. Authorship-position filter applies (first or senior only) to keep the chip row about scholars' own work in the topic.

**Surface-specific filters and constraints:**

| Surface | Pool restriction | Dedup |
|---|---|---|
| Selected highlights | Single scholar's WCM-attributed publications | None internal |
| Recent highlights | All scored publications attributed to the topic | None |
| Recent contributions | Eligibility carve + first-or-senior author | One per parent research area |
| Top scholars chip row | Eligibility carve + at least one scored paper in topic | None — same scholar can appear on multiple topic pages |

**Methodology page coverage.** The methodology page (Open Q #1) restates these formulas in plain English so a scholar viewing their own profile and wondering "why isn't my Cell paper in Selected highlights?" can read the answer. Surfaces that use this formula link to the relevant methodology page section via their "How this works" affordance.

**Why this differs from naive recency or naive impact.** Pure recency biases toward papers without accumulated signal. Pure impact biases toward older papers that have had time to accumulate citations and forever-feature on senior faculty profiles. The composite formula with surface-specific recency curves produces stable rankings that match what each surface is actually for.

**Worked examples.** Three concrete cases to anchor implementation and verification. Use these as test fixtures.

*Example 1 — Whitcomb's foundational paper as a Selected highlight candidate.*
- Paper: 2003 hospital-medicine paper, Annals of Internal Medicine, senior author (Whitcomb)
- Type: Academic Article → `pub_type_weight = 1.0`
- Authorship: senior → `authorship_weight = 1.0`
- Age: 23 years old → falls in 20+ years bracket on Selected highlights curve → `recency_weight = 0.5`
- Suppose `reciterai_impact = 0.92` (well-cited, well-venued)
- Final score: `0.92 × 1.0 × 1.0 × 0.5 = 0.46`

*Example 2 — Same paper as a Recent highlight on a topic page.*
- Same paper, same factors except recency curve
- Age 23 years → falls in 3+ years bracket on Recent highlights curve → `recency_weight = 0.4`
- Final score: `0.92 × 1.0 × 1.0 × 0.4 = 0.37`
- Note: this paper is unlikely to be selected as a Recent highlight even with strong impact — that's by design. Recent surfaces are for current work.

*Example 3 — A 14-month-old NEJM paper as a Recent contribution.*
- Paper: Academic Article, NEJM, first author (postdoc), 14 months old
- Type: Academic Article → `pub_type_weight = 1.0`
- Authorship: first → `authorship_weight = 1.0`
- Age: 14 months → falls in 6–18 months bracket on Recent contributions curve → `recency_weight = 1.0` (peak)
- Suppose `reciterai_impact = 0.88`
- Final score: `0.88 × 1.0 × 1.0 × 1.0 = 0.88`
- Postdoc is in the eligibility carve; paper qualifies. Likely surfaces on Recent contributions.

**Calibration discipline.** The four-factor formula × four recency curves is not self-tuning. Without explicit ownership and a review trigger, the curves drift or get reinterpreted differently by future implementers.

- **Calibration owner: ReCiter lead, in concert with the methodology page owner.** The ReCiter lead owns the per-publication scoring (`reciterai_impact`); the methodology page owner owns user-facing explanation. Both must agree before any curve changes ship.
- **Review trigger: 6 months post-launch.** A scheduled retrospective examines the actual ranking outputs (top-N papers per surface for a sample of scholars) against subjective expectation. Adjustments to weights or curves get versioned in this spec's changelog and the methodology page.
- **Tuning rubric.** Curve adjustments are bounded: no individual weight changes by more than 0.2 in a single retune, and the relative ordering between curves (Selected highlights skews older than Recent highlights) does not flip without a deliberate spec discussion. This prevents post-launch drift from accumulating into a different formula by version 2.0.

---

## Open questions

Things flagged during sketch review that need spec-level resolution before launch.

### 1. Methodology page content

Multiple "How this works" / "methodology" links across the system point to a methodology page that doesn't exist yet. **The page must exist before launch.** A dead methodology link is the single most credibility-damaging element on these pages.

**Owner: TBD.** Name an owner before the spec is circulated. Candidates: OFA (if treated as an institutional research-information artifact), ITS (if treated as product documentation), or shared between them with one editor as primary. **Decision needed by:** 2026-05-06 (one week from current spec date; the methodology page owner blocks circulation).

> ⚠ **Circulation blocker.** This document does not get circulated to Mohammad's team until the methodology-page owner is named. The page is load-bearing — every algorithmic surface in the system has a "How this works" link pointing at it. Shipping with a dead methodology link is the single most credibility-damaging element on these pages, and naming an owner is the only thing that prevents it from sliding.

The page needs to cover:

- The [Highlight selection formula](#highlight-selection-formula) in plain English: how publications are ranked for Selected highlights, Recent highlights, Recent contributions, and Top scholars chip rows. Each surface's recency curve gets a one-line description so a scholar wondering "why isn't my Cell paper a Selected highlight" can read the answer.
- The home page Recent contributions selection rule (top-tier venues, dedup by area, eligibility carved to Full-time faculty + Postdoc + Fellow + Doctoral student)
- The home page carousel selection rule (top subtopic per parent by recent activity)
- The topic page Recent highlights selection
- The topic page sort options ("ReCiterAI Impact", "Curated by ReCiterAI")
- The Profile Selected highlights vs. most-recent-papers distinction (different surfaces answer different questions; the recency curves are tuned to avoid feature overlap)
- ReCiterAI's scoring scope and propagation rules: per-publication scoring keyed on Full-Time WCMC Faculty co-authorship; co-authors of those publications inherit visibility; the scholar-centric carve for Recent contributions and Top scholars in this area
- The publication-type weighting (Academic Article preferred; Reviews and Case Reports possible but require higher score; Letters and Editorials effectively excluded)
- The publication-type filter behavior on topic pages (research articles by default; toggle for full corpus)
- The role categorization (five chip categories vs. the underlying ED person-types)
- Update cadences (weekly for ReCiterAI-curated surfaces, daily for ED, reciter-db, Jenzabar, and COI data)

Suggested URL: `/about/methodology`. Link from footer too.

### 2. Profile pages for non-faculty roles

Under the v1.3 role model, the question is which Enterprise Directory person-types get a profile page in Phase 1. Default proposal:

| Role | Profile page in Phase 1? |
|---|---|
| Full-Time WCMC Faculty | Yes |
| Part-Time WCMC Faculty | Yes |
| Voluntary, Adjunct, Courtesy Faculty | Yes |
| Faculty Member Emeritus | Yes |
| Instructor, Lecturer | Yes |
| Postdoc, Fellow | Yes |
| Non-Faculty Academic, Non-Academic | Yes |
| Doctoral student | Yes |
| Pure ED-only entries with no `analysis_summary_author` rows | No |

The bar is low: if Enterprise Directory says someone is a person at WCM and reciter-db says they've been attributed as an author on a publication, they get a profile. The profile template gracefully degrades for thin records (no Grants section if zero, no Selected Highlights if fewer than three, no year-collapse if fewer than 20 publications) — see [Profile](#3-profile-profilescwid).

The pure-ED-only case is a corner: someone exists in Enterprise Directory but has zero attributed publications. They wouldn't have anything meaningful to display. Handling: omit from search and lists; if a vanity URL `/profiles/{cwid}` is hit directly, render a minimal stub with name, title, department, and "No publications attributed yet" placeholder. Expected to be rare for the active scholar population.

Spec decision needed before launch.

### 3. WCM brand standards

The current palette and brand mark are placeholders. When real WCM brand standards are published:
- Swap `--color-primary` family if Cornell red shade differs
- Replace the Charter serif stack if a brand-specified display face is licensed
- Adjust the tagline treatment if WCM has prescribed type for "Weill Cornell Medicine" lockups

The variable structure in `default.css` is designed for this swap. Components reference variables, not raw values.

### 4. Department, division, and subtopic descriptions

Three editorial corpora to consider:

- 29 departments
- ~300 divisions (29 × ~10 average)
- ~2,010 subtopics (67 parents × ~30 subtopics)

The taxonomy is roughly power-law distributed: the top entries get nearly all the traffic, the long tail is academic. The right scope is to invest editorial effort proportional to traffic.

**Decided approach:**
- Phase 1 launches with hand-written descriptions for the **top ~300 entries by traffic** (top departments, top divisions, top subtopics — about two weeks of focused work for one editor).
- **Editorial owner: ITS plus a copy editor seconded from Comms (or a contractor if Comms cannot allocate).** Two-week window committed for May 2026 — work block 2026-05-13 through 2026-05-27, contingent on the editor being identified by 2026-05-08. If the editor isn't named by 2026-05-08 the launch slips by the corresponding number of days; this is a critical-path dependency, not a slack item.
- The long tail gets a deliberately quiet stub treatment: section header + chief / parent-topic link, no description paragraph. No "help us describe this →" affordance — it implies an editorial process we don't want to operate on a long-tail page nobody visits.
- **Hand-curated descriptions** (top tier only) show a small **"Suggest an edit →"** link in the footer of the description block, routing to a generic Comms / OFA feedback form. This gives engaged faculty a path to flag inaccuracies without committing the team to operating a copy-submission workflow. Stub pages do not surface this link.
- Optional admin-side queue for chiefs / topic owners who want to submit copy on their own initiative; not user-facing.

This avoids the "budget an editorial hire for 3 months" trap. Real users rarely encounter "Liver fibrosis & cognition" with 7 publications; subject-matter experts who do don't need a paragraph to know what they're looking at.

### 5. Search relevance algorithm [TRACKED]

The default sort on Search results is "Relevance" but the computation is unspecified. Tracked under [Conversations in flight](#conversations-in-flight) — see ReCiter lead consultation. Default proposal: hybrid BM25 + dense biomedical embedding + faculty-status boost, pending confirmation.

### 6. Per-publication subtopic tags

Currently each publication is tagged to one or more subtopics by ReCiterAI. The topic detail publication feed surfaces these as small chips below each pub. **Decision pending:** are these chips clickable links to filter the current feed, or links that navigate to the subtopic-filtered view? Suggest the former for in-page exploration.

### 7. Recent contributions citation strip [DECIDED]

Resolved — see [Home / Landing](#1-home--landing-) above. Citations are removed from Recent contributions cards; same logic as Recent highlights on the topic page.

### 8. Center / institute detail pages [DECIDED — Phase 2 with Phase 1 placeholder]

**Decision:** Center / institute detail pages are deferred to Phase 2. Phase 1 ships a thin placeholder route at `/centers/{slug}` that renders:

- Center name + director name (linked to director's profile)
- One sentence: "Detail page coming in Phase 2."
- "View affiliated faculty in Search →" link, pre-filtering Search results to faculty with the center affiliation
- Footer

**Why not build the full page in Phase 1:** the "high reuse from department detail" framing understates the data work. Departments have a clean parent-child structure (department → division → faculty appointment). Centers don't — they're cross-cutting affiliations layered on top of departmental appointments, with no equivalent of "divisions." The page would *look* like a department page but ride on a different (less-tested) data model. A full Center page in Phase 1 would risk shipping fragile data; the placeholder is honest about scope and gives Phase 2 a clean slate.

A broken `/centers/{slug}` link from the browse hub is worse than a thin placeholder. Building a full page on shaky data is worse still.

### 9. "Recently joined WCM" surface

Considered for the home page during review and explicitly declined in favor of "Recent contributions." The Recently joined surface (auto-derived from Enterprise Directory appointment data) remains a viable Phase 2 addition — it answers "who's new?" rather than "what's notable?" and complements the contributions surface without competing with it. Data is already there; UI is small. Punt to Phase 2 unless a stakeholder explicitly requests it.

### 10. Publication date semantics

The original sketches showed `Added 2024-09-12` in publication metadata, which is the Entrez ingestion date. Most users will read this as the publication date and be confused when it doesn't match the journal year. **Resolution:** show the actual publication date (e.g., `Published Sep 2024`); reserve `Indexed YYYY-MM-DD` for places where ingestion date matters (admin views).

### 11. Publication-type filter on topic page [DECIDED]

**Decided:** the publication-type filter applies to the **entire topic page consistently**, regardless of sort. The topic page reads as "research publications in {area}"; errata, letters, and editorials don't surface here under any sort.

**Definition of "research publications":** based on `publicationTypeCanonical` from ReCiterAI:

| Type | Counts as research publication |
|---|---|
| Academic Article | Yes |
| Review | Yes |
| Case Report | Yes |
| Preprint | Yes |
| Letter | No |
| Editorial Article | No |
| Erratum | No |

**Visible toggle:** a single line of copy appears below the publication feed toolbar:

> _Including research articles, reviews, case reports, and preprints._ **[Show editorials and other types →]**

Affirmative phrasing — describes what the page shows, action verb for what's not currently included. Avoids "hidden" framing that would imply the default is concealing useful content.

When the toggle is engaged, the line updates to:

> _Showing all publication types._ **[Hide editorials and other types ←]**

**Toggle state is per-page, not session-sticky.** A user who opts into all types on the Aging & Geroscience topic page does not have that preference persist when they navigate to Cardiovascular Disease. Each topic page is independent. This avoids a personalization decision Phase 1 doesn't need to make.

**Rationale for sort-independent (option b) over Newest-only (option a):**

The original concern was that a literal-Newest sort surfaces errata and middle-author commentaries at the top of every topic page. But the same problem applies to other sorts: under "Most cited," a 2008 erratum citing a foundational paper can outrank the original. Under "Curated by ReCiterAI," a high-impact editorial about a field can outrank actual research papers. Filtering only on Newest fixes the worst case but leaves the others; it also creates a count discontinuity (publication counts shift when users change sort) that's worse than the original failure mode.

The whole-page filter gives one consistent story: this is the research publication feed for {topic}. Power users (meta-analysts, journal editors, reference librarians) are one toggle click away from the full corpus.

**Where this filter does NOT apply:**

- **Profile pages.** Errata and letters are part of the scholar's record. Filtering would create a discrepancy between the topic-page count and the profile-page count for the same scholar.
- **Publication search results.** The user's query is the scoping rule; if they search for "erratum cardiology," they want errata.
- **Recent highlights / Recent contributions surfaces.** These are already curated by ReCiterAI scoring, which de-emphasizes non-research types implicitly.

**Acceptance criterion** (added to [Acceptance criteria](#acceptance-criteria)): topic pages exclude non-research publication types by default; toggle restores them; toggle state is per-page.

### 12. Division detail pages [DECIDED — Phase 2 with Phase 1 routing]

WCM has roughly 130 divisions across 29 departments. Each is a real institutional unit with a chief, a faculty roster, and (often) distinct research programs. The Department detail page (sketch 006) surfaces division information through its sticky divisions rail — clicking a rail item filters the on-page scholar list and section-header context, but does not navigate to a dedicated division page.

**Phase 2 scope.** A dedicated division detail page mirrors the department detail page (sketch 006) but scoped to a single division. Structure:

- Crumbs: `Home › Browse › Departments › Medicine › Cardiology`
- Hero: parent department prominently linked; division name as serif H1; division chief card; top research areas; stats line (scholars · publications · active grants)
- Layout: scholars list scoped to the division, role chip row (faculty / postdocs & non-faculty / etc.), Recent publications surface
- The parent department remains visually prominent throughout — the page is a sub-page of the department, not a standalone unit

**URL structure.** Nested under the parent department: `/departments/medicine/divisions/cardiology`. This makes the parent relationship structurally clear and avoids the Cardiology-in-Medicine vs. Cardiology-in-Pediatrics slug collision entirely. Top-level `/divisions/{slug}` would require disambiguation; the nested pattern is cleaner.

**Phase 1 routing.** Division URLs (e.g., `/departments/medicine/divisions/cardiology`) resolve to the parent department page with the corresponding division pre-selected in the rail. This gives users who land on a division URL — from a Search result, an external link, an email, or a Phase-2-anticipating bookmark — a coherent landing experience without building 130 templated pages.

**Why Phase 2.** The template reuse from the department detail page is high (probably 80%+) and the data is already in the read store via org-unit ingestion. But 130 pages is real work, and the user value is incremental over the department-with-rail pattern. Defer until usage signals justify it.

---

## Conversations in flight

Four real conversations are owed to other teams as of v1.5. These are tracked here rather than buried in Open Questions because they have specific owners and time pressure.

### Data team — Enterprise Directory appointment-status freshness

The status pill (profile sidebar, [Components](#status-pill)) renders non-default states (On leave, Emeritus, Sabbatical) only when the Enterprise Directory appointment record has been updated within the last 6 months. This requires an appointment-status freshness attribute (the LDAP record's `modifyTimestamp` or equivalent) to be exposed in the identity sync that populates the Scholars read store. Also requires confirmation of the `weillCornellEduStatus` value vocabulary (active / emeritus / on_leave / sabbatical / etc.) so the pill mapping is complete.

**Question for the data team:** is this field available, and how reliable is its update cadence? What's the full enumeration of `weillCornellEduStatus` suffix values? **Format:** binary commit-by-date answer requested, not an open-ended investigation.

**Fallback if unavailable:** under v1.4 the pill is absent-by-default, so a missing freshness signal degrades cleanly — no pill ever renders, which is honest about uncertainty rather than confidently wrong. The richer behavior (Emeritus / On leave indicators on faculty profiles) is unavailable but the page doesn't lie.

### ReCiter lead — search relevance algorithm

The Search results page defaults to a "Relevance" sort whose computation is unspecified. Default proposal in the spec is hybrid lexical (BM25) + dense biomedical embedding + faculty-status boost, but ReCiter likely has prior art that should anchor the conversation.

**Target:** consultation completed two weeks before the search build kicks off. Earlier is fine; later risks the implementation team improvising.

**Decision needed by:** 2026-06-15 (target two weeks before anticipated search-build kickoff in late June; subject to ReCiter lead bandwidth).

Once decided, document the rule on the methodology page (Open Q #1) so users can understand why a given search result ranked where it did.

### Jenzabar integration owner — thesis advisor field

Doctoral student profiles surface a thesis advisor in the sidebar, sourced from Jenzabar. This requires Scholars to ingest the advisor relationship (advisor CWID + relationship type) on a daily refresh cadence.

**Question for the Jenzabar integration owner:** what's the integration shape — REST API, nightly export, reverse-ETL into a warehouse? Is the thesis-advisor field reliably populated for current PhD students? Is the field a single CWID or a structured record (advisor of record vs. co-advisor)?

**Fallback if unavailable:** doctoral student profiles render without the Advisor card. Same absence-as-default pattern as the status pill — no card is more honest than a wrong card. The doctoral-student profile sketch (when built) demonstrates both states.

**Decision needed by:** 2026-06-30 (target before doctoral-student profile build; subject to Jenzabar integration owner availability).

### COI office — External relationships ingestion

The External relationships section on profile pages reads from WCM's COI disclosure system. Scope is narrow — only the disclosure category and disclosed entity name, not amounts or dates. Refresh cadence working assumption is daily.

**Question for the COI office:** what's the integration shape — direct database read, API, periodic export? What's the canonical category vocabulary (currently the spec lists Leadership Roles, Professional Services, Other Interests, Ownership, Proprietary Interest based on sampled profiles, but the full list is COI-office-defined)? What's the URL for the institutional COI policy page that the section's "About these disclosures →" link should route to? What's the legally-vetted preamble paragraph — the spec carries the language from a sampled VIVO profile, but the COI office should confirm this is the current authoritative text.

**Fallback if unavailable:** External relationships section is absent on all profiles. Phase 1 ships without disclosure visibility. This is degraded — VIVO surfaces disclosures today, so Scholars not surfacing them would be a regression. Worth pushing on.

**Decision needed by:** 2026-06-15 (target before profile build; subject to COI office bandwidth).

---

## Out of scope (Phase 2+)

Explicitly deferred:

- **Personal saved searches and saved scholars** ("Watch this scholar" / "Saved searches")
- **Email digests** of recent publications by saved scholars
- **Editorially-curated faculty spotlights** (rejected during review; the editorial workflow is the cost)
- **Center / institute detail pages** (pending decision, see Open Questions)
- **A "labs" axis** — the lab is a real organizational unit at WCM (PI + their group) but isn't modeled as such in Enterprise Directory or reciter-db. Phase 2 may add a derived lab page from PI + group co-publication patterns.
- **News integration** — recent press mentions of WCM faculty
- **Awards integration** — NAM elections, society fellows, etc. (data not reliably available)
- **Funding totals** at the topic or department level — depends on grant attribution data quality
- **Search autocomplete / typeahead** — significant implementation effort, defer
- **"Save this search" / alerts** on search results
- **Mobile-first redesign** of filter sidebars (search, department) — Phase 1 collapses sidebars to top-stack on narrow screens; Phase 2 should treat filters as a slide-up drawer

---

## Sketch chrome to strip

Each sketch HTML file contains review-only elements. Production builds must remove:

- The dark bar at the top (`#variant-nav` element and its CSS)
- The bottom-right tooltip (`#sketch-tools` element and its CSS)
- The 44px `body { padding-top: 44px }` rule (only there to clear the variant nav)
- The `top: 44px` offset on `.wcm-header` (revert to `top: 0`)
- The `top: calc(44px + var(--header-h) + ...)` offsets on sticky sidebars (drop the `44px +`)
- Any commented-out variant blocks (some sketches had multiple variants for review)

These are mechanical sed-able removals.

---

## Acceptance criteria

A Phase 1 implementation should hit these as concrete tests:

1. **Header is consistent** across all six page types: red band, typographic lockup, no W square, slate focus rings on inputs.
2. **Role tags appear** on every list view of people: search results, department scholar list, browse A-Z, profile sidebars, topic-page scholar chips. Role tags use the actual Enterprise Directory person-type (Postdoc, Voluntary Faculty, etc.), not the chip-row category.
3. **Selection rules are visible** on every algorithmic surface, with working "How this works" links.
4. **No citation counts** on Recent highlights or Recent contributions (the "recent" surfaces).
5. **Default sort on topic page is Newest**, not AI-curated. Curated tag appears only when an AI sort is selected.
6. **Active filter chips** are present above search results when filters are applied, with × removal and "Clear all".
7. **Pagination uses ellipsis pattern** for result sets ≥7 pages.
8. **Year-grouped publications** work on profile pages: most recent 2 years expanded, half-decade groupings for older work.
9. **Status pill is absent for default-active scholars.** No "Active" pill renders on profiles where status is `{class}:active`. The pill renders **only** when status is non-default (Emeritus, On leave, Sabbatical) AND when the Enterprise Directory record is fresh (modified within the last 6 months). Stale data renders no pill — neither falsely Active nor falsely Emeritus.
10. **Methodology page exists** at `/about/methodology`, has a named owner, and covers all surfaces that link to it. (No surface in the system links to a 404.)
11. **Topic pages exclude non-research publication types** (errata, letters, editorials) by default, regardless of sort. Visible toggle restores the full corpus. Toggle state is per-page, not session-sticky.
12. **Author chips render unlinked** when no profile exists — same visual (avatar + name), no `<a>` element, no hover state. Profiled scholars get full clickable chips.
13. **`/centers/{slug}` resolves to a placeholder route** in Phase 1 — no broken links from the browse hub. Placeholder shows center name, director (linked), one-sentence Phase-2 explanation, and an affiliated-faculty search link.
14. **"Suggest an edit →" affordance** appears in the footer of hand-curated descriptions on top-tier pages (top ~300 entries). Stub pages on the long tail do not show this affordance.
15. **Lighthouse accessibility audit ≥ 95** on each of the six page types in production build. Real users include screen-reader users, keyboard-only users, and users with low-vision configurations; this is a public-facing institutional product and accessibility is non-negotiable.
16. **Sketch chrome stripped:** no `#variant-nav`, no `#sketch-tools`, no 44px body padding, no commented-out variant blocks in the production build. (See [Sketch chrome to strip](#sketch-chrome-to-strip).)
17. **External relationships section** appears on profiles only when at least one disclosure exists. The committee-authored preamble paragraph renders verbatim. Categories are read from the COI source; disclosed entities are plain text and not linked. Section name is "External relationships" — not "Conflicts of interest."
18. **Clinical profile link** appears in the Contact card only when Enterprise Directory has a `weillcornell.org/{cwid}` URL populated. Absent when not.
19. **Division URLs route to parent department with pre-selection** in Phase 1. Visiting `/departments/{dept}/divisions/{div}` returns the parent department detail page (200 status, no 3xx redirect that breaks back-button behavior). The division corresponding to `{div}` is pre-selected in the divisions rail on page load: the rail item shows active state, the page's scholar list is filtered to the division, and the page heading shows the division context. **Specific test on launch day:** visit `/departments/medicine/divisions/cardiology` and `/departments/pediatrics/divisions/cardiology`; verify both load the correct parent department page, verify the correct Cardiology division (Medicine vs. Pediatrics) is pre-selected, verify scholar lists differ accordingly. No 404s. No silent fallback to "Department of Medicine, no division pre-selected."
20. **Highlight surfaces use the documented formula.** Profile Selected highlights, Topic page Recent highlights, Home page Recent contributions, and Topic page Top scholars chip row all derive from the [Highlight selection formula](#highlight-selection-formula) with the surface-specific recency curve. Selected highlights excludes papers under 6 months old; Recent highlights and Recent contributions penalize papers under 3 months for signal maturity. The formula is documented on the methodology page with surface-specific details so scholars can understand why their work appears (or doesn't) on each surface.

---

_If you find a conflict between this spec and a sketch, file an issue tagged `design-spec` rather than picking one. The spec gets updated, or the sketch was wrong._
