# Sponsor-match — findings (2026-07-14)

Written against `origin/master` @ `487b9eab`. Four issues closed this session: #1696, #1697, #1698,
#1700. This document records what was **learned**, not what was shipped — the PRs record that. Read
§1 before running any ranking experiment; it invalidates a class of claim this subsystem has been
making.

## 1. THE EVAL HAS A NOISE FLOOR OF ~0.0074 nDCG — EVEN AT `temperature: 0`

Sonnet 4.5 pinned at `temperature: 0`, three samples, same 15 fixtures, same code:

```
0.6572   0.6497   0.6510      mean 0.6526   spread 0.0074
```

**The extraction is not deterministic, even pinned.** The pin narrows the distribution; it does not
collapse it.

**Consequence, and it is retroactive: any mean-nDCG improvement under ~0.01, claimed from a single
run, is unproven.** Several results in this subsystem's history are exactly that size. They are not
necessarily wrong — they are *unmeasured*. Anything at or below the floor needs N samples and a
distribution, not a before/after pair.

This compounds with `CENTRALITY_GAMMA = 3` (`sponsor-match-contract.ts`): centrality is cubed into the
fusion weight, so a concept wobbling 0.6↔0.8 between runs swings its weight 0.216↔0.512 — a 2.4x move
from sampling alone. The ranker's dominant input is the least stable thing in it.

## 2. Opus 4.8 does NOT beat Sonnet 4.5 for concept extraction (#1697, closed)

2 arms x 3 samples x 15 fixtures; every sample scored 15/15 with 0 unmeasured.

| arm | samples | mean | spread |
|---|---|---|---|
| **Sonnet 4.5** (pinned, `temperature: 0`) | 0.6572 / 0.6497 / 0.6510 | **0.6526** | **0.0074** |
| **Opus 4.8** (temperature silently dropped) | 0.6733 / 0.6628 / 0.6517 | **0.6626** | **0.0215** |

Gap **+0.010**, against Opus's own spread of **0.0215**. Opus's worst sample lands *below* Sonnet's
best. Per-fixture it is a reshuffle, not a lift — 9 better, 1 tied, 5 worse — and it is **worse** on
`multiple-sclerosis` (-0.104) and `rarity-scleroderma` (-0.051), the rare-disease calls the surface
exists to serve.

**Kept Sonnet:** cheaper, faster, statistically indistinguishable on this evidence, and the only one of
the two that can be **pinned**.

**One run per arm would have "proved" a win.** Sonnet's worst (0.6497) against Opus's best (0.6733) is
**+0.024** — a headline number and a pure artifact. That is what the N-sample requirement was for.

Opus is ~3x noisier *because* it cannot be pinned: the gate `modelAcceptsTemperature` omits
`temperature` for `opus-4-[78]` (they 400 on it), so switching to Opus silently un-pins the very
determinism the bake-off depends on. **The instrument gets noisier the moment you switch to the thing
you are trying to measure.**

### Method, for whoever runs the next one

- **The extractor is the thing under test ⇒ every sample must REFETCH.** This is the *opposite* of a
  *constant* sweep, where refetching per arm scores a different extraction and the deltas are garbage.
  Know which kind of experiment you are running.
- **The route caches on `sha256(paste)` in an in-process Map.** Sampling one paste N times replays
  ONE Bedrock call and measures zero jitter — the exact quantity you need. **Restart the server between
  samples.**
- **Fix the decision rule before you see numbers.** Ours was written first: a win must exceed the arm's
  own spread.
- Assert `scored=15/15` and `exit=0` per sample *before* quoting any mean.
- The flip is env-only: `SPONSOR_MATCH_EXTRACT_MODEL`. IAM already grants both families.

## 3. A guard that cannot fire, and a green suite that could not see it (#1696)

`selectEvidence` terminates in `return { kind: "none" }`. `selectEvidenceLines` ends with
`if (lines.length === 0) lines.push(selectEvidence(input))`. **Neither can return empty.**

So the spine's `if (!hitEvidence) continue` — the guard whose entire job was "a concept with no evidence
contributes no block" — **was dead code in every deployed environment.** Every concept shipped a block,
including unresolved clusters that fall down the ladder to the identity tail. The console captioned a
scholar's **self-reported research areas** with the sponsor's concept: *who is this* rendered as *why
they matched*, on the surface a fundraising officer acts on.

Driven against the real route, real OpenSearch and real Bedrock, the fix suppressed **21 fabricated
blocks on a single paste** (21 of 341 candidates ranked, had no research evidence for any concept, and
would each have shipped an identity block under a concept heading).

**The suite was green — 7,172 tests — because the spine's mock returned a hit carrying neither
`evidence` nor `evidenceLines`: a shape the real emitter cannot produce.** A mock cannot tell you what
the real dependency emits. It can only tell you what you already believed.

### Ask the right question, not the plausible one

The first fix gated on *"was this evidence derived from the query?"* — which is intuitive, reads as
correct, and is **wrong**. `affiliation` **is** query-derived (the `<mark>` is the query's own) and is
still merely the name of the group the person sits in. It is emitted at ladder rank 9 — *"weak/
organizational, just above empty"* — i.e. **precisely when nothing about their work matched**. So the
researcher *least* connected to the concept is the one who gets the block. `name` is worse: a researcher
surnamed Parkinson is not thereby an expert on Parkinson disease, and that is the false-positive class
the gold grades **0**.

The question is **"does this assert that their RESEARCH matches?"** Only `method`, `topic`,
`publications`, `clinical`, `selfDescription` do. `isResearchMatchEvidence` (`result-evidence.ts`) is
an exhaustive switch with **no `default`**, so a new evidence kind fails to compile until someone
classifies it — the permissive fallback is what created the bug in the first place.

## 4. A cap that kept the weakest concepts (#1696)

The evidence cap sliced the top 3 contributions **by raw rank**, while every consumer measures
importance as `centrality^3 x weightFactor / (K + rank)`. With γ=3 centrality dominates rank, and the
correlation runs the wrong way in practice: **a sponsor's primary concept is its broadest, most
competitive query, so a specialist ranks *worse* on it than on a narrow peripheral mechanism.**

```
target    (centrality 1.0, aligned)   weight 1.25  rank 25  ->  strength .0227   <- DROPPED
mechanism (centrality 0.5, off-tgt)   weight 0.10  rank  1  ->  strength .0032   <- kept
```

The cap systematically discarded the sponsor's actual target — the card's **leading chip** — and kept
three incidental concepts. Now sorted by the same default strength the client ranks blocks by.

**Generalisable:** whenever a server truncates and a client re-ranks, truncating on a *different axis*
from the one the client sorts by will silently drop the top item. Grep for `.slice(` next to a `.sort(`
and check the two agree.

## 5. Local dev emits NO search evidence — a feature can "pass" locally having never run

`searchPeople` emits evidence only under **both** of `SEARCH_RESULT_EVIDENCE` and
`SEARCH_EVIDENCE_REASON_COUNTS`. Both are ON in staging and prod; **neither is in a default local
`.env.local`.**

The first local verification of #1696 returned **0 evidence blocks on all 341 candidates** — which reads
as a catastrophic failure of the feature. It was flag parity. The mirror-image failure is the dangerous
one: a local check that *appears to pass* while the code path never executed. Set both, then assert you
got non-zero evidence before concluding anything.

## 6. The eval was scoring its own failures as ranking results (#1700, closed)

A give-up — breaker 502 after retries, stale cookie, non-JSON — emitted `[]`, and `[]` scores
**nDCG 0.000**. The script printed *"UNMEASURED, not zero"* to stderr and then did precisely that in the
arithmetic. Every baseline this project has quoted was dragged by an unknown amount.

Now: `null` (never answered) is excluded from the mean and from coverage; `[]` (answered, ranked nobody)
is still a legitimate 0; and a run with any unmeasured fixture **exits 2**, so a degraded box stops the
experiment instead of lying to it.

## 7. What is now stale in the older docs

| Doc | Stale claim |
|---|---|
| `2026-07-13-sponsor-weighting-reskin-handoff.md` §9 | "Tuning constants were NOT swept" — they were (#1681); rarity is deleted, not bounded |
| same, §4 | "Local OpenSearch is a 1 GiB heap" — master carries `-Xms4g -Xmx4g` |
| `2026-07-13-sponsor-match-next-steps-handoff.md` §2b | 3 of 5 "blocked on a producer" rows have shipped |
| `2026-07-13-sponsor-optimization-session-handoff.md` | Corrected in-place when it merged (#1701); its §0a landmine is FIXED, kept as a lesson |
| Any doc citing `dampedIdf` as the fusion weight | It is deleted (#1698). The weight is `centrality^3 x kindPrior` |

## 8. The through-line

Four of the six findings above are the same failure wearing different clothes: **an assertion that was
never checked against the thing it described.** A comment that said rarity was the weight. A guard that
could not fire. A mock that emitted a shape production never produces. A cap that sorted on an axis
nobody read. Each was confident, each was documented, each was green.

**Grep the assignment. Drive the real path. Mutate the code and watch the test fail.** A test that
passes against both the bug and the fix is not evidence of anything — and this codebase produced 7,172
of those in a single suite.
