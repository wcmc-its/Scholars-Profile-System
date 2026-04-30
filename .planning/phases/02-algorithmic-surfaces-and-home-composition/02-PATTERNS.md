# Phase 2: Algorithmic surfaces and home composition - Pattern Map

**Mapped:** 2026-04-30
**Files analyzed:** 26 new/modified files
**Analogs found:** 24 / 26

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `lib/ranking.ts` (REWRITE Variant B) | utility | transform (pub → score) | itself (Variant A — replace in place) | exact (same file, same export contract) |
| `lib/api/profile.ts` (retrofit ranking call sites) | service | CRUD (DB → payload) | itself (lines 200-202) | exact (in-place edit) |
| `lib/api/home.ts` (NEW) | service | CRUD (DB → payload) | `lib/api/profile.ts` | exact (same Prisma + serializer + ranking pattern) |
| `lib/api/topics.ts` (NEW) | service | CRUD (DB → payload, per-scholar aggregation) | `lib/api/profile.ts` | exact (same Prisma + serializer pattern) |
| `lib/eligibility.ts` (NEW) | utility | transform (constants + helper) | `lib/utils.ts` | role-match (named-export utility, no I/O) |
| `lib/methodology-anchors.ts` (NEW) | utility | constant export | `lib/utils.ts` | role-match (constants module) |
| `prisma/schema.prisma` (add `Topic`, `scholar.role_category`, extend `topic_assignment`) | model | schema | `prisma/schema.prisma:160-191` (`TopicAssignment`, `PublicationScore`) | exact (mirror existing minimal-projection table shape) |
| `prisma/migrations/2026XXXX_phase2_topics_and_role/migration.sql` (NEW) | migration | DDL | `prisma/migrations/20260430115133_add_coi_activity/migration.sql` | exact (additive migration with FK) |
| `etl/dynamodb/index.ts` (extend with taxonomy projection) | utility (ETL script) | batch (DDB → MySQL) | itself (lines 28-127 main loop) | exact (extend in place) |
| `etl/dynamodb/probe.ts` (NEW Wave 0) | utility (one-shot CLI) | batch (DDB scan → stdout) | `etl/dynamodb/index.ts` lines 42-64 | exact (same scan pattern, no DB write) |
| `etl/ed/index.ts` (add `role_category` derivation + `ou=students` branch) | utility (ETL script) | batch (LDAP → MySQL) | itself (lines 27-153) | exact (extend in place) |
| `lib/sources/ldap.ts` (extend `ED_FACULTY_ATTRIBUTES` with FTE + degreeCode) | utility | external-source adapter | itself (lines 22-35) | exact (additive to existing list) |
| `etl/search-index/index.ts` (replace `personType = "Faculty"` placeholder at line 120) | utility (ETL script) | batch (MySQL → OpenSearch) | itself (line 120) | exact (in-place fix) |
| `app/page.tsx` (REPLACE with composed home) | component | request-response (Server Component) | `app/(public)/scholars/[slug]/page.tsx` | exact (same Server Component + ISR + section composition) |
| `app/(public)/topics/[slug]/page.tsx` (NEW placeholder) | component | request-response (Server Component) | `app/(public)/scholars/[slug]/page.tsx` | exact (same `params: Promise<{slug}>` + ISR pattern) |
| `app/(public)/about/methodology/page.tsx` (NEW) | component | static prose | `app/(public)/scholars/[slug]/page.tsx` (Section helper) | role-match (Server Component, force-static, no data) |
| `app/(public)/about/page.tsx` (NEW stub) | component | static | `app/(public)/scholars/[slug]/page.tsx` (Section helper) | role-match (minimal Server Component) |
| `app/api/revalidate/route.ts` (NEW) | route | request-response (POST → revalidatePath) | `app/api/scholars/[cwid]/route.ts` | role-match (thin Next.js route handler delegating to lib) |
| `app/globals.css` (port design tokens) | config | — | `.planning/sketches/themes/default.css` lines 4-80 | exact (token block to copy verbatim) |
| `components/home/recent-contributions-grid.tsx` (NEW) | component | request-response (server) | `app/(public)/scholars/[slug]/page.tsx` Section helper + `ShowMoreList` | role-match (Server Component grid) |
| `components/home/recent-contribution-card.tsx` (NEW) | component | render | `app/(public)/scholars/[slug]/page.tsx` `PublicationRow` (lines 305-347) | role-match (single-pub render with HeadshotAvatar) |
| `components/home/selected-research-carousel.tsx` (NEW) | component | render (CSS scroll-snap) | NONE — first carousel | no-analog (use sketch 003 Variant D + native scroll-snap) |
| `components/home/subtopic-card.tsx` (NEW) | component | render | `components/ui/card.tsx` | role-match (Card wrapper composition) |
| `components/home/browse-all-research-areas-grid.tsx` (NEW) | component | render | `app/(public)/scholars/[slug]/page.tsx` Areas-of-interest block (lines 167-179) | role-match (badge/chip grid) |
| `components/topic/top-scholars-chip-row.tsx` (NEW) | component | render | `app/(public)/scholars/[slug]/page.tsx` PublicationRow co-author chips (lines 327-339) | role-match (chip-row pattern with HeadshotAvatar) |
| `components/topic/top-scholar-chip.tsx` (NEW) | component | render | `components/scholar/headshot-avatar.tsx` callsite + chip styling (`scholars/[slug]/page.tsx` lines 330-336) | role-match (small chip with avatar + name) |
| `components/topic/recent-highlights.tsx` (NEW) | component | render | `app/(public)/scholars/[slug]/page.tsx` Section helper + Recent publications block (lines 198-215) | role-match (titled list of paper rows) |
| `components/topic/recent-highlight-card.tsx` (NEW) | component | render | `app/(public)/scholars/[slug]/page.tsx` PublicationRow (lines 305-347) | role-match (paper row, no citation count) |
| `components/ui/scroll-area.tsx` (shadcn add) | component | — | shadcn registry | exact (run `npx shadcn add scroll-area`) |
| `components/ui/skeleton.tsx` (shadcn add) | component | — | shadcn registry | exact (run `npx shadcn add skeleton`) |
| `tests/unit/ranking.test.ts` (REWRITE for Variant B) | test | — | itself (current Variant A version, lines 1-213) | exact (replace fixtures, keep `describe`/`it` + `makePub` helper shape) |
| `tests/unit/eligibility.test.ts` (NEW) | test | — | `tests/unit/slug.test.ts` | exact (vitest unit test, pure utility) |
| `tests/unit/home-api.test.ts` (NEW) | test | — | `tests/unit/profile-api.test.ts` | exact (vitest with `vi.mock("@/lib/db")`) |
| `tests/unit/topic-api.test.ts` (NEW) | test | — | `tests/unit/profile-api.test.ts` | exact (vitest with `vi.mock("@/lib/db")`) |
| `tests/fixtures/ranking-worked-examples.ts` (NEW) | fixture | — | `tests/fixtures/scholar.ts` | role-match (constants-only fixture file) |
| `tests/e2e/home.spec.ts` (REWRITE) | test | — | itself (current 8-line file) | exact (Playwright `expect(page.getByRole(...))` pattern) |
| `tests/e2e/topic-placeholder.spec.ts` (NEW) | test | — | `tests/e2e/home.spec.ts` | exact (Playwright `page.goto` + `getByRole`) |
| `tests/e2e/methodology.spec.ts` (NEW) | test | — | `tests/e2e/home.spec.ts` | exact (anchor-link verification) |

Two files have no direct analog: the carousel component (no horizontal scroll-snap pattern in repo) and shadcn primitives (registry installs, not codebase analogs). Both are documented in "No Analog Found" below.

---

## Pattern Assignments

### `lib/ranking.ts` (REWRITE — utility, transform, Variant A → Variant B)

**Analog:** itself — `lib/ranking.ts` lines 1-149.

**Module-level constant tables pattern** (`lib/ranking.ts` lines 26-39):
```typescript
const TYPE_POINTS: Record<string, number> = {
  "Academic Article": 4,
  Review: 2,
  // ...
};

const IMPACT_CAP = 6;
const RECENCY_CAP = 8;
const RECENCY_DECAY_YEARS = 5;
const MS_PER_YEAR = 1000 * 60 * 60 * 24 * 365.25;
```
Copy this "module constants at top, named exports below" structure. For Variant B, replace with `PUB_TYPE_WEIGHTS`, four `RECENCY_CURVES` step-function tables (transcribed verbatim from `design-spec-v1.7.1.md:1103-1145`), and a `TopScholarsCompressedCurve` table for D-14's compressed Option A buckets.

**Named-export pure-function pattern** (`lib/ranking.ts` lines 47-69):
```typescript
export function authorshipPoints(pos: AuthorshipPosition): number {
  if (pos.isFirst || pos.isLast) return 5;
  if (pos.isPenultimate) return 2;
  return 0;
}

export function typePoints(publicationType: string | null | undefined): number {
  if (!publicationType) return 0;
  return TYPE_POINTS[publicationType] ?? 0;
}
```
Copy the `export function`-with-narrow-types-and-explicit-defaults pattern. For Variant B:
```typescript
export function authorshipWeight(pos: AuthorshipPosition, scholarCentric: boolean): number {
  if (!scholarCentric) return 1.0;        // publication-centric: no filter
  if (pos.isFirst || pos.isLast) return 1.0;
  return 0;                                // filtered out on scholar-centric surfaces
}

export function pubTypeWeight(publicationType: string | null | undefined): number {
  if (!publicationType) return 0;
  return PUB_TYPE_WEIGHTS[publicationType] ?? 0;  // returns 0 for hard-excluded types
}

export function recencyWeight(ageMonths: number, curve: RecencyCurve): number {
  return RECENCY_CURVES[curve](ageMonths);
}
```

**Ranking facade pattern** (`lib/ranking.ts` lines 89-103, 111-124):
```typescript
function score<T extends RankablePublication>(p: T, now: Date): ScoredPublication<T> {
  const ap = authorshipPoints(p.authorship);
  const tp = typePoints(p.publicationType);
  const ip = impactPoints(p.citationCount);
  const rs = recencyScore(p.dateAddedToEntrez, now);
  return {
    ...p,
    authorshipPoints: ap, typePoints: tp, impactPoints: ip,
    highlightScore: ap + tp + ip,
    recencyScore: rs,
    recentScore: rs + ap + tp + ip,
  };
}

export function rankForHighlights<T extends RankablePublication>(
  pubs: readonly T[],
  now: Date = new Date(),
): ScoredPublication<T>[] {
  return pubs
    .filter((p) => p.isConfirmed && p.publicationType !== "Erratum")
    .map((p) => score(p, now))
    .sort(/* ... */);
}
```
Variant B keeps the same shape: a private `scorePublication()` core fn, then named-export wrappers per surface. The Variant B contract:
```typescript
export type RecencyCurve =
  | "selected_highlights"
  | "recent_highlights"
  | "recent_contributions"
  | "top_scholars";        // compressed curve per D-14

export function scorePublication(
  p: RankablePublication,
  curve: RecencyCurve,
  scholarCentric: boolean,
  now: Date = new Date(),
): number;

// Per-scholar aggregation for Top scholars chip row (D-13/D-14)
export function aggregateScholarScore(
  pubs: readonly RankablePublication[],
  curve: RecencyCurve = "top_scholars",
  now?: Date,
): number;

// Surface-specific wrappers (consumed by lib/api/{profile,home,topics}.ts)
export function rankForSelectedHighlights<T>(pubs: readonly T[], now?: Date): T[];
export function rankForRecentFeed<T>(pubs: readonly T[], now?: Date): T[];
export function rankForRecentContributions<T>(pubs: readonly T[], now?: Date): T[];
export function rankForRecentHighlights<T>(pubs: readonly T[], now?: Date): T[];
```

**JSDoc header pattern** (`lib/ranking.ts` lines 1-24): The current file opens with a multi-line `/** ... */` describing the formula and citing spec line numbers. Variant B keeps this convention — open with a JSDoc that cites `design-spec-v1.7.1.md:1062-1180` and lists the four curves + worked-example references.

**Divergence the planner must call out:**
- The old `RankablePublication` type lacks `reciteraiImpact` (currently keyed off `citationCount`). Variant B's input type adds `reciteraiImpact: number` (sourced from `publication_score.score` per D-08). `RankablePublication` becomes:
  ```typescript
  export type RankablePublication = {
    pmid: string;
    publicationType: string | null;
    reciteraiImpact: number;           // NEW: from publication_score.score
    dateAddedToEntrez: Date | null;
    authorship: AuthorshipPosition;
    isConfirmed: boolean;
  };
  ```
  `citationCount` is no longer used in scoring (D-11: trust `reciterai_impact` to encode venue quality + cite count). Display can still surface `citationCount` on profile-page rows; ranking does not consume it.
- Old `ScoredPublication` shape had four parallel score fields (`authorshipPoints`, `typePoints`, `impactPoints`, `highlightScore`, `recencyScore`, `recentScore`). Variant B only needs one `score: number` per surface invocation. Decision in PLAN.md: keep the rich shape for profile retrofit (callers expect those field names), or expose only `score: number` and update `lib/api/profile.ts` accordingly. Recommendation: thin shape.
- Old `rankForHighlights` filtered `publicationType !== "Erratum"` only; Variant B's `pubTypeWeight` returns 0 for `Letter`, `Editorial Article`, `Erratum` so the multiplicative formula naturally excludes all three. Don't apply the explicit type-name filter on top — let weight=0 do the work.

---

### `lib/api/profile.ts` (MODIFIED — service, CRUD, retrofit ranking call sites)

**Analog:** itself.

**Existing call sites to update** (`lib/api/profile.ts` lines 11-15, 201-202):
```typescript
import {
  rankForHighlights,
  rankForRecent,
  type ScoredPublication,
} from "@/lib/ranking";
// ...
const highlights = rankForHighlights(rankablePubs, now).slice(0, 3);
const recent = rankForRecent(rankablePubs, now);
```

**Replacement:**
```typescript
import {
  rankForSelectedHighlights,
  rankForRecentFeed,
  type ScoredPublication,
} from "@/lib/ranking";
// ...
const highlights = rankForSelectedHighlights(rankablePubs, now).slice(0, 3);
// D-16 dedup: filter highlights' pmids out of recent-feed
const highlightPmids = new Set(highlights.map((h) => h.pmid));
const recent = rankForRecentFeed(rankablePubs, now)
  .filter((p) => !highlightPmids.has(p.pmid));
```

**Input shape adjustment** (`lib/api/profile.ts` lines 168-199): the `rankablePubs` build needs `reciteraiImpact` populated. Add `publicationScores: { where: { cwid: scholar.cwid } }` to the `publicationAuthor.findMany` include block at lines 144-166, then map:
```typescript
const rankablePubs = authorships.map((a) => ({
  pmid: a.publication.pmid,
  // ... existing fields
  reciteraiImpact: a.publication.publicationScores[0]?.score ?? 0,  // NEW
  // ...
}));
```

**Type change:** `ProfilePublication` (`lib/api/profile.ts` lines 23-44) currently extends `ScoredPublication` which carried `authorshipPoints`, `typePoints`, `impactPoints`, `highlightScore`, `recencyScore`, `recentScore`. With Variant B's thin shape, only `score: number` is added. Update `ProfilePublication` type accordingly. The profile page (`app/(public)/scholars/[slug]/page.tsx` `PublicationRow`) reads `pub.citationCount`, not `pub.impactPoints`, so display is unaffected.

---

### `lib/api/home.ts` (NEW — service, CRUD, three home surfaces)

**Analog:** `lib/api/profile.ts`

**Module header pattern** (`lib/api/profile.ts` lines 1-9):
```typescript
/**
 * Profile-page data assembly. Reads scholar + relations + publications and
 * computes the ranking formulas from `lib/ranking.ts`.
 *
 * Pure-function handler (production-extractable per Q1' refinement). The
 * profile page server component imports this directly for ISR; the equivalent
 * external API endpoint would call the same function.
 */
import { prisma } from "@/lib/db";
import { identityImageEndpoint } from "@/lib/headshot";
```
Copy this "purpose + extractability + imports" header. For `lib/api/home.ts`:
```typescript
/**
 * Home-page data assembly. Reads scholars, publications, topic taxonomy and
 * computes Variant B rankings from `lib/ranking.ts`.
 *
 * Three surfaces, three exported functions:
 *   - getRecentContributions(): RecentContribution[] | null  (RANKING-01)
 *   - getSelectedResearch():    SubtopicCard[]      | null   (HOME-02)
 *   - getBrowseAllResearchAreas(): ParentTopic[]             (HOME-03)
 *
 * Each function returns null when its sparse-state floor (D-12) isn't met,
 * after emitting a structured log line (consumed by Phase 6 logging surface).
 */
import { prisma } from "@/lib/db";
import { identityImageEndpoint } from "@/lib/headshot";
import { rankForRecentContributions } from "@/lib/ranking";
import { ELIGIBLE_ROLES } from "@/lib/eligibility";
```

**Payload type pattern** (`lib/api/profile.ts` lines 46-90 `ProfilePayload`):
```typescript
export type ProfilePayload = {
  cwid: string;
  slug: string;
  preferredName: string;
  fullName: string;
  // ...
  identityImageEndpoint: string;
  // ...
  appointments: Array<{ /* ... */ }>;
  highlights: ProfilePublication[];
  recent: ProfilePublication[];
};
```
For `home.ts`, mirror the named-array-of-typed-records pattern:
```typescript
export type RecentContribution = {
  cwid: string;
  slug: string;
  preferredName: string;
  primaryTitle: string | null;
  identityImageEndpoint: string;
  authorshipRole: "first author" | "senior author";  // text label per UI-SPEC
  paper: {
    pmid: string;
    title: string;
    journal: string | null;
    year: number | null;
    pubmedUrl: string | null;
    doi: string | null;
  };
  // NO citationCount field (locked by design spec v1.7.1)
};

export type SubtopicCard = {
  parentTopicSlug: string;
  parentTopicName: string;
  subtopicSlug: string;
  subtopicName: string;
  scholarCount: number;
  publicationCount: number;
  publications: Array<{
    pmid: string;
    title: string;
    firstWcmAuthor: { cwid: string; slug: string; preferredName: string } | null;
  }>;
};

export type ParentTopic = {
  slug: string;
  name: string;
  scholarCount: number;
};
```

**Prisma + ranking + serialize pattern** (`lib/api/profile.ts` lines 116-202): the function flow is `findFirst/findMany → map to rankable shape → call ranking fn → slice + serialize`. Mirror this for `getRecentContributions`:
```typescript
export async function getRecentContributions(
  now: Date = new Date(),
): Promise<RecentContribution[] | null> {
  const rows = await prisma.publicationAuthor.findMany({
    where: {
      isConfirmed: true,
      OR: [{ isFirst: true }, { isLast: true }],
      scholar: {
        deletedAt: null,
        status: "active",
        roleCategory: { in: ELIGIBLE_ROLES },   // requires Wave 0 schema add
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
  // ... map + score + sort + dedup-by-parent-area + slice(0, 6)
  // ... sparse-state floor check (D-12)
  if (top.length < 3) {
    console.warn(JSON.stringify({
      event: "sparse_state_hide",
      surface: "home_recent_contributions",
      qualifying: top.length, floor: 3,
    }));
    return null;
  }
  return top.map(toContribution);
}
```

**Sparse-state log shape:** see `lib/api/profile.ts:273-278` `isSparseProfile` for the existing sparse-state precedent. Phase 2's pattern is more aggressive (return null instead of a flag), but the log line shape mirrors structured-log convention: `{ event, surface, qualifying, floor, ...context }`.

**`identityImageEndpoint` import pattern** (`lib/api/profile.ts:10`, `lib/api/scholars.ts:8`): every payload that returns a scholar reference computes `identityImageEndpoint(cwid)` via the `lib/headshot` helper. Apply the same import + call in `RecentContribution` and `TopScholarChip` shapes.

**Divergence:**
- `getRecentContributions` requires `parentTopicSlug` for the dedup step (one card per parent area per spec line 1143). This depends on the W2 taxonomy migration (D-01/D-02). The query needs to join `publication → topic_assignment → topic → parent`. Until the schema is finalized, leave the dedup step as `// TODO(W3): implement after taxonomy schema lands`.
- The Selected research carousel query (`getSelectedResearch`) computes per-subtopic activity score and one-per-parent dedup; this is more complex than any existing query in the codebase. Plan a Prisma raw query (`prisma.$queryRaw`) here — pattern precedent is absent in `lib/api/*` today, so document the choice in PLAN.md.

---

### `lib/api/topics.ts` (NEW — service, CRUD, two topic surfaces)

**Analog:** `lib/api/profile.ts`

**Same patterns as `lib/api/home.ts` above.** Two exports:
```typescript
export async function getTopScholarsForTopic(
  topicSlug: string,
  now: Date = new Date(),
): Promise<TopScholarChip[] | null>;

export async function getRecentHighlightsForTopic(
  topicSlug: string,
  now: Date = new Date(),
): Promise<RecentHighlight[] | null>;
```

**Per-scholar aggregation pattern** — RESEARCH.md Example 4 (lines 651-691) walks this through. Distinct from anything in the existing `lib/api/*` modules, so flag it as a new pattern in PLAN.md. The shape:
```typescript
const byCwid = new Map<string, { scholar: Scholar; total: number }>();
for (const r of rows) {
  const score = scorePublication(/* ... */, "top_scholars", true, now);  // D-14 compressed curve
  const e = byCwid.get(r.cwid!) ?? { scholar: r.scholar!, total: 0 };
  e.total += score;
  byCwid.set(r.cwid!, e);
}
const sorted = [...byCwid.values()].sort((a, b) => b.total - a.total);
```

**Eligibility carve narrowing for D-14:**
```typescript
const TOP_SCHOLARS_ELIGIBLE_ROLES = ["full_time_faculty"] as const;
// NOT the broader ELIGIBLE_ROLES used elsewhere
```
Document this divergence in a comment block referencing D-14 + the methodology page.

---

### `lib/eligibility.ts` (NEW — utility, role-category constants and helper)

**Analog:** `lib/utils.ts`

**Module structure pattern** (`lib/utils.ts` lines 1-16):
```typescript
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}
```
Copy: no default export, named `export function`/`export const`, no I/O. For `lib/eligibility.ts`:
```typescript
/**
 * Role-category eligibility carve for algorithmic surfaces.
 * Source: design-spec-v1.7.1.md:377-385 (general carve);
 *         CONTEXT.md D-14 (Top scholars chip row narrowed override).
 */
export type RoleCategory =
  | "full_time_faculty"
  | "affiliated_faculty"
  | "postdoc"
  | "fellow"
  | "non_faculty_academic"
  | "non_academic"
  | "doctoral_student"
  | "instructor"
  | "lecturer"
  | "emeritus";

/** Eligibility carve for Recent contributions, Selected research carousel, Recent highlights. */
export const ELIGIBLE_ROLES: ReadonlyArray<RoleCategory> = [
  "full_time_faculty",
  "postdoc",
  "fellow",
  "doctoral_student",
];

/** Top scholars chip row only — D-14 narrows to PIs only. */
export const TOP_SCHOLARS_ELIGIBLE_ROLES: ReadonlyArray<RoleCategory> = [
  "full_time_faculty",
];
```

---

### `lib/methodology-anchors.ts` (NEW — utility, constants)

**Analog:** `lib/utils.ts` (constants module pattern)

```typescript
/**
 * Anchor IDs on /about/methodology referenced by the four algorithmic surfaces.
 * Hard-coded here to prevent surface components and the methodology page from
 * drifting (Pitfall 6 in 02-RESEARCH.md).
 */
export const METHODOLOGY_ANCHORS = {
  recentContributions: "recent-contributions",
  selectedResearch:    "selected-research",
  topScholars:         "top-scholars",
  recentHighlights:    "recent-highlights",
} as const;

export const METHODOLOGY_BASE = "/about/methodology" as const;
```

Surface components import these and build `href={\`${METHODOLOGY_BASE}#${METHODOLOGY_ANCHORS.recentContributions}\`}`.

---

### `prisma/schema.prisma` (MODIFIED — add `Topic`, `scholar.role_category`, extend `topic_assignment`)

**Analog:** `prisma/schema.prisma:160-191` — `TopicAssignment` and `PublicationScore` are the closest precedent for ReCiterAI projection tables.

**Existing `TopicAssignment` model** (`prisma/schema.prisma` lines 160-174):
```prisma
model TopicAssignment {
  id                String   @id @default(uuid()) @db.VarChar(64)
  cwid              String   @db.VarChar(32)
  scholar           Scholar  @relation(fields: [cwid], references: [cwid], onDelete: Cascade)
  topic             String   @db.VarChar(255)
  score             Float
  source            String   @default("ReCiterAI-DynamoDB") @db.VarChar(64)
  lastRefreshedAt   DateTime @default(now()) @map("last_refreshed_at")

  @@unique([cwid, topic])
  @@index([cwid])
  @@map("topic_assignment")
}
```

**Add a new `Topic` table** following the same conventions (uuid PK, `@db` length annotations, `@map` snake_case table name, FK with cascade):
```prisma
/// 67-parent / ~2,000-subtopic hierarchy projected from ReCiterAI DynamoDB.
/// Self-FK parent_id encodes parent → subtopic edge; parent rows have parent_id = null.
/// Phase 2 W0 probe (etl/dynamodb/probe.ts) determines exact ID/name shape.
model Topic {
  id                String    @id @db.VarChar(128)         // ReCiterAI topic_id
  parentId          String?   @map("parent_id") @db.VarChar(128)
  parent            Topic?    @relation("TopicParent", fields: [parentId], references: [id], onDelete: SetNull)
  children          Topic[]   @relation("TopicParent")
  name              String    @db.VarChar(255)
  slug              String    @unique @db.VarChar(255)
  scholarCount      Int       @default(0) @map("scholar_count")  // pre-computed for Browse grid (D-03)
  source            String    @default("ReCiterAI-DynamoDB") @db.VarChar(64)
  lastRefreshedAt   DateTime  @default(now()) @map("last_refreshed_at")

  topicAssignments  TopicAssignment[]

  @@index([parentId])
  @@index([slug])
  @@map("topic")
}
```
**NOTE:** Final schema shape locked by W0 probe per D-02. The above is candidate (a) from CONTEXT.md.

**Extend `TopicAssignment`** with FK to `Topic` (additive, backwards-compatible):
```prisma
model TopicAssignment {
  // ... existing fields
  topicId           String?  @map("topic_id") @db.VarChar(128)   // NEW: FK to Topic.id
  topicRef          Topic?   @relation(fields: [topicId], references: [id], onDelete: SetNull)
  // existing flat `topic: String` column kept for backwards compat; deprecated in W2 once topicId is fully populated
  // ...
  @@index([topicId])
}
```

**Extend `Scholar`** with `roleCategory` (Wave 0):
```prisma
model Scholar {
  // ... existing fields
  roleCategory      String?   @map("role_category") @db.VarChar(32)  // NEW: derived in ED ETL
  // ...
  @@index([roleCategory])
}
```
Use `String?` (nullable) initially so the migration applies cleanly to the existing 8,943 rows; ED ETL backfills in the same wave.

**Migration file pattern** — see `prisma/migrations/20260430115133_add_coi_activity/migration.sql`:
```sql
-- CreateTable
CREATE TABLE `coi_activity` (
    `id` VARCHAR(64) NOT NULL,
    `cwid` VARCHAR(32) NOT NULL,
    -- ...
    INDEX `coi_activity_cwid_idx`(`cwid`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `coi_activity` ADD CONSTRAINT `coi_activity_cwid_fkey`
  FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;
```
Copy: `CREATE TABLE` + named indexes + `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY` blocks. Migration should be additive only (no `DROP COLUMN`, no `RENAME`).

---

### `etl/dynamodb/index.ts` (MODIFIED — extend with taxonomy projection)

**Analog:** itself.

**Existing scan loop** (`etl/dynamodb/index.ts` lines 47-59):
```typescript
do {
  const resp = await ddb.send(
    new ScanCommand({
      TableName: TABLE,
      FilterExpression: "begins_with(PK, :prefix)",
      ExpressionAttributeValues: { ":prefix": "FACULTY#cwid_" },
      ExclusiveStartKey: lastKey,
    }),
  );
  for (const it of (resp.Items ?? []) as FacultyRecord[]) items.push(it);
  scanned += resp.ScannedCount ?? 0;
  lastKey = resp.LastEvaluatedKey;
} while (lastKey);
```
Replicate this paginated-scan idiom for the taxonomy partition (e.g., `TAXONOMY#`, `TOPIC#parent_id` — exact prefix from W0 probe). Add a second scan block before the existing FACULTY# block.

**Existing batch insert pattern** (`etl/dynamodb/index.ts` lines 92-107):
```typescript
console.log("Resetting topic_assignment table...");
await prisma.topicAssignment.deleteMany();

console.log(`Inserting ${rows.length}...`);
const BATCH = 1000;
for (let i = 0; i < rows.length; i += BATCH) {
  await prisma.topicAssignment.createMany({
    data: rows.slice(i, i + BATCH).map((r) => ({
      cwid: r.cwid,
      topic: r.topic,
      score: r.score,
      source: "ReCiterAI-DynamoDB",
    })),
    skipDuplicates: true,
  });
}
```
Copy: `deleteMany()` + `BATCH = 1000` + `createMany({ skipDuplicates: true })`. Apply for new `topic` table:
```typescript
await prisma.topic.deleteMany();
const BATCH = 1000;
for (let i = 0; i < topicRows.length; i += BATCH) {
  await prisma.topic.createMany({
    data: topicRows.slice(i, i + BATCH),
    skipDuplicates: true,
  });
}
```

**EtlRun bookkeeping pattern** (`etl/dynamodb/index.ts` lines 29-32, 109-126):
```typescript
const run = await prisma.etlRun.create({
  data: { source: "ReCiterAI-projection", status: "running" },
});
try {
  // ... ETL work
  await prisma.etlRun.update({
    where: { id: run.id },
    data: { status: "success", completedAt: new Date(), rowsProcessed: rows.length },
  });
} catch (err) {
  await prisma.etlRun.update({
    where: { id: run.id },
    data: { status: "failed", completedAt: new Date(),
            errorMessage: err instanceof Error ? err.message : String(err) },
  });
  throw err;
}
```
Keep the same `run` row but extend `rowsProcessed` semantics in PLAN.md (e.g., return aggregate count or extend the schema to per-source row counts).

**Process-exit pattern** (`etl/dynamodb/index.ts` lines 129-136):
```typescript
main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
```
Identical for the probe script and any new ETL extensions.

---

### `etl/dynamodb/probe.ts` (NEW Wave 0 — utility, one-shot DDB scan to stdout)

**Analog:** `etl/dynamodb/index.ts` lines 14-64 (scan + sample setup; skip the DB-write tail).

Copy the imports, env-var reading, and `DynamoDBDocumentClient.from(...)` setup verbatim. The probe enumerates partition prefixes:
```typescript
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";

const TABLE = process.env.SCHOLARS_DYNAMODB_TABLE ?? "reciterai-chatbot";
const REGION = process.env.AWS_DEFAULT_REGION ?? process.env.AWS_REGION ?? "us-east-1";

async function main() {
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  const prefixes = new Map<string, number>();
  const samples = new Map<string, unknown[]>();
  let lastKey: Record<string, unknown> | undefined;

  do {
    const resp = await ddb.send(new ScanCommand({
      TableName: TABLE,
      ExclusiveStartKey: lastKey,
      Limit: 1000,
    }));
    for (const it of resp.Items ?? []) {
      const pk = String(it.PK ?? "");
      const prefix = pk.split("#")[0] + "#";
      prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1);
      const arr = samples.get(prefix) ?? [];
      if (arr.length < 5) arr.push(it);
      samples.set(prefix, arr);
    }
    lastKey = resp.LastEvaluatedKey;
  } while (lastKey);

  console.log(JSON.stringify({ prefixes: [...prefixes], samples: [...samples] }, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
```
**No DB write, no `EtlRun` row — this is a probe.** Output goes to stdout for human inspection; capture to `.planning/phases/02-.../probe-output.json`.

---

### `etl/ed/index.ts` (MODIFIED — add `role_category` derivation + `ou=students` query branch)

**Analog:** itself.

**Existing per-faculty upsert block** (`etl/ed/index.ts` lines 60-114):
```typescript
for (const f of facultyEntries) {
  incomingCwids.add(f.cwid);
  const existingScholar = existingByCwid.get(f.cwid);
  if (existingScholar) {
    await prisma.scholar.update({
      where: { cwid: f.cwid },
      data: {
        preferredName: f.preferredName,
        // ...
      },
    });
  } else {
    await prisma.scholar.create({
      data: {
        cwid: f.cwid,
        // ...
      },
    });
  }
}
```
Add `roleCategory: deriveRoleCategory(f)` to both `update.data` and `create.data`. The derivation function lives at the top of the file:
```typescript
function deriveRoleCategory(f: EdFacultyEntry): RoleCategory {
  if (f.ou === "students" && f.degreeCode === "PHD") return "doctoral_student";
  if (f.personTypeCode === "Full-Time WCMC Faculty" && f.fte === 100) return "full_time_faculty";
  if (f.personTypeCode === "Postdoc") return "postdoc";
  if (f.personTypeCode === "Fellow") return "fellow";
  // ...
  return "affiliated_faculty";
}
```

**Second LDAP query branch (Wave 0):** `etl/ed/index.ts:38-40` currently calls `fetchActiveFaculty(client)` once. Add a second call to a new `fetchDoctoralStudents(client)` (added to `lib/sources/ldap.ts`) that searches `ou=students,dc=weill,dc=cornell,dc=edu` with a degree-code filter:
```typescript
console.log("Fetching active academic faculty...");
const facultyEntries = await fetchActiveFaculty(client);

console.log("Fetching doctoral students from ou=students...");
const studentEntries = await fetchDoctoralStudents(client);

const allEntries = [...facultyEntries, ...studentEntries];
await client.unbind();
```

---

### `lib/sources/ldap.ts` (MODIFIED — extend attributes + add student fetch)

**Analog:** itself.

**Existing attributes constant** (`lib/sources/ldap.ts` lines 22-35):
```typescript
export const ED_FACULTY_ATTRIBUTES = [
  "weillCornellEduCWID",
  "weillCornellEduPrimaryTitle",
  "weillCornellEduMiddleName",
  "weillCornellEduPersonTypeCode",
  "weillCornellEduDepartment",
  "givenName",
  "sn",
  "cn",
  "mail",
  "ou",
  "title",
  "departmentNumber",
] as const;
```

**Extend with FTE + degreeCode (Wave 0):**
```typescript
export const ED_FACULTY_ATTRIBUTES = [
  // ... existing entries
  "weillCornellEduFTE",         // NEW: drives full_time_faculty derivation
  "weillCornellEduDegreeCode",  // NEW: drives doctoral_student derivation (in ou=students)
] as const;
```

**Existing `fetchActiveFaculty` pattern** (`lib/sources/ldap.ts` lines 65-96): copy into a new `fetchDoctoralStudents` with a different `searchBase` (`ou=students,...`) and filter (`(weillCornellEduDegreeCode=PHD)`). Mirror the `firstString(...)` projection idiom.

**Add to `EdFacultyEntry`:**
```typescript
export type EdFacultyEntry = {
  cwid: string;
  preferredName: string;
  fullName: string;
  primaryTitle: string | null;
  primaryDepartment: string | null;
  email: string | null;
  personTypeCode: string | null;  // NEW (already pulled but not exposed)
  fte: number | null;             // NEW
  ou: string;                     // NEW (so the deriver can branch on "students")
  degreeCode: string | null;      // NEW
};
```

---

### `etl/search-index/index.ts` (MODIFIED — replace `personType = "Faculty"` placeholder)

**Analog:** itself, line 120.

**Current code** (`etl/search-index/index.ts` line 120):
```typescript
const personType = "Faculty"; // Phase 1 seed is faculty-only; ETL will refine.
```

**Replacement (Wave 0, after `scholar.role_category` lands):**
```typescript
const personType = s.roleCategory ?? "unknown";  // sourced from ED ETL derivation
```
Update the upstream Prisma include at line 60-74 to select `roleCategory` on the scholar row.

---

### `app/page.tsx` (REPLACE — Server Component + ISR + composed sections)

**Analog:** `app/(public)/scholars/[slug]/page.tsx`

**ISR exports pattern** (`app/(public)/scholars/[slug]/page.tsx` lines 19-22):
```typescript
// ISR: regenerate every 24 hours by default; on-demand revalidation fires from
// `/api/edit` (Phase 7) and from ETL writes (Phase 4) per decision #8.
export const revalidate = 86400;
export const dynamicParams = true;
```
For `app/page.tsx`, use a 6h fallback per Claude's discretion default (RESEARCH.md §Architecture Pattern 3):
```typescript
// ISR: 6h fallback TTL; on-demand revalidation fires after each ETL completion
// via /api/revalidate?path=/ (wave 4).
export const revalidate = 21600;
```

**Server Component data-fetch pattern** (`app/(public)/scholars/[slug]/page.tsx` lines 58-73):
```typescript
export default async function ScholarProfilePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const profile = await getScholarFullProfileBySlug(slug);
  if (!profile) notFound();
  // ...
}
```
For `app/page.tsx`:
```typescript
export default async function HomePage() {
  // Three independent fetches; allSettled so a single surface failure doesn't 5xx the page.
  const [recent, selected, browse] = await Promise.all([
    getRecentContributions().catch(() => null),
    getSelectedResearch().catch(() => null),
    getBrowseAllResearchAreas().catch(() => null),
  ]);
  // ... compose hero + (recent && <RecentContributionsGrid items={recent} />) + ...
}
```
Note: a thrown error from `lib/api/home.ts` should be uncommon (sparse-state returns null, not throw); the `.catch` is defense-in-depth for transient DB blips. The Browse grid has its own error-state UI per UI-SPEC §States ("Research areas temporarily unavailable. [Retry]").

**Section helper pattern** (`app/(public)/scholars/[slug]/page.tsx` lines 296-303):
```typescript
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="mb-4 text-xl font-semibold">{title}</h2>
      {children}
    </section>
  );
}
```
Reuse this pattern in `app/page.tsx` for section headings. The 18px / weight-600 token (UI-SPEC §Typography) is the new standard, so update the className to `text-lg font-semibold` (referencing the `--text-lg: 18px` token ported in W0).

**Conditional-render pattern for hide-if-null** (`app/(public)/scholars/[slug]/page.tsx` lines 100, 116, 122, 167, 220, 256):
```tsx
{profile.areasOfInterest.length > 0 ? (
  <Section title="Areas of interest">
    {/* ... */}
  </Section>
) : null}
```
Apply for Phase 2 sparse-state hide:
```tsx
{recent && <RecentContributionsGrid items={recent} />}
{selected && <SelectedResearchCarousel items={selected} />}
<BrowseAllResearchAreasGrid items={browse ?? []} />  {/* never hidden per D-12 */}
```

**`generateMetadata` pattern** (`app/(public)/scholars/[slug]/page.tsx` lines 38-56): adapt for the home page with static title/description (no params), or omit since `app/layout.tsx` may already set defaults — planner verifies.

---

### `app/(public)/topics/[slug]/page.tsx` (NEW placeholder per D-10)

**Analog:** `app/(public)/scholars/[slug]/page.tsx` (exact structural mirror)

**Copy the entire file structure** — params handling, ISR exports, data fetch, notFound, Server Component:
```typescript
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import {
  getTopScholarsForTopic,
  getRecentHighlightsForTopic,
} from "@/lib/api/topics";
import { TopScholarsChipRow } from "@/components/topic/top-scholars-chip-row";
import { RecentHighlights } from "@/components/topic/recent-highlights";

export const revalidate = 21600;
export const dynamicParams = true;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Topic: ${slug}` };  // refine in Phase 3
}

export default async function TopicPlaceholderPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  // Phase 2 ships ONLY hero + Top scholars + Recent highlights (D-10).
  // Phase 3 expands to full Topic detail layout B.
  const [topScholars, recentHighlights] = await Promise.all([
    getTopScholarsForTopic(slug).catch(() => null),
    getRecentHighlightsForTopic(slug).catch(() => null),
  ]);
  if (!topScholars && !recentHighlights) notFound();

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="text-4xl font-semibold">{slug}</h1>
      {topScholars && <TopScholarsChipRow scholars={topScholars} />}
      {recentHighlights && <RecentHighlights papers={recentHighlights} />}
    </main>
  );
}
```

**Divergence:** the profile page has `resolveBySlugOrHistory` redirect handling (lines 67-70). Phase 2 topic placeholder does NOT need this — topic slugs come from the W2 taxonomy migration and have no history table. Document the omission.

---

### `app/(public)/about/methodology/page.tsx` (NEW per D-04)

**Analog:** `app/(public)/scholars/[slug]/page.tsx` (Server Component + Section helper) — but no data fetch.

```typescript
import { METHODOLOGY_ANCHORS } from "@/lib/methodology-anchors";

export const dynamic = "force-static";  // pure prose, no data; SSG only
export const revalidate = false;        // never revalidate

export default function MethodologyPage() {
  return (
    <main className="mx-auto max-w-[720px] px-6 py-10">
      <h1 className="font-serif text-4xl font-semibold">How algorithmic surfaces work</h1>
      {/* Four anchor sections — IDs come from METHODOLOGY_ANCHORS so surface
          components and this page can never drift (Pitfall 6 in 02-RESEARCH.md). */}
      <section id={METHODOLOGY_ANCHORS.recentContributions} className="mt-10">
        <h2 className="text-lg font-semibold">Recent contributions</h2>
        {/* ... plain-English Variant B explanation, eligibility carve, recency curve ... */}
      </section>
      <section id={METHODOLOGY_ANCHORS.selectedResearch} className="mt-10">
        <h2 className="text-lg font-semibold">Selected research</h2>
        {/* ... including D-15 2020+ data floor footnote, D-16 dedup footnote ... */}
      </section>
      <section id={METHODOLOGY_ANCHORS.topScholars} className="mt-10">
        <h2 className="text-lg font-semibold">Top scholars</h2>
        {/* ... including D-14 narrowed eligibility + compressed curve callout ... */}
      </section>
      <section id={METHODOLOGY_ANCHORS.recentHighlights} className="mt-10">
        <h2 className="text-lg font-semibold">Recent highlights</h2>
        {/* ... */}
      </section>
      <p className="mt-12 text-sm italic text-muted-foreground">
        Weights reviewed six months post-launch by ReCiter lead and methodology page owner.
      </p>
    </main>
  );
}
```

**Section helper** (`app/(public)/scholars/[slug]/page.tsx` lines 296-303) is the precedent for the inline `<section>` blocks. Inline them rather than reuse the helper since each section needs a stable `id` for anchor links.

---

### `app/(public)/about/page.tsx` (NEW stub per D-05)

**Analog:** `app/(public)/scholars/[slug]/page.tsx` minimal version.

```typescript
export const dynamic = "force-static";
export const revalidate = false;

export default function AboutStubPage() {
  return (
    <main className="mx-auto max-w-[720px] px-6 py-10 text-center">
      <h1 className="font-serif text-4xl font-semibold">About Scholars at WCM</h1>
      <p className="mt-6 text-base">
        Methodology and algorithmic details are documented on the{" "}
        <a href="/about/methodology" className="text-[#2c4f6e] underline">
          methodology page
        </a>.
      </p>
    </main>
  );
}
```

**Alternative (D-05 discretion):** redirect via `next.config.ts` `redirects()` or `import { redirect } from "next/navigation"; redirect("/about/methodology")`. Planner picks. Recommendation: stub is cheaper because Phase 4 needs the file at this URL anyway.

---

### `app/api/revalidate/route.ts` (NEW — extends ETL → ISR cache invalidation)

**Analog:** `app/api/scholars/[cwid]/route.ts`

**Thin-delegator route handler pattern** (`app/api/scholars/[cwid]/route.ts` lines 1-22):
```typescript
import { NextResponse } from "next/server";
import { getScholarByCwid } from "@/lib/api/scholars";

export async function GET(
  _request: Request,
  context: { params: Promise<{ cwid: string }> },
) {
  const { cwid } = await context.params;
  const result = await getScholarByCwid(cwid);
  if (!result) {
    return NextResponse.json({ error: "Scholar not found" }, { status: 404 });
  }
  return NextResponse.json(result);
}
```
Mirror for revalidate:
```typescript
import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";

const ALLOWED_PATHS = ["/", "/scholars/[slug]", "/topics/[slug]", "/about/methodology"] as const;

export async function POST(request: NextRequest) {
  // Auth: env-var token (planner picks the var name; SCHOLARS_REVALIDATE_TOKEN is the convention)
  const token = request.headers.get("x-revalidate-token");
  if (!token || token !== process.env.SCHOLARS_REVALIDATE_TOKEN) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const path = request.nextUrl.searchParams.get("path");
  if (!path) {
    return NextResponse.json({ error: "missing path" }, { status: 400 });
  }
  // Validate path against whitelist (allow exact match or [slug] template)
  // ... (planner refines)
  revalidatePath(path);
  return NextResponse.json({ revalidated: path });
}
```

**Divergence:** No existing `/api/revalidate` route in the codebase (verified via `grep -rn "revalidatePath" app lib etl` — only `app/(public)/scholars/[slug]/page.tsx:21` declares `export const revalidate`). RESEARCH.md asserts this route "already exists" but it does not — Wave 4 creates it. Flag in PLAN.md.

---

### `app/globals.css` (MODIFIED — port design tokens from sketch theme)

**Analog:** `.planning/sketches/themes/default.css` lines 4-80 (token block).

**Existing `:root` block** (`app/globals.css` lines 6-27): only Radix shadcn color tokens (background, foreground, card, etc.). Missing the design-spec typography, spacing, and weight scales used by UI-SPEC.

**Existing `@theme inline` block** (`app/globals.css` lines 51-74): exposes shadcn color tokens to Tailwind. Tailwind 4 reads `@theme` to derive utility classes. **Add typography + spacing tokens here so `text-sm` (etc.) map to the Phase 2 values.**

**Tokens to port from `default.css`:**
```css
/* Typography (default.css lines 24-37) */
--text-sm: 13px;
--text-base: 15px;
--text-lg: 18px;
--text-4xl: 44px;
--font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
--font-serif: 'Charter', 'Tiempos', 'Georgia', serif;

/* Weights (default.css lines 44-47) */
--weight-normal: 400;
--weight-semibold: 600;
/* NOTE: per UI-SPEC checker, --weight-medium and --weight-bold exist but are NOT used in Phase 2 */

/* Spacing (default.css lines 50-60) */
--space-1: 4px;
--space-2: 8px;
--space-3: 12px;   /* the named exception per UI-SPEC */
--space-4: 16px;
--space-6: 24px;
--space-8: 32px;
--space-12: 48px;
--space-16: 64px;

/* Color (default.css lines 14-17) */
--color-primary-cornell-red: #B31B1B;
--color-accent-slate: #2c4f6e;     /* working accent — UI-SPEC color §Accent */

/* Layout (default.css lines 73-79) */
--max-content: 1100px;
--max-narrow: 720px;
--header-h: 60px;
```

**Important:** Tailwind 4 maps CSS vars in `@theme inline` to utility classes. Adding `--text-sm: 13px` to `@theme inline` makes `text-sm` resolve to 13px. Adding `--space-3` makes `gap-3`/`p-3`/etc. resolve to 12px (which it already does by default — but explicit declaration locks the value).

**Verify after port:** `text-sm` renders at 13px not Tailwind's default 14px; `text-base` at 15px not 16px; `text-lg` at 18px (matches Tailwind default); `text-4xl` at 44px not 36px.

---

### `components/home/recent-contributions-grid.tsx` (NEW — Server Component, 3×2 grid)

**Analog:** `app/(public)/scholars/[slug]/page.tsx` Section + Areas-of-interest grid (lines 167-179).

**Server Component (no `"use client"` needed):**
```tsx
import { RecentContributionCard } from "./recent-contribution-card";
import { METHODOLOGY_BASE, METHODOLOGY_ANCHORS } from "@/lib/methodology-anchors";
import type { RecentContribution } from "@/lib/api/home";

export function RecentContributionsGrid({ items }: { items: RecentContribution[] }) {
  return (
    <section className="mt-12">
      <h2 className="text-lg font-semibold">Recent contributions</h2>
      <p className="mt-1 text-sm italic text-muted-foreground">
        Faculty contributions ranked by ReCiterAI ·{" "}
        <a
          href={`${METHODOLOGY_BASE}#${METHODOLOGY_ANCHORS.recentContributions}`}
          className="text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
        >
          How this works
        </a>
      </p>
      <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
        {items.map((c) => (
          <RecentContributionCard key={c.paper.pmid} item={c} />
        ))}
      </div>
    </section>
  );
}
```
Note: Tailwind grid utilities for the responsive 3×2 → 2×3 → 1×6 collapse pattern (UI-SPEC §Responsive Breakpoints).

---

### `components/home/recent-contribution-card.tsx` (NEW)

**Analog:** `app/(public)/scholars/[slug]/page.tsx` `PublicationRow` (lines 305-347).

**Existing `PublicationRow`** (lines 305-347 — extract pattern):
```tsx
function PublicationRow({ pub }: { pub: ProfilePublication; ownerCwid: string }) {
  return (
    <div>
      <div className="font-medium leading-snug">
        {pub.pubmedUrl ? (
          <a href={pub.pubmedUrl} target="_blank" rel="noopener noreferrer"
             className="hover:underline">
            {pub.title}
          </a>
        ) : (
          pub.title
        )}
      </div>
      {/* ... authors, coauthor chips, journal · year line */}
      <div className="text-muted-foreground mt-1 text-xs">
        {pub.journal} · {pub.year}
        {pub.publicationType ? ` · ${pub.publicationType}` : ""}
        {pub.citationCount > 0 ? ` · ${pub.citationCount} citations` : ""}
      </div>
    </div>
  );
}
```
For `RecentContributionCard`, **omit citation count** (locked by design spec v1.7.1) and add HeadshotAvatar:
```tsx
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import { Card, CardContent } from "@/components/ui/card";
import type { RecentContribution } from "@/lib/api/home";

export function RecentContributionCard({ item }: { item: RecentContribution }) {
  return (
    <Card>
      <CardContent className="px-4 py-4">
        <div className="flex items-start gap-3">
          <HeadshotAvatar
            size="md"
            cwid={item.cwid}
            preferredName={item.preferredName}
            identityImageEndpoint={item.identityImageEndpoint}
          />
          <div className="flex-1 min-w-0">
            <a href={`/scholars/${item.slug}`}
               className="text-base font-semibold hover:underline">
              {item.preferredName}
            </a>
            <div className="text-sm text-muted-foreground truncate">
              {item.primaryTitle}
            </div>
          </div>
        </div>
        <a
          href={item.paper.pubmedUrl ?? item.paper.doi ?? "#"}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 block text-base font-semibold leading-snug hover:underline line-clamp-2"
        >
          {item.paper.title}
        </a>
        <div className="mt-1 text-sm text-muted-foreground">
          {item.paper.journal} · {item.paper.year} · {item.authorshipRole}
        </div>
      </CardContent>
    </Card>
  );
}
```

---

### `components/home/selected-research-carousel.tsx` (NEW — no codebase analog)

**Analog:** NONE — first horizontal scroll-snap carousel in the project. Use sketch 003 Variant D + native CSS `scroll-snap-type` per RESEARCH.md "Don't Hand-Roll" table.

**Pattern from research:**
```tsx
import { SubtopicCard } from "./subtopic-card";
import type { SubtopicCard as SubtopicCardData } from "@/lib/api/home";

export function SelectedResearchCarousel({ items }: { items: SubtopicCardData[] }) {
  return (
    <section className="mt-12">
      <h2 className="text-lg font-semibold">Selected research</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Eight subtopics with the strongest recent activity at WCM, one per parent area, refreshed weekly
      </p>
      <div
        className="mt-6 flex gap-4 overflow-x-auto pb-4 snap-x snap-mandatory"
        style={{ scrollPaddingLeft: "var(--space-3)" }}
      >
        {items.map((s) => (
          <div key={s.subtopicSlug} className="snap-start shrink-0 w-[calc((100%-3*16px)/3.15)]">
            <SubtopicCard item={s} />
          </div>
        ))}
      </div>
    </section>
  );
}
```
Native `scroll-snap-type: x mandatory` (Tailwind: `snap-x snap-mandatory`); `scroll-snap-align: start` per item (Tailwind: `snap-start`). Width formula on each item is `calc((100% - N*gap) / cards-visible)` where `cards-visible = 3.15` desktop, `2.15` tablet, `1.15` mobile (UI-SPEC §Responsive Breakpoints). Use Tailwind responsive variants on the width.

**`scroll-area` shadcn primitive:** UI-SPEC lists it in component inventory but native `overflow-x-auto` may be sufficient. Planner decides; if scroll-area is preferred, install via `npx shadcn add scroll-area` and replace the wrapping div.

---

### `components/home/subtopic-card.tsx` (NEW)

**Analog:** `components/ui/card.tsx` (Card / CardContent composition pattern).

```tsx
import { Card, CardContent } from "@/components/ui/card";
import { METHODOLOGY_BASE, METHODOLOGY_ANCHORS } from "@/lib/methodology-anchors";
import type { SubtopicCard as SubtopicCardData } from "@/lib/api/home";

export function SubtopicCard({ item }: { item: SubtopicCardData }) {
  return (
    <Card>
      <CardContent className="px-4 py-4">
        <div className="text-sm text-muted-foreground">{item.parentTopicName}</div>
        <a href={`/topics/${item.subtopicSlug}`}
           className="block text-base font-semibold hover:underline">
          {item.subtopicName}
        </a>
        <div className="mt-1 text-sm text-muted-foreground">
          {item.scholarCount} scholars · {item.publicationCount} publications
        </div>
        <ul className="mt-3 flex flex-col gap-2">
          {item.publications.map((p) => (
            <li key={p.pmid}>
              <div className="text-base font-semibold line-clamp-1">{p.title}</div>
              {p.firstWcmAuthor && (
                <a
                  href={`/scholars/${p.firstWcmAuthor.slug}`}
                  className="inline-block rounded-full bg-zinc-100 px-2 py-0.5 text-sm hover:bg-zinc-200"
                >
                  {p.firstWcmAuthor.preferredName}
                </a>
              )}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-sm italic text-muted-foreground">
          Selected by ReCiterAI ·{" "}
          <a
            href={`${METHODOLOGY_BASE}#${METHODOLOGY_ANCHORS.selectedResearch}`}
            className="text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
          >
            methodology
          </a>
        </p>
      </CardContent>
    </Card>
  );
}
```

---

### `components/home/browse-all-research-areas-grid.tsx` (NEW — 4-col grid of 67 parents)

**Analog:** `app/(public)/scholars/[slug]/page.tsx` Areas-of-interest grid (lines 167-179):
```tsx
{profile.areasOfInterest.length > 0 ? (
  <Section title="Areas of interest">
    <ul className="flex flex-wrap gap-2">
      {profile.areasOfInterest.map((t) => (
        <li key={t.topic}>
          <Badge variant="secondary" className="text-sm font-normal">
            {t.topic}
          </Badge>
        </li>
      ))}
    </ul>
  </Section>
) : null}
```

For Phase 2, switch from `flex flex-wrap` to a 4-col grid:
```tsx
import type { ParentTopic } from "@/lib/api/home";

export function BrowseAllResearchAreasGrid({ items }: { items: ParentTopic[] }) {
  if (items.length === 0) {
    return (
      <section className="mt-12">
        <h2 className="text-lg font-semibold">Browse all research areas</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Research areas temporarily unavailable.{" "}
          <button className="text-[var(--color-accent-slate)] underline">Retry</button>
        </p>
      </section>
    );
  }
  return (
    <section className="mt-12">
      <h2 className="text-lg font-semibold">Browse all research areas</h2>
      <ul className="mt-6 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
        {items.map((t) => (
          <li key={t.slug} className="flex items-baseline justify-between gap-2">
            <a href={`/topics/${t.slug}`} className="text-base font-semibold hover:underline">
              {t.name}
            </a>
            <span className="text-sm text-muted-foreground">{t.scholarCount} scholars</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
```
Note: `gap-y-3` = 12px = `--space-3` (UI-SPEC §Spacing exception).

---

### `components/topic/top-scholars-chip-row.tsx` (NEW)

**Analog:** `app/(public)/scholars/[slug]/page.tsx` PublicationRow co-author chips (lines 327-339).

**Existing chip pattern** (lines 327-339):
```tsx
{pub.wcmCoauthors.length > 0 ? (
  <div className="mt-1.5 flex flex-wrap gap-1.5">
    {pub.wcmCoauthors.map((a) => (
      <a
        key={a.cwid}
        href={`/scholars/${a.slug}`}
        className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs text-zinc-800 hover:bg-zinc-200"
      >
        {a.preferredName}
      </a>
    ))}
  </div>
) : null}
```
For Top scholars chip row, the chip is richer (avatar + name + title) and the row is single-line on desktop:
```tsx
import { TopScholarChip } from "./top-scholar-chip";
import { METHODOLOGY_BASE, METHODOLOGY_ANCHORS } from "@/lib/methodology-anchors";
import type { TopScholarChip as TopScholarChipData } from "@/lib/api/topics";

export function TopScholarsChipRow({ scholars }: { scholars: TopScholarChipData[] }) {
  return (
    <section className="mt-12">
      <h2 className="text-lg font-semibold">Top scholars in this area</h2>
      <p className="mt-1 text-sm italic text-muted-foreground">
        Ranked by ReCiterAI publication impact ·{" "}
        <a href={`${METHODOLOGY_BASE}#${METHODOLOGY_ANCHORS.topScholars}`}
           className="text-[var(--color-accent-slate)] underline-offset-4 hover:underline">
          How this works
        </a>
      </p>
      <div className="mt-6 flex gap-2 overflow-x-auto py-2">
        {scholars.map((s) => (
          <TopScholarChip key={s.cwid} scholar={s} />
        ))}
      </div>
    </section>
  );
}
```

---

### `components/topic/top-scholar-chip.tsx` (NEW)

**Analog:** `components/scholar/headshot-avatar.tsx` callsite + the chip pattern from `scholars/[slug]/page.tsx:330-336`.

**Compose `<HeadshotAvatar size="sm">` (24×24) with name + title:**
```tsx
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";

export function TopScholarChip({ scholar }: { scholar: TopScholarChipData }) {
  return (
    <a
      href={`/scholars/${scholar.slug}`}
      className="flex shrink-0 items-center gap-2 rounded-full border border-border bg-background px-3 py-1 hover:border-[var(--color-accent-slate)] hover:border-[1.5px]"
    >
      <HeadshotAvatar
        size="sm"
        cwid={scholar.cwid}
        preferredName={scholar.preferredName}
        identityImageEndpoint={scholar.identityImageEndpoint}
      />
      <div className="flex flex-col leading-tight">
        <span className="text-sm font-semibold">{scholar.preferredName}</span>
        <span className="text-sm text-muted-foreground">{scholar.primaryTitle}</span>
      </div>
    </a>
  );
}
```

**Min-height for accessibility:** UI-SPEC declares the chip-row tap-target floor (44px). Achieve via `py-2` on the row (2 × 8px) + 28px chip height = 44px tap target.

---

### `components/topic/recent-highlights.tsx` and `recent-highlight-card.tsx` (NEW)

**Analog:** `app/(public)/scholars/[slug]/page.tsx` Recent publications block (lines 198-215) + `PublicationRow` (lines 305-347).

Same shape as `RecentContributionCard` minus the scholar header (publication-centric — RANKING-02 — no authorship-position filter, no scholar focus). Show first 3 WCM authors as chip row + ellipsis if more, journal · year metadata, no citation count.

---

### `components/ui/scroll-area.tsx` and `components/ui/skeleton.tsx` (NEW shadcn primitives)

**Analog:** shadcn registry. Install via:
```bash
npx shadcn@latest add scroll-area
npx shadcn@latest add skeleton
```
Files land at `components/ui/scroll-area.tsx` and `components/ui/skeleton.tsx`. No custom code; trust the registry output. Verify the imports use `@/lib/utils` for `cn` (matches project convention per `components/ui/avatar.tsx:6`).

---

### `tests/unit/ranking.test.ts` (REWRITE for Variant B)

**Analog:** itself, lines 1-213 (current Variant A tests) — keep test structure and `makePub` helper, replace assertions.

**Existing structure** (`tests/unit/ranking.test.ts` lines 1-9):
```typescript
import { describe, expect, it } from "vitest";
import {
  authorshipPoints,
  impactPoints,
  rankForHighlights,
  rankForRecent,
  recencyScore,
  typePoints,
} from "@/lib/ranking";
```
Replace imports to match new Variant B exports (`authorshipWeight`, `pubTypeWeight`, `recencyWeight`, `scorePublication`, `aggregateScholarScore`, `rankForSelectedHighlights`, `rankForRecentContributions`, etc.).

**Existing `makePub` helper** (`tests/unit/ranking.test.ts` lines 193-212): keep verbatim, but adjust the default shape to include `reciteraiImpact: 0.5` and remove `citationCount` (no longer consumed by Variant B scoring). The shape to match becomes the new `RankablePublication`.

**Worked-example fixtures pattern (NEW per D-07):**
```typescript
import { WORKED_EXAMPLES } from "../fixtures/ranking-worked-examples";

describe("Variant B worked examples (design-spec-v1.7.1.md:1150-1173)", () => {
  it("Whitcomb 2003 Annals as Selected highlight: 0.46", () => {
    const { input, expected } = WORKED_EXAMPLES.whitcombSelected;
    expect(scorePublication(input, "selected_highlights", true, NOW))
      .toBeCloseTo(expected, 2);
  });
  // ... two more examples
});
```

---

### `tests/fixtures/ranking-worked-examples.ts` (NEW)

**Analog:** `tests/fixtures/scholar.ts` (constants-only fixture file).

**Pattern** (`tests/fixtures/scholar.ts` lines 1-22):
```typescript
export const FIXTURE_CWID = "abc1234";
export const EXPECTED_HEADSHOT_BASE = "https://...";
export const EXPECTED_HEADSHOT_URL = "https://.../abc1234.png?returnGenericOn404=false";
export const fixtureScholar = {
  cwid: FIXTURE_CWID,
  // ...
};
```
Mirror for ranking:
```typescript
export const NOW = new Date("2026-04-01");

export const WORKED_EXAMPLES = {
  whitcombSelected: {
    input: {
      pmid: "whitcomb-2003",
      reciteraiImpact: 0.92,
      publicationType: "Academic Article",
      authorship: { isFirst: false, isLast: true, isPenultimate: false },
      dateAddedToEntrez: new Date("2003-04-01"),
      isConfirmed: true,
    },
    expected: 0.46,  // 0.92 × 1.0 × 1.0 × 0.5
  },
  whitcombRecentHighlight: { input: /* same paper */, expected: 0.37 },
  nejmPostdocRecentContribution: {
    input: {
      pmid: "nejm-postdoc",
      reciteraiImpact: 0.88,
      publicationType: "Academic Article",
      authorship: { isFirst: true, isLast: false, isPenultimate: false },
      dateAddedToEntrez: new Date("2025-02-01"),  // ~14mo before NOW
      isConfirmed: true,
    },
    expected: 0.88,
  },
} as const;
```

---

### `tests/unit/eligibility.test.ts` (NEW)

**Analog:** `tests/unit/slug.test.ts` — pure-utility vitest pattern.

```typescript
import { describe, expect, it } from "vitest";
import { ELIGIBLE_ROLES, TOP_SCHOLARS_ELIGIBLE_ROLES } from "@/lib/eligibility";

describe("ELIGIBLE_ROLES", () => {
  it("includes the four spec-mandated roles per design-spec-v1.7.1:377-385", () => {
    expect(ELIGIBLE_ROLES).toEqual([
      "full_time_faculty", "postdoc", "fellow", "doctoral_student",
    ]);
  });
});

describe("TOP_SCHOLARS_ELIGIBLE_ROLES", () => {
  it("narrows to full_time_faculty only per D-14", () => {
    expect(TOP_SCHOLARS_ELIGIBLE_ROLES).toEqual(["full_time_faculty"]);
  });
});
```

---

### `tests/unit/home-api.test.ts` and `tests/unit/topic-api.test.ts` (NEW)

**Analog:** `tests/unit/profile-api.test.ts`

**Prisma-mock pattern** (`tests/unit/profile-api.test.ts` lines 7-51):
```typescript
import { describe, expect, it, vi } from "vitest";
import { EXPECTED_HEADSHOT_URL, FIXTURE_CWID } from "../fixtures/scholar";

vi.mock("@/lib/db", () => ({
  prisma: {
    scholar: {
      findFirst: vi.fn(async () => ({ /* fixture row */ })),
      findUnique: vi.fn(async () => ({ /* fixture row */ })),
    },
    publicationAuthor: {
      findMany: vi.fn(async () => []),
    },
  },
}));
```
Mirror for `home-api.test.ts`: stub `prisma.publicationAuthor.findMany`, `prisma.topic.findMany`, etc. Test the sparse-state floor behavior — `getRecentContributions` returns null when fewer than 3 qualify and emits a structured log (capture via `vi.spyOn(console, "warn")`).

For `topic-api.test.ts`: mirror with stubs for `prisma.publicationAuthor.findMany` filtered by topic; assert `aggregateScholarScore` math against a fixture pub set.

---

### `tests/e2e/home.spec.ts` (REWRITE) and topic / methodology e2e tests (NEW)

**Analog:** `tests/e2e/home.spec.ts` lines 1-9 (current 8-line file).

**Existing pattern:**
```typescript
import { test, expect } from "@playwright/test";

test("home page renders the hello banner", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Scholars @ Weill Cornell Medicine",
  );
});
```

**Phase 2 rewrite asserts the four sections render (or are gracefully hidden):**
```typescript
test("home page renders all four primary sections", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 }))
    .toContainText("Scholars at Weill Cornell Medicine");
  // Four section headings (D-12: section may be hidden if sparse — assert at least Browse renders)
  await expect(page.getByRole("heading", { name: "Browse all research areas" })).toBeVisible();
});
```

**`tests/e2e/methodology.spec.ts` (NEW):**
```typescript
test("all four methodology anchors resolve to DOM IDs", async ({ page }) => {
  for (const anchor of ["recent-contributions", "selected-research", "top-scholars", "recent-highlights"]) {
    await page.goto(`/about/methodology#${anchor}`);
    await expect(page.locator(`#${anchor}`)).toBeVisible();
  }
});
```

---

## Shared Patterns

### Named export functions, no default exports
**Source:** `lib/utils.ts`, `lib/api/profile.ts`, `lib/api/scholars.ts`, `components/profile/show-more-list.tsx`, `lib/ranking.ts`
**Apply to:** every new file in `lib/`, every component in `components/home/` and `components/topic/`
```typescript
export function HomePage() { ... }       // never `export default function`
export const ELIGIBLE_ROLES = [...];
```
Exception: Next.js page files (`app/page.tsx`, `app/(public)/topics/[slug]/page.tsx`, etc.) MUST `export default` because the App Router requires it. This is the only place default exports appear.

### Path alias `@/` for all project imports
**Source:** every `.ts` file in `lib/`, `app/`, `components/`, `tests/`
**Apply to:** all new files
```typescript
import { prisma } from "@/lib/db";
import { cn, initials } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
```
Never use `../` relative imports. The `@/` alias resolves from the project root via `tsconfig.json:paths`.

### Active-scholar predicate
**Source:** `lib/api/profile.ts:121`, `lib/api/scholars.ts:43`, `etl/search-index/index.ts:61`, `etl/dynamodb/index.ts:36`
**Apply to:** every new MySQL query that selects from the `scholar` table
```typescript
where: { deletedAt: null, status: "active" }
```
D-03 adds the eligibility-carve filter on top of (NOT in place of) this predicate. D-07 of CONTEXT explicitly notes the carve does NOT remove the active-scholar guard. Pitfall 7 in RESEARCH.md.

### `identityImageEndpoint(cwid)` for every scholar reference
**Source:** `lib/api/profile.ts:214`, `lib/api/scholars.ts:61`, `lib/api/search.ts` (search results)
**Apply to:** `lib/api/home.ts` (RecentContribution), `lib/api/topics.ts` (TopScholarChip), every payload that renders a `<HeadshotAvatar>`
```typescript
import { identityImageEndpoint } from "@/lib/headshot";
// ...
return {
  cwid: scholar.cwid,
  // ...
  identityImageEndpoint: identityImageEndpoint(scholar.cwid),
};
```

### Pure-function lib/api modules; thin route handlers
**Source:** `lib/api/profile.ts:1-9` (header), `app/api/scholars/[cwid]/route.ts:1-22` (delegator)
**Apply to:** `lib/api/home.ts`, `lib/api/topics.ts` (pure functions); `app/api/revalidate/route.ts` (thin delegator if a lib/api function is appropriate, else inline since revalidate is Next.js-bound)
```typescript
// lib/api/X.ts  — pure function, no Next.js imports
export async function getX(): Promise<XPayload | null> { ... }

// app/api/X/route.ts  — thin delegator
export async function GET(...) {
  const result = await getX();
  return NextResponse.json(result);
}
```

### Sparse-state hide with structured log
**Source:** RESEARCH.md Patterns 2 + Example 4 (no exact codebase precedent — closest is `lib/api/profile.ts:273-278` `isSparseProfile` returning a boolean flag, but Phase 2 uses null-return)
**Apply to:** `getRecentContributions`, `getSelectedResearch`, `getTopScholarsForTopic`, `getRecentHighlightsForTopic`
```typescript
if (qualifying.length < FLOOR) {
  console.warn(JSON.stringify({
    event: "sparse_state_hide",
    surface: "<surface_name>",
    qualifying: qualifying.length,
    floor: FLOOR,
    // ... context (slug, topic, etc.)
  }));
  return null;
}
```
The Browse all research areas surface is the only one that does NOT hide on sparse — D-12 specifies "always renders all 67 (no floor — fewer than 67 is a data-layer bug)". Browse's error state is "Research areas temporarily unavailable. [Retry]" instead.

### ETL bookkeeping with `EtlRun` row
**Source:** `etl/dynamodb/index.ts:29-32, 109-126`, `etl/ed/index.ts:28-31, 130-153`, `etl/search-index/index.ts` (no run row — opportunity to add)
**Apply to:** ETL extensions in `etl/dynamodb/index.ts`, `etl/ed/index.ts` (taxonomy + role_category)
```typescript
const run = await prisma.etlRun.create({ data: { source: "<source>", status: "running" } });
try {
  // ETL work
  await prisma.etlRun.update({
    where: { id: run.id },
    data: { status: "success", completedAt: new Date(), rowsProcessed: count },
  });
} catch (err) {
  await prisma.etlRun.update({
    where: { id: run.id },
    data: { status: "failed", completedAt: new Date(),
            errorMessage: err instanceof Error ? err.message : String(err) },
  });
  throw err;
}
```

### CSS-variable design tokens via Tailwind 4 `@theme`
**Source:** `app/globals.css:51-74` (current `@theme inline` block)
**Apply to:** Wave 0 port from `.planning/sketches/themes/default.css`. After port, components reference tokens via Tailwind utilities (`text-sm` = 13px after token override) or CSS-var pass-through (`text-[var(--color-accent-slate)]` for the Slate accent).

### Server Component ISR exports
**Source:** `app/(public)/scholars/[slug]/page.tsx:21-22`
**Apply to:** `app/page.tsx` (revalidate=21600), `app/(public)/topics/[slug]/page.tsx` (revalidate=21600). Methodology + about-stub use `dynamic = "force-static"` instead.
```typescript
export const revalidate = 21600;
export const dynamicParams = true;
```

### `params: Promise<{ slug: string }>` in Next.js 15 dynamic routes
**Source:** `app/(public)/scholars/[slug]/page.tsx:40-42, 60-62`, `app/api/scholars/[cwid]/route.ts:14`
**Apply to:** `app/(public)/topics/[slug]/page.tsx`, any new route under `app/api/`
```typescript
export default async function Page({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  // ...
}
```
Note: Next.js 15 made `params` a Promise. Don't write `params.slug` directly without `await`.

---

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `components/home/selected-research-carousel.tsx` | component | render (CSS scroll-snap) | First horizontal scroll-snap surface in the codebase. No existing component uses `snap-x snap-mandatory` or carousel idiom. Use sketch 003 Variant D + native CSS scroll-snap per RESEARCH.md "Don't Hand-Roll" table. |
| `app/api/revalidate/route.ts` | route | request-response (POST → revalidatePath) | RESEARCH.md asserts this exists; verified absent (`grep -rn revalidatePath app lib etl` finds no matches). Wave 4 creates it — closest analog `app/api/scholars/[cwid]/route.ts:1-22` (thin Next.js delegator pattern). |

Both files have rough patterns to follow (sketch 003 Variant D for the carousel; the `[cwid]` route handler shape for revalidate), but neither has a 1:1 codebase precedent the planner can copy verbatim. The two surfaces flagged here are also the most likely to surface execution bugs (carousel responsive width math; revalidate auth + path whitelist). Plan accordingly.

---

## Metadata

**Analog search scope:** `lib/`, `lib/api/`, `lib/sources/`, `app/`, `app/api/`, `app/(public)/`, `components/`, `etl/`, `prisma/`, `tests/`, `app/globals.css`, `next.config.ts`
**Files scanned:** 28 source files + sketch theme + Phase 1 PATTERNS.md
**Pattern extraction date:** 2026-04-30
**Key cross-cutting findings:**
- `lib/api/profile.ts` is the dominant analog for Phase 2 service-layer files (4 of 6 new lib/api files use it as direct precedent)
- `app/(public)/scholars/[slug]/page.tsx` is the dominant analog for Phase 2 page files (4 of 5 new pages use it as precedent — including the home replacement and the topic placeholder)
- `etl/dynamodb/index.ts` is its own analog for the W2 taxonomy extension; no second projection ETL exists yet to triangulate
- The `<HeadshotAvatar>` component (Phase 1) is reused in 3 of the 9 new components without modification
- Two structural gaps require cross-references rather than codebase analogs: (1) the carousel pattern and (2) the `/api/revalidate` route. Both are flagged in "No Analog Found"
