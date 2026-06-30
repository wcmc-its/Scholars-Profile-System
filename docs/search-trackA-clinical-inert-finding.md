# Finding: the clinical-signal flag (Track A) is inert for the buried clinician-experts

_Measured 2026-06-30 via a non-destructive in-VPC A/B against staging OpenSearch (no deploy).
Refutes the central premise of `docs/search-author-rank-clinical-signal-handoff.md` Track A
("flip `SEARCH_PEOPLE_CLINICAL` on → Igel lifts"). Also a direct caveat for the open
`feat/pops-clinical-tune` branch._

## What was tested

Called the real `searchPeople()` in-VPC (relevanceMode `v3`, area-boost on — staging config),
toggling `SEARCH_PEOPLE_CLINICAL` off vs on, over 26 gold-set scholars × 4 queries (obesity,
diabetes, hypertension, FMT). The resolver toggled correctly (`off=false`, `on=true`).

## Result: zero movement

**Every one of the 26 scholars ranked identically off vs on.** Leon Igel (`lei9004`) on
"obesity": `#183` → `#183`, score **248.22699 → 248.22699** (byte-identical).

## Why — cross_fields blend domination (raw-OS scores for Igel, q="obesity")

| fields | _score |
|---|---|
| `publicationTitles^6` only | 29.75 |
| `publicationMesh^4` only | 22.27 |
| `clinicalSpecialties^3` only | 8.74 ← clinical **does** match "Obesity" |
| `clinicalExpertise^2` only | 9.42 |
| `publicationMesh^4 + clinicalSpecialties^3` (master flag-on) | **22.27** (clinical adds 0) |
| `publicationMesh^4 + clinicalSpecialties^5` (pops-tune default) | **22.27** (still 0) |
| `publicationMesh^4 + clinicalSpecialties^20` | 29.27 (only now contributes) |

The people topic query is one `cross_fields` `multi_match` over fields sharing the
`scholar_text` analyzer. `cross_fields` (Lucene `BlendedTermQuery`) scores the term against
the **dominant** field, not the sum. Igel already matches "obesity" in `publicationTitles^6`
(29.75) and `publicationMesh^4` (22.27); `clinicalSpecialties` at `^3` (8.74) — **and at `^5`
(≈14.6)** — stays below that, so it's blended away. It would need ≈`^11+` to beat
`publicationTitles^6` for Igel.

## Two independent reasons clinical can't rescue Igel

1. **Blend domination (above):** any clinician who *also* has topical publications (Igel has
   obesity pubs) gets their clinical match swallowed by the higher-boosted publication fields.
   The flag therefore only helps scholars with **no** topical publication signal at all.
2. **He's buried by the function_score multipliers, not the text score.** His base text score
   (~29.75) is fine; his final `relevanceScore` (248) is ~8× that from the function_score
   (area-concentration × prominence). The ~182 docs ahead have higher multipliers. Clinical
   *text* fields feed the base score, which is then multiplied by Igel's **low** authorship-
   weighted concentration — so even a clinical contribution that survived the blend would be
   scaled down by the same low multiplier that buries him.

## Implications (redirect)

- **Do not flip `SEARCH_PEOPLE_CLINICAL` expecting it to lift the buried clinician-experts** —
  it is inert for any of them who publish on the topic (the realistic case). The "cheap flag
  flip" is a dead end for this population.
- **`feat/pops-clinical-tune`'s `^5` is also inert for them** (14.6 < 22.27/29.75). If that
  branch's goal is to surface clinician-experts, the boost is too low *and* the cross_fields
  blend caps its leverage. Raising the boost high enough (~`^11+`) to win the blend would
  distort every other clinical query — not a clean lever.
- **The real lever is the function_score, not the field list.** To lift a clinician-expert,
  clinical signal must act as an **additive function_score boost** (a prominence-like multiplier
  keyed on board-cert/specialty match), *or* the authorship-expertise/concentration restructure
  (Track B) must raise their multiplier. Track A and Track B converge on the function_score.
- **Where the flag DOES help:** pure clinicians with zero topical publications (no publication
  match to dominate the blend). Narrower than the handoff assumed; worth a separate gold-set
  cohort to confirm.

## Repro

`scratchpad` probes (run via `scripts/run-staging-probe.sh`): `probe-trackA-ab.ts` (full A/B),
`probe-trackA-diag.ts` (toggle + score), `probe-trackA-mechanism.ts` (the field/boost table above).
