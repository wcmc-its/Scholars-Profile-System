# Matcha: concept-canonicalization vs. the sponsor's literal phrasing (gloss-query) — exploration handoff

Written 2026-07-19. Prompted by a live observation: an ask that says **"cognitive decline"** is
extracted as the concept **"cognitive dysfunction"** (the MeSH-preferred term), and those two return
materially different people. This doc captures what the pipeline already does, why it is a
measurement question rather than a build, and how to explore it to a prod decision.

## The observation

On the public Scholars search, the same query resolves three ways (the `match` scope):

| Scope (`?match=`) | What it searches | Scholars | Top people (illustrative) |
|---|---|---|---|
| `concept` | MeSH **Cognitive Dysfunction** concept only | 242 | Gloria Chiang (Radiology/imaging) |
| `exact` | the literal words "cognitive decline" | 99 | Walter Boot, Neil Charness (Psychology) |
| `word+concepts` (default) | both | — | union |

So "cognitive decline" (the sponsor's words) and "Cognitive Dysfunction" (the MeSH concept) are
**not synonyms in retrieval** — different populations, different counts. Canonicalizing to the MeSH
concept for the Matcha rail is correct for the concept axis, but on its own it **discards the
literal-phrase signal**.

## A/B RESULT 2026-07-19 — gloss-query LOSES on every metric. The retrieval half was DELETED.

The A/B ran (vehicle below). Three arms, one shared extraction, 15 fixtures, **0 unmeasured**:

| Arm | mean nDCG@20 | mean ρ | coverage | candidates returned |
|---|---|---|---|---|
| **off** (prod today) | **0.613** | **0.404** | **260/270** | 5,834 |
| substitute (staging today) | 0.434 | 0.210 | 237/270 | 5,019 |
| append (the proposed fix) | 0.535 | 0.264 | 242/270 | 4,770 |

**The flag's premise is backwards.** This doc assumed gloss-query ADDS recall and asked whether the
extra recall is noisy ("does it retrieve MORE of the judged-relevant people?"). It retrieves
**fewer** — fewer candidates overall, and fewer of the known-relevant people. Of 238 judged-relevant
scholars, the append arm **loses 15 that `off` retrieved and gains 1**. A long prose gloss is a
*narrowing* BM25 query, not a broadening one.

That 15:1 number is the one to trust. It is **immune to the gold's staleness**: a judged-relevant
person that `off` returned and a gloss arm did not is a real recall loss no matter what the gold
does or does not contain about newly-surfaced people.

`substitute` scores **0.000** on `cardiovascular-broad` — a total collapse, the term-loss pathology
in pure form.

**The append fix is a real improvement over substitute** (better on 13 of 15 fixtures, +0.101 mean
nDCG, +5 coverage) but does **not** reach parity with `off` (−0.078 nDCG, −18 coverage). It
mitigates the substitution bug; it does not rescue the feature.

**Decision taken: DELETE the retrieval half** (this doc's **Option C**, now measured rather than
assumed). Retrieval always uses the bare member tokens; the gloss stays on the wire for the rail's
provenance `ⓘ`, which is where the sponsor's words actually earn their keep. Shipped as:

1. `lib/api/matcha-spine-run.ts` — `clusterQuery` is unconditionally `cluster.members.join(" ")`;
   the flag read and both gloss compositions are gone.
2. `cdk/lib/app-stack.ts` — `MATCHA_GLOSS_QUERY` removed, snapshot regenerated. This also turns
   staging off by construction: merging to master redeploys staging, and the code no longer reads
   the variable even while the old task def still carries it.
3. The test that asserted the flag's behaviour became a regression guard that the gloss must NEVER
   reach the query.

The append fix is NOT kept. It was strictly better than the substitute behaviour staging ran, but
it still lost to plain bare tokens, so with the flag gone there is nothing for it to improve.

Parking it dark was considered and rejected: a flag with a measured "no" attached is exactly the
kind of dead option that accumulates. The measurement is preserved here and in the spine's own
comment, so the decision is recoverable without the code.

**What this does NOT settle.** All 15 fixtures use MeSH-canonical phrasing. The motivating case —
a *divergent* lay-phrased ask like "cognitive decline" → Cognitive Dysfunction — is precisely the
case this gold cannot grade, because it contains no such fixture. Gloss-query is measured a loser
on canonical asks; on divergent asks it is **unmeasured**. Eight divergent pastes are drafted
(`spine-eval-divergent-pastes.json`) but have no judged gold. Deciding that case needs new
fixtures graded through `sponsor-evidence.sh` → `sponsor-judge.workflow.js` → `sponsor-merge-union.sh`.

Secondary caveat: the gold's candidate pools came from bare-term search (`sponsor-candidates.sh`),
so people surfaced ONLY by gloss retrieval were never judged, which biases nDCG against the gloss
arms. The pool-size shrinkage and the 15:1 judged-relevant loss are not explained by that bias.

### The vehicle (built, working, reusable)

`scripts/search-eval/spine-eval-{extract,run,dispatch,selftest}.ts|sh`. Extraction runs on the laptop
(Bedrock) and retrieval runs in-VPC on a one-off `sps-etl-staging` task (OpenSearch), because
neither environment has both. The in-VPC side seeds the `#1800` extractor memo
(`matcha:extract:<modelId>:<sha256>`) so `rankResearchersForDescriptionSpine` runs **unmodified** —
every MeSH argument it passes to `searchPeople` stays real, which a hand-rolled retrieval harness
would silently drop. One shared extraction across arms cancels extractor noise within each pair.

All three arms ran on a **stock image**, which is what made this cheap: the then-deployed spine
composed the ON query as `glossByTerm.get(m) ?? m`, so seeding a doctored gloss of
`"<term> <gloss>"` made that same substituting code emit the appended query. No image build, no
cdk, no flag flip. (That specific trick died with the flag; the reusable part is the memo seeding
plus the dispatch, which is why the scripts are now named `spine-eval-*` and take an `ARMS` list.)

A missed seed does not throw — it fail-softs to the v1 dictionary extractor and would produce a
plausible ranking off the wrong terms. So `spine-eval-selftest.ts` proves the key derivation offline,
and the runner marks any fixture whose returned concepts do not trace to seeded terms as
UNMEASURED. This run: 0 unmeasured across all three arms.

## MEASURED 2026-07-19 — the ON arm SUBSTITUTES the gloss, it does not add it

Everything below this section was written before the flag's behaviour was measured. Two of its
load-bearing claims turned out to be wrong. Read this first.

**The gloss REPLACED the concept token in the free-text query — it was never searched "in tandem".**
The composition was `cluster.members.map((m) => glossByTerm.get(m) ?? m)` — `??`, so a glossed
member contributed its gloss *instead of* its token. Measured with the real Sonnet extractor over
the 15 sponsor fixtures (179 concepts) plus 8 purpose-written lay-phrased asks (45 concepts):

| Corpus | Concepts | Glossed | Lose EVERY own token |
|---|---|---|---|
| The 15 existing fixtures | 179 | 158 (88.3%) | 97 (61.4% of glossed) |
| 8 new lay-phrased asks | 45 | 41 (91.1%) | 25 (61.0% of glossed) |

Concretely: `cancer metabolism` → `metabolic reprogramming to fuel growth, survive stress, and
evade immune clearance`; `immune checkpoint blockade` → `mechanistic and translational
understanding in solid tumors, resistance and relapse`. The BM25 axis stopped searching the
concept.

**The MeSH axis cannot backstop that.** The spine passes **no `scope`** (zero occurrences in
`matcha-spine-run.ts`), so the `scope === "concept"` admission gate in `lib/api/search.ts` never
fires and `meshDescendantUis` is a **boost, not a filter**. Once the concept's own token leaves the
free-text query, nothing keeps an untagged prose match out of the pool. The doc's stated risk
("more recall can mean more noise") understates the mechanism: this is recall drifting *off* the
concept, not widening around it.

**"When to search both" is NOT self-scoping.** The claim below — that a gloss only exists in the
divergence case — is false: 88% of concepts on the *existing, MeSH-canonically-phrased* corpus carry
a gloss, and 0 of 23 pastes were provably inert. The flag fires nearly everywhere.

**Superseded by the A/B above.** An append-instead-of-substitute fix was written first
(`g ? \`${m} ${g}\` : m`) and did beat substitute — but it still lost to plain bare tokens, so the
whole retrieval half was deleted instead. The mechanism finding below stands and is why the
substitute arm scored worst; it is retained as the explanation, not as a live proposal.

**This retires Option A below.** Option A proposed teaching the extractor to emit a bare surface
term to search *instead of* the diluted gloss — an extractor-prompt change with its own eval
exposure. Appending gets the same anchoring for one line and no prompt risk.

**The A/B was NOT run — all three vehicles are blocked or unsound:**

1. *Offline replay via the public `/api/search`* (this doc's "local spine run" suggestion) —
   **impossible**. The route derives `meshDescendantUis` from `q` itself and accepts no override, so
   changing `q` also moves the MeSH axis: it would measure a different intervention. It also cannot
   express `facultyProminence:false` / `grantProminence:false` / `shape:"topic"`.
2. *Flag-flip staging deploys* — **unsound**, and this doc already contains the reason without
   drawing the conclusion: the route cache key omits the flag, so a post-flip request can serve the
   pre-flip payload.
3. *In-VPC two-arm run on `sps-etl`* — **blocked**: the `sps-etl-task-staging` role has **zero**
   Bedrock permissions, and the spine calls the Sonnet extractor.

The cheapest sound vehicle is to extract locally (Bedrock works from the laptop — the measurement
above did exactly that) and inject the fixed concepts into an in-VPC retrieval run, so the in-VPC
half never needs Bedrock. That also shares one extraction across both arms, cancelling extractor
noise within each pair. **Not built** — it should be pointed at `off` vs `append`, not at the
substitute arm that just got fixed.

Verified independently while doing this: staging taskdef `sps-app-staging:128` (the running one)
does carry `MATCHA_GLOSS_QUERY=on`.

## What Matcha already does (this is the key finding)

Matcha's per-concept retrieval is **already a hybrid**, not concept-only. Each cluster issues one
`searchPeople` call (`lib/api/matcha-spine-run.ts`, ~line 285) that carries BOTH:

- a **free-text query** `q` (BM25 over the people index), and
- a **MeSH descriptor match** (`meshDescendantUis` / `meshDescriptorUi`, `shape: "topic"`).

What the free-text half searches is gated by the **`MATCHA_GLOSS_QUERY`** flag
(`lib/api/matcha-spine-run.ts`, ~line 490):

| Flag | Free-text `q` is… | Effect on the "cognitive decline" ask |
|---|---|---|
| **off** (prod today) | the bare canonical token ("cognitive dysfunction") | literal-phrase signal **discarded** |
| **on** (staging today) | the **gloss** — the sponsor's own words ("cognitive decline with genetic and vascular contributions") | searches the sponsor's phrasing **in tandem with** the MeSH concept |

The `gloss` is the extractor's per-concept **qualifying context** — the sponsor's own words for what
they mean by a concept — emitted by the LLM extractor and defined in `lib/api/matcha-extract.ts`
(`ExtractedConcept.gloss`). It is absent when a concept stands alone in the paste (no qualifying
context) or on the dictionary-fallback path.

Net: the "search both" instinct is **already implemented** and **already on in staging**. So the
open question is not "should we build it" — it is "does the gloss-hybrid retrieve the right people
without adding noise, measured?" — and that is exactly why the flag is eval-gated (staging-on to
measure, prod-off until an A/B proves it).

### Confirmed flag state (2026-07-19)

Running staging task def `sps-app-staging:128`, container `app`:
`MATCHA=on`, `MATCHA_SPINE=on`, `MATCHA_GLOSS_QUERY=on`, `MATCHA_RECENCY=on`.
Prod defaults: `MATCHA_GLOSS_QUERY=off`, `MATCHA_RECENCY=off` (cdk `env === "staging" ? "on" : "off"`).

## Why "when to do both" is (mostly) already answered

The concern "it's hard to know when to search both" is largely self-scoping:

- The gloss **only exists when the sponsor gave context the MeSH term strips** — i.e. the divergence
  case (decline vs dysfunction). A bare "pulmonary fibrosis" with no extra sense has no gloss, so
  there is nothing extra to search and the canonical term already IS the sponsor's word.
- So gloss-query does NOT indiscriminately keyword-search every concept. It adds the sponsor's
  phrasing only where the sponsor said something richer than the bare label.

Two honest caveats remain:

1. **The gloss is the qualifying phrase, not a clean keyword.** It is "cognitive decline WITH genetic
   and vascular contributions", so the free-text is diluted by the trailing words. It will not
   reproduce the public `exact`-scope population one-for-one. Possible refinement (see Options).
2. **More recall can mean more noise.** A keyword mention of "cognitive decline" is not the same as
   topical focus. That is the whole reason for the A/B rather than a blind flip.

## How to explore this to a decision (runnable)

The harness lives in `scripts/search-eval/` (`sponsor-README.md` is the guide). It scores a ranking
against a **judged gold set** with **nDCG@k** (order quality) + **Spearman ρ** (rank correlation) +
**coverage** (did the ranker return the judged people at all).

Crucially for this question: the gold grades are produced by an **evidence-grounded LLM judge +
adversarial verify** that is deliberately **independent of the MeSH tagged-count** (to avoid
circularity — see `sponsor-judge.workflow.js`). So unlike the recency flag (whose gold is
recency-blind and could never show recency winning), **this gold CAN fairly grade gloss-query**:
does pulling in the sponsor's phrasing surface genuinely-relevant people, or noise?

### The one trap: gloss-query changes RETRIEVAL, so the offline re-rank harness does NOT apply

`sponsor-rerank-ab.ts` re-ranks a **single fixed capture** two ways — valid for recency (a pure
re-score of already-retrieved candidates). `MATCHA_GLOSS_QUERY` changes **which people are
retrieved**, so you cannot re-rank one capture. You must **capture twice** — once with the flag off,
once with it on — and compare. Steps:

```bash
cd scripts/search-eval
./sponsor-eval.sh --selftest                 # sanity: scorer math, no infra

# 1. Gold set (once). Real pastes graded 0-3 (see sponsor-README §"Building the gold set").
#    A dedicated fixture for a DIVERGENT ask (e.g. cognitive decline) + a FAITHFUL control
#    (e.g. pulmonary fibrosis, where MeSH == the sponsor's word) isolates the effect.
cp sponsor-fixtures.template.json sponsor-fixtures.json   # then fill

# 2. Capture the ranker output BOTH ways → run.json { "<promptId>": ["cwid", ...ranked...] }.
#    The flag is read from process.env in the spine, so each arm needs the spine run with the
#    flag set — a local spine run against the staging OpenSearch, NOT a curl of one deployed env
#    (a single deployed env only exercises ONE flag state). Produce:
#      off.json  (MATCHA_GLOSS_QUERY unset/off)
#      on.json   (MATCHA_GLOSS_QUERY=on)

# 3. Score + diff
ACTUAL=off.json ./sponsor-eval.sh sponsor-fixtures.json > off.txt
ACTUAL=on.json  ./sponsor-eval.sh sponsor-fixtures.json > on.txt
diff off.txt on.txt
```

Read **coverage first** for this question (does gloss-on retrieve MORE of the judged-relevant
people?), then **nDCG** (does it keep them well-ordered, or does the extra recall bury the good
matches?). A coverage gain with flat/higher nDCG is the win condition; a coverage gain with an nDCG
drop is recall-bought-with-noise.

### Decision criterion (proposed)

Flip `MATCHA_GLOSS_QUERY` on in prod only if, **across the fixture set** (not a single ask):
gloss-on shows **≥ non-inferior nDCG@k** AND a **coverage gain on the divergent asks** with **no
coverage/nDCG regression on the faithful controls**. One compelling anecdote (cognitive decline) is
a reason to build the fixture, not to flip the flag.

## Options if the A/B says "the gloss helps but is too diluted"

Only pursue if the measurement motivates it — do not build speculatively.

- **A. Tighten the gloss keyword.** Have the extractor emit, alongside the qualifying gloss, the
  sponsor's **bare surface term** ("cognitive decline") and search THAT as the keyword instead of the
  full qualifying phrase. Higher-signal than the diluted gloss; contained to the extractor + spine.
  Eval-sensitive (extractor prompt).
- **B. Keep gloss-query as-is** (the full qualifying phrase) — simplest, already built, already
  measured by the harness above.
- **C. Do nothing.** The canonical concept is correct, the sponsor's words are already surfaced in
  the concept's provenance `ⓘ`, and the gloss hedge exists in staging. Defensible if the A/B is a
  wash.

Recommendation: **run the A/B (B), then decide A vs C from the numbers.** Do not relabel the rail
concept ("cognitive dysfunction" → "cognitive decline") — `term` is the MeSH search key, not just a
label, and the sponsor's phrase is already one hover away.

## Promoting the already-merged work to prod (two DISTINCT actions)

These are separate; do not conflate them.

1. **The merged UI code** — reskin (#1806) + coverage-tooltip polish (#1807), both on `master`/staging.
   Pure component/CSS, **no cdk, no env change**. Promote via the **reviewer-gated prod deploy**
   (pauses for paulalbert1). This ships the warm palette, provenance `ⓘ`, compact-default, and the
   clearer coverage tooltip to prod. No flag decision involved.

2. **The gloss-query prod flip** (only after the A/B) — this is a **cdk change**, not a code deploy:
   edit `cdk/lib/app-stack.ts` line ~1295 (`MATCHA_GLOSS_QUERY: env === "staging" ? "on" : "off"`),
   regenerate the app-stack snapshot (`cd cdk && npm test -- -u`, commit only the `.snap`), and
   `cdk deploy Sps-App-prod`. Caveat: **the flag is NOT in the route cache key** (the key is
   `sha256(description + include)`, `app/api/edit/matcha/route.ts` ~line 139), so already-cached asks
   keep serving the old (gloss-off) result until the **30-minute TTL** expires — a bounded stale
   window, not a bug, but worth knowing when validating the flip.

## Adjacent, out of scope here (cross-refs)

- **PET / abbreviation highlighting** — the paste read-back does not highlight "PET" because the
  extractor canonicalizes/expands it and does not keep the abbreviation as a `member`. `markPaste`
  already marks all `members` (`lib/matcha-paste-highlight.ts`), so the honest fix is extractor-side
  (retain the abbreviation as a member or emit the verbatim span). Same family of problem as this
  doc (canonical term ≠ the sponsor's surface form), different surface.

## File map

- Spine retrieval + gloss gate: `lib/api/matcha-spine-run.ts` (`searchPeople` ~285; `glossQuery` ~490).
- Extractor + gloss definition: `lib/api/matcha-extract.ts` (`ExtractedConcept.gloss`).
- Flag wiring (per-env): `cdk/lib/app-stack.ts` ~1290-1296.
- Route cache key + TTL: `app/api/edit/matcha/route.ts` (~129 TTL, ~139 key).
- Eval harness: `scripts/search-eval/sponsor-README.md`, `sponsor-eval.sh`, `sponsor-fixtures.json`,
  `sponsor-candidates.sh`, `sponsor-evidence.sh`, `sponsor-judge.workflow.js`, `sponsor-assemble.sh`.
- Rail provenance `ⓘ` (where the sponsor's phrase is already shown): `components/edit/matcha-panel.tsx` `ConceptRail`.
