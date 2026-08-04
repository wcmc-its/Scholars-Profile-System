# docs/ADR-012 — InfoEd grant import: what we admit, what we publish as a date, and where dates may come from

**Status:** **Partially accepted, nothing yet in production.** D1, D3, D4a and D9 are merged to master (#2176, #2140) but **dark** — `etl:infoed` is excluded from the staging cadence and prod requires a manual `workflow_dispatch` deploy, so no behaviour has changed for any user yet. D5 and D4b are decisions *not* to act, and are live by default. D10 is unresolved and blocked on OSRA.
**Date:** 2026-08-04
**Revision:** 1
**Authors:** Scholars Profile System development team
**Supersedes:** —
**Superseded by:** —

## Context

InfoEd is the system of record for WCM sponsored-project administration, and `etl/infoed`'s `CONSOLIDATED_QUERY` is the only thing standing between it and every grant a faculty member sees on their profile. That query is a single ~130-line SQL string. Over time it accumulated a substantial amount of **policy** — which records are real awards, which are confidential, what counts as a project period — expressed only as join types and `WHERE` predicates, with no statement anywhere of what was intended.

The cost of that became concrete over the past week. An `INNER JOIN` nobody had examined was deleting 29% of in-scope proposal rows. A date aggregate keyed on the wrong grain was hiding periods that were plainly present in the source. A column pair holding a period for 1,521 accounts had never been read. A candidate fallback source was investigated three times by sampling and got three different answers, all of them wrong. And a report from a department administrator that grants were "missing" turned out to have nothing to do with any of it.

Each of those was settled by measurement against prod InfoEd. This record exists so the settled ones are not re-litigated, and so the deliberately-unsettled ones are not quietly resolved by whoever next edits the query.

**Every figure in this document was measured against production InfoEd (`wc_infoedprod`) and production Aurora between 2026-08-03 and 2026-08-04.** Where a number is a census it says so; where it is a projection it says so.

## The population, stated once

Prod's actionable `grant_date_gap` backlog is **1,988 distinct accounts**. Splitting it correctly is a precondition for most decisions below, and it was got wrong twice before it was got right:

| | accounts | |
|---|---|---|
| have an awarded period somewhere in the account family | 297 | recoverable |
| no awarded period on any `proposal` row in the family | 1,691 | |
| ...of which carry a **proposed** period (`pp_st_dt`/`pp_end_dt`) | 1,521 (89.9%) | not a data-entry gap |
| ...of which are dateless in every sense | 170 | |

By project status, the 1,691 are **980 `In Process`, 699 `Active Award`, 12 `Expired Award`**.

Two corrections that this table encodes, both of which had already been stated wrongly in working notes before they were measured:

1. **"Dateless in InfoEd" was false for 90% of the apparent backlog.** The measurement had only ever asked about `app_st_dt`/`app_end_dt`. Sibling columns `pp_st_dt`/`pp_end_dt` are populated on 1,521 of them and are read nowhere in this codebase. (A word-boundary grep is required to confirm that: `app_st_dt` contains `pp_st_dt` as a substring, so the naive search returns false hits.)
2. **The 980 `In Process` accounts are not a gap at all.** An unawarded proposal correctly has no awarded period. Counting them inflated the ask to OSRA by roughly a factor of three.

The genuinely actionable population — awarded, but carrying no awarded period — is **711 accounts**, and D8 narrows that further to 153.

## Decisions

### D1 — The project period is a property of the ACCOUNT, not of the (cwid, account) pair

Shipped in #2176. `begin_date`/`end_date` come from an aggregate over `wc_infoedprod.dbo.proposal` grouped on `Account_Number` alone.

The previous aggregate grouped `infoed_all` by `(cwid, Account_Number)`. Because `infoed_all` rows only exist where that specific CWID's `proppds`/`faculty` join fired, a person attached only to a dateless child or amendment `prop_no` never saw the parent proposal's real dates.

Two sub-decisions that are load-bearing and easy to undo by accident:

**The aggregate reads `dbo.proposal` directly, not `infoed_all`.** Re-aggregating `infoed_all` would be cosmetic: it only ever sees rows that already survived the personnel join, which is the bug. It also has a second effect nobody predicted — `dbo.proposal` sits *upstream* of the `pgm_type` join in D5, so the fix works even though the dated parent row is usually deleted by that join. This is why D1 did not have to wait for D5.

**Flat family `MIN`/`MAX`, with no parent-preference tie-break.** A first draft preferred the parent `prop_no`'s own period when it had one. Review found two defects: it *narrows* the period on accounts whose continuations run past the parent's end date, silently flipping published grants from Active to Past via `isFundingActive`; and choosing `begin_date` and `end_date` from independently-selected rows can emit `startDate > endDate`, a state the previous per-CWID `MIN`/`MAX` could not produce.

**Consequence accepted:** on an account whose family periods genuinely diverge, the span can be wider than any single sibling's. Measured at 6 pairs across 4 accounts out of 13,725 currently-dated pairs.

### D2 — Only the AWARDED period is ever published as a project period

The proposed period (`pp_st_dt`/`pp_end_dt`) is present for 1,521 backlog accounts and is **not** adopted.

A proposed period is what was asked for, not what was granted. `Grant.startDate`/`endDate` drive `isFundingActive`, the active/past split on the profile, `hasActiveGrants`, the funding-index project window, and recency ranking. Publishing a proposed period asserts to a reader that a sponsor funded work it may never have funded.

**This is a policy decision, not a technical limitation.** If it is ever revisited, the period must carry a distinct `datesSource` (see D3) and must be visually distinguishable at every surface that renders it — the same discipline the RePORTER backfill already follows.

### D3 — A derived period never masquerades as an authoritative one

`Grant.datesSource` records where the period came from: `'infoed'` when InfoEd supplied it, `'reporter'` when it was adopted from NIH RePORTER for an award InfoEd left undated.

Critically, **a backfilled row keeps its `grant_date_gap` row OPEN**. A derived period makes the grant render; it does not make the InfoEd record correct, and the worklist must still carry it to OSRA. `GrantDateGap.status = 'backfilled'` exists precisely to express "visible but still wrong at source".

`datesSource` is currently written and never read at any UI surface. #2180 covers surfacing it where a correction would actually start.

### D4 — Grant data comes from InfoEd and NIH RePORTER, and from nothing else

`reciterdb` is not a grants source. It is a ReCiter-side database whose grant tables are populated by a Python sync (`update/retrieveReporter.py`) in another repository, on a schedule and with a scope we neither see nor control.

**D4a — the date backfill (shipped, #2140).** `etl/infoed`'s undated-award backfill now calls `api.reporter.nih.gov` directly. Evidence that the indirection was costing us: a live check against every open gap found the mirror missing **30 of 73** still-undated NIH awards RePORTER itself has a period for, including an active CDC-funded award. Calling RePORTER directly also removed the ReciterDB/VPC dependency from that ETL step.

**D4b — enrichment (not yet done, #2182).** `etl/reporter` still reads `reciterdb.grant_reporter_project` for `applId`, `abstract`, `keywords` and `meshDescriptorUis` — the entire topical signal for every grant in the system — and `reciterdb.grant_provenance` for `grant_publication`.

That mirror holds exactly **one** distinct `org_name`. An incoming subaward's core project number belongs to the *prime* institution, so it can never match. Measured over 66 grants belonging to four investigators named in an administrator report: **0 of 19 subaward grants are enriched**, and **50 of 66 (76%) carry no topical signal at all**, including 18 of the 28 currently active. Those grants render on a profile but are invisible to every disease-filtered view — which is the entire content of the "missing grants" report that prompted this work.

### D5 — The `pgm_type` INNER JOIN stays, deliberately, and its replacement must separate two concerns

`INNER JOIN wc_infoedprod.dbo.codetab AS ct ON prop.pgm_type = ct.codeid` deletes the **whole proposal row** when `pgm_type` is NULL — not just the program-type label. That is a real defect (#2174), and it is systemic: `pgm_type` is NULL on **18,113 of 62,474** in-scope rows (29%). The join is acting as an undocumented 29% filter on the entire grants feed.

**It was fixed, measured, and deliberately reverted before merge.** A bare `INNER` → `LEFT` swap admits **+13,922 (cwid, account) pairs** across +11,636 accounts, of which ~1,313 have dates and would become visible grants (only 15 of them Active Awards; the rest expired, concentrated 2013–2016). The other ~8,276 arrive undated and land in the OSRA worklist, taking it from 2,525 to roughly 10,800 rows — a 4.3× increase in a list whose purpose is to be worked down.

The swap also silently mutates rows that **already publish**: `MAX(Award_Number)`, `MAX(Sponsor)`, `MAX(proj_title)`, `MAX(Primary_PI_Flag)` and `MIN(Role_Category)` all aggregate over every `infoed_all` row for the account, so newly-admitted rows can change an existing grant's award number (which feeds the RePORTER join, `mechanism` and `nihIc`), its displayed title and funder, and a person's role.

**Any accepted fix must let a `pgm_type`-null row contribute its dates to the account aggregate without admitting it to the published feed.** Those are two changes, not one join swap. Sized as a one-line change it is a data-quality incident.

The other five `INNER JOIN`s in `infoed_all` (`ct2`/prop_type, `projstatxref`, `cdp`/projstat, `projmain`, `sponspas`) were measured at **zero** drops in the same scope. This is one join, not a class of bug.

### D6 — `PMAward`/`PMAwardInc` is not a project-period source

Refuted by **census, not sample**: 0 of 1,691 undated accounts recover a period from it, across every project status and every age quartile.

Recorded in detail because this was investigated three times by sampling and produced three contradictory hit rates (31%, 0%, 0%):

- `PMAward.ProjID` resolves to `ProjMain` rows with `System='AWD'` for **16,457 of 16,457** rows — never `'PT'`. `AWD` has its own `Prop_no` sequence that **collides numerically** with low PT account numbers, which is what manufactured the phantom 31%.
- `PMAwardInc.ObjectID` matches **0 of 39,159** `ProjMain` rows. `PMAward.AwardNumber` matches **0 of 16,412** `proposal.spon_awd`.
- The one working bridge, if it is ever needed for another purpose: `PMAwardInc.BUD_ID` characters 11–20 equal the PT `prop_no` (**30,455 of 30,466** resolve).
- Decisively: `PMAward` rows exist **only** where `app_st_dt` is already populated. Both are written by the same OSRA award-setup event, so `PMAward` can never lead the column we already read.

`ProjPerformancePeriods`, `rpt_performance_period`, `pmawarddata`, `PT_BM_Periods` and `PT_BM_PeriodInc` are all **0 rows**. A sweep of all 281 non-empty date-bearing joinable tables in `wc_infoedprod` found nothing else usable.

**Do not re-open this by sampling.** A census exists; sampling here has a demonstrated failure mode.

### D7 — Only Active and Expired awards count as a data gap

`In Process` records correctly have no awarded period, because they have not been awarded. They must continue to be *imported* (they are real awards mid-setup — verified 2026-07-14 against funders' own records), and they must not be *reported* to OSRA as missing data.

### D8 — Records are classified by central office AND intake type, never by office alone

Two `prop_u` columns carry the classification. `P_SIN_18` is the central office (`OSRA` 31,446 / NULL 30,950 / `JCTO` 11,846 / blank 1,015). `p_sin_5` is the intake type (free text, 13 values) — **already selected in `CONSOLIDATED_QUERY` as `intake_type` and discarded**, which is why nothing downstream could use it.

Office alone looks decisive and is not:

| Office × intake | no awarded period | has one | % awarded |
|---|---|---|---|
| JCTO × Clinical Trial Agreement | 5,565 | 1 | **0.0%** |
| JCTO × (blank) | 4,133 | 0 | **0.0%** |
| JCTO × Grant | 3 | 166 | **98.2%** |
| OSRA × Grant | 90 | 6,103 | 98.5% |

JCTO's *agreement-tracking* records never award — it uses InfoEd for tracking and does not formally award after execution, because account management happens outside a WBS. But JCTO on an actual Grant awards at the same rate as OSRA. **Excluding JCTO wholesale would be wrong.**

Applying office and intake together narrows the 711 actionable accounts to **153** a real OSRA ask, plus 187 pending a direction ruling (171 of them `Service Agreement (WCM)`), with 371 set aside as structurally never-awarded.

**A heuristic that failed, recorded so it is not adopted later:** "records that do not involve incoming funding, or represent outgoing funding, will almost certainly not have an awarded increment" is intuitive, was offered by a domain expert, and is **wrong at population scale**. Outgoing Consulting Agreements carry an awarded period **62.8% of the time (98 of 156)** — above the overall average. The intake types that genuinely predict no award are Clinical Trial Agreement (0.0%), Research Collaboration Agreement (11.9%), blank (13.3%), Data Use Agreement (23.6%) and Confidential Disclosure Agreement (25.1%).

Note also that intake type is **unpopulated on ~24% of accounts**, so it cannot be the sole discriminator either.

### D9 — Confidentiality is enforced by two independent nets

InfoEd's own "Confidential" checkbox (`prop_u.p_log_50`, excluded at the source query) is a **manual** flag and is demonstrably not always set: a live check found it unset on real CDAs and NDAs, including two then-active records already public on profiles.

Since #2140, any InfoEd row whose title matches a word-boundary check for `CDA`/`NDA`/`MTA`/`DUA` or a "Confidentiality Agreement"-style phrase receives a revocable system `Suppression` instead of rendering. The check is deliberately over-inclusive on MTA/DUA: a false suppression is a one-line revoke, a leaked CDA is not.

### D10 — OPEN: whether non-incoming-funding agreements belong on a profile at all

Unresolved, pending an OSRA ruling. Stated here so it is not resolved by accident.

Of the 10,100 published InfoEd grant rows for active scholars, **334 (3.3%) across 295 accounts are not incoming research funding**:

| Funding direction | accounts | grant rows |
|---|---|---|
| incoming funding | 5,441 | 9,766 |
| unclear (service agreements) | 162 | 185 |
| non-funding agreement (MTA/DUA/CDA) | 85 | 89 |
| **outgoing funding** | **33** | **33** |
| unknown (intake blank) | 15 | 27 |

The 33 Outgoing Consulting Agreements are the unambiguous case: the faculty member was paid for consulting rendered *outward*, and the profile renders it as though the sponsor funded their research. The 185 service agreements hinge on whether `Service Agreement (WCM)` denotes incoming or outgoing, which is not derivable from the data.

D9's title-based suppression already removes some of the MTA/DUA/CDA rows incidentally, but only those whose title reveals the type. It is not a substitute for a decision here.

## Consequences

- The `grant_date_gap` worklist means "awarded but carrying no awarded period", not "no date anywhere". Anyone quoting its size externally must say which they mean; the two differ by roughly 9×.
- D1 changes dates for 415 worklist rows across 282 accounts on the first prod run after deploy. Some of those rows currently hold RePORTER-backfilled dates and will switch to InfoEd dates — the intended direction (authoritative over derived), but the values can differ.
- D5 means the published feed remains ~29% smaller than InfoEd's in-scope population, and the OSRA worklist remains correspondingly smaller. Both are deliberate.
- D4b remaining open means subaward-funded and non-NIH-funded investigators have systematically worse topical coverage than NIH-prime-funded ones. This is not a random gap — it is correlated with funding structure, and therefore with discipline.
- D2 means 1,521 accounts stay invisible on profiles despite InfoEd holding a date for them. That is the correct trade, and it is a real cost.

## Verification

D1 was verified end to end against prod InfoEd before merge, running the old and new queries and diffing at the `(CWID, Account_Number)` grain:

- Row admission identical — 17,979 pairs on both sides, zero fan-out.
- 415 worklist rows across 282 accounts recovered.
- Of 13,725 currently-dated pairs: **0 lost a date, 0 narrowed, 0 emitted `start > end`, 0 flipped a grant Active → Past** under `isFundingActive`. Six pairs across four accounts widened.
- The policy blocks partition cleanly with no remainder: 8 non-award-status + 6 Confidential + 1,680 dateless = 1,694.

The guard that exists (`assertPruneVolume("infoed:stale-grants", maxPct: 10)`) provides **no** protection against the failure modes that mattered here. It catches disappearance, and every real risk in D1 was a mutation of a row that continues to exist. Reviews of changes to this query should not treat it as a safety net.

Note also that this change is a **SQL string**. `tsc`, the unit suite, and CI cannot see any of its failure modes. The 8,585-test suite passed on the first draft that contained both the narrowing defect and the inverted-period defect. Only the in-VPC before/after diff caught them.

## Alternatives considered

**Ship D1 and D5 together.** Rejected. An early sizing pass concluded that 4 of the 5 accounts named in #2173 needed the `pgm_type` fix as well, which would have made them inseparable. That pass had measured a re-aggregation of `infoed_all`, which sits *downstream* of the `pgm_type` join; the shipped aggregate reads `dbo.proposal`, which is upstream. All five resolve without D5.

**Adopt the proposed period rather than leave 1,521 accounts undated.** Rejected under D2.

**Exclude JCTO from the worklist entirely.** Rejected under D8 — it would discard 166 legitimately awarded JCTO Grants.

**Widen `assertPruneVolume` to catch date mutations.** Considered and not pursued. The failure modes are directional (narrowed, inverted, source-changed) rather than volumetric, and a volume guard is the wrong shape. The in-VPC before/after diff is the control that works.

## Open questions

1. **D10** — profile admission for outgoing and non-funding agreements. Blocked on OSRA.
2. **`Service Agreement (WCM)` direction** — 171 accounts, the single largest unresolved category. Not derivable from InfoEd; needs OSRA.
3. **Non-NIH topical signal.** Komen, ACS, DOD, PCORI and CDC awards have no RePORTER record, so D4b cannot help them. `Grant.abstractSource` already anticipates `'nsf' | 'pcori' | 'cdmrp' | 'gates'` and fetchers exist under `etl/nsf` and `etl/gates`, but they evidently do not reach these rows.
4. **`NIH_AWARD_RE` rejects 4-character activity codes** (`lib/award-number.ts`), so CDC awards such as `1 NU58DP007916-01-00` cannot parse. Separately, `FHCRC 203865-01` **false-positive parses** to core `FHCRC203865`, treating a Fred Hutch reference number as an NIH award.
5. **OSRA intends to formally award these contract types in future**, which will resolve part of the 711 without any code change. No date given.

## Related

- #2173 / #2176 — D1, merged
- #2140 — D4a and D9, merged
- #2174 — D5, open by decision
- #2175 — D6, refuted by census
- #2180 — D3 surfacing, central office and intake type at the record level in `/edit`
- #2182 — D4b, and the enrichment defect it causes
- #2020 / #2026 — the original undated-award investigation and the RePORTER backfill
- #2038 — the prod nightly's `IntegrityNightly` failure, downstream of `TaskInfoed`
- [`ADR-005`](./ADR-005-manual-override-layer.md) — the suppression/override layer D9 writes into
