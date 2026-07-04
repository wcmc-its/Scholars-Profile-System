# Handoff — #917 publication-modal "Methods & tools" section

> ⚠️ **SUPERSEDED (2026-06-19) — this doc's Phase 1 plan is WRONG.** It was written
> against the stale `docs/spotlight-pipeline` checkout (0 occurrences of
> `resolveMethodFamilies`) and so declared #917 "not started." In reality **Phase 1
> (families) already shipped AC-complete in #938 (`78e2a2db`, 2026-06-12)**:
> `resolveMethodFamilies` (`lib/api/publication-detail.ts`) does a **bounded**
> author-scoped lookup (`publication_author`@pmid → `scholar_family`@`cwid IN`),
> #800/#801-gated, cross-author de-duped, plus the `MethodsSection` UI + tests. All
> six families ACs are met. **Do NOT build the `pmid_method_family` reverse table
> below** — the bounded lookup already satisfies the "no unbounded scan" AC (which
> allows "batched lookup OR reverse index"), and a reverse table would be redundant
> + collide with #1119's `etl/tools/*`. The only real gap (a per-surface flag) was
> closed by **PR #1154** (`METHODS_LENS_PUB_MODAL`). The genuine remaining work is
> **Phase 2 (tools + context), still deferred to #1119/PR #1122** — §6 below stands.
> Everything in §2–§4 (Phase 1) is historical/inaccurate; keep only §6.

**Issue:** #917 — *Publication modal: per-pmid tools + context in the Methods section (families half shipped dark in #938)*
**Status:** ~~decisions locked (2026-06-18); not started.~~ → Phase 1 shipped (#938) + flagged (PR #1154); Phase 2 deferred to #1119/#1122.
**Scope of this handoff:** ~~Phase 1 (families only).~~ Phase 2 (tools + per-tool context) is deferred and tied to #1119 — see the last section.

---

## 1. What we're building

When a publication-detail modal opens, show the **method families** (#799/#819) attributed to that paper as a "Methods & tools" section, with each family linking to its cross-scholar Method page. The modal is keyed purely on **pmid** (no cwid in scope), shared across profile / topic-feed / search / method surfaces.

This is the **new** section. The "Plain-language synopsis" the modal already shows is `Publication.synopsis` (#329/#387) — already shipped, unrelated to this work.

---

## 2. Decisions (locked — rationale in #917 thread + the design review)

| # | Decision | Choice | Why |
|---|---|---|---|
| 1 | Scope | **Families only** in Phase 1 | Every AC is family-scoped; families are resolvable today; `ScholarTool.pmids` is sparse/unreliable in practice (found empty in #1060) and tools are noisier. Tools = Phase 2. |
| 2 | Lookup mechanism | **New reverse table** `pmid_method_family`, indexed on `pmid`, populated by `etl/tools` | Modal is hot (profile/topic/search/method surfaces) and the AC bars "unbounded scan on modal open." `pmids` is a plain JSON column with no indexable membership on the app DB. A reverse table makes modal open an indexed point lookup. |
| 3 | Per-tool context | **Deferred to Phase 2, built on #1119** | Per-pmid context is discarded at rollup today (`scholar-tool-mapper.ts:119`). #1119 (PR #1122, open) already builds tool-context snippet extraction — reuse it rather than a parallel ETL change. |
| 4 | Cross-author aggregation | **Aggregate across all WCM authors, de-dupe by `(supercategory, familyLabel)`** | Mandatory: the modal has no cwid. Mirrors how Topics de-dupe (`publication-detail.ts` MAX-across-cwids precedent). De-dupe happens at ETL write time (one reverse row per `(pmid, supercategory, familyLabel)`). |
| 5 | Suppression / sensitivity | **Mandatory — reuse `loadFamilyOverlayGate()`** (`lib/api/methods-overlay.ts`) | #800 suppression + #801 sensitivity. The modal must never leak a family the rest of the site hides (AC verifies against a known animal-model/suppressed family). |
| 6 | Flag | **New default-off flag `METHODS_LENS_PUB_MODAL`** (in `lib/profile/methods-lens-flags.ts`), AND gated behind the master lens gate `isMethodsLensEnabled()` | Independent rollout, consistent with how every methods-lens surface gets its own flag (`METHODS_LENS_*`). |
| 7 | UI placement | A `MethodsSection` **below MeSH**, family labels as links (`lib/method-url.ts`), **omitted entirely when empty** (sparse, like synopsis) | Matches the issue's UI ask. |

> **All line numbers in this doc are indicative — the canonical checkout is stale (see Gotchas). Re-ground every reference via `git show origin/master:<path>` or a fresh-master worktree before trusting it.**

---

## 3. What exists today (grounded on origin/master)

- **`ScholarFamily`** (`prisma/schema.prisma`, #819): per-`(cwid, family)` rollup with `pmids[]` (JSON), `familyLabel`, `supercategory`, `exemplarTools[]`. `len(distinct pmids) === pub_count`. The stable family identity is `(supercategory, familyLabel)`.
- **`ScholarTool`** (`prisma/schema.prisma`, #794): per-`(cwid, tool)` rollup with `pmids[]`, `category`, `maxConfidence`, `sampleContext`. (Phase 2.)
- **No pmid→family reverse index today.** Method pages union `ScholarFamily.pmids` across cwids at read time (`lib/api/methods.ts`) — fine for a page, **not** for the hot modal.
- **Overlay gate is reusable:** `loadFamilyOverlayGate()` in `lib/api/methods-overlay.ts` applies the #800/#801 `(supercategory, familyLabel)` gate. Method pages already use it (`lib/api/methods.ts`). **Reuse it verbatim — never reimplement.**
- **The methods-lens ETL is `etl/tools/`** (S3-based): `etl/tools/index.ts`, `etl/tools/scholar-family-mapper-s3.ts`, `etl/tools/scholar-tool-mapper-s3.ts`. The reverse-table population belongs in the family mapper here (where `ScholarFamily.pmids` is written).
- **Modal plumbing:** `components/publication/publication-modal.tsx` (ModalContent section list ~:308, `SynopsisSection` ~:494) → `/api/publications/[pmid]` → `lib/api/publication-detail.ts` (pmid-keyed payload ~:114; multi-author de-dupe precedent ~:161).
- **Flags:** `lib/profile/methods-lens-flags.ts` (`isMethodsLensEnabled()`, `isMethodPagesEnabled()`, etc.).
- **Method page URLs:** `lib/method-url.ts`.

---

## 4. Phase 1 implementation plan

### 4a. Data layer — reverse table

1. **Prisma model + migration.** Add a model, e.g.:
   ```prisma
   /// Reverse index: which method families (#819) a publication is attributed to,
   /// de-duped across all WCM authors. Populated by etl/tools alongside ScholarFamily.
   /// Read by the publication modal (#917) for an indexed point lookup on pmid —
   /// the modal is hot, so a JSON membership scan over scholar_family is barred.
   model PublicationMethodFamily {
     pmid          String @db.VarChar(20)
     supercategory String @db.VarChar(...)
     familyLabel   String @db.VarChar(...)
     @@id([pmid, supercategory, familyLabel])
     @@index([pmid])
     @@map("pmid_method_family")
   }
   ```
   Store exactly the fields needed to (a) apply `loadFamilyOverlayGate()` (keys on `(supercategory, familyLabel)`) and (b) build the Method page URL (`lib/method-url.ts`). Create the migration **after** the latest on origin/master (#1119 added `20260618130000_...`; new timestamp must sort after it).

2. **ETL population** in `etl/tools/scholar-family-mapper-s3.ts` (or a sibling step in `etl/tools/index.ts`): for each `ScholarFamily` row, for each `pmid in pmids[]`, emit `(pmid, supercategory, familyLabel)`; **DISTINCT** the set (de-dupe across cwids/authors) before writing; replace-all the table per run (idempotent, mirrors how the rollups are rebuilt). Add a row-count log line.

3. **Read** in `lib/api/publication-detail.ts`: behind `METHODS_LENS_PUB_MODAL && isMethodsLensEnabled()`, add `methodFamilies` to the pmid payload:
   - `SELECT supercategory, familyLabel FROM pmid_method_family WHERE pmid = ?` (indexed).
   - Load `loadFamilyOverlayGate()` **once**, filter out suppressed/sensitive `(sc, label)`.
   - Map survivors to `{ supercategory, familyLabel, href }` via `lib/method-url.ts`.
   - Return `[]`/omit when flag off, table empty for the pmid, or all families gated out.
   - **Check the gate's cost on the hot path** — if `loadFamilyOverlayGate()` is heavy, confirm it's request-cached or cheap enough; method pages tolerate it but the modal opens far more often.

### 4b. UI

- New `MethodsSection` in `components/publication/publication-modal.tsx`, rendered **below the MeSH section**. Renders family labels as links to Method pages. **Render nothing (no heading) when `methodFamilies` is empty** — same sparse pattern as `SynopsisSection`.

### 4c. Tests

- **ETL** (`etl/tools/*` test): reverse rows are DISTINCT across multiple cwids/authors sharing a pmid; a family with N pmids emits N rows; replace-all semantics.
- **API** (`publication-detail` test): returns de-duped families for a pmid; a #800-suppressed / #801-sensitive family is **excluded** (the AC's key check); `[]` when flag off / no families.
- **UI** (`publication-modal` test): section renders family links; **omitted with no empty heading** when families is empty; respects the flag.
- **Hot-path**: assert the lookup is the indexed point query, not a scholar_family scan.

### 4d. Rollout

App + migration, no infra/cdk change. Flag default-off both envs. The CD migrate step applies the migration on deploy. Sequence: merge → CD applies migration (staging) → run `etl/tools` (or the targeted reverse-table step) to populate the table → flip `METHODS_LENS_PUB_MODAL` on staging via `cdk deploy --exclusively Sps-App-staging` → verify a known pmid renders its (gated) families → prod later behind the gated release. (No reindex needed — this is a DB table + app read, not a search-index change.)

---

## 5. Acceptance criteria (from #917)

- [ ] Opening a publication with attributed method families shows a "Methods & tools" section listing those families (links to Method pages).
- [ ] Families suppressed by #800 or gated by #801 do **not** appear (verified against a known suppressed/animal-model family).
- [ ] Section is omitted (no empty heading) when the pmid has no surfaced families.
- [ ] Families de-dupe across multiple WCM authors of the same paper (one entry per `(supercategory, familyLabel)`).
- [ ] No N+1 / unbounded scan on modal open (indexed reverse-table lookup).
- [ ] Existing sections (synopsis, topics, MeSH, cited-by) unchanged.

---

## 6. Phase 2 (deferred — DO NOT start until #1119 lands)

Tools per pmid + per-tool context snippet.

- **Blocked on #1119 (PR #1122, open):** it builds tool-context snippet extraction (`etl/tools/tool-context.ts`, `scholar_family.exemplar_contexts`, mapper changes). Phase 2 should **reuse that infrastructure**, not author a parallel ETL change to retain per-`(tool, pmid)` context.
- **Before building tools-per-pmid, confirm `ScholarTool.pmids` is reliably populated** (it was empty in #1060's environment). If sparse, tools-per-pmid is low-value.
- Likely shape: extend the reverse table (or a sibling `pmid_method_tool`) + surface tools "on expand" under each family, with the #1119 context snippet. Re-confirm scope with the issue author when Phase 2 starts.

---

## 7. Gotchas for the implementing session

- **Stale canonical checkout.** The repo is on `docs/spotlight-pipeline`, 177+ behind `origin/master`; Read/Grep read THAT tree. Re-ground every code/line reference via `git show origin/master:<path>` or a fresh-master worktree before trusting it.
- **Worktree recipe (Dropbox repo):** branch off fresh `origin/master`; app `package-lock` is identical master↔canonical → symlink `node_modules` from canonical; the prisma schema differs → `npx prisma generate` in the worktree (output `lib/generated/prisma`); `unlink node_modules` before `git worktree remove`. (See the recent #1123/#1124/#1126 sessions for the exact commands.)
- **#1119 overlap.** PR #1122 also touches `lib/api/methods.ts` and `etl/tools/*`. If it merges while you're in flight, rebase on fresh `origin/master` and re-run the FULL `vitest` suite (the #954 full-suite trap — a sibling PR in shared files reddens master).
- **Never bypass the overlay gate.** Use `loadFamilyOverlayGate()` exactly as the method pages do; the whole #800/#801 leak-prevention AC hinges on it.
- **Migration ordering.** New migration timestamp must sort after #1119's `20260618130000`. App + migration only — no cdk/CFN snapshot refresh needed.
- **Flag convention.** Add `METHODS_LENS_PUB_MODAL` (default off both envs) to `lib/profile/methods-lens-flags.ts`; gate the section behind it AND `isMethodsLensEnabled()`.
- **De-dupe at write, not read.** The reverse table holds one row per `(pmid, supercategory, familyLabel)`; the modal read is then a trivial indexed lookup with no cross-author logic.

---

## 8. Code references (re-ground on master)

- `components/publication/publication-modal.tsx` — ModalContent section list (~:308), `SynopsisSection` (~:494, the sparse-omit pattern to mirror).
- `lib/api/publication-detail.ts` — pmid-keyed payload (~:114), multi-author de-dupe precedent (~:161).
- `prisma/schema.prisma` — `ScholarFamily` (#819), `ScholarTool` (#794), `FamilySuppressionOverlay` (#800).
- `lib/api/methods-overlay.ts` — `loadFamilyOverlayGate()` (the #800/#801 gate to reuse).
- `lib/api/methods.ts` — `ScholarFamily.pmids` union precedent + gate usage.
- `etl/tools/scholar-family-mapper-s3.ts`, `etl/tools/index.ts` — where to emit the reverse rows.
- `etl/dynamodb/scholar-tool-mapper.ts:119` — where per-pmid context is discarded (Phase 2 context).
- `lib/method-url.ts` — Method page URL builder.
- `lib/profile/methods-lens-flags.ts` — methods-lens flags.
- Precedent for extending this modal with a new per-pmid section: #328.

Refs #799, #819, #794, #800, #801, #1119. Synopsis (the existing DDB context) is #329/#387.
