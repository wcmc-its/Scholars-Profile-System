# Item-3 prod cutover — turnkey in-window runbook

**Authored 2026-07-05.** The prod half of the ETL/SPS consolidation into the shared
`its-reciter-vpc01`. Staging soaked clean (Phase F PASSED: nightlies 07-04 + 07-05
both SUCCEEDED). This runbook is the **execute-ready** Phase B→G for prod, with every
identifier filled in and secret-touching steps run as in-VPC ECS tasks (no credential
ever passes through a local shell).

Source of truth for phase *logic*: `cutover-item3-execution-runbook.md` §3 (A→G) and
`sps-vpc-consolidation-plan.md` §6/§7. This doc is the prod-specific, values-filled
execution of that logic. Account `665083158573`, us-east-1.

> ⚠️ **Point of no easy return** is **step 10** (App cut to the new Aurora → it becomes
> the SOR). Everything before it is reversible by abandoning the new stacks. The
> write-freeze is the only mitigation for the no-rollback zone — no edits may land
> between the freeze snapshot (step 2) and the freeze lift (step 15).

---

## 0. Prep — DONE (2026-07-05, non-destructive, already merged)

- [x] Prod's 3 shared-VPC SGs created + wired (PR **#1489**): app `sg-098a71afdd462d988`,
      etl `sg-03babbb300ddb3b95`, alb `sg-06422c1b27dc4e17d` (no ingress, allow-all
      egress). Inert while `useSharedVpc:false`; app-stack snapshot unchanged.
- [x] `scholars/prod/opensearch/{app,etl}` seeded with `node` = current prod OS endpoint
      (creds preserved). Inert while `openSearchNodeFromSecret:false`.
- [x] Prod ETL cadences already parked (`sps-etl-{nightly,weekly,annual,heartbeat}-prod`
      DISABLED). Two latent bugs (data-tier SG RETAIN, OS new-construct-id) already fixed
      in merged #1419 and cover prod.

## 1. Identifiers (grounded live 2026-07-05 — do not re-derive)

| Thing | Value |
|---|---|
| Prod Aurora cluster (current) | `sps-data-prod-auroracluster23d869c0-naxambgndood` (engine `8.0.mysql_aurora.3.08.0`, deletion-protected) |
| Prod Aurora writer endpoint (current) | `sps-data-prod-auroracluster23d869c0-naxambgndood.cluster-cetg9yc1lyuf.us-east-1.rds.amazonaws.com` |
| Prod OS domain (current) | `opensearch58799-fquptd67j2so` — endpoint `vpc-opensearch58799-fquptd67j2so-zcjx4niwn4sdqhsbnxjmjv4awm.us-east-1.es.amazonaws.com` |
| Prod public ALB (current) | `app/sps-public-prod/14016856c2b4f506` |
| Prod public target group (current) | `targetgroup/sps-tg-pub-prod/8522717eb2c2809d` |
| Prod internal ALB (current) | `app/sps-internal-prod/50a02e7022054e99` |
| Prod CloudFront dist | `E28NKDFXC7K2ZL`, alias `scholars.weill.cornell.edu` |
| Prod edge cert (live truth) | `arn:aws:acm:us-east-1:665083158573:certificate/95f77e69-4abc-4d2c-b081-b8b5b8572fd6` |
| Prod edge WAF (live) | `sps-edge-prod-wcm-only/8bddc4fb-953c-4f0f-a798-5e683eae2dbb` |
| Prod edge allowed CIDRs | `140.251.0.0/16,157.139.0.0/16` (verify via `--strict` diff — WAF must not change) |
| Shared VPC | `vpc-08a1873fc8eebae28`; app2 subnets `subnet-0c6593fb9c9a165c3`,`subnet-070cbc242efbddc3c`; db subnets `subnet-0d35923e345653d0d`,`subnet-099a9ebefc36ee888` |
| Prod shared SGs | app `sg-098a71afdd462d988`, etl `sg-03babbb300ddb3b95`, alb `sg-06422c1b27dc4e17d` |
| Prod DSN secrets | `scholars/prod/db/{master,app-rw,app-ro,etl,bootstrap,migrate}` |
| Prod OS secrets | `scholars/prod/opensearch/{master,app,etl}` |

## 2. Pre-window go/no-go (verify GREEN before step 1)

- [ ] **Operator present** for ~1–2 h to approve ~7 `cdk deploy Sps-*-prod` at the #475 gate.
- [ ] **No `/edit` curator writes** will land during the window (no hard read-only lock exists — this is operational).
- [ ] **No prod Step Functions RUNNING**: `aws stepfunctions list-executions --state-machine-arn $(aws stepfunctions list-state-machines --query "stateMachines[?contains(name,'scholars-nightly-prod')].stateMachineArn|[0]" --output text) --status-filter RUNNING` → `[]`.
- [ ] **OS master rotation decision** (see step 3): rotate `scholars/prod/opensearch/master` **before** the Data deploy so the fresh domain is born un-leaked; rotate `scholars/staging/opensearch/master` separately (its domain already exists).
- [ ] **Deploy tree** = detached `origin/master` (has #1489). `git worktree add ~/worktrees/sps-deploy-prod --detach origin/master && cd ~/worktrees/sps-deploy-prod/cdk && npm ci`.
- [ ] Restore-compat: engine 3.08.0 exact / master `scholars_admin` / same-account KMS — pre-verified for the same DataStack code on staging.

**Reusable in-VPC task launcher** (never reads secrets locally; the task's role + baked
DSN/OS creds do the work). After the Data deploy, target the **shared** VPC so the task
reaches the new tier:

```bash
runjs() {   # runjs <container-cmd-json>   — e.g. runjs '["npm","run","search:index"]'
  aws ecs run-task --cluster sps-cluster-prod --task-definition sps-etl-prod \
    --launch-type FARGATE \
    --network-configuration 'awsvpcConfiguration={subnets=[subnet-0c6593fb9c9a165c3,subnet-070cbc242efbddc3c],securityGroups=[sg-03babbb300ddb3b95],assignPublicIp=DISABLED}' \
    --overrides "{\"containerOverrides\":[{\"name\":\"etl\",\"command\":$1}]}" \
    --started-by "prod-cutover"
}
# watch: /aws/ecs/sps-etl-prod stream etl/etl/<taskId>
```

---

## Phase B — data migration (reversible until step 10)

### Step 1 — Quiesce + confirm freeze
Confirm the go/no-go list. ETL cadences are already DISABLED; also disable the two
enabled reconcilers for the window (they don't write Aurora but keep the freeze clean):
```bash
aws events disable-rule --name sps-reconcile-prod
aws events disable-rule --name sps-cdn-reconcile-prod
```

### Step 2 — FINAL freeze-time prod Aurora snapshot
```bash
STAMP=20260705   # set to the actual window date
aws rds create-db-cluster-snapshot \
  --db-cluster-identifier sps-data-prod-auroracluster23d869c0-naxambgndood \
  --db-cluster-snapshot-identifier sps-data-prod-cutover-final-$STAMP
aws rds wait db-cluster-snapshot-available \
  --db-cluster-snapshot-identifier sps-data-prod-cutover-final-$STAMP
```
Non-destructive (a snapshot). This id feeds `auroraSnapshotIdentifier` at step 6.

### Step 3 — Rotate the prod OS master secret (before the fresh domain is created)
Generate a new master password and store it (in-shell generation, value never printed):
```bash
NEWPW=$(python3 -c "import secrets,string; a=string.ascii_letters+string.digits+'!#$%'; print(''.join(secrets.choice(a) for _ in range(32)))")
aws secretsmanager put-secret-value --secret-id scholars/prod/opensearch/master --secret-string "$NEWPW" >/dev/null && echo "rotated (value not shown)"; unset NEWPW
```
> The fresh domain (step 7 Data deploy) is created with this rotated master. The OLD
> domain keeps the leaked password but is VPC-internal and is destroyed at Phase G.
> Rotate `scholars/staging/opensearch/master` on its own (its domain already exists →
> also update the domain master-user config).

### Step 4 — Config commit #1: observability sever + OS-from-secret (useSharedVpc still FALSE)
In the deploy tree, edit `cdk/lib/config.ts` **prod** block:
- `openSearchNodeFromSecret: false` → `true`
- `observabilityMetricsByName: false` → `true`
- fill the **current-live** transitional identifiers (swapped to the new names at step 9):
  - `auroraClusterIdentifier: "sps-data-prod-auroracluster23d869c0-naxambgndood"`
  - `opensearchDomainName: "opensearch58799-fquptd67j2so"`
  - `publicAlbFullName: "app/sps-public-prod/14016856c2b4f506"`
  - `publicTargetGroupFullName: "targetgroup/sps-tg-pub-prod/8522717eb2c2809d"`

`cd cdk && npm ci && npx jest -u --maxWorkers=2` (regen snapshot), commit, PR → merge on
green, then **re-detach the deploy tree on the new `origin/master`**.

### Step 5 — Deploy the sever, Observability LAST-and-exclusive
`cdk diff` each, then deploy (**each pauses for #475 approval**):
```bash
npx cdk diff Sps-App-prod --exclusively -c env=prod && npx cdk deploy Sps-App-prod --exclusively -c env=prod --require-approval never   # [#475]
npx cdk diff Sps-Etl-prod --exclusively -c env=prod && npx cdk deploy Sps-Etl-prod --exclusively -c env=prod --require-approval never   # [#475]
npx cdk diff Sps-Observability-prod --exclusively -c env=prod && npx cdk deploy Sps-Observability-prod --exclusively -c env=prod --require-approval never   # [#475]
```
This severs the Data→Observability + App→Observability cross-stack exports **before** the
Data replace (`observability-stack.ts:158-160`), so the replace won't hit "cannot update
an export in use". App/Etl now read `OPENSEARCH_NODE` from the secret (same endpoint →
byte-identical). Confirm App service steady (2/2) after.

### Step 6 — Config commit #2: flip the topology
Edit `cdk/lib/config.ts` prod block:
- `useSharedVpc: false` → `true`
- `auroraSnapshotIdentifier: "sps-data-prod-cutover-final-$STAMP"` (from step 2)

`cd cdk && npm ci && npx jest -u --maxWorkers=2`, commit, PR → merge on green → re-detach.
`assertSharedVpcConfig` now passes (prod SGs wired via #1489). **`cdk diff` EVERY stack**
and confirm: new Aurora `DatabaseClusterFromSnapshot` + fresh OS domain (new construct id)
alongside the RETAIN'd old ones; ECS cluster/service show **update** not replace; ALBs
create-before-delete (auto-named); no IAM/SG surprises.

### Step 7 — Deploy the new data tier  **[#475]**
```bash
npx cdk diff Sps-Data-prod --exclusively -c env=prod
npx cdk deploy Sps-Data-prod --exclusively -c env=prod --require-approval never   # [#475]
```
Creates the snapshot-restored cluster + fresh (empty) OS domain. Capture the **new**
cluster id, new OS domain name/endpoint, and (after step 10) the new auto-named ALB +
target-group full names from the stack outputs.

### Step 8 — Reseed DSN + OS secrets to the new endpoints (in-VPC, no local secret reads)
Reseed `scholars/prod/db/{app-rw,app-ro,etl,bootstrap,migrate}` and
`scholars/prod/opensearch/{app,etl}` `node` to the **new** cluster/domain endpoints. Prod
users are `@'%'` (carried in the restored snapshot) so **no CIDR re-grant is needed** —
only the endpoint changes. Run the reseed + `verify-grants` as in-VPC tasks:
```bash
runjs '["npm","run","db:verify-grants"]'     # golden-list check against the new cluster
```
For the DSN/OS `node` value reseeds, run a tsx task that reads the new endpoints from the
Data stack outputs (SSM/CFN) and `PutSecretValue` — never echoing values. (Template:
`@/lib/db` interop under `tsx -e` per `project_sps_prod_db_readonly_query`; writes use
`m.db.write`.)

### Step 9 — Recreate OpenSearch FGAC internal users on the fresh domain
The fresh domain's `_security` DB is empty (the one thing `search:index` does not rebuild).
**Copy the exact FGAC config from the old domain** rather than hand-author it: in an in-VPC
task, GET `_security/internalusers` + `_security/rolesmapping` from the OLD domain (master
creds) and PUT them onto the NEW domain (rotated master creds). App/Etl users keep their
existing passwords from `scholars/prod/opensearch/{app,etl}`.

### Step 10 — Reindex the new domain (app still on OLD domain)  ← builds toward the cut
```bash
runjs '["npm","run","search:index"]'
```
Verify people/publications/funding/opportunities doc counts match a fresh build (~178k+
pubs) and the alias sits on the fresh index **before** flipping `OPENSEARCH_NODE`.

---

## Phase C — App validation  **[#475]**

### Step 11 — Deploy App onto the shared VPC (auto-named ALB)
```bash
npx cdk diff Sps-App-prod --exclusively -c env=prod
npx cdk deploy Sps-App-prod --exclusively -c env=prod --require-approval never   # [#475]
```
**This is the point of no easy return** — the app now reads/writes the NEW Aurora (SOR).
Validate the new **internal** ALB directly with `X-Origin-Verify`
(`scholars/prod/edge/origin-shared-secret`); confirm app→Aurora:3306 and app→OS:443
intra-VPC; confirm one edit-flow write lands in the new cluster.

Then re-deploy Observability with the **new** Aurora/OS/ALB/TG names (swap the step-4
transitional identifiers to the post-replace values) — closes the §4 alarm-name gap.

---

## Phase D — Edge cutover (reversible in minutes)

### Step 12 — Flip OS_NODE to the new domain, then repoint the edge
After reindex verify (step 10), reseed `scholars/prod/opensearch/{app,etl}` `node` to the
**new** domain endpoint and redeploy App/Etl so the live app reads the new domain.

Repoint CloudFront's ALB origin (decouple model — SSM-param origin re-resolves to the new
public-ALB DNS). **EdgeStack manual deploy STRIPS WAF/cert/alias without all context
flags** — pass them and `--strict` diff first (must show ONLY the origin/SSM-param change,
no WAF/cert/alias delta):
```bash
npx cdk diff Sps-Edge-prod --exclusively --strict -c env=prod \
  -c edgeCustomDomain=scholars.weill.cornell.edu \
  -c edgeCertArn=arn:aws:acm:us-east-1:665083158573:certificate/95f77e69-4abc-4d2c-b081-b8b5b8572fd6 \
  -c edgeAllowedCidrs=140.251.0.0/16,157.139.0.0/16
# if the diff shows any WAF/cert/alias removal → STOP (wrong context)
npx cdk deploy Sps-Edge-prod --exclusively -c env=prod \
  -c edgeCustomDomain=scholars.weill.cornell.edu \
  -c edgeCertArn=arn:aws:acm:us-east-1:665083158573:certificate/95f77e69-4abc-4d2c-b081-b8b5b8572fd6 \
  -c edgeAllowedCidrs=140.251.0.0/16,157.139.0.0/16
```
Re-assert `https://scholars.weill.cornell.edu/` 200 through CloudFront.

---

## Phase E — ETL cutover + lift freeze

### Step 13 — ETL onto the shared VPC  **[#475]**
```bash
npx cdk deploy Sps-Etl-prod --exclusively -c env=prod --require-approval never   # [#475]
```
Re-enable the prod cadences **on the new tier** only after a clean manual run:
`aws events enable-rule --name sps-reconcile-prod` (+ cdn-reconcile). Leave the nightly
disabled until a manual `search:index` + one supervised nightly pass (matches prod's
`etlSchedulesEnabled:false` operator-driven policy).

### Step 14 — Confirm exports drained
```bash
aws cloudformation list-imports --export-name <old Data/App export> 2>&1   # expect: no exports / empty
```

### Step 15 — Lift the write-freeze
Resume normal operation. Prod is now on the shared VPC.

---

## Phase F — soak (days, reversible; old estate RETAIN'd)

- [ ] ≥1 full nightly + weekly cycle clean on the new tier.
- [ ] Search freshness after a cadence run; an edit write lands in the new cluster.
- [ ] ALB 5xx/latency + ENI/EIP headroom nominal.
- [ ] Row-count/checksum parity old↔new Aurora for the app-SOR tables (center membership,
      curated org-unit/methods-tools, `scholars_audit.manual_edit_audit`).
- [ ] The **staging-SG → prod-datastore refused** isolation probe passes (per-env SG isolation).

## Phase G — decommission (NOT reversible; only after F passes)

- [ ] 35-day recovery-point retention observed before any teardown (prod policy).
- [ ] Take a final OLD-cluster snapshot; disable deletion protection on the OLD cluster;
      delete OLD Aurora + OLD OS domain **before** the VPC.
- [ ] Flip/tear down `Sps-Network-prod` (old `10.10.0.0/16`) **LAST** — the rollback anchor.
- [ ] Rotate `scholars/prod/opensearch/master` again if the OLD domain outlived the leak window.

---

## Rollback

- **Steps 1–9:** delete the new stacks; the old estate is untouched + serving. Zero user impact.
- **Steps 12 (edge):** re-deploy `Sps-Edge-prod` with the origin SSM param pointed back at
  the old ALB DNS (minutes).
- **After step 11 (App cut):** no easy rollback — the new Aurora is SOR. The write-freeze
  (steps 2→15) is the mitigation; the final old snapshot + RETAIN'd old cluster/domain are
  the only recovery path.

## #475 approval gates (count: 5–7 `cdk deploy Sps-*-prod`)
Step 5 (App, Etl, Observability) · Step 7 (Data) · Step 11 (App) · Step 13 (Etl) · plus the
step-11 Observability re-deploy and the step-12 Edge deploy. Each **pauses for the prod
reviewer approval** — the operator must approve in GitHub as each runs.
