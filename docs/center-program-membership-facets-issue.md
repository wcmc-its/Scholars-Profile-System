# Meyer Cancer Center: surface program + membership-type on the public center page (facets + per-record display) and load the classification

**Status:** Reconciled 2026-06-14 (#990). Gaps **B** (per-row Research/Clinical badge) and **C** (program / membership-type facet sidebar) **shipped in #911**, and staging is **loaded (342 classified members, reindexed)** — so the "almost everything is built but nothing is classified" framing below is itself now stale. The only genuinely-open scope is: (1) the **prod** data-load + deploy (tracked on #906 / #552), and (2) the still-missing **global people-search membership-type index key** — `lib/search-index-docs.ts` emits `centerProgram:<CODE>` but does **not** key membership type, so a *global* membership-type facet stays unbacked. See the per-gap notes below.
**Type:** Feature / data-load
**Center:** Sandra and Edward Meyer Cancer Center (`meyer_cancer_center`, `/centers/meyer-cancer-center`)
**Relationship to existing work:** Extends **#552** (Center management). The data model, roster editor, program grouping, and search-index keying are **already merged** under #552 (Phases 1–7). This issue covers the remaining public-page surfacing and the data load — it does **not** re-build the schema.

---

## TL;DR for the reviewer

Almost everything the request asks for is already built; it just isn't visible because **no member is classified**.

- ✅ **Schema** — `CenterProgram` taxonomy + `CenterMembership.programCode` / `membershipType` (enum `research`/`clinical`) + dates already exist (`prisma/schema.prisma:859–915`).
- ✅ **Taxonomy seeded** — Meyer's 5 programs (CB, CGE, CPC, CT, ZY) are live on staging (verified below).
- ✅ **Edit surface** — `/edit/center/meyer-cancer-center` already exposes a **Type** dropdown (Research/Clinical) and a **Program** dropdown per member, gated to centers that have a program taxonomy. Authz: Superuser / Owner / Curator.
- ✅ **Search index** — the indexer already emits a `centerProgram:<CODE>` facet key per active classified member.
- ✅ **Dated memberships + audit** — editable start/end dates (all centers), expiry → member silently drops off the public page but stays visible-as-`Inactive` in the editor, and a per-center audit-history view all already ship (#552 §3.3/§6). Extending this to non-center (Division) memberships is the only new piece.
- ✅ **Data (staging)** — the backfill ran on staging: **342 members classified** (one program each) and the index was rebuilt. *(Was "0 of 331" when this note was written; **prod** is still unloaded — see open scope.)*
- ✅ **Classification cleaned + loaded** — the export (`reciterdb_reporting_cancer_center_20260611_1656EDT.tab`, 343 rows) was normalized to **342 members, one program each** (operator decision: single program per person — see Gap A) and loaded via #822 (0 parse skips).
- ✅ **Public per-record display** — **shipped #911**: the grouped roster row now carries a Research/Clinical badge (`center-members-client.tsx` + `centers.ts`).
- ✅ **Public facets** — **shipped #911**: the center page has a Program / Membership-type / Org-unit facet sidebar (not just the old jump-nav). The global *people-search* membership-type facet is still unbacked (no index key — open scope).

**Remaining work (open):** run the backfill + reindex on **prod**, then deploy (tracked on #906 / #552); and — only if a *global* people-search membership-type facet is wanted — add a membership-type index key to `lib/search-index-docs.ts`. The per-center display + facets (Gaps B/C) already shipped (#911); no data-model change.

---

## Verified live state (staging, 2026-06-11)

Read-only probe against `meyer_cancer_center` on staging Aurora:

```
PROGRAMS  CB Cancer Biology / CGE Cancer Genetics & Epigenetics / CPC Cancer Prevention and Control
          / CT Cancer Therapeutics / ZY "Non-aligned Clinical"          (5 rows, seeded)
TOTALS    total=331  with_program=0  with_membership_type=0  with_start=0  with_end=0
BYPROGRAM null → 331
BYTYPE    null → 331
CENTER    "Sandra and Edward Meyer Cancer Center"  source=seed  scholar_count=331
PROGRAMMED_CENTERS  meyer_cancer_center=5   (only center with a program taxonomy)
```

So: the **taxonomy exists, the members exist, but the link between them is empty.**

> **Label nit:** the request lists `ZY = Clinical, Non-Aligned`; the seed stores the label as `Non-aligned Clinical`. Same meaning — confirm the exact public wording before we display it.

---

## What already exists (so we don't rebuild it)

| Capability | Where | Status |
|---|---|---|
| `CenterProgram` taxonomy table (per-center, opt-in by row) | `prisma/schema.prisma:859` | ✅ merged |
| `CenterMembership.membershipType` (`research`/`clinical`), `programCode`, `startDate`, `endDate` | `prisma/schema.prisma:893` | ✅ merged |
| Meyer's 5 programs seeded | `prisma/center-seed-data.ts` (`CENTER_PROGRAMS`) | ✅ live on staging |
| Roster editor: per-member **Type** + **Program** dropdowns (shown only for centers with programs) + dates + Active/Pending/Inactive status | `components/edit/center-roster-card.tsx` (`hasPrograms` gate) | ✅ merged |
| `POST /api/edit/roster` reads/writes type/program/dates, with full B03 audit | `app/api/edit/roster/route.ts` | ✅ merged |
| Public roster **grouped by program** (sticky scroll-spy program nav + per-section counts) when ≥1 active member has a `programCode` | `components/center/center-members-client.tsx:46` (`GroupedRoster`); grouping decided in `lib/api/centers.ts` `getCenterMembers` | ✅ merged (dormant — no classified members) |
| Search index emits `centerProgram:<CODE>` key per active classified member | `lib/search-index-docs.ts` (buildPeopleDoc) | ✅ merged |
| One-shot backfill to classify Meyer members from an export | `scripts/backfills/2026-06-10-meyer-center-membership-extended.ts` (#822) | ✅ merged, **not yet run with real data** |
| Spec of record | `docs/center-management-spec.md` | ✅ |

---

## The gaps (the actual work)

### Gap A — Load the classification (export now in hand; needs normalization + a multi-program decision)

The classified export exists: **`reciterdb_reporting_cancer_center_20260611_1656EDT.tab`** (from `reciterdb.reporting_cancer_center`, 343 data rows). Columns: `id`, `cwid`, `membershipType`, `program` (formatted `"Meyer Cancer Center: <CODE>"`). It carries the per-member assignment that was missing.

**Distribution (computed from the file):**
- **Membership type:** `RESEARCH` 293, `CLINICAL` 50 — all valid, maps cleanly to the `research`/`clinical` enum.
- **Program:** `CT` 131, `CB` 70, `CPC` 50, `CGE` 35, `ZY` 23 — **plus 27 multi-program rows** (`CT, ZY` ×20, `CPC, CT` ×6, `CGE, CT` ×1) and **7 free-text `Not Aligned`/`Not aligned`** (two casings) that mean `ZY`.
- **342 unique CWIDs in 343 rows** — `lae2014` appears twice (`CT` + `CPC`), i.e. multi-program encoded as duplicate rows rather than a comma list. Encoding is inconsistent.
- **Count reconciliation:** 342 export CWIDs vs **331** membership rows on staging — ~11 CWIDs differ. The UPSERT backfill will create the missing rows; CWIDs with no `scholar` record yet are fine (no FK to Scholar, per ADR-003) but won't render publicly until they arrive.

**Normalization the import must do** (none of this is guessing — it's deterministic):
1. Drop the `id` column + header; key on `cwid`.
2. Strip the `"Meyer Cancer Center: "` prefix → bare code.
3. Map `Not Aligned` / `Not aligned` → `ZY`.
4. Resolve the duplicate-row encoding and the comma-list encoding into one consistent multi-program representation.
5. Validate every resulting code against the seeded set `{CB, CGE, CPC, CT, ZY}`; **count + skip** anything unmappable (never invent), and surface the skip list.

> ⚠️ The existing backfill (`scripts/backfills/2026-06-10-meyer-center-membership-extended.ts`, #822) parses **one program code per line** and would **skip all 27 multi-program rows** and choke on the leading `id` column. It needs either a pre-transform of the `.tab` into its accepted format **and** a decision on multi-program (below), or a small rework to read this `.tab` directly.

#### Decision: single program per person (RESOLVED 2026-06-11)

The source has 27 multi-program members, but the operator chose **one program per person** — the existing single `programCode` column stays, **no data-model change**. The cleanup (deterministic, documented in the file header) collapses each member to one code:

- Strip the `"Meyer Cancer Center: "` prefix and drop the `id` column / header.
- `Not Aligned` / `Not aligned` (7, both casings) → **`ZY`**.
- Multi-program comma rows → the **first-listed** code: `CT, ZY`→`CT` (20), `CPC, CT`→`CPC` (6), `CGE, CT`→`CGE` (1).
- `lae2014` (appeared twice, `CT`+`CPC`) → **`CPC`** (operator override).
- Validate every code against `{CB, CGE, CPC, CT, ZY}`; **0 unmappable**.

**Result — 342 members, one program each:** `CT` 150, `CB` 70, `CPC` 56, `CGE` 36, `ZY` 30; `research` 292 / `clinical` 50. Written to `data/center-members/meyer-cancer-center.txt` (gitignored, operator-local), and it parses through the #822 backfill with **0 skips**.

> **Loader fix applied:** #822's `CWID_PATTERN` was `^[a-z]{3}[0-9]{4}$`, which silently skipped **37 real members with name-derived "vanity" CWIDs** (`nkaltork`, `barany`, `formenti`, `mtalmor`, …). Relaxed to `^[a-z]{2,}[0-9]{0,4}$` (still rejects the hyphen-bearing junk the tests exercise); all 24 unit tests pass.

**Remaining action:** run the backfill against staging (the data is prepared) → re-run `etl:search-index` so `centerProgram:` keys populate. The public page then flips flat → grouped automatically. *(Local can't reach staging Aurora directly; load via an in-VPC `run-task`, the same path used to probe the DB.)*

> **Editor ergonomics (optional follow-on):** a **bulk paste / CSV import** in the roster editor so an admin can re-load a refreshed export without per-row clicking. A refreshed export with new multi-program members would need the same first-listed collapse.

### Gap B — Display program + membership type per record (public) — ✅ SHIPPED (#911)

> **Reconciled 2026-06-14 (#990):** this gap shipped in #911 — the grouped center roster row carries a Research/Clinical badge, threaded via `getCenterMembers` (`lib/api/centers.ts`) into `center-members-client.tsx`. The original analysis is retained below for the record.

`PersonRow` (`components/department/person-row.tsx`) renders name, role-rank tag, title, dept line, overview snippet, pub/grant counts — but not the member's **program** or **membership type**. The hit shape it consumes (`DepartmentFacultyHit`) doesn't even carry them.

**Action:**
1. Thread `membershipType` (and optionally `programCode`) onto the member hit returned by `getCenterMembers` (`lib/api/centers.ts`).
2. Render a small badge on the roster row — e.g. a `Research` / `Clinical` chip. Program is conveyed by the section header today; decide whether to also badge it on the row (useful in flat/search contexts where the section header isn't present).

### Gap C — Public facets for program and membership type — ✅ SHIPPED (#911)

> **Reconciled 2026-06-14 (#990):** the per-center facet sidebar (Program / Membership type / Org unit) shipped in #911. What remains is **only** the *global* people-search membership-type facet, which is unbacked because `lib/search-index-docs.ts` keys `centerProgram:<CODE>` but not membership type. The original analysis is retained below for the record.

Today on the center page:
- **Program** = grouping + a jump-nav (navigation, not a filter).
- **Membership type** = nothing.
- The only real filter is **"Appointment"** = faculty *rank* (Professor / Assistant Prof / …) via `RoleChipRow` — a different axis from research-vs-clinical.

**Action (recommended minimal design):** keep program grouping as-is, and add a second filter chip row for **Membership type** (All / Research / Clinical) next to the existing Appointment row, reshaping sections + counts the same way the Appointment filter does. Optionally promote **Program** from jump-only to a true filter. Mirror these in the global people-search facet UI later (the index is already keyed for program; **membership type would need an index key added** — it currently is not emitted).

---

### Gap D — Dated memberships, expiry → inactive, audit history (already shipped for centers; only "other memberships" is new)

The request to "set start/end dates, have an expired member drop off the public page but stay visible-as-inactive on the backend, with audit history" is **already built for center memberships** (#552 §3.3 / §6). Verify, don't rebuild:

- **Editable start/end dates** for *every* center (not just programmed ones) — `components/edit/center-roster-card.tsx` Start/End columns are outside the `hasPrograms` gate, with end≥start validation (`onStartChange`/`onEndChange`).
- **Expiry → inactive → hidden publicly** — `statusOf` derives `inactive` when `endDate < today` (`:60`); the public center page (and the center's `scholar_count`, and search-index membership) all filter through `isCenterMembershipActive` / `loadActiveCenterMemberCwids` (`lib/api/centers.ts:45,81,284`), so a lapsed member silently leaves the public roster.
- **Still visible-as-inactive on the backend** — the roster editor renders inactive rows at `opacity-50` with a **Status** column (Active / Pending / Inactive) and a "show active only" toggle (default on, flip to reveal lapsed/pending).
- **Audit history** — `/edit/center/[code]/history` (a sub-route of the center editor) surfaces the append-only B03 audit log scoped to that center; every roster write (incl. date edits) is audited via `POST /api/edit/roster`. Same Owner/Curator/Superuser gate as the editor.

**"Other memberships" = other centers (confirmed, not divisions).** Dated start/end + expiry→inactive + audit already apply to every center's memberships, so this requirement is **already satisfied** — verify on the Meyer page once data loads, don't rebuild. (Extending dates to `DivisionMembership` is explicitly **out of scope**.)

## Out of scope / non-goals

- Re-designing or re-building the `CenterProgram` / `CenterMembership` schema — it exists and fits the request exactly.
- Extending programs to other centers — the taxonomy is per-center opt-in; only Meyer needs rows today.
- A global search **membership-type** facet UI — note only; the index doesn't key it yet.

## Acceptance criteria

1. ✅ **Done** — single-program decision resolved; classification cleaned to 342 members (one program each) and written to the backfill source path (0 parse skips); loader CWID regex fixed (37 vanity CWIDs recovered); 24 unit tests pass.
2. Meyer members carry their program + `membershipType` on staging (backfill #822 run in-VPC against staging, then `etl:search-index` re-run).
3. `/centers/meyer-cancer-center` renders **grouped by program** with per-section counts (already coded — flips on once data lands).
4. Each roster row shows the member's **membership type** (Research/Clinical) badge, and their program where not conveyed by a section header.
5. The center page offers a **Membership type** filter (All / Research / Clinical) that reshapes the roster.
6. `centerProgram:<CODE>` facet keys are present in the search index for every classified member (re-index after backfill).
7. Center admins (Owner/Curator/Superuser) can adjust a member's program/type/dates in `/edit/center/meyer-cancer-center`, with expiry→inactive→hidden and audit history — **already shipped**; verify, don't rebuild.

## Suggested issue hygiene

- **#552** is already the open tracker for the data-load step — narrow it to Gap A or fold Gap A here, don't duplicate.
- File Gaps B + C as this issue (public surfacing). They're small and gated entirely on Gap A producing data.
