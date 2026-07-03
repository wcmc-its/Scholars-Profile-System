# #917 Phase 2 — tools + context under each family in the publication modal

**Status:** plan, awaiting approval. Author-grounded against `origin/master` @ `00255974`.
**Prereqs (all met):** Phase 1 families live on staging (`METHODS_LENS_PUB_MODAL=on`,
td `sps-app-staging:66`, render-verified 2026-06-19); #1119 tool-context infra MERGED
(PR #1122); `METHODS_LENS_TOOL_CONTEXT=on` on staging (td `:64`+).

---

## 1. Goal

The modal "Methods" section currently renders a flat chip list of method **families**
attributed to the paper (`MethodsSection` in `components/publication/publication-modal.tsx:634`).
Phase 2 adds, **under each family chip**, the family's representative **tools** and a
one-line **usage-context snippet** per tool — the remaining half of #917.

## 2. The data-source decision (the thing to approve)

`scholar_tool` (cwid, toolName, category, **pmids**, sampleContext) carries true per-pmid
tool linkage, BUT it has **no family id / supercategory** — so a `scholar_tool` row cannot
be nested under a family without an ETL-level tool→family join that does not exist today.

`scholar_family` (the rows `resolveMethodFamilies` **already loads**) carries the
tool→family linkage directly:
- `exemplarTools: Json` — up to ~3 representative member-tool **display names** per family
  (e.g. `"CheXpert"`), resolved at ETL time.
- `exemplarContexts: Json?` (#1119) — `{ toolDisplayName: snippet }`, the best
  junk-filtered usage sentence drawn **from a paper in this family's `pmids`**.

| | **Option A — `scholar_family` exemplar tools** (recommended) | **Option B — `scholar_tool.pmids ∋ pmid`** |
|---|---|---|
| Tool→family nesting | ✅ native (tools live on the family row) | ❌ no family id on `scholar_tool` — can't nest without ETL change |
| Per-pmid precision | family is pmid-attributed; tools are the scholar's top-3 for that family | ✅ literally tools whose pmids include this paper |
| New query | none (reuse loaded rows) | +1 `scholarTool.findMany` on the authors |
| Snippet | #1119 `exemplarContexts`, family-pmid-derived | `sampleContext`, representative (one per cwid+tool), not per-pmid |
| Gating/suppression | already via family overlay gate (#800/#801) | tools carry no family → no overlay key |
| Risk / surface | minimal, additive | higher; needs tool→family ETL to be useful |

**Recommendation: Option A.** It is the only path that cleanly nests tools under families
(the linkage exists only on `scholar_family`), reuses data the modal already fetches,
inherits the #800/#801 gate, and surfaces the curated #1119 snippet. The caveat to accept:
tools are the family's **representative exemplar tools** (paper-adjacent — the family is
attributed to this pmid), not a literal "only tools used in this exact paper" list.
Literal per-pmid tool filtering (Option B) would require an ETL change to stamp a family id
onto `scholar_tool` — propose as a separate **Phase 2b** only if reviewers require it.

## 3. Implementation (Option A)

### 3a. Data layer — `lib/api/publication-detail.ts`
- Extend `PublicationDetailMethodFamily` with `tools: Array<{ name: string; context: string | null }>`.
- In `resolveMethodFamilies` (already iterating `familyRows`): also `select` `exemplarTools`
  and `exemplarContexts`. For the first row kept per `(supercategory, familyLabel)` key, parse
  `exemplarTools` (string[]) and, **only when `isMethodsLensToolContextOn()`**, look up each
  tool's snippet in `exemplarContexts` (keyed by display name). When the tool-context flag is
  off, emit tool names with `context: null` (names are part of the families surface, already
  gated by `METHODS_LENS_PUB_MODAL`; the *snippet* is the tool-context-gated bit — matches how
  the rest of the lens splits the two flags).
- Reuse the existing exemplarTools/exemplarContexts JSON parse helpers (search `lib/api/methods.ts`,
  `lib/api/method-exemplar.ts`, `lib/api/profile.ts` — do not re-implement parsing).
- No new query, no `JSON_CONTAINS`, no ETL/reindex. Bounded exactly as today (author-scoped).

### 3b. UI — `MethodsSection` in `components/publication/publication-modal.tsx:634`
- Keep the family chip; render a nested sub-list of tool names beneath each family that has tools.
- Each tool: small label; when `context` present, show the snippet as muted helper text
  (mirror the existing exemplar-tool + context treatment in `components/profile/methods-section.tsx`
  / `components/method/family-rail.tsx` for visual consistency — match their classes, don't invent).
- Sparse rules unchanged: section omits when no families; a family with no exemplar tools renders
  as today (chip only).

### 3c. Flags
- `METHODS_LENS_PUB_MODAL` (already wired/live on staging) gates the whole section incl. tool names.
- `METHODS_LENS_TOOL_CONTEXT` (already wired/live on staging) gates only the snippet.
- No new flag. No app-stack change (both env vars already present on `sps-app-staging:66`).

### 3d. Tests
- Extend `tests/unit/publication-detail-api.test.ts`: family rows with `exemplarTools` +
  `exemplarContexts` → `tools[]` populated; tool-context flag off → `context: null`;
  pub-modal flag off → `methodFamilies: []` (unchanged); suppression gate still drops hidden families.
- Component test for the nested sub-list render (`tests/unit/publication-modal.test.tsx`).
- Full suite via `vitest --maxWorkers=4`; `tsc --noEmit`; eslint.

## 4. Rollout
- **Render-only — no ETL, no reindex, no migration, no app-stack/flag deploy.** Ships on the next
  CD image roll to staging (both gating flags are already on). Verify on staging by reopening the
  rayaz-a-malik Corneal Confocal modal → tools appear under "Confocal microscopy" with snippets.
- Prod stays dark (inherits `METHODS_LENS_PUB_MODAL=off` until the gated lens go-live).

## 5. Open questions for the reviewer / issue author
1. **Accept Option A's family-level exemplar tools** (recommended), or require literal per-pmid
   tool filtering (Option B + a Phase 2b ETL change to add a family id to `scholar_tool`)?
2. Cap on tools shown per family (exemplarTools is already ~3; show all vs top-N)?
3. Snippet display: inline muted text vs tooltip/popover (Phase 1 chips are compact — a long
   snippet per tool could bloat the section).

## 6. Out of scope
- Any ETL/artifact change (Option B's tool→family stamping).
- Prod rollout of the lens (separate gated effort — see [[project_917_pub_modal_methods]]).
