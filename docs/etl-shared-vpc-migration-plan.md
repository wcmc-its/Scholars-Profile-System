# Plan: Relocate the SPS ETL cadence into the shared `lts-reciter-vpc01` (per-env SGs over dual peering)

> **⚠️ SUPERSEDED (2026-06-30) — read the current plan first: [`docs/sps-vpc-consolidation-plan.md`](./sps-vpc-consolidation-plan.md).**
> This plan moved only the **ETL compute** into `lts-reciter-vpc01` and kept Aurora/OpenSearch/the app in the Sps VPCs, reachable over **VPC peering + cross-VPC SG references** (shipped flag-off in merged PR #1310). On the same day the decision changed to **full consolidation, no peering**: relocate the **entire SPS estate (app + data, both envs)** into `lts-reciter-vpc01` and **decommission** the `Sps-network-staging/prod` VPCs. The peering apparatus this plan + #1310 build is therefore **superseded** (see the new plan's §8.8 for #1310's disposition). Retained for history.

Status: **PLAN for human approval.** No code changes, no deploys, no git-history edits. Every code reference below is grounded against `origin/master` (`e8ab902b`) and `feat/etl-vpc-peering` (`8f354425`, open PR #1310) via `git show <ref>:<path>` — **not** the stale checked-out worktree (~358 commits behind master). Line numbers cite the content I verified at those refs; treat them as anchors, not promises, since the branch must be rebased before edits land (Section 3).

This plan supersedes the per-env ETL target that PR #1229 (merged) and PR #1310 (open) encode, applying the Fabrice/networking meeting decisions of 2026-06-30.

> **✅ RESOLVED at the 2026-06-30 meeting — read this first.** Fabrice confirmed: **use `lts-reciter-vpc01`**, and it is in the **same AWS account as SPS (`665083158573`)**. Region is **`us-east-1`** (confirmed via the RDS endpoint hostname `…us-east-1.rds.amazonaws.com`). Consequences that override the hedged "cross-account" text below:
> - **Gates G1 (region) and G2 (account): GREEN.** Same-region + same-account → SG-references over peering are valid, and each peer **auto-accepts** (no manual accept step).
> - **Implement the SAME-ACCOUNT path ONLY.** Datastore/ALB ingress uses the L2 `addIngressRule(ec2.SecurityGroup.fromSecurityGroupId(...))` form; do **NOT** add `sourceSecurityGroupOwnerId`, the `etlPeerOwnerId` config field (§6 A.4/A.5), `peerOwnerId` on the peering (§6 B.2), or any cross-account IAM. **Gate G8 is N/A.** Wherever a "cross-account (G2)" branch appears below, skip it — it is dead.
> - **Still open (confirm with networking next):** G3 (SG-references "Allow referenceable security groups" enabled on the peer), G4/G5 (DNS reach to the Sps datastore hostnames), G6 (AWS-service egress from the VPC), G7 (subnet IP capacity), G9 (lts-side return routes + who pre-creates the two ETL SGs), and Q1/Q2/Q5–Q10.

---

## 1. Decision summary

| Dimension | #1229 + #1310 (current code) | Settled decision (this plan) |
|---|---|---|
| ETL compute target VPC | Per-env: scholars-dev `vpc-02c4dd698f3e3869c` (staging), scholars-prod `vpc-0b8006fee120df6bc` (prod) — `config.ts` `edExportVpc` | **One shared** `lts-reciter-vpc01` (CIDRs `10.46.134.0/24` + `10.46.160.0/24`) for **both** envs |
| Env isolation | Network layer (separate VPCs per env) | **Per-env security groups** inside the one shared VPC (Fabrice-approved) |
| Datastore ingress source | CIDR allowlist `Peer.ipv4(etlPeerCidr)` — Aurora 3306 / OpenSearch 443 in data-stack; ALB 80 `cidrIp` in etl-stack | **Cross-VPC security-group references** — each env's datastore SGs admit only that env's ETL SG by id (+ owner id if cross-account) |
| Peering | One requester-side peer per env stack: Sps VPC ↔ `edExportVpc` | Two peers retargeted: `lts-reciter-vpc01` ↔ Sps-network-staging (`10.20.0.0/16`) and ↔ Sps-network-prod (`10.10.0.0/16`) |
| Gate | Two flags `etlVpcPeeringEnabled` then `etlCadenceVpcRelocated`; `resolveEnvConfig` enforces relocated ⇒ peered | **Kept + extended** — also enforce relocated ⇒ `etlComputeSecurityGroupId` present, and (cross-account) peered ⇒ `etlPeerOwnerId` present |

Carries over unchanged: Fargate profile (2 vCPU / 8 GB, one main task at a time — `etlTaskCpu=2048` / `etlTaskMemoryMiB=8192`, both envs), Step Functions orchestration (nightly `cron(0 7 * * ? *)`, weekly Sun 08:00 UTC, annual Jul 1), the egress-only "no ingress" SG shape, and the "ingress present before tasks move" behavior `feat` already implemented by gating datastore/ALB ingress on `etlVpcPeeringEnabled` rather than `etlCadenceVpcRelocated`.

Out of scope / parked: InfoEd (`10.20.91.8`, overlaps `10.20/16`); reconciler + curated-backup placement (Section 13); the ED-export bridge VPC (Section 13, pending Q11).

---

## 2. Pre-flight HARD GATES (must be confirmed before ANY deploy)

These are not assumptions to carry forward — each is a binary gate that, if violated or unconfirmed, makes the SG-reference model **silently fail** (ingress rules synthesize fine but do not match traffic; connectivity hangs with no error). They are restated as Section 12 questions but listed here because the rollout (Section 10) cannot start until all are green.

| # | Gate | Why it blocks | Failure mode if wrong |
|---|---|---|---|
| G1 | ✅ **CONFIRMED `us-east-1`** (same region as both Sps env VPCs; RDS hostname `…us-east-1.rds.amazonaws.com`). | Cross-VPC SG references are valid **only same-region**. | — (green; SG-reference model viable). |
| G2 | ✅ **CONFIRMED same account `665083158573`** (Fabrice, 2026-06-30). | Same account → peering **auto-accepts** + L2 `addIngressRule` (no owner id). | — (green; cross-account branch is dead). |
| G3 | **"Allow referenceable security groups" enabled on BOTH peers.** | SG references over peering require this peering option on each side. | SGs exist but never filter traffic; probe hangs indistinguishably from a missing route. |
| G4 | **DNS resolution + hostnames enabled** on `lts-reciter-vpc01` and on each peering connection (`enableDnsSupport`, `enableDnsHostnames`; the peering's DNS-resolution option). | SG references and cross-VPC endpoint resolution depend on it. | Silent SG-ref enforcement failure / endpoint won't resolve to private IP. |
| G5 | **Sps datastore endpoints resolve to private `10.20.x` / `10.10.x` from inside `lts-reciter-vpc01`** (Route 53 private hosted zone association or resolver reach for the Aurora writer, OpenSearch domain, internal ALB hostnames). | The relocated task connects by hostname; if the PHZ isn't visible from `lts-reciter-vpc01`, name resolution fails before any SG/route is exercised. | `getaddrinfo` failure or resolution to a public/no IP → connect fails. |
| G6 | **Egress to AWS service endpoints from `lts-reciter-vpc01`** — NAT gateway(s) OR VPC endpoints for ECR (api+dkr), CloudWatch Logs, Secrets Manager, S3, DynamoDB; and endpoint policies (if any) permit the SPS task role. | Fargate cannot pull the image or write logs without these; the task fails to start. | Task stuck in `PROVISIONING`/`STOPPED (CannotPullContainerError)`; no logs. |
| G7 | **Placement subnet IP capacity** in the chosen `lts-reciter-vpc01` subnets (which already host ReCiter RDS at `10.46.134.208` / `10.46.134.113`) — room for concurrent staging+prod ENIs during rollout. | ENI allocation fails if the subnet is near-full. | Task launch fails `Insufficient free addresses`. |
| G8 | ⛔ **N/A** — was cross-account-only; G2 is same-account, so no cross-account ENI/assume-role concern. | — | — |
| G9 | **lts-reciter-side return routes owned and added out-of-band** — `10.20/16 → pcx` (staging) and `10.10/16 → pcx` (prod), under a named owner with a stated SLA, plus the cross-account **peer accept** if G2 = cross-account. | The Sps side only owns its own return route; reply traffic dies without the lts-side route. | One-way blackhole; probe TCP hangs. |

**Probe (Section 10, step 3) is the catch-all** for G1–G9: if any is wrong, the probe hangs or the task fails to start, and the relocate flag is never flipped.

---

## 3. Branch & merge prerequisite (corrected)

The draft's branch-hygiene note had the direction **backwards**; the verified state is:

- `feat/etl-vpc-peering` (`8f354425`) is **34 commits behind `origin/master`** and **1 commit ahead** (merge-base `4e75e727`). Verified: `git rev-list --count feat/etl-vpc-peering..origin/master` = 34.
- The branch is **missing** content that master has, not carrying content master removed:
  - `REPORTER_MATCH_V2` is **present in master** (`etl-stack.ts` L624/L629) and **absent from feat**.
  - `grantMatcherSubtopicGrain` is **present in master** (`config.ts` L237 / L409 / L508) and **absent from feat**.
- Therefore the real hazard is the opposite of the draft's claim: **landing feat's edits (or merging feat) without rebasing would DROP `REPORTER_MATCH_V2` and `grantMatcherSubtopicGrain` from master**, not "reintroduce a deleted block."

**Required order (do this FIRST, after this plan is approved):**
1. Rebase `feat/etl-vpc-peering` onto fresh `origin/master` (`git fetch origin` first). The rebase carries forward master's `REPORTER_MATCH_V2` / `grantMatcherSubtopicGrain`; the only true delta the branch contributes is the single peering commit.
2. Re-ground Section 5's line numbers against the rebased branch (they will shift).
3. Apply this plan's edits (Section 6) on the rebased branch — either folded into PR #1310 before it merges, or as a stacked follow-up PR with #1310 as its base. **Recommended:** fold into #1310 so reviewers approve the final retargeted intent in one PR (the open PR currently still describes the scholars-dev/prod target — update its description regardless, Section 12-doc).

Responsibility/timing: the rebase is the first commit after approval; it is owned by whoever picks up the implementation, not deferred to merge time.

---

## 4. Target architecture

One shared, TGW-attached `lts-reciter-vpc01` hosts both envs' ETL Fargate tasks. Isolation is by SG, not network. Each env's datastores live in its own Sps-network VPC and admit only that env's ETL SG, referenced cross-VPC over a dedicated peering connection.

```
                         lts-reciter-vpc01  (TGW-attached; G1 ASSUMPTION: us-east-1)
                         CIDRs 10.46.134.0/24 + 10.46.160.0/24
                         (already hosts ReCiter RDS: 10.46.134.208, 10.46.134.113)
            ┌───────────────────────────────────────────────────────────────┐
            │  Fargate ENIs (2 vCPU/8GB, RUN_JOB, one main task at a time)    │
            │   ┌────────────────────┐        ┌────────────────────┐         │
            │   │ staging-ETL-SG     │        │ prod-ETL-SG         │         │
            │   │ (egress-only)      │        │ (egress-only)       │         │
            │   └─────────┬──────────┘        └─────────┬──────────┘         │
            └─────────────┼──────────────────────────────┼───────────────────┘
              pcx-staging │ (Sps-side return route        │ pcx-prod
                          │  10.46.134/160 -> pcx;         │
                          │  lts-side 10.20/16 & 10.10/16  │
                          │  -> pcx are OUT-OF-BAND, G9)   │
            ┌─────────────▼───────────────┐  ┌────────────▼────────────────┐
            │ Sps-network-staging         │  │ Sps-network-prod            │
            │ 10.20.0.0/16                │  │ 10.10.0.0/16                │
            │  Aurora :3306  ─ingress◀──  │  │  Aurora :3306  ─ingress◀──  │
            │  OpenSearch :443 (admits    │  │  OpenSearch :443 (admits    │
            │  internal ALB :80   staging-│  │  internal ALB :80   prod-   │
            │   datastore SGs     ETL-SG  │  │   datastore SGs     ETL-SG  │
            │                     ONLY)   │  │                     ONLY)   │
            └─────────────────────────────┘  └─────────────────────────────┘
```

Write-back path (a relocated cadence task → an Sps datastore):
1. Task ENI in `lts-reciter-vpc01` (source SG = `staging-ETL-SG` / `prod-ETL-SG`) resolves the Sps datastore hostname to its private `10.20.x` / `10.10.x` IP (G5) and opens 3306/443/80.
2. Traffic crosses the env's peering connection (lts-reciter side route `10.20/16` or `10.10/16` → pcx, added out-of-band — G9).
3. The Sps datastore SG admits it because its ingress rule references the source SG **by id** (+ owner id if cross-account — G2), not a CIDR, and the peer has SG-references enabled (G3).
4. Reply returns via the Sps-side return route (`10.46.134/160` → pcx) on each Sps private route table.

Cross-env blocking: `prod-ETL-SG` is not in any staging datastore ingress rule (and vice-versa), so a prod task cannot reach staging datastores even though both ENIs share the VPC and CIDR space. **This SG reference is what concretely replaces network isolation** — and it is the reason the old CIDR allowlist had to go: with both envs in one shared CIDR space, a CIDR rule could not distinguish staging from prod at all.

---

## 5. Current state (grounded)

### `config.ts`
- `@master` — `edExportVpc` interface object (`vpcId` / `availabilityZones` / `appSubnetIds`) ~L252-256. Staging `edExportVpc.vpcId = "vpc-02c4dd698f3e3869c"`, AZs `us-east-1a/b`; prod `vpcId = "vpc-0b8006fee120df6bc"`. `etlCadenceVpcRelocated` staging/prod `false`. `etlPeerCidr` staging `"10.46.231.0/24"` / prod `"10.46.230.0/24"`. `etlTaskCpu 2048` / `etlTaskMemoryMiB 8192`.
- `@feat` (adds on master) — `etlVpcPeeringEnabled` interface field + staging/prod `false`. `resolveEnvConfig` calls `assertEtlMigrationInvariants(cfg)`, which throws if `etlCadenceVpcRelocated && !etlVpcPeeringEnabled`.

### `network-stack.ts` (`@feat`)
- Base SGs default-deny + `allowAllOutbound:true`: `albSecurityGroup`, `appSecurityGroup`, `etlSecurityGroup`.
- Peering block gated `if (envConfig.etlVpcPeeringEnabled)`: `CfnVPCPeeringConnection "EtlCadenceVpcPeering"` with `vpcId: this.vpc.vpcId`, `peerVpcId: envConfig.edExportVpc.vpcId`, `peerOwnerId`/`peerRegion` **omitted → same-account auto-accept**, `Name` tag `sps-etl-cadence-peer-${envName}`.
- Return-route loop: dedups by `routeTableId`, one `CfnRoute "EtlCadencePeerRoute${i}"` per Sps private route table, `destinationCidrBlock: envConfig.etlPeerCidr` → `peering.ref`. `CfnOutput "EtlCadenceVpcPeeringId"`.

### `data-stack.ts` (`@master`; `feat` only flips the gate)
- `auroraSecurityGroup` (`allowAllOutbound:false`); app-SG ingress 3306; etl-SG ingress 3306; **conditional CIDR ingress** `Peer.ipv4(envConfig.etlPeerCidr)` → 3306, gate `etlVpcPeeringEnabled` (was `etlCadenceVpcRelocated`).
- `opensearchSecurityGroup`; app-SG ingress 443; etl-SG ingress 443; **conditional CIDR ingress** `Peer.ipv4(envConfig.etlPeerCidr)` → 443, gate `etlVpcPeeringEnabled`.

### `etl-stack.ts` (`@master`; `feat` moves ALB-cadence ingress out of the relocate block and gates it on `etlVpcPeeringEnabled`)
- Internal ALB SG id imported from `Fn.importValue("Sps-App-${env}-InternalAlbSecurityGroupId")`; unconditional `InternalAlbIngressFromEtl` (`sourceSecurityGroupId: etlSecurityGroup`) → 80.
- `relocateCadence = envConfig.etlCadenceVpcRelocated` (L160); defaults `cadenceSubnets = {PRIVATE_WITH_EGRESS}` (L161-163), `cadenceSecurityGroups = [etlSecurityGroup]` (L164).
- `if (relocateCadence)`: import `EtlCadenceVpc` via `Vpc.fromVpcAttributes` from `edExportVpc`; build `cadenceSubnets` via `Subnet.fromSubnetId` loop `EtlCadenceSubnet${i}`; create **egress-only** `EtlCadenceSg` (`vpc: cadenceVpc`, `allowAllOutbound:true`, no ingress) (L185-190); `cadenceSecurityGroups = [cadenceSg]`.
- `if (envConfig.etlVpcPeeringEnabled)` (feat): `CfnSecurityGroupIngress "InternalAlbIngressFromEtlCadenceVpc"` with `cidrIp: envConfig.etlPeerCidr` → 80.
- `FargateTaskDefinition`; `buildStep` `EcsRunTask` uses `subnets: cadenceSubnets`, `securityGroups: cadenceSecurityGroups` (L694-695) for all nightly/weekly/annual/heartbeat steps.
- Stays in Sps VPC (`PRIVATE_WITH_EGRESS` + `[etlSecurityGroup]`): #393 reconcile (L1321-1322); #353 CDN reconcile (L1618-1619); curated backup (L1789-1790); opportunity projection (L1924-1925); ED-export bridge import step (L2158-2159).

### `app-stack.ts` (`@master`)
- `internalAlbSecurityGroup` created (L856-858); `CfnOutput "InternalAlbSecurityGroupId"` with `exportName: Sps-App-${env}-InternalAlbSecurityGroupId` (L2832-2834).

### Tests (`@master` / `@feat`)
- `cdk/test/network-stack.test.ts` (`@feat`): asserts 0 peering resources when off; with `etlVpcPeeringEnabled:true`, `resourceCountIs("AWS::EC2::VPCPeeringConnection", 1)`, `PeerVpcId: "vpc-02c4dd698f3e3869c"`, and `peerRoutes.toHaveLength(2)`.
- `cdk/test/etl-stack.test.ts`: asserts `rule.Properties?.CidrIp` toBeUndefined (~L179, for the non-relocated ALB rule).
- `cdk/test/data-stack.test.ts`: inspects `SourceSecurityGroupId` on ingress rules (~L385).

---

## 6. Change list grouped by file

Each item is before → after **intent**, plus the same-account / cross-account split where it matters.

### A. `cdk/lib/config.ts`
1. **Add a dedicated `etlComputeVpc` field (DECISION: do NOT overload `edExportVpc`).** `edExportVpc` is consumed by the ED-export bridge (etl-stack L2150-2160 region) which is **out of scope** (Q11) and stays on scholars-dev/prod. Introduce a separate `etlComputeVpc: { vpcId; availabilityZones; appSubnetIds }` per env carrying `lts-reciter-vpc01`'s `vpcId` (UNKNOWN — Q1), AZs, and placement subnet ids (UNKNOWN — Q2). This avoids accidentally relocating the bridge and keeps the two concerns independently flippable. (Resolves the reviewers' "decision not resolved" finding — it is now a decision.)
2. **Convert `etlPeerCidr` (string) → `etlPeerCidrs` (string[]).** The Sps-side return-route destination is now the lts-reciter placement-subnet CIDR(s). `10.46.134.0/24` and `10.46.160.0/24` are **non-contiguous** (cannot aggregate to a `/23`). Populate with **only the CIDR(s) the ENIs actually place into** (Q2): if placement is confined to one subnet, the array holds one entry; if ENIs straddle both, two. Do not list both speculatively. Add a synth-time bound: throw if empty or length > 2.
3. **Add per-env `etlComputeSecurityGroupId: string`** holding the `staging-ETL-SG` / `prod-ETL-SG` id inside `lts-reciter-vpc01`. Consumed by data-stack ingress (C), etl-stack ALB ingress + task attachment (E). Ownership = import-by-id (Section 7, Q9).
4. **Add per-env `etlPeerOwnerId?: string`** (optional) — set only if G2 = cross-account. Drives `peerOwnerId` on the peering and `sourceSecurityGroupOwnerId` on the ingress rules.
5. **Extend the invariant** (`assertEtlMigrationInvariants`): keep relocated ⇒ peered; ADD relocated ⇒ `etlComputeSecurityGroupId` is set (fail synth, not Fargate runtime, on a missing SG id); ADD — if `etlPeerOwnerId` is set it must be non-empty. (Resolves rollout blocker: a missing SG id otherwise surfaces as a runtime "security group not found", not a synth error.)
6. **Update JSDoc** on `etlCadenceVpcRelocated`, `etlPeerCidr`→`etlPeerCidrs`, and the two new fields to describe the shared-VPC + SG-reference model; drop the "scholars-dev/prod" wording and point at this plan / the handoff doc (Section 12-doc).

### B. `cdk/lib/network-stack.ts`
1. **Retarget the peer**: `peerVpcId` from `envConfig.edExportVpc.vpcId` → `envConfig.etlComputeVpc.vpcId`.
2. **Cross-account branch**: `if (envConfig.etlPeerOwnerId) { peerOwnerId: envConfig.etlPeerOwnerId }`. Same-account → omit (auto-accept). Update the comment to: *"Same account + same region → omit peerOwnerId/peerRegion (auto-accepted). Cross-account (or cross-region) requires peerOwnerId/peerRegion; the peer lands `pending-acceptance` until the lts-reciter side accepts out-of-band (G9)."* Note explicitly that auto-accept requires **both** account ids to match.
3. **Return route**: iterate `etlPeerCidrs × deduped Sps route tables`, one `CfnRoute` per pair. **Construct id must combine BOTH the CIDR and the route-table id** (e.g. `EtlCadencePeerRoute-${cidrSlug}-${rtbSlug}`, slugging `.`/`/` to `_`) so two CIDRs don't collide on a duplicate construct id. The current loop indexes by subnet position with a single CIDR; extend it.
4. **Output comment**: correct the parenthetical from "scholars-dev" to "lts-reciter"; keep the "lts-side `10.20/16` / `10.10/16` → this pcx added out-of-band (G9)" note.

### C. `cdk/lib/data-stack.ts`
1. **Aurora ingress (3306)** — **DELETE the CIDR rule, do not leave it as dead code.** Remove the `Peer.ipv4(envConfig.etlPeerCidr)` block entirely and replace it with an SG-reference block gated on `etlVpcPeeringEnabled` (keep that gate so the rule exists for the probe before tasks move):
   - **Same-account (G2):** `auroraSecurityGroup.addIngressRule(ec2.SecurityGroup.fromSecurityGroupId(this, "EtlComputeSgRef", envConfig.etlComputeSecurityGroupId), ec2.Port.tcp(3306), "<env>-ETL-SG in lts-reciter-vpc01 -> Aurora 3306 over the peer")`.
   - **Cross-account (G2):** L2 `addIngressRule` **cannot** express the owner; use `new ec2.CfnSecurityGroupIngress(this, "AuroraIngressFromEtlComputeSg", { groupId: auroraSecurityGroup.securityGroupId, ipProtocol: "tcp", fromPort: 3306, toPort: 3306, sourceSecurityGroupId: envConfig.etlComputeSecurityGroupId, sourceSecurityGroupOwnerId: envConfig.etlPeerOwnerId, description: ... })`.
   - Branch on `envConfig.etlPeerOwnerId` being set.
2. **OpenSearch ingress (443)** — identical conversion (L2 same-account / L1 cross-account with owner id).
3. **Leave the local-SG rules untouched** — app-SG (3306/443) and etl-SG (3306/443) ingress stay; they serve in-Sps app traffic plus the reconcilers/curated-backup that do **not** relocate and reach Aurora/OpenSearch from the **local** `etlSecurityGroup`, never the remote `staging/prod-ETL-SG` (Section 13).

### D. `cdk/lib/app-stack.ts`
- **No functional change.** `internalAlbSecurityGroup` (L856-858) and its export `Sps-App-${env}-InternalAlbSecurityGroupId` (L2832-2834) remain the integration point. Verification-only: confirm the export name/shape is unchanged so etl-stack's `Fn.importValue` still resolves (Section 11 snapshot will catch any drift).

### E. `cdk/lib/etl-stack.ts`
1. **Task placement**: point `Vpc.fromVpcAttributes` / `Subnet.fromSubnetId` at `envConfig.etlComputeVpc` (from A.1), placing ENIs in `lts-reciter-vpc01` subnets.
2. **Per-env ETL SG — import by id, stop creating it.** Replace the `new ec2.SecurityGroup(this, "EtlCadenceSg", ...)` (L185-190) with `ec2.SecurityGroup.fromSecurityGroupId(this, "EtlComputeSg", envConfig.etlComputeSecurityGroupId)` so the **same SG id** is shared between task attachment (here) and datastore ingress (C). Rationale to record in the PR: creating the SG in etl-stack and importing it in data-stack would form a **dependency cycle** (data-stack is a dependency of etl-stack); import-by-id breaks it and is required anyway for the cross-account case. **No SG-creation code may remain in etl-stack after this change** — a reviewer checklist item. The imported SG must live in the same VPC as the placement subnets (`lts-reciter-vpc01`) for ENI attachment to succeed — satisfied by design (E.1), called out so the coupling is explicit.
3. **Internal-ALB ingress (80)**: replace `cidrIp: envConfig.etlPeerCidr` with an SG reference on the existing `CfnSecurityGroupIngress` — `sourceSecurityGroupId: envConfig.etlComputeSecurityGroupId`, plus `sourceSecurityGroupOwnerId: envConfig.etlPeerOwnerId` if cross-account. Keep the `etlVpcPeeringEnabled` gate `feat` introduced.
4. **No change** to reconciler/backup/projection/ED-bridge placement (L1321-1322, L1618-1619, L1789-1790, L1924-1925, L2158-2159) — Section 13.

---

## 7. Per-env security-group design

Goal: staging datastores admit only `staging-ETL-SG`; prod datastores admit only `prod-ETL-SG`; both SGs live in `lts-reciter-vpc01`.

- **Two egress-only SGs, one shared VPC.** Each is `allowAllOutbound:true`, no ingress (a batch task accepts no inbound). Because Sps deploys `Sps-Etl-staging` and `Sps-Etl-prod` as separate per-env stacks, each env naturally references one SG.
- **Reference, not membership, is what isolates.** Each env's datastore + ALB SGs add an ingress rule whose source is the env's ETL SG id. `prod-ETL-SG` never appears in a staging rule → a prod ENI cannot open 3306/443/80 to a staging datastore despite sharing VPC + `10.46.x` space.
- **Cross-VPC SG references** are valid **same-region** (G1) on peers with SG-references enabled (G3). They work same-account (L2 `addIngressRule`) and cross-account (L1 `CfnSecurityGroupIngress` + `sourceSecurityGroupOwnerId`, G2). Cross-**region** peering does not support SG references — model reverts to CIDR.
- **SG ownership — RECOMMEND import-by-id.** Networking pre-creates `staging-ETL-SG` / `prod-ETL-SG` in `lts-reciter-vpc01`; SPS imports the ids via `etlComputeSecurityGroupId` (A.3). SPS must **not** create them (would cycle, per E.2). If networking instead wants SPS to own them, they would have to be created in a stack upstream of both data-stack and etl-stack and threaded by id — more churn for no benefit; import-by-id is the recommendation.

---

## 8. Peering & cross-account handling

- **Same account (G2):** keep auto-accept (omit `peerOwnerId`); no accepter step; SG references work directly by id.
- **Cross account (G2):** `CfnVPCPeeringConnection` passes `peerOwnerId` (B.2); peer lands `pending-acceptance`; the **lts-reciter side accepts out-of-band** (G9 — named owner + SLA + how SPS detects success: poll `aws ec2 describe-vpc-peering-connections` for `Status.Code=active` before the probe). Return routes and SG-reference ingress do nothing until accepted — the probe (Section 10 step 3) is the catch. Cross-account SG ingress carries `sourceSecurityGroupOwnerId` on **all three** rules (Aurora/OpenSearch/ALB).
- **Two separate peers, by design:** each per-env Sps stack creates its own requester-side peer (matches `feat`'s per-stack pattern); only `peerVpcId` retargets. The lts-side routes (`10.20/16` and `10.10/16` → respective pcx) are SPS-out-of-band (networking owns — G9). Confirm whether those route tables are under networking's IaC (Terraform/CloudFormation/manual) and whether drift detection exists (Q10).

---

## 9. Operational prerequisites (egress, DNS, IAM, capacity)

These are the non-SG, non-route prerequisites that the SG-reference focus can mask. Each maps to a pre-flight gate (Section 2) and a Section 12 question.

- **AWS-service egress (G6):** the relocated Fargate task pulls its image from ECR, writes CloudWatch Logs, reads Secrets Manager (ETL secrets are looked up by name in etl-stack), and touches S3 / DynamoDB. Confirm `lts-reciter-vpc01` provides this via NAT or VPC endpoints, and that endpoint policies permit the SPS task role. The existing egress-only SG's `allowAllOutbound` already covers the SG side; the VPC plumbing is the unknown.
- **DNS to Sps datastores (G4/G5):** the task connects to Aurora/OpenSearch/ALB by hostname. Confirm those endpoints are in a Route 53 private hosted zone associated with (or resolvable from) `lts-reciter-vpc01`, and verify with `dig`/`nslookup` from the probe task that they resolve to `10.20.x` / `10.10.x`.
- **Task IAM (G8, cross-account only):** confirm the Sps task/execution roles can attach ENIs in the placement subnets without a cross-account assume-role; if one is required, document the chain.
- **Subnet IP capacity (G7):** confirm free addresses in the placement subnets (they already host ReCiter RDS) for concurrent staging+prod ENIs during rollout; if tight, ask networking for a dedicated subnet.

---

## 10. Rollout sequence

Per env, staging fully soaked before prod. Both flags start `false`. **Flags are hardcoded per-env in `config.ts`, not CDK `-c` context** — `-c env=<env>` only selects which env's config block is read; to cross a gate you edit `config.ts`, commit, and deploy. (`-c env` cannot override a hardcoded flag.)

1. **Pre-flight (networking, out-of-band):** confirm G1–G9 (Section 2). Pre-create `staging-ETL-SG`/`prod-ETL-SG` if networking-owned (Q9); confirm placement subnet ids + CIDRs (Q1/Q2), account id (Q3/G2), region (G1), SG-references enabled (G3), DNS (G4/G5), egress (G6), capacity (G7), IAM (G8), lts-side routes + accept owner/SLA (G9).
2. **Staging — `etlVpcPeeringEnabled=true`, deploy.** `cdk deploy --exclusively Sps-Network-staging Sps-Data-staging Sps-Etl-staging -c env=staging` from **fresh `origin/master`** (per the "deploy from master, not the feature branch" rule — the shared checkout's branch is what synthesizes). This stands up the staging peer, the Sps-side return route(s), and the datastore/ALB SG-reference ingress — before any task moves. If cross-account (G2), confirm the lts-reciter side has **accepted** the peer (`Status.Code=active`) and added `10.20/16 → pcx` before proceeding.
3. **Probe over the peer from `lts-reciter-vpc01`.** Run a throwaway task (or the cadence task def with a connectivity override) attached to **`staging-ETL-SG`** in **one of the staging placement subnets** (confirm the source IP falls in an `etlPeerCidrs` range, else the Sps return route won't match). The probe must verify, in order:
   - **Task reaches `RUNNING` and exits 0** (catches G6 image-pull / G8 ENI-attach failures — a task stuck in `PROVISIONING`/`STOPPED` is an egress/IAM problem, not a connectivity one).
   - **CloudWatch Logs entries present** (catches the Logs endpoint/egress).
   - **DNS:** `dig` the Aurora/OpenSearch/ALB hostnames → resolve to `10.20.x` (G5).
   - **TCP:** connect Aurora `:3306`, OpenSearch `:443`, internal ALB `:80`.
   - Use a ~5-min timeout. A silent hang means: peer not accepted, lts-side route missing (G9), SG-references disabled (G3), wrong CIDR (Q2), or owner id missing on a cross-account rule (G2). Diagnostic order: `describe-vpc-peering-connections` (active?), `describe-route-tables` (return route present? lts-side route present?), `describe-security-groups` (ingress rule has the right `SourceSecurityGroupId` [+owner]?), then endpoint reachability. Capture this as a runbook section in the handoff doc.
4. **Monitoring setup (before relocate).** Add/confirm: CloudWatch alarm on the peering connection state (alert if not `active`); ETL `RunTask` failure-rate alarm; baseline the datastore connection latency so a post-relocate regression is visible. Record the dashboard in the handoff doc.
5. **Staging — `etlCadenceVpcRelocated=true`, deploy.** Tasks now launch in `lts-reciter-vpc01` with `staging-ETL-SG`. `assertEtlMigrationInvariants` (A.5) fails synth if relocated is set without peered **or** without `etlComputeSecurityGroupId`. Run a real nightly + the weekly/annual paths; verify writes land in Aurora/OpenSearch and `/api/revalidate` reaches the ALB.
6. **Soak staging** (≥ one full nightly + weekly cycle; watch Step Functions failures, datastore connect errors, peering-state alarm).
7. **Prod — repeat 2→6** with `-c env=prod` and the prod peer/SG/CIDRs. Prod `Sps-App/Etl-prod` deploys are reviewer-gated (paulalbert1 approval) — schedule accordingly.

**Deploy-env sanity (lightweight, not code):** before each deploy, confirm `-c env=<env>` matches the stack names (`Sps-*-<env>`). A config/stack mismatch is structurally hard here — stack ids are `Sps-Etl-${env}` derived from the same `-c env` that selects the config block, so a single `-c env` value cannot pair prod stacks with staging config (see Section 14 for why a code guard is rejected). The real risk is deploying the *wrong env entirely*; the prod reviewer gate catches that.

**Rollback (flags are independent + additive):**
1. **Back out tasks:** set `etlCadenceVpcRelocated=false`, deploy → tasks return to the Sps VPC on `etlSecurityGroup` (default branch, etl-stack L161-164). The ETL is idempotent (upserts / delete-then-insert per partition; search:index rebuilds the full corpus), so a re-run in the Sps VPC self-heals any write interrupted during relocation — manual record reconciliation is only needed if a run was killed mid-write AND the next idempotent run cannot reach the source (inspect Aurora/OpenSearch against last-known-good only in that case).
2. **Soak** one nightly+weekly cycle clean in the Sps VPC.
3. **Only then back out the peer:** set `etlVpcPeeringEnabled=false`, deploy. The invariant forbids relocated-without-peered, and pulling the peer/ingress while tasks still run there would strand all datastore writes — so the order is strictly **un-relocate → soak → un-peer**.
4. **Post-incident cleanup:** with both flags `false` and deployed, the per-env SG-reference ingress + peer are gone from the template. If a manual rule was added out-of-band, remove it explicitly. Stale rules are harmless but confuse future troubleshooting.

---

## 11. Tests & CI impact

- **`cdk/test/data-stack.test.ts`:** Aurora/OpenSearch ingress assertions change from `CidrIp`/`Peer.ipv4` to a SG-reference source. Add an explicit matrix: (a) peering off → no peer rule; (b) same-account on → `SourceSecurityGroupId` present, `SourceSecurityGroupOwnerId` **absent**; (c) cross-account on (`etlPeerOwnerId` set) → both `SourceSecurityGroupId` **and** `SourceSecurityGroupOwnerId` present. Assert the old CIDR rule is **gone** (no `CidrIp` on the peer rule).
- **`cdk/test/etl-stack.test.ts`:** ALB-cadence ingress assertion changes from `CidrIp` to SG reference (same same-account/cross-account split); task-placement assertion changes from `edExportVpc` ids to `etlComputeVpc` ids; assert no new `AWS::EC2::SecurityGroup` is created in the relocate branch (import-by-id, E.2).
- **`cdk/test/network-stack.test.ts`:** update `PeerVpcId` from `"vpc-02c4dd698f3e3869c"` to the `lts-reciter-vpc01` id; route count = `etlPeerCidrs.length × uniqueRouteTables` (the existing `toHaveLength(2)` becomes a function of the array); add a `PeerOwnerId`-present assertion for the cross-account case; add a two-CIDR fixture asserting one `CfnRoute` per (cidr, routeTable) and unique construct ids.
- **`cdk/test/config.test.ts` (or the invariant unit test):** keep relocated⇒peered; add relocated⇒`etlComputeSecurityGroupId` set; add `etlPeerOwnerId` non-empty when set; assert `etlPeerCidrs` is a 1–2-entry array (not the old single string); assert the retargeted `etlComputeVpc.vpcId !=` the old scholars-dev/prod ids.
- **Snapshot regen (CI-gating per the `cdk` gate):** affected snaps — `network-stack`, `data-stack`, `etl-stack` (the ingress + peer + placement changes); `app-stack` has no functional change (verify only that the SG export name is unchanged in the snap). Run **from the `cdk/` directory** `npm ci && npm test -- -u` (the worktree-root `npm ci` does **not** install cdk deps — separate lockfile). Review each `.snap` diff: confirm new `CfnSecurityGroupIngress`/`SourceSecurityGroupId` (+owner if cross-account) appears, old `Peer.ipv4`/`CidrIp` is gone, peer `PeerVpcId` retargeted; investigate any unexpected hunk before committing only the `.snap` deltas.
- Run the **full** suite before pushing (`--maxWorkers=4`); API/ETL/CDK changes have historically caught regressions `tsc` cannot.

---

## 12. Open questions for networking / Fabrice

None invented; each blocks a specific edit or pre-flight gate.

1. **`lts-reciter-vpc01` vpcId** — blocks config A.1 / network-stack B.1 / etl-stack E.1.
2. **Placement subnet ids** for the Fargate ENIs, and which of `10.46.134.0/24` / `10.46.160.0/24` they sit in (drives `etlPeerCidrs` — one entry or two) — config A.1/A.2, return-route values, probe subnet (Section 10 step 3), capacity (G7).
3. ✅ **RESOLVED — same account `665083158573`** (Fabrice, 2026-06-30). Implement the same-account path: auto-accept, L2 `addIngressRule`, no `peerOwnerId`/`sourceSecurityGroupOwnerId`, G8 N/A.
4. ✅ **RESOLVED — `us-east-1`** (RDS hostname evidence). SG-references over peering are valid; no CIDR fallback needed on region grounds.
5. **SG-references enabled on both peers (G3)** — confirm "Allow referenceable security groups" is on (and DNS resolution option set) on each peering connection.
6. **DNS reach (G4/G5)** — are the Aurora writer/reader, OpenSearch domain, and internal ALB hostnames in a Route 53 PHZ associated with (or resolvable from) `lts-reciter-vpc01`, resolving to `10.20.x`/`10.10.x`?
7. **AWS-service egress (G6)** — does `lts-reciter-vpc01` have NAT and/or VPC endpoints for ECR (api+dkr), CloudWatch Logs, Secrets Manager, S3, DynamoDB, and do endpoint policies permit the SPS task role?
8. **Subnet IP capacity (G7)** — free addresses in the placement subnets for concurrent staging+prod ENIs; if tight, a dedicated subnet?
9. **lts-reciter-side routes + peer accept + SG ownership (G9/Q-own)** — confirm networking adds `10.20/16 → pcx` (staging) and `10.10/16 → pcx` (prod) and (if cross-account) accepts each peer; named owner + SLA + how SPS detects `active`. Does networking pre-create `staging-ETL-SG`/`prod-ETL-SG` (SPS imports ids — recommended), or does SPS? Need the ids + naming/tagging if networking-owned.
10. **lts-side IaC + drift** — are `lts-reciter-vpc01` route tables / SGs managed by Terraform/CloudFormation/manual, and is there drift detection on the peer + routes?
11. **ED-export bridge** — does the bridge (etl-stack ~L2150-2160) also move to `lts-reciter-vpc01`, or stay on scholars-dev/prod? This plan treats it as **staying** (separate `etlComputeVpc`, A.1). If it moves, a follow-up reuses this shared-VPC model for the bridge.

---

## 13. Doc & diagram updates

- **Create the handoff doc.** `docs/etl-vpc-migration-handoff.md` is referenced by `config.ts`, `data-stack.ts`, `etl-stack.ts`, and `cdk/test/etl-stack.test.ts` but **does not exist at any ref** (verified — dangling reference). The migration plan should land that file (or this plan can be it, with the code references repointed to `docs/etl-shared-vpc-migration-plan.md`). It must describe the shared `lts-reciter-vpc01` + per-env SG-reference model, the dual-peer topology, the probe runbook (Section 10 step 3), and the rollback order — superseding the per-env scholars-dev/prod intent the JSDoc currently implies.
- **`docs/network-security-topology.md`** (exists @master): replace the per-env ETL-placement VPC rows with one `lts-reciter-vpc01` hosting both envs' ETL with `staging-ETL-SG`/`prod-ETL-SG`; replace the CIDR-allowlist pattern with the SG-reference pattern; document the two peers, the write-back path (Section 4), and the cross-env block.
- **`scripts/diagrams/definitions/03-network-topology.mjs`** (exists @master): add `lts-reciter-vpc01` as a peer node hosting both envs' Fargate ENIs with the two ETL SGs; draw both peering connections + Sps-side return routes; redraw datastore ingress as SG references (not CIDR). Use the `architecture-diagrams` skill toolkit so facts can't silently drift.
- **`docs/architecture/network-topology.svg`** (exists @master): regenerate from the updated `.mjs` (repo diagram build); commit SVG (+ PNG/HTML if the gallery tracks them).
- **PR #1310:** update the description (and, if it merges before this plan, the merge commit note) to reflect the retargeted `peerVpcId` and the SG-reference ingress, so reviewers don't approve the stale scholars-dev/prod intent and future developers don't read it as the placement of record.

---

## 14. Out of scope & rejected/down-scoped findings

**Out of scope (parked):**
- **InfoEd** (`10.20.91.8`, overlaps `10.20/16`, likely third-party): excluded per the meeting. No route or SG work.
- **Reconcilers (#393, #353) + curated backup:** confirmed to **stay in the Sps VPC** on the **local** `etlSecurityGroup` (etl-stack L1321-1322, L1618-1619, L1789-1790). They only touch Sps Aurora/OpenSearch and **do not cross the peer** — so they do not need a placement move, and their datastore connectivity comes from the local app-SG/etl-SG rules (data-stack), which C.3 explicitly does **not** touch. **ASSUMPTION:** no reconciler/backup ever needs to read a `10.46.x` source; if one does, it would have to relocate too — flag for confirmation, treated as no-change here. Section 11 adds a regression check that reconciler/backup writes still succeed with the new peer-SG rules co-present.
- **ED-export bridge VPC** (etl-stack ~L2150-2160): stays on scholars-dev/prod via the still-separate `edExportVpc` unless Q11 says otherwise — this migration's task move uses the new `etlComputeVpc` only.

**Rejected / down-scoped review findings (with reason):**
- **"Add a deploy-time code guard that throws if stack name contains 'prod' but `envName !== 'prod'`"** — REJECTED as code; kept as a one-line pre-deploy checklist item only (Section 10). Stack ids are `Sps-*-${env}` derived from the same `-c env` value that selects the config block, so a single `-c env` cannot pair prod stacks with staging config; the guard would protect against a state that the construction model already makes unreachable. The genuine risk (deploying the wrong env wholesale) is covered by the prod reviewer gate.
- **"Manually inspect Aurora/OpenSearch for orphaned records and reconcile on rollback"** — DOWN-SCOPED. The ETL is idempotent (upserts / per-partition delete-then-insert / full-corpus index rebuild), so a re-run in the Sps VPC self-heals; manual reconciliation is reserved for the narrow case of a run killed mid-write whose next idempotent run cannot reach the source (Section 10 rollback step 1).
- **"Enable DNS in the `CfnVPCPeeringConnection` construct itself"** — NOTED but treated as a pre-flight/networking action (G4), not necessarily an SPS CDK edit: the peering DNS-resolution option and the VPC-level `enableDnsSupport`/`enableDnsHostnames` may be owned by the lts-reciter side (especially cross-account, where the accepter sets its own option). SPS sets what it owns on the requester side and **verifies** the rest in the probe; folding it into the construct is an option only if SPS owns both sides (same-account). This is left as Q5/G4 rather than a hard CDK edit.

---

**ASSUMPTION markers retained inline:** separate `etlComputeVpc` (resolved to a decision in A.1, with the bridge-stays rationale); `us-east-1` region (G1); reconcilers never reading `10.46.x`; ED-bridge staying put (Q11). All concrete network identifiers (vpcId, subnet ids, account id, SG ids, exact placement CIDR, owner id) are deliberately left as Section 12 questions, never guessed.
