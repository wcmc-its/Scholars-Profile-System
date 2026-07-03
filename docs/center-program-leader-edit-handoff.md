# Handoff — Center program **multi-leader** + description edit UI (#1117)

> **STATUS 2026-06-18: MERGED — PR [#1125](https://github.com/wcmc-its/Scholars-Profile-System/pull/1125)** squash-merged to `master` (`b3201109`), **CI green** (build + cdk + Orca all pass). Ships dark behind the existing `CENTER_PROGRAM_PAGES` flag. Issue **#1117 stays open for rollout only** (deploy → staging backfill → verify → prod flip with #1105). Built largely as this spec describes, with one design refinement: the schema migration **drops** the old `leaderCwid`/`leaderInterim` columns (clean cutover — feature dark, no data) rather than keeping them. The 8 CWIDs below are loaded by `scripts/backfills/2026-06-18-meyer-program-leaders.ts` (verify-before-write). Remaining = the usual gated rollout: deploy → run backfill on staging → verify the four program pages → prod flip with the rest of the #1105 rollout. The spec below is retained as the design record._

_Originally written as a spec + implementation guide for #1117. Code references were grounded against `origin/master` as of writing; the implementation now lives in PR #1125._

## TL;DR

#1105 (per-program pages, merged in PR #1111) added the `CenterProgram.leaderCwid` /
`leaderInterim` / `description` columns **and** the public program page that renders them
(`/centers/[slug]/programs/[code]`, gated `CENTER_PROGRAM_PAGES`). **There is no edit UI** to
set those fields.

#1117 adds the editor — **and the scope has grown: a program must support MULTIPLE leaders**, on
both the display and edit surfaces. The Meyer Cancer Center programs are co-led (e.g. Cancer
Biology has two leaders). The current single `leaderCwid` column can't represent that, so this
work now includes a **schema change** (a `CenterProgramLeader` join table) plus a small data
backfill (§ Data to load).

It still rides the existing `CENTER_PROGRAM_PAGES` flag, so it stays dark in prod until that
flag flips. It is **not** app-code-only anymore — it needs a Prisma migration (which CD applies
on deploy), but **no CDK/IAM**.

---

## Status snapshot

| Item | State |
|---|---|
| Single-leader columns `CenterProgram.{leaderCwid, leaderInterim, description}` | **EXIST on master** (model `CenterProgram`, #1105). `description` stays; `leaderCwid`/`leaderInterim` are **replaced** by the join table (feature is dark + program leaders are unset everywhere, so this is a safe cutover — no prod data to migrate). |
| Multi-leader model | **NOT BUILT** — new `CenterProgramLeader` join table + migration. |
| Read side | **Single-leader only today** (`getCenterProgram` returns `leader: ProgramLeader \| null`). Must become `leaders: ProgramLeader[]`. |
| Display | Program page + center page render **one** leader. Must render a list. |
| Edit UI | **NOT BUILT.** |
| The 4 Meyer program leader assignments | **NOT LOADED** (see § Data to load). |
| Issue #1117 | **OPEN** (`enhancement`, split from #1105). |
| Flag | Rides existing `CENTER_PROGRAM_PAGES` (`isCenterProgramPagesEnabled()`; `cdk/lib/app-stack.ts` staging-on / prod-off). **No new flag.** |
| Deploy | App code **+ a Prisma migration** (CD's migrate step applies it). **No `cdk deploy`** (no IAM, no infra). |

---

## What already exists (context)

**The columns** — `model CenterProgram` (`prisma/schema.prisma`, composite PK
`@@id([centerCode, code])`, table `center_program`): `leaderCwid String?`,
`leaderInterim Boolean @default(false)`, `description String? @db.Text`. All manually owned (no
ETL writes them), null/false by default → the feature ships dark.

**The read side** — `getCenterProgram(centerSlug, code)` in `lib/api/centers.ts` resolves a
**single** leader: `leaderCwid` → a WCM `scholar` row (profile-linked), else the external
fallback `EXTERNAL_LEADERS["<centerCode>:<programCode>"]` (`lib/external-leaders.ts`) → name +
Directory photo, no link; empty/null ⇒ no leader. It returns
`CenterProgramDetail { …, leader: ProgramLeader | null, … }`. `getCenterPrograms` (the list used
by the center page) likewise carries one leader per program.

**The editor surface** — `/edit/center/[code]` is `components/edit/unit-edit-page.tsx`, an
attribute router (`?attr=`) with tabs `description` / `leader` / `roster` / `slug` /
`center-type` / `retire`. The center's **program taxonomy** is already loaded into the edit
context — `lib/api/unit-edit-context.ts` returns `programs: { code, label, sortOrder }[] | null`
— but **not** per-program leader/description data.

**Closest editor analog** — `components/edit/unit-leader-card.tsx` edits a *unit's* leader (a
directory-pick cwid, an explicit vacancy, an interim toggle), writing a center in-row via
`POST /api/edit/unit`. Reuse its directory-typeahead + interim UX, but as a **repeatable row**
(add / remove / reorder) rather than a single field.

**Roster route** — `app/api/edit/roster/route.ts` is the model for **list mutations** on a
center (add / remove / set membership rows, one MySQL transaction + B03 `roster_change` audit,
program-code validation with `no_taxonomy` 400). The leader-list write path should mirror it.

---

## Scope (#1117, expanded)

On `/edit/center/[code]`, per program in the taxonomy:
1. **Multiple leaders** — add a leader (directory typeahead → cwid), remove one, **reorder**
   (display order), and an **interim** toggle **per leader**. External-leader fallback applies
   per-cwid (see Design § 6).
2. **Description** — a single prose textarea → `description` (null when empty).
3. A **write path** with B03 audit on every mutation.
4. **Authz** — Superuser / Owner / Curator of the center (roster parity; these are content
   fields, **not** Superuser-only).
5. **Display** — the program page and the center page render **all** leaders, in order.

Out of scope: creating/renaming/reordering programs (the #552 taxonomy, edited elsewhere);
editing `EXTERNAL_LEADERS` (code-owned); multi-leader for **center directors / dept chairs**
(those stay single `directorCwid` / `chairCwid` unless a follow-up asks — flag it if the user
wants parity there).

---

## Recommended design

### 1. Schema — a `CenterProgramLeader` join table (migration)

Replace the single `leaderCwid` / `leaderInterim` columns with a child table; keep
`description` on `CenterProgram`.

```prisma
model CenterProgram {
  // …unchanged: centerCode, code, label, sortOrder, description…
  leaders CenterProgramLeader[]
  // DROP leaderCwid + leaderInterim (no prod data — feature is dark)
}

/// #1117 — a program's leaders. N per program, each with its own interim flag and
/// display order. Manually owned (no ETL). A cwid resolves to a WCM scholar, or
/// the external-leader fallback (lib/external-leaders.ts), same as the old single path.
model CenterProgramLeader {
  centerCode  String  @map("center_code")  @db.VarChar(64)
  programCode String  @map("program_code") @db.VarChar(16)
  cwid        String  @db.VarChar(32)
  interim     Boolean @default(false)
  sortOrder   Int     @default(0) @map("sort_order")

  program CenterProgram @relation(fields: [centerCode, programCode], references: [centerCode, code], onDelete: Cascade)

  @@id([centerCode, programCode, cwid])
  @@map("center_program_leader")
}
```

Migration: `create table center_program_leader` + drop the two single columns. There is **no
program-leader data in any environment** yet (the edit UI never existed and the backfill only
set member `programCode`), so no data migration is needed — clean cutover. (If you'd rather be
conservative, keep the columns nullable-and-unused for one release; the recommendation is to
drop them so there's a single source of truth.)

### 2. Read side — return a list

`getCenterProgram` (and `getCenterPrograms`): select `program.leaders` ordered by
`sortOrder`, resolve **each** cwid the same way the single path does (scholar row → external
fallback), and return `leaders: ProgramLeader[]` (drop the singular `leader`). `ProgramLeader`
already carries `isInterim` per leader — no type change beyond list-vs-scalar. Empty list ⇒ no
leaders rendered. Resolve in one batched `scholar.findMany({ where: { cwid: { in } } })`, not N
queries.

### 3. Display — render all leaders

`components/center-program/program-page.tsx` and the center page (`components/center/center-page.tsx`
/ wherever `getCenterPrograms` leaders surface): map over `leaders` and render a leader card
each (photo, name → profile link when scholar-backed, title, "Interim Leader" qualifier when
`isInterim`). Heading "Program Leaders" (plural) — or "Program Leader" when length 1. Keep the
existing single-leader card component; just render it in a list/grid.

### 4. Edit — a list-management card

New `components/edit/center-program-card.tsx` (rendered under a new `programs` attribute tab in
`unit-edit-page.tsx`, visible only for a center with a non-empty taxonomy). Per program:
- a row per current leader: name + title + interim checkbox + remove (✕) + drag/reorder handle;
- an "Add leader" directory typeahead (reuse the picker from `unit-leader-card.tsx`);
- a single description textarea.
Dirty-track and save like `unit-leader-card.tsx`. Reorder writes `sortOrder`.

### 5. Write path — leader-list mutations + description

Mirror `app/api/edit/roster/route.ts` (list mutations) rather than the single in-row update.
Recommend a sibling route `POST /api/edit/center-program` (cleaner than overloading
`/api/edit/unit`), body `{ centerCode, programCode, action, … }`:
- `add_leader` — upsert a `CenterProgramLeader` row (cwid, interim, sortOrder).
- `remove_leader` — delete by `(centerCode, programCode, cwid)`.
- `set_leader` — update `interim` / `sortOrder` for an existing row.
- `set_description` — in-row update of `CenterProgram.description` ("" → null).
Validate `programCode` references a real `CenterProgram` for the center (reuse the roster
route's `no_taxonomy` / unknown-program 400s) and `cwid` via `validateUnitLeaderCwid`
(`lib/edit/validators.ts`). Each mutation = **one** `db.write.$transaction` (the row change **+**
`appendAuditRow`).

### 6. External-leader fallback — resolve per cwid

In a multi-leader world each cwid resolves independently, so the cleanest fallback is a
**cwid-keyed** lookup. The current `EXTERNAL_LEADERS` map is keyed by unit code /
`<centerCode>:<programCode>` (single leader). Options:
- minimal: keep `EXTERNAL_LEADERS` as-is for the existing single dept/center paths, and add a
  small cwid-keyed map (or reuse the same entries keyed by cwid) for program leaders; or
- cleaner: re-key the program lookup by cwid. **None of the 8 leaders in § Data to load are
  external — all are WCM scholars** — so this is an edge case you can stub now and harden later.
  Just don't regress the existing single dept/center external path.

### 7. Audit (B03)

`AuditEntityType` (`lib/edit/audit.ts`) has **no `centerProgram`** member — don't invent one
(that's a DB ENUM change, out of scope). Log as `targetEntityType: "center"`, `targetEntityId =
"<centerCode>:<programCode>"` (granular enough for history; match what the roster/center rows
do), `action: "roster_change"` for leader add/remove/set (it already means "a membership-style
row changed") and `"field_override"` for the description in-row edit (the existing center-field
"semantic stretch"). `before`/`after` carry `{ programCode, cwid?, interim?, sortOrder?, description? }`.

### 8. Authz + revalidation

Authz: `canManageAccess(session, effective)` (`lib/edit/authz.ts`) — Superuser / Owner /
Curator, exactly as the roster route. After a successful write, purge the program page
`/centers/<slug>/programs/<code>` **and** the center page (it lists programs + leaders) via the
same `reflectUnitChange` / CloudFront purge the unit routes use.

---

## Data to load

Center `meyer_cancer_center`. Program codes are canonical (`prisma/center-seed-data.ts` →
`CENTER_PROGRAMS`). Leaders in the listed order (`sortOrder` 10, 20, …), `interim = false`.

| Program (code) | Leaders (in order) | CWID | Source |
|---|---|---|---|
| Cancer Biology (`CB`) | Juan Cubillos-Ruiz | `jur2016` | local export `docs/overview-coverage/bio-metadata.csv` |
| | Tim (Timothy) McGraw | `temcgraw` | local export (vivo `cwid-temcgraw`) |
| Cancer Genetics & Epigenetics (`CGE`) | Ekta Khurana | `ekk2003` | local export `bio-metadata.csv` |
| Cancer Prevention and Control (`CPC`) | Rulla Tamimi | `rmt4001` | user-provided (2026-06-18) |
| | Shoshana Rosenberg | `shr4009` | local export `target-list-prominent-uncovered.csv` |
| Cancer Therapeutics (`CT`) | Nasser Altorki | `nkaltork` | user-provided (2026-06-18) |
| | Rohit Chandwani | `roc9045` | local export `bio-metadata.csv` |

> **All eight CWIDs are resolved** — six from local data exports, two (Tamimi `rmt4001`, Altorki
> `nkaltork`) provided by the user. The backfill should still **verify each cwid resolves to
> exactly one `scholar` row and fail loudly on a 0/>1 match** before upserting (the local exports
> are point-in-time, and a typo'd cwid should error, never silently no-op). Do not write a cwid
> that doesn't resolve.

**Backfill** — add `scripts/backfills/2026-06-18-meyer-program-leaders.ts` (model it on
`scripts/backfills/2026-06-10-import-unit-curation.ts`): a `--dry-run`-able, idempotent upsert
of the `CenterProgramLeader` rows above. Resolve every leader cwid against `scholar` first
(by the cited cwid, falling back to slug for the two unknowns), assert each resolves to exactly
one row, then upsert. Run staging first (`run-task`), verify on `/centers/meyer-cancer-center/programs/CB`
etc., then prod with the same gating as the rest of the #1105 rollout.

---

## Files to touch

- `prisma/schema.prisma` — add `model CenterProgramLeader` + the `leaders` relation; drop
  `leaderCwid` / `leaderInterim` from `CenterProgram`.
- `prisma/migrations/<ts>_center_program_leaders/migration.sql` — create the table, drop the
  two columns (`npx prisma migrate dev --name center_program_leaders`).
- `lib/api/centers.ts` — `getCenterProgram` / `getCenterPrograms` return `leaders[]`
  (batched resolution).
- `components/center-program/program-page.tsx`, `components/center/center-page.tsx` (+ any
  shared leader-card) — render a list of leaders.
- `lib/api/unit-edit-context.ts` — load per-program `leaders[]` (cwid + interim + sortOrder +
  resolved name/title) and `description` for the editor.
- `app/api/edit/center-program/route.ts` **(new)** — `add_leader` / `remove_leader` /
  `set_leader` / `set_description`, validators, one-tx + B03 audit, authz, revalidation.
- `components/edit/center-program-card.tsx` **(new)** + register a `programs` tab in
  `components/edit/unit-edit-page.tsx`.
- `lib/external-leaders.ts` — only if you add the per-cwid fallback (optional; none of this
  data needs it).
- `scripts/backfills/2026-06-18-meyer-program-leaders.ts` **(new)** — the § Data to load upsert.
- Tests: new-route suite (add/remove/set/description, unknown-program 400, authz-denied, audit
  rows), card test, and update `tests/unit/api-center-program.test.ts` /
  `tests/unit/center-program-page.test.tsx` for the `leaders[]` shape.

---

## Steps to finish

1. **Branch off fresh `origin/master`** (NOT this `docs/spotlight-pipeline` checkout — it
   predates the #1105 columns and won't compile). SPS is a Dropbox repo with untracked
   `.env`/`node_modules`/`lib/generated/prisma`, so a **normal branch in the canonical checkout**
   is fine (worktree carve-out for SPS).
2. **Schema + migration** → `npx prisma migrate dev --name center_program_leaders` →
   `npx prisma generate`. `npx tsc --noEmit` clean.
3. **Read side** (`leaders[]`) → **display** (render the list) → **edit context** loader.
4. **Write path** (`/api/edit/center-program`) + **card/tab**.
5. **Tests** — `npx vitest run --maxWorkers=4 <the touched suites>`; full suite before PR.
6. **Backfill** — resolve the two unknown cwids against the live `scholar` table (fail loudly on
   ambiguity), dry-run, then load on **staging**, verify the four program pages render all
   leaders.
7. **PR** → base `master`, reference #1117. CI (`build` + `cdk`) green. The migrate step runs on
   deploy — **no `cdk deploy`**.
8. **Merge** → CD rolls the staging image **and applies the migration**.
9. **Verify on staging** (`CENTER_PROGRAM_PAGES=on`): as Curator/Owner/Superuser open
   `/edit/center/meyer_cancer_center` → add/remove/reorder leaders + interim + description on a
   program → confirm `/centers/meyer-cancer-center/programs/CB` (etc.) renders all leaders in
   order with the right interim qualifier and profile links.
10. **Close #1117** when merged (prod flip is tracked by the `CENTER_PROGRAM_PAGES` rollout in
    #1105 — don't leave #1117 open for the flag flip).

---

## Gotchas / hard-won lessons

- **This is now a schema change, not app-only.** A Prisma migration is required; CD's migrate
  step applies it on deploy. Still **no `cdk deploy`** (no IAM/infra). Don't drop the columns in
  a separate, un-coordinated migration from the code that stops reading them — ship them together.
- **Clean cutover is safe** because there is **zero program-leader data** in any env (the edit
  UI never existed). Confirm with a `SELECT count(*) FROM center_program WHERE leader_cwid IS NOT
  NULL` on staging+prod before dropping the columns; if (unexpectedly) non-zero, migrate those
  rows into the join table first.
- **Verify every CWID against the live `scholar` table before upserting** — all eight are known
  (§ Data to load), but the backfill should still assert each resolves to exactly one row and
  fail loudly on 0/>1 (local exports are point-in-time; a typo should error, never silently
  no-op). Never write a cwid that doesn't resolve.
- **Re-ground every code ref against `origin/master`** — this doc lives on a branch that predates
  the #1105 columns. `git show origin/master:<path>`.
- **External leaders are code, not the column** — the editor writes cwids only; a non-scholar
  cwid renders only if `lib/external-leaders.ts` has a matching entry, else no leader (by design,
  "do not fabricate"). None of this data needs it.
- **`AuditEntityType` has no `centerProgram`** — reuse `"center"` with a
  `"<centerCode>:<programCode>"` id; `roster_change` for leader rows, `field_override` for the
  description. Keep the one-transaction `row-change + appendAuditRow` invariant.
- **Authz = roster parity (Superuser/Owner/Curator)** — content fields, not Superuser-only.
- **Batch the leader resolution** — one `scholar.findMany({ where: { cwid: { in } } })`, never N
  per-leader queries (the single path's per-cwid `findUnique` doesn't scale to a list).

---

## Pointers

- Issue: **#1117** (open). Parent: **#1105** (per-program pages, PR #1111). Taxonomy: **#552** /
  **#906** (Meyer Cancer Center programs — the test center). Center code `meyer_cancer_center`,
  programs `CB` / `CGE` / `CPC` / `CT` (+ excluded `ZY`).
- Schema/seed: `prisma/schema.prisma` (`model CenterProgram`), `prisma/center-seed-data.ts`
  (`CENTER_PROGRAMS`).
- Read side: `lib/api/centers.ts` (`getCenterProgram` / `getCenterPrograms` /
  `CenterProgramDetail` / `ProgramLeader`); `components/center-program/program-page.tsx`;
  `app/(public)/centers/[slug]/programs/[code]/page.tsx`.
- Editor: `components/edit/unit-edit-page.tsx` (attr router), `components/edit/unit-leader-card.tsx`
  (leader-picker analog), `lib/api/unit-edit-context.ts` (`programs` loader),
  `app/api/edit/roster/route.ts` (list-mutation + B03 audit model).
- Audit/authz/validators: `lib/edit/audit.ts` (`appendAuditRow`, `AuditAction`,
  `AuditEntityType`), `lib/edit/authz.ts` (`canManageAccess`), `lib/edit/validators.ts`
  (`validateUnitLeaderCwid` / `validateUnitDescription`).
- Flag: `lib/profile/methods-lens-flags.ts` (`isCenterProgramPagesEnabled()`),
  `cdk/lib/app-stack.ts` (`CENTER_PROGRAM_PAGES`).
- External leaders: `lib/external-leaders.ts` (`EXTERNAL_LEADERS`).
- Backfill model: `scripts/backfills/2026-06-10-import-unit-curation.ts`.
- Resolved CWIDs (all eight): Cubillos-Ruiz `jur2016`, McGraw `temcgraw`, Khurana `ekk2003`,
  Rosenberg `shr4009`, Chandwani `roc9045` (local exports); Tamimi `rmt4001`, Altorki `nkaltork`
  (user-provided). Verify each against the live `scholar` table at backfill time.
