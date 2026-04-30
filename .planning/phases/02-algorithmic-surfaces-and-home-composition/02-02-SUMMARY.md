---
phase: 02-algorithmic-surfaces-and-home-composition
plan: 02
status: complete
completed: 2026-04-30
---

# Plan 02-02 — DynamoDB probe + D-02 schema decision

## What was built

Wave 0 prerequisite for Phase 2's algorithmic-surfaces work. A read-only DynamoDB probe script (`etl/dynamodb/probe.ts`) that enumerates partition prefixes in the `reciterai-chatbot` table and samples records per prefix, plus the captured probe output (`probe-output.json`) and the locked D-02 schema-shape decision (`02-SCHEMA-DECISION.md`).

Outcome: Plan 05 (Wave 2 topic taxonomy ETL) and Plans 07–08 (Wave 3 surfaces) now have a concrete schema contract — candidate **(e), project the granular `TOPIC#` rows directly** — to migrate to and query against. No guess-and-rewrite risk on Wave 2.

## Tasks completed

| Task | Name | Commit |
|------|------|--------|
| 1 | Build `etl/dynamodb/probe.ts`, run against `reciterai-chatbot`, capture `probe-output.json` | `f78b116` |
| 2 | Lock D-02 schema decision in `02-SCHEMA-DECISION.md` after human review | (this commit) |

## Probe findings (summary)

Total scanned: 101,501 items across 7 prefixes:

| PK prefix | Count | In Phase 2 scope |
|-----------|------:|:----------------:|
| `TAXONOMY#` | 1 | yes — 67-parent topic catalog |
| `TOPIC#` | 78,103 | yes — per-publication scoring rows |
| `FACULTY#` | 1,563 | partial — `top_topics` already projected; aggregation columns out of scope |
| `IMPACT#` | 7,097 | already feeds existing `publication_score` |
| `TOOL#` | 14,721 | **no — deferred** |
| `TOOL_INDEX#` | 15 | **no — deferred** |
| `DEEPDIVE#` | 1 | no — Phase 3+ |

**Critical empirical finding:** subtopics are NOT first-class entities in DynamoDB. They appear only as embedded fields (`subtopic_ids[]`, `primary_subtopic_id`, `subtopic_confidences{}`, `subtopic_scores{}`) on `TOPIC#` and `FACULTY#` rows. There is no `SUBTOPIC#` PK prefix, no nested subtopic list inside `TAXONOMY#`, and no human-readable label or description for subtopics anywhere — the slug is the canonical identifier.

This finding eliminated candidates (a) and (c) from contention (both would synthesize ~2,000 NULL-description subtopic rows). It also surfaced two new candidates beyond the original CONTEXT.md menu:

- **(d)** two-table `topic` + `subtopic_assignment` mirroring `FACULTY#.subtopic_scores` 1:1
- **(e)** project the granular `TOPIC#` rows directly into `publication_topic` — store ground truth, derive aggregations

**(e) was chosen.** Full rationale in `02-SCHEMA-DECISION.md`.

## D-02 decision

**Locked: candidate (e).** See `02-SCHEMA-DECISION.md` for the full Prisma sketch, surface query map, alternative-disqualifier table, and migration risks. Plan 05 will refine and apply.

## Out-of-scope deferrals captured

- **`TOOL#` / `TOOL_INDEX#`:** the inferred-tools dataset (14,736 rows total). Genuine product opportunity but no design backing in v1.7.1, no requirement ID, and no UI placement decided. Full out-of-band analysis (audience fit, schema sketch, phasing estimate, validation plan, counterargument) saved to `.planning/research/inferred-tools-feature-brief.md` for a future milestone-planning conversation.
- **`DEEPDIVE#`:** Phase 3+.
- **`FACULTY#` aggregation columns** (`h_index`, `article_count`, `first_author_count`, `last_author_count`): not projected in Phase 2; derive from `publication_topic` if ever needed.

## Verification gates

- `etl/dynamodb/probe.ts` exists, compiles cleanly (zero typecheck errors in this file)
- Probe script is read-only — no `prisma.*` calls, no `EtlRun` row creation
- `probe-output.json` is valid JSON with non-empty `prefixes` and `samples` objects (verified: 7 prefixes, samples per prefix)
- 14 distinct CWID-shaped strings + all faculty `name` fields redacted from FACULTY# samples before commit (T-02-02-01 mitigation; `.planning/` is tracked in this public repo per repo discipline)
- Schema shape fully preserved through redaction (all field names, types, structure intact)
- `02-SCHEMA-DECISION.md` exists with locked candidate, probe-evidence rationale, Prisma model sketch, and migration risks

## Deviations

1. **Candidate (e) is new vs CONTEXT.md.** The original D-02 menu was (a/b/c). The probe surfaced an empirical shape that none of (a/b/c) handled well, and a/b/c/d were all suboptimal versus storing the ground truth `TOPIC#` rows directly. Candidate (e) was added during the human-review step, evaluated against probe evidence, and selected. CONTEXT.md is not amended (locked); the decision lives in this SUMMARY and in 02-SCHEMA-DECISION.md, which are the consumed-by sources for Plans 05/07/08.
2. **Inferred-tools out-of-band brief.** The probe surfaced `TOOL#` (14,721 rows) and `TOOL_INDEX#` (15 rows) — interesting data not part of the Phase 2 spec. Rather than discard the finding or scope-creep Phase 2, a thorough out-of-band analysis was saved to `.planning/research/inferred-tools-feature-brief.md` (frontmatter, audience fit, schema sketch, phasing estimate, hard questions, counterargument, validation plan). This file is a planning artifact for a future milestone, not a Phase 2 commitment.
3. **Pre-existing typecheck errors (37 across `lib/api/profile.ts`, `lib/db.ts`, `seed/publications.ts`, `etl/dynamodb/index.ts`)** logged in `deferred-items.md` per execute-plan SCOPE BOUNDARY. Out of scope for this plan — present on base commit, unrelated to probe work.

## Self-Check: PASSED

- Probe ran successfully against the live `reciterai-chatbot` table in `us-east-1`
- All 7 PK prefixes captured with sample records
- Schema decision is grounded in probe evidence (not speculation)
- Plan 05 has a concrete contract to migrate to
- No PII committed (CWIDs and faculty names redacted)
- No Prisma writes from probe script
- No EtlRun rows created
- STATE.md and ROADMAP.md untouched per parallel-executor protocol

## Files

| File | Status |
|------|--------|
| `etl/dynamodb/probe.ts` | new |
| `.planning/phases/02-algorithmic-surfaces-and-home-composition/probe-output.json` | new (redacted) |
| `.planning/phases/02-algorithmic-surfaces-and-home-composition/02-SCHEMA-DECISION.md` | new |
| `.planning/phases/02-algorithmic-surfaces-and-home-composition/02-02-SUMMARY.md` | new (this file) |
| `.planning/phases/02-algorithmic-surfaces-and-home-composition/deferred-items.md` | new (typecheck errors) |
| `.planning/research/inferred-tools-feature-brief.md` | new (out-of-band) |

## Commits

| SHA | Subject |
|-----|---------|
| `f78b116` | feat(02-02): add DynamoDB probe and capture reciterai-chatbot shape |
| (this commit) | docs(02-02): lock D-02 schema decision (candidate e) and complete plan |
