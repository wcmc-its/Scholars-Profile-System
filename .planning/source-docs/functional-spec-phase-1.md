# Scholars @ WCM — Phase 1 Functional Specification

_Last updated: 2026-04-28_

## Purpose & audience

This document defines what the Phase 1 Scholars @ WCM application does from a user's perspective. It is the functional companion to the Project Charter (`Scholars Project Charter - 2026-04-28.docx`). Technical implementation details — stack, data model, deployment topology, API contracts — are out of scope; those are owned by Mohammad's team in a separate technical plan.

Audience: ITS development team, Mohammad's team, VIVO/ASMS Steering Committee, AAC, CAB.

## Phase 1 scope summary

Adopting Mohammad's Phase 1 scope (slide 16 of `WCM_Scholar_Proposal-v2.pptx`) verbatim:

- Public profile page
- Search (with sorting and filtering, including publication search)
- Home / landing page
- Self-edit of overview statement (authenticated)
- Support page
- `sitemap.xml` and SEO essentials
- Underlying data integrations and operational concerns (technical; not specified here)

## Scholar profile page

The most important page in the system. Phase 1 sections, in order:

### Header
- Headshot
- Full name
- Primary title (single string, sourced from upstream)
- Primary department / affiliation

### Overview statement
- A single text block, self-edit by the profiled scholar (see "Self-edit," below).
- Day-one launch: every profile is seeded from the existing VIVO overview where one exists. Profiles with no VIVO overview start empty and stay empty until the scholar self-edits.
- Empty profiles (no seed, no self-edit) show no overview section.

### Contact
- Email address only.
- Location, phone, website, fax: **out of scope for Phase 1**.

### Appointments
- Display order and filtering replicate ReCiter Connect's existing logic in `AppointmentsFetchFromED.java`:
  - Primary appointments first (driven by `isPrimaryAppointment` flag → `core:PrimaryPosition` RDF type today)
  - Active appointments only (exclude expired)
  - Interim appointments excluded if any non-interim appointments exist; otherwise included
- Active appointments shown by default; historical appointments collapsed behind a "Show past appointments" expander.
- Per appointment: title, organization, dates.

### Education and training
- Reverse chronological.
- Per entry: degree, institution, year, field (where available).

### Areas of interest (keywords)
- Sourced from the ReCiter Feature Generator API output.
- Filtered by score / relevance threshold (specific threshold TBD by team; calibrate against Publication Manager's existing display).
- Displayed as a simple list of "Areas of interest." No tag cloud, no sizing/weighting visuals.
- Note: this list is also a privileged 6× signal in the people search index (see Search section). Because the index boost amplifies whatever the AOI threshold lets through, the threshold and the search boost must be calibrated together — a loose AOI threshold makes "cardiology" matches drown out scholars whose primary title is literally "Cardiologist." Treat as a single calibration item.

### Publications

Publications display in **two stacked sections**, because no single ranking formula reasonably balances "this is my career-defining paper from 2010" against "this came out last week." The sections solve different problems.

#### Section 1: Selected highlights (top 3)

Surfaces the publications that best represent the scholar's body of work, regardless of recency.

```
highlight_score =
    authorship_points       // 5 (first or last) | 2 (second or penultimate) | 0
  + type_points             // see type table below
  + impact_points           // log10(citation_count + 1) × 2, capped at 6
                            //   citation count sourced from reciterdb prod
sort highlight_score desc; tiebreak by citation_count desc, then datePublicationAddedToEntrez desc
display top 3; if the scholar has fewer than 3 publications, show what exists
```

**Citation count freshness SLA:** the highlight ranking pivots on `citation_count`. The reciterdb-prod citation values must refresh **at least weekly**, with monitoring on the refresh job. If current cadence is slower, this is a technical-plan task for Mohammad's team. Citation values that lag by months produce visibly wrong rankings for newly-cited papers.

#### Section 2: Recent publications

The scholar's recent output, for visitors looking for current work.

```
recency_score = 8 × exp(-age_years / 5)
                // smooth exponential decay, capped at 8
                // age measured by datePublicationAddedToEntrez

recent_score =
    recency_score
  + authorship_points       // 5 (first/last) | 2 (second/penultimate) | 0
  + type_points             // see type table below
  + impact_points           // log10(citation_count + 1) × 2, capped at 6
sort recent_score desc; tiebreak by datePublicationAddedToEntrez desc
display 10 by default with "Show all" expander
```

Recency is bounded at 8 deliberately so that authorship + type + impact (max 5+4+6 = 15) can outweigh recency for landmark older work. The exponential decay avoids visible bucket cliffs at year boundaries.

#### Type points (shared across both sections)

Based on `publicationTypeCanonical` (mutually exclusive values from ReCiter Feature Generator):

| `publicationTypeCanonical` | Type points |
|---|---|
| Academic Article | 4 |
| Review | 2 |
| Case Report | 2 |
| Preprint | 1 |
| Letter | 0 |
| Editorial Article | 0 |
| Erratum | 0 |

Weights are starting estimates; refine post-launch against feedback.

#### Filtering, display, and presentation

- Filtering: Phase 1 inherits ReCiter's authorship-confirmation logic (only ReCiter-confirmed authorships display). Errata never appear in "Selected highlights."
- Per publication row: title, authors (WCM authors linked to internal profile, others as plain text), journal, year, **citation count** (from reciterdb prod), link out to DOI/PubMed.
- **Abstracts: out of scope for Phase 1.**
- "Copy citation" button: nice-to-have, not blocking launch.
- Featured / top publications curation by the scholar themselves: Phase 3 (per Mohammad's slide 18). Until then, "Selected highlights" is fully algorithmic.

### Grants
- Filtering replicates ReCiter Connect's logic in `GrantsFetchFromED.java`:
  - Exclude `Confidential = 'Y'`
  - Exclude `program_type = 'Contract without funding'`
  - Require non-null `Project_Period_Start` and `Project_Period_End`
  - Include only entries with valid PI / Co-Investigator role (PI, PI-Subaward, Co-PI, Co-I, Key Personnel)
- Display order: active first (current date between start and end), then ended grants by end date desc.
- Display: 10 by default with "Show all" expander. Pubs and grants have **independent** counts: a profile with 9 pubs and 9 grants shows both fully expanded; one with 11 of each shows both collapsed independently.
- Per grant: title, role, funder, dates.

### Empty-state and sparse-profile behavior
- If a section has zero items, the section is hidden entirely (do not display "No grants" or similar).
- If a profile is below a completeness threshold (overview AND fewer than 3 publications AND no active grants), display a single small affordance below the header: _"This profile is being populated. Some content may not yet be available. See [Department of X] for additional information."_ Threshold may be tuned post-launch.
- Sparse profiles are also filtered out of default search results (see Search → People results); their canonical URL still resolves and direct name searches still find them.
- For authenticated owners viewing their own profile, **always surface a "what's missing" checklist** (missing overview, unconfirmed publications in Publication Manager, missing primary appointment, etc.). If the profile passes the completeness threshold, the checklist collapses to a single "Profile complete ✓" indicator that's expandable for review. Not dismissible — it's a passive nudge, not an interruption. This converts the empty-state problem into an action-driving moment for owners regardless of completeness.
- **Track post-launch:** % of profiles with overview + ≥1 publication + ≥1 appointment, weighted by faculty seniority. Watch weekly. Budget intervention if it stays below ~70%.

### Out of profile-page scope for Phase 1
Clinical trials; CV / biosketch export; achievement badges; altmetric badges; news mentions; activity stream; collaboration / network visualizations; geographic maps; timeline / sparkline visualizations; "highly influenced" or related-article surfaces; honors & awards.

## Search

### Inputs
- A single search box, persistent in the site header and prominent on the home page.

### People index — composition

The people index uses **separate fields with explicit relative boosts**, not a single concatenated text blob. This prevents publication-derived terms from drowning out high-signal fields like name and overview.

| Field | Boost |
|---|---|
| Name | 10× |
| Areas of interest (privileged topical signal) | 6× |
| Primary title | 4× |
| Department | 3× |
| Overview statement | 2× |
| Publication titles (per scholar) | 1× |
| Publication MeSH terms (per scholar) | 0.5× |

#### Authorship-weighted contributions for publication-derived signal

When a publication contributes its title and MeSH terms to a scholar's people index, the contribution is weighted by the scholar's authorship position on that paper:

- First or last author: ×1.0
- Second or penultimate author: ×0.4
- Middle author: ×0.1

Implementation note: depending on the search engine's indexing model, this may translate to repeated indexing (term appears N times based on weight) or to per-document field boosts at index time. Either is acceptable. **Search engine choice must support per-field boosting and either term-repetition or per-document field weighting; flag to Mohammad's team if Postgres FTS is being considered, since neither is natively supported there and this would translate to denormalized term-frequency tricks or `setweight()` workarounds.**

#### Minimum-evidence threshold

A topical term contributes to a scholar's index only if **either**: (a) the term appears in ≥2 of their publications, OR (b) the term appears in ≥1 first/last-author publication. This dramatically reduces noise on common topics and prevents one-off middle-author co-authorships from misclassifying scholars.

Known tradeoff: a junior faculty member whose only publications are middle-author papers from grad school will be slightly under-indexed on topical terms compared to peers with first/last-author work. This is the right tradeoff for default search quality but worth being clear-eyed about when reviewing post-launch search-result feedback.

### Publications index — composition
- Separately searchable as a result type.
- Fields: publication title, MeSH terms, journal name, author names. Abstracts not indexed in Phase 1.

### Autocomplete
- Fires after 2 characters.
- Suggests scholar name + primary title (Stanford-style; FunReq Figure C).
- Submitted on Enter or click.

### Results page
- Two sections (or tabs): **People (N)** and **Publications (N)**.
- Default landing on People; switch to Publications via tab.

### People results
- Per row: headshot, name, primary title, primary department, snippet showing matched keywords or terms.
- Sort options: Relevance (default), Last name (A–Z), Most recent publication.
- Filters (faceted sidebar): person type (full-time faculty, adjunct, etc.); department / division; "has active grants" (boolean).
- **Default-result filtering:** profiles below the completeness threshold (see Profile → Empty-state behavior) do not appear in default browse-style results, only in name-anchored searches and at their canonical URLs. This prevents ghost-town profiles from looking like the product is broken.
- **Pagination: numbered, 20 per page.** (Locked: numbered pagination supports deep-linking, predictable analytics, and accessibility better than infinite-scroll for a directory-style product.)

### Publication results
- Per row: title, **WCM co-authors as a stack of clickable name chips** (the genuine differentiator vs PubMed), other authors as plain text, journal, year, citation count, link out to DOI/PubMed.
- Click target: external (DOI/PubMed). **No internal publication detail page in Phase 1.**
- Sort options: Relevance (default), Year (newest first), Citation count.
- **Filters: year-range filter** (e.g., "2020–present"). Trivial to implement and conspicuous by its absence; pulled into Phase 1.

### Out of search scope for Phase 1
Full-text search of abstracts; saved searches; advanced search builder UI; cross-result-type relevance blending; subject-area filter on publications.

## Home page

A lean landing page that prioritizes search per FunReq guidance.

- **Hero:** WCM branding, brief tagline ("Search scholars at Weill Cornell Medicine"), large search box with autocomplete (same component as header search).
- **Stats strip:** "X scholars · Y publications · Last updated [date]." Small, secondary; serves to signal data freshness.
- **Browse entrypoints:** four to six link tiles or chips that link to the search page with a filter pre-applied — e.g., by school/college, major department, person type ("Full-time faculty," "Postdocs").
- **Footer:** WCM standard, plus link to Support page.

### Out of home-page scope for Phase 1
News carousel; featured scholars; recent-publications feed; activity feeds; visualizations.

## Self-edit

### Authentication and access
- SAML via the WCM identity provider.
- Anonymous visitors see the public profile.
- Authenticated visitors see the same profile with inline edit affordances **on their own profile only**.
- One narrowly-scoped admin role for ITS / service desk: can suppress an entire profile or revert a damaging edit. Admin can also paste in overview text on a faculty member's behalf for legitimate proxy-edit requests escalated through the service desk (see "Known launch risk: proxy editing," below).
- Faculty cannot suppress their own profile in Phase 1 (handled via support request).

### What can be edited
- The overview statement only. No other fields are editable in Phase 1.

### Editor behavior
- Simple WYSIWYG with limited formatting: bold, italic, paragraph breaks, **lists**, links. No headings, no images.
- Character limit: ~3,000 characters (~450 words). Hard limit, with live counter. (Not calibrated against existing VIVO bios because those include outliers — multiple cases of 100-page CV pastes — that aren't a useful baseline. Adjust post-launch based on real usage.)
- Save model: explicit Save button, immediate publish, no approval workflow, no staging/preview.
- **Self-edits bypass the daily data refresh pipeline and write through immediately.** A faculty member who edits and refreshes sees their change instantly. This is documented explicitly because the rest of the system runs on a 24-hour refresh.
- History: database tracks updated-at timestamps for audit; no user-facing version history or undo in Phase 1.
- **Edit-event logging:** every overview save is logged to a low-volume monitoring channel (Slack, email digest, or equivalent — target TBD). Lightweight passive review for catching the rare problematic edit; no workflow burden on faculty.

### Overview seeding (one-time, at launch)
- For every profile, seed the overview from the existing VIVO overview if one exists. VIVO overviews were human-authored (even if old) and are migrated as-is, no flag.
- Profiles with no existing VIVO overview start empty. **No LLM auto-generation.**
- Faculty self-edits always override seeded text.
- Goal: preserve every existing human-authored overview without forcing faculty to re-enter what they already wrote.

### Out of self-edit scope for Phase 1
Suppressing appointments, grants, education, or publications; featuring or pinning specific publications; editing structured data; **delegate / proxy editing by assistants, DAs, or DivAs**; preview / staging; approval workflow; multi-version history; suppress own profile.

## Support page

A static page with three short sections:

1. **How to update your profile** — explains overview-statement self-edit; for everything else, points to the source-of-record systems (Enterprise Directory for name / title / email / appointments; ASMS for educational background; InfoEd for grants; ReCiter / Publication Manager for publications). Also covers the proxy-edit-via-service-desk path (see launch-risk note below).
2. **Reporting an issue** — link to the chosen service-desk target (ServiceNow form or email — must be decided pre-build; see Open items).
3. **FAQs** — five to ten Q&As, drafted by the team near launch.

## Sitemap and SEO

- `sitemap.xml` listing all public profile URLs; refreshed on the daily data refresh cycle.
- `robots.txt` allowing indexing of profile and search pages; disallowing internal / authenticated paths.
- Per-page `<title>` and `<meta description>` auto-generated from name + primary title + department. `<link rel="canonical">` on every page.
- **301 redirects** from old VIVO profile URLs to new Scholars URLs. **Requires a URL-pattern audit before build:** VIVO URLs may be a mix of slug-based, ID-based, and hand-curated forms; the redirect mapping is potentially per-record and not a one-line nginx rule. Audit must enumerate the patterns in production and produce a mapping table.

### Deferred to a later phase
- **schema.org `Person` JSON-LD** is deferred until the data refresh pipeline has run cleanly for 4–6 weeks post-launch. JSON-LD shipped with stale or wrong data ends up in Google knowledge panels and is harder to walk back than simply not publishing structured data yet. Sitemap + canonicals + meta tags ship in Phase 1; JSON-LD ships once data quality is validated.
- HTML browse / sitemap page.

## Cross-cutting requirements

- **Mobile responsive.** All Phase 1 pages must render usably on phones (single-column collapse for profile and search results).
- **Daily data refresh** is the assumed cadence for source-system data. **Self-edits are the documented exception:** they write through immediately, bypassing the refresh pipeline.
- **WCM branding standards** apply once published. If standards are still pending at build time, follow Mohammad's existing mockups as a placeholder.

## Analytics

The spec leans heavily on post-launch tuning ("calibrate against feedback," "refine post-launch"). That requires inputs. Phase 1 must instrument:

- **Page views** — per profile, per day. Surfaces high-traffic profiles (calibration priority) and detects orphaned profiles (zero traffic).
- **Search queries** — raw query text, result count, result set type (people vs publications), filters applied. Detects what users are actually searching for and where the index falls short.
- **Search-result CTR** — clicks on result rows by position. Detects whether the top results are actually the right answers.
- **Self-edit completion rate** — % of authenticated owners who save at least one overview edit, tracked weekly. Detects whether the self-edit affordance is discoverable and acceptable.
- **Redirect 404 rate** — incoming requests to old VIVO URLs that don't match a 301. Surfaces gaps in the URL-pattern mapping; spike monitoring during the first weeks post-launch.
- **Profile completeness metric** — % of profiles meeting the completeness threshold, weighted by faculty seniority. Reported weekly, escalated if below ~70% sustained.

Tooling target (Google Analytics, Plausible, custom log pipeline, etc.): TBD; align with WCM analytics standards. Tracked as an open item.

## Known launch risks

### Proxy editing through the service desk
The spec defers delegate editing (where a faculty member can grant edit access to one or two named WCM accounts, typically an assistant or coordinator) to a later phase. This is a real operational gap for an academic medical center: senior faculty often do not log into self-service systems for content edits, and their assistants will email the service desk requesting overview updates on their behalf.

Phase 1 mitigation: the ITS admin role is explicitly scoped to fulfill these requests — paste in overview text supplied by the faculty member (or by a clearly delegated assistant) and save. This is **de facto proxy editing through a slow channel**. Service-desk staffing should account for this volume; documentation on the Support page should set expectations.

Long-term fix: build delegate editing in a later phase. Tracked as a deferred item.

### Sparse profiles at day one
Even with one-time seeding from VIVO and LLM-generated drafts, some profiles will look thin at launch (new hires with no publications attributed, clinicians with light research output, etc.). The completeness threshold + "being populated" affordance + default-search filtering all mitigate this. Watch the post-launch completeness metric closely.

### Daily refresh failures
A failed daily refresh leaves stale data in front of users for 24+ hours. Monitor refresh health. Document the recovery procedure (manual re-run, who's on call) before launch.

### VIVO 301 redirect coverage
If the URL-pattern audit reveals a long tail of unstable or hand-curated VIVO URLs, Phase 1 may launch with imperfect redirect coverage. Quantify the gap before launch and decide whether to delay or accept it.

## Open items (must close before build)

- **Service-desk ticketing target on Support page.** ServiceNow form vs. email. Form, if chosen, must exist before launch.
- **VIVO URL-pattern audit.** Enumerate the existing VIVO URL forms in production and produce the redirect mapping table.

## Open items (close before launch)

- WCM institutional UI / branding standards (tracked as a charter dependency).
- **AOI threshold + search boost calibration** (joint item): the keyword-score threshold for the Areas of Interest list, calibrated together with the 6× search boost applied to AOI matches. A loose threshold + 6× boost produces over-broad search results; a tight threshold + 6× boost produces narrow AOI lists. Calibrate against Publication Manager and a sample of real searches.
- Calibration of publication ranking weights (highlight + recent formulas) against ~20 real WCM profiles spanning the seniority spectrum: junior faculty with thin output, mid-career, and named-chair holders with 200+ papers. The chair-level profiles are where ranking errors generate angry emails.
- Specific completeness threshold for "being populated" affordance and default-search filtering.
- **Edit-event logging target** (Slack channel, email digest, etc.). _Owner: launch lead. Decided by end of design phase — before build begins, not after._
- **Analytics tooling target** (Google Analytics vs Plausible vs custom log pipeline). Align with WCM analytics standards.
- Confirmation of source-system field names for filters (e.g., person type values from Enterprise Directory).
- **Citation-count refresh cadence in reciterdb prod.** Spec target: at least weekly. Confirm current cadence with Mohammad's team; add a refresh job if slower.

## Out of Phase 1 scope (consolidated)

Carried forward from each section above for quick reference:

- **Profile:** clinical trials; CV / biosketch export; achievement badges; altmetric badges; news mentions; activity stream; collaboration / network / geographic / timeline visualizations; honors & awards; abstracts on profile; "highly influenced" articles; scholar-curated featured pubs.
- **Search:** abstract full-text search; saved searches; advanced search builder; cross-result-type relevance blending; subject-area filter on publications.
- **Home:** news carousel; featured scholars; recent-publications feed; activity feed; visualizations.
- **Self-edit:** suppress appointments / grants / education / publications; feature / pin pubs; **delegate / proxy editing**; preview / staging; approval workflow; multi-version history; suppress own profile.
- **Sitemap / SEO:** schema.org `Person` JSON-LD (deferred until data quality validated); HTML browse / sitemap page.

## Phase mapping (per Mohammad's slides 16–19)

For context. This functional spec defines Phase 1 only; later phases evolve in their own functional specs.

- **Phase 2 — Data Enhancement:** abstracts display; selected pages (Person, Organizations, etc.); enhanced search; landing-page marketing/highlight content; **schema.org `Person` JSON-LD** once the refresh pipeline has run clean for 4–6 weeks; HTML browse / sitemap page.
- **Phase 3 — Self-Edit Expanded:** suppress appointments / grants / education / publications; feature top publications; **delegate editing** (faculty designate one or two named WCM accounts as proxies for overview self-edit).
- **Phase 4 — ASMS Central Faculty Profile:** ASMS faculty profile launch; "Scholar Profile" exposed via micro-service.
