# COI-gap suggestion feedback — research-grade 3-way capture

**Status:** Implemented — shipped #944 (3-way feedback) + #953 (Medium expander + Reviewed history with change-of-mind + tier partitioning). Dark behind `SELF_EDIT_COI_GAP_HINT`. This spec already reflects the #953 surface (§5a) and the superseded-but-retained `/dismiss` route (§4). (Spec reconciled to shipped code 2026-06-14, #990.)
**Scope decision (locked):** *pure signal* — feedback is recorded and stops the
nag; it triggers no workflow, reminders, or Weill Research Gateway hand-off.
**Flag:** ships behind the existing `SELF_EDIT_COI_GAP_HINT` (still **dark**). The
reason capture is inert until the panel goes live, so the research dataset starts
clean at launch.

---

## 1. Goal

Replace the current binary "Not relevant" dismissal on the publication-derived
COI-gap panel with a **3-way reason-coded response**, so the scholar's adjudication
of each suggestion is captured well enough to support a methods/validation paper.

The three choices and what they encode:

| UI label (scholar sees) | `status` | `feedbackReason` | Research meaning |
|---|---|---|---|
| **I intend to update my COI statement** | `acknowledged` | `will_disclose` | true positive, actionable |
| **Historically true but not currently valid** | `dismissed` | `historical` | true positive, temporally stale |
| **Not a valid suggestion** | `dismissed` | `invalid` | **false positive** (model error) |

Why the middle row matters: today both "stale-but-real" and "model-is-wrong" collapse
into one `dismissed` bucket, which makes any **precision** estimate uninterpretable.
Splitting them yields:

- **Extraction precision** = `(will_disclose + historical) / all_reviewed`
- **Currency rate** = `will_disclose / (will_disclose + historical)`

`will_disclose` maps to the pre-existing `acknowledged` status (which exists in the
type today but has **no UI** — `lib/coi-gap/lifecycle.ts:17`), so the gap closes
itself as `resolved` once the scholar actually discloses — no separate tracking.

## 2. Current state (verified)

- **Model:** `CoiGapCandidate` (`prisma/schema.prisma:1084`) — `status` is a free
  `VARCHAR(16)` (`new | acknowledged | dismissed | resolved`), validated app-side
  only (`lib/coi-gap/lifecycle.ts:17`), plus `reviewedAt`. **No reason field.**
- **Write paths:** `POST /api/edit/coi-gap/[id]/dismiss` (→ `dismissed`) and
  `POST /api/edit/coi-gap/[id]/restore` (→ `new`). Each writes status + `reviewedAt`
  and one B03 audit row (`coi_gap_dismiss` / `coi_gap_restore`) in a single tx.
- **UI:** `components/edit/coi-gap-card.tsx` — buttons **"Not relevant"** (dismiss),
  **"Undo"** (restore), **"Review in Gateway"**. Governance chips: *"Not a compliance
  judgement"*, *"Managed in the Gateway, never here"*. Modes: `self` / `superuser`
  (superuser sees a confirmation "nag" before acting).
- **Lifecycle:** `reconcileCandidates` preserves `acknowledged`/`dismissed`, never
  re-nags `dismissed`, resolves `new`/`acknowledged` gaps that disappear
  (`lib/coi-gap/lifecycle.ts:54`).
- **Authz (unchanged):** genuine self OR genuine (non-impersonating) superuser; a
  "View as" overlay never confers write (IS-1).

## 3. Data model change

Add one nullable column — no change to `status` semantics or reconcile rules:

```prisma
model CoiGapCandidate {
  ...
  /// Scholar's reason, captured alongside a terminal feedback action. Null for
  /// system states (new/resolved) and until the scholar responds.
  /// will_disclose → status=acknowledged; historical|invalid → status=dismissed.
  feedbackReason String? @map("feedback_reason") @db.VarChar(24)
  ...
}
```

- **Migration:** additive, nullable, **no backfill** (feature dark → table is
  effectively empty of scholar-acted rows). One forward migration only.
- **Validation:** app-side enum `"will_disclose" | "historical" | "invalid"` in a new
  `lib/coi-gap/feedback.ts` (mirrors how `CandidateStatus` is typed today). No DB
  CHECK constraint, consistent with `status`.
- **ETL preservation:** the daily `etl:coi-gap` upsert already excludes
  `feedbackReason` from its `update` payload (it lists explicit columns + `status`), so a
  recorded reason survives reruns — no ETL change needed.
- **Panel surfacing (changed):** `lib/api/edit-context.ts` partitions acted vs.
  unacted relationships rather than dropping every acted row. An active suggestion
  (any `status='new'` source) keeps nagging; a fully-acted relationship moves to a
  settled **Reviewed** view instead of vanishing (see §5a). The active list still
  never nags on an acted row, and every row stays in the table for the
  ETL/reconcile and research. No current effect: nothing set `acknowledged` before
  this change.
- **Audit (changed):** the `action` ENUM gains `coi_gap_feedback` — TS `AuditAction`
  (`lib/edit/audit.ts`) **and** the MySQL ENUM in `scripts/sql/audit-log.sql`, appended
  LAST to preserve ordinals. The operator applies the idempotent `MODIFY COLUMN` before
  enabling the flag, exactly as `coi_gap_dismiss` was added.

## 4. API

**Replace** the single-purpose `/dismiss` route with one feedback route (clean, since
the feature never shipped — no clients to break):

```
POST /api/edit/coi-gap/[id]/feedback
body: { "reason": "will_disclose" | "historical" | "invalid" }
```

- Maps reason → `(status, feedbackReason)` per the §1 table; writes `reviewedAt=now`.
- Same authz, same `503` dormancy ordering, same `404`/`403`/`400` precedence as the
  current dismiss route (`app/api/edit/coi-gap/[id]/dismiss/route.ts`). Add `400
  invalid_reason` when `reason` is absent/unrecognised.
- **Idempotency:** if the candidate already holds the requested `(status, reason)`,
  return `{ ok, status, reason, unchanged: true }` without re-writing.
- **Re-feedback (change of mind):** a different valid reason overwrites
  `status`+`feedbackReason`+`reviewedAt` (one audit row records before→after).
- One B03 audit row, action `coi_gap_feedback`, `fieldsChanged: ["status",
  "feedbackReason"]`, before/after carrying both fields.

**`/restore` stays**, extended to clear `feedbackReason` to `null` and to also undo an
`acknowledged` (will-disclose), not just a `dismissed`.
**`/dismiss` is superseded** by `/feedback` — the UI no longer calls it. The route and its
test are left in place (dark, unused) for a trivial follow-up deletion; nothing references
it, so it cannot fire. (Deletion was deferred only because the build tooling here can't
remove files.)

## 5. UI (`coi-gap-card.tsx`)

Replace the lone "Not relevant" button with the three labelled choices, presented as
**equal, neutral options** (no default emphasis / no primary styling) so the response
isn't nudged — `historical` vs `invalid` is only an honest precision signal if the
scholar isn't steered. Keep "Review in Gateway" in the rail.

- **Active card:** verbatim `sourceSentence` blockquote stays *always visible* (the
  non-negotiable "human adjudicates, not the score" rule), tier chip, PMID link, then the
  three choice buttons (below the sources) + "Review in Gateway" (in the rail).
- **After a choice:** the active row stops nagging; the relationship reappears, settled,
  in the **Reviewed** view (§5a) as "<entity> — <recorded reason>" (e.g. "Historically
  true, not currently valid") with **"Undo"** and **"Change response"**. Undo →
  `/restore`, clears the reason; the relationship returns to the active list on the next
  load (and shows a "Moved back to your review." confirmation in place until then).
- **Superuser mode:** unchanged "nag" confirmation before the write; audit records the
  real admin.
- **Governance chips:** unchanged — and note "I intend to update my COI statement" is
  phrased as the scholar's *intent*, never a compliance commitment the system tracks.

## 5a. Two added surfaces — lower-confidence matches & Reviewed

The original panel showed exactly one list: active **High**-tier suggestions, with every
acted row dropping off. That left two things invisible — the weaker **Medium**-tier
matches the model also found, and the scholar's own prior decisions — so a scholar who
acted on a suggestion could never see, revisit, or change it. Two surfaces close that,
both still **dark** behind `SELF_EDIT_COI_GAP_HINT`.

### The active / lower / reviewed partition

`lib/api/edit-context.ts` now reads `status ∈ {new, acknowledged, dismissed}` (still
excluding `resolved`) and groups each relationship by normalized entity, then classifies
the **whole group** by whether it still has any unacted source:

| Group has… | Goes to | Surface |
|---|---|---|
| ≥1 `new` source, ≥1 High | `unmatchedPubmedCoi` | active **High** list (unchanged) |
| ≥1 `new` source, all Medium | `unmatchedPubmedCoiLower` | lower-confidence expander |
| no `new` source (every source acted) | `unmatchedPubmedCoiReviewed` | **Reviewed** view |

**Partition rule (the invariant):** *any `new` source ⇒ the relationship is **active**,
never in Reviewed.* A relationship that has both a fresh source and earlier acted sources
shows once, in the active list, on its new sources only — its acted sources are not
re-shown. This guarantees a relationship is never in two lists at once, and that acting
on the last unacted source is what moves it to Reviewed.

### Lower-confidence matches (Medium tier)

Medium-tier matches are now shown — but deliberately demoted. Below the High list, a
**native, collapsed** `<details>` expander labelled "Show *n* lower-confidence match(es)"
holds the active Medium groups, with one muted caveat: *"These are weaker matches —
often a co-author's disclosure rather than your own."* Inside, each row uses the **same**
active-row markup as the High list (tier chip — the green "Likely covered" — verbatim
source sentence(s), PMID, the same three choice buttons, Undo, "Review in Gateway"), so a
scholar can adjudicate a Medium match exactly as a High one. Medium is opt-in by being
collapsed and never auto-expanded; it does not nag.

### Reviewed (current-state, change-of-mind)

Below the Medium expander, a **collapsed** `<details>` labelled "Reviewed (*n*)" shows
every fully-acted relationship, presented as **settled history** — no amber, no "worth
reviewing", nothing that nags. Each row shows the entity (verbatim), the recorded reason
label, and the action date (`reviewedAt`), plus two affordances:

- **Change response** — re-opens the three choice buttons inline; picking a different one
  re-records via `/feedback` and updates the label in place (the relationship stays in
  Reviewed).
- **Undo** — `/restore`, which clears the reason and returns the relationship to the
  active list on the next load; the row shows "Moved back to your review." in place until
  then.

Both affordances route through the **same superuser "nag" confirmation** as the active
list (IS-1 authz is unchanged: genuine self or genuine non-impersonating superuser).

### Rail gating

- **Item visibility:** the COI-gap rail item appears when **High-active > 0 OR
  reviewed > 0**. A scholar with only reviewed history (no live suggestions) still gets
  the item, so they can find and revisit past decisions. A relationship that is
  **Medium-only** (lower-confidence, nothing High-active, nothing reviewed) does **not**
  surface the item — weak matches never demand attention.
- **Badge count:** the numeric badge counts **High-active only** (`unmatchedPubmedCoi`),
  coerced so a count of 0 shows no badge. Medium and Reviewed counts live in their own
  expander/section labels, not the badge — the badge means "things actively worth a look".

### Governance — what crosses to the client

The Reviewed view is the **only** new place server-derived fields reach the browser, and
the surface is tightly bounded:

- **`feedbackReason` crosses only** mapped into a Reviewed row's `reason` (the
  scholar's *own* recorded choice — `will_disclose` is derived for an `acknowledged`
  row that predates the reason column), rendered as the existing human label.
- **`reviewedAt` crosses only** into a Reviewed row's `reviewedAt` (the scholar's own
  action date, governance-allowed). It is also used server-side to order the list; the
  ordering key (`newestTs`) is never displayed.
- **Still starved (never cross):** the numeric entity score, `attribution`, `category`,
  and lifecycle `status`. The active and lower lists carry no reason and no date at all.
- The verbatim `sourceSentence` of every source is **always** rendered (active, lower,
  and Reviewed alike), and confidence is shown only as the qualitative tier chip — never
  a number or percentage. None of the added copy uses the forbidden accusatory vocabulary
  ("undisclosed", "failed to disclose", "missing", "violation", "gap").

## 6. Research export

The candidate table is self-contained for the dataset; the B03 audit table gives the
action timeline if reviewer latency is needed. Runnable aggregate (precision/currency):

```sql
SELECT
  COUNT(*)                                                   AS reviewed,
  SUM(status='acknowledged')                                 AS will_disclose,
  SUM(feedback_reason='historical')                          AS historical,
  SUM(feedback_reason='invalid')                             AS invalid,
  ROUND( (SUM(status='acknowledged') + SUM(feedback_reason='historical'))
         / NULLIF(COUNT(*),0), 3)                            AS extraction_precision,
  ROUND( SUM(status='acknowledged')
         / NULLIF(SUM(status='acknowledged')+SUM(feedback_reason='historical'),0), 3)
                                                             AS currency_rate
FROM coi_gap_candidate
WHERE feedback_reason IS NOT NULL OR status='acknowledged';
```

Dialect: MariaDB/MySQL (the `SUM(<predicate>)` boolean idiom). The `OR status='acknowledged'` in the WHERE is intentional, not redundant — it also catches `acknowledged` rows written before the `feedback_reason` column existed (NULL reason).

Stratify by `tier` / `attribution` / `entity_score` for the model-quality breakdown.

## 7. IRB / consent — decided: not required

Operator decision (2026-06-12): **no IRB determination is required** for this use.
No consent surface or research-notice line is added to the panel; the governance
chips (§5) are unchanged. The export (§6) stays an internal operator query.

## 8. Test plan (vitest)

| Area | Cases |
|---|---|
| `/feedback` route | each valid reason → correct `(status, reason)` + `reviewedAt`; missing/garbage reason → `400 invalid_reason`; absent flag → `503` after authz; non-self non-superuser → `403`; impersonating superuser → `403`; missing id → `404`; idempotent same reason → `unchanged:true`; change-of-mind overwrites + single audit row |
| `/restore` | clears `feedbackReason` to null and status to `new`; audit row |
| lifecycle | `reconcileCandidates` unchanged; **ETL upsert preserves `feedback_reason`** on an existing acted row (regression guard) |
| UI | three labelled choices render in `self` and `superuser` modes; source sentence always present; acting moves the relationship to **Reviewed** (named reason + date), Undo returns it ("Moved back to your review."), Change-response re-records in place |
| surfaces | Medium-only active groups appear only in the collapsed lower-confidence expander; a relationship with any `new` source is **active, never in Reviewed** (partition invariant); a fully-acted group renders in Reviewed with its newest derivable reason + `reviewedAt` |
| rail | item visible when High-active>0 OR reviewed>0; Medium-only does **not** surface the item; badge counts High-active only and shows nothing at 0 |
| governance | active/lower lists carry no reason/date; only Reviewed rows carry `reason` + `reviewedAt`; score/status/attribution/category never reach the client; no forbidden vocabulary in added copy |
| audit | `coi_gap_feedback` row carries both fields in before/after |

## 9. Rollout

No flag change. Ships **dark** behind `SELF_EDIT_COI_GAP_HINT`; the column + routes + UI
are inert until the panel is enabled for scholars. When it goes live, the dataset accrues
clean from day one. The `feedback_reason` migration runs via the normal CD path on merge to
master (staging first). **One operator step before enabling the flag:** apply the
idempotent `action`-ENUM extension in `scripts/sql/audit-log.sql` (it's a no-op if already
extended) so `coi_gap_feedback` writes are accepted — exactly as `coi_gap_dismiss` was
added under this same flag. (The route 503s while dark, so order isn't safety-critical, but
the ENUM must be in place before any real write.)

## 10. Out of scope (explicit)

- Any reminder, to-disclose list, or Gateway hand-off for `will_disclose` (the *pure
  signal* decision — revisit as a separate project if wanted).
- Re-nag tuning, tier thresholds, or matching-quality changes (separate workstream).
- Backfill / historical reconstruction of pre-feature dismissals (none exist — dark).
