# Comms Steward — prod rollout runbook

**Status:** Prep for review. This branch flips `COMMS_STEWARD_ENABLED` on for prod
in `cdk/lib/app-stack.ts`; **nothing is deployed**. Merging it does NOT change
prod (CD re-rolls the image only, never the task-def env) — the env change lands
only on a manual, reviewer-gated `cdk deploy Sps-App-prod`.

Everything below was merged to master and verified on **staging** (comms_steward
PRs #941, #949, #951, #958, #959, #963, #964). This runbook is the prod go-live.

---

## ⚠️ The blocker you must see first: a prod App deploy is a BATCH

The prod App stack is well behind master. A `cdk deploy Sps-App-prod` (the only
way the flag reaches prod) ships **23 env-var additions** + a new IAM policy +
a task-def replace — NOT just comms_steward. **6 flip ON in prod:**

| Flag → on | Feature | Its own prereq before it's safe/meaningful |
|---|---|---|
| `COMMS_STEWARD_ENABLED` | this rollout | prod steward provisioning (below) |
| `SELF_EDIT_MANUAL_HIGHLIGHTS` | #836 manual Highlights | none (additive editor) |
| `SEARCH_PUB_DEPARTMENT_FILTER` | #837 pub dept facet | **reindex** before flip (per #837 notes) |
| `MENTORING_COPUB_BRIDGE` | #443/#926 mentee co-pubs | bridge import run on prod (else empty, degrades honestly) |
| `PUBLICATION_CITING_BRIDGE` | #938 cited-by | bridge import run on prod |
| `METHODS_LENS_PAGES` | #824 /methods pages | **inert** — gated by `METHODS_LENS_ENABLED` (stays off) |

Plus IAM: `+ TaskRoleCloudFrontPolicy` (CDN invalidation, #353) and the expected
`AppTaskDefinition … replace`. The other ~17 added vars are `off`/`""` (inert).

**Implication:** you cannot ship comms_steward to prod alone via this deploy. The
options are (a) deploy the whole batch (after each ON flag's prereq is met), or
(b) hold comms_steward until you're ready to ship the batch, or (c) temporarily
set the not-ready flags back to off in app-stack for a narrower prod deploy. This
is a decision for you — review the full `cdk diff` (reproduce below) before any
deploy.

Reproduce the diff:
```
cd cdk && npm ci
npx cdk diff --exclusively Sps-App-prod -c env=prod   # read-only; AWS creds from shell
```

---

## Prod steward provisioning (REQUIRED — currently empty)

This PR leaves `SCHOLARS_COMMS_STEWARD_ALLOWLIST` **empty for prod** on purpose.
With `COMMS_STEWARD_ENABLED=on` + an empty allowlist:
- The steward surfaces (Method Families, profile editing, unit editing) are
  reachable by **prod superusers only** (the steward superset).
- **No External-Affairs comms person has the role.** The live LDAPS group check
  fails closed in-VPC (#443), so `SCHOLARS_COMMS_STEWARD_GROUP_CN` won't work yet.

**Before comms gets access**, set the prod allowlist to the EA steward CWIDs:
```ts
SCHOLARS_COMMS_STEWARD_ALLOWLIST: env === "staging" ? "dwd2001" : "<prod steward cwids>",
```
(or wire `SCHOLARS_COMMS_STEWARD_GROUP_CN` once #443 LDAPS routing lands, then
clear the allowlist). Confirm whether `dwd2001` is a real prod steward or a
staging test account.

---

## Go-live sequence (operator)

1. **Decide the batch** (above) — confirm every ON flag's prereq is met, or
   narrow the deploy.
2. **Provision** the prod steward allowlist (or group CN).
3. **Data**: run on prod what the ON flags need —
   - `etl:family-review` (Method-Family review queue) for the Methods surface,
   - `etl:ed:export-steward-names` (WCM-side) + `etl:ed:import-steward-names`
     (in-VPC) so the banner/switcher show names, not CWIDs,
   - any reindex / bridge imports the other ON flags require.
4. **Deploy**: `cdk deploy --exclusively Sps-App-prod -c env=prod` — this PAUSES
   for `paulalbert1` approval (#475). Read the full diff at the prompt; abort if
   it shows anything beyond the reviewed batch.
5. **Verify** on prod as a steward (the staging checklist): Profiles/Units/Method
   Families tabs, edit + save, slug/grants/create excluded, doctoral profiles 404.

---

## What this PR changes

- `cdk/lib/app-stack.ts`: `COMMS_STEWARD_ENABLED` → on for prod (was staging-only).
  Prod allowlist + group CN intentionally left empty (provisioning is step 2).
- `cdk/test/__snapshots__/app-stack.test.ts.snap`: regenerated for the flag value.

No app code; no other flags touched. Spec: `docs/comms-steward-profile-editing-spec.md`.
