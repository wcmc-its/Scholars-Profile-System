# Methods & Tools redesign — implementation plan

**Status:** Draft for approval · Owner: Paul Albert · Date: 2026-06-20
**Authoritative design:** `docs/methods-cellline-redesign-spec.md` · **Orientation:** `docs/methods-cellline-redesign-handoff.md`
**Issues:** #1166 (data gate, §7) · #1167 (Surface A, §4) · #1168 (Surface B, §5) · #1158 (source-pmid, folds into #1166)

This plan supersedes the *sequencing and scope* implied by the handoff, based on a fresh grounding pass against `origin/master` (@ `67268ddd`). It does **not** change the spec, which remains authoritative for design.

---

## 0. Decisions locked for this plan

| # | Decision | Choice |
|---|---|---|
| P-A | This cycle's deliverable | **Plan + issue re-scope first** (this doc). No code until approved. |
| P-B | How #1166 represents the `(publication × entity)` grain | **New table + ETL mapper** (`family_entity_usage`), not a JSON extension of `exemplarContexts`. |
| P-C | Is the ReciterAI entity-resolution stage in scope this cycle | **No.** Phase 1 ships against the **existing tool/family grain**; the entity stage + most of Surface B move to a later cycle. |

Spec §8 (D1–D6) decisions are accepted **as written** (side-sheet directory, single-select v1, granular-data/nest-in-UI, URL filter state, highest-centrality snippet, light rail). Mockup supersession question is **resolved** (see §6).

---

## 1. What grounding corrected (read this before trusting the handoff)

The handoff's symbol references were written at the `#1162` era and have drifted. Verified against `origin/master`:

| Handoff claim | Reality on `origin/master` |
|---|---|
| Highlighter at `components/ui/mark-term.tsx::markTermInText` | **Does not exist.** The only highlighter is module-local `highlightTermInSnippet` in `components/publication/publication-modal.tsx:681` (client-side `String.split(RegExp)`). |
| `#1164` shipped "Verbatim" + highlight into the **profile panel** | **`#1164` does not exist.** "Verbatim, from the author's papers" + `<mark>` shipped in **`#1160` to the publication *modal* only**. The profile panel got a **plain-text** Radix tooltip in **`#1119`** — no highlight, no source link. |
| Surface A is "already half-redesigned" | Surface A (`components/profile/methods-section.tsx`, `MethodsSection`/`ExemplarToolsLine:63`) is **closer to greenfield**: A1/A6/A7 net-new, A2/A4/A5 partial. The "interim" work the handoff credits to Surface A is actually in the **modal**. |
| Surface B §5.2 "reframes the existing block" | **Premise refuted.** The "How researchers use these tools" block (`lib/api/methods.ts:268 getFamilyToolUsage`) is keyed to **tool display names, not cell-line entities**. The entire entity layer is **100% net-new** → #1168 is a **ground-up build**, not a reframe. |
| `cores-inference` branch may help the gate | **Out of scope.** `pipeline_cores` is WCM core-*facility* attribution (a separate classification axis → DynamoDB `PUB#/CORE#`). It emits no §7 field. The §7 work lives entirely in `pipeline_tools`. |

**Re-grounded file map (Surface A / B / data):**

- Surface A panel: `components/profile/methods-section.tsx` (`MethodsSection:145`, `ExemplarToolsLine:63`), hosted by `components/profile/profile-pubs-cluster.tsx:391`.
- Surface A data shape: `lib/api/profile.ts` → `ScholarFamilyView { exemplarTools: string[]; exemplarContexts: Record<string,string> }` (`:78–98`); read via `lib/api/method-exemplar.ts` (`methodContext`, `pickMethodContext:146`).
- Surface B page: `app/(public)/methods/[supercategory]/[family]/page.tsx` (block at `:206–227`); strip data `lib/api/methods.ts:268 getFamilyToolUsage`; feed `components/method/publication-feed.tsx` (sort + research/all toggle only, **no entity filter, no URL state**); feed API `app/api/methods/[supercategory]/[family]/publications/route.ts`.
- Schema: `prisma/schema.prisma` `ScholarFamily` (`:1869`) + `ScholarTool` (`:1832`); `exemplarContexts` JSON (`:1907`) keyed by tool name, value = context **string only**.
- The cheap-win drop point (#1158): `etl/tools/scholar-family-mapper-s3.ts:203` `resolveExemplarContexts` calls `selectBestSnippet` which **returns `{context, pmid}` but persists only `out[name]=best.context`** — the pmid is computed and thrown away.
- Existing highlighter to share/replace: `components/publication/publication-modal.tsx:681 highlightTermInSnippet`.

---

## 2. The binding constraint

Both UI surfaces read the **same impoverished substrate**: a per-`(scholar, family, tool-display-name)` snippet **string**. It carries **no** char offsets, **no** source pmid, **no** `(publication × entity)` grain, and **no** entity normalization. Therefore:

- The provenance features that make the redesign worth doing — in-place highlight from offsets, source-pub click-through, ranked/filterable cell-line entities, multi-membership "Also matches" — **cannot be built faithfully on today's data** (spec §1/§10: "swapping in real extraction output should be a data change, not a structural one").
- The §7 gate (#1166) is the **common dependency** of #1167 and #1168.

§7 field status today (full table in #1166):

| Field | Status | Note |
|---|---|---|
| `method_family` | ✅ exists | family label |
| `usage_sentence` | ✅ exists (lossy) | verbatim, but collapsed to **one** best snippet per tool; multiplicity (§5.5) lost in SPS rollup |
| `source_publication_id` | 🟡 recoverable now | pmid already computed in `selectBestSnippet`, discarded at `scholar-family-mapper-s3.ts:203` → **this is #1158** |
| `is_evidenced` | 🟡 derivable | presence of a snippet |
| `usage_count` | 🟡 reframe | counts exist at family/tool grain; need per-**entity** count once entities exist |
| `entity_term` | 🟡 reframe | today = tool display name; §7 wants the specific entity (e.g. a cell line) |
| `normalized_entity_id` | 🔴 net-new | needs new entity-resolution stage in ReciterAI |
| `parent_entity_id` | 🔴 net-new | entity→entity nesting (e.g. 3T3-L1 → forms) |
| `entity_role` / `form` | 🔴 net-new | today leaks as a parenthetical in the family label |
| `matched_span` | 🔴 net-new (hardest) | char offsets; spec-**Required**; no client-side string matching |
| `centrality_score` | 🔴 net-new | `nameFirstFraction` heuristic in `tool-context.ts` is a seed but is discarded |

---

## 3. Phased plan

### Phase 1 — ship against the existing tool/family grain (this cycle)

Goal: deliver the provenance experience users can get **now**, with zero ReciterAI extraction changes, and build the shared components once.

**1a — #1158 source-pmid, end-to-end (the smallest win).**
- ETL: stop discarding the pmid. Extend the tool-grain snippet shape from `Record<string, string>` to `Record<string, { context: string; pmid: string }>` (this is a **tool-grain** JSON extension — explicitly *not* the §7 entity grain, which uses the new table in Phase 2). Touch: `etl/tools/scholar-family-mapper-s3.ts:203` (keep `best.pmid`), `etl/tools/tool-context.ts` (already carries `{context,pmid}`), schema `exemplarContexts` value type, `prisma` migration (additive/back-compat read).
- Read path: thread the pmid through `lib/api/profile.ts` `ScholarFamilyView`, `lib/api/method-exemplar.ts` `methodContext`, `lib/api/methods.ts` `FamilyToolUsage`, and `lib/api/publication-detail.ts` `PublicationDetailMethodTool`.
- UI: render a **"Source publication →"** click-through in the modal (the original #1158 target) **and** in the Surface A rail (1c). Back-compat: rows without a pmid render no link.
- This unblocks spec Goal #1 (verbatim sentence → click-through) without any extraction work.

**1b — Shared `ProvenanceRail` component (built once, used everywhere).**
- One component, per spec §5.3 ("reused from A"): eyebrow → term → sentence (with highlight) → "Source publication →". Persists last-hovered content; `aria-live="polite"` region (§9 — absent from all mockups, must be added).
- Surface-specific props only: eyebrow copy ("…from this scholar's papers" on A vs "…from a paper using it" on B) and the optional "View N publications" pill (A only).
- Highlight in Phase 1: **interim** — extract `highlightTermInSnippet` from `publication-modal.tsx` into a shared helper and reuse it (it already ships in prod via #1160, so we share existing debt rather than create new). **Marked for replacement** by offset-driven `<mark>` from `matched_span` when #1166 lands (§10). *(See decision Q-1 in §4 — this is the one deliberate §10 deviation in Phase 1.)*

**1c — Surface A (#1167) against current data.**
- **A1** side rail replaces the Radix tooltip overlay (`methods-section.tsx:88–102`). Two-column list+rail layout.
- **A2** consistent affordance (already partial): keep dotted-underline evidenced terms; add the descriptive-parent muted label and the one-line disambiguating caption (spec §4.2 line 63).
- **A4** the checkbox(filter) vs count+arrow-pill(navigate) split — consolidate the currently-separate count + arrow into the single pill arrangement the spec wants.
- **A5** hierarchy/air: family titles prominent, monospace strip recedes with more vertical air.
- **A6/A7** rail provenance: eyebrow + interim highlight + **source link from 1a's pmid**; soften heading only once `centrality_score` exists (Phase 2) — Phase 1 uses the fixed "Verbatim…" heading.
- **A3 (role nesting) deferred to Phase 2** — needs `parent_entity_id`/`entity_role`. *(Optional Phase-1 nicety: parse the existing label parenthetical to fake the "two ways" grouping; recommend deferring — fragile.)*

**1d — Surface B (#1168), Phase-1 slice only.**
- **§5.1 IA reorder + rename** is the only safe Phase-1 Surface-B piece (section order: Definition → Top scholars → [entity strip placeholder] → Spotlight → Articles). The **ranked entity strip, directory, filter, and cross-links are deferred** to Phase 3 because they require the entity grain.
- Recommend: keep the current tool-keyed block in place but renamed/reframed minimally, OR leave Surface B untouched in Phase 1 and do all of it in Phase 3. *(Decision Q-2 in §4.)*

### Phase 2 — the #1166 gate proper (later cycle, B+P-C)

**ReciterAI (`pipeline_tools`):**
- New **entity-resolution stage** below the existing tool registry: mint/normalize specific entities (`normalized_entity_id`), link `parent_entity_id`, attach `entity_role`/`form`. Template = the existing `canonical_tool_id` registry (`registry.py`), one grain down.
- Emit **`matched_span`** (char offsets of the matched occurrence within the already-verbatim sentence — the *specific* occurrence, not naive first-index).
- Emit **`centrality_score`** (move/port the `nameFirstFraction` heuristic upstream).
- Preserve **`usage_sentence` multiplicity** per `(publication × entity)` (today's rollup collapses to one winner — §5.5 needs all of them).

**SPS:**
- New **`family_entity_usage`** table at `(publication × entity)` grain + columns for the §7 fields (decision P-B). New ETL mapper alongside `scholar-family-mapper-s3.ts`.
- New read APIs for entity lists + per-`(pub × entity)` sentences/offsets.
- Swap the Surface A rail highlight to **offset-driven `<mark>`** (sanitized, §10); retire the interim client-side helper.

### Phase 3 — Surface B full discovery (#1168) + Surface A A3

- Ranked **"Specific cell lines used" strip** (entity_term + usage_count + proportional bar), single-select radio (D2 v1).
- **Hover rail** reuse (already built in 1b).
- **Filter + per-row relevance snippets** (on-demand), filtered article-list state (§5.7), **"Also matches" cross-links** (§5.5), **directory side-sheet** (search/sort/parent-nesting, §5.6).
- **URL state** for filter+sort+side-sheet (D4) — net-new; the family detail page has none today.
- Surface A **A3 role nesting** (now that `parent_entity_id`/`entity_role` exist).
- Later sub-phase: multi-select OR (D2), centrality-driven snippet selection + heading switch (D5).

---

## 4. Open sub-decisions (recommendations; not blocking the plan)

| ID | Decision | Recommendation |
|---|---|---|
| Q-1 | Phase-1 Surface A highlight with no `matched_span` | **Reuse the modal's existing client-side highlighter** as a shared, clearly-flagged interim (already in prod); replace with offsets in Phase 2. Accept as the single time-boxed §10 deviation. |
| Q-2 | Surface B in Phase 1 | **§5.1 IA rename only; defer the strip/directory/filter to Phase 3.** Leaves the tool-keyed block functioning until entities exist. |
| Q-3 | Article-list sort dropdown (Newest/Most cited/Oldest) in mockups | Has **no spec backing** — confirm scope; recommend deferring to Phase 3 with the rest of Surface B. |
| Q-4 | Directory parent-descriptor text ("mouse fibroblast line · 2 forms") | **No §7 field supplies it.** Decide a data source (new field, or derive) before Phase 3. |
| Q-5 | Where `centrality_score` is computed | **Upstream in ReciterAI** (emit it), not recomputed SPS-side, so the heading-switch logic is data-driven. |
| Q-6 | Legacy flag-off render path (`methods-section.tsx:451–553`) | Redesign behind the existing flag fabric; decide explicitly whether to retire the legacy path (per the #18 flag-hygiene note at `profile-pubs-cluster.tsx:404`). |

---

## 5. Shared components inventory (build once)

| Component | Spec | Phase | Notes |
|---|---|---|---|
| `ProvenanceRail` | §5.3 / §4.2-A6 | 1b | eyebrow / term / highlighted sentence / source link; `aria-live`; persists on leave |
| Term-highlight helper | §7 `matched_span` / §10 | 1b interim → 2 final | extract from modal now; offset-driven later |
| `FilterContextBar` (breadcrumb + removable chip + clear/back) | §5.7 / A4 | 1c (A chip bar) → 3 (B) | parameterized per surface |
| Ranked `StripRow` (term + bar + count) | §5.2 | 3 | **radio/single-select** (D2) — do **not** reuse Surface A's checkbox control |
| `EntityDirectory` side-sheet (search/sort/nest) | §5.6 | 3 | URL-addressable (D4) |
| `AlsoMatches` cross-link | §5.5 | 3 | generalize to N entities/row; cap TBD (§12) |

**Hard rule:** Surface A uses **checkbox + multi-select** (A4); Surface B strip uses **radio + single-select** (D2 v1). These are deliberately different — do not "harmonize" the control widget.

---

## 6. Resolved questions (no longer open)

- **Mockup supersession → RESOLVED.** The three Surface B mockups are **complementary states** of the §6 state machine (proven by identical entity vocabulary/counts/MS1 sentence and the `sendPrompt` transitions that hand state between them). None supersedes another or the spec. The Surface A mockup at `~/Downloads/scholars_methods_panel_redesign.html` exists and realizes A1–A7. All chrome (chat-design tokens, Tabler icons, `sendPrompt`) is **stand-in** → re-skin to Scholars Profile Console tokens + real URL/router state.
- **§8 D1–D6 → accepted as written** (defaults stand).

---

## 7. Proposed issue re-scope (apply on approval)

> Not yet pushed to GitHub. Ready to apply with `gh issue edit` once you approve.

- **#1166** (gate) — keep the §7 field table; **add**: (a) P-B decision (new `family_entity_usage` `(pub × entity)` table, not a JSON extension); (b) the §7 status table from §2 above; (c) explicit note that **`cores-inference` is out of scope**; (d) **`#1158` folds in as the source-pmid subset but does NOT close #1166** (matched_span + entity stage remain). Add to Phase 2.
- **#1167** (Surface A) — **fix the drift**: remove the false "#1164 / `markTermInText`" claim; state the real baseline (`#1119` plain-text tooltip on the panel; `#1160` highlight in the *modal* only). Split into **Phase 1** (A1/A2/A4/A5/A6/A7 with interim highlight + #1158 source link) and **Phase 2/3** (A3 nesting + offset highlight, gated on #1166).
- **#1168** (Surface B) — **re-characterize as net-new, not a reframe** (entity layer is 100% new; hard-gated on #1166). Keep Phase-1 = §5.1 IA rename only; move strip/rail-reuse/filter/directory/cross-links/URL-state to Phase 3. Drop the "mockups possibly superseded" note (resolved — complementary).
- **#1158** — narrow to the Phase-1 tool-grain pmid slice; note it is a subset of #1166 and serves both the modal **and** the Surface A rail; close it when the pmid ships end-to-end (it does not satisfy #1166).

---

## 8. Risks / gotchas

- **Do not let #1158 close #1166** — it delivers source-pmid only; matched_span + the entity-resolution stage remain.
- **No client-side string-matching as the *final* state** (§10). Phase 1's reuse of the modal helper is an explicit, tracked interim (Q-1).
- **Grain change is a new table, not a JSON tweak** (P-B). "Just add fields to `exemplarContexts`" under-scopes #1166 and cannot represent §5.5 multi-sentence-per-entity.
- **Flags:** Surface A is behind `PROFILE_FACET_REDESIGN` / `METHODS_LENS_*`; new work must thread the existing flag fabric and decide the legacy path's fate (Q-6).
- **Worktree/PR hygiene:** base every PR off **fresh `origin/master`** (current canonical branch `docs/spotlight-pipeline` is 214 behind). For this Dropbox repo, a normal branch is fine for single-stream work; if worktreeing, budget `npm ci` + `npx prisma generate` + copy `.env*`, and beware Turbopack rejecting symlinked `node_modules` (`npx next dev` webpack).
- **Verify worked-example data is real** (Immortalized cell lines / MS1 / 3T3-L1 / PMID 38321760) vs mock placeholder before any data-level verification.

---

## 9. Verification plan (per phase)

- **Phase 1:** unit tests for the pmid threading + rail; full `vitest --maxWorkers=4`; render-verify the Surface A rail + source link (Playwright `browser_snapshot`) on a real scholar with method data; confirm modal source link. CI green before merge.
- **Phase 2:** ETL dry-run on a sample; confirm `family_entity_usage` populates with offsets; verify `<mark>` renders from offsets (sanitized) and matches the term occurrence.
- **Phase 3:** filter/cross-link/directory interaction tests; URL deep-link round-trip; the MS1 multi-membership worked example renders the *different* sentence under each entity.

---

## 10. Immediate next actions (await approval)

1. Approve this plan (and the §4 recommendations / §7 re-scope).
2. On approval: apply the #1166/#1167/#1168/#1158 re-scope via `gh`.
3. Begin Phase 1 on a branch off fresh `origin/master`, starting with **1a (#1158 pmid)** then **1b (ProvenanceRail)** → **1c (Surface A)**.
