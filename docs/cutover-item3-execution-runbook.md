# Item-3 `useSharedVpc` cutover — execution runbook (staging first)

Operator runbook for consolidating the SPS estate into `its-reciter-vpc01`
(`vpc-08a1873fc8eebae28`, acct `665083158573`, `us-east-1`). Reconciles the
authoritative plan (`docs/sps-vpc-consolidation-plan.md` §6.8/§8.5, on the
`docs/sps-vpc-consolidation-plan` branch) with what is actually built on
`origin/master` as of 2026-07-02. **Staging is fully soaked before prod.**

> This is a coordinated, booked-maintenance-window operation. **All item-3 code
> has landed** (increment-2 merged: #1397 / #1398 / #1399 — see §0), so the flip
> is now operational, not a code change. Two external asks remain: the edge
> **sequencing** (Fabrice confirmed the target is CloudFront → NetScaler → ALB;
> open choice = insert NetScaler at cutover vs. as a follow-on — see §1 ⚠️) and
> ReCiter `:5000` SG ingress (Mahender/EKS). It is **not** a flag flip. Do not
> start any phase until its gate row below is GREEN.

---

## 0. What is / isn't built (grounded on origin/master)

**Built (increment-1 — export-lock decouple + snapshot path):**
- `resolveTierSubnets` reads shared subnet ids from `cfg.sharedVpc.*SubnetIds`
  config literals when `useSharedVpc` (`shared-vpc-subnets.ts:45-59`). ✔ correct.
- Data-tier snapshot-restore: `auroraSnapshotIdentifier` set → DataStack builds
  `DatabaseClusterFromSnapshot` (new logical id) alongside the RETAIN'd live
  cluster (`data-stack.ts:171-220`). OpenSearch domain is RETAIN and replaces to
  a fresh domain (`data-stack.ts:494-524`). ✔.
- Export-lock severs: `openSearchNodeFromSecret` (App/Etl read `OPENSEARCH_NODE`
  from the `opensearch/{app,etl}` secret `node` key instead of
  `Fn.importValue(Sps-Data-<env>-OpenSearchDomainEndpoint)`) and
  `observabilityMetricsByName` (Observability keys Aurora/OS/ALB metrics by
  literal name instead of the DataStack/App handles). ✔.
- `assertCutoverGate` tripwire: `useSharedVpc:true` without
  `auroraSnapshotIdentifier` fails synth (`config.ts:817-848`). ✔.

**LANDED (increment-2 — merged #1397 / #1398 / #1399; nothing further must land before the flip):**

| Gap | Evidence | Status |
|---|---|---|
| **G15-a: AppStack hardcodes VPC-coupled physical names** | `loadBalancerName: sps-public/internal-${env}`, `clusterName: sps-cluster-${env}` (928), `serviceName: sps-app-${env}` (2438). | ✅ **#1397** — under `useSharedVpc` the ALBs **+ target groups** auto-generate names (`sharedReplaceName`, `app-stack.ts:2286`), so the replace is create-before-delete with no `already exists`; flag-off byte-identical. **Cluster + service stay fixed by design** — an ECS cluster isn't VPC-scoped, and a Fargate service's subnet/SG/target-group change is an in-place update under the rolling deployment controller, so neither replaces or collides. Belt-and-suspenders: confirm at Phase B step 8 `cdk diff` that both show *update*, not *replace*. |
| **G15-b: `resolveSharedSg` reads shared SG ids from SSM** | `shared-vpc-subnets.ts` — SSM held the *standalone* ids during Phases A–F (NetworkStack flips last), so consumers would have wired the wrong SGs. | ✅ **#1397 / #1398** — under `useSharedVpc`, reads the `cfg.sharedVpc.<tier>SgId` config literal (`shared-vpc-subnets.ts:91`); SSM only when flag-off. `mutable:false` kept. |
| **G8: shared SG ids empty in config** | `config.ts` `appSgId/etlSgId/albSgId = ""`; `assertSharedVpcConfig` fails synth on empty. | ✅ **#1399** — 3 staging SGs created out-of-band in the shared VPC (allow-all egress, no ingress): app `sg-010c270a395b4854b`, etl `sg-016b62e11314e7050`, alb `sg-0ab492e161a9e9976`; wired into **staging's** `sharedVpc` via a per-env spread so prod stays empty. |

---

## 1. Mechanism per tier (reconciled)

| Tier | Recreated? | Cutover style | Old kept as rollback |
|---|---|---|---|
| Network substrate | imported (`fromVpcAttributes`) | NetworkStack stays **flag-off until Phase G**; per-env SGs are created **out-of-band** (the old VPC can't be deleted while datastores occupy it) | old VPC live until Phase G |
| Aurora | new cluster (`DatabaseClusterFromSnapshot`) | freeze-only final restore at 658 MB (~10–20 min, §6.2/G14) | old cluster RETAIN + deletion-protected |
| OpenSearch | new domain | app reads **OLD** domain until new-domain reindex verifies, **then** flip `OPENSEARCH_NODE` (§6.3) | old domain RETAIN |
| ECS app + ALBs | replaced, **auto-named** (G15-a) | hard cutover; validate new ALBs by direct `X-Origin-Verify` probe before the edge cutover | — (hard cutover; window covers the outage) |
| ETL | replaced placement | hard cutover; schedules parked **and no RUNNING execution** before freeze | idempotent; re-park new / re-enable old |
| Edge | CloudFront distribution (**SPS-owned**) | **Target: CloudFront → NetScaler → ALB** (Fabrice; ALB kept — Fargate). Cutover step depends on sequencing (see ⚠️): **decouple** = repoint CloudFront origin to new ALB (SPS, no WCM); **couple** = NetScaler backend re-point (WCM, Q11) | repoint origin / re-point NetScaler back (minutes) |

> ⚠️ **Edge model — Fabrice confirmed NetScaler in front (2026-07-02).** Target for
> the new VPC is **CloudFront → NetScaler → ALB → Fargate**; because the app is ECS
> Fargate, the AWS **ALB stays** (no CDK change — our design already keeps it). BUT
> NetScaler is **not in the path today** (verified: both distributions point straight
> at their ALBs — prod `E28NKDFXC7K2ZL` → `sps-public-prod-374923924…`, staging
> `E17NRWINXLP3B3` → `sps-public-staging-955542627…`), so reaching Fabrice's target
> requires *inserting* NetScaler — a change **orthogonal to the VPC move** (NetScaler →
> ALB works regardless of which VPC the ALB lives in). **Open sequencing decision:**
> - **Decouple (recommended):** the VPC cutover keeps CloudFront → ALB and just
>   repoints the CloudFront origin to the new ALB DNS (SPS-owned, one `Sps-Edge-staging`
>   redeploy, no external dep — handoff item 3). WCM inserts NetScaler as a **separate
>   follow-on**. Q11 is **N/A in the window**; the risky freeze stays SPS-only.
> - **Couple:** insert NetScaler at cutover — CloudFront origin → NetScaler VIP,
>   NetScaler backend → new ALB. Q11 becomes a **hard in-window gate** (WCM ready) and
>   adds cross-team coordination to the freeze.

---

## 2. HARD GATES — verify GREEN before starting (owner in **bold**)

| Gate | What | Owner | How to confirm |
|---|---|---|---|
| **G15 code** ✅ | increment-2 merged (#1397/#1398/#1399: auto-naming + `resolveSharedSg` config-literal + G8 config) | **SPS (me)** | ✅ merged, build+cdk green. Still `cdk diff Sps-App-staging` at the flip → ALB **create-before-delete**, no `already exists` |
| **G8 SGs** ✅ | 3 staging SGs in `vpc-08a1873fc8eebae28`; ids wired in staging `sharedVpc` spread (#1399) | **SPS operator** | ✅ `describe-security-groups --group-ids sg-010c270a395b4854b sg-016b62e11314e7050 sg-0ab492e161a9e9976` (0 ingress, allow-all egress) |
| **G6 firewall** ✅ | WCM firewall admits `10.46.134/160 → every ETL source` (ReciterDB, ED LDAPS `:636`, InfoEd `10.20.91.8`, ASMS, COI, Jenzabar, SES, POPS) | **WCM network (Q12)** | ✅ empirically proven open 2026-07-02 (all 6 sources reachable from `10.46.160.x`) |
| **Q11 NetScaler** (live only if NetScaler is **coupled** into the cutover — N/A if decoupled) | NetScaler VIP can reach the new ALB DNS and is ready to re-point its backend | **WCM edge track (Fabrice)** | WCM confirmation + SPS supplies new ALB DNS |
| **G5 endpoints** | its-reciter reaches SM/ECR/Logs/STS over NAT (no 2nd SM endpoint) | GREEN (confirmed 2026-06-30) | — |
| **Snapshot** | fresh staging Aurora snapshot id set as `auroraSnapshotIdentifier` at Phase B step 6 — restore-compat **pre-verified 2026-07-02** (live cluster engine 3.08.0 exact, master `scholars_admin`, same-account KMS) | **SPS operator** | `aws rds describe-db-cluster-snapshots` |

**If G6 is not GREEN — or Q11, when NetScaler is coupled into the cutover — stop.**
Moving the app strands staging behind an un-re-pointed front door / a firewall that
rejects every source — that is an outage, not "downtime". (G6 is proven; Q11 is N/A
if NetScaler insertion is decoupled from the VPC move — recommended.)

---

## 3. Phase-by-phase execution (staging)

All deploys from a clean `origin/master`-based tree (`~/worktrees/sps-deploy`),
`cdk diff` before every `cdk deploy`, one stack at a time, human-approved. CD
rolls the image only — all infra here is manual.

### Phase A — Stand-up (reversible: delete new, old untouched)
1. ✅ **DONE (#1399):** 3 staging SGs created in the shared VPC (allow-all egress,
   no ingress) — app `sg-010c270a395b4854b`, etl `sg-016b62e11314e7050`, alb
   `sg-0ab492e161a9e9976`; wired into staging's `sharedVpc` spread override.
2. ✅ **DONE:** increment-2 code merged (#1397/#1398/#1399). `useSharedVpc:false`
   still — the code is landed, nothing flips yet.
3. ⬜ **Next pre-window prep:** seed `scholars/staging/opensearch/{app,etl}` secret
   `node` key = the **current live** OS endpoint (so App/Etl keep working when the
   flag flips). Inert while `openSearchNodeFromSecret:false`.

### Phase B — Data migration (reversible: abandon new, keep old)
4. Quiesce ETL: park schedules **and confirm no Step Functions execution is
   `RUNNING`** (§6.8 step 4).
5. Open the maintenance window (app read-only).
6. Take the **final** staging Aurora snapshot; set `auroraSnapshotIdentifier`.
7. Flip `openSearchNodeFromSecret:true` and `observabilityMetricsByName:true`
   (fill `auroraClusterIdentifier`/`opensearchDomainName`/`publicAlbFullName`/
   `publicTargetGroupFullName` — see §4), deploy `Sps-App-staging`,
   `Sps-Etl-staging`, then **`Sps-Observability-staging` EXCLUSIVELY** — this
   severs the Data/App exports **before** the Data replace (`observability-stack.ts:158-160`).
8. Flip `useSharedVpc:true`. `cdk diff` **every** stack.
9. Deploy `Sps-Data-staging` (new cluster-from-snapshot + fresh OS domain
   alongside the RETAIN'd old ones).
10. Re-create OpenSearch FGAC users on the new domain (`_security` API).
11. Re-issue MySQL GRANTs for the `10.46.x` source (`app_rw`/`app_ro`/
    `sps_migrate`/`sps_bootstrap`); update `appRwGranteeHost` `10.20.%`→`10.46.160.%`
    (or `%`) + verify-grants golden list; **reseed** every `db/*` DSN secret with
    the new cluster endpoint.
12. Run `search:index` against the **new** domain from the migrated Aurora.
    **App still reads the OLD domain** until doc-count/alias verify passes (§6.3).

### Phase C — App validation (reversible)
13. Deploy `Sps-App-staging` (now shared-VPC, auto-named ALBs). Validate the new
    **internal** ALB directly with `X-Origin-Verify`; confirm app→Aurora:3306 and
    app→OS:443 intra-VPC SG refs; confirm an edit-flow write lands in the new cluster.

### Phase D — Edge cutover (reversible: repoint origin / re-point NetScaler back, minutes)
14. Inside the write-freeze: flip `OPENSEARCH_NODE` to the new domain (reseed
    `opensearch/{app,etl}` `node`) **after** reindex verify; re-assert
    `X-Origin-Verify`; **cut the edge over** (per the ⚠️ sequencing decision);
    then lift the freeze.
    - **Decouple (recommended):** redeploy `Sps-Edge-staging` with the 3 `-c edge*`
      context flags so its SSM-param origin re-resolves to the new public-ALB DNS
      (procedure + pinned values in handoff item 3). No WCM step; WCM inserts
      NetScaler in front as a separate follow-on.
    - **Couple:** WCM (Fabrice) re-points the NetScaler backend to the new ALB DNS;
      CloudFront origin → NetScaler VIP.

### Phase E — ETL cutover (reversible)
15. Deploy `Sps-Etl-staging`; enable schedules on the new tier; park old.
16. `aws cloudformation list-imports` empty for the old Data/App exports.

### Phase F — Soak (reversible)
17. ≥1 full nightly + weekly cycle; verify search freshness, edit writes, ALB
    5xx/latency, ENI/EIP headroom; run the **staging-SG → prod-datastore refused**
    isolation probe once prod exists.

### Phase G — Decommission (NOT reversible once old data tier deleted)
18. Flip `Sps-Network-staging` to shared (or tear down) **last**, only after F
    passes: it deletes the now-vacated standalone VPC/subnets/NAT/RTs, releases
    the EIP, drops the 3 resolver associations. Confirm its-reciter already carries
    WCM resolver reach (G7 GREEN) first. Take a final old-cluster snapshot; disable
    deletion protection on the OLD cluster; delete old Aurora/OS **before** the VPC
    (a VPC delete fails while an orphaned RDS lives in it).

---

## 4. The observability-identifiers timing note

`observabilityMetricsByName` (step 7) must deploy **before** the Data replace, but
its `publicAlbFullName`/`publicTargetGroupFullName` are the **post-replace** ALB's
full names — not known until Phase C. Handling: set the Aurora/OS identifiers
(deterministic, from the new cluster/domain) at step 7; for the ALB names, either
(a) accept a brief ALB-alarm gap and set them once the new ALB exists (Phase C),
re-deploying Observability, or (b) pin a deterministic ALB name. Recommended: (a) —
the ALB alarms are non-load-bearing during the freeze.

---

## 5. Verification checklist (before Phase G) — from §6.9

- [ ] Row-count/checksum parity old↔new Aurora for every table (esp. center
      membership — the app-only SOR).
- [ ] Schema-object parity (`SHOW CREATE` tables/views/triggers/routines/events,
      charset, FKs, AUTO_INCREMENT).
- [ ] `app_rw`/`app_ro`/`sps_migrate`/`sps_bootstrap` authenticate from a `10.46.x`
      source; verify-grants golden list passes.
- [ ] No stale `10.20`/`10.10` host in any `db/*` or `opensearch/*` secret.
- [ ] Force one rotation on the new cluster; app reconnects.
- [ ] New OS domain green; FGAC users present; `search:index` complete; alias on
      fresh index; doc counts match (~178k+ pubs); then `OPENSEARCH_NODE` flipped.
- [ ] AWS Backup selection re-pointed; next daily run = primary + us-west-2 copy.
- [ ] Old backup vault + DR recovery points still present, within retention.
- [ ] One full nightly Step Functions cycle clean on the new tier.
- [ ] Rollback proven: old Aurora/OS still RETAIN + deletion-protected.

---

## 6. Rollback

- **A–C:** delete new stacks; old estate untouched. Zero user impact.
- **D:** revert the edge (minutes) — CloudFront-direct: redeploy `Sps-Edge-staging`
  with the origin SSM param pointed back at the old ALB DNS; NetScaler model: WCM
  re-points the backend to the old ALB DNS.
- **E:** re-park new schedules, re-enable old (idempotent; safe only while the app
  still writes the OLD cluster).
- **Point of no easy return:** once App is cut to the NEW Aurora it is the SOR;
  the Phase-D write-freeze is the mitigation (no edits during cutover).
- **G:** none once the old data tier is deleted — keep the final old snapshot +
  RETAIN vaults through retention as the only recovery path.

---

## 7. Prod

Repeat A→F for prod only after staging soaks clean. Prod `appRwGranteeHost` is
`%` (host scope not an issue) but still needs the new endpoint in its DSN. Prod
adds the reviewer gate (#475), the §5 bridge for the WCM connectivity, its own
drift assessment, and the 35-day recovery-point retention before any teardown.
