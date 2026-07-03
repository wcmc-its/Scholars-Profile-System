# GrantRecs → ReciterAI handoff: publish funding-opportunity records

**Audience:** ReciterAI engineering (the `pipeline_grants` engine).
**Goal:** populate the SPS GrantRecs matchers (forward "Grants for me" *and* reverse
`/edit/find-researchers`) by emitting one `GRANT#` item per funding **opportunity**
into the `reciterai` DynamoDB table. SPS already consumes this shape; it is just empty.

Grounded in SPS `origin/master` @ `c088defa`:
`etl/dynamodb/grant-opportunity-mapper.ts`, `etl/dynamodb/grant-opportunity-etl.ts`,
`lib/api/match-researchers.ts`, `lib/search.ts`.

---

## 1. Current state (verified 2026-06-21)

- The SPS reverse matcher renders, but every search returns 0 researchers.
- Root cause: the `reciterai` DynamoDB table (acct `665083158573`, the source the
  SPS ETL reads via `SCHOLARS_DYNAMODB_TABLE ?? "reciterai"`) contains **zero**
  `GRANT#` items — a full paged `COUNT` scan returned `Count: 0` of `161,006`
  scanned items.
- Consequence: the SPS `opportunity` table is empty → `rankResearchersForOpportunity()`
  does `opportunity.findUnique(id)` → `null` → returns `[]` for **any** ID typed.

**Nothing is broken on the SPS side. The opportunity corpus has never been produced.**

---

## 2. What ReciterAI must do

Run/ship the `pipeline_grants` engine so it, on a recurring cadence:

1. **Ingests** funding *opportunities* (grants.gov, NIH Guide, foundations, …) — note
   these are open *opportunities/NOFOs*, NOT awarded grants.
2. **Filters to research** opportunities (sets `is_research`).
3. **Classifies each opportunity into the SPS/ReciterAI topic taxonomy** → `topic_vector`
   (see §4 — this is the make-or-break step).
4. **Estimates career-stage appeal** → `appeal_by_stage` (see §5).
5. **Writes** one item per opportunity to the `reciterai` DynamoDB table with the
   exact key + field shape in §3.

Write to **staging first** (acct `665083158573`, table `reciterai`). Mirror to the
prod table only after staging is validated (§7).

---

## 3. DynamoDB item contract

| Attr | DDB key | Type | Req? | Notes |
|---|---|---|---|---|
| `PK` | partition | `GRANT#<opportunity_id>` | ✅ | e.g. `GRANT#grants_gov:359855` |
| `SK` | sort | `META` | ✅ | one META row per opportunity |
| `opportunity_id` | | string | ✅ | stable unique id; also parsed from PK if absent. `<source>:<native_id>` recommended |
| `title` | | string | ✅ | **drops the record if blank** |
| `synopsis` | | string | ✅ | **drops the record if blank** |
| `topic_vector` | | `[{topic_id, score, rationale?}]` | ✅ effectively | **see §4.** No topic ≥ 0.3 ⇒ matcher returns `[]` |
| `appeal_by_stage` | | `{grad,postdoc,early,mid,senior}` (numbers) | ⚠️ | needed for the "Weight by career-stage fit" lens; see §5 |
| `is_research` | | boolean | ⚠️ | `false` ⇒ **skipped**. Absent ⇒ treated as research |
| `primary_topic_id` | | string | optional | a topic_id; display/index hint |
| `source` | | string | optional | e.g. `grants_gov`, `nih_guide` |
| `source_url` | | string | optional | canonical opportunity URL |
| `sponsor` | | string | optional | e.g. `National Institutes of Health` |
| `status` | | string | optional | e.g. `open`, `forecasted`, `closed` |
| `mechanism` | | string | optional | e.g. `R01`, `K99/R00` |
| `open_date` | | ISO date string | optional | blank/absent ⇒ null |
| `due_date` | | ISO date string | optional | blank/absent ⇒ "continuous" (null) |
| `eligibility_raw` | | string (prose) | optional | SPS derives structured flags from this text — do **not** pre-structure it |
| `cfda_list` | | string[] | optional | e.g. `["93.310"]` |
| `award_ceiling` / `award_floor` / `estimated_funding` | | number | optional | coerced to BigInt (truncated) |
| `number_of_awards` | | number (int) | optional | |
| `mesh_descriptor_ui` | | string[] | optional | MeSH UIs; stored as-is |
| `taxonomy_version` | | string | recommended | the topic-taxonomy version used for `topic_vector` (see §4) |
| `ingested_at` | | ISO datetime string | recommended | falls back to epoch 0 if absent |

Items are read via the DocumentClient, so emit **plain attributes** (no `{"S":…}`
wrapping). The SPS upsert is idempotent on `opportunity_id`, so re-emitting is safe.

---

## 4. ⚠️ `topic_vector` — the critical alignment requirement

This is what silently breaks matching if wrong.

```json
"topic_vector": [
  { "topic_id": "implementation_science", "score": 0.82, "rationale": "…" },
  { "topic_id": "health_services_research", "score": 0.55 }
]
```

Rules:

- **`topic_id` MUST be a ReciterAI *parent-topic* slug** — the SAME namespace used for
  publication/scholar topic assignments. In DynamoDB those are the `TOPIC#<id>` items;
  SPS stores the id as `publication_topic.parentTopicId = PK.replace("TOPIC#","")`.
  Example real slugs: `implementation_science`, `palliative_end_of_life_care`.
  An id that isn't a real parent-topic contributes **nothing** (it matches no
  publications), so the opportunity effectively has no topics.
- **`score`** is a relevance weight (treat as 0–1). The reverse matcher keeps only
  topics with **`score ≥ 0.3`** (`OPPORTUNITY_TOPIC_GATE`), takes the **top 8**, and
  weights each researcher's topic strength by it. **At least one topic must clear 0.3**
  or the result is empty.
- Use the **same topic classifier/taxonomy version** already used to topic-tag
  publications, and stamp it in `taxonomy_version`. If the opportunity taxonomy drifts
  from the publication taxonomy, the join degrades quietly.
- `rationale` is optional free text (not used for ranking; useful for explainability).

How SPS uses it (for context): for each top topic it fans across the existing
per-topic scholar aggregation (first/last author, full-time faculty, pubs year ≥ 2020,
non-excluded types), scores with the Variant-B curve, and sums
`Σ_t (topicWeight · scholarTopicScore)` into the `topicFit` axis.

---

## 5. `appeal_by_stage`

```json
"appeal_by_stage": { "grad": 0.2, "postdoc": 0.6, "early": 1.0, "mid": 0.7, "senior": 0.4 }
```

- Keys are exactly the SPS `CareerStage` buckets: **`grad`, `postdoc`, `early`, `mid`,
  `senior`** (numbers; treat as 0–1 appeal).
- Drives the `stageAppeal` axis and the page's **"Weight by career-stage fit"** toggle
  ("who would this suit"). The default lens leaves stage out ("who *could* apply"), so
  an opportunity with no/partial `appeal_by_stage` still matches on topic fit — but the
  stage lens will be uninformative without it.
- Eligibility (US/faculty/postdoc/student-only/limited-submission) is derived by SPS
  from `eligibility_raw` prose — keep that as natural language; don't fold it into
  `appeal_by_stage`.

---

## 6. Complete worked example (one item)

```json
{
  "PK": "GRANT#grants_gov:359855",
  "SK": "META",
  "opportunity_id": "grants_gov:359855",
  "source": "grants_gov",
  "source_url": "https://www.grants.gov/search-results-detail/359855",
  "sponsor": "National Institutes of Health",
  "title": "Dissemination and Implementation Research in Health",
  "synopsis": "Supports investigator-initiated research on dissemination and implementation.",
  "status": "open",
  "open_date": "2026-01-15",
  "due_date": "2026-09-01",
  "eligibility_raw": "Public/State Controlled Institutions of Higher Education",
  "cfda_list": ["93.310"],
  "mechanism": "R01",
  "award_ceiling": 500000,
  "award_floor": 50000,
  "estimated_funding": 3000000,
  "number_of_awards": 6,
  "primary_topic_id": "implementation_science",
  "topic_vector": [
    { "topic_id": "implementation_science", "score": 0.82, "rationale": "core focus" },
    { "topic_id": "health_services_research", "score": 0.51 }
  ],
  "appeal_by_stage": { "grad": 0.1, "postdoc": 0.5, "early": 1.0, "mid": 0.8, "senior": 0.5 },
  "is_research": true,
  "mesh_descriptor_ui": ["D000074243"],
  "taxonomy_version": "<topic-taxonomy-version>",
  "ingested_at": "2026-06-21T00:00:00Z"
}
```

(Mirrors the SPS mapper unit-test fixture in `tests/unit/grant-opportunity-mapper.test.ts`.)

---

## 7. Acceptance / validation

ReciterAI side:
1. `aws dynamodb scan --table-name reciterai --filter-expression "begins_with(PK,:p)"
   --expression-attribute-values '{":p":{"S":"GRANT#"}}' --select COUNT` → **> 0**.
2. Spot-check a few items: required fields present; `topic_vector` topic_ids are real
   parent-topic slugs; ≥ 1 topic with `score ≥ 0.3`.

SPS side (operator, after ReciterAI publishes):
3. Run the DynamoDB projection ETL: **`npm run etl:dynamodb`** (it scans `GRANT#`,
   upserts the `opportunity` table; log line "Found N GRANT# records"). Then rebuild
   the opportunity search index: **`npm run search:index`**.
4. In `/edit/find-researchers`, enter a real `opportunity_id` (e.g. `grants_gov:359855`)
   → expect a ranked researcher list. Confirm `/api/opportunities/<id>/researchers`
   returns `count > 0`.

Do staging → validate → then repeat for prod.

---

## 8. Open questions for ReciterAI

- Does `pipeline_grants` exist/run today, or is it net-new? (Mapper comments + the
  `2026-06-19-grantrecs-phase2-matching-engine-design.md` spec reference it, but no
  `GRANT#` items have ever been written.)
- Cadence + which opportunity sources are in scope for launch.
- Confirmation that the opportunity topic classifier shares the publication topic
  taxonomy (and version) — the single biggest correctness risk.
