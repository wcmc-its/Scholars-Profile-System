# Core-facility claim queue — SPEC

**Status:** Implemented (undocumented until now — reverse-derived from code)
**Date:** 2026-08-13
**Builds on:** [ADR-005](./ADR-005-manual-override-layer.md) — manual-override layer (the `CoreClaim` table is a same-pattern override, keyed on `(pmid, coreId)` instead of a scholar/entity id)
**Upstream dependency:** ReciterAI's `pipeline_cores` module (cores-inference engine, ReciterAI PR #245)
**Shipped:** migrations `20260620120000_add_core_tables`, `20260620130000_add_core_claim`

## Purpose

WCM runs 13 shared core facilities (imaging, flow cytometry, genomics, proteomics, …). A publication that used a core rarely says so in a structured field — the signal is scattered across acknowledgments text, byline co-authorship with core staff, and the paper's own content. ReciterAI's `pipeline_cores` module mines PubMed + reciterdb for these signals and projects a per-(publication, core) usage **candidate** with a combined likelihood. This SPEC covers the SPS-side consumer: the per-core owner's **claim queue** (`/edit/core/[coreId]`) where a human confirms or rejects each candidate, and the public surfaces (`/cores/[coreId]`, the publication-detail modal) that read the result.

This is a **read-projection + human-override** design, the same shape ADR-005 uses everywhere else: the engine's output is disposable and gets fully replaced; the human decision lives in a separate, ETL-immune table and always wins at read time.

## Data model (`prisma/schema.prisma`)

Three tables, one flow: catalog → engine candidates → human decision.

```
core                  the 13-facility catalog (seeded, not user-editable)
  id, name, facility, source, refreshedAt

publication_core       ENGINE output — rebuilt wholesale every ETL run
  pmid, coreId              PK (no scholar dimension — usage is a property
                             of the publication, not a pub×scholar pair)
  likelihood                0-1 combined-signal score
  status                    candidate | confirmed | below_threshold
  signalCoauthors            JSON string[] of core-staff CWIDs on the byline
  signalAck, ackAlias, ackSnippet
  llmScore, llmRationale
  authorAffinity
  scoredAt

core_claim              HUMAN decision — ETL-immune, never touched by the nightly rebuild
  id (uuid)
  pmid, coreId               UNIQUE (pmid, coreId) — one current decision per pair
  status                     claimed | rejected (Prisma field `status`, DB column `claim_status`)
  claimedBy, claimedAt
  note
  revokedBy, revokedAt        soft-revoke; NULL = active
```

`core` has **no DynamoDB catalog record** (unlike `topic`, seeded from `TAXONOMY#`). It's seeded from a version-controlled constant, `CORE_CATALOG` (`etl/dynamodb/core-catalog.ts`), a thin mirror of ReciterAI's `config/core_dictionary.yaml`. All 13 dictionary cores are mirrored today; 4 (Institutional Biorepository, Metabolic Phenotyping, Microbiome, Human Immune Monitoring) have a catalog row but currently project zero usage rows — an empty page, not an error, until the upstream feed surfaces their staff.

`core_claim` carries **no foreign key** to `publication_core`/`core`/`publication` — deliberately, the same ETL-immunity ADR-005 uses elsewhere: a claim can precede the engine's projection (or outlive a `publication_core` delete) and still be the durable record.

Ownership is **not** a column on `core`. A core owner/curator is a `UnitAdmin(entityType="core", entityId=coreId, role="owner"|"curator")` row — the same RBAC machinery as department/division/center — provisioned today by direct row insert (no admin write-UI yet).

## The signals

### Shown in the SPS queue

`publication_core.likelihood` is one combined 0–1 score, but the queue UI decomposes it into up to four independently-fired signals (`buildSignals()`, `components/edit/core-claim-queue.tsx`). Each signal's **display strength is fixed per kind**, not the model's raw self-score — how much that *category* of evidence should move a reviewer:

| Signal | Source | Strength (fixed) | Raw value shown |
|---|---|---|---|
| **Acknowledgment** (`signalAck`/`ackAlias`/`ackSnippet`) | A core alias matched in the full text | Direct (4 dots) | the matched snippet, quoted |
| **Co-author** (`signalCoauthors`) | Core-staff CWIDs found on the byline | Strong (3 dots) | resolved scholar names + dept, or bare CWID if unresolved |
| **LLM triage** (`llmScore`/`llmRationale`) | 1–10 dense LLM read | Moderate (2 dots) | `{score}/10` + one-line rationale |
| **Repeat-user prior** (`authorAffinity`) | 0–1, from the author's own history of confirmed usage of this core | Weak (1 dot) | percentage |

Signals are shown strongest-first. A row can fire 0–4 of them; "Why this surfaced · N of 4 signals fired" is the queue's evidence-count line.

### Topic is a candidate-generation input, but it isn't shown

Yes — with a caveat. `pipeline_cores` runs two modes. The **deterministic run** (`run.py`) is the source of the four signals above. A separate **`batch_screen` run-mode** generates the *candidate* queue for everything the deterministic run didn't confirm, and its pre-filter combines two free signals by noisy-OR into a `prefilter_prior` **before** the LLM screen:

1. author-affinity (repeat-user prior) — weight 0.6, outranks the other
2. **bare-descriptor MeSH E-tree membership** — weight 0.4 — a topical hint that the paper carries a MeSH descriptor under that core's technique branch of the tree (e.g. `E01.370.350` Diagnostic Imaging for core 2). This is the closest thing to a "topic match" signal in the pipeline.

Two things temper that: **MeSH qualifiers/subheadings were separately tested and rejected** as a signal (only discriminative for imaging, redundant there, and indexing lag would drop ~half the corpus as a gate) — only bare descriptors survived, and only for the cores with a clean technique branch (imaging, microscopy, flow, sequencing-based cores, MS-based cores; bioinformatics/biorepository/metabolic-phenotyping/microbiome/immune-monitoring have no mapped MeSH branch and rely on author-affinity + the LLM screen alone). And **the topical prior never reaches SPS as a labeled signal**: `batch_screen`'s DynamoDB write adds `prefilter_prior`/`screen_band`/`screen_confidence` attributes, but SPS's ingest mapper (`buildPublicationCoreWrites`, `etl/dynamodb/publication-core-mapper.ts`) only reads `pmid`/`coreId`/`likelihood`/`status`/`scoredAt` plus the four signal fields above — `prefilter_prior` isn't one of them. So a topic-driven candidate can surface in the queue (it moved the combined `likelihood`), but the reviewer sees it as an unexplained likelihood with 0–2 of the four displayed signals fired, never a "matched on topic" evidence row. Surfacing it as a fifth signal is a straightforward add if it's worth the mapper + UI change — the source field already exists upstream.

## Lifecycle: engine status × human claim → effective status

`lib/api/core-merge.ts` is the pure read-merge, unit-tested without a DB — the same split every ADR-005 consumer uses.

```
                    no active claim              active claim
engine status   +-----------------------+-------------------------------+
candidate       | candidate  (queue)    | claimed -> confirmed          |
                |                       | rejected -> rejected          |
confirmed       | confirmed             | rejected -> rejected (engine  |
                |                       |   can be overridden!)         |
below_threshold | (dropped, invisible)  | claimed -> confirmed (a human |
                |                       |  can promote a sub-threshold  |
                |                       |  row the engine never surfaced)|
                +-----------------------+-------------------------------+
```

A **soft-revoked** claim (`revokedAt` set) is ignored entirely — the engine status stands, as if the claim never happened. This is how "Undo" and "Revoke"/"Restore" work: they never delete a `core_claim` row, they set `revokedAt`.

The owner queue (`loadCoreReviewQueue` → `partitionCoreQueue`) buckets every row into exactly one of three lists by effective status:

- **candidates** — open engine `candidate` rows with no active claim. The actual review work.
- **confirmed** — effective-confirmed (engine `confirmed` OR human `claimed`). `claimed: true/false` on the row tells the UI whether a Revoke should soft-revoke (human claim) or write a `rejected` override (bare engine confirm — there's no claim to revoke).
- **rejected** — effective-rejected. **Always** human-backed (the engine itself has no rejected state), so `claimed: true` always drives the Rejected tab's "Restore" → soft-revoke.

An engine `below_threshold` row with no claim drops out of all three — invisible until/unless a human claims it directly (there's no UI path to do that today; it would need a claim written outside the queue).

## Authorization

`lib/edit/authz.ts` — `getCoreOwnerRole` + `authorizeCoreClaim`.

```
allow iff  session.isSuperuser
       OR  UnitAdmin(entityType="core", entityId=coreId, cwid=session.cwid).role
             in { owner, curator }
else 403 "not_core_owner"
```

Cores are **flat** — no dept→division cascade to walk, unlike unit curation. One composite-key lookup. Superuser is granted in `authorizeCoreClaim`, not baked into `getCoreOwnerRole`, so the audit log always records the role the actor actually held (a Superuser reviewing a core they don't own is logged as acting *as* Superuser, not as a phantom owner).

`/edit/core/[coreId]` (the page) distinguishes 404 ("no such core") from 403 ("core exists, you can't review it") by checking core existence only on the denial path. `/edit/core` (the index) is Superuser-only for now — a non-superuser owner reaches their queue only via the direct deep link; an owner-scoped index is a known future add.

### Owner vs curator are equal for claiming, unequal for granting

Today `authorizeCoreClaim` treats `owner` and `curator` identically — either can confirm/reject (correct: reviewing publications is content work, the same "curator parity" `canEditUnit` already gives dept/division/center curators). What's missing is the *other* half of the Amendment 1 role model: **granting** access. For department/division/center, that split already exists and is load-bearing —

- `canEditUnit` — Superuser OR Owner OR Curator (content parity)
- `canManageAccess` / `canGrant` — Superuser OR Owner **only** ("Curators grant nothing" — the line that stops a Curator from self-granting Owner)

Cores have no equivalent today: a `UnitAdmin(entityType="core", role="owner")` row is provisioned only by direct DB insert (see Non-goals). This SPEC proposes closing that gap by **reusing the existing machinery**, not building a parallel one — `canGrant`/`canManageAccess` already take a bare `EffectiveUnitRole` and don't care which unit kind produced it, and `getCoreOwnerRole` already produces one. Three small, additive changes:

1. **`POST /api/edit/grant`** — widen the `entityType` check to accept `"core"` alongside `department`/`division`/`center`. Branch two things by kind: the existence check (`db.read.core.findUnique` instead of `findUnit`) and the role lookup (`getCoreOwnerRole` instead of `getEffectiveUnitRole` — cores are flat, so no cascade to apply). `canGrant(session, coreRole, role)` is called exactly as today; **zero changes to the predicate itself**. The `ed_locked` branch is skipped for cores (no ED source ever writes a core grant — `source` is always app-granted). Audit needs nothing new: `target_entity_type='core'` and `action='grant_change'` are both already in the ENUM (added alongside `core_claim`, for the earlier UnitAdmin ENUM widen). Skip `reflectUnitChange` — no public page shows a core's owner/curator list, so there's nothing to revalidate.
2. **`lib/api/administrators-roster.ts`** — widen `AdminRosterGrant.entityType` (currently `"department" | "division" | "center"`) to include `"core"`, with a core-name lookup alongside the existing dept/division/center joins. This is the existing cross-unit "who has access to what" roster (`/edit/administrators`) — it already scopes to "units you own" for a non-superuser Owner, so a core owner sees their core's grants there with no new page.
3. **`AddAdministratorDialog`** — no code change. Its unit picker already takes a generic `AddAdminUnit[]`; the page that renders it just needs cores added to the list it builds (from `getCoreList`).

Net: the RBAC *predicate* layer needs nothing new (`canGrant`/`canManageAccess` are already unit-kind-agnostic); the work is entirely in widening three call sites' `entityType` unions. No schema/migration change — `unit_admin.entity_type` already includes `'core'`.

A grant row for a core, as it would render on the existing Administrators roster:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Rachel Chen . rrc4001                                                        │
│ rrc4001@med.cornell.edu                                                      │
│                                                                              │
│ Org unit                    Role                  Source      Actions        │
│ ---------------------------------------------------------------------------- │
│ Biomedical Imaging [Core]   (o) Owner ( ) Curator manual      [Revoke]       │
│ Pathology [Department]      ( ) Owner (o) Curator ED          Managed via    │
│                                                               Web Directory  │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Write path — `POST /api/edit/core-claim`

One MySQL transaction: upsert `core_claim` + one B03 audit row (`action: "core_claim"`, `targetEntityType: "core"`, `targetEntityId: "{coreId}:{pmid}"`). Three actions in one endpoint:

- **`claimed` / `rejected`** — upsert, clearing any prior soft-revoke (`revokedBy`/`revokedAt` reset to null). Idempotent: an identical active decision (same status + note) short-circuits to `{unchanged: true}`, no re-write.
- **`revoked`** — the undo. Soft-revoke only (`revokedBy`/`revokedAt` set); no-op if there's no active claim to revoke.

After the commit (never before, never blocking it): a **best-effort DynamoDB writeback** (`lib/cores/claim-writeback.ts`) mirrors `claimed`/`rejected` decisions back to the engine's `PUB#{pmid}/CORE#{coreId}` item, so the *next* cores-inference run reads the human decision as a repeat-user prior for `authorAffinity`. Gated behind `CORE_CLAIM_WRITEBACK` (default **off** — SPS has no DynamoDB write IAM grant yet; until that's provisioned and the flag flips, the claim still lands correctly in MySQL and this step is silently skipped). Never throws to the caller; a failure is logged and returned as advisory metadata, not an error. No writeback on revoke — the engine's own nightly re-derivation is the backstop for that case.

## Bulk write path — `POST /api/edit/core-claim/bulk`

The scale companion: `{ coreId, pmids: string[], status: "claimed" | "rejected" }`, capped at `MAX_BULK_PMIDS = 500`. Same upsert + audit loop, **one transaction** for the whole batch (not N). Role resolved once (the core dimension is identical for every pmid). Pre-filters pmids already at the target status (idempotent skip, counted in the response). `revoked` is deliberately **not** a bulk action — undo stays a single-row gesture on the single-claim route.

Drives the UI's **"Confirm N high-confidence"** button: candidates at `likelihood >= 0.9` with no existing decision, one click, one request, one transaction — instead of N client-side round-trips.

### Manual PMID add — built, extending this same endpoint

An owner who knows a paper used their core — one the engine never scored, or scored `below_threshold` — can paste a block of known PMIDs and claim them directly, independent of the engine queue. No new endpoint: this bulk route now does the work.

**Write path.** One addition on top of the existing route: a `db.read.publication.findMany({ where: { pmid: { in: pmids } }, select: { pmid: true } })` existence check, run alongside the prior-active-claims lookup. A pmid not in that set is returned as a new `notFound: string[]` in the response (alongside the existing `skipped`-already-claimed count) instead of being written — a pmid `core_claim` is FK-less, so nothing at the DB layer would otherwise reject it, and it would then display nowhere (see below). Everything else — the transaction, the audit row, `MAX_BULK_PMIDS = 500` — is unchanged, and the check is a no-op for the existing "Confirm N high-confidence" caller (its pmids always already have a `publication` row). `revoked` stays out of scope (single-row-only route, unchanged) — manual add only ever writes `claimed`.

**Read path.** All three consumers (`loadCoreReviewQueue`/`lib/api/core-queue.ts`, `getCorePage`/`lib/api/cores.ts`, `resolvePublicationCores`/`lib/api/publication-detail.ts`) now run a fourth query for `core_claim` rows with no matching `publication_core` row (CLAIMED only — a REJECTED claim with nothing to reject isn't surfaced), joined directly to `Publication` (and `Core`, for the modal) for display fields, and union the result into the same collection handed to the existing partition/select functions — the shape `getMenteesForMentor` (`lib/api/mentoring.ts`) already used to fold `getManualMentees` (`lib/api/manual-layer.ts`) in alongside engine-sourced queries. `core-merge.ts` needed no changes: `effectiveCoreStatus`/`isEffectiveConfirmed` already short-circuit on an active claim before reading engine status, so a manual row's placeholder `status` field is never actually read. New `isManual: boolean` field on `CoreQueueRow`, threaded through so the UI can label the row.

**UI.** An "Add PMIDs" affordance in the owner queue header, next to "Confirm N high-confidence" — a textarea taking a newline/comma/space-separated block (`parsePmidBlock`, client-side parse + de-dupe), posting to the same bulk endpoint with `status: "claimed"`. The result line reports added / already-claimed / not-found-in-SPS, then `router.refresh()`s so the new row's real title/journal/etc. comes from the server (the component has no local data for a pmid it didn't already have in props). Turns out the once-open "likelihood bar" display question resolved itself for free: `partitionCoreQueue` always routes an active `claimed` claim straight to the **Confirmed** tab, which renders the compact `ConfirmedRow` (title/year/PMID/Revoke) — it never reaches the candidate-card likelihood-bar rendering at all. `ConfirmedRow` shows a small "Manually added" badge when `isManual` is set, so the row's missing evidence trail is explained rather than silently absent.

## UI — `/edit/core/[coreId]` (owner review queue)

### Full queue view (default state, no history yet)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Biomedical Imaging — core publications                                       │
│ Publications our signals flag as having used this core. Confirm the          │
│ ones that did and reject false positives — your decisions surface on         │
│ the public profiles and prime the next inference run.                        │
│                                                                              │
│ To review  14                    [Confirm 3 high-confidence]  [Download CSV] │
│                                                                              │
│ (All) (Acknowledged) (Co-authored) (LLM-flagged)   Sort: Uncertain first     │
│ Shortcuts (focused card): a confirm | r reject | u undo | up/down move       │
├──────────────────────────────────────────────────────────────────────────────┤
│   Spatial transcriptomics of the tumor microenvironment in murine            │
│   glioblastoma models                                                        │
│   Nature Methods . 2026                                                      │
│   Kim J, [Chen R], Ortiz M, Patel S, ...                                     │
│                                                                              │
│   PMID 39812345 (link)   DOI (link)   142 citations   RCR 2.1 (88th pct)     │
│                                                          [Confirm]  [Reject] │
│                                                                              │
│   Single-cell profiling was performed using the imaging core's Leica         │
│   SP8 confocal system with subsequent spatial deconvolution.                 │
│                                                                              │
│   Combined likelihood  ################----                              82% │
│                                                                              │
│   Why this surfaced . 3 of 4 signals fired                                   │
│     Named in the acknowledgments                                ****  Direct │
│       "imaging performed at the Citigroup Biomedical Imaging                 │
│        Center core facility"                                                 │
│     Co-authored with Rachel Chen (Pathology)                    ***.  Strong │
│     LLM triage                                                **..  Moderate │
│       Methods section explicitly names core equipment                   8/10 │
│                                                                              │
│   > Details (abstract, full author list, WCM authors, MeSH)                  │
├──────────────────────────────────────────────────────────────────────────────┤
│   Comparative analysis of flow cytometry gating strategies for rare          │
│   population detection ... (next card, likelihood 55%, near the              │
│   "uncertain" cutoff the default sort surfaces first)                        │
└──────────────────────────────────────────────────────────────────────────────┘
```

Notes on the mockup: `[Chen R]` in the byline is a tinted, linked chip in the real UI — the co-author signal's staff CWID resolved to a named scholar and overlaid onto the flat `authorsString` by best-effort surname match (`ponytail`-marked in the source: the data carries no per-author byline token, so this mirrors how the profile page overlays author links). The default sort is **"Uncertain first"** — likelihoods near 50/50 surface before the engine's own high-confidence tail, on the theory that a 96% doesn't need a human and a 58% does.

### Tabs, once there's history

Once at least one candidate has been confirmed or rejected, the single "To review" heading becomes a 3-way segmented control:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ [ To review  11 ]   Confirmed  6    Rejected  2               [Download CSV] │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Confirmed tab** — compact rows, not full cards (the review work is done):

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ +  Spatial transcriptomics of the tumor microenvironment...         [Revoke] │
│    2026 . PMID 39812345                                                      │
├──────────────────────────────────────────────────────────────────────────────┤
│ +  Multiplexed imaging reveals immune cell heterogeneity...         [Revoke] │
│    2025 . PMID 38209981                                                      │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Rejected tab** — same shape, mirrored action:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ x  Retrospective cohort analysis of imaging biomarkers...          [Restore] │
│    2024 . PMID 37102244                                                      │
└──────────────────────────────────────────────────────────────────────────────┘
```

Revoking/restoring keeps the row visible for the session with a one-line "Revoked — …" / "Restored — …" state and an Undo, rather than yanking it out of the list immediately — it re-files into the correct tab on next page load.

### A decided card, mid-session (before the page reloads)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ +  Confirmed   Spatial transcriptomics of the tumor microenvi...      [Undo] │
└──────────────────────────────────────────────────────────────────────────────┘
```

## UI — `/edit/core` (owner index, Superuser-only today)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Core facilities                                                              │
│ Review the engine-suggested publications for each core facility.             │
│ Confirmed publications appear on the public core page; rejected ones         │
│ are hidden. A core with no staff feed yet has nothing to review.             │
├──────────────────────────────────────────────────────────────────────────────┤
│   Biomedical Imaging                                                Review > │
│   Citigroup Biomedical Imaging Center                                        │
├──────────────────────────────────────────────────────────────────────────────┤
│   Flow Cytometry                                                    Review > │
│   Flow Cytometry Core Facility                                               │
├──────────────────────────────────────────────────────────────────────────────┤
│   Genomics Resources                                                Review > │
│   Genomics Resources Core Facility                                           │
├──────────────────────────────────────────────────────────────────────────────┤
│   ...9 more (Epigenomics, Proteomics and Metabolomics, ...)                  │
├──────────────────────────────────────────────────────────────────────────────┤
│   Research Informatics                                     not yet cataloged │
│   Not one of the 13 dictionary cores today -- see "Adding a core" below      │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Public surface — `/cores/[coreId]`

**Confirmed-only** (`isEffectiveConfirmed`), no evidence, no LLM scores, no co-author CWIDs — a deliberately narrower field set than the owner queue (`CorePublication` vs `CoreQueueRow`), rendered with the shared `<PublicationCard>` (no author chips).

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ CORE FACILITY                                                                │
│ Biomedical Imaging                                                           │
│ Citigroup Biomedical Imaging Center                                          │
│                                                                              │
│ Publications (6)                                                             │
│ ---------------------------------------------------------------------------- │
│ Spatial transcriptomics of the tumor microenvironment in murine              │
│ glioblastoma models                                                          │
│ Nature Methods . 2026 . 142 citations . doi.org/10.1038/...                  │
│ ---------------------------------------------------------------------------- │
│ Multiplexed imaging reveals immune cell heterogeneity across...              │
│ Cell Reports . 2025 . 89 citations . doi.org/10.1016/...                     │
│ ---------------------------------------------------------------------------- │
│ ...4 more, sorted year desc...                                               │
└──────────────────────────────────────────────────────────────────────────────┘
```

Empty state (a real, reachable case — 4 of the 13 catalog cores currently have zero projected rows): "No confirmed publications yet." under the facility header.

## Public index — `/cores`

Lists only cores where `hasConfirmedPublications` is true (an engine-`confirmed` presence flag, cheap `distinct` scan) — empty cores stay unlisted so the public index never advertises a dead page. **Note:** this is engine-status only, not the full `CoreClaim` merge, so a core whose only confirmed row came from a human `claimed` override (with the engine itself never marking anything `confirmed`) will have its detail page work correctly but may not appear in this index — a narrow, currently-unaddressed gap between the index's presence check and the per-core page's real merge.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Core facilities                                                              │
│                                                                              │
│ Biomedical Imaging                                                  /cores/2 │
│ Flow Cytometry                                                      /cores/4 │
│ Genomics Resources                                                  /cores/5 │
│ ...                                                                          │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Publication-detail modal — "Core facilities" section

Per-pmid, effective-confirmed cores only (`resolvePublicationCores`), each linking to `/cores/[coreId]` when public pages are enabled, else rendered as plain text:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Core facilities                                                              │
│ [ Biomedical Imaging ]   [ Flow Cytometry ]                                  │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Feature flags

Both **server-only, request-time** (`process.env.X === "on"`, checked at request time — a client component never sees the value) — no master "data" gate exists (unlike Methods lens) because the `publication_core` substrate is simply empty until the engine has published, so each surface flag stands alone. Flipping either needs the flag set in **both** `.env.local`/per-env `cdk/lib/app-stack.ts` block AND a `cdk deploy Sps-App-<env>` — the standard flag-parity rule.

**Committed source says on, runtime says off (as of 2026-08-13).** `cdk/lib/app-stack.ts` sets all three unconditionally to `"on"` (an adjacent comment dates the promotion to 2026-07-22, and a CDK snapshot test asserts it) — but a merged flag is dark until its own `cdk deploy Sps-App-<env>` ships it, and that deploy hasn't happened: neither the running staging task-def (`sps-app-staging:280`) nor prod (`sps-app-prod:71`) has any of the three env vars set, so `=== "on"` reads false and all three surfaces are still dark today. (The source comments in `lib/profile/cores-flags.ts` and one at `cdk/lib/app-stack.ts:981` still say "default off" — stale, predating the promotion; don't trust either comment over the running task-def.)

| Flag | Gates | Off behavior |
|---|---|---|
| `CORE_PUB_MODAL` | The "Core facilities" section in the publication-detail modal | `resolvePublicationCores` returns `[]`; section omitted; no core data in the modal payload at all (not a client-side hide) |
| `CORE_PAGES` | Public `/cores` + `/cores/[coreId]` | Route `notFound()`s; the modal renders a core name as plain text instead of a link |
| `CORE_CLAIM_WRITEBACK` | The DynamoDB mirror-back of a claim decision to the engine | Claim still lands correctly in MySQL; writeback step is skipped entirely (needs a not-yet-provisioned DynamoDB write IAM grant) |

The owner queue itself (`/edit/core/*`) has **no flag** — it's gated by authorization only (core-owner role or Superuser), so an owner can review and claim before either public flag is on.

## ETL ingest (`etl/dynamodb/index.ts` Block 6)

Mirrors the topic-projection block. Two-phase, "populate catalog then guard usage rows":

1. Upsert the `core` table from the version-controlled `CORE_CATALOG` constant.
2. Scan `PUB#{pmid}/CORE#{core_id}` items from the shared `reciterai` DynamoDB table and map them via the pure, unit-tested `buildPublicationCoreWrites` (`etl/dynamodb/publication-core-mapper.ts`), which applies four guards in order and **counts** (never throws on) each skip category:
   - `skippedMissingCore` — `core_id` not in the seeded catalog (FK guard)
   - `skippedMissingFields` — a required scalar (pmid/likelihood/status/scored_at) absent or unparseable
   - `skippedBelowThreshold` — engine scored it but marked `below_threshold` (deliberately not surfaced)
   - `skippedMissingPublication` — pmid not yet in SPS's `publication` table (FK guard)

`publication_core` is a **full wholesale rebuild** every run — it carries no human decision, so clobbering it nightly is safe by construction. `core_claim` is a completely separate table the ETL never touches. The mapper's field list is a strict subset of what the engine can write (see "Topic is a candidate-generation input" above) — extending it is a mapper + Prisma-column change, not a re-architecture.

## Adding a core

Both sides need an entry before a core is reviewable, in this order:

1. **ReciterAI:** an entry in `config/core_dictionary.yaml` — `core_id`, name, facility, aliases (signal 3), staff CWIDs (signal 2), and an LLM description (signal 4/topical routing). This is "the project's real IP" per the dictionary's own header comment; a core with no resolved staff still seeds a row and just won't fire signal 2.
2. **SPS:** the matching entry in `CORE_CATALOG` (`etl/dynamodb/core-catalog.ts`), same `core_id`. The next ETL run upserts the `core` table row; `publication_core` rows for that core start landing once `pipeline_cores` has scored it.
3. A `UnitAdmin(entityType="core", entityId=coreId, role="owner")` row, granting whoever will review the queue — by direct insert today (see Non-goals).

**Research Informatics is a concrete example of a facility not yet in either list.** It is not one of the 13 cores in ReciterAI's dictionary today (verified against `origin/main`, both the SPS `CORE_CATALOG` mirror and the ReciterAI `core_dictionary.yaml` source), and it's a different thing from the "Research Informatics" already elsewhere in this codebase — that name refers to an unrelated cross-account grants-data consumer (`RESEARCH_INFORMATICS_TOKEN`, #2363/#2364), not a WCM core facility. If/when WCM stands up a Research Informatics core facility that scholars should be able to claim publications against, it goes through the same two-file + `UnitAdmin` grant path as any other core — no schema change needed.

## Non-goals / open gaps

- **No admin write-UI for granting core ownership yet** — a `UnitAdmin(entityType="core", role=owner)` row is still provisioned today by direct DB insert. SPEC'd above ("Owner vs curator are equal for claiming, unequal for granting") as a three-call-site widen of the existing dept/division/center grant machinery; not yet built.
- **No note-entry UI** — the single-claim API accepts an optional `note` (≤2000 chars, stored on `core_claim`), but the queue component never collects one; every UI-driven claim writes `note: null`. The field exists for the schema/API and a future direct-write use case.
- **Owner-scoped `/edit/core` index doesn't exist yet** — `/edit/core` is Superuser-only; a non-superuser owner reaches their queue only via the deep link `/edit/core/[coreId]` (e.g. from an account-menu entry point, not yet built).
- **`/cores` index presence check is engine-status-only** (see the public-index note above) — can under-list a core whose only confirmed usage is a pure human override.
- **`CORE_CLAIM_WRITEBACK` needs a DynamoDB write IAM grant** SPS doesn't have yet (SPS has only ever *read* the `reciterai` table before this feature) — dormant until that's provisioned, same posture `lib/reciter/client.ts` documents for its own dormant-safe writes.
- **A `below_threshold` row can never be claimed today** — there's no UI path that lets an owner promote an engine-suppressed candidate directly (the merge logic supports it; nothing writes it).
- ~~No way to manually claim a PMID the engine hasn't scored at all~~ — **built** ("Manual PMID add" above): an owner can paste a block of known PMIDs and claim them directly, independent of the engine queue. Built on a separate branch (`feat/core-claim-manual-pmid-add`), not yet merged as of this spec's date.
- **The topical MeSH prior isn't a labeled signal in SPS** (see "Topic is a candidate-generation input" above) — it can move a row into the queue but the reviewer never sees why in those terms.
- **A 14th+ core needs a coordinated two-repo change** (see "Adding a core" above) — there's no SPS-side self-service path; Research Informatics (or any other facility) needs ReciterAI's dictionary updated first.

## Interfaces and dependencies

- **Upstream:** ReciterAI's `pipeline_cores` module (PR #245), writing `PUB#{pmid}/CORE#{core_id}` items to the shared `reciterai` DynamoDB table, keyed the same way the topic pipeline is. Two run-modes: the deterministic `run.py` (the four SPS-visible signals) and the `batch_screen` candidate generator (adds the topical MeSH prior, not SPS-visible).
- **Downstream (this feature writes back to):** the same DynamoDB table, gated behind `CORE_CLAIM_WRITEBACK`, feeding the engine's `authorAffinity` prior on its next run.
- **RBAC:** `UnitAdmin(entityType="core")`, the same table department/division/center ownership uses; `canGrant`/`canManageAccess` (`lib/edit/authz.ts`) are already unit-kind-agnostic and need no change to cover cores (see "Owner vs curator" above).
- **Audit:** `core_claim` action + `core` target-entity-type, registered in all four required sites (`lib/edit/audit.ts` + the three `scripts/sql/audit-log.sql` ENUM sites) — verified present.
- **Manual-override pattern:** ADR-005, same shape as `field_override`/`suppression`, keyed on `(pmid, coreId)` instead of an entity id.
