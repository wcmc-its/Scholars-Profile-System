# Scholars @ WCM — Design Forks for Review

_Last updated: 2026-04-28_

## What this is

A compact write-up of the design decisions made across four exploratory UI sketches for **Scholars @ Weill Cornell Medicine** — the read-mostly public-facing replacement for VIVO. The sketches are working HTML mockups; this doc captures the forks taken, the alternatives that were considered, and where reviewer input would most help.

The corresponding artifacts:

- **Charter** — `Scholars Project Charter - 2026-04-28.docx`
- **Functional spec (Phase 1)** — `Scholars Functional Spec - Phase 1 - 2026-04-28.md`
- **Sketches** — `.planning/sketches/{001,002,003,004}-*/index.html`

Open the sketches in a browser to see what's described below. Each sketch HTML has all variants reachable via tabs at the top.

## Reference points used while sketching

- **Yale School of Medicine** profiles (e.g., `medicine.yale.edu/profile/`) — closest editorial reference; modern type, citation counts inline, concept pills, tabbed sub-nav.
- **Harvard Catalyst Profiles / UCSF Profiles** (Profiles RNS family) — feature inspiration: weighted concepts, similar people, co-author maps. Visually dated; we borrowed features, not chrome.
- **UCSF Profiles landing** — pre-built intent tiles ("Mentor faculty / Run clinical trials / Global health") as a discovery on-ramp.

Anti-references: Stanford Profiles (metric-thin), Hopkins Find-A-Doctor (patient-rating template, wrong product), Penn Medicine (fragmented per-department microsites with visible template bugs).

## Cross-cutting decisions

These apply across multiple sketches and are likely the highest-stakes things to review.

### Visual placeholder until WCM brand standards land

- Cornell Big Red (`#B31B1B`) accent on near-white surfaces; charcoal text; sans-serif throughout. Matches the institutional identity well enough as a placeholder. Will be re-skinned when WCM brand standards are published per the charter dependency.
- **Reviewer question:** does this read as too "cardinal" for a medical school? Should the placeholder lean cooler / less Cornell-undergrad?

### Faculty data is fictional but realistic

- The mockup faculty member ("Eleanor M. Ramirez, MD, Chief of Cardiology") has 142 publications and 11 grants. Designed to test how layouts handle a mid-senior profile. Reviewer should ask: how would this scale up for a department chair with 400 pubs / 30 grants?

### The ReCiterAI impact score is never published

- The score is back-end only — used internally as a sort key, never displayed as a number.
- Surface-level signals when AI is shaping order: a sort option label ("Selected by ReCiterAI") and a small Cornell-red "ReCiterAI" pill badge that appears next to the section header when an AI sort is active.
- AI-generated **synopses** ("why was this paper selected?") were prototyped on hover and ultimately removed — they're too compact and not plain-language enough for public display.
- A "Selected highlights" surface (3 ReCiterAI-curated pubs in a featured card above the publication feed) was prototyped and removed for the same reason.
- **Reviewer question:** does the current AI surfacing (sort label + pill badge + small "Selected by ReCiterAI · methodology" footnote on home cards) feel honest or too quiet? Either could be wrong.

---

## Sketch 001 — Profile page

**Surface:** Individual scholar profile, the most-visited page in the system.

### Forks considered

| Variant | Approach | Tradeoff |
|---|---|---|
| A | Single-column scroll, Yale-style editorial | Linear, scannable, scroll-heavy on dense profiles |
| B | Tabbed sub-nav (About / Research / Publications / Appointments) | Hides density behind tabs; users have to click to discover full picture |
| **C ★ Selected** | **Two-column with sticky left sidebar** | Compact left rail (photo, name, appointments, education, contact); main column scrolls (overview, AOI, pubs, grants). Reference-card feel |

### Why C

- Sticky sidebar keeps the scholar's "identity card" (photo, name, title, primary appointments, education, contact) always visible while the visitor scrolls publications and grants.
- Main column reads like a research narrative; sidebar reads like a CV reference.
- Mobile gracefully collapses to single column with sidebar at top.

### Forks within C worth review

- Sidebar order: photo + name → contact → appointments → education → action buttons. Appointments before education. Defensible (active before historical); reviewer may disagree.
- "Show all 4 appointments →" link in the sidebar collapses past appointments. ReCiter Connect's appointment-ordering logic determines display order (per spec).
- The "what's missing" yellow checklist appears for authenticated owners. Currently always visible (not dismissible). Spec says reviewers should weigh in on whether always-on is the right behavior.
- "Copy citations" / "Print" buttons live at the bottom of the sidebar. Reasonable but could move to a more prominent action bar near the header.

---

## Sketch 002 — Search results

**Surface:** Page returned when a user submits a search.

### Forks considered

| Variant | Approach | Tradeoff |
|---|---|---|
| **A ★ Selected** | **Tabs (People / Publications) + left filter sidebar** | Classic, scales with filter count, matches RNS / Yale / most academic search |
| B | Tabs + horizontal filter pill strip | More modern but less room for many filters; harder to scan filter state at a glance |
| C | Stacked sections (no tabs) — People above Publications, both visible at once | Discovery-friendly but pubs section gets buried; mode switching done via scroll |

### Why A

- Predictable, accessible, scales as filters grow.
- Filter sidebar matches what experienced researchers expect.
- Tabs keep mode switching explicit.

### Forks within A worth review

- People filters: Person type, Department, "Has active grants." Are there other facets reviewers think are essential? (The spec lists these three only for Phase 1.)
- Publication results have **WCM author chips** below the citation — clickable name+avatar pills for any WCM authors on the paper. This is the genuine differentiator vs. PubMed. Reviewer question: too busy, or load-bearing?
- Numbered pagination (per spec). Locked decision; reviewer can challenge.
- People-result snippet shows matched keywords with `<em>` highlights. Yellow background on matched terms — possibly too garish; reviewer to weigh in.

---

## Sketch 003 — Home / landing page

**Surface:** Front door at `scholars.weill.cornell.edu`.

### Forks considered

| Variant | Approach | Tradeoff |
|---|---|---|
| A | Search-dominant hero with generic department/person-type browse tiles | Closest to spec letter; tiles felt uninteresting |
| B | Hero + UCSF-style "intent tiles" ("Mentor faculty / NIH-funded / Clinical trials / Global health") | Stronger on-ramps but requires backend queries for accurate counts and curation |
| C | Two-column editorial hero with "Recently featured" scholars | Most institutional/editorial; implies an editorial workflow that's out of Phase 1 scope |
| **D ★ Selected** | **A's clean hero + ReCiterAI subtopic carousel (refinement)** | Drops generic tiles; replaces them with a horizontal carousel of curated subtopic cards from ReCiterAI |

### Why D

- A's hero is clean and lean and works.
- Department tiles felt generic and didn't surface anything you couldn't get from a department directory.
- ReCiterAI's taxonomy gives 67 topics × ~30 subtopics each. Surfacing **subtopics** ("Cardiotoxicity from Cancer Therapies," "Tau-Targeting Therapeutics in Alzheimer's," "Long COVID Immune Signatures") is far more interesting than parent topics ("Cardiovascular Disease," "Aging & Geroscience").
- Each card shows: parent-topic breadcrumb (small uppercase tag), subtopic name, counts, 2 representative publications with WCM author chips, and a small italic footnote: _"Selected by ReCiterAI · methodology"_.
- Selection of which 2 publications appear on each card is impact + recency + citation driven (no number displayed).
- Carousel scrolls horizontally with prev/next arrows on desktop, native swipe on mobile. 15 subtopic cards visible plus a final "Browse all subtopics →" affordance.

### Forks within D worth review

- **Which 15 subtopics surface on home?** Currently mocked up with a deliberately diverse mix across 12 different parent topics. Real implementation needs a rule: top by recent activity? Top by aggregate impact? Curated-rotated weekly? Reviewer input would help here.
- **Section title:** "Selected research at Weill Cornell Medicine." Editorial framing implies curation, which is honest given the impact-driven selection. Reviewer may prefer "Latest research" (chronological framing) or something else.
- **Carousel vs grid.** We tried grid first; user preferred carousel. Reviewer may have a strong opinion.
- **No "Recently featured scholars" surface.** Variant C had one but required editorial workflow. Should we add a small editorial surface back (Phase 2 + ?) for newsworthy faculty events?

---

## Sketch 004 — Topic detail page

**Surface:** What a user lands on after clicking "Aging & Geroscience" or any other ReCiterAI parent topic.

### Forks considered

| Variant | Approach | Tradeoff |
|---|---|---|
| A | Subtopic chip strip (all 30 subtopics as wrapping pills) + chronological feed with subtopic tags per pub | Discovery-friendly; tags-on-pubs help users learn the taxonomy |
| **B ★ Selected** | **Subtopic side rail (sticky list) + filtered feed for the selected subtopic** | Densest; faceted-research-browser feel; "easier to scan" per user |
| C | Subtopic mini-cards grid — each subtopic gets a card with description and most recent pub | Communicates breadth at a glance; no topic-level pub feed |

### Why B

- 30 subtopics fit comfortably in a sticky left rail with a filter-as-you-type input at the top.
- Right column shows a brief description of the selected subtopic followed by its publication feed.
- Best for the subject-matter-expert use case (they know what subtopic they want).
- Left rail also handles the long tail of subtopics (some have only 3–4 pubs) without making them look sad — they're just shorter list items.

### Forks within B worth review (the most contentious cluster)

#### Pub feed sort options (4)

1. **Newest** — pure `datePublicationAddedToEntrez` desc, no AI
2. **Citation count** — pure citation count desc, no AI
3. **ReCiterAI Impact** — pure `impact_score` desc; pill badge appears
4. **Selected by ReCiterAI** — combined formula: impact × recency × citations; pill badge appears; **default sort**

The header label changes dynamically to match the sort:

| Sort | Header |
|---|---|
| Newest | Recent publications |
| Citation count | Most-cited publications |
| ReCiterAI Impact | Notable publications |
| Selected by ReCiterAI | Selected publications |

#### Default sort

We default to "Selected by ReCiterAI" with rationale: a topic page with 512 pubs needs a useful default. Chronological is noisy (recent commentaries surface), pure citations is stale (1990s landmarks dominate). The combined sort surfaces papers that are both consequential and active.

**Reviewer questions on this cluster:**

1. **Are four sort options too many?** Could collapse to three (drop "ReCiterAI Impact" pure?), or even two.
2. **Is "Selected by ReCiterAI" as default the right call?** It exposes the AI provenance on every topic page load. The pill badge makes this transparent — but is it too prominent?
3. **Is the dynamic header an over-design?** A static "Publications" label would always be honest about what's shown but loses some informational value.
4. **Are the four header labels right?** "Notable publications" for the pure ReCiterAI Impact sort is the one I'm least confident about. Alternatives: "By impact," "Most impactful," "Highlighted."
5. **Should the methodology link in the sort dropdown's footnote actually exist as a page before launch?** It's a placeholder right now. If we ship without it, the link is a credibility-reducing dead end.

### Things explicitly removed from sketch 004 during iteration

- **"Selected highlights" surface** above the subtopic browser (3 ReCiterAI-curated publications with synopsis text) — removed because the synopses are too compact and not plain-language for public display.
- **"$48M active funding" stat** in the topic hero — removed because we don't have funding totals reliably yet.

Both could be added back later if data + content quality improves.

---

## Where review would help most

Ranked by how much one informed opinion could change the outcome:

1. **Cross-cutting AI surfacing** — does the current treatment (sort label + pill badge + small footnote) feel honest or too quiet? What edge cases worry you (faculty complaint scenarios; press scrutiny of an AI-curated medical research site)?
2. **Sketch 004 default sort** — should the topic detail page default to AI-driven order? If yes, does the dynamic header sufficiently communicate what's happening?
3. **Sketch 003 home page subtopic cards** — what should drive which 15 subtopics surface?
4. **Sketch 001 sidebar order** — is the appointments-before-education ordering right? Is the sticky sidebar the right shape, or would a top-aligned hero with sections below scale better for senior faculty?
5. **WCM brand placeholder** — does Cornell Big Red feel right institutionally, or should the placeholder lean cooler?

## How to review

```
open ".planning/sketches/001-profile-page/index.html"
open ".planning/sketches/002-search-results/index.html"
open ".planning/sketches/003-home-landing/index.html"
open ".planning/sketches/004-topic-detail/index.html"
```

Each file has a dark variant-tab bar at the top — switch between A/B/C(/D) to compare. Resize the window to see mobile collapse. The variant marked **★ Selected** is the working winner; others are preserved for comparison.

Sketch 004 has the most live interactions: try the sort dropdown in variant B and watch the header label and ReCiterAI pill badge change.
