# Overview generator — prompt versioning + v3 prompt

**Status:** DRAFT — awaiting approval before implementation.
**Author / date:** Paul Albert, 2026-06-19.
**Tracker:** #742 (overview generator). Sits on top of the merged Phase-1/2 selection work.
**Source idea doc:** `~/Downloads/overview-generator-prompt-v3a.md` (the v3 "keyword-rich narrative" prompt + the scope/aspect/content control taxonomy).

> Branch-drift note: this branch (`docs/spotlight-pipeline`) is ~206 commits behind `origin/master`.
> All file/line references below were re-grounded via `git show origin/master:<path>`. Implementation
> must happen on a fresh worktree off `origin/master`, NOT this branch.

---

## 1. Goal

1. Make the overview-generator **prompt a versioned, swappable bundle** so we can iterate and A/B
   test prompts without a hard cutover.
2. Register the **v3 keyword-rich narrative prompt** (from the v3a doc) as a version and make it the
   **new default**, with the current prompt kept as a selectable fallback (`v2`).
3. **Expose the version selector to superuser + curator** (not faculty owners), so privileged actors
   can choose which prompt generates and compare them.
4. **Show the model** that will run alongside the version, and **persist both the prompt version and
   the model in the DB** as queryable columns for future analysis.

### Decisions already ratified (this session)

| # | Decision | Choice |
|---|----------|--------|
| D-A | Testing UX | **Selector only** — a version dropdown in the generate controls; generate one at a time; compare via history. No side-by-side compare (can add later). |
| D-B | v3 rollout posture | **Promote v3 to default** for all generations; keep `v2` selectable as fallback by superuser/curator. |
| D-C | What a version bundles | **Full bundle** — system prompt + user-turn directive wording + word bands + theme set/labels. Theme **keys stay stable** (stored params don't break); only labels/wording/bands are version-scoped. |
| D-D | Model | Version **lists the effective model**; a version MAY optionally pin a model, else falls back to env/default. **Persist prompt version + model as DB columns** for analysis. |
| D-E | Curator exposure | **Widen the generator to curators** (Option 2). Unit-admins/curators get the generator UI; the version selector shows for superuser + curator. Faculty owners get default v3 with no selector. |

---

## 2. Current architecture (grounded against origin/master)

| Concern | Location |
|---|---|
| System prompt (fixed) | `lib/edit/overview-generator.ts` → `OVERVIEW_SYSTEM_PROMPT` (line 62) |
| User-turn builder | `lib/edit/overview-generator.ts` → `buildOverviewUserPrompt(facts, params)` (line 230) |
| Voice/tone/length directives | `lib/edit/overview-generator.ts` (`voiceDirective`/`toneDirective`/`lengthDirective`) — **word bands live in `lengthDirective`** |
| FACTS projection | `lib/edit/overview-generator.ts` → `toModelFacts(facts)` (line 203) |
| Generation call | `lib/edit/overview-generator.ts` → `generateOverviewDraft(facts, params, opts?)` (line 370). `opts` already has `{ model?, temperature?, faithfulnessPass? }`. Hardcodes `system: OVERVIEW_SYSTEM_PROMPT` + `buildOverviewUserPrompt(...)`. |
| Default model | `DEFAULT_MODEL = "us.anthropic.claude-sonnet-4-5-20250929-v1:0"` (line 40); env override `OVERVIEW_GENERATE_MODEL`. IAM scopes Bedrock to `claude-sonnet-4-*`. |
| Steering params type + normalizer + themes | `lib/edit/overview-params.ts` → `OverviewParams` (line 38), `OVERVIEW_ELEMENTS` (line 49), `DEFAULT_OVERVIEW_PARAMS` (line 72), `normalizeOverviewParams` (line 107) |
| Generate route | `app/api/edit/overview/generate/route.ts` — normalizes params, authorizes via `authorizeOverviewWrite`, assembles facts, calls `generateOverviewDraft`, writes an `OverviewGeneration` history row (`{ ...params, selection }` into the `params` Json column). |
| History row (Prisma) | `prisma/schema.prisma` → `model OverviewGeneration` (line 1717): columns `model`, `params Json`, `createdByCwid`, `createdAt`. **No `promptVersion` column today.** |
| Generate-controls UI | `components/edit/overview-generate-controls.tsx` (voice/tone/length pills, element checkboxes from `OVERVIEW_ELEMENTS`, instructions textarea) |
| Card / wiring | `components/edit/overview-card.tsx` holds params + Generate; `components/edit/edit-page.tsx:599` renders `<OverviewCard … generateEnabled={(mode === "self" || isSuperuserLike(mode)) && isOverviewGenerateEnabled()} />` |
| History panel | `components/edit/overview-versions-panel.tsx` + `app/api/edit/overview/generations/route.ts` (`listOverviewGenerations`) |

---

## 3. The versioning model

### 3.1 `OverviewPromptVersion` type + registry

New file `lib/edit/overview-prompt-versions.ts`:

```ts
export type OverviewPromptVersionId = "v2" | "v3"; // extend as we add versions

export type OverviewPromptVersion = {
  id: OverviewPromptVersionId;
  /** Short label for the selector, e.g. "v3 — keyword-rich narrative". */
  label: string;
  /** One-line description shown to superuser/curator under the selector. */
  description: string;
  status: "default" | "experimental" | "deprecated";
  /** The grounding/anti-hallucination system prompt for this version. */
  systemPrompt: string;
  /** Build the user turn (voice/tone/length/themes directives + sparse guards + FACTS). */
  buildUserPrompt: (facts: OverviewFacts, params: OverviewParams) => string;
  /** Optional model pin (else env OVERVIEW_GENERATE_MODEL → DEFAULT_MODEL). */
  model?: string;
  /** Version-scoped theme labels (keys unchanged). Falls back to OVERVIEW_ELEMENTS. */
  elementLabels?: Partial<Record<OverviewElement, string>>;
};

export const OVERVIEW_PROMPT_VERSIONS: Record<OverviewPromptVersionId, OverviewPromptVersion>;

/** Registry default. Overridable per-env without a redeploy via OVERVIEW_PROMPT_VERSION_DEFAULT. */
export function defaultPromptVersionId(): OverviewPromptVersionId; // → "v3"
export function resolvePromptVersion(id?: string | null): OverviewPromptVersion; // unknown → default
export function listSelectablePromptVersions(): OverviewPromptVersion[]; // for the UI
```

- **`v2`** = the *current* `OVERVIEW_SYSTEM_PROMPT` + current `buildOverviewUserPrompt` + current word
  bands + current theme labels, moved verbatim into the registry (status `deprecated` once v3 is
  default, but kept selectable as the fallback baseline for A/B).
- **`v3`** = the keyword-rich narrative bundle (see §4). Status `default`.
- **Default = v3** (D-B), with `OVERVIEW_PROMPT_VERSION_DEFAULT` env as a **no-redeploy rollback**
  lever: set it to `v2` to revert the live default instantly (consistent with the project's flag
  discipline). Falls back to the registry's declared default (`v3`) when unset/invalid.

### 3.2 `promptVersion` becomes a first-class steering param

In `lib/edit/overview-params.ts`:

- Add `promptVersion: OverviewPromptVersionId` to `OverviewParams`.
- `DEFAULT_OVERVIEW_PARAMS.promptVersion = defaultPromptVersionId()`.
- `normalizeOverviewParams` validates `promptVersion` against the registry, unknown → default.
  (Trust boundary preserved — a garbage value yields the default, never a 400.)

Why a param (not just `opts`): it rides through the existing `{ ...params, selection }` history blob
so **"Regenerate from these settings" restores the version** too, and the UI reads it back from
history naturally. The **queryable analysis** home is still a dedicated column (§5) — same split the
codebase already uses for `model` (its own column even though it could live in `params`).

### 3.3 `generateOverviewDraft` resolves the version

```ts
// opts.promptVersion (test override) ?? params.promptVersion ?? default
const version = resolvePromptVersion(opts?.promptVersion ?? params.promptVersion);
const modelId = opts?.model ?? version.model ?? process.env.OVERVIEW_GENERATE_MODEL ?? DEFAULT_MODEL;
const result = await generateText({
  model: overviewBedrock()(modelId),
  system: version.systemPrompt,
  prompt: version.buildUserPrompt(facts, params),
  temperature,
});
```

The faithfulness pass (`OVERVIEW_FAITHFULNESS_PASS`, verify→revise) is **version-aware where the floor
differs**: its grounding reference is derived from FACTS, but a version's floor can change what counts
as grounded. v3 permits a quantitative finding stated in a publication `synopsis`, so the pass takes a
`permitSynopsisFindings` flag (from `versionPermitsSynopsisFindings(version)`) that relaxes the
ALLOWED-NUMBERS rule in `buildGroundingReference` and the verifier's `number` category
(`overviewVerifySystemPrompt`) — it must NOT strip a synopsis number v3 legitimately allowed. Without
this, enabling the (off-by-default) pass with v3 default would silently revert v3's number loosening.
Bibliometrics stay forbidden for every version. `generateOverviewDraft` already returns `model`; it
will **also return `promptVersion`** so the route can persist it.

---

## 4. The v3 prompt (port of the v3a doc)

v3 carries the full bundle from `~/Downloads/overview-generator-prompt-v3a.md`:

1. **System prompt** = the doc's `SYSTEM PROMPT` block — the core shift: *don't invent entities*
   (kept absolute, the ENTITY-PROVENANCE hard floor) vs *don't synthesize* (removed; synthesis of
   true relationships between grounded entities is now explicitly the job). Keyword-rich load-bearing
   prose, not comma-spliced term lists.
2. **Word bands raised** (in v3's `lengthDirective`): research-active **180–240**, standard
   **140–180**, sparse tiers keep the lower bands. (v2 keeps the existing 120–160 bands.)
3. **Theme rename**: `key_findings` label "Key findings & significance" → **"Findings & their
   implications"** via v3's `elementLabels` — scientific implication, not prestige (the one axis the
   floor bans). **Key stays `key_findings`** ⇒ stored selections survive (D-C).
4. **Keywords line**: NOT emitted in v3 (it's optional in the doc, gated by a consumer/purpose
   selector we are not building now). Can register a `v3.1` with the keywords line later.

**Porting fidelity check (must do at impl time):** the v3a system prompt references FACTS fields by
name (`methods` `name`/`examples`/`exemplarContexts`, publication `title`/`synopsis`/`topicRationale`,
`activeGrants` `title`, `publicationCount`, `yearsActive`). These must be reconciled against the
**actual `OverviewFacts` shape + `toModelFacts` output** (e.g. funding may be named `funding` not
`activeGrants`) so the grounding rules cite fields that really exist in the projection. The FACTS
projection itself is **unchanged and shared** across versions.

---

## 5. Persistence for analysis (D-D)

Add a column to `OverviewGeneration` (migration required):

```prisma
model OverviewGeneration {
  ...
  model         String   @db.VarChar(64)
  promptVersion String?  @map("prompt_version") @db.VarChar(32) // NEW — queryable for A/B analysis
  ...
  @@index([promptVersion, createdAt(sort: Desc)]) // NEW — "all v3 drafts, newest first"
}
```

- Route persists `promptVersion: result.promptVersion` on the create. `model` already persisted.
- Nullable + backfill-free: existing rows stay `NULL` (pre-versioning). New rows always set it.
- `listOverviewGenerations` returns `promptVersion` so the **history label** reads e.g.
  *"Generated with v3 · Claude Sonnet 4.5 · 2m ago"* and "Regenerate from these settings" restores it.
- Future analysis: `GROUP BY prompt_version, model` joined to overview-provenance edit-origin
  (`generated` vs `generated_edited`) to measure which version produces drafts that survive editing.

Migration is additive (new nullable column + index) — no data migration, deploy-gated like the rest
of the overview phases.

---

## 6. Exposure: who sees the selector (D-E — RESOLVED: widen to curators)

The version selector renders **only for actors who may pick a version**; faculty owners always get the
default (v3) with no selector. The route enforces this server-side regardless of UI.

**Server enforcement (always):** in the generate route, after normalizing params, compute
`canSelectPromptVersion = isSuperuser(session) || authz.viaUnitAdminUnit !== null` (superuser OR
unit-admin/curator — both already available: superuser from session, `viaUnitAdminUnit` is already
returned by `authorizeOverviewWrite`). If `!canSelectPromptVersion` and `params.promptVersion !==
default`, **force the default** (defense against hand-crafted requests; a normal owner's UI never
sends a non-default).

**UI exposure — the governance fork:** today `edit-page.tsx:609` only offers the generator to
`mode === "self" || isSuperuserLike(mode)`, with an explicit comment that it is *"NOT widened to
proxy / unit-admin — that's a separate governance call."* So **curators don't see the generator UI at
all yet.** Two options:

- **Option 1 — selector for superuser now; curator deferred.** Add the version selector to the
  existing superuser generate surface. Curators keep no generator UI (status quo). Smallest change;
  honors the existing governance posture; the "curator" half of the ask waits for a separate decision
  to widen the generator to unit-admins.
- **Option 2 — widen the generator to curators + selector for both.** Change `generateEnabled` (and
  the relevant rail `modes`) so unit-admins/curators get the generator, then show the selector to
  superuser + curator. Fully satisfies "expose to superuser and curator," but makes the governance
  call the code deliberately deferred (curators can now generate bios, not just hand-edit them).

**RESOLVED: Option 2.** Widen the generator to curators. Change `generateEnabled` (and the relevant
rail `modes`) in `edit-page.tsx` so unit-admins/curators get the generator surface; show the version
selector to superuser + curator. Curators can now generate bios (the route already authorizes them
via `authorizeOverviewWrite`'s unit-admin leg; this turns on the UI). Update the deliberate
"NOT widened to proxy / unit-admin" comment to reflect the new governance decision. Proxy editors:
keep status quo unless you say otherwise (the ask named curators, not proxies).

---

## 7. UI changes

`components/edit/overview-generate-controls.tsx`:
- New **Prompt version** select, rendered only when `canSelectPromptVersion` is true.
- Options from `listSelectablePromptVersions()` (id + label + description). Default-selected =
  current `params.promptVersion`.
- Under the select, a read-only line: **"Model: Claude Sonnet 4.5"** (humanized from the version's
  effective model). This is the "version lists which model is being run" requirement, visible even to
  a single-version actor.
- Theme checkbox labels reflect the **selected version's** `elementLabels` (so switching to v2 shows
  "Key findings & significance"; default v3 shows "Findings & their implications").

`components/edit/overview-card.tsx`:
- Hold `promptVersion` in params; send it in the generate POST body.
- Thread `canSelectPromptVersion`, `promptVersions`, and `defaultPromptVersion` from props.

`components/edit/edit-page.tsx`:
- Pass `canSelectPromptVersion` (computed from the same role signals as `generateEnabled`) and the
  registry option list to `OverviewCard`. (Per §6, also possibly widen `generateEnabled`.)

`components/edit/overview-versions-panel.tsx`:
- Show the prompt version + model in each history entry's metadata line.

---

## 8. File-by-file change list

| File | Change |
|---|---|
| `lib/edit/overview-prompt-versions.ts` | **NEW** — `OverviewPromptVersion` type, registry (`v2`,`v3`), `resolvePromptVersion`, `defaultPromptVersionId` (+ env override), `listSelectablePromptVersions`. |
| `lib/edit/overview-generator.ts` | Move current system prompt + `buildOverviewUserPrompt` + word bands into the `v2` registry entry; author `v3`; `generateOverviewDraft` resolves version, uses `version.systemPrompt`/`version.buildUserPrompt`/`version.model`, returns `promptVersion`. |
| `lib/edit/overview-params.ts` | Add `promptVersion` to `OverviewParams` + `DEFAULT_OVERVIEW_PARAMS` + `normalizeOverviewParams` (validate vs registry). |
| `prisma/schema.prisma` + migration | Add `promptVersion` column + index to `OverviewGeneration`. |
| `app/api/edit/overview/generate/route.ts` | Compute `canSelectPromptVersion`; downgrade non-privileged non-default to default; persist `promptVersion`. |
| `app/api/edit/overview/generations/route.ts` / `lib/edit/overview-provenance.ts` | Return `promptVersion` in the generations summary. |
| `components/edit/overview-generate-controls.tsx` | Version select + model line + version-scoped theme labels. |
| `components/edit/overview-card.tsx` | Hold/send `promptVersion`; accept new props. |
| `components/edit/edit-page.tsx` | Pass `canSelectPromptVersion` + registry options (+ §6 generate-surface decision). |
| `components/edit/overview-versions-panel.tsx` | Render version + model per history row. |
| Tests | `overview-generator`, `overview-params`, `overview-generate-route`, `overview-card`, `edit-page`, plus a new `overview-prompt-versions` unit test. Update the assertions that pin the current default prompt to the v2/v3 split. |

No new feature flag is strictly required (additive, default-version is the behavior switch), but
`OVERVIEW_PROMPT_VERSION_DEFAULT` env gives a no-redeploy rollback to v2.

---

## 9. Validation (data-integrity gate)

v3 becomes the live default, so before the **prod** flip:
- Re-run the existing gate `npm run edit:overview-validate` (`scripts/edit/overview-validation.ts`)
  against v3 on a `scholar_family`-populated env (staging), per the lesson in
  `project_overview_coverage_gap` (validate grounding on REAL deployed data, with complete
  ground-truth incl. synopsis/topicRationale). v3 *relaxes* the synthesis posture, so confirm it
  doesn't reopen entity-level leaks; the faithfulness pass (`OVERVIEW_FAITHFULNESS_PASS`) remains
  available as defense-in-depth and is now version-aware (it honors v3's synopsis-number permission
  via `permitSynopsisFindings`, so enabling it no longer silently reverts that loosening).
- Staging picks up v3 on the next CD image roll (the generator is already live on staging). Prod
  needs a gated deploy (prod App stack is behind master).

---

## 10. Explicitly out of scope (from the v3a doc — future)

The v3a doc proposes more than prompt versioning. Not in this change:
- **Consumer/purpose selector** (public bio | funding-match | directory blurb) — a separate aspect
  lever; would swap whole directive bundles. Natural next version-adjacent feature.
- **Scope controls at subarea grain** + drift/staleness signal — note the **pub pin/suppress
  three-state drawer is already built** (Phase 2, `SELF_EDIT_OVERVIEW_GENERATE`); subarea-grain scope
  + stable-facet-ID reconciliation is not.
- **Content controls** (typed-keyword field, free-text steering note hardening) — the doc says refuse
  the typed-keyword field; the free-text `instructions` note already exists and stays as-is.
- **Side-by-side compare** UI (D-A chose selector-only).
