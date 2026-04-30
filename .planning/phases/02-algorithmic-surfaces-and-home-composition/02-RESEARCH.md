# Phase 2: Algorithmic surfaces and home composition - Research

**Researched:** 2026-04-30
**Domain:** Variant B publication ranking, Next.js 15 ISR + on-demand revalidation, Prisma 7 + MySQL, ReCiterAI DynamoDB minimal-projection ETL extension, shadcn/ui Tailwind 4 home page composition
**Confidence:** HIGH on the codebase shape, formula transcription, and ISR patterns; MEDIUM on the role-eligibility data path (data feed for Postdoc / Fellow / Doctoral student does not exist yet — see landmine §3); MEDIUM on the DynamoDB taxonomy structure (live probe required before final schema choice).

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** Extend the ReCiterAI minimal-projection ETL (the `etl/dynamodb` script) to land the parent / subtopic taxonomy from DynamoDB into MySQL. Runtime stays MySQL-only per ADR-006.
- **D-02:** MySQL schema shape for the taxonomy is deferred to research — researcher inspects DynamoDB structure (probe + sample), then picks (a) new `topic` table with self-FK `parent_id` + `topic_assignment.topic_id`, (b) added `parent_topic` + `subtopic` columns on `topic_assignment`, or (c) two tables `topic` + `topic_subtopic` with FK chain.
- **D-03:** Browse all research areas grid count = distinct scholars per parent topic; "all scholars" not eligibility-carved (enumerative surface).
- **D-04:** Phase 2 owns `/about/methodology` as the technical methodology page. Anchor IDs: `#recent-contributions`, `#selected-research`, `#top-scholars`, `#recent-highlights`. Content scope: plain-English Variant B formula, eligibility carve, four recency curves, hard-exclusion list, six-month calibration review trigger.
- **D-05:** `/about` ships as a stub (or redirect to `/about/methodology`) in Phase 2. Phase 4 expands it.
- **D-06:** Phase 2 rewrites profile-page ranking to Variant B alongside the new surfaces. `lib/ranking.ts` is replaced; profile Selected highlights and most-recent-papers feed migrate to Variant B in this phase. All four surfaces derive from the same per-publication scoring fn parameterized by recency curve.
- **D-07:** Recency-curve buckets transcribed verbatim from `design-spec-v1.7.1.md:1103-1145` into typed step functions. Worked examples (`design-spec-v1.7.1.md:1150-1173`) become unit-test fixtures.
- **D-08:** `reciterai_impact` is sourced from `publication_score.score` (verify against minimal-projection Lambda; if mismatch, extend projection).
- **D-09:** `co-corresponding author` weight 1.0 — but schema has no `is_corresponding` flag. Researcher decides between (a) leave first/last only at 1.0, (b) add the field via projection from ReCiter, (c) defer and document the limitation.
- **D-10:** Phase 2 ships a minimal `/topics/{slug}` placeholder route — hero (topic name) + Top scholars chip row + Recent highlights only. Phase 3 expands to layout B.
- **D-11:** Trust `reciterai_impact` to encode venue quality. No separate journal whitelist or IF threshold.
- **D-12:** Hide a section entirely when below per-surface floor. Suggested defaults: Recent contributions ≥3 of 6, Top scholars ≥3 of 7, Selected research ≥4 of 8. Browse grid always renders all 67. Emit structured log line on hide.

### Claude's Discretion

- Per-surface floor values for sparse-state hiding (D-12)
- Component file locations under `components/scholar/` / `components/home/` / `components/topic/` (mirror `components/scholar/headshot-avatar.tsx`)
- ISR revalidation cadence for home page and `/topics/{slug}` placeholder (default: combine on-demand revalidation triggered by ETL completion + a fallback time-based TTL of ~6h)
- Card layouts within Recent contributions (follow sketch 003 variant D)
- Whether `/about` is a stub vs. a redirect to `/about/methodology` (D-05)
- Mobile responsive collapse patterns
- Anchor-section IDs on `/about/methodology` (suggested IDs already locked in D-04)
- Authorship role display label vs icon
- Carousel UX details (arrow buttons + scroll-snap, or scroll-snap only)

### Deferred Ideas (OUT OF SCOPE)

- Phase 3 — Topic detail full layout B (subtopic rail, publication feed, sort dropdown, "View all N scholars" affordance, Curated tag)
- Phase 4 — `/about` institutional content (project intro, audience, scope, contact)
- Phase 6 — Component-render logging surface (Phase 2 emits structured log lines for sparse-state hides; full dashboard later)
- Post-launch six-month calibration retrospective (no code change in Phase 2)
- Co-corresponding author flag in schema (default to D-09 option (a) unless researcher concludes adding it is trivial)
- Drop deprecated Variant A `lib/ranking.ts` code path (done as part of D-06)
- `/api/headshot/:cwid` proxy (deferred per ADR-009)
- Variant B weight calibration against ~20 real WCM profiles (post-launch)

</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| RANKING-01 | Home Recent contributions: 3×2 grid of 6 scholar cards; first-or-senior author filter; eligibility carve (Full-time faculty + Postdoc + Fellow + Doctoral student); no citation counts; methodology link visible | Variant B per-publication scoring (§Variant B math); eligibility carve requires new `scholar.role_category` field (§Landmine 3); cards reuse `<HeadshotAvatar size="md">` from Phase 1 |
| RANKING-02 | Topic Recent highlights: 3 paper cards; publication-centric (no authorship-position filter); no citation counts; methodology link visible | Same per-publication scorer as RANKING-01 with `recent_highlights` recency curve; pool = all scored publications attributed to topic |
| RANKING-03 | Topic Top scholars chip row: 7 chips; publication-centric in scope but eligibility carve applies; first-or-senior author per spec line 1135 | Per-scholar aggregation: `SUM(per_pub_score)` over scholar's papers in topic with the `recent_highlights` recency curve and first-or-senior filter (apparent contradiction with "publication-centric" — see §Variant B math note); reuse `<HeadshotAvatar size="sm">` |
| HOME-02 | Selected research carousel: 8 subtopic cards in horizontal scroll-snap; visible rule "Eight subtopics with the strongest recent activity at WCM, one per parent area, refreshed weekly"; methodology link | Requires parent/subtopic taxonomy (D-01/D-02) — does NOT currently exist in MySQL. Per-subtopic activity score = sum of per-publication Variant B scores in that subtopic with `recent_highlights` curve; one-per-parent dedup; top-8 |
| HOME-03 | Browse all research areas: 67 parent topic names + scholar counts in 4-col grid | Requires parent topic table (D-01); count = distinct scholars per parent (D-03, no eligibility filter) |

</phase_requirements>

---

## Summary

Phase 2 is a four-track build sitting on top of an already-shipped Milestone 1 prototype:

1. **Ranking math rewrite (`lib/ranking.ts`)** — replace the additive Variant A formula (`authorship_points + type_points + impact_points + recency_score`) with the multiplicative Variant B formula (`reciterai_impact × authorship_weight × pub_type_weight × recency_weight`) parameterized by four recency curves. Five existing call sites (profile Selected highlights, profile most-recent-papers, plus three new home/topic surfaces) all consume the same `scorePublication(p, curve)` factored function. The four worked examples on `design-spec-v1.7.1.md:1150-1173` become unit-test fixtures.

2. **Topic taxonomy ETL extension (`etl/dynamodb/index.ts`)** — extend the existing minimal-projection ETL to land the 67-parent / ~2,000-subtopic taxonomy hierarchy from the `reciterai-chatbot` DynamoDB table into MySQL. Schema choice (separate `topic` table vs. flat columns on `topic_assignment`) is locked behind a probe step against live DynamoDB. Three Prisma migration shapes are evaluated below.

3. **Home page composition (`app/page.tsx`)** — replace the three-line placeholder with hero + stats strip + `RecentContributionsGrid` + `SelectedResearchCarousel` + `BrowseAllResearchAreasGrid`. ISR with on-demand revalidation triggered by ETL completion (`/api/revalidate` hook already exists from Milestone 1).

4. **Topic placeholder route (`app/(public)/topics/[slug]/page.tsx`)** plus methodology page (`app/(public)/about/methodology/page.tsx`) plus `/about` stub.

**Two architectural landmines must be resolved before planning lands:** the eligibility-carve data feed does not currently exist (no role-category field on `scholar`; `etl/search-index/index.ts:120` hard-codes `personType = "Faculty"`), and the design tokens referenced by the UI-SPEC (`--space-3`, `--text-sm`, `--text-4xl`, `--weight-semibold`) are declared in the sketch theme `.planning/sketches/themes/default.css` but **not in the live `app/globals.css`**. Both are Wave 0 prerequisites — they are not optional and they are not "discovered during execution," they are visible from research time and must be in the plan as explicit early-wave tasks.

**Primary recommendation:** Plan around five waves: (W0) eligibility-carve data feed + design-token port + DynamoDB probe; (W1) Variant B core rewrite + golden test fixtures; (W2) DynamoDB taxonomy ETL extension + Prisma migration; (W3) home composition + topic placeholder + methodology page; (W4) integration tests + visual verification + ETL-completion revalidation hook. Wave 0 is non-negotiable; W1–W3 can be parallelized in worktrees because they touch disjoint trees once W0 lands.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Variant B per-publication scoring fn | API / Backend (`lib/ranking.ts`) | — | Pure function; consumed by both server-component data fetchers (profile, home) and ETL projection if scoring ever pre-computes |
| Surface query construction (top-N papers, top-N scholars per topic, top-8 subtopics) | API / Backend (`lib/api/*`) | Database / Storage | Server-side composition; pulls from MySQL via Prisma; results memoized by ISR |
| Eligibility carve filter (Full-time faculty + Postdoc + Fellow + Doctoral student) | ETL (sets `scholar.role_category`) | API / Backend (filters at query time) | Source-of-truth derivation lives in ED ETL where `weillCornellEduPersonTypeCode` + `weillCornellEduFTE` are read; query layer treats it as a stored field (no derivation at request time) |
| Topic taxonomy projection | ETL (`etl/dynamodb`) | Database / Storage | One-way DynamoDB → MySQL; no runtime DDB reads |
| Home page composition | Frontend Server (Next.js Server Component, ISR) | API / Backend | `app/page.tsx` is a Server Component; pulls data via `lib/api/home.ts`; ISR with on-demand revalidate via `/api/revalidate` |
| Carousel scroll-snap interaction | Browser / Client | — | Native CSS `scroll-snap-type` + `scroll-snap-align`; no JS state |
| Methodology page | Frontend Server (Static / SSG) | — | Pure prose; `export const dynamic = 'force-static'`; no data fetching |
| Sparse-state hide + structured log emission | Frontend Server | — | Decision happens at server-component data-fetch time; log line emitted to stdout (Phase 6 consumes) |

---

## Standard Stack

### Core

| Library | Version in Project | Purpose | Why Standard |
|---------|-------------------|---------|--------------|
| `next` | 15.5.15 [VERIFIED: package.json] | App Router, ISR via `revalidate`, on-demand via `revalidatePath`, Server Components | Locked by ADR-008; already wired for Milestone 1 |
| `@prisma/client` | ^7.8.0 [VERIFIED: package.json] | Type-safe MySQL queries; aggregations via `groupBy`, raw SQL fallback for complex top-N joins | Locked stack; client already generated to `lib/generated/prisma` |
| `@prisma/adapter-mariadb` | ^7.8.0 [VERIFIED: package.json] | MariaDB-compatible adapter — runs against MySQL 8 / Aurora MySQL | Already configured in `prisma/schema.prisma` |
| `@aws-sdk/client-dynamodb` + `@aws-sdk/lib-dynamodb` | ^3.1039.0 [VERIFIED: package.json] | Scan + project DynamoDB items; already used by `etl/dynamodb/index.ts` | Pattern established Milestone 1 |
| `react` | 19.0.0 [VERIFIED: package.json] | Server Components for home + topic pages | Locked |
| `radix-ui` | ^1.4.3 [VERIFIED: package.json] | Avatar primitive (already used by `<HeadshotAvatar>`); ScrollArea (to be installed) | Already in project |
| `tailwindcss` | ^4.0.0 [VERIFIED: package.json] | Utility CSS for grid, scroll-snap, responsive collapse | Tailwind 4 idiom: `@theme` block in CSS, no `tailwind.config.js` |
| `lucide-react` | ^0.469.0 [VERIFIED: package.json] | Icons for chips, carousel arrows (if used) | Locked icon library per `components.json` |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `vitest` | ^3.0.2 [VERIFIED: package.json] | Unit tests for Variant B math + golden fixtures from worked examples | All four worked-example fixtures in spec → vitest cases |
| `@testing-library/react` | ^16.1.0 [VERIFIED: package.json] | Component tests for sparse-state hides, "view all" affordances | Mirror existing `tests/unit/headshot-avatar.test.tsx` |
| `@playwright/test` | ^1.49.1 [VERIFIED: package.json] | E2E for home page render + topic placeholder render | Mirror `tests/e2e/home.spec.ts` |

### To Be Added (shadcn primitives)

```bash
npx shadcn@latest add scroll-area
npx shadcn@latest add skeleton
```

Both are listed in UI-SPEC §Component Inventory; not currently installed (verified by `ls components/ui/` — only avatar, badge, button, card, collapsible, separator, tabs).

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Native CSS `scroll-snap-type: x mandatory` for the carousel | `embla-carousel-react` or similar JS library | Native scroll-snap is zero-bundle, supported in all modern browsers, and matches sketch 003 Variant D pattern. Library adds ~10KB and only earns its weight if we need keyboard navigation, dot indicators, or programmatic scroll — UI-SPEC says no arrow buttons required. Stay native. |
| Server-Component-direct DB read in `app/page.tsx` | API call to `/api/home` | Server Component direct read mirrors the existing profile page pattern (`app/(public)/scholars/[slug]/page.tsx` calls `getScholarFullProfileBySlug` directly). Avoids serialization round-trip. Reserve `/api/home` for if/when we need the data exposed to a non-Next consumer. |
| Three Prisma raw queries (one per surface) | Single Prisma `findMany` with `include` and post-filter in JS | Surface-specific top-N queries differ enough that three targeted queries are cleaner and faster than one mega-fetch. Each surface has different ranking + filter criteria. |

**Version verification (run before final lock-in):**
```bash
npm view @prisma/client version
npm view next version
npm view @aws-sdk/client-dynamodb version
```
Verified once at research time (2026-04-30); re-verify if Phase 2 execution slips by >7 days.

---

## Architecture Patterns

### System Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│                              SOURCES (read-only)                         │
│   ED LDAP        ASMS         InfoEd       ReCiterDB     ReCiterAI       │
│  (active        (educa-      (grants)     (citations,    DynamoDB        │
│   faculty)      tion)                      MeSH)         (impact +       │
│                                                          taxonomy)       │
└────┬──────────────┬──────────────┬─────────────┬──────────────┬──────────┘
     │              │              │             │              │
     v              v              v             v              v
┌──────────────────────────────────────────────────────────────────────────┐
│                       ETL ORCHESTRATOR (etl/orchestrate.ts)              │
│   ED → ASMS → InfoEd → ReCiter → COI → DynamoDB-projection → search-idx  │
│   ED-first abort cascade; each step staging→atomic-swap                  │
│                                                                          │
│   Phase 2 modifies:                                                      │
│   • etl/ed/index.ts  → derive scholar.role_category (NEW field)          │
│   • etl/dynamodb/index.ts → land taxonomy + (verify) publication_score   │
└────┬─────────────────────────────────────────────────────────────────────┘
     │
     v                                    Fires after each ETL step
┌──────────────────────────────────────────────────────────────────────────┐
│                    MySQL 8 / Aurora MySQL (runtime store)                │
│  scholar    appointment   publication   publication_author               │
│  topic      topic_assignment   publication_score                         │
│            (NEW or extended schema per D-01/D-02)                        │
└────┬─────────────────────────────────────────────────────────────────────┘
     │ (Prisma)
     v
┌──────────────────────────────────────────────────────────────────────────┐
│                         APPLICATION LAYER                                │
│                                                                          │
│   lib/ranking.ts  ─────  Variant B scoring (per-pub + per-scholar agg)   │
│         │                                                                │
│         ├── lib/api/profile.ts  ───  Selected highlights + recent feed   │
│         ├── lib/api/home.ts (NEW) ─  Recent contributions, Selected      │
│         │                            research, Browse all areas          │
│         └── lib/api/topics.ts (NEW) ─ Top scholars, Recent highlights    │
│                                                                          │
│   Server Components (ISR):                                               │
│     app/page.tsx                ←  composes home (Phase 2)               │
│     app/(public)/scholars/[slug]   ←  profile (already shipped, retrofit │
│                                       ranking call sites in W1)          │
│     app/(public)/topics/[slug] (NEW) ← placeholder per D-10              │
│     app/(public)/about/methodology (NEW) ← static prose per D-04         │
│     app/(public)/about (NEW) ← stub per D-05                             │
└────┬─────────────────────────────────────────────────────────────────────┘
     │
     v
┌──────────────────────────────────────────────────────────────────────────┐
│                    BROWSER (Server-rendered HTML + light JS)             │
│   Server-rendered home + topic + methodology pages                       │
│   Client islands: HeadshotAvatar (state for image load),                 │
│                   carousel scroll-snap (native CSS)                      │
└──────────────────────────────────────────────────────────────────────────┘

REVALIDATION PATH:
   ETL writes → POST /api/revalidate?path=/   ─────────┐
   ETL writes → POST /api/revalidate?path=/topics/[slug] (per slug, optional)
                          ↓
              revalidatePath() invalidates ISR cache
                          ↓
              Next request triggers re-render against fresh MySQL data
```

### Recommended Project Structure

```
app/
├── page.tsx                          # MODIFIED: home composition
├── (public)/
│   ├── topics/
│   │   └── [slug]/
│   │       └── page.tsx              # NEW: placeholder per D-10
│   └── about/
│       ├── page.tsx                  # NEW: stub per D-05
│       └── methodology/
│           └── page.tsx              # NEW: methodology page per D-04
└── api/
    └── revalidate/
        └── route.ts                  # already exists from Milestone 1; verify accepts `/` and `/topics/{slug}` paths

components/
├── home/                             # NEW directory
│   ├── recent-contributions-grid.tsx
│   ├── recent-contribution-card.tsx
│   ├── selected-research-carousel.tsx
│   ├── subtopic-card.tsx
│   └── browse-all-research-areas-grid.tsx
├── topic/                            # NEW directory
│   ├── top-scholars-chip-row.tsx
│   ├── top-scholar-chip.tsx
│   ├── recent-highlights.tsx
│   └── recent-highlight-card.tsx
├── methodology/                      # NEW directory (optional — could inline in page)
│   └── recency-curve-table.tsx
└── ui/
    ├── scroll-area.tsx               # NEW: shadcn add
    └── skeleton.tsx                  # NEW: shadcn add

lib/
├── ranking.ts                        # REWRITE: Variant B replaces Variant A
├── api/
│   ├── home.ts                       # NEW
│   ├── topics.ts                     # NEW
│   └── profile.ts                    # MODIFIED: switch ranking call sites to Variant B
└── eligibility.ts                    # NEW: encapsulates the role_category check

etl/
├── ed/
│   └── index.ts                      # MODIFIED: derive role_category from personTypeCode + FTE
├── dynamodb/
│   └── index.ts                      # MODIFIED: extend to land taxonomy + (verify) publication_score
└── search-index/
    └── index.ts                      # MODIFIED: replace `personType = "Faculty"` placeholder

prisma/
├── schema.prisma                     # MODIFIED: add Topic table + scholar.role_category column (per D-01/D-02 schema choice)
└── migrations/
    └── 2026XXXX_phase2_topics_and_role/
        └── migration.sql             # NEW

tests/
├── unit/
│   ├── ranking.test.ts               # REWRITE: Variant B fixtures from spec worked examples
│   ├── eligibility.test.ts           # NEW
│   └── home-api.test.ts              # NEW
├── e2e/
│   ├── home.spec.ts                  # MODIFIED: assert new sections present
│   ├── topic-placeholder.spec.ts     # NEW
│   └── methodology.spec.ts           # NEW
└── fixtures/
    ├── ranking-worked-examples.ts    # NEW: spec fixtures from §1150-1173
    └── topic-fixture.ts              # NEW
```

### Pattern 1: Variant B per-publication scoring (D-06, D-07)

**What:** A single pure function `scorePublication(p, curve)` parameterized by recency curve. Four call-site wrappers (one per surface) apply surface-specific filters and dedup. Per-scholar aggregation for Top scholars chip row sums the per-publication scores.

**When to use:** Every algorithmic surface in Phase 2 (Recent contributions, Recent highlights, Top scholars, Selected research carousel) AND the two profile surfaces (Selected highlights, most-recent feed) when retrofitted in W1.

**Example structure (approximate; planner refines):**

```typescript
// lib/ranking.ts (Variant B)

export type RecencyCurve =
  | "selected_highlights"   // profile Selected highlights (skews older)
  | "recent_highlights"     // topic Recent highlights (heavy recency, 0-3mo penalty)
  | "recent_contributions"  // home Recent contributions (same shape as recent_highlights)
  | "top_scholars";         // top scholars uses recent_highlights curve per spec line 1127

const RECENCY_CURVES: Record<RecencyCurve, (ageMonths: number) => number> = {
  selected_highlights: (m) => {
    if (m < 6) return 0;
    if (m < 18) return 0.7;
    if (m < 120) return 1.0;        // 18mo–10yr peak
    if (m < 240) return 0.7;        // 10–20yr
    return 0.5;                     // 20+yr
  },
  recent_highlights: (m) => {
    if (m < 3) return 0.4;          // immaturity penalty
    if (m < 6) return 0.7;
    if (m < 18) return 1.0;         // peak
    if (m < 36) return 0.8;         // 18mo–3yr
    return 0.4;                     // 3+yr
  },
  recent_contributions: (m) => RECENCY_CURVES.recent_highlights(m),  // same shape per spec line 1125
  top_scholars: (m) => RECENCY_CURVES.recent_highlights(m),          // per spec line 1127
};

const PUB_TYPE_WEIGHTS: Record<string, number> = {
  "Academic Article": 1.0,
  Review: 0.7,
  "Case Report": 0.5,
  Preprint: 0.7,
  Letter: 0,
  "Editorial Article": 0,
  Erratum: 0,
};

function authorshipWeight(a: AuthorshipPosition, scholarCentric: boolean): number {
  // Scholar-centric surfaces: only first or last (or co-corresponding per D-09); else 0 (filtered).
  // Publication-centric surfaces (Recent highlights): authorship weight = 1.0 for all positions
  //   (per spec line 1087: "On publication-centric surfaces, authorship position is not filtered").
  if (!scholarCentric) return 1.0;
  if (a.isFirst || a.isLast) return 1.0;
  return 0;  // middle author filtered on scholar-centric surfaces
}

export function scorePublication(
  p: { reciteraiImpact: number; publicationType: string | null;
       authorship: AuthorshipPosition; dateAddedToEntrez: Date | null },
  curve: RecencyCurve,
  scholarCentric: boolean,
  now: Date = new Date(),
): number {
  const aw = authorshipWeight(p.authorship, scholarCentric);
  if (aw === 0) return 0;
  const tw = PUB_TYPE_WEIGHTS[p.publicationType ?? ""] ?? 0;
  if (tw === 0) return 0;  // hard exclude letters/editorials/errata
  const ageMonths = monthsBetween(p.dateAddedToEntrez, now);
  const rw = RECENCY_CURVES[curve](ageMonths);
  return p.reciteraiImpact * aw * tw * rw;
}

// Per-scholar aggregation for Top scholars chip row (spec line 1127-1135)
export function aggregateScholarScore(
  pubs: Array<RankablePub>,
  curve: RecencyCurve = "top_scholars",
): number {
  // First-or-senior filter applies (spec line 1135)
  return pubs.reduce((sum, p) => sum + scorePublication(p, curve, true), 0);
}
```

**Critical fixtures (from `design-spec-v1.7.1.md:1150-1173`):**
- Example 1: Whitcomb 2003 Annals paper, senior author, 23yr old, impact 0.92 → Selected highlights score 0.46
- Example 2: Same paper as Recent highlight on topic page → score 0.37
- Example 3: 14-month-old NEJM paper, postdoc first author, impact 0.88 → Recent contributions score 0.88

These three become `tests/fixtures/ranking-worked-examples.ts` and drive `tests/unit/ranking.test.ts` cases.

### Pattern 2: Surface query construction with surface-specific filters

**What:** Each algorithmic surface has its own data-fetch function in `lib/api/{home,topics}.ts`. The function pulls candidates from MySQL via Prisma, calls `scorePublication`, applies surface-specific filters, sorts, and slices.

**Example: home Recent contributions (D-12 sparse-state floor handled here):**

```typescript
// lib/api/home.ts
export async function getRecentContributions(now = new Date()): Promise<HomeContribution[] | null> {
  // Pull candidate publications: scored (publication_score row exists), confirmed authorship,
  // scholar in eligibility carve, first OR senior author.
  const rows = await prisma.publicationAuthor.findMany({
    where: {
      isConfirmed: true,
      OR: [{ isFirst: true }, { isLast: true }],
      scholar: {
        deletedAt: null,
        status: "active",
        roleCategory: { in: ["full_time_faculty", "postdoc", "fellow", "doctoral_student"] },
      },
      publication: {
        publicationType: { notIn: ["Letter", "Editorial Article", "Erratum"] },
        publicationScores: { some: {} },  // has a ReCiterAI score
      },
    },
    include: {
      publication: { include: { publicationScores: true } },
      scholar: { select: { cwid: true, slug: true, preferredName: true,
                          primaryTitle: true, roleCategory: true } },
    },
  });

  const scored = rows
    .map((r) => ({
      ...r,
      score: scorePublication(
        {
          reciteraiImpact: r.publication.publicationScores[0]?.score ?? 0,
          publicationType: r.publication.publicationType,
          authorship: { isFirst: r.isFirst, isLast: r.isLast, isPenultimate: r.isPenultimate },
          dateAddedToEntrez: r.publication.dateAddedToEntrez,
        },
        "recent_contributions",
        true,  // scholar-centric
        now,
      ),
    }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);

  // Dedup: one per parent research area (spec line 1143)
  const seenAreas = new Set<string>();
  const top: typeof scored = [];
  for (const r of scored) {
    const area = r.parentTopicSlug;  // requires topic taxonomy from D-01
    if (seenAreas.has(area)) continue;
    seenAreas.add(area);
    top.push(r);
    if (top.length >= 6) break;
  }

  // D-12 sparse-state floor: hide if <3 of 6
  if (top.length < 3) {
    console.warn(JSON.stringify({
      event: "sparse_state_hide", surface: "home_recent_contributions",
      qualifying: top.length, floor: 3,
    }));
    return null;
  }
  return top.map(toContribution);
}
```

### Pattern 3: ISR + on-demand revalidation per ADR-008

**What:** Server Components export `revalidate` (TTL fallback) and rely on `revalidatePath('/')` fired by `/api/revalidate` after ETL completion. Already wired in Milestone 1 for profile pages.

```typescript
// app/page.tsx (Phase 2)
export const revalidate = 21600;       // 6h fallback per Claude's discretion default
export const dynamicParams = true;

// app/(public)/topics/[slug]/page.tsx
export const revalidate = 21600;
export const dynamicParams = true;
```

**ETL completion hook (already exists):** `app/api/revalidate/route.ts` — verify it accepts `/` and `/topics/[slug]`. If currently scoped only to `/scholars/[slug]`, plan a small extension in W4.

### Anti-Patterns to Avoid

- **Computing role category at request time** from `appointment.title` strings or LDAP fields — derivation lives in ETL, stored as `scholar.role_category`. Querying every render is slow and the derivation rule is in one place.
- **One mega-Prisma query** that pulls all candidates and sorts in JS for all five surfaces. Each surface has different filters; three targeted queries are cleaner and faster.
- **Putting the recency curve table in client code.** It's server-only logic in `lib/ranking.ts`; never exposed to browser.
- **Hand-rolling a carousel.** Use native CSS `scroll-snap-type: x mandatory` + `scroll-snap-align: start` on cards. Zero JS. Sketch 003 Variant D demonstrates the pattern.
- **Inline reading of design tokens via JS** — tokens are CSS vars in `app/globals.css`; reference via Tailwind utilities or `var(--space-3)` in component CSS. Do not duplicate token values in TS.
- **Querying DynamoDB at request time.** Locked by ADR-006. All taxonomy reads go through MySQL via the projection ETL.
- **Skipping the ETL probe before schema design.** The DynamoDB taxonomy structure is not documented in code; running `etl/dynamodb/index.ts` (or a probe variant) and inspecting actual records is a Wave 0 prerequisite — guessing the shape leads to a migration rewrite.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Horizontal carousel | Custom scroll JS, intersection observer | Native CSS `scroll-snap-type: x mandatory` on the wrapper + `scroll-snap-align: start` on each card | Zero bundle, hardware-accelerated, accessible, matches sketch 003 Variant D |
| Skeleton loading state | Custom shimmer animation | `npx shadcn add skeleton` | shadcn primitive already has the right token-based fade |
| Image avatar with 404 fallback | Custom `<img onError>` handler | `<HeadshotAvatar>` from Phase 1 (`components/scholar/headshot-avatar.tsx`) | Already shipped; size variants `sm`/`md`/`lg` already match Phase 2 use cases |
| 4-col → 2-col → 1-col responsive grid | CSS calc + media queries | Tailwind 4 `grid-cols-1 md:grid-cols-2 lg:grid-cols-4` | Already in project's idiom |
| ISR revalidation triggered by ETL | Custom HTTP webhook + state file | Existing `/api/revalidate` route (Milestone 1) + `revalidatePath` | Pattern proven; ETL already calls it for `/scholars/[slug]` |
| Per-publication ranking | New formula | `lib/ranking.ts` rewrite per D-06/D-07 (factored `scorePublication`) | Single source of truth across all five call sites |
| Per-scholar aggregation for Top scholars | Hand-tuned heuristic | `aggregateScholarScore = SUM(scorePublication for scholar's first-or-senior pubs in topic)` per spec line 1129-1133 | Spec-mandated; resists post-launch drift |
| Topic taxonomy data layer | Hard-coded JSON file in repo | DynamoDB → MySQL minimal projection (extend `etl/dynamodb`) | Locked by ADR-006; refresh cadence aligns with weekly ReCiterAI updates |
| Sparse-state hiding | Conditional 5xx, "no results" empty state | Section returns `null`; layout omits the entire section; structured log line emitted | D-12 — UX policy: never shrink-or-caveat; hide entirely |

**Key insight:** Phase 2 is overwhelmingly extension and composition over Milestone 1 primitives. Almost nothing new is needed at the primitive layer beyond shadcn `scroll-area` and `skeleton`. Most of the build is wiring up the already-existing ranking factor inputs (publication_score, publication metadata, authorship flags) into a multiplicative formula and four queries.

---

## Runtime State Inventory

> Phase 2 is a build phase, not a rename / refactor. The replaced module (`lib/ranking.ts` Variant A → Variant B) has only one external consumer (`lib/api/profile.ts`) per the codebase grep below — no runtime state migration required. Confirming explicitly per protocol:

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | None — Phase 2 adds new tables (`topic`, possibly `subtopic` per D-02) and one new column (`scholar.role_category`); does not rename any existing key, collection, or ID. Existing `topic_assignment.topic` flat-string column may be deprecated/extended depending on D-02 schema choice — handle via additive migration not rename. | Prisma migration; backfill `scholar.role_category` from ED ETL; backfill `topic` table from ETL extension. No data renaming. |
| Live service config | None — ETL orchestrator (`etl/orchestrate.ts`) is in repo, not in n8n / Datadog / external scheduler in this prototype. | None |
| OS-registered state | None — no Task Scheduler, launchd, or pm2 entries; ETL runs are manual (`npm run etl:*`) in dev. | None |
| Secrets / env vars | None new. Existing `SCHOLARS_DYNAMODB_TABLE`, AWS credentials carry forward. | None |
| Build artifacts | `lib/generated/prisma` is regenerated on `prisma generate`. After schema migration in W2, must run `prisma generate` (already wired to `postinstall` in package.json:6). | Run `npx prisma generate` after migration; verify `lib/generated/prisma` reflects new models. |

**Verification:** `grep -rn "from \"@/lib/ranking\"" app/ lib/ components/ tests/` confirms only `lib/api/profile.ts` and `tests/unit/ranking.test.ts` import the Variant A module; no orphan call sites.

---

## Common Pitfalls

### Pitfall 1: Eligibility carve has no data feed (CRITICAL)
**What goes wrong:** Plan assumes `scholar.role_category` exists; query like `WHERE roleCategory IN (...)` fails because the column doesn't exist. Or worse: developer adds the column but populates everyone with "full_time_faculty" because it ships green and tests pass.
**Why it happens:** `etl/search-index/index.ts:120` hard-codes `personType = "Faculty"` as a placeholder. ED ETL pulls `weillCornellEduPersonTypeCode` and `weillCornellEduFTE` (both already in `ED_FACULTY_ATTRIBUTES`) but does not currently project them. Doctoral students live under `ou=students` (not `ou=people`) per spec line 355 — current ED filter `(weillCornellEduPersonTypeCode=academic)` would not include them at all.
**How to avoid:** W0 must (a) add `scholar.role_category` enum column, (b) extend `etl/ed/index.ts` to compute `role_category` from `weillCornellEduPersonTypeCode` + `weillCornellEduFTE`, (c) add a separate ED query branch for `ou=students` to bring doctoral students into the active scholar set, (d) backfill from existing 8,943 active rows, (e) test that all four eligibility-carve roles appear with non-zero counts before any home-page query is wired.
**Warning signs:** Test data has all "Faculty" role; no Postdoc / Fellow / Doctoral student rows in `scholar` table; the chair appointment title pattern matches the entire population.

### Pitfall 2: Design tokens referenced but not declared (MEDIUM)
**What goes wrong:** UI-SPEC line 41 says "`--space-3` already defined in `default.css`" — true for the sketch theme, but `app/globals.css` does NOT declare `--space-3`, `--text-sm` (=13px), `--text-base` (=15px), `--text-lg` (=18px), `--text-4xl` (=44px), `--weight-semibold` (=600). Components written assuming these tokens exist will silently inherit Tailwind defaults and look subtly wrong (Tailwind 4 `text-sm` = 14px, not 13px; `text-base` = 16px, not 15px).
**Why it happens:** UI-SPEC was authored against the sketch theme; `app/globals.css` was last updated in Milestone 1 with only Radix shadcn color tokens.
**How to avoid:** W0 includes a "port design tokens from `.planning/sketches/themes/default.css` into `app/globals.css`" task. Specifically port the spacing scale, typography scale, weight scale, and the Slate/Cornell-red color tokens. Update Tailwind 4 `@theme` block accordingly.
**Warning signs:** Component visual review shows fonts at 14px instead of 13px; section heading at 16px instead of 18px; carousel peek width wrong.

### Pitfall 3: Variant A → Variant B retrofit on profile pages breaks shipped tests (MEDIUM)
**What goes wrong:** Existing `tests/unit/ranking.test.ts` asserts Variant A scores (e.g., `authorshipPoints({ isFirst: true }) === 5`). D-06 deletes the additive formula. Tests fail; if planner naively adds Variant B alongside, two formulas drift.
**Why it happens:** Variant A was the spec at Milestone 1 ship time; Variant B was decided 2026-04-30 (REQ-publications-ranking row in PROJECT.md).
**How to avoid:** Plan explicitly schedules `tests/unit/ranking.test.ts` rewrite in W1 alongside the formula rewrite. The new test file references the three worked examples in `design-spec-v1.7.1.md:1150-1173` as fixtures. Old test file goes away — do not maintain Variant A.
**Warning signs:** PR has both `authorshipPoints` and `authorshipWeight` exports; CI fails on the old assertion; reviewer asks "which is the source of truth?"

### Pitfall 4: DynamoDB taxonomy structure is unknown (MEDIUM)
**What goes wrong:** Schema migration designed against assumed structure (`top_topics: [{ topic_id, topic, score }]`) doesn't match reality. Migration ships, ETL fails, rollback churn.
**Why it happens:** Current `etl/dynamodb/index.ts` only reads `top_topics` per scholar. The 67-parent / ~2,000-subtopic hierarchy may live in a separate partition (e.g., `TAXONOMY#`, `TOPIC#parent_id`) not yet probed.
**How to avoid:** W0 includes a probe task — extend `etl/dynamodb/index.ts` (or a new `probe.ts`) to enumerate ALL partition prefixes in the `reciterai-chatbot` table, sample 5 records per prefix, and dump their shape to stdout. THEN choose the schema (D-02 candidates a / b / c). Do NOT design schema before probe results are in hand.
**Warning signs:** Phase 2 plan locks in a schema with no probe artifact in the repo; reviewer asks "where did the parent_id come from?"

### Pitfall 5: First-or-senior filter contradiction on Top scholars chip row (LOW)
**What goes wrong:** Spec line 1135 says authorship-position filter applies on Top scholars (first or senior only), but ROADMAP success criterion #4 + UI-SPEC §RANKING-03 + CONTEXT.md describe the row as "publication-centric — no authorship-position filter." The two sources contradict.
**Why it happens:** Spec evolved between v1.6 and v1.7.1; ROADMAP was authored from one version, design spec line 1135 from another.
**How to avoid:** Spec line 1135 is canonical (more recent, more specific). Plan applies first-or-senior filter on Top scholars chip row aggregation. Methodology page should document the rule. Surface the contradiction to the user during planning if any team member challenges it.
**Warning signs:** Reviewer reads UI-SPEC and ROADMAP and asks "doesn't 'publication-centric' mean we don't filter authorship?" — answer: scope filter (eligibility carve) is publication-centric; authorship filter still applies per spec line 1135.

### Pitfall 6: Methodology page link target mismatch (LOW)
**What goes wrong:** Surface components hard-code `/about/methodology#recent-contributions`, but the page is built as `/methodology` or with different anchor IDs.
**Why it happens:** D-04 locks the URL and anchors; easy to drift if components are written before the methodology page lands.
**How to avoid:** Build methodology page first in W3 (or in W1 as a stub page with the four anchor sections); hard-code anchor IDs in a constant `lib/methodology-anchors.ts` consumed by every surface.
**Warning signs:** Page-not-found in Playwright e2e; "How this works" link 404s.

### Pitfall 7: Browse all research areas count mismatch (LOW)
**What goes wrong:** D-03 says "all scholars" not eligibility-carved. If the count query naively joins `topic_assignment` to `scholar` without `WHERE deleted_at IS NULL AND status = 'active'`, soft-deleted scholars inflate counts; if it joins with eligibility-carve filter, counts are smaller than expected.
**Why it happens:** "All scholars" is a relative term — D-03 means "no eligibility-carve filter" but does NOT mean "include soft-deleted."
**How to avoid:** Standard active-scholar predicate (`deletedAt IS NULL AND status = 'active'`) applies to count queries — same as everywhere else. D-03 only suspends the eligibility-carve role filter.
**Warning signs:** Browse grid shows e.g. 12,000 scholars when the active population is ~8,943.

---

## Code Examples

### Example 1: Recency curve as typed step function (W1)

```typescript
// lib/ranking.ts (excerpt)
// Source: design-spec-v1.7.1.md:1107-1123
function recencyWeightSelectedHighlights(ageMonths: number): number {
  if (ageMonths < 6) return 0;
  if (ageMonths < 18) return 0.7;
  if (ageMonths < 120) return 1.0;   // 18mo–10yr peak
  if (ageMonths < 240) return 0.7;   // 10–20yr
  return 0.5;                         // 20+yr
}

function recencyWeightRecentHighlights(ageMonths: number): number {
  if (ageMonths < 3) return 0.4;     // immaturity penalty
  if (ageMonths < 6) return 0.7;
  if (ageMonths < 18) return 1.0;    // peak
  if (ageMonths < 36) return 0.8;    // 18mo–3yr
  return 0.4;                         // 3+yr
}
```

### Example 2: Worked-example unit test (W1)

```typescript
// tests/unit/ranking.test.ts
// Source: design-spec-v1.7.1.md:1150-1173
describe("Variant B worked examples", () => {
  it("Whitcomb 2003 Annals as Selected highlight: 0.46", () => {
    const score = scorePublication(
      {
        reciteraiImpact: 0.92,
        publicationType: "Academic Article",
        authorship: { isFirst: false, isLast: true, isPenultimate: false },
        dateAddedToEntrez: new Date("2003-04-01"),
      },
      "selected_highlights",
      true,
      new Date("2026-04-01"),
    );
    expect(score).toBeCloseTo(0.46, 2);  // 0.92 × 1.0 × 1.0 × 0.5
  });

  it("Same paper as Recent highlight: 0.37", () => {
    const score = scorePublication(/* ... */, "recent_highlights", false, /* ... */);
    expect(score).toBeCloseTo(0.37, 2);  // 0.92 × 1.0 × 1.0 × 0.4
  });

  it("14-mo NEJM postdoc-first as Recent contribution: 0.88", () => {
    const score = scorePublication(/* ... */, "recent_contributions", true, /* ... */);
    expect(score).toBeCloseTo(0.88, 2);  // 0.88 × 1.0 × 1.0 × 1.0
  });
});
```

### Example 3: ED ETL role_category derivation (W0)

```typescript
// etl/ed/index.ts (extension)
// Source: design-spec-v1.7.1.md:352-356, line 61 (compound rule)
type RoleCategory =
  | "full_time_faculty"   // Full-Time WCMC Faculty AND FTE=100
  | "affiliated_faculty"  // any other faculty class, OR Full-Time WCMC Faculty with FTE<100
  | "postdoc"
  | "fellow"
  | "non_faculty_academic"
  | "non_academic"
  | "doctoral_student"    // ou=students with degree code = PHD
  | "instructor"
  | "lecturer"
  | "emeritus";

function deriveRoleCategory(personTypeCode: string, fte: number | null,
                             ou: string, degreeCode: string | null): RoleCategory {
  if (ou === "students" && degreeCode === "PHD") return "doctoral_student";
  if (personTypeCode === "Full-Time WCMC Faculty" && fte === 100) return "full_time_faculty";
  if (personTypeCode === "Postdoc") return "postdoc";
  if (personTypeCode === "Fellow") return "fellow";
  // ... rest of mapping
  return "affiliated_faculty";  // catch-all for faculty classes not meeting full-time
}

// Eligibility-carve roles for scholar-centric algorithmic surfaces:
export const ELIGIBLE_ROLES: ReadonlyArray<RoleCategory> = [
  "full_time_faculty", "postdoc", "fellow", "doctoral_student",
];
```

### Example 4: Top scholars chip row aggregation (W3)

```typescript
// lib/api/topics.ts
// Source: design-spec-v1.7.1.md:1127-1135
export async function getTopScholarsForTopic(topicSlug: string, now = new Date()) {
  // Pull all scored publications attributed to this topic, joined to author rows
  // for first-or-senior WCM authors who are in the eligibility carve.
  const rows = await prisma.publicationAuthor.findMany({
    where: {
      OR: [{ isFirst: true }, { isLast: true }],
      isConfirmed: true,
      scholar: {
        deletedAt: null, status: "active",
        roleCategory: { in: ELIGIBLE_ROLES },
      },
      publication: {
        publicationType: { notIn: ["Letter", "Editorial Article", "Erratum"] },
        publicationScores: { some: {} },
        // Topic membership: requires the new topic taxonomy from D-01
        topicAssignments: { some: { topic: { slug: topicSlug } } },  // shape per chosen schema
      },
    },
    include: { publication: { include: { publicationScores: true } }, scholar: true },
  });

  // Aggregate per scholar
  const byCwid = new Map<string, { scholar: Scholar; total: number }>();
  for (const r of rows) {
    const score = scorePublication(/* ... */, "top_scholars", true, now);
    const e = byCwid.get(r.cwid!) ?? { scholar: r.scholar!, total: 0 };
    e.total += score;
    byCwid.set(r.cwid!, e);
  }

  const sorted = [...byCwid.values()].sort((a, b) => b.total - a.total);
  if (sorted.length < 3) {  // sparse-state floor per D-12
    console.warn(JSON.stringify({ event: "sparse_state_hide",
      surface: "topic_top_scholars", topic: topicSlug, qualifying: sorted.length, floor: 3 }));
    return null;
  }
  return sorted.slice(0, 7);
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Variant A additive ranking (`authorship + type + impact + recency`) | Variant B multiplicative ranking with surface-keyed recency curves | 2026-04-30 (REQ-publications-ranking decision) | All five surfaces (2 profile + 3 new) use Variant B; profile retrofit happens in W1 of Phase 2 |
| Hard-coded `personType = "Faculty"` placeholder in `etl/search-index/index.ts:120` | Real `scholar.role_category` derived in ED ETL from `personTypeCode` + `FTE` + `ou` + `degreeCode` | Phase 2 Wave 0 | Enables eligibility carve queries; also unblocks search-results role chip row |
| `topic_assignment.topic` as flat string | `topic` table with parent/subtopic relation (D-02 schema choice) | Phase 2 Wave 2 | Enables 67-parent grid, parent-dedup on Recent contributions, subtopic-keyed Selected research carousel, /topics/{slug} routing |
| Pages 16: Next.js Pages Router | App Router (already shipped Milestone 1) | Already current | — |
| `next/image` optimization | `<HeadshotAvatar>` already wired with `unoptimized` per Phase 1 | Phase 1 | Phase 2 just composes the existing component |

**Deprecated/outdated:**
- Variant A `authorshipPoints` / `typePoints` / `impactPoints` / `recencyScore` exports in `lib/ranking.ts` — removed in W1 per D-06.
- `tests/unit/ranking.test.ts` Variant A assertions — rewritten in W1 against Variant B worked examples.

---

## Recommended Wave Groupings

> The orchestrator can launch worktree-parallel waves once W0 lands. W0 is sequential and serial; W1–W3 share dependencies but operate on disjoint file trees and can be parallelized.

### Wave 0 — Prerequisites (sequential; the gate everything else depends on)
- `etl/dynamodb/probe.ts` (NEW) — enumerate partitions in reciterai-chatbot table; sample 5 records each; dump shape. Produces a probe artifact in `.planning/phases/02-.../probe-output.json` for the schema decision.
- Decide D-02 schema shape (writeup as ADR addendum or in PLAN.md) based on probe.
- Port design tokens from `.planning/sketches/themes/default.css` into `app/globals.css` (`--space-3`, `--text-sm`/`base`/`lg`/`4xl`, `--weight-semibold`, Slate `#2c4f6e`, Cornell red `#B31B1B`, font stack). Update Tailwind 4 `@theme` block.
- Add `scholar.role_category` column (Prisma migration) + ED ETL extension to derive role from `personTypeCode` + `FTE` + new `ou=students` query branch.
- Run ED ETL; verify counts: ~2,211 full_time_faculty, ~5,000 affiliated_faculty, postdoc/fellow > 0, doctoral_student > 0.
- Install shadcn `scroll-area` + `skeleton`.

### Wave 1 — Variant B core (after W0; parallel with W2)
- Rewrite `lib/ranking.ts` to Variant B (factored `scorePublication` + four recency curves + `aggregateScholarScore`).
- Rewrite `tests/unit/ranking.test.ts` against three worked-example fixtures (`tests/fixtures/ranking-worked-examples.ts`).
- Update `lib/api/profile.ts` call sites (Selected highlights, recent feed) to call new ranking.
- Verify profile page still renders against real data (visual smoke; no behavior regression).

### Wave 2 — Topic taxonomy ETL + schema (after W0; parallel with W1)
- Apply chosen Prisma migration (D-02 candidate winner from probe).
- Extend `etl/dynamodb/index.ts` to land taxonomy.
- Verify `publication_score.score` matches `reciterai_impact` per D-08; if not, extend projection.
- Backfill: run extended ETL; assert 67 parent topics in `topic` table.

### Wave 3 — Pages and components (after W1 + W2)
- Build methodology page (`app/(public)/about/methodology/page.tsx`) with four anchor sections per D-04.
- Build `/about` stub.
- Build `lib/api/home.ts` and `lib/api/topics.ts` data-fetch functions.
- Build component tree under `components/home/` and `components/topic/`.
- Replace `app/page.tsx` with the new home composition.
- Build `app/(public)/topics/[slug]/page.tsx` placeholder per D-10.

### Wave 4 — Integration + verification
- Extend `/api/revalidate` to accept `/` and `/topics/[slug]` paths.
- Wire `etl/orchestrate.ts` to fire revalidate for home + per-topic after DynamoDB ETL completes.
- Add Playwright e2e for home (sections render, sparse-state hides emit logs), topic placeholder, methodology anchors.
- Component-render smoke test: structured log line emitted on each sparse-state hide (D-12).
- Visual verification against sketch 003 Variant D (planner runs `playwright_browser_take_screenshot` for human review).

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node 22+ | Build / dev / Vitest | ✓ | 22.x [VERIFIED: package.json `engines` not set, but project uses Node 22+ idioms; verify via `node --version` at execution] | — |
| MySQL 8 / MariaDB | Runtime + Prisma migrations | ✓ | per `docker-compose.yml` (verify image tag) | — |
| OpenSearch 2.x | Search index (already shipped) | ✓ | per `docker-compose.yml` | — |
| AWS credentials for DynamoDB scan | DynamoDB ETL extension (W2) | ✓ if `~/.zshenv` has SCHOLARS_AWS_* (project namespace) | — | Probe script can run against a JSON fixture if AWS creds unavailable; planner should not gate Wave 0 on AWS access |
| `directory.weill.cornell.edu` | Headshot rendering (already wired Phase 1) | ✓ | — | — |
| `reciterai-chatbot` DynamoDB table | Topic taxonomy probe (W0) + ETL extension (W2) | ✓ assumed; was used Milestone 1 Phase 4 | — | If unreachable, plan stalls — flag immediately |
| `npx shadcn` | W0 component installs | ✓ | — | — |

**Missing dependencies with no fallback:** None identified for code/config; AWS creds for DynamoDB are the only hard external dependency, and they're already a Milestone 1 prerequisite.

**Missing dependencies with fallback:** AWS creds for the W0 probe — if dev machine lacks creds momentarily, run probe in an environment that has them (or mock with a JSON fixture for the schema decision).

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 3.0.2 + @testing-library/react 16.1.0 + Playwright 1.49.1 |
| Config files | `vitest.config.ts`, `playwright.config.ts` |
| Quick run command | `npm test` (Vitest unit suite) |
| Full suite command | `npm test && npm run test:e2e` |
| Type check | `npm run typecheck` |
| Lint | `npm run lint` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| RANKING-01 | Home Recent contributions selects 6 cards, first-or-senior, eligibility-carved, no citations, methodology link | unit + e2e | `vitest run tests/unit/home-api.test.ts` + `playwright test tests/e2e/home.spec.ts` | ❌ Wave 0 (creates fixtures) |
| RANKING-01 (math) | `scorePublication` for `recent_contributions` curve matches worked example 3 | unit | `vitest run tests/unit/ranking.test.ts` | ✅ exists; rewrite in W1 |
| RANKING-02 | Topic Recent highlights selects 3 cards, publication-centric, no citations | unit + e2e | `vitest run tests/unit/topic-api.test.ts` + `playwright test tests/e2e/topic-placeholder.spec.ts` | ❌ Wave 0 |
| RANKING-03 | Topic Top scholars chip row aggregates per-scholar with first-or-senior filter | unit | `vitest run tests/unit/topic-api.test.ts` (assertion: aggregateScholarScore matches fixture sum) | ❌ Wave 0 |
| HOME-02 | Selected research carousel shows 8 subtopic cards, one per parent area | unit + e2e | `vitest run tests/unit/home-api.test.ts` (parent-dedup assertion) + `playwright test tests/e2e/home.spec.ts` (8 cards visible, scroll-snap) | ❌ Wave 0 |
| HOME-03 | Browse all research areas shows 67 parent topics with counts | unit + e2e | `vitest run tests/unit/home-api.test.ts` (count == 67) + `playwright test tests/e2e/home.spec.ts` | ❌ Wave 0 |
| Eligibility carve | `scholar.role_category` correctly populated for all 8,943+ active scholars | unit (against ETL output) | `vitest run tests/unit/eligibility.test.ts` + manual SQL counts after ED ETL run | ❌ Wave 0 |
| Sparse-state hide | `getRecentContributions` returns null when <3 qualify; structured log emitted | unit | `vitest run tests/unit/home-api.test.ts` | ❌ Wave 0 |
| Methodology anchors | All four "How this works" links resolve to `/about/methodology#<id>` and the anchor exists in DOM | e2e | `playwright test tests/e2e/methodology.spec.ts` | ❌ Wave 0 |
| Variant B worked example 1 | Whitcomb Annals 2003 Selected highlights score 0.46 | unit | `vitest run tests/unit/ranking.test.ts` | ❌ Wave 0 (rewrite) |
| Variant B worked example 2 | Same paper Recent highlights score 0.37 | unit | `vitest run tests/unit/ranking.test.ts` | ❌ Wave 0 (rewrite) |
| Variant B worked example 3 | NEJM 14mo postdoc Recent contributions score 0.88 | unit | `vitest run tests/unit/ranking.test.ts` | ❌ Wave 0 (rewrite) |

### Sampling Rate

- **Per task commit:** `npm run typecheck && npm test -- <changed-test-file>` (< 30 seconds)
- **Per wave merge:** `npm test && npm run lint && npm run typecheck` (full unit + lint + typecheck)
- **Phase gate (`/gsd-verify-work`):** `npm test && npm run test:e2e && npm run lint && npm run typecheck` (all greens; visual review of home + topic against sketch 003 Variant D + sketch 004)

### Wave 0 Gaps

- [ ] `tests/unit/eligibility.test.ts` (NEW) — covers role_category derivation rule
- [ ] `tests/unit/home-api.test.ts` (NEW) — covers Recent contributions, Selected research, Browse grid query shape + sparse-state behavior
- [ ] `tests/unit/topic-api.test.ts` (NEW) — covers Top scholars aggregation + Recent highlights
- [ ] `tests/fixtures/ranking-worked-examples.ts` (NEW) — three fixtures from spec 1150-1173
- [ ] `tests/fixtures/topic-fixture.ts` (NEW) — synthetic topic + scholars + publications for surface tests
- [ ] `tests/e2e/topic-placeholder.spec.ts` (NEW) — placeholder route renders both surfaces
- [ ] `tests/e2e/methodology.spec.ts` (NEW) — anchors resolve from all four surfaces
- [ ] `tests/e2e/home.spec.ts` (MODIFY) — assertions for new sections (currently a stub from Milestone 1)
- [ ] `tests/unit/ranking.test.ts` (REWRITE) — Variant B worked examples replace Variant A unit tests

*(Framework already installed; no install step needed.)*

---

## Security Domain

> Phase 2 surfaces are read-only against MySQL and DynamoDB. No new authentication, no new authorization paths, no user input vectors. Self-edit + SAML are Phase 7. Most ASVS categories are not applicable.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | Phase 7 (AUTH-01 through AUTH-04) |
| V3 Session Management | no | Phase 7 |
| V4 Access Control | no | Phase 2 surfaces are public |
| V5 Input Validation | yes (limited) | `topicSlug` parameter on `/topics/[slug]` route — validate against known slugs from MySQL or 404. No raw user input flows into SQL/DynamoDB. |
| V6 Cryptography | no | No new crypto in Phase 2 |
| V7 Error Handling and Logging | yes | Sparse-state hides emit structured logs (D-12) — must NOT contain PII (no scholar names, only counts and surface names). Error handling: surface failures hide section; never 5xx the page. |
| V8 Data Protection | yes | DynamoDB ETL must use IAM role / env-var creds (existing pattern); no creds in source. |
| V14 Configuration | yes | No new config — extends existing `SCHOLARS_DYNAMODB_TABLE`, AWS creds. CLAUDE.md: never display credentials. |

### Known Threat Patterns for {Next.js + Prisma + MySQL + DynamoDB stack}

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| SQL injection via topicSlug | Tampering | Prisma parameterized queries (already idiomatic); never string-interpolate user input into SQL |
| DynamoDB scan with user-controlled filter | Information disclosure | ETL is server-only and not exposed to the browser; user input never reaches DDB query |
| Open redirect on `/about` stub | Tampering / Phishing | If `/about` is built as a redirect to `/about/methodology`, hard-code the target — no user-controlled redirect target |
| Log injection via slug or scholar name in sparse-state log | Tampering of logs | Sparse-state log emits ONLY surface name + counts (`{"event":"sparse_state_hide","surface":"home_recent_contributions","qualifying":2}`) — no slug, no scholar name. Limits log injection vector to topic slug at most; sanitize before logging. |
| ISR cache poisoning via path injection | Tampering | `/api/revalidate` (existing) must validate the `path` parameter against a whitelist of `/`, `/scholars/[slug]`, `/topics/[slug]` patterns — already a Milestone 1 concern; verify in W4 |

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | DynamoDB taxonomy structure has parent/subtopic relations recoverable via partition prefix scan | §Pitfall 4 | Schema choice (D-02) is wrong; W2 ETL needs rewrite. Mitigated by W0 probe task. |
| A2 | `weillCornellEduFTE` field is reliably populated for Full-Time WCMC Faculty rows | §Pattern 3, Pitfall 1 | Eligibility carve undercount/overcount; spec line 207 says it's reliable but not measured against live data. ED probe in W0 should sample. |
| A3 | Doctoral students have `weillCornellEduDegreeCode = PHD` (per spec line 355: "or similar") | §Pitfall 1 | Spec itself says "working assumption pending registrar confirmation" — this is a CARRIED-FORWARD assumption from Milestone 1 calibration items in STATE.md. Phase 2 inherits the risk. |
| A4 | `publication_score.score` is the authoritative `reciterai_impact` (D-08) | §Don't Hand-Roll | If misnamed or differently-scaled, all four surfaces score wrongly. Verified by reading `etl/dynamodb/index.ts` schema — score is a 0–1 float. Re-confirm against live DDB record in W2. |
| A5 | Native CSS `scroll-snap-type: x mandatory` works in all target browsers | §Anti-Patterns | Edge case for older Safari; supported widely since 2020. Risk: low. |
| A6 | ETL run takes <5 minutes after extension; on-demand revalidation is timely | §Pattern 3 | If ETL slows, ISR fallback TTL (6h) protects against stale data; no UX impact unless dev cycle is impatient. |
| A7 | UI-SPEC's per-surface floor defaults (3/6, 3/7, 4/8) are appropriate | §D-12 | If too aggressive, real data hides sections; if too lax, sparse sections look broken. Mitigated by structured log; planner can adjust at first sight. |

---

## Open Questions

1. **Doctoral-student data feed (carried from Milestone 1)**
   - What we know: Spec says `ou=students` + `degreeCode = PHD` "or similar"; STATE.md flags as "working assumption pending registrar confirmation."
   - What's unclear: Whether ED actually exposes doctoral students to the bind DN; what the exact filter is.
   - Recommendation: W0 includes an ED probe — run a one-off LDAP query against `ou=students,dc=weill,dc=cornell,dc=edu` with the existing bind DN and inspect attributes. If doctoral students don't surface, escalate to user before W2 (the eligibility-carve population would be ~40% smaller than spec assumes).

2. **Co-corresponding author handling (D-09)**
   - What we know: Spec says weight 1.0; schema has no `is_corresponding` flag.
   - What's unclear: Whether ReCiter's source data contains corresponding-author info recoverable via projection.
   - Recommendation: Default to D-09 option (a) — leave first/last only at 1.0, document the gap on the methodology page. Revisit if user pushes back.

3. **Apparent contradiction in Top scholars chip row spec**
   - What we know: Spec line 1135 says first-or-senior filter applies on Top scholars row aggregation. ROADMAP success criterion #4 + UI-SPEC + CONTEXT.md describe the row as "publication-centric — no authorship-position filter."
   - What's unclear: Whether the contradiction is intentional (publication-centric scope = no scholar-eligibility filter on the publication pool, but per-scholar aggregation still uses first-or-senior) or a spec drift.
   - Recommendation: Treat spec line 1135 as canonical (most specific, multi-paragraph derivation). The pool of publications considered is publication-centric (all scored, all author positions); the per-scholar aggregation that determines who appears as a CHIP applies first-or-senior. Surface to user if a planner challenges.

4. **`/about` stub vs. redirect (D-05 Claude's discretion)**
   - What we know: Either is acceptable; cheaper choice that doesn't constrain Phase 4.
   - Recommendation: Stub page (3-line placeholder per UI-SPEC §`/about (stub)`). A redirect would require Phase 4 to undo the redirect when expanding `/about`; a stub is one-line content swap.

5. **Eligibility-carve scope on the BROWSE grid count vs. RANKING-01 dedup**
   - What we know: D-03 says count is "all scholars" (no eligibility carve) for Browse grid. RANKING-01 dedup is "one per parent research area" — meaning a parent area must HAVE a qualifying scholar for the dedup to land.
   - What's unclear: If a parent area exists in the taxonomy but has zero eligibility-carved scholars, can the home Recent contributions surface still pull a card from that area? Spec is silent.
   - Recommendation: One-per-parent dedup applies to PRESENT scholars only; areas with no eligibility-carved scholars are skipped naturally. A planner should not over-engineer this — top-N over the ranked list with a `seenAreas` set handles it.

---

## Sources

### Primary (HIGH confidence)
- `lib/ranking.ts` — current Variant A implementation (to be replaced) [VERIFIED: read in research]
- `lib/api/profile.ts` — current ranking call sites for retrofit [VERIFIED: read in research]
- `prisma/schema.prisma` — current data model [VERIFIED: read in research]
- `etl/dynamodb/index.ts` — current minimal-projection ETL pattern [VERIFIED: read in research]
- `etl/ed/index.ts` + `lib/sources/ldap.ts` — ED ETL pattern; confirms attribute set already pulls `personTypeCode` and `weillCornellEduDepartment` (FTE field needs explicit add) [VERIFIED: read in research]
- `etl/search-index/index.ts` — confirms `personType = "Faculty"` placeholder at line 120 [VERIFIED: read in research]
- `app/(public)/scholars/[slug]/page.tsx` — ISR pattern for new pages [VERIFIED: read in research]
- `components/scholar/headshot-avatar.tsx` — Phase 1 component reused in Phase 2 [VERIFIED: read in research]
- `app/globals.css` — confirms design tokens are NOT declared [VERIFIED: read in research]
- `.planning/sketches/themes/default.css` — sketch token declarations to port [VERIFIED: read in research]
- `.planning/source-docs/design-spec-v1.7.1.md:1062-1180` — Variant B formula + recency curves + worked examples [CITED: design spec, locked]
- `.planning/source-docs/design-spec-v1.7.1.md:342-388` — scholar role model + eligibility carve [CITED: design spec, locked]
- `.planning/source-docs/design-spec-v1.7.1.md:423-437` — algorithmic surface guidelines [CITED: design spec, locked]
- `.planning/phases/02-.../02-CONTEXT.md` — D-01 through D-12 locked decisions [CITED]
- `.planning/phases/02-.../02-UI-SPEC.md` — visual contract for each surface [CITED]

### Secondary (MEDIUM confidence)
- `.planning/phases/01-headshot-integration/01-RESEARCH.md` + `01-PATTERNS.md` — Phase 1 carry-forward patterns [CITED]
- `.planning/sketches/003-home-landing/index.html` — winner Variant D layout reference [CITED, not directly read in this session]
- Tailwind 4 `@theme` block syntax — verified by reading `app/globals.css` (uses Tailwind 4 idiom) [VERIFIED]
- Prisma 7 `findMany` with nested `include` for join shape — established Milestone 1 idiom [VERIFIED via `lib/api/profile.ts`]

### Tertiary (LOW confidence)
- DynamoDB taxonomy structure beyond `top_topics` — ASSUMED based on spec (67 parents, ~2k subtopics) but not verified against live data. **Mitigation:** W0 probe task. [ASSUMED]
- Doctoral student LDAP filter — spec says "or similar." [ASSUMED]
- ED `weillCornellEduFTE` reliability — spec says reliable, no live measurement in this session. [ASSUMED]

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries verified in `package.json`; idioms verified in shipped Milestone 1 code.
- Architecture: HIGH — ISR + on-demand revalidation pattern proven in profile pages; Server Component + Prisma direct read pattern established.
- Pitfalls: HIGH for Pitfalls 1, 2, 3 (verified by reading actual code); MEDIUM for 4 (probe pending); LOW for 5, 6, 7 (low impact / cheap to detect).
- Variant B math: HIGH — transcribed verbatim from spec; worked examples are deterministic.
- Eligibility carve data feed: MEDIUM — derivation rule is clear, but the doctoral-student LDAP path and FTE reliability carry forward Milestone 1 calibration risks.
- Topic taxonomy schema choice: MEDIUM — depends on W0 probe.

**Research date:** 2026-04-30
**Valid until:** 2026-05-30 (30 days; stable codebase, locked spec). If Phase 2 execution starts after this date, re-verify package versions and re-read STATE.md for any updates.

## RESEARCH COMPLETE

**Phase:** 2 — Algorithmic surfaces and home composition
**Confidence:** HIGH (codebase + ranking math + ISR pattern); MEDIUM (eligibility-carve data path, DynamoDB taxonomy structure)

### Key Findings
- **Variant B math is fully specified** in `design-spec-v1.7.1.md:1062-1180` with three worked examples that translate directly to unit-test fixtures. The formula is a single multiplicative product `reciterai_impact × authorship_weight × pub_type_weight × recency_weight`, parameterized by four typed step-function recency curves.
- **Phase 2 is overwhelmingly composition + retrofit, not new primitives.** The only net-new shadcn components are `scroll-area` and `skeleton`. Almost all data plumbing (Prisma, ISR + revalidate, ETL orchestrator, `<HeadshotAvatar>`) is already in place from Milestone 1.
- **Two non-obvious Wave 0 prerequisites must be in the plan or the build will silently regress:** (1) the eligibility-carve data feed does not exist (`scholar.role_category` is missing; `etl/search-index/index.ts:120` hard-codes `personType = "Faculty"`); (2) the design tokens referenced by UI-SPEC (`--space-3`, `--text-sm` = 13px, `--text-base` = 15px, `--text-lg` = 18px, `--text-4xl` = 44px, `--weight-semibold`) are declared in the sketch theme but **NOT** in `app/globals.css` — components written assuming they exist will silently inherit Tailwind 4 defaults.
- **DynamoDB taxonomy probe is a hard prerequisite** — schema choice (D-02 candidates a/b/c) cannot be made before probing the real DDB structure. W0 includes a probe task.
- **One spec contradiction must be resolved during planning:** ROADMAP / UI-SPEC say Top scholars chip row is "publication-centric, no authorship-position filter," but spec line 1135 says first-or-senior applies. Spec line 1135 is canonical (most specific).

### File Created
`.planning/phases/02-algorithmic-surfaces-and-home-composition/02-RESEARCH.md`

### Confidence Assessment
| Area | Level | Reason |
|------|-------|--------|
| Standard Stack | HIGH | All packages verified in package.json; shipped patterns observed |
| Architecture | HIGH | ISR + revalidate proven in profile pages; ETL pattern established |
| Variant B math | HIGH | Transcribed verbatim from spec; deterministic worked examples |
| Eligibility carve | MEDIUM | Derivation rule clear; doctoral-student feed and FTE reliability carry MD1 risks |
| DynamoDB taxonomy | MEDIUM | Probe required before W2 schema lock-in |
| Common pitfalls | HIGH (1-3, verified in code) / MEDIUM (4, probe-gated) |

### Open Questions
1. Doctoral-student LDAP filter (carried from Milestone 1)
2. Co-corresponding author handling (D-09 — recommend option (a))
3. Apparent contradiction on Top scholars chip row authorship filter (recommend spec line 1135 as canonical)
4. `/about` stub vs. redirect (recommend stub)
5. Eligibility-carve scope on Browse grid count (recommend D-03 verbatim — no carve, but active-only)

### Ready for Planning
Research complete. Planner should structure plans into ~5 waves (W0 prerequisites; W1 ranking core + W2 taxonomy ETL parallelizable; W3 pages/components; W4 integration + verification). Wave 0 must include: ED ETL extension for `role_category`, design-token port, DynamoDB probe, Prisma migration scaffold, and shadcn component installs. Three landmines (§Pitfalls 1, 2, 4) are visible from research and MUST surface as explicit Wave 0 tasks rather than assumed-discovered-during-execution.
