# COI-from-publications suggestions — how the approach works

**What it is.** A scheduled data source (like ReCiter, InfoEd, RePORTER…) that
surfaces, on a scholar's own `/edit` surface, relationships named in **their own
PubMed competing-interest statements** that we could **not** match against their
current Weill Research Gateway (WRG) disclosures. Each row is a _suggestion to
review_, never a verdict — see `coi-pubmed-unmatched-feasibility.md` for the
governance contract and `coi-pubmed-phase0-trackA-results.md` for the original
validation run.

**Current state (2026-06).** The matcher has been hardened (junk suppression,
multi-author leakage suppression) and the rendered surface has been **narrowed to
`High` tier only** — the credible, scholar-attributed core — with a quiet "to
review" count on the rail. The whole surface remains **dark behind
`SELF_EDIT_COI_GAP_HINT`** pending Faculty Affairs / Compliance sign-off on the
concept and the exact copy. See *The precision journey* and *Production-scale
picture* below for the data behind these decisions.

**Where it sits.**

```
PubMed <CoiStatement>  ──(ReCiter → ReciterDB.reporting_conflicts; upstream, WCM-side)
        │  etl:reciter:coi-statements   (nightly, alongside ReCiter — same WCM-DB path)
        ▼
publication_conflict_statement   (per-PMID verbatim COI text)
        │  etl:coi-gap   (nightly, after etl:coi — reads SPS-DB only)
        │     ├─ extract → attribute → diff-vs-disclosed → tier
        ▼
coi_gap_candidate   (the seeded recommendations; High renders on /edit when the flag is on)
```

The two ETL steps run in the nightly cadence (`etl/orchestrate.ts` and the
EtlStack nightly Step Function) exactly like every other source. The gap
computation reads only SPS-DB and is not network-blocked; seeding the upstream
`publication_conflict_statement` table depends on the same WCM-ReciterDB path the
ReCiter source needs (#443), with an S3 import bridge as the interim
(`etl:reciter:import-coi-statements`).

---

## How one candidate is built — 4 steps

The core matcher is a pure, unit-tested module (`lib/coi-gap/pipeline.ts`), a
faithful port of the validated Track-A harness.

1. **Extract** the candidate entities from the statement (strip boilerplate,
   legal suffixes, grant identifiers; a small gazetteer of known pharma/device
   names anchors the obvious ones).
2. **Attribute** — decide _whose_ relationship it is: the scholar's (their
   surname or exact author-ref initials in the clause), a co-author's, or neither
   (a funder / employer / home-institution clause). This is the hard part.
3. **Diff** the scholar's entities against their disclosed WRG set (fuzzy,
   recall-biased). Only an entity with no disclosed analog survives.
4. **Tier** — `High` when cleanly **scholar-attributed** _and_ a strong entity
   _and_ not already disclosed; `Medium` for softer attribution or a weaker
   entity above the suppression floor; `Low` is suppressed upstream and never
   persisted.

### What renders to a scholar — High tier only

Only `High` candidates render (see *The precision journey* for why). A `High`
match means the scholar's _own_ name/initials are in the clause and the entity is
a strong, undisclosed organization. Real example — **Alexander Drilon** (the
canonical clean case, 48 High relationships), each with its verbatim sentence:

> *"Alexander Drilon has received honoraria from **Exelixis**, **Ignyta**, and
> **Loxo Oncology**…"* · *"…is a consultant for … **AstraZeneca**, **Pfizer**,
> **Blueprint Medicines**, **Genentech**/Roche, **Takeda**…"*

The rail item **"From your publications"** carries a quiet count of how many High
relationships are pending — a muted pill, capped at **"9+"** (the true count is in
the accessibility label). It is deliberately *not* a red alert badge: a cue, not a
compliance alarm.

### What's correctly suppressed — the false-positive avoidance

| Case | Statement (de-identified) | Why suppressed |
| --- | --- | --- |
| **Co-author bleed** (the dominant FP) | _"[CoAuthor-initials] has received fees for consultancy from Pfizer, Genentech and HalioDx SAS."_ in a paper where the scholar is a _different_ author | attributed to the co-author, not the scholar |
| **Multi-author unattributed** (#903) | a shared statement naming ≥2 authors, with an unattributed "the authors are consultants for X" clause | can't be assigned to this scholar on a shared statement |
| Funder / grant id | _"Dr. [S] is supported by NIH grant K23 HL140199 and a grant from the American Lung Association."_ | grant id never extracted; funder has no WRG analog |
| Home institution | _"[S] has filed a patent in conjunction with Cornell University."_ | the scholar's own institution is never a "relationship" |
| Already-disclosed variant | entity `Pfizer` when the scholar disclosed `Pfizer Inc` | fuzzy-matches the disclosed set → already covered |
| **Junk word** (#907) | a bare boilerplate token — `All`, `Various`, `Travel`, ASCO category words | never an organization (single RAW word only) |

---

## The precision journey — 2026 hardening

The surface was tuned **measurement-first**: an internal, read-only diagnostic
export (`etl:coi-gap:diagnose`, #894) re-runs the matcher with every entity
visible — surfaced *and* suppressed — carrying the nearest disclosure, fuzzy
score, tier reason, and failure-mode guess. Numbers are fine in that internal
export; they never reach the scholar-facing card.

1. **#903 — suppress unattributed clauses in multi-author statements.** On a
   shared statement naming ≥2 authors, an unattributed clause can't be assigned to
   this scholar. Measured staging effect: multi-author leakage 586 → 0, legitimate
   single-author candidates untouched.
2. **#907 — junk-word suppression, and a key negative result.** Bare
   boilerplate words (`All`, `Various`, ASCO category words) are suppressed
   (`looksLikeJunkEntity`, single RAW word, judged *before* corporate-suffix
   stripping so `Royalty Pharma` / `Additional Ventures` aren't collapsed to a
   junk token). **The negative result is load-bearing:** suppressing bare
   `First Last` co-author *names* was attempted and **abandoned** — adversarial
   review proved the shape is indistinguishable from founder-/eponymous-named
   organizations (`Leon Levy`, `Karl Storz`, `Grace Bio-Labs`, `Ludwig Cancer`,
   `Henry Schein`, `Royalty Pharma`). There is no regex that separates
   `John Leonard` (a co-author) from `Leon Levy` (a funder), so suppressing the
   class would *hide real conflicts*. Co-author full names are therefore **sized
   in the diagnostic, never suppressed in production.**
3. **#909 — render `High` tier only.** Staging data showed the rendered surface
   was dominated by `Medium` co-author leakage (see below). The bar was raised to
   `High` (scholar-attributed + strong entity). This matches the long-stated
   go-live gate (a measured *High*-tier precision number, not Medium). `Medium`
   rows stay in the table for diagnostics but never render.
4. **#910 — the "to review" count chip** on the rail (muted pill, 9+ cap, not an
   alert), so the otherwise-buried advisory is discoverable.

---

## Production-scale picture (staging snapshot, 2026-06)

Measured on the persisted `coi_gap_candidate` table (≈ staging; the all-tier
numbers predate a full `etl:coi-gap` re-run, but `High` is scholar-attributed and
is stable across the #903/#907 changes).

**Why the bar matters — all tiers vs. High:**

- **~92%** of all surfaced rows are `attribution = "unattributed"` (≈161.6k of
  175.3k) — overwhelmingly co-author disclosures leaking onto a shared paper's
  other authors.
- **~70%** of the scholars who have *any* candidate have **zero** genuinely
  (scholar-)attributed match. Their entire card was leakage.

**The `High`-tier surface (what actually renders):**

| Metric | Value |
| --- | --- |
| Active scholars (denominator) | 8,937 |
| Scholars with ≥1 High suggestion | **585** (6.5%) |
| → scholars who see nothing | 8,352 (93.5%) |
| Total High relationships (deduped — what cards show) | **3,467** |
| Total High rows (counting each source paper) | 8,139 |
| Avg per scholar (of those with ≥1) | 5.9 |
| Median per scholar | ~2 |
| Max (one scholar) | 53 |

**Distribution (per scholar with ≥1 High):**

| High suggestions | scholars |
| --- | --- |
| 1 | 151 |
| 2–3 | 157 |
| 4–5 | 80 |
| 6–10 | 108 |
| 11–25 | 70 |
| 25+ | 19 |

Right-skewed but modest: **~53% (308/585) have just 1–3**, the bulk are under 10,
and a small heavy-discloser tail (**19 scholars at 25+** — the oncology / spine
crowd) is where the "9+" cap earns its keep.

**Two worked cases:**

- **Alexander Drilon (`aed2004`)** — 48 High, all scholar-attributed pharma ties
  (Exelixis, Loxo, AstraZeneca, …). Rail shows "9+". The feature working as
  intended.
- **Rulla Tamimi (`rmt4001`)** — 84 candidates pre-bar, **all unattributed**
  (e.g. *"A.Ashworth is a cofounder of Tango Therapeutics…"*, *"C Lehman is a
  co-founder of Clairity…"*), **0 attributed to her** → **0 High → empty card**.
  Her one real tie (Sterigenics) is correctly suppressed as already disclosed.
  Before the bar her card was 84 false suggestions; after, it's correctly silent.

---

## Quality, limits & the next lever

- **Recall-biased by design:** when attribution is uncertain, the pipeline
  suppresses rather than surfaces. We accept missing some real gaps to avoid false
  accusations.
- **The remaining residual — the real next lever:** the dominant surviving noise
  is a co-author who discloses **without an honorific** in
  `FirstInitial Surname …` form — *"A.Ashworth is a cofounder of …"*,
  *"C Lehman is a co-founder of …"*. Attribution only recognizes `Dr Surname` and
  `First Last` author subjects, so these statements read as *single-author
  unattributed* and the disclosing co-author's orgs leak onto every co-author.
  This **escapes #903** (the statement isn't detected as multi-author) and is the
  highest-value next fix: teach attribution to recognize the initial-surname
  author form (→ attribute as `other` / multi-author → suppressed), or cross-check
  against the paper's actual author roster. It is also what would let `Medium` be
  shown safely in future.
- **Entity-dedup residual:** one relationship can surface as several entities when
  the source spells it multiple ways (e.g. `Genentech` / `Roche` /
  `Genentech Roche`). Cosmetic; inflates a heavy discloser's count slightly.
- **The outstanding quality gate:** a measured High-tier *precision* number
  (human-labeled, ratified with Compliance) — §C in `coi-pubmed-HANDOFF.md` — is
  what a go-live threshold should be set against. The distribution above is a gap
  *rate*, not a precision number.

---

## Governance — the non-negotiables

- **Suggestion, not a verdict.** No forbidden vocabulary
  (undisclosed / gap / missing / violation / failed-to-disclose) anywhere on the
  scholar-facing surface.
- **Tier-only, never a numeric score.** The card shows the verbatim source
  sentence and a qualitative tier; the entity score / attribution / normalized
  form / status never cross to the client. (Numbers are fine only in the internal
  diagnostic export.)
- **High only.** `Medium` is retained in the table for analysis but is never
  rendered, because it is dominated by co-author leakage.
- **Self-only by default**, with superuser parity (#892) for operator review on a
  scholar's `/edit`. Never exposed to curators, proxies/unit-admins, the public,
  the search index, or any compliance feed.
- **Durable dismissal.** A scholar's "Not relevant" is respected; the nightly job
  never re-surfaces a dismissed candidate.
- **Flag-gated.** `SELF_EDIT_COI_GAP_HINT` is **off in both envs** until Faculty
  Affairs / Compliance sign off on concept *and* copy, and a High-tier precision
  number is ratified. Not a staging-first rollout.

---

## Operational notes

- **Cadence:** nightly, in the EtlStack nightly Step Function
  (`etl:reciter:coi-statements` near the ReCiter step; `etl:coi-gap` after the COI
  step). Incremental via the `EtlRun(source="COI-Gap")` watermark; `--full`
  recomputes all. Reconciliation preserves dismissals across runs
  (`lib/coi-gap/lifecycle.ts`).
- **Refresh staging on demand:** a one-off Fargate `run-task` on
  `sps-etl-staging` with `command: ["npm","run","etl:coi-gap"]` (ETL SG, private
  subnets) rewrites the persisted candidates with the deployed pipeline.
- **Internal diagnostic:** `npm run etl:coi-gap:diagnose -- --sample 300 --out -`
  (or `--cwid <cwid>`) re-runs the matcher with every entity visible and emits
  JSONL + a summary (surfaced / suppressed-by-reason / failure-mode buckets). For
  tuning only; never scholar-facing. JSONL is gitignored (CWIDs + statement text).
- **Read-only staging queries** (no bastion): a one-off `run-task` on
  `sps-etl-staging` with a `node -e` override using `require("mariadb")` +
  `process.env.DATABASE_URL` (set `bigIntAsNumber: true`); SELECT-only; logs land
  in CloudWatch `/aws/ecs/sps-etl-staging`, stream `etl/etl/<task-id>`.
- **Reproduce the original validation:** `bash scripts/coi-phase0/run.sh` →
  `/tmp/coi-phase0/` (`candidates.csv` + `report.md`; confidential — never
  committed).

### Change log (PRs)

| PR | Change |
| --- | --- |
| #877 / #881 / #887 | superuser parity + COI-statement S3 import bridge + ETL concurrency |
| #892 | superuser-rail UI: dedup-by-relationship, cite every source, 3-mode sort |
| #894 / #899 | `etl:coi-gap:diagnose` internal export + multi-author sizing |
| #903 | suppress unattributed clauses in multi-author statements |
| #907 | junk-word suppression + co-author-name sizing (two-word suppression rejected as unsafe) |
| #909 | render **High tier only** (hide Medium co-author leakage) |
| #910 | quiet "to review" count chip on the rail |
