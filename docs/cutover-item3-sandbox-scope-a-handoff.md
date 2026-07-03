# Item-3 Sandbox — Scope A (export-lock dry-run) — HANDOFF

**For a fresh session.** Authored 2026-07-01. Everything below is verified as noted.

## Goal (what "do all of the above" means)
Deploy the throwaway `Sps-*-sandbox` estate, prove `list-imports=0` on every pinned export (the pass-3-safety precondition), then tear it down. **The user has already approved the spend** — no need to re-ask the spend gate; just execute and report.

## What Scope A proves (and doesn't)
- **Proves:** after pass-2, the pinned cross-stack exports have **zero importers** — so the eventual `useSharedVpc` flip (pass-3) cannot hit CFN's "cannot delete/update export in use" lock. A fresh sandbox deployed at master *is* the post-pass-2 end-state (consumers read SSM, not `Fn::ImportValue`), so `list-imports=0` on the exports is the direct proof.
- **Does NOT prove:** the flip's datastore-replacement behavior (Aurora/OpenSearch empty-replace). That's **Scope B** — needs `sharedVpc.{appSgId,etlSgId,albSgId}` provisioned in its-reciter-vpc01 + an `auroraSnapshotIdentifier`; still gated, out of scope here.

## State: scaffolding BUILT + synth-verified (2026-07-01)
- Worktree: **`~/worktrees/sps-sandbox`**, branch **`sandbox/export-lock-dryrun`** (commit `1eaff88d`, off master `43a01c75`). `cdk` deps installed (`npm ci` done). Throwaway — never PR to master.
- `npx cdk synth -c env=sandbox` → **exit 0, all 8 stacks build**: `Sps-{Network,DrBackupVault,Data,Secrets,App,Etl,Observability,Edge}-sandbox` (Analytics intentionally skipped).
- Verified: standalone `10.30.0.0/16` VPC (0 refs to shared `vpc-08a1873fc8eebae28`), **10 pinned Network exports**, resolver assoc skipped.

**The 6 edits (rebuild from these if the worktree is ever lost — all env-gated, inert for staging/prod):**
1. `cdk/lib/config.ts` — `EnvName` += `"sandbox"`; `isEnvName` += `"sandbox"`; extracted the staging inline literal to `const STAGING_CONFIG: SpsEnvConfig`; added `SANDBOX_CONFIG` = `{...STAGING_CONFIG}` overriding `vpcCidr:"10.30.0.0/16"`, `cloudFrontDistributionId:"SANDBOX-NO-CLOUDFRONT"` (non-empty so the CF metric dimension is valid), `cloudFrontLogsBucketName:""`, and `edEmailVisibilityBridgeEnabled`/`etlSchedulesEnabled`/`reconcileScheduleEnabled`/`cdnReconcileScheduleEnabled`/`curationBackupScheduleEnabled`/`opportunityProjectionScheduleEnabled`/`usageRollupScheduleEnabled` all `false`; `ENV_CONFIG` now `{ staging: STAGING_CONFIG, sandbox: SANDBOX_CONFIG, prod: {...} }`.
2. `cdk/lib/network-stack.ts` — resolver gate `if (!envConfig.useSharedVpc && envConfig.envName !== "sandbox")` (skip WCM resolver assoc; avoids RAM-share dep + the RSLVR-00704 class of failure).
3. `cdk/lib/data-stack.ts` — `const sandbox = envConfig.envName === "sandbox";`; Aurora standalone branch `deletionProtection: !sandbox` + `removalPolicy: sandbox ? DESTROY : RETAIN`; OpenSearch `removalPolicy: sandbox ? DESTROY : RETAIN` (one-command teardown).
4. `cdk/bin/sps-infra.ts` — `if (envConfig.envName !== "sandbox") { new AnalyticsStack(...) }`.

## DEPLOY — the plan to execute
Run from `~/worktrees/sps-sandbox/cdk`. Account context: `-c env=sandbox -c sandboxAccount=665083158573` on **every** cdk call. Creds in the shell are write-capable (`user/reciter` @ `665083158573`/us-east-1 — proven; NOT read-only).

**Prereqs (resolve first):**
- **us-west-2 bootstrap** for `Sps-DrBackupVault-sandbox` (cross-region). `aws cloudformation describe-stacks --stack-name CDKToolkit --region us-west-2` → if absent, `npx cdk bootstrap aws://665083158573/us-west-2`. (Alternative: skip the DR-vault stack — but DataStack takes it as a prop, so bootstrapping is simpler.)
- **Secret seeding.** `Sps-Secrets-sandbox` creates the empty secret structure, but the OpenSearch domain reads `scholars/sandbox/opensearch/master` as its master password at deploy — an empty/absent value fails the Data deploy. After deploying Secrets, confirm what it seeds vs. what needs a manual value; seed `scholars/sandbox/opensearch/master` (and any other required key) with a throwaway value before `Sps-Data-sandbox`. Mirror the real-env secret-seeding step (check `docs`/secrets-stack for the list).

**Deploy order** (CDK respects deps with `--all`, but secrets must be seeded between Secrets and Data):
1. `npx cdk deploy Sps-Network-sandbox Sps-Secrets-sandbox -c env=sandbox -c sandboxAccount=665083158573 --require-approval never`
2. Seed `scholars/sandbox/opensearch/master` (+ any others).
3. `npx cdk deploy --all -c env=sandbox -c sandboxAccount=665083158573 --require-approval never` (Data → App → Etl → Observability → Edge; DrBackupVault to us-west-2).
   - Watch for any `UPDATE_ROLLBACK`/`CREATE_FAILED` with an "Export ... in use" reason → that would itself be a finding.

**The proof (read-only):** enumerate every export from the synthesized templates and confirm zero importers:
```bash
cd ~/worktrees/sps-sandbox/cdk
npx cdk synth -c env=sandbox --quiet   # ensures cdk.out is current
for f in cdk.out/Sps-*-sandbox.template.json; do
  grep -oE '"Name": *"Sps-[A-Za-z]+-sandbox:[^"]+"' "$f" | sed -E 's/.*"(Sps[^"]+)".*/\1/'
done | sort -u | while read -r EXP; do
  N=$(aws cloudformation list-imports --export-name "$EXP" --query 'length(Imports)' --output text 2>/dev/null || echo "0")
  echo "$N  $EXP"
done
```
Expected: **every export → `0` importers** (or `None`/error "not imported" = 0). The load-bearing set is the 10 `Sps-Network-sandbox:*` exports + Data's `OpenSearchDomainEndpoint` + App's internal/public-ALB exports. Any non-zero = a consumer still imports it = pass-2 did NOT fully sever = a real finding to chase (which stack, which edge).

**Teardown (after the proof):**
```bash
npx cdk destroy --all -c env=sandbox -c sandboxAccount=665083158573 --force
```
Aurora + OpenSearch are DESTROY-policy for sandbox, so this is clean. Then verify nothing lingers: `aws rds describe-db-clusters`, `aws opensearch list-domain-names`, `aws ssm get-parameters-by-path --path /sps/sandbox --recursive` (should be empty), and delete any RETAIN'd leftovers (secrets, backup vault) by hand if present. Confirm the sandbox VPC (`10.30.0.0/16`) is gone.

## Report back
- The `list-imports` table (all exports → 0, or the exceptions).
- Whether any stack rolled back / hit an export-in-use error.
- Confirmation of clean teardown.
Then Scope A is complete; the remaining gate is Scope B (the flip rehearsal), which needs the shared-VPC SGs + snapshot.

## Cross-refs
- Runbook (staging reconciliation + §2 dry-run): `docs/cutover-item3-pass1-staging-reconciliation-runbook.md`
- Design (proof gate §): `docs/cutover-item3-export-lock-design-2026-06-30.md` (§ "MANDATORY proof gate")
- Impl map: `docs/cutover-item3-implementation-map-2026-06-30.md`
- Memory: `project_staging_cdk_deploy_drift`, `project_etl_cadence_vpc_relocation` (item-3 block).
