# VIVO dormant-resource cleanup — runbook & handoff

**For:** Eliza
**Tracks:** issue #945 (VIVO teardown plan) · related: #506 (go-live critical path)
**AWS account:** `665083158573` · **Region:** `us-east-1`
**Audited:** 2026-06-13 (read-only; nothing has been deleted yet)

## TL;DR

VIVO's two MySQL databases (`vivo-qa`, `vivo-dev`) are **already deleted** — there is nothing to terminate, and the July-31 MySQL-EOL notice for `db:vivo-qa` is moot. What remains in this account is a mix of (A) leftover backups, (B) dormant Kubernetes/EBS resources, and (C) the **still-live** VIVO EC2 box that must stay up until the SPS cutover + soak.

Cleanup is split into two tiers:

- **Tier 1 — safe to run now.** Isolated leftovers of already-deleted DBs. Touches no live or shared resource. Each step keeps a restorable archive.
- **Tier 2 — defer / do carefully.** The dormant EKS `vivo`/`vivo-fuseki` workloads are entangled with **live ReCiter prod** (they share one Ingress and one ALB) and with a **shared AWS Backup selection** (covering 14 live volumes). Reversible, but not a blind run, and **not required before cutover.**

**None of this affects VIVO cutover or rollback** — live VIVO is the EC2 box (`vits-vivod01`), which no step here touches.

> ⚠️ **Re-verify before deleting.** This was captured 2026-06-13. Run each tier's pre-flight check first; resource state may have changed.



## Inventory (what's in the account)

### A. Already deleted — backups only

| Resource | Note |
|---|---|
| RDS `vivo-qa` (MySQL 8.0.44) | Deleted ~2026-04-24. Snapshots: `vivo-qa-snapshot`, `vivo-qa-snapshot-final`, `vivo-qa-snapshot-encrypted` (3 × 150 GB, redundant copies) |
| RDS `vivo-dev` (MySQL 8.0.25) | Deleted 2025-06-09. Snapshot: `vivo-dev-final-snapshot-encrypted` (100 GB) |

### B. Dormant — cleanup candidates (see Tier 1 / Tier 2)

| Resource | Status |
|---|---|
| EKS `reciter` ns: `deployment/vivo` | **0/0** replicas, ~5 yr |
| EKS `reciter` ns: `deployment/vivo-fuseki` | **0/0** replicas, ~4 yr |
| Services `vivo`, `vivo-fuseki` (ns `reciter`) | Route to 0 pods |
| Target groups `k8s-reciter-vivo-5543b5659e`, `k8s-reciter-vivofuse-288ab86edc` | 0 registered targets; **share ALB `k8s-reciter-reciterm-5781d5ecb2` with ReCiter Manager** |
| EBS `vol-0ef870455f11748a5` = PVC `vivo-fuseki-tdb-pvc` (100 GB) | **detached / `available` since 2021**; PVC still `Bound` |
| Latest Fuseki snapshot `snap-095289426be03158f` | `completed` 2026-06-12 — the restorable archive |
| Old one-off EBS snapshots | `snap-09ba65801ec3a4e20` (`vivo-fuseki-snapshot`, 2021-09-09), `snap-0d240df861009feb8` (`vivo-dev-snapshot`, 2021-10-14) |
| RDS parameter groups `vivo-aurora-parameter-group`, `vivo-parameter-group` | Unused (no instance references them) |

### C. LIVE — do **NOT** remove until SPS cutover + soak (#945)

| Resource | Note |
|---|---|
| EC2 `i-0bbed3def0c0b36f0` `vits-vivod01.cc.weill.cornell.edu` | Running since 2020, t3a.xlarge, ReCiter `10.46` VPC |
| `vivo-root-volume` `vol-00d86c0c450aa1fc1` | Root disk of the above (`/dev/sda1`, attached) |
| `vivo-dev-public-alb` (internet-facing) + `vivo-dev-tg` | EC2 is a **healthy** target |
| `vivo-dev-private-alb` (internal) + `vivo-dev-private-tg` | EC2 is a **healthy** target |
| CloudFront `E3N4EJVPDF4QYN` → `vivo-dev.weill.cornell.edu` | → internal private ALB → EC2 |
| Security groups `vivo-sg`, `vivo-public-sg`, `vivo-private-sg` | In use by the EC2 box / ALBs |



## Two findings that shaped the plan (read before running)

1. **The daily Fuseki backups are NOT tag-driven.** AWS Backup plan `EBS-Daily-Backup-Plan` (`4e18fa03-6596-4056-a898-322ffaaaf150`), selection `AssignDailyEBSVolBkup` (`5a922046-dd42-4626-a996-98f75e246c3c`), selects by an **explicit list of 15 volume ARNs** (`ListOfTags` is empty). That list includes both the dead Fuseki volume **and the live VIVO EC2 root volume** `vol-00d86c0c450aa1fc1`. Removing a `Backup=true` tag does nothing. Since the Fuseki volume is detached/static, its daily incrementals are ~0 bytes — **not worth touching the selection.**

2. **The EKS vivo services live inside the live ReCiter-prod Ingress.** They are 3 rules in `reciter-main-ing` (ns `reciter`), which also serves `reciter.weill.cornell.edu`:
   - host `vivo-qa.weill.cornell.edu` `/*` → svc `vivo`
   - host `vivo-dev.weill.cornell.edu` `/*` → svc `vivo`
   - host `reciter-dev.weill.cornell.edu` `/fuseki*` → svc `vivo-fuseki`

   All three point at the 0-target services, so they serve nothing — but removing them is an **edit to a production ingress**, not an isolated delete.



## Tier 1 — safe to run now

Isolated leftovers of already-deleted DBs. No live/shared resource touched. Each step keeps a restorable archive.

```bash
R=us-east-1

# ACCOUNT GUARD — REQUIRED. AWS creds are live in the shell and this is a
# multi-account environment; every delete below is irreversible. Abort unless
# the shell is actually pointed at the SPS/ReCiter account. (Optionally pin
# AWS_PROFILE to the 665083158573 profile instead of relying on the default chain.)
[ "$(aws sts get-caller-identity --query Account --output text)" = "665083158573" ] \
  || { echo "WRONG AWS ACCOUNT — aborting"; exit 1; }

# Pre-flight: confirm the archives we KEEP exist & are usable BEFORE deleting anything.
aws rds describe-db-snapshots --region $R \
  --query "DBSnapshots[?DBSnapshotIdentifier=='vivo-qa-snapshot-encrypted' || DBSnapshotIdentifier=='vivo-dev-final-snapshot-encrypted'].{Id:DBSnapshotIdentifier,Status:Status,GB:AllocatedStorage}" \
  --output table

# 1a. RDS: keep ONE encrypted snapshot per DB
#     (vivo-qa-snapshot-encrypted, vivo-dev-final-snapshot-encrypted);
#     delete the two redundant vivo-qa copies (~300 GB).
aws rds delete-db-snapshot --region $R --db-snapshot-identifier vivo-qa-snapshot
aws rds delete-db-snapshot --region $R --db-snapshot-identifier vivo-qa-snapshot-final

# 1b. Stale 2021 one-off EBS snapshots (superseded).
aws ec2 delete-snapshot --region $R --snapshot-id snap-09ba65801ec3a4e20   # vivo-fuseki-snapshot 2021-09-09
aws ec2 delete-snapshot --region $R --snapshot-id snap-0d240df861009feb8   # vivo-dev-snapshot   2021-10-14

# 1c. Unused RDS parameter groups (both vivo DBs deleted; delete fails safe / no-ops if in use).
aws rds delete-db-parameter-group --region $R --db-parameter-group-name vivo-parameter-group
aws rds delete-db-parameter-group --region $R --db-parameter-group-name vivo-aurora-parameter-group

# POST-DELETE VERIFICATION — run before closing the loop:
#   (a) exactly the two KEPT encrypted snapshots remain, both 'available';
aws rds describe-db-snapshots --region $R \
  --query "DBSnapshots[?contains(DBSnapshotIdentifier,'vivo')].{Id:DBSnapshotIdentifier,Status:Status}" \
  --output table   # expect ONLY vivo-qa-snapshot-encrypted + vivo-dev-final-snapshot-encrypted
#   (b) the Fuseki EBS archive is still intact;
aws ec2 describe-snapshots --region $R --snapshot-ids snap-095289426be03158f \
  --query 'Snapshots[].{Id:SnapshotId,State:State}' --output table   # expect 'completed'
#   (c) next day: confirm the EBS-Daily-Backup-Plan job still completes cleanly.
```

**Why this is safe:** leftovers of **already-deleted** DBs, referenced by nothing live; you retain one encrypted snapshot of each VIVO MySQL DB (preserves the #945 Phase-0 archive); param-group deletes fail safe if somehow in use. To keep a different `vivo-qa` copy than `-encrypted`, swap which two IDs you delete.

**Restore paths (if ever needed):** RDS — `aws rds restore-db-instance-from-db-snapshot --db-instance-identifier <new-id> --db-snapshot-identifier vivo-qa-snapshot-encrypted`; EBS — `aws ec2 create-volume --availability-zone <az> --snapshot-id snap-095289426be03158f`.



## Tier 2 — defer / do carefully (NOT cutover-gating)

Deleting the dormant EKS `vivo`/`vivo-fuseki` workloads requires editing the live `reciter-main-ing` ingress. Reversible (back it up first), but should be done by the ReCiter EKS operator, ideally in a quiet window. There is **zero cutover urgency** to this.

```bash
# ACCOUNT + CLUSTER GUARD — REQUIRED (this tier edits a PROD ingress).
[ "$(aws sts get-caller-identity --query Account --output text)" = "665083158573" ] \
  || { echo "WRONG AWS ACCOUNT — aborting"; exit 1; }
kubectl config current-context   # ASSERT: the ReCiter prod EKS cluster — stop if anything else

# Pre-flight: confirm still dormant.
kubectl get deploy vivo vivo-fuseki -n reciter           # expect 0/0
aws ec2 describe-volumes --region us-east-1 --volume-ids vol-0ef870455f11748a5 \
  --query 'Volumes[].{State:State,Attachments:Attachments}' --output json   # expect available / []

# A. Back up the live ingress FIRST (recovery path).
kubectl get ingress reciter-main-ing -n reciter -o yaml > reciter-main-ing.backup.yaml

# B. Edit OUT only the three vivo rules, then REVIEW the diff before applying:
#      - host vivo-qa.weill.cornell.edu   (-> svc vivo)
#      - host vivo-dev.weill.cornell.edu  (-> svc vivo)
#      - path /fuseki* under reciter-dev.weill.cornell.edu (-> svc vivo-fuseki)
#    Leave every reciter.* / reciter-consumer.* rule untouched.
cp reciter-main-ing.backup.yaml reciter-main-ing.edit.yaml   # hand-edit this copy
diff -u reciter-main-ing.backup.yaml reciter-main-ing.edit.yaml   # eyeball: ONLY vivo rules removed
kubectl apply -f reciter-main-ing.edit.yaml

# C. Confirm the controller dropped the vivo target groups AND ReCiter still serves,
#    THEN delete the now-unreferenced workloads.
kubectl delete deploy vivo vivo-fuseki -n reciter
kubectl delete svc    vivo vivo-fuseki -n reciter
kubectl delete pvc    vivo-fuseki-tdb-pvc -n reciter

# D. Delete the detached volume (archive snapshot snap-095289426be03158f is 'completed').
aws ec2 delete-volume --region us-east-1 --volume-id vol-0ef870455f11748a5
```

**Backup-selection cleanup (separate, deliberate):** after the volume is deleted, its ARN (`vol-0ef870455f11748a5`) still sits in selection `AssignDailyEBSVolBkup`. AWS Backup has no update API — removing it means delete + recreate of a selection covering **14 live volumes**, so an infra owner should do this carefully and out of band. Until then the daily job logs a harmless "resource not found" for the deleted volume.

**Rollback for Tier 2:** `kubectl apply -f reciter-main-ing.backup.yaml` restores the ingress; the Fuseki data is recoverable from `snap-095289426be03158f` (restore to a new volume) if ever needed.



## Do NOT touch (live VIVO serving path)

Everything in inventory section **C**. Per #945, the EC2 box and its `vivo-dev` ALBs / CloudFront / security groups stay up as the rollback fallback until the SPS cutover + soak completes.



## Phase-3 BLOCKER — resolve with WCM ITS/networking BEFORE any EC2/ALB/CloudFront teardown

**This is a blocking prerequisite for Phase 3 (tracked on #945), not a footnote.** Prod `vivo.weill.cornell.edu` resolves to CloudFront `d3t1ivz9l0ys5g`, which is **not in this account** — prod VIVO's edge is external/on-prem. The `vivo-dev`-named EC2 stack is likely its **origin** (the EC2 box is a healthy target on the internet-facing `vivo-dev-public-alb`), i.e. the "dev"-named stack may be serving prod. Confirm the actual origin mapping with WCM ITS / networking before assuming anything in section C is non-prod. Moot for Tier 1/Tier 2 (they don't touch section C) — but no Phase-3 EC2/ALB/CloudFront delete may run until this is answered in writing on #945.
