# Overview generator → biosketch parity plan

Bring four proven biosketch-generator capabilities to the profile **overview** generator.
All references grounded in `origin/master` (`bb7b13f4`); the working branch is ~248 commits
behind, so re-verify exact line numbers at implementation time via
`git show origin/master:<path>`.

## Scope (approved — go-ahead given)

1. **Streaming status bar** — determinate progress bar with phase labels + elapsed time.
2. **Download prompt/payload** — superuser-only debug endpoint + download button.
3. **Persist failed runs too** — record every attempt, not just successful ones.
4. **Impersonation audit parity** — record the real actor on saved runs.
5. **Audience selector** — let the editor choose who the overview is written for, and
   make the default less technical. Doubles as the fix for "outputs are overly technical"
   (calibrate against the `rak2007` / `thc2015` overviews, cited as good, plain-language examples).

## Current state (origin/master)

| Concern | Biosketch | Overview |
|---|---|---|
| Generate route | `app/api/edit/biosketch/generate/route.ts` → `editOkStream` (NDJSON) | `app/api/edit/overview/generate/route.ts` → `editOk` (buffered JSON) |
| Generator fn | `generateBiosketch(facts, params, {onProgress})` | `generateOverviewDraft(facts, params)` — no `onProgress` |
| Client | `components/edit/biosketch-tool.tsx` + `<BiosketchProgress>` | `components/edit/overview-card.tsx` — spinner text only |
| Stream reader | `lib/edit/biosketch-stream.ts` (`readBiosketchStream`) | none |
| Debug payload | `app/api/edit/biosketch/debug-payload/route.ts` (superuser) | none |
| Persistence | `BiosketchGeneration` (schema ~1921), success-only | `OverviewGeneration` (schema ~1890), success-only |
| History/restore | `/api/edit/biosketch/generations` + history panel | `/api/edit/overview/generations` + `OverviewVersionsPanel` ✅ |
| Audit actor | `createdByCwid` (real) + `impersonatedCwid` | `createdByCwid: session.cwid` only |
| Flag | `EDIT_BIOSKETCH_GENERATE` (staging-on/prod-off) | `SELF_EDIT_OVERVIEW_GENERATE` (**on both envs**) |

Reusable substrate (not biosketch-specific): `editOkStream()` in `lib/edit/request.ts`
emits `{"type":"progress",…}` NDJSON lines + 10s heartbeats and always returns 200 with
errors in-body (headers `application/x-ndjson`, `no-store, no-transform`, `x-accel-buffering: no`).

---

## Item 1 — Streaming status bar

**Server**
- Add an `onProgress?: (e: OverviewProgress) => void` param to `generateOverviewDraft()`
  in `lib/edit/overview-generator.ts`. Define `OverviewProgress` to match the function's
  real internal stages. At minimum:
  `{ phase: "drafting" } → { phase: "faithfulness"; done; total } → { phase: "done" }`.
  Verify the faithfulness pass's actual granularity when implementing — if it iterates
  per-claim, emit `done/total` like biosketch; if it's a single call, emit a bare phase.
- In the generate route, swap `editOk(...)` for `editOkStream(async (emit) => { … emit(event) … return {draft, model, promptVersion, generationId} }, onError)`.
  Keep all pre-flight validation (auth, flag, rate-limit, entity checks) as buffered JSON
  *before* the stream opens — biosketch does the same.

**Client**
- Add `lib/edit/overview-stream.ts` (`readOverviewStream`) — a thin reader modeled on
  `readBiosketchStream` (`getReader()` + `TextDecoder`, split on `\n`, tolerate blanks).
  Confirm whether `readBiosketchStream` can be generalized/shared rather than copied.
- Add `components/edit/overview-progress.tsx` (`<OverviewProgress>`) modeled on
  `<BiosketchProgress>`: phase→percent map, label copy ("Drafting your overview…",
  "Fact-checking each line…"), elapsed timer.
- Update `generate()` in `overview-card.tsx` to consume the stream instead of
  `await res.json()`, drive progress state, and apply the terminal `result` line.

**Rollout flag (important — overview is already prod-ON):** gate the streaming response
behind a sub-flag `SELF_EDIT_OVERVIEW_GENERATE_STREAM` (staging-on / prod-off), mirroring
the house staging-first pattern. Route branches `editOkStream` vs existing `editOk`; the
flag value is surfaced to the client so it picks the matching reader. This gives a
rollback lever and lets us verify on staging before flipping prod. (Biosketch needed no
such sub-flag because its whole feature is prod-off.)

**Bonus benefit:** streaming + heartbeats also protect long Opus-4.8 drafts from
CloudFront/ALB idle-timeouts on the current buffered response.

---

## Item 2 — Download prompt/payload (superuser)

**Server** — add `app/api/edit/overview/debug-payload/route.ts`, a near-copy of the
biosketch route:
- Gates in order: `SELF_EDIT_OVERVIEW_GENERATE` on → session → `authorizeOverviewWrite()`
  → hard `session.isSuperuser`.
- Read-only: assemble and return `{ target, model, promptVersion, systemPrompt, userPrompt, facts }`
  using the existing prompt assembly + `toModelFacts()` in `overview-generator.ts`.
  **No** Bedrock call, **no** DB write, **no** rate-limit consumption. Header `cache-control: no-store`.
- `facts` uses the same public `toModelFacts()` projection the real generate uses (overview
  withholds `facultyMetrics`/`impact`/`impactJustification` — preserve that).

**Client** — add a "View prompt & payload" button in `overview-card.tsx` (mirror
`downloadDebugPayload` in `biosketch-tool.tsx`): POST `{entityId, params}`, download the
JSON as a blob `overview-prompt-{cwid}-{version}.json`. Gate visibility with a `canDebug`
prop wired from `edit-page.tsx` as `mode === "superuser" || (mode === "self" && isSuperuser)`.

No new flag — rides `SELF_EDIT_OVERVIEW_GENERATE` and the superuser gate; safe to ship on.

---

## Item 3 — Persist failed runs too

Today both generators write the history row only after the model succeeds. Add failure
persistence to overview.

**Schema** (`prisma/schema.prisma`, `OverviewGeneration`):
- `status String @default("succeeded")` — `"succeeded" | "failed"`.
- `error String? @db.Text` — error code/message for failed rows.
- Make `text` nullable (or store `""` on failure) — verify current nullability first.
- Migration must be backward-compatible (existing rows default to `succeeded`).

**Route** — write a best-effort row in **both** the success path (existing) and the
`catch` path (new), so every attempt is recorded. Failures store `status:"failed"`,
`error`, and whatever partial context exists (params, model, promptVersion, actor).

**History UI stays success-only.** `listOverviewGenerations` / the `OverviewVersionsPanel`
restore list should filter `status = "succeeded"` so failed attempts don't clutter the
user's restore options — failures are for audit/debugging only.
→ **Confirm:** is failure-persistence purely for audit (my assumption), or do you also
want failed attempts visible somewhere in the UI (e.g. a superuser-only view)?

---

## Item 4 — Impersonation audit parity

**Schema** — add `impersonatedCwid String? @db.VarChar(32)` to `OverviewGeneration`.

**Route** — mirror biosketch: set `createdByCwid` = real signed-in actor and
`impersonatedCwid` = the "view as" overlay target (null when not impersonating). Reuse the
same `realCwid` / `impersonatedCwid` derivation biosketch uses in its generate route.

---

## Item 5 — Audience selector + less-technical default

Motivation: current overviews read as overly technical. `rak2007` / `thc2015` are the
target tone (plain-language, accessible). Add audience as a first-class steering dimension
*and* tune the default toward the less-technical end.

**Param** — add `audience` to the overview params (the `params` column is already JSON, so
**no migration needed**). Proposed enum (to confirm tone against the two examples):
- `general` — non-specialist / educated layperson (**default**): plain language, minimal
  jargon, define or avoid field terms.
- `peers` — researchers in/near the field: precise terminology permitted.
- `patients` — patients & families (clinical scholars): accessible, reassuring, concrete.

**Prompt** — in `lib/edit/overview-generator.ts`, add an audience-specific instruction
block to the assembled user prompt (alongside the existing voice/tone + emphasis
directives). The `general` block carries explicit "avoid jargon / explain terms / short
sentences" guidance. Keep it prompt-version-aware (applies to v3/v4). Re-baseline the
default tone toward `general` so the un-touched output is already less technical.

**Validation against examples** — before finalizing the prompt copy, read the actual
`rak2007` and `thc2015` overviews and a known over-technical one, and tune the `general`
block until a regenerate approximates the good examples. (Method for viewing them TBD —
public profile render vs. DB read — decided at implementation.)

**Client** — add an audience control (segmented/select) to `overview-card.tsx`, persisted
in params like the other steering controls; surfaced in the debug payload and history.

**Tests** — params round-trip (default `general`), prompt contains the audience block,
debug payload reflects the selected audience.

> Open (low-stakes, will default and let you refine on staging): exact audience list and
> labels, and whether `general` or `peers` is the default for clinical vs. basic-science
> scholars.

## Migration / deploy ordering

- Items 3 & 4 add columns → run the DB migration (`Sps-Data` / migrate step) **before**
  rolling the app image, so the new code never writes columns that don't exist yet
  (same ordering caution as the biosketch `app_ro` grant work).
- Item 1's `SELF_EDIT_OVERVIEW_GENERATE_STREAM` env var is added in
  `cdk/lib/app-stack.ts` (`env === "staging" ? "on" : "off"`) and flipped via
  `cdk deploy Sps-App-*`.

## Testing (mirror biosketch)

- `lib/edit/request.ts` streaming contract already covered by `tests/unit/edit-ok-stream.test.ts`.
- New: overview stream-reader test (chunk reassembly, junk tolerance, missing-result fallback).
- New: overview debug-payload route test — 404 flag-off, 401 no-session, 403 non-superuser,
  200 shape, **no** model call, **no** DB write.
- New: persistence test — failed run writes `status:"failed"` and is **excluded** from the
  history list; success path unchanged; both writes best-effort.
- Update overview generate-route test for the streamed content-type when the sub-flag is on.

## Risks / notes

- **Faithfulness-pass granularity** drives how meaningful the bar is; confirm internal
  stages of `generateOverviewDraft` before finalizing phase events. Worst case the bar is
  coarse (drafting → checking → done) but the elapsed timer + labels still help.
- **Prod-on endpoint:** the streaming sub-flag is the safety lever; keep the buffered path
  intact until prod flip.
- Consider generalizing `readBiosketchStream` into one shared reader rather than two copies.

## Out of scope

Rate-limiting (`ovgen:` already at parity), prompt versioning, and the faithfulness pass
itself — all already present in overview.
