# Core-usage inference — pipeline spec (engine in ReciterAI, claim UI in SPS)

Draft v0.1 — 2026-06-19. Grounded in the head-to-head pilot + non-circular validation (`HEAD-TO-HEAD-REPORT.md`).

## What the validation forces on the design
Text alone can't establish core usage at scale: acknowledgement match is ~100% precision but <1% recall in the wild; abstract-LLM identifies imaging *topic* but can't tell a WCM-core scan from an external one. So the engine is **multi-signal candidate-generation feeding a human claim**, with deterministic non-text signals doing the heavy lifting for recall.

## Signal layers (priority order)

| # | Signal | Type | Role | Source |
|---|---|---|---|---|
| 1 | **Service-owner customer roster** (CWIDs of known users) | deterministic prior | primary recall | web form / spreadsheet upload by core owners |
| 2 | **Core-staff co-authorship** (staff CWID in author list) | deterministic | high-precision recall | per-core personnel roster × ReCiterDB authorship |
| 3 | **Acknowledgement / alias name-match** in full text | deterministic | high-precision confirmer | PMC OA + author-manuscript full text |
| 4 | **LLM abstract score** (1–10) | probabilistic | triage/ranking only | Bedrock over ReCiterDB title+abstract |
| 5 | **Human claim** by core-owner role | authoritative | source of truth | SPS UI |

Combine into a per-(publication × core) record with a `likelihood` and the contributing signals. **Auto-confirm** only on signal 3 (named core) or 5 (human claim). Signals 1/2/4 set a likelihood and route to the claim queue — they never auto-label.

### Signal 2 — use RESOLVED authorship, never name matching
Source: `reciterdb.analysis_summary_author_list` (pmid, authorLastName/FirstName, rank, **`personIdentifier`** = resolved CWID per author row) — mirrored into the SPS DB by the reciter ETL. Match on `personIdentifier`, never on name strings.

Validated on the 237-paper pilot: co-authorship by the 4 active CBIC staff (Ballon `djb2001`, Dyke `jpd2001`, Shungu `dcs7001`, Bin He `bih2006`) covers **39% of true imaging papers at 100% precision** (0/100 negatives) — the single best scalable recall lever found.

**The 39% is capped by an upstream gap, not a matching technique.** Voss `hev2006`, Babich `job2060`, Foley `cof2003` exist in `identity` but are **not ReCiter target persons**, so ReCiter never resolves their authorships — their rows carry `personIdentifier = null` (confirmed on pmid 21724116, where Voss is null while co-authors resolve). The lever to raise recall is **adding them to ReCiter's identity/target feed**, after which their pubs resolve automatically. Do **not** surname-match: there are 511 resolved "Voss" rows and none is `hev2006` — they're Martin Henner Voss `mhv9001` (oncology); string matching would mis-attribute his papers to the imaging core.

### Repeat-user prior (per Paul) — model signal 1 at the *author* level
Core users are overwhelmingly **repeat users**: once a CWID is confirmed (claim) or strongly implied (acknowledgement/co-authorship) to have used a core, **all of that author's other publications get a likelihood boost**, past and future. So signal 1 isn't only an uploaded roster — it's a *derived, compounding* prior: `confirmed(cwid, core)` → prior on every `(pub, core)` where that cwid is an author. This is why the claim layer bootstraps so well (one confirmation lights up an author's whole corpus, e.g. Ballon's 102 / Dyke's 181 pubs) and why even a partial roster is high-value. Implement as an author×core affinity score that combines confirmed claims + acknowledgement history + co-authorship, decayed lightly over time.

## Engine → ReciterAI (Python / Bedrock, batch) — confirmed
Lives beside existing publication scoring; outputs to S3 + DynamoDB exactly like ReciterAI's other jobs. Decisive reason: ReciterAI **already** publishes `publication→topic` to DynamoDB that SPS consumes via `etl/dynamodb/publication-topic-mapper.ts`. Cores inference is the identical shape (publication→core), so it reuses that publish/ingest path end-to-end. Same engine→ReciterAI / UI→SPS split already chosen for GrantRecs — keeps one consistent pattern, avoids putting heavy Bedrock batch work inside the Next.js app.

```
pipeline_cores/
  core_dictionary.yaml         # the IP: per-core aliases, grant IDs, staff CWIDs, owner
  customer_rosters/            # service-owner-provided CWID lists (ingested)
  s1_roster_match.py           # CWID roster -> candidate (pub,core)
  s2_coauthor_match.py         # staff CWID in authorship -> candidate
  s3_ack_match.py              # PMC full text alias/CBIC match -> confirmed
  s4_llm_score.py              # Bedrock 1-10 over title+abstract -> rank
  combine.py                   # merge signals -> per (pub,core) likelihood + provenance
  publish.py                   # -> S3 + DynamoDB table  PublicationCoreUsage
```

Run nightly alongside the ReciterDB ETL refresh. Full-text fetch (PMC) cached; only new PMIDs fetched.

### Output record (DynamoDB `PublicationCoreUsage`)
```
pmid, coreId, likelihood(0-1), status(candidate|confirmed|claimed|rejected),
signals:{roster:bool, coauthor:[cwid], ack:{matched:bool, snippet}, llm:int},
claimedBy(cwid?), claimedAt?, updatedAt
```

## Claim UI → Scholars-Profile-System (confirmed — strong existing-machinery fit)
SPS turns out to already have every piece this needs, so cores slot in as a direct parallel to topics:

- **Ingestion is a copy of an existing path.** ReciterAI already publishes `publication→topic` to DynamoDB and SPS ingests it via `etl/dynamodb/publication-topic-mapper.ts` → MySQL → the public **methods** taxonomy (`app/(public)/methods/[supercategory]/[family]`). Cores inference outputs `publication→core` the same way; add `etl/dynamodb/publication-core-mapper.ts` alongside it. (This is also why the engine belongs in ReciterAI — see below.)
- **Claims use the ADR-005 manual-override layer, not a new writer.** SPS runtime is read-only over MySQL (ADR-001); the *only* sanctioned human-write path is the ADR-005 override layer, built precisely so human-entered data survives the nightly ETL rebuild (same mechanism as suppression / slug-override / self-edit). A core-owner **claim/reject is exactly an override record** taking read-time precedence over the ETL-projected candidate. No new write architecture required.
- **"Core owner" is a new unit-scoped role** in the existing RBAC model (Superuser / Unit Owner / Unit Curator / Proxy editor, as `unit_admin`-style data-derived rows). A core is a center-like org unit; the owner reviews/claims within their core's scope — the same "edit within owned subtree" pattern already implemented.
- **Per-core review queue**: ETL-projected candidates ranked by likelihood, evidence (ack snippet, co-author, LLM score) shown inline; one-click confirm/reject writes an override = signal 5.
- **Profile/methods surface**: confirmed cores display next to research areas ("Cores used: Biomedical Imaging").
- **Resolved:** UI → SPS (not PM). SPS has the override+RBAC+topic-ingestion machinery; PM's curation is authorship-acceptance, a different domain. If PM ever needs to show cores, it reads the same store.

## Core dictionary — schema + Biomedical Imaging seed (evidence-grounded)
```yaml
- coreId: 2
  name: Biomedical Imaging
  owner_cwid: <tbd>
  aliases:                      # for signal 3 (full-text match) — observed in pilot
    - "Citigroup Biomedical Imaging Center"   # canonical (157/157 hits)
    - "Citigroup Biomedical Imaging Core Facility"
    - "CBIC"                                   # acronym; require word-boundary
    - "Biomedical Imaging Core Facility"
  staff_cwids:                  # for signal 2 — recurring CBIC authors in pilot acks
    # names to resolve to CWIDs via ReCiterDB: Henning U. Voss, Douglas J. Ballon,
    # Jonathan P. Dyke, Dikoma C. Shungu, Bin He, John W. Babich, Conor P. Foley
    - <resolve>
  grant_ids: []                 # NONE — validation showed no shared core grant (don't use)
  llm_description: >
    multimodal imaging research; advanced MRI/MRS, PET/CT, MicroPET/SPECT/CT,
    optical imaging, ultrasound, cyclotron, radiochemistry for radiotracer synthesis
```
Per-core dictionary entries are the project's real IP. The 13 cores from `Core inference prompt 0.txt` are the starting list; each needs its aliases + staff CWIDs + an owner. **The Imaging entry is done** — staff resolved to CWIDs against ReCiterDB `identity` (see `core_dictionary_imaging_seed.yaml`).

## Build order (recommended)
1. **Dictionary + roster ingestion** (signals 1–2) — highest recall, no LLM cost. Wire the service-owner CWID web form first.
2. **Acknowledgement matcher** (signal 3) — cheap confirmer; reuse `match_deterministic.py`.
3. **LLM triage** (signal 4) — Bedrock batch; only to rank the queue.
4. **SPS claim queue + profile surface** (signal 5).
5. New tables in **prod reciterDB, dev reciterDB, AND the ReCiterDB repo schema** (per standing rule).

## Cold-start: no customer rosters yet (the claim layer bootstraps them)
Service owners don't maintain customer CWID lists today (per Paul). Implication: signal 1 starts empty, so initial **recall leans on co-authorship (signal 2) + LLM triage (signal 4) + owner review (signal 5)**. That's workable because true usage per core is small (the imaging core is maybe a few hundred papers), so an LLM-ranked queue is humanly reviewable.

Key design consequence: **every confirmed claim IS a customer record.** The ADR-005 claim layer accumulates `(cwid, core)` pairs as owners curate — so the system *generates* the customer roster as a byproduct, and each subsequent run uses it as a signal-1 prior. Build the roster *ingestion path* (form/spreadsheet) for when owners do have lists, but don't block on it — the claim workflow is the bootstrap.

## Open decisions for Paul
- ~~Claim UI home~~ → **SPS** (resolved; ADR-005 override + RBAC + topic-ingestion fit).
- Define the **core-owner role** grant model (who designates a core's owner — Superuser-granted `unit_admin`-style row).
- Which cores to pilot beyond Imaging — suggest one low-abstract-visibility core (e.g. Biorepository) to confirm LLM triage degrades gracefully where methods aren't in the abstract.
