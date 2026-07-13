# Sponsor-match evidence (#1689) — handoff

Date: 2026-07-13

## ✅ RESOLVED — #1691 merged (`fe31e65c`) and PROVEN on staging. Nothing here is open.

This doc was written mid-flight, while #1691 was still an open PR. It is kept for the two lessons
in §2 and the probe recipe in §3; the "merge it, then prove it" instruction below is **done**.

Verified on the post-merge image (ECR `latest` also carries the tag `fe31e65c…`), in-VPC against
real staging OpenSearch:

| check | before | after |
|---|---|---|
| shipped spine, driven end-to-end (`candidates[].searchEvidence.evidence`) | 0 | **324 / 324** |
| emitter: hits carrying `evidenceLines` | 0 of 160 | **160 / 160** |
| emitter: hits carrying legacy `evidence` | 0 of 160 | **0 / 160** (as diagnosed) |

**Two traps found while running the probe itself — read these before reusing §3:**

- **The §3 probe below re-implements the read (`evidenceLines?.[0] ?? h.evidence`) inline, so it
  only tests the EMITTER, not the shipped consumer.** It would go green even if the spine still
  read the wrong field. To actually test the fix, drive the real entry point
  (`rankResearchersForDescriptionSpine`) and count `candidates[].searchEvidence.evidence`. A probe
  that re-implements the read under test is just a mock you wrote in bash — the same trap as §2b,
  one level out.
- **A zero can mean "never ran".** In-VPC the ETL task role gets Bedrock **403**, so the spine falls
  back to its dictionary extractor, which matches **only taxonomy labels** (`Topic.label` +
  `Subtopic.label`). A hand-written sponsor paste extracts *nothing*, the spine short-circuits at
  `extracted.length === 0`, and you get `CANDIDATES=0` — indistinguishable from a failed fix. Build
  the probe's paste out of real vocab labels (query them first), and assert concepts > 0 before
  trusting any downstream count.

## 1. ~~THE OPEN ITEM~~ — DONE: merged #1691, then proved it with the probe

**Do not close this out on a green suite.** That is exactly what went wrong once already today.

1. ~~`gh pr checks 1691` → both green → `gh pr merge 1691 --squash`~~ — merged, `fe31e65c`.
2. ~~Wait for the staging deploy~~ — run `29281087148`, success in 12m28s.
3. ~~Run the probe in §3~~ — ran, with the two corrections above. **324/324 candidates carry
   evidence; 160/160 hits carry `evidenceLines`, 0/160 carry `evidence`.**
4. ~~If it is still 0…~~ — it is not.

## 2. What went wrong, twice — both worth internalising

### 2a. A code comment asserted a mechanism, and it was false

Two comments (`sponsor-match-spine-run.ts`, and the contract's `SponsorEvidence` doc) said the
spine could not produce evidence *"because it runs `skipFacetAggs`"*, and that closing the gap
needed *"the match-explain aggregation the spine deliberately skips"*.

**Both false.** `skipFacetAggs` is read at exactly one place and gates exactly one thing — the
nine People-index **facet** aggs. It appears nowhere in `reasonAggEligible`, which is
`matchExplain && contentQuery.length > 0 && …`. The spine produced no evidence because **it
never passed `matchExplain`, which defaults to false. It never asked.**

This was not harmless. Acting on the stated cause meant *dropping* `skipFacetAggs`, which would
have re-armed the size-200 `deptDivKey` agg on every fan-out call, **re-tripped the OpenSearch
parent breaker #1671 fixed, and still produced no evidence.** I also propagated the false cause
into issue #1689 when I filed it. Both comments are corrected on master; the issue has a
correction comment.

### 2b. A mock cannot tell you what the real dependency emits

`searchPeople` emits **either** `evidenceLines[]` **or** `evidence` — and which one is a **flag
decision**, not a property of the data:

```ts
return reasonCountsStacked
  ? { evidenceLines: selectEvidenceLines(evInput) }   // and NEVER `evidence`
  : { evidence: selectEvidence(evInput) };
```

`reasonCountsStacked = SEARCH_RESULT_EVIDENCE && SEARCH_EVIDENCE_REASON_COUNTS`, and **both are
`on` in staging and prod.** #1690 read `h.evidence` — the one field guaranteed to be empty in
exactly the environments that matter.

**Every test passed**, because the spine tests mock `searchPeople` and hand it whichever shape
the test author imagined. The suite can only confirm you are consistent with your own
assumption. The suite said yes; staging said **0 of 160**.

The standing lesson, and it generalises well beyond this file: **when a change depends on the
shape another module emits, verify against the real emitter, not a mock.** One in-VPC probe
found in 4 seconds what 7,160 tests could not.

## 3. THE PROBE — the check that can fail

Runs the real deployed `searchPeople` with the exact options the spine passes, against real
staging OpenSearch. Bedrock is unreachable from the ETL role, so concepts are supplied directly
— the retrieval path under test is identical.

The script is in the session scratchpad; recreate it as `probe.sh`:

```ts
cd /app && npx tsx -e '
import { searchPeople } from "@/lib/api/search";
import { matchQueryToTaxonomy } from "@/lib/api/search-taxonomy";
const CONCEPTS = ["systemic sclerosis","pulmonary fibrosis","myofibroblast",
  "interstitial lung disease","cardiac fibrosis","immunotherapy","cystic fibrosis",
  "multiple sclerosis"];
(async () => {
  const t0 = Date.now(); let withEvidence = 0, hits = 0, sample = "";
  for (const term of CONCEPTS) {
    const rep = (await matchQueryToTaxonomy(term)).meshResolution;
    const r = await searchPeople({
      q: term, page: 0, shape: "topic", relevanceMode: "v3",
      meshDescendantUis: rep?.descendantUis?.length ? rep.descendantUis : undefined,
      meshDescriptorName: rep?.name,
      facultyProminence: false, grantProminence: false,
      matchExplain: true, reasonFromDoc: true, meshDescriptorUi: rep?.descriptorUi,
      filters: { includeIncomplete: undefined }, skipFacetAggs: true,
    } as any);
    hits += r.hits.length;
    for (const h of r.hits as any[]) {
      const ev = h.evidenceLines?.[0] ?? h.evidence;   // <- read BOTH shapes
      if (ev) { withEvidence++; if (!sample) sample = JSON.stringify(ev).slice(0, 160); }
    }
  }
  console.log("ELAPSED_MS=" + (Date.now() - t0));
  console.log("HITS=" + hits);
  console.log("HITS_WITH_EVIDENCE=" + withEvidence);
  console.log("SAMPLE=" + (sample || "(none)"));
})();
'
```

Run it in-VPC (the ETL task def has **no** `SEARCH_*` flags, so they must be injected as
container-override env, or evidence is suppressed for a reason that has nothing to do with the
code):

```bash
aws ecs run-task --cluster sps-cluster-staging \
  --task-definition sps-etl-staging:21 --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[<two private subnets>],securityGroups=[<etl sg>],assignPublicIp=DISABLED}' \
  --overrides '{"containerOverrides":[{"name":"etl","command":["sh","-c","<probe>"],
    "environment":[
      {"name":"SEARCH_RESULT_EVIDENCE","value":"on"},
      {"name":"SEARCH_EVIDENCE_ROWS","value":"on"},
      {"name":"SEARCH_EVIDENCE_REASON_COUNTS","value":"on"},
      {"name":"SEARCH_PEOPLE_MATCH_EXPLAIN","value":"on"},
      {"name":"SEARCH_PEOPLE_REASON_FROM_DOC","value":"on"},
      {"name":"SEARCH_PEOPLE_SNIPPET_REPRESENTATIVE_PUB","value":"off"},
      {"name":"SEARCH_PEOPLE_MATCH_AWARE_SNIPPET","value":"on"}]}]}'
# then: aws logs get-log-events --log-group-name /aws/ecs/sps-etl-staging \
#         --log-stream-name "etl/etl/<taskId>"
```

Subnet/SG values: take them from the running app service's `networkConfiguration` (do not paste
them into the public repo — see the redaction rule).

**Last result (against #1690, i.e. the broken read):** 8/8 concepts resolved a MeSH descriptor,
`HITS=160`, **`HITS_WITH_EVIDENCE=0`**, `ELAPSED_MS=3737`.

## 4. Flag reality (verified on the live task defs, 2026-07-13)

On the **app** container (`sps-app-staging:125`) — where the route actually runs:

| flag | value |
|---|---|
| `SEARCH_RESULT_EVIDENCE` | **on** |
| `SEARCH_EVIDENCE_ROWS` | **on** |
| `SEARCH_EVIDENCE_REASON_COUNTS` | **on** ⇒ emits `evidenceLines`, **never** `evidence` |
| `SEARCH_PEOPLE_MATCH_EXPLAIN` | **on** |
| `SEARCH_PEOPLE_REASON_FROM_DOC` | **on** (the cheap O(1) doc-sourced count) |
| `SEARCH_PEOPLE_SNIPPET_REPRESENTATIVE_PUB` | **off** (the expensive `top_hits`; leave it off) |
| `SPONSOR_MATCH` / `SPONSOR_MATCH_SPINE` | **on / on** |

**No new flag and no cdk deploy are needed for any of this.** The ETL container carries **zero**
`SEARCH_*` flags — which is why the probe must inject them.

## 5. Cost — measured, and it is fine

The one bit of genuinely new load is a **mention-only** agg for candidates whose tagged count is
zero (`contentShape && zeroTaggedCwids.length > 0`). No tagged filter, no `top_hits`, only the
zero-tagged subset, and cached.

**The bounding argument:** after this change a spine call runs the reason path **and still skips
the nine facet aggs**. A public people-search call runs the same reason path **plus** those nine.
So **a spine call is strictly lighter than one public people-search call**, which staging and
prod already serve continuously.

Measured on staging: 8 sequential concept people-searches (each heavier than a post-change spine
call) → **8/8 → 200, 13s**, breaker alarm `sps-opensearch-breaker-staging` **OK, unchanged since
07-12 (no trip)**, JVM peaks 67–69% falling to 24% — the documented GC sawtooth against a 95%
breaker. The in-VPC spine-shaped probe itself: **3.7s for 8 concepts.**

A test asserts `skipFacetAggs: true` **alongside** the new options, precisely so the breaker
guard cannot be quietly traded away for evidence later.

## 6. What the feature does, once #1691 lands

- The spine passes three options on a call it already makes: `matchExplain: true`,
  `reasonFromDoc: true`, `meshDescriptorUi: rep?.descriptorUi` (already in hand for the
  attribution boost).
- `SponsorCandidate.searchEvidence` carries the search's **own** `ResultEvidence`, and the panel
  renders it with the public People card's **own** `<EvidenceLine>`. Same reason line ("142 of
  210 publications tagged Systemic Sclerosis"), same lazy representative-papers disclosure via
  the existing `/api/search/key-paper` — which costs nothing for the ~700 candidates nobody
  expands. Two surfaces answering "why did this scholar match?" through **one renderer** is the
  point: it is the only way they cannot come to disagree.
- Evidence is taken from the concept the candidate **ranked best under**, not whichever cluster
  retrieved them first (`hitByCwid` is first-wins — fine for a name, wrong for a caption).
- Absent stays absent: a cluster resolving to no MeSH descriptor (e.g. "cardiac fibrosis" in the
  probe above) cannot produce a tagged count, and such a candidate carries no `searchEvidence`
  rather than a zeroed one.

## 7. Ranking is untouched

Aggregations never affect hits, scoring or order. The topical baseline still stands — staging,
2026-07-13, commit `181042b5`: **meanNDCG@20 = 0.726, meanρ = 0.544, coverage 573/637.** No eval
re-run is required for any of this work.

## 8. Also still open (from the earlier session, unrelated to evidence)

- **§6e copy-emails is a POLICY NO-GO**, not a deferral — `docs/email-visibility-spec.md` forbids
  bulk email download "even for internal users" (cap 50; the sponsor pool is up to 800), the
  visibility filter **fails open** when the gate is off (and it is off in prod), and prod's
  `email_visibility` backfill has never run. The **contact log** half is unblocked and needs
  nobody's email.
- **§4 preference-bearing gold set** — still the only way to score λ, and still a human judgment
  call. But #1688 now retains real sponsor pastes (`SponsorMatchSubmission`), so the corpus that
  was missing is finally accumulating.
