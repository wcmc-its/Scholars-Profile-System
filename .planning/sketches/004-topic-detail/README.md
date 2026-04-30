---
sketch: 004
name: topic-detail
question: "How should subtopics surface on a topic detail page? Chip strip vs. side rail vs. mini-cards grid."
winner: "B"
tags: [topic, subtopics, browse, reciter-ai]
---

# Sketch 004: Topic Detail Page

## Design Question

The home page (sketch 003 winner D) lands users on a topic detail page when they click a topic card. Each topic in the ReCiterAI taxonomy has subtopics — Aging & Geroscience has 30 of them, ranging from "Cellular Senescence" to "Hospice & Palliative Care" to "Elder Mistreatment & APS." How should those subtopics be surfaced?

This is the natural home for subtopic content. Three approaches:

## How to View

```
open ".planning/sketches/004-topic-detail/index.html"
```

Topic shown: **Aging & Geroscience** (real subtopics from `hierarchy_augmented_aging_geroscience.json`).

## ReCiterAI sort (kept across all three variants)

The publication-feed sort dropdown offers four options:

1. **Newest** — `datePublicationAddedToEntrez` desc; no AI involvement.
2. **Citation count** — citation count desc; no AI involvement.
3. **ReCiterAI Impact** — pure `impact_score` desc; AI-driven; pill badge shown.
4. **Selected by ReCiterAI** — combined formula (impact × recency × citations); AI-driven; pill badge shown. **Default sort in variant B.**

Three distinct sort axes give users explicit control without conflating them. The score itself is never displayed — only used as a sort key. When either AI sort is active, a small Cornell-red "ReCiterAI" pill appears next to the section header so the user always knows when the order is AI-driven.

The section header is **dynamic** — it changes to match the active sort, so the label never lies about the order:

| Sort | Header |
|---|---|
| Newest | Recent publications |
| Citation count | Most-cited publications |
| ReCiterAI Impact | Notable publications |
| Selected by ReCiterAI | Selected publications |

Variant B's default sort is "Selected by ReCiterAI" — so the page loads with header "Selected publications" and the ReCiterAI pill visible. Rationale: a topic page with 512 publications needs a useful default, and chronological / pure-citation defaults both produce noisy or stale top-of-feed results.

A "Selected highlights" surface above the subtopic browser was prototyped and removed. The auto-generated synopses powering that surface are too compact for plain-language public display, and the editorial framing was deemed unnecessary given the sort options already provide the same ranking signals.

## Variants

- **A: Chip strip + chronological feed** — Topic hero at top with description and stats. Below, all 30 subtopics rendered as a horizontal-wrapping pill strip; clicking a chip filters the feed below. Default state ("All") shows a chronological pub feed for the whole topic, with each pub showing its subtopic tag(s) inline. Good for browsers who don't already know what subtopic they want; tag-on-pub helps them learn the taxonomy.

- **B: Side rail + filtered feed** — Topic hero at top. Below, a sticky left-rail list of all 30 subtopics with publication counts, plus a filter-as-you-type search at the top of the rail. Right column shows the *currently selected* subtopic's description in a highlighted card, then the publication feed for that subtopic only. Densest option; feels like a faceted research browser. Best for subject-matter experts who want to drill into specific subtopics.

- **C: Subtopic mini-cards grid** — Topic hero at top. Below, a grid of subtopic cards, each showing subtopic name + description + pub count + the single most recent publication. Click a card → drills into that subtopic. No publication feed at the topic-level; subtopics ARE the content. Most browsable and editorial; communicates the breadth of the topic at a glance.

## What to Look For

- **Onboarding for non-experts** — A and C help users discover what subtopics exist; B assumes they already know.
- **Drilling into a known subtopic** — B is fastest if you know what you want; A and C require more clicks or scanning.
- **Information density** — A's chip strip wraps to 2–3 lines for 30 subtopics, then publishes a single feed below; B uses sidebar real estate; C uses ~30 cards in a grid (more vertical scroll).
- **How a "long-tail" subtopic feels** — most subtopics have <10 pubs. In B, a 3-pub subtopic is a sad-looking page; in A and C, those just disappear into the larger view.
- **Subtopic-tags-on-pubs** (visible in A) — does seeing every pub tagged with 1–2 subtopics help users understand the taxonomy, or feel busy?
- **Mobile collapse** — B's sidebar moves to top on narrow screens (long list to scroll past); A and C work natively.

## Notes

- Real subtopic data drawn from `hierarchy_augmented_aging_geroscience.json` (30 subtopics, with descriptions and activity counts).
- Plausible-but-fictional publications across each subtopic.
- Active subtopic in B is "Alzheimer's & neurodegeneration" (50 pubs, the largest subtopic).
- Variant C shows 9 of 30 subtopic cards plus a "+21 more" affordance — the real page would show all 30, possibly sorted by activity count or alphabetically.
- Click hooks: subtopic chip/rail item/card → filtered view; pub title → DOI/PubMed; author chip → profile.
