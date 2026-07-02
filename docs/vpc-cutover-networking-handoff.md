# SPS VPC consolidation — networking handoff (post-cutover)

**Status: STAGING cutover Phases B→E EXECUTED + VALIDATED 2026-07-02.** Staging now runs
entirely inside the shared **`its-reciter-vpc01`** off a snapshot-restored Aurora cluster
and a freshly reindexed OpenSearch domain. This doc is the durable record of what changed
on the network, the next steps (merge → soak → decommission → prod), and the operational
reference (ids, endpoints, techniques).

Companion docs: execution runbook `docs/cutover-item3-execution-runbook.md` (§3 phase-by-phase),
plan `docs/sps-vpc-consolidation-plan.md`, prod checklist `docs/cutover-item3-prod-release-checklist.md`.

---

## 1. Network topology now (staging)

| Tier | Where it lives now | Was (standalone `Sps-Network-staging` `10.20.0.0/16`) |
|---|---|---|
| VPC | **`vpc-08a1873fc8eebae28`** (its-reciter-vpc01), CIDRs `10.46.134.0/24` + `10.46.160.0/24`, TGW `tgw-07716c8311a165e54` | old standalone VPC (still live, deleted at Phase G) |
| App + ETL Fargate | **app2 subnets** `subnet-0c6593fb9c9a165c3` (aza, `10.46.160.0/25`) + `subnet-070cbc242efbddc3c` (azb, `10.46.160.128/25`) | old app subnets |
| Public ALB | **DMZ subnets** `subnet-09a6fab648280ca19` + `subnet-0485fefe267b06736` (IGW `igw-09ece8f823b10c030`) — new ALB `Sps-Ap-Publi-28Px8J5FO9hH-959335416.us-east-1.elb.amazonaws.com` (`app/Sps-Ap-Publi-28Px8J5FO9hH/54dece3b8bad13da`) | old ALB `sps-public-staging-955542627` (replaced, auto-named) |
| Aurora + OpenSearch | **db subnets** `subnet-0d35923e345653d0d` + `subnet-099a9ebefc36ee888` | old db subnets |
| Per-env SGs (item-3 G8) | app `sg-010c270a395b4854b` · etl `sg-016b62e11314e7050` · alb `sg-0ab492e161a9e9976` (allow-all egress, no ingress) | — (isolation was network-level; now per-env SG) |

**Isolation model:** per-env security groups inside one shared CIDR — **no VPC peering**.
App→datastore reachability is intra-VPC SG-to-SG (`app/etl → aurora:3306`, `app/etl → opensearch:443`),
which is why the whole estate moved together in one cutover.

**Datastores (new, live):**
- Aurora `sps-data-staging-auroraclusterfromsnapshot7b6a45d8-8kp4eh79cfrn`
  - writer `…-8kp4eh79cfrn.cluster-cetg9yc1lyuf.us-east-1.rds.amazonaws.com`
  - reader `…-8kp4eh79cfrn.cluster-ro-cetg9yc1lyuf.…` (1 instance; reader endpoint routes to writer)
  - restored from `sps-data-staging-cutover-final-20260702`; engine `8.0.mysql_aurora.3.08.0`; master `scholars_admin` (`db/master-its`)
- OpenSearch `opensearchshare-mhshucea3jvk`
  - `vpc-opensearchshare-mhshucea3jvk-tlepzyd25hhwagioteu36zt22u.us-east-1.es.amazonaws.com`

**Retained for rollback (deleted at Phase G, not before):**
- old Aurora `sps-data-staging-auroracluster23d869c0-rgmmgczcfzdc` (deletion-protection ON)
- old OpenSearch `opensearch58799-j7tli0rlgtyz`
- old physical SGs (orphaned by the `RETAIN` fix; torn down with the old VPC)

**Edge:** CloudFront `E17NRWINXLP3B3` (`scholars-staging.weill.cornell.edu`) origin →
new ALB; WAF `sps-edge-staging-wcm-only` + ACM cert `f50f0b04-…` + alias all preserved.
The ALB origin is an SSM `Value<String>` param (`/sps/staging/app/public-alb-dns`) that
re-resolves on every deploy — the `-c edgeCustomDomain/edgeCertArn/edgeAllowedCidrs` flags
are load-bearing (a bare `cdk deploy Sps-Edge-staging` strips WAF/cert/alias).

---

## 2. What was executed (B→E)

Runbook `docs/cutover-item3-execution-runbook.md` §3, all deploys `--exclusively` from
`origin/master`-based tree, `cdk diff` before each:

1. **B1** — parked ETL cadence rules; took the final Aurora snapshot after the write-freeze.
2. **B2** — flipped `observabilityMetricsByName` (seeded with current-live names) and deployed
   `Sps-Observability-staging` to **sever** the Data→Observability cross-stack exports (verified freed)
   before the Data replace.
3. **B3** — flipped `useSharedVpc:true` + set `auroraSnapshotIdentifier`; `cdk diff` every stack
   (confirmed ECS cluster/service **update** not replace, ALBs auto-named create-before-delete);
   deployed `Sps-Data-staging` → new cluster-from-snapshot + fresh empty OpenSearch domain, old ones orphaned/RETAIN'd.
4. **B4** — recreated DB grants + OpenSearch FGAC + reindexed:
   - cloned `app_rw`/`app_ro`/`etl` from `@'10.20.%'` → `@'10.46.160.%'` on the new cluster (golden-list grants verified)
   - reseeded every `db/*` DSN + `opensearch/{app,etl}` `node` secret to the new endpoints
   - provisioned FGAC roles/users/mappings on the fresh domain (with the #485 alias-get-on-`*` fix)
   - `search:index` → **8,937 people / 177,255 pubs / 4,858 funding / 1,150 opportunities**, smoke checks passed
5. **C** — deployed `Sps-App-staging` onto the shared VPC; validated the new ALB directly
   (`X-Origin-Verify` 403-without/200-with) and end-to-end via `scholars-staging.weill.cornell.edu`
   (search + profile + health green); redeployed Observability with the new identifiers.
6. **D** — repointed the CloudFront origin to the new ALB (WAF/cert/alias preserved).
7. **E** — deployed `Sps-Etl-staging` onto the shared VPC; re-enabled the parked schedules on the new tier.

### Two latent bugs fixed in the (never-before-deployed) cutover code — PR #1419
Both gated on `useSharedVpc` so flag-off synth is byte-identical; **both also fix the prod cutover.**
1. **Data-tier SGs now `RETAIN`.** The VpcId change forces an SG *replace*; without RETAIN, CFN
   deletes the old physical SG during cleanup while the RETAIN'd old cluster/domain are still
   attached → `DependencyViolation`, failed deploy. RETAIN orphans them (torn down with the old VPC at G).
2. **OpenSearch domain gets a new construct id under `useSharedVpc`.** An OpenSearch domain
   [cannot move to a different VPC in place](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/vpc.html);
   the stable-id code would attempt an in-place `VPCOptions` change and fail the deploy. The new id
   forces a fresh (empty → reindexed) domain and orphans the old.

---

## 3. Next steps

### 3.1 Merge PR #1419 (makes master == deployed)
`item-3: cut staging over to the shared VPC + snapshot-restore data path`.
Lands `useSharedVpc:true` + `auroraSnapshotIdentifier` + `observabilityMetricsByName` + the new
identifiers + `appRwGranteeHost 10.46.160.%` + the 2 data-stack fixes + updated tests/snapshots.

**Why it matters:** master still shows `useSharedVpc:false` for staging until this merges. A
`cdk deploy Sps-*-staging` from master would try to **revert** staging to the standalone VPC. Nothing
auto-deploys infra (CD only rolls images), but merge closes the footgun. cdk gate is green; merge on build-green.

> ⚠️ **This config ARMS Phase G but does not trigger it.** With `useSharedVpc:true`, `Sps-Network-staging`
> synthesizes as an *import* of the shared VPC (0 NAT/subnets) — deploying it tears down the standalone
> VPC. **Do NOT `cdk deploy Sps-Network-staging` until Phase F soak passes** (see 3.3).

### 3.2 Phase F — soak (reversible; days)
- [ ] ≥1 full **nightly** Step Functions cycle clean on the new tier (fires 07:00 UTC 2026-07-03) — watch `/aws/states/…nightly-staging` + `/aws/ecs/sps-etl-staging`.
- [ ] ≥1 **weekly** cycle (Sunday 08:00 UTC).
- [ ] Search freshness after a cadence run; edit-flow write lands in the new cluster (the one Phase-C check deferred).
- [ ] ALB 5xx/latency + ENI/EIP headroom nominal.
- [ ] Canary: `chm2042` publicationCount > 0 after nightly (post-VPC ETL canary).
- [ ] Row-count/checksum parity old↔new Aurora for the app-SOR tables (center membership, curated org-unit/methods-tools, `scholars_audit.manual_edit_audit`).
- [ ] AWS Backup selection points at the new cluster; next daily run = primary + us-west-2 copy.

Rollback during soak: revert the app/etl secrets to the old endpoints + redeploy App/Etl/Edge back
to the standalone VPC (old cluster/domain still live). No data loss (write-frozen at snapshot; edits
since land in the new cluster — reconcile if rolling back after edits).

### 3.3 Phase G — decommission (NOT reversible once old data tier deleted)
Only after F passes. Ordered teardown (a VPC delete fails while an orphaned RDS lives in it):
1. Final snapshot of the OLD cluster; disable its deletion protection; **delete old Aurora + old OpenSearch domain**.
2. Deploy `Sps-Network-staging` **last** → deletes the standalone VPC/subnets/NAT/RTs, releases the EIP,
   drops the 3 resolver associations. Confirm its-reciter already carries WCM resolver reach (G7 GREEN) first.
3. Clean up orphaned old physical SGs if any linger.

### 3.4 Prod — repeat A→G
After staging soaks clean. Prod differs: `appRwGranteeHost` is already `%`; adds the **#475 reviewer gate**,
its own snapshot + `auroraSnapshotIdentifier`, 35-day recovery-point retention before any teardown, and its
own drift review before the App deploy. The **2 bug fixes in #1419 carry over** (prod would have hit both).

---

## 4. Operational reference

### 4.1 Running privileged DB/OpenSearch admin in-VPC (no bastion)
There is no bastion/ECS-Exec, and the RDS Data API `--enable-http-endpoint` **silently no-ops** on this
Serverless-v2 3.08 cluster. Pattern used:
- One-off task-def cloned from `sps-etl-staging` (has `mariadb` + `tsx` + global `fetch`), with the needed
  secrets injected (`db/master-its`, `opensearch/{master,app,etl}`) — run-task overrides can't add `secrets`,
  so a dedicated task-def revision is required; grant the ETL **exec** role read on the extra secrets temporarily.
- Inline script via `--overrides file://…json` (Python `json.dumps` handles escaping); `mariadb` v3 ESM:
  `const m = (await import("mariadb")).default ?? mod`.
- Clone a DB user's identity without plaintext: `SHOW CREATE USER 'x'@'old'` → swap the **backtick-quoted** host → execute; never log the statement (the driver embeds the hash in error messages — catch and print codes only).
- Reseed DSN/JSON secrets host-only via boto3 (never print the value).
- **Revoke the temp exec-role policy + deregister the one-off task-def when done.**

### 4.2 Deploy hygiene
- Always deploy from a fresh `origin/master`-based tree, `--exclusively`, `cdk diff` first.
- Edge deploys REQUIRE `-c edgeCustomDomain=… -c edgeCertArn=… -c edgeAllowedCidrs=…` (bare deploy strips WAF/cert/alias).
- Never deploy `Sps-Network-staging` until Phase G.

### 4.3 Key ids
- Account `665083158573` · region `us-east-1` · shared VPC `vpc-08a1873fc8eebae28`
- New cluster `sps-data-staging-auroraclusterfromsnapshot7b6a45d8-8kp4eh79cfrn` · new domain `opensearchshare-mhshucea3jvk`
- Old (rollback) cluster `sps-data-staging-auroracluster23d869c0-rgmmgczcfzdc` · old domain `opensearch58799-j7tli0rlgtyz`
- SGs app `sg-010c270a395b4854b` / etl `sg-016b62e11314e7050` / alb `sg-0ab492e161a9e9976`
- Edge dist `E17NRWINXLP3B3` · cert `arn:aws:acm:us-east-1:665083158573:certificate/f50f0b04-dc62-4d8e-97b8-2761d1efdd0f` · WAF `sps-edge-staging-wcm-only` (CIDRs `157.139.0.0/16`,`140.251.0.0/16`)
