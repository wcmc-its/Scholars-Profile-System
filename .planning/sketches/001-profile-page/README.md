---
sketch: 001
name: profile-page
question: "What's the right layout for the most-visited surface — single-column scroll, tabbed sub-nav, or two-column with sticky sidebar?"
winner: "C"
tags: [profile, layout, hero]
---

# Sketch 001: Profile Page

## Design Question

How should the scholar profile page be laid out? The profile is the most-visited surface and the heart of the product. Three structural approaches with meaningfully different tradeoffs:

## How to View

```
open ".planning/sketches/001-profile-page/index.html"
```

Use the variant tabs at the top to switch between A / B / C. Toggle "Signed-in view" in the top-right of the variant nav to see how the authenticated state surfaces inline edit affordances and the "what's missing" checklist.

## Variants

- **A: Single-column scroll** — Yale-inspired editorial. Full-width header (photo + name + title + dept), then linear sections from top to bottom: overview → areas of interest → selected highlights → recent publications → grants → appointments → education. Scannable, scroll-heavy, no UI surprises.
- **B: Tabbed sub-nav** — Same hero, then four tabs: About / Research / Publications / Appointments & Education. Hides density behind tabs; content per tab is shorter; users have to click to discover full picture.
- **C: Two-column with sticky sidebar** — Compact left rail with photo + name + title + appointments + education + contact (sticky, follows scroll); main column on right with overview + AOI + publications + grants. Reference-card feel, like a CV laid alongside the narrative.

## What to Look For

- **Density vs. breathability** — does A feel like a wall of content for senior faculty? Does B feel hidden? Does C feel cramped?
- **Above-the-fold value** — what does a visitor see first in each? Which gives the strongest first impression?
- **Mobile behavior** — resize the window narrow. C collapses to single column (sidebar moves to top); A and B stay vertical. Is the collapsed C still the right shape?
- **Skim-friendliness** — can you find publications fast in each? Grants? Education?
- **Authenticated state** — toggle "Signed-in view." The edit pencil and "what's missing" checklist render the same in all three; check it doesn't break the layout.
- **Senior faculty test** — Dr. Ramirez has 142 publications and 11 grants. Imagine a chair-of-medicine type with 400 pubs and 30 grants. Which variant scales?

## Notes

- All variants use realistic-but-fictional content for a cardio-oncology faculty member with mid-senior output. No real WCM faculty data.
- Cornell Big Red (`#B31B1B`) is a placeholder accent until WCM brand standards land.
- Inline citation counts and "WCM author" highlighting (gray emphasis on the profiled person, link color on other WCM co-authors) appear in all three.
- Selected highlights vs. recent publications shown as two distinct sections, per spec.
