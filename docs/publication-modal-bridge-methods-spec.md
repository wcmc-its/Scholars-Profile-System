# Publication modal: #917 Methods section + #928 cited-by/NIH-cites in-VPC bridge

One PR. Touches the publication-detail data layer (`lib/api/publication-detail.ts`) and
modal (`components/publication/publication-modal.tsx`) once, adding two independent payload
surfaces:

1. **#917 — Methods section.** Per-pmid method families, aggregated across all WCM authors of
   the paper, de-duped by `(supercategory, familyLabel)`, suppression/sensitivity-gated, linked
   to the cross-scholar Method pages. App-only; existing local data; testable locally.
   *Out of scope (no ETL exists):* per-`(tool, pmid)` tool context — `scholar-tool-mapper.ts:119`
   discards it. Tracked separately under #917.
2. **#928 — cited-by/NIH-cites bridge.** The last request-time ReciterDB surface in the family.
   Today `citingPubs` / `citingPubsTotal` come from a live `analysis_nih_cites` query that the
   in-VPC app can't reach, so the modal shows "Citation list temporarily unavailable." Bridge it
   via S3 (the #443/#926/#930 pattern) so it renders in-VPC. The headline Scopus count
   (`Publication.citationCount`, local) is unaffected and already survives in-VPC.

Shared flag posture: each surface has its own gate (below). Both ship dark to prod by default.

---

## Part 1 — #917 Methods section (app-only)

### Data layer (`lib/api/publication-detail.ts`)
Add to `PublicationDetailPayload`:
```ts
methodFamilies: PublicationDetailMethodFamily[];   // [] when flag off or none
```
```ts
export type PublicationDetailMethodFamily = {
  supercategory: string;
  familyLabel: string;
  familyId: string;      // for the Method-page link (see RISK below)
  href: string;          // precomputed methodFamilyPath(...) — UI stays dumb
  exemplarTools: string[];
};
```
Resolution (after the existing dark-pmid gate, so a dark pmid still returns null and never
reaches this):
1. Gate: `if (!isMethodsLensEnabled()) return []`. (prod=off → renders nothing; staging=on.)
2. Confirmed WCM authors of the pmid (LOCAL, bounded by the paper's WCM author count):
   `publication_author WHERE pmid = ? AND is_confirmed = 1` → cwids.
   - If zero cwids → `[]`.
3. Load their families (mirror `lib/api/methods.ts` filters):
   `scholarFamily.findMany({ where: { cwid: { in: cwids }, scholar: { deletedAt: null, status: "active" } }, select: { supercategory, familyLabel, familyId, pmids, exemplarTools } })`.
4. Scan each row's `pmids[]` JSON in JS for the target pmid (the codebase's established pattern —
   no `JSON_CONTAINS` anywhere). Collect distinct `(supercategory, familyLabel)`.
5. Apply `loadFamilyOverlayGate()` + `isFamilyPubliclyVisible(supercategory, familyLabel, gate)`
   (#800 suppression always; #801 sensitivity when `METHODS_LENS_SENSITIVE_GATE=on`). Identical
   to what the rest of the site applies, so the modal can't leak a hidden/animal-model family.
6. Build `href` via `methodFamilyPath(supercategory, familyId, familyLabel)` (`lib/method-url.ts`).
7. Sort deterministically (supercategory, then familyLabel). De-dupe keeps the first familyId seen.

**RISK — familyId in the link.** `methodFamilyPath` embeds `familyId` in the slug, but `familyId`
is *not stable across A2 rebuilds*; the stable key is `(supercategory, familyLabel)`. Before
wiring, confirm how `app/methods/[supercategory]/[family]/` resolves the family (by slug-embedded
familyId vs. by re-deriving from label). If it resolves by familyId, picking "any" cwid's familyId
is correct only if all cwids share it for that label — verify, and if not, resolve the canonical
familyId the Method page itself uses. (Acceptance test below covers a real linked family.)

### UI (`components/publication/publication-modal.tsx`)
- New `MethodsSection({ families })` placed **after MeSH** (matches issue's "below MeSH").
- Early-return `null` when `families.length === 0` (sparse, like `SynopsisSection`).
- Render family labels as `<Link href={f.href}>` with the existing `SectionHeading` ("Methods").
  Show `exemplarTools` as muted secondary text. No new fetch — data is in the payload.

### Flag
`METHODS_LENS_ENABLED` (existing). staging=on / prod=off. No cdk change (already wired per-env).

---

## Part 2 — #928 cited-by/NIH-cites bridge (S3, mirrors #443/#926/#930)

### Bridge granularity (decision)
**One row per cited pmid:** `{ pmid, total, citingPubs JSON (≤ 500) }` — an exact mirror of what
the modal reads (`citingPubsTotal` + up-to-`CITING_PUBS_CAP` list). NOT a full
`(cited_pmid, citing_pmid)` edge list (tens of millions of rows). Same shape as
`mentee_copublication` (count + capped preview JSON), just a 500-cap list.

### Prisma model + migration
```prisma
model PublicationCiting {
  pmid        Int      @id
  total       Int                       // full analysis_nih_cites count for this cited_pmid
  citingPubs  Json     @map("citing_pubs")  // ≤500 [{ pmid, title, journal, year }], date desc
  refreshedAt DateTime @default(now()) @map("refreshed_at")
  @@map("publication_citing")
}
```
Migration `prisma/migrations/2026061215XXXX_add_publication_citing/migration.sql` — CREATE TABLE,
utf8mb4, PK on `pmid`. No FK (citing metadata is reciterdb-derived). Regenerate prisma client.

### Export (WCM-side) `etl/mentoring/export-citing.ts` → `etl:mentoring:export-citing`
- Runs where ReciterDB is reachable (creds `SCHOLARS_RECITERDB_*` in shell env).
- Iterate the **local `Publication` table** pmids (these are the only ones the modal opens). For
  each, query `analysis_nih_cites` for `total` + the ≤500 most-recent citers joined to
  `analysis_summary_article` (reuse the exact SELECTs already in `publication-detail.ts`). Batch
  the iteration (e.g. chunk pmids, one connection). Emit only pmids with `total > 0`.
- Write NDJSON `{ pmid, total, citingPubs: [...] }` → `s3://<bucket>/citations/citing.ndjson`.
- `--dry-run` writes `/tmp` and skips S3 (matches export-copubs).
- **Note the cost honestly in logs:** this iterates all local pubs against ReciterDB — longer than
  the mentoring export. Log progress + a final count.

### Import (in-VPC) `etl/mentoring/import-citing.ts` → `etl:mentoring:import-citing`
- Mirror `import-copubs.ts`: read NDJSON from S3, validate, UPSERT by `pmid` in 500-batches,
  full-refresh `deleteMany({ refreshedAt: { lt: importedAt } })`, log to `etl_run`
  (`source: "Publication-Citing-Import"`), `--dry-run` parse-only, empty-export guard.
- Env: `MENTORING_COPUBS_BUCKET` (reuse), new `PUBLICATION_CITING_KEY` (default
  `citations/citing.ndjson`).

### Read-path (`lib/api/publication-detail.ts`)
Gate the citing block behind a new flag, with the **empty-table existence-probe** (so a flag
flipped before import degrades honestly, never fake zeros):
```ts
if (process.env.PUBLICATION_CITING_BRIDGE === "on") {
  const row = await prisma.publicationCiting.findUnique({ where: { pmid: pmidInt } });
  if (row) { citingPubsTotal = row.total; citingPubs = <row.citingPubs>; }
  else {
    // honest-degrade: distinguish "this pmid has 0 citers" from "table empty/not imported"
    const any = await prisma.publicationCiting.findFirst({ select: { pmid: true } });
    if (any) { citingPubsTotal = 0; citingPubs = []; }   // genuinely uncited
    else { citingPubsTotal = null; citingPubs = null; }  // un-imported → "temporarily unavailable"
  }
} else {
  // unchanged: live withReciterConnection block (still the path on WCM network / off-flag)
}
```
- `getCitingPublicationsForCsv` (the >500 escape-hatch, 50k cap): when the bridge flag is on,
  serve the bridged `citingPubs` (≤500). **Sub-decision:** for the rare paper with >500 NIH-cites,
  the in-VPC CSV is capped at 500 (the full 50k list only exists on the WCM network). Recommended:
  accept + document (most papers have <500 NIH-cites; in-VPC = the public site, never had the
  live path anyway). The modal subhead already reads "500 most recent of N total"; in-VPC that
  stays truthful for the count. Alternative (rejected): bridge a 50k-row JSON per pmid — too large.

### CDK / IAM (manual `cdk deploy` — CD never runs CDK)
- `cdk/lib/etl-stack.ts`: add `"arn:aws:s3:::wcmc-reciterai-artifacts/citations/*"` to the etl-role
  `s3:GetObject` resource list (alphabetical, before the hierarchy bucket).
- `cdk/test/etl-stack.test.ts`: add the same prefix to the guard test's `toEqual([...])`.
- `cdk/lib/app-stack.ts`: add `PUBLICATION_CITING_BRIDGE` per-env. **staging=on, prod=off**
  (import-then-flip; prod stays dark until its own gated deploy + import).
- Regenerate the app-stack snapshot: `cd cdk && npm ci && npm test -- -u`, commit only the `.snap`.

### Activation (operational, per env — NOT in this PR's merge)
1. CD deploys the merged image (new npm scripts live in it).
2. `cdk deploy --exclusively Sps-Etl-<env>` (grants the `citations/*` read — without it the import
   AccessDenied's).
3. Export WCM-side → import in-VPC (`run-task`, cluster/SG/subnets per the staging recipe).
4. `cdk deploy --exclusively Sps-App-<env>` to flip `PUBLICATION_CITING_BRIDGE=on`.
Empty table degrades honestly, so the PR is safe to merge ahead of any of this.

---

## Tests (vitest, before push — tsc/lint insufficient here)
- `publication-detail`: methods aggregation de-dupes across two cwids; suppressed/sensitive family
  excluded; flag-off → `[]`; bridge-on reads `publication_citing`; empty-table probe → null (not
  []); uncited-but-table-present → `[]`/0.
- `import-citing`: NDJSON parse/skip; upsert + stale-delete; empty-export guard.
- cdk: etl-stack guard test (new prefix) + app-stack snapshot.

## Acceptance
- [ ] Modal on a paper with a surfaced method family shows a "Methods" section linking to the
      Method page; a known suppressed/animal-model family does NOT appear; section omitted when
      empty; families de-dupe across multiple WCM authors.
- [ ] With `PUBLICATION_CITING_BRIDGE=on` + table imported, cited-by list + total render in-VPC;
      with the table empty, the modal still shows "temporarily unavailable" (honest degrade).
- [ ] No request-time ReciterDB dependency on the modal path when the flag is on.
- [ ] Existing modal sections (abstract, synopsis, impact, topics, MeSH) unchanged.

## Process
- Worktree off fresh `origin/master`, outside Dropbox; `npm ci` + `npx prisma generate` + copy
  `.env*`. Implement the coupled core serially (one data-layer file, one schema, one modal);
  optional review workflow on the final diff.
- PR for review only (no merge). Branch e.g. `feat/917-928-pub-modal-methods-citing-bridge`.
