---
sketch: 003
name: home-landing
question: "How prominent should search be vs. browse on-ramps? Lean search-first vs. UCSF-style intent tiles vs. editorial two-column with featured scholars."
winner: "D"
tags: [home, search, browse]
---

# Sketch 003: Home / Landing

## Design Question

The home page is the front door. FunReq says prioritize the search box and deprioritize stats/dashboards. UCSF showed that pre-built intent tiles ("Mentor Faculty," "Run Clinical Trials") outperform a naked search box for browse on-ramps. The spec asks for search hero + small stats strip + 4–6 browse tiles + footer. Three approaches with different tradeoffs:

## How to View

```
open ".planning/sketches/003-home-landing/index.html"
```

## Variants

- **A: Search-dominant hero** — Big search box centered in a tall hero with the title and a one-line subtitle. Suggested-search chips below. Stats strip below the hero. Generic "browse by department" tiles near the bottom. Cleanest, leanest, but the tiles feel uninteresting.
- **B: Hero + intent tiles (UCSF-inspired)** — Smaller hero with search, then a section of six "intent tiles" ("Mentors for trainees," "Currently NIH-funded," etc.). Department tiles relegated to a secondary section. More on-ramps but more curation/maintenance.
- **C: Two-column editorial** — Hero is a two-column grid: narrative + search left, "Recently featured" scholar card right. Generic browse tiles below. Most editorial; implies a curation workflow.
- **D: A's hero + ReCiterAI subtopic carousel with curated selections (refinement of A)** ★ — Drops the generic browse tiles. Below the hero and stats strip, surfaces a horizontal scrolling carousel of subtopic cards (e.g., "Cellular Senescence & Molecular Aging" from Aging & Geroscience; "Cardiotoxicity from Cancer Therapies" from Cardiovascular Disease). Each card shows: parent-topic breadcrumb, subtopic name, counts, **2 ReCiterAI-selected publications** with WCM author chips, and a small italic footnote: _"Selected by ReCiterAI · methodology"_. Selection combines impact_score, recency, and citation count internally; the score and the AI-generated synopses are never exposed publicly. Mostly automated; no editorial workflow.

## What to Look For

- **First impression** — what does a visitor see in 1 second? Where does their eye go?
- **Search vs. browse balance** — A is search-first, B and C have richer browse on-ramps. Which feels right for the WCM use case?
- **Maintenance burden** — B's intent tiles need queries that produce sensible counts (e.g., "Currently NIH-funded" requires reliable grant-status data); C's "Recently featured" needs a curation workflow. A is purely automated.
- **Brand expression** — A is restrained; B is more product-y with icons and color; C feels more institutional / editorial.
- **Tile typography** — currently uses default theme; pay attention to how titles + descriptions read at scan speed.
- **Mobile collapse** (resize) — C's two-column hero stacks vertically; A and B already stack naturally.

## Notes

- Stats counts ("3,247 scholars · 184,512 publications") are realistic placeholder values for WCM scale.
- All variants use Cornell Big Red as the placeholder accent.
- Variant B's intent tiles use emoji icons as placeholders — production would use a proper icon set or small illustrations.
- Variant C's "Recently featured" surface implies an editorial workflow that's out of Phase 1 scope per the functional spec — it's shown to make the design tradeoff visible.
