# Evidence drawer (level-2) — unblock scope

Verified against `origin/master` @ `e09605dc`, 2026-07-14. Every claim below carries a `file:line` read at that commit.

## Read this first: the fixes are not sponsor-only

The drawer renders inside `EvidenceLine`, and `EvidenceLine` is shared:
`components/search/evidence-line.tsx` is imported by **`components/search/people-result-card.tsx`** (the public People card) *and* `components/edit/sponsor-match-panel.tsx` (the auth-gated console). Its data comes from `app/api/search/key-paper/route.ts`, which is explicitly "the same public, unauthenticated read posture" (route.ts:19) — there is no session check on the `GET` (route.ts:27).

So every datum the drawer needs has to be widened in `lib/api/search.ts` / the pubs index / `components/search/*`, and every one of those lands on the **public People card** the moment it ships. That is why they are out of scope for a sponsor-only PR: they need their own review, their own flag, and their own staging look. The per-element public surface is named in the table below.

## What was cut and why

The level-2 drawer (per-artifact PUB/GRANT rows with venue, role, a 0..1 strength bar, an "also supports" cross-link, a per-year sparkline with a grant-active overlay, plus Group-by / Sort / "Senior author only") was cut from the current PR. The grounding pass found that the drawer's fields are not in the payload the browser receives: the strength score is computed and discarded, venue is indexed but not selected, and per-person authorship role is not serialized. Rather than widen the shared public-search contract inside a sponsor-scoped PR, the drawer is deferred and the unblock is scoped here.

## Corrections to the grounding pass

The tree contradicts the handoff on three points, all in the direction of **less work than believed**.

**Grants are not missing — they already ship on the public card.** The claim was that `SponsorCandidate` has zero grant fields (true — `lib/api/sponsor-match-contract.ts` has none, and `lib/api/sponsor-match-spine-run.ts:262` does set `grantProminence: false`), and the inference drawn was that grant artifacts are unreachable. They are not. `EvidenceGrant` (`lib/api/result-evidence.ts:47-61`) carries `projectId`, `title`, `titleHighlight`, `sponsor`, `startYear`, `endYear`, `isActive`, and it is **wired, not inert**: `app/api/scholar/[cwid]/grants/route.ts:111-121` constructs it from live funding hits, filtered per-person (`investigator: [cwid]`, route.ts:105) and per-concept (`descriptorUis` / `label`, route.ts:83-100) — the exact shape the drawer wants. The funding index is concept-tagged with the *same field name as the pubs index, by design*: `meshDescriptorUi` (`lib/search.ts:566`, commented "deliberately the same field name … so one `terms` query template hits both"), plus `fundedPubMeshUi` (`lib/search.ts:572`), `wcmInvestigatorCwids` (`lib/search.ts:605`), and date-mapped `startDate`/`endDate` (`lib/search.ts:541-542`). The PUB/GRANT badge and the grant-active bar are substantially **built**, behind `SEARCH_FUNDING_CONCEPT_GRANTS` (default off, `lib/api/search-flags.ts:230`).

**Authorship role needs no ETL.** The claim was that `authorPosition` "is not on the pubs index at all" and is "the only item needing ETL". Both halves are wrong. The pubs index already carries `wcmAuthorPositions` (keyword, `lib/search.ts:438`) and a **nested** `wcmAuthors` with `cwid` + `position` (`lib/search.ts:456-464`). The per-person datum is already in Aurora twice over — `PublicationAuthor.position/totalAuthors/isFirst/isLast` (`prisma/schema.prisma:965-968`) and `PublicationTopic.authorPosition` (`prisma/schema.prisma:1462`) — and the sponsor engine reads the latter straight from Aurora (`lib/api/sponsor-match.ts:193-195`). Decisively: `buildPublicationDoc` **already has `isFirst`/`isLast`/`totalAuthors` in memory** and uses them (`lib/search-index-docs.ts:582-589`) to build the paper-level union, then throws them away instead of putting them on the per-author object (`lib/search-index-docs.ts:547-552`); they arrive via `PUBLICATION_INDEX_INCLUDE`'s `include` on `authors` (`lib/search-index-docs.ts:361-364`), which loads all scalars. This is a doc-builder + mapping change + reindex. Zero ETL.

Consequence: **first-author is queryable today** (nested `wcmAuthors.position == 1`); **senior-author is the only gap**, because `totalAuthors`/`isLast` are absent from the nested object, so `position` alone cannot prove "last". The existing `wcmAuthorPositions` keyword is a **paper-level union** across all WCM authors (`lib/search-index-docs.ts:580-590`) — on a paper with a WCM first-author and a WCM middle-author it holds `["first","middle"]` and cannot attribute either to a given person. Using it for a per-person "Senior author only" filter would be wrong.

**The sparkline needs no new data.** The claim that "no per-year counts exist anywhere" is true *as a stored field* — the people doc carries only `pubCountBucket ∈ {0..4}` (`lib/search-index-docs.ts:1331`; note the file is `lib/search-index-docs.ts`, not `lib/api/search-index-docs.ts` as the handoff had it), which is an autocomplete tiebreak, not a histogram. But the pubs index maps `year` as `{ type: "integer" }` (`lib/search.ts:380`) — aggregatable — and already carries `wcmAuthorCwids` (`lib/search.ts:444`) and `meshDescriptorUi`. A per-year, per-person, per-concept histogram is one `terms` agg on `year` against filters that `fetchKeyPaper` already builds. No reindex.

Confirmed as written in the handoff (line refs corrected): the blend score is computed and discarded (`lib/api/search.ts:533-555`; the final `.map((x) => x.h)` at :554 drops it); `_source` selects only `pmid,title,year,citationCount` (`lib/api/search.ts:641` — not :354, which is the `RepresentativePub` type at :354-359, and which indeed has no journal field); the exclude dedup is real (`components/search/evidence-line.tsx:131-132` → `must_not: [{ terms: { pmid: exclude } }]` at `lib/api/search.ts:614`); representative papers are capped at 3 (`lib/api/search.ts:403-405`, applied at :680) and grants at `GRANT_CAP = 3` (`app/api/scholar/[cwid]/grants/route.ts:43`).

## Element-by-element

| Drawer element | Datum required | Where it dies today | What it would take | Blast radius on public search | Size |
|---|---|---|---|---|---|
| Strength bar (0..1) | per-artifact blend score | `lib/api/search.ts:554` — `rankKeyPaperHitsByBlend` computes the blend (:535-545) and returns only reordered hits; score never enters `RepresentativePub` (:354-359) | Return `{hit, score}`, carry `strength` onto `EvidencePub` (`lib/api/result-evidence.ts:37-43`), normalize 0..1 | Additive field on `/api/search/key-paper` (public, unauth). Renders only where UI reads it. No reindex, no new query | S |
| Venue / journal | `journal` on the pub hit | `lib/api/search.ts:641` — `_source` omits it. Field **is** indexed (`lib/search.ts:379`, text + keyword) and emitted (`lib/search-index-docs.ts:635`) | Add `"journal"` to `_source`; add field to `RepresentativePub`/`EvidencePub` | Same route, same surfaces. Additive. `export-publications.ts` / `word-bibliography.ts` set their own `_source` — unaffected | S |
| PUB/GRANT badge | grant artifacts per concept | **Not dead.** `EvidenceGrant` is built and wired (`app/api/scholar/[cwid]/grants/route.ts:111-121`), gated off by `SEARCH_FUNDING_CONCEPT_GRANTS` (`lib/api/search-flags.ts:230`) | Flip + verify the flag; render both artifact kinds in one list | Public People card "Key funding" disclosure changes for **all** users on flip. Also interacts with `SEARCH_FUNDING_MESH_GATE` (`lib/api/search-flags.ts:210-212`; `fundedPubMeshUi` requires a funding reindex first) | S |
| Grant-active bar | grant start/end/active | **Not dead.** `startYear`/`endYear`/`isActive` already on `EvidenceGrant` (`lib/api/result-evidence.ts:57-60`) | Render only | Same as above — rides the same flag | S |
| Per-year sparkline | per-year pub counts | No stored histogram; people doc has only `pubCountBucket` 0..4 (`lib/search-index-docs.ts:1331`) | One `terms`/histogram agg on `year` (`lib/search.ts:380`, integer ⇒ aggregatable) under the filters `fetchKeyPaper` already builds (`lib/api/search.ts:609-629`) | **New aggregation on the public search path.** Latency is the risk, not correctness. Cache alongside `cachedReasonAgg` (:631) | M |
| Authorship role + "Senior author only" | per-person `isLast`/`totalAuthors` | Nested `wcmAuthors` carries `cwid` + `position` only (`lib/search.ts:456-464`); builder has `isFirst`/`isLast` and discards them (`lib/search-index-docs.ts:582-589`) | Emit `isFirst`/`isLast` (or `totalAuthors`) on the nested author object (`lib/search-index-docs.ts:547-552`) + mapping + **full pubs reindex** | Mapping change + reindex touches the whole Publications tab (the Authorship facet reads `wcmAuthorPositions`, `lib/search.ts:438`). The reindex is the risk; the code is ~2 lines | M |
| "also supports \<other concept\>" | a paper's membership in >1 concept line | **Destroyed by design** — `evidence-line.tsx:131-132` sends `exclude=<claimedPmids>`; `lib/api/search.ts:614` drops them at query level | Remove the dedup — see "Do not do this" | Would change what the **public** card shows: one paper under multiple concepts | L / no |
| Group-by, Sort | nothing new | — | Client-side over the loaded rows | None, once the fields above land | S |

## Dependency order

Ranked by drawer-per-unit-of-public-risk.

**1. Serialize what `fetchKeyPaper` already computes — strength + journal.** *This is the one change that buys the most drawer for the least public-search risk.* It is a single function (`lib/api/search.ts:533-555`, `:641`) plus two additive fields on `EvidencePub`. No reindex, no new aggregation, no new query, no extra latency — the blend is already being computed on every call and thrown on the floor, and `journal` is already sitting in the index unread. It unlocks two of the seven elements outright, and the strength bar is the only element in the whole mockup that shows the user something the system knows and currently refuses to say. Do this first, and do it alone.

**2. Flip and verify `SEARCH_FUNDING_CONCEPT_GRANTS`.** Two more elements (PUB/GRANT badge, grant-active bar) for a flag flip, because the route and contract already exist (`route.ts:111-121`). Cheap, but it is a *behavior* change on the public Key-funding disclosure, so it needs its own staging look and its own before/after. Check `SEARCH_FUNDING_MESH_GATE` state first (`lib/api/search-flags.ts:210-212`) — flipping that to `fundedPubMeshUi` before the funding reindex empties concept results.

**3. Year-histogram aggregation → sparkline.** Needs no data that does not exist, but it adds a query to a public, latency-sensitive path. Gate it, cache it, measure it.

**4. Nested per-author `isLast`/`totalAuthors` → role + "Senior author only".** The code is trivial; the **full pubs reindex** is the cost and the risk. Worth doing only if role display is actually wanted — and note first-author needs nothing (nested `position == 1` works today), so if "first author" satisfies the use case, skip this entirely.

**5. "also supports" — not worth doing at all.** See below. It is the single most expensive element and the only one that degrades the public product.

The honest reading of this ranking: items 1 and 2 are a few days and deliver four of the seven elements. Items 3 and 4 are the long tail. Item 5 should never ship.

## Do not do this

**Do not remove the `exclude` dedup to get "also supports".** It looks like a two-line deletion (`evidence-line.tsx:131-132`, `search.ts:614`) and it is a trap. The dedup is a deliberate product decision, not an oversight: each `EvidenceLine` claims its pmids into a shared `claimedPmids` set (`evidence-line.tsx:116`, `:137`) and passes them as `exclude`, so the sibling line pulls its top-N *from the non-claimed pool* rather than fetching and post-filtering — which, per the comment at `lib/api/search.ts:567-570`, was chosen specifically so a line "under-fills from the remaining pool rather than resolving empty". Removing it means the same paper renders under two or three concept lines **on the public People card**, which is the exact repetition the design eliminated. If "also supports" is genuinely wanted, it must be built as a *cross-reference on an otherwise-deduped list* (compute the other concepts a shown pmid belongs to and label it), never by widening the candidate pool. That is a different, larger piece of work than it appears.

**Do not use `wcmAuthorPositions` for a per-person role or a "Senior author only" filter.** It is a paper-level union across every WCM author on the paper (`lib/search-index-docs.ts:580-590`) and cannot attribute a role to a person. It will look right on single-WCM-author papers and be silently wrong on collaborations — the worst possible failure shape.

**Do not raise the cap of 3 casually.** Both papers (`lib/api/search.ts:403-405`) and grants (`route.ts:43`) are capped at 3. Raising the cap to fill a drawer multiplies the public search path's fetch and render cost, and the pool is fetched lazily on click for a reason.

**Do not assume the sponsor console is the blast radius.** `EvidenceLine` is shared with the public card (`components/search/people-result-card.tsx`) and `/api/search/key-paper` is unauthenticated (`route.ts:19`). There is no such thing as a sponsor-only change to these files.

## What the drawer would be worth

Straight answer: **not much, as drawn — and it should not be built.**

The payload is three papers (`lib/api/search.ts:403-405`) and three grants (`route.ts:43`). Group-by (Type/Period/Role/None), Sort (Strength/Recency), and a "Senior author only" filter are controls for a list of **six rows at most**. You do not need faceted grouping to read six rows. Those three controls — half the mockup's chrome — are dead weight unless the caps are also raised, and raising the caps is precisely the change that costs public-search latency. The drawer's information architecture is sized for a dataset the product deliberately does not fetch.

Strip the chrome and what is actually new versus the inline `EvidenceLine` disclosure it would replace? The inline disclosure already shows up to three representative papers with query highlighting and an "N of M publications" count, and already shows concept-matched grants with sponsor and years. The genuinely new information is: **per-artifact strength**, **venue**, and **authorship role**. All three are field-level additions to the *existing* inline row. None of them require a drawer.

Recommendation: do item 1 (strength + venue on the existing inline disclosure) and item 2 (grants flag), render them in `EvidenceLine`, and drop the drawer. That captures the real value — surfacing a score the system already computes and discards — at a fraction of the cost, without a reindex, without a new aggregation on the public path, and without touching the dedup that keeps the public card clean. Revisit the drawer only if the caps are raised for an unrelated reason, at which point grouping starts to earn its keep.
