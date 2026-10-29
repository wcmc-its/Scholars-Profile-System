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

- **On file is `scholar.orcid` only** (2026-10, Scholars is the ORCID authority). An iD typed into Publication Manager (`rpm_admin`) or held in WCM Identity (`identity`, written by `etl/identity`) is a candidate like any other: it is confirmed or dismissed here, and it never makes another candidate a conflict. Until then an undismissed `rpm_admin` iD counted as on file.
- **Email auto-confirm** also requires exactly one `email_verified` row for the scholar and for the iD, and that no other scholar holds the iD: two verified matches are a question for a librarian, not the ETL.
- **Bulk confirm and sampling** leave out a scholar with two qualifying rows in the band (only one iD can be theirs). Those rows stay in the tab for one-at-a-time decisions, and the bulk response counts them as skipped.
- **A competitor that cannot be ruled out counts.** When another candidate iD of the same scholar could not be fetched this run, the pair is marked competitor, so a degraded run never lifts it into a confirmable band.
- **Confirm never overrides a dismissal** (409 `dismissed`): unlike the scholar's own `/api/edit/orcid` confirm, a librarian does not undo the scholar's Remove or an earlier Not this person.
- **Samples.** A sampled confirm whose iD went on file by another route stamps the row confirmed and writes nothing else. "Start a new sample" abandons an open sample. A passed sample stops authorizing bulk once a later ETL run re-scores the band (any evidence `computed_at` after the sample started); review a new one.

## Tests

Unit tests (vitest, `--maxWorkers=4`) for: band function and name cases; evidence assembly from a fixture record; competitor rules; email auto-confirm (flag off = no write, never overwrites, dismissal respected); each route's authz (non-superuser 403, impersonation), sample lifecycle (pass, lock on dismissal, stale sample refused), bulk re-check skipping rows that changed; existing `/api/edit/orcid` sets method `self` / `proxy`.

## Out of scope

Cornell NetID scholars; mirroring iD + method to reciterdb (the publication lane's PR); `/authenticate` (#3115); any change to `etl:orcid-push` beyond what the new columns require.

## v2 (2026-10-25)

Source: `~/Dropbox/Projects/Roadmap/orcid-queue-v2-spec.md`, approved from a review of the live prod queue. This PR builds its items 1 to 8; item 9 (the Publication Manager deep link) is a later PR. Everything in v1 above still holds: the superuser gate, the View-as refusal, the sample gate, the server re-check in bulk, never confirming over a dismissal, and (until 2026-10) `rpm_admin` counting as on file.

### Data model (one migration, `20261025120000_orcid_queue_v2`)

- `orcid_candidate_evidence.history_match` `BOOLEAN NOT NULL DEFAULT false`.
- `orcid_candidate_evidence.evidence_detail` `JSON NULL`: the facts behind each chip (`OrcidEvidenceDetail` in `lib/edit/orcid-queue.ts`): both names and the surname rule that matched, every matched institution pair (ORCID side with kind and years, our side with its source: `wcm`, `education`, `appointment`, `identity`), a cornell.edu email on the record, the verified email, the shared papers (PMID, DOI, title, year, journal from our publications, first 100), the competitor detail (who, how many papers, which rule), the pair's sources, and how many works the filter dropped. NULL on rows a v1 run wrote; the page shows "the details arrive with the next weekly evidence run".
- `orcid_queue_sample.filter_key` `VARCHAR(1024) NOT NULL DEFAULT ''`: the canonical filter a sample was drawn under (`orcidQueueFilterKey`; `''` = none, so v1 samples read as unfiltered).

### Evidence ETL

- **history_match** (item 1, `etl/orcid-evidence/institution-match.ts`): an ORCID employment or education organization matches an institution in the scholar's own history: `education.institution` (ASMS degrees), `profile_appointment.organization` with category `EXTERNAL`, and ReCiter Identity `identity.institutions`, read once per run with one paged Scan of the Identity table (`etl/orcid-evidence/identity-institutions.ts`, the same table, region and task-role grant `etl/identity` uses). Names are folded, lowercased, stripped of punctuation and a leading "The", common abbreviations expanded (Univ, Ctr, Centre, St, Mt, ...) plus a short list of unambiguous acronyms (MIT, UCSF, MSKCC, ...), and "University of X" also reads as "X University" (whole names only, never as a prefix, and never for an X where the two forms are different places: Washington, Miami, Ohio, Indiana, Saint Louis, Rochester, ...). USC is not expanded (Southern California or South Carolina). Two names match when equal, or when the shorter starts the longer and what follows is an "of" / "at" clause after a complete institution name ("Albany Medical College" ↔ "Albany Medical College of Union University") or only generic words ("University of Rochester" ↔ "University of Rochester Medical Center"). The shorter must carry a distinctive word that is neither generic nor a weak descriptor (children's, state, memorial, city, cancer, royal, ...), so "Children's Hospital" or "State University" never match. A comma-separated part that is a multi-campus system's name ("State University of New York", "University of California") never matches on its own.
- **Band rule** (decision C): `inst_match OR history_match` is the institutional condition, for Strong and for Moderate's two of three, once `ORCID_HISTORY_BAND` is exactly "on" (cdk etl-stack, off in both envs). Until then the ETL writes `history_match` and `evidence_detail` but bands on `inst_match` alone, and each run logs the band moves the history term would make (`historyBandShift`), per the spec's Phasing step 2: compare band counts before switching the band rule.
- **Non-publication works** (item 3, `etl/orcid-evidence/work-filter.ts`, `filterPublicationWorks`, pure and exported for the Phase 2 harvest): drops types `image`, `data-set`, `software`, `lecture-speech`, `conference-poster`, `conference-abstract`, `website`; an `other` or untyped work titled as a figure or supplement ("Figure 3", "Table S1", "Supplementary ..."); a Figshare (`10.6084`) or Zenodo (`10.5281`) DOI unless typed `journal-article`. Collapses preprint versions: works sharing a normalized title (trailing `v1`/`v2` ignored) or a DOI up to its version suffix form a group when the group holds a preprint (type `preprint` or a preprint-server DOI). The group keeps its published works, or the highest-version preprint when none is published, and the kept work takes every id of the works it absorbed. Runs before `works_total`, `new_works`, the new-works sample and `shared` are counted. The new-works sample also stores each work's own URL.

### Queue page

- **One card per scholar** (item 5): every candidate iD, best first (band, then shared papers, then name agreement). The card's tab is `cardTabOf`: Email verified when the ETL confirmed one of their iDs, Conflicts when another iD is on file, else the best band. Tab counts are scholars. Confirm and Not this person act per iD; on a card with other open candidates, Confirm also marks them Not this person in the same request (a checkbox, on by default, turns it off).
- **Names side by side** (item 4): "Scholar" (fullName / preferredName) and "ORCID" (credit name, else given + family, with given + family and other names as "also known as"), with the result and the rule: same surname, same once accents are folded, a compound surname shares a part, or same once spaces and hyphens are removed; plus whether the full given name agrees.
- **Chips that open** (item 2): Institution (each pair), Verified email, Name, Shared N (each paper linked), Competitor (who, K papers, which rule; an unfetched iD says so), How discovered.
- **Filters** (items 6 and 7): one sticky bar, the `/edit/orcid-coverage` popover: person type, department / division, institution (`lib/edit/person-filter.ts` values and `personFilterWhere`), and how discovered (`orcid_candidate.source`: `rpm_inferred`, `rpm_admin`, `identity`, `orcid_email`, `orcid_works`, `orcid_crossref`, `orcid_name`). URL params `type`, `unit`, `source`. The filter applies to the list, the counts, the sample draw and bulk confirm. A source chip on each iD, "N sources agree" when two or more found it.
- **Links** (item 8): each new work and each shared paper links to PubMed when it has a PMID, else doi.org, else the ORCID work's own URL (http/https only). The scholar name links to the profile, the iD to orcid.org.

### Routes

- `decide` takes `dismissOthers?: string[]` with `confirm` (max 20, each normalized). After the confirm, each other iD gets a dismissal and its own `orcid_librarian_dismiss` audit row (`with_confirm_of`), in the same transaction. Each must be one of the scholar's candidates in `orcid_candidate_evidence`, else 404 `other_not_in_queue` and nothing commits.
- `sample` and `bulk-confirm` take `filter?: { types, units, sources }` (sanitized: sorted, de-duplicated, units `dept:` / `div:` / `inst:` only, sources from the list above; malformed = 400). A sample stores the filter's key. Bulk confirm refuses (409 `filter_mismatch`) when the sample's filter differs from the request's, and confirms only rows inside the filter.

### Deviations (deliberate)

- **Qualifying for a sample or bulk** also requires that the scholar's best open band IS the band, besides v1's one-row-in-the-band rule. So a sampled pair always sits on its band's tab, and Strong and Shared papers samples never share a scholar. Both rules read the scholar's full candidate set, never the filtered one: a filter can narrow which pairs qualify but cannot hide a second iD.
- **One sample per band, across filters.** Drawing a sample under one filter abandons an open sample drawn under another; bulk confirm needs the band's latest sample and the same filter. The panel says when the latest sample belongs to another filter.
- **The source filter is per card for the list** (a card shows when any of its iDs was found that way, and still lists every iD) **and per pair for the sample and bulk** (the confirmed pair itself must carry the source). Sources are read live from `orcid_candidate`; `evidence_detail.sources` keeps the scoring-time snapshot.
- **Centers are not offered** in the filter: the spec names person type, department / division and institution.
- **No ROR match for history**: none of the three history sources carries a ROR id, so names are the only key.
- **Name matching is conservative**: a comma-separated name is split into institutions only when every distinctive part names an institution, so "University of California, San Francisco" never yields "University of California"; a system name never matches a campus ("University of Texas" ≠ "... at Austin"). Location suffixes ("University of Rochester, Rochester, NY") therefore miss.
- **A failed Identity Scan** logs a warning and the run goes on with education and appointments only, instead of failing the run: without that source a pair can only score lower.
- **Figure titles** are dropped when the work is typed `other` or not typed at all. A work group with any `journal-article` copy counts as a journal article.
- **Preprints group by title** only when the normalized title has at least 20 characters, so short generic titles ("Reply") never collapse; groups with no preprint are never collapsed.
- **Not built here**: item 9 and item 8's Publication Manager curate link (both PM links, the next PR).

## v2.1 (2026-10-26)

Source: `~/Dropbox/Projects/Roadmap/orcid-queue-v2-spec.md`, section "v2.1", from a review of the prod queue after #3155. Items 1 to 5. No migration: the new facts live in `new_works_sample` entries and `evidence_detail`.

### Evidence ETL

- **Supplements** (item 1, `work-filter.ts`): dropped whatever the ORCID type when the title opens "Supplementary / Supplemental <material noun> ..." (materials, data, information, files, tables, figures, methods, appendix, videos, text, notes, ...), or "(Figure|Fig.|Table|Data|Movie|Video|File|Appendix) S?<n>[a-z]? (from|for|of) ...", or "Supplementary (Figures|Tables) S<n>-S<n> from ..."; and any AACR supplement DOI, `10.1158/<ISSN>.<6+ digits>[.vN]` (an AACR article DOI has letters after the ISSN and is kept).
- **DOI to PMID** (item 2, `pubmed-resolve.ts`): every DOI of a work with no PMID goes to the PMC ID converter (`pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/`, 200 per call), then what is left to PubMed ESearch `"<doi>"[aid] OR ...` (40 per call) mapped back to each DOI through ESummary `articleids`. Exact only: a DOI two PMIDs claim stays unresolved. 3 req/s, 10 with `NCBI_API_KEY` (already allowlisted as an optional key; not wired in cdk, so the deployed run is keyless until it is); 3 retries on a network error, 429 or 5xx; 20 s per request. Cached per run. Never throws: a failed batch leaves its DOIs unresolved and is counted, and three failed batches in a row stop the lookups for the run. The run logs requested / converter / [aid] / unresolved / failed batches. A resolved PMID joins the work's ids, so it can count as shared (and so move a band) like a PMID the record carried.
- **Title match** (item 3): a work with no id at all is matched to the scholar's own publications by title (HTML tags and entities removed, accents folded, lowercased, punctuation to spaces, at least 20 characters) and publication year within one. Exact normalized equality, and exactly one of the scholar's papers; a missing year on either side never matches. A match gives the work that paper's PMID, so it counts as shared and leaves the new works.
- **ReCiter status** (item 4): each scholar's assertions are read from reciterdb `person_article` (`SELECT personIdentifier, pmid, userAssertion ... WHERE personIdentifier IN (?) AND pmid IN (?)`, only the PMIDs on that scholar's candidate records, 200 scholars x 2,000 PMIDs per query) through `lib/sources/reciterdb.ts`, the client `etl:reciter` uses. `ACCEPTED` = accepted, `REJECTED` = rejected, any other row (NULL, 'NULL', PENDING) = pending; no row for a known PMID = `not_retrieved`; a DOI that did not resolve = `not_in_pubmed`; neither id = `no_ids`. An accepted PMID our publications lack is added to the scholar's work index, so it counts as shared and is excluded from new works (the 33 wrongly shown as missing). Each `new_works_sample` entry carries `status`; `evidence_detail.workStatus` holds the new works per status, `unknown`, `reciterRead`, `acceptedInReciter`, `resolvedByDoi` and `resolvedByTitle`. The run logs the totals.
- **Task family moved**: SPS does not mirror pending assertions (it keeps accepted authorships in `publication_author` and, since #3071, rejections in `reciter_rejected_pmid`), so the evidence step reads reciterdb itself. `etl:orcid-evidence` is now in `SOURCES_SCRIPTS` (`cdk/lib/etl-stack.ts`) and `OrcidEvidenceWeekly` runs on `sps-etl-sources-<env>`, which carries the reciterdb secret; same task role, so the Identity Scan grant is unchanged. Snapshots updated. Takes effect on a `cdk deploy --exclusively Sps-Etl-<env>`.

### Queue page

- **Status per work** (item 5): the preview header adds "ReCiter: N pending · N rejected · N not retrieved · N not in PubMed · N with no identifiers", plus "N accepted in ReCiter counted as shared" and, when the run could not read reciterdb, says so. Each work shows its status chip and its link: the title links to PubMed for any PMID (else doi.org, else its own https URL, unchanged); pending and rejected get "Review in Publication Manager" (`<pm>/curate/<uid>`), rejected labelled "Rejected in ReCiter: re-review"; `not_in_pubmed` gets "Add in Publication Manager" (`<pm>/curate/<uid>?add=external&doi=<doi>`, PM #1047).
- **PM base URL**: `PUBLICATION_MANAGER_URL`, wired in `cdk/lib/app-stack.ts` (both envs `https://reciter.weill.cornell.edu`), read by `publicationManagerBaseUrl()`; https only (no credentials, query or fragment), else the SPS-wide `PUBLICATION_MANAGER_URL` constant in `lib/edit/request-a-change.ts`. `pmCurateHref` URL-encodes the uid and the DOI and returns null for a non-https base. doi.org links now encode the DOI per path segment.

### Deviations (deliberate)

- **"Supplementary / Supplemental" alone does not drop a work**: it must be followed by a material noun, so "Supplemental oxygen after surgery" and "Supplemental Nutrition Assistance Program ..." stay. The item-word pattern must open the title. The title rules (not the AACR DOI rule) still spare a work whose ORCID record carries a PMID.
- **No migration**: the per-status counts are in `evidence_detail.workStatus`, not columns; the spec allowed either.
- **Status unknown**: when reciterdb cannot be read, a PMID work's status is null (no chip), counted as `unknown`, and no accepted lift happens; `not_in_pubmed` and `no_ids` do not depend on ReCiter and are still set. The run never fails on it.
- **Both envs link to production Publication Manager**: staging's scholars are prod's people, and the dev PM is not guaranteed to carry #1047.
- **Pending and rejected come from reciterdb, not DynamoDB GoldStandard**: `person_article` already holds every candidate ReCiter retrieved for the person with its assertion, which is also what separates `pending` from `not_retrieved`; GoldStandard holds only accepted and rejected PMIDs.
- **Bands can move**: a resolved PMID, a title match or a ReCiter acceptance raises `shared` like any shared paper. Compare band counts on the first v2.1 run.

## v3 PR A (2026-10-26): master–detail redesign

Plan: `Roadmap/orcid-queue-v3-redesign-plan.md` (Projects). Mockup: `Projects/Scholars-Profile-System/mockups/ORCID Queue Redesign/` v5. UI only; no schema change.

### Queue page

- The band tabs are gone. The page loads every scholar in the queue as a summary (`loadOrcidQueue`); the selected scholar's card comes from `GET /api/edit/orcid-queue/scholar?cwid=` (`loadOrcidQueueCard`), gated like the page.
- Each scholar carries a 5-step "Match evidence" meter from their best iD (`bandLevel`: Weak 1 … Email verified 5). A competitor blocks steps 3–5, drawn amber.
- Search (name, CWID, iD with or without dashes), Confidence, Decision (default Unassigned) and Possible errors (a different iD on file) run in the browser. Person type, department, institution and how discovered stay server-side (`?type=&unit=&source=`).
- Sorts: Strongest match (`candidateScore`), Clearest winner (`scholarGap`), Department then name, Name, CWID.
- One table per scholar, a column per signal. An opened row shows the competitor rule that fired (`competitorRules`: 1 same-surname scholar, 2 another plausible iD, 3 iD shared with another scholar), names, signals, and publications ORCID vs. ReCiter (`reciterTotal` = confirmed `publication_author` rows).
- The card shows the iD on file and where it came from (`OrcidOnFile.how`).

### Routes

- `decide` drops `sampleId`. "None of these" is a dismiss with the rest in `dismissOthers` and `noneOfThese: true`; each audit row carries `none_of_these: true`.
- `sample` and `bulk-confirm` are removed. The `orcid_queue_sample` table stays; nothing writes it.

### Deviations (deliberate)

- No "Only in ReCiter" list, only its count: the ETL keeps a capped sample of shared papers, so the exact set isn't known. PR B.
- No Undo of a librarian decision, no "Same person, duplicate iD", no one-iD-two-scholars compare, no "Decided by", and no queue-age sorts. Each needs the `orcid_decision` table (PR B).
