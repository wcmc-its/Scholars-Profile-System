---
sketch: 002
name: search-results
question: "How do People + Publications coexist on one results page? Tabs vs. stacked sections; left filter sidebar vs. horizontal filter strip."
winner: "A"
tags: [search, results, faceting]
---

# Sketch 002: Search Results

## Design Question

The spec calls for two result types — People and Publications — on a single results page. There are real questions about how to arrange them and how to surface filters. Three approaches:

## How to View

```
open ".planning/sketches/002-search-results/index.html"
```

Use the variant tabs at top to switch between A / B / C. Search query is "cardio-oncology" with 14 people and 847 publications.

## Variants

- **A: Tabs + left filter sidebar** — Classic search UX. People/Publications tabs above the results; persistent filter sidebar on the left. Familiar, scales to many filters, matches Profiles RNS / Yale / most academic search surfaces.
- **B: Tabs + horizontal filter pill strip** — Tabs same as A, but filters live in a horizontal pill row above the results, no sidebar. More modern feel, frees horizontal space for content, but less room for many filters and harder to scan filter state at a glance.
- **C: Stacked, no tabs** — Single scrollable page: People section first (showing top 3), then Publications section below (showing top 5+). Filter sidebar shared across both. No mode switch — both result types always visible. WCM-author chips render below each publication.

## What to Look For

- **Cognitive load** — does B's filter pill strip read clearly with 3 active filters? With 8?
- **Discoverability** — in A and B, how obvious is it that publications also matched the search? In C, do users see the people section and stop scrolling?
- **Filter density** — when filters expand (year ranges, sub-departments, etc.), which layout still works?
- **WCM author chips** (visible in variant C's publication results) — does the chip stack add real value, or just visual noise?
- **Mobile collapse** (resize window) — A and C collapse sidebar to top; B's pill strip stays inline. Which feels best?
- **Sort and filter affordances** — sort lives top-right of results in all three; filter affordance differs.

## Notes

- Phase 1 spec defaults to People mode; switching to Publications goes via tab. C breaks that default but tests whether tabs are needed at all.
- WCM-author chips appear as a row of clickable name/avatar chips below each publication's citation. This is the differentiator vs. PubMed.
- Numbered pagination (per spec lock).
- Publication results show citation count, DOI/PubMed links externally — no internal pub detail page.
