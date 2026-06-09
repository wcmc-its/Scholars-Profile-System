# Scholar tools / method-family taxonomy — source, ETL, and schema

**Answers:** *"Where does the Methods & tools data come from?"*, *"What is the `scholar_tool`
table and how is it populated?"*, *"Is the tools taxonomy in DynamoDB?"* (no — see below),
*"How do I export the method-family taxonomy for review?"*

The **Methods & tools** lens on a scholar profile (#799/#800/#801) is backed by a *canonical
tool / method-family taxonomy* produced by **ReciterAI** and consumed by SPS. This doc is the
authoritative pointer to **where that taxonomy lives, what shape it is, and how SPS ingests it.**

---

## TL;DR — the one fact people get wrong

> **The canonical taxonomy is NOT in DynamoDB.** It is published by ReciterAI as a set of
> JSON artifacts on **S3**. The legacy `reciterai` DynamoDB table *does* hold `TOOL#` items,
> but those are **per-PMID activity rows**, not the canonical tool/family registry. A
> projected `Scan` of DynamoDB looking for `disposition == "method_tool"` families returns
> **nothing** — those attributes only exist in the S3 artifact.

| | Canonical registry (what you want) | Legacy DynamoDB `TOOL#` |
|---|---|---|
| **Location** | `s3://wcmc-reciterai-artifacts/tools/latest/{tools,families}.json` | `reciterai` table, `PK = TOOL#<tool_name>` |
| **Grain** | one row per **canonical tool**; one row per **method family** | one row per (tool × PMID × CWID) **observation** |
| **Key attrs** | `disposition`, `kind`, `method_family_id`, `pub_count`, family `label`/`dominant_kind`/`status` | `tool_category`, `score`, `context`, `faculty_uid`, `pmid` |
| **SK** | n/a (JSON array) | `SCORE#<conf>#ACTIVITY#pmid_<pmid>#cwid_<cwid>` |
| **Produced by** | `pipeline_tools` (ReciterAI A2) → `publish.py` → S3 | legacy ReciterAI scorer write path |

---

## 1. Source of record — the A2 artifact set on S3

Published by ReciterAI to `s3://wcmc-reciterai-artifacts/tools/`, with a `latest/` mirror and a
manifest carrying per-object SHA-256:

| Object | Contents |
|---|---|
| `tools/latest/manifest.json` | `schema_version` (`tools-a2-v1`), `version` (e.g. `v2026-06-09`), `generated_at`, per-object byte size + `sha256`, and `counts` |
| `tools/latest/tools.json` | **Superset.** Top-level keys: `tools[]`, `families[]`, `hierarchy`, `faculty{}`, `grant_signal`, `telemetry`, `provenance`, `salience_thresholds`, `exceptions_summary`. The SPS loader fetches this one object. |
| `tools/latest/families.json` | The family registry alone (`families[]` + `hierarchy`) — identical `families[]` to `tools.json`. |
| `tools/latest/faculty.json` | The per-CWID rollup (also embedded in `tools.json` as `faculty{}`). |

Reference counts (manifest `v2026-06-09`): **18,410 tools · 872 families · 1,316 faculty.**

### `tools[]` — canonical tool record

| Attribute | Notes |
|---|---|
| `canonical_tool_id` | opaque durable id (e.g. `tool_000188`) |
| `display_name` | render name (fixes legacy slug-mangling, e.g. `C57BL/6` not `C57BL_6` — #765) |
| `disposition` | `method_tool` \| `infrastructure` \| `excluded` — **the gate**; only `method_tool` is surfaced |
| `kind` | `instrument`/`reagent`/`assay`/`software`/`method`/`model`/`dataset`/`organism_or_cells` |
| `supercategory` | one of ~14 closed-set supercategories |
| `method_family_id` | family this tool belongs to (the join key; was called "member_of_family" in early specs) |
| `method_family_label` | family display label carried on the tool |
| `salience_tier` (+`_basis`) | `S`/`A`/`B`/`C`; secondary ordering signal only (see mapping) |
| `pub_count` | publications mentioning this canonical tool |
| `aliases`, `context_evidence`, `attributes`, `classified_by` | provenance/matching internals — **not surfaced** |

### `families[]` — method-family registry

| Attribute | Notes |
|---|---|
| `family_id` | opaque durable id (e.g. `fam_0180`) |
| `label` | family display label (the attribute is `label`, **not** `display_label`) |
| `supercategory` | family's supercategory |
| `dominant_kind` | most common `kind` among members |
| `status` | `active` \| `provisional` |
| `member_tool_ids`, `exemplar_tool_ids` | canonical-tool-id membership (exemplars resolve to display names) |

---

## 2. How SPS ingests it

The repoint from the legacy DynamoDB scan to the S3 taxonomy is **#794** (the migration is
reversible behind a per-env switch).

```
ReciterAI A2 (S3)  ──►  etl/tools/index.ts (loader)  ──►  scholar_tool table  ──►  lib/edit/overview-facts.ts (reader)
                         manifest poll + sha256 +                                   → profile "Methods & tools" lens
                         per-object integrity + full-replace
```

| Piece | File |
|---|---|
| ETL job | `npm run etl:scholar-tool` → `etl/tools/index.ts` (mirrors `etl/spotlight`: manifest poll, sha256 short-circuit, full-replace) |
| Tool mapper | `etl/tools/scholar-tool-mapper-s3.ts` |
| Family mapper | `etl/tools/scholar-family-mapper-s3.ts` |
| Source switch | `lib/etl/scholar-tool-source.ts` → `resolveScholarToolSource()` |
| Legacy path | `etl/dynamodb/index.ts` (Block 5) + `etl/dynamodb/scholar-tool-mapper.ts` |
| Reader | `lib/edit/overview-facts.ts` (the only consumer of `scholar_tool`) |

### The `SCHOLAR_TOOL_SOURCE` switch (reversible cutover)

Set per-env in the ETL container `environment:` (wired in `cdk/lib/etl-stack.ts`):

| Value | Behaviour |
|---|---|
| `ddb` *(default)* | Legacy DynamoDB Block 5 owns the `scholar_tool` table; `etl:scholar-tool` is a freshness-green **no-op**. |
| `s3` | `etl:scholar-tool` is the **sole writer** (A2 canonical taxonomy); Block 5 skips. |

`etl:scholar-tool -- --dry-run` parallel-runs the S3 path and diffs against the live table
**without** writing — safe to run while `ddb` still owns it. An unrecognized value warns and
falls back to `ddb`. Both writers are wired permanently; the flag is the only switch.

> **Deploy ordering matters.** "Tools" is a freshness-tracked nightly step, so
> `cdk deploy Sps-Etl-<env>` must run (it adds the nightly Tools step + `TOOLS_BUCKET`/
> `TOOLS_PREFIX`/`SCHOLAR_TOOL_SOURCE` env + the `tools/*` read grant) **before** the freshness
> heartbeat expects it — otherwise it false-alarms "Tools STALE." CD rolls the image only, not
> CDK. See [`etl-monitoring.md`](./etl-monitoring.md), [`dependency-outage-matrix.md`](./dependency-outage-matrix.md).

### Field mapping into `scholar_tool`

The reader (`overview-facts.ts`) consumes exactly four columns ordered `[pmidCount desc,
maxConfidence desc]`, top-N per scholar. The S3 mapper fills them as:

| `scholar_tool` column | A2 source |
|---|---|
| `toolName` | `tools[].display_name` (faculty-side `display_name` fallback) |
| `category` | `tools[].method_family_label` |
| `pmidCount` | `faculty[cwid].tools[].pub_count` (the "used in N papers" count) |
| `maxConfidence` | `salience_tier` → `S:0.9 / A:0.7 / B:0.5 / C:0.3`, unknown `0.1` — **orderBy tiebreak only; never displayed or sent to an LLM** |

Rows are grouped by `(cwid, tool display name)`, matching the table's `@@unique([cwid, toolName])`.

---

## 3. The display lens (status)

The profile **Methods & tools** lens is family-primary (family title + member tools inline)
and is being built under #799 (display), #800 (suppress non-distinctive families/tools), and
#801 (audience-gated visibility — e.g. animal-model supercategories hidden from public viewers,
an access-control gate, not editorial). It currently ships **dark** behind flags; mockups live
in [`mockups/methods-lens/`](./mockups/). This doc covers the **data plane** (source + ETL),
which is operational regardless of the display flags.

---

## 4. Exporting the taxonomy for a consolidation review

To pull the taxonomy out for offline family-consolidation review (group `method_tool` tools by
`method_family_id`, join the family registry, top-12 members per family, per-supercategory files
+ a flat label index), use:

```
~/Dropbox/Projects/ReciterAI/method-family-consolidation/export-method-families.mjs
```

Node built-ins only; `aws s3 cp`s the two `tools/latest/` artifacts (cache in `/tmp`,
`--refresh` to re-pull) and emits `families-<supercategory>.json` × N + `family-label-index.json`
+ `_meta.json`. The 2026-06-09 run grouped 18,314 `method_tool` tools (795 unfamilied, excluded
and logged) into 872 families across 14 supercategories. **Note:** the export's per-family
`n_pubs` is **approximate** (sum of per-tool `pub_count`; double-counts publications that use
multiple tools in the same family).

---

## Related

- **Issues:** #794 (source repoint, migration gate) · #799/#800/#801 (Methods lens display, suppression, audience gating) · #765 (slug-mangling fixed by canonical `display_name`)
- **ReciterAI (producer) docs:** `docs/tools-a2-architecture.md`, `docs/tool-classifier-spec.md`, `docs/tools-producer-model.md`
- **SPS docs:** [`dependency-outage-matrix.md`](./dependency-outage-matrix.md) (ReciterAI as an upstream), [`data-dictionary.md`](./data-dictionary.md) (`scholar_tool` table), [`spotlight-integration-plan.md`](./spotlight-integration-plan.md) (the analogous ReciterAI→S3→SPS integration)
