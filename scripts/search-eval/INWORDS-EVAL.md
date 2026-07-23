# MATCHA_GLOSS_INWORDS — §1 acceptance measurement (operator-run)

The ship gate for the "in their words" gloss-evidence line (PR #1884, dark). Per concept: **does the
line populate often enough to earn its vertical space, and is it never misleading when absent?**
Blocks the staging flag flip. See `docs/2026-07-23-matcha-inwords-merged-next-steps-handoff.md` §1.

This reuses the λ-sweep vehicle (`spine-eval-*`). Two changes make it emit the metric:
`spine-eval-run.ts` now forces `MATCHA_GLOSS_INWORDS=on` (display-only — cannot change `.ranked`)
and emits an `.evidence` block per candidate; `inwords-population.jq` scores it. No new deploy path.

## Prerequisite (the one gate)

The `inWords` code + the `stemmer` dep live in the **image's spine** (`lib/api/matcha-spine-run.ts`,
`lib/api/search.ts`), and the runner calls the image copy. So `scholars-etl-staging:latest` must be
**≥ `da99bfb0`** (the #1884 merge). If the deployed etl image predates it, rebuild it from `master`
first — otherwise every fragment comes back empty and the measurement reads as a false "0% populated."
(The runner itself ships fresh via S3 each dispatch, so its change needs no rebuild.)

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

Output: `overall` (blocks / populated / rate) and `perConcept` rows sorted by `rate`, each with two
real `examples` fragments.

## Read it against the ship criteria (§5)

1. **Populated often enough** — scan `perConcept.rate`. A high rate (cognitive-dysfunction is the
   expected win — §4 of the parent doc found decline-specialists literally rank on "decline") earns
   the line; a near-zero rate for a concept whose gloss rarely appears verbatim (e.g. "candidate
   biomarkers for patient stratification") just means the line won't show for it — fine, not a fail.
2. **Never misleading when absent** — eyeball `examples`: a populated fragment must genuinely carry
   the sponsor's *divergent* sense (the `<mark>` word), not the concept's own token. And spot-check
   that a **missing** fragment isn't hiding a scholar who obviously used the term (pull that scholar's
   titles). Over-drop is the stemmer's safe direction (under-claim); confirm it's not over-claim.

If a concept over-drops badly, decide whether it's still worth shipping the line for it.

## Notes

- **Denominator = matched pool, not "rescore winners."** `perConcept.pool` counts candidates that
  *matched the concept* (have an evidence block for it) — the scholars a card could show the line to.
  That directly answers §5's "earn its vertical space." The finer "of the scholars the re-ranker
  *lifted*, how many carry the line" cut needs per-concept base-vs-gloss ranks the artifact doesn't
  carry; approximate it by intersecting populated cwids with those whose fused rank improved
  gloss-vs-base (`.ranked` diff), if wanted — not required for the gate.
- `inWords` is set upstream **only** from a real `<mark>` fragment, so `populated` is honest by
  construction; the jq just counts.
