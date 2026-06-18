# Tool-context (#1119) — rollout runbook

Ingest of the ReciterAI **tool-context** artifact (`tools/latest/tool_context.json`,
`tool_context_kind: "tool_usage_snippet"` — `tool_id → { pmid → usage sentence }`, 13,652 tools)
and its surfacing across the overview generator, the Methods UI, and people search.

Everything ships **dark**: the snippet columns are NULL until the tools ETL re-runs on this code, and
every consuming surface is behind a default-off flag **and** the existing #800/#801 family-overlay gate.

## What landed (all flag-/data-gated)

| Part | Area | Gate |
|------|------|------|
| 1 | ETL: fetch + sha-verify `tool_context.json`; best-snippet mapper; populate `scholar_tool.sample_context` (global per-tool) + new `scholar_family.exemplar_contexts` (per exemplar, family-pmid-scoped) | data-gated (next ETL run) |
| 0 | Overview generator grounds on the exemplar usage snippet (injection-safe DATA, grounding-eligible like `synopsis`; the #879 `definition` stays RENDER-ONLY) | data-gated |
| 2 | Profile per-tool usage hover; family-page "How researchers use these tools" strip; search method-badge exemplar hover | `METHODS_LENS_TOOL_CONTEXT` + #800/#801 overlay |
| 3 | Index `methodContext` field; gated relevance boost | `SEARCH_PEOPLE_METHOD_CONTEXT` + reindex |

Best-snippet rule: junk filter (drop bare URLs / `available at …` / `<25` chars), then prefer snippets that
**name the tool**, then **longest**, clamped to 240 chars, keeping the source pmid for provenance.
(Chosen against the live artifact: per-tool survivor count is p50=1 / p90=2, so best-of-N only bites on the
generic high-frequency tools the Methods lens already deprioritizes.)

## Go-live sequence (per env, staging first)

1. **Migrate.** The CD migrate step applies `20260618130000_add_scholar_family_exemplar_contexts`
   (nullable `JSON` column — applies cleanly to the populated table).
2. **Backfill the data.** Run the tools ETL on this code so the mappers populate the new columns:
   `SCHOLAR_TOOL_SOURCE=s3 npm run etl:scholar-tool` (or the run-task). Dry-run first:
   `tsx etl/tools/index.ts --dry-run` and confirm the `tool_context_loaded`, `mapped`
   (`with_sample_context`), and `mapped_families` (`families_with_exemplar_context`) coverage logs.
3. **Reindex people** (Part 3 only): `npm run search:index:people` so docs carry the new `methodContext`
   field. (The UI surfaces in Part 0/2 read Aurora directly and need no reindex.)
4. **Flip the flags + deploy.** Set in the per-env `environment:` block in `cdk/lib/app-stack.ts`
   (CD only re-rolls the image; a new env key needs a `cdk deploy`):
   - `METHODS_LENS_TOOL_CONTEXT=on` → `cdk deploy --exclusively Sps-App-<env>`
   - `SEARCH_PEOPLE_METHOD_CONTEXT=on` (after the reindex) → same deploy
5. **Soak + measure on staging.** `methodContext` is prose; confirm it doesn't over-match (it relies on the
   people minimum-should-match — the #1056/#1090 lesson) before any prod flip.
6. **Prod.** Repeat 1–5 in prod once staging is signed off.

## Known follow-up — close BEFORE the staging flag flip

**Per-publication suppression immediacy (ADR-005).** The stored snippet keeps no source
pmid, so the render paths (`pickMethodContext`, `getFamilyToolUsage`, the profile hover)
cannot drop a snippet whose source publication is later taken dark or author-hidden via
`/edit` — it persists until the next full-replace tools ETL. The sibling representative-papers
path drops such pubs instantly. Bounded risk (the rendered text is a generic "how researchers
use X" sentence with no title/pmid/author attribution, and the cwid is an already-public hit),
and inert while the flag is off. Fix before flipping `METHODS_LENS_TOOL_CONTEXT` on: either
persist the source pmid alongside each snippet and re-check it against
`loadPublicationSuppressions`/`isAuthorHidden` at render time, or intersect candidate pmids
against the non-suppressed set at ETL selection time. (Surfaced by the #1119 adversarial review.)

## Notes

- The artifact integrity is sha256-verified against the manifest when present; a **present but corrupt**
  `tool_context.json` fails the run, while an **absent** object (pre-v3 manifest) is benign (columns stay null).
- The snippets are extracted publication text — no PII, public content. They are grounding-eligible for the
  overview generator but always treated as injection-safe DATA in any LLM prompt.
