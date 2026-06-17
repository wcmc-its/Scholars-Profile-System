# Implementation spec — Representative-papers disclosure + free-text pub evidence + chip-wrench fix

Branch `feat/topic-exemplar-hover` (worktree `~/worktrees/sps-method-hover`). All edits
happen IN THIS WORKTREE. Rides the existing `SEARCH_RESULT_EVIDENCE` (staging-on, prod-off)
+ `SEARCH_PEOPLE_SNIPPET_REPRESENTATIVE_PUB` (staging-on, prod-off) flags — no new flag,
no reindex, no edge deploy (the `/api/scholar/[cwid]/method-exemplar` route path is unchanged).

This SUPERSEDES the hover-reveal (#1060/#1064): the ▾ becomes a real clickable disclosure.

## User decisions (locked)
1. **Free-text pub evidence (#1).** For content queries that do NOT resolve to a concept
   (e.g. `16s rna`), show `N of M publications mention "<query>"` (with representative papers
   on the disclosure) instead of a weak partial bio highlight or "no specific match".
2. **Precedence — publications win on partial bio.** A bio highlight that matched only a
   SUBSET of a multi-word query loses to publication-mention evidence. A FULL-query bio match
   (or a single-token query) still wins, as today.
3. **Reveal = clickable chevron, COLLAPSED by default.** Replaces hover. Requires the card to
   stop being a single `<Link>` (stretched-link pattern below).
4. **Up to 3 representative papers** in the stack + `+N more in profile →`.
5. **Wrench (#3).** Remove the per-chip `Wrench` from `MethodChip` (the section label keeps it).

## Files & changes

### 1. `lib/api/result-evidence.ts` (contract + precedence)
- `EvidencePub` unchanged.
- `publications` kind: replace `pub?: EvidencePub` with `pubs?: EvidencePub[]` AND add
  `count?: number` (the numeric "N" for `+N more` math; the `text` keeps the human string).
- `SelectEvidenceInput.pub.tagged` / `.mention`: replace `pub?: EvidencePub` with
  `pubs?: EvidencePub[]` and carry `count: number`.
- Add `query?: string` to `SelectEvidenceInput` (the content query, for partial-bio detection).
- New exported pure helper `bioCoversQuery(bioHighlight: string, query: string): boolean`:
  tokenize `query` (lowercase, split on non-alphanumeric, drop tokens < 2 chars); extract the
  text inside every `<mark>…</mark>` in `bioHighlight` (lowercased, concatenated); return true
  iff EVERY query token appears in that marked text. A query with ≤1 significant token → true
  (single-token bio match is "full"). Empty/absent query → true (back-compat: no demotion).
- `selectEvidence` precedence, updated (tiers unchanged except bio split):
  1 name → 2 method → 3 topic → 4 `pub.tagged` → 4b `pub.concept`
  → **5 selfDescription ONLY IF `bioCoversQuery(bioHighlight, query)`**
  → 6 `pub.mention`
  → **6b selfDescription (partial bio falls here — still beats affiliation)**
  → 7 affiliation → 8 areas → 9 none.
  When building a `publications` evidence, pass `pubs` + `count` through.

### 2. `lib/api/method-exemplar-rank.ts` (top-N)
- Add exported `rankMethodExemplarList(candidates, currentYear, limit = 3): EvidencePub[]`:
  same filter + same lexicographic sort as `rankMethodExemplar`, return the top `limit` mapped
  to `EvidencePub` (`{ pmid, title, year }`).
- Keep `rankMethodExemplar` returning `rankMethodExemplarList(c, y, 1)[0] ?? null` (back-compat;
  `method-exemplar-rank.test.ts` still passes).

### 3. `lib/api/method-exemplar.ts` (loaders return top-N + total)
- `rankExemplarForPmids(cwid, pmids): Promise<{ pubs: EvidencePub[]; total: number }>`:
  after building `candidates`, set `total = candidates.length` (renderable safe candidates,
  pre-cap is fine), `pubs = rankMethodExemplarList(candidates, year, 3)`. Empty → `{pubs:[],total:0}`.
- `loadMethodExemplar` / `loadTopicExemplar` return `{ pubs, total }` (null-equivalent = `{pubs:[],total:0}`).

### 4. `app/api/scholar/[cwid]/method-exemplar/route.ts`
- Return `{ pubs, total }` (not `{ pub }`). Flag-off / error / no-selector → `{ pubs: [], total: 0 }`.

### 5. `lib/api/search.ts` (free-text mention + multi-pub parsing)
- Add `parseReasonTopHits(agg, limit = 3): RepresentativePub[]` (array form of `parseReasonTopHit`;
  iterate `agg.top.hits.hits`, map each via the same pmid/title/year/titleHtml logic, drop invalid).
  Keep `parseReasonTopHit` (used by `composeMatchReason`/legacy).
- `repPubTopHits.top_hits.size`: 1 → 3.
- **Gating fix (the core of #1).** Today the reason aggregation block (`reasonCounts`/`reasonReps`)
  runs only when `applyTopicTemplate && meshDescendantUis.length > 0 && provenanceParent.length > 0`.
  Change so it ALSO runs for content-shaped free-text queries with no resolved concept:
  - Compute `contentShape = applyTopicTemplate || applyHybridTemplate || queryShape === "restructured_msm"`
    (i.e. NOT `name_template`, NOT `department_template`).
  - Run the agg when `matchExplain && contentQuery.length > 0 && pageCwids.length > 0 && contentShape`.
  - Inside: the `tagged` sub-filter requires `meshDescendantUis.length > 0` — when empty, OMIT the
    `tagged` sub-agg entirely and compute `mention` only (so `tagged` count stays 0 / absent).
  - `mention` filter is unchanged (`multi_match` title+abstract `operator:"and"` on `contentQuery`).
- In `reasonReps`, store `tagged`/`mention` as `RepresentativePub[]` (via `parseReasonTopHits`).
  (Update the `reasonReps` Map value type to arrays; `composeMatchReason` legacy path still wants a
  single `pub` — give it `reps?.tagged?.[0]` etc. via a tiny adapter so the legacy reason is unchanged.)
- In `resolveHitEvidence`: build `pub.tagged`/`pub.mention` with `{ text, count, pubs }`
  (`pubs = reps?.tagged ?? []`, `count = Math.min(counts.x, pubCount)`). Pass `query: contentQuery`
  into `selectEvidence`. Only set `pub.tagged` when `counts.tagged > 0`, `pub.mention` when
  `counts.mention > 0` (unchanged thresholds).
- Do NOT change ranking, the result SET, facets, or counts — evidence is presentation-only.

### 6. `components/search/match-reason.tsx`
- `MatchAwareReason` (method/topic) + `MatchReason` (publications count line) gain disclosure props:
  `canExpand?: boolean`, `expanded?: boolean`, `onToggle?: () => void`, `panelId?: string`.
  When `canExpand`, render a real `<button type="button">` at the row end (`margin-left:auto`,
  `relative z-10`) with `aria-expanded={expanded}`, `aria-controls={panelId}`, a
  `ChevronDown`/`ChevronUp` (or rotate on `expanded`), and an `aria-label` like
  `Show representative papers` / `Hide representative papers`. `onClick` calls `onToggle` AND
  `e.preventDefault()/stopPropagation()` so it never triggers the stretched name-link navigation.
  Remove the old decorative `group-hover:rotate` ▾.
- New exported `RepresentativePapers({ papers, total, profileHref, status, panelId })`:
  the mockup's `REP. PAPERS` block — a small uppercase `REP. PAPERS` label + a column of up to 3
  italic titles via `PubTitle` + ` (year)` muted; when `total > papers.length`, a
  `+{total - papers.length} more in profile →` `<Link>` (`relative z-10`, stops propagation) to
  `profileHref`. While `status==="loading"` show a muted "finding representative papers…" (aria-hidden).
  `MethodExemplarLine` (single-paper hover) is REMOVED (superseded).

### 7. `components/search/result-evidence.tsx`
- Thread disclosure props through `<ResultEvidence>` (`canExpand`, `expanded`, `onToggle`, `panelId`)
  to `MatchAwareReason` (method/topic) and the `publications` `MatchReason`.
- `publications` case: `canExpand = (evidence.pubs?.length ?? 0) > 0`.

### 8. `components/search/people-result-card.tsx` (the structural refactor)
- **Stretched-link card.** Replace the single `<Link>` wrapper with a `<div className="group relative …">`
  (keep the grid + hover bg). The NAME becomes the profile link:
  `<Link href={profilePath(hit.slug)} onClick={handleClick} className="… after:absolute after:inset-0 after:content-['']">{hit.preferredName}</Link>`
  so the whole card stays clickable. Every other interactive element (chevron button, `+N more` link)
  sits ABOVE the overlay with `relative z-10`. The analytics `handleClick` beacon moves onto the name link.
  Keep `onMouseEnter`/`onFocus` off (no longer hover-driven).
- **Disclosure state.** `const [expanded, setExpanded] = useState(false)`. `panelId = useId()`.
  - method/topic: lazy-fetch on FIRST expand (not hover). `exemplarQuery` as today (`family=`/`topic=`).
    `fetch(...).then(r => r.json()).then((d:{pubs:EvidencePub[]; total:number}) => …)`. Store
    `{pubs,total}`. `canExpand` = `!!exemplarQuery` (optimistic; if fetch returns empty, render an
    empty stack / collapse — never a dead control: if `status==="done" && pubs.length===0`, hide chevron).
  - publications: pubs are INLINE (`evidence.pubs`), `total = evidence.count ?? evidence.pubs.length`.
    No fetch. `canExpand` = `pubs.length > 0`.
  - `onToggle` flips `expanded`; on first open for method/topic, trigger the fetch.
- Render order inside the text column: name → title → dept → `<ResultEvidence … disclosure props>`
  → (when `expanded`) `<RepresentativePapers papers total profileHref={`${profilePath(hit.slug)}#publications`} status panelId/>`.
- LEGACY path (no `hit.evidence`) is unchanged EXCEPT the wrapper is now the stretched-link div
  (the legacy snippet lines are non-interactive, so they're fine under the overlay).

### 9. `components/search/research-areas-row.tsx` (#3 wrench)
- In `MethodChip`, DELETE the leading `<Wrench …/>` element. Keep the rust tint, the name, and the
  `Users` count. (The `Wrench` import stays — still used by the section-label icon in `ResearchAreasRow`.)

## Tests to update / add (run with `--maxWorkers=4`)
- `result-evidence-select.test.ts` — new precedence (partial-bio→pubs, full-bio→bio), `bioCoversQuery`,
  `pubs`/`count` shape on `publications`.
- `result-evidence-card.test.tsx` — `publications` renders the count line; chevron present when `pubs`;
  `RepresentativePapers` stack + `+N more`.
- `method-exemplar-rank.test.ts` — add `rankMethodExemplarList` (ordering, limit, empty).
- `method-exemplar-loader.test.ts` — loaders return `{pubs,total}`; gates unchanged.
- `people-result-card-method-exemplar.test.tsx` + `people-result-card-representative-pub.test.tsx` —
  click-to-expand (not hover), fetch shape `{pubs,total}`, stretched-link (name is the link, chevron
  is a button), stack render. (Rename/replace the hover assertions.)
- `search-people-result-evidence.test.ts` / `search-match-reason-representative-pub.test.ts` —
  free-text (no concept) now yields `publications:mention` with `pubs`; `parseReasonTopHits`; the
  `tagged` sub-agg omitted when no descriptor; legacy `composeMatchReason` unchanged.
- `research-areas-row.test.tsx` — method chip no longer renders a per-chip wrench.
- Search the suite for other refs to `evidence.pub`/`{ pub }` from the route/`MethodExemplarLine` and fix.

## Guardrails
- No `git commit`/`push`/`gh pr merge` — leave the worktree dirty for review.
- Assert `git rev-parse --show-toplevel` == the worktree before editing.
- Presentation-only: do not alter the query predicate, scoring, result set, facets, or counts.
- Keep the `SEARCH_RESULT_EVIDENCE` off-path byte-identical (no evidence field, legacy chain).
