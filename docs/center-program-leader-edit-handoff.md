# Center program — leader & description edit UI (handoff)

**Issue:** #1117 (follow-up to #1105 / PR #1111)
**Status:** spec / handoff — not yet implemented
**Flag:** ships under the existing `CENTER_PROGRAM_PAGES` (staging-on, prod-off)

---

## TL;DR

#1105 made each center program a first-class page (`/centers/[slug]/programs/[code]`)
that renders a **program leader** (`LeaderCard`) and a **description**. The
read-side is done and live on staging. What's missing is the **edit UI + write
path** to *set* those fields — today `CenterProgram.leaderCwid`,
`leaderInterim`, and `description` are populated only by backfill (mirroring how
`Center.directorCwid` and external leaders are seeded). This handoff specs the
in-app editor so a center Owner/Curator can curate them without a backfill.

This is a small, well-scoped extension: the schema columns already exist, the
center editor already loads the program taxonomy, and `/api/edit/unit op:"update"`
already does exactly this shape for the **center itself** (`directorCwid` /
`leaderInterim` / `description`). The job is to mirror that pattern one level
down, for each program.

---

## Current state (origin/master)

- **Schema (done, #1111):** `CenterProgram` has `leaderCwid String?`,
  `leaderInterim Boolean @default(false)`, `description String? @db.Text`
  (`prisma/schema.prisma`). Migration `20260618120000_center_program_pages`
  applied to staging by the CD `migrate` step.
- **Read-side (done, #1111):** `getCenterProgram()` (`lib/api/centers.ts`)
  resolves the leader (`leaderCwid` → WCM scholar, else the `external-leaders.ts`
  fallback keyed `<centerCode>:<programCode>`) + description, and
  `components/center-program/program-page.tsx` renders them via `LeaderCard`.
- **Edit surface today:** the center editor (`/edit/center/[code]` →
  `components/edit/unit-edit-page.tsx` → `CenterRosterCard`) lets an editor set
  each **member's** `membershipType` (Research/Clinical) + `programCode` via the
  per-row dropdowns (`components/edit/center-roster-card.tsx`, `hasPrograms`
  gate; writes through `POST /api/edit/roster`). The program **taxonomy**
  (`ctx.programs` = `{code,label,sortOrder}[]`) is passed in
  (`unit-edit-page.tsx:184` `programs={ctx.programs ?? []}`), but there is **no
  per-program editor** — nothing writes `CenterProgram.leaderCwid` /
  `leaderInterim` / `description`.
- **The mirror pattern:** `POST /api/edit/unit` `op:"update"`
  (`app/api/edit/unit/route.ts`) updates a `Center` **in row** (centers don't use
  `field_override`), with **field-level authz**: `description` / `url` /
  `directorCwid` / `leaderInterim` are **Owner/Curator-editable**; `slug` /
  `centerType` are Superuser-only. Every write is one MySQL transaction with a
  B03 audit row via `appendAuditRow` (`@/lib/edit/audit`). **This is the
  template to copy for programs.**

## The gap

No UI or API to set a program's `leaderCwid` / `leaderInterim` / `description`.

---

## Proposed implementation

### 1. Load the editable program fields

`lib/api/unit-edit-context.ts` — extend the `programs` projection (currently
`{ code, label, sortOrder }`, ~line 125 / 329–349) to also select
`leaderCwid`, `leaderInterim`, `description`. Resolve `leaderCwid` to a display
name for the UI (a `scholar.findMany` over the non-null leader cwids, like the
center director resolution), so the editor can show "Jane Smith" next to the
CWID input. Add the resolved fields to the `UnitEditContext.programs` type.

### 2. Write path — extend `/api/edit/unit`

Add a program-scoped update to `app/api/edit/unit/route.ts`. Two viable shapes
(pick one; **A is recommended** for cohesion with the existing center update):

- **A. New op `op:"update-program"`** on the same route. Body:
  `{ unitType:"center", code /* center code */, programCode, fields: { leaderCwid?, leaderInterim?, description? } }`.
- **B.** A sibling route `app/api/edit/center-program/route.ts`.

Either way:
- **Authz:** resolve the actor's effective role on the center via
  `getEffectiveUnitRole({ kind:"center", code })` (same helper the center update
  uses); require **Owner / Curator** (or Superuser). 403 otherwise. All three
  fields are Owner/Curator-editable (no Superuser-only fields here — a program
  leader/description is curation, not governance).
- **Write:** `prisma.centerProgram.update({ where: { centerCode_code: { centerCode: code, code: programCode } }, data: { ... } })` inside **one transaction** with the B03 audit row (`appendAuditRow`, new `action:"program_update"`, `target_entity_type` for the program, `actor_cwid = realCwid`, `impersonatedCwid`, before/after values). Mirror the center `handleUpdate` transaction exactly.
- **Validation:** `leaderCwid` — empty string / null clears it; a non-empty
  value must resolve to a real `scholar` (404/400 if not) **OR** be left to the
  `external-leaders.ts` fallback (see Open Questions — external leaders are
  currently code-curated, not UI-settable). `description` — trim, cap length
  (match the center `description` cap). `leaderInterim` — boolean.
- **Cache:** purge the program page + center page on success (the center update
  already does a CloudFront purge; reuse that path for
  `/centers/[slug]/programs/[code]` and `/centers/[slug]`).

### 3. UI — a "Programs" editor in the center editor

Add a per-program editor to the center management surface. Options:
- **A (recommended):** a new card `components/edit/center-programs-card.tsx`,
  shown as its own section/tab in `components/edit/unit-edit-page.tsx` for
  centers that have a program taxonomy (`ctx.programs?.length`). One row per
  program: program label (read-only) + **Leader** (CWID input with the resolved
  name shown, like the center director field) + **Interim** toggle +
  **Description** textarea. Save per program (debounced or explicit Save),
  POSTing to the op from step 2.
- **B:** fold it into `center-roster-card.tsx` above the roster (heavier; the
  roster card is already large).

Reuse the existing director-field input component if there is one; otherwise a
plain CWID text input + resolved-name affordance is fine (match how the center
`directorCwid` is edited).

### 4. Authz / audit summary

| Field | Who can edit | Audited |
|---|---|---|
| `leaderCwid`, `leaderInterim`, `description` | Superuser / center Owner / center Curator | yes (B03, `program_update`) |

---

## Files to touch

- `lib/api/unit-edit-context.ts` — extend `programs` projection + type (+ leader-name resolution).
- `app/api/edit/unit/route.ts` — `op:"update-program"` handler (authz + transactional write + audit + cache purge).
- `components/edit/center-programs-card.tsx` — **new** editor card.
- `components/edit/unit-edit-page.tsx` — mount the card for programmed centers.
- `lib/edit/audit.ts` (+ the audit `action` enum / `scholars_audit` ENUM) — add `program_update` if a new action is used. **NB:** a new audit `action` value needs the `scholars_audit.action` ENUM widened — same gated mechanism as #944 (the `sps-db-bootstrap` task applies `audit-log.sql` on the next gated deploy). Prefer reusing an existing unit-update action if the shape fits, to avoid the ENUM step.
- Tests (below).

## Testing

- **API:** anon → 401; non-Owner/Curator → 403; Owner sets leader/description → 200 + row updated + B03 audit row; clearing leader (`""`/null) works; bad `leaderCwid` (no scholar) → 400/404; ENUM/action present.
- **Loader:** `unit-edit-context` returns the new program fields + resolved leader name.
- **UI:** the programs card renders one row per program, pre-filled; save posts the right body.
- Run the facet/guardrail tests too — this must **not** touch the search index or add any `centerProgram` browse/search facet (the #1074/#1076 guardrail).

## Rollout

- App-only; ships via the normal CD image roll. No reindex.
- Gated by the existing `CENTER_PROGRAM_PAGES` (already staging-on). Until a
  curator sets values, the program pages keep showing whatever the backfill
  seeded (the two paths coexist).
- Prod: flips with the rest of #1105 on the next gated `Sps-App-prod` deploy.

## Open questions

1. **External leaders.** `external-leaders.ts` (non-WCM leaders, e.g. the Joel
   Stein pattern) is **code-curated**, keyed `<centerCode>:<programCode>`. Should
   the UI be able to set an external leader (name + title, no scholar), or do
   external program leaders stay code-only and the UI only sets WCM-scholar
   `leaderCwid`? (Recommend: UI sets `leaderCwid` only for v1; external leaders
   remain code-curated, documented in the card's help text.)
2. **Co-leaders.** Cancer-center programs often have co-directors. The schema is
   single-`leaderCwid`. Out of scope here (tracked separately if needed) — v1 is
   one leader.
3. **Description length / formatting.** Plain text vs. light markdown? Match the
   center `description` treatment.
4. **Per-program Save vs. one Save.** Per-program save is simpler and matches the
   roster card's per-row patch model.

## References

- #1105 / PR #1111 (program pages + leader read-side), #1117 (this), #552 /
  `docs/center-management-spec.md` (center program data model).
- Pattern to mirror: `app/api/edit/unit/route.ts` `handleUpdate` (center in-row
  update + B03 audit), `components/edit/center-roster-card.tsx` (per-row patch
  UI), `lib/api/unit-edit-context.ts` (program taxonomy load).
