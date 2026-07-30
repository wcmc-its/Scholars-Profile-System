# Search relevance contract — retrieval, ordering, evidence

Normative. This document says what each layer of people search is **allowed to do**. It does not
describe the pipeline — `docs/search-people-relevance.md` does that, layer by layer, and this document
assumes it.

```
Verified against origin/master b837c8c6 — 2026-07-30 (O9 and the O8/O5 amendments: 81045890, 2026-07-31)
Every invariant below was checked in a worktree at that SHA. If HEAD has moved, re-ground before
citing one:
  git log 98bea66a..origin/master -- lib/api/search.ts app/api/search/route.ts \
    app/\(public\)/search/page.tsx lib/api/result-evidence.ts lib/api/search-taxonomy.ts
```

Each rule is marked **[CHECK]** when it can be verified mechanically, or **[REVIEW]** when it can only
be asked in review. A rule that cannot be checked is a question, not a gate — do not treat it as one.

## Why this exists

Search has had many ranking changes and few ranking regressions caught before users found them. The
2026-07-29 investigation is the reason for writing rules rather than more description: five reported
inversions were diagnosed, and **not one was a mis-tuned weight**. Every one was a rule sitting in the
wrong layer.

1. An ordering term credited **area membership** rather than the query. The concentration boost emits
   `{ filter: { terms: { cwid: [...] } }, weight }` (`lib/api/search.ts:1426-1451`) — a bare
   identity-membership filter referencing neither the query nor the resolved descriptor. Measured on
   `genetic therapy`, isolating the layer with `?match=exact` versus `expanded`: scholars with 1
   on-topic publication of 393 and 1 of 607 gained up to 30 ranks, while the scholar with the most
   on-topic work in the set (36 of 135) lost 5.
2. An ordering term keyed on the query's **surface form** rather than its resolved concept. The
   method-family tier is a lexical token-boundary prefix match of the normalised query against the
   family's own label (`lib/api/search-taxonomy.ts:653-671`, `lib/api/normalize.ts:132-139`).
   `"genetherapy"` matches `"aavgenetherapyvectors"` at offset 3; `"genetictherapy"` does not. So
   `gene therapy` carries a ×2.0 multiplier and `gene therapies` does not — same concept, same 921
   results, different order.
3. A displayed number that was never computed under the query. The `topic` evidence line reads
   `areaCounts[hitSlug]` (`lib/api/search.ts:3824`), an index-time total of the scholar's publications
   in that area (`lib/search-index-docs.ts:968-987`). On a gene-therapy search a line reading
   "Ophthalmology & Vision Science — 20" means twenty ophthalmology papers.
4. A displayed fraction whose numerator and denominator are different populations. The card renders
   `N of grantCount grants` (`components/search/people-result-card.tsx:405,463-464`). `N` counts
   `coreProjectNum`-grouped, suppression-filtered funding-index project docs; `grantCount` is
   `s.grants.length`, raw Grant rows with neither grouping nor suppression
   (`lib/search-index-docs.ts:471-472,1385`). One scholar renders "32 of 127" against a searchable
   funding population of 117.

A document that describes the layers cannot catch any of these. A document that states what each layer
may take as **input** catches all four by construction. That is the only job here.

## Layer 1 — Retrieval

Retrieval decides **which scholars are in the result set**. Nothing else.

### Admissible inputs

The query text, its resolved MeSH descriptor and descendants, the user's explicit facet selections,
and visibility/suppression state. Nothing derived from a scholar's prominence, volume, seniority,
funding, or area membership may admit a document.

### Invariants

**R1. An ordering lever never changes the set.** Every `function_score` function scores documents that
already matched; it cannot admit one. Any ranking change must therefore leave `hits.total` and every
facet bucket count byte-identical.
**[CHECK]** For each probe query, diff `total` and `facets` before and after. A moved `total` means the
change escaped its layer — stop and diagnose; do not adjudicate the ordering. This is the existing
hard gate in the #2018 scope protocol, promoted here to policy.

**R2. Identical totals with a different order is a ranking effect, and must be attributable to a named
term.** `gene therapy` and `gene therapies` both return 921; `genetic therapy` and `genetic therapies`
both return 846. Identical `total` with a different order proves the difference ranks rather than
filters, with no deploy.
**[CHECK]** `?match=` decomposition — `exact` suppresses MeSH attribution, concept admission and both
concentration arms (`lib/api/search-flags.ts:126-128`, `app/api/search/route.ts:613,635`), so
`expanded − exact` isolates the concept layers. The param is `match=`, not `scope=`; a wrong name is
silently ignored and returns the default, and the tell is an identical `total` **and** an identical
order.

**R3. Flag off is byte-identical.** A new ordering lever, unset, produces the same request body as the
prior revision — guaranteed structurally (omit the key) rather than by setting it to its identity
value.
**[CHECK]** Snapshot the built body. This is the entire rollback story for any ranking flag.

**R4. A merged flag is dark until deployed.** Flags live in the `sps-app-<env>` task-def env
(`cdk/lib/app-stack.ts`), not the image. Before asserting any live posture, read the **running** task
definition.
**[CHECK]** `scripts/release/flag-parity.mjs` gates wiring, but it validates the synthesised env and is
blind to "merged but never deployed". Read the running task def separately. Note prod's
`containerDefinitions[0]` is `otel-collector`, so a query against `[0]` returns empty and reads as
"flag absent"; filter in Python or jq, never a nested JMESPath.

## Layer 2 — Relevance sorting

Ordering decides **which of the admitted scholars answers the query best**.

### The principle

> Rank by the strength of a scholar's evidence for the queried concept. Query-independent priors may
> break ties among comparably-relevant scholars; they must never overturn a large difference in query
> evidence.

Today the system does the opposite, and the size of the inversion is measured. Across the top 40 of
`genetic therapy`: the query-independent volume prior spans **2.01×** (2060 publications → prominence
multiplier 8.63, versus 26 publications → 4.30) while everything the query contributes spans **2.29×**.
Total output volume, which has no topical relation to the query, carries as much ordering authority as
the query itself.

### Admissible inputs

A term that reorders results may read: the query text and its resolved concept; per-scholar evidence
**for that concept**; and query-independent priors, subject to O3.

### Invariants

**O1. A term keyed on the query's surface form rather than its resolved concept is a defect.** If two
queries resolve to the same descriptor, any ordering difference between them must be attributable to a
genuine difference in evidence, not to spelling, pluralisation, or word order.
**[CHECK]** For any concept with more than one common surface form, probe the forms as a pair and
require convergence. `gene therapy` / `gene therapies` is the standing regression pair for the method
tier; add a pair whenever a new lexical lever lands.

**O2. A term must reference what it claims to measure.** A boost justified as "this scholar works on
the queried concept" must have the concept in its filter. A `terms: { cwid: [...] }` membership list
computed from something other than the query does not satisfy this, however the list was built.
**[REVIEW]** Read the emitted clause, not the function name: what field does it match on, and is that
field a function of the query?

**O3. Every query-independent prior states a ceiling.** Volume, seniority, faculty status and funding
status are legitimate tiebreaks and illegitimate deciders. A prior with no bound cannot be argued
about, only observed after the fact.
**[CHECK]** `grep -c max_boost lib/api/search.ts` is currently `1`, and that single hit is the O4
warning comment in the prominence block — **no `max_boost` is emitted anywhere in the people body**.
Confirm that with `grep -n max_boost lib/api/search.ts` and read the line: a hit that is not a
comment is a new O4 violation. Meanwhile the `ln1p(publicationCount)` `field_value_factor` carries
no `filter` and no bound. That is the violation; see the register below. A ceiling means a stated
maximum contribution, not a smaller unbounded slope. #2068 supplies the ceiling behind
`SEARCH_PEOPLE_PUBCOUNT_DAMPEN=capped` (default `off`, so the unbounded factor is still what both
envs serve): a mutually exclusive step ladder, `PEOPLE_PROMINENCE_PUBCOUNT_BANDS` in
`lib/search.ts`, whose maximum (`PEOPLE_PROMINENCE_PUBCOUNT_CEILING` = 3.0) is derived from the
table rather than asserted beside it, and is machine-checked in
`tests/unit/search-people-pubcount-bands.test.ts`. The lever is resolved at the caller
(`pubCountDampen`), and the Matcha spine pins it `off`.

**O4. Do not cap the sum to bound a term.** `max_boost` on the outer `function_score` caps the
**sum**, so it silently truncates every other term alongside the one being bounded and makes each
lever's A/B uninterpretable. Bound the term.
**[REVIEW]** If a global ceiling is genuinely wanted it is a separate, separately-flagged change with
its own validation.

**O5. Ship ordering levers serially.** Two changes to the same additive sum in one revision make every
observed reorder the composition of two effects with no way to attribute either. An effect size is
reported with the state of every interacting flag attached.
**[REVIEW]** Also: an effect measured on staging is not an effect in prod. Staging and prod differ on
`SEARCH_PEOPLE_FACULTY_PROMINENCE`, `SEARCH_PEOPLE_AREA_BOOST_GRADED`,
`SEARCH_PEOPLE_METHOD_FAMILY_TIER`, `SEARCH_MESH_RESOLUTION_FALLBACK`, and the
`mesh_curated_topic_anchor` row population (85 distinct in prod versus 349 in staging, #2016). All
four flags are on the `?flags=` allowlist, so staging can be made to serve prod's exact
configuration; the anchor population is data and cannot be pinned, which makes it the residual on
any staging-measured claim about prod. The
last one is the sharpest: anchors determine which area is credited, so the two environments choose
from different distributions.
**[CHECK]** On staging, isolate a single lever without a deploy: `?flags=NAME:value,…` on
`/api/search` overrides an allowlisted ranking flag for that request only, so an A/B is two curls
against the same process, the same index and the same second instead of two captures separated by a
deploy and a container restart. The allowlist, the staging gate and the cache-key reasoning are in
`lib/api/flag-override.ts` (#2085); an overridden response carries `flagOverride` in its JSON body,
so a capture cannot be mistaken for default behaviour. The param is inert outside staging — the
prod/staging differences above still have to be reasoned about, not measured away.

**O6. Not every fix is monotone-downward.** Rejecting one arm of a boost can route a query to another
arm with a **wider** eligibility carve, taking a scholar from no boost to the maximum. Describe such a
change as a re-targeting, never as a reduction.
**[REVIEW]** Nothing in the search response distinguishes which arm produced a boost. If a change
alters arm selection, say so explicitly rather than reporting the net.

**O7. A publication contributes once.** Two ordering terms that can both fire on the same publication
are one signal expressed twice. The inner `function_score` composes with `score_mode: "multiply"`
(`lib/api/search.ts`), so they do not merely add — they compound. A scholar whose single paper is both
tagged with the resolved descriptor and carries a matching method-family label earns
×1.5 × ×2.0 = **×3.0** from one piece of evidence. The stacking is deliberate and is stated in
`lib/search.ts` ("tagged + MeSH (×1.5·2.0=3.0) > tagged-only > MeSH-only"); what was never stated is
that the two filters may be reading the **same paper**. Multiplying two views of one publication is
not a trust ladder, it is a double count.
**[REVIEW]** For every pair of terms inside one multiply block, ask whether a single publication can
satisfy both filters. If it can, they are one signal and must compose additively, be collapsed, or be
justified in writing here. Ask separately whether the two filters even read the same publications:
`methodFamily` is built from a sidecar `ScholarFamily` lookup that never intersects the
authorship-derived kept-PMID set (`lib/search-index-docs.ts`), so the ×2.0 can fire on papers that are
not the papers that produced the descriptor match. A multiplier sourced from a different paper set
than the one it is credited against fails O2 as well.

**O8. A term that orders by evidence is sensitive to how much evidence there is.** A filter that fires
identically for one matching publication and five hundred answers **admission**, not ordering. It
belongs in Layer 1. Using it to order is how the principle at the top of this layer is violated while
every other rule is satisfied — O1 through O6 constrain what a term may be keyed on and how far a
prior may reach, and a presence test passes all of them.

Today every query-derived ordering term in the people body is a presence test. `publicationMeshUi` is
a deduped keyword set, so the count never reaches the query; `methodFamily` is a joined label string;
clinical, faculty and active-grant terms are booleans. The only smoothly increasing term in the sum is
`ln1p(publicationCount)` — **total career output, with no topical relation to the query** (see O3).
So the single continuous dial in the system is pointed at the one quantity the query does not ask
about, and the measured consequence is that ordering barely responds to the evidence being ranked on:
on a disease query, the scholar with **318** publications tagged to the queried descriptor ranks
**15th** while one with **13** ranks first, and across a top 20 the score per matching publication
spans **43×, inverted** — the less evidence a scholar has, the more each paper is worth.
**[CHECK]** Capture a query's top 20 and divide each scholar's score by their count of matching
publications. Under a magnitude-sensitive ordering that ratio is roughly flat; a wide spread, or one
that trends **downward** as evidence rises, localises the violation. Then count inversion pairs — a
scholar outranking another who has more than 3× their matching publications. Both are computable from
the search response alone, with no index access. A term proposed as evidence should move this
measurement; if it does not, it is an admission signal wearing an ordering signal's clothes.

🔴 **This [CHECK] is a smoke test, not an acceptance test, and it has produced a wrong verdict.** It
measures evidence as tagged-publication count; where the resolved concept is broad, that count and
career volume become nearly the same quantity, so **deleting any lever that ranks on an orthogonal
signal scores as a large win.** On 2026-07-30 it recommended disabling the method-family tier by
−153 inversion pairs, and reading three result pages reversed the verdict outright — with the tier
off, every practitioner of the queried technique is evicted in favour of high-volume generalists.
Never ship on this number alone; adjudicate on pages. A change whose gain sits in the tail of a
20-row result, where the aggregate improves and the visible top 3 is byte-identical, has not been
shown to help anyone.

**O9. A magnitude is assembled from ONE population.** A term that orders by "how much evidence" must
count one kind of thing across every candidate it compares. `evidenceLines[kind == "publications"]`
carries a `strength` discriminator with **three** values (`lib/api/result-evidence.ts:129`):

| `strength` | means | carries `count`? |
| --- | --- | --- |
| `tagged` | the publication carries the resolved MeSH descriptor | yes (`:558`) |
| `concept` | the MeSH-expansion text variant | **no** (`:574-585`) |
| `mention` | the publication's free text contains the query string | yes (`:598`) |

Within one hit these are mutually exclusive — `selectEvidenceLines` pushes the `mention` line only when
no method, tagged or topic line fired — so the hazard is not a sum inside a scholar. It is a **column
assembled across candidates**: a magnitude read by `kind` takes a MeSH count from one scholar and a
free-text keyword count from the next, and orders them against each other.
**[CHECK]** Filter to `strength == "tagged"`. Treat a `concept`-strength hit as **unknown**, never as
zero — it is concept evidence with no count, so a consumer that defaults it to 0 silently ranks a
matching scholar last. Measured 2026-07-31 across the 10-query panel: eight queries are 100% `tagged`,
and only `longevity` (10 mention / 8 tagged) and `crispr` (6 / 4) mix — the two with the thinnest
descriptor coverage, so the defect is invisible on most probes and maximally damaging on the rest.
Reading the column by `kind` put a cardiac electrophysiologist first for `longevity` on six
*device-battery*-longevity mentions.

This is **O1 restated for counts**: a `mention` count is keyed on the query's literal string rather
than its resolved concept, which is the surface-form defect with a magnitude's lever behind it. Use
O1's standing-pair discipline to check it.

## Layer 3 — Evidence display

Display decides **what the card asserts about why this scholar is here**.

### Admissible inputs

Anything, provided it is labelled as what it is. The rules below are about honesty of the claim, not
about which data may appear.

### Invariants

**E1. A number presented as query evidence is computed under the query.** An index-time total, a
career total, or any figure that would be identical for a different query is not query evidence and
must not be rendered where the user reads it as such.
**[CHECK]** For any evidence count, ask whether the value changes when the query changes. Probe the
same scholar under two unrelated queries: a figure that does not move is not evidence for either.

**E2. A numerator and a denominator rendered as one fraction come from one population — and the
denominator is the ELIGIBLE POOL for that specific claim, not the largest number to hand.** "N of M"
where N and M are counted over different sets is false regardless of how correct N is.
**[CHECK]** Name the population of each side. A `Math.min(N, M)` guard only prevents N > M; it cannot
detect M being drawn from a larger set.

Worked examples of all three states, because this rule is the one most often satisfied by accident:

- **Method — correct.** `components/search/result-evidence.tsx:303` sends the method kind to
  `methodPubCount`, the union of `ScholarFamily.pmids`, because method extraction covers 2020+ by
  design. Dividing by `pubCount` once rendered 11 of 923 (1.2%) where the honest figure was 11 of 27
  (41%) — and at 1.2% the `COVERAGE_CUE_THRESHOLD = 0.02` dim then greyed out the strongest match on
  the page. Resolved query-time over the page cwids, not as an index field.
- **Grants — fixed.** See the register.
- **Research area — still wrong.** That same ternary sends every non-method kind to `pubCount`, but a
  publication is only listed in a Research Area if it is **post-2020**, a **research article**, and one
  where the faculty member was **first or last author**. The numerator is carved and the denominator is
  not, so the area line understates by roughly the same mechanism method did — and it sits close enough
  to the 2% dim to be silenced by it. Fixing it needs an eligible-pool count SPS does not store today;
  the method line is the template.

**E3. An OR count is labelled as a match, not as a topical count.** Where a count admits on a text
match **or** a concept tag, the rendered phrasing claims a match. It does not claim the concept.
**[CHECK]** Compare the count against its tagged sub-count. One scholar's funding count of 32 carries
a tagged sub-count of 1; the remaining 31 matched loose words in title, sponsor, abstract or keyword
fields. Note the concept axis is per-env gated (`SEARCH_FUNDING_CONCEPT_GRANTS`), so in prod the
tagged sub-bucket is hard zero for everyone — a phrasing that depends on it renders nothing there.

**E4. A summary count and the drill-down it opens are the same population.** Where a card shows a
count the user can expand, the admission logic of the two must be identical, and this is already
stated as a requirement in code (`lib/api/search-funding.ts:316-320`): "a summary count that
disagreed with the records the user then expands would be a bug".
**[CHECK]** Probe both surfaces for the same scholar and the same query, threading every parameter the
card threads — a drill-down called without the card's concept parameters runs text-only and
undercounts. Take the identifier from the payload; never construct one from a name.

**E5. A failure and an empty result are distinguishable.** An endpoint that returns HTTP 200 with a
zero count for a bad identifier, a caught exception, and a genuine no-match cannot be used as
evidence of anything.
**[CHECK]** Probe with a deliberately invalid identifier. If the response is indistinguishable from a
real empty result, the endpoint cannot verify a card claim, and any investigation using it will
produce a false finding. One did.

**E6. Ordering of evidence lines is a claim about strength.** The first line is read as the primary
reason. Where the order is structural rather than scored, say so in the code that builds it, so a
later reader does not infer a ranking that was never computed.
**[REVIEW]** Current order is method → tagged → topic → mention → clinical, fixed, with one two-way
swap (`lib/api/result-evidence.ts:638-746`).

## Register of known violations

Open at the verified SHA. This section is the reason the document is worth keeping current: a contract
with no violations listed is either new or not being read.

| Rule | Violation                                                                                              | Status                                                                             |
| ---- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| O1   | Method-family tier selected by lexical match on the family label; a plural removes ×2.0                | Open                                                                               |
| O2   | Concentration boost credits area membership via a bare `terms: {cwid}` filter                          | Fixed behind `SEARCH_PEOPLE_CONCEPT_ARM_FIRST` — **on in both envs**; prod flipped 2026-07-30 (#2018/#2079). The descriptor-keyed arm is tried first, but its magnitude is still quantised to three bands — see O8 |
| O3   | `ln1p(publicationCount)` is unfiltered and unbounded; worth 2.01× across a measured top 40             | Ceiling shipped behind `SEARCH_PEOPLE_PUBCOUNT_DAMPEN=capped`, default off, topic/hybrid/unclassified only, spine pins it off (#2068) |
| O7   | Attribution ×1.5 and the method tier ×2.0 sit in one multiply block and can both fire on the same publication, compounding to ×3.0 from one paper; `methodFamily` is not even joined to the papers that produced the descriptor match | Open — no flag isolates it; the composition is intentional and documented in `lib/search.ts`, the shared-publication case is not |
| O8   | Every query-derived ordering term is a presence test; the only continuous term is career-total volume. A scholar with 318 publications tagged to the queried descriptor ranks 15th while one with 13 ranks first | Open, but the missing magnitude **already exists and is live**: the concept arm scores `n²/total` from two publications-index aggs over `meshDescriptorUi ∩ wcmAuthorCwids` (`getConceptScholarConcentration`; both fields already indexed, no reindex), on in both envs since 2026-07-30. `buildAreaBoostFunctions` then quantises it to three membership bands by fraction-of-max, so a 200-paper specialist and a 3-paper one share a band whenever both clear 0.5× of the top. Computed over the right corpus at query time, discarded one step before use. ⚠ The curated arm's `scorePublication` is **not** the vehicle — it sums over `PublicationTopic` (4.9% of authored pmids, median per-scholar ratio 0) and weights each paper by impact, authorship and type rather than counting it once. **✅ The binding constraint is now measured: it is the CEILING, not the banding.** `buildAreaBoostFunctions` bounds the emitted weight by `AREA_BOOST_W_HI`, default **3**, in a sum where the unbounded volume prior alone spans 2.01×. Sweeping `SEARCH_AREA_BOOST_W_HI` via `?flags=` at prod parity (7 weights × 10 queries, `total` byte-identical on all 70 captures): at the default the median tagged-publication count in a disease query's top 10 is 27; at `W_HI=20` it is 187, and the page reaches scholars that were not in the fetched 20 at all. `cancer` moves 32 → 168, `aging` 8 → 11. **No reindex is required for concept magnitude** — see [`ADR-011`](./ADR-011-concept-magnitude-unquantise.md). This also explains why `SEARCH_PEOPLE_AREA_BOOST_GRADED` measured "worse alone": grading a magnitude into a range the ceiling has already collapsed reorders within bands that are all worth about the same. The two flags are one change |
| E1a  | `topic` line named the FIRST of the scholar's own areas that intersects the match, not the best-evidenced | **Fixed** — `pickMatchedAreaIndex`, degrades to the old rule without `areaCounts` |
| E1b  | `topic` evidence line renders an index-time area total as query evidence                               | Open — the count is still `areaCounts`, never query-filtered                        |
| E2b  | `topic` line divides by `pubCount` while its numerator is carved                                       | **Fixed** — the line states a magnitude, no share (see below)                       |
| E2   | Grant card denominator is raw Grant rows; numerator is grouped, suppression-filtered projects          | **Fixed** (#2058) — `grantIndexedCount`, same aggregation, no reindex              |
| E5   | `/api/scholar/[cwid]/grants` swallowed a caught throw into a body identical to a real no-match         | **Fixed** (#2057) — 200 + `error: "search_failed"`, and it logs                     |

### E2b — how it was closed, and why not with a new denominator

The obvious repair was to divide by the scholar's topic-eligible pool. Measured on staging
2026-07-29, across all 2,422 scholars with ≥ 20 authored publications: **12,129 of 245,135 authored
pmids (4.9%) carry any `PublicationTopic` row**, the median scholar carries **zero**, and 1,446 of
the 2,422 (59.7%) have none at all. So `pubCount` overstates the pool by roughly 20× — the Chair of
Genetic Medicine has 36 topic-assigned pmids of 924, which is why his area line rendered
"21 of 923 = 2.3%", one publication above the `COVERAGE_CUE_THRESHOLD` that would have greyed it out
as a thin match, when the honest share is 21 of 36.

The eligible pool was rejected as the replacement anyway. The `%` cell is a fixed position on every
card and therefore a cross-card comparison device; that only works while every cell divides by the
same KIND of denominator, and an eligible-pool ratio would be a third kind beside output-share and
the method-indexed pool. So `topic` joins `method` in withholding the share and stating a magnitude
("21 publications in Gene & Cell Therapy") — which is what the lesser-tier row had already decided
for this same count, on this same argument. Consequence to know: after this change **no
`CountFirst` kind renders a `%`**, so a test that needs the column must use a `publications` lead.

E1b is untouched and still open: that 21 is the scholar's index-time total in the area whatever you
searched.

## Related documents

- `docs/search-people-relevance.md` — the descriptive reference this contract assumes. Layers,
  formula, flag inventory, measurement recipes, known defects.
- `docs/search-research-area-relevance-spec.md` — the concentration boost's original spec.
- `docs/search-evidence-rows.md` and `docs/scholar-card-evidence-rows-spec.md` — evidence-row
  surface specs. Layer 3 above governs what those rows may claim; it does not restate their contents.
- `docs/taxonomy-aware-search.md` — resolution and the curated taxonomy.
- `docs/ADR-011-concept-magnitude-unquantise.md` — the decision to raise the concept-magnitude
  ceiling rather than index a new one, and the measurement behind O9 and the O8 register row.

## Scope

People search on `/search` and `/api/search`. The Publications and Funding tabs share Layer 1's
invariants and the Layer 3 invariants, but not Layer 2 — `searchPublications` takes no
`meshMatchTier` and carries none of the people prominence terms. The Matcha spine reuses the people
body with `shape: "topic"` and suppresses the faculty and grant priors but not the volume prior, so
Layer 2 changes move Matcha ranking and require a re-baseline before a prod flip.
