# SPS cutover item 3 — implementation map (companion to the export-lock design)

**Date:** 2026-06-30 · **Grounded on:** `origin/master` @ `ccb3f700`. Design doc: `docs/cutover-item3-export-lock-design-2026-06-30.md` (written @ `09ce498d`; its line hints are HINTS — symbols re-grounded here).
**Assumes:** Approach C spine + Option-2 SG ownership (shared-VPC team pre-provisions the app/etl/alb SGs out-of-band; their ids arrive as config literals). Reviewed wiring-only per-pass snapshot delta accepted (design "the one decision").

---

## 1. Resolved open questions

### Q4 — SG ingress: is anything dropped on the `fromSecurityGroupId` switch? What must the shared team pre-own?

**Ingress: nothing drops.** Every rule whose RECEIVER is app/etl/alb SG is either a raw L1 `ec2.CfnSecurityGroupIngress` keyed on `<sg>.securityGroupId`, or an `addIngressRule` on a CDK-owned data-plane SG with the imported SG only as a *peer* (contributes `.securityGroupId`, a string). Both forms are emitted unconditionally and survive import even with `mutable:false`:
- `PublicAlbIngressFromInternet` tcp/80 ← 0.0.0.0/0 — `cdk/lib/app-stack.ts:896`
- `AppIngressFromPublicAlb` tcp/3000 ← albSG — `cdk/lib/app-stack.ts:904`
- `AppIngressFromInternalAlb` tcp/3000 ← internalAlbSG — `cdk/lib/app-stack.ts:912`
- `InternalAlbIngressFromEtl` tcp/80 ← etlSG — `cdk/lib/etl-stack.ts:136`
- Aurora tcp/3306 ← app/etl — `cdk/lib/data-stack.ts:99,104`; OpenSearch tcp/443 ← app/etl — `cdk/lib/data-stack.ts:123,128`
- vpcEndpointSG tcp/443 ← app/etl — `cdk/lib/app-stack.ts:2776,2781` — **absent under shared VPC** (gated `!useSharedVpc`; endpoints off per #1373), not dropped.

**Egress: THREE rules DO drop and MUST be pre-owned.** The allow-all egress on each central SG comes from `allowAllOutbound:true` on the CDK-created SG (`network-stack.ts:133` alb, `:139` app, `:145` etl). `SecurityGroup.fromSecurityGroupId(...)` emits **no** egress for an imported SG, so allow-all outbound vanishes on the switch → app tasks / ETL Fargate+Lambda lose all outbound (Aurora 3306, OpenSearch 443, ECR/SM/NAT/DNS). **The pre-provisioned out-of-band app/etl/alb SGs MUST be created with default (allow-all) egress.** Same for `internalAlbSecurityGroup` (`app-stack.ts:875`) **if** it is ever externalized — it is App-owned today (`app-stack.ts:869`), so it stays CDK-created and is not affected.

**Shared-team REQUIRED base rules:** allow-all egress on app/etl/alb (the only functional break). **Optional polish** the team may also pre-own to delete the CDK L1 resource: appSG:3000←albSG (`app-stack.ts:904`; both ends team-owned) and albSG:80←0.0.0.0/0 (`app-stack.ts:896` — but this is the NetScaler-dependent "HTTP merge window" rule on the DMZ/public ALB that config.ts:312 notes is unused under NetScaler; decide keep-CDK-side vs drop). **Cannot be team-pre-owned** (peer is a CDK-created SG that replaces at flip): appSG:3000←internalAlbSG, internalAlbSG:80←etlSG, auroraSG:3306←app/etl, opensearchSG:443←app/etl — leave CDK-side; they survive import unchanged.

**Mutability:** `{mutable:true}` is NOT strictly required to preserve existing edges (nothing calls `addIngressRule` on the three central SGs). Keep `mutable:true` anyway so any *new* item-3 ingress on the imported SGs is legal.

**No self-referential SG rules exist** (appSG←alb/internalAlb; albSG←internet; etlSG only ever a source). No `.connections`/`allowFrom`/`allowTo` anywhere; ECS is L1-attached via `cfnService.loadBalancers` (`app-stack.ts:~2470`) precisely to suppress CDK's auto ALB→app ingress.

### Q5 — CloudFront/ALB origin: exact props to reproduce verbatim

Swap `new origins.LoadBalancerV2Origin(publicAlb, {...})` (`cdk/lib/edge-stack.ts:239-244`) → `new origins.HttpOrigin(<ssm-ALB-DNS>, {...})`. **Keep the `const origin` name/shape** — it is reused as the OriginGroup fallbackOrigin (`edge-stack.ts:312-316`). Exactly THREE props, nothing else:

```ts
const origin = new origins.HttpOrigin(ssmPublicAlbDns, {
  protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,   // edge-stack.ts:240 — MUST be explicit (HttpOrigin default = HTTPS_ONLY)
  httpPort: 80,                                                 // edge-stack.ts:241
  customHeaders: { "X-Origin-Verify": originVerifyToken },      // edge-stack.ts:242-243 — load-bearing
});
```
- `originVerifyToken` — leave the definition at `edge-stack.ts:119-121` untouched (`SecretValue.secretsManager("scholars/${env}/edge/origin-shared-secret").unsafeUnwrap()` → CFN dynamic-ref token). Do NOT switch to `Secret.fromSecretNameV2().secretValue` (partial-ARN → `ResourceNotFoundException`; footgun at `edge-stack.ts:113-118`). This header is the **entire** origin-protection mechanism: the public listener default-denies `fixedResponse(403)` (`app-stack.ts:2358-2361`) and only priority-1 rule `OriginVerifiedForward` matching the same secret (`app-stack.ts:2352-2354,2372-2383`) forwards. Dropping it makes the ALB DNS an open back door.
- Leave UNSET (all default today): `readTimeout` (30s), `keepaliveTimeout` (5s), `connectionAttempts` (3), `connectionTimeout` (10s), `originShield`, `originSslProtocols`, `httpsPort`. Adding any = behavior drift.
- **No SG/prefix-list to reproduce:** the public-ALB SG is open to 0.0.0.0/0 (`app-stack.ts:896-903`); there is NO CloudFront prefix-list / origin-facing rule anywhere. The swap needs the header only.
- SSM value must be the **bare ALB DNS name** (no scheme/port/path) — `HttpOrigin` first arg is a domainName. `LoadBalancerV2Origin` is `super(loadBalancer.loadBalancerDnsName, props)` with zero injected props, so `HttpOrigin(dns, sameProps)` is byte-identical `CustomOriginConfig`. Only template deltas: origin `domainName` (Fn::GetAtt→SSM literal, intended) + the CDK origin-id hash (derived) — wiring-only.

### Q6 — inc-2 edges 9/10 (App→Obs ALB/TG metrics): extend inc-2 vs absorb into item-3?

**Decision: EXTEND inc-2's by-name pattern — do NOT absorb via item-3 SSM.** And this is **already coded** on the unmerged inc-2 branch (see §2 prereqs / §5). Rationale: (1) same class/stack/flag — edges 9/10 are metric-dimension decouples in the SAME Observability stack as 16/17, under the SAME `observabilityMetricsByName` flag, so one atomic Observability-only `cdk deploy --exclusively` severs all four Data/App→Obs metric edges before the flip; (2) no deploy-ordering race — a CloudWatch dimension is a string known at synth (the replaced ALB/TG full names), never needs a live import the way Etl's internal-ALB DNS/SG-id genuinely do; (3) byte-identical flag-off preserved. **Item-3 references, does not re-implement, the ALB/TG metric severance.** On `origin/master` edges 9/10 are still handle-bound (`observability-stack.ts:206` ALB metrics; `:241` TG `unhealthyHostCount`) — so this must merge as prereq P0b.

---

## 2. Exact edit surface (Option-2 SG ownership)

### Prereqs (merge + deploy BEFORE any item-3 pass)

| Prereq | What | State | Gate |
|---|---|---|---|
| **P0a — #1380** | `openSearchNodeFromSecret`: App/ETL read `OPENSEARCH_NODE` from a Secrets Manager secret instead of `Fn::importValue Sps-Data-<env>-OpenSearchDomainEndpoint` (severs edge 15) | OPEN PR, not on master | must land + secret exist before flip; reseed secret at flip |
| **P0b — inc-2 (+9/10 extension)** | `observabilityMetricsByName` by-name metric dims for Aurora/OpenSearch (edges 16/17) **and** ALB/TG (edges 9/10) — all-four-or-throw guard, default false | CODE-COMPLETE but UNMERGED/UNPUSHED on local `feat/cutover-decouple-aurora-observability` (commits `dc23099a` + `c6df4cd3`); NOT on master | re-cut clean CDK-only branch off fresh `origin/master`, PR, `cd cdk && npm ci && npm test -- -u` for `{app-stack,observability-stack}.test.ts.snap`. Deploy Observability-**exclusively** before the flip pass |
| **P0c — inc-4** | Aurora `DatabaseClusterFromSnapshot` + `auroraSnapshotIdentifier` gate | on same local branch (`62da3492`), unmerged | supplies the flip-pass snapshot restore |

### Pass 1 — publish + pin (flag OFF, replaces nothing)

| File | Symbol / line | Change |
|---|---|---|
| `cdk/lib/config.ts` | `sharedVpc` type block `305-314` | ADD `readonly appSgId: string; readonly etlSgId: string; readonly albSgId: string;` |
| `cdk/lib/config.ts` | `SHARED_VPC` literal `369-379` | ADD the 3 SG ids (values = out-of-band pre-provisioned SG ids from shared team) |
| `cdk/lib/config.ts` | `assertSharedVpcConfig` `~614` | validate the 3 new fields non-empty when `useSharedVpc=true` |
| `cdk/lib/network-stack.ts` | after each SG create (`130`/`136`/`142`) + vpc/subnets | `Stack.exportValue(...)` **pins for edges 1-5** (`ExportsOutputRefVpc*`, `ExportsOutputRefVpc*Subnet*`, `…RefAppSecurityGroup`, `…RefEtlSecurityGroup`, `…RefAlbSecurityGroup`) — keeps auto-exports alive after consumers repoint in pass 2 |
| `cdk/lib/app-stack.ts` | publicAlb `2263`/`loadBalancerDnsName` | `Stack.exportValue` **pin for edge 8** (`…FnGetAttPublicAlb…DNSName`) — the one genuinely-required App pin; **+** write public-ALB DNS to a new SSM param |
| `cdk/lib/app-stack.ts` | internalAlbSG `869`/`2867`, internalAlb DNS `2860` | write internal-ALB **SG-id** (edge 6) and internal-ALB **DNS** (edge 7) to SSM params (App = producer) |
| — | edges 6 & 7 producer pins | NOT strictly required — they are explicit NAMED CfnOutputs (`app-stack.ts:2869`,`2860`), never auto-deleted, re-compute safely once Etl stops importing in pass 2. Doc lists them conservatively; mechanical requirement = "Etl stop importing before flip" |

> Confirm exact per-subnet `ExportsOutputRefVpc*Subnet*` logical-id count with `cdk synth Sps-Network-<env> | grep ExportsOutputRef` before writing the pins (count is synth-dependent — UNVERIFIED here).

### Pass 2 — repoint consumers (flag OFF, replaces nothing)

| File | Line | Change |
|---|---|---|
| `cdk/lib/data-stack.ts` | `34` (`props.appSecurityGroup`) | → `ec2.SecurityGroup.fromSecurityGroupId(this,"AppSg",cfg.sharedVpc.appSgId,{mutable:true})`; drop prop + `bin/sps-infra.ts:62` feed |
| `cdk/lib/data-stack.ts` | `36` (`props.etlSecurityGroup`) | → `fromSecurityGroupId(...,cfg.sharedVpc.etlSgId,{mutable:true})`; drop prop + `bin:63` |
| `cdk/lib/app-stack.ts` | `96` (`props.appSecurityGroup`) | → `fromSecurityGroupId(...,cfg.sharedVpc.appSgId,{mutable:true})`; drop prop + `bin:84`. (ingress at `897/905/909/913` survives — L1, id-keyed) |
| `cdk/lib/app-stack.ts` | `98` (`props.etlSecurityGroup`) | → `fromSecurityGroupId(...,cfg.sharedVpc.etlSgId,{mutable:true})`; drop prop + `bin:85` |
| `cdk/lib/app-stack.ts` | `100` (`props.albSecurityGroup`) | → `fromSecurityGroupId(...,cfg.sharedVpc.albSgId,{mutable:true})`; drop prop + `bin:86` |
| `cdk/lib/etl-stack.ts` | `34` (`props.etlSecurityGroup`) | → `fromSecurityGroupId(...,cfg.sharedVpc.etlSgId,{mutable:true})`; drop prop + `bin:101` |
| Data/App/Etl | VPC (`bin:61/83/100`) + subnets | VPC → `ec2.Vpc.fromVpcAttributes(cfg.sharedVpc.vpcId, …)`; subnets → `resolveTierSubnets(cfg.sharedVpc)` (helper exists `shared-vpc-subnets.ts:23`). Removes edges 1/2 imports |
| `cdk/lib/etl-stack.ts` | `133` (internal-ALB SG-id `Fn.importValue`), `594` (internal-ALB DNS `Fn.importValue`, `SCHOLARS_BASE_URL`) | → `ssm.StringParameter.valueForStringParameter(...)` reading the Pass-1 SSM params (edges 6/7) |
| `cdk/lib/edge-stack.ts` | `239-244` | `HttpOrigin(ssmPublicAlbDns, {protocolPolicy:HTTP_ONLY, httpPort:80, customHeaders:{"X-Origin-Verify":originVerifyToken}})` per §Q5. `ssmPublicAlbDns` = `valueForStringParameter` of the Pass-1 public-ALB-DNS param. Removes edge 8 import |

Snapshot regen after Pass 1 and Pass 2 (`cd cdk && npm ci && npm test -- -u`; commit only `.snap`).

### Pass 3 — flip (single atomic flag)

| File | Change |
|---|---|
| `cdk/lib/config.ts` | `useSharedVpc = true` (both/target env) + set `auroraSnapshotIdentifier` (inc-4). Clears `assertCutoverGate` (config.ts) — its step-2/3 prereqs (grantee re-scope, DSN/endpoint reseed) MUST be done operationally first (§4) |

Deploy order at flip: P0b Observability-exclusive already done → then the Data/App/Etl/Edge flip deploy. No importer holds a replacing resource's export (pins + repoints already landed), so no `Export … in use` lock.

---

## 3. CHECKSUM gate table set (exact names, no guesses)

Resolve `<…>` from `scripts/backups/export-curated-tables.ts` `CURATED_TABLES` — do NOT hard-code. The resolved set:

**11 curated tables (DB `scholars`):**
`department`, `division`, `center`, `center_program`, `center_membership`, `division_membership`, `unit_admin`, `family_suppression_overlay`, `family_sensitivity_overlay`, `field_override`, `suppression`.

- **center-membership table = `center_membership`** (Prisma `CenterMembership @@map("center_membership")`, `prisma/schema.prisma:1285-1306`; already one of the 11). `membership_type` is a Prisma ENUM column, NOT a separate table — there is no `center_membership_type` table. App is its system-of-record.

**+ audit table (separate DB `scholars_audit`, NOT in the manifest — add explicitly):**
`scholars_audit.manual_edit_audit` (`scripts/db-bootstrap.ts:45-46`; DDL `scripts/sql/audit-log.sql:51,55`; writes `lib/edit/audit.ts:260`; reads `lib/api/center-audit.ts:181`, `lib/api/scholar-audit.ts:213`). Deliberately not a Prisma model.

**EXCLUDED (ETL-regenerable, per script header):** `scholar_tool`, `scholar_family`, `spotlight`, topics, search index.

---

## 4. Cutover operator prereqs (flip-time, operational)

**`appRwGranteeHost` regrant** — `cdk/lib/config.ts:131` (field), today staging=`"10.20.%"` (`:417`), prod=`"%"` (`:516`). MUST become the app2 /24 host pattern **`"10.46.160.%"`** (or `"%"`) per guidance `config.ts:688-689` + `assertCutoverGate` step 2. Consumed by: DataStack seeder Lambda `APP_RW_GRANTEE_HOST` (`data-stack.ts:331` → `cdk/lambda/db-bootstrap-seed`, `appRwTightenStatements` `seed.ts:164`) and AppStack bootstrap/verify task `GRANTEE_HOST` (`app-stack.ts:2176`). Operator must ALSO re-issue LIVE `app_rw`/`app_ro`/`sps_migrate`/`sps_bootstrap` GRANTs for the 10.46.x source (plan §6.2) or `app_rw` fails closed with MySQL 1410. **UNVERIFIED:** `"10.46.160.%"` is not committed as a value anywhere — only in guidance strings; config still holds `"10.20.%"`/`"%"`.

**DSN + OpenSearch endpoint reseed** — snapshot-restored Aurora + fresh OpenSearch domain get NEW endpoints (`config.ts:692`; `assertCutoverGate` step 3).
- DSN secrets (host embedded): `scholars/<env>/db/app-rw` (`secrets-stack.ts:79`), `db/app-ro` (`:85`), `db/bootstrap` (`:105`), `db/migrate` (`:118`), `db/master` (DataStack/RDS rotation). `db/bootstrap` + `db/migrate` **auto-reseed** on DataStack deploy (seeder `buildDsn(DB_HOST=auroraCluster.clusterEndpoint.hostname)`, `data-stack.ts:326`,`seed.ts:72`,`grantWrite` `data-stack.ts:356-361`). **`db/app-rw`, `db/app-ro`, `db/master` = manual operator reseed** to the new cluster endpoint. App reads `DATABASE_URL`/`_RO` (`app-stack.ts:2001-2002`); ETL `db/etl` (`etl-stack.ts:503`).
- OpenSearch: today `OPENSEARCH_NODE=https://<Fn::importValue Sps-Data-<env>-OpenSearchDomainEndpoint>` in-template (`app-stack.ts:1013-1016`; `etl-stack.ts:586,1244`; export `data-stack.ts:544-550`). #1380 moves this to a Secrets Manager secret — that secret MUST be reseeded with the new domain endpoint at flip. **UNVERIFIED:** exact #1380 secret name (PR still open, not on master).

---

## 5. Falsified assumptions / UNVERIFIED items

- **Design doc STALE on the inc-2 9/10 gap.** The doc (its edges-9/10 "not yet coded; see gap" + inline warning) was true at snapshot `dc23099a` but is **already closed** at branch HEAD `c6df4cd3` (committed 2026-06-30 21:05, ~4 min after the doc was saved 21:01): it adds `publicAlbFullName` + `publicTargetGroupFullName` config fields + `albMetric` helper (`AWS/ApplicationELB`) covering edges 9 (`alb5xxRate`/latency/dashboard) and 10 (`UnHealthyHostCount` alarm), all under `observabilityMetricsByName` with the all-four-or-throw guard. Action: re-cut clean, PR, deploy Observability-exclusive as P0b.
- **inc-2 branch is NOT clean CDK-only.** It also carries unrelated evidence-rows search-UI commits and DELETES `docs/evidence-rows-polish-handoff.md`. Re-cut just the 3 CDK commits (`62da3492`/`dc23099a`/`c6df4cd3` — config/data-stack/observability-stack + tests) off fresh `origin/master` before PR.
- **By-name metric strings are hand-typed literals (no L2 validation).** Cross-check exact CloudWatch names before flip: `HTTPCode_Target_5XX_Count`, `HTTPCode_Target_4XX_Count`, `HTTPCode_ELB_5XX_Count`, `RequestCount`, `TargetResponseTime`, `UnHealthyHostCount` (capital H); `AWS/ES` needs `ClientId=account` alongside `DomainName`. A typo silently yields an empty NOT_BREACHING (never-firing) alarm.
- **Edges 6 & 7 do NOT need `Stack.exportValue` pins** (contra a conservative reading of pass-1). They are explicit NAMED CfnOutputs (`app-stack.ts:2869`,`2860`), never auto-deleted; value re-computes safely once Etl (sole importer, `Fn.importValue` `etl:133`,`594`) repoints to SSM in pass 2. Genuinely load-bearing pins = **5 in Network (edges 1-5) + 1 in App (edge 8)**.
- **`mutable:true` is NOT strictly required** to preserve existing edges — nothing calls `addIngressRule` on the three central SGs (all receiver rules are L1 id-keyed). Keep it `true` only for forward-safety.
- **`"10.46.160.%"` unverified as a committed value** — appears only in guidance strings; config still `"10.20.%"`/`"%"`. `useSharedVpc` default-OFF, so `assertCutoverGate` is inert today and no reseed/regrant has run.
- **#1380 secret name unverified** (open PR, not on master).
- **Per-subnet `ExportsOutputRefVpc*Subnet*` count unverified** — confirm via `cdk synth Sps-Network-<env> | grep ExportsOutputRef` before pinning edge 2.
