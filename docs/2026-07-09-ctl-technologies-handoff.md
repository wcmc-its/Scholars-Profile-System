# CTL / Enterprise Innovation — handoff (2026-07-09)

Everything shipped, everything deliberately deferred, and the two things that are
wrong today. Read `docs/ctl-technologies.md` first for how the pipeline works;
this file is the state of play and the decision log.

## Origin

Email from **Lisa Placanica**, Senior Managing Director, WCM Center for Technology
Licensing (`lmp26@cornell.edu`), 2026-07-09. Three asks, in her order:

1. _"help us identify researchers when we have inbound interest from potential
   commercial sponsors. Is there a beta site we can access?"_
2. _"link to that from our own Website to aide commercial partners search for
   potential collaborators"_ (under their **Collaboration Opportunities** page).
3. _"This may be a pipedream, but... pull through to a researcher's profile any of
   our available technologies just like you list grants and publications... we have
   the lead PI listed as well as any relevant paper about the invention."_

She also asked for the ppt walked through in the meeting. **Not yet sent.**

## Audience — decided by evidence, not assumption

**External commercial partners: pharma/biotech BD, VCs, startup founders. Not
researchers, not Cornell Ithaca.**

All 279 technology pages carry `enterpriseinnovation@med.cornell.edu`; 245 also
name a specific licensing officer. The pages are a licensing storefront with a
contact route. Her ask (2) says it outright — _"aide commercial partners."_

So: **ask 1's users are CTL's ~6 licensing officers** (internal). **Asks 2 and 3
serve external industry** (unauthenticated, arriving from CTL's site).

CTL is a Cornell-wide office (Lisa's `@cornell.edu` address is an Ithaca NetID, as
are all the licensing officers'), but `innovation.weill.cornell.edu` is the
**WCM-scoped** portfolio — every PI title sampled is a WCM title. Scholars holds
only WCM people, so an Ithaca inventor would have no profile. State that boundary
to her; do not try to close it.

## Shipped

| PR    | What                                                                     | State                       |
| ----- | ------------------------------------------------------------------------ | --------------------------- |
| #1594 | `scholar_technology` table, ETL, profile section, translational-IP boost | merged, **live on staging** |
| #1596 | `TechnologyWeekly` in the deployed Step Function                         | merged                      |
| #1602 | reference-markup bug, binary-file bug, `patentStatus` + `pmids`          | open                        |

Deployed to **staging only**: `Sps-Analytics-staging` (created the
`sps-usage-app-staging` Athena workgroup — a prerequisite, see below),
`Sps-App-staging` (task def `:116`, `AVAILABLE_TECHNOLOGIES_SECTION=on`), and
`Sps-Etl-staging` (weekly schedule). `scholar_technology` holds 225 rows across
120 scholars. Verified live at `scholars-staging.weill.cornell.edu/ronald-g-crystal`.

**Prod is untouched.** `AVAILABLE_TECHNOLOGIES_SECTION=off`, no prod stack deployed.

## Open items

### 1. Lisa cannot be granted access yet — blocker

Ask (1) needs the **`development`** role, not superuser (superuser confers profile
writes, unit admin, and "View as" impersonation).

Two mechanisms back the role and **only one works**:

- The ED group `ITS:Library:Scholars/development-role` is **dormant for the app** —
  the App task definition carries no `SCHOLARS_LDAP_*`, so `isDeveloper()` fails
  closed before it searches. Adding her to that group would silently do nothing.
- `SCHOLARS_DEVELOPMENT_ALLOWLIST` in `cdk/lib/app-stack.ts` is the operative path.
  Currently `"flm4001"` on staging, empty in prod.

**We do not have her WCM CWID.** `lmp26` is a Cornell-Ithaca NetID; she appears in
neither `scholar` nor `steward_directory`. Resolve by an ED lookup on surname
`Placanica`, or by asking her. Then one line in `app-stack.ts` and a
reviewer-gated `cdk deploy Sps-App-prod` — note prod App lags master by hundreds of
commits, so `cdk diff` and review the accumulated drift first.

### 2. `/edit/find-researchers` is the wrong tool for ask (1)

Saying "it already exists" was true of the machinery and false of the workflow.
That surface ranks by `topicFit` + `stageAppeal` and demotes on **ESI
eligibility** — NIH-grant concepts a pharma sponsor does not care about. Its
intake takes a **URL to scrape**; sponsor interest arrives as an email or a call.

Ask (1) deserves a thin surface of its own: paste a sponsor's description, rank
WCM researchers on topical fit alone, no stage axis and no ESI. The ranking engine
(`rankResearchersForOpportunity`) is reusable; the axes and the intake are not.

### 3. The translational-IP boost should probably be deleted

`GRANT_MATCHER_IP_SIGNAL` (ships off) boosts IP-holders when ranking researchers
for SBIR/STTR opportunities. Nobody asked for it. It runs scholar -> NIH-funding;
Lisa's problem is sponsor -> scholar. It never touches her use case.

The 2.7x enrichment behind it is real but was measured on **twelve synthetic DEMO
opportunities**, and the corpus carries no `mechanism`, so the mechanism list
(`R41`-`R44`, `UH2`, `UH3`; `U01` excluded) is **judged, not measured**.

Either delete it, or re-measure against staging's real grants.gov corpus before
anyone flips the flag. Do not flip it on the current evidence.

### 4. Asks (2) and (3) for CTL

- Ask (2) costs nothing: send her the URL. `scholars-staging.weill.cornell.edu`
  today (WCM-network CIDR-gated), `scholars.weill.cornell.edu` at launch.
- **The data-quality ask back to CTL**, which is bigger than first reported:
  60 of 279 pages have no VIVO inventor link. Some are current faculty
  (Michelle Bradbury, `msb2006`). Ask them to add links for inventors still here,
  and to **repoint every VIVO inventor link at Scholars once VIVO retires** — that
  is the same work as their ask (2), and it is what keeps this import alive.
- Send the ppt.

### 5. Prod rollout

1. Merge #1602.
2. `cdk deploy Sps-Etl-prod` (schedules `TechnologyWeekly`).
3. Populate: one-off ECS task `npm run etl:technologies` on `sps-etl-prod`, or wait
   for the Sunday 12:00 UTC weekly.
4. **`cdk deploy Sps-Analytics-prod` BEFORE `Sps-App-prod`** — see below.
5. Flip `AVAILABLE_TECHNOLOGIES_SECTION` to `"on"` for prod in `app-stack.ts`,
   then `cdk deploy Sps-App-prod`.
6. Leave `GRANT_MATCHER_IP_SIGNAL` off.

## Traps, paid for the hard way

**Analytics must deploy before App.** Master carries an undeployed rename,
`SPS_USAGE_WORKGROUP: sps-usage-<env> -> sps-usage-app-<env>`. The new workgroup is
created by the **Analytics** stack. Deploying `Sps-App-<env>` first points the
running app at an Athena workgroup that does not exist. Confirmed on staging:
`aws athena get-work-group --work-group sps-usage-app-staging` returned
_WorkGroup is not found_ until `Sps-Analytics-staging` was deployed.

**`etl/orchestrate.ts` is not the deployed nightly.** It is the in-process
prototype runner (`npm run etl:daily`). The deployed cadence is a Step Functions
chain in `cdk/lib/etl-stack.ts`. A step added only to `orchestrate.ts` never runs
in staging or prod. This shipped wrong in #1594 and was fixed by #1596.

**Run `node scripts/release/flag-parity.mjs` before pushing.** It runs in the
`cdk` CI job _after_ the cdk vitest suite, so green cdk tests do not mean a green
cdk job. Every new `process.env.LITERAL` must be wired per-env in `app-stack.ts`
or registered in `scripts/release/flag-parity-allowlist.txt`. #1594 went red on
three tuning knobs after tsc + eslint + 6,772 vitest + the cdk suite all passed.

**Never attribute a technology by PMID.** CTL's linked papers average **3.2
scholar-authors**; you would credit every co-author with the invention. Use the
PMID to _display_ the paper only. The VIVO href is the attribution key.

**Watch for control characters in source.** `fingerprint` shipped with NUL bytes as
separators, so git treated `etl/technologies/index.ts` as **binary** and its diff
was unreviewable in review. Fixed in #1602.

## Rejected from the mockup, and why

`available-technologies-mockup.html` proposed cards with badges and per-card
contacts. Measured against the real portfolio:

- **`Stage: Preclinical`** — appears on 8 of 279 pages (3%). Cut.
- **`Related funding: R33 HL169190`** — **0 of 60 sampled pages carry an NIH grant
  number.** Rendering it means inventing an association between a grant and an
  invention from no evidence. Cut on principle, not coverage.
- **`Licensees: Exclusive field available`** — no such field. Cut.
- **Category chips** (`Gene therapy · AAV`) — only 7 coarse facets exist, and only
  on the listing page. Cut.
- **Per-card contact block with avatar** — 112 of 129 scholars have one licensing
  officer across all their technologies, so it repeats identically; and caching a
  named person's email/phone rots. One shared inbox in the footer instead.
- **Cards** — the section sits under Funding and Clinical trials, which are compact
  rows. Twelve cards would dwarf the publication list, and `Showing 3 of 12` needs
  client state in a zero-JS server component.

Kept because the data is real: `PoC Data:` exists on 115 pages (41%) and
`Technology Overview` on 157 (56%). **Both still deferred** — scraping Drupal prose
is a maintenance tax, and we were already bitten by stray `<span>` tags inside a
_number_. Revisit only if CTL ships a structured export.

## Environment notes

- Local dev DB was brought forward by hand to render the page: seven pending
  migrations plus four `pops_*` columns on `scholar` plus
  `center_program_leader.role`. Additive only.
- Worktree: `~/worktrees/ctl-tech`.
- Scratch analysis (harvested HTML, coverage scripts) lives in the session
  scratchpad, not the repo.
