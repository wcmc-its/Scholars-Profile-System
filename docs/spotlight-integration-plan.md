# Spotlight Integration — phase plan

**Status (2026-05-08):** Plans 09-01 through 09-04 shipped. 09-05 collapsed into 09-03 (resolved: `personIdentifier` IS the WCM CWID). 09-06 (hierarchy bucket flip) and 09-07 (cleanup) are open. Operator runbook: [`spotlight-runbook.md`](spotlight-runbook.md).

Consume the ReciterAI spotlight artifact and replace the home page **Selected research** carousel with the new 2-column interactive spotlight component. Suppress **Recent contributions**.

**Authoritative upstream contract:** `~/Dropbox/GitHub/ReciterAI -ReCiter-Integration/docs/spotlight-contract.md`
**SPS coding-agent brief:** `~/Dropbox/GitHub/ReciterAI -ReCiter-Integration/docs/sps-spotlight-handoff.md`
**Reference ETL script:** `~/Dropbox/GitHub/ReciterAI -ReCiter-Integration/docs/sps-spotlight-etl-reference.ts`
**Mockup:** `~/Downloads/home-spotlight-interactive.html` (operator's laptop, not in repo)
**Launch handoff (what's live upstream):** `~/Dropbox/GitHub/ReciterAI -ReCiter-Integration/docs/spotlight-launch-handoff.md`

## Goal

Render 10 LLM-authored editorial ledes (one per parent topic) on the home page, each backed by 2–3 representative WCM publications with first/last author headshots, refreshed weekly from `s3://wcmc-reciterai-artifacts/spotlight/latest/spotlight.json`.

## Non-goals (v1)

- Editorial dashboard / hand-curated overrides — operator runs `--review-queue` on the ReciterAI side.
- Cron-triggered automation of the upstream `--publish` (operator-run).
- Modifying lede text client-side. Render verbatim per contract §Voice Contract.
- Shipping any image data from the artifact — there are none. Photo store does the join.

## Current state (what exists today)

- `app/page.tsx` calls `getSelectedResearch()` and `getRecentContributions()` in parallel and renders `<SelectedResearchCarousel>` + `<RecentContributionsGrid>`.
- `lib/api/home.ts:getSelectedResearch()` aggregates `PublicationTopic` scores per parent → top 8 subtopics → reads `displayName` / `shortDescription` from MySQL `Subtopic` (populated by Hierarchy ETL). Output: `SubtopicCard[]`.
- `etl/hierarchy/index.ts` is the template to mirror. Uses `@aws-sdk/client-s3`, `ajv/dist/2020`, sha256 short-circuit via `prisma.etlRun` keyed on `source: "Hierarchy"`.
- `model EtlRun` already has `manifestSha256` + `manifestTaxonomyVersion` columns and a `source` discriminator — we add a `source: "Spotlight"` row, no migration needed there.
- Last shipped phase commit prefix is `08-XX`. This is **Phase 09**.

## Plan breakdown

### Plan 09-01 ✅ shipped — Schema: `Spotlight` table + JSON `papers` column

New Prisma model. Mirrors the artifact shape so the ETL upsert is mechanical.

```prisma
model Spotlight {
  subtopicId       String   @id @map("subtopic_id") @db.VarChar(128)
  parentTopicId    String   @map("parent_topic_id") @db.VarChar(128)
  label            String   @db.VarChar(255)
  displayName      String   @map("display_name") @db.VarChar(255)
  shortDescription String   @map("short_description") @db.Text
  lede             String   @db.Text
  papers           Json     @db.Json   // Paper[] verbatim from artifact
  artifactVersion  String   @map("artifact_version") @db.VarChar(32)
  refreshedAt      DateTime @map("refreshed_at")

  @@index([parentTopicId])
  @@map("spotlight")
}
```

- D-06 carry-over: `subtopicId` is unstable across hierarchy recomputes. Each ETL run is a full replacement; no FK from other tables.
- `papers` stays as JSON. Per-paper author payload (`personIdentifier`, `displayName`, `position`) is denormalized in the artifact already; no separate `SpotlightPaper` / `SpotlightAuthor` tables.
- `Spotlight.subtopicId` is **not** a Prisma FK to `Subtopic.id` — the spotlight publish cycle is independent of the hierarchy publish cycle, and a transient mismatch during dual-publish windows must not break inserts.
- New migration: `prisma migrate dev --name spotlight_table`.

**Acceptance:** `prisma migrate` applies cleanly, `prisma.spotlight.findMany()` returns `[]` on empty schema.

### Plan 09-02 ✅ shipped — ETL: `etl/spotlight/index.ts`

Copy `sps-spotlight-etl-reference.ts` → `etl/spotlight/index.ts` and adapt the upsert + state-store blocks to mirror `etl/hierarchy/index.ts` structure.

- Module-level constants: `BUCKET = process.env.ARTIFACTS_BUCKET ?? "wcmc-reciterai-artifacts"`, `PREFIX = process.env.ARTIFACT_PREFIX ?? "spotlight"`.
- Reuse the `recordRun` helper pattern. `source: "Spotlight"`. Sha256 short-circuit against the prior successful `Spotlight` run, identical to hierarchy logic. Reuse `manifestSha256`; spotlight has no taxonomy_version drift case to model — leave `manifestTaxonomyVersion` populated for diagnostic continuity but skip the contradiction-guard branch.
- Fetch `${PREFIX}/latest/manifest.json`, then version-pinned `${manifest.version}/spotlight.schema.json` + `${manifest.version}/spotlight.json` (never mix `latest/` schema with versioned artifact).
- Validate via `Ajv({ strict: false })`. On failure, write `EtlRun(status: "failed")` and `process.exit(1)` — no partial upsert.
- Replace-style upsert: for each `artifact.spotlights[]` call `prisma.spotlight.upsert({ where: { subtopicId }, ... })`. Stale rows from prior publishes are removed via `prisma.spotlight.deleteMany({ where: { artifactVersion: { not: manifest.version } } })` after the upsert loop (full-replacement semantics per contract §Integration Pattern step 5).
- Ignore `artifact.pool_snapshot[]` — transparency-only per contract.
- Add npm script: `"etl:spotlight": "node --import tsx/esm etl/spotlight/index.ts"`.
- Wire into `etl/orchestrate.ts` after the hierarchy step (so `Subtopic` is fresh before any UI joins, even though the spotlight render does not strictly require it).

**Bucket migration carry:** the handoff says hierarchy moves from `wcmc-reciterai-hierarchy` → `wcmc-reciterai-artifacts/hierarchy/`. Per the launch handoff §What's live, this migration **has not happened yet** on the ReciterAI side either — they're still serving the hierarchy at the legacy bucket. Keep this Plan independent: the spotlight ETL points at `wcmc-reciterai-artifacts` from day one; the hierarchy ETL bucket flip is a separate (small) follow-up Plan 09-06 below, sequenced when ReciterAI confirms the cutover.

**Acceptance:** `npm run etl:spotlight` against the live `wcmc-reciterai-artifacts/spotlight/latest/` returns 10 rows in MySQL, schema validation passes, second run logs `short_circuit` and writes a 0-row `EtlRun`.

### Plan 09-03 ✅ shipped — DAL: `getSpotlights()`

New function in `lib/api/home.ts`. Read all 10 rows from `Spotlight` joined to `Topic.label` for the parent display name; resolve each paper's `first_author.personIdentifier` and `last_author.personIdentifier` to a Scholar row (for the photo URL + canonical display name).

- Function signature: `getSpotlights(): Promise<SpotlightCard[] | null>` returning `null` when fewer than 10 rows exist (D-12 sparse hide).
- Photo resolution: fold `Scholar` join into the same DAL call rather than a per-card client fetch — the existing `RecentContributionsGrid` pattern already does scholar-side joining server-side. Use `personIdentifier` as the join key (same key SPS uses today; verified Phase 2 per upstream handoff).
- Return shape:
  ```ts
  type SpotlightAuthor = {
    personIdentifier: string;
    displayName: string;            // prefer Scholar.displayName; fallback to artifact's displayName
    photoUrl: string | null;        // null → render initial-avatar fallback
    profileSlug: string | null;     // for click-through
    position: "first" | "last";
  };
  type SpotlightPaperCard = {
    pmid: string;
    title: string;
    journal: string;
    year: number;
    firstAuthor: SpotlightAuthor;
    lastAuthor: SpotlightAuthor;
  };
  type SpotlightCard = {
    subtopicId: string;
    parentTopicLabel: string;
    parentTopicSlug: string;
    displayName: string;
    shortDescription: string;
    lede: string;
    papers: SpotlightPaperCard[];   // 2-3
  };
  ```
- D-19 LOCKED reminder in the doc-comment: never pass `displayName`, `shortDescription`, or `lede` through any LLM, embedding, or retrieval path.
- Add a fixture-backed unit test alongside `tests/unit/home-api.test.ts`.

**Acceptance:** unit test against a 10-spotlight fixture produces 10 cards with photo URLs filled where Scholar rows exist, `null` where they don't, and lede strings carried verbatim.

### Plan 09-04 ✅ shipped — Render: `<SpotlightSection>` + suppress `RecentContributions`

New component implementing the 2-column interactive layout from `~/Downloads/home-spotlight-interactive.html`. Replace `<SelectedResearchCarousel>` and remove `<RecentContributionsGrid>` from `app/page.tsx`. Keep `getSelectedResearch()` / `<SelectedResearchCarousel>` / `getRecentContributions()` / `<RecentContributionsGrid>` files in place for one release cycle behind a feature flag, then delete in 09-07.

- The mockup is the source of truth; before writing this plan's tasks, screenshot the mockup file and put it in `.planning/source-docs/spotlight-mockup.png` so the implementation has a stable reference.
- Render `lede` verbatim (no truncation, no localization, no auto-formatting).
- Author headshots: `<Image>` with `photoUrl` if present, otherwise an initial-avatar built from `displayName`. Same fallback semantics as `RecentContributionsGrid`.
- Click-through: paper card → PubMed (existing pattern); author → `/scholars/{slug}` if `profileSlug` is non-null.
- Sparse hide: if `getSpotlights()` returns `null`, render nothing (do not show a half-empty section).
- Methodology link target stays at `#selected-research` (existing anchor) — this section semantically replaces the old one. Update copy in `app/(public)/about/methodology/page.tsx` to reflect the new selection mechanism (LLM lede + WCM-author pairing).

**Acceptance:** Playwright e2e (`tests/e2e/home.spec.ts` extension) loads `/`, finds 10 spotlight cards with non-empty ledes, each card has 2–3 papers, each paper has 2 author avatars (photo or initials).

### Plan 09-05 ✅ resolved (collapsed into 09-03) — Photo-store contract verification

Confirm the upstream claim that SPS already uses `personIdentifier` as the photo-store join key for `RecentContributionsGrid`. If yes, no work — Plan 09-03 reuses the same lookup. If the existing key is something else (e.g. `cwid`), document the mapping in this plan and update the DAL accordingly.

- Read the `RecentContributionsGrid` data path (`getRecentContributions()` and component prop shape) and grep for the photo-URL field on `Scholar`.
- Output: a one-paragraph note appended to this doc under §Photo-store join key (resolved). No code if the upstream claim holds.

**Acceptance:** §Photo-store join key (resolved) section exists with a single-line answer.

### Plan 09-06 ⏳ open — Bucket migration follow-up (sequenced, not blocking)

Once ReciterAI confirms `wcmc-reciterai-hierarchy` → `wcmc-reciterai-artifacts/hierarchy/` is cut over (per `bucket-migration-runbook.md`), flip `etl/hierarchy/index.ts`'s `HIERARCHY_BUCKET` default and the key prefix. Keep the env-var override so prod can be flipped independently of the deploy.

- Default flip: `HIERARCHY_BUCKET = "wcmc-reciterai-artifacts"`, key path `hierarchy/latest/manifest.json` (new prefix).
- Verify by running `npm run etl:hierarchy` against the new bucket and confirming a successful short-circuit-then-no-op against the existing `EtlRun` row (sha256 should match).

**Acceptance:** hierarchy ETL runs green against the new bucket, `EtlRun` row continues the existing source/status pattern, no schema changes.

### Plan 09-07 ⏳ open — Cleanup

After one passing weekly cycle of the new section:

- Delete `getSelectedResearch()`, `<SelectedResearchCarousel>`, `<SubtopicCard>` (home variant), `getRecentContributions()`, `<RecentContributionsGrid>`, and their test fixtures.
- Drop the feature flag introduced in 09-04.
- Update `docs/browse-vs-search.md` if any references to the old "Selected research" mechanism need rewording.

**Acceptance:** `git grep -i "selected.research\|recent.contributions"` returns only the new spotlight section + methodology copy + this planning doc.

## Sequencing

```
09-01 (schema)  →  09-02 (ETL)  →  09-03 (DAL)  →  09-04 (render)  →  09-07 (cleanup)
                                       ↑
                            09-05 (photo-store check, can run in parallel with 09-01/09-02)

09-06 (hierarchy bucket flip) — independent, run when ReciterAI confirms cutover.
```

## Open questions

1. **Spotlight count vs parent-topic uniqueness.** Current `getSelectedResearch()` enforces "one per parent." Upstream produces 10 spotlights across 10 distinct parents per the launch handoff (verified live). Confirm this invariant survives weekly publishes — if a future publish has 2 spotlights from the same parent, the render needs a tie-break. Default: render in artifact order; flag for editorial review only if it actually happens.
2. **Mockup gap.** `~/Downloads/home-spotlight-interactive.html` is on the operator's laptop, not in this repo. Drop a copy into `.planning/source-docs/` (gitignored) so future agents can read it.
3. **Photo-store API signature.** Plan 09-05 resolves this; if the join key is anything other than `personIdentifier`, Plan 09-03's DAL changes accordingly.
4. **Methodology copy.** The current methodology section explains the "8 subtopics by aggregate score, one per parent" mechanism. The replacement copy should describe the upstream LLM lede + critic gate without leaking implementation details. Draft inline in 09-04 and confirm with operator before merge.

## Photo-store join key (resolved)

`personIdentifier` from the spotlight artifact IS the WCM CWID, no translation needed. The existing `getRecentContributions()` path already keys on `Scholar.cwid` and constructs photo URLs via `identityImageEndpoint(cwid)` (see `lib/headshot.ts`). `getSpotlights()` reuses that exact pattern with no new mapping table.

Verified by Plan 09-03 smoke run on 2026-05-07: 10 cards rendered, last-author photos resolved against `Scholar` for ~70% of authors (mario-gaudino, harold-varmus, shuibing-chen, juan-miguel-mosquera, jim-hu, …); the rest render the initial-avatar fallback per contract §Author Headshot Rendering, which is graceful degradation, not an error. First-author resolution rate is lower because the upstream pipeline puts WCM full-time faculty in either first OR last position — many first authors are postdocs/trainees who don't have an SPS Scholar row.
