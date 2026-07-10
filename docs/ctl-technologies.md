# CTL available technologies + sponsor intake

Origin: Lisa Placanica (Senior Managing Director, WCM Center for Technology
Licensing), 2026-07-09. Three asks: (1) find researchers when a commercial
sponsor makes an inbound inquiry, (2) link to Scholars from CTL's site, (3) pull
CTL's available technologies through to a researcher's profile.

Ask 1 needs no code — it is `/edit/find-researchers`, already shipped. Ask 2 is a
URL. Ask 3 is what this document covers, plus the resulting funding-matcher signal.

## The join: CTL already publishes CWIDs

CTL's portfolio (`innovation.weill.cornell.edu/technology-portfolio`, ~280 pages,
Drupal, no structured feed) prints each technology's Principal Investigator with a
VIVO link:

    https://vivo.weill.cornell.edu/display/cwid-zhz9010

The CWID is in the href. Technologies therefore join to `scholar` **by
identifier, never by name** — there is no fuzzy matching anywhere in this
pipeline, and there must not be.

Coverage as of 2026-07-09:

|                                            | Count                    |
| ------------------------------------------ | ------------------------ |
| Detail pages listed                        | 280 (1 dead: `/rpe`)     |
| Pages carrying a VIVO/CWID link            | 219 / 279                |
| Pages with a PI but **no** link            | 60                       |
| (scholar, technology) pairs produced       | 235                      |
| Rows landing after the `scholar` FK filter | 225, across 120 scholars |

The 60 unlinked pages are a **mix**, not one thing:

- departed faculty (Cantley, Silverstein, Vahdat, Hla, Muller) — no `scholar` row;
- people who would never hold a `scholar` row (a resident, a senior technician);
- **current faculty CTL simply did not link** — e.g. Michelle Bradbury, `msb2006`.

Two dead ends, both tempting:

- **Name matching** recovers ~3 rows and invites false attributions. Don't.
- **Attributing by PMID** looks attractive because 75% of pages link a paper, but
  CTL's linked papers carry **3.2 scholar-authors on average** — you would credit
  every co-author with the invention. The PMID is for _displaying_ the paper, not
  for deciding who invented it.

**The ask back to CTL:** add VIVO links to the 60 unlinked pages for inventors who
are still here, and repoint every VIVO inventor link at Scholars once VIVO is
retired. That is the same work as their ask (2), and it keeps this import alive.

### The papers corroborate the join

CTL lists a related paper on 75% of pages. Following those PubMed links:
264 (scholar, PMID) pairs; 256 of those PMIDs are already in our `publication`
table; and **243 of the 256 (95%) are authored by the very PI CTL names on the
page.** Two independent sources agree on attribution. The 13 that disagree are
worth showing CTL, not acting on.

## ETL

`npm run etl:technologies` → `etl/technologies/index.ts`.

**Cadence: weekly**, as `TechnologyWeekly` in the deployed Step Function
(`cdk/lib/etl-stack.ts`), `tier: "continue"` so a CTL outage never aborts the
chain. It is also listed in `etl/orchestrate.ts`, but that file is only the
in-process prototype runner (`npm run etl:daily`) — a step there is **not**
scheduled in staging or prod. Wiring the deployed cadence requires
`cdk deploy Sps-Etl-<env>`.

Each run scrapes CTL live, validates (origin-pinned URL, well-formed CWID), drops
rows whose CWID has no `scholar` row (logged as `droppedUnknownCwid`, currently
10), then:

- **Volume guard** — aborts without writing if the row count falls below
  `TECHNOLOGIES_MIN_RETAIN` (default 0.8) of what's in the table. A CTL markup
  change or partial outage aborts loudly instead of blanking the section.
- **No-op short-circuit** — if the scrape is identical to the table's current
  contents, no write happens at all. CTL's portfolio changes a few times a year,
  so nearly every weekly run lands here: no truncate/insert churn, no
  `refreshed_at` bump. The comparison is against the table, not a stored hash, so
  there is nothing to drift out of sync.
- Otherwise a full replace inside one transaction.

Either way an `etl_run` row lands under `source="Technology"`.

Env:

| Var                       | Default   | Purpose                                                                    |
| ------------------------- | --------- | -------------------------------------------------------------------------- |
| `TECHNOLOGIES_SEED_PATH`  | _(unset)_ | Read this JSON instead of scraping. The offline path for local dev and CI. |
| `TECHNOLOGIES_MIN_RETAIN` | `0.8`     | Volume-guard floor, as a fraction of current rows.                         |

### Fields

| Column         | Coverage                | Notes                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `title`, `url` | 100%                    |                                                                                                                                                                                                                                                                                                                                                                                                              |
| `reference`    | 155/235 rows            | CTL's "Cornell Reference" docket. Editors wrap it in stray `<span>`/`<p>` markup on some pages; the scraper strips tags and the validator **rejects any surviving angle bracket** — `&lt;span&gt;9220&lt;/span&gt;` once rendered on staging.                                                                                                                                                                |
| `patentStatus` | 143/235 rows            | Normalized to a closed vocabulary: `Provisional filed`, `PCT filed`, `Application filed`, `Issued`. CTL's raw text is prose (`US Patent 9,943,506 . "BCL6 inhibitors..." Issued`), so `normalizePatentStatus` classifies rather than truncates. Unrecognized prose yields null (no chip) instead of failing the run. **A pending application must never be labelled `Issued`** — the rule order enforces it. |
| `pmids`        | 163/235 rows, 226 links | Scoped to CTL's dedicated publications pane, not the whole page: a stray PubMed link in prose is not a claim about the invention. Rendered as PubMed links.                                                                                                                                                                                                                                                  |

`etl/technologies/technologies.json` is a committed **fixture**, not the
production source of truth. Regenerate it with
`npx tsx scripts/scrape-ctl-technologies.ts` and eyeball the diff when CTL's
portfolio changes.

### When the volume guard trips

It means the scrape shrank. Check, in order: is CTL up; did their markup change
(run the scraper by hand and read the `pagesWithoutCwidLink` count); did they
genuinely retire technologies. Only then lower `TECHNOLOGIES_MIN_RETAIN` for one
run. The table keeps its previous contents until you do — a trip is not a loss.

## Profile section

`AVAILABLE_TECHNOLOGIES_SECTION` gates the payload in `lib/api/profile.ts`. Off ⇒
`technologies: []` regardless of table contents, so the ETL can land before the
flag flips. Staging-on, prod-off (`cdk/lib/app-stack.ts`).

Rollout: land the migration -> let one weekly run populate the table (or run
`etl:technologies` as a one-off ECS task) -> verify on staging -> flip prod.

The section is deliberately a compact **row**, not a card: it sits directly under
Funding and Clinical trials, which are rows. There is no per-row contact block —
112 of 129 scholars have a single licensing officer across all their
technologies, so repeating it per row is noise, and caching a named person's
email would rot the moment CTL reassigns a docket. One shared inbox in the
footer; the named officer lives on CTL's own page, one click away.

## Funding-matcher signal

Scholars holding CTL IP are **~2.7x over-represented** in the top-10 of the
reverse matcher (`rankResearchersForOpportunity`), measured across the local
corpus: 8.3% of the rankable pool holds IP, versus 22.5% of top-10 slots.

The concentration is entirely in bench/translational topics — gene therapy 5/10,
immunology 6/10, genomics 6/10 — and **0/10** for health-services,
implementation-science, and workforce topics. Applying the signal corpus-wide
would inject noise exactly where it has none to give.

So `GRANT_MATCHER_IP_SIGNAL` (default off) boosts `defaultScore` by
`GRANT_MATCHER_IP_BOOST` (default 0.15) **only** on SBIR/STTR (R41–R44) and the
phased UH2/UH3 mechanisms. `U01` is deliberately excluded: a general cooperative
agreement, not a tech-development vehicle. The mechanism set is a judgment call —
the corpus used for the enrichment measurement carries no `mechanism`, so nothing
in that set is validated by it. Revisit against a real grants.gov corpus.

Two invariants, both unit-tested:

- The boost is applied **before** `limit`, so an IP holder can _enter_ the top-N
  rather than merely reshuffle within it.
- The boost moves `defaultScore` only. `axes.topicFit` stays the untouched topical
  evidence, so a row's rationale never overclaims topical fit.

`technologyCount` is attached to every ranked row regardless of the flag, so the
★ column is observable on `/edit/find-researchers` before the boost is trusted.

## Granting CTL access to /edit/find-researchers

Use the **`development`** role. Not superuser — that would confer profile writes,
unit admin, and "View as" impersonation. `development` exists precisely for this:
it opens `/edit/find-researchers` and its data route and nothing else.

Two mechanisms back the role, and **only one currently works**:

1. ED group `ITS:Library:Scholars/development-role` — **dormant for the app.** The
   App task definition carries no `SCHOLARS_LDAP_*` credentials, so `isDeveloper()`
   fails closed before it searches. Adding someone to this group does nothing today.
2. `SCHOLARS_DEVELOPMENT_ALLOWLIST` — the operative path. Currently `"flm4001"` on
   staging, empty in prod.

`DEVELOPMENT_ENABLED` is already `"on"` in staging and prod. So granting access is
a one-line edit to `cdk/lib/app-stack.ts` plus a reviewer-gated
`cdk deploy Sps-App-prod`. Note that prod App lags master substantially — `cdk diff`
and review the accumulated drift before deploying.

Once LDAPS routing reaches the App task (issue #443), the ED group becomes the
durable path and the allowlist retires.
