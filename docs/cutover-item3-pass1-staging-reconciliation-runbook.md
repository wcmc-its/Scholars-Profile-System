# Item-3 Pass-1 — Staging CDK Reconciliation Runbook

**Status:** DRAFT / operator-executable. Authored 2026-07-01.
**Goal:** land item-3 **pass-1** (the `/sps/staging/{net,app}/*` SSM params) on staging so pass-2a/2b consumers can deploy — *without* an origin outage from the drift bundled into the same stacks.
**Creds:** the deploy steps need write creds. The read-only `user/reciter` creds in the session shell can run every **verify** step but **no `deploy`/`disassociate`/`authorize` step**. Operator runs the mutating steps.
**Working dir for all `cdk`:** `~/worktrees/sps-deploy/cdk` (detached at `origin/master` `9a0dca02`; `npm ci` already run).

---

## 0. Why this isn't a plain `cdk deploy`

Two pre-existing, un-deployed drifts ride in the same two stacks as pass-1. A naive `cdk deploy --exclusively Sps-Network-staging` hits both.

**Drift A — resolver-rule collision (currently a safety latch).** 3 WCM resolver rules are already associated to `vpc-04f5b7f7979245d77` out-of-band; Network's `WcmResolverAssoc*` try to re-create the same bindings → `RSLVR-00704 AlreadyExists` → whole Network deploy rolls back. That rollback is the only reason drift B hasn't fired.

| CDK logical id | existing assoc id | resolver rule id |
|---|---|---|
| `WcmResolverAssocWeillCornellEdu` | `rslvr-rrassoc-79e757fd013452b82` | `rslvr-rr-58457e95d34548148` |
| `WcmResolverAssocMedCornellEdu` | `rslvr-rrassoc-e6b969ad4c1d42e5b` | `rslvr-rr-467f0939c1f2458e9` |
| `WcmResolverAssocWcmcAdNet` | `rslvr-rrassoc-7586ebe09fb1422da` | `rslvr-rr-56f32331b3a1441ba` |

**Drift B — double-owned public-ALB `:80` rule (the real hazard).** ALB SG `sg-069a25838bdda75ce` has exactly one ingress: `sgr-0d75b0d11b3890c49` = `tcp/80 0.0.0.0/0`, desc `"Allow from anyone on port 80"`. That physical rule is claimed by **both**:
- App `PublicAlbIngressFromInternet` (`app-stack.ts:894`) — reported `CREATE_COMPLETE`, physical id `sgr-0d75b0d11b3890c49`; and
- the deployed **Network** template's inline ingress on `AlbSecurityGroup` — which master removes (`network-stack.ts:131` SGs are now bare), so `cdk diff` shows `[-]` on it.

Deploying Network deletes its inline rule → **deletes the live `:80` rule App depends on** → CloudFront origin (HTTP:80) unreachable, and App's stack left pointing at a deleted resource. Master also *changes the rule's description*, so the follow-up App deploy will try to modify a rule that no longer exists.

**Ruling:** rehearse on cloned stacks first (the mandated dry-run gate). Do not hand-execute against live staging until §2 passes and §3.0 confirms ownership.

### 0.1 Dry-run findings (verified 2026-07-01, read-only diff + reversible SSM seed)
Ran `cdk diff` on Network + App and re-ran App with `/sps/staging/net/{alb,app,etl}-sg-id` seeded to the current standalone SG ids (`sg-069a25838bdda75ce` / `sg-0e9f5358a40c016a5` / `sg-09b494047547ea148`), then deleted the params. Results:
- **No stateful resource replaces** — Aurora, OpenSearch, the ALB, target groups, and the ECS **service** all show in-place `[~]` (SG refs flip `Fn::ImportValue`→`Ref`(SSM), modifiable in place). Confirmed safe.
- **`AppIngressFromPublicAlb` / `AppIngressFromInternalAlb`** (app `:3000`): seeding downgraded them `requires replacement`→`may be replaced` (Conditional). With pass-1 deployed first they resolve **in-place**. Benign ordering artifacts.
- ⚠️ **`PublicAlbIngressFromInternet` (public `:80`) stays a HARD `requires replacement`** even with the param seeded — CFN-certain. The physical rule's description (`"Allow from anyone on port 80"`, created by Network's inline) ≠ App's template desc, so App **deletes-and-recreates the `:80` rule** on deploy → **unavoidable brief origin gap unless §5 bridge is pre-staged.** This is drift B made concrete; it is NOT a pass-1 ordering artifact.
- `AppTaskDefinition` replace = normal new revision (env churn).
Conclusion: the pass-1+2a+2b staging deploy is well-characterized. Only real hazard = the `:80` recreate gap → **run §5 bridge even on staging.** The export-lock (pass-2's raison d'être) is untested here — it is a pass-2c/pass-3 concern, needs the full cloned rehearsal before those.

---

## 1. Read-only assessment (safe, run anytime — read-only creds OK)

```bash
cd ~/worktrees/sps-deploy/cdk
aws sts get-caller-identity --query '{acct:Account,arn:Arn}'          # expect 665083158573 / us-east-1

# 1a. Full drift, ALL staging stacks — do NOT flush anything you haven't read.
for S in Sps-Network-staging Sps-App-staging Sps-Data-staging Sps-Etl-staging Sps-Edge-staging; do
  echo "===== $S ====="; npx cdk diff --exclusively "$S" -c env=staging 2>&1 | tee /tmp/diff-$S.txt
done
```
**Abort if** any diff shows a resource **replacement** (`[-]/[+]` on a stateful resource: Aurora, OpenSearch, ECS service, ALB, target group, DBSubnetGroup) or any removal you can't explain. Expected Network changes only: 3 resolver assocs `[+]`, 10 `Net-*` SSM `[+]`, 1 `AlbSecurityGroup` inline-`:80` `[-]`. Expected App changes: `PublicAlbIngressFromInternet` description update + pass-2a SG-import rewiring (no replacement).

```bash
# 1b. Baseline the live rule + SSM emptiness (for the after/before compare).
aws ec2 describe-security-group-rules --filters Name=group-id,Values=sg-069a25838bdda75ce \
  --query 'SecurityGroupRules[?IsEgress==`false`].{id:SecurityGroupRuleId,proto:IpProtocol,from:FromPort,cidr:CidrIpv4,src:ReferencedGroupInfo.GroupId,desc:Description}'
aws ssm get-parameters-by-path --path /sps/staging --recursive --query 'length(Parameters)'   # expect 0 today
aws route53resolver list-resolver-rule-associations \
  --query "ResolverRuleAssociations[?VPCId=='vpc-04f5b7f7979245d77'].{name:Name,assoc:Id,status:Status}" --output table
```

---

## 2. Cloned-stack dry-run (the gate — do this before §3)

Rehearse the full sequence on throwaway copies so the deploy-time behaviors (export-lock, the `:80` delete, resolver create) are observed, not guessed.

1. Deploy clones of `Sps-Network`/`Sps-App` under a `-dryrun` suffix into a scratch VPC (or a copy of `vpc-04f5b7f7979245d77`), seeded to mirror the drift: Network clone with the inline `:80`, App clone owning the same rule via import.
2. Run §3.1 → §3.3 against the clones.
3. **Pass criteria:**
   - `aws cloudformation list-imports --export-name <each pinned export>` returns **0** in-use importers at the point pass-2 would flip (proves the export-lock is severed).
   - No stack ever enters `UPDATE_ROLLBACK_*`.
   - After the sequence, the clone ALB SG ends with exactly one `:80 0.0.0.0/0` rule **and** the app `:3000`-from-ALB rules, owned solely by the App clone.
   - The origin-reachability check (§3.3) passes on the clone.
4. Only if all four hold, proceed to §3 on live staging in a maintenance window. Record the observed `:80` gap duration from the clone — that is your live blast radius.

> If cloning is not feasible before the window, the fallback is §3 executed with the §3.4 emergency-restore command staged in a second terminal, accepting a real (short) staging origin gap. This is *not* the recommended path.

---

## 3. Live staging execution (maintenance window; write creds)

### 3.0 Confirm `:80` ownership before you touch anything
```bash
# Which stack's state actually owns sgr-0d75b0d11b3890c49?
aws cloudformation describe-stack-resources --stack-name Sps-App-staging \
  --logical-resource-id PublicAlbIngressFromInternet \
  --query 'StackResources[0].{logical:LogicalResourceId,physical:PhysicalResourceId,status:ResourceStatus}'
```
If `physical == sgr-0d75b0d11b3890c49` (double-owned, as observed 2026-07-01): expect Network's deploy to **delete** it. The App redeploy in §3.2 recreates it — the window between is your gap. Keep §3.4 ready.

### 3.1 Resolve the resolver collision, then deploy Network
```bash
# Remove the 3 manual associations so Network can create its own (brief WCM-DNS gap on the VPC —
# run OUTSIDE the nightly ETL window; the app only resolves WCM names on LDAP/source calls).
for R in rslvr-rr-58457e95d34548148 rslvr-rr-467f0939c1f2458e9 rslvr-rr-56f32331b3a1441ba; do
  aws route53resolver disassociate-resolver-rule --resolver-rule-id "$R" --vpc-id vpc-04f5b7f7979245d77
done
# wait for DELETING→gone
aws route53resolver list-resolver-rule-associations \
  --query "length(ResolverRuleAssociations[?VPCId=='vpc-04f5b7f7979245d77' && starts_with(Name,'sps_')])"   # expect 0

# Deploy Network + App TOGETHER (dependency order Network→App), pre-reviewed in §1a so --require-approval never
# keeps the Network→App window tight. This is the moment the :80 rule is deleted (Network) then recreated (App).
npx cdk deploy Sps-Network-staging Sps-App-staging -c env=staging --require-approval never --concurrency 1
```

### 3.2 (only if you split the deploy) restore `:80` immediately after Network
If you deploy Network alone, run App the instant it finishes — every second is origin-down:
```bash
npx cdk deploy Sps-App-staging -c env=staging --require-approval never
```

### 3.3 Verify (read-only creds OK)
```bash
# Stacks healthy
for S in Sps-Network-staging Sps-App-staging; do
  aws cloudformation describe-stacks --stack-name $S --query 'Stacks[0].StackStatus'; done   # both UPDATE_COMPLETE

# :80 restored + app :3000 rules present, owned by App now
aws ec2 describe-security-group-rules --filters Name=group-id,Values=sg-069a25838bdda75ce \
  --query 'SecurityGroupRules[?IsEgress==`false`].{id:SecurityGroupRuleId,from:FromPort,cidr:CidrIpv4,src:ReferencedGroupInfo.GroupId,desc:Description}'

# pass-1 params now exist: 10 net + 3 app
aws ssm get-parameters-by-path --path /sps/staging/net --query 'Parameters[].Name' --output text
aws ssm get-parameters-by-path --path /sps/staging/app --query 'Parameters[].Name' --output text

# resolver assocs re-created + COMPLETE
aws route53resolver list-resolver-rule-associations \
  --query "ResolverRuleAssociations[?VPCId=='vpc-04f5b7f7979245d77'].{name:Name,status:Status}" --output table

# origin actually serving — public target group healthy
aws elbv2 describe-target-health \
  --target-group-arn arn:aws:elasticloadbalancing:us-east-1:665083158573:targetgroup/sps-tg-pub-staging/868dd91764c030a7 \
  --query 'TargetHealthDescriptions[].TargetHealth.State'                                   # expect ["healthy"...]
curl -4 -s -o /dev/null -w '%{http_code}\n' https://<staging-host>/                          # expect 200/3xx
```

### 3.4 EMERGENCY — origin down mid-window
If §3.3 shows `:80` missing / target group unreachable, restore instantly (does not wait on CDK):
```bash
aws ec2 authorize-security-group-ingress --group-id sg-069a25838bdda75ce \
  --protocol tcp --port 80 --cidr 0.0.0.0/0
```
Then finish the App deploy to hand ownership back to CFN. If Network itself failed, it auto-rolls-back and restores the inline `:80` — do not fight it; let the rollback finish, then investigate.
If the resolver disassociate ran but Network never deployed, re-associate to restore WCM DNS:
```bash
for R in rslvr-rr-58457e95d34548148 rslvr-rr-467f0939c1f2458e9 rslvr-rr-56f32331b3a1441ba; do
  aws route53resolver associate-resolver-rule --resolver-rule-id "$R" --vpc-id vpc-04f5b7f7979245d77 --name restore-$R
done
```

---

## 4. After pass-1 lands — pass-2 consumers (separate follow-up)
Only once §3.3 confirms the 13 SSM params exist:
```bash
npx cdk diff   --exclusively Sps-Data-staging -c env=staging   # review, then deploy
npx cdk deploy --exclusively Sps-Data-staging -c env=staging
npx cdk diff   --exclusively Sps-Etl-staging  -c env=staging
npx cdk deploy --exclusively Sps-Etl-staging  -c env=staging
# Edge (pass-2b origin) NEVER bare — needs --strict + the 3 context flags or it strips WAF/cert/alias:
npx cdk diff --strict Sps-Edge-staging -c env=staging \
  -c edgeCustomDomain=<...> -c edgeCertArn=<...> -c edgeAllowedCidrs=<...>
```

## 5. Zero-gap `:80` bridge (RECOMMENDED — §0.1 confirmed the `:80` rule replaces; mandatory for PROD)
To eliminate the origin gap entirely, pre-stage a covering pair that isn't a duplicate of `0.0.0.0/0`, do the swap, then remove it:
```bash
# before Network deploy — two halves cover all IPv4 without duplicating the 0.0.0.0/0 rule
aws ec2 authorize-security-group-ingress --group-id sg-069a25838bdda75ce --ip-permissions \
  'IpProtocol=tcp,FromPort=80,ToPort=80,IpRanges=[{CidrIp=0.0.0.0/1,Description=bridge},{CidrIp=128.0.0.0/1,Description=bridge}]'
# ... run §3.1 Network+App (the 0.0.0.0/0 rule churns underneath but :80 stays open via the bridge) ...
# after §3.3 confirms App owns 0.0.0.0/0 again — remove the bridge
aws ec2 revoke-security-group-ingress --group-id sg-069a25838bdda75ce --ip-permissions \
  'IpProtocol=tcp,FromPort=80,ToPort=80,IpRanges=[{CidrIp=0.0.0.0/1},{CidrIp=128.0.0.0/1}]'
```
Mandatory before the prod equivalent of this reconciliation.
