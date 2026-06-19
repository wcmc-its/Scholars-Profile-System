# Cancer Center collaboration network — spec

**Status:** Draft for approval · **Owner:** Paul Albert · **Date:** 2026-06-19
**Flag:** `CENTER_COLLABORATION_NETWORK` (staging-on / prod-off, env-conditional)
**Gate:** data-driven — appears only for centers that have a `CenterProgram` taxonomy (today: Meyer Cancer Center). No hardcoded center code, matching the existing `CenterProgram`/`CENTER_METHODS_FACET` precedent.

---

## 1. Motivation

In 2021 the Cancer Center commissioned a one-off **co-authorship network** of its
faculty (`~/Dropbox/Index/Publications Reporting/Network visualization - PSAC/`).
It was a `pyvis` → `vis-network` static HTML file: nodes = faculty (colored by an
ad-hoc category, sized by a count), edges = "_N_ publications co-authored." It was
hand-built from a spreadsheet, manually recolored, and exported per-filter
("All", "COVID") into standalone HTML dropped into Keynote slides.

This spec **productizes** that artifact: an on-demand, interactive,
**program-colored** collaboration graph computed from live data, rendered as a
public tab on the Cancer Center page, with controls and a standalone-HTML export
that reproduces the slide-ready legacy workflow.

## 2. Locked decisions (from requirements review)

| Question | Decision |
|---|---|
| What is a node? | **People, colored by program** (CB/CGE/CPC/CT/ZY), with a **program-rollup toggle** (programs become the nodes; edges = cross-program collaboration). |
| Audience / placement | **Public tab on `/centers/[slug]`.** Must include only publicly-displayed scholars. |
| Output form | **Both** — live interactive in-app view **and** one-click "Download standalone HTML" (+ PNG) for slides. |
| Axes | **Phase 1 = publication co-authorship.** Grants (co-investigator) = **Phase 2.** |

## 3. Data model — it already exists

No schema changes for Phase 1. Everything derives from existing tables (verified
against `origin/master prisma/schema.prisma`).

### 3.1 Members & program coloring
- `CenterMembership(centerCode, cwid, programCode, startDate, endDate)` — the
  roster. Active predicate = `isCenterMembershipActive(start, end, today)` from
  `lib/api/centers.ts` (§3.3; nulls = open). **Reuse it; do not re-derive.**
- `programCode` (CB/CGE/CPC/CT/ZY, or `null` = "Unclassified") → **node color.**
  A membership carries exactly one program, so each node has exactly one color.
- `CenterProgram(centerCode, code, label)` → legend labels + the data-driven gate.

### 3.2 Co-authorship edges
- `PublicationAuthor(pmid, cwid, isConfirmed)` — one row per WCM author of a PMID.
  Source of truth for co-authorship (same join the profile pages use).
- Build: for the active publicly-displayed member set `M`, select confirmed
  `PublicationAuthor` rows with `cwid IN M`; group by `pmid`; any PMID with ≥2
  distinct members in `M` is a **co-authored paper** linking those members.
- `Publication.year` rides along for the date-range control.

### 3.3 Privacy gate (load-bearing — this is a PUBLIC surface)
Reuse the exact public gate already in `lib/api/centers.ts`:
```
scholar where: { cwid: { in: activeCwids }, deletedAt: null, status: "active" }
```
plus `isPubliclyDisplayed(role)` from `lib/eligibility.ts`. Consequences:
- **#536-hidden faculty and soft-deleted doctoral students never appear** as nodes
  (they fail `deletedAt: null` / `isPubliclyDisplayed`), and therefore never appear
  in any edge.
- Non-WCM authors and non-members are **not** nodes (no `cwid` / not in `M`).
- The only personal datum emitted is the scholar's display name — already public on
  the center roster. No emails, no hidden attributes.

## 4. Architecture

```
                 ┌──────────────────────────────────────────────┐
  /centers/[slug]│  CenterCollaborationTab (client, dynamic)     │
   (cacheable    │   • vis-network render (dynamic import,        │
    page)        │     ssr:false)                                │
                 │   • controls: program legend/filter, min-edge │
                 │     slider, year range, person search,        │
                 │     people↔program toggle, physics freeze,    │
                 │     export PNG / standalone HTML, reset        │
                 │   • ALL filtering is client-side on one payload│
                 └───────────────┬──────────────────────────────┘
                                 │ fetch once
                 ┌───────────────▼──────────────────────────────┐
   GET /api/centers/[slug]/collaboration   (force-dynamic)       │
                 │  flag-gated · slug-validated · public gate    │
                 │  returns the WHOLE graph payload (§5)         │
                 └───────────────┬──────────────────────────────┘
                                 │
                 ┌───────────────▼──────────────────────────────┐
   lib/api/center-collaboration.ts  buildCenterCollaboration()   │
                 │  active members → publicly-displayed → papers │
                 └──────────────────────────────────────────────┘
```

**One payload, client-side everything.** The API returns the full graph for the
center once; the route reads only the path slug (no query params), so it needs **no
edge query-allowlist change** — unlike the methods-facet members route which reads
`?method=`. All controls (year filter, thresholds, program rollup) recompute in the
browser from the payload. This keeps the route simple, makes the standalone export a
freebie (it embeds the same JSON), and makes the date-range slider instant.

**Uncacheable + private.** Route is `export const dynamic = "force-dynamic"` →
Next emits `Cache-Control: private, no-store` → CloudFront never caches it (same
posture as `app/api/units/[kind]/[code]/members/route.ts`). It contains only
already-public names, but staying uncacheable keeps roster/membership changes live
and avoids a stale per-center cache. No new edge behavior is required because no
query params are read; confirm against the #490/#624 EdgeStack guard in review.

## 5. API payload

`GET /api/centers/[slug]/collaboration` →

```jsonc
{
  "center": { "code": "meyer_cancer_center", "name": "Meyer Cancer Center" },
  "programs": [
    { "code": "CPC", "label": "Cancer Prevention & Control", "color": "#…" },
    { "code": null,  "label": "Unclassified",                "color": "#…" }
  ],
  "nodes": [
    { "i": 0, "cwid": "cym2003", "name": "Cynthia Magro, MD",
      "programCode": "CB", "slug": "cynthia-magro", "pubCount": 412 }
  ],
  // Compact per-paper member groups (member INDICES into nodes[]).
  // The client builds BOTH the people-edge set and the program-edge set
  // from this, and applies year / threshold filters live.
  "papers": [
    { "pmid": "33144353", "year": 2020, "m": [0, 4, 9] }
  ],
  "generatedAt": "2026-06-19T…Z"
}
```

- `papers[].m` is the set of in-center, publicly-displayed members on that PMID
  (length ≥ 2; singletons are dropped — they make no edge but still size a node, so
  node `pubCount` is computed server-side over **all** the member's confirmed pubs,
  independent of `papers`).
- Client derives **people edges**: for each paper, all pairs → weight =
  #distinct shared PMIDs. **Program edges**: distinct PMIDs whose member set spans
  two programs. Recomputed per view, never summed across views (avoids
  double-counting).

### 5.1 Edge-explosion guard
A consortium PMID with _k_ in-center members yields C(_k_,2) people-edges. Guard:
- Default render uses **Newman fractional weighting** `1/(k−1)` per co-author pair
  so a 30-author paper doesn't dominate, **and** a `maxMembersPerPaper` display cap
  (default 25) above which a paper is excluded from edge-building (still counts
  toward node `pubCount`). Both are surfaced as a control toggle ("count
  hyper-authored papers"). `log()`-equivalent: the UI states "N papers with >25
  center authors omitted from links" so the cap is never silent.

## 6. UI

### 6.1 Center page tab
Add a "Collaboration" tab to `components/center/center-tabs.tsx`, visible only when
the flag is on **and** the center has `CenterProgram` rows. Tab content =
`CenterCollaborationTab` (new client component), graph lib dynamically imported
(`next/dynamic`, `ssr:false`) so the center page's initial bundle is unaffected.

### 6.2 Controls (the "interactive with controls" ask)
- **Program legend** — click to toggle a program's nodes on/off; also the color key.
- **People ↔ Program rollup** toggle.
- **Min co-pubs** slider (hide edges below weight _N_) — declutter.
- **Year range** slider (`Publication.year`) — the legacy "All / COVID" filters,
  generalized.
- **Person search** — type-ahead highlight + zoom-to-node.
- **Hide unconnected members** checkbox (§13.3) — **default off** (full roster
  shown). When checked, members with zero in-center co-authored papers (in the
  current filtered view) are removed.
- **Physics**: run/freeze (vis-network Barnes-Hut, as the legacy used) + stabilize.
- **Labels**: show all / on-hover / hide.
- **Export**: "Download PNG" (canvas snapshot) and **"Download standalone HTML"**
  (self-contained, embeds the current filtered JSON + vis-network UMD — opens
  offline, drops into Keynote; reproduces the 2021 deliverable).
- **Reset**.

### 6.3 Admin entry point (optional, low-cost)
Mirror the roster-export card: a small card on the center **edit** surface
(`components/edit/unit-edit-page.tsx`, sibling to `unit-faculty-export-card.tsx`)
with a "Download collaboration HTML" button for admins/comms who live in `/edit`.
The button hits the same generator. Include only if cheap; the public tab already
carries the export.

## 7. Rendering library

**Recommendation: `vis-network`** (the standalone UMD build), dynamically imported
client-side via a `useEffect`+`ref` wrapper (not the abandoned `react-graph-vis`).

Why:
- It is exactly what the legacy used — Barnes-Hut physics, hover tooltips, the look
  the Cancer Center already approved.
- The **standalone-HTML export is near-free**: emit an HTML template with the
  vis-network UMD `<script>` + the same `nodes`/`edges`/`options` JSON — identical
  to what `pyvis` produced, so the in-app and exported views are pixel-consistent.
- A few hundred nodes / a few thousand edges is comfortably within its canvas perf.

Alternatives considered: `react-force-graph-2d` (more React-idiomatic canvas, but
export diverges from the in-app renderer); `sigma.js`+`graphology` (WebGL, scales to
10k+ nodes — overkill for one center, heavier setup); `cytoscape.js` (rich layouts,
but a different visual idiom than the approved legacy). Pick vis-network unless we
later need the whole-institution graph, where sigma would win.

Bundle: lazy-loaded, off the critical path of the (cacheable) center page.

## 8. Performance

- Generator is one indexed query (`PublicationAuthor` by `cwid IN M`, `@@index([cwid, isConfirmed])`)
  + one scholar gate query + one membership read. For Meyer (~300 members) this is
  tens of thousands of rows grouped in-process → expect ~100–300 ms.
- Optional: wrap `buildCenterCollaboration` in a short-TTL in-process cache (e.g.
  `unstable_cache`/`React.cache` keyed by center+day) since membership/pubs move
  slowly. Not required for v1.
- Payload: ~hundreds of nodes + per-paper groups ≈ tens of KB gzipped.

## 9. Security & privacy checklist
- [ ] Route flag-gated → 404 when off (feature does not exist for clients).
- [ ] `slug` validated against a strict charset; bad slug = 400, never logged.
- [ ] Public gate (`deletedAt: null, status: "active"`, `isPubliclyDisplayed`)
      applied **before** any edge build — a hidden scholar can't appear in a node or
      an edge.
- [ ] Only display name + program emitted; no email/hidden attributes.
- [ ] `force-dynamic` / no-store; confirm no EdgeStack allowlist change needed
      (route reads no query params).
- [ ] Standalone-HTML export contains the same gated data only.

## 10. Phasing

**Phase 1 (this spec):** publication co-authorship, people view + program rollup,
public tab, controls, PNG + standalone-HTML export. Flag staging-on/prod-off.

**Phase 2 (separate):** grant co-investigator axis — link members who share a grant
award. **Researched: see `docs/grant-coinvestigator-axis-handoff.md`** (grounded in a
real Meyer probe). Headlines: `awardNumber` is the join key (99.8% present, vs 37% for
`applId`); the network is dense enough to build (~986 edges, 206/332 connected); the
main hazard is **umbrella/infrastructure grants** (CTSA `UL1`, cancer-center `P30`/
`P50`/`U54`) that create semantic cliques — handle via a mechanism exclude-list +
Newman weighting + active-only default. UI: an axis toggle (Publications / Grants /
Both, with relationship-colored edges for "Both"). The grant-visibility/suppression
gate is the load-bearing privacy task. No schema change.

## 11. Rollout
- App-only, **no reindex**, no schema migration (Phase 1).
- Branch off **fresh `origin/master`** (the local `docs/spotlight-pipeline` checkout
  is ~190 commits behind — do not base implementation on it).
- New dep (`vis-network`) → run full suite + `npx jest app-stack -u` if CFN snapshot
  touched (it won't be unless an edge behavior is added — it shouldn't be).
- Flag flip: `CENTER_COLLABORATION_NETWORK` env-conditional in app-stack
  (`env === "staging" ? "on" : "off"`); staging deploy `cdk deploy --exclusively
  Sps-App-staging` from a fresh-master worktree; prod gated/dark.

## 12. Testing
- Unit: edge-build (pairwise + Newman weighting + `maxMembersPerPaper` cap),
  program-rollup aggregation, year filter, privacy gate (hidden scholar excluded
  from nodes AND edges).
- API: flag-off 404; bad slug 400; payload shape; `no-store` header.
- Component: tab hidden when flag off / no programs; controls drive the render;
  export produces a self-contained HTML string.
- Manual (Playwright `browser_snapshot`): legend toggles, rollup toggle, slider,
  search, export download — on staging through CloudFront.

## 13. Resolved decisions

### 13.1 Node size metric — within-center collaboration volume
Node radius scales with the number of distinct PMIDs the member co-authored **with
at least one other center member**, computed over the **current filtered view**
(year range + thresholds), so size responds live to the controls. Use
`r = rMin + k·sqrt(coPubCount)` (area-proportional) with an `rMin` floor so isolated
/ low-collaboration members stay clickable. Deliberately **not** raw productivity —
this is a collaboration graph, so size = how much you collaborate inside the center.
(Raw total-pub sizing can be added later as a toggle if asked; not in v1.)

### 13.2 Program colors — Okabe-Ito, assigned by sortOrder
Use the **Okabe-Ito colorblind-safe qualitative palette**, assigned to programs in
`CenterProgram.sortOrder` order (deterministic; survives label/program changes):

| slot (sortOrder) | hex | sample program |
|---|---|---|
| 0 | `#0072B2` (blue) | CB |
| 1 | `#D55E00` (vermillion) | CGE |
| 2 | `#009E73` (bluish green) | CPC |
| 3 | `#CC79A7` (reddish purple) | CT |
| 4 | `#E69F00` (orange) | ZY |
| 5 | `#56B4E9` (sky blue) | (spare) |
| Unclassified (`null`) | `#9AA0A6` (neutral gray) | — |

Labels come from `CenterProgram.label`. Colorblind-safe and print-legible — required
for a public tab that is also exported into slides. If `>6` programs ever exist, wrap
the palette and `log`/note it (won't happen for Meyer).

### 13.3 Unconnected members — checkbox, default off
Members with zero in-center co-authored papers render as isolated nodes (floored to
`rMin`) by default, so the full roster is visible and nobody is silently dropped. A
**"Hide unconnected members" checkbox** (§6.2, default **off**) removes them for a
cleaner core-collaboration view.

### 13.4 Open — Edit-surface admin card
§6.3 admin card (Phase 1 or skip): **skip in Phase 1** — the public tab's
"Download standalone HTML" already covers the slide-export workflow. Revisit only if
admins want it inside `/edit`.
