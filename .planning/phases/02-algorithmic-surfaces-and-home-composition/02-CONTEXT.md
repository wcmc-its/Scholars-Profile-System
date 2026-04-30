# Phase 2: Algorithmic surfaces and home composition - Context

**Gathered:** 2026-04-30
**Status:** Ready for research / planning

<domain>
## Phase Boundary

Phase 2 ships the Variant B publication-ranking buildout end-to-end and the home page composition mandated by design spec v1.7.1. Concretely:

1. **`lib/ranking.ts` rewrite to Variant B** — `reciterai_impact × authorship_weight × pub_type_weight × recency_weight` with four surface-specific recency curves (Selected highlights, Recent highlights, Recent contributions, Top scholars chip row). Replaces the existing additive Variant A; profile pages adopt Variant B in this phase, not later.
2. **Topic-taxonomy projection ETL extension** — extend the existing ReCiterAI minimal-projection Lambda to land the 67-parent / ~2,000-subtopic taxonomy from DynamoDB into MySQL. MySQL schema shape (separate `topic` table vs columns on `topic_assignment`) is decided in research after inspecting DynamoDB.
3. **Home page composition** — replace the current `app/page.tsx` placeholder with: hero (existing pattern), Recent contributions 3×2 grid (6 cards, scholar-attributed, eligibility-carved, first/senior author only), Selected research subtopic carousel (8 cards, weekly refresh, scroll-snap), Browse all research areas grid (67 parent topics + scholar counts, 4-column).
4. **Topic-page sub-components mounted at a placeholder `/topics/{slug}` route** — Top scholars chip row (7 chips, eligibility-carved, no authorship-position filter) and Recent highlights (3 papers, no citations). Phase 3 fills out the full Topic detail page (rail + main column, sorts, curated tag); Phase 2 ships only enough route surface to verify the two components work against real data and real URLs.
5. **Methodology page at `/about/methodology`** — Phase 2 owns this technical page (formula explanation, eligibility carve, recency-curve descriptions, hard-exclusion list). All algorithmic-surface "How this works" links deeplink to anchor sections on it. `/about` itself ships as a stub or redirect; Phase 4 expands `/about` into the broader institutional page while `/about/methodology` stays at the same URL.

**Out of scope for this phase:**
- Full Topic detail layout (subtopic rail, publication feed, Newest/Most-cited/By-impact/Curated sort dropdown, Curated tag) — Phase 3
- `/about` institutional content (project intro, audience, scope, contact) — Phase 4
- Department detail page — Phase 3
- Browse hub `/browse` — Phase 4
- SEO machinery, sitemap, canonical tags — Phase 5
- Component-render logging surface for absence-as-default monitoring — Phase 6
- Self-edit pipeline — Phase 7
- Variant B weight/curve calibration against ~20 real WCM profiles — post-launch retrospective per spec line 1178 (6-month review trigger by ReCiter lead + methodology page owner)
- `/api/headshot/:cwid` proxy — deferred per ADR-009

</domain>

<decisions>
## Implementation Decisions

### Topic taxonomy data layer
- **D-01:** **Extend the ReCiterAI minimal-projection ETL** to land the parent / subtopic taxonomy from DynamoDB into MySQL. The 67-parent / ~2,000-subtopic hierarchy is authoritative in DynamoDB; Phase 2 brings it through the same projection-Lambda pattern that already lands `topic_assignment` and `publication_score`. The runtime stays MySQL-only per ADR-006.
- **D-02:** **MySQL schema shape is deferred to research** — researcher inspects ReCiterAI's DynamoDB taxonomy structure (probe via the existing minimal-projection script + sample real assignments), then picks whichever shape mirrors it most cleanly. Candidate shapes: (a) new `topic` table with self-FK `parent_id` + `topic_assignment.topic_id`, (b) added `parent_topic` + `subtopic` columns on `topic_assignment`, (c) two tables `topic` + `topic_subtopic` with FK chain. Pick whichever lets Phase 3's `/topics/{slug}` layout B query cleanly.
- **D-03:** **Browse all research areas grid count = distinct scholars per parent topic.** Scholar count is what users will scan ("how big is this area at WCM?"). Eligibility carve question (count all scholars with an assignment vs. only the eligibility-carved population) is left to Claude's discretion — default to "all scholars" since the surface is enumerative (browse hub), not algorithmic. Planner verifies against any explicit spec language.

### Methodology page
- **D-04:** **Phase 2 owns `/about/methodology`** as the technical methodology page. All four algorithmic-surface "How this works" links deeplink to anchor sections (`#recent-contributions`, `#selected-research`, `#top-scholars`, `#recent-highlights`) on this page. Content scope: plain-English Variant B formula explanation, eligibility carve, four recency curves with one-line summaries, letter/editorial/erratum hard-exclusion, six-month calibration review trigger. Pulled directly from `design-spec-v1.7.1.md:1062-1180`.
- **D-05:** **`/about` ships as a stub or redirect** in Phase 2. Stub renders a placeholder ("About this site — coming soon. Methodology: /about/methodology"). Phase 4 expands `/about` into the broader institutional page (project intro, audience, scope, contact, methodology overview). `/about/methodology` stays at the same URL — Phase 4 does not move it.

### Ranking (Variant B retrofit)
- **D-06:** **Phase 2 rewrites profile-page ranking to Variant B alongside the new surfaces.** Single source of truth from day one; eliminates a deprecated formula running in parallel. `lib/ranking.ts` is replaced (or a new `lib/ranking-v2.ts` lands and the old one is deleted). All four surfaces — profile Selected highlights, profile most-recent-papers feed, home Recent contributions, topic Recent highlights, topic Top scholars chip row — derive from the same per-publication scoring fn parameterized by recency curve.
- **D-07:** **Recency-curve buckets are transcribed verbatim from `design-spec-v1.7.1.md:1103-1145` into typed step functions.** Researcher pulls the exact bucket tables (one per surface); planner translates into a typed module (e.g., `recencyWeight(ageMonths, curve: 'selected' | 'recent_highlight' | 'recent_contribution' | 'top_scholars'): number`). The four worked examples in the spec (`design-spec-v1.7.1.md:1150-1173`) become unit-test fixtures.
- **D-08:** **`reciterai_impact` is sourced from `publication_score.score`** — researcher verifies this against the existing minimal-projection Lambda code and the DynamoDB field. If `publication_score.score` is something else, the projection is extended in the same migration that brings parent/subtopic across (D-01).
- **D-09:** **`co-corresponding author` authorship weight is treated as the spec says (1.0)** but the schema has no `is_corresponding` flag on `publication_author`. Researcher decides: (a) leave first/last only at 1.0 and accept the gap, (b) add the field via projection from ReCiter, (c) defer the corresponding-author handling and document the accepted limitation. Document the choice in the methodology page so it's not a hidden inconsistency.

### Surface mounting
- **D-10:** **Phase 2 ships a minimal `/topics/{slug}` placeholder route.** Renders only the hero (topic name), Top scholars chip row, and Recent highlights section. Phase 3 expands this same route with layout B (subtopic rail + filter, publication feed with sort dropdown, Curated tag, "View all N scholars" affordance). Phase 2 success criteria #4 and #5 ("A user visiting any topic page sees…") are verifiable against the placeholder route. Slug source for the placeholder route comes from the Phase 2 taxonomy projection (D-01).

### "Top-tier venues" criterion
- **D-11:** **Trust `reciterai_impact` to encode venue quality** — no separate journal whitelist, no IF-threshold field, no curated venue list. The Variant B formula's top-N selection naturally favors top-tier venues because `reciterai_impact` "incorporates citation count, journal venue, and other quality signals" per spec line 1076. The Recent contributions surface description (`design-spec-v1.7.1.md:511`) is met by formula behavior, not by a separate filter.

### Sparse-state policy
- **D-12:** **Hide a section entirely when below its per-surface floor.** Floors are decided in PLAN.md but should be set conservatively (suggested defaults: ≥3 of 6 cards for Recent contributions, ≥3 of 7 chips for Top scholars, ≥4 of 8 cards for Selected research carousel; Browse grid always renders all 67). When hidden, emit a structured log line so the absence is observable when component-render logging lands in Phase 6. Do NOT relax the eligibility carve, do NOT show fewer with a caveat line, do NOT 5xx — those create either spec drift or fragile UX.

### Claude's Discretion (planner / researcher decide from existing patterns)
- Per-surface floor values for sparse-state hiding (D-12)
- Component file locations under `components/scholar/` / `components/home/` / `components/topic/` (mirror `components/scholar/headshot-avatar.tsx` from Phase 1)
- ISR revalidation cadence for home page and `/topics/{slug}` placeholder (default: combine on-demand revalidation triggered by ETL completion + a fallback time-based TTL of ~6h; planner picks specifics)
- Card layouts within Recent contributions (mockup detail not yet referenced); follow sketch 003-home-landing variant D for the carousel and Browse grid
- Whether `/about` is a stub page vs. a redirect to `/about/methodology` (D-05) — pick the cheaper choice that doesn't constrain Phase 4
- Mobile responsive collapse patterns for Recent contributions 3×2 → 1-col, carousel scroll-snap, Browse grid 4-col → 2-col → 1-col
- Anchor-section IDs on `/about/methodology` (suggested: `#recent-contributions`, `#selected-research`, `#top-scholars`, `#recent-highlights`)
- Authorship role display on Recent contributions cards ("first author", "senior author") — text label vs. icon
- Carousel UX details (arrow buttons + scroll-snap, or scroll-snap only) — sketch 003 winner Variant D shows the pattern

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before research / planning / implementation.**

### Architecture (LOCKED)
- `.planning/PROJECT.md` § "Constraints" + "Key Decisions" — full constraint list including ADR-006 (LOCKED runtime DAL), ADR-008 (LOCKED ISR + on-demand revalidation), eligibility carve, hard-excluded publication types, no citation counts on recent surfaces, design tokens, typography
- `.planning/PROJECT.md` § "Key Decisions" → REQ-publications-ranking row — Variant B resolved 2026-04-30 (multiplicative, surface-keyed recency curves, hard-excludes letters/editorials/errata, scholar-attributed surfaces apply first-or-senior author filter, publication-centric surfaces do not)
- `.planning/ROADMAP.md` § "Phase 2" — goal, dependencies (Phase 1), requirements (RANKING-01, RANKING-02, RANKING-03, HOME-02, HOME-03), five success criteria
- `.planning/REQUIREMENTS.md` → RANKING-01, RANKING-02, RANKING-03, HOME-02, HOME-03 — acceptance criteria

### Design spec — read these line ranges directly
- `.planning/source-docs/design-spec-v1.7.1.md:1062-1180` — Highlight selection formula component spec: `reciterai_impact × authorship_weight × pub_type_weight × recency_weight`, four surface-specific recency curves with bucket tables, three worked examples (use as unit-test fixtures), calibration discipline (six-month post-launch review trigger by ReCiter lead + methodology page owner)
- `.planning/source-docs/design-spec-v1.7.1.md:511-515` — Home page Recent contributions surface: visible plain-English rule, eligibility carve, methodology link, role-tag display
- `.planning/source-docs/design-spec-v1.7.1.md:538` — Topic page Recent highlights surface: 3-column row, no citations, caveat line "Three publications surfaced by ReCiterAI · how this works"
- `.planning/source-docs/design-spec-v1.7.1.md:1127-1145` — Top scholars chip row formula (per-scholar aggregation using Recent highlights recency curve) + surface-specific filter / dedup table
- `.planning/source-docs/design-spec-v1.7.1.md:423-437` — Algorithmic surface guidelines: rule visible in plain English, "How this works" link to a real page, no citation counts on recent surfaces, list of hard-excluded publication types
- `.planning/source-docs/design-spec-v1.7.1.md:377-385` — Algorithmic surface eligibility carve definition (Full-time faculty + Postdoc + Fellow + Doctoral student)

### Sketches — winner variants
- `.planning/sketches/003-home-landing/index.html` + `.planning/sketches/003-home-landing/README.md` — winner Variant D: search-dominant hero + ReCiterAI subtopic carousel with parent-topic breadcrumb, subtopic name, counts, 2 ReCiterAI-selected publications with WCM author chips, italic footnote "Selected by ReCiterAI · methodology"
- `.planning/sketches/004-topic-detail/index.html` + `.planning/sketches/004-topic-detail/README.md` — Topic detail layout reference (Phase 3 wires the full layout; Phase 2 mounts Top scholars + Recent highlights into the placeholder route per D-10)

### Phase 1 carry-forward
- `.planning/phases/01-headshot-integration/01-CONTEXT.md` — `<HeadshotAvatar>` component contract (size variants, props), reused by Recent contributions cards + Top scholars chips per ADR-009 D-06 ("Phases 2 and 3 import the same component when they build their new surfaces")
- `.planning/phases/01-headshot-integration/01-PATTERNS.md` — established surface-mount patterns

### Existing Scholars-Profile-System code
- `lib/ranking.ts` — Variant A additive formula (TO BE REPLACED with Variant B per D-06)
- `lib/api/profile.ts` — profile API serializer; ranking call sites for Selected highlights + most-recent-papers (TO BE UPDATED to Variant B)
- `prisma/schema.prisma:160-191` — `TopicAssignment`, `PublicationScore` models (`topic_assignment.topic` flat string today; D-01 extends)
- `prisma/schema.prisma:114-158` — `Publication` (publicationType, dateAddedToEntrez, citationCount), `PublicationAuthor` (isFirst/isLast/isPenultimate/isConfirmed; no isCorresponding — see D-09)
- `app/page.tsx` — current home page placeholder (TO BE REPLACED with Phase 2 composition)
- `components/ui/` — existing Card / Avatar / Badge primitives; reuse for cards and chips
- `components/scholar/headshot-avatar.tsx` (Phase 1) — reused for Recent contributions cards + Top scholars chips
- `next.config.ts` — `directory.weill.cornell.edu` already in `images.remotePatterns` from Phase 1

### Functional spec for cross-reference
- `.planning/source-docs/functional-spec-phase-1.md` — per-field search boosts, authorship weighting, minimum-evidence threshold (already shipped in Milestone 1 Phase 3); referenced for cross-cutting consistency, not as primary spec for Phase 2 surfaces (design spec v1.7.1 supersedes per spec-precedence stack)

### ETL / data layer
- ReCiterAI minimal-projection Lambda (existing) — to be extended per D-01; researcher locates the source repo / package; PROJECT.md notes the projection lands `publication_score` + `topic_assignments` today

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`<HeadshotAvatar>`** (Phase 1) — drop-in for every scholar render in Recent contributions cards and Top scholars chips. Three size variants already exist (sm / default / lg).
- **`Avatar` + `AvatarFallback`** primitives — fallback path for Top scholars chips when CWID is missing.
- **`components/ui/` shadcn primitives** — Card, Badge, Button, ScrollArea (for carousel scroll-snap)
- **`initials(name)` utility** — already used by Phase 1 components.
- **`lib/api/profile.ts` ranking call sites** — single integration point for Variant B retrofit (D-06).
- **`lib/search.ts`** — established server-side data-fetch pattern for `/api/search` proxy; mirror for any new server-side data fetches Phase 2 needs.
- **`/api/scholars/[cwid]` route handler** — serializer pattern to mirror for new Phase 2 endpoints (e.g., `/api/topics/[slug]` if Phase 3's data needs are pre-fetched here).

### Established Patterns
- **ISR + on-demand revalidation** (ADR-008) — already wired for profile pages; extend to home page and `/topics/{slug}` placeholder. On-demand revalidation already runs on ETL completion via `/api/revalidate`.
- **MySQL-only runtime reads** (ADR-006) — no runtime DynamoDB fetches. All DynamoDB → MySQL flow happens in projection ETL.
- **Hard-coded weight tables in `lib/ranking.ts`** — Variant A pattern (`TYPE_POINTS` const) translates directly to Variant B (`PUB_TYPE_WEIGHTS`, four `RECENCY_CURVES` step-function tables).
- **Server-side serializer fields driven from row + config constant** (Phase 1 D-02) — pattern reusable for any computed fields Phase 2 adds (e.g., topic_slug, parent_topic_slug).

### Integration Points
- **`lib/ranking.ts`** replaced with Variant B; new `score(p, curve, surface): number` factored from the per-publication formula; `aggregateScholarScore(scholar, topic): number` for Top scholars chip row.
- **`lib/api/profile.ts`** updates the highlight + recent feed selection to call new ranking fns; no change to API shape since field names stay the same.
- **`prisma/schema.prisma`** modified per D-01 / D-02 (researcher's pick) — new migration; `cwid_aliases`-style approach (additive, backwards-compatible) preferred over destructive renames.
- **`app/page.tsx`** replaced with composed home page: hero, Recent contributions section, Selected research carousel, Browse all research areas grid.
- **New routes:** `app/(public)/topics/[slug]/page.tsx` (placeholder per D-10), `app/(public)/about/page.tsx` (stub per D-05), `app/(public)/about/methodology/page.tsx` (real page per D-04).
- **New components:** `RecentContributionsGrid`, `RecentContributionCard`, `SelectedResearchCarousel`, `SubtopicCard`, `BrowseAllResearchAreasGrid`, `TopScholarsChipRow`, `TopScholarChip`, `RecentHighlights`, `RecentHighlightCard`, `MethodologyPage`.
- **ETL extension:** ReCiterAI minimal-projection Lambda gains parent/subtopic landing per D-01.

</code_context>

<specifics>
## Specific Ideas

- **Variant B implementation: per-publication formula factored, recency curves parameterized.** A single `scorePublication(p, curve)` fn called four times with different curves keeps the surfaces consistent and makes the worked-example unit tests trivial. The four curves live in a `RECENCY_CURVES` const (step-function tables transcribed from `design-spec-v1.7.1.md:1103-1145`).
- **`/about/methodology` anchor IDs:** `#recent-contributions`, `#selected-research`, `#top-scholars`, `#recent-highlights`. Each surface's "How this works" link uses the matching anchor.
- **`/topics/{slug}` placeholder layout:** hero (topic name + count) + Top scholars chip row + Recent highlights. No layout B yet (Phase 3). The placeholder satisfies Phase 2 success criteria #4 and #5.
- **Calibration carry-forward:** spec calls for ReCiter lead + methodology page owner six-month post-launch review (`design-spec-v1.7.1.md:1175-1180`). Phase 2 ships the formula; calibration is post-launch. Methodology page should mention the review window to set expectations.
- **Per-surface floor defaults (Claude's discretion, planner refines):** Recent contributions ≥3 of 6, Top scholars ≥3 of 7, Selected research ≥4 of 8. Browse grid always renders all 67 (no floor — if fewer than 67 parents exist, that's a data-layer bug).
- **"Selected by ReCiterAI · methodology" footnote** on subtopic cards (sketch 003 variant D) — the "methodology" word is the link to `/about/methodology#selected-research`.

</specifics>

<deferred>
## Deferred Ideas

- **Phase 3 — Topic detail full layout B:** subtopic rail (sorted by pub count desc, "Less common" divider for n≤10, filter input), main publication feed with Newest / Most cited / By impact / Curated by ReCiterAI sort dropdown, Curated tag when AI sort active, "View all N scholars in this area →" affordance. Phase 2 ships only the Top scholars row + Recent highlights into the placeholder route.
- **Phase 4 — `/about` institutional content:** project intro, audience, scope, contact, methodology overview. Phase 2's `/about` stub gets replaced; `/about/methodology` stays at the same URL.
- **Phase 6 — Component-render logging surface:** Phase 2 emits structured log lines for sparse-state hidden sections (D-12) so the data exists when the logging surface lands. Full operational dashboard is Phase 6.
- **Post-launch calibration retrospective:** six-month review of weights + curves against actual outputs, by ReCiter lead + methodology page owner per `design-spec-v1.7.1.md:1175-1180`. No code change in Phase 2.
- **Co-corresponding author flag:** `publication_author.is_corresponding` not currently in schema (D-09). Decision to add via ReCiter projection deferred unless researcher concludes it's trivial.
- **Drop deprecated `lib/ranking.ts` Variant A code path** — done as part of Phase 2 D-06; if any consumer outside `lib/api/profile.ts` exists, planner picks whether to retain shim or fail loudly.
- **`/api/headshot/:cwid` proxy** — deferred per ADR-009 (carried forward from Phase 1).
- **Variant B weight calibration against ~20 real WCM profiles spanning seniority** — open stakeholder item carrying forward from Milestone 1; not a Phase 2 deliverable. Acknowledge in methodology page copy.

</deferred>

---

*Phase: 2 — Algorithmic surfaces and home composition*
*Context gathered: 2026-04-30*
