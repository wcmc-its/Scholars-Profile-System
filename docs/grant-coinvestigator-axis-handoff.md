# Grant co-investigator axis — research handoff (collaboration network Phase 2)

**Status:** ✅ IMPLEMENTED on `feat/center-collab-grant-axis` · research dated 2026-06-19
**Parent:** `docs/cancer-center-collaboration-network-spec.md` (§10 Phase 2), issue #1137
**Prereq:** Phase 1 (publication co-authorship) shipped — read that component first:
`components/center/center-collaboration-tab.tsx`, `lib/center-collaboration/graph.ts`,
`lib/api/center-collaboration.ts`.

> **Implementation note (§9 decisions taken).** Built per this handoff's recommended
> defaults: (1) **`awardNumber`** join key; (2) umbrella handling = **mechanism
> exclude-list (`P30/P50/U54/UL1/S10/KL2/TL1`) OR member-count ≥ 12** — the floor
> catches null-mechanism foundation umbrellas like PICI that the mechanism list
> alone misses — plus Newman down-weighting; (3) **active-only default on**; (4)
> **"Both" = option-C relationship color**; (5) node size = **co-investigator
> degree**; (6) shipped behind a **separate sub-flag** `CENTER_COLLABORATION_GRANT_AXIS`
> (staging-on/prod-off) so the axis soaks independently. The grant-visibility gate
> (§5.6) uses `resolveActiveGrantSuppression`, dropping suppressed rows before
> grouping. Pure helpers in `lib/center-collaboration/grants.ts`; no schema change,
> no reindex. **Year filter uses span OVERLAP** (a grant active across the window
> is kept), unlike the point-in-time paper filter. Re-run the §3/§4 probes against
> the target env and complete the §8 render-verify (incl. a suppressed-grant
> no-edge check) before flipping the prod flag.

---

## 1. Goal

Add **grant co-investigation** as a second relationship axis to the Cancer Center
collaboration network: two members are linked when they appear on the **same grant
award**. Surface it alongside the existing publication co-authorship axis via an
axis toggle (Publications / Grants / Both).

This doc is grounded in a real feasibility probe (below) so the implementer starts
from facts, not guesses. **Re-run the probe before building** — the data moves.

## 2. Data model (what exists)

`Grant` (`prisma/schema.prisma`) is **per-person**: one row per (scholar, award),
with `externalId @unique`. There is **no native multi-PI edge** — a grant with a PI
and three co-Is at WCM is four rows sharing an award identifier. So the co-investigator
network must be **inferred by grouping rows on a shared award key**.

Relevant columns: `cwid`, `role` (`PI | Co-PI | Co-I | PI-Subaward | Key Personnel`),
`awardNumber` (sponsor award no., e.g. "5 P50 CA211024-05"), `applId` (RePORTER
appl id, NIH-only), `mechanism`/`nihIc` (NIH-derived), `isSubaward`, `primeSponsor`,
`startDate`/`endDate`, `funder`.

## 3. Feasibility probe — Meyer Cancer Center (staging/local DB, 2026-06-19)

> Methodology: active publicly-displayed members (same gate as Phase 1) → their
> `Grant` rows → group by candidate award key → pairwise edges. Two throwaway
> scripts (`/tmp/_grant-probe.ts`, `/tmp/_grant-probe2.ts`); re-create and re-run.

**Coverage**
| metric | value |
|---|---|
| active members | 332 |
| members with ≥1 grant | **248 / 332 (75%)** |
| grant rows | 3,071 (986 active) |
| `awardNumber` present | **3,066 / 3,071 (99.8%)** |
| `applId` present | 1,128 / 3,071 (37%, NIH-only) |
| roles | PI 1220 · Co-I 840 · PI-Subaward 534 · Key Personnel 475 · Co-PI 2 |

**Inferred network, by join key**
| join key | shared awards (≥2 members) | edges | within-program | connected members |
|---|---|---|---|---|
| **`awardNumber`** | 406 | **986** | 394 | **206 / 332** |
| `applId` | 212 | 970 | 366 | 172 |
| `coreProjectNum` (derived) | 256 | 657 | 282 | 172 |

**Active-only** (`endDate ≥ today`, cap 25): **593 edges, 164 connected members**.

→ **`awardNumber` is the join key** (99.8% coverage vs 37% for `applId`). The grant
network density (~986 edges, 206 connected) is comparable to the publication network
(~1,256 within-program edges), so it is **worth building**.

## 4. KEY FINDING — the infrastructure-grant clique problem

The largest shared awards are **umbrella / infrastructure grants**, not real
co-investigation:

| members | award | sponsor |
|---|---|---|
| 16 | `2 UL1 TR002384-06` | NCATS (CTSA — institutional translational grant) |
| 15 | `PICI 235170-01` | Parker Institute for Cancer Immunotherapy |
| 14 | `5 P50 CA211024-05` | NCI (SPORE program-project) |
| 14 | `1 UL1 TR002384-01` | NCATS (CTSA) |
| 9 | `1 NU58DP007916-01` | CDC |
| 7 | `1 U54 CA280808-01` | NCI (center grant) |

A CTSA `UL1`, a cancer-center `P30`, a SPORE `P50`, or a `U54` lists many members who
share institutional infrastructure but do **not** co-investigate in any meaningful
sense. Grouping naively makes each a clique (16 members → 120 edges) that drowns out
real ties. This is the grant analog of Phase 1's consortium-paper problem, but it is
**semantic, not just size** — the fix is not only a member cap.

Edge counts by cap: none/25 → 986 · 15 → 880 · 10 → 647 (no single award exceeds 25
members today, so a raw size cap barely helps).

**Options (decide before building):**
1. **Mechanism exclude-list** — drop `UL1`, `P30`, `P50`, `U54`, `S10`, `KL2`, `TL1`
   (training/center/instrument mechanisms) from edge-building, keeping R/U01/DP/DoD/
   foundation awards. Most targeted; needs a curated list (derive from `mechanism`
   for NIH; for non-NIH, parse `awardNumber` prefix). **Recommended default.**
2. **Newman `1/(k-1)` weighting** (already in `graph.ts`) — down-weights big awards
   without removing them. Softer; a P50 still draws a faint clique.
3. **Member cap** — weakest here (max award = 16 < 25).
4. **Active-only default** — orthogonal but halves noise (986 → 593).

Recommendation: **(1) + (2) + active-only default**, all surfaced as controls so the
omission is never silent (mirror Phase 1's "N papers omitted" line).

## 5. Open research questions

1. **Renewal/segment dedup.** Is `2 UL1 TR002384-06` the same award as
   `1 UL1 TR002384-01`? `awardNumber` distinguishes budget years; the *project* is the
   same. Decide whether to collapse to `coreProjectNum` (loses the 99.8% coverage —
   non-NIH awards don't parse) or keep `awardNumber` (over-segments renewals). Probe:
   how many member-pairs are merged by core-num collapsing?
2. **Role semantics.** Undirected (any two on the award) vs directed (PI → Co-I)? The
   `Co-PI` role is unused (2 rows), so PI-ness is the only hierarchy signal. v1:
   undirected. Future: arrow/ring for PI. Should Key Personnel count as a tie?
3. **Subawards.** 534 `PI-Subaward` rows — a WCM person holding a subaward of a prime
   elsewhere. Two WCM members on the same `awardNumber` where one is prime-PI and one
   is subaward-PI is a real tie; confirm `awardNumber` is shared across prime/sub at WCM.
4. **Active vs historical** default (986 vs 593). Recommend active-default with a
   "include expired" toggle.
5. **Edge weight.** # shared awards? Total/blended? Direct-cost $ (not in schema)?
   Recommend # shared awards (parallels pub count).
6. **Grant visibility / suppression.** Funding has its own gating —
   `resolveActiveGrantSuppression` / `loadPublicationSuppressions` in
   `lib/api/manual-layer.ts`, and the public Funding section already renders grants.
   Confirm a suppressed grant is dropped from edge-building so the graph never reveals
   a grant the profile hides. (Pubs reuse `deleted_at`/`status`; grants need their own
   gate.) **This is the load-bearing privacy task for the public surface.**
7. **Overlap with the pub axis** — see §6 "Both".

## 6. UI review (the thoughtful part)

### 6.1 Axis toggle
Add a segmented control next to the existing **People / Programs** view toggle:

```
View:  [ People | Programs ]      Axis:  [ Publications | Grants | Both ]
```

- **Publications** — today's behavior.
- **Grants** — same People/Programs renderer, edges = shared awards. The program
  picker, year range (grant `startDate`/`endDate`), Min-shared slider, hide-unconnected,
  re-layout, exports all carry over unchanged — reuse the Phase 1 control bar.
- **Both** — overlay (see 6.2).

### 6.2 Edge encoding for "Both" — three options

```
A) TWO EDGES           B) BLENDED WEIGHT        C) RELATIONSHIP COLOR  ← recommended
   A ═══ B  (pub)         A ═══ B                  gray  = pub only
   A - - - B  (grant)     weight = pubs+grants     gold  = grant only
   (clutter, 2 lines)     (conflates types)        green = BOTH (the strong ties)
```

- **A. Two parallel edges** (solid = pubs, dashed = grants). Honest but cluttered;
  vis-network can draw both with a curvature offset.
- **B. Single blended edge** (weight = pubs + grants). Clean but conflates a paper
  with a grant.
- **C. Single edge colored by relationship type** — gray (pub only), gold (grant
  only), **green (both)**. One edge per pair; the *green* edges are the analytically
  interesting ones — pairs who both publish and fund together are the real
  collaborations. **Recommended.** Legend gains a 3-row edge key.

Lead with the **single-axis toggle** (simplest, ships first); add **Both = option C**
as a fast-follow.

### 6.3 Node size & tooltip
- People view, Grants axis: size = **# co-investigators** (degree from shown edges) —
  consistent with the pub axis's "# co-authors". Offer "# grants" as an alternate.
- Tooltip becomes axis-aware:
  `Jane Doe · Cancer Therapeutics · 12 co-authored papers · 3 shared grants`.

### 6.4 New controls (Grants/Both only)
- **"Exclude center & training grants"** checkbox (default **on**) — the §4 mechanism
  filter. Footer states "N umbrella awards (P30/P50/UL1…) excluded", never silent.
- **"Active grants only"** checkbox (default **on**).
- Reuse Min-shared, year (grant dates), program picker, hide-unconnected.

### 6.5 Program rollup, Grants axis
Cross-program **co-funding** — programs linked by shared awards spanning them. Same
`buildProgramEdges` shape; just feed grant groups instead of paper groups.

### 6.6 Interaction with the program picker
Unchanged — node color stays program; the picker filters to one program's grant
network. A member with pubs in-program but no grants shows as unconnected under the
Grants axis (hide-unconnected handles it).

## 7. Recommended implementation sketch

Keep the one-payload, client-builds-edges architecture.

- **Payload** (`lib/api/center-collaboration.ts`): add `awards: [{ awardId, year,
  m: number[] }]` next to `papers`, built from `Grant` grouped by `awardNumber` over
  the SAME gated member set, with the grant-visibility gate (§5.6) applied first, and
  a per-award `mechanism`/excluded flag for the §4 filter. Mirror `CollabPaper`.
- **graph.ts**: `buildPeopleEdges`/`buildProgramEdges` are already group-agnostic —
  pass `awards` instead of `papers`. Add a `mechanismExclude`/`activeOnly` filter step.
  Add unit tests mirroring the existing ones.
- **Component**: an `axis` state ("pubs" | "grants" | "both"); `computed` picks the
  group set (or merges for "both" → option C edge coloring). Most controls unchanged.
- **No schema change.** App-only, no reindex. Same flag (`CENTER_COLLABORATION_NETWORK`)
  or a sub-flag if shipping the axis separately.

## 8. Validation plan
- Re-run the §3/§4 probes against the target env; confirm coverage + clique list.
- Unit-test grant edge-building + mechanism filter + active filter (deterministic).
- Render-verify each axis on staging through CloudFront (Playwright snapshot), incl.
  the suppression gate: pick a suppressed grant and confirm its pair has no edge.

## 9. Decisions needed from product
1. Join key — `awardNumber` (recommended) vs collapse renewals to core project num.
2. Umbrella-grant handling — mechanism exclude-list (recommended) vs weighting only.
3. Active-only default — yes (recommended) / no.
4. "Both" edge encoding — option C relationship-color (recommended) / A / B.
5. Node size metric under Grants — co-investigators (recommended) / grant count.
6. Ship grants behind the existing flag, or a separate `..._GRANTS` sub-flag for a
   staged rollout.
