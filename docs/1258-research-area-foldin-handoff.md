# #1258 — Fold synonym lay-terms into the existing Research Areas row (handoff)

**Status:** ready to implement. The anchor data + pipeline are already shipped and live on
staging; this is the final piece — a contained server-side change in `matchTaxonomy` so a
query like `longevity` surfaces the **Aging & Geroscience** chip in the existing Research
Areas row.

> Branch hygiene: the canonical checkout may be on the stale `docs/spotlight-pipeline`
> branch (hundreds of commits behind). **Base the PR off freshly-fetched `origin/master`**
> and re-ground every symbol/line reference below via `git show origin/master:<path>`.

---

## 1. Goal

Searching a lay term that is practically synonymous with a research area (e.g. `longevity`
≈ *Aging & Geroscience*) should **fold that query into the existing research area** — it
shows up as the area's chip in the search-results "Research Areas" row, linking to the
existing `/topics/{slug}` page. **No new UI, no new area, no new chip type.** Just: the
synonym resolves into the existing area.

This is the research-area analog of the method-family synonym pattern that already exists
(`lib/methods/family-synonyms.ts` → `synonymKeys`), but **sourced from the MeSH curated
topic-anchor table that is already populated** rather than a new list.

---

## 2. Current state (what's already done)

**Merged to master:**
- **#1279** (`56f00958`) — relevance-weighted derived anchor producer (`etl/mesh-anchors`)
  + dry-run/resolve tooling + candidate fragments. Prod-gated via `MESH_ANCHOR_SCORE_MIN`
  (`0.9` staging / `2` prod kill-switch, in `cdk/lib/etl-stack.ts`).
- **#1282** (`0f674eac`) — promoted 135 curated anchors + 34 aliases into the loaded seeds
  (`etl/mesh-anchors/curated.csv`, `etl/mesh-aliases/curated.csv`). **`longevity` (D008136)
  → `aging_geroscience` is now a curated anchor.**
- **#1283** (`f8ae330e`) — wired `etl:mesh-anchors` into the **staging** nightly Step
  Function (staging-only; prod excluded until soak, mirroring the `infoed` exclusion).

**Deployed/loaded on staging (account 665083158573):**
- `cdk deploy Sps-Etl-staging` done → task def **rev 14**, `MESH_ANCHOR_SCORE_MIN=0.9`,
  nightly SM runs `etl:mesh-anchors`.
- One-off `etl:mesh-anchors` run-task: **143 curated** (incl. `longevity→aging`) + **233
  derived** loaded into `mesh_curated_topic_anchor`.
- App force-redeployed (resolver mesh-map cache refreshed — `curatedTopicAnchors` is live).
- Full `search:index` run-task: 177k pubs reindexed.

**So on staging right now:** `resolveMeshDescriptor("longevity")` returns
`curatedTopicAnchors: ["aging_geroscience"]`. The data is in place; only the
`matchTaxonomy` consumption is missing.

---

## 3. Why the obvious path didn't work (don't repeat it)

The descriptor→topic anchor's `reciterParentTopicId` clause (§1.6 OR-of-evidence) is
attached **only to publication docs** (`buildPublicationDoc` in `lib/search-index-docs.ts`),
**never to people docs** (`buildPeopleDoc`). So the anchor surfaces matching *publications*,
not *scholars* — the people-search results for `longevity` never change, no matter how many
reindexes you run. (There's a latent dead clause: the people query pushes a
`reciterParentTopicId` should-clause that matches a field people docs don't carry — see §7.)

**The Research Areas row is the correct surface** because it's driven by
`taxonomyMatch.areas`, which is independent of the people/publication index fields.

---

## 4. The change

**File:** `lib/api/search-taxonomy.ts`, function `matchTaxonomy(query)` (≈ lines 599–760 on
master; re-ground).

**Today:** `areas` is built only from candidates whose topic/subtopic **name** (or a
method-family `synonymKey`) matches the query. `longevity` matches no area name → `matched`
is empty → `state: "none"` → `ResearchAreasRow` renders nothing.

**Do:** treat the resolved `curatedTopicAnchors` as **synonym matches** and inject the
anchored topic candidates into the match set, mirroring how curated method synonyms already
flow (similarity `1.0`, an explicit editorial mapping).

Recommended shape (inside `matchTaxonomy`, after `const [all, meshResolution] = await
Promise.all([...])`):

```ts
// #1258 — fold curated topic anchors in as synonym matches. The query resolved to a
// MeSH descriptor whose curated anchor IS the research area (e.g. longevity -> Aging &
// Geroscience). Inject those topic candidates at similarity 1.0 so they flow through the
// normal partition/rank/enrich/areas pipeline exactly like a method-family synonym hit.
const anchorTopicIds = new Set(meshResolution?.curatedTopicAnchors ?? []);
const anchorMatches = anchorTopicIds.size
  ? all
      .filter((c) => c.entityType === "topic" && anchorTopicIds.has(c.id))
      .map((c) => ({ ...c, similarity: 1 }))
  : [];
// merge into matchedAll, deduped against name/synonym matches by (entityType,id)
```

Then merge `anchorMatches` into `matchedAll` before the existing
`if (matchedAll.length === 0) return { state: "none", meshResolution }` guard, deduping so a
topic that *also* name-matched isn't added twice (keep the higher similarity). Everything
downstream (topic/method partition, rank, enrich → counts/href, `areas`, `primary`) then
works unchanged — the anchored area appears as a chip (and, when it's the only match, as the
primary card, satisfying the `matches`-state contract).

**Key invariants to preserve:**
- Anchored topics are `entityType: "topic"` → they go into `matched` (topic partition), not
  `matchedMethods`. Don't let them leak into the method callout.
- Dedupe by `(entityType, id)` against name matches; the `areas` builder already dedupes by
  lowercased name as a second pass.
- Respect `ROW_AREA_CAP` (12) — anchored areas count toward it.
- `href` for a topic candidate is `/topics/{parentTopicId or id}` via `buildHref` — already
  correct; the chip links to the existing area page.

**Multiple anchors** (a descriptor can anchor several topics) → several chips. That's the
"all the research areas related" case; no special handling needed.

---

## 5. Test

Add to `tests/unit/search-taxonomy.test.ts` (mirrors existing pattern):
- Mock `resolveMeshDescriptor` → resolution with `curatedTopicAnchors: ["aging_geroscience"]`.
- Mock `loadEntityCandidates` to include an `aging_geroscience` topic candidate whose name
  does NOT contain the query string.
- `matchTaxonomy("longevity")` → assert `state === "matches"` and `areas` contains the
  `aging_geroscience` topic (with its scholarCount/href), even with zero name matches.
- Negative: a query that resolves to a descriptor with **no** anchor and no name match still
  returns `state: "none"`.

---

## 6. Deploy + verify

- This is **app code** (`lib/api/...`), so it ships in the **app image**, not the ETL.
  Path: merge → CD builds `scholars-app-staging:latest` → `aws ecs update-service
  --cluster sps-cluster-staging --service sps-app-staging --force-new-deployment` (or wait
  for the service to pick up `:latest`).
- **No ETL re-run / no reindex needed** — the anchor data is already loaded and the change
  is purely in the request-time taxonomy match.
- **Verify:** `https://scholars-staging.weill.cornell.edu/search?q=longevity` → the
  "Research Areas" row shows an **Aging & Geroscience** chip linking to its topic page.
  (Quick API check: the page is SSR; inspect `taxonomyMatch.areas` via the rendered row, or
  add a temporary debug field — the public `/api/search` response is people-only and does
  NOT carry `areas`.)

---

## 7. Related / remaining items (not blocking this change)

1. **`etl:mesh-aliases` NOT yet run on staging.** Only `etl:mesh-anchors` ran, so the 34
   alias terms (`diabetes`, `ICU`, `COVID`, `Alzheimer's`, `IVF`, …) don't resolve yet.
   Run it as a one-off run-task (cluster `sps-cluster-staging`, task def `sps-etl-staging`,
   FARGATE, subnets `subnet-019afebef588ee4b3`/`subnet-03de6e3dfe190288b`, SG
   `sg-09b494047547ea148`, command override `["npm","run","etl:mesh-aliases"]`) so those lay
   terms resolve → get their anchored areas via this same fold-in. **Also add an
   `etl:mesh-aliases` state to the nightly SM** (it's not in there either — same gap #1283
   fixed for anchors).
2. **Prod rollout (gated).** To enable prod: add `etl:mesh-anchors` (+ `etl:mesh-aliases`)
   to the **prod** nightly SM (remove the staging-only guard in `etl-stack.ts`), drop
   `MESH_ANCHOR_SCORE_MIN` from `"2"` to `"0.9"` for prod, `cdk deploy Sps-Etl-prod`, run the
   one-off populate + reindex, roll the prod app image. Curated anchors load even with the
   `=2` gate (it only suppresses *derived*), which is why prod is gated at the SM-step level.
3. **Dead people-search anchor clause.** The people query pushes a `reciterParentTopicId`
   should-clause, but people docs don't carry that field (§3) → it's an inert no-op. Worth a
   separate cleanup issue (either drop the clause from the people path or index the field on
   people docs if people-level topic admission is ever wanted).
4. **Worktree cleanup.** `~/worktrees/sps-1258-promote` (currently on the merged
   `feat/1258-nightly-sm-mesh-anchor` branch, has `cdk/node_modules`) — `git worktree remove`
   + `pkill -f 'vitest|esbuild|jest'`.
5. **Redundant artifacts.** `etl/mesh-{anchors,aliases}/curated.candidates.csv` were
   committed in #1279 as review fixtures and are now redundant (promoted into `curated.csv`);
   can be `git rm`'d. The `docs/mesh-anchor-lay-term-candidates.csv` seed is worth keeping.

---

## 8. Key references (re-ground on origin/master)

- `lib/api/search-taxonomy.ts` — `matchTaxonomy`, `loadEntityCandidates`,
  `resolveMeshDescriptor`, `MeshResolution.curatedTopicAnchors: string[]`.
- `components/search/research-areas-row.tsx` — `ResearchAreasRow({ result })`, renders
  `result.areas`; rendered at `app/(public)/search/page.tsx` (`<ResearchAreasRow
  result={taxonomyMatch} />`).
- `lib/methods/family-synonyms.ts` + `synonymKeys` handling in `matchTaxonomy` — the
  existing synonym pattern this mirrors.
- `etl/mesh-anchors/` — the anchor producer; `etl/mesh-anchors/curated.csv` — the curated
  seed now containing `D008136,aging_geroscience` (longevity).
- Anchor → publications field: `buildPublicationDoc` / `buildReciterParentTopicIdField` in
  `lib/search-index-docs.ts` (why the people path doesn't work).
