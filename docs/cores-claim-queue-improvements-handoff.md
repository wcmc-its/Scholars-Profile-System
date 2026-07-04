# Handoff — Core pub-claiming queue usability (Tiers 1–3)

**Date:** 2026-06-22 · **Status:** ready to implement (not started) · **Scope:** the owner
review queue at `/edit/core/[coreId]` and its loader. No engine or schema changes for Tier 1–2;
one small route addition for Tier 3 undo.

Companion reference: `docs/cores.md` (how the whole feature works).

---

## Goal

Make the core-publication claiming queue more usable: clearer **why** each publication was
suggested, more context on the **researchers** and the **publication**, and faster/safer
**accept/reject**. The engine already computes rich evidence — most of Tier 1 is surfacing data
that's stored but not loaded.

## Current state

- **Queue page:** `app/edit/core/[coreId]/page.tsx` (auth-gated: superuser / core owner / curator).
- **Component:** `components/edit/core-claim-queue.tsx` (client; optimistic Confirm/Reject).
- **Loader + row shape:** `lib/api/core-queue.ts` (`loadCoreReviewQueue`, `CoreQueueRow`,
  pure `partitionCoreQueue`).
- **Decision API:** `POST /api/edit/core-claim` (`status: "claimed" | "rejected"`, optional `note`).
- **Status merge:** `lib/api/core-merge.ts` (engine status read-merged with `CoreClaim`).

The card today shows: title, journal·year, truncated authors, Confirm/Reject, four evidence chips
(likelihood %, "Named: <alias>", "N core-staff co-authors", "LLM N/10"), and the ack snippet.

## Available data (grounded)

`publication_core` (Prisma `PublicationCore`) — already stored, **not all loaded** into `CoreQueueRow`:

| Field | In `CoreQueueRow`? | Signal |
|---|---|---|
| `likelihood` (0–1) | ✅ | combined |
| `status` | ✅ | engine band |
| `authorAffinity` (Decimal 0–1) | ❌ | S1 repeat-user prior |
| `signalCoauthors` (JSON CWID[]) | ✅ as `coauthors` (CWIDs only) | S2 core-staff byline |
| `signalAck` (bool) / `ackAlias` / `ackSnippet` | partial (`ackAlias`,`ackSnippet`) | S3 full-text ack |
| `llmScore` (1–10) | ✅ | S4 dense triage |
| `llmRationale` (Text) | ❌ | S4 plain-language reason |
| `scoredAt` | ❌ | provenance |

`Publication` — joinable, mostly unshown: `abstract`, `synopsis`, `citationCount`,
`relativeCitationRatio`, `nihPercentile`, `pubmedUrl`, `doi`, `pmcid`, `fullAuthorsString`,
`meshTerms` (JSON), `volume`/`issue`/`pages`, `journalAbbrev`.

`Scholar` (keyed by `cwid`): `preferredName`, `fullName`, `primaryTitle`, `primaryDepartment` —
resolve co-author CWIDs to named, linkable researchers via
`db.read.scholar.findMany({ where: { cwid: { in: [...] } }, select: { cwid, preferredName, primaryTitle, primaryDepartment } })`
(pattern in `lib/api/data-quality.ts`).

`CoreClaim`: has **`revokedBy` / `revokedAt`** soft-revoke fields — read-merge reverts a revoked
claim to the engine status. The route does **not** expose revoke yet (`isClaimStatus` accepts only
`claimed`/`rejected`).

---

## Tier 1 — surface the reasons we already computed (low effort, high value)

Goal: the reviewer sees *why*, not just an opaque %.

**`lib/api/core-queue.ts`**
- Add to `CoreQueueRow`: `llmRationale: string | null`, `authorAffinity: number | null`,
  `signalAck: boolean`, `citationCount: number`, `pubmedUrl: string | null`, `doi: string | null`.
- Extend the `findMany` select: add `llmRationale`, `authorAffinity`, `signalAck`, and on
  `publication` add `citationCount`, `pubmedUrl`, `doi`. Map them through (coerce `authorAffinity`
  with `Number()` like `likelihood`).

**`components/edit/core-claim-queue.tsx`**
- Render `llmRationale` prominently (it's the human-readable "why" — give it a line, not a chip).
- Replace the single likelihood chip with a **per-signal breakdown**: show which of the 4 fired —
  S1 affinity (`authorAffinity` as %), S2 co-authors (count, becomes names in Tier 2),
  S3 ack (`ackAlias` + snippet, already there), S4 `llmScore`. Keep the combined % as the headline.
- Add **PubMed** and **DOI** links (open in new tab) + `citationCount`.

No schema/route/engine change. Loader + component only.

## Tier 2 — researcher + publication context (medium effort, joins)

**Researchers**
- Resolve `signalCoauthors` CWIDs → names/title/dept via `Scholar` (one `findMany`, batched across
  the queue in the loader — collect all CWIDs, resolve once, attach to each row). Render
  *"Co-authored with **Jenny Xiang** (Genomics Resources)"* with a profile link
  (`/{slug}` or the scholar route). **Fallback:** core staff not in `Scholar` (some aren't ReCiter
  targets) show the CWID — note this; the engine's `core_dictionary.yaml` has staff names if you
  want a richer fallback later.
- Optionally flag which byline authors are **WCM scholars** (potential users) via
  `PublicationAuthor → Scholar`; link them.

**Publication**
- **Abstract** (`abstract`) behind an expander (collapsed by default). Add `abstract` + `synopsis`
  to the select + row.
- `synopsis` one-liner if present; `meshTerms` as topic chips (optional).
- Full author list (`fullAuthorsString`) in the expander vs. the truncated `authorsString`.

Loader gains a name-resolution step; component gains an expandable detail section. Still no
schema/route change.

## Tier 3 — accept/reject UX (medium effort; one route addition)

- **Undo.** After a decision, allow reverting. The model supports it via soft-revoke
  (`CoreClaim.revokedAt` → read-merge falls back to engine status). Implementation:
  extend `POST /api/edit/core-claim` to accept a revoke action (e.g. `status: "revoked"` or an
  explicit `{ action: "revoke" }`) that sets `revokedAt`/`revokedBy` instead of upserting a
  decision; `core-merge.ts` already treats a revoked claim as "no claim." Component: keep the just-
  decided row visible with an "Undo" affordance for the session.
- **Keyboard shortcuts:** `a` accept / `r` reject / `u` undo on the focused card; roving focus down
  the list. Big win for long queues.
- **Sort/filter:** sort candidates by likelihood (default) or by which signal fired; a filter to
  show only ack-matched or only co-authored, etc.
- (Optional, future) bulk-confirm the high-confidence band — defer unless asked.

---

## Cross-cutting constraints

- **Auth-gated surface only.** `llmRationale`, `authorAffinity`, co-author CWIDs/names, and ack
  snippets are *internal evidence* — they must never reach the public `/cores` pages
  (`lib/api/cores.ts` deliberately omits them; keep it that way). Tier 1–3 touch only the
  `/edit/core` loader/component + the claim route.
- **No new flag.** The queue is auth-gated, not flag-gated (unchanged).
- **`Decimal` coercion:** `authorAffinity` / `likelihood` are Prisma `Decimal` — `Number()` them in
  the loader (as `likelihood` already is).
- **Batch the name resolution** in the loader (one `findMany` for all rows' CWIDs), not per-row.

## Tests

- `tests/unit/core-queue.test.ts` — extend `partitionCoreQueue` / add a loader-mapping test for the
  new fields (mirror the existing injected-reader pattern in `tests/unit/core-page.test.ts`).
- `tests/unit/core-claim-queue.test.tsx` — assert the rationale + per-signal breakdown render; the
  PubMed/DOI links; the abstract expander; (Tier 3) the undo action posts the revoke.
- `tests/unit/core-claim-authz.test.ts` — if the route gains a revoke action, cover its authz
  (same owner/curator/superuser gate as claim).

## Suggested sequencing & effort

1. **Tier 1** — loader select + row fields + render (rationale, signal breakdown, links). ~½ day.
2. **Tier 2** — name resolution join + abstract expander. ~1 day.
3. **Tier 3** — route revoke action + undo + keyboard + sort/filter. ~1–1.5 days.

Ship Tier 1 first (own PR) — it's the cheap high-impact "show the reasons." Tier 2 and 3 can each be
their own PR.

## Open questions (confirm before building)

- **Card layout / mockup?** Default plan mirrors the existing evidence-chip + `coi-gap-card`
  pattern. Provide a mockup if you want a specific layout.
- **Undo API shape:** `status: "revoked"` vs `{ action: "revoke" }` — pick one (revoked is simplest
  given `ClaimStatus`/`revokedAt` already exist).
- **WCM-author highlighting (Tier 2):** include now or defer? Adds a second join.
- **MeSH topic chips:** wanted, or noise on this surface?
