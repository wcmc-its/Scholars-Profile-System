# MATCHA_GLOSS_INWORDS — §1 acceptance measurement (operator-run)

The ship gate for the "in their words" gloss evidence (dark). Per concept: **does the sponsor's own
phrasing actually get marked often enough to earn the surface, and is it never misleading?**
Blocks the staging flag flip. See `docs/2026-07-24-matcha-inwords-descendants-redesign-spec.md`.

The mechanism was **redesigned** on 2026-07-24. It is no longer a person-level fragment: the gloss's
distinctive terms now ride `fetchKeyPaper`, whose admission filter is already
`wcmAuthorCwids = cwid` AND `meshDescriptorUi ∈ descriptorUis`. So a marked title is provably this
scholar's paper under this concept, rather than "this word appears somewhere in their corpus" (which
measured ~50% off-concept fragments). The old `inWords` field, `glossHighlight`, and the
`publicationTitles` highlight are all deleted.

This reuses the λ-sweep vehicle (`spine-eval-*`). Two changes make it emit the metric:
`spine-eval-run.ts` forces `MATCHA_GLOSS_INWORDS=on` (display-only — cannot change `.ranked`) and
calls the real `fetchKeyPaper` per (candidate, concept) for the top `KEY_PAPER_EVAL_DEPTH`
candidates, emitting `.evidence[fixture][]` with `{cwid, rank, blocks[]}` where each block carries
`{term, glossTerms, pmid, titleHtml, leadMarked}`; `inwords-population.jq` scores it. No new deploy
path.

## Prerequisite (the one gate)

The gloss clause and the spine's `glossTerms` wiring live in the **image** (`lib/api/search.ts`,
`lib/api/matcha-spine-run.ts`), and the runner imports the image's copy — it is downloaded from S3
into the container and run with `npx tsx`, so `@/lib/api/search` resolves to the image, not to the
uploaded file. So `scholars-etl-staging:latest` must be **≥ the commit that merged the descendant
redesign**. An image predating it has no `glossTerms` on the contract and no gloss clause in
`fetchKeyPaper`, so every block reports `glossTerms: null` / `glossMarked: 0` and the measurement
reads as a false "0% populated."

Do **not** use `da99bfb0` (the old #1884 merge) as the floor — that is the person-level mechanism
this redesign deleted, and it will produce exactly the false zero this paragraph exists to prevent.

## Run

```bash
cd scripts/search-eval

# 1. Extract on the laptop (Bedrock; the in-VPC role has none). Pin Sonnet 4.5, shared across arms.
AWS_REGION=us-east-1 npx tsx spine-eval-extract.ts <pastes.json> > extractions.json

# 2. Dispatch in-VPC (operator; the run-task path is classifier-blocked for the agent). The
#    gloss-0.5 arm is the staging λ. Evidence is emitted on EVERY arm, so an existing base+gloss
#    nDCG run already carries it — no separate run needed.
ARMS="gloss-0.5" ./spine-eval-dispatch.sh extractions.json

# 3. Score. The full artifact (with .evidence) is $arm.raw.json; $arm.json is the .ranked slice.
jq -f inwords-population.jq spine-eval-out/gloss-0.5.raw.json
```

Output: `overall` and `perConcept` rows sorted by `rate`, each with two real `examples` fragments.

## Read it against the ship criteria

### 1. Assert the invariant — must be 100%, not a rate

This is the claim the redesign makes; **verify it, do not trust it**. Every emitted `pmid` must carry
a descriptor in that concept's descendant set:

```bash
# the (concept, pmid) pairs the run surfaced
jq -r '.perConcept[] | .term as $t | .pmids[] | "\($t)\t\(.)"' <(jq -f inwords-population.jq \
  spine-eval-out/gloss-0.5.raw.json) | sort -u
# then, in-VPC, for each pmid: _source.meshDescriptorUi ∩ that concept's descendantUis must be non-empty
```

Anything less than 100% means the admission filter is not doing what the redesign says it does —
stop and find out why before reading any other number.

**Known bound on the invariant.** It guarantees "tagged under the descriptor we resolved to", NOT
"about the concept the sponsor asked for". Non-biomedical concepts resolve to broad ancestors:
`foreign policy` lands on the MeSH `Policy` descriptor, whose descendants are `Public Policy` /
`Health Policy` / `Health Care Reform`, so health-policy papers are admitted for a foreign-policy
ask. That is a concept→MeSH **resolution** defect, upstream of everything measured here, and no
number in this file can detect it. Eyeball the concepts, not just the rates.

### 2. Population rate, per concept

Scan `perConcept.rate`. Expect it to fall versus the old person-level mechanism — the subtree filter
is strictly narrower than "anywhere in the corpus". **Falling is fine**: a gloss that rarely appears
verbatim simply shows no mark.

Two rates, and they are not interchangeable:

- **`rate` = the FACE rate.** The gloss word is marked on the pub the card actually shows. The card
  renders `papers[0]` only (`ArtifactLead` in `components/search/evidence-line.tsx`); the rest sit
  behind "+N more pubs". **Read the ship criterion against this one.**
- **`reachRate`** = marked on any of the 3 returned pubs — reachable in one click. Always ≥ `rate`.

### 3. Blind quality sample

Draw ~16 fragments **unfiltered** and judge only: *is the marked word the sponsor's sense?* The
"is the paper on-concept?" half is now structural (subject to the bound above).

**Do not** score against our own stoplist. That metric fell 38% → 17% → 5.5% across iterations while
blind samples stayed ~50% bad, because it only counted words we had already listed.

**Ship criteria:** invariant 100%; `rate` high enough per concept to be worth the surface; blind
sample shows marks that carry the sponsor's divergent sense.

## Notes

- **Denominator = matched pool, not "rescore winners."** `perConcept.pool` counts (candidate,
  concept) blocks — the scholars a card could show a mark to. The finer "of the scholars the
  re-ranker *lifted*, how many carry a mark" cut needs per-concept base-vs-gloss ranks the artifact
  doesn't carry; approximate by intersecting marked cwids with those whose fused rank improved
  gloss-vs-base (`.ranked` diff), if wanted — not required for the gate.
- A mark is only ever a real OpenSearch highlight fragment — absent ⇒ absent, never fabricated. The
  jq just counts.
- **Attribution is an exact token match**, not a substring and not a stem match. Substring
  over-counted (`car`⊂`cardiac`, `gene`⊂`generation`) — the wrong direction for a ship gate. Exact
  tokens under-count instead (a marked `Declining` won't score for gloss word `decline`), and
  under-count is the safe direction.
- **Mention-strength blocks carry no gloss.** The card suppresses `glossTerms` when
  `evidence.strength === "mention"`, because that path blanks `descriptorUis` and falls back to a
  free-text filter an abstract alone can satisfy — the one place the invariant would not hold. Those
  blocks appear in `pool` with `glossMarked: 0`, which is correct, not a miss.
- The harness passes no `exclude`, while the card passes sibling-claimed pmids. A pub claimed by a
  stronger sibling block can therefore be scored here but not shown there. Minor, and in the
  optimistic direction — worth remembering when a per-concept rate looks better than the UI feels.
