# Search-result evidence & representative-papers disclosure — as-built

The People-tab search-result snippet: one typed evidence object per result, rendered as a
"why this matched" line, with a clickable disclosure that reveals the scholar's representative
papers. This is the as-built record of the behavior shipped across **#1064 → #1066 → #1067**
(it supersedes the original implementation spec and the #1060 hover-reveal).

**Flags (no new flag, no reindex, no edge deploy — the `/api/scholar/[cwid]/method-exemplar`
route path is unchanged):**
- `SEARCH_RESULT_EVIDENCE` — emits the typed `evidence` object + the disclosure. Staging **on**,
  prod **off**.
- `SEARCH_PEOPLE_SNIPPET_REPRESENTATIVE_PUB` — attaches the inline representative pubs to the
  pub-count evidence. Staging **on**, prod **off**.
- `SEARCH_PEOPLE_MATCH_EXPLAIN` — the underlying reason-count aggregation. On in both envs.

Everything here is **presentation-only**: the query predicate, scoring, result set, facets, and
counts are unchanged, and the `SEARCH_RESULT_EVIDENCE`-off (prod) path is byte-identical to the
pre-feature legacy reason line.

---

## The contract — `lib/api/result-evidence.ts`

One `ResultEvidence` per hit, selected server-side by ONE precedence function (`selectEvidence`);
the card renders it and never re-ranks. Relevant shapes:

- `EvidencePub = { pmid; title; titleHtml?; year? }`.
- `publications` kind: `{ kind:"publications"; strength:"tagged"|"mention"|"concept"; text;
  pubs?: EvidencePub[]; count?: number }` — `pubs` is the (≤3) representative stack, `count` the
  numeric N for the `+N more` math, `text` the human "N of M …" string.
- `method` kind: `{ kind:"method"; family: string; tools: string[] }`. **The `tools` are no
  longer rendered** (the trail was dropped in #1067 — see "Method row" below), but the field is
  retained so a curated 1–2 terms could be reinstated without re-deriving anything.
- `SelectEvidenceInput.pub.{tagged,mention}` carry `{ text; count; pubs? }`; the input also
  carries `query` (the content query) for the partial-bio test.

### Precedence (`selectEvidence`)
`name → method → topic → pub.tagged → pub.concept → selfDescription(bio, IF it covers the query)
→ pub.mention → selfDescription(partial-bio fallback) → affiliation → areas → none`

The bio is split into two tiers by **`bioCoversQuery(bioHighlight, query)`** (exported, pure): a
bio highlight that marked only a SUBSET of a multi-word query loses to `pub.mention`; a full-query
(or single-token) bio still wins. Implementation: tokenize `query` (lowercase, split on
non-alphanumeric, drop tokens < 2 chars); a bio "covers" the query iff every query token appears
inside the `<mark>…</mark>` spans. ≤1 significant token, or empty/absent query → true (no
demotion). This is why `16s rna` rows show "N of M publications mention …" instead of a bio
sentence that only matched "RNA".

---

## Free-text publication evidence — `lib/api/search.ts`

The "N of M publications tagged/mention X" reason (and its representative pubs) is produced by ONE
aggregation on the publications index keyed by page cwid — no people-index field, no reindex.

**Gating (the core of the `16s rna` fix).** Historically the aggregation ran only when a query
resolved to a MeSH concept (`applyTopicTemplate && meshDescendantUis>0 && provenanceParent>0`),
so a content-shaped free-text query that resolves to nothing fell through to a weak bio highlight
or "no specific match". It now also runs for **content-shaped free-text queries**, but the
widening is gated on `resultEvidence` so the flag-off prod legacy reason stays byte-identical:

```ts
const contentShape =
  applyTopicTemplate || applyHybridTemplate || queryShape === "restructured_msm"; // NOT name/department
const runReasonAgg = resultEvidence
  ? matchExplain && contentQuery.length > 0 && pageCwids.length > 0 && contentShape
  : matchExplain && applyTopicTemplate && meshDescendantUis.length > 0 && provenanceParent.length > 0;
```

- Name- and department-shaped queries never run it (no "publications mention 'John Smith'").
- The `tagged` sub-filter requires a resolved descriptor: when `meshDescendantUis` is empty it is
  OMITTED and only `mention` (`multi_match` title+abstract, `operator:"and"` on `contentQuery`) is
  computed. The `tagged` evidence is additionally guarded on `provenanceParent.length > 0` so an
  empty descriptor can never render "publications tagged " with a trailing blank.
- Representative pubs: `repPubTopHits` is `top_hits` `size: 3`, sorted year-desc then citations-desc,
  with the title `<mark>`-highlighted against the literal `contentQuery`. Parsed by
  `parseReasonTopHits(agg, 3): RepresentativePub[]` (array form of `parseReasonTopHit`, which is
  kept for the legacy `composeMatchReason` path — fed `reps.x?.[0]` so the legacy reason is
  unchanged).
- `resolveHitEvidence` builds `pub.tagged`/`pub.mention` as `{ text, count: Math.min(count,
  pubCount), pubs }` and passes `query: contentQuery` into `selectEvidence`.

---

## Representative-paper loaders — method/topic (lazy, Aurora-only)

`/api/scholar/[cwid]/method-exemplar?family=` / `?topic=` resolves the stack on first expand
(`{ pubs: EvidencePub[]; total: number }`; flag-off / error / no-selector → `{ pubs:[], total:0 }`).

- `rankMethodExemplarList(candidates, year, limit=3)` — same lexicographic rank as the single-pick
  `rankMethodExemplar` (original-research → first/senior → impact → citations/yr → year → pmid),
  returning the top `limit`. `filterRenderableExemplars` drops corrections / untitled stubs.
- `rankExemplarForPmids` returns `{ pubs, total }` where `total` is the **renderable** candidate
  count (so `+N more` never over-promises). All gates intact: scholar active/non-deleted, #800/#801
  family overlay (method), ADR-005 publication suppression.
- These titles carry **no `titleHtml`** (no analyzer at fetch time), so method/topic rep papers
  render plain — see "Keyword highlighting" below.

---

## Rendering — `components/search/match-reason.tsx`, `result-evidence.tsx`, `people-result-card.tsx`

### Disclosure = the whole summary row is the toggle (#1066)
Not a chevron marooned at the right edge: the `[icon] [label] [chevron]` cluster is ONE
content-width native `<button>` (`DisclosureRow`) — implicit role=button, native Enter/Space,
`aria-expanded`, `aria-controls` **only while expanded** (the panel mounts only then, so a
collapsed `aria-controls` would dangle). It has a hover surface (`hover:bg-[#f0eeea]`) and
`-mx-2 / px-2` so the surface breathes ±8px without shifting the content's left edge; the chevron
rotates 180° on expand. `onClick` does `preventDefault`/`stopPropagation` so it never triggers the
card's stretched name-link. The accessible name is the visible content (the count / method label)
plus an `sr-only " representative papers"` affordance. Applies to both the publication-count
`MatchReason` row and the method/Research-area `MatchAwareReason` pill row.

### Method row (#1067)
Just the `METHOD` pill + the bold family name + the chevron — the muted `· term · term`
exemplar-tool trail was removed (the rep-papers list does the evidentiary work; the bare name
reads as a confident label with no casing/truncation to maintain). The family name is
`font-semibold` (600) `#1a1a1a` — the same weight as the in-title highlight.

### Representative-papers panel — `RepresentativePapers`
- Label pluralizes: **"Rep. paper"** for one, **"Rep. papers"** for more.
- Each paper is a flex `[•] [title]` row (`items-start`, bullet `flex-shrink-0`, **6px** gap), so a
  wrapped title hangs under the title text, not the bullet.
- Titles are **roman, 15px, and never truncate** — the full article title always wraps. Rendered
  through `PubTitle` (markup-safe) or `HighlightedSnippet` when a `titleHtml` is present; the
  matched keyword stays `font-semibold` (600) `#1a1a1a`. The trailing ` (year)` is non-italic
  tertiary.
- `+{total - papers.length} more in profile →` `<Link>` (`relative z-10`, stops propagation) to
  `${profilePath(slug)}#publications` when `total > shown`.
- While a method/topic fetch is in flight: a muted, `aria-hidden` "finding representative papers…"
  placeholder. Renders nothing once a fetch resolves with zero papers (no dead block / no dead
  chevron).

### Stretched-link card — `people-result-card.tsx`
The card is no longer a single `<Link>`. The NAME is the profile link with an
`after:absolute after:inset-0` overlay (whole-card click + analytics beacon preserved); the
chevron button and the `+N more` link sit above it (`relative z-10`). Disclosure state is
`useState` + `useId`; method/topic lazy-fetch `{pubs,total}` on first expand, publications use the
inline `evidence.pubs` (no fetch).

### Chip wrench (#1064 #3)
`MethodChip` (the "Methods and Tools" header chip row) no longer carries a per-chip `Wrench`; the
rust tint already cues "method" and the section label keeps its icon — consistent with the
Research-Areas chips.

---

## Keyword highlighting — confirmed behavior (not morphological)

- **Publication-mention / tagged** rep-paper titles are highlighted by OpenSearch using the title
  field's analyzer: exact + light English stemming (catches simple inflections), but **NOT**
  cross-morphological (`metabolomics` does not light up `metabolic` / `metabolome` — different
  stems).
- **Method / topic** rep-paper titles come from the lazy Aurora fetch with no analyzer, so they
  currently render **plain (no highlight)**.
- Accepted limitation: exact/stemmed-token only; some titles show no highlight. Morphological
  matching is intentionally not built. If method/topic rep papers should later highlight verbatim
  query terms for page-wide consistency, that is a small separate follow-up (highlight the query
  tokens client-side in the card, which already has `q`).

---

## Invariants (keep these true)
- Presentation-only: never alter the query predicate, scoring, result set, facets, or counts.
- `SEARCH_RESULT_EVIDENCE`-off path is byte-identical to the legacy reason line (the `runReasonAgg`
  guard is what protects this).
- Every returned representative pub passes the scholar / family-overlay / ADR-005 suppression gates
  — top-N must not bypass a gate the single-pick had.
- No interactive element nested inside the card's name `<a>`; the disclosure button and `+N more`
  link live above the stretched-link overlay (`relative z-10`).
