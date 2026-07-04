# NIH Biosketch — follow-ups handoff (round 2)

Three enhancements requested after the **feedback round (PR #1187)** landed and the streaming generate
was confirmed working on staging. This doc is a **plan/spec, not yet implemented** — pick them up in a
future session. Each is independently shippable; suggested order and cross-cutting notes are at the end.

## Baseline (what's already in place)

Everything below is on `master` as of the #1187 merge (squash `57936277`), live on staging
(`EDIT_BIOSKETCH_GENERATE` on staging / off prod; `BIOSKETCH_PROMPT_VERSION_DEFAULT=v6`).

- **Streaming route** — `app/api/edit/biosketch/generate/route.ts` returns `editOkStream(...)`
  (`lib/edit/request.ts`): a 200 stream that flushes a `"\n"` whitespace heartbeat every 10s while
  `generateBiosketch` runs, then the final `{ ok, ... }` JSON. The client (`components/edit/biosketch-tool.tsx`,
  `generate()`) consumes it with a single `await res.json()` (whitespace-tolerant). A gateway failure is an
  in-body `{ ok:false, error }` (status stays 200).
- **Generator** — `lib/edit/biosketch-generator.ts` `generateBiosketch(facts, params, opts)`. Phases, in
  order: ① main draft (1 `generateText`, ~10s) → ② faithfulness pass (`Promise.all` over entries, ~2 calls
  each, parallel) → ③ products mapping (1 call) → ④ source attribution (1 call). Default model
  `us.anthropic.claude-opus-4-8` (~9.8s/call measured). `DEFAULT_BIOSKETCH_PARAMS.maxContributions` = the MAX,
  so a default draft is the worst case (~60-90s).
- **Result shape** — `BiosketchResult` (`biosketch-generator.ts:494`): `entries: string[]`, `products`,
  `sources`, `overflow`, `removed`. Parsed by `parseBiosketchEntries` (`:467` — splits on `N.`/`N)` markers
  or blank lines). Prompt + facts: `buildBiosketchUserPrompt` (`:391`), `resolveBiosketchPromptImpl` +
  `BIOSKETCH_SYSTEM_PROMPT_V6`, `toBiosketchModelFacts`.
- **UI** — controls `components/edit/biosketch-generate-controls.tsx`; result `biosketch-result-card.tsx`
  (renders `result.entries.map(...)` in an `<ol>`, "Download all (.txt)"); history panel + the
  `BiosketchGenerationItem` type live in `biosketch-tool.tsx`; read side `lib/edit/biosketch-provenance.ts`
  (`coerceEntries`); GET `app/api/edit/biosketch/generations/route.ts`.
- **Versioning** — `lib/edit/biosketch-prompt-versions.ts` (v5 baseline, v6 default; **v5/v6 prompts are
  byte-identity-pinned by tests** — any prompt change MUST be a NEW version id, never an edit to v5/v6).

---

## Follow-up A — generation progress bar + rough ETA (visually pleasing)

**Ask:** during the ~60-90s Bedrock fan-out, show a status indicator with a rough time estimate; make it
look good. (User accepts the ETA is approximate.)

**Approach — upgrade the stream from opaque heartbeats to structured progress events.** The streaming
plumbing already exists; today it only sends `"\n"`. Emit real phase events the client renders as a
*determinate-by-phase* progress bar (advances on actual events, not a fake timer — honest and reassuring).

1. **Protocol (server).** Switch the body to **newline-delimited JSON (NDJSON)**: each line is either
   `{"type":"progress","phase":"...","done":N,"total":M}` or the final `{"type":"result","ok":true,...}`
   (or `{"type":"result","ok":false,"error":"..."}`). Generalize `editOkStream` to accept an `onProgress`
   emitter it passes into `produce`, and to write the final payload as a `{"type":"result",...}` line.
   (Heartbeats are no longer needed — progress lines keep the connection warm; keep a fallback `"\n"` if a
   phase runs >10s, e.g. the long main draft.)
2. **Instrument the generator.** Thread an optional `onProgress?(ev)` callback through `generateBiosketch`
   and fire it at phase boundaries: `drafting` (before ① ) → `faithfulness` with `done/total` (resolve each
   `Promise.all` entry to increment) → `products` → `sources` → done. The per-entry faithfulness increment
   is the one that makes the bar feel alive.
3. **Client.** Replace the single `await res.json()` with an incremental reader
   (`res.body.getReader()` + `TextDecoder`, split on `\n`, `JSON.parse` each complete line). On `progress`
   update the bar; on `result` resolve as today (same `{ok}` branching). Keep a tolerant parser (ignore blank
   lines / a stray heartbeat).
4. **UI (the "pleasing" part).** A shadcn `Progress` bar with phase-weighted milestones, e.g. drafting 0→40%,
   faithfulness 40→75% (advance per contribution), products 75→88%, sources 88→100%; a rotating phase label
   ("Drafting your contributions…", "Fact-checking each line against your records…", "Selecting key
   publications…", "Linking source papers…"); an elapsed counter (`0:23`) and a soft hint ("usually
   60-90s"). Subtle shimmer/pulse on the active segment. Replace the current bare "Generating…" button state.

**ETA model:** don't promise a number. Derive a rough range from params
(`~ maxContributions × 12s + 25s`, clamped to a "60-90s" style band) shown as a hint; let the *bar* (driven
by real phase events) carry the actual sense of progress.

**Gotchas / risks:**
- The NDJSON switch is a **breaking change to the response body contract** — the route test and the client
  must move together (no more `res.json()`). Update `tests/unit/biosketch-generate-route.test.ts` (it already
  drains the stream; it'll now need to parse the final `result` line).
- Confirm CloudFront still streams NDJSON through (same pass-through that works today for heartbeats — it
  does, but re-verify after the change).
- Buffering: keep `cache-control: no-store, no-transform` + `x-accel-buffering: no`; flush per line.
- This is the largest of the three (protocol + generator instrumentation + client reader + UI).

---

## Follow-up B — superuser "view / download prompt & payload"

**Ask:** a button (superusers only) to download/expose the exact prompt and payload sent to Bedrock.

**Approach — a superuser-gated debug endpoint that assembles the same inputs WITHOUT calling Bedrock**
(cheap, inspectable before/independent of a real generation):

1. **New route** `app/api/edit/biosketch/debug-payload/route.ts` (POST, same body shape as generate:
   `{ entityId, params }`). Gate: flag `EDIT_BIOSKETCH_GENERATE` **and** `session.isSuperuser` only
   (NOT comms/proxy/unit-admin — prompts + raw FACTS are internal). Reuse `authorizeOverviewWrite` for the
   target, then hard-require `isSuperuser`.
2. **Build, don't call.** Assemble exactly what `generateBiosketch` would send: resolve the version
   (`resolveBiosketchPromptImpl(effectiveParams.promptVersion)`), build `systemPrompt`,
   `buildBiosketchUserPrompt(facts, effectiveParams, { groundsImpact })`, and the model-facts projection
   (`toBiosketchModelFacts`). Return `{ model, promptVersion, systemPrompt, userPrompt, facts }`. Do not
   invoke Bedrock. (For the aux calls — products/source-attribution — note they depend on the *generated*
   entries, so they can't be shown pre-generation; either omit them or expose the main draft prompt only.)
3. **UI.** In `biosketch-generate-controls.tsx` (or the result card), behind `canSeeCost`/`isSuperuser`, add
   a "View prompt & payload" button → fetch the endpoint → download as `.json` (and/or render in a Dialog
   with copy buttons). Thread an `isSuperuser`/`canDebug` prop from `edit-page.tsx` (it already computes
   `isSuperuserLike(mode)` for `canSeeCost`).

**Alternative:** include the prompt+payload in the *generate* response when superuser (so it reflects the
exact call just made, incl. aux prompts). Downside: bloats the streamed result and couples debug to a paid
generation. Recommend the standalone endpoint; add the aux prompts to it later if needed.

**Gotchas:** strictly superuser-gate (the FACTS payload is internal data); no caching (`no-store`); the
download filename should include the cwid + version for traceability.

---

## Follow-up C — per-contribution title / subject

**Ask:** have the LLM return a short title/subject for each contribution, *outside* the narrative, so the
reader can tell what each one is about at a glance. (This is also closer to the real NIH "Contributions to
Science" format, where each contribution has a heading.)

**Approach — a new prompt version (v7) that emits a titled structure, parsed into `{ title, body }`:**

1. **New prompt version v7** in `lib/edit/biosketch-prompt-versions.ts` (DO NOT edit v6 — it's byte-pinned).
   v7 = v6 + an instruction to prefix each contribution with a short (<= ~80 char) title on its own line,
   in a parseable form, e.g. `TITLE: <subject>` then a blank line then the narrative. Set v7 as the new
   default; add the cdk lever `BIOSKETCH_PROMPT_VERSION_DEFAULT=v7`. v6 stays selectable for A/B.
2. **Parser.** `parseBiosketchEntries` returns `{ title, body }[]` for v7 (extract the `TITLE:` line; fall
   back to `title: ""` if absent so a malformed entry still renders). Keep it tolerant.
3. **Types.** Introduce `BiosketchEntry = { title: string; body: string }` and change
   `BiosketchResult.entries` (and the cap/overflow logic, which currently measures `entry.length` — measure
   `body.length`) and the faithfulness pass (operate on `body`; the title is a short label — either exempt it
   or run a light grounding check; a fabricated *title* is low-risk but should still reflect the body).
4. **Persistence (no migration needed).** `biosketch_generation.entries` is a JSON column. Write
   `{title, body}[]`. **Backward-compat read:** `coerceEntries` in `biosketch-provenance.ts` (and the client
   `BiosketchGenerationItem`/`viewDraft` in `biosketch-tool.tsx`) must coerce an old `string[]` row to
   `[{ title: "", body: s }]`. The generations GET route maps entries through — verify it carries the new shape.
5. **Render + export.** `biosketch-result-card.tsx` renders the title as a heading above each `<li>`/body;
   the `.txt` export becomes `"<title>\n\n<body>"` per contribution; the history panel "View draft" shows
   titles too. Personal Statement mode is single-narrative → no title (keep `{ title: "", body }`).

**Gotchas:** the entry-shape change ripples through generator → parser → result type → result card → export →
history → provenance coercion → the generate-route test fixtures (`GEN_RESULT.entries`) and
`biosketch-generator.test.ts` (parser tests). Do it as one coherent change. Faithfulness char-cap now keys on
`body`. Because it's gated behind a new version id, v6 output is unaffected for reproducibility.

---

## Sequencing & cross-cutting

- **B is independent** — smallest, ship first if you want a quick win.
- **C changes the entry shape; A changes the response protocol.** They touch overlapping files
  (`biosketch-generator.ts`, the route, `biosketch-tool.tsx`, the route test). Do **C before A** (settle the
  data shape, then layer progress on top), or land them together. Avoid doing them in parallel branches that
  both rewrite the route.
- All three keep the feature gated (`EDIT_BIOSKETCH_GENERATE` staging-first); A/C touch the streamed
  contract → re-verify CloudFront pass-through on staging after each. C ships behind the new v7 default (cdk
  `BIOSKETCH_PROMPT_VERSION_DEFAULT`), so it can be rolled back without a deploy.
- Run the **adversarial diff-review workflow** before each PR (it caught a CI-only `tsc` break last round).

## Still-open operator items from round 1 (PR #1187)

- **Item 6 DB grant (not yet applied):** `GRANT SELECT ON \`scholars_audit\`.\`manual_edit_audit\` TO 'app_ro'@'%';`
  on staging + prod (DBA/master — the bootstrap role can't issue it). Until then `/edit/scholar/[cwid]/history`
  and `/edit/center/[code]/history` show the "unavailable" notice (no 500). Then a small follow-up PR codifies
  it in `scripts/verify-db-grants.ts` (app-ro golden) + `scripts/sql/audit-log.sql`, sequenced grant-first so
  the verify-grants gate doesn't red.
- Prod rollout of the whole biosketch feature stays gated.
