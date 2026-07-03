# Handoff — Overview generator: Opus 4.8 default + 4 follow-ups

**For:** the next session/engineer. **Base:** fresh `origin/master` (prompt versioning shipped in
**PR #1156**, squash `d2927dad`, merged + staging-deployed 2026-06-20; CI green; v3 validation passed
3/3). All file paths below are on `origin/master` — re-ground before editing.

**Setup:** Dropbox repo → use a worktree off fresh `origin/master`; symlink BOTH `node_modules` and
`cdk/node_modules` from the canonical checkout, copy `.env*`, run `npx prisma generate`. (The current
session left a worktree at `~/worktrees/sps-overview-prompt-versioning` with reusable scratch probes
`scripts/_overview-*.ts` — untracked, not in the PR.)

---

## 1. Default model → Opus 4.8

Change the generator default from Sonnet 4.5 to Opus 4.8.

- **`lib/edit/overview-generator.ts`** — `DEFAULT_MODEL` (~line 40): set to
  `"us.anthropic.claude-opus-4-8"` (confirmed present as an inference profile in the account,
  us-east-1; no date suffix).
- **⚠️ BLOCKER — `temperature` 400s on Opus 4.7/4.8 (and Fable 5).** The generator passes
  `temperature` to `generateText` in `generateOverviewDraft` (and `temperature: 0` / `0.2` in
  `verifyDraftGrounding` / `reviseDraftForGrounding`). Opus 4.7/4.8 **reject** `temperature` /
  `top_p` / `top_k` with a 400 — switching the model without removing it will fail **every**
  generation. Add a guard `modelAcceptsTemperature(modelId)` (returns false for
  `/claude-(opus-4-[78]|fable)/`) and only include `temperature` in the `generateText` params when
  true. Apply it at all three call sites. (Opus ≤4.6 and Sonnet/Haiku still accept it.) Leave
  `thinking` omitted (off by default on 4.7/4.8 — fine for this short grounded writing task).
- **IAM widen — `cdk/lib/app-stack.ts`** `TaskRoleBedrockPolicy` (~lines 690–699). Today it scopes
  `bedrock:InvokeModel` to `claude-sonnet-4-*` only. Add the Opus 4.8 ARNs, mirroring the existing
  two-line Sonnet pattern:
  - `arn:aws:bedrock:*:${this.account}:inference-profile/us.anthropic.claude-opus-4-8`
  - `arn:aws:bedrock:*::foundation-model/anthropic.claude-opus-4-8*`
  Then refresh the CFN snapshot: `cd cdk && npx jest app-stack -u`.
- **Cost** (measured this session): ~**3–4¢/draft** at Opus rates ($5/$25 per 1M) on the real call
  profile (~5,000 input + ~300 output tokens; rgcryst rich-case ~5,700 in). vs ~2¢ on Sonnet. Bulk
  512-faculty seed ≈ $18. Bedrock list price ≈ Anthropic API price.
- **Deploy:** staging model+IAM = `cdk deploy --exclusively Sps-App-staging` (the `reciter` creds can
  do staging App deploys; **not** ETL/prod) + the image roll (CD on merge carries the code). Prod is
  a gated deploy.
- **Re-validate** (model change) — run the §6 gate with Opus 4.8 before any prod flip.

## 2. Version dropdown: "superuser / curator only" callout

- **`components/edit/overview-generate-controls.tsx`** — the version-selector `<fieldset>`
  (`showVersionSelector` block; `data-testid="overview-prompt-version-field"`). Add a small muted
  callout under the legend, e.g. *"Visible to superusers and curators only"* (a `<span class="text-muted-foreground text-xs">`, optionally with a lock/info icon). It already only renders when
  `canSelectPromptVersion` — this just makes the gating explicit to the privileged viewer.

## 3. Display projected cost to superuser

- **`lib/edit/overview-prompt-versions.ts`** (client-safe) — add a per-model price map + a pure
  `estimateDraftCostUsd(modelId)` using a representative profile (~5,000 input + ~300 output) and the
  `claude-api` reference rates ($/1M): Opus $5/$25, Sonnet $3/$15, Haiku $1/$5, Fable $10/$50. Return
  a rounded `$` per draft. Match the model family with the same humanizer pattern as `humanizeModelId`.
- **`overview-generate-controls.tsx`** — under the existing model line, render
  *"~$0.03 per draft (estimate)"* for the selected version's effective model (superuser/curator
  surface only — same gate). If `OVERVIEW_FAITHFULNESS_PASS` is on, note it's ~3× (the pass adds
  verify→revise→re-verify calls). Code comment: estimate only; Bedrock ≈ list price.

## 4. Sort funding descending by importance (intelligent heuristic)

Today funding is ordered by lead-role then end-date. Goal: rank by *importance* so the bio (and the
source-drawer default) leads with the marquee grants — e.g. an **NHLBI R01 > a one-off biopharma MSA**.

- **New pure, unit-tested scorer** `lib/edit/funding-importance.ts` →
  `scoreFundingImportance(grant): number`. Deterministic tiers:
  1. **Federal research (highest)** — NIH / NSF / DOD / AHRQ / CDC etc. Detect via `funderLabel`
     (NIH institute names like "National Heart, Lung, & Blood Institute") **and/or** parse the NIH
     `awardNumber` for activity code + institute (e.g. `5R01HL123456-03` → `R01` + `HL`=NHLBI).
     Weight the activity code: `P01`/`U01`/`R01`/`R37`/`DP*`/`UM1` (research/program) >
     center/cooperative > `K`/`T`/`F` (career/training) > other.
  2. **Major foundations (mid)** — AHA, Gates, CZI, Doris Duke, LLS, etc.
  3. **Industry / contract (lowest)** — funder is a company (`Inc`/`LLC`/`Therapeutics`/`Bio`/
     `Pharma`/`Biopharma`) **or** title matches `MSA between…` / `Agreement` / `contract`.
  Tie-break within a tier by: role (PI > MPI > PI-Subaward > co-I), award amount (if available), then
  recency.
- **Apply in `lib/edit/overview-facts.ts` `loadActiveFunding`** — score on the **raw grant row**
  (where `awardNumber`, amount, agency, role, title are available, before projecting to
  `OverviewFacts.activeGrants`) and order desc. Carry that order into the source-options funding
  default/featured order so the drawer matches. Sort the candidate pool **before** applying the
  led/all + pin/exclude deltas so user pins still win.
- **First inspect the Grant/funding schema** (`prisma/schema.prisma` + `loadActiveFunding`) for the
  real field names — confirmed-present in the facts projection: `title`, `funderLabel`, `role`;
  `awardNumber` / amount live on the underlying row (see `project_nih_profile_pool` — NIH RePORTER
  provides agency/activity/amount). Don't invent field names.
- Additive reorder; no flag strictly required (gate it if you want to A/B). Unit-test with an
  NHLBI-R01 fixture ranking above a biopharma-MSA fixture.

## 5. Prompt: better trend / theme / pattern illumination

Add a directive to the synthesis section, e.g.:
> *"Illuminate the larger trends, themes, and patterns that connect the work — name the throughline
> that unifies the research program, not just its individual parts."*

This extends v3's existing "you may synthesize / connect into threads" thesis. **Decision (use the
versioning infra you just built):** register it as a **new version `v4`** (= v3 + this directive),
make `v4` the default, keep `v3`/`v2` selectable so you can A/B whether pattern-illumination measurably
improves the bios. Alternative: edit v3 in place if you'd rather not add a version. If `v4`:
- `lib/edit/overview-prompt-versions.ts` — add the `v4` meta (label/description/status:"default",
  `elementLabels` + `permitsSynopsisFindings: true` reused from v3); flip
  `OVERVIEW_DEFAULT_PROMPT_VERSION` → `"v4"`; demote v3 to `"deprecated"`/`"experimental"`.
- `lib/edit/overview-generator.ts` — add `OVERVIEW_SYSTEM_PROMPT_V4` (v3 text + the new directive) +
  the `v4` entry in `OVERVIEW_PROMPT_IMPLS` (reuse `V3_LENGTH_BANDS`).
- `cdk/lib/app-stack.ts` — `OVERVIEW_PROMPT_VERSION_DEFAULT: "v4"` (the rollback lever).
- Update the version tests (`overview-generator.test.ts`, `overview-prompt-versions.test.ts`).

## 6. Validation gate recipe (re-run for the new model + prompt)

Because both the model (Opus 4.8) and the prompt (v4) change, re-run the §9 gate the way this session
did — generate with the **new** code against **real staging facts**, then adversarially audit:
1. **Pull staging facts:** `scripts/run-staging-probe.sh <probe.ts> staging`, where the probe calls
   `assembleOverviewFacts` for the gate cwids (`rgcryst`, `imh2003`, `gbm9002`) **plus a real
   sparse-tail cwid** (skipped last time — find one with thin signal). `assembleOverviewFacts` is
   unchanged data-assembly, so the deployed image is fine for the pull.
2. **Generate locally via Bedrock** with Opus 4.8 + v4 — **omit `temperature`** (§1 blocker).
3. **Adversarial audit:** 2 independent skeptics per draft vs the grounding reference (a small
   `Workflow`); gate = **0 faithfulness violations, ≥4/5 publishable**. Confirm Opus's richer
   synthesis didn't reopen entity leaks.

## Gotchas recap
- **`temperature` 400 on Opus 4.7/4.8 — the #1 trap.** Guard it before switching the model.
- IAM is Sonnet-only today; Opus needs the ARN widen + `jest app-stack -u` snapshot refresh.
- `reciter` creds: `cdk deploy` staging App/Edge OK; ETL + prod are gated.
- Bedrock list price ≈ Anthropic API price (rates from the `claude-api` skill, cached 2026-06-04).
- Worktree: symlink `node_modules` **and** `cdk/node_modules`; `npx prisma generate`; copy `.env*`;
  Turbopack rejects symlinked node_modules → use `npx next dev` (webpack) if you run the dev server.
- Pre-existing full-suite failure: `edit-page.test.tsx` Radix-avatar `FakeImage`/`currentTarget`
  drift — NOT yours; CI's `npm ci` passes it.
