# Handoff — extend the ReciterAI entity layer to more method families

**Created:** 2026-06-22 · **For:** ReciterAI producer work (you to execute) · **Repo:** `wcmc-its/ReciterAI` (`pipeline_tools`)
**Why:** SPS #1168 (the per-paper usage snippet + "How it was used" / "Where it appears" badge) is live on staging, but it only renders where the producer has emitted an **entity layer**. Today that's **131 entities across 7 families, all cell-line families in `animal_cell_models`**. Families like *Primary cell culture models* — and everything outside cell lines — have no entities, so no rail and no badges.

This handoff is the **producer-side** change to broaden that coverage. **No SPS change is required** — the #1210 consumer already serves any family's entities (gated by `METHODS_LENS_ENTITY_USAGE`/`METHODS_LENS_CELL_LINE_ENTITIES`, both on staging); once the producer emits more families and you re-publish + re-backfill, those pages light up automatically.

---

## 1. Current state (verified 2026-06-22)

- Live artifact `s3://wcmc-reciterai-artifacts/tools/latest/` (`tools-a2-v4`, `v2026-06-22`): `entities.json` = 131 entities, `entity_context.json` = 131.
- All 131 entities are in **7 cell-line families** (`animal_cell_models`): Cancer cell lines (43), Immortalized (29), Pluripotent stem (24), Genetically engineered (21), Neuronal (8), Hematopoietic (3), Stably transfected reporter (3).
- All `dominant_kind = organism_or_cells`, all `is_generic = false`.

## 2. Why coverage is cell-line-only

`pipeline_tools/entities.py`:
- `build_entity_layer(registry, families, ..., scope=is_cell_line_family)` (`:146-151`) — `scope` is an **injectable predicate**.
- `is_cell_line_family(family)` (`:82-86`) returns true only when `dominant_kind == "organism_or_cells"` **AND** the label matches `/cell line/i` (`CELL_KIND` + `_CELL_LINE_LABEL`, `:67-68`).
- The build loop skips everything else: `for fam in families: if not scope(fam): continue` (`:171-173`).
- The resolution/nesting helpers (`_cell_line_core`, the digit-token designator at `:74-77`) are **cell-line-specific** — they nest forms by a cell-line core token (`3T3-L1`), which doesn't generalize to reagents/datasets/instruments.

So widening the *scope* is trivial; the real work is **resolving + normalizing specific entities of other kinds** — which is exactly **ReciterAI #252 (WS-B)**.

## 3. Two increments

### Increment 1 — widen to all `organism_or_cells` families (cheap, low value)
Drop the `/cell line/i` guard so primary-culture / animal-model families are projected too.
- **Change:** a broader `scope` (e.g. `lambda f: f.get("dominant_kind") == "organism_or_cells"`), or relax `is_cell_line_family`.
- **Caveat:** primary cultures are usually described **generically** ("primary fibroblasts", "primary hepatocytes") rather than as specific named lines, so this yields few specific entities — and those that are generic should be flagged `is_generic=true` (WS-B) so SPS soft-suppresses them (renders them non-interactive). Net: *Primary cell culture models* may still show little. Low effort, modest payoff.

### Increment 2 — the real generalization (ReciterAI #252 / WS-B), all kinds
Project entities for **all families across all 14 supercategories**, resolving specific entities of every `kind` (reagents → specific antibodies/plasmids; datasets → specific cohorts; instruments → specific platforms; methods → specific named assays), with WS-B vocabulary normalization.
- **Scope:** `scope = lambda f: True` (or an "active, non-suppressed family" predicate).
- **Resolution:** generalize beyond `_cell_line_core` — the WS-B normalization (#252) must canonicalize surface variants (HMC-1 ×3 → one), drop 0-count phantoms, keep near-duplicates distinct (293 vs 293T), and **flag generics** (`is_generic=true`) so non-specific buckets ("macrophage cell line", "antibody", "regression model") don't pollute the rail. The SPS consumer already reads `is_generic` and soft-suppresses.
- `dominant_kind` is already emitted per entity (#260), so the SPS rail noun ("Reagents"/"Datasets"/…) lights up automatically once non-cell-line families carry entities.

## 4. Producer steps (you)

1. **Scope + resolution** in `pipeline_tools/entities.py` (Increment 1 for a quick win, or #252 for the real one). Keep the `scope=` parameter injectable so cell-line-only runs remain reproducible.
2. **WS-B normalization (#252)** so `is_generic` / `vocab_normalized_form` are populated for the broader set (the SPS columns already exist and ingest them).
3. **Re-publish** `entities.json` + `entity_context.json` (additive, no schema-version bump — mirrors #260) to `s3://wcmc-reciterai-artifacts/tools/latest/`. Use the entity-only sidecar publish path so you don't regress the live `tool_context` (the #239 sentence-aligned data) — same trap noted in the cell-line rollout.
4. Confirm the published `entities.json` count grew and now spans >1 supercategory.

## 5. SPS step (after the producer re-publishes) — one in-VPC backfill

No code change. Re-run the SPS staging backfill so the new families/entities land in `family_entity*`:

```bash
# dry-run first (no writes) — confirms the new mapper reads the broader artifact
aws ecs run-task --cluster sps-cluster-staging --task-definition sps-etl-staging \
  --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[subnet-019afebef588ee4b3,subnet-03de6e3dfe190288b],securityGroups=[sg-09b494047547ea148],assignPublicIp=DISABLED}' \
  --overrides '{"containerOverrides":[{"name":"etl","command":["npm","run","etl:scholar-tool"],"environment":[{"name":"SCHOLAR_TOOL_DRY_RUN","value":"1"}]}]}' \
  --region us-east-1
# then the real run: same command WITHOUT the SCHOLAR_TOOL_DRY_RUN env
```
Check the task's CloudWatch logs (`/aws/ecs/sps-etl-staging`, stream `etl/etl/<task-id>`) for `write_complete` with a higher `entity_rows` and a non-cell-line `mention_class_dist`. The `etl:scholar-tool` source (`SCHOLAR_TOOL_SOURCE=s3`) is baked into the task def. (This is the exact procedure used for the 2026-06-22 cell-line backfill.)

Then render-verify a newly-covered family page (rail header should read the right noun per `dominant_kind`).

## 6. Notes / guardrails

- **SPS is ready** — `isMethodsLensEntityLayerOn()` already serves any family; the rail noun, generic soft-suppression, and the usage badge are all kind-agnostic.
- **Expect sparsity** in families whose entities are mostly generic (primary cultures, many method families) — that's correct behavior (generics soft-suppressed), not a bug.
- **Prod** stays gated until prod entity data + the prod flag flip (separate go-live step).
- Tracks **ReciterAI #252** (WS-B) and complements **#253** (informativeness, already feeding the badge) / **#260** (`dominant_kind`, already emitted).
