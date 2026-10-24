# ORCID librarian confirmation queue — spec

Status: approved 2026-10-23 (Paul). Source plan: `~/Dropbox/Projects/Roadmap/orcid-publication-lane-plan.md`, piece 1. Sizing: `~/Dropbox/Projects/ReCiter Research/analysis/orcid_lane_phase1/README.md`.

## Why

People do not self-confirm ORCID iDs (see #3115: "Confirmation uptake is very low"). The publication lane that imports works from a person's ORCID record needs iDs we trust, so librarians confirm them on evidence. Self-confirm and `/authenticate` (#3115) stay; this adds the librarian path and an email auto-confirm.

## Decisions (do not re-open)

- Librarians are superusers (Paul `paa2013`, `drw2004`). Gate every page and route on `isSuperuser`. No new role.
- An exact match between a scholar's institutional email and a **verified** public email on the ORCID record, with no competitor, confirms the iD automatically (method `email_verified`). Behind a flag, off by default; when off the ETL logs what it would confirm.
- Bands `strong` and `shared_only` are bulk-confirmable only after a librarian reviews a random sample of 50 from that band with zero "Not this person" decisions.
- WCM only for now. Nothing here may assume a cwid format; Cornell NetID scholars come later.

## Data model (one migration)

`scholar`:
- `orcid_confirm_method` `VARCHAR(16) NULL`: `self` | `proxy` | `librarian` | `email_verified`. (`authenticated` is reserved for #3115.) Null = iD came from WCM Identity, or none on file.
- `orcid_confirmed_by` `VARCHAR(32) NULL`: actor cwid for `self` / `proxy` / `librarian`; `"ETL"` for `email_verified`.
- `POST /api/edit/orcid` (existing) sets method `self` when the real actor is the scholar, `proxy` otherwise, and `orcid_confirmed_by` = the real actor. Remove (`orcid: null`) clears both, like `orcid_confirmed_at`.

`orcid_candidate_evidence` (new; full replace per ETL run, key `(cwid, orcid)`):
- `cwid`, `orcid`, `band` (`email_verified` | `strong` | `shared_only` | `moderate` | `weak`)
- `inst_match` bool, `email_verified` bool, `name_agrees` bool
- `shared` int (distinct papers on the record also in the scholar's publications; PMID or DOI, a paper with both counts once — reuse `extractWorkIds` / `indexScholarWorks` / `sharedPapers` from `etl/orcid-registry`)
- `competitor` bool, `competitor_cwids` JSON (string[]), `competitor_orcids` JSON (string[])
- `works_total` int, `new_works` int (works not in the scholar's publications), `new_works_sample` JSON (≤ 5 of `{title, year, doi, pmid, source}` — `source` = the ORCID work summary's source name)
- `record_modified_at` datetime null, `computed_at` datetime

`orcid_queue_sample` (new):
- `id`, `band`, `started_by`, `started_at`, `cwid`, `orcid`, `decision` (`confirmed` | `dismissed` | null), `decided_by`, `decided_at`
- One open sample per band at a time. A sample is "passed" when all its rows are decided and none is `dismissed`.

## Evidence ETL `etl/orcid-evidence`

Weekly, after `etl:orcid-registry`. `npm run etl:orcid-evidence [-- --dry-run]`. Same conventions as `etl/orcid-registry` (`withEtlRun`, anonymous ORCID client allowed, fail loud on an ORCID outage or 401/403, refuse to write an empty set, `MAX_RECORDS` smoke forces dry run).

Population: every distinct `(cwid, orcid)` in `orcid_candidate` (all sources) for an active scholar, minus pairs in `orcid_dismissal`, minus pairs where `scholar.orcid` already equals that iD.

Per iD fetch `GET https://pub.orcid.org/v3.0/{orcid}/record` once (shared across scholars). Evidence:

- `email_verified`: a public email on the record with `verified: true` equals (case-insensitive) the scholar's `email`.
- `inst_match`: any employment or education organization name contains "Weill Cornell" or "Cornell" (case-insensitive), OR its disambiguated ROR id is `https://ror.org/02r109517`, OR any public email ends in `cornell.edu`. Use the `INSTITUTIONS` constant, not a new literal, for the WCM values.
- `name_agrees`: record given name agrees with the scholar's (`givenNamesAgree`), AND surnames agree after `nameTokens` folding: the record family name's tokens and the scholar's surname tokens share at least one token of length ≥ 3, or are equal once spaces and hyphens are removed. Must pass for: "Jaffré"/"Jaffre", "Navarro-Millán"/"Navarro-Millan", "Al Hariri"/"Alhariri", "Sanchez"/"Sanchez Garcia-Vao", "Prieto"/"Prieto Fernandez". An empty family name with the full name in given names: split it and retry (the registry already handles this case; reuse it).
- `competitor` = any of:
  - another active scholar with the same `lastNameKey` holds ≥ 3 papers from this record's works that are NOT in this scholar's publications;
  - another candidate iD for this scholar has `shared` ≥ 3;
  - the same iD is a candidate for another scholar (any source) and that scholar's `shared` ≥ 3.
- `band` (first match wins):
  1. `email_verified` — `email_verified` and not `competitor`
  2. `strong` — `inst_match` and `shared` ≥ 3 and not `competitor` and `name_agrees`
  3. `shared_only` — `shared` ≥ 3 and not `competitor` and `name_agrees` (no `inst_match`)
  4. `moderate` — two or more of {`inst_match`, `shared` ≥ 3, not `competitor`}
  5. `weak` — everything else

Band logic is a pure exported function with unit tests covering each band and every name case above.

### Email auto-confirm

Same ETL, after the evidence write. Flag `ORCID_EMAIL_AUTOCONFIRM` (`on` = write; anything else = log the would-confirm count and cwids only). For each `email_verified` row where `scholar.orcid` is null: set `scholar.orcid`, `orcid_confirmed_at` = now, `orcid_confirm_method` = `email_verified`, `orcid_confirmed_by` = `"ETL"`, plus an audit row (`orcid_email_autoconfirm`). Never overwrite a non-null `scholar.orcid`. `etl:orcid-push` then carries it to Identity as for any other `scholar.orcid`.

Wire the task and its schedule in `cdk/lib/etl-stack.ts` following `orcid-registry`, the flag per env in the ETL task definition (off in every env), `scripts/release/flag-parity-allowlist.txt`, freshness policy and ETL source copy entries like the registry's, and update the cdk snapshot tests.

## Queue page `/edit/orcid-queue`

Console page (`ConsoleShell`), superuser only (`requireSuperuserGet` on GET, `isSuperuser` on every route). Add it to the admin subnav next to ORCID coverage. Follow the layout and components of an existing queue page (`/edit/titles-queue` or `/edit/grant-attribution-queue`); no new design language.

- Band tabs with counts: Email verified, Strong, Shared papers, Moderate, Weak. Default tab Strong.
- Rows exclude pairs already on file, dismissed pairs, and scholars whose `scholar.orcid` holds a different iD (those go in a separate "Conflicts" tab: on-file iD vs candidate, never bulk-confirmable).
- Row: scholar name (link to profile), title, department; iD (link to orcid.org); evidence chips (institution, verified email, name, shared N, competitor); new works N with the sample (title, year, source); competitor names/iDs when present; Confirm and Not this person buttons.
- Email verified tab shows confirmed rows too (method `email_verified`), each with Undo (= Remove: clears `scholar.orcid` and writes a dismissal).

### Sample gate and bulk confirm (Strong, Shared papers only)

- "Review a sample of 50": creates an `orcid_queue_sample` with 50 random undecided rows of the band (fewer if the band is smaller). The tab then shows the sample first.
- Each decision in the sample writes the same confirm / dismiss as a normal row and stamps the sample row.
- When the sample is passed, "Confirm remaining N" appears. One POST confirms every remaining row of the band that STILL qualifies when the server re-reads it (band unchanged, no on-file iD, no dismissal). Batch the writes; return confirmed / skipped counts. One `orcid_bulk_confirm` audit row with the count and sample id, plus per-scholar confirm audit rows.
- A dismissal in the sample locks bulk for that band and says so; "Review another sample" starts a fresh one.

### Routes

- `POST /api/edit/orcid-queue/decide` `{cwid, orcid, decision: "confirm" | "dismiss", sampleId?}`
- `POST /api/edit/orcid-queue/sample` `{band}` → creates or returns the open sample
- `POST /api/edit/orcid-queue/bulk-confirm` `{band, sampleId}` → refuses unless that sample is passed and is the band's latest

Confirm = same writes as `POST /api/edit/orcid` confirm (`scholar.orcid`, `orcid_confirmed_at`, delete the pair's dismissal) plus `orcid_confirm_method = "librarian"`, `orcid_confirmed_by` = real actor cwid (impersonation never counts as the librarian). Dismiss = an `orcid_dismissal` row. Every write in one transaction with its audit row. New audit actions `orcid_librarian_confirm`, `orcid_librarian_dismiss`, `orcid_bulk_confirm`, `orcid_email_autoconfirm`: register in `lib/edit/audit.ts` and all ENUM sites in `scripts/sql/audit-log.sql`.

Gate the page, routes and subnav link on flag `ORCID_LIBRARIAN_QUEUE` (`on` in staging, off in prod in `cdk/lib/app-stack.ts`; flag-parity allowlist).

## Deviations (deliberate, from review)

The build is stricter than the text above in these places:

- **On file includes `rpm_admin`.** Everywhere this spec says "`scholar.orcid`" for what is on file (population, Conflicts, the bulk re-check, the auto-confirm's "`scholar.orcid` is null"), the build reads `scholar.orcid`, else an undismissed `rpm_admin` candidate iD. That is how `/api/edit/orcid` and the coverage fold read it; WCM usually leaves `scholar.orcid` NULL. Replacing an `rpm_admin` iD from Conflicts dismisses it, and dismissing one here is a 409 (that is Remove on /edit).
- **Email auto-confirm** also requires exactly one `email_verified` row for the scholar and for the iD, and that no other scholar holds the iD: two verified matches are a question for a librarian, not the ETL.
- **Bulk confirm and sampling** leave out a scholar with two qualifying rows in the band (only one iD can be theirs). Those rows stay in the tab for one-at-a-time decisions, and the bulk response counts them as skipped.
- **A competitor that cannot be ruled out counts.** When another candidate iD of the same scholar could not be fetched this run, the pair is marked competitor, so a degraded run never lifts it into a confirmable band.
- **Confirm never overrides a dismissal** (409 `dismissed`): unlike the scholar's own `/api/edit/orcid` confirm, a librarian does not undo the scholar's Remove or an earlier Not this person.
- **Samples.** A sampled confirm whose iD went on file by another route stamps the row confirmed and writes nothing else. "Start a new sample" abandons an open sample. A passed sample stops authorizing bulk once a later ETL run re-scores the band (any evidence `computed_at` after the sample started); review a new one.

## Tests

Unit tests (vitest, `--maxWorkers=4`) for: band function and name cases; evidence assembly from a fixture record; competitor rules; email auto-confirm (flag off = no write, never overwrites, dismissal respected); each route's authz (non-superuser 403, impersonation), sample lifecycle (pass, lock on dismissal, stale sample refused), bulk re-check skipping rows that changed; existing `/api/edit/orcid` sets method `self` / `proxy`.

## Out of scope

Cornell NetID scholars; mirroring iD + method to reciterdb (the publication lane's PR); `/authenticate` (#3115); any change to `etl:orcid-push` beyond what the new columns require.
