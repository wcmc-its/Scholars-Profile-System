# Item-3 `useSharedVpc` cutover — execution runbook (staging first)

Operator runbook for consolidating the SPS estate into `its-reciter-vpc01`
(`vpc-08a1873fc8eebae28`, acct `665083158573`, `us-east-1`). Reconciles the
authoritative plan (`docs/sps-vpc-consolidation-plan.md` §6.8/§8.5, on the
`docs/sps-vpc-consolidation-plan` branch) with what is actually built on
`origin/master` as of 2026-07-01. **Staging is fully soaked before prod.**

> This is a coordinated, booked-maintenance-window operation with two
> **cross-team (WCM) dependencies** and one **unbuilt code gap**. It is **not**
> a flag flip. Do not start any phase until its gate row below is GREEN.

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

**NOT built — must land before any flip (increment-2, this PR):**

| Gap | Evidence | Fix |
|---|---|---|
| **G15-a: AppStack hardcodes VPC-coupled physical names** | `loadBalancerName: sps-public/internal-${env}` (`app-stack.ts:2279/2287`), `clusterName: sps-cluster-${env}` (928), `serviceName: sps-app-${env}` (2428) — none gated on `useSharedVpc`. | Under `useSharedVpc`, pass `undefined` (CDK auto-generates) so the VPC-change replace is create-before-delete without an `already exists` collision. Flag-off keeps the exact fixed names (byte-identical synth). |
| **G15-b: `resolveSharedSg` reads shared SG ids from SSM** | `shared-vpc-subnets.ts:79-93` always reads `/sps/<env>/net/<tier>-sg-id`. NetworkStack publishes the *shared* ids there only when it is flipped — but NetworkStack flips **last** (Phase G; see §2), so during Phases A–F SSM still holds the **standalone** SG ids. Consumers would wire the wrong SGs. | Under `useSharedVpc`, read `cfg.sharedVpc[`${tier}SgId`]` config literal; else SSM. Keeps `mutable:false`. Flag-off unchanged. |
| **G8: shared SG ids empty in config** | `config.ts:476-478` `appSgId/etlSgId/albSgId = ""`; `assertSharedVpcConfig` (`config.ts:773-788`) fails synth on empty. | Operator creates 3 per-env SGs in the shared VPC (allow-all egress, no ingress — CDK adds ingress as standalone L1 `CfnSecurityGroupIngress`, `app-stack.ts:894-916`), and fills **staging's** `sharedVpc` via spread override so prod stays empty/untouched. |

---

## 1. Mechanism per tier (reconciled)

| Tier | Recreated? | Cutover style | Old kept as rollback |
|---|---|---|---|
| Network substrate | imported (`fromVpcAttributes`) | NetworkStack stays **flag-off until Phase G**; per-env SGs are created **out-of-band** (the old VPC can't be deleted while datastores occupy it) | old VPC live until Phase G |
| Aurora | new cluster (`DatabaseClusterFromSnapshot`) | freeze-only final restore at 658 MB (~10–20 min, §6.2/G14) | old cluster RETAIN + deletion-protected |
| OpenSearch | new domain | app reads **OLD** domain until new-domain reindex verifies, **then** flip `OPENSEARCH_NODE` (§6.3) | old domain RETAIN |
| ECS app + ALBs | replaced, **auto-named** (G15-a) | hard cutover; validate new internal ALB by direct `X-Origin-Verify` probe before NetScaler re-point | — (hard cutover; window covers the outage) |
| ETL | replaced placement | hard cutover; schedules parked **and no RUNNING execution** before freeze | idempotent; re-park new / re-enable old |
| Edge | **no SPS resource** | **NetScaler backend re-point** to the new internal ALB DNS (WCM edge track, Q11) | re-point NetScaler back (minutes) |

---

## 2. HARD GATES — verify GREEN before starting (owner in **bold**)

| Gate | What | Owner | How to confirm |
|---|---|---|---|
| **G15 code** | increment-2 PR merged (auto-naming + `resolveSharedSg` config-literal + config filled) | **SPS (me)** | PR green (build+cdk), `cdk diff Sps-App-staging` shows ALB **create-before-delete**, no `already exists` |
| **G8 SGs** | 3 staging SGs exist in `vpc-08a1873fc8eebae28`; ids in `sharedVpc` (staging override) | **SPS operator** | `aws ec2 describe-security-groups --group-ids <ids>` |
| **G6 firewall** | WCM firewall admits `10.46.134/160 → every ETL source` (ReciterDB, ED LDAPS `:636`, InfoEd `10.20.91.8`, ASMS, COI, Jenzabar, SES, POPS) | **WCM network (Q12)** | WCM change-ticket confirmation — a describe **cannot** prove it |
| **Q11 NetScaler** | NetScaler VIP can reach the new internal-ALB DNS and is ready to re-point its backend | **WCM edge track** | WCM confirmation + SPS supplies internal-ALB DNS |
| **G5 endpoints** | its-reciter reaches SM/ECR/Logs/STS over NAT (no 2nd SM endpoint) | GREEN (confirmed 2026-06-30) | — |
| **Snapshot** | fresh staging Aurora snapshot id set as `auroraSnapshotIdentifier` | **SPS operator** | `aws rds describe-db-cluster-snapshots` |

**If G6 or Q11 is not GREEN, stop.** Moving the app strands staging behind an
un-re-pointed front door / a firewall that rejects every source — that is an
outage, not "downtime".

---

## 3. Phase-by-phase execution (staging)

All deploys from a clean `origin/master`-based tree (`~/worktrees/sps-deploy`),
`cdk diff` before every `cdk deploy`, one stack at a time, human-approved. CD
rolls the image only — all infra here is manual.

### Phase A — Stand-up (reversible: delete new, old untouched)
1. Create the 3 staging SGs in the shared VPC (allow-all egress, no ingress);
   record ids; fill `sharedVpc` staging override in config.
2. Merge the increment-2 PR (§0 gaps). Keep `useSharedVpc:false` still —
   this only lands the code; nothing flips yet.
3. Seed `scholars/staging/opensearch/{app,etl}` secret `node` key = the
   **current live** OS endpoint (so App/Etl keep working when the flag flips).

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

### Phase D — Edge cutover (reversible: re-point NetScaler back, minutes)
14. Inside the write-freeze: flip `OPENSEARCH_NODE` to the new domain (reseed
    `opensearch/{app,etl}` `node`) **after** reindex verify; **WCM re-points the
    NetScaler backend** to the new internal-ALB DNS; re-assert `X-Origin-Verify`;
    lift the freeze.

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
- **D:** WCM re-points NetScaler backend to the old ALB DNS (minutes).
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
