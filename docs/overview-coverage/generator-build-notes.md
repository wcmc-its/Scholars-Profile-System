# Overview-statement generator — build notes (#742)

Companion to [`docs/overview-statement-generator-spec.md`](../overview-statement-generator-spec.md).
Records what shipped, the decisions taken, what is deliberately deferred, how to
run the gated validation, and the exact steps to enable in deployed environments.

## What was built

The **in-SPS, single-scholar interactive path** of #742 — the `/edit` Overview
panel's "✨ Generate a draft" / "↻ Regenerate" action:

- **`POST /api/edit/overview/generate`** — owner-only (`authorizeFieldEdit`,
  `fieldName: "overview"`), 404 when the flag is off (mirrors the slug-request
  route), rate-limited per scholar. Returns a sanitized HTML draft; performs
  **no DB write** (Save is the existing owner-gated `field_override` path).
- **`lib/edit/overview-facts.ts`** — `assembleOverviewFacts(cwid)` builds the
  facts contract (identity from ED, topics + rationale, representative
  publications with abstract excerpt / impact justification / synopsis, active
  grants, education, optional `existingBio` from the frozen VIVO seed).
  `hasSufficientFacts()` gates sparse profiles (SPEC G2 → 422).
- **`lib/edit/overview-generator.ts`** — the fixed `OVERVIEW_SYSTEM_PROMPT`
  (facts-only grounding rules verbatim from the SPEC), `buildOverviewUserPrompt`,
  and `generateOverviewDraft()` calling the AI Gateway via the `ai` SDK
  (`generateText`, no tools) and sanitizing the prose into `<p>` paragraphs with
  `sanitizeOverviewHtml`. Throws on gateway failure so the route maps it to 502.
- **`lib/edit/rate-limit.ts`** — `recordOverviewGenerateAttempt(cwid)`, keyed
  `ovgen:<cwid>` in the existing `request_change_rate_limit` table, sharing one
  private helper with `recordRequestChangeAttempt` (whose behavior is unchanged).
- **`scripts/edit/overview-validation.ts`** (`npm run edit:overview-validate`) —
  the operator-run **validation gate** below.

## Decisions taken

- **Third person.** Matches the existing VIVO seeds and Grad School bios (SPEC
  decision #1, recommendation accepted).
- **~120–180 words, 1–2 paragraphs, plain prose** (no headings/lists/markdown),
  under the existing 20k sanitizer cap. A shorter sparse draft is a pass, not a
  fail (SPEC decision #2 / acceptance "Length").
- **In-SPS only** for this build — the interactive, on-demand single-scholar
  path. Instant, server-side, with local bio enrichment, reusing the #594 AI
  Gateway client.
- **No `methods` field** in `OverviewFacts`. ReciterAI's per-publication `TOOL#`
  is not ingested into the SPS DynamoDB ETL (only `TOPIC#` is), so the in-SPS
  path has no grounded source for it (SPEC Open Question #10). Topics +
  representative-publication abstracts/justifications carry the specificity lever
  instead.
- **Generation never writes.** The draft returns to the editor as unsaved local
  state; the owner's existing Save publishes it. No new write surface, no
  auto-publish, ever.

## What is deferred (out of this build)

- **Bulk / admin staging** (the prominent-faculty seed, ~2,051 drafts). Needs the
  **staged-override marker** (SPEC § Bulk mode / Open Question #3 — a `status`
  flag, a distinct `source`, or a staging table) and **Resolution A**
  (admin generate + stage, owner publishes) wired through authz + the `/edit`
  "A suggested draft is ready" surface. None of that ships here.
- **The upstream / Bedrock execution site.** The recommended split (bulk-upstream
  via the ReciterAI harness + spotlight `lede_generator`, interactive in-SPS) is
  a separate workstream; this build is the in-SPS half only.
- **`methods` / `TOOL#` ETL.** Per Open Question #10, ingesting `TOOL#` (and
  `synopsis` more fully) into the SPS DynamoDB ETL is a prerequisite for a
  `methods` facts field; deferred until that ETL exists (the upstream path has
  them natively, an argument for generating bulk upstream).
- **Notification, provenance disclosure, refresh cadence** (Open Questions #5–7).

## How to run the validation gate

The SPEC requires generating 3–5 real overview statements from ReciterAI data and
grading them **before** the feature is enabled. Run:

```bash
# Dry run — assembles facts + renders the prompt for each sample case.
# NO gateway call, NO AI_GATEWAY_API_KEY required.
npm run edit:overview-validate -- --dry-run

# Live run — generates a draft per case (needs AI_GATEWAY_API_KEY in the env).
npm run edit:overview-validate

# Override the sample (e.g. supply a real sparse E_tail cwid for case 4):
npm run edit:overview-validate -- --cwids rgcryst,imh2003,gbm9002,<sparse-cwid>
```

Default sample (the SPEC's validation set): `rgcryst` (rich/leadership),
`imh2003` (computational), `gbm9002` (clinical/non-bench), plus a sparse-tail
placeholder — **replace the placeholder with a real `E_tail` gap cwid** via
`--cwids` so graceful degradation is exercised. Output is written to
`docs/overview-coverage/validation-run-results.md`: per scholar, the assembled
facts summary, the generated draft, its word count, and a blank acceptance table
(faithfulness / specificity / voice / length / currency / artifacts / overall)
for the operator to fill in.

**Pass bar:** ≥4 of 5 drafts judged "publishable with light edits," and **zero**
faithfulness violations across the entire set. Any faithfulness violation → fix
the prompt/grounding and re-run before enabling. The validation run makes ~5 LLM
calls and writes nothing to the database.

## How to ENABLE in deployed environments

The flag stays **OFF** until the validation run above passes (≥4/5 publishable, 0
faithfulness violations). Once it does, enable per-env in two steps:

1. **Wire `AI_GATEWAY_API_KEY` into the App ECS task** in `cdk` app-stack,
   per-env. Today the key is consumed only by the `seo:llm-rank` ETL script (#594),
   **not** by the Next.js server, so the App task does not yet have it. The
   interactive generate route runs in the Next server, so the key must reach that
   task definition (from Secrets Manager, never inline).
2. **Set `SELF_EDIT_OVERVIEW_GENERATE="on"`** in `cdk` app-stack, per-env. CD
   re-rolls the image but does not re-run `cdk deploy`, so this env change needs a
   manual `cdk deploy Sps-App-<env>` (audit `.env.local` vs app-stack per-env to
   avoid a local-on / deployed-off parity gap).

Optionally tune `OVERVIEW_GENERATE_MODEL`
(default `anthropic/claude-sonnet-4.5`), `OVERVIEW_GENERATE_TEMPERATURE`
(default `0.4`), and `SELF_EDIT_OVERVIEW_GENERATE_RATE_LIMIT` (default `10`/hour)
in the same per-env stack. See [`.env.example`](../../.env.example) for the full
variable list.
