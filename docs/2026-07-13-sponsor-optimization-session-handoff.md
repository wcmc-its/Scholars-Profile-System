# Sponsor-match optimization — session handoff (2026-07-13, session 3)

Written against `origin/master` @ `e4995731`. Every code claim below was re-grounded at that commit.

## TL;DR

The sponsor-match ranker works and is shipped. The next round of work is **five filed issues**
(#1696–#1700). Before touching any of them, read §0 — **the biggest hazard in this area is not the
code, it is the notes about the code.** Several handoffs and doc-comments assert mechanisms that are
false, and acting on them has already cost real time twice.

## 0. READ THIS FIRST — the stale notes, and why they matter

This subsystem has a track record of **confidently-worded comments that are wrong**. Two have already
caused damage. Treat every mechanism claim you read — including this document — as a hypothesis, and
grep the assignment before you act on it.

### 0a. Four comments say corpus rarity is the fusion weight. It is dead code.

`dampedIdf` (`lib/api/sponsor-match-axes.ts`) has **zero call sites**. `git grep dampedIdf` returns
its definition, its unit suite, and comments. Nothing else.

The live fusion is:

```ts
concept.centrality ** CENTRALITY_GAMMA * concept.weightFactor   // contract.ts, γ = 3
const weightFactor = cluster.kind === targetKind ? KIND_ALIGNED : KIND_OFF_TARGET;  // spine-run.ts, 1.25 : 0.8
```

These four still claim otherwise, and `sponsor-match-extract.ts` literally calls it *"the LIVE left
factor of `weight = centrality × dampedIdf`"*:

- `lib/api/sponsor-match-extract.ts` (~15)
- `lib/api/sponsor-match-spine-run.ts` (~5, ~203)
- `lib/api/sponsor-match-spine.ts` (~48)

**One comment tells the truth and must survive the cleanup:** `sponsor-match-contract.ts` (~164). It
documents the removal properly — IDF anti-correlates with topical centrality in a hierarchical domain
(Myofibroblasts 8.44 > Fibrosis 8.00 > Scleroderma 7.24), #1676 demoted it to a ±15% tiebreaker, a
sweep showed the band paid for nothing (γ=4: keep 0.6610 vs delete 0.6612), so it was deleted. Rarity
survives on the wire as `corpusCoverage`, display-only.

So **the "should rarity be in the fusion?" question is already answered and measured.** Do not
re-litigate it. Cleanup only: #1698.

**Why this is the landmine:** open these files to "optimize the matcher", believe the comments, and
you will spend a session tuning a knob that is not connected. With γ=3, **centrality is the ranker** —
a concept at 1.0 outranks one at 0.3 by **125×**, while the kind prior spans only 1.56×. That is where
the leverage is.

### 0b. The `skipFacetAggs` evidence diagnosis was false, and it is still quoted

`docs/2026-07-13-sponsor-match-next-steps-handoff.md` §2b says topic/method evidence rows are blocked
because the spine runs `skipFacetAggs: true` and closing the gap "will cost the fan-out budget the
breaker was protecting."

**Both halves are false.** `skipFacetAggs` gates exactly one thing (the nine People-index facet aggs)
and appears nowhere in the reason-agg eligibility predicate. The spine produced no evidence for the
dullest reason available: it never passed `matchExplain`, which defaults to false. It never asked.
#1691 fixed it. Acting on the stated cause would have re-armed the aggregation that tripped the
OpenSearch breaker **and still produced no evidence.**

### 0c. That same §2b table is now stale on three of five rows

| Row | §2b says | Actually, on `e4995731` |
|---|---|---|
| Topic/method evidence | blocked, expensive | **shipped** (#1691) — candidates carry `searchEvidence` |
| Preferences rail | blocked | **shipped** — `lib/api/sponsor-preferences.ts`, produced by the route, rendered by the panel |
| Sort: Seniority / status tags | blocked, "spine sets `careerStage: null`" | **shipped** — `careerStage` from `careerStageBucket(...)`, `isClinician` from `hasClinicalProfile` |
| "show anyway" (near-miss) | blocked, needs `caveat` | **still absent** |
| "Ask" header | blocked, needs `ask` | **still absent** |

The reskin is far **less** blocked than that table implies. See #1699.

### 0d. Also stale in that same doc

Its §3 ("The weighting fix") opens *"The finding stands and is unfixed."* It is fixed — #1676 landed
it. Read that document for the eval recipe and the mockup pointer; do not trust its status claims.

## 1. What is open

### Issues (all filed 2026-07-13, all grounded at `e4995731`)

- **#1696 — evidence for every matched concept, not just the best one.** The most attractive of the
  five. The spine already builds a per-`(concept, cwid)` evidence map during the fan-out with
  `matchExplain: true` on every call, then keeps only `evidenceLines[0]` of the single `best.term`
  (`spine-run.ts` ~476 and ~564). **The rest is already fetched, already in memory, and discarded.**
  Widening it costs **zero** additional OpenSearch queries — contract + UI only, so it does not spend
  the fan-out budget the breaker protects.
- **#1697 — evaluate Opus 4.8 for concept extraction.** See §3 before running anything.
- **#1698 — delete dead `dampedIdf`, fix the four lying comments, reconcile the rarity fixtures.**
  The fixtures (`sponsor-topics.json` rarity probes; the template's "rare expert = 3") currently grade
  a signal the ranker deliberately does not have — i.e. they score the system down for working as
  designed. Either re-grade against topicality or label the loss as known-and-accepted.
- **#1699 — Scholars reskin.** Target mockup is `sponsor-match-scholars.html` (repo root, untracked,
  approved). *Not* `sponsor-match-mockup.html`, which no longer exists. Get design sign-off before
  touching pixels; the console is auth-gated, so verify on **staging** with a session cookie, not
  locally.
- **#1700 — the eval scores an unmeasured fixture as nDCG 0.000.** Prerequisite for #1697.

### PR

- **#1694** — cost-model correction + 30 sponsor-match demo inputs. CI green, open, unmerged.

### Operator task, not merged-and-done

- **#1695 is merged but NOT deployed.** Live alarms only change on a manual
  `cdk deploy Sps-Observability-staging` / `-prod` (additive: one alarm, one metric filter, one
  threshold change). **Until that runs, the Aurora connection alarm stays blind to connection leaks.**

## 2. The ranker, as it actually is

```
paste ─▶ extractSponsorConcepts (Bedrock Sonnet 4.5, temperature 0)
           └─▶ concepts[]: { term, kind: concept|method, centrality ∈ [0,1] }
      ─▶ MeSH resolve + cluster (Jaccard over descendant UIs — redundant phrasing collapses)
      ─▶ per-cluster searchPeople fan-out (matchExplain: true, skipFacetAggs: true)
      ─▶ weight = centrality^3 × kindPrior(1.25 aligned / 0.8 off-target)
      ─▶ RRF fuse ─▶ top-N
```

One LLM call per paste, ~$0.01. The route caches on a sha256 of the input (30-min TTL), so a
re-submitted paste is free. **The sponsor-match route is the only Bedrock path in the app with no rate
limit** — it is not wired to `lib/edit/rate-limit.ts`.

Centrality is the product. Everything downstream is arithmetic on it.

## 3. The eval — how to run it without fooling yourself

Baselines to beat, so a "win" is real: **live eval 0.636**, **union gold ~0.72**.

1. **Fix #1700 first.** A give-up (502 / 401 / non-JSON) currently emits `[]`, which scores nDCG
   **0.000**, not null. The script prints *"UNMEASURED, not zero"* to stderr and then does exactly
   that. A breaker-heavy arm will read as a worse *ranker*. The script's own history proves the point:
   a first local baseline scored 0.161 purely because 11 of 15 fixtures had 502'd.
2. **Fetch once, re-fuse offline.** A per-arm refetch scores a *different* Bedrock extraction (both
   `term` and `kind` vary run to run), so the deltas are noise, not signal.
3. **N samples per arm; compare distributions.** Especially for #1697 — see below.
4. The route is flag-gated: `SPONSOR_MATCH=on` (route 404s without it) and `SPONSOR_MATCH_SPINE=on`
   (without it you silently score the **bespoke** engine, not the spine). A fresh checkout carries
   neither.
5. **The fixtures are local-only and contain PII. Never commit them. This repo is public.**

### The Opus trap (#1697)

```ts
modelAcceptsTemperature = (id) => !/claude-(opus-4-[78]|fable)/.test(id)
```

Opus 4.7/4.8 reject an explicit temperature with HTTP 400, so the gate **omits** it. Pointing
`SPONSOR_MATCH_EXTRACT_MODEL` at Opus does not error — it **silently un-pins `temperature: 0`**, the
pin that exists (per its own comment) for bake-off run-to-run comparability. And because the fusion
cubes centrality, that jitter is cubed: a concept wobbling 0.6↔0.8 swings its weight 0.216↔0.512, a
**2.4× move from sampling noise alone.**

The instrument you would use to judge Opus gets noisier the moment you switch to Opus. Sample N times
per arm.

The flip itself is cheap: IAM (`TaskRoleBedrockPolicy`) already grants `us.anthropic.claude-opus-4-8*`,
so it is a task-def env change, no code and no cdk. Cost is ~$0.014/paste vs ~$0.0086. **Decide on
quality, not price.**

## 4. Environment gotchas that have actually bitten

- **Probes must clean up after themselves.** Anything importing `@/lib/db` — transitively, any
  `@/lib/api/*` — opens a 15-connection Prisma pool and Node never exits. End with
  `await db.$disconnect()` and wrap the container command in `timeout 600`. This took staging down
  twice; the runbook is `docs/performance-baseline.md`.
- **There is no cheap Bedrock model here.** Haiku is IAM-excluded on purpose, so any "just add a small
  LLM call" is a **second Sonnet call** on an unmetered route. Ask what already read the input before
  adding a call.
- **The console is auth-gated** (`/edit`). You cannot visually verify it locally. Staging, with a
  session cookie.
- **Start from fresh `origin/master`.** It carries all of today's merges. Do not branch off a
  long-lived local branch — at least one local checkout is 600+ commits behind, and reading code from
  it will mislead you.

## 5. What was verified, and what was not

**Verified** at `e4995731`, by grep/read of the code itself:

- `dampedIdf` has no call site; the live fusion is `centrality**3 × kindPrior`.
- The per-`(concept, cwid)` evidence map is written for every fan-out hit and read once, for
  `best.term` only.
- `careerStage`, `isClinician`, and `preferences[]` all have live producers; `caveat` and `ask` do not.
- The eval's terminal give-up path emits `[]`.
- IAM grants both the Opus 4.8 and Sonnet 4.x families to the app task role.

**NOT verified — do not treat as established:**

- **Whether Opus actually extracts better centrality.** No bake-off was run. #1697 asserts only that
  the *mechanism by which it could help* is real and larger than the code comment suggests.
- The per-paste cost figures are **estimates** (chars/4 tokens, ~300 output tokens, published Bedrock
  rates), not metered. They are marked `est.` in `docs/cost-model.md`.
- Nothing in this session was run against prod.
