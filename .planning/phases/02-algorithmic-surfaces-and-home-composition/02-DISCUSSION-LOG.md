# Phase 2 Discussion Log

**Date:** 2026-04-30
**Mode:** discuss (default, no flags)
**Phase:** 2 — Algorithmic surfaces and home composition

This log records the conversation that produced `02-CONTEXT.md`. It is not consumed by downstream agents; it is for human reference (audits, retrospectives).

---

## Area selection

**Q:** Which areas do you want to discuss for Phase 2?
**Options presented:**
- Topic taxonomy data layer
- Methodology link strategy
- Variant B retrofit on profile
- Mount strategy + top-tier venues + sparse state (bundled)

**User selected:** All four areas.

---

## Area 1: Topic taxonomy data layer

### Q1.1: Where does the parent / subtopic hierarchy live, and how should Phase 2 land it in MySQL?
**Options:**
- Extend the projection ETL
- Derive from delimiter convention
- Hand-maintained mapping table
- Defer to researcher

**User selected:** Extend the projection ETL (i.e., DynamoDB is the source of truth).

### Q1.2: What MySQL shape for the landed taxonomy?
**Options:**
- New Topic table + FK on TopicAssignment
- Add columns to topic_assignment
- Two tables: topics + topic_subtopics
- Researcher decides from the DynamoDB shape

**User selected:** Researcher decides from the DynamoDB shape.

### Q1.3: What count is displayed on the Browse grid?
**Options:**
- Scholars in the topic
- Publications in the topic
- Both (scholars primary)
- Defer to researcher

**User selected:** Scholars in the topic.

**Decision captured as:** D-01, D-02, D-03.

---

## Area 2: Methodology link strategy

### Q2.1: How should Phase 2 handle methodology links given /about doesn't ship until Phase 4?
**Options:**
- Ship a thin /about stub in Phase 2
- Link to /about and accept the gap
- Hide methodology links until Phase 4
- Anchor links into a Phase-2 README-style page

**User selected:** Anchor links into a Phase-2 README-style page (Phase 2 owns the technical methodology page).

### Q2.2: URL and structure for the Phase 2-owned methodology page?
**Options:**
- /methodology with anchor sections
- /about/methodology nested under /about
- /how-this-works as standalone
- Defer to UI spec phase

**User selected:** /about/methodology nested under /about.

**Decision captured as:** D-04, D-05.

---

## Area 3: Variant B retrofit on profile

### Q3.1: Does Phase 2 also rewrite profile-page ranking to Variant B?
**Options:**
- Yes — rewrite profile alongside new surfaces (Recommended)
- No — new surfaces only, defer profile retrofit
- Yes — but feature-flagged behind a config
- Researcher confirms the retrofit cost first

**User selected:** Yes — rewrite profile alongside new surfaces.

**Decision captured as:** D-06, D-07, D-08, D-09.

---

## Area 4: Mount strategy + top-tier venues + sparse state (bundled)

### Q4.1: Where do Phase 2's topic-page sub-components mount?
**Options:**
- Pure components + unit tests, no route
- Ship minimal /topics/{slug} placeholder route
- Demo route only
- Defer until UI-SPEC phase

**User selected:** Ship minimal /topics/{slug} placeholder route.

### Q4.2: How should "top-tier venues" be encoded for Recent contributions?
**Options:**
- Trust reciterai_impact (no separate filter)
- Curated journal whitelist
- IF threshold via new field
- Researcher decides from spec re-read + sketch

**User selected:** Trust reciterai_impact (no separate filter).

### Q4.3: Sparse-state policy when fewer items qualify than the surface expects?
**Options:**
- Fill from the next-best pool, never hide
- Hide section if below floor
- Show fewer with a note
- Fail loud (assume data bug)

**User selected:** Hide section if below floor.

**Decision captured as:** D-10, D-11, D-12.

---

## Notes / Claude's discretion items

Items the user did not need to decide; defaults documented in CONTEXT.md `<decisions>` "Claude's Discretion" subsection:

- Per-surface floor values for sparse-state hiding
- Component file locations
- ISR revalidation cadence specifics for home page and `/topics/{slug}`
- `/about` stub vs. redirect implementation
- Mobile responsive collapse patterns (single-column collapse on phone is locked)
- Anchor-section IDs on `/about/methodology`
- Authorship role display format on Recent contributions cards
- Carousel UX details (arrow buttons + scroll-snap vs. scroll-snap only)
- Recency-curve bucket value transcription from spec lines 1103-1145

---

## Deferred ideas captured

(Full list in CONTEXT.md `<deferred>` section.)

- Phase 3: full Topic detail layout B (subtopic rail, publication feed, sort dropdown, Curated tag)
- Phase 4: /about institutional content
- Phase 6: component-render logging surface
- Post-launch calibration retrospective (6-month review, ReCiter lead + methodology page owner)
- Co-corresponding author flag in schema
- /api/headshot/:cwid proxy

---

*End of discussion log.*
