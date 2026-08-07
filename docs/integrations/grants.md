# Grants integration — InfoEd (WRG) and NIH RePORTER

**This is an integration spec, not an ADR.** It is a living document: no status header, no
immutability, no "accepted/proposed". Edit it freely and in place. An ADR answers *why did we do it
this way rather than the obvious way*; a registry entry answers *where does this field come from*.
This document answers **how grants actually work, and what to do when the feed breaks at 4pm on a
Friday**.

Written for a maintainer who has been paged and has never seen this feed before. Read §8 first if
something is already broken.

**Scope.** InfoEd is the system of record for WCM sponsored-project administration. NIH RePORTER
writes to the same `Grant` table, repairs dates InfoEd left blank, and creates net-new rows InfoEd
never held. Splitting the two into separate documents would put the failure modes in two files, so
both live here: InfoEd first, RePORTER in §6.

**Deployment caveat.** ADR-012's Status header records D1, D3, D4a and D9 as merged to master but
**dark** as of 2026-08-05: `etl:infoed` never runs on staging, and prod needs a manual deploy.
Everything in §2, §5 and §6 therefore describes **master**, not necessarily what is running. Confirm
against the running `sps-etl-prod` task definition and the latest `etl_run` row before asserting any
of it is live — the 2026-08-05 prod nightly was still running the pre-#2173 query.

**Every count in this document carries its measurement date inline.** A count without a date is a
lie within a month. Where the source of a count records no date, that is said explicitly. Re-measure
before quoting anything externally.

## 1. Ownership and contacts

This is the first thing you need at 4pm on a Friday and the least likely to be written down
anywhere else. Fill in the TBC lines as you learn them; that is the point of a living document.

### Who owns what

| Thing | Owner | Status |
|---|---|---|
| The **grant records themselves** (dates, roles, titles, sponsors, program type, the Confidential flag) | **OSRA Sponsored Programs** (Office of Sponsored Research Administration) | Established. OSRA issued the written investigator-role ruling of 2026-08-05 that ADR-012 D11 rests on |
| **Reviewing and correcting** the record backlog | The **RAC team**, working with OSRA | Established that they are the reviewing party. Individual names: **TBC** |
| The **InfoEd/WRG application and its production database** | **TBC** — the DBA or application owner for the InfoEd production instance. OSRA would know who this is | Not established. This is the contact you need for a schema change, a slow query, or "is the database up" |
| The **InfoEd integration database** (the `..._Integration` catalog holding the legacy `dbo.VIVO` view) | **TBC** — possibly the same owner as above, possibly not. Ask OSRA | Not established. This is who to ask for the `CREATE VIEW` text of `dbo.VIVO` if anyone ever needs the legacy WRG→VIVO rules reconstructed |
| **Network reachability** from the SPS VPC to the on-premises InfoEd address | **TBC** — WCM ITS networking. No named contact is recorded in this repo | Not established. Relevant because InfoEd is on-premises and not TGW-attached, which is why the step cannot run on staging at all (§8) |
| **Agreement-tracking records** carried under the JCTO central office (`prop_u.P_SIN_18 = 'JCTO'`) | **TBC** — JCTO. These records behave differently from OSRA's (ADR-012 D8) and a cleanup question about them may need a different person | Not established |
| The **Scholars side**: the ETL, the schema, the profile and search surfaces | Scholars Profile System development team | Established |
| **NIH RePORTER** | NIH. A public API with no support relationship. There is nobody to call | Established |

The 2026-08-06 record review that produced the briefing in §10 was raised by a staff member in the
OSRA/RAC orbit. The requester's name and office are recorded in the internal briefing, not here, so
do not guess either into an email.

### Escalation

There is no vendor ticket to file from the Scholars side. The ladder is:

1. **Decide whether it is us or them.** §8's decision tree does this in about two minutes. A source
   outage and a Scholars regression look identical from the profile page and have completely
   different owners.
2. **Scholars-side alerts** route to the `etl-failures-<env>` SNS topic, then the on-call relay
   Lambda, then Microsoft Teams. See [`oncall.md`](../oncall.md) for the topic topology and the
   channel arrangement, and [`etl-monitoring.md`](../etl-monitoring.md) for which signal means what.
   WCM ITS app teams have no automated paging; off-hours wake-up is an accepted gap documented in
   `oncall.md`.
3. **InfoEd unreachable, or the query has gone slow.** The Scholars side can only observe this. The
   fix lives with the InfoEd application/database owner (TBC) or with WCM ITS networking (TBC). Until
   those two lines are filled in, this is the weakest link in the whole escalation path, and it is
   worth filling them in on a calm day rather than a bad one.
4. **The data is wrong at source.** Use the matrix below. Nothing in Scholars can fix an ETL-owned
   field.
5. **Scholars is misrendering correct data.** Open an issue in
   `wcmc-its/Scholars-Profile-System`.

### Where a given error has to be fixed

Give this to anyone who reports a bad grant. It is the single most reused thing in this document.

| Problem | Where it must be fixed |
|---|---|
| Wrong or missing project period | **WRG.** Flows through on the next nightly run |
| Wrong role (PI vs Co-I vs MPI) | **WRG only.** Scholars has no path to change a grant's role. `/edit` is hide/show only, and no request path writes `Grant.role` |
| Wrong title or sponsor | **WRG** |
| Blank `pgm_type` | **WRG.** It is also what makes the record invisible in Scholars in the first place (§5) |
| Award should not be public at all | **WRG.** Set InfoEd's Confidential checkbox; it is honoured at the source query (§5). Scholars also carries an independent title-based net (§5) |
| Award is not this person's | Scholars `/edit` can hide the row. The underlying record still needs a WRG correction, or the row returns on the next run under the same suppression |
| Prior-institution NIH award missing | Not a WRG issue. That is the RePORTER path (§6) |

Anything a faculty member "fixes" in Scholars that is ETL-owned is **overwritten on the next nightly
run**. Say this explicitly to anyone tempted to correct records in the wrong place.

### Why the stakes are higher than they look

Worth having in your head before you tell someone a bad grant row is cosmetic. Grant fields feed
documents faculty submit externally: the NIH biosketch narrative generator, the WCM Faculty CV
(.docx), and the public profile overview. Grant **title, role label, funder and mechanism** are sent
to the model; abstracts, keywords and dollar amounts are not. A wrong role or a garbled title is
written verbatim into text that goes to NIH. Grant data also drives the "currently funded" boost and
PI filters in people search, department/division/center active-grant statistics, the Cancer Center
collaboration network, curation worklist ordering, and a server-to-server export of a scholar's
complete grant history to the WCM Faculty Review Tool.

A wrong **role** propagates further than a wrong **date**. If a cleanup pass has to prioritise, role
accuracy on active awards is the highest-leverage thing available.

## 2. Mechanics

### InfoEd

| | |
|---|---|
| **Transport** | MS SQL Server over the `mssql` npm package (Tedious). `lib/sources/mssql-infoed.ts` |
| **Connection string** | A JDBC URL parsed by regex in `parseJdbcUrl`; default port 1433 when the URL omits one. The `DatabaseName` (or `Database`) property is required and throws if absent |
| **TLS** | `encrypt: true`, **`trustServerCertificate: true`**. Encryption is on; certificate validation is off |
| **Auth** | SQL Server username/password, injected from Secrets Manager |
| **Secret** | `scholars/<env>/etl/infoed`, construct id `EtlSecretInfoed` (`cdk/lib/etl-stack.ts`). JSON keys: `SCHOLARS_INFOED_DB_URL`, `SCHOLARS_INFOED_USERNAME`, `SCHOLARS_INFOED_PASSWORD`. Each is injected per-key; a key missing from the seeded JSON fails ECS **task start**, not the query |
| **Task definition** | **`sps-etl-sources-<env>`**, not the base family. `etl:infoed` is in `SOURCES_SCRIPTS`. Container name is **`etl`** |
| **Schedule** | Nightly Step Functions `scholars-nightly-<env>`, step id `Infoed`, position 6 of 21. EventBridge rule `sps-etl-nightly-<env>`, `cron(0 7 * * ? *)` = 07:00 UTC |
| **Environment** | **Prod only.** The step is spliced out of the staging cadence entirely (§8) |
| **Pool** | One module-level pool, `max: 4`, `min: 0`, `idleTimeoutMillis: 30_000`, closed in the ETL's `.finally()` |
| **Timeouts** | `requestTimeout: 2_400_000` ms = **40 minutes** per query. `connectionTimeout: 30_000` ms. Step Functions per-attempt task timeout is 4h, `maxAttempts: 2` plus the initial attempt |
| **Retries** | **Zero on the MSSQL side.** No retry wrapper anywhere. A failure propagates straight to `main()`'s catch. The only retry is Step Functions' own attempt count |
| **Latency** | Both queries together: **499.2s**, historical band **425–524s** (recorded in `etl/infoed/index.ts`; the comment records **no measurement date** for this figure). That is ~4.8x under the 40-minute request timeout. Standalone, the account-period query returns its 29,326 rows in **1.0s** (measured 2026-08-05). The prior embedded-derived-table form died at ~2427s on all three Step Functions attempts of a single nightly (2026-08-05), ≈3.28h |
| **Volume** | ~**17,974** grant rows returned per run and **29,326** account-period rows (`etl/infoed/index.ts`; 29,326 measured 2026-08-05, while the 17,974 figure carries **no measurement date**). In-scope proposal rows before filtering: **62,474** (measured 2026-08-03) |
| **Write batching** | `createMany` in chunks of **1000**. Updates are **one round trip per changed row**, unbatched. Same for date-gap upserts and confidential-title suppressions |
| **Local writes** | Prisma over the MariaDB adapter, all through `db.write` (the writer endpoint) |

**Which database does it actually read?** Two different catalogs are involved and this trips people
up. The connection's `DatabaseName` is the **integration** catalog (`WC_InfoEdProd_Integration` per
the module header), but every `FROM`/`JOIN` in both queries three-part-names **`wc_infoedprod.dbo.*`**.
So the connection database is only the login context; the reads cross into the raw production
catalog. The `dbo.VIVO` integration view that fed the legacy VIVO system is **not read at all**. It
survives in two comments: `lib/sources/mssql-infoed.ts`'s module header still names it as the target
view, and one comment inside the query notes where the Confidential flag surfaces.

Credentials are never in the image and never in the repo. Do not paste connection strings into
tickets: the JDBC URL contains the server address.

### NIH RePORTER

| | |
|---|---|
| **Transport** | HTTPS POST to `https://api.reporter.nih.gov/v2/projects/search`. No auth, no key |
| **Client** | `etl/nih-profile/fetcher.ts`, shared by all four uses (§6) |
| **Pacing** | `PAGE_LIMIT = 500`, `CORE_NUMS_BATCH = 50`, `REQ_DELAY_MS = 1000` — one request per second |
| **Retries** | `MAX_FETCH_RETRIES = 4` (5 attempts). Retryable statuses 408, 429, 500, 502, 503, 504. Backoff `min(1000 * 2^(n-1), 15_000)` |
| **Schedule** | Weekly Step Functions `scholars-weekly-<env>`, EventBridge `sps-etl-weekly-<env>`, `cron(0 12 ? * SUN *)` = 12:00 UTC Sundays — **except** the date-repair use, which rides the nightly InfoEd step |
| **Task definitions** | `etl:reporter` → `sps-etl-sources-<env>`. `etl:reporter-grants` and `etl:nih-profile` → the base `sps-etl-<env>` |
| **Degradation** | In the InfoEd date-repair path, a RePORTER failure degrades to an empty map with a `console.warn`. It never produces a wrong date, and it never fails the InfoEd run |

## 3. Field mapping

Prisma target is the `Grant` model in `prisma/schema.prisma`. Mapping code is the `inserts` build in
`etl/infoed/index.ts`.

The **semantics** column is where the two sides disagree. Read it before you trust a field name.

| `Grant` field | InfoEd origin | Path | Semantics |
|---|---|---|---|
| `id` | none | Prisma `uuid()` default | **Never written by this ETL.** Preserved across runs deliberately (#352) so the ADR-005 manual-override layer can key on it |
| `cwid` | `faculty.employer_id` | `proppds.unique_id` → `faculty.unique_id`, `role_key = 'KEY'` | **A rename that changes meaning.** InfoEd calls it `employer_id`; Scholars treats it as the Scholar primary key. No case folding, no trimming, on either side (§4) |
| `title` | `proposal.proj_title` | `MAX(proj_title)` per `(cwid, Account_Number)`, then CR/LF stripped, then encoding repair, then a placeholder fallback | **Four transforms stack.** (1) `MAX()` picks the **lexically greatest** title on the account family, not the parent's. (2) CR and LF become spaces, but a literal four-space run is **deleted, not collapsed**. (3) cp1252 mojibake repair plus invisible-character drop. (4) An empty title becomes the **fabricated** string `(untitled grant <Account_Number>)`. `GrantDateGap.title` deliberately has no such placeholder |
| `role` | `proppds.dd_role`, `proppds.first_pd` | Three stages: a `Role_Category` CASE, an account-level aggregate, an outer `Role` CASE, then `ROLE_MAP` | **The heaviest semantic drift in the feed.** See the role sub-table below |
| `funder` | `sponspas.spon_name` twice | `primeRaw`, then `via <direct>` appended when a distinct direct sponsor exists, joined with a space | A **pre-rendered display string**, e.g. `NIH via Columbia`. Falls back to the literal `(unknown sponsor)`. The schema marks it legacy and slated for removal. Note the module header claims the format is `NIH (via Columbia)` with parentheses; the code emits none (§7) |
| `startDate` | `proposal.app_st_dt`, **or** RePORTER | `MIN(app_st_dt)` over the whole account family, joined in TypeScript; or the RePORTER project period | **Not the row's own proposal date.** It is the family minimum, which can be wider than any single sibling. MSSQL `datetime` into a `@db.Date` column: the time component is truncated. **Two provenances in one column** — check `datesSource` |
| `endDate` | `proposal.app_end_dt`, or RePORTER | `MAX(app_end_dt)` over the family | Same. Family maximum |
| `externalId` | derived | `INFOED-<Account_Number>-<CWID>` | Composite of a **mutable** CASE expression and the CWID. Unique. See §4 for what happens when the account re-keys |
| `awardNumber` | `proposal.spon_awd` | `MAX(Award_Number)` per `(cwid, Account_Number)`, then encoding repair | **`MAX()` across the account family**: on a family carrying several award numbers, the lexically greatest wins. Encoding repair is load-bearing here — 9 award numbers carried a soft hyphen (measured 2026-07-30) |
| `source` | none | literal `"InfoEd"` | Also the scope key for reconcile and delete. RePORTER-created rows carry `"RePORTER"` and are outside this ETL's universe entirely |
| `datesSource` | none | `"infoed"` for dated rows, `"reporter"` for backfilled ones | Provenance of the **dates**, not of the grant. ADR-012 D3. Currently written and read at no UI surface (#2180) |
| `lastRefreshedAt` | none | `new Date()` **on update only** | **Means "last changed", not "last seen".** An unchanged row gets no write at all, so a stale-looking timestamp is not evidence the feed skipped it |
| `programType` | `codetab.code_desc` via `proposal.pgm_type` | Guarded `MIN(...)` excluding `'Contract without funding'`, then a default | Code-table lookup, guarded aggregate, then a **fabricated default**. Empty or NULL silently becomes the literal `"Grant"`. The guard exists because a bare `MIN()` returned `'Contract without funding'` on mixed-type accounts (`'C'` sorts before `'G'`), writing the exact value the policy excludes |
| `primeSponsor` | `sponspas.spon_name` via `proposal.orig_spon` when it differs from `spon_code`, else via `spon_code` | `MAX(Orig_Sponsor)`, then `canonicalizeSponsor` | **Lookup normalization.** Exact short-name/alias match, then full-name, then a normalized form that strips legal suffixes and a leading "The"/"United States", maps `&` to "and", and drops `/NIH` and `/DHHS` tails. **Null when unmatched**, which is not an error |
| `primeSponsorRaw` | same | SQL `RTRIM`, then JS `trim` | Double-trimmed. **No encoding repair is applied to sponsor names**, unlike title and award number |
| `directSponsor` | `sponspas.spon_name` via `proposal.spon_code` | `MAX(Sponsor)`, NULLed when equal to prime, then coalesced back to prime in TypeScript, then canonicalized | **A rename that changes meaning.** The SQL column is called `Subward_Sponsor` but holds the **direct / pass-through** sponsor (the entity that issued the subaward to WCM). The TS layer coalesces it back to prime, so `directSponsor` is never null when prime exists: it equals prime when WCM holds the prime directly |
| `directSponsorRaw` | same | same coalesce | |
| `mechanism` | derived from `proposal.spon_awd` | `parseNihAward(...).mechanism` | **A regex derivation, not a source column.** Three- or four-character activity code, uppercased. Known false positive: a Fred Hutch reference number of the form `FHCRC 203865-01` parses to mechanism `FHC` |
| `nihIc` | derived from `proposal.spon_awd` | `parseNihAward(...).nihIc` | **A code-table lookup that changes the value.** The award number carries a two-letter prefix (`CA`); the stored value is the **institute short name** (`NCI`). Null when the prefix is not one of the 26 NIH institutes, so real CDC awards get a `mechanism` but no `nihIc` |
| `isSubaward` | derived | `prime && direct && prime !== direct` | Computed from the **raw** strings, before canonicalization. Two spellings of the same funder read as a subaward |
| `applId` | none | not written | Preserved. Written by the RePORTER enrichment ETL |
| `abstract`, `abstractFetchedAt`, `abstractSource` | none | not written | Preserved. This preservation is the entire point of #352 — the prior implementation's truncate-and-recreate wiped them every night |
| `keywords`, `keywordsSource`, `keywordsFetchedAt` | none | not written | Preserved |
| `meshDescriptorUis`, `meshResolutionCoverage`, `meshResolvedAt` | none | not written | Preserved |

**InfoEd columns selected but never mapped to `Grant`:** `unit_name`, `int_unit_code`, `spon_code`,
`Project_Status`. `unit_name` gates the outer `WHERE` and feeds `GrantDateGap.unitName`.
`Project_Status` feeds `GrantDateGap.projectStatus` only. **`Grant` has no status column at all** —
active versus past is derived purely from the dates. `int_unit_code` and `spon_code` are read into
the row type and used nowhere.

**Columns computed in the query and read by nothing:** `Project_Period_Start`, `Project_Period_End`
(superseded by the account-period query in #2173), `RecordID`, `Submission_Status`, `intake_type`,
`Proposal_Type`, `Proposal_Status`, `Subward_Indicator`, `lname`, `fname`, `title`,
`Role_Description`. `intake_type` is the interesting one: ADR-012 D8 shows it is the discriminator
that makes the date-gap worklist actionable, and it is selected and thrown away.

### Role, in three renames

InfoEd `dd_role` and `first_pd` map to an intermediate `Role_Category`:

| InfoEd condition | `Role_Category` |
|---|---|
| `first_pd = '1'`, or `dd_role` in `PD/PI`, `Principal Investigator`, `Qatar PI` | `PI` |
| `dd_role LIKE 'Co-Sponsor'` | `Key Personnel` |
| `dd_role LIKE '%co-%'` | `Co-Investigator` |
| `dd_role LIKE 'subaward PI'` | `PI Subaward` |
| `dd_role LIKE 'SubProject PI'` | `PI Subproject` |
| anything else | `Key Personnel` |

That is then aggregated per `(cwid, Account_Number)` and run through a second CASE and a lookup map:

| Condition | SQL literal | `Grant.role` | Semantics |
|---|---|---|---|
| direct award and `Primary_PI_Flag = 'Y'` | `PrincipalInvestigatorRole` | `PI` | contact PI on a direct award |
| sponsor mismatch and `Primary_PI_Flag = 'Y'` | `PrincipalInvestigatorSubawardRole` | `PI-Subaward` | **Derived from the sponsor mismatch, not from `Role_Category = 'PI Subaward'`.** An InfoEd `dd_role = 'subaward PI'` never reaches this branch |
| `Any_Pd_Pi = 1` | `CoPrincipalInvestigatorRole` | `Co-PI` | **`Co-PI` here means a non-contact PD/PI on a multi-PI award, not "co-principal investigator".** Downstream it counts as a PI and drives `isMultiPi` and the Multi-PI pill |
| `Role_Category LIKE '%Co-investigator'` | `CoInvestigatorRole` | `Co-I` | Reads `MIN(role_category)`, which is alphabetical: `Co-Investigator` < `Key Personnel` < `PI`, so Co-I beats Key Personnel across the family |
| everything else | `KeyPersonnelRole` | `Key Personnel` | **A catch-all that silently absorbs `PI Subaward` and `PI Subproject`** — neither matches an earlier branch |
| an unmapped literal | — | `Key Personnel` | Silent demotion, guarded only by a source-text unit test |

`Primary_PI_Flag` is `'Y'` when `first_pd = '1'`, aggregated with `MAX()`. Since `'Y' > 'N'`, any
contact-PI row anywhere on the account wins.

ADR-012 D11 is the contract for what `dd_role` values mean. Its two load-bearing points: the
three-value PI list is **complete against OSRA's stated convention** (they do not use "Co-PI"; on a
multi-PI award every named investigator is recorded as a PD/PI), and **the catch-all is not a safety
net** — an unrecognised PD/PI spelling publishes a full PI as a junior collaborator, on a public
profile, and the affected person is the last to see it. If the convention changes, the new value
goes in the `IN` list. Do not widen the catch-all.

## 4. Identity resolution at the boundary

### Person: InfoEd `employer_id` to Scholars `cwid`

The InfoEd side reaches the person through `proppds.unique_id` joined to `faculty.unique_id` with
`inst_code` matching and `pers.role_key = 'KEY'`. The resulting `faculty.employer_id` is aliased
`CWID`.

The Scholars side loads every `Scholar` where `deletedAt IS NULL` and `status = 'active'` into a
JavaScript `Set` of CWIDs.

The match test is **exact string equality**. No trim, no case folding, no fallback lookup, no
near-miss diagnostic.

**When they do not reconcile, the row is silently dropped.** Specifically:

- A CWID Scholars has never heard of: dropped.
- A CWID belonging to a suppressed or soft-deleted scholar: dropped.
- A personnel row with no `faculty` match, or with `role_key <> 'KEY'`: the SQL emits `CWID = NULL`
  (the faculty join is an INNER nested inside a LEFT OUTER, so the proposal survives with a null
  person), and the TypeScript filter drops it.

All four cases are **indistinguishable in the output**. The only signal is one aggregate log line,
`Rows for active CWIDs: N`. There is no per-CWID log and no worklist row.

The knock-on effect matters more than the drop itself: the date-gap worklist is built from the
already-filtered set, so **a non-scholar's undated award never reaches the worklist either**. If
someone asks why an award for a person who left last year is not on the OSRA list, this is why.

### Award: account to `externalId`

Format: **`INFOED-<Account_Number>-<CWID>`**, constructed identically at three sites (the grant row,
the date-gap row, and the RePORTER-backfill marker) so a gap and its eventual grant are joinable.

`Account_Number` is `parentprop_no` when present, otherwise `prop_no`. Child proposals and
amendments therefore roll up into the parent account, and Scholars does not show every proposal
record separately.

**`Account_Number` is mutable, and this is the sharpest edge in the whole integration.** The moment
InfoEd links a standalone proposal into a family, the same investigator's same award re-keys:

1. The old `externalId` no longer appears in the extract.
2. The reconcile classifies it as stale and **hard-deletes** it.
3. The award reappears under the new `externalId` as a fresh row, with a **new uuid primary key**.
4. Anything keyed to the old row is gone. In particular a `/edit` suppression that was hiding it is
   now orphaned, and **the award silently becomes visible again**.

The one thing that catches this: `repointReissuedSuppressions` moves active suppressions from the
old id to the new one, strictly 1:1 on `(cwid, awardNumber)`, requiring a non-empty award number and
skipping any pair that is ambiguous on either side. If the award number is empty or ambiguous, the
re-point does not happen and the nightly integrity check reports a `suppression:orphan-infoed`
violation, which pages. Note that the re-point **writes no audit row**.

`parseExternalId` parses the id back with `/^INFOED-(.+)-([^-]+)$/`: greedy account segment, CWID is
the final dash-free segment. A dashed account number parses fine. **A CWID containing a dash would
misparse.** Whether any WCM CWID can contain a dash is not settled anywhere in this repo — TBC, and
worth confirming with whoever owns the CWID namespace.

### There are two `externalId` formats and only one of them parses

RePORTER-created rows use `reporter:<cwid>:<core>` (§6). `parseExternalId` returns `null` for that
format. Consequences worth knowing before you debug something that looks like a data loss:

- The funding-index projection emits **no operations** for RePORTER grants, so they are absent from
  funding search. Profiles still show them.
- The nightly integrity check grades `INFOED-` orphan suppressions as a violation and does **not**
  grade `reporter:` ones.

## 5. Inclusion and exclusion rules

Every filter here can make a record that is **perfect in WRG and still invisible in Scholars**. The
*why* is the part that gets lost, so it is given for each one.

The extract runs one query for grant rows (`CONSOLIDATED_QUERY`) and a second for account periods
(`ACCOUNT_PERIOD_QUERY`), joined in TypeScript rather than SQL.

### What the grant query admits

| Filter | Effect | Why |
|---|---|---|
| `prop.system = 'PT'` and `prop.inst_code = 'WCORNELLMC'` | Scope | WCM proposal-tracking records only. InfoEd also carries other systems and institutions |
| `subp.child IS NULL` (anti-join on `pt_project`) | Drops child proposals | The parent account carries the row. Without this the same award appears once per amendment |
| `Project_Status IN ('Active Award', 'Expired Award', 'In Process')` | Admits three statuses | **Expired awards are deliberately included.** There is no date cutoff, no lookback window and no "ends after today" filter anywhere in the import. `In Process` is kept on purpose: those are real awards mid-setup, verified 2026-07-14 against funders' own records (an R35 and an NSF award). ADR-012 D7 |
| `ISNULL(prop_u.p_log_50, 0) <> 1` | Drops Confidential-flagged records | InfoEd's own Confidential checkbox. Honoured **at source**, so a flagged award cannot reach a public profile by any later path **once the image carrying it is deployed** (ADR-012 D9, merged but dark). This predicate was previously computed and then ignored; 18 accounts were being published, one of them as active funding (**the source comment records no measurement date**) |
| `proppds.role_key = 'KEY'` (inside the nested INNER, not the outer `WHERE`) | Nulls the CWID rather than dropping the row; the TS filter drops it afterwards (§4) | Scholars publishes investigators, not full personnel rosters |
| `pt_unit.prim = '1'` (LEFT-join condition) | Selects the primary unit per **proposal**; drops nothing on its own | Keeps one unit per proposal so department rollups do not double-count |
| `unit_name IS NOT NULL` | Drops accounts with no resolvable primary unit | A grant with no department cannot be attributed on any org-unit surface |
| `program_type <> 'Contract without funding'` | Excluded by policy | Not incoming research funding |
| **`INNER JOIN codetab ON prop.pgm_type = ct.codeid`** | **Deletes the entire row when `pgm_type` is NULL** | See below. This is the big one |
| `INNER JOIN` on `codetab`/prop_type, `projstatxref`, `codetab`/projstat, `projmain`, `sponspas` | Existence filters. Each *could* drop a row, but all five were **measured at zero drops** in this scope (ADR-012 D5, measured 2026-08-03 to 2026-08-04) | Only the `pgm_type` join above is a real filter. None of the five contributes a published column, and `projmain` selects nothing at all — the `SELECT DISTINCT` absorbs its fan-out. This is one join, not a class of bug |

### The `pgm_type` INNER JOIN, stated plainly

`pgm_type` is NULL on **18,113 of 62,474 in-scope proposal rows, 29% (measured 2026-08-03)**, and the
inner join deletes **the whole row**, not just the program-type label.

If Program Type is blank in WRG, that award is invisible in Scholars regardless of its status, its
dates, or how clean the rest of the record is. It appears on no profile, in no funding search, and
**on no Scholars-generated worklist, including the date-gap worklist**. Any "records needing
attention" list produced from Scholars is therefore a **lower bound**, and the two readings differ by
roughly 9x.

It was fixed, measured, and deliberately reverted before merge (#2174, ADR-012 D5). A bare
INNER-to-LEFT swap admits **+13,922 `(cwid, account)` pairs** across +11,636 accounts (measured
2026-08-03 to 2026-08-04). About 1,313 of those have dates and would become visible grants, only 15
of them Active Awards. The other ~8,276 arrive undated and land in the OSRA worklist, taking it from
2,525 rows to roughly 10,800 — a 4.3x increase in a list whose entire purpose is to be worked down.
The swap also silently mutates rows that **already publish**, because `MAX(Award_Number)`,
`MAX(Sponsor)`, `MAX(proj_title)`, `MAX(Primary_PI_Flag)` and `MIN(Role_Category)` all aggregate over
every admitted row for the account.

Any accepted fix must let a `pgm_type`-null row contribute its **dates** to the account aggregate
without admitting it to the **published feed**. Those are two changes, not one join swap.

### Dates: what is published and what is dropped

Start and end dates are **required** on the Scholars side. An award with no period is not displayed
at all. That is the real user-facing cost of the date gap and the honest justification for a cleanup
pass.

- The period is a property of the **account**, not of the `(cwid, account)` pair. It comes from a
  flat `MIN(app_st_dt)` / `MAX(app_end_dt)` over the whole account family, with **no
  parent-preference tie-break** (ADR-012 D1). A parent-preferring draft was rejected because it
  narrows the period on accounts whose continuations run past the parent's end date, silently
  flipping published grants from Active to Past, and because choosing start and end from
  independently selected rows can emit `startDate > endDate`.
- Accepted consequence: on an account whose family periods genuinely diverge, the published span can
  be wider than any single sibling's. Measured at **6 pairs across 4 accounts out of 13,725
  currently-dated pairs (measured 2026-08-03 to 2026-08-04)**.
- The account-period query is a deliberate **strict superset** of the grant query's scope: it omits
  the CTE's `ct` (pgm_type) and `ct2` (prop_type) codetab joins, `projmain` and `sponspas`, while
  keeping `projstatxref` and the `cdp` codetab join it needs for the status filter — so no pair can
  ever go from dated to undated. It reads `dbo.proposal` **upstream** of the `pgm_type` join, which
  is why the date fix did not have to wait for the `pgm_type` fix.
- **Only the awarded period is ever published.** `app_st_dt` / `app_end_dt` is the awarded pair.
  InfoEd carries a second pair, `pp_st_dt` / `pp_end_dt`, holding the **proposed** period. It is read
  nowhere in this codebase, deliberately (ADR-012 D2): a proposed period is what was asked for, not
  what was granted, and these dates drive the active/past split, the "currently funded" signal in
  people search, and recency weighting.
- This matters for how the backlog is described. Of the undated accounts, **1,521 of 1,691 (89.9%)
  do carry a proposed period (measured 2026-08-03 to 2026-08-04)**. Do not let anyone characterise
  the backlog as "dateless in InfoEd" — it is not true and it sends a review in the wrong direction.
  Only **170** are dateless in every sense.

### The date-gap worklist

Every undated row is upserted into `grant_date_gap`, whether or not RePORTER later backfills a
period. A backfilled row keeps its gap **open** with `status = 'backfilled'`, which means "visible
but still wrong at source" (ADR-012 D3). `firstSeenAt` is deliberately excluded from the update
payload so "how long has this been undated" survives every run. Gaps that vanish from the feed are
marked `resolved` and **never deleted**; `dismissed` never reopens.

Backlog shape, all **measured 2026-08-03 to 2026-08-04**:

| | accounts |
|---|---|
| Total actionable backlog as counted | 1,988 |
| Have an awarded period somewhere in the account family (recoverable) | 297 (ADR-012; `etl/infoed/index.ts:302` says 296 for the same window — unreconciled) |
| No awarded period anywhere in the family | 1,691 |
| ...of which carry a proposed period | 1,521 (89.9%) |
| ...of which are dateless in every sense | 170 |

By project status the 1,691 are **980 `In Process`, 699 `Active Award`, 12 `Expired Award`**. The
980 `In Process` accounts are **not a gap**: an unawarded proposal correctly has no awarded period,
and counting them inflated the ask to OSRA by roughly a factor of three. The genuinely actionable
population is **711 accounts**, which office-and-intake decomposition (ADR-012 D8) narrows further to
**153**.

Every one of those figures is a **lower bound**, because the worklist is written from the grant
query's recordset and a `pgm_type`-blocked row can never be logged as a gap at all.

Two more figures live in `prisma/schema.prisma`, both **measured 2026-07-28** — older than
everything above, so re-measure before quoting either:

- **4,244 of 17,954 eligible `(cwid, account)` pairs are dropped for having no project period.** About
  850 of them carry a sponsor award number, and only about 358 are recoverable from RePORTER. The
  same drop is described as 23.6% in `etl/infoed/index.ts:679`.
- **Roughly 74% of the undated population carries no award number either** (1,862 of 2,519). That is
  why the worklist stores the project title as the only recognisable field, and why those rows are
  the hardest to match back to anything — and it is also why the suppression re-point in §4, which
  requires a non-empty award number, cannot help most of them.

### Confidentiality: two independent nets

1. **InfoEd's own Confidential checkbox**, excluded at the source query. It is a **manual** flag and
   demonstrably not always set: a live check found it unset on real CDAs and NDAs, two of them
   then-active and already public on profiles.
2. **A title-based net on the Scholars side.** Any admitted row whose title matches a word-boundary
   check for `CDA`, `NDA`, `MTA` or `DUA`, or a "Confidentiality Agreement"-style phrase, receives a
   revocable system `Suppression` instead of rendering. Deliberately over-inclusive: a false
   suppression is a one-line revoke, a leaked CDA is not.

The title net runs over **every prepared row, new and already-published**, not just new ones, so it
retroactively catches rows that are already live. It is idempotent, it **never revokes** (a title
that stops matching keeps its suppression), and a human revoke carries a different `createdBy` and is
never touched by the ETL. Newly minted suppressions are reflected into the funding index inside the
same run (#2284), closing what used to be a 24-hour exposure window on a standalone run. It **writes
no audit row**.

### What Scholars does not import at all

Verified against the actual extract, not assumed. Scholars holds **no** dollar amounts of any kind
(RePORTER's award amount is fetched, summed, and then deliberately discarded), no budget periods,
no effort or FTE, no personnel beyond key investigators, no compliance/IRB/protocol data, and no
subaward financial detail or F&A.

Scholars stores: investigator CWID, account number, award number, project title, direct and prime
sponsor, program type, mechanism, NIH institute, role, and the awarded start and end dates — plus a
RePORTER-sourced abstract and keywords.

### What a re-run does to an existing row

Reconcile is by `externalId` against a 17-column content key, with dates compared at **day
precision**.

| Case | Action |
|---|---|
| `externalId` is new | `createMany`, chunked at 1000 |
| `externalId` exists, content differs | `update`, all 17 owned columns overwritten, `lastRefreshedAt` bumped |
| `externalId` exists, content identical | **No write at all.** `lastRefreshedAt` is not bumped |
| `externalId` in the database, absent from the source | **Hard delete**, scoped to `source = 'InfoEd'` |
| Duplicate `externalId` within one extract | Last occurrence wins, deduped into a map, logged with the first 10 ids |

**Preserved across every run:** the uuid primary key, and every enrichment column the reconcile does
not select — `applId`, `abstract`, `abstractFetchedAt`, `abstractSource`, `keywords`,
`keywordsSource`, `keywordsFetchedAt`, `meshDescriptorUis`, `meshResolutionCoverage`,
`meshResolvedAt`.

The delete is a **hard delete, not a tombstone**, despite the module header and
`lib/etl/reconcile.ts` both calling the pass "tombstone". `GrantPublication` rows cascade away with
it.

## 6. NIH RePORTER

InfoEd is the system of record. RePORTER is used in **four distinct ways**, and conflating them
causes most of the confusion in this area.

| # | Use | Entry point | Cadence | What it writes |
|---|---|---|---|---|
| 1 | **Enrichment of existing rows** | `etl/reporter` | weekly, step `ReporterWeekly` | `applId`, `abstract`, `keywords` on any grant with a parseable NIH award number, InfoEd-sourced or not, plus MeSH resolution over those keywords and the grant-to-publication bridge |
| 2 | **Creation of net-new rows** | `etl/reporter-grants` | weekly, step `ReporterGrantsWeekly` | Grants InfoEd never held: **prior-institution history** and dropped WCM history, marked `source = "RePORTER"` |
| 3 | **Date repair of InfoEd rows** | `loadReporterPeriods` inside `etl/infoed` | **nightly**, inside the InfoEd step, prod only | `startDate`/`endDate` plus `datesSource = "reporter"` on awards InfoEd left undated |
| 4 | **Person resolution** (profile_id to cwid) | `etl/nih-profile` (v1, weekly) and `runReporterMatchV2` (step 0 of `etl:reporter-grants`) | weekly | `person_nih_profile`, which drives the "View NIH portfolio" link and gates use 2 |

Use 3 replaced a `reciterdb` mirror on **2026-07-31**: a live check found the mirror missing **30 of
73** still-undated NIH awards that RePORTER itself had a period for, including an active CDC-funded
award (ADR-012 D4a). Use 1's enrichment half stopped reading that mirror on **2026-08-04** (#2182)
and now fetches RePORTER by `project_nums`. What still touches ReciterDB is use 1's *second* step,
the grant↔publication bridge over `reciterdb.grant_provenance` — that is the remaining ADR-012 D4
violation. The `grant_reporter_project` mirror is now read by nothing.

**A backfilled date makes the grant render. It does not make the InfoEd record correct.** The gap
row stays open.

### The dedup rule

A RePORTER project is dropped if either arm fires:

1. **Exact match** — InfoEd already holds that `core_project_num`.
2. **Phased-family match** — the core, minus its leading three-character activity code, matches an
   InfoEd core's family key, **and** the project's org name matches `/weill|cornell/i`, **and** the
   core is longer than 3 characters.

Arm 2 exists for phased awards: UG3/UH3, K99/R00, R61/R33. The WCM org gate exists because InfoEd is
WCM-only — a K99 held at a prior institution whose R00 is at WCM is a genuinely distinct line and is
**kept**.

The dedup is the **only** thing keeping RePORTER off InfoEd rows on the write path. The delete path
is separately protected by scoping every reconcile and delete to `source = "RePORTER"`.

### Limitations, stated honestly

**(a) The role on a RePORTER-created row is hardcoded to `PI`.** Not derived, not defaulted —
hardcoded as a literal type on the row and re-asserted on every upsert. RePORTER's own investigator
list is never consulted; the fetcher does not even request a PI role field. Someone who was
Co-Investigator on a prior-institution award shows as PI on that row. This compounds: the default
selection for generated biosketch and CV text is lead-role active funding, so a hardcoded-PI row
always clears that filter and is fed into externally-submitted prose as a PI award by default. A
scholar can hide the row, but inclusion is the default. **This is the one RePORTER limitation with
real external consequences.**

**(b) RePORTER-created rows are absent from funding search, and this is a defect, not a decision.**
Their `reporter:<cwid>:<core>` identifier is not the format the project-grouping parser accepts, so
every such row is loaded and then silently dropped when the index is built. Two places in the
codebase assert the opposite: the comment where the id is minted claims it was chosen so the
externalId-keyed suppression and funding-index machinery resolve these rows without change (the
suppression half does work; the index half does not), and the ETL step ordering puts the RePORTER
step ahead of the index build "so their fresh rows are indexed", which cannot happen. It also extends
past the funding tab: the per-person grant-evidence card on people-search results is index-backed
too, so a prior-institution award cannot appear there as topical evidence. Profiles do show these
grants.

**(c) In production, RePORTER grant creation only covers scholars with an already-curated NIH
profile id.** The automatic matcher is gated by `REPORTER_MATCH_V2`, wired `staging = "on"`,
`prod = "off"` on both the ETL and app task definitions. **A flag is only dark if the running task
definition matches the template** — confirm against the live task def before stating this externally
(§7).

**(d) RePORTER-created rows never get a `datesSource`.** `buildReporterGrantRow` does not set the
field, so the row inherits the schema default `"infoed"` even though every date came from RePORTER.
Whether any consumer mis-reports provenance because of this is **not established** — no consumer of
`datesSource` has been audited, and it is currently read at no UI surface.

**(e) Phased-family dedup degrades to exact-match on four-character activity codes.** The family key
drops exactly three characters, but the award-number regex admits three **or four**. For a
four-character activity code the family key retains a leftover character and the phased-sibling arm
silently stops matching. The `core.length > 3` guard does not catch this. Whether four-character
activity codes actually occur in the real InfoEd/RePORTER population is **not determinable from the
code** — nothing enumerates the activity-code set. TBC by measurement.

**(f) An InfoEd row with a NULL award number cannot suppress a RePORTER twin at all,** because the
dedup builds its key set from `Grant.awardNumber` only.

## 7. Known quirks

Their system's actual behaviour versus its documentation, plus our own code versus its own comments.

**This section grows by write-on-surprise.** Every time this integration surprises you, add a line.
Within a year this will be the highest-value part of the document, and it is worth more than any
amount of prose written up front, because it is the only section that accumulates the things nobody
could have predicted.

### InfoEd's behaviour versus its documentation

- **The connection database is not the query database.** The connection's `DatabaseName` is the
  integration catalog; every query three-part-names the raw production catalog. The connection
  database is only the login context.
- **`dbo.VIVO` is not read.** The module header still names it as the target view (recorded "per
  user 2026-04-30"). No query touches it. It appears once more as a comment noting where the
  Confidential flag surfaces. If anyone believes Scholars reads the same feed VIVO did, they are
  wrong, and this is why (§10).
- **The WRG-to-VIVO business rules do not exist anywhere on this side.** Not in the ADRs, not in
  code comments, not in version-control history. If they are needed, the artifact to request is the
  `CREATE VIEW` text of `dbo.VIVO` from whoever owns the integration database (TBC). That view is
  the old contract in executable form.
- **The Confidential checkbox is manual and unreliable.** Found unset on real CDAs and NDAs,
  including two then-active records already public on profiles. Hence the second net (§5).
- **InfoEd carries two project-period column pairs, not one.** `app_st_dt`/`app_end_dt` is awarded;
  `pp_st_dt`/`pp_end_dt` is proposed. A naive grep for the awarded pair returns false hits, because
  `app_st_dt` contains `pp_st_dt` as a substring. Use word boundaries.
- **`PMAward`/`PMAwardInc` is not a date fallback and sampling it lies.** Refuted by census: 0 of
  1,691 undated accounts recover a period (measured 2026-08-03 to 2026-08-04). Three separate
  sampling passes produced 31%, 0% and 0%, because `PMAward.ProjID` resolves to `System='AWD'` rows
  whose `Prop_no` sequence **collides numerically** with low PT account numbers. `PMAward` rows also
  exist only where `app_st_dt` is already populated, so it can never lead the column we already read.
  `ProjPerformancePeriods`, `rpt_performance_period`, `pmawarddata`, `PT_BM_Periods` and
  `PT_BM_PeriodInc` are all empty. **Do not re-open this by sampling.**
- **JCTO's agreement-tracking records never award, but JCTO's actual Grants award at OSRA's rate.**
  Measured 2026-08-03 to 2026-08-04: JCTO x Clinical Trial Agreement 0.0% awarded (1 of 5,566), JCTO
  x Grant 98.2% (166 of 169), OSRA x Grant 98.5%. Excluding JCTO wholesale would discard 166
  legitimate awards.
- **Granularity mismatch with OSRA's lists.** OSRA works by `Account_Number`. Funding search groups
  by NIH core project number and takes the **latest** end date across renewals, so an expired account
  folded into a live project inherits the live project's dates and status. An account can be expired
  in WRG and not visibly expired in Scholars search. Profiles show individual rows, so the two
  surfaces will not always agree. Explain this before it is reported as a bug.

### Our code versus our own comments

- **The `funder` string has no parentheses.** The module header says the format is
  `NIH (via Columbia)`; the code joins with a space and emits `NIH via Columbia`. **The code wins.**
  Anyone matching on that string should match on neither form and read the sponsor columns instead.
- **The `datesSource` schema comment is stale.** It still names the `reciterdb.grant_reporter_project`
  mirror as the reporter source. The ETL has fetched the live RePORTER API since 2026-07-31. Which is
  authoritative for a downstream consumer reading the schema is unresolved in code — read the ETL,
  not the comment.
- **`etl/infoed/probe.ts` has drifted and is not a faithful sample of what the ETL runs.** It is
  scoped to a hardcoded test CWID, it is **missing the Confidential exclusion** (so it returns
  do-not-publish rows the ETL excludes), it carries the pre-#2173 date aggregate, the pre-#2090 role
  CASE, and an unguarded `MIN(program_type)`. It also prints the whole recordset — full titles,
  sponsors and names — to stdout, and swallows query errors into a log line while still exiting 0.
  Whether the drift is deliberate or simply unmaintained is not stated anywhere. **Do not use the
  probe to answer a question about production behaviour.**
- **`MAX()` on title and award number picks the lexically greatest value on the account family,** not
  the parent's. This is a real content decision made by an aggregate function.
- **`MIN(role_category)` is alphabetical,** so `Co-Investigator` sorts ahead of `Key Personnel` and
  `PI`. `Any_Pd_Pi` exists precisely because the earlier `MIN(Role_Category) LIKE '%PI'` form lost
  121 pairs (#2090, measured 2026-07-30) by flattening non-contact PD/PIs.
- **`Sponsor` and `Orig_Sponsor` are aggregated independently with `MAX()` and then compared for
  equality** to decide whether the award is direct. On an account whose rows carry heterogeneous
  sponsor pairs, the two maxima can come from different rows, so that equality test is **not** the
  same test as "this award is direct". No comment or test addresses this. Unmeasured.
- **`funder` is `VarChar(255)` but is built from two `VarChar(255)` values plus a separator.** Nothing
  truncates or validates the length. Whether MySQL strict mode errors the write or silently truncates
  is **not settled by the repo**. Unobserved in practice, which may only mean the sponsor names have
  stayed short.
- **A literal four-space run in a title is deleted, not collapsed.** CR and LF become spaces; the
  four-space replacement removes the run entirely, so words can be joined.
- **`programType` silently becomes the literal `"Grant"`** when the source value is empty. That is a
  fabricated value sitting in a column people read as source data. Same class of issue as the
  `(untitled grant <n>)` title placeholder.
- **`nihIc` is null for real CDC awards.** The prefix is only mapped for the 26 NIH institutes, so a
  CDC award gets a `mechanism` and no institute — gating on the prefix map is the principled fix, and
  it would currently drop real CDC awards. The regex itself accepts three- **and** four-character
  activity codes, widened in #2182 precisely so CDC forms like `1 NU58DP007916-01-00` parse. What it
  does get wrong is a false-positive parse of a Fred Hutch reference number `FHCRC 203865-01` to core
  `FHCRC203865`.
- **`Co-PI` does not mean co-principal investigator.** It means a non-contact PD/PI on a multi-PI
  award. OSRA does not use the Co-PI designation at all, matching NIH. Anyone reading the label
  literally will draw the wrong conclusion.
- **The reporter-grants v2 matcher's comments say "nightly" four times across three files**
  (`etl/reporter-grants/index.ts`, `etl/reporter-grants/v2.ts` twice, and `cdk/lib/etl-stack.ts`)
  while the step appears only in the weekly array. Whether that is stale prose or evidence
  of a planned nightly step is not established. Nothing in the arrays supports a nightly run today.
- **`external: true` on a step spec is documentation only.** Nothing reads it; task-def routing keys
  off the npm script name alone. The CDK comment claiming reporter-grants reads ReciterDB is wrong —
  it imports no ReciterDB client.
- **ADR-012's line-number citations have drifted** against current master (it cites
  `etl/infoed/index.ts:647` and `:487` for code that now sits elsewhere). The ADR's *reasoning* is
  current; its line anchors are not. Navigate by symbol name.
- **`assertPruneVolume`'s denominator is read after `createMany` has already run,** so newly created
  rows pad it and the 10% ceiling is slightly more permissive than a pre-run count would be. Whether
  that ordering is deliberate is undocumented, and it contradicts the guard module's own stated
  contract that guards throw before any destructive pass.
- **`rowsProcessed` on the `etl_run` row counts prepared rows, not writes.** A run where nothing
  changed still reports the full count.

## 8. Failure modes and recovery

### The two failure modes that currently trigger no alert

Read these first. Both are structural, both are established from the code rather than from an
observed incident, and both are silent.

**1. A partial extract that loses 10% or less of rows hard-deletes up to ~1,800 production grants and
fires nothing.**

The entire detection ladder for InfoEd volume:

| Guard | Threshold | Verdict on a 5% loss |
|---|---|---|
| `assertPruneVolume("infoed:stale-grants")` | throws above **10%** deleted | passes |
| `etl:integrity` `findVolumeRegressions` | fires above a **50%** drop in `rowsProcessed` | passes |
| `etl:freshness` | age since last `status='success'` only | passes — a partial run is a success |

So the band **above 0% and up to 10% is graded by nothing**. What happens in that band is a
`deleteMany` scoped to `source = 'InfoEd'`: a **hard delete**, no tombstone, no soft-delete column.
On a feed of ~17,974 rows (see §2 for the measurement) that is up to **~1,797 grants deleted per run
with zero signal**. The nightly search-index rebuild runs later the same night, so the loss
propagates to funding search the same night too.

This case is established **structurally** — from the guard thresholds plus the hard delete — not
from an observed incident. Nothing in the code or docs records a measured instance of the band being
entered. A read of production `etl_run.rows_processed` history for `source = 'InfoEd'` would settle
whether it ever has. Note also that a persistently-truncated source loses ~10% **once** (night two
sees the already-shrunk table), whereas a *progressively* degrading source loses ~10% **every**
night. Which pattern a real InfoEd truncation produces is not determinable from the code.

**InfoEd has no incoming-volume floor at all.** It imports only the prune guard. Every peer WCM
source calls `assertSourceVolume` — `etl/ed`, `etl/reciter`, `etl/coi`, `etl/jenzabar`, `etl/pops`,
`etl/reporter`, `etl/tools`, `etl/clinical-trials`. InfoEd and ASMS are the only two nightly WCM
sources guarded by prune volume alone. There is no absolute floor on the `grant` table in
`etl:integrity` either; it floors `scholar` (below 5000) and `publication` (below 100000) only, and
counts `grant` solely to assert the funding index is not empty.

Adding an `assertSourceVolume` call to `etl/infoed` is the obvious fix. The right floor value depends
on the real production grant-count distribution across sources, which is not in the repo.

**2. The date-gap worklist has no consumer and no alarm.**

Every undated award is written to `grant_date_gap`, and the complete list of consumers is one CLI
script (`npm run report:grant-date-gaps`). There is no app route, no `/edit` page, no alarm, no
threshold, and no grant-date dimension on the data-quality dashboard. The backlog stands at **1,988
accounts (measured 2026-08-03 to 2026-08-04)** and it is a lower bound. Nothing in the repo shows a
row ever transitioning to `resolved` by human action, or the CSV ever reaching OSRA.

### What a bad run looks like

| Mode | Symptom | Effect on data |
|---|---|---|
| **Source unreachable** | `sql.connect` throws after 30s | `etl_run` marked `failed`, exit 1. **No writes.** Grants stay at last-good |
| **Auth failure or missing credential** | A named throw on the unset env var, or a login error | Same. No writes. A key missing from the secret JSON fails at **task start**, before any of this |
| **Query hang / slow creep** | `RequestError … ETIMEOUT` after 40 minutes, three times | No writes. The real incident: the 2026-08-05 nightly burned 3 attempts x ~2427s ≈ 3.28h; grant data had been frozen since 08-04. The per-attempt task timeout is 4h, so the step burns its whole budget without tripping it |
| **Zero rows on a successful read** | `inserts = 0` | Every existing row classifies as stale, the prune guard sees 100%, throws. Caught **only as a side effect** of tombstone volume, and the guard no-ops entirely against an empty grant table (bootstrap) |
| **Partial extract, 10% or less** | Nothing | **Silent hard delete.** See above |
| **Partial extract, more than 10%** | `EtlGuardError` | Throws, but **after** creates and updates have already landed |
| **Schema drift breaking a query** | MSSQL error | Same as unreachable. No writes |
| **Schema drift re-keying an account** | Nothing, until a suppression orphans | Old id hard-deleted, award returns under a new id **unsuppressed** (§4) |
| **`pgm_type` goes NULL on a record** | Nothing | Row vanishes from the feed and from the worklist simultaneously. Invisible from both sides |
| **Undated award** | Nothing | Grant never renders. Gap row written, read by nobody |

### How to detect it

| Failure mode | Signal | Topic |
|---|---|---|
| Step threw (unreachable, auth, query error) | `NotifyInfoed` SNS publish from the step's `Catch`, which only runs after retries are exhausted | `etl-failures-<env>`, re-graded to **page** |
| Step threw, second net | `DegradedRun`: an error present at the chain end fails the execution, tripping `sps-etl-nightly-status-<env>` | `etl-failures-<env>` |
| Slow creep toward the timeout | `sps-etl-nightly-duration-<env>`, `ExecutionTime` MAXIMUM above 150 min | `etl-failures-<env>` |
| Schedule never fired | `sps-etl-nightly-cadence-<env>`, `ExecutionsStarted < 1` over 30h, missing data treated as breaching | `etl-failures-<env>` |
| Timed-out or operator-aborted execution | Status alarm metric math `failed + timedOut + aborted`. A machine-level `timeout:` kill runs **no** Catch, so nothing else notifies | `etl-failures-<env>` |
| Green but stale, more than 30h since the last InfoEd success | `etl:freshness` exits 1, tripping `sps-etl-heartbeat-status-<env>` | `etl-failures-<env>` |
| A re-key orphaning a suppression | `etl:integrity` `suppression:orphan-infoed` violation, which **aborts** the nightly | **`etl-page-<env>`** |
| More than a 50% `rowsProcessed` drop | `etl:integrity` `volume:InfoEd` | `etl-page-<env>` |
| **Loss of 10% or less** | **nothing** | |
| **Undated awards** | **nothing** | |
| **`rowsProcessed = 0` on a success** | **nothing** | Freshness ignores row counts, and the integrity volume history filters `rowsProcessed > 0`, so a zero-row success is not even retained as a sample |
| **`SCHOLARS_ENV` unset on the ETL task def** | **nothing** | An env-scoped source is **skipped**, not failed, and the skip is a `console.log` line. Drop `SCHOLARS_ENV` and InfoEd stops being freshness-graded silently |

Two things about severity worth knowing before you trust the routing:

- A nightly step failure now grades **page** rather than warn (#2192). That re-grading lives in the
  on-call relay Lambda, which goes live only on a `cdk deploy Sps-Observability-<env>` — and CD rolls
  images, not infrastructure. **Whether that deploy has run is not verifiable from the repo.** If it
  has not, an InfoEd step failure still grades warn. Check before assuming you will be paged.
- The P2 warn channel falls back to the **page** channel until an optional per-env warn webhook
  secret exists. Secret existence is not readable from the repo.

A `SUCCEEDED` nightly execution is **not** evidence the InfoEd step ran. Before #2191, `tier:
"continue"` meant the nightly reported SUCCEEDED with the step dead inside it: measured at **2 of 20
production nightlies between 2026-07-17 and 2026-08-05**. Use `/edit/etl-status` (which reads
`etl_run`, not execution history) or the `etl_run` table directly.

### Triage, in order

1. **Is the schedule even enabled?** Check the EventBridge rule `sps-etl-nightly-<env>`. Prod
   cadences were enabled **out of band on 2026-07-07** and ran drifted from the CDK template for
   about four weeks before reconciliation (#1512). Several docs still claim prod cadences ship
   disabled. They do not.
2. **What does `etl_run` say?**
   ```sql
   SELECT source, status, started_at, completed_at, rows_processed, error_message
   FROM etl_run WHERE source = 'InfoEd' ORDER BY started_at DESC LIMIT 10;
   ```
   Compare `rows_processed` against ~17,974. A number that is close but not equal is the silent band.
   A number that is 0 is invisible to every alarm.
3. **Read the step log.** Log group `/aws/ecs/sps-etl-<env>`, stream `etl/etl/<task-id>`. The state
   machine log is `/aws/states/nightly-<env>`. The success line to look for names both query timings
   separately, on purpose, because the failure that motivated it was a query getting slower with
   nothing in the log to show it:
   `InfoEd returned ~17,974 grant rows in ~500s; 29,326 account periods in ~1s.`
4. **Check the image tag before diagnosing anything.** `sps-etl-prod` binds the **mutable `:latest`**
   tag, so what ran is not pinned to a commit the way the app task def is. A feature-branch staging
   deploy rebuilds the staging ETL image from that branch, silently rolling ETL code back to its
   merge base.

### Recovery

**Re-running is safe.** The ETL has been idempotent since #352: reconcile by `externalId` rather than
truncate-and-recreate, so each row keeps its uuid primary key and the enrichment columns survive.
Confidential-title suppressions are reflected into the funding index inside the run since #2284, so a
standalone re-run does not leave an exposure window.

Manual re-run. **Use the `sps-etl-sources-<env>` task family, not the base family** — `etl:infoed`
carries the InfoEd secrets only there, and a run against the wrong family fails at task start with a
missing secret key. Container name is `etl`, not `app`.

```
# Resolve the subnets and security group LIVE off the nightly state machine.
# NEVER hardcode them: the VPC cutover moved both, and stale ids launch into
# the dead VPC and present as a DB timeout.
aws ecs run-task --cluster sps-cluster-$ENV \
  --task-definition sps-etl-sources-$ENV \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$ETL_SUBNETS],securityGroups=[$ETL_SG],assignPublicIp=DISABLED}" \
  --overrides '{"containerOverrides":[{"name":"etl","command":["npm","run","etl:infoed"]}]}'
```

Resume the nightly mid-chain instead, if downstream steps also need to run:

```
aws stepfunctions start-execution \
  --state-machine-arn arn:aws:states:us-east-1:<acct>:stateMachine:scholars-nightly-prod \
  --input '{"startFrom":"Infoed"}'
```

The step id is `Infoed`. A `startFrom` that is present but matches no step now fails loudly as
`UnknownStartFrom` rather than silently running the whole chain. An empty `{}` input falls through to
the first step.

**Doc trap:** both `data-population-runbook.md` and `DEPLOY-RUNBOOK.md` show
`--task-definition sps-etl-$ENV` for ETL re-runs. That is correct for `search:index` and for
backfills. It is **wrong for `etl:infoed`**.

**There is no InfoEd replay or backfill.** This is the single most important recovery fact in this
document. The delete is a hard delete. If a bad run deleted rows, your options are:

1. The next good run re-creates them — but with **new uuid primary keys**, so anything the
   manual-override layer keyed on the old row is lost.
2. **Aurora point-in-time recovery.** RPO 24h or better, RTO 4h or better.

That is the whole list.

**`ETL_GUARD_BYPASS` is not a routine tool.** Setting `ETL_GUARD_BYPASS="infoed:stale-grants"` (or
`"all"`) turns off the **only** thing standing between a truncated read and a mass hard delete of the
grant table. Set it through `containerOverrides.environment` on a one-off `run-task` and never
permanently, and verify the shrink is genuine before you do.

**Ordering, if you are reasoning about a crash mid-run.** `repointReissuedSuppressions` runs **after**
the `deleteMany`, deliberately. A crash between them leaves an orphaned suppression, which the
integrity check reports and pages on. Re-pointing first and then crashing would **un-hide** a stale
row that still exists. The current order fails safe.

### InfoEd does not run on staging, at all

The step is spliced out of the staging cadence. InfoEd's on-premises address sits in a range that
overlaps the SPS VPC's own CIDR, so the VPC routes that address into itself and blackholes it, and
the step's Catch-to-Fail would then abort the entire nightly. The SPS VPC cannot reach it today in
any case: InfoEd is on-premises and not TGW-attached. The freshness policy mirrors this by scoping
InfoEd to prod only. Re-adding staging is gated on WCM re-IPing or NATing InfoEd out of the
overlapping range.

Two consequences you have to plan around:

- **There is no staging rehearsal for any InfoEd change.** That is exactly how #2176 (a derived-table
  join that could not be seeked) reached production and killed the grant import for a day. A change
  to either query is a SQL string: `tsc`, the unit suite and CI can see **none** of its failure
  modes. The full unit suite (8,585 tests at the time ADR-012 was written; **no date recorded**, and
  it grows every merge) passed on a draft containing both a period-narrowing defect and an
  inverted-period defect. Only an in-VPC before/after diff caught them.
- **Any "go look at this record in the new system" instruction must name production explicitly**, or
  people will check staging, find nothing, and conclude the feed is broken.

Several docs are stale on this and still list `etl:infoed` among staging preconditions and in the
staging nightly chain. They are wrong.

### The environment variable trap

ETL tasks carry **`SCHOLARS_ENV`**. App tasks carry **`SPS_ENV`**. They are not interchangeable.
Reading `SCHOLARS_ENV` from the running app leaves the env undefined and **silently drops every
env-scoped source, InfoEd included**. The app-side loader resolves `SPS_ENV` first and falls back to
`SCHOLARS_ENV` only so it remains usable from an ETL-family task.

## 9. Related decisions

Pointers, not restatements. Read the source when the question is "why".

- [**ADR-012 — InfoEd grant import policy**](../ADR-012-infoed-grant-import-policy.md). The rule set
  this document implements: which records are admitted (D5, D7), what may be published as a project
  period (D1, D2), where a date may come from (D4), how confidentiality is enforced (D9), what a
  `grant_date_gap` row means (D3), and the investigator-role contract (D11). Note its Status header:
  parts are merged but dark. **Check what is actually deployed before quoting it as current
  behaviour.**
- [**ADR-005 — Manual-override layer**](../ADR-005-manual-override-layer.md). Why `/edit` is
  hide/show only for grants, and why the uuid primary key must survive every ETL run. This is the
  reason #352 replaced truncate-and-recreate, and the reason an account re-key is a real incident
  rather than a cosmetic id change.
- [**ADR-001 — Runtime data access layer equals ETL transform**](../ADR-001-runtime-dal-vs-etl-transform.md).
  Why the role mapping, the sponsor canonicalization and the funder string are computed in the ETL
  and stored, rather than derived at request time.
- [**ADR-009 — Separate the runtime writer from the migration runner**](../ADR-009-database-role-separation.md).
  Why this ETL writes through `db.write` and why the suppression reflect reads through `db.read`,
  which is why both pools have to be closed at the end of the run.

Companion operational docs: [`etl-monitoring.md`](../etl-monitoring.md) (what each signal means),
[`oncall.md`](../oncall.md) (where alerts land), [`data-population-runbook.md`](../data-population-runbook.md)
(re-run procedures, with the task-family caveat in §8), and
[`dependency-outage-matrix.md`](../dependency-outage-matrix.md) (source inventory — note its InfoEd
row says "existing grants still render", which is true for an outage and **false** for the
partial-extract band).

## 10. Source correspondence

**This is a scratch section. Everything below is raw material, not a specification.**

The working rule: **emails and notes from source owners get pasted here verbatim as they arrive**,
attributed and dated, without being edited into shape. Verbatim matters — a paraphrase of a source
owner's claim loses exactly the qualifier that turns out to matter six months later. Periodically,
durable claims get **extracted up** into the structured sections above (a filter into §5, a contact
into §1, a surprise into §7), and the original stays here as provenance.

Append new entries at the end, newest last. Do not delete old ones, even when they are superseded —
note the supersession inline instead.

### 2026-08-06 — OSRA / RAC record review

A record review was raised on the OSRA/RAC side, asking to confirm scope before the RAC team began
work. Three questions were put to the Scholars side, and the answers were prepared on 2026-08-06
from a read of the codebase at master. Summarised here; the full internal briefing is not in this
repo because it carries internal counts and named individuals.

**Q1. "Our understanding is that VIVO displays only active funded projects."**

Answered: whatever was true of VIVO, it is **not** true of Scholars. Scholars ingests and publicly
displays **expired awards as well as active ones**. The extract admits `Active Award`, `Expired
Award` and `In Process`, and there is no date cutoff, no lookback window, and no "ends after today"
filter anywhere in the import. Profiles render both a current and a past section, both public, and
expired awards are searchable. A cleanup list containing expired project periods is **in scope**, by
design.

**Q2. "Before undertaking a detailed review, we'd like to confirm whether those records are actually
in scope."**

Answered: mostly yes, with one exclusion that should shrink the work. `In Process` records are
imported but **must not be reported as missing data** (ADR-012 D7) — an unawarded proposal correctly
has no awarded period, so asking someone to fix it is asking them to invent an award that does not
exist. The list should be re-cut by project status before review effort starts. Measured
2026-08-03 to 2026-08-04, 980 of the 1,691 fully-undated accounts are `In Process`.

**Q3. "The criteria and business rules used in the original WRG-to-VIVO data feed."**

Answered: we do not have them, and reconstructing them from memory would be worse than saying so.
The Scholars repository contains no documentation of the WRG-to-VIVO feed anywhere. More
importantly, **Scholars does not use the same feed VIVO did** — VIVO was served from the InfoEd
`dbo.VIVO` integration view, and Scholars does not read that view at all; it connects to the raw
production tables and runs its own query. The old rules would not describe what Scholars shows even
if they were recovered. If the legacy rules are genuinely wanted, the artifact to request is the
`CREATE VIEW` text of `dbo.VIVO` from whoever owns the integration database.

**Raised proactively by the Scholars side, as the likely highest-yield cleanup item:** the blank
`pgm_type` population. 18,113 of 62,474 in-scope proposal rows, 29% (measured 2026-08-03), are
dropped entirely by an inner join. Those awards are missing from Scholars regardless of how clean the
rest of the record is, and they appear on no Scholars-generated worklist, so the issue is invisible
from where OSRA is currently standing. A bulk populate of `pgm_type` would surface a large population
at once.

**Open asks recorded from this exchange:**

| Direction | Ask | Status |
|---|---|---|
| Scholars → OSRA | A decision on whether **proposed periods** should ever be adopted as project periods. Scholars' position: not without an explicit `datesSource` label, and never as awarded dates (ADR-012 D2) | Open |
| Scholars → OSRA | The direction of `Service Agreement (WCM)` — incoming or outgoing funding. 171 accounts, the single largest unresolved category, not derivable from InfoEd data (ADR-012 open question 2) | Open |
| Scholars → OSRA | A ruling on whether outgoing and non-funding agreements belong on a profile at all (ADR-012 D10). 334 of 10,100 published rows, 3.3%, across 295 accounts, measured 2026-08-03 to 2026-08-04 | Open |
| Scholars → integration DB owner (TBC) | The `CREATE VIEW` text of `dbo.VIVO`, if the legacy rules are wanted | Not yet requested |
| OSRA → Scholars | Confirmation of how OSRA wants to receive the date-gap worklist, and in which cut | Open. Note §8: there is currently no delivery mechanism at all beyond a CLI |
| Scholars, internal | Disclose the RePORTER funding-search gap (§6 limitation b) as a defect on our side, not as intended behaviour. Not something OSRA or RAC need to act on | Open |

**Two claims from this exchange that were explicitly flagged as unverified at the time**, so they are
not later quoted as measurements:

- The share of grant suppressions that are RePORTER-sourced comes from a code comment recording an
  earlier production measurement, not from a query run that day.
- "The automatic RePORTER matcher is off in production" was read from the infrastructure definition,
  not from the running task definition. Deployed configuration can lag the definition.

### Append new correspondence below this line
