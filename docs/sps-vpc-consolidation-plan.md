# SPS Estate Consolidation into `its-reciter-vpc01` — Migration PLAN

**Status: DRAFT PLAN for human approval (senior engineer + networking lead). Not yet approved; no work authorized by this document.**

- **Grounded vs `origin/master`** (working tree is ~358 commits behind and was NOT trusted; every code reference was re-read via `git show origin/master:<path>` for `cdk/lib/{network,data,app,etl,edge,config}-stack.ts`, `cdk/lib/config.ts`, `cdk/bin/sps-infra.ts`, `etl/search-index/index.ts`, `etl/orchestrate.ts`, `etl/search-index/alias-swap.ts`).
- **Supersedes the peering design.** This plan **replaces** the VPC-peering approach of PR **#1229** + merged PR **#1310** and `docs/etl-shared-vpc-migration-plan.md`, per the **2026-06-30 "full consolidation, no peering" decision**. Those moved only the ETL compute and stretched reachability across two `CfnVPCPeeringConnection`s; this plan relocates the **entire SPS estate (both envs)** into one shared, TGW-attached VPC and **deletes the peering apparatus**.
- **Decision being planned:** relocate AppStack (both ALBs + ECS), DataStack (Aurora + OpenSearch), and EtlStack for **both staging and prod** into the single, already-existing **`its-reciter-vpc01`** (account `665083158573`, `us-east-1`; CIDRs `10.46.134.0/24` + `10.46.160.0/24`; already hosts ReCiter RDS `10.46.134.208` and `reciter-publication-manager-dev` `10.46.134.113`). **Env isolation is by per-env security groups inside one shared CIDR — no network boundary, no peering.** Then decommission the SPS-owned `Sps-network-staging` (`10.20.0.0/16`) and `Sps-network-prod` (`10.10.0.0/16`) VPCs.
- **Identifier discipline:** the substrate identifiers (vpcId, subnet ids/AZs/CIDRs, IGW/NAT presence, VPC-endpoint + resolver-rule inventory, per-tier free-IP capacity) were **discovered 2026-06-30 via read-only `aws ec2 describe-*`** in account `665083158573` and are now filled in (§2.2 gates G0–G5/G7 GREEN, §3, §4.4 subnet table) — **none invented; all describe-verified.** Three further items were settled **2026-06-30** by operator decision + one measurement: **prod data volume is now MEASURED** (~658 MB — G14 GREEN, Q18); **SG ownership + deploy-role ENI-attach are OUR call** because SPS owns both ReCiter and the account (G8/G10 GREEN, Q4/Q15/Q16); and **the public front door is decided — NetScaler** (G11 narrowed / #502 / Q13 resolved). The one remaining genuinely **EXTERNAL** item is the **WCM-firewall source-allow (G6/Q12)** — TGW routing is already confirmed present; everything else is now measured or an internal SPS decision. Narrow follow-ups stay open questions (§9: the NetScaler→internal-ALB reachability path Q11, and whether CloudFront is kept as an optional caching layer). Nothing in this plan is invented.

---

## 1. Decision summary — old peering design → this consolidation

| Dimension | Old peering design (#1229 / merged #1310 / `docs/etl-shared-vpc-migration-plan.md`) | This consolidation (2026-06-30 decision) |
|---|---|---|
| Scope of move | **ETL compute only** relocates into `its-reciter-vpc01`; Aurora/OpenSearch/App stay in the Sps VPCs | **Entire estate** (App + Data + ETL, both envs) relocates into `its-reciter-vpc01` |
| Cross-VPC reachability | **Two VPC peerings** (`its-reciter ↔ 10.20/16`, `↔ 10.10/16`) + return routes + cross-VPC SG references ("Allow referenceable SGs") | **No peering anywhere.** All reachability is intra-VPC SG-to-SG references |
| Sps VPCs | Retained (datastores stay there) | **Decommissioned** (`10.20/16` + `10.10/16` deleted, last) |
| Env isolation | Network layer (separate VPC/CIDR per env) + cross-VPC SG refs gated by `etlVpcPeeringEnabled` | **Per-env security groups only**, inside one shared CIDR — no network backstop |
| Key CDK constructs | `CfnVPCPeeringConnection`, `EtlCadencePeerRoute*`, `EtlComputeSgRef`, `InternalAlbIngressFromEtlCadenceVpc`, `etlPeerCidrs`, `etlVpcPeeringEnabled`, `etlCadenceVpcRelocated`, `assertEtlMigrationInvariants` | **All deleted.** Reuse only the import-by-id pattern (`Vpc.fromVpcAttributes` / `Subnet.fromSubnetId` / `SecurityGroup.fromSecurityGroupId`) and the SG-isolation model, **generalized** to the whole estate |
| WCM source reach | Peering + out-of-band routing; #443 gap persists | Native via `its-reciter`'s TGW attachment — the consolidation's primary upside |
| #1310 disposition | n/a | **Superseded by a forward PR**, not `git revert` (keep the reusable import scaffolding; delete the peering halves) — §9.7 |

---

## 2. Pre-flight HARD GATES

### 2.1 How to read this section

Every item in §2.2 is a **binary GO/NO-GO gate**. No change-list item deploys until *all* gates it depends on are GREEN, where GREEN means the fact is **describe-verified, measured, or settled in writing** — not assumed. This plan invents **zero** concrete network identifiers: the substrate (vpcId/subnets/IGW/NAT/endpoints/resolver) was read directly from AWS on 2026-06-30 (those gates are GREEN); prod data volume was **measured** 2026-06-30 (G14 GREEN); and the SG-ownership, deploy-role-ENI-attach, and edge-front-door items are now **SPS decisions** (we own ReCiter + the account; NetScaler chosen — G8/G10/G11), not cross-team asks. The one value still «UNKNOWN — cross-team» is the **WCM firewall source-allow** (G6/Q12); a few narrow edge follow-ups (NetScaler→internal-ALB reachability, optional CloudFront caching, cert ARNs) stay tracked in §9. A still-RED gate cannot flip GREEN while any value it needs is «UNKNOWN».

Two gates remain **plan-validity** gates: if RED they invalidate the consolidation shape and force a redesign — clear these first.
- **G0 (account model)** can void the architecture. (**G4 / public ingress is no longer plan-validity:** with NetScaler chosen as the front door the app ALB is internal-only, so an internet-facing public ALB is nice-to-have, not required — §7.)
- **G15 (cutover-mechanics / name-collision plan)** can void the rollout mechanic (see §9, the blocker the reviews surfaced).

The consolidation inverts the substrate; nothing carries over automatically:

| Dimension | BEFORE (per-env) | AFTER (consolidated) | Gate |
|---|---|---|---|
| VPC | NetworkStack **CREATES** a 2-AZ VPC from `vpcCidr` | NetworkStack **IMPORTS** `its-reciter-vpc01` via `fromVpcAttributes` (CI synth is account-agnostic → `fromLookup` unavailable) | G1 |
| Env isolation | **Network layer** (separate VPCs + non-overlapping CIDRs) | **SG references only** — both envs share `10.46.134.0/24` + `10.46.160.0/24` | G8, G9 |
| Tenancy | SPS owns its whole VPC | SPS ENIs/SGs co-tenant with ReCiter RDS + pub-mgr-dev (**the ReCiter EKS cluster is in a SEPARATE VPC `192.168.0.0/16`, NOT here** — confirmed 2026-06-30, so no EKS VPC-CNI IP contention) | G2, G9 |

### 2.2 HARD GATES (all must be GREEN before the deploy steps they block)

Cross-ref shorthand: **§CL-Net/Data/App/Etl/Edge/Cfg** = the §6 per-stack change-lists; **§DM-\*** = §7 data-migration items.

> **Status column updated 2026-06-30.** Gates flipped GREEN from three sources: (1) **AWS describe** (read-only) in `665083158573` / `us-east-1` for the substrate; (2) a **prod data-volume measurement** (`information_schema`) resolving the write-freeze sizing (**G14**); and (3) **operator decisions** — SPS owns ReCiter + the account, so SG ownership (**G8**), ENI-attach IAM (**G10**), and ReCiter co-tenancy (**G9**) are our call, and **NetScaler** is the chosen edge front (**G11** narrowed; #502 resolved). The only gate still gated on a **WCM/cross-team action** is **G6** (the WCM firewall source-allow); **G12/G13/G15** carry remaining **operational/SPS** steps.

| ID | Status | Gate (must be GREEN) | Evidence / owner | Failure mode if RED | Blocks |
|---|---|---|---|---|---|
| **G0** | **GREEN** | **Account + region confirmed.** `its-reciter-vpc01` AND both SPS envs are in `665083158573` / `us-east-1`, and staging+prod genuinely share that one account today. | **CONFIRMED 2026-06-30 (read-only describe, Paul):** single account `665083158573` / `us-east-1`. The **ADR-008 "separate accounts" wording is stale/wrong** — **no cross-account work**. (Networking/AWS Orgs should still correct the ADR-008 contradiction: config JSDoc + `network-security-topology.md` say *separate accounts*; the EIP-cap comment + session memory say *shared* `665083158573`.) | If separate accounts, this is **also a cross-account merge** → KMS/secret/cross-account-share/IAM rework; the `-c <env>Account` synth pattern + ADR-008 decision-5 no longer hold. **Plan-validity.** | everything |
| **G1** | **GREEN** | **VPC identity + import attributes known.** `vpcId` + explicit subnet ids + AZs (+ per-subnet route-table ids if any route reference is needed). | **CONFIRMED 2026-06-30 (read-only describe):** `its-reciter-vpc01` = `vpc-08a1873fc8eebae28`; CIDRs `10.46.134.0/24` + `10.46.160.0/24` (plus an unused secondary `3.89.200.0/24`); TGW-attached `tgw-07716c8311a165e54`. 8 subnets across us-east-1a + us-east-1b — full ids/tiers in §4.4. | Synth cannot import; or resources land in the wrong tier/AZ. | §CL-Net, §CL-Cfg |
| **G2** | **GREEN with placement constraint** | **IP / ENI capacity proven** in the two /24s to absorb **BOTH envs' full estate** on top of ReCiter. | **CONFIRMED 2026-06-30 (read-only describe), with a placement constraint:** the **app2 tier (162 free: `10.46.160.0/25`=78 + `10.46.160.128/25`=84)** is the runway — place SPS app + ETL compute **HERE**. The **db /27 tier (40 free)** and **public dmz /27 tier (45 free)** are the tight spots for two envs' Aurora/OpenSearch/ALBs — workable but confirm. **AVOID the near-full app /26 tier (only 5 + 17 free).** **The ReCiter EKS cluster is in a SEPARATE VPC (`192.168.0.0/16`), NOT here — so there is no EKS VPC-CNI IP contention in this VPC.** SPS demand is an **estimate** (≈9 app ENIs at max autoscale, ~8 ALB ENIs across 2 AZ×2 env, Aurora writer+reader, OpenSearch 1+2 nodes, ETL fat task + 5-min reconcilers, rotation/seeder Lambda ENIs). Full subnet table in §4.4. | ENI/IP exhaustion → tasks stuck PROVISIONING, datastore/endpoint ENI placement fails, autoscale stalls, partial deploy. | §CL-App, §CL-Data, §CL-Etl |
| **G3** | **GREEN** | **AZ coverage ≥ 2.** Placement subnets span ≥2 AZs. | **CONFIRMED 2026-06-30 (read-only describe):** the 8 subnets span **us-east-1a + us-east-1b** → multi-AZ Aurora writer+reader and a 2-node zone-aware (`zoneAwareness=2`) OpenSearch domain are viable, and multi-AZ ALBs are placeable. | Prod loses multi-AZ (Aurora writer+reader, 2-node OpenSearch `zoneAwareness=2` synth fails with <2 AZs, multi-AZ ALBs). | §CL-Data, §CL-App |
| **G4** | **GREEN — but no longer required** | **Public ingress** — internet-facing PUBLIC subnets + IGW. **NICE-TO-HAVE, NOT on the critical path:** with the 2026-06-30 NetScaler decision the SPS app ALB is **INTERNAL-only**, fronted by NetScaler (§7); an internet-facing public ALB is not needed. | **CONFIRMED 2026-06-30 (read-only describe):** IGW `igw-09ece8f823b10c030` present, 2-AZ public **dmz** tier routes to it → public ingress *exists* if ever wanted. **But the plan now uses an internal ALB behind NetScaler, so this capability is optional, not load-bearing.** | **NOT a blocker.** Even if public ingress were absent, the internal-ALB-behind-NetScaler model stands. | §CL-App, §CL-Edge |
| **G5** | **GREEN via NAT (no endpoint conflict)** | **Egress + AWS-service endpoints sufficient**, role-permitting, **no duplicate-private-DNS conflict.** Need NAT and/or interface endpoints for ECR-api, ECR-dkr, CloudWatch Logs, Secrets Manager (`privateDnsEnabled`), STS + gateway endpoints S3, DynamoDB. | **CONFIRMED 2026-06-30 (read-only describe):** **NAT gateways in both AZs** (`nat-056ac39b8ea37dd6c` 1a, `nat-0a01ea7275328eeba` 1b) → outbound internet works. Endpoints present: **S3 (gateway) + DynamoDB (gateway) + Lambda (interface, private-DNS)**. **NO ECR(api/dkr) / CloudWatch Logs / Secrets Manager / STS interface endpoints** → SPS Fargate rides **NAT** for those (works; minor NAT cost/throughput). **There is NO private-DNS Secrets Manager endpoint here, so the "duplicate private-DNS SM endpoint" conflict is MOOT** — SPS reaches SM over NAT and does not add a 2nd SM endpoint. (Destination-specific reachability — Bedrock/SES/RePORTER/etc. — is policy not plumbing; tracked under Q7.) | Image pulls, log puts, `GetSecretValue` (seeder + rotation Lambda hang ~49s then fail), ReCiter DynamoDB/S3/KMS reads break. (The duplicate-SM-endpoint rejection no longer applies — no SM endpoint exists.) | §CL-App, §CL-Data, §CL-Etl |
| **G6** | **RED — partial (TGW routing present; WCM firewall open)** | **TGW source reach + WCM firewall hold for `10.46.x`** to the **full** SPS source set: ReciterDB, ED LDAPS (`edprovider.weill.cornell.edu:636`), InfoEd `10.20.91.8`, ASMS, COI, Jenzabar, SES, POPS (`pops.weillcornell.org`), and the public-API ETL sources. | **TGW routing half CONFIRMED 2026-06-30 (read-only describe):** the private route tables carry `10.0.0.0/8` + WCM ranges (`207.162.240.0/20`, `140.251.0.0/16`, `157.139.0.0/16`) → TGW, so on-prem + 10.x sources route via `tgw-07716c8311a165e54`. **STILL OPEN (Q12):** the WCM-side firewall admitting `10.46.134/160 → each source` is policy, not plumbing — a describe call cannot prove it; confirm or file a change. | ETL steps fail; #443 reach regresses; staging `etl:infoed` stays blocked if `10.20.91.8` unreachable from `10.46.x`. | §CL-Etl, §CL-App |
| **G7** | **GREEN** | **WCM DNS resolver state decided.** Are the 3 RAM-shared FORWARD-rule associations (`rslvr-rr-58457e95d34548148`, `-467f0939c1f2458e9`, `-56f32331b3a1441ba`; Central Services `091981818184`) **already associated to its-reciter** → SPS **DROPS** its 3 `CfnResolverRuleAssociation`s. | **CONFIRMED 2026-06-30 (read-only describe):** the 3 WCM Route53 Resolver rules (`med_cornell_edu`, `weill_cornell_edu`, `wcmc_ad_net`) are **ALREADY associated to `its-reciter-vpc01` (status COMPLETE)** → **no re-association needed**, and **no DNS gap** when the old Sps VPCs are decommissioned. SPS drops its own 3 associations. (Datastores are now LOCAL to this VPC, so the old "Sps datastore PHZ reach" framing no longer applies — this gate is purely about WCM-name resolution.) | Re-associating an already-associated rule → CFN *"rule already associated."* Dropping when they're **not** present → WCM hostnames stop resolving after Sps-network teardown. | §CL-Net, §CL-Cfg |
| **G8** | **GREEN — our call** | **Per-env SG ownership decided.** SPS creates its **own** per-env SGs (alb / internal-alb / app / etl / vpc-endpoint / aurora / opensearch, suffixed per env) against the imported `its-reciter-vpc01` — **not** networking-pre-created. | **RESOLVED 2026-06-30 (operator decision):** SPS owns ReCiter + the account, so SG creation against the import is an internal action; SGs live in reviewable SPS IaC (NetworkStack option (a), §5.3). Confirm default SG-quota headroom at first deploy (internal). | n/a — SGs are created against the imported VPC in SPS CDK, so SG-to-SG ingress is valid intra-VPC. | §CL-Net, §CL-Data, §CL-App, §CL-Etl |
| **G9** | **GREEN — our call (internal SG discipline)** | **Isolation enforced two ways, SG-only.** (a) **From ReCiter:** RESOLVED — SPS owns ReCiter, so no external acceptance is needed (Q16); SPS and ReCiter SGs are mutually scoped by SPS. (b) **staging↔prod:** with one shared CIDR and no peering, every ingress is an **SG-reference by id** and a **prod SG must NEVER appear in a staging rule** (and vice-versa) — an **SPS-internal naming/tagging discipline**, not a cross-team ask. | **RESOLVED 2026-06-30 (operator decision):** ReCiter co-tenancy is our call (we own it); cross-env SG hygiene is enforced by SPS via env-suffixed, auditable naming. Still a **security-review-grade** design requirement to implement + document. | A mis-named/missing SG reference silently cross-wires prod↔staging — remains a real implementation hazard (no network backstop); enforce + verify the env-suffix discipline. **Threat-model change** to `network-security-topology.md` + ADR-008. | §CL-Data, §CL-App, §CL-Etl + ADR update |
| **G10** | **GREEN — our call** | **IAM for ENI attach into shared subnets.** SPS task-exec / task / rotation / seeder roles **and** the CDK/CFN deploy role hold `ec2:*NetworkInterface*` (Create/Describe/Delete, + `CreateNetworkInterfacePermission`) for the app2/db/dmz placement subnets; no **SCP / permission boundary** blocks ENI attach. | **RESOLVED-as-our-call 2026-06-30 (operator decision):** SPS owns the account, so SPS grants its own roles the ENI permissions — an internal IAM action, not a Fabrice/networking gate; **no external SCP blocker expected.** Keep a one-line **verify-at-first-deploy** check (internal, Q15). | If the internal grant is missed, tasks/Lambdas/datastores stuck PROVISIONING — caught at first deploy, fixed in SPS IAM. | §CL-App, §CL-Data, §CL-Etl |
| **G11** | **NARROWED — front door decided (NetScaler)** | **Edge front-door = NetScaler** (#502 resolved, Q13; 2026-06-30 decision): the WCM ADC is the public front, with the SPS **internal ALB** as its backend (§7). The CloudFront origin-swap is no longer the plan; CloudFront could remain an optional caching layer (TBD, not required). **Residual edge items (narrow):** (a) the NetScaler→internal-ALB reachability path + SPS providing the internal-ALB DNS as backend (Q11); (b) cert/TLS termination at NetScaler + any retained-CloudFront cert ARNs (Q10). | SPS: provide internal-ALB DNS as NetScaler backend; WCM-ITS edge track: NetScaler VIP/cert. | The CloudFront-recreation hazard is **demoted** (CloudFront optional). Residual risk is only NetScaler→ALB reachability + cert wiring — narrow, not a redesign. | §CL-Edge |
| **G12** | **RED — narrowed (mechanism decided; volume measured)** | **Data-migration mechanism + cutover window.** **Mechanism DECIDED 2026-06-30:** Aurora = **logical dump/restore (or encrypted snapshot-restore via `DatabaseClusterFromSnapshot`)** into a NEW its-reciter cluster — **DMS/binlog CDC is contingency-only, NOT needed at the measured 658 MB** (§6.2 / G14); OpenSearch = **fresh domain + full `search:index` rebuild** (~178k+ pubs); **regrant** `app_rw`/`app_ro`/`sps_migrate`/`sps_bootstrap` from `'10.20.%'`/`'%'` → the new `10.46.x` scope (or `'%'`), update `appRwGranteeHost` + verify-grants golden list; **reseed** every DSN/endpoint secret. **Still RED operationally:** book the (sub-hour) maintenance window + execute the regrants/reseeds. | DBA + SPS: schedule the (now sub-hour) window; restore-target KMS confirmed (same acct/region → snapshot/dump retains key). | A stale DSN silently regresses every write step; MySQL **1410** closes the app for staging once tasks get `10.46.x` ENIs; reindex can't run until ETL+sources are reachable. | §DM-\*, §CL-Cfg |
| **G13** | **RED** | **Decommission sequencing approved.** `Sps-Network-staging`/`-prod` torn down **LAST**, only after cutover verification **and** prod's **35-day** recovery-point retention; RETAIN + deletion-protected Aurora/OpenSearch/BackupVaults preserved; orphaned recovery points handled; NAT EIPs + resolver associations released cleanly (upside: relieves the prod EIP cap — 2nd-NAT request denied 2026-05-20). | SPS + networking: written cutover runbook with ordering. | Premature teardown destroys the live data tier, orphans recovery points, or drops DNS/egress before co-location → outage + data loss. | §DM-\* + §CL-Net teardown |
| **G14** | **GREEN — measured** | **Prod data volume measured (resolves the write-freeze sizing).** | **MEASURED 2026-06-30 (read-only `information_schema` query on prod):** the relational SOR is **SMALL — total 658 MB** (data 498 MB + index 160 MB), **49 tables**, ~**619k rows**. Largest: `publication` 390 MB / 133k rows; `publication_author` 90 MB / 249k; `publication_topic` 59 MB / 75k; `grant` 31 MB; `grant_publication` 23 MB; `mesh_descriptor` 20 MB; everything else < 10 MB. At this size a **logical dump+restore (or snapshot-restore) runs in minutes** → write-freeze **comfortably sub-hour (~10–20 min est.)**. The previously-flagged "modest volume" premise is now **VERIFIED-measured**, not assumed. | Largely retired — still **book** the (sub-hour) prod maintenance window (G12). | prod window scheduling, §DM-\* |
| **G15** | **RED** | **Fixed-physical-name + CFN export hand-off plan approved (NEW gate; plan-validity for the rollout mechanic).** A per-resource disposition exists for every env-keyed physical name (OIDC provider [#491], IAM role names, ECR repos, ECS cluster/service, ALBs, RETAIN log groups, backup/DR vault names, `scholars/<env>/db/master`) AND a transitional cross-stack endpoint-wiring + export hand-off sequence (§9.2/§9.3). | SPS infra owner: approved §9.2 disposition matrix + §9.4 export hand-off order. | The naïve `-v2` parallel-stack model is **unbuildable** (env-keyed names + CFN export names collide); deploy fails "already exists"; backup vaults can't be renamed/deleted-while-nonempty. **Rollout-validity.** | §9 (all phases), §CL-* |
| **G16** | **N/A — CDC not needed (contingency only)** | **CDC prerequisites.** **DOWN-SCOPED 2026-06-30:** at the measured 658 MB (G14) a plain dump/restore freeze is sub-hour, so DMS/binlog CDC is **NOT on the primary path.** Pre-stage CDC **only** as a contingency *if a near-zero-downtime cutover is later required*: source Aurora `binlog_format=ROW` (parameter-group change **+ reboot of the old cluster**), DMS replication instance in-VPC, endpoints + IAM, type-mapping validated, a CDC dry-run passed — all before any such window. | DBA + SPS: only if the contingency is ever invoked. | n/a on the primary path. If CDC is ever needed, invoking it reactively adds setup delay — pre-stage then. | §DM-Aurora (contingency) |

---

## 3. Current state (concise)

- **Two CDK-created VPCs:** `Sps-network-staging` (`10.20.0.0/16`) and `Sps-network-prod` (`10.10.0.0/16`), each 2-AZ (`us-east-1a/b`), public `/24` + private-with-egress `/22`, **1 NAT gateway + EIP** per env (prod single-NAT due to the EIP cap).
- **Stacks** (instantiation order): NetworkStack → DrBackupVaultStack → DataStack → SecretsStack → AppStack → EtlStack → ObservabilityStack → EdgeStack → AnalyticsStack.
  - **DataStack:** Aurora MySQL Serverless v2 (`scholars`, engine `VER_3_08_0`; ACU 0.5–2 staging / 1–8 prod; reader 0/1; 14-day backup; `deletionProtection:true`, `RETAIN`) + OpenSearch domain (`OPENSEARCH_2_19`; 1×t3.medium.search staging / 2×m6g.large.search prod, `zoneAwareness=2`); db-bootstrap seeder + 30-day single-user rotation Lambda; `BackupPlan` `sps-aurora-daily-<env>` → primary vault `sps-backup-vault-<env>` + cross-region copy to us-west-2 `sps-dr-backup-vault-<env>`.
  - **AppStack:** public ALB (`sps-public-<env>`, internet-facing) + internal ALB (`sps-internal-<env>`), ECS Fargate cluster/service (`sps-cluster-<env>` / `sps-app-<env>`, `assignPublicIp:false`), Secrets Manager interface endpoint (`privateDnsEnabled`) + S3 gateway endpoint, ECR repos `scholars-app-<env>` / `scholars-etl-<env>` (RETAIN), the GitHub OIDC provider (owned only when `env==='staging'`, #491), IAM roles (`sps-task-exec-<env>`, `sps-task-<env>`, `sps-deploy-<env>`, …). Exports `Sps-App-<env>-InternalAlbDns` / `-InternalAlbSecurityGroupId`.
  - **EtlStack:** cadence + both reconcilers (`TaskReconcile`, `TaskCdnReconcile`), `TaskCurationBackup`, `TaskOpportunityProjection`, ED import — all hardwired to the Sps VPC private subnets + `etlSecurityGroup`; internal-ALB ingress from the ETL SG; `CurationBackupBucket` (S3, versioned, RETAIN). RunTask resolves its VPC from the AppStack cluster.
  - **EdgeStack:** CloudFront (dist ids above) + WAFv2 CLOUDFRONT-scope WCM allowlist (#461), ACM imported, S3 static origin (OAC) with ALB fallback, `X-Origin-Verify` shared secret, RETAIN logs bucket. (Was **frozen** behind #502 / RITM0792011 — **now resolved: NetScaler is the chosen front**, §7.7; CloudFront demoted to an optional caching layer.)
- **Env isolation today:** network layer (separate VPC/CIDR) + (assumed) account boundary. Datastores co-resident with compute in each Sps VPC; app/ETL reach them via **intra-VPC SG-to-SG references**.
- **WCM reach:** 3 RAM-shared resolver-rule associations on each Sps VPC + half-fixed routing (#443 gap). Staging `etl:infoed` excluded because InfoEd `10.20.91.8` self-overlaps `10.20/16`.
- **#1310 (merged, flag-off):** peering scaffolding present but inert (`etlVpcPeeringEnabled=false`, `etlCadenceVpcRelocated=false` both envs).
- **`its-reciter-vpc01`** (**discovered 2026-06-30 via read-only AWS describe**): `vpc-08a1873fc8eebae28`, account `665083158573`, `us-east-1`, TGW-attached `tgw-07716c8311a165e54`, CIDRs `10.46.134.0/24` + `10.46.160.0/24` (plus an unused secondary `3.89.200.0/24`); **8 subnets across us-east-1a + us-east-1b** in four tiers (public **dmz** → IGW `igw-09ece8f823b10c030`; private **app** /26 near-full; private **app2** /25 = the runway; private **db** /27), with **NAT gateways in both AZs** (`nat-056ac39b8ea37dd6c`, `nat-0a01ea7275328eeba`) and S3 + DynamoDB gateway endpoints + a Lambda interface endpoint (full table in §4.4). Already hosts ReCiter RDS `10.46.134.208` and `reciter-publication-manager-dev` `10.46.134.113`. **The ReCiter EKS cluster is in a SEPARATE VPC (`192.168.0.0/16`), NOT here** — the earlier "ReCiter EKS workload co-tenant" assumption is **refuted**, so there is no EKS VPC-CNI IP contention in this VPC.
- **`search:index` is reproducible from Aurora (confirmed `origin/master`):** `etl/search-index/index.ts` builds all four indices (people, publications, funding, opportunities) from MySQL/Aurora via Prisma using the **alias-swap pattern** (`alias-swap.ts`: versioned index → bulk-fill → atomic alias repoint); `orchestrate.ts` runs it **last**, after every source ETL. The only OpenSearch-resident state NOT rebuilt by `search:index` is the FGAC internal-user DB (set out-of-band via the `_security` API).

---

## 4. Target architecture (`its-reciter-vpc01`, no peering)

### 4.1 End-state in one sentence

The **entire SPS estate for both environments** — public ALB + internal ALB, the ECS Fargate app service, every ETL Fargate task, the Aurora MySQL cluster, the OpenSearch domain, and all VPC endpoints — lives inside the single, already-existing, TGW-attached **`its-reciter-vpc01`**, alongside the existing ReCiter RDS tenants. Staging and prod are isolated **only by per-env security groups inside one shared CIDR space** — no network boundary between them, and **no VPC peering anywhere**.

### 4.2 The load-bearing fact: the *whole* app moves, not just data

> **[ASSUMPTION — WHOLE-ESTATE MOVE]** AppStack (both ALBs + ECS), DataStack (Aurora + OpenSearch), and EtlStack all relocate into `its-reciter-vpc01` *together*. You cannot move a subset.

**Why no-peering forces this.** App→datastore reachability is expressed as **intra-VPC SG-to-SG references**, not CIDR rules: `app→aurora:3306`, `app→opensearch:443`, `etl→aurora:3306`, `etl→opensearch:443`, `etl→internal-alb:80`. An SG-to-SG reference is valid **only within a single VPC** (the peering plan needed "Allow referenceable security groups" precisely to stretch it across the boundary). With peering removed, the reference resolves only if source and target SGs are co-resident — so the moment any tier moves, every tier it talks to must move with it. The peering plan's "ETL-only relocation" is no longer expressible.

### 4.3 Before → after

| Dimension | Current (Sps-network-staging / -prod) | Target (`its-reciter-vpc01`, no peering) |
|---|---|---|
| VPC | Two CDK-**created** VPCs (`10.20/16`, `10.10/16`) | One pre-existing VPC, **imported** (`Vpc.fromVpcAttributes`, not `fromLookup` — CI synth is credential-free). CIDRs `10.46.134.0/24` + `10.46.160.0/24` (non-contiguous) |
| Env isolation | Network layer (separate VPC + CIDR) | **Per-env SGs inside one shared VPC/CIDR.** No network backstop |
| App/ETL → datastore | Intra-(Sps)-VPC SG-to-SG | Intra-(its-reciter)-VPC SG-to-SG. **No peer, no return routes, no `etlPeerCidrs`** |
| Subnets / AZs / NAT / IGW / route tables | SPS **creates** them | SPS **owns none** — consumes its-reciter's. `vpcCidr`/`natGateways`/hardcoded AZs stop driving creation |
| Internet egress | SPS-owned NAT + EIP per env | its-reciter NAT — **CONFIRMED: NAT gateways in both AZs** (`nat-056ac39b8ea37dd6c`, `nat-0a01ea7275328eeba`); endpoints = S3 + DynamoDB gateway + Lambda interface (no SM/ECR/Logs/STS interface endpoints → those ride NAT). Releases SPS NAT EIPs — eases the prod EIP cap |
| WCM DNS | 3 RAM-shared resolver-rule associations on the Sps VPC | **CONFIRMED already associated** to its-reciter (status COMPLETE) → SPS **drops** its 3 associations; no DNS gap at decommission |
| WCM source reach | Half-fixed; #443 gap | Native via its-reciter's TGW attachment — the primary upside |
| Aurora `app_rw` grantee host | staging `'app_rw'@'10.20.%'`, prod `'%'` | Re-scoped to the its-reciter source CIDR (`10.46.%`, exact range **UNKNOWN**) or `'%'` (the `10.20.%` grant fails closed at `10.46.x`) |

### 4.4 Subnet / tier layout

SPS places ENIs into its-reciter's existing subnets; it no longer creates any. Placement subnet IDs/AZs were **discovered 2026-06-30 via read-only AWS describe** and are tabulated in *Discovered subnet inventory* below (Q2 RESOLVED).

| SPS tier | Subnet type required | Notes |
|---|---|---|
| Public ALB (optional — not used under NetScaler) | **PUBLIC** (IGW-routed) → **dmz** subnets | **[G4 — nice-to-have]** its-reciter has a 2-AZ public **dmz** tier routed to IGW `igw-09ece8f823b10c030`, so an internet-facing public ALB is *available* — but the **NetScaler decision (§7) makes the SPS app ALB internal-only**, so this is unused on the critical path. (Only relevant if a public ALB is ever wanted; dmz `/27`s are the tightest public tier, 24 + 21 free.) |
| Internal ALB | Private (NAT-egress) → **app2** subnets | Serves only intra-VPC `/api/revalidate` from the ETL tier |
| ECS app service ENIs (`assignPublicIp:false`) | Private (NAT-egress) → **app2** subnets | Egress for Bedrock / SES / New Relic OTLP / POPS / ReCiter DynamoDB+S3+KMS |
| ETL Fargate ENIs | Private (NAT-egress) → **app2** subnets | Egress for RePORTER / NSF / Gates / PubMed E-utils / ECR pulls |
| Aurora + OpenSearch | Private (no public exposure) → **db** subnets | Prod requires **2 AZs** (writer+reader; `zoneAwareness=2`) — **G3 RESOLVED:** its-reciter spans us-east-1a + 1b. Place Aurora + OpenSearch ENIs in the **db** `/27` tier (40 free across 2 AZs — tight but workable for 2 envs; confirm). |
| Interface/Gateway endpoints | Private | **CONFIRMED (G5):** S3 + DynamoDB **gateway** + Lambda **interface** (private-DNS) endpoints exist. **No SM / ECR / Logs / STS interface endpoints → SPS rides NAT for those.** There is **no private-DNS SM endpoint, so the "2nd SM endpoint rejected" conflict is MOOT** — SPS drops its own SM/S3 endpoints and reaches SM over NAT. |

> **[ASSUMPTION — `fromVpcAttributes` placement]** Because the VPC is imported, `subnetType` filters (`PRIVATE_WITH_EGRESS`, `PUBLIC`) are unreliable. Aurora's subnet group, the OpenSearch subnet list, the ALB placements, and the seeder/rotation-Lambda placement must each be given **explicit its-reciter subnet IDs** — now known (see *Discovered subnet inventory* below; use **db** for data, **app2** for compute, **dmz** for the public ALB).

**Discovered subnet inventory (`vpc-08a1873fc8eebae28`, 2026-06-30, read-only AWS describe).** 8 subnets, 4 tiers, across us-east-1a + us-east-1b:

| Tier | Route | AZ 1a | AZ 1b | Free IPs | SPS placement |
|---|---|---|---|---|---|
| **dmz** (public) | default → IGW `igw-09ece8f823b10c030` | `subnet-09a6fab648280ca19` `10.46.134.0/27` (24 free) | `subnet-0485fefe267b06736` `10.46.134.32/27` (21 free) | 45 | **Public ALB** (tightest public tier) |
| **app** (private) /26 | NAT + TGW | `subnet-081ea573064846f3b` `10.46.134.64/26` (**5 free**) | `subnet-0d0a403cd7b733c54` `10.46.134.128/26` (17 free) | 22 | **AVOID — near-full** |
| **app2** (private) /25 | NAT + TGW | `subnet-0c6593fb9c9a165c3` `10.46.160.0/25` (78 free) | `subnet-070cbc242efbddc3c` `10.46.160.128/25` (84 free) | **162** | **SPS app + ETL compute → HERE** (the runway) |
| **db** (private) /27 | NAT + TGW | `subnet-0d35923e345653d0d` `10.46.134.192/27` (23 free) | `subnet-099a9ebefc36ee888` `10.46.134.224/27` (17 free) | 40 | **Aurora + OpenSearch ENIs** |

**Placement guidance:** SPS **compute** (app service + the **internal-only** app ALB + every ETL Fargate task) → **app2** subnets; **data** (Aurora + OpenSearch) → **db** subnets. **No public ALB is placed under the NetScaler decision (§7)** — the app ALB is internal in **app2**; the **dmz** tier is only relevant if a public ALB is ever wanted. **Do NOT place any SPS resource in the near-full app `/26` subnets** (5 + 17 free). The app2 tier (162 free) is sufficient runway for both envs' compute; the db (40) `/27` tier is the tight spot for two envs' Aurora/OpenSearch — workable but confirm before prod.

### 4.5 Per-env security-group model

Env isolation rests **entirely** on SGs. One set per env (suffix `-<env>`): `alb`, `internal-alb`, `app`, `etl`, `vpc-endpoint`, `aurora`, `opensearch`. Concrete SG IDs are ‹**UNKNOWN**›; ownership (SPS-created against the import vs networking-pre-created + imported) is **G8**.

| Target SG | Admits (same env only) | Port |
|---|---|---|
| `alb-<env>` (public) | `0.0.0.0/0` but listener default = `403`; priority-1 rule forwards only on matching `X-Origin-Verify` | `:80` |
| `internal-alb-<env>` | `etl-<env>` | `:80` |
| `app-<env>` | `alb-<env>`, `internal-alb-<env>` | `:3000` |
| `etl-<env>` | none (egress-only) | — |
| `vpc-endpoint-<env>` (if SPS keeps any) | `app-<env>`, `etl-<env>` | `:443` |
| `aurora-<env>` | `app-<env>`, `etl-<env>` | `:3306` |
| `opensearch-<env>` | `app-<env>`, `etl-<env>` | `:443` |

**Cross-env blocking (the only isolation guard):** `prod-*` SGs never appear in any `staging-*` ingress rule and vice-versa. A single mis-scoped/mis-named SG reference silently cross-wires prod and staging datastores with **no network backstop**. SG naming/tagging discipline (env-suffixed, auditable) is load-bearing — a threat-model change versus the "separate VPCs/accounts" framing in `network-security-topology.md` + ADR-008 decision 5 (**G9**).

**Sharing the VPC with ReCiter.** SPS rules reference only SPS SGs, so ReCiter workloads are unaffected; SPS does not depend on ReCiter SG membership except where ETL reads ReciterDB-derived sources (a separate reachability question — G6/G16-Q).

### 4.6 Local datastore access (no peer)

```
write/read path:  app or etl task ENI  ──:3306/:443──►  Aurora / OpenSearch ENI
                  (SG app-<env> / etl-<env>)             (SG aurora-<env> / opensearch-<env>)
```
1. Task ENI and datastore ENI are **in the same VPC**; endpoints resolve to private `10.46.x` IPs via in-VPC AWS DNS ‹confirm whether SPS datastore hostnames need a Route53 PHZ association, or co-location resolves natively — §10›.
2. The datastore SG admits the connection because its ingress rule **references the source SG by id** — no CIDR, no peer, no return route.

Versus #1310, the whole write-back choreography (resolve → cross peer → SG-ref-with-owner-id → return route) collapses to a single intra-VPC SG reference. `DATABASE_URL` / `OPENSEARCH_NODE` / `SCHOLARS_BASE_URL` point at in-VPC endpoints (re-seeded with the new cluster/domain endpoints — the data tier is **re-created**, not lifted; Aurora's subnet group and OpenSearch's VPC are immutable).

### 4.7 Egress

SPS stops owning a NAT + EIP. All internet/AWS-service egress uses **its-reciter's** NAT and/or VPC endpoints. **CONFIRMED 2026-06-30 (read-only describe):** NAT gateways exist in **both** AZs (`nat-056ac39b8ea37dd6c`, `nat-0a01ea7275328eeba`) → outbound internet works; S3 + DynamoDB gateway + Lambda interface endpoints are present, and SM / ECR / Logs / STS ride NAT (no interface endpoints for those, no SM-endpoint conflict).

> **[PARTIALLY RESOLVED — egress posture, G5/Q7]** The **plumbing is confirmed**: NAT in both AZs (outbound internet), plus S3/DynamoDB gateway + Lambda interface endpoints. **Still open (policy, not plumbing — Q7):** whether endpoint/NAT egress policies and security groups admit the SPS task/exec/rotation/seeder roles to specific destinations (Bedrock / SES / New Relic / POPS / RePORTER / NSF / Gates / PubMed). If a destination is restricted, image pulls succeed but that external-source step breaks at runtime.

### 4.8 Topology (target end-state)

```
                              ┌──────────────────────────────────────────────────────────────┐
   Internet ─► CloudFront ───►│  PUBLIC dmz subnets  [G4 ✓ IGW present; dmz /27 ×2 AZ]       │
              (+WCM WAF,      │   sps-public-staging ALB        sps-public-prod ALB            │
               X-Origin-Verify)│  (SG alb-staging)               (SG alb-prod)                 │
                              ├──────────────────────────────────────────────────────────────┤
   WCM on-prem ◄═ TGW ═══════►│              its-reciter-vpc01   (acct 665083158573, us-east-1)│
   (ED/InfoEd/COI/            │   CIDRs 10.46.134.0/24 + 10.46.160.0/24   (subnet ids → §4.4) │
    ReciterDB, LDAPS)         │                                                                │
                              │   PRIVATE subnets  [NAT ✓ ×2 AZ; app2 /25 runway, db /27]    │
                              │  ┌───────────── STAGING (SG set -staging) ──────────────┐      │
                              │  │ internal-alb │ ECS app (app) │ ETL tasks (etl)        │      │
                              │  │      ▲:80         │:3306/:443      │:3306/:443        │      │
                              │  │      └───────►  Aurora(aurora) │ OpenSearch(opensearch)│     │
                              │  │  ingress: aurora/opensearch admit app-staging+etl-staging ONLY│
                              │  └──────────────────────────────────────────────────────┘      │
                              │  ┌───────────── PROD (SG set -prod) ────────────────────┐       │
                              │  │ internal-alb │ ECS app (app) │ ETL tasks (etl)        │       │
                              │  │      └───────►  Aurora(aurora) │ OpenSearch(opensearch)│      │
                              │  │  ingress: aurora/opensearch admit app-prod+etl-prod ONLY      │
                              │  └──────────────────────────────────────────────────────┘       │
                              │  ┌──── existing ReCiter tenants (NOT SPS) ─────┐                 │
                              │  │ reciter-analysis-report-db   10.46.134.208  │                 │
                              │  │ reciter-publication-manager-dev 10.46.134.113│                │
                              │  └──────────────────────────────────────────────┘               │
                              └──────────────────────────────────────────────────────────────┘
   NO PEERING ANYWHERE.  Sps-network-staging (10.20/16) + Sps-network-prod (10.10/16) DECOMMISSIONED.
   Isolation = SG references only:  prod SGs never in a staging ingress rule, and vice-versa.
```

> **Note (edge front, 2026-06-30):** the diagram shows CloudFront as the historical front; per the NetScaler decision (§7) the public front door is now **NetScaler → SPS internal ALB**, and the public/dmz ALB shown is optional (G4 nice-to-have). CloudFront, if retained at all, is an optional caching layer.

### 4.9 What this end-state deletes vs the #1310 peering design

- **Deleted constructs:** `CfnVPCPeeringConnection "EtlCadenceVpcPeering"`, all `EtlCadencePeerRoute*`, `CfnOutput EtlCadenceVpcPeeringId`, the cross-VPC `EtlComputeSgRef`, the cross-VPC `InternalAlbIngressFromEtlCadenceVpc`, and SPS's own `ec2.Vpc`/subnets/NAT/EIP/IGW/route tables (now its-reciter-owned) plus its 3 resolver-rule associations.
- **Deleted config + guards:** `etlVpcPeeringEnabled`, `etlComputeVpc`, `etlComputeSecurityGroupId`, `etlPeerCidrs`, `etlCadenceVpcRelocated`, `vpcCidr` (as a creation driver), `natGateways`, and `assertEtlMigrationInvariants`.
- **Generalized from #1310 (reusable):** the import-by-id pattern (`Vpc.fromVpcAttributes`, `Subnet.fromSubnetId`, `SecurityGroup.fromSecurityGroupId`) and the per-env-SG isolation model — now extended from ETL-only to the whole app+data+ETL estate.

---

## 5. CDK change list per stack

Conventions: **`UNKNOWN-NET`** = a concrete its-reciter identifier/capability networking must supply (never guessed); **`ASSUMPTION`** = a design choice pending approval. "Recreate, not lift" = every VPC-bound resource (Aurora, OpenSearch, ECS cluster/service, both ALBs, VPC endpoints) is **re-created** in the new VPC (the VPC/subnet-group is immutable). Order of edits: **config.ts first**, then app wiring, then stacks.

### 5.1 `config.ts` — env shape

| Field | Before (origin/master) | After (consolidation) |
|---|---|---|
| `vpcCidr` | `10.20/16` / `10.10/16` — drives `ec2.Vpc` | **Removed** as a creation input. Retain only as a doc-comment of the *decommissioned* CIDRs (WCM-firewall teardown + `app_rw` re-scope reference it). |
| `natGateways` | `1` both envs | **Removed** — SPS owns no NAT. |
| *(new)* `sharedVpc` | — | **ASSUMPTION** descriptor for `fromVpcAttributes`: `{ vpcId, availabilityZones, albSubnetIds[], appSubnetIds[], dataSubnetIds[], etlSubnetIds[], (privateSubnetRouteTableIds[] if needed) }`. All values **UNKNOWN-NET**. May be one shared block (env separation via SG). |
| `appRwGranteeHost` | `'10.20.%'` / `'%'` | Staging re-scoped to the its-reciter app/ETL source CIDR (**UNKNOWN-NET**) or `'%'`. Prod unchanged. Drives both the seeder `GRANT` and the live in-DB grant (§7). |
| `etlComputeVpc` / `etlComputeSecurityGroupId` / `etlPeerCidrs` / `etlVpcPeeringEnabled` / `etlCadenceVpcRelocated` | #1310 peering field set (placeholders, flags `false`) | **Deleted** (§9.7). Intent generalized into `sharedVpc` + per-env SG ids. |
| `assertEtlMigrationInvariants(cfg)` | relocated⇒peered invariants | **Replaced** by `ASSUMPTION assertSharedVpcConfig(cfg)`: assert `sharedVpc.vpcId` non-empty, ≥1 subnet id per tier, ≥2 AZs for prod, non-empty per-env SG ids if imported. |
| *(new)* per-env SG ids | — | **ASSUMPTION + UNKNOWN-NET.** Present only if networking pre-creates SGs (option b, §5.3); omitted if SPS creates them in the imported VPC (**G8**). |

**New phased-cutover flag (ASSUMPTION).** Per-env `useSharedVpc` (default `false`) flips NetworkStack create→import and re-targets every downstream subnet/SG selection. Governs CDK *topology* only; the Aurora/OpenSearch move is a snapshot-restore + reseed, not a flag flip (§7). `edExportVpc` (scholars-dev/prod) is **untouched** (out of scope, `edEmailVisibilityBridgeEnabled`); whether TGW co-location lets it retire is a follow-up (§10-Q17).

### 5.2 CDK app wiring — `cdk/bin/sps-infra.ts`

| Element | Before | After |
|---|---|---|
| `-c <envName>Account` → `account` | Per-env account | **Mechanics unchanged**, but ADR-008's "separate accounts" premise is contradicted by the shared-`665083158573` signal — **G0 must resolve this**; if confirmed single-account, correct the comment + framing. |
| `networkStack.vpc` → Data/App/Etl props | NetworkStack *creates* the VPC | NetworkStack exposes `.vpc` as an **import** (§5.3). Prop threading **unchanged** — the key lever: wiring stays identical, only what NetworkStack returns changes. |
| Stack instantiation order | as in §3 | **Unchanged.** No new stacks. |
| `crossRegionReferences:true` (Data + DrVault) | — | **Unchanged** (DR stays us-west-2). |

> **Cross-stack endpoint wiring during the parallel window (see §9):** the §3 export-import contract (`Sps-Data-<env>-OpenSearchDomainEndpoint`, `Sps-App-<env>-InternalAlbDns`, `-InternalAlbSecurityGroupId`, AppStack's legacy `this.exportValue` pins) is consumed via `Fn.importValue`. Because **a CFN export name is account/region-unique**, a parallel producer cannot re-export the same name while the old producer lives. The transitional wiring + export hand-off is specified in §9.3–§9.4 — **do not assume export names "stay stable" through a parallel window.**

### 5.3 NetworkStack — `cdk/lib/network-stack.ts` (most-rewritten)

| Element | Before | After |
|---|---|---|
| `ec2.Vpc "Vpc"` | creates VPC + 2 public + 2 private subnets + IGW + NAT + EIP + route tables | **Replaced** by `Vpc.fromVpcAttributes(...)` (not `fromLookup` — account-agnostic synth). Every id explicit from `config.sharedVpc` (UNKNOWN-NET). Deletes the VPC/subnets/IGW/NAT/EIP/route tables from CFN; **releases the SPS NAT EIPs**. |
| 3 base SGs (`AlbSecurityGroup`/`AppSecurityGroup`/`EtlSecurityGroup`) | created in `this.vpc` | **RESOLVED (G8 GREEN — our call):** **(a)** `new ec2.SecurityGroup({ vpc: importedVpc })` — SPS creates its own per-env SGs against the import (SPS owns ReCiter + the account; keeps the `.appSecurityGroup` props alive, SG hygiene stays in reviewable IaC). Option (b) `fromSecurityGroupId(...)` (networking-pre-created) is **not** taken. |
| 3 `CfnResolverRuleAssociation` | associate the created VPC with the 3 WCM rules | **Likely DELETED (G7).** A rule associates to a VPC **once**; its-reciter almost certainly already has all three. Re-associating fails `RuleAlreadyAssociated`. Confirm before dropping SPS's own. |
| `CfnOutput` VpcId/AppSgId/EtlSgId/AlbSgId | descriptive | **Kept** (useful for `cdk diff`); values reflect imported ids. |
| **#1310 peering block** | gated, inert | **DELETED entirely** (§9.7). Justification: **a single shared VPC has no peer**, so no peering connection and no return routes exist. (Note: `fromVpcAttributes` *can* expose private-subnet route tables when `privateSubnetRouteTableIds` are supplied — so route-table exposure is **not** the reason; the reason is simply "no peer.") |

Net: NetworkStack collapses to "import a VPC + define (or import) three per-env SGs." Constructor signature + exposed props unchanged.

### 5.4 DataStack — `cdk/lib/data-stack.ts` (+ DrBackupVaultStack)

The data tier is the **heavy lift** — a real migration (§7), not a CDK re-point. CDK edits describe the new resources.

| Element | Before | After |
|---|---|---|
| `rds.DatabaseCluster "AuroraCluster"` | `vpc: props.vpc`, `vpcSubnets:{subnetType:PRIVATE_WITH_EGRESS}` | New cluster in its-reciter via a **logical dump/restore (primary at the measured 658 MB) or `rds.DatabaseClusterFromSnapshot`** (co-equal CDK-native alternative — §6.2), `vpc: importedVpc`, `vpcSubnets:{ subnets: <explicit dataSubnetIds> }` (subnetType filtering unreliable on imports; prod needs ≥2 AZs, UNKNOWN-NET). Old cluster RETAIN + deletion-protected → survives as rollback. |
| `AuroraSecurityGroup`/`OpenSearchSecurityGroup` ingress | 3306/443 from app+etl SGs **plus** `EtlComputeSgRef` (gated) | SGs against `importedVpc`; ingress from the co-resident app+etl SGs (intra-VPC). `EtlComputeSgRef` **DELETED** (§9.7). |
| `opensearchservice.Domain "OpenSearch"` | `vpcSubnets` via `selectSubnets(PRIVATE_WITH_EGRESS)` | New domain with **explicit** `dataSubnetIds`; zoneAwareness AZ count must match supplied subnets (UNKNOWN-NET). **Index rebuilt via `search:index`**; FGAC internal users re-created out-of-band. Endpoint changes → export *value* changes (§9.3 governs the *name*). |
| `DbBootstrapSeederFunction` + rotation Lambda | in `vpc` on `etlSecurityGroup`; hard-depend on a privateDNS SM endpoint | Explicit its-reciter subnets on the new etl SG. **Hard dependency** on its-reciter providing a privateDNS SM endpoint + Aurora 3306 reach (UNKNOWN-NET, G5). `DB_HOST`/`DB_PORT` from the new endpoint; `APP_RW_GRANTEE_HOST` from re-scoped config. |
| `APP_RW_GRANTEE_HOST` / live grant | `'app_rw'@'10.20.%'` (staging) | Re-scoped to the new CIDR or `'%'`. **The live in-DB grants must be re-issued** for the new source CIDR or auth fails closed (MySQL 1410) — runbook step (§7.2), not CDK. |
| `BackupPlan AuroraSelection` | `fromRdsDatabaseCluster(oldCluster)` | Re-point to the new cluster. Vaults env-named, not VPC-coupled → **reused unchanged** (§7.6); existing recovery points preserved through teardown. |
| DrBackupVaultStack | us-west-2 vault | **No change** — region/account constant; the new DataStack consumes the **existing** vault (no v2 DR vault), confirm cross-region SSM resolves (§7.6). |

DataStack constructor props unchanged in signature.

### 5.5 AppStack — `cdk/lib/app-stack.ts`

| Element | Before | After |
|---|---|---|
| Consumed props | `vpc`, app/etl/alb SGs | **Unchanged signature** — resolve to the imported VPC + per-env SGs. |
| `PublicAlb` → **internal ALB** (NetScaler front) | `subnetType:PUBLIC` | **Now internal-only (NetScaler decision, §7):** set `internetFacing:false` in the private **app2** subnets; the internet-facing public-ALB / IGW path (G4) is nice-to-have, not required. SPS supplies the internal-ALB DNS as the NetScaler backend (Q11). Subnets become **explicit ids** (`appSubnetIds`). **Name handling: §9.2.** |
| `InternalAlb`, `EcsService`, `SecretsManagerEndpoint` | `PRIVATE_WITH_EGRESS` filter | Explicit `appSubnetIds`. App egress for Bedrock/SES/New Relic/POPS/ReCiter — depends on its-reciter NAT/endpoints (G5). |
| `EcsCluster` | Sps VPC | Co-located in its-reciter. **Critical coupling:** RunTask resolves its VPC from this cluster, so App+Etl must move together (§5.6). |
| `SecretsManagerEndpoint` (privateDNS) + `S3GatewayEndpoint` | created here | **Likely REMOVED** — reuse its-reciter's; a 2nd privateDNS SM endpoint is rejected (G5). Confirm ECR/Logs/DDB endpoints or NAT exist. |
| OIDC provider (`env==='staging'` owner, #491), IAM roles (`sps-task-exec-<env>` …), ECR repos (`scholars-app/etl-<env>`, RETAIN) | account/region-scoped singletons | **NOT VPC-coupled → REUSED by reference, not recreated** (§9.2). This avoids the #491 `EntityAlreadyExistsException` and the IAM/ECR name collisions the parallel model would otherwise hit. |
| `VpcEndpointSecurityGroup`, `AppIngressFrom*Alb`, `PublicAlbIngressFromInternet` | SG-id ingress | Re-point to the new per-env SG ids; intra-VPC refs valid. |
| db-bootstrap `GRANTEE_HOST` + verify-grants golden list | `'10.20.%'` | Re-scoped (matches §5.4 / §7); golden list updated. |
| Exports `Sps-App-<env>-InternalAlbDns` / `-InternalAlbSecurityGroupId` + legacy `exportValue` pins | consumed by EtlStack | **§9.3 governs** — during the window, consumers read via props/SSM, not the locked shared export. |

run-task subnet/SG params for migrate/db-bootstrap/verify-grants are passed by the **deploy workflow**; the pipeline's network params update to the new VPC/SGs (coordinate with `useSharedVpc`).

### 5.6 EtlStack — `cdk/lib/etl-stack.ts`

**Simpler** under consolidation: datastore access becomes local.

| Element | Before | After |
|---|---|---|
| `props.vpc` / `props.etlSecurityGroup` | Sps VPC + SG; `void props.vpc` | Imported VPC + new per-env ETL SG. The two SG concepts merge into one. |
| **5 hardwired task families** (`TaskReconcile`, `TaskCdnReconcile`, `TaskCurationBackup`, `TaskOpportunityProjection`, ED import) | `etlSecurityGroup` + `{subnetType:PRIVATE_WITH_EGRESS}` | **Each re-targeted** to explicit `etlSubnetIds` + the new ETL SG. Consolidation routes **every** ETL task into the one VPC/SG. |
| cadence relocate branch (`etlCadenceVpcRelocated`) | flag-gated cross-VPC | **Branch deleted; pattern generalized** — `fromSubnetId`/`fromSecurityGroupId` becomes the single placement path for all ETL tasks (§9.7). |
| `InternalAlbIngressFromEtl` | same-VPC, kept | Kept; re-points to the new internal-ALB SG (intra-VPC). |
| `InternalAlbIngressFromEtlCadenceVpc` (gated) | cross-VPC :80 | **DELETED** (§9.7). |
| Env: `OPENSEARCH_NODE`, `SCHOLARS_BASE_URL`, `DATABASE_URL` | Sps-VPC endpoints | In-VPC its-reciter endpoints; **DSN secret re-seeded** or write steps silently regress. |
| `CurationBackupBucket` (S3, versioned, RETAIN, CFN-generated name) | dump history | **Data migrated** (sync), not re-created empty (§7.5). |
| InfoEd staging-exclusion (`10.20.91.8` overlaps `10.20/16`) | CIDR-overlap workaround | **Re-evaluate** under `10.46.x` — self-overlap disappears; staging may re-add `etl:infoed` if reachable over TGW (G6). Behavior follow-up, not a CDK edit. |

Constructor props unchanged in signature. **Risk:** if the cluster stays in the Sps VPC while ETL sets its-reciter subnets, RunTask gets a cross-VPC ENI mismatch — cluster placement (§5.5) and ETL placement must flip together.

### 5.7 Other stacks (no CDK *network* change)

- **EdgeStack:** owns no VPC/subnet/SG. When the (now internal) ALB is recreated, its DNS changes → the **NetScaler backend** must be re-pointed (§7); CloudFront is demoted to an optional caching layer (if retained, any `cdk deploy Sps-Edge` must carry all three context flags or it strips alias/cert/WAF — §7.5).
- **SecretsStack:** secret *resources* RETAIN/unchanged; the **DSN/OpenSearch secret VALUES** are re-seeded out-of-band with new endpoints (§7.4).
- **DrBackupVaultStack, AnalyticsStack, ObservabilityStack:** non-VPC by design — no manual network edit.

### 5.8 #1310 (merged peering) — reuse vs delete ledger

| #1310 artifact | Verdict | Why |
|---|---|---|
| network-stack peering block (`CfnVPCPeeringConnection` + per-RT `CfnRoute` + `EtlCadenceVpcPeeringId`) | **DELETE** | No peer in a single shared VPC. |
| data-stack `EtlComputeSgRef` cross-VPC ingress | **DELETE** | Becomes a plain intra-VPC SG reference. |
| etl-stack `InternalAlbIngressFromEtlCadenceVpc` | **DELETE** | Internal ALB admits the ETL SG intra-VPC. |
| `etlVpcPeeringEnabled` / `etlPeerCidrs` / `etlCadenceVpcRelocated` + peering invariants in `assertEtlMigrationInvariants` | **DELETE / REWRITE** | Replaced by `useSharedVpc` + `assertSharedVpcConfig`. |
| `etlComputeVpc` / `etlComputeSecurityGroupId` (import-by-id descriptor) | **REUSE / GENERALIZE** | This *is* the consolidation import model — promote to the shared `sharedVpc` descriptor used by all stacks. |
| import-by-id placement (`Subnet.fromSubnetId` / `SecurityGroup.fromSecurityGroupId`) | **REUSE / GENERALIZE** | Single placement path for all ETL (and App/Data) tasks. |
| Per-env-SG isolation model | **REUSE / EXTEND** | Extended to the whole estate — now the **only** env boundary (G9). |

**Grounded paths (all via `git show origin/master`):** `cdk/lib/{network,data,app,etl,config}-stack.ts`, `cdk/lib/config.ts`, `cdk/bin/sps-infra.ts`. Every its-reciter identifier is **UNKNOWN-NET** and tracked in §10 — none invented here.

---

## 6. Data migration (Aurora + OpenSearch + secrets)

This section moves only the **genuinely stateful** tier and separates what must be physically migrated from what is rebuilt or re-pointed. Every its-reciter identifier is `[UNKNOWN — networking]`; every non-code judgement is `[ASSUMPTION]`.

> **Grounding fact (confirmed):** SPS both envs and `its-reciter-vpc01` are the **same account `665083158573`, same region `us-east-1`** — making both a **logical dump/restore** and an **encrypted same-account/same-region snapshot-restore valid**, and removing cross-region/cross-account credential or KMS-grant work. **The relational SOR is now MEASURED-small (~658 MB — §6.2 / G14),** so either path completes in a sub-hour freeze. The DR copy stays cross-region to us-west-2 and is unaffected. (Pending **G0** confirmation.)

### 6.1 Migration triage

An Aurora cluster's **DB subnet group and an OpenSearch domain's VPC are immutable**. A CDK change that re-points the subnet group/VPC forces **replacement**; with `RETAIN` + `deletionProtection:true` that yields a *new, empty* resource beside the old one. So the data tier is necessarily **create-new-in-its-reciter → migrate/rebuild → cutover → decommission-old**.

| Resource | Classification | Action |
|---|---|---|
| Aurora MySQL `scholars` | **STATEFUL — migrate** | New cluster in its-reciter + data move + cutover (§6.2) |
| OpenSearch indices | **REPRODUCIBLE — rebuild** | New domain + `search:index` full reindex from migrated Aurora (§6.3) |
| OpenSearch FGAC internal users | STATEFUL config, not in the index | Re-create out-of-band on the new domain (§6.3) |
| Aurora master secret `scholars/${env}/db/master` | STATEFUL credential | Name-collision handling (§6.4) |
| DSN/user secret VALUES (`db/*`, `opensearch/*`) | STATEFUL values embedding endpoints | **Re-seed** with new endpoints; resources (RETAIN) unchanged (§6.4) |
| Live MySQL host-scoped GRANTs | STATEFUL, CIDR-coupled | Re-issue for the new `10.46.x` source range (§6.2) |
| `CurationBackupBucket` dump history | **STATEFUL data** | Reuse bucket; else `s3 sync` before teardown (§6.5) |
| AWS Backup recovery points | **STATEFUL data** (RETAIN) | Preserve through prod 35-day window; re-point selection (§6.6) |
| DR vault (us-west-2) | STATEFUL, not VPC-coupled | Reuse unchanged (§6.6) |
| ECR repos, Static/Logs/Analytics buckets | Region-scoped, not VPC-coupled | Survive in-place; reused by reference (§6.5, §9.2) |

### 6.2 Aurora MySQL — the one genuinely stateful tier

The `scholars` Aurora MySQL Serverless v2 cluster is the SPS field-of-record, including **center membership — the single datum whose system-of-record is this app**, existing nowhere else. It must move with **zero data loss**.

> **[MEASURED 2026-06-30 — relational volume is modest, now verified]** OpenSearch is a projection built from Aurora; the relational SOR itself was **measured** (read-only `information_schema` on prod): **total 658 MB** (data 498 MB + index 160 MB), **49 tables**, ~**619k rows** — largest `publication` 390 MB / 133k rows, `publication_author` 90 MB / 249k, `publication_topic` 59 MB / 75k, `grant` 31 MB, `grant_publication` 23 MB, `mesh_descriptor` 20 MB; all else < 10 MB. This **VERIFIES** the "modest volume" premise the reviewers had flagged as unverified: at 658 MB a **logical dump+restore (or snapshot-restore) runs in minutes** → the write-freeze is **comfortably sub-hour (~10–20 min est.)**. **G14 is GREEN.** CDC/DMS is therefore contingency-only, not the primary path.

**New cluster spec:** carry forward engine `VER_3_08_0`, ACU/reader config, encryption (AWS-managed RDS KMS), `deletionProtection:true`, `RETAIN`, 14-day backup, 03:00–04:00 UTC window — only the **network** changes: explicit its-reciter private subnets (prod ≥2 AZs, `[UNKNOWN]` / G3), SG re-created in the imported VPC with ingress from the new per-env app/etl SGs (`[UNKNOWN]` SG ids / G8).

**Chosen mechanism (resolves the prior internal inconsistency — dump/restore-primary at the measured 658 MB):**

> **Aurora = logical dump+restore (recommended primary), or equivalently an encrypted snapshot-restore adopted into CDK via `rds.DatabaseClusterFromSnapshot`.** At the **measured 658 MB (G14)** either runs in minutes and fits a sub-hour freeze, so the migration commits to a **plain dump/restore-primary** path: take a consistent logical dump (`mysqldump`/`mydumper --routines --triggers --events`) and load it into the new cluster, **or** restore an encrypted native snapshot and adopt it via `DatabaseClusterFromSnapshot` (the CDK-native alternative — no out-of-CDK drift). **DMS/binlog CDC is contingency-only** — pre-stage it (G16) **only if** a near-zero-downtime cutover is later required; it is **not** on the primary path. "Final delta"/"snapshot delta" semantics apply **only** to that CDC contingency (a plain dump/restore has no incremental catch-up — it does not need one at this volume).

| Mechanism | Role | Notes |
|---|---|---|
| **Logical `mysqldump`/`mydumper` dump+restore** | **Primary path (recommended at 658 MB).** | Simplest at the measured volume; runs in minutes into a sub-hour freeze. Use `--routines --triggers --events` (or mydumper equivalents) to carry schema objects/triggers/routines/charset/AUTO_INCREMENT. Loads into the new its-reciter cluster. **PII artifact handling per §6.7** (the dump is PII-bearing — KMS-encrypted staging + secure delete). |
| **Snapshot-restore → `DatabaseClusterFromSnapshot`** | **Co-equal primary (CDK-native alternative).** | Native, same-acct/region, preserves data + KMS exactly, carries schema objects/triggers/routines/charset/AUTO_INCREMENT natively, produces no plaintext artifact. Adopted into CDK so DataStack owns it. Restore targets the new its-reciter DB subnet group. Choose this if you prefer the CDK-native, artifact-free path. |
| **DMS full-load+CDC or binlog logical replication** | **Contingency only — NOT needed at 658 MB.** | Pre-staged per **G16** *only if* a near-zero-downtime cutover is later required: source `binlog_format=ROW` (cluster parameter-group change **+ reboot of the old cluster**), DMS replication instance in-VPC, endpoints + IAM, type-mapping validated, a CDC dry-run passed. Cutover = stop writes → drain final CDC lag (seconds) → flip endpoints. The only path giving true near-zero-downtime — unnecessary at this small volume. |
| Aurora cross-region/cross-VPC native (Global DB, clone) | **N/A** | No in-place VPC move; clones stay in the source VPC; Global DB is cross-*region*, we stay us-east-1. |

**The host-scoped GRANT landmine (hard cutover blocker for staging).** The live `app_rw` user is `'app_rw'@'10.20.%'` — scoped to the Sps staging CIDR. Once app/ETL ENIs sit in `10.46.x`, MySQL rejects them (1410) until `app_rw`, `app_ro`, `sps_migrate`, `sps_bootstrap` are **re-granted** for the new source CIDR `[UNKNOWN — which 10.46.x range]` (or `%`), **and** `config.appRwGranteeHost` + the verify-grants golden list are updated so the seeder re-issues the matching GRANT. Prod (`@'%'`) is unaffected by host scope but still needs the new endpoint in its DSN. This is DB-resident + config state, fails *closed*.

### 6.3 OpenSearch — rebuild, do not migrate (with explicit cross-domain read continuity)

**Confirmed reproducible** (`origin/master`): `etl/search-index/index.ts` builds all four indices entirely from Aurora via Prisma, using the alias-swap pattern; `orchestrate.ts` runs the reindex last. No OpenSearch-resident data is non-derivable from Aurora.

**Plan:**
1. Stand up a **fresh OpenSearch domain** in its-reciter (`OPENSEARCH_2_19`; 1 node staging / 2 nodes prod with `zoneAwareness=2` — needs 2 AZs `[UNKNOWN]` / G3), new SG admitting :443 from the new per-env app+etl SGs.
2. **Re-create the FGAC internal users** out-of-band (`sps_master` + app/etl via the `_security` API) — a fresh domain's `_security` DB is empty. The **one** piece `search:index` does not rebuild.
3. **Run `search:index`** against the new domain *after* the migrated Aurora is live and reachable in its-reciter.

> **[CORRECTION — cross-domain read continuity]** The alias-swap bridges versioned indices **within a single domain only** — it does **NOT** bridge old-domain → new-domain. Therefore the app **keeps reading the OLD OpenSearch domain** (fed by the now-frozen old Aurora — acceptable for a read projection) **until the NEW domain's full reindex completes and passes doc-count/alias verification**, and only then is `OPENSEARCH_NODE` flipped to the new domain. The reindex is a long serial step that sits inside the no-edit window unless deferred behind the old domain this way.

4. Re-point the `Sps-Data-${env}-OpenSearchDomainEndpoint` value and the `OPENSEARCH_NODE` consumers (App + ETL); re-seed `opensearch/{app,etl}` with the new endpoint.

**Fallback (not expected):** if rebuild proves non-viable, snapshot the old index to S3 and restore into the new domain — re-importing whatever staleness the old index carried.

### 6.4 Secrets Manager + rotation re-pointing

Secret **resources** are RETAIN/account-region-scoped — they do not move. The **VALUES embedding endpoints** are re-seeded after the new cluster/domain come up.

| Secret | Embeds | Action |
|---|---|---|
| `scholars/${env}/db/master` | generated master creds | **Name-collision gotcha** (below) |
| `scholars/${env}/db/{app-rw,app-ro,etl,bootstrap,migrate}` | DSN → old Aurora host | **Re-seed**; staging host pattern must match the re-scoped GRANT |
| `scholars/${env}/opensearch/{master,app,etl}` | domain endpoint + FGAC creds | **Re-seed** with new domain endpoint |
| `edge/origin-shared-secret`, SAML, session-cookie, New Relic, ETL source creds | no datastore endpoint | **Unchanged** |

**Master-secret name-collision.** `scholars/${env}/db/master` is a singleton name RETAIN'd on the old cluster. A `DatabaseClusterFromSnapshot`-generated secret at the same name collides while old and new coexist. Resolution (secrets owner decides): (a) build the new cluster with a **transitional master-secret name**, cut over, then converge to the canonical name only after the old cluster is deleted; or (b) supply the new cluster's master credential from a pre-created secret. DSN stubs carry no such conflict — re-seeded by the seeder.

**Rotation re-pointing.** The 30-day single-user rotation + Lambda + SG are re-created against the new cluster (`addRotationSingleUser`), placed in its-reciter. Both the rotation Lambda **and** the seeder hard-depend on a **privateDNS SM interface endpoint** (the seeder records a ~49s hang when 443 was dropped). its-reciter providing it (admitting the new etl SG) is `[UNKNOWN]` / G5. After cutover, **force one rotation** and confirm reconnect (§6.8).

**Retention.** The old cluster + old domain (RETAIN, deletion-protected) survive Sps-VPC teardown; deleted only after verification + retention obligations (§6.7 / §9).

### 6.5 S3 buckets, ECR, and what re-points vs is recreated

| Asset | VPC-coupled? | Treatment |
|---|---|---|
| `CurationBackupBucket` (gzipped curated SQL, RETAIN, versioned) | No | **Keep the bucket if EtlStack updates in place.** If replaced, `aws s3 sync` all objects (incl. `latest/`) before decommission; update `CURATION_BACKUP_BUCKET` / output. Do not orphan the dump history. |
| ECR `scholars-app/etl-${env}` (RETAIN) | No | Region-scoped; **reused by reference** (§9.2). Re-push images only if a repo is *replaced* (CD rolls images, never CDK). |
| `StaticAssetsBucket`, `LogsBucket` (config-pinned, RETAIN) | No | Keep unchanged. |
| `AnalyticsBucket` (RETAIN) | No | Keep unchanged; Glue LOCATION derives from the pinned name. |

### 6.6 AWS Backup + DR vault

- **Re-point `AuroraSelection`** in `sps-aurora-daily-${env}` to the new cluster ARN. Plan, primary vault, rule are env-named, **not** VPC-coupled → reused.
- **Preserve recovery points.** `sps-backup-vault-${env}` + DR vault hold real RETAIN data. **Backup vaults cannot be renamed and cannot be deleted while holding recovery points** — so **do not create a v2 vault; reuse the existing one** (§9.2). Honor **prod's 35-day** retention before any teardown; orphaned recovery points age out, not force-deleted.
- **DR copy unchanged.** The new DataStack consumes the **existing** DrBackupVaultStack (no v2 DR vault). Confirm the cross-region `crossRegionReferences` SSM export/import still resolves when DataStack changes, and that the next daily backup produces both a primary recovery point **and** a us-west-2 copy for the new cluster.

### 6.7 Migration-artifact data-safety (PII)

The `scholars` SOR contains **FERPA-carve doctoral-mentee records and other PII**.
- **Artifact-free option:** the snapshot-restore alternative uses an encrypted native snapshot (KMS, same acct/region) — nothing lands on disk unencrypted. Choose it if avoiding any plaintext artifact is preferred.
- **The recommended logical dump/restore path produces a PII-bearing artifact** (now a primary path, §6.2, not just a fallback): stage the dump **only** in a **KMS-encrypted S3 location with a least-privilege bucket policy** (or an in-VPC transfer that never lands unencrypted on disk), restrict read access to the migration role, and **securely delete the artifact after row-count/checksum + schema-object parity verification passes** (§6.8). No PII-bearing dump may persist past verification.

### 6.8 Cutover sequence and downtime window

Ordered so the data tier is rebuilt and verified in its-reciter **before** anything in the old VPCs is torn down (old Aurora/OpenSearch/vaults are RETAIN + deletion-protected — they survive as rollback until step 10).

1. **Networking pre-reqs green** (G1–G11): imported VPC id, subnet ids/AZs, per-env SGs, NAT/endpoints (incl. **privateDNS SM endpoint**), WCM resolver reach.
2. **Stand up the new data tier:** new Aurora (`DatabaseClusterFromSnapshot` from a baseline snapshot), new OpenSearch domain, new data-tier SGs, rotation Lambda. (If CDC: stand up DMS + start full-load+CDC now — **G16**.)
3. **Pre-seed credentials:** re-create OpenSearch FGAC users; seed transitional DSN secrets (master-secret name gotcha, §6.4).
4. **Quiesce ETL:** park Step Functions schedules **and confirm no state machine is in `RUNNING`** (a parked schedule does not stop an in-flight multi-step execution) — abort/drain any in flight before the freeze.
5. **Open the maintenance window** — app read-only/maintenance.
6. **Final Aurora data move (freeze-only — the primary path):** take the final logical dump and restore (or the final snapshot and restore) into the new cluster. At the measured 658 MB this is minutes. (CDC contingency only: drain final CDC lag instead.) The no-edit window spans the final dump/restore + reseed + reindex + cut — **comfortably sub-hour** at this volume.
7. **Re-issue GRANTs** for the `10.46.x` range; update `appRwGranteeHost` + golden list; **re-seed** all DSN + OpenSearch secrets with new endpoints.
8. **OpenSearch reindex:** run `search:index` against the new domain from the migrated Aurora; confirm the alias points at the fresh versioned index. **App still reads the OLD domain until this passes verification** (§6.3); only then flip `OPENSEARCH_NODE`.
9. **Cut traffic over:** point App/ETL at the new endpoints; smoke-test (§6.9); re-point AWS Backup selection.
10. **Close the window;** resume ETL on the new tier; monitor one full nightly cycle.
11. **Decommission (last):** only after verification + retention — disable deletion protection, take final retained snapshots of the old Aurora, delete old Aurora/OpenSearch, then the old Sps-network VPCs (§9).

**Downtime window:** **now measured-small — comfortably sub-hour (~10–20 min est.).** At the measured 658 MB (G14) the freeze-only path = final dump/restore (or snapshot+restore) + reseed + reindex + cut fits well inside an hour; **CDC is not required.** The committed prod window is booked from this measured size (the CDC variant — final CDC-lag drain + reseed + cut, reindex deferred behind the old domain per §6.3 — is held only as a contingency).

### 6.9 Verification checklist (before decommissioning anything)

- [ ] **Row-count / checksum parity** between old and new Aurora for every `scholars` table (esp. center-membership — the app-only SOR). Per-table counts + a content checksum on a sample; do not eyeball.
- [ ] **Schema-object parity:** compare `SHOW CREATE` for tables/views/triggers/stored routines/events, charset/collation, foreign-key constraints, and **AUTO_INCREMENT** positions. (Snapshot-restore carries these natively; a logical dump must use `--routines --triggers --events`.) A missing trigger or wrong AUTO_INCREMENT is silent until a later write.
- [ ] New cluster reachable from app + ETL ENIs on :3306; `app_rw`/`app_ro`/`sps_migrate`/`sps_bootstrap` **authenticate** from a `10.46.x` source IP (verify-grants golden list passes).
- [ ] All DSN secret VALUES resolve to the **new** endpoints (no stale `10.20`/`10.10` host in any `db/*` or `opensearch/*` secret).
- [ ] **Force one secret rotation** on the new cluster; confirm success + app reconnect (proves SM endpoint + Aurora reach in its-reciter).
- [ ] OpenSearch: new domain green; FGAC users present; `search:index` completed; alias on the fresh index; people/pubs/funding/opportunities doc counts match a fresh build (≈178k+ pubs); a representative `/search` returns expected top results — **then** `OPENSEARCH_NODE` flipped.
- [ ] AppStack `OPENSEARCH_NODE` + EtlStack consumers resolve the **new** endpoint; internal `/api/revalidate` works end-to-end.
- [ ] **AWS Backup:** selection re-pointed; next daily run produces a primary recovery point **and** a us-west-2 DR copy.
- [ ] Old `sps-backup-vault-${env}` + DR recovery points **still present** and within retention (nothing force-deleted).
- [ ] `CurationBackupBucket` objects present in the bucket the new EtlStack consumes; `latest/` intact.
- [ ] One full **nightly Step Functions cycle** completes on the new tier (ETL → Aurora → reindex → revalidate) with no regression.
- [ ] PII migration artifact (if any) **securely deleted** post-verification (§6.7).
- [ ] Rollback proven available: old Aurora/OpenSearch still RETAIN + deletion-protected until all of the above pass.

---

## 7. Edge / DNS / cert / WAF cutover

> **DECISION 2026-06-30 — the public front door is NetScaler.** WCM's NetScaler ADC fronts the public entry `scholars[-staging].weill.cornell.edu`, with the SPS **internal ALB** as the NetScaler backend. This settles the parked #502 / RITM0792011 NetScaler-vs-CloudFront question (§7.7). The earlier **CloudFront → public-ALB origin-swap is no longer the plan**; CloudFront could remain an optional CDN/caching layer in front of or behind NetScaler (**TBD, not required — not built out here**). Because NetScaler fronts, the SPS app ALB is **INTERNAL-only** — the internet-facing public-ALB / public-subnet+IGW capability (G4) is now nice-to-have, not on the critical path. The remaining edge work is narrow (§7.2): the **NetScaler → internal-ALB reachability path** (SPS provides the internal-ALB DNS as backend — residual Q11) and whether CloudFront stays as a caching layer.

The public entry is therefore `scholars[-staging].weill.cornell.edu` → **NetScaler VIP** → SPS **internal ALB** → ECS. The edge change is a backend re-point at NetScaler (SPS supplies the new internal-ALB DNS), not a VPC relocation.

### 7.1 What changes vs. what is preserved

| Edge component | Today | After (NetScaler front) | Action |
|---|---|---|---|
| Public front door | CloudFront distribution (staging `E17NRWINXLP3B3`, prod `E28NKDFXC7K2ZL`) | **NetScaler VIP** (WCM ADC) | Public viewer DNS (CNAME → NetScaler VIP) + TLS termination move to the WCM edge track. |
| Backend / origin | `LoadBalancerV2Origin(appStack.publicAlb)`, HTTP :80 | **SPS internal ALB DNS** as the NetScaler backend | SPS provides the new internal-ALB DNS; NetScaler reaches it over TGW/WCM network (residual Q11). |
| SPS app ALB | public, internet-facing | **internal-only** | No internet-facing public ALB / IGW dependency (G4 nice-to-have, not required). |
| Origin-verify header | `scholars/<env>/edge/origin-shared-secret`; matched by ALB listener priority-1 (default 403) | same value, asserted on the **NetScaler → internal-ALB** hop | Reuse (don't rotate) — §7.4. NetScaler injects the shared-secret header. |
| ACM / TLS cert | imported via `-c edgeCertArn` (CloudFront viewer-side) | terminates at **NetScaler** (WCM ADC) | Cert wiring is a WCM edge-track item (Q10). |
| WAF / source allowlist (#461) | CLOUDFRONT-scope WCM allowlist | enforced at **NetScaler** (WCM allowlist) | WCM edge-track. |
| CloudFront | the public front | **optional caching layer only — TBD, not required** (not built out) | If kept, it sits in front of/behind NetScaler and the distribution-constancy rules (§7.5) reapply; otherwise retired from the path. |
| Static-asset origin / Logs bucket / IPv6 | S3 (OAC) + ALB fallback; RETAIN logs; `enableIpv6:false` | **unchanged** | If CloudFront is dropped, static-asset serving moves behind NetScaler/internal ALB — TBD with the caching-layer decision. |

### 7.2 The chosen edge model: NetScaler → internal ALB

With the 2026-06-30 NetScaler decision the edge model is settled and the old Path A/Path B (public-ALB-vs-CloudFront-VPC-origin) question is moot: **the SPS app ALB is internal-only and NetScaler is the public front.** Public ingress on its-reciter (IGW `igw-09ece8f823b10c030` + the 2-AZ public **dmz** tier) is **confirmed present but unused** (G4 nice-to-have, not on the critical path).

| | Chosen — NetScaler front + SPS internal ALB |
|---|---|
| SPS app ALB | `internetFacing:false`, in the private **app2** subnets |
| Public front | NetScaler VIP (WCM ADC); viewer DNS CNAME → NetScaler |
| NetScaler → ALB | NetScaler reaches the internal ALB over TGW/WCM network; SPS supplies the internal-ALB DNS as backend (residual **Q11**) |
| Exposure | internal ALB has no public DNS → exposure largely removed; keep `X-Origin-Verify` as defense-in-depth on the NetScaler→ALB hop |
| CloudFront | **optional caching layer only — TBD, not required** |
| Public-ALB/IGW need | none (G4 nice-to-have) |

**Remaining edge open-items (narrow, not a redesign):** (a) the **NetScaler → internal-ALB reachability path** — how NetScaler reaches the ALB in its-reciter over TGW/WCM, with SPS providing the internal-ALB DNS as the backend (residual **Q11**); (b) whether **CloudFront stays as a caching layer** (TBD). Cert/TLS and the public CNAME move to the WCM edge track.

### 7.3 The backend re-point (the cutover step)

The cutover is a **NetScaler backend re-point**: point the NetScaler VIP at the new SPS **internal** ALB DNS (the old front pointed at the old-VPC ALB).
1. Stand up the new **internal** ALB + listener + `X-Origin-Verify` rule (AppStack in its-reciter); bring ECS to steady state, `/api/health` green (§7.6) — **before** the backend re-point.
2. SPS provides the new internal-ALB DNS to the WCM edge track; NetScaler updates its backend (over TGW/WCM — Q11).
3. Verify end-to-end through the NetScaler VIP.
4. Only then decommission the old `Sps-Network-<env>` VPC (whose ALB is the rollback target).

*(If CloudFront is later kept as an optional caching layer, the §7.5 distribution-constancy rules reapply to that layer — but it is not on the critical path here.)*

### 7.4 `X-Origin-Verify` continuity

Re-establish the rule on the **new internal** ALB listener with the **same secret value**, asserted on the **NetScaler → internal-ALB** hop (NetScaler injects the shared-secret header). A missing rule or differing value 403s every viewer. Reuse the value (do not rotate) to avoid a 403 window. This rule lives in AppStack and moves with it.

### 7.5 Frozen-Edge redeploy hazard (only if CloudFront is retained)

With NetScaler chosen, #502 is resolved and the CloudFront distribution is **no longer on the critical path**. This hazard applies **only if** CloudFront is later kept as an optional caching layer: in that case **any** `cdk deploy Sps-Edge-<env>` MUST pass all three flags or it silently strips the live alias, cert, and WAF:
```
-c edgeCustomDomain=scholars[-staging].weill.cornell.edu \
-c edgeCertArn=<ACM cert ARN, us-east-1>   # UNKNOWN — §10 \
-c edgeAllowedCidrs=<WCM viewer CIDRs>      # UNKNOWN exact set — §10
```
Always `--strict` cdk diff first; confirm no removal of `domainNames` / `certificate` / `webAclId`. If CloudFront is dropped from the path entirely, this section does not apply.

### 7.6 Health-check + warmup

- The internal ALB target groups health-check `/api/health` (IP targets, :3000). NetScaler health-checks its backend (the internal ALB) directly; a backend 5xx during cutover is served live, not cached (unless an optional CloudFront caching layer is added — then its `5xx→0s` no-cache behavior applies).
- SPS has a cold-start latch (#695 + #1297): a freshly-placed Fargate task returns 503 until primed. **Bring the new ECS service to steady-state with health checks passing AND the warmup primer complete before the NetScaler backend re-point.** Verify the target group is healthy and a direct internal-ALB probe (with `X-Origin-Verify`) returns 200, then re-point NetScaler.

### 7.7 NetScaler-vs-CloudFront (#502) — RESOLVED

RITM0792011 / REQ0292790 (Andrew Budries) — whether NetScaler replaces or fronts CloudFront — is **RESOLVED 2026-06-30: NetScaler is the chosen public front.** Consequences:
- The public CNAME points at the **NetScaler VIP** (a WCM-ITS DNS change, with TTL lowering, owned by the edge/launch track). TLS terminates at NetScaler.
- The SPS app ALB is **internal-only**; SPS provides its DNS as the NetScaler backend (Q11). The old public-ALB/CloudFront-origin model is retired.
- **CloudFront could remain an optional caching layer** in front of or behind NetScaler (TBD, not required — not built out here).

The irreversible step (decommissioning the old ALB/VPC) is gated on the NetScaler backend cutover being verified, not on #502 (now resolved).

### 7.8 DNS / cutover / rollback

- **Public DNS:** NetScaler is the front, so the public CNAME points at the **NetScaler VIP** — a WCM-ITS DNS change with TTL lowering, owned by the edge/launch track.
- **Rollback:** a **single NetScaler backend revert** to the old-VPC ALB DNS — requires the old ALB + ECS + Aurora/OpenSearch still alive (so the old stack is decommissioned only after the edge cutover is verified).
- **In-place, not recreate:** the cutover is a backend re-point at NetScaler; no SPS distribution is recreated. (If an optional CloudFront caching layer is later added, its config changes are in-place on that layer.)

### 7.9 Dependencies inherited from other tracks

- **AppStack:** the new **internal** ALB + `X-Origin-Verify` rule are AppStack-owned; the NetScaler backend can't cut over until the ALB exists and is healthy. New internal-ALB DNS known only after AppStack deploys (SPS provides it to the edge track — Q11).
- **Data tier:** a healthy `/api/health` depends on the DataStack move being complete + DSN/endpoint secrets re-seeded.
- **Networking:** the NetScaler → internal-ALB reachability path over TGW/WCM (Q11). (G4 public-ingress is no longer required.)
- **Edge/launch track (WCM-ITS):** the NetScaler VIP + backend wiring, TLS cert termination at NetScaler (Q10), the WCM source allowlist at NetScaler, and the public CNAME → NetScaler VIP DNS change.

---

## 8. Rollout phasing, rollback, decommission, #1310 disposition

This section sequences the consolidation per environment, **staging fully soaked before prod**. All §2 gates the affected steps depend on must be GREEN before that phase — the SG-reference isolation model fails *silently* if they are not.

### 8.1 The cutover-mechanics blocker — and its resolution (G15)

> **The naïve "stand up a parallel `-v2` estate" model is UNBUILDABLE and is rejected.** A `-v2` suffix renames only CDK stack/construct **ids**; it does not rename the **physical** resources, and a second same-env estate collides on every env-keyed account/region-unique name. Verified against `origin/master`:
>
> - **CFN export names** — `Sps-Data-${env}-OpenSearchDomainEndpoint`, `Sps-App-${env}-InternalAlbDns`, `Sps-App-${env}-InternalAlbSecurityGroupId` (+ AppStack legacy `exportValue` pins) are account/region-unique; a parallel producer **cannot re-export the same name** while the old producer lives (`export already exported by stack …`). This directly contradicts a naïve "keep export names stable while running parallel."
> - **Account/region-scoped singletons** — the GitHub **OIDC provider** (`env==='staging'` owner — the code documents this exact `EntityAlreadyExistsException`, #491), **IAM role names** (`sps-task-exec-${env}`, `sps-task-${env}`, `sps-deploy-${env}`, …), **ECR repos** (`scholars-app/etl-${env}`), **ECS cluster** (`sps-cluster-${env}`), **service** (`sps-app-${env}`), **ALBs** (`sps-public/internal-${env}`), RETAIN **log groups** (`/aws/ecs/sps-*-${env}`, `/aws/lambda/sps-db-bootstrap-seed-${env}`), the **master secret** (`scholars/${env}/db/master`), and **backup-vault names** (`sps-backup-vault-${env}`, `sps-dr-backup-vault-${env}`).
> - **Backup vaults are worst:** AWS Backup **refuses to delete a vault holding recovery points** and **cannot rename** a vault — so a `-v2` vault becomes permanent.
> - **A distinct `envName` ("staging-v2")** cascades into broken `scholars/staging/db/*` secret lookups, `-c staging-v2Account` context, per-env-pinned dist ids, SAML ACS/entity URLs, and `appRwGranteeHost`.
> - **CFN stack names are immutable** — "drop the `-v2` suffix in a later cosmetic rename" is a destroy/recreate, which for the data stack means re-migration. There is **no cosmetic rename.**

**Resolution (the model this plan adopts), gated by G15:**

1. **Account/region-scoped, NOT VPC-coupled → REUSE by reference, never recreate:** OIDC provider, all IAM roles, ECR repos, **the existing primary + DR backup vaults**, Static/Logs/Analytics S3 buckets, and the **existing CloudFront distributions** (only if CloudFront is retained as an optional caching layer per §7 — otherwise out of the path). The estate keeps **one** identity per env — these are referenced, not duplicated.
2. **VPC-coupled, must be re-created → use distinct/auto-generated physical names so create-before-delete works, and let the old (RETAIN) copy survive as rollback:** Aurora (`DatabaseClusterFromSnapshot`, **transitional master-secret name** §6.4), OpenSearch domain, ALBs, ECS cluster/service, ETL task ENIs, per-env SGs. Where a fixed `loadBalancerName`/`clusterName`/`serviceName`/`domainName` would block CFN create-before-delete, **switch it to a CDK auto-generated name** (a one-time tradeoff — the names are not externally referenced; CloudFront reads the ALB **DNS**, not the `loadBalancerName`).
3. **Cross-stack endpoint wiring during the transition (§8.3):** consumers (Etl/App) read the new Aurora/OpenSearch/internal-ALB endpoints via **constructor props or SSM parameters**, NOT `Fn::ImportValue` of the locked shared name. The shared export name is re-established on the new producer only **after** the old producer is gone (§8.4).
4. **Decommission honors the CFN export-lock (§8.4):** an export referenced by any `Fn::ImportValue` cannot be modified/deleted, and its producing stack cannot be deleted, until every importer stops referencing it.

> [ASSUMPTION] Both envs share account `665083158573` (G0). If ADR-008's "two accounts" is literally true, confirm before Phase A — it changes `-c <env>Account`, the isolation threat model, and adds a cross-account merge.

### 8.2 Cutover style per tier

| Tier | Re-created? | Cutover style | Why |
|---|---|---|---|
| Network substrate | import its-reciter | parallel — old VPC stays up | additive until edge flip |
| Aurora MySQL | yes — new cluster | **freeze-only OR CDC-drained cutover** (§6.2, set by G14) | single SOR; writes cannot diverge |
| OpenSearch domain | yes — new domain | **app reads OLD domain until NEW reindex verified, then flip `OPENSEARCH_NODE`** (§6.3) | index rebuildable; no write-divergence |
| ECS app + ALBs | yes — auto-named (§8.1) | hard cutover at the edge (NetScaler backend re-point to the new internal ALB) | new ALB validated by direct probe before viewer traffic |
| ETL | yes — new placement | hard cutover; **schedules parked AND no RUNNING execution** before the freeze (§6.8 step 4) | never two cadences writing the same SOR |
| Edge (NetScaler front) | **NO SPS resource recreated** | NetScaler **backend** re-point to the new internal ALB | front door is NetScaler; SPS supplies internal-ALB DNS (Q11). CloudFront optional caching layer TBD |

### 8.3 Transitional cross-stack endpoint wiring

During the window, **do not** rely on `Fn::ImportValue` of the shared export names (they are locked by the live old producer). Instead, the new App/Etl stacks receive the new Aurora endpoint, OpenSearch endpoint, and internal-ALB DNS/SG via **constructor props (preferred) or SSM parameters**. Re-seeded DSN/OpenSearch secrets already carry the new endpoints for the running tasks; the props/SSM path covers synth-time references. This removes the `Fn::ImportValue` dependency on the old exports and lets convergence happen cleanly at teardown.

### 8.4 Export hand-off + decommission ordering (CFN export-lock)

Because an in-use export cannot be deleted and its producer cannot be torn down:
1. **Re-point importers** (Etl/App) off `Fn::ImportValue(<shared name>)` to props/SSM (§8.3) — removing the references to the old exports.
2. **Confirm zero importers:** `aws cloudformation list-imports --export-name <name>` returns empty for each old export.
3. **Only then** delete/replace the old producer stack.
4. **Re-establish the canonical export name** on the new producer after the old is gone (or **keep the transitional names permanently** — decide in G15; if kept, update the §5.2/§5.5 wiring to reference the permanent names rather than asserting "names stay stable").

### 8.5 Phase sequence (per env; staging fully soaked before prod)

| Phase | Action | Old VPC state | Reversible? |
|---|---|---|---|
| **A. Stand-up** | Import its-reciter (`fromVpcAttributes`); create per-env SGs in the import; **reuse** OIDC/IAM/ECR/vaults/dist (§8.1); create the new auto-named ALBs/ECS/endpoints (reuse its-reciter's SM/S3 — no 2nd privateDNS SM); **drop** the 3 resolver associations (G7). Push bootstrap images to the existing ECR repos. | live, serving | yes — delete new stacks |
| **B. Data migration** | Snapshot-restore Aurora into a new cluster (`DatabaseClusterFromSnapshot`); (CDC variant: start full-load+CDC); create the fresh OpenSearch domain; re-create FGAC users; re-seed `db/*` + `opensearch/*` secret VALUES (transitional master-secret name); **re-grant** host-scoped users `'10.20.%'`→`10.46.x`/`'%'`, update `appRwGranteeHost` + golden list; run `search:index` on the new domain (§6). | live, serving | yes — abandon new, keep old |
| **C. App validation** | Bring up the new ECS service; validate **directly against the new ALB DNS** with `X-Origin-Verify`; confirm app→Aurora :3306 + app→OpenSearch :443 intra-VPC SG refs; confirm edit-flow writes land in the new cluster. | live, serving | yes |
| **D. Edge cutover** | **Write-freeze + ETL quiesced (no RUNNING execution)** → final Aurora dump/restore → flip `OPENSEARCH_NODE` after new-domain verify → re-point the **NetScaler backend** to the new **internal** ALB DNS (SPS supplies it; WCM edge track) → re-establish `X-Origin-Verify` on the new ALB (same value) → lift freeze. | live (standby) | **yes — re-point NetScaler backend back** (minutes) |
| **E. ETL cutover** | Re-point importers off old exports (§8.4); enable ETL schedules on the new stacks pointed at the new endpoints; park old schedules. | live (standby) | yes — re-park new, re-enable old (see §8.7) |
| **F. Soak** | ≥ one full nightly **+** weekly cycle: Step Functions failures, datastore connect errors, search freshness, edit writes, ALB 5xx/latency, EIP/ENI capacity. **Verify cross-env SG isolation** (a staging SG must not reach prod datastores). | live (standby) | yes |
| **G. Decommission** | Drain → verify-no-refs (incl. `list-imports` empty per §8.4) → delete old stacks → old VPC last (§8.6). | **deleted** | no (§8.7) |

Per-env ordering: complete **A→F for staging**, soak clean, then **A→F for prod**. Cross-env isolation can only be *fully* tested once the prod data tier exists — add an explicit **"staging-SG → prod-datastore is refused" probe at prod Phase A**, since SGs are the **only** boundary.

### 8.6 Decommission order (drain → verify → delete)

Delete strictly **last**, reverse-dependency, only after Phase F soak passes **and** prod's 35-day retention is honored, **and** §8.4 `list-imports` is empty:
1. **Old ECS / ALBs** — drained; log groups RETAIN (let retention expire).
2. **Old ETL** — migrate `CurationBackupBucket` objects to the new bucket first (the dump history *is* data); then delete.
3. **Old data tier** — final manual snapshot of the old Aurora; disable `deletionProtection` on the **old** cluster; **preserve** recovery points in `sps-backup-vault-<env>` through prod's 35-day window; then delete old Aurora + old OpenSearch.
4. **Old network** **last** — drops the NAT + **releases the EIPs** (relieves the prod EIP cap), the endpoints, the subnets, and the 3 resolver associations. Confirm its-reciter already carries the WCM resolver reach **before** this delete, or app/ETL DNS to WCM breaks. (Note: a VPC delete fails while any orphaned RDS still lives in it — step 3 must truly delete the old cluster first, which is why the old data tier must be a *new* resource in its-reciter, not an in-place flip of the old VPC.)

### 8.7 Rollback per phase

| Phase | Rollback | Notes |
|---|---|---|
| A–C | Delete new stacks; old estate untouched. | Zero user impact. |
| **D (edge)** | **Re-point the NetScaler backend back to the old ALB DNS.** | Minutes; in-place at NetScaler (no SPS distribution recreate). |
| **E (ETL)** | Re-park new schedules; ETL is idempotent (upserts / per-partition delete-then-insert / full reindex). | Safe **only while the app still writes the old cluster.** |
| **D+E coupled** | After the app is cut to the **new** Aurora, the new cluster is the SOR; rolling back strands post-cutover edits. | **Mitigation = the Phase-D write-freeze** — no edits during cutover, so a rollback inside the freeze loses nothing. Keep the window short and the approver on-call. This is the practical point-of-no-easy-return. |
| **G (decommission)** | **None once the old data tier is deleted.** | Delete old **last**; keep the final old-cluster snapshot + RETAIN vaults through prod's 35-day window as the only recovery path. |

### 8.8 #1310 disposition — refactor the pattern, revert the peering

PR #1310 (merged, **flag-off**) splits cleanly:

| #1310 artifact | Disposition |
|---|---|
| `etlComputeVpc{vpcId,AZs,appSubnetIds}` + import-by-id pattern | **REUSE & GENERALIZE** — this *is* the consolidation import model (deterministic, credential-free synth). Promote to all of Network/Data/App/Etl as `sharedVpc`. |
| `etlComputeSecurityGroupId` + per-env-SG isolation | **REUSE** — extend to the full per-env SG set. |
| `etlVpcPeeringEnabled` flag | **DELETE** |
| network-stack peering block (`CfnVPCPeeringConnection` + per-RT `CfnRoute`) | **DELETE** — no peer in a single shared VPC. |
| `etlPeerCidrs` + data-stack `EtlComputeSgRef` + `InternalAlbIngressFromEtlCadenceVpc` | **DELETE / collapse to intra-VPC SG references.** |
| `assertEtlMigrationInvariants` | **REWRITE** — drop peering invariants; keep "imported VPC + SG id must be set." |

**Recommendation: a forward "supersede" PR, not `git revert` of #1310** (a literal revert would delete the reusable import scaffolding). Land one PR that (a) deletes the peering constructs/flags/fields and (b) generalizes the surviving import-by-id placement to the whole estate. Update #1310's description to point at this plan. Regenerate the CDK snapshots — run `npm ci && npm test -- -u` **from `cdk/`** (the root lockfile skips cdk deps), commit only the `.snap` deltas after eyeballing each hunk; verify AppStack export-name changes are intentional per §8.4.

### 8.9 Prod reviewer-gate + edge scheduling

- **Prod is reviewer-gated** (paulalbert1 approval; push-to-master = staging only). Every prod cutover step — new `Sps-Data-prod`/`Sps-App-prod`/`Sps-Etl-prod` resources and the **NetScaler backend re-point to the new prod internal ALB** — pauses for approval. Schedule the prod window with the approver **on-call** (the Phase-D rollback boundary depends on a human approving a fast revert).
- **Edge cutover is a NetScaler backend re-point** — verify the new internal ALB is healthy (direct probe with `X-Origin-Verify` → 200) before re-pointing; reuse the same `X-Origin-Verify` value. (If an optional CloudFront caching layer is retained, its `Sps-Edge` deploys still need all 3 flags + `--strict` diff — §7.5.)

> **Edge prerequisite [Q11]:** SPS supplies the new **internal** ALB DNS as the NetScaler backend, and the **NetScaler → internal-ALB reachability path** over TGW/WCM must be confirmed. G4 public-ingress is no longer required (the ALB is internal).

---

## 9. Open questions for networking / Fabrice (identifiers this plan will NOT invent)

Each row is a value/decision recorded as unknown rather than guessed. "Gate" shows which gate it maps to. **Most rows are now RESOLVED** — by 2026-06-30 read-only describe, by the prod data-volume **measurement** (Q18), or by operator **decision** (we own ReCiter + the account → SG ownership/ENI-attach are our call, Q4/Q15/Q16; NetScaler is the chosen front, Q13). The **one remaining genuinely-external** item is the **WCM firewall source-allow (Q12)** — TGW routing is already confirmed present. A few narrow edge follow-ups (NetScaler→internal-ALB reachability Q11, cert ARNs Q10) and operational steps remain, but no cross-team architecture decision is outstanding.

| # | Question | Why unresolved | Failure mode if guessed | Gate |
|---|---|---|---|---|
| Q1 | **[RESOLVED 2026-06-30]** **`its-reciter-vpc01` vpcId?** | **`vpc-08a1873fc8eebae28`** (CIDRs `10.46.134.0/24` + `10.46.160.0/24` + unused secondary `3.89.200.0/24`; TGW `tgw-07716c8311a165e54`) — read-only describe. | Import fails / wrong VPC. | G1 |
| Q2 | **[RESOLVED 2026-06-30]** **Subnet ids + AZs + which /24** per tier? | **8 subnets across us-east-1a + 1b in 4 tiers (dmz public / app /26 near-full / app2 /25 runway / db /27)** — full ids + free-IP counts in §4.4. | wrong AZ/tier, prod loses AZ spread. | G1, G3, G4 |
| Q3 | **[RESOLVED 2026-06-30, with caveat]** **Free IP capacity** after ReCiter RDS (.208) + pub-mgr-dev (.113)? | **app2 = 162 free (place SPS compute here); db = 40; dmz = 45; app /26 = near-full (5 + 17) → AVOID.** No dedicated SPS subnet needed if compute lands in app2 (confirm the tight db/dmz `/27`s for 2 envs). **The ReCiter EKS cluster is in a SEPARATE VPC (`192.168.0.0/16`) → NO EKS VPC-CNI contention in this VPC** (the EKS-footprint premise was false). | ENI exhaustion → partial deploy. | G2 |
| Q4 | **[RESOLVED 2026-06-30 — our call]** Per-env SG ownership. | **SPS creates its own per-env SGs against the imported VPC** (alb/internal-alb/app/etl/vpc-endpoint/aurora/opensearch, suffixed per env) — SPS owns ReCiter + the account, so this is internal IaC, not networking-pre-created. Env-suffixed/auditable naming enforced by SPS (Q16/G9). | invalid SG-to-SG ingress, or un-auditable cross-wiring. | G8, G9 |
| Q5 | **[RESOLVED 2026-06-30]** **Are the 3 WCM resolver rules already associated** to its-reciter? | **YES — all 3 (`med_cornell_edu`, `weill_cornell_edu`, `wcmc_ad_net`) associated, status COMPLETE.** SPS drops its own 3; no DNS gap at decommission. | re-associate → CFN error; drop-without-present → DNS dies post-teardown. | G7 |
| Q6 | **[RESOLVED 2026-06-30]** **Endpoint inventory + policies?** | **S3 + DynamoDB gateway + Lambda interface (private-DNS) present; NO SM/ECR/Logs/STS interface endpoints → ride NAT.** No private-DNS SM endpoint exists → the duplicate-SM-endpoint conflict is **MOOT**. (Role-policy admission to specific destinations is the Q7 half.) | duplicate SM endpoint rejected; pulls/logs/secret/DDB break. | G5 |
| Q7 | **[PARTIALLY RESOLVED 2026-06-30]** **NAT / outbound posture?** | **NAT in both AZs confirmed (`nat-056ac39b8ea37dd6c`, `nat-0a01ea7275328eeba`) → outbound internet works; S3/DDB gateway + Lambda interface present.** STILL OPEN (policy, not plumbing): whether endpoint/NAT policies + SGs admit SPS roles to Bedrock/SES/New Relic/POPS/RePORTER/NSF/Gates/PubMed. | app + public-API ETL outbound fail. | G5, G6 |
| Q8 | **[RESOLVED 2026-06-30]** **Public subnets + IGW** for an internet-facing ALB? | **YES — 2-AZ public dmz tier routed to IGW `igw-09ece8f823b10c030`** → public ingress is available. **But with NetScaler chosen as the front (Q13), the SPS app ALB is internal-only**, so this capability is nice-to-have, not on the critical path (G4 no longer plan-validity). | n/a — internal-ALB-behind-NetScaler stands regardless. | G4 |
| Q9 | **Route-table ids** SPS may need; **who owns route-table/SG IaC + drift detection** in the shared VPC? | boundary undecided. | silent drift; unclear blast-radius ownership. | G8 |
| Q10 | **TLS cert + source allowlist** — now terminate at **NetScaler** (WCM edge track); ACM cert ARNs only relevant if CloudFront is retained as an optional caching layer. | not in this plan; owned by WCM-ITS. | cert/allowlist mis-wired at the edge. | G11 |
| Q11 | **[NARROWED — residual edge item]** **NetScaler → internal-ALB reachability path:** how NetScaler reaches the new SPS **internal** ALB in its-reciter (over TGW/WCM); SPS provides the internal-ALB DNS as the NetScaler backend. | known only after AppStack deploys the internal ALB; NetScaler-side wiring is WCM edge track. | NetScaler backend points at nothing. | G11 |
| Q12 | **WCM firewall + TGW route tables** open for `10.46.134/160 → every SPS source` (ED LDAPS :636, InfoEd `10.20.91.8`, ReciterDB, SES, POPS)? Does leaving `10.20/16` resolve the InfoEd self-overlap so staging can re-add `etl:infoed`? | **TGW routing half CONFIRMED 2026-06-30** (private RTs carry `10/8` + WCM ranges `207.162.240.0/20` / `140.251.0.0/16` / `157.139.0.0/16` → TGW). **STILL OPEN: the WCM-side firewall admitting `10.46.134/160 → each source` (policy, no describe can prove it).** | ETL fails; #443 regresses; infoed stays excluded. | G6 |
| Q13 | **[RESOLVED 2026-06-30 — NetScaler chosen]** #502 / RITM0792011: **NetScaler is the public front**, with the SPS internal ALB as backend (§7.7). CloudFront origin-swap retired; CloudFront optional caching layer TBD. The SPS app ALB is internal-only (G4 nice-to-have). | — | — | G11 |
| Q14 | **[RESOLVED 2026-06-30]** **Confirmed account model?** | **Single account `665083158573` (Paul, 2026-06-30).** ADR-008 "separate accounts" wording is stale/wrong; `-c <env>Account` stays single-account; **no cross-account merge**. | plan is/isn't also an account merge. | G0 |
| Q15 | **[RESOLVED-as-our-call 2026-06-30]** ENI-attach IAM. **SPS owns the account → SPS grants its own roles `ec2:*NetworkInterface*` for the placement subnets; no external SCP blocker expected.** Keep a one-line verify-at-first-deploy check (internal action, not a Fabrice gate). | — | (internal) tasks stuck PROVISIONING if the grant is missed — fixed in SPS IAM. | G10 |
| Q16 | **[RESOLVED 2026-06-30 — our call]** ReCiter co-tenancy. **SPS owns ReCiter**, so no cross-team sign-off is needed to place SPS ENIs/SGs in this VPC; SPS scopes ReCiter↔SPS SG references itself. | — | — | G6, G9 |
| Q17 | **#443 ED LDAPS export** — can it run from its-reciter, retiring `edExportVpc` (staging `vpc-02c4dd698f3e3869c`, prod `vpc-0b8006fee120df6bc`)? | known non-target ids; fate must be decided. | bridge orphaned, or prematurely retired. | G6 (decision, not blocking) |
| Q18 | **[RESOLVED 2026-06-30 — MEASURED]** Prod data volume. **Total 658 MB** (data 498 + index 160), **49 tables**, ~**619k rows** (read-only `information_schema` on prod; largest `publication` 390 MB/133k rows, `publication_author` 90 MB/249k, `publication_topic` 59 MB/75k, `grant` 31 MB, `grant_publication` 23 MB, `mesh_descriptor` 20 MB; all else <10 MB). A dump/restore (or snapshot-restore) runs in minutes → **write-freeze comfortably sub-hour (~10–20 min est.)**. The "modest volume" premise is **verified-measured**. | — | (still book the sub-hour window). | G12, G14 |
| Q19 | **[DOWN-SCOPED 2026-06-30 — NOT NEEDED]** CDC prerequisites. At the measured 658 MB (Q18) a plain dump/restore freeze is sub-hour, so **CDC/DMS is NOT on the primary path** — pre-stage it (binlog_format=ROW + old-cluster reboot, DMS instance/endpoints/IAM) **only** as a contingency *if a near-zero-downtime cutover is later required*. | not pre-staged (contingency only). | only relevant if the contingency is invoked reactively — pre-stage then. | G16 |
| Q20 | **Fixed-physical-name + export hand-off plan** (G15) — auto-name the recreated ALB/ECS/domain; reuse OIDC/IAM/ECR/vaults; switch consumers to props/SSM; keep transitional names or do a full export migration? | the naïve `-v2` model is unbuildable. | deploy fails "already exists"; permanent `-v2` vault; export-lock deadlock at teardown. | G15 |

---

## 10. Out of scope / assumptions

**Out of scope**
- **The `edExportVpc` ED-LDAPS bridge** (#443 / `edEmailVisibilityBridgeEnabled`, scholars-dev/prod VPCs) is untouched here; whether TGW co-location lets it retire is a follow-up (Q17), not part of this consolidation.
- **The #502 NetScaler-vs-WAFv2 decision** is **resolved (2026-06-30): NetScaler is the chosen public front** (§7.7). The WCM-side NetScaler VIP/cert/allowlist wiring and the public CNAME change are owned by the WCM-ITS edge track, not deliverables of this plan; CloudFront, if retained, is an optional caching layer.
- **DR-region (us-west-2) topology** is unchanged — same account, DR vault + cross-region copy preserved.
- **Application/feature code** (search ranking, ETL business logic, UI) — only network placement, datastore endpoints, grants, secrets, and CDK topology change.
- **A literal `git revert` of #1310** — superseded by a forward PR (§8.8).

**Assumptions (each must be confirmed before the dependent phase)**
- **[A1 — account model]** Both envs and its-reciter share `665083158573` / `us-east-1` (G0). If separate, this becomes a cross-account merge and the IAM/KMS/secret scope changes.
- **[A2 — whole-estate move]** App + Data + ETL all relocate together; a subset is not expressible without peering (§4.2).
- **[A3 — resolver pre-association]** its-reciter already associates the 3 WCM rules, so SPS drops its own (G7).
- **[A4 — endpoint reuse]** its-reciter provides (or will provide) a privateDNS SM endpoint + ECR/Logs/DDB/S3 endpoints or NAT admitting the SPS roles; SPS drops its own SM/S3 endpoints (G5).
- **[A5 — edge front]** **DECIDED 2026-06-30:** NetScaler is the public front, with the SPS **internal** ALB as its backend (§7); the old Path A/Path B (public-ALB-vs-CloudFront-VPC-origin) choice is moot. CloudFront, if kept at all, is an optional caching layer (TBD). G4 public-ingress is nice-to-have, not required.
- **[A6 — migration mechanism]** **MEASURED-small (658 MB, G14):** Aurora = logical dump/restore (recommended primary) or snapshot-restore via `DatabaseClusterFromSnapshot` (co-equal CDK-native alternative); **DMS/binlog CDC is contingency-only, not needed** at this volume. OpenSearch = rebuild-from-source via `search:index` (G12/G14).
- **[A7 — read continuity]** The app reads the OLD OpenSearch domain (and old Aurora is read-frozen, not deleted) until the new domain is reindexed and verified, then `OPENSEARCH_NODE` flips (§6.3).
- **[A8 — physical-name disposition]** Account/region-scoped singletons (OIDC, IAM roles, ECR, backup vaults, S3, CloudFront) are reused by reference; VPC-coupled recreated resources use auto-generated/transitional names so create-before-delete works and the RETAIN'd old copies remain as rollback (§8.1, G15).
- **[A9 — SG isolation hygiene]** Env-suffixed, auditable SG naming/tagging is enforced; a prod SG never appears in a staging rule (the only env boundary; G9).
- **[A10 — ENI capacity]** its-reciter's two /24s have headroom for both envs' full ENI footprint on top of ReCiter (RDS + pub-mgr; **the ReCiter EKS cluster is in a SEPARATE VPC `192.168.0.0/16`, NOT here — confirmed 2026-06-30, so no EKS VPC-CNI contention**); a dedicated SPS subnet is **not** required if SPS compute lands in the **app2** tier (162 free), though the tight db/dmz `/27`s for two envs should be confirmed (G2/Q3).

*Source grounding: all CDK/ETL references re-read via `git -C /Users/paulalbert/Dropbox/GitHub/Scholars-Profile-System show origin/master:<path>`. No its-reciter network identifier was read from or inferred into the working tree; all are open questions in §9.*