# Overview Generator v5 — NIH Biosketch: grounded implementation plan

> Pairs with `docs/overview-generator-v5-handoff.md` (the brief) and `docs/overview-generator-prompt-v5.md` (the prompt contract — moved here from `~/Downloads`).
> This plan supersedes the handoff where they disagree: it was produced by re-grounding every load-bearing handoff claim against **fresh `origin/master`** via a parallel agent workflow, because the working checkout (`docs/spotlight-pipeline`) is **218 commits behind** master. All file/line refs below are master, re-grounded.

**Base for the build:** a fresh worktree off `origin/master`, **outside Dropbox** (`~/worktrees/`), with `node_modules` + `cdk/node_modules` symlinked, `.env*` copied, `npx prisma generate`. Do **not** build on `docs/spotlight-pipeline` — its local `OverviewGeneration` is even missing the `promptVersion` column.

---

## Claim audit — handoff vs origin/master (17/19 confirmed)

| # | Handoff claim | Verdict | Note |
|---|---|---|---|
| 1 | `OverviewFacts.topics` is `{label,rationale}[]`, no cluster object | ✅ confirmed | `overview-facts.ts:71` |
| 2 | 5 contributions are model-derived from topics + repPubs (per-pub `topicRationale`) | ✅ confirmed | but see finding below — `TOPIC_LIMIT=4` |
| 3 | `toModelFacts` withholds `impact`/`impactJustification`/`facultyMetrics` | ✅ confirmed | `overview-generator.ts:489-504` |
| 4 | significance grounds on pub `synopsis`, which IS in the projection | ✅ confirmed | `:499` |
| 5 | funding importance-sorted via `scoreFundingImportance` | ✅ confirmed | `overview-facts.ts:416-420`; **no `Grant.amount`** |
| 6 | `groundOverviewDraft` strips anything not grounded (would delete significance) | ✅ confirmed | the (b)-relaxation is real work |
| 7 | `overviewVerifySystemPrompt(opts)` takes `{ permitSynopsisFindings }` | ✅ confirmed | `:803` |
| 8 | Opus 4.8 default; `modelAcceptsTemperature` omits temp for Opus 4.7/4.8/Fable | ✅ confirmed | `:49`, `:55-57` |
| 9 | `DEFAULT_OVERVIEW_PARAMS.promptVersion` is derived, not hardcoded | ✅ confirmed | `overview-params.ts:92` |
| 10 | shared floor/facets/verbatim blocks are inline + extractable | ✅ confirmed | V3/V4 are parallel full copies |
| 11 | route reuses `authorizeOverviewWrite` + rate-limit + facts + sufficiency | ✅ confirmed | canonical order in route |
| 12 | new flag should be **default-off, staging-first** | ⚠️ **STALE** | structural pattern right, but `SELF_EDIT_OVERVIEW_GENERATE` is now `'on'` both envs → wire new flag `env==='staging'?'on':'off'` |
| 13 | `estimateDraftCostUsd` assumes 300 output tokens | ✅ confirmed | `overview-prompt-versions.ts:194` |
| 14 | cost surfaced on privileged control only | ✅ confirmed | superuser/unit-admin only |
| 15 | `overviewGeneration` is single `text`+`promptVersion` (too thin) | ✅ confirmed | `schema.prisma:1874` |
| 16 | no `amount` on `Grant` | ✅ confirmed | `schema.prisma:568-662` |
| 17 | **ADR-009: a new table needs golden-list grant or deploy fails closed** | ❌ **WRONG** | `scholars.*` wildcard already covers new scholars-schema tables; adding a grant line would *fail* `verify-grants`. Net table cost = 1 migration, **zero grant work** |
| 18 | validation reuses `overview-facts-probe.ts` + biosketch mode in generate-from-facts | ✅ confirmed | scripts exist; biosketch mode is net-new |
| 19 | script gotchas (write-to-file, no-dotenv-in-VPC) hold | ✅ confirmed | both live in master code |

**New finding (not in handoff): `TOPIC_LIMIT = 4`** (`overview-facts.ts:47`). The spec's "up to 5 / top ~5 subarea clusters" exceeds the labeled-topic supply. The model sees ≤4 topic labels + up to 25 pubs (each `title`+`synopsis`+`topicRationale`+`authorPosition`). A 5th contribution must be subdivided from a rich topic using pub-level signal — supportable but not structurally guaranteed. **Decision fork below.**

---

## Architecture — a *purpose* axis, not a 5th version (handoff §0, confirmed)

Do **not** add `"v5"` to `OverviewPromptVersionId`. Build a **parallel** generator `generateBiosketch(facts, { mode, projectAims?, maxContributions?, model? })` beside `generateOverviewDraft`, sharing the substrate (`assembleOverviewFacts`, `toModelFacts`, the entity-floor fragment, `DEFAULT_MODEL`/`modelAcceptsTemperature`, `scoreFundingImportance` ordering) but with its own system prompt, user-turn builder, output parser, and **mode-aware** faithfulness pass. Greenfield: `git grep -il biosketch` over `lib/ app/ scripts/` returns zero generation code.

---

## Decisions (resolved by the grounding workflow; ★ = needs your sign-off)

### D1 — Persistence ★
**Recommend:** new `biosketchGeneration` Prisma model → `scholars`-schema table `biosketch_generation`: `id`, `cwid` (FK Scholar, Cascade), `mode` (`contributions`|`personal_statement`), `entries` (Json string[], ≤5, store exactly what was generated — don't pad), `projectAims` (Text, nullable, personal-statement only), `model`, `promptVersion?`, `params` (Json), `createdByCwid`, `createdAt`, index `(cwid, createdAt desc)`. Migration = `CREATE TABLE` + FK only, **no GRANT SQL**, **no `verify-db-grants.ts` edit** (wildcard covers it — claim #17 correction). Best-effort write in the route (try/catch, `generationId=null` on hiccup, entries still returned), copying the overview route's history block.
**Alternative:** pure stateless export (no table) — cleanest since the output is a copy/export artifact, not a profile field. Recommended *only* if you don't want an audit/reuse trail.

### D2 — Surface + gating ★
**Recommend:** dedicated `/edit/biosketch` (self) + `/edit/scholar/[cwid]/biosketch` (delegated), new `POST /api/edit/biosketch/generate` (own return shape). Reuse `authorizeOverviewWrite` **verbatim** (self + superuser + granted proxy + org-unit curator = the requested scope; superuser is a superset). **Do not** copy the overview generator's owner-self-only UI clamp (`edit-page.tsx:488`) — render for self/proxy/unit-admin/superuser and let the server predicate decide. New `BiosketchGenerateControls` (mode selector, `maxContributions` 1–5 stepper, project-title/aims textarea) + new `BiosketchResultCard` (per-entry copy + download-all, **no Accept-to-editor**). Do **not** bolt onto the Overview card (it's built on a saved-bio baseline + `UnsavedChangesGuard` + Accept-to-editor) or the ATTRIBUTES rail (every rail item maps to a savable field/SOR).
**Alternative:** a new ATTRIBUTES-rail section — cheaper plumbing, but mis-signals an export as profile data.
**Flag:** `EDIT_BIOSKETCH_GENERATE`, structural `process.env.FLAG === 'on'` (404 off), wired CDK `env==='staging'?'on':'off'` (claim #12 correction). **Rate limit:** distinct namespace `biosketch:{cwid}` (not `ovgen:{cwid}` — would cannibalize the overview cap).

### D3 — Shared-prompt extraction (handoff §1)
Extract the byte-identical V3/V4 blocks into named `string[]` fragments — `ENTITY_PROVENANCE_FLOOR`, `FACETS_ARE_ROUTING`, `VERBATIM_STRINGS`, `SPARSE_FACTS`, `OUTPUT`, plus the override/injection-guard clause — and recompose **both** `OVERVIEW_SYSTEM_PROMPT_V4` and the new `BIOSKETCH_SYSTEM_PROMPT` by spreading them. **Prove byte-identity first:** add a snapshot/hash test for `OVERVIEW_SYSTEM_PROMPT_V4` (none exists today — current tests are phrase-containment only and would miss a dropped newline), commit it, *then* extract as a no-behavior-change refactor and confirm the snapshot is unchanged. Biosketch diverges on: first-person forced, significance ON, char caps (not word bands), external-uptake ban, up-to-5 numbered output.

### D4 — Mode-aware faithfulness pass (handoff §3 — HIGHEST RISK)
Add **one** boolean opts key `permitSignificance` threaded exactly like `permitSynopsisFindings` through `groundOverviewDraft → verifyDraftGrounding → {overviewVerifySystemPrompt, buildGroundingReference}`. (Not a `purpose` discriminant — a biosketch wants *both* relaxations; an enum wouldn't compose and would force every caller to branch.)
1. **Opts extension** — widen `{ permitSynopsisFindings? }` → `{ permitSynopsisFindings?, permitSignificance? }` on the four threaded symbols (`:803`, `:819`, `:989`, `:1052`). Additive; threading already reaches all sites.
2. **New verifier clause** `VERIFY_SIGNIFICANCE_EXCEPTION` (parallel to `VERIFY_SYNOPSIS_NUMBER_EXCEPTION` at `:786`), appended when `permitSignificance`. Priority-ordered, conflicts resolve toward flagging:
   - **ALLOW** significance/implication ("means/changes/enables/rules out/reframes/informs") **only when anchored** in the same clause to a finding in a publication `title` or a `finding:` line, plus the scholar's own grounded follow-on work.
   - **STILL FLAG** (hard floor, unchanged): any invented/misattributed entity/number/disease/grant-aim. Significance never widens entity allowance.
   - **FLAG** empty superlatives / self-rating (the (a)-ban).
   - **FLAG** external uptake (NEW ban — claims about others' behavior/adoption/citation).
   - **Floating** (unanchored) significance = violation, category `unanchored-significance` (`parseUngrounded` has no allowlist, so a new category flows through verify→revise unchanged).
3. **Mode-aware reviser** (the load-bearing fix): `reviseDraftForGrounding` hardwires `OVERVIEW_REVISE_SYSTEM_PROMPT` and only takes `{model,temperature}`. Add a `system?: string` opt; `groundOverviewDraft` passes a new `BIOSKETCH_REVISE_SYSTEM_PROMPT` when `permitSignificance`. The delta: "remove only the flagged phrase; when a flagged entity/number sits in a sentence that also states an allowed significance of a grounded finding, keep the grounded significance clause — don't delete the whole sentence." Without this, the adjacency case strips valid significance across up-to-2 revision passes with no recovery.
4. `buildGroundingReference` change is **one guarded sentence** under PUBLICATIONS (names the `finding:` lines as the only valid significance anchors), behind `permitSignificance` so the overview path stays byte-identical.
**Recommend** biosketch also set `permitSynopsisFindings=true` (significance often quantifies a finding).

---

## Work breakdown

1. **Refactor (no behavior change):** snapshot-lock V4 prompt → extract shared fragments (D3). Assert snapshot unchanged.
2. **Prompt + generator:** `BIOSKETCH_SYSTEM_PROMPT` (verbatim intent from the spec), two user-turn builders (Contributions / Personal Statement), `generateBiosketch`, numbered-block parser → `string[]`, per-entry char-cap validation (≤2,000 / ≤3,500 — trim/flag overflow), sanitize per entry.
3. **Faithfulness mode (D4):** opts key, verifier clause, mode-aware reviser, guarded reference line, unit tests (incl. byte-identity guard for the overview path).
4. **Inputs:** Personal Statement requires `{ projectTitle, aims }` — route 400s when absent. Contributions: optional `maxContributions` (≤5) + optional area/role weighting (scope ★).
5. **Route + flag + gating + rate-limit (D2).**
6. **Persistence (D1)** — migration + model, or skip if stateless.
7. **UI:** `BiosketchGenerateControls` + `BiosketchResultCard`; extract the private `SegmentedField` helper out of `overview-generate-controls.tsx` to share it. Cost line via a parameterized `estimateBiosketchCostUsd(modelId, mode)` (Contributions ~1,650 out-tok, Personal Statement ~770; ×~3 with faithfulness pass) — privileged actors only.
8. **CDK:** add `EDIT_BIOSKETCH_GENERATE` (`env==='staging'?'on':'off'`); `npx jest app-stack -u`. No new IAM (Opus 4.8 already granted).
9. **Validation (handoff §8):** add a biosketch mode to `scripts/edit/overview-generate-from-facts.ts` (default OUT `/tmp/biosketch-drafts.json`, `faithfulnessPass:true`); reuse `overview-facts-probe.ts` in-VPC for facts (Personal Statement aims supplied locally, not via the probe). Re-tuned 2-skeptic audit, lenses: (1) entity-provenance [regression], (2) superlative + external-uptake, (3) significance-attachment [**primary focus** — floating significance + uptake-dressed-as-significance], (4) structure (distinct/non-padded, char caps, first person, no invented co-authors). Samples: `rgcryst`/`imh2003`/`gbm9002` + a mid-career 2–3-body scholar (tests "write fewer") + a Personal Statement run with sample aims. **Gate:** 0 entity violations, 0 superlatives, 0 external-uptake, every significance anchored, distinct/non-padded, caps respected.

## Deploy recipe (handoff gotchas, confirmed)
PR for review (no merge/deploy unless asked). Then: **flag/migration/IAM via manual `cd cdk && npx cdk deploy --exclusively Sps-App-staging -c env=staging --require-approval never` FIRST** (`cdk diff` writes to STDERR → `2>&1`); code → image via CD or `gh workflow run deploy.yml --ref <branch> -f env=staging`. Migration runs in the deploy's `migrate` step. Re-validate against the re-tuned gate. Worktree caveat: symlinked `node_modules` lacks `vis-network` → 5 baseline `tsc` errors in `center-collaboration-tab.tsx` (ignore; CI resolves); 1 pre-existing `edit-page` Radix-avatar vitest failure (symlink artifact).

---

## Sign-off — LOCKED 2026-06-20
1. **Persistence:** ✅ **new `biosketch_generation` table** (audit/reuse trail). *(D1)*
2. **Surface:** ✅ **dedicated `/edit/biosketch` route** (+ delegated `/edit/scholar/[cwid]/biosketch`). *(D2)*
3. **Contributions count:** ✅ **up to 5** — model may subdivide a rich topic via pub-level signal; the entry-count instruction must stay "write fewer when the work supports fewer" so the 5th is never padded. *(new finding)*
4. **v1 scope:** ✅ **both modes** (Contributions to Science + Personal Statement) in one PR.
5. *(defaults taken, change if wrong)* superusers may generate for any scholar (via `authorizeOverviewWrite`); flag staging-first (`env==='staging'?'on':'off'`); biosketch also `permitSynopsisFindings=true`; ban-list vocab (superlatives: *seminal, first to, world-renowned, highly-cited, pioneering, leading expert, landmark*; uptake: *widely adopted, shaped the field, became the standard, is widely cited, influenced, established the paradigm*) — refine during validation.
