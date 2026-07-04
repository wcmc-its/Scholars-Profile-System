# Handoff — Biosketch generator v6: contributions overhaul + Products + prompt versioning/history + Services-rail move

> Follows the v5 biosketch generator (`docs/overview-generator-v5-handoff.md`, `docs/overview-generator-prompt-v5.md`) — **MERGED to master `1c1b087a` (#1179), STAGING-LIVE** (flag `EDIT_BIOSKETCH_GENERATE` staging-on / prod-off; task-def `sps-app-staging:68`; `biosketch_generation` table migrated). This handoff is the **next iteration** of the biosketch prompt + surface, plus a parallel prompt-versioning/history system.

**Base:** fresh `origin/master` (HEAD `4556fa43` at writing). Worktree **outside Dropbox**, symlink `node_modules` + `cdk/node_modules`, copy `.env*`, `npx prisma generate`. The biosketch code is on master:
- `lib/edit/biosketch-generator.ts` (prompt blocks `BIOSKETCH_*`, `generateBiosketch`, parser, per-entry faithfulness pass), `lib/edit/biosketch-params.ts`, `app/api/edit/biosketch/generate/route.ts`, `components/edit/biosketch-{tool,generate-controls,result-card}.tsx`, the `biosketch` rail panel in `components/edit/edit-page.tsx`, `prisma/schema.prisma` `BiosketchGeneration`, `scripts/edit/biosketch-generate-from-facts.ts`.

Read first to orient: the v5 spec (`docs/overview-generator-prompt-v5.md`) is the current contract; `lib/edit/biosketch-generator.ts` the current prompt; the overview versioning machinery (`lib/edit/overview-prompt-versions.ts`, `app/api/edit/overview/generate/route.ts`, `app/api/edit/overview/generations/route.ts`, `lib/edit/overview-provenance.ts`, `components/edit/overview-card.tsx` history panel, `components/edit/overview-generate-controls.tsx` version selector) is the **template** for §6.

---

## 0. Two framing decisions before touching code

**(a) The overhaul should ship as a NEW biosketch prompt version, not an in-place edit.** §6 adds a biosketch prompt-version registry. The cleanest sequencing: build the registry FIRST (§6 step 1), register the *current* prompt as the baseline version (id `v5`, matching the existing `BIOSKETCH_PROMPT_VERSION = "v5"` constant in the route), then author the overhauled prompt (§2–§3) as a new version (`v6`, new default). That gives instant A/B (v5 vs v6) and a per-env rollback lever, exactly like overview v2/v3/v4. The biosketch version namespace is **internal to biosketch** — do NOT conflate with overview's `v2/v3/v4` (different artifact, different registry).

**(b) Decisions resolved (§7); one scope toggle remains.** Impact grounding (item 5) = **bibliometrics IN**, surfaced into a **biosketch-only** facts projection (§3.5: ReciterAI `impactScore` for ordering, `citationCount` for grounded citation magnitude, NIH iCite RCR once sourced), with a judicious-use caution and the verifier updated in lockstep. Products (item 2) = **deterministic-select + model-map** (§4). The only thing still to confirm: **source NIH iCite (RCR) this iteration, or ship on `citationCount` first** (recommended: fast-follow) — §7-A.

---

## 1. Move "Services" rail section to the BOTTOM (trivial)

Today the self-edit rail renders **Yours to edit → Services → From WCM systems**. Operator wants Services **last**. The rendered group order is first-appearance in `SELF_RAIL_ORDER` (`attribute-rail.tsx` `groupItems` preserves first-appearance), so the only change is to move the two Services keys to the end.

`components/edit/edit-page.tsx`, `SELF_RAIL_ORDER` (currently lines 208–233): remove `"biosketch"`, `"grant-recs"` from their slot after `"proxy-editors"` and append them after `"coi-gap"`:
```
  // … "From WCM systems" …
  "mentees", "coi", "coi-gap",
  // "Services" group — owner-facing tools, rendered LAST.
  "biosketch", "grant-recs",
];
```
No change to `SELF_RAIL_KIND` (`service`) or `SELF_RAIL_GROUP` (`service: "Services"`). The **superuser** rail is flat (no groups) — unaffected; leave `SUPERUSER_RAIL_ORDER` as-is. The existing `biosketch-rail-gating.test.tsx` still passes (it asserts membership, not order). Optional: add an order assertion if desired.

---

## 2. Stop em-dash output (both generators) — prompt directive [DECIDED: B]

Decision: **just ask the model** — a prompt output directive, no post-process sanitizer, no new overview version. Add one concise rule to the biosketch `v6` prompt AND the overview live-default prompt:
> *"Do not use em dashes (—) or en dashes (–) anywhere in the output. Rephrase with commas, colons, parentheses, or separate sentences; use a hyphen only inside a hyphenated compound word."*

- **Biosketch:** goes into the `v6` `OUTPUT` block (free — `v6` is new).
- **Overview:** add the same one line to the **live default `v4`** `OUTPUT` block. `v4` is sha256-byte-pinned (`tests/unit/overview-prompt-byte-identity.test.ts`), so **regenerate the v4 hash** in that test — a deliberate, reviewed change to the live default, not silent drift. Leave v2/v3 untouched (they are not the default).

Replacement convention = **rephrase** (commas/colons/parens/separate sentences), never hyphen-for-emdash. Note: the prompt *source files* still contain em dashes in their own instruction text — that is fine and out of scope; the directive governs the model's **output**, not the prompt source.

---

## 3. Contributions prompt overhaul (the 9 tweaks → exact blocks)

All blocks are `const BIOSKETCH_* : string[]` in `lib/edit/biosketch-generator.ts`, composed into `BIOSKETCH_SYSTEM_PROMPT`. Ship as the new `v6` version (§0a). **Grounded reality:** `authorPosition` (first/last/middle) is already in the per-pub `toModelFacts` projection and `activeGrants[].role` is already in FACTS + the grounding reference — so the role tweaks are **prompt-only**.

### Content & compliance

1. **Explicit role per contribution** → `BIOSKETCH_THROUGHLINE` + `BIOSKETCH_OUTPUT`. Require the entry to name the faculty member's *specific* role using the data already present: lead vs senior/last (corresponding) vs contributing author (`authorPosition`), and PI / co-PI / co-I on a grant (`activeGrants[].role`). Replace reflexive "we built / we showed" with role-anchored framing ("As senior author, I led…", "As PI of <grant title>, I…"). Add a line directing the model to read `authorPosition` and grant `role` and to distinguish the individual's contribution from the team's.

2. **Products selector (5 + 5) as a separate output** → see **§4** (new feature, not a prompt edit).

3. **Hard-constrain specifics + faithfulness ON by default** → tighten `BIOSKETCH_SIGNIFICANCE`/floor wording ("state only numbers, metrics, named artifacts that appear verbatim in the evidence; never infer or compute them") **and** flip the pass on by default → see **§5**. Rationale per operator: one fabricated "83.0% recall" in a grant submission dwarfs the ~3× cost.

4. **Loose product references, never formal citations** → `BIOSKETCH_REFERENCES`. Current block already bans full citations + "(Author, year)". Extend: *allow* descriptive mentions of a product's title / journal / year for findability (author names only if present in FACTS — today FACTS carry no co-author names, so keep the no-invented-author rule), and *forbid* citation markers, bracketed/numbered refs `[1]`, superscripts, or any reference list (non-compliant in the Common Form prose section). The Products list (§4) is where products live formally.

5. **Ground impact with bibliometrics [DECIDED: A — bibliometrics IN, judiciously]** → `BIOSKETCH_SIGNIFICANCE` (the EXTERNAL UPTAKE block, lines ~91–97). Relax the absolute ban to a **grounded conditional**: *assert influence / adoption / citation magnitude ONLY when a concrete bibliometric signal for it is present in FACTS; otherwise describe the contribution without asserting impact the evidence doesn't show.* This requires surfacing a bounded bibliometric block into the **biosketch-only** projection (**§3.5**), and a paired **caution**: cite a metric only when it materially supports a specific contribution's influence — never as a productivity boast, **at most once or twice across the whole biosketch**. The (a)-ban still holds: a *number from FACTS* is grounded; a bare self-rating adjective ("highly-cited", "seminal") is not. The faithfulness verifier must be updated in lockstep (**§5**) so it permits a citation/RCR figure that is in FACTS and still flags an ungrounded uptake claim.

6. **Enforce the four NIH elements per contribution** → `BIOSKETCH_THROUGHLINE` + `BIOSKETCH_OUTPUT`. Require all four, in order: **(i)** background/problem, **(ii)** central finding(s), **(iii)** influence or application to health, **(iv)** the scholar's role. The current block has (i)–(iii) implicitly; **(iv) role is routinely dropped** — make it mandatory and name it explicitly.

### Style & consistency

7. **Pin one first-person convention** → `BIOSKETCH_PREAMBLE` line 58 (`Write in the FIRST PERSON ("we," "my laboratory," "I")`). Replace with: default to **"I" / "my research"** for individual framing; use **"we"** only for genuine multi-author/team work; **forbid "my laboratory"** (the system cannot verify the person runs a lab — reads wrong for e.g. informatics faculty). Propagate the same register to the Personal Statement output line.

8. **Length target band** → `BIOSKETCH_LENGTH`. Current guidance ("write the shortest entry…") **reverses** here: target **~1,200–1,800 characters** (hard cap stays **2,000**), so entries use the space and don't come out lopsided (a 585-char entry next to a full one). Keep "never pad with unsupported content" — fuller, not padded. Update `BIOSKETCH_CONTRIBUTION_LABEL` directive copy accordingly; the cap constant `BIOSKETCH_CONTRIBUTION_MAX_CHARS = 2000` is unchanged. (Personal Statement band optional — leave at ≤3,500.)

9. **Plain prose, no repetition, no meta-framing** → `BIOSKETCH_OUTPUT` + a new style block. Add: no figures, tables, or hyperlinks; consistent **past tense** for completed work; no repeated stock phrases (the model repeated "improve the availability and quality of…" twice in one entry); no meta-references to the document itself ("in a 2026 study I describe…", "as noted above").

### 3.5 Surface bibliometrics into a BIOSKETCH-ONLY facts projection (data for items 5 + 8 + Products)

The overview's `toModelFacts` (`overview-generator.ts`) **deliberately withholds** `impact`, `impactJustification`, and `facultyMetrics` — and the public bio must keep that. So do **not** edit `toModelFacts`; add a parallel **`toBiosketchModelFacts(facts)`** (or a `purpose: "biosketch"` branch) that the biosketch generator + grounding reference use, which **includes a bounded per-pub bibliometric block** the model may ground impact on:

- **ReciterAI impact score** — `Publication.impactScore` (0–100, GPT-rubric, DynamoDB `IMPACT#`, already mirrored; surfaced as `OverviewFacts.representativePublications[].impact`). **Use it to ORDER** the featured pubs + the Products "significant" set, impact-desc (this is already how `OverviewFacts` orders). Per operator: **ReciterAI is the better signal for RECENT pubs** where citations have not yet accrued — blend it with citation count rather than ranking purely on citations.
- **Citation count** — `Publication.citationCount` (Int, refreshed weekly from reciter-db; present today). The grounded citation-magnitude signal the model may cite (judiciously, §3-item-5).
- **NIH iCite metrics (RCR / NIH percentile)** — **PREREQUISITE: not in the schema today.** Operator wants iCite ("especially nih icite metrics"); RCR is the field-normalized, most-defensible figure for a biosketch. This needs a **source step**: an iCite ETL (NIH iCite API, keyed by pmid) populating new `Publication` columns (e.g. `relativeCitationRatio`, `nihPercentile`, `citedByCount`) + the projection. Until that lands, **citation count is the available grounded signal** and the prompt grounds impact on it; RCR is a fast-follow once sourced. *(Confirm whether to source iCite in this iteration or ship on citation count first.)*

Keep this projection **biosketch-only** — gate it so nothing here can leak into the public overview path. The verifier's `buildGroundingReference` for biosketch must include the bibliometric lines as ALLOWED NUMBERS (so a cited RCR/count is not flagged), while the overview reference stays unchanged.

---

## 4. Products selector (5 + 5) — new structured output

The real Common-Form gap (not inline citations). The system already knows the publications, so generate a **Products** artifact alongside the contributions.

**Spec (operator):** up to **5 products most closely related to the proposed project** + up to **5 other significant products**, **mapped to the five contributions**.

**Data available:** `representativePublications[]` carries `pmid, title, venue, year, synopsis, topicRationale, authorPosition` — enough to render a product line and to map a product to a contribution (both derive from the same topic/synopsis signal). "Related to the proposed project" needs a **project input** (aims) — today only the Personal Statement mode carries `projectTitle`/`aims`; **Contributions mode would need an optional project-aims input** to compute the "related" five (else fall back to "5 most significant overall").

**Approach [DECIDED: C — deterministic selection + model mapping].** Select the pmids in code (grounded identity, zero hallucinated products); the model only maps + labels:
1. **Selection (code).** From the scholar's scored pubs: **related** = top by topic/aims overlap when project aims are present (below), else top by impact; **other significant** = top by the §3.5 blended impact order (ReciterAI `impactScore` for recency-robustness + `citationCount` for established work), excluding the related set. Up to 5 each.
2. **Mapping (model).** Assign each selected product to one of the 1–5 contributions + a one-line "why", choosing only from the provided pmids. Verify every returned pmid is in FACTS; drop any that is not.
3. **Project aims for "related".** Add an **optional project-title/aims input to Contributions mode** (reuse the Personal Statement fields, optional here); when present compute "related" by aims/topic overlap, when absent fall back to "5 most significant overall" and label the bucket accordingly.

NIH allows up to 4 peer-reviewed products *per contribution*; the operator's "5 + 5" is a flat related/significant split mapped across contributions — ship that, surface the per-contribution grouping in the UI.

**Output/UI/persistence:** a new `products` field on `BiosketchResult` + the route response (`{ related: Product[], otherSignificant: Product[] }`, `Product = { pmid, title, venue, year, contributionIndex, why }`); a Products section in `biosketch-result-card.tsx` (two buckets, each line = title · venue · year, grouped by contribution, copy/download with the entries); persist a new `products Json?` column on `biosketch_generation` (migration; the `scholars.*` app_rw wildcard covers it, **no verify-grants edit** — confirmed empirically when the v5 table deployed).

---

## 5. Faithfulness pass ON by default (item 3)

Today off: `isBiosketchFaithfulnessPassEnabled()` reads `BIOSKETCH_FAITHFULNESS_PASS` (default off), and the route does not force it. For a grant document the operator wants it **on by default**. Lowest-friction:
- Have the route pass `faithfulnessPass: true` explicitly (always on, env can still force-disable for debugging), **or** flip `isBiosketchFaithfulnessPassEnabled()` to default-true with an opt-out, **and** set `BIOSKETCH_FAITHFULNESS_PASS = "on"` in `cdk/lib/app-stack.ts` for both envs.
- Update `estimateBiosketchCostUsd` display copy to reflect the ~3× (the pass runs per-entry: up to 5 × verify→revise). Cost line already privileged-only.
- The biosketch faithfulness pass already threads `permitSignificance: true` (v5 work). If §3-item-5 relaxes external-uptake conditionally, the **verifier clause** (`VERIFY_SIGNIFICANCE_EXCEPTION` in `overview-generator.ts`) must be updated in lockstep so it doesn't strip a now-permitted, evidence-grounded impact claim — and must still flag an *un*grounded one.

---

## 6. Biosketch prompt VERSIONING + HISTORY (mirror overview)

Today the biosketch prompt version is a hardcoded `BIOSKETCH_PROMPT_VERSION = "v5"` constant; the `biosketch_generation.promptVersion` column already exists and is written. Build the registry + gate + history to match overview (template map below; all refs origin/master).

**Build list (parallel to `overview-prompt-versions.ts` etc.):**
1. **`lib/edit/biosketch-prompt-versions.ts`** (client-safe): `BiosketchPromptVersionId` union (`"v5" | "v6"`; v5 = current baseline, v6 = the overhaul, new default), `BiosketchPromptVersionMeta` (`id, label, description, status, model?`, and a biosketch-specific `permitsSignificance?`/`permitsImpactWhenGrounded?` flag instead of overview's `permitsSynopsisFindings`), `BIOSKETCH_PROMPT_VERSION_METAS` (insertion order = selector order), `BIOSKETCH_DEFAULT_PROMPT_VERSION`, `defaultBiosketchPromptVersionId()` (reads a new `BIOSKETCH_PROMPT_VERSION_DEFAULT` env — the rollback lever), `isValidBiosketchPromptVersionId`, `listSelectableBiosketchPromptVersions`. Reuse `estimateBiosketchCostUsd` (already shared in `overview-prompt-versions.ts`).
2. **Prompt content → version map** in `biosketch-generator.ts`: a `BIOSKETCH_PROMPT_IMPLS: Record<BiosketchPromptVersionId, { systemPrompt: string }>` (biosketch uses char caps, not word bands — no `lengthBands`). v5 = the current composed prompt; v6 = the overhauled prompt (§2–§3). `generateBiosketch` selects the impl by resolved version.
3. **`biosketch-params.ts`**: add `promptVersion: BiosketchPromptVersionId` to `BiosketchParams` + `DEFAULT_BIOSKETCH_PARAMS` (via `defaultBiosketchPromptVersionId()`, not a literal); normalize untrusted value → default.
4. **Route** (`app/api/edit/biosketch/generate/route.ts`): compute `canSelectBiosketchPromptVersion = session.isSuperuser || session.isCommsSteward || authz.viaUnitAdminUnit !== null`; downgrade a non-default posted version to the default for unprivileged actors (verbatim pattern from overview route lines 89–99); persist the *resolved* version into the existing `promptVersion` column (replace the hardcoded constant).
5. **Prisma**: add `@@index([promptVersion, createdAt(sort: Desc)])` to `BiosketchGeneration` (A/B queries) — small migration.
6. **History**: `lib/edit/biosketch-provenance.ts` with `listBiosketchGenerations(cwid)` (newest-first, cap 20, normalize params on read) mirroring `overview-provenance.ts`; `GET /api/edit/biosketch/generations` mirroring `app/api/edit/overview/generations/route.ts` (auth via `authorizeOverviewWrite`, returns `{generations:[{id,mode,entries,projectTitle,projectAims,model,promptVersion,params,createdAt}]}`). Biosketch has no "published provenance" analog (no save-to-profile) — drop the `provenance` half.
7. **UI**: version `<select>` (gated by `canSelectBiosketchPromptVersion`, model line + cost span) in `biosketch-generate-controls.tsx` mirroring `overview-generate-controls.tsx` lines 100–147; an "Earlier biosketches" history panel + "Use these settings" restore in `biosketch-tool.tsx`/`biosketch-result-card.tsx` mirroring `overview-card.tsx` lines 904–968 (restore `params` incl. `promptVersion`; no selection-delta clamping needed — biosketch uses default facts selection).
8. **cdk**: add `BIOSKETCH_PROMPT_VERSION_DEFAULT` (default `v6`) to `app-stack.ts` both envs — the no-redeploy rollback lever.
9. **Validation**: `scripts/edit/biosketch-generate-from-facts.ts` already has `GEN_MODE`; add `GEN_VERSION` (biosketch id) to validate v5 vs v6.

**Does NOT generalize from overview** (per the template map): overview's `elementLabels` (biosketch has `mode`/`maxContributions`, no theme elements); `permitsSynopsisFindings` (biosketch needs its own significance/impact flag); word `lengthBands` (biosketch uses char caps). Keep the biosketch registry standalone — do not extend the overview union.

---

## 7. Decisions [RESOLVED 2026-06-20]

- **A. Impact grounding → bibliometrics IN, judiciously.** Surface a bounded biosketch-only bibliometric block (**§3.5**): ReciterAI `impactScore` for ordering (esp. recent pubs), `citationCount` as the grounded citation signal available now, NIH iCite **RCR** once sourced. The prompt grounds impact on these with a caution to cite a metric only when it supports a contribution's influence, at most once or twice across the biosketch; the (a)-ban on bare self-rating adjectives stays; the verifier permits a FACTS-present figure and flags ungrounded uptake. **The one remaining scope toggle:** NIH iCite (RCR/percentile) is **not in the schema** — sourcing it is an iCite ETL (keyed by pmid) + new `Publication` columns. **Ship on `citationCount` now and add RCR as a fast-follow (recommended), or source iCite first?** This is the only thing still to confirm.
- **B. Em-dashes → prompt directive only** (no sanitizer): biosketch `v6` + overview live-default `v4` (regenerate the v4 byte-pin). See **§2**.
- **C. Products → deterministic selection + model mapping**, 5 related + 5 significant mapped across contributions, optional project-aims added to Contributions mode. See **§4**.
- **D. Versioning → version ids** (`v5` baseline / `v6` overhaul), biosketch-internal namespace. See **§6**.
- **E. Length → ~1,200–1,800 char target, hard cap 2,000.** Confirmed (intentionally reverses the v5 "shortest honest entry" rule). See **§3-item-8**.

---

## 8. Validation + deploy

Reuse the v5 gate: `scripts/edit/overview-facts-probe.ts` (in-VPC facts via `scripts/run-staging-probe.sh`) → `scripts/edit/biosketch-generate-from-facts.ts` (local Opus-4.8, `GEN_VERSION=v6`, faithfulness ON). Re-tuned adversarial audit lenses, **plus new for v6**: (i) role present + correct (matches `authorPosition`/grant `role`, not invented), (ii) all four NIH elements present, (iii) no em/en dashes in output, (iv) no formal citations/reference markers, (v) impact claims grounded in a FACTS bibliometric (citation count / RCR), used **judiciously (≤1–2 across the whole biosketch)**, no ungrounded uptake, no bare "highly-cited" adjective, (vi) length in band, (vii) Products all map to real FACTS pmids. Samples: `rgcryst`/`imh2003`/`gbm9002` + a mid-career scholar + the informatics-faculty case that triggered the "my laboratory" / 585-char issues. **Gate:** 0 invented entities/products, 0 em-dashes, 0 formal citations, every role grounded, four elements each, impact grounded-or-absent, lengths in band.

**Deploy (v5 recipe, verified live):** PR for review (no merge/deploy unless asked). Then push-to-master auto-Deploy rolls the image + runs any migration (Products column / version index) via the `migrate` step; flags/env (`BIOSKETCH_FAITHFULNESS_PASS=on`, `BIOSKETCH_PROMPT_VERSION_DEFAULT=v6`) via **manual `cd cdk && npx cdk deploy --exclusively Sps-App-staging -c env=staging --require-approval never`** (reciter creds; **read the full `cdk diff` first**, `2>&1` — it writes to STDERR; `npx jest app-stack -u` to refresh the CFN snapshot after the env change). **GOTCHA:** `/api/edit/*` middleware returns a bare 401 before the route's flag check, so the route/UI behavioral verify needs an **SSO session** (the documented manual spot-check) — confirm the Services rail (now bottom) shows "NIH biosketch", and a v6 generation renders role + four elements + Products + no dashes.

## Gotchas (carried from v5)
- New `scholars`-schema columns/tables need **no** `verify-db-grants` edit — the `app_rw` `scholars.*` wildcard covers them (empirically confirmed when the v5 `biosketch_generation` table deployed: `verify-grants` passed). A separate-schema table WOULD need a golden-list entry.
- Worktree symlinked `node_modules` → 5 baseline `tsc` errors in `center-collaboration-tab.tsx` (vis-network; ignore, CI's `npm ci` resolves). Full `vitest` has 1 pre-existing `edit-page` Radix-avatar mock-vs-version failure (symlink artifact; CI green).
- Overview prompts are sha256 byte-pinned (`overview-prompt-byte-identity.test.ts`); any overview prompt change must be a new version or update the pin deliberately.
- `DEFAULT_*_PARAMS.promptVersion` is **derived** (`default…PromptVersionId()`) — never hardcode. No `amount` field on `Grant`. `authorPosition` + grant `role` already reach the model (the role tweaks are prompt-only).

**End state:** PR for review; then the v5 staging recipe (cdk env/flag deploy + migration first, then land code), re-validate against the v6 gate, SSO render-verify.
