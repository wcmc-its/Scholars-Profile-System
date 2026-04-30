## Conflict Detection Report

### BLOCKERS (0)

(none)

### WARNINGS (0 outstanding — 1 resolved)

[RESOLVED 2026-04-30] User chose Variant B (design spec v1.7.1) for REQ-publications-ranking. Functional spec arithmetic superseded. See requirements.md REQ-publications-ranking for the locked spec.

### WARNINGS — original (now resolved) (1)

[WARNING] Competing acceptance variants for REQ-publications-ranking
  Found: Functional spec (precedence 3) and design spec v1.7.1 (precedence 1) define **different** ranking algorithms for publication surfaces. Both are SPEC-class sources at adjacent precedence; the orchestrator instruction says design spec is the locked UI/UX contract and overrides earlier UI hints in the functional spec, so design spec v1.7.1 wins on UI display — but the two algorithms diverge on calibration semantics in ways that are not safe to silently merge.

  Variant A — Functional spec Phase 1 (`.planning/source-docs/functional-spec-phase-1.md` lines 64-114):
    - Two stacked profile sections: "Selected highlights (top 3)" and "Recent publications" (10 by default + Show all).
    - highlight_score = authorship_points + type_points + impact_points
      - authorship_points: 5 (first/last) | 2 (second/penultimate) | 0 (middle)
      - type_points: Academic Article 4, Review 2, Case Report 2, Preprint 1, Letter 0, Editorial 0, Erratum 0
      - impact_points: log10(citation_count + 1) × 2, capped at 6
      - tiebreak: citation_count desc, then datePublicationAddedToEntrez desc
    - recent_score = recency_score + authorship_points + type_points + impact_points
      - recency_score = 8 × exp(-age_years / 5), capped at 8
      - tiebreak: datePublicationAddedToEntrez desc
    - "Errata never appear in Selected highlights" (filter, not weight=0)
    - Note: spec calls type weights "starting estimates; refine post-launch against feedback"

  Variant B — Design spec v1.7.1 (`.planning/source-docs/design-spec-v1.7.1.md` v1.6 + v1.7 changelogs, "Highlight selection formula" component):
    - Multiple algorithmic surfaces beyond profile: Selected highlights (profile), Recent highlights (topic page), Recent contributions (home page), Top scholars chip row (topic page) — each with surface-specific recency curves.
    - Shared formula: reciterai_impact × authorship_weight × pub_type_weight × recency_weight
    - publication-type weights as soft preference: Academic Article 1.0, Review 0.7, Case Report 0.5, Letter / Editorial / Erratum 0.1 → updated in v1.7 to **0** (hard-excluded; "a 10× score gap can no longer rescue an erratum onto the home page contributions surface")
    - Two-stage recency curves keyed to surface intent: "Recent" surfaces (home contributions, topic page highlights) penalize papers under 3 months and peak at 3-18 months. Selected highlights skews older deliberately — peaks 18 months-10 years, excludes papers under 6 months entirely (avoid duplication with most-recent-papers view immediately below).
    - Authorship-position filter for scholar-attributed surfaces: First or senior author only on profile Selected highlights and home page Recent contributions. Publication-centric surfaces (Topic page Recent highlights, Top scholars chip row) do NOT apply this filter.
    - "Calibration owner named (ReCiter lead, in concert with the methodology page owner). Six-month post-launch review trigger committed to."

  Impact: Synthesis cannot pick a single algorithm without losing intent. Variant A is concrete arithmetic with explicit type-point integers and a single recency curve; Variant B is multiplicative with surface-specific recency curves and a different weight scale. Variant B also adds entire surfaces (Recent contributions on home page, Top scholars chip row, Topic page Recent highlights) that don't exist in Variant A. The HANDOFF current-state says profile pages render "publications (with both ranking formulas + WCM coauthor chips)" — ambiguous about which formula(s).

  → Choose one of:
    (a) Adopt Variant B (design spec v1.7.1) for all algorithmic surfaces and treat Variant A's arithmetic as superseded; capture the Variant A formula only as historical context. Justified by the orchestrator's "design spec v1.7.1 is the locked UI/UX contract" instruction and the spec-internal precedence.
    (b) Treat Variant A as the locked Phase 1 profile-only formula and Variant B as the broader surface-spanning calibration target — split into REQ-publications-ranking-profile (Variant A locked) and REQ-publications-ranking-algorithmic-surfaces (Variant B, calibration TODO).
    (c) Have the user explicitly merge: pick which weights, which recency curve(s), and which surfaces are in Phase 1 scope before routing.

### INFO (8)

[INFO] Auto-resolved: ADR-006 > design spec on runtime DAL pattern
  Found: Design spec v1.7.1 ("Data sources" section, source `.planning/source-docs/design-spec-v1.7.1.md`) states *"A thin data-access layer abstracts DynamoDB calls behind domain methods (`getPublicationScore(pmid)`, `getTopicAssignmentsForPublication(pmid)`, etc.)"* — implying a runtime DAL with two stores. ADR-006 (`.planning/source-docs/phase-1-design-decisions.md` §6, LOCKED) explicitly contradicts: *"The Scholars application reads only MySQL at runtime — there is no runtime DynamoDB read path. The data-access-layer pattern called for in spec language ... applies at the **ETL transform**, not at the runtime read. This is a real departure from the spec's verbatim language and is documented in a separate ADR."*
  Note: ADR > SPEC by precedence; ADR-006 is locked; ADR text itself acknowledges the spec-verbatim departure and references a future Q6 ADR (`docs/ADR-001-runtime-dal-vs-etl-transform.md`, BUILD-PLAN Phase 6 deferred work). Synthesized intel adopts ADR-006 (runtime MySQL only, DAL discipline at ETL boundary). Design spec's DAL phrasing is captured for context but does not drive runtime architecture. The Q6 ADR is a tracked open item for circulation to reviewers reading spec-only.

[INFO] Auto-resolved: Design spec v1.7.1 > functional spec on home-page composition
  Found: Functional spec (`.planning/source-docs/functional-spec-phase-1.md` "Home page", lines 208-218) describes a leaner home page — hero with search, single-line stats strip, 4-6 browse entry tiles or chips, footer. Design spec v1.7.1 §1 requires a richer composition — hero + stats strip + Selected research carousel (8 subtopic cards in horizontal scroll-snap) + Recent contributions faculty grid (6 cards in 3×2 with eligibility carve) + Browse all research areas (67 parent topics in 4 columns) + footer.
  Note: Per orchestrator instruction, design spec v1.7.1 is the locked UI/UX contract and overrides earlier UI hints in the functional spec. Synthesized REQ-home-page adopts the design spec composition. Functional spec composition captured as historical context only.

[INFO] Auto-resolved: Design spec v1.7.1 > functional spec on role model (5 categories vs implicit 4)
  Found: Functional spec carries an implicit role model (full-time faculty, adjunct, postdocs as a vague set of "person types"); design spec v1.7.1 §"Scholar role model" defines an explicit five-chip-row category model (Full-time faculty, Affiliated faculty, Postdocs & non-faculty, Doctoral students, All) with a compound derivation rule (ED person-type class AND `weillCornellEduFTE`) and an algorithmic-surface eligibility carve.
  Note: Design spec v1.7.1 wins per UI/UX-contract precedence. Synthesized REQ-role-model adopts the five-category model. Sketch `002-revised` only has three categories — design spec v1.7.1 changelog explicitly calls this out as "a known gap to update during implementation," already accepted internally.

[INFO] Auto-resolved: Design spec v1.7.1 introduces page types not in functional spec
  Found: Functional spec Phase 1 enumerates Profile, Search, Home, Self-edit, Support, Sitemap/SEO. Design spec v1.7.1 introduces four additional Phase 1 page types: Topic detail (`/topics/{slug}`), Department detail (`/departments/{slug}`), Browse hub (`/browse`), About page (sketch 008).
  Note: Per orchestrator instruction, charter scope claims do NOT veto more ambitious requirements derived from HANDOFF or design spec; design spec v1.7.1 is the locked UI/UX contract. Synthesized requirements include REQ-topic-detail-page, REQ-department-detail-page, REQ-browse-hub-page, REQ-about-page as in-scope Phase 1. Implementation status is TBD against current code — HANDOFF's "current state" list does not enumerate these pages, so they may be deferred work or partially-built. Verify against code during routing.

[INFO] Auto-resolved: ADR-001 (provisional) vs charter "AWS-native, microservices architecture"
  Found: Charter Constraints (`.planning/source-docs/charter.md` line 69) requires *"AWS-native, microservices architecture is required."* ADR-001 (`.planning/source-docs/phase-1-design-decisions.md` §1) decides single Next.js deploy with `/api/*` routes for the prototype, with production architecture explicitly **deferred to Mohammad's official design kickoff** following his preliminary preference for a separate Scholar API service.
  Note: Charter is precedence 9 (lowest, manifest-declared by user as intentionally downplayed). ADR-001 is treated as PROVISIONAL per orchestrator instruction. Implementation discipline (route handlers as pure functions in `lib/api/*`) keeps the migration path open. No actual conflict to resolve at intel-synthesis time — the production-architecture decision is owned by Mohammad and the prototype build does not foreclose the microservice option.

[INFO] Auto-resolved: HANDOFF spec amendment > functional spec on COI Disclosures section
  Found: Functional spec did not enumerate a COI "Disclosures" / External Relationships section on profile pages. HANDOFF notes a spec amendment added during build (*"COI 'Disclosures' section on profile pages. The functional spec didn't enumerate it, but VIVO surfaced this data and removing it would be a regression."*). Design spec v1.7.1 v1.5 changelog formalizes this as the External Relationships section.
  Note: HANDOFF + design spec are both higher-precedence than functional spec for current-scope assertions in this ingest. Synthesized REQ-profile-page includes External Relationships per design spec v1.7.1 §3 + Components §"External relationships section". No actual conflict.

[INFO] Auto-resolved: Pagination 20-per-page LOCKED in functional spec, design spec adds rendering pattern
  Found: Functional spec line 197 marks "numbered pagination, 20 per page" as **Locked**. Design spec v1.7.1 "Components / Pagination" specifies the rendering pattern (small ≤6 pages = numbered prev/next; large ≥7 pages = ellipsis pattern).
  Note: Compatible — functional spec locks the page-size and numbering style; design spec specifies the visual rendering. Synthesized CON-search-pagination merges both: "numbered, 20 per page (LOCKED)" + the size-based rendering pattern.

[INFO] Documentation cross-reference loop: BUILD-PLAN ↔ HANDOFF
  Found: Cycle detection on the cross-ref graph identified BUILD-PLAN.md → HANDOFF (cross_refs in classifier) and HANDOFF → BUILD-PLAN.md (HANDOFF's companion-documents table lists BUILD-PLAN). Both are DOC-class.
  Note: This is benign documentation cross-referencing, not a content cycle that creates synthesis loops on contended scope. BUILD-PLAN is the planned phasing; HANDOFF is the realized snapshot. Each defers to the other on its respective question (BUILD-PLAN is authoritative on planned phase boundaries; HANDOFF is authoritative on what is actually shipped). Synthesis treated them as complementary: BUILD-PLAN populates phase-mapping context, HANDOFF populates current-state context. No assertive contradiction detected. No action required.
