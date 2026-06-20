# Handoff — Overview generator v5: NIH-biosketch *purpose* (Contributions to Science + Personal Statement)

> Pairs with the spec `docs/overview-generator-prompt-v5.md` (currently `~/Downloads/overview-generator-prompt-v5.md` — move into `docs/` as part of this work). Written after v4 shipped (PR #1170 `cf46d2ba`; Opus 4.8 default + v4 prompt live on staging).

**Base:** fresh `origin/master`. Worktree off fresh `origin/master`, **outside Dropbox**; symlink `node_modules` + `cdk/node_modules`, copy `.env*`, `npx prisma generate`.

Read first to orient: `lib/edit/overview-generator.ts`, `lib/edit/overview-prompt-versions.ts`, `lib/edit/overview-params.ts`, `lib/edit/overview-facts.ts`, `app/api/edit/overview/generate/route.ts`, `components/edit/overview-generate-controls.tsx`, `prisma/schema.prisma` (`overviewGeneration` model), and the v4 system prompt (`OVERVIEW_SYSTEM_PROMPT_V4`) as the contract this adapts.

Note grounded against current code: `OverviewFacts.topics` is just `{ label, rationale }[]` (top parent topics by distinct-pmid count) — there is **no** code-level cluster object. The "5 contributions" are **model-derived** from topics + `representativePublications` (with per-pub `topicRationale`), i.e. the same prompt-driven throughline mechanism as v4. Verify there's enough signal to form up to five genuinely distinct bodies of work.

---

## 0. Lock the architecture FIRST — this is a *purpose* axis, not a 5th version

Do **not** add `"v5"` to `OverviewPromptVersionId`. The version registry (v2/v3/v4) is iteration on **one** artifact: a single, third-person, word-banded, public **overview**. The biosketch differs on every axis the registry can't express:

| | public-overview (v2–v4) | nih-biosketch (v5) |
|---|---|---|
| voice | third (param) | **first, forced** |
| output | 1 flowing overview | **up to 5 char-capped Contributions, OR 1 Personal Statement** |
| length model | word bands | **character caps (2,000 / 3,500)** |
| grounding contract | significance **forbidden** | **significance REQUIRED** (the (b)-relaxation) + new external-uptake ban |
| inputs | facts only | Personal Statement **requires project aims** |
| destination | lands in the profile editor to save | **a copyable/exportable grant-app artifact**, not a profile field |

**Recommended shape:** introduce a `purpose` concept and a **parallel** generator `generateBiosketch(facts, { mode, projectAims?, maxContributions?, model? })` living beside `generateOverviewDraft`, sharing the substrate (`assembleOverviewFacts`, `toModelFacts`, the entity-floor prompt fragment, the Opus model + `modelAcceptsTemperature` gate, `scoreFundingImportance` ordering) but with its own system prompt, user-turn builder, output parser, and **mode-aware** faithfulness pass. The version registry stays untouched for public-overview work. The critique's **public-bio** purpose is the *next* instance of the same scaffold (see §9) — build the scaffold generic enough that it drops in. This is the critique's core thesis: *don't de-densify the generator globally; add a purpose lever.*

## 1. System prompt + extract shared fragments (kill drift)

- Add `BIOSKETCH_SYSTEM_PROMPT` from the spec's SYSTEM PROMPT block (verbatim intent). It reuses v4's HARD FLOOR / throughline-first / no-methods-roster / facets-as-routing / verbatim-strings blocks **near-identically**. **Extract those shared blocks into named constants** (e.g. `ENTITY_PROVENANCE_FLOOR`, `FACETS_ARE_ROUTING`, `VERBATIM_STRINGS`) reused by `OVERVIEW_SYSTEM_PROMPT_V4` *and* the biosketch prompt — otherwise the floor drifts between purposes. Do this as a no-behavior-change refactor first; assert v4's assembled prompt is byte-identical before/after.

## 2. Output schema + parsing

- Contributions mode: **up to 5** entries, each a self-contained **first-person** paragraph **≤2,000 chars** (~330 words), returned as numbered blocks; **write fewer** when the FACTS support fewer distinct bodies of work ("a forced contribution is the same error as a forced fact").
- Personal Statement mode: **1** narrative **≤3,500 chars** (~580 words), project-tailored.
- Implement a parser (split numbered blocks → `string[]`), per-entry char-cap **validation** (flag/trim overflow), and sanitize per entry. Length discipline is a ceiling, never a target.

## 3. Mode-aware faithfulness pass — the (b)-relaxation (HIGHEST-RISK ITEM)

Today `groundOverviewDraft` → `verifyDraftGrounding`/`reviseDraftForGrounding` (driven by `overviewVerifySystemPrompt(opts)` + `buildGroundingReference`) **strips anything not grounded in FACTS** — which would delete the *required* significance sentences ("…which reframes the safety considerations…"). Extend the `opts` pattern (currently `{ permitSynopsisFindings }`) with a biosketch/significance mode and author a verifier variant whose contract is:

- **ALLOW**: a significance/implication claim **attached to a grounded finding** (what a reported result *means / changes / enables / rules out / reframes / informs*), and the scholar's own grounded follow-on work.
- **STILL FLAG** (unchanged hard floor): any invented/misattributed **entity** (tool, disease, gene, number, result, grant aim).
- **FLAG (the (a)-ban)**: empty superlatives / self-rating ("seminal," "first to," "world-renowned," "highly-cited"…).
- **FLAG (NEW ban)**: **external uptake** — "widely adopted," "shaped the field," "became the standard," "is widely cited." Claims about others' behavior are ungroundable from the scholar's own FACTS.
- A **floating** significance claim (not anchored to a grounded finding) is a violation.

This is where validation must concentrate — the relaxation is exactly the surface where a strong model over-reaches.

## 4. New inputs (generalize "purpose-required inputs")

- Personal Statement **requires** `{ projectTitle, aims }` — without it the model can't honestly write the "directly relevant experience" framing. Make the sub-mode reject when absent.
- Contributions: optional `maxContributions` (≤5) and optional area/role weighting.
- Model this as a per-purpose "required extra inputs" declaration so the **public-bio** purpose's *grounded disease-stake field* (§9) slots into the same mechanism.

## 5. Surface / route / persistence / flag / gating

- **New flag** (e.g. `EDIT_BIOSKETCH_GENERATE`), default-off, staging-first (mirror `SELF_EDIT_OVERVIEW_GENERATE` / `isOverviewGenerateEnabled`).
- **New route** `POST /api/edit/biosketch/generate` (different return shape than the overview route — don't overload it). Reuse `authorizeOverviewWrite` + rate-limit + `assembleOverviewFacts` + `hasSufficientFacts`.
- **Persistence**: `overviewGeneration` has a single `text` + `promptVersion` — biosketch is N entries + mode + project aims. Decide: a new `biosketchGeneration` table (entries as JSON or rows) is cleaner. **A Prisma migration is then required** → it runs in the deploy's `migrate` step. ⚠️ **ADR-009 gotcha (verified in `deploy.yml`):** a new table needs its `app-rw` grants added to the golden list, or the `verify-grants` task **fails the deploy closed** before the service rolls. Confirm the grant/bootstrap path for any new table.
- **Output is an export/copy artifact**, not a saved profile field — no "save to profile" flow; provide copy/download of the entries. New UI surface (a biosketch tool — decide `/edit/biosketch` vs a tab) and **gating** (scholar self + proxies + curators, since it's for the scholar's own applications).

## 6. Cost

`estimateDraftCostUsd` assumes **300 output tokens** (overview). Biosketch output is far larger — 5×~330 words ≈ **~1,650 out** (Contributions) or ~580 words ≈ **~770 out** (Personal Statement). Parameterize the out-token estimate per purpose (Opus list price $5/$25 → ≈ **$0.05–0.06** Contributions / **$0.02–0.03** statement; **×~3** if the faithfulness pass is on). Surface it on the privileged control, same as v4.

## 7. Reuse / model / IAM (mostly free)

- **Opus 4.8 is already the default and already IAM-granted** (v4 work — `sps-task-staging:67`, all 4 ARNs). The `modelAcceptsTemperature` gate already omits `temperature` for Opus — **reuse it; do not re-add temperature**. **No new IAM.**
- `toModelFacts` already withholds raw `impact`/`impactJustification`/`facultyMetrics`; significance grounds on the publication **`synopsis`**, which IS in the projection — sufficient. Funding in FACTS is already importance-sorted (`scoreFundingImportance`), which helps contributions pick the meatiest grants.

## 8. Validation — RE-TUNED for the relaxation (model + new contract)

Reuse the v4 tooling: `scripts/edit/overview-facts-probe.ts` (in-VPC facts, via `scripts/run-staging-probe.sh`) → add a **biosketch mode** to `scripts/edit/overview-generate-from-facts.ts` (or a sibling) for local Opus-4.8 generation. Then a **re-tuned** adversarial 2-skeptic audit — the v4 audit would false-positive on legitimate significance, so the lenses change to:

1. **Entity-provenance** (unchanged hard floor).
2. **Superlative/self-rating + external-uptake** (the (a)-ban + new ban).
3. **Significance-attachment**: every "means/implies/reframes" claim ties to a *grounded* finding (floating significance = violation).
4. **Structure**: no forced/padded contributions, genuinely distinct bodies of work, char caps respected, first person, no full citations / invented co-author names.

Sample set: `rgcryst` / `imh2003` / `gbm9002` (rich) + a **mid-career** scholar with only 2–3 real bodies of work (tests "write fewer than five") + a Personal Statement run with a sample project. **The spec's Crystal worked examples are the ground-truth reference** for what "significance ON, grounded" should read like. Gate: 0 entity violations, 0 superlatives, 0 external-uptake, every significance anchored, distinct/non-padded contributions, caps respected.

## 9. Public-bio purpose — document as the next instance (don't build now)

The critique's other purpose: same FACTS, **low** density — translate jargon to plain language, one idea per sentence, lead with the **human stake**, cap specialist terms (~2 flagship), suppress the methods list. Its structural gap mirrors §4: it needs a **grounded disease-stake / burden input** the base FACTS don't carry (publication synopses assume burden rather than state it), or the generator can't write the sentence that makes a stranger care. Build §0's scaffold so this drops in next.

## Gotchas (carry forward, all verified during the v4 ship)

- **Deploy split:** code → image via CD (push-to-master auto-deploy) or `gh workflow run deploy.yml --ref <branch> -f env=staging` (staging accepts any branch; the non-master guard is prod-only). Flags/env → **manual** `cd cdk && npx cdk deploy --exclusively Sps-App-staging -c env=staging --require-approval never` (reciter creds; `--require-approval never` needed for any IAM change). **`cdk diff` writes to STDERR** (`2>&1`). Migration runs in the deploy's `migrate` step. Master branch-protection `strict:false` (a behind-base branch still merges); required checks = `build` + `cdk`.
- **Worktree/local:** symlinked `node_modules` lacks `vis-network`/`vis-data` → 5 baseline `tsc` errors in `center-collaboration-tab.tsx` (ignore; CI's `npm ci` resolves them). Full `vitest` has **1 pre-existing** `edit-page` Radix-avatar mock-vs-version failure (symlink artifact; CI green). `npx jest app-stack -u` to refresh the CFN snapshot after any cdk change.
- **Local validation scripts:** large stdout is truncated by `process.exit()` → **write output to a file** (awaited `fs.writeFile`); in-VPC probes must **not** `import "dotenv/config"` (the container lacks it; `DATABASE_URL` comes from the task def).
- `DEFAULT_OVERVIEW_PARAMS.promptVersion` is **derived** (`defaultPromptVersionId()`) — don't hardcode. There is **no `amount`** field on `Grant`.

**End state:** PR for review (no merge/deploy unless asked); then the v4 staging recipe — cdk deploy (flag/migration/any IAM) *first*, then land the code — and re-validate against the re-tuned gate.
