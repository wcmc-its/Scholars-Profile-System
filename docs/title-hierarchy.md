# Display-title hierarchy

How the Scholars Profile System picks the one title shown under a scholar's name: on the
profile header, search hits, people cards, popovers and `/og` share cards. Every one of
those surfaces reads the same resolved value, `Scholar.primaryTitle`, which the ED nightly
writes and the `/edit` title picker can pin.

**Source of truth:** `TITLE_RANK` and `TITLE_RANK_LABEL` in
[`lib/scholar-title.ts`](../lib/scholar-title.ts). This doc restates them for readers who
do not read code; `tests/unit/title-hierarchy-doc.test.ts` fails CI if the rank table below
drifts from the code. Change the code first, then this table.

**Where the ranks come from:** the title pecking order supplied by External Affairs
(Institutional Communications), 2026-09-24, with follow-up rulings 2026-09-25 (#2771).

**Where it is reviewed:** `/edit/reports/display-titles` lists every scholar whose title is
decided by leadership, a pin, a close contest or a mismatch, with the rule that decided it.

## The rank table

Lower ranks win. A scholar with several candidate titles shows the one with the lowest
rank number.

| Rank | Label | Examples |
|---|---|---|
| 1 | Dean / Provost / President | Dean; Provost; President |
| 2 | Vice Provost / Vice Dean / Vice President | Vice Dean; Deputy Provost; Executive Vice President |
| 3 | Senior Associate Dean | Senior Associate Dean for Research |
| 4 | Department Chair | Chair of Medicine; Chairman, Department of Surgery |
| 5 | Institutional Center / Institute Director | Director of a tracked school-wide center |
| 6 | Division Chief | Chief, Example Division; Chief of Cardiology |
| 7 | Associate / Assistant Dean | Associate Dean for Education; Assistant Dean |
| 8 | Associate / Assistant Vice Provost | Associate Vice Provost; Assistant Vice President |
| 8.5 | Vice Chair | Vice Chair for Research |
| 9 | Endowed title of any academic rank (incl. endowed Clinical / Research / Educational Scholars) | Example Family Professor of Medicine; Chair in Example Studies; Example Family Research Scholar in Oncology |
| 10 | Unit-based Center / Institute Director | Director of a department's own center or an untracked institute |
| 11 | Unit-based Program Director | Director, Residency Program |
| 12 | Academic rank (Professor, Instructor …) | Professor of Medicine; Assistant Professor; Instructor |
| 13 | Anything else | Attending Physician; Lecturer; any title the ladder does not name |

Vice Chair was not on the original list; External Affairs slotted it between 8 and 9, so it
carries the fractional rank 8.5 and ranks 1 to 12 keep the list's own numbering. Rank 13 is
the floor for everything unmatched.

Matching is most specific first: "Associate Vice Provost" never reads as Vice Provost,
"Senior Associate Dean" never as Associate Dean, and "Vice Dean" never as Dean. A named
chair *in* a field ("Chair in Example Studies") is an endowed title, not a department chair.
Endowed Clinical, Research and Educational Scholars count as endowed at any academic rank
(External Affairs, 2026-09-25); like a professorship, the title needs a name in front of it, so a
bare "Research Scholar" is not endowed.

## The candidate sources

Each scholar has up to five candidate titles, one per source (`TITLE_TIERS`). A source
that does not apply to the scholar contributes nothing.

| Source | What it is |
|---|---|
| `working` | The Enterprise Directory working title (`weillCornellEduWorkingTitle`), set by the scholar's department in the Web Directory for everyday use. |
| `primary` | The Enterprise Directory primary title (`weillCornellEduPrimaryTitle`), the official title of record. |
| `appointment` | The best-ranked current Enterprise Directory appointment title, counted only when it ranks above a plain academic rank (chair, endowed professorship and so on). |
| `centerHead` | Director of a tracked center, from the center's leadership roster (`OrgUnitRoleAssignment` with the Director role). |
| `chief` | Division chief, from the division's leadership roster (`OrgUnitRoleAssignment` on a division). |

The source list order is the tie-break order, and nothing else: it never beats a lower
rank number.

## The rules

**Pins always win.** A title pinned in `/edit` is shown regardless of rank. Only a
superuser or a comms steward (`comms_steward`) can pin; a scholar or their proxy requests a
change instead. Clearing the pin ("Use default") returns the scholar to the ranked pick.

**Ties go to the working title, then the Enterprise Directory primary title.** Between
candidates of equal rank, the earlier source in the list above wins, so the scholar's own
wording is preferred over a derived one.

**Emeritus titles hold no office.** A title containing Emeritus, Emerita or Emeriti never
ranks as dean, chair, chief, director or any other office; at best it ranks as an endowed
title or an academic rank.

**Every tracked center counts as institutional (rank 5).** Every center in the center
table is school-wide, so its Director ranks as Institutional Center / Institute Director,
above division chief. A text title that names the same center keeps the scholar's own
wording at rank 5. A director title for a center or institute the system does not track
ranks as unit-based (rank 10).

**Center associate directors and co-directors never title their holder.** Only the
Director role on a center roster produces a candidate. An associate, assistant or deputy
director title never ranks as a director.

**A center or institute director title that names its own appointment's department ranks
as Chair.** When a director title is held in a department whose name it shares, the holder
heads that department in all but name, so the title ranks 4 (the BMRI rule, #2804).
The same holds for a director title (working or primary) naming a department the scholar
holds the chair role on, e.g. a Reproductive Medicine chair whose working title directs
the Institute for Reproductive Medicine.

**A working title claims Chair only with a chair role behind it.** The working title is
set by the scholar in the Web Directory and can outlive the office. "Chair of …" there
ranks as Chair only when the scholar holds a department chair role; otherwise it ranks as
nothing, and the endowed or academic title shows instead.

**Only academic departments have chairs.** Graduate School and MD-PhD Program are
student-only units, not academic departments, so a leader recorded on one never counts as
a department chair. The list lives in `lib/non-academic-units.ts`, shared with the ED ETL
that keeps these units off /browse.
