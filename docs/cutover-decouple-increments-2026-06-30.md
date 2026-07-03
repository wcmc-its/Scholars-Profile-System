# SPS VPC-consolidation cutover — decouple increments 2, 3, 4 (specs)

**Date:** 2026-06-30 · **Grounded on:** `origin/master` @ `09ce498d` (gate-tripwire #1378).
**Method:** 3 specs generated in parallel, each adversarially verified against `origin/master` + installed `aws-cdk-lib`. Verify verdicts are authoritative where they correct the spec's line refs or mechanism.

| # | Increment | Kind | Verdict | Status |
|---|-----------|------|---------|--------|
| 3 | NetworkStack/ALB export-lock deploy strategy | DESIGN | first draft REJECTED → **RESOLVED** | see `docs/cutover-item3-export-lock-design-2026-06-30.md` |
| 2 | Observability metric-by-name decouple | CODE | **HOLDS** | ready to implement (2 corrections baked in) |
| 4 | Aurora `DatabaseClusterFromSnapshot` path | CODE | **HOLDS** | ready to implement (1 build-breaker fix) |

Two corrections gate **any** code below:
- **#1380 (OpenSearch-node-from-secret) and increment 2 are NOT merged on `origin/master`.** The verifier confirmed `app-stack.ts:1014` + `etl-stack.ts:586/1244` still `Fn::importValue` `Sps-Data-${env}-OpenSearchDomainEndpoint`, and `observability-stack.ts:357–968` still references the live `dataStack.*` handles. Any plan that assumes those edges are gone (item 3's first draft did) is wrong until they actually land.
- **`cdk deploy --all` is NOT one atomic changeset.** CDK deploys each stack sequentially, producer-first. CloudFormation blocks changing/removing an export's *value* while any not-yet-updated stack still imports it. This single fact invalidates item 3's mechanism and dictates the deploy ordering for item 2.

---

## Increment 3 — NetworkStack/ALB export-lock deploy strategy · first draft **REJECTED**, now **RESOLVED**

> **Resolved design: `docs/cutover-item3-export-lock-design-2026-06-30.md`** (2nd workflow: full edge inventory → 3-approach panel → adversarial verify). Winner = Approach C (decouple-then-flip, single `useSharedVpc` flag, lock-free, per-stack `--exclusively` deploys) with A's SG-ownership graft + B's compute-tier reality. Governing decision surfaced for the user: byte-identity hard-gate vs reviewed wiring-only deltas. The rejected first-draft analysis below is retained for context.

The blocker. First-draft recommendation was *"consumer-first multi-pass + flip the inherent VPC/SG/ALB locks in one `cdk deploy --all` changeset."* **The verify pass killed it:**

> `cdk deploy --all` performs sequential, producer-first per-stack updates (Network → Data → App → Etl → Edge). When Network replaces the 3 SGs (and swaps the VPC to `fromVpcAttributes`), its auto `ExportsOutput*` SG/subnet values change **while App/Data/Etl — which deploy after — still import the old values** → `Export … is in use by …`. Being in the same `--all` run does not help; producer-first ordering *guarantees* the block.

### What's actually true on `origin/master`
- **L1 (inherent):** `network-stack.ts` passes `vpc` + `appSecurityGroup`/`etlSecurityGroup`/`albSecurityGroup` as **construct handles** to Data/App/Etl → CDK auto-`ExportsOutput*` exports. SGs replace when the VPC flips → export **value** changes. Network's own `CfnOutput`s (VpcId, *SecurityGroupId) have **no** `exportName` (descriptive only) — the real edges are the auto-exports from prop-passing.
- **L2:** `app-stack.ts` public ALB → `edge-stack.ts:239` `LoadBalancerV2Origin` auto-export.
- **L3:** App→Etl named `Sps-App-${env}-InternalAlbDns` / `-InternalAlbSecurityGroupId` (`app-stack.ts:2860/2869`) **plus** `ecsCluster` handle auto-export, **plus** `etlSecurityGroup` (Network→Etl) and the internal-ALB-SG ingress (`etl-stack.ts:133`).
- **Still-live edges the draft wrongly assumed removed:** OpenSearch endpoint import (#1380 unmerged) and the App/Data→Observability handle exports (increment 2 unmerged).

### Corrected direction (for the redesign, not yet a spec)
The non-decoupleable L1 VPC/SG plane cannot be flipped in place via a producer-first deploy. Two viable mechanisms, to be designed/scored properly:
1. **Decouple the handle imports** — App/Etl reference the VPC via `ec2.Vpc.fromVpcAttributes` and SGs via `SecurityGroup.fromSecurityGroupId` (ids from config), the pattern `etl-stack.ts:2011` already uses for the ed-export VPC. Severs the export edge entirely → Network replaces freely. Lighter than blue-green.
2. **Parallel new-name resources (blue-green at the export layer)** — stand up shared-VPC-attached SGs/ALB/ECS + snapshot-restored datastores under **new logical ids / new export names** alongside the live ones, repoint consumers, decommission old. Matches the already-mandated data-tier posture (§8.5/§8.6) and is fully reversible, at the cost of churn.

API check passed (every construct/prop the draft cited exists). **Open questions before this is buildable:** does prod change-control permit `cdk deploy --all`, or are per-stack deploys mandated (which forces option 2 for L1)? Confirm #1380 + inc-2 merge order. Where do the snapshot-restored datastores get new logical ids?

**Action:** this needs its own focused design iteration — I can run a second workflow scoped to the corrected L1 decouple mechanism + a cloned-stack dry-run proof plan. The lock is deploy-time only and invisible to synth/CI, so the staging cloned-stack dry-run with `aws cloudformation list-imports` per export is a **blocking** gate regardless of mechanism.

---

## Increment 2 — Observability metric-by-name decouple · **HOLDS**

Sever the two Data→Observability auto-exports by reading Aurora/OpenSearch metrics by literal name instead of via the `dataStack.*` L2 handles.

### Verified facts
- Two edges: `Sps-Data-{env}:ExportsOutputRefAuroraCluster…` (→ `DBClusterIdentifier`) and `…ExportsOutputRefOpenSearch…` (→ `DomainName`). **14 imports** confirmed (Aurora 2 alarms + 3 widgets ×2 envs; OpenSearch 2 alarms ×2). **Sole importer = ObservabilityStack** (grep across all 9 stack snapshots) → severing it is necessary *and* sufficient.
- `git grep 'dataStack\.'` in `observability-stack.ts` → exactly **7 metric sites** (alarms L357/381/405/426 + widgets L938/952/968), no grants/log-subs. All 7 must convert together or a residual ref keeps the export alive.

### Change
- **`observability-stack.ts`:** add `dbMetric`/`osMetric` helpers cloning the existing `cfMetric` arrow (L778) — `new cloudwatch.Metric({namespace:'AWS/RDS', metricName, dimensionsMap:{DBClusterIdentifier: envConfig.auroraClusterIdentifier}, …})` and `AWS/ES` with `{DomainName: envConfig.opensearchDomainName, ClientId: Stack.of(this).account}`. **Keep `ClientId`** — without it the AWS/ES series is empty. Branch all 7 sites on `envConfig.observabilityMetricsByName`.
- **`config.ts`:** add `observabilityMetricsByName: boolean` (+ `auroraClusterIdentifier`, `opensearchDomainName`) to `SpsEnvConfig`, set in **both** ENV_CONFIG entries (`false`, name literals empty until cutover). Dedicated flag — **not** `useSharedVpc` — because `assertCutoverGate` hard-throws on `useSharedVpc=true`, which would make a `useSharedVpc`-tied branch un-synthesizable/untestable.
- **Add a synth guard:** `observabilityMetricsByName === true ⇒ both names non-empty`, else a stray flip synths empty-dimension alarms that silently never fire (`treatMissingData: NOT_BREACHING`).

### Load-bearing deploy-ordering correction (from verify)
Deploy `Sps-Observability-{env}` **EXCLUSIVELY** with the flag ON, **before** any Data deploy that removes the export. Flipping by-name in the *same* deploy as `useSharedVpc` (Data redeployed first) re-trips `cannot delete export in use` — import-removal trails export-removal. The Observability-only deploy leaves a harmless dangling export on Data, cleaned up by the later `useSharedVpc` Data deploy.

### Flag parity / snapshots
Infra flag → parity lives in `config.ts` ENV_CONFIG (both envs), **not** app-stack.ts/.env.local (n/a). Flag-off is **byte-identical** → `observability-stack.test.ts.snap` must stay unchanged (that's the safety assertion); add flag-on coverage via `Template` matchers, **not** a second `toMatchSnapshot`, to avoid baking cutover output early.

**Prerequisite (lands at cutover, not this increment):** the snapshot-restored cluster/domain must carry explicit `clusterIdentifier`/`domainName`, copied into the two config fields. Flag must flip only after those names exist on live resources — premature flip blinds the alarms.

---

## Increment 4 — Aurora `DatabaseClusterFromSnapshot` path · **HOLDS**

Add the data-bearing snapshot-restore branch + config field + transitional secret + gate evolution. **Touches zero `exportName` edges** (the 4 Aurora `CfnOutput`s at `data-stack.ts:528–540` have no `exportName`; the only Data export is OpenSearch, untouched) → cannot trip the lock.

### Change
- **`config.ts`:** add `readonly auroraSnapshotIdentifier?: string` to `SpsEnvConfig`; leave **undefined** in both ENV_CONFIG entries (shipped → standalone path, byte-identical). Evolve `assertCutoverGate`: throw only when `useSharedVpc && !auroraSnapshotIdentifier`, message names the missing field + operator prereqs.
- **`data-stack.ts`:** broaden field to `public readonly auroraCluster: rds.IDatabaseCluster` (verified safe — Observability + `backup.BackupResource.fromRdsDatabaseCluster` only need `IDatabaseCluster`). Branch on `auroraSnapshotIdentifier`: present ⇒ `rds.DatabaseClusterFromSnapshot` with `snapshotCredentials: rds.SnapshotCredentials.fromSecret(<generated db/master-its Secret>)`; absent ⇒ unchanged `rds.DatabaseCluster` with construct id kept literally `AuroraCluster`. Omit `storageEncrypted`/`defaultDatabaseName` on the FromSnapshot branch (inherited from snapshot on restore).
- **Why `fromSecret`, not `fromGeneratedSecret`:** `SnapshotCredentialsFromGeneratedPasswordOptions` has **no `secretName`** — the only way to get a custom-named retained `db/master-its` credential is your own `Secret` + `fromSecret`. The `credentials` prop is `@deprecated` and silently not applied on FromSnapshot.

### Build-breaker fix (from verify — would RED the build)
The proposed new gate message **drops `"not yet deployable"`**, but `config.test.ts:79` asserts `toThrow(/not yet deployable/)`. **Keep that phrase in the message** (or update the assertion). The test updates: existing no-snapshot-id case still throws — keep `/DatabaseClusterFromSnapshot/`, `/appRwGranteeHost/`, `/reseed/`, `/not yet deployable/`, **add** `/auroraSnapshotIdentifier/`; add a new case `useSharedVpc:true + auroraSnapshotIdentifier:set ⇒ not.toThrow()`.

### Snapshots / parity
Shipped config (snapshot id undefined) → `data-stack.test.ts.snap` **unchanged** (byte-identical, unprovable in read-only — must confirm with `cd cdk && npm test`). New FromSnapshot branch covered by a `Template.hasResourceProperties` test with a synthetic snapshot-id config, **not** a new `.snap`. Infra field → no app-stack.ts/.env.local wiring (flag-parity n/a).

### Residual (operational, not code)
The evolved gate permits `useSharedVpc:true` the instant a snapshot id is set, even if `appRwGranteeHost` regrant (§6.2) and DSN/OpenSearch reseed (§6.4/§6.8) haven't run — a premature flip passes synth and can silently regress writes. Message names them; cannot enforce. Confirm live prod master username is `scholars_admin` (snapshot username is immutable; only the password is re-set by `fromSecret`).

---

## Recommended order

1. **Land increment 4** (Aurora FromSnapshot) — self-contained, no export edges, byte-identical flag-off; lifts the assertCutoverGate from a tripwire to a real prerequisite. Smallest blast radius.
2. **Land increment 2** (observability-by-name) — independent, byte-identical flag-off; removes the last two non-inherent Data exports. Bundle the Observability-only-deploy ordering note into the cutover runbook.
3. **(Re-land #1380** OpenSearch-from-secret if not yet merged.)
4. **Redesign increment 3** with the corrected L1 mechanism + cloned-stack dry-run proof plan — *then* spec/build it. This is the remaining real open question.
