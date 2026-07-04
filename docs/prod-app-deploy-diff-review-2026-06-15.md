# `Sps-App-prod` batched deploy — go/no-go diff review (2026-06-15)

**Reviewer artifact for the operator who runs the prod deploy.** Read this before
`cdk deploy --exclusively Sps-App-prod -c env=prod`.

## How this diff was produced (trustworthy baseline)

- Synthesized from a **clean `origin/master` worktree** (`20a93654`, 2026-06-15), **not**
  the `docs/spotlight-pipeline` branch — that branch's `cdk/lib/app-stack.ts` is 249 lines
  stale and would have produced a wrong diff (this is the same trap that caused the earlier
  no-op `Sps-Etl-staging` deploy).
- Command: `npx cdk diff --strict --exclusively Sps-App-prod -c env=prod` — **env-agnostic**
  (no `-c prodAccount`, per the runbook, to avoid literal-ARN no-op churn).
- Captured: `/tmp/diff-app-prod-fresh.txt` (212 lines), `/tmp/diff-app-prod-strict.txt` (222).
- **Validated 1:1 against the live prod task def `sps-app-prod:19`** (desiredCount 2/2,
  single stable deployment): every flag the diff *adds* is `<ABSENT>` live; every flag it
  leaves *unchanged* (`SELF_EDIT_OVERVIEW_GENERATE=on`, `SECURITY_CSP_MODE=enforce`) is
  present live. The diff is real.

## What the diff actually changes (and only this)

1. **ECS app task-definition env vars** — ~29 additions (see table). No image-line change,
   no `desiredCount` change.
2. **One new IAM policy** `TaskRoleCloudFrontPolicy` — `cloudfront:CreateInvalidation` on
   `arn:aws:cloudfront::<acct>:distribution/*` for the app TaskRole.
3. **Three cosmetic em-dash fixes** — stack `Description` + two CFN `Output` descriptions
   (`EcsDbBootstrapTaskFamily`, `EcsVerifyGrantsTaskFamily`). The `--strict` run confirmed
   these are the "3 omitted non-ASCII" changes. Zero functional impact.

No networking / SG / DB / RETAIN / autoscaling / destructive changes.

---

## ⛔ The one finding that gates everything: the prod image is stale

The app task def references the app image by the **mutable tag** `scholars-app-prod:latest`
(`app-stack.ts:821`). Prod `:latest` currently = git **`30ff64f1`** (pushed **2026-06-09**).
Master is `20a93654` (2026-06-15) — `30ff64f1` is a strict ancestor, **~40 PRs behind**.
Push-to-master builds the **staging** image only; the prod image rolls on a **separate gated
release**.

A `cdk deploy Sps-App-prod` registers a new task-def revision that **re-pulls `:latest`** —
i.e. it runs the **2026-06-09 code** with the new env vars. **All six ON-flip feature readers
are absent from `30ff64f1`** (each merged 06-10→06-12), so:

> **A flags-only deploy against today's image is SAFE but INERT — it activates nothing.**
> It is *not* a crash risk (verified: no half-present feature can half-activate), but it ships
> zero user-visible features plus a dormant IAM policy. To actually deliver these features you
> must **roll a fresh prod image first** (plus the data/index preconditions below).

This corrects the handoff's mental model: the cdk deploy carries the **flags**; the gated
image release carries the **code**. Both (+ data + reindex) are required. The cdk diff being
clean does **not** mean "deploy ships the features."

### Per-flag verdict (the ON-flips)

| Flag | PR | Ships | In `30ff64f1`? | Effect today | To activate (on a fresh image) |
|---|---|---|---|---|---|
| `SELF_EDIT_MANUAL_HIGHLIGHTS` | #836/#839 | `on` | **No** (`lib/edit/manual-highlights.ts` absent) | inert | fresh image only — self-serve |
| `MENTORING_COPUB_BRIDGE` | #443 | `on` | **No** (no flag branch in `lib/api/mentoring.ts`) | inert | fresh image + **Sps-Etl-prod deploy** + `import-aoc/copubs/copub-list`; SOFT (degrades to "temporarily unavailable" if flipped before import) |
| `PUBLICATION_CITING_BRIDGE` | #938 | `on` | **No** (no branch in `publication-detail.ts`) | inert | fresh image + **Sps-Etl-prod deploy** + `import-citing`; SOFT |
| `SEARCH_PUB_DEPARTMENT_FILTER` | #837/#840 | `on` | **No** (reader + `wcmAuthorDepartments` field absent) | inert | fresh image + **prod publications reindex** (`search:index`) — reindex-then-flip; degrades to empty facet (no 500) if flipped pre-reindex |
| `COMMS_STEWARD_ENABLED` | #889 | `on` | **No** (`lib/auth/comms-steward.ts` absent) | inert | fresh image; with empty `GROUP_CN`/`ALLOWLIST` it is **superuser-only / fail-closed** (safe). Provision `SCHOLARS_COMMS_STEWARD_ALLOWLIST` for EA comms staff |
| `METHODS_LENS_PAGES` | #824 | `on` | **No** | inert | **stays dark by design** — gated under `METHODS_LENS_ENABLED=off`; no action |

`SITE_URL=https://scholars.weill.cornell.edu` — correct prod value, benign.

### Dark flags (~20) — all correctly prod-OFF, safe regardless of image

`SEARCH_PEOPLE_SNIPPET_REPRESENTATIVE_PUB`, `SEARCH_SHELL_STREAMING`,
`SEARCH_SUGGEST_MESH_CONCEPT`, `SEARCH_PEOPLE_CONCEPT_PRECOUNT` (B2 optimized state),
`SEARCH_PEOPLE_CONCEPT_GRANT_AXIS` (#921), `COAUTHOR_HIDDEN_STUDENT_CHIPS` (#1026),
`PROFILE_FACET_REDESIGN`, `SCHOLAR_LIST_EXPORT`, `INTERNAL_VIEWER_NETWORK_SIGNAL`,
`SCHOLAR_LIST_EXPORT_EMAIL`, `INTERNAL_VIEWER_CIDRS=""`, `PROFILE_EMAIL_RELEASE_GATE`, and the
whole methods-lens bundle (`METHODS_LENS_ENABLED/SENSITIVE_GATE/FAMILY_FILTER/ROSTER_FALLBACK/
FAMILY_DEFINITIONS`, `CENTER_METHODS_FACET`, `ORG_UNIT_METHODS_CHIPS`, `ORG_UNIT_METHODS_FACET`).
A node-evaluation of all 35 delta ternaries at `env=prod` reproduced the ground-truth diff
exactly — **no value-level posture mismatch anywhere**.

---

## Verdicts

| Dimension | Verdict | Note |
|---|---|---|
| **Infra-safety** | ✅ **GO** | Zero-downtime task-def revision + rolling deploy (circuit-breaker `rollback:true`, 100/200%, 120s grace). IAM grant is **byte-identical to staging's** app TaskRole and **dormant** (`SCHOLARS_CLOUDFRONT_DISTRIBUTION_ID` unset on prod → `CreateInvalidation` is unused). No destructive change. |
| **Flag value posture** | ✅ **GO** | Every value matches documented intended prod posture; comms-steward fails closed to superuser-only. |
| **Feature activation (flags-only, today's image)** | ⛔ **NO-GO / pointless** | Flags are inert against `30ff64f1`. Don't deploy flags alone expecting features. |
| **Feature activation (correct sequence)** | ✅ **GO with preconditions** | See sequence below. |

---

## Correct rollout sequence (to actually ship these features)

1. **Roll a fresh prod app image** from master `20a93654` (gated prod release). This brings all
   six readers + the bridge Prisma migrations (2026-06-12) + #1029 generator hardening +
   #837 reader/field emitter. Confirm the release pipeline runs `prisma migrate deploy` on prod.
2. **`cdk deploy --exclusively Sps-Etl-prod -c env=prod`** — adds the `mentoring/*` + `citations/*`
   S3 `GetObject` grants to the prod ETL task role (verified absent today: live `sps-etl-task-prod`
   has only `spotlight/*` + `hierarchy/*`). Required before bridge imports can read S3.
3. **Prod data prep** (around the image roll):
   - Bridge imports (in-VPC, after WCM-side exports): `etl:mentoring:import-aoc`,
     `import-copubs`, `import-copub-list`, `import-citing`.
   - **Prod publications reindex** on the fresh ETL image: `search:index` (atomic alias-swap,
     low risk) so `wcmAuthorDepartments` is populated — reindex **before** the dept flag serves.
4. **`cdk deploy --exclusively Sps-App-prod -c env=prod`** — the reviewed flag batch + IAM.
   **Re-read the live `cdk diff` at the prompt** and confirm it still shows *only* this batch
   (task-def env additions + `TaskRoleCloudFrontPolicy` + em-dash descriptions) — abort if an
   image line, `desiredCount`, or any other resource appears.
5. **Provision** `SCHOLARS_COMMS_STEWARD_ALLOWLIST` (EA steward CWIDs) if non-superuser comms
   staff need `/edit/methods` access; else it stays superuser-only. Confirm staging's `dwd2001`
   is **not** carried to prod (it isn't — the ternary is env-scoped).

> If the goal is **only to pre-stage env+IAM** ahead of a later image roll: step 4 alone is
> harmless but does nothing visible — and it desyncs the cdk task def from reality so a future
> image roll silently activates flags set long ago without re-review. Not recommended; prefer
> the coordinated sequence above.

## Rollback

Fast and deterministic: revert the value in `app-stack.ts` → `cdk deploy --exclusively
Sps-App-prod` (one rolling revision swap, ~3–5 min, no image change, no CloudFront action —
the grant is dormant). Faster stopgap: `aws ecs update-service --task-definition <prior-revision>`.
**Sequencing caveat:** don't push a new prod `:latest` between the deploy and a potential
rollback, or a flag-revert `cdk deploy` would also swap the code. Pin to a known-good task-def
revision via `update-service` if that window is a concern.

## Corrections to the handoff narrative

- **#742 generator is already live in prod** (`SELF_EDIT_OVERVIEW_GENERATE=on` on `sps-app-prod:19`).
  This deploy does **not** newly enable it. (Prod runs the *un-hardened* generator until the
  image roll brings #1029 — superuser-only, low blast radius.)
- **The cdk App deploy ≠ the prod rollout.** It carries flags, not code. "One batched
  `cdk deploy Sps-App-prod` carries #837/#921/B2/#836/#443…" conflates the flag-flip with the
  image roll; without the image roll it carries nothing visible.
- **#921 grant-axis ships `off`** (armed/dark) — consistent with intent, not "enabled."
- **B2 precount** ships `off` (optimized) but the perf win also lands with the fresh image.
- **`SECURITY_CSP_MODE=enforce` is already on prod** (since 2026-06-08); the `config.ts`
  comment claiming "prod previously carried no `SECURITY_CSP_MODE`" is stale. Value is correct
  either way.

## Hygiene note surfaced by this review

Prod `:latest` is tagged `30ff64f1` — the **same commit the stale `~/worktrees/sps-methods-lens`
is stuck at**. That stale worktree is a deploy hazard (it caused the earlier no-op). Prune it;
deploy only from a freshly-pulled checkout.
