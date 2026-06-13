# COI-gap suggestion feedback — research-grade 3-way capture

**Status:** DRAFT — awaiting approval. No code written.
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
- **Panel surfacing (changed):** `lib/api/edit-context.ts` now surfaces only
  `status='new'` (was `new` + `acknowledged`). Any recorded feedback — `acknowledged`
  (will disclose) *or* `dismissed` — therefore stops nagging by dropping off the panel,
  while the row stays in the table for the ETL/reconcile and research. No current effect:
  nothing set `acknowledged` before this change.
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
- **After a choice:** the row collapses to "<entity> — <recorded reason>" (e.g.
  "Historically true, not currently valid") + **"Undo"**. Undo → `/restore`, clears the
  reason, re-expands the three choices.
- **Superuser mode:** unchanged "nag" confirmation before the write; audit records the
  real admin.
- **Governance chips:** unchanged — and note "I intend to update my COI statement" is
  phrased as the scholar's *intent*, never a compliance commitment the system tracks.

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
| UI | three labelled choices render in `self` and `superuser` modes; chosen-state names the reason; Undo re-expands; source sentence always present |
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
