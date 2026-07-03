# VPC consolidation (item-3) — next-steps HANDOFF

**Authored 2026-07-02.** Pick-up point for finishing the ETL/SPS estate consolidation into
`its-reciter-vpc01`. Everything external turned out to be provable or ours — the balance is
SPS-side. Account `665083158573`, us-east-1. Staging first, then prod.

Cross-refs: runbook `docs/cutover-item3-execution-runbook.md` (now on master, §2 gates + §3 phases A–G),
plan `docs/sps-vpc-consolidation-plan.md`, memory `project_etl_cadence_vpc_relocation` +
`project_staging_cdk_deploy_drift`.

## Done this session (2026-07-02)
- **G8 staging SGs CREATED + wired — PR #1399 MERGED (`b888d524`).** 3 SGs
  provisioned out-of-band in the shared VPC (allow-all egress, no ingress, no self-ref), tagged
  `Project=SPS`/`Env=staging`/`ManagedBy=item3-pass1`: app `sg-010c270a395b4854b`,
  etl `sg-016b62e11314e7050`, alb `sg-0ab492e161a9e9976`. Wired into staging via a per-env spread
  (`sharedVpc: { ...SHARED_VPC, appSgId, etlSgId, albSgId }`), **prod left empty** — the shared
  `SHARED_VPC` const can't hold per-env SGs (isolation is by per-env SG, plan §4.5). Inert at flag-off
  (byte-identical synth, 14 cdk snapshots unchanged); 527 cdk tests pass. **PR #1399 MERGED** (`b888d524`).
- **Runbook reconciled — PR #1400 MERGED** (`1822c34c`): §0 gaps marked landed, cluster/service fixed-by-design
  clarified, gates G8/G15/G6 green, Fabrice edge answer folded in (decouple).
- **ReCiter ":5000 gap" DISSOLVED — was a misdiagnosis, no EKS/SG ask.** ReCiter ALB serves :80/:443 open to
  all; `:5000` is the Spring Boot backend port, unexposed. Real fix = prod `scholars/prod/reciter-api`
  secret `RECITER_API_BASE_URL` `:5000`→`:443` (**reseeded**; staging was already 443). See §1.
- **Staging OpenSearch `node` pre-seed DONE** (Phase A step 3): `scholars/staging/opensearch/{app,etl}`
  `node` = `https://vpc-opensearch58799-j7tli0rlgtyz-….es.amazonaws.com` (current domain); inert while
  `openSearchNodeFromSecret:false`. Removes a window step.
- **Edge reconcile ANSWERED (Fabrice) → decouple; ZERO external deps remain.** See "Edge reconcile" below.
- **#1397 MERGED** (`380c2e01`) — G15 ALB/cluster/service auto-naming + `resolveSharedSg` config-literal
  + execution runbook. **#1370 MERGED** (`2f719b90`) — consolidation plan docs.
- **G6 firewall EMPIRICALLY PROVEN OPEN** — from the post-cutover ETL CIDR `10.46.160.x`, all 6 on-prem
  WCM sources reachable (ED LDAPS `:636`, ReciterDB, ASMS, InfoEd, COI, Jenzabar). Not hearsay.
- **ReCiter reachability — CORRECTED: no SG ask at all** (supersedes the earlier ":5000 SG rule" read).
  The ReCiter internal ALB serves `:80/:443` open to `0.0.0.0/0`; `:5000` is the backend pod port, exposed
  nowhere. SPS reaches ReCiter on 443 intra-VPC post-move. The only fix was a stale prod-secret port
  (`:5000`→`:443`), now reseeded. Full detail in §1.
- **Edge — CORRECTED by Fabrice's answer** (see "Edge reconcile" below). Deployed today is CloudFront→ALB
  direct, but Fabrice's TARGET is **CloudFront → NetScaler → ALB → Fargate** (ALB stays — Fargate). We chose
  **decouple**: the VPC-move edge step is our own CloudFront origin repoint (item 3); NetScaler insertion is
  a separate WCM follow-on. Net: still a CloudFront origin repoint in the window, zero external edge dep.

## NEXT SESSION → staging data-move (runbook Phase B onward)
**Phase A is COMPLETE.** Entry state:
- SGs created + wired (#1399); all item-3 code landed (#1397/#1398/#1399); runbook reconciled (#1400).
- OpenSearch `node` secret seeded (staging app+etl = current endpoint `https://vpc-opensearch58799-j7tli0rlgtyz-….es.amazonaws.com`).
- `openSearchNodeFromSecret:true` for staging — **PR #1401 MERGED + DEPLOYED + verified** (`cdk deploy`
  Sps-App/Etl-staging; App service steady, task def now sources `OPENSEARCH_NODE` from
  `scholars/staging/opensearch/app:node::`). App/Etl→Data OS-export severed ahead of the window;
  same current endpoint so byte-identical in effect. Staging had ZERO app-stack drift.
- Edge = **DECOUPLE** (CloudFront origin repoint to the new ALB; NetScaler insertion is a separate WCM
  follow-on, not in the window). Copy-paste deploy values in "item 3" below.
- Aurora restore-compat verified (engine 3.08.0 exact / `scholars_admin` / same-account KMS).
  Staging OS domain = `opensearch58799-j7tli0rlgtyz`; prod = `opensearch58799-fquptd67j2so`.
- Zero open external deps.

**Still OFF — window steps, do NOT pre-flip:**
- `observabilityMetricsByName` — needs the POST-cutover cluster/domain/ALB identifiers (runbook §7/§4). Flip IN the window.
- `useSharedVpc` — the topology flip; `assertCutoverGate` blocks it until `auroraSnapshotIdentifier` is set from the FINAL freeze-time snapshot.

**Execute:** `docs/cutover-item3-execution-runbook.md` §3 **Phase B→G** (authoritative, reconciled). Staging has
no protected window → run whenever; reversible until Phase G (old estate RETAIN'd). At Phase B step 8, `cdk diff`
every stack and confirm ECS cluster/service show *update* not *replace* (G15-a belt-and-suspenders).

## Shared-VPC facts (grounded live — don't re-derive)
- VPC `vpc-08a1873fc8eebae28` (its-reciter-vpc01); CIDRs `10.46.134.0/24` + `10.46.160.0/24`;
  TGW `tgw-07716c8311a165e54` (attached, on-prem reachable).
- **app2 subnets** (ETL + app land here): `subnet-0c6593fb9c9a165c3` (`10.46.160.0/25`, aza),
  `subnet-070cbc242efbddc3c` (`10.46.160.128/25`, azb).
- **DMZ subnets** (public ALB): `subnet-09a6fab648280ca19` (`10.46.134.0/27`),
  `subnet-0485fefe267b06736` (`10.46.134.32/27`) — IGW `igw-09ece8f823b10c030`.
- **db subnets**: `subnet-0d35923e345653d0d` (aza), `subnet-099a9ebefc36ee888` (azb).
- **ReCiter internal ALB** `k8s-reciter-reciterm-5781d5ecb2` (SGs `sg-08f437f8183c2bb2f` managed-LB +
  `sg-0e4bf8c1cd71eafcd` backend): serves `:80/:443` open to `0.0.0.0/0` → **NO SG change needed** (SPS
  reaches it on 443 intra-VPC post-move). The earlier ":5000 ingress" belief was wrong — see §1.

## REMAINING — in order (all SPS-side unless noted)

### 1. G8 — shared-VPC security groups (unblocks the flip; `assertSharedVpcConfig` fails synth without)
- ✅ **DONE (PR #1399 MERGED):** 3 staging SGs created in `vpc-08a1873fc8eebae28` (app
  `sg-010c270a395b4854b`, etl `sg-016b62e11314e7050`, alb `sg-0ab492e161a9e9976`; allow-all egress,
  no ingress) and wired into staging via a per-env spread over `SHARED_VPC` (prod stays empty). NOTE:
  used a spread, NOT the shared const — the const is one object for both envs, so filling it would have
  given prod the same SGs.
- ✅ **ReCiter reachability — NOT an EKS/SG ask (prior ":5000 gap" was a misdiagnosis; corrected 2026-07-02).**
  ReCiter is fronted by an **internal ALB** (`k8s-reciter-reciterm-5781d5ecb2`, SGs `sg-08f437f8183c2bb2f`
  managed-LB + `sg-0e4bf8c1cd71eafcd` backend) listening **:80/:443 open to `0.0.0.0/0`**; `:5000` is
  ReCiter's Spring Boot *backend* pod port and is **not exposed anywhere** (no listener, no target group,
  no classic ELB). `reciter.weill.cornell.edu` → `10.46.160.175/101` (ALB ENIs, intra-shared-VPC). So the
  SPS app reaches ReCiter on **443** with **no SG change** once it's in the shared VPC (+G7 resolver).
  **Real fix (ours, ReciterAI) — ✅ DONE 2026-07-02:** the **prod** `scholars/prod/reciter-api` secret had
  `RECITER_API_BASE_URL=…:5000` (stale — nothing serves 5000); **staging was already correct** (443).
  Reseeded prod → `https://reciter.weill.cornell.edu` (443, `RECITER_API_KEY` preserved; old `:5000`
  version retained as AWSPREVIOUS). Dormant (`RECITER_REJECT_SEND=off`) so it never bit. **No EKS/SG ask.**

### 2. Aurora snapshot (the data-move gate) — COMPATIBILITY VERIFIED; snapshot is a cutover-window action
- **De-risked 2026-07-02 (no AWS mutation, no config change):** the restore is fully compatible with the
  live staging cluster `sps-data-staging-auroracluster23d869c0-rgmmgczcfzdc` —
  engine `8.0.mysql_aurora.3.08.0` (exact match to the pinned `VER_3_08_0`), master `scholars_admin`
  (matches the `db/master-its` username requirement — immutable on snapshot restore), encrypted with a
  same-account KMS key `6e13ff78-…`. The one thing that could block the restore (engine/user/KMS
  mismatch) is ruled out.
- **Do NOT take/commit a snapshot now.** With `useSharedVpc:false` the id is inert (byte-identical synth),
  and a snapshot taken now goes stale nightly (ETL writes) — restoring from it at cutover = data loss.
  The runbook is authoritative: `auroraSnapshotIdentifier` is set from the **FINAL** freeze-time snapshot
  inside the cutover window (runbook step 6 → deploy `Sps-Data-staging` at step 9). Nothing to do here
  until the window.
- **Data-tier SGs need no extra provisioning:** DataStack CREATES the Aurora + OpenSearch SGs itself
  (`data-stack.ts:101`/`:121`) with ingress from the item-1 app/etl SGs — so item 1's three SGs fully
  cover the data tier. `DatabaseClusterFromSnapshot` (data-stack.ts:194) + `db/master-its` are built;
  `assertCutoverGate` still throws if `useSharedVpc` flips without the id.

### 3. Edge — CloudFront origin repoint (ours) — PLANNED 2026-07-02 (no AWS mutation; grounded live)

**The repoint is already mechanized — no code change, no manual origin edit.** EdgeStack's ALB origin is
an SSM-parameter reference, not a hardcoded/cross-stack ALB handle:
```
origin = HttpOrigin(ssm.StringParameter.valueForStringParameter("/sps/staging/app/public-alb-dns"), …)
```
`valueForStringParameter` synthesizes an `AWS::SSM::Parameter::Value<String>` that **re-resolves to the
current SSM value on every `cdk deploy`**. AppStack publishes the public-ALB DNS to that param (pass 1),
so when AppStack redeploys onto the shared VPC (new G15 auto-named ALB), the param updates automatically;
a single `Sps-Edge-staging` redeploy then re-resolves it and CloudFront's origin follows. The S3
static-asset origin is untouched.

**Grounded current state (staging, live 2026-07-02):**
- Distribution `E17NRWINXLP3B3`, alias `scholars-staging.weill.cornell.edu`.
- ALB origin `sps-public-staging-955542627.us-east-1.elb.amazonaws.com` — **exactly equals** SSM
  `/sps/staging/app/public-alb-dns` (proves the mechanism; today it's the OLD standalone-VPC ALB).
- Viewer cert `arn:aws:acm:us-east-1:665083158573:certificate/f50f0b04-dc62-4d8e-97b8-2761d1efdd0f`.
- WAF `sps-edge-staging-wcm-only`, IP-allow `157.139.0.0/16`,`140.251.0.0/16` (WCM-only).

**Sequence at cutover (feeds runbook Phase D):**
1. AppStack deploys onto shared VPC → new public ALB → AppStack writes its DNS to
   `/sps/staging/app/public-alb-dns` (automatic).
2. Validate the NEW ALB directly first (before repointing users): `curl -H 'X-Origin-Verify: <secret>'`
   against the new ALB DNS → expect app 200; without the header → 403 (listener default-deny).
3. **Redeploy Edge manual-with-context** (bare deploy STRIPS alias/cert/WAF —
   `project_edgestack_manual_deploy_context`), from `origin/master`, `cdk diff` first:
   ```
   cd cdk && cdk deploy Sps-Edge-staging --exclusively \
     -c env=staging \
     -c edgeCustomDomain=scholars-staging.weill.cornell.edu \
     -c edgeCertArn=arn:aws:acm:us-east-1:665083158573:certificate/f50f0b04-dc62-4d8e-97b8-2761d1efdd0f \
     -c edgeAllowedCidrs=157.139.0.0/16,140.251.0.0/16
   ```
4. Verify: `aws cloudfront get-distribution-config --id E17NRWINXLP3B3` ALB origin domain == new ALB;
   alias + cert + `WebACLId` still present; `curl -I https://scholars-staging.weill.cornell.edu` → 200.
   CloudFront propagation is the visible switchover window (~minutes, longer than a NetScaler re-point).
- **Rollback:** old ALB is RETAIN'd through soak → revert SSM param to the old DNS (or re-deploy Edge
  after pointing the param back) and CloudFront follows on the next deploy. Fully reversible.

> ⚠️ **This IS the Phase-D edge step (reconcile RESOLVED 2026-07-02).** Fabrice's target is
> CloudFront → NetScaler → ALB, but we **decouple**: the VPC-move edge step is this SPS-owned CloudFront
> origin repoint, and NetScaler insertion is a separate WCM follow-on (not in the window). So Q11 is **N/A
> in the window** and there is zero external edge dependency. Runbook Phase D was reconciled to this in
> #1400 (decouple branch). See "Edge reconcile" below.

### 4. Execute staging cutover — runbook §3 Phases A–G
- A Stand-up → B Data migration (freeze + final snapshot + restore + checksum app-SOR tables) →
  C App validation → D Edge (CloudFront origin repoint) → E ETL cutover → F Soak → G Decommission.
- Consumers-first deploy ordering (Data→App→Etl before Network); per-stack `--exclusively`, never `--all`.
- Regrant `appRwGranteeHost` `10.20.%`→`10.46.160.%` + DSN reseed; canary `chm2042` publicationCount>0.

### 5. Verify → soak → prod
- After staging soaks clean, repeat for prod (adds the #475 reviewer gate + §5 `:80` bridge).

## Edge reconcile — ANSWERED by Fabrice 2026-07-02 (→ new sequencing sub-decision)
Fabrice's answer: target for the new VPC is **CloudFront → NetScaler → ALB → Fargate**, and because the
app is ECS Fargate the **AWS ALB stays** (his rule: Fargate/Beanstalk keep the ALB; only raw EC2 drops
it). No CDK change — our design already keeps the ALB.

**New wrinkle:** NetScaler is **not in the path today** (verified: both distributions point straight at
their ALBs). So reaching Fabrice's target is a **NetScaler-insertion** change that is *orthogonal* to the
VPC move (NetScaler → ALB works regardless of which VPC the ALB is in). Open **sequencing** decision:
- **Decouple (recommended):** VPC cutover keeps CloudFront → ALB, just repoints the CloudFront origin to
  the new ALB DNS (SPS-owned, item-3 plan above, no external dep). WCM inserts NetScaler as a separate
  follow-on. Q11 N/A in the window; the freeze stays SPS-only.
- **Couple:** insert NetScaler at cutover (CloudFront → NetScaler VIP, NetScaler backend → new ALB). Q11
  becomes a hard in-window gate + cross-team coordination during the freeze.

Runbook reconciled to this in **PR #1400**. **Sequencing = decouple** (SPS operational call — no need to
re-ping Fabrice to confirm; reaches his target either way). Next Fabrice contact is a real action item,
NOT a confirm: after the VPC move, hand him the new ALB DNS and ask him to stand up NetScaler in front of
it. Don't message him before then.

## Gotchas / method notes
- **Empirical probe pattern** (how G6/ReCiter/edge were proven): `aws ecs run-task` on `sps-etl-prod`
  with a `node -e` / `npx tsx -e` container override, placed via `--network-configuration` in whatever
  subnet/SG you want to test from. `@/lib/db` needs the `.default` interop unwrap under tsx; `@/lib/search`
  exposes `searchClient()`. **Print pass/fail only, never secret values.** `aws ecs wait` blocks past the
  Bash 2-min default → set the tool `timeout` for reindex-length tasks. Scripts in this session's scratchpad.
- **Tripwires:** `assertCutoverGate` + `assertSharedVpcConfig` (config.ts) fail synth if flipped before
  snapshot id / SG config filled. In-place flip is FORBIDDEN (CFN-replaces into empty datastores).
- **OpenSearch has no snapshot path** → new domain is EMPTY → full `search:index` reindex is mandatory
  at cutover (app reads OLD domain until the new one verifies, then flip `OPENSEARCH_NODE`).
- **Worktree** `~/worktrees/sps-deploy` is on the now-merged `feat/item3-cutover-runbook-g15` — safe to
  clean up (`git worktree remove`).
- Prod DB is now migrated to the Jun-22 app image schema; master's Jun 26–29 migrations ship with the
  next full prod app deploy (separate from this).
