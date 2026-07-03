# Methods lens — production go-live runbook

Status: **PREP / planning.** The methods suite is staging-live + verified, prod-dark. This runbook is the operator package for flipping it on in prod. Diffs captured 2026-06-14 against `origin/master` @ `9511b550`; **re-diff immediately before deploying** (master is moving under an active parallel session).

## What "methods go-live" covers
One flip activates the whole suite on prod:
- Center "Methods & tools" facet + per-row chips (#962/#965, +#970/#972).
- Department/division per-row chips (#974 Phase 1, #976).
- Department/division facet (#974 Phase 2, #983) — incl. the `/api/units/[kind]/[code]/members` route.
- The underlying methods lens, /methods pages, family overlays (#799/#800/#801/#824/#879).

## The core problem: it is NOT a flag flip
The methods flags are coded `env === "staging" ? "on" : "off"` (`cdk/lib/app-stack.ts`), so **prod resolves to `off`** — a prod deploy from current master keeps methods **dark**. Going live requires **two code changes + a data load**:

1. **Code (app-stack.ts):** flip prod → `on` for `METHODS_LENS_ENABLED`, `CENTER_METHODS_FACET`, `ORG_UNIT_METHODS_CHIPS`, `ORG_UNIT_METHODS_FACET` (and, per the staging config, `METHODS_LENS_SENSITIVE_GATE`, `METHODS_LENS_FAMILY_FILTER`, `METHODS_LENS_FAMILY_DEFINITIONS`; `METHODS_LENS_PAGES` is already prod=on but inert).
2. **Code (etl-stack.ts):** flip prod → `s3` for `SCHOLAR_TOOL_SOURCE` (currently `ddb`; prod `scholar_family` is unpopulated).
3. **Data:** after the Etl deploy, run `etl:scholar-tool` (`tsx etl/tools/index.ts`) to load prod `scholar_family` from `s3://wcmc-reciterai-artifacts/tools/latest/`; verify the table is non-empty before flipping `METHODS_LENS_ENABLED`.

## The diffs (all three prod stacks are far behind master — entangled batches)

### `Sps-App-prod` (`/tmp/diff-app-prod.txt`, 686 lines)
- **26 env vars added, 0 removed.** Task def replaced; rolling restart.
- Methods/family flags land **OFF** (see core problem). `METHODS_LENS_PAGES=on` (inert).
- ⚠️ **Bundled activation** — the same deploy turns ON, for the first time in prod: `SELF_EDIT_MANUAL_HIGHLIGHTS`, `MENTORING_COPUB_BRIDGE`, `PUBLICATION_CITING_BRIDGE`, `SEARCH_PUB_DEPARTMENT_FILTER`, `COMMS_STEWARD_ENABLED` (all coded prod=on, awaiting this release). You cannot ship a methods-only App deploy — the whole env block goes at once. **Confirm each is prod-ready, or set it prod=off in the go-live PR to hold it.**
- **IAM:** `+TaskRoleCloudFrontPolicy` (`cloudfront:CreateInvalidation` — CDN purge), `~TaskRoleBedrockPolicy`, `~DeployRole` (mostly `${AWS::AccountId}`→literal cleanup, benign).

### `Sps-Edge-prod` (`/tmp/diff-edge-prod.txt`, 136 lines)
- **Non-destructive** — strict diff with prod context (`scholars.weill.cornell.edu`, cert `95f77e69…`, WAF `sps-edge-prod-wcm-only`): **WAF + cert + alias all preserved** (no destroy lines).
- Adds 5 CloudFront behaviors (also behind): `/api/units/*/*/members` (#974), `/api/methods/*/*/publications` + `/methods/*/*/scholars` (#824), `/api/profile/*` + `InternalViewerOrp` (#866). The `/api/units` behavior forwards `?method` to the origin (required, or the dept/division facet is inert). Inert until the App flags flip.
- Edge context flags (prod): `env=prod`, `prodAccount=665083158573`, `edgeCustomDomain=scholars.weill.cornell.edu`, `edgeCertArn=arn:aws:acm:us-east-1:665083158573:certificate/95f77e69-4abc-4d2c-b081-b8b5b8572fd6`, `edgeAllowedCidrs=140.251.0.0/16,157.139.0.0/16`. (See `project_edgestack_manual_deploy_context` — omitting these STRIPS WAF/cert/alias.)

### `Sps-Etl-prod` (`/tmp/diff-etl-prod.txt`, 960 lines)
- Adds the **`tools/*` S3 GetObject grant** to `EtlTaskRole` (needed for `etl:scholar-tool`), alongside `citations/*`, `mentoring/*`, `ed/*`.
- ⚠️ Also adds a **whole CDN-reconcile subsystem** (Step Function, task def, EventBridge schedule, 2 CloudWatch alarms, roles) — unrelated to methods, the prod Etl is far behind. `SCHOLAR_TOOL_SOURCE` stays `ddb` until the code flip.

## Go-live order (each prod deploy is reviewer-gated → `paulalbert1` approval)
1. **Code PR** — the two flips above (and decide the bundled-feature holds). Merge → re-diff all three stacks vs the new master.
2. **`cdk deploy Sps-Etl-prod`** (ships `tools/*` grant + CDN-reconcile batch + `SCHOLAR_TOOL_SOURCE=s3`).
3. **`etl:scholar-tool`** → populate + verify prod `scholar_family`.
4. **Reindex** — `METHODS_LENS_PAGES` (search surfacing) and `SEARCH_PUB_DEPARTMENT_FILTER` both want a fresh index first.
5. **`cdk deploy Sps-Edge-prod`** (strict diff + context flags; verify non-destructive) — Edge first so `?method` forwards before the facet renders.
6. **`cdk deploy Sps-App-prod`** (ships the 26 env incl. methods=on + IAM) — verify the diff still matches expectations.
7. **Verify** on `scholars.weill.cornell.edu`: center facet/chips, dept/division chips, dept facet filter (e.g. `/departments/population-health-sciences`, select a method → roster filters), and that suppressed/sensitive families don't surface.

## Coordination
- **Master is moving** (parallel session landing changes). Every diff above is point-in-time at `9511b550`; **re-run all three diffs against the then-current master right before deploying.**
- The prod release is a **single batched event** across App/Edge/Etl — not piecemeal. The bundled non-methods activations (App: 5 features; Etl: CDN-reconcile) should be a conscious go/no-go, not a side effect.
- Captured diffs: `/tmp/diff-app-prod.txt`, `/tmp/diff-edge-prod.txt`, `/tmp/diff-etl-prod.txt`.
