# Core-facility claim queue — SPEC

**Status:** Implemented (undocumented until now — reverse-derived from code)
**Date:** 2026-08-13 (stale points corrected 2026-09-29: ownership grants, the `/edit/core` index, core 14, the `/review` route, known clients)
**Builds on:** [ADR-005](./ADR-005-manual-override-layer.md) — manual-override layer (the `CoreClaim` table is a same-pattern override, keyed on `(pmid, coreId)` instead of a scholar/entity id)
**Upstream dependency:** ReciterAI's `pipeline_cores` module (cores-inference engine, ReciterAI PR #245)
**Shipped:** migrations `20260620120000_add_core_tables`, `20260620130000_add_core_claim`

## Purpose

WCM runs a set of shared core facilities (imaging, flow cytometry, genomics, proteomics, …). A publication that used a core rarely says so in a structured field — the signal is scattered across acknowledgments text, byline co-authorship with core staff, and the paper's own content. ReciterAI's `pipeline_cores` module mines PubMed + reciterdb for these signals and projects a per-(publication, core) usage **candidate** with a combined likelihood. This SPEC covers the SPS-side consumer: the per-core owner's **claim queue** (`/edit/core/[coreId]/review`) where a human confirms or rejects each candidate, and the public surfaces (`/cores/[coreId]`, the publication-detail modal) that read the result.

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

Ownership is **not** a column on `core`. A core owner/curator is a `UnitAdmin(entityType="core", entityId=coreId, role="owner"|"curator")` row — the same RBAC machinery as department/division/center — granted in the UI like any other unit's access: the core editor's Access section and the Administrators roster, both through `POST /api/edit/grant` (#2409; comms_steward access-management parity #2522).

## The signals

### Shown in the SPS queue

`publication_core.likelihood` is one combined 0–1 score, but the queue UI decomposes it into up to five independently-fired signals (`buildSignals()`, `components/edit/core-claim-queue.tsx`). Each signal's **display strength is fixed per kind**, not the model's raw self-score — how much that *category* of evidence should move a reviewer:

| Signal | Source | Strength (fixed) | Raw value shown |
|---|---|---|---|
| **Acknowledgment** (`signalAck`/`ackAlias`/`ackSnippet`) | A core alias matched in the full text | Direct (4 dots) | the matched snippet, quoted |
| **Co-author** (`signalCoauthors`) | Core-staff CWIDs found on the byline | Strong (3 dots) | resolved scholar names + dept, or bare CWID if unresolved |
| **LLM triage** (`llmScore`/`llmRationale`) | 1–10 dense LLM read | Moderate (2 dots) | `{score}/10` + one-line rationale |
| **Repeat-user prior** (`authorAffinity`) | 0–1, from the author's own history of confirmed usage of this core | Weak (1 dot) | percentage |
| **Topical MeSH prior** (`topicalPrior`) | `batch_screen`'s `prefilter_prior` — noisy-OR of author-affinity (0.6) + bare-descriptor MeSH E-tree membership (0.4) | Weak (1 dot) | percentage |

Signals are shown strongest-first. A row can fire 0–5 of them; "Why this surfaced · N of 5 signals fired" is the queue's evidence-count line.

### Topic is a candidate-generation input, and now it's shown

`pipeline_cores` runs two modes. The **deterministic run** (`run.py`) is the source of the first four signals above. A separate **`batch_screen` run-mode** generates the *candidate* queue for everything the deterministic run didn't confirm, and its pre-filter combines two free signals by noisy-OR into a `prefilter_prior` **before** the LLM screen:

1. author-affinity (repeat-user prior) — weight 0.6, outranks the other
2. **bare-descriptor MeSH E-tree membership** — weight 0.4 — a topical hint that the paper carries a MeSH descriptor under that core's technique branch of the tree (e.g. `E01.370.350` Diagnostic Imaging for core 2). This is the closest thing to a "topic match" signal in the pipeline.

Two things temper that: **MeSH qualifiers/subheadings were separately tested and rejected** as a signal (only discriminative for imaging, redundant there, and indexing lag would drop ~half the corpus as a gate) — only bare descriptors survived, and only for the cores with a clean technique branch (imaging, microscopy, flow, sequencing-based cores, MS-based cores; bioinformatics/biorepository/metabolic-phenotyping/microbiome/immune-monitoring have no mapped MeSH branch and rely on author-affinity + the LLM screen alone). **This PR closes the other gap**: `batch_screen`'s DynamoDB write adds `prefilter_prior`/`screen_band`/`screen_confidence` attributes; the ingest mapper (`buildPublicationCoreWrites`, `etl/dynamodb/publication-core-mapper.ts`) now also reads `prefilter_prior` (defensively — absent/unparseable maps to `null`, same as `author_affinity`, and it never participates in a skip guard) and lands it on `publication_core.topical_prior`. The queue UI surfaces it as the fifth "Topical MeSH match" signal above. `screen_band`/`screen_confidence` remain unmapped — a topic-driven candidate can still move the combined `likelihood` via those two fields without any displayed signal firing, so the "No displayed signal fired" empty state is still reachable.

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
- **confirmed** — effective-confirmed (engine `confirmed` OR human `claimed`). `claimed: true/false` on the row tells the UI whether a Revoke should soft-revoke (human claim) or write a `rejected` override (bare engine confirm — there's no claim to revoke). A claim on top of an engine `confirmed` row also takes the `rejected` override (Queue v2 PR B): soft-revoking that claim would leave the engine's own confirmation standing. `revokeStatusFor` in the queue component holds the rule.
- **rejected** — effective-rejected. **Always** human-backed (the engine itself has no rejected state), so `claimed: true` always drives the Rejected tab's "Restore" → soft-revoke.

An engine `below_threshold` row with no claim drops out of all three — invisible until/unless a human claims it directly (there's no UI path to do that today; it would need a claim written outside the queue).

## Authorization

`lib/edit/authz.ts` — `getCoreOwnerRole` + `authorizeCoreClaim`.

```
allow iff  session.isSuperuser
       OR  session.isCommsSteward        (curator parity on cores, #2522)
       OR  UnitAdmin(entityType="core", entityId=coreId, cwid=session.cwid).role
             in { owner, curator }
else 403 "not_core_owner"
```

Cores are **flat** — no dept→division cascade to walk, unlike unit curation. One composite-key lookup. Superuser is granted in `authorizeCoreClaim`, not baked into `getCoreOwnerRole`, so the audit log always records the role the actor actually held (a Superuser reviewing a core they don't own is logged as acting *as* Superuser, not as a phantom owner).

`/edit/core/[coreId]` (the core editor) and `/edit/core/[coreId]/review` (the queue) distinguish 404 ("no such core") from 403 ("core exists, you can't review it") by checking core existence only on the denial path. `/edit/core` (the index) admits Superusers and comms_stewards (#2522; redesigned as the KPI/sortable "Core facilities" table in #2812) — an owner or curator who is neither reaches their core only via the direct deep link; an owner-scoped index is still a known future add.

### Owner vs curator are equal for claiming, unequal for granting

`authorizeCoreClaim` treats `owner` and `curator` identically — either can confirm/reject (correct: reviewing publications is content work, the same "curator parity" `canEditUnit` already gives dept/division/center curators). The *other* half of the Amendment 1 role model is **granting** access. For department/division/center, that split was already load-bearing —

- `canEditUnit` — Superuser OR Owner OR Curator (content parity)
- `canManageAccess` / `canGrant` — Superuser OR Owner **only** ("Curators grant nothing" — the line that stops a Curator from self-granting Owner)

**Built (#2409, cores-as-org-units P2):** cores got the same split by **reusing the existing machinery**, not building a parallel one — `canGrant`/`canManageAccess` already take a bare `EffectiveUnitRole` and don't care which unit kind produced it, and `getCoreOwnerRole` already produces one. The three additive changes, as specified and shipped (#2522 later admitted comms_stewards to `canManageAccess` on every unit kind, cores included):

1. **`POST /api/edit/grant`** — widen the `entityType` check to accept `"core"` alongside `department`/`division`/`center`. Branch two things by kind: the existence check (`db.read.core.findUnique` instead of `findUnit`) and the role lookup (`getCoreOwnerRole` instead of `getEffectiveUnitRole` — cores are flat, so no cascade to apply). `canGrant(session, coreRole, role)` is called exactly as today; **zero changes to the predicate itself**. The `ed_locked` branch is skipped for cores (no ED source ever writes a core grant — `source` is always app-granted). Audit needs nothing new: `target_entity_type='core'` and `action='grant_change'` are both already in the ENUM (added alongside `core_claim`, for the earlier UnitAdmin ENUM widen). Skip `reflectUnitChange` — no public page shows a core's owner/curator list, so there's nothing to revalidate.
2. **`lib/api/administrators-roster.ts`** — widen `AdminRosterGrant.entityType` (currently `"department" | "division" | "center"`) to include `"core"`, with a core-name lookup alongside the existing dept/division/center joins. This is the existing cross-unit "who has access to what" roster (`/edit/administrators`) — it already scopes to "units you own" for a non-superuser Owner, so a core owner sees their core's grants there with no new page.
3. **`AddAdministratorDialog`** — no code change. Its unit picker already takes a generic `AddAdminUnit[]`; the page that renders it just needs cores added to the list it builds (from `getCoreList`).

Net: the RBAC *predicate* layer needs nothing new (`canGrant`/`canManageAccess` are already unit-kind-agnostic); the work is entirely in widening three call sites' `entityType` unions. No schema/migration change — `unit_admin.entity_type` already includes `'core'`.

A grant row for a core, as it renders on the Administrators roster:

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

The scale companion: `{ coreId, pmids: string[], status: "claimed" | "rejected" | "revoked" }`, capped at `MAX_BULK_PMIDS = 500`. Same upsert + audit loop, **one transaction** for the whole batch (not N). Role resolved once (the core dimension is identical for every pmid). Pre-filters pmids already at the target status (idempotent skip, counted in the response).

`revoked` became a bulk action in Queue v2 PR B (owner decision, 2026-09-28): bulk **Revoke** on the Confirmed tab and bulk **Restore** on the Rejected tab, each behind an inline confirm ("Revoke 12 confirmed papers? They return to review. Each gets its own audit row." / "Revoke 12" / "Cancel"). It is the single route's soft revoke looped: each ACTIVE claim gets `revokedBy`/`revokedAt` and its own audit row; a pmid with no active claim is skipped. No publication probe and no engine writeback. A Revoke row that needs the `rejected` override (see above) goes out as a separate `rejected` batch. Single-row Revoke/Restore stay unguarded, with Undo.

Drives the queue's **hand-picked selection bar**: a reviewer arms "Select several" (or "Select N" on an evidence group they're already reading), ticks the rows they mean, and "Confirm all" / "Reject all" posts exactly that set — one click, one request, one transaction, instead of N client-side round-trips. Both buttons disable for the duration and the acting one reads "Confirming…" / "Rejecting…", so a double-click can't post the same batch twice.

It used to drive a **"Confirm N high-confidence"** button instead — every open candidate at `likelihood >= 0.9`, swept in one click. That button and the `HIGH_CONFIDENCE_LIKELIHOOD = 0.9` constant behind it are **gone**. The threshold was never validated against an observed confirm rate, and a threshold sweep decides rows the reviewer never looked at; the selection bar keeps the batching and drops the blind part. "Reject all" — and only "Reject all" — asks for confirmation first. The asymmetry is deliberate: a wrong bulk *confirm* surfaces on the public core page, where someone will eventually notice it, while a wrong bulk *reject* just silently leaves the papers absent with nothing to notice. "Confirm all" is unguarded because the rows are hand-picked and on screen, which was the whole reason for removing the sweep; per-row reject is unguarded too, since that is one visible row and the undo toast offers its Undo right away.

### Manual PMID add — built, extending this same endpoint

An owner who knows a paper used their core — one the engine never scored, or scored `below_threshold` — can paste a block of known PMIDs and claim them directly, independent of the engine queue. No new endpoint: this bulk route now does the work.

**Write path.** One addition on top of the existing route: a `db.read.publication.findMany({ where: { pmid: { in: pmids } }, select: { pmid: true } })` existence check, run alongside the prior-active-claims lookup. A pmid not in that set is returned as a new `notFound: string[]` in the response (alongside the existing `skipped`-already-claimed count) instead of being written — a pmid `core_claim` is FK-less, so nothing at the DB layer would otherwise reject it, and it would then display nowhere (see below). Everything else — the transaction, the audit row, `MAX_BULK_PMIDS = 500` — is unchanged, and the check is a no-op for the selection-bar caller (its pmids come off rows already rendered on screen, so they always already have a `publication` row). `revoked` stays out of scope (single-row-only route, unchanged) — manual add only ever writes `claimed`.

**Read path.** All three consumers (`loadCoreReviewQueue`/`lib/api/core-queue.ts`, `getCorePage`/`lib/api/cores.ts`, `resolvePublicationCores`/`lib/api/publication-detail.ts`) now run a fourth query for `core_claim` rows with no matching `publication_core` row (CLAIMED only — a REJECTED claim with nothing to reject isn't surfaced), joined directly to `Publication` (and `Core`, for the modal) for display fields, and union the result into the same collection handed to the existing partition/select functions — the shape `getMenteesForMentor` (`lib/api/mentoring.ts`) already used to fold `getManualMentees` (`lib/api/manual-layer.ts`) in alongside engine-sourced queries. `core-merge.ts` needed no changes: `effectiveCoreStatus`/`isEffectiveConfirmed` already short-circuit on an active claim before reading engine status, so a manual row's placeholder `status` field is never actually read. New `isManual: boolean` field on `CoreQueueRow`, threaded through so the UI can label the row.

**UI.** An "Add PMIDs" affordance in the owner queue header, alongside "Download CSV" and "Known clients" — a textarea taking a newline/comma/space-separated block (`parsePmidBlock`, client-side parse + de-dupe), posting to the same bulk endpoint with `status: "claimed"`. The result line reports added / already-claimed / not-found-in-SPS, then `router.refresh()`s so the new row's real title/journal/etc. comes from the server (the component has no local data for a pmid it didn't already have in props). Turns out the once-open "likelihood bar" display question resolved itself for free: `partitionCoreQueue` always routes an active `claimed` claim straight to the **Confirmed** tab, which lists it as a `ConfirmedListRow` — it never reaches the candidate-card likelihood-bar rendering at all. A manual row shows a small "Manually added" marker in place of the band (and no signal strip) when `isManual` is set, so the row's missing evidence trail is explained rather than silently absent; it files under the rail's "Added by you" group.

## Send to review — `POST /api/edit/core-queue-add` (Queue v2 PR B)

Add PMIDs has two modes: **Confirm now** (the manual claim above) and **Send to review**. A sent PMID gets a row in `core_queue_add` (`core_id`, `pmid`, `added_by`, `created_at`, UNIQUE `(core_id, pmid)`), not a new `ClaimStatus` value — claim semantics are untouched (decision 1, 2026-09-28). Validation matches the manual add: PMID shape, the 500 cap, the `publication` existence probe (`notFound`), and a `dryRun`. A PMID that already has an active claim or an engine `confirmed` row is `decided`; one already queued or an open engine candidate is `inQueue`; neither is written. One `core_queue_add` audit row per PMID. `core_queue_add` is in `CURATED_TABLES`.

The loader puts an undecided queued PMID (no engine row, or engine `below_threshold`) into `candidates` with `queued: true`, and the queue files it under the unscored **"Added by you"** rail group (no band). Once decided, the claim wins and it files under Confirmed/Rejected like any paper. The `core_queue_add` row is never deleted, so a Revoke, Restore or Undo puts it back under "Added by you".

## Known clients — `POST`/`DELETE /api/edit/core-client` (#2608; name-only #2620)

The "Known clients" button in the queue header opens the core's client list: people the owner knows use the core. Rows live in `core_client` (soft-remove, ETL-immune like `core_claim`, in `CURATED_TABLES`), with `core_client_add` / `core_client_remove` audit actions. Same authz as the claim routes (`authorizeCoreClaim`).

- **CWID clients** (the default POST mode) take a pasted block, re-parsed server-side by `parseCwidBlock`, with names resolved from Scholars and then the enterprise directory. The active CWID list is mirrored to the engine's DynamoDB item by `lib/cores/client-writeback.ts`, behind the same `CORE_CLAIM_WRITEBACK` flag and IAM caveat as claim writeback (see Non-goals).
- **Name-only clients** (`mode: "name"`, `cwid` NULL) are roster-only: they can't match a byline and are never mirrored. They're deduped by a case-insensitive `displayName` check in the route, since the `(coreId, cwid)` unique index can't dedupe NULLs.

The `/edit/core` index shows the split as clients with and without a CWID.

## UI — `/edit/core/[coreId]/review` (owner review queue)

The queue lives on its own `/review` sub-route. `/edit/core/[coreId]` itself is the core's editor (Basics, Leadership, Staff, Access on one scrolling page), which links here from a "Review pending publications" banner.

### Full queue view (default state, no history yet)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Biomedical Imaging — core publications                                       │
│ Publications our signals flag as having used this core. Confirm the          │
│ ones that did and reject false positives — your decisions surface on         │
│ the public profiles and prime the next inference run.                        │
│                                                                              │
│ To review  14              [Download CSV]  [Add PMIDs]  [Known clients 4]    │
│                                                                              │
│ (All) (Acknowledged) (Staff co-author) (LLM-flagged)  Sort: Most certain    │
│                                  [Filter by title, author, journal or PMID…] │
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
│   Moderate  82%                                                              │
│   ################----                                                       │
│                                                                              │
│   Why this surfaced . 3 of 5 signals fired                                   │
│     Named in the acknowledgments                                ****  Direct │
│       "imaging performed at the Citigroup Biomedical Imaging                 │
│        Center core facility"                                                 │
│     Co-authored with Rachel Chen (Pathology)                    ***.  Strong │
│     LLM triage                                                **..  Moderate │
│       Methods section explicitly names core equipment                   8/10 │
├──────────────────────────────────────────────────────────────────────────────┤
│   Comparative analysis of flow cytometry gating strategies for rare          │
│   population detection ... (next card, likelihood 55%, near the              │
│   "uncertain" cutoff the default sort surfaces first)                        │
└──────────────────────────────────────────────────────────────────────────────┘
```

Notes on the mockup: `[Chen R]` in the byline is a tinted, linked chip in the real UI — the co-author signal's staff CWID resolved to a named scholar and overlaid onto the flat `authorsString` by best-effort surname match (`ponytail`-marked in the source: the data carries no per-author byline token, so this mirrors how the profile page overlays author links). The default sort is **"Most certain first"** (the `likelihood` key), not the "Uncertain first" option beside it — the mockup and this note both said otherwise for a while, but the component has defaulted to `likelihood` since before the direction-A rebuild. "Uncertain first" remains available, and is the better setting when the aim is calibration rather than throughput: likelihoods near 50/50 are where a human adds the most.

Checked against the original design artifact (`Core Claim Queue.dc.html`) and brought into parity: the just-decided strip is now color-tinted (green/confirmed, red/rejected — it rendered in flat neutral gray before, including a gray, non-red Rejected icon); a 0-signal candidate now explains itself ("No displayed signal fired — the combined score moved on inputs the queue doesn't label.") instead of silently omitting the evidence list — a real, reachable state per the topical-MeSH-prior note above; Revoked/Restored rows on the Confirmed/Rejected tabs keep title, year, and PMID visible with an added "— re-files on next load" note, instead of the whole line collapsing to just "Revoked — {title}"; and `Publication.synopsis` gets the mockup's light boxed treatment. Not brought into parity: the mockup's "· just now" Confirmed-tab entries are a demo artifact of having no server. A session-decided paper does not move into the Confirmed or Rejected tab until the next page load; it leaves the To review list at once (see **Deciding and undoing** below).

The score reads as the **band word plus the percent** ("Moderate 82%") over a band-coloured meter — Strong ≥ 0.85, Moderate ≥ 0.65, Slight ≥ 0.40, else Weak. Band colours are green, amber, coral and neutral; the same colour tints the score block, draws the list row's left spine (slate instead when the row is focused, none for a paper added by PMID) and fills the rail's dot, which takes the lowest band in that pile. List-row chips are slate for a counted signal, neutral for uncounted context (known client, method tier), and the LLM chip follows the pane's own cut-offs: slate at 8+, amber at 6–7, neutral below. There is no "Combined likelihood" caption any more, and no threshold tick on the meter: with the 0.9 sweep gone (see the bulk write path above), a hairline at 90% would mark a control that no longer exists. The card also no longer carries the **`> Details` disclosure** — the abstract, full author list, WCM byline authors and MeSH chips it held are off the card entirely; the plain-language synopsis, which was never part of it, stays. (`CoreQueueRow` still *loads* `abstract` and `meshTerms`; nothing renders them, and the field docs on the loader say so.)

The **free-text filter** on the controls row narrows the review list on the card's own visible text — title, journal, PMID, synopsis, byline, the resolved WCM/core-staff names, and the acknowledgment alias + quote. It sits with the facet pills rather than in the tab strip because everything that reports its effect is a review-tab control: the "Showing N of M candidates" line, the "Clear filters" link (which drops the text and the pills together; the box's own native clear button drops only the text) and the "Nothing matches this filter." state. It deliberately does *not* search MeSH or method family: the first is no longer on the card and the second was never plumbed into `CoreQueueRow`, and a match a reviewer can't see is worse than a miss.

**Selection bar.** "Select several" (or "Select N" on a group header) puts a checkbox on each card and floats one bar over the queue for as long as anything is ticked:

```
┌──────────────────────────────────────────────────────────────┐
│  3 papers selected  │  [Confirm all]  [Reject all]  │  Clear │
└──────────────────────────────────────────────────────────────┘
```

One request for the whole hand-picked set (`POST /api/edit/core-claim/bulk`), with both buttons disabled and the acting one reading "Confirming…"/"Rejecting…" until it returns. No confirmation dialog: the rows were picked one at a time and are on screen.

**Summary strip (Core publication queue mockup refresh).** Between the tab row and the search box, To review carries a three-part card, computed client-side from rows already loaded (`summarizeOpen`, `reasonTally`):

- **Open candidates by evidence**: the number of open candidates the list shows (after the display floor; a hidden below-floor row is not counted until "Show" brings it in), a stacked bar and legend by evidence group (`buildEvidenceGroups`), and how many carry two or more counted signals. It covers the whole queue, not the rail's current pile.
- **Which signals fired · Click to filter**: per-signal counts off `buildSignals` (so the repeat-user de-dup applies). A click toggles that value in the Filters panel's "Signals fired" facet, the same value `facetValues` emits, so it shows as an ordinary removable filter chip. A signal with no hits is disabled.
- **This session**: confirmed and rejected counts, the reject-reason tally, and "Undo last" (moved here from the tab row). Its footnote says only what the engine reads. The writeback mirrors a decision's status and nothing else, the next run uses confirmed papers only as the repeat-user prior, and reject reasons stay in SPS (claim row and audit row).

Below `lg` the three parts stack in one column.

**Deciding and undoing (Core publication queue mockup refresh).** A decided paper (Confirm, Reject, a reason chip, `a`/`r`, or a bulk action) leaves the To review list at once; it no longer stays on screen marked "Confirmed"/"Rejected" with an Undo beside it. When it was the paper in the pane, the pane moves to the row that slides into its place, or to the new last row when it was at the bottom (`resolveFocusIndex`). An undo toast at the bottom of the screen names the decision ("Rejected · Method match only", "Confirmed 12 papers") with an Undo button and goes away after about five seconds. Undo is the same `undoLast` as `u` and the summary strip's "Undo last", so all three walk back the newest batch, and `u` and "Undo last" still work once the toast is gone. An undone paper returns to the list and the pane. If an undo fails, the paper stays decided and off the list, and the toast says "Undo could not be saved"; its Undo retries. The polite live region still announces each outcome; the toast carries no live region of its own. The tab row shows the real keys inline ("J / K move · A confirm · R reject") beside the Shortcuts popover, desktop only. The mockup's C/X keys were not adopted: `x` stays select/deselect.

### Tabs, once there's history

Once at least one candidate has been confirmed or rejected, the single "To review" heading becomes a 3-way segmented control:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ [ To review  11 ]   Confirmed  6    Rejected  2               [Download CSV] │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Confirmed tab** — three panes, like To review (Core publication queue mockup refresh):

```
┌─────────────────┬───────────────────────────────────┬──────────────────────────────────┐
│ [By evidence|   │ All confirmed                     │ 1 of 36 shown     Previous  Next │
│  By person]     │ [ ] Select all 36 shown  [Revoke] │ Spatial transcriptomics of ...   │
│ All confirmed 36│ ┃ Spatial transcriptomics ... STRONG 99% │ 2026 · PMID 39812345 ↗    │
│ Ack + LLM     14│ ┃ 2026 · PMID 39812345             │ STRONG 99%  ▬▬▬▬▬▬▬   [Revoke] │
│ Staff + LLM    4│ ┃ [Ack][Staff][LLM][Repeat]        │ 2 of 4 signals fired · on the   │
│ LLM read      12│ ┃ Multiplexed imaging ...          │ public core page                │
│ ...             │ ┃ ...                              │ WHY THIS WAS CONFIRMED          │
│ About these     │                                   │ Acknowledgment  "We thank ..."  │
│ signals         │                                   │ Staff co-author Did not fire... │
└─────────────────┴───────────────────────────────────┴──────────────────────────────────┘
```

- **Rail.** "By evidence" groups confirmed papers with the same `buildEvidenceGroups` To review uses (each row's evidence key reads its `withoutOwnPaper` counts, the same ones its strip and pane read); manual adds file under "Added by you". "By person" opens on Everyone and lists every byline author with a confirmed paper here (`buildRailPeople`, holdings as loaded). Counts exclude rows revoked this session. Below `lg` the rail is a select, as on To review. "About these signals" carries the live staff line (`staffTrackedCount` of `staffCount`).
- **List.** Each row has its band word and percent in the band colour (no pill, and no band spine: only the focused row gets the slate spine, as in the mockup) and the four-cell signal strip (`signalStrip`: Ack / Staff / LLM / Repeat, fired cells tinted), plus a quiet "Client co-author" chip when a known client is on the byline. The list sorts "Strongest first" (the `likelihood` key, default) or "Newest" (`year`). The search box, Filters, the selection bar's bulk Revoke and its guard are unchanged.
- **Pane.** "N of 4 signals fired · on the public core page", Revoke (posting what `revokeStatusFor` says), and "Why this was confirmed": all four counted signals off `confirmedEvidence`, the fired ones with their evidence (the acknowledgment quote, the core staff, the LLM score and rationale, the repeat-user sentence) and the rest as "Did not fire: …". Then the uncounted context To review shows: a known client ("Known client · not counted"), the method family (context only) and the topical-prior footnote. The staff and repeat-user rows link to that person under By person. Below `lg` the pane is a full-screen sheet opened by tapping a row; Escape closes it.

**Rejected tab** — same shape, mirrored action:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ x  Retrospective cohort analysis of imaging biomarkers...          [Restore] │
│    2024 . PMID 37102244                                                      │
└──────────────────────────────────────────────────────────────────────────────┘
```

Revoking/restoring keeps the row visible for the session rather than yanking it out of the list immediately — it re-files into the correct tab on next page load. On Confirmed the row stays in the list struck through and marked "Revoked", loses its checkbox, and the pane says "Revoked, re-files on next load" with an Undo; on Rejected the row becomes a one-line "Restored — …" state with its Undo.

### A decided card, mid-session (before the page reloads)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ +  Confirmed   Spatial transcriptomics of the tumor microenvi...      [Undo] │
└──────────────────────────────────────────────────────────────────────────────┘
```

## UI — `/edit/core` (index, Superuser + comms_steward)

The sketch below is the original list; #2812 replaced it with KPI tiles that double as filters and a sortable per-core table (review backlog split high-confidence ≥ 0.8 vs other, confirmed, clients, staff coverage, leaders, owners/curators, public state), loaded by `loadCoreConsoleIndex` (`lib/api/core-console-index.ts`).

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
└──────────────────────────────────────────────────────────────────────────────┘
```

The index (`app/edit/core/page.tsx` → `loadCoreConsoleIndex()`) only ever enumerates real catalog rows — there's no "not yet cataloged" placeholder for a facility missing from `CORE_CATALOG`.

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

The owner queue itself (`/edit/core/*`) has **no flag** — it's gated by authorization only (core owner/curator, Superuser or comms_steward), so an owner can review and claim before either public flag is on.

## ETL ingest (`etl/dynamodb/index.ts` Block 6)

Mirrors the topic-projection block. Two-phase, "populate catalog then guard usage rows":

1. Upsert the `core` table from the version-controlled `CORE_CATALOG` constant.
2. Scan `PUB#{pmid}/CORE#{core_id}` items from the shared `reciterai` DynamoDB table and map them via the pure, unit-tested `buildPublicationCoreWrites` (`etl/dynamodb/publication-core-mapper.ts`), which applies four guards in order and **counts** (never throws on) each skip category:
   - `skippedMissingCore` — `core_id` not in the seeded catalog (FK guard)
   - `skippedMissingFields` — a required scalar (pmid/likelihood/status/scored_at) absent or unparseable
   - `skippedBelowThreshold` — engine scored it but marked `below_threshold` (deliberately not surfaced)
   - `skippedMissingPublication` — pmid not yet in SPS's `publication` table (FK guard)

`publication_core` is a **full wholesale rebuild** every run — it carries no human decision, so clobbering it nightly is safe by construction. `core_claim` is a completely separate table the ETL never touches. The mapper's field list is a strict subset of what the engine can write (see "Topic is a candidate-generation input, and now it's shown" above) — extending it is a mapper + Prisma-column change, not a re-architecture.

## Adding a core

Both sides need an entry before a core is reviewable, in this order:

1. **ReciterAI:** an entry in `config/core_dictionary.yaml` — `core_id`, name, facility, aliases (signal 3), staff CWIDs (signal 2), and an LLM description (signal 4/topical routing). This is "the project's real IP" per the dictionary's own header comment; a core with no resolved staff still seeds a row and just won't fire signal 2.
2. **SPS:** the matching entry in `CORE_CATALOG` (`etl/dynamodb/core-catalog.ts`), same `core_id`. The next ETL run upserts the `core` table row; `publication_core` rows for that core start landing once `pipeline_cores` has scored it.
3. A `UnitAdmin(entityType="core", entityId=coreId, role="owner")` row, granting whoever will review the queue — through the core editor's Access section or the Administrators roster.

**Research Informatics went through exactly this path: it is core 14** (`CORE_CATALOG` in `etl/dynamodb/core-catalog.ts`, with a resolved `core_dictionary.yaml` entry; owners backfilled by `scripts/backfills/2026-08-14-core-14-research-informatics-owners.ts`). It is a different thing from the "Research Informatics" cross-account grants-data consumer elsewhere in this codebase (`RESEARCH_INFORMATICS_TOKEN`, #2363/#2364). A catalog core with no dictionary entry yet (15 and 16 today, see the `core-catalog.ts` header) seeds its `core` row but gets no usage rows, because the dictionary loader raises on a core with no aliases.

## Non-goals / open gaps

- ~~No admin write-UI for granting core ownership~~ — **built** (#2409, #2522): see "Owner vs curator" above.
- **No note-entry UI** — the single-claim API accepts an optional `note` (≤2000 chars, stored on `core_claim`), but the queue component never collects one; every UI-driven claim writes `note: null`. The field exists for the schema/API and a future direct-write use case.
- **Owner-scoped `/edit/core` index doesn't exist yet** — `/edit/core` admits Superusers and comms_stewards only; any other owner or curator reaches their core only via the deep link `/edit/core/[coreId]`.
- **`/cores` index presence check is engine-status-only** (see the public-index note above) — can under-list a core whose only confirmed usage is a pure human override.
- **`CORE_CLAIM_WRITEBACK` needs a DynamoDB write IAM grant** SPS doesn't have yet (SPS has only ever *read* the `reciterai` table before this feature) — dormant until that's provisioned, same posture `lib/reciter/client.ts` documents for its own dormant-safe writes.
- **A `below_threshold` row can never be claimed today** — there's no UI path that lets an owner promote an engine-suppressed candidate directly (the merge logic supports it; nothing writes it).
- ~~No way to manually claim a PMID the engine hasn't scored at all~~ — **built** ("Manual PMID add" above): an owner can paste a block of known PMIDs and claim them directly, independent of the engine queue. Merged in #2393.
- ~~The topical MeSH prior isn't a labeled signal in SPS~~ — **built** ("Topic is a candidate-generation input, and now it's shown" above): `prefilter_prior` is mapped through as `publication_core.topical_prior` and surfaced as the fifth "Topical MeSH match" signal. `screen_band`/`screen_confidence` remain unmapped, so a 0-displayed-signal candidate is still reachable.
- **Every new core needs a coordinated two-repo change** (see "Adding a core" above) — there's no SPS-side self-service path; a facility needs ReciterAI's dictionary entry before it gets usage rows.

## Interfaces and dependencies

- **Upstream:** ReciterAI's `pipeline_cores` module (PR #245), writing `PUB#{pmid}/CORE#{core_id}` items to the shared `reciterai` DynamoDB table, keyed the same way the topic pipeline is. Two run-modes: the deterministic `run.py` (the first four SPS-visible signals) and the `batch_screen` candidate generator (adds the topical MeSH prior — now the fifth SPS-visible signal — plus `screen_band`/`screen_confidence`, still not mapped).
- **Downstream (this feature writes back to):** the same DynamoDB table, gated behind `CORE_CLAIM_WRITEBACK`, feeding the engine's `authorAffinity` prior on its next run.
- **RBAC:** `UnitAdmin(entityType="core")`, the same table department/division/center ownership uses; `canGrant`/`canManageAccess` (`lib/edit/authz.ts`) are already unit-kind-agnostic and need no change to cover cores (see "Owner vs curator" above).
- **Audit:** `core_claim` action + `core` target-entity-type, registered in all four required sites (`lib/edit/audit.ts` + the three `scripts/sql/audit-log.sql` ENUM sites) — verified present.
- **Manual-override pattern:** ADR-005, same shape as `field_override`/`suppression`, keyed on `(pmid, coreId)` instead of an entity id.
