# Surfacing Unmatched PubMed Conflicts of Interest on /edit — Feasibility & Design Exploration

> Exploration artifact (not a committed SPEC). Produced from a 4-investigator workflow over the SPS codebase, the
> ReCiter/ReciterDB/PubMed-Retrieval repos, and the 2022 WCM COI capstone reference corpus. Verdict: **BUILD-GATED**.

## Executive summary

Every parallel investigation converged on the same conclusion: this feature is **technically feasible, and the hard parts are not the parts you'd expect**. The PubMed competing-interest text already flows end-to-end into infrastructure SPS can read (PubMed `<CoiStatement>` XML → DynamoDB `PubMedArticle.coiStatement` → `ReciterDB.reporting_conflicts`), so ingestion is a near-verbatim clone of the existing `backfill-abstracts.ts` pattern. The official disclosed-COI ground truth (`CoiActivity` / `coi_activity`) is already populated and already rendered read-only on the `/edit` "COI / Mentees" panel. A 2022 WCM capstone project — by this same user — already built exactly this comparison and proved the gap is real and large (≈37% of PubMed COI statements had **zero** corresponding WCM disclosure). The genuinely greenfield, genuinely risky work is everything *between* ingestion and display: attributing one author's disclosure out of a paper-level blob, extracting and normalizing entity names, and — above all — saying any of this to a named faculty member without it reading as an accusation of research misconduct.

**Overall verdict: BUILD-GATED.** Build it narrowly — self-only, suggestion-framed, behind a dormant flag, preceded by an offline precision study — but treat **Faculty Affairs / Compliance / General Counsel sign-off on the concept and the exact copy as a hard, non-engineering gate**. The single biggest reason this is gated rather than green-lit: the output of this feature is, structurally, an algorithm telling a named person they may have failed to disclose a regulated conflict, computed by mixing a confidential internal disclosure set against public text — and the dominant failure mode (a co-author's conflict mis-attributed to our scholar) produces false accusations that are far costlier than any normal product defect.

## The idea & why it matters

PubMed records carry a `<CoiStatement>` element — the "Competing interests:" text journals collect at publication. The idea is to compare the conflicts a scholar's *publications* declare against the conflicts the scholar *officially disclosed to WCM* (the Conflicts Survey / Weill Research Gateway, surfaced in SPS as `CoiActivity`), and surface the gap to the scholar on `/edit`. The 2022 prior art framed this as three Cases, which the task brief inherits verbatim (`COI project notes - Jan 2022.txt`):

- **Case 1 — in PubMed, NOT in official disclosure.** *The problem case this feature targets.*
- **Case 2 — in both.** Ideal; surface nothing.
- **Case 3 — in disclosure, NOT in PubMed.** Out of scope here (a failure-to-disclose-*to-journal*, not something the scholar fixes via WRG).

"Unmatched" means a named relationship extracted from the scholar's own PubMed COI statements that does **not** appear in their `CoiActivity` disclosed set.

Why it matters is settled empirically, not speculatively. The 2022 study (`Capstone Paper 4.0.pdf`) compared every WCM faculty `CoiStatement` (last 5 years) against WRG and found, over 1,096 statements from 237 faculty: 23% fully declared in WRG, 40% partial, **37% not declared at all**; per-faculty, 32% had at least one entirely undeclared PubMed conflict. Critically, the same project's 11-response questionnaire found non-disclosure is **overwhelmingly an awareness/UX gap, not concealment**: 9/11 believed they'd missed nothing, 6/9 of those thought their conflicts were "unnecessary" to report, and 3/11 didn't know the Conflicts Survey existed. The paper's own recommendation — "machine automatically recognizes the difference between PubMed and WRG, warning… annually by email" — is precisely the `/edit` nudge proposed here. WCM already publishes these COIs publicly on VIVO with a transparency preamble and per-category tooltips (`Conflicts - Changes - 2022-02-01.txt`), so the *posture* is established; what's new is the inference of the gap.

## What already exists vs what's greenfield

| Capability | Status | Where |
|---|---|---|
| PubMed `<CoiStatement>` parsed from EFetch XML | **Exists** | `ReCiter-PubMed-Retrieval-Tool/.../PubmedEFetchHandler.java:469,1133-1138` |
| COI text persisted per-PMID in DynamoDB | **Exists** | `PubMedArticle.medlinecitation.coiStatement` |
| Per-PMID COI table in ReciterDB | **Exists** | `ReciterDB/setup/createDatabaseTableReciterDb.sql:854-862` (`reporting_conflicts`), loaded by `update/conflictsImport.py` |
| SPS↔ReciterDB connection + per-PMID backfill pattern | **Exists** | `etl/reciter/backfill-abstracts.ts:33-71`; `lib/sources/reciterdb.ts:11-58` |
| Scholar↔PMID linkage | **Exists** | `prisma/schema.prisma:541-559` (`PublicationAuthor`, `pmid`+`cwid`+`isConfirmed`) |
| Per-paper target-author signal | **Exists (upstream only)** | `ReciterDB/.../populateAnalysisSummaryTables_v2.sql:186-190,335` (`analysis_summary_author_list.targetAuthor=1`) |
| Official disclosed COI ground truth | **Exists** | `CoiActivity` / `coi_activity` (`schema.prisma:981-1000`), loaded by `etl/coi/index.ts:47-83` from `v_coi_vivo_activity_group` |
| Read-only COI `/edit` panel + LockedBadge + request-a-change routing | **Exists** | `components/edit/coi-card.tsx:29-72`; `lib/coi-groups.ts` |
| Public VIVO/POPS 7-category rollup + tooltip copy | **Exists (reference)** | `Industry Relationships_VIVO_POPS 2.0.pptx` slide 2; `Conflicts - Changes - 2022-02-01.txt` |
| Ingestion of PubMed COI text **into SPS** | **Greenfield** | grep for `coiStatement`/`reporting_conflicts` across SPS returns zero hits |
| Per-author attribution, entity extraction/normalization, diff, confidence, panel | **Greenfield** | — |
| Persisted ReCiter identity score on `publication_author` | **Greenfield** | `isConfirmed` is hardcoded `true` (`etl/reciter/index.ts:419,450`); no score column exists |

## Proposed architecture

End-to-end pipeline, with the cleanest ingestion path that avoids any E-utilities re-fetch or ReCiter change:

1. **Ingest (clone of abstracts backfill).** Add `coiStatement String? @db.Text` + `coiStatementFetchedAt` to a per-PMID store, and write `etl/reciter/backfill-coi-statements.ts` as a near-verbatim clone of `backfill-abstracts.ts`, swapping the query to `SELECT pmid, conflictsVarchar FROM reporting_conflicts WHERE pmid IN (?) AND conflictsVarchar IS NOT NULL AND conflictsVarchar <> ''`. Reuse `withReciterConnection`. Read `conflictsVarchar` (already `CAST` to char), **not** the raw blob, to avoid driver Buffer decoding. **Prerequisite:** confirm `conflictsImport.py` is actually enabled in the WCM ReciterDB prod nightly — it is "optional"/present-file-gated — and inherits the known SPS→WCM VPC fragility (`reciterdb.ts` uses deliberate 2s/3s timeouts).
2. **Attribute** the paper-level blob to the scholar (the hard step — see confidence model). Use `analysis_summary_author_list` (`targetAuthor`, `authorFirstName/LastName`) + the existing `deriveInitials()` (`etl/reciter/index.ts:93-101`).
3. **Extract & normalize** entity strings from the scholar's clause. Normalize **both** sides (strip `Inc/LLC/Ltd/Pharmaceuticals`, trailing `(*)`, parenthetical parents, lowercase, fuzzy match) — the 2022 paper named entity-name drift as its #1 limitation. Reuse `canonicalizeSponsor` (`lib/sponsor-lookup.ts`) and a curated alias table modeled on `MeshCuratedAlias` (`schema.prisma:717-725`).
4. **Diff vs `CoiActivity`**, restricted to `activityRelatesTo='Self'` and recall-biased: when in doubt, treat as already-disclosed.
5. **Surface** Case-1 results on a self-only `/edit` panel.

**Proposed Prisma sketch** (per the SPS-seams investigator):

```prisma
model PublicationConflictStatement {   // per-PMID projection of reporting_conflicts
  pmid            Int      @id
  statementText   String   @db.Text
  source          String   @default("PubMed")
  lastRefreshedAt DateTime
}
```

A scholar↔entity candidate is the riskier artifact. The adversarial review is emphatic that **no persisted boolean "undisclosed" verdict** should exist and the set-difference should be computed at render time. The reconciling design: persist only **non-accusatory primitives** — `(cwid, pmid, extractedEntity, sourceSpan, extractionScore, attributionScore, paperMatchScore)` plus a human-controlled `status` (new/dismissed/acknowledged) on a separate Suppression-style row — and derive "unmatched" live by diffing against `CoiActivity` at request time. Also add nullable `publication_author.reciterIdentityScore` so the paper-match input is persisted rather than recomputed.

## The confidence model

This is the core deliverable, because the confidence indicator is the only thing standing between "helpful nudge" and "false accusation." Confidence is **multiplicative across four independent inputs**, then **rendered as a qualitative band, never a percentage** (a false-precision "87% yours" launders an error chain into spurious authority and invites meaningless faculty-vs-faculty comparisons):

**`confidence = paperMatch × authorAttribution × entityExtraction × normalizationMatch`**, surfaced only when the diff-gate fires (entity NOT in the scholar's `CoiActivity`).

1. **paperMatch — does this PMID belong to this scholar?** Today the strongest available signal is `analysis_summary_author_list.targetAuthor=1`, a hard belongs-to-scholar flag; `isConfirmed` on `publication_author` is hardcoded `true` and is *not* a real score. Ingest `targetAuthor` (and a numeric ReCiter article score *if* one survives into ReciterDB — **open question**) as `reciterIdentityScore`. Cap candidates to confirmed ReCiter authors.
2. **authorAttribution — is the named person in the clause *this* scholar?** The dominant structural failure mode, because `<CoiStatement>` is **one block for the whole paper** that concatenates per-author disclosures ("GN has no conflicts… MN has received consultant support from Pfizer…"; "JN Allan is a member of the Advisory Board for Pharmacyclics…" — real corpus rows). Score the match between the clause's name token and the scholar's PubMed initials/surname (via `deriveInitials` on `authorFirstName/LastName`) plus author position. **Boost** single-author papers and clean initials+surname matches; **penalize** "all authors," many-author papers, and shared/common initials.
3. **entityExtraction — was an org string correctly pulled from free text?** Require **span-grounding**: the extractor must return the verbatim substring, and the pipeline must **reject any entity not literally present in the source text** (mirrors the `seo:llm-rank` citation-grounding pattern). Prefer rules/NER; if an LLM assists, pin temperature 0 and post-hoc verify the substring — never send the confidential disclosed set out of the VPC, only the already-public PubMed text.
4. **normalizationMatch — did we correctly decide it's *not* in `CoiActivity`?** Tune for **recall on the disclosed set**: ambiguous → treat as disclosed (suppress). Surface what it matched (or didn't) against so the scholar sees the reasoning.

**Tiers and rendering:**

| Tier | Lands here when | Renders as |
|---|---|---|
| **High** ("Worth reviewing") | Confirmed ReCiter author **and** scholar's initials+surname cleanly bound to the clause naming the entity (ideally single-author or scholar-named statement) **and** entity span-verified **and** not normalization-matched to any disclosed entity | Amber chip + verbatim source sentence + "Review in WRG" link |
| **Medium** ("Possible match") | Belongs-signal present but attribution is soft (all-authors phrasing, or position-but-not-initials) | Neutral chip; shown only if above the suppression floor |
| **Low** | Entity present but scholar not name-matched, or shared common initials in a many-author list, or any input weak | **Suppressed — not shown at all** |

The non-negotiable rendering rule from the adversarial review: **always pair any shown item with its verbatim source sentence** so the human, not the number, adjudicates; never rank or sort faculty by score; suppress rather than show low confidence — a false "gap" costs more than a missed one.

## /edit UX

**Slot.** The `/edit` rail is a centralized registry (`components/edit/edit-page.tsx`). Add an 11th read-only attribute — proposed key `coi-gap` / label **"Relationships in Your Publications"** (deliberately *not* "Undisclosed Conflicts") — by extending the `AttrKey` union, `ATTRIBUTES` (`readonly:true`), `SELF_RAIL_ORDER` + `SELF_RAIL_KIND`, and a `renderPanel` case rendering a new `components/edit/coi-gap-card.tsx`. Place it directly **after** the existing `coi` item in the "From WCM systems" group so disclosed-COI and the publication-derived relationships read as siblings. Reuse `EditPanel` + `LockedBadge` + a per-row confidence chip. Load via a new `unmatchedPubmedCoi` array on `EditContext` (`lib/api/edit-context.ts`, mirroring the `coiDisclosures` loader). `/edit` is force-dynamic and must stay `no-store`, so the diff reads per-request.

**Mode: self-only.** Unlike the existing COI panel (modes `['self','superuser']`), this panel is gated to `mode==='self'` **with a server-side guard** (`effectiveCwid===targetCwid`), not mere UI hiding.

**Wording — suggest, never accuse.** Forbidden words: "undisclosed," "failed to disclose," "missing disclosure," "violation." Use temporal-neutral language because `CoiActivity` is a current snapshot with **no end-dates** and cannot distinguish never-disclosed from disclosed-then-ended:

> *"We noticed a relationship mentioned in one of your publications that we did not find in your current Weill Research Gateway disclosures. When in doubt, disclose! — you may want to review this in WRG."*
> *Source (PMID 31508198): "…Clinical Research investigator for Procept Aquablation and Neotract Urolift."*

Reuse the existing transparency-preamble framing and the VIVO/POPS 7-category vocabulary (Consultant; Advisory/Scientific Board Member; Ownership; Proprietary Interest; Speaker/Lecturer; Leadership Roles; Other Interest) so an extracted relationship is presented in WCM's own public terms.

**Action.** No in-app COI editing — SPS is **not** the COI system-of-record. Mirror the existing `coi` request-a-change routing to WRG / the Conflicts Management Office (`conflicts@med.cornell.edu`), plus a per-item **Dismiss / Not applicable** control the scholar owns, remembered so the same nudge doesn't recur. Scope `etl:coi`-style funder/grant-sponsor and employer-of-record sentences **out** (they have no WRG analog), and exclude family-member rows.

## Governance, privacy & visibility

**Visibility matrix — self-only by construction:**

| Viewer | Sees the gap? |
|---|---|
| Scholar (self) | **Yes** — the only authorized viewer |
| Superuser | **No** — explicitly excluded from the superuser surface |
| Curator / UnitAdmin (current or future) | **No** |
| Compliance / Faculty Affairs | **No** automated feed — see below |
| Public / search index / profile view | **Never** |

The disclosed set being public *in summary* does **not** make the *gap* shareable: the gap is a new inference, more sensitive than either input, that SPS has no governance mandate to hold institution-wide. A superuser-visible gap list would be a "shadow compliance dossier" — explicitly do not build it.

**Suggest-don't-accuse, and no auto-notify.** Do **not** generate any feed, report, or notification to the compliance office; that converts a self-service nudge into an automated allegation pipeline run by a system that is error-prone and not the COI system-of-record. Make "no compliance feed" an explicit **non-goal** in the SPEC. If Compliance later wants org-wide detection, that is a separate, Compliance-owned product with its own authorization, human-in-the-loop review, and appeals path.

**Confidentiality & persistence.** Compute the diff ephemerally for the self viewer; never persist a "verdict." If caching is needed, store only non-accusatory primitives (entity + PMID + span + scores) and derive the gap live. Never send the confidential disclosed set to a third-party LLM. Audit should be **minimal and self-protective**: log only the scholar's own dismiss/acknowledge action (self-scoped, like `scholars_audit`), never a "we accused you on date X" trail. Reproducibility (pinned source text + spans) is the audit substrate so a disputed flag can be re-derived.

## Risks & mitigations

| Risk | Sev | Likelihood | Mitigation |
|---|---|---|---|
| Algorithmic "failure-to-disclose" accusation against named faculty (defamation / liability) | **Critical** | High if asserted; Low if suggested | Suggestion-only copy; never persist a verdict; **Legal/Compliance/Faculty-Affairs sign-off on concept + exact copy as a hard gate** |
| Visibility/RBAC leak beyond the scholar | **Critical** | High (default would inherit COI panel's self+superuser visibility) | Self-only by construction; server-side `effectiveCwid===targetCwid` guard; never public/indexed |
| Paper-level blob mis-attributed to our scholar (co-author's conflict) | **High** | High (dominant structural failure) | Confirmed ReCiter authors only; initials+surname+position attribution gate; show verbatim source sentence; floor/exclude when scholar not name-matched |
| Funder/employer/below-threshold/disclosed-then-ended/family-member false gaps | **High** | High | Classify relationship type (exclude funder/employer clauses); `activityRelatesTo='Self'` only; neutral temporal wording ("not currently in your disclosures"); per-item dismiss |
| LLM entity-extraction hallucination / non-determinism | **High** | Medium (High if free-form) | Span-grounding: reject any entity not literally in source; prefer rules/NER; temperature 0; snapshot source+spans |
| Mixing confidential WRG data with public PubMed into a new sensitive artifact | **High** | Medium | Compute ephemerally; only public PubMed text leaves VPC; data-classification note + owner sign-off in the ADR |
| Auto-notify / feed to Compliance (over-reach) | **High** | Medium | Explicit non-goal; surface-and-suggest to scholar only; route via existing WRG request-a-change |
| Entity-name variant phantom gaps (Pfizer Inc vs Pfizer) | **Medium** | High | Canonicalize both sides (`canonicalizeSponsor` + auditable alias table like `mesh_curated_alias`); recall-biased toward "disclosed" |
| Confidence indicator gives false precision | **Medium** | Medium | Qualitative bands only; never a percentage; never rank faculty; pair with source sentence |
| Negation / "No competing interests" boilerplate treated as signal (~68% of rows) | **Medium** | High if naive | Drop pure-negation statements; clause-scope entities; discard entities under "declare none"; unit-test against real statement-shape fixtures; verify corpus non-empty before any counts |
| Audit/repudiation gap | **Medium** | Medium | Self-scoped dismiss/acknowledge log only; reproducible spans as substrate; no enforcement trail |
| Stale official baseline → drift | **Medium** | Medium | Tie diff to a defined `CoiActivity` refresh cadence; neutral temporal wording absorbs snapshot limits |
| Coverage skew (PubMed COI ~2017+, partial fill) makes absence non-informative | **Medium** | High | Panel copy: "based on N publications with parseable disclosure text"; never imply completeness |
| Blob/encoding edge cases (15000-char truncation, BLOB→varchar) | **Low** | Low | Read `conflictsVarchar` (already CAST), not raw blob |
| Flag-parity (local-on/deployed-off silent no-ship) | **Low** | Low | Add the new `SELF_EDIT_*` flag to `cdk/lib/app-stack.ts` per-env, not just `.env.local` |

## Open questions & decisions needed from the user

1. **Concept + copy sign-off:** Will Faculty Affairs / Compliance / General Counsel approve a scholar-visible "relationship in your publications you may want to review in WRG" surface, and approve the exact wording? *(This is the gating decision — everything else is downstream.)*
2. **Audience/owner:** Is this strictly a self-service scholar nudge (recommended), or is there appetite for a later, separately-governed compliance product? Confirm self-only for v1.
3. **Source granularity:** Is the live source the discrete `<CoiStatement>` XML element (clean) or scraped abstract text? (Findings indicate the element is parsed upstream — confirm `reporting_conflicts` carries it cleanly, not re-parsed abstracts.)
4. **ReCiter numeric score:** Does any `analysis_summary_*` column expose a numeric ReCiter identity/article score, or only the boolean `targetAuthor`? Determines how granular `paperMatch` can be.
5. **Official-side refresh:** What is the going-forward refresh cadence/source-of-record for `CoiActivity`? A frozen baseline drifts into false positives.
6. **Coverage reality check:** Is `conflictsImport.py` actually enabled in the WCM prod nightly, and how many non-null `reporting_conflicts` rows exist for the WCM corpus today? (Needs a direct row-count probe once VPC connectivity allows — do not estimate.)
7. **Extraction approach:** Deterministic regex/dictionary, span-grounded LLM-assist, or hybrid? (Drives `extractionScore` and the LLM-egress governance question.)
8. **Family + threshold scope:** Confirm exclusion of `activityRelatesTo≠Self` and below-threshold relationships from the diff.

## Phased recommendation

**Phase 0 — Offline precision study (no UI, no flag).** Backfill `reporting_conflicts` into a scratch SPS table for a representative faculty sample, run attribution + extraction + diff offline, and have a human (ideally with the 2022 author's involvement) label a few hundred candidates as true Case-1 vs false (co-author mis-attribution, funder/employer, entity-variant, family, ended). *Validate the fetched corpus is non-empty before computing any statistic* (known repo footgun). **Exit gate:** measured precision on the High tier is high enough that the verbatim-source-sentence UX would not embarrass the institution, AND Faculty Affairs/Compliance/General Counsel have signed off on concept + copy. Do not proceed without both.

**Phase 1 — Self-only, behind a dormant flag.** Ship `PublicationConflictStatement` ingestion + the `coi-gap` self-only panel + span-grounded extraction + recall-biased normalization + per-item dismiss, gated behind `SELF_EDIT_COI_GAP_HINT=off` and wired per-env in `cdk/lib/app-stack.ts`. Ephemeral diff; no persisted verdict; suggestion copy only; self-scoped dismiss audit. **Exit gate:** a real-scholar pilot (a handful of consenting faculty) confirms the framing reads as helpful-not-accusatory and the High-tier candidates they review are genuinely theirs.

**Phase 2 — Routing & durability (NOT auto-notification).** Wire the per-item action to the existing WRG / Conflicts-Management-Office request-a-change flow and persist scholar dismiss/acknowledge state durably. **Explicitly NOT** a compliance feed, NOT superuser/curator visibility, NOT a faculty-ranking report. **Exit gate:** Conflicts Management Office confirms the self-service routing matches their intake, and a data-governance note (data classification + retention + access) is approved. Any org-wide detection remains a separate, Compliance-owned product out of scope for `/edit`.

## Design update — persisted candidates via a daily incremental ETL

Implementation note (supersedes the "ephemeral diff" framing above where they conflict): the gap detection runs as a **daily background ETL** (`etl:coi-gap`) that persists candidates in `coi_gap_candidate`, rather than recomputing the whole diff on every request. This was a deliberate change for three reasons: (1) **incremental** — the job only reprocesses scholars whose statements / disclosures / author-links changed since the last successful run, so there is no full re-retrieval; (2) **disavow** — a scholar can dismiss a bad match and that dismissal is durable, so the same nudge is never shown twice; (3) **tracking** — each gap carries a lifecycle (`new → acknowledged / dismissed / resolved`) instead of reappearing from scratch.

This does **not** cross the "never persist a verdict" line. What is persisted is a **candidate plus the scholar's own review status**, not an accusation: there is no `undisclosed` boolean, no ranking, no compliance-facing column, and the rows are surfaced **only to the scholar themselves** (self-only at render). A newly-disclosed entity auto-resolves its candidate on the next run (the job re-diffs against the current `coi_activity`), so the persisted set is self-healing and reflects the live disclosure state. The job reads only SPS-DB tables, so — unlike the statement ingestion — it is **not** ReciterDB-VPC-blocked. The scholar-facing **disavow action and the panel remain gated** behind the flag + Faculty-Affairs/Compliance/Counsel sign-off; the ETL + table are dormant backend infrastructure until then.
