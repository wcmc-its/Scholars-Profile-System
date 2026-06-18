# On-prem ED export runbook — email-visibility bridge (#443)

## What this is

For most of the project's life the Sps application VPCs (`Sps-Network-staging`
10.20.0.0/16, `Sps-Network-prod` 10.10.0.0/16) had **no route to on-prem WCM
resources**. The nightly `etl:ed` Enterprise-Directory sync reaches the WCM LDAP
host `edprovider.weill.cornell.edu:636`, which is on-prem-only — so any ETL step
that needed live LDAP timed out (#443). The workaround for the
`Scholar.emailVisibility` field was an **S3 bridge**: an operator ran
`etl:ed:export-email-visibility` from a laptop on the WCM network (LDAP → NDJSON
on S3) and the in-VPC `etl:ed:import-email-visibility` read it back into Aurora.

WCM networking has since created two **TGW-attached VPCs** that *do* reach
on-prem, so the export half can finally run unattended in AWS. This bridge
automates it.

| Env | On-prem VPC | VPC id | Private app subnets |
|-----|-------------|--------|---------------------|
| staging | `scholars-dev` (10.46.231.0/24) | `vpc-02c4dd698f3e3869c` | `subnet-08cab06d3084fba41` (1a), `subnet-07ffed73356c01f6c` (1b) |
| prod | `scholars-prod` (10.46.230.0/24) | `vpc-0b8006fee120df6bc` | `subnet-069dc77801ee2d8f3` (1a), `subnet-0ceec7bb2f059e162` (1b) |

Each VPC's private `app` subnets route `140.251/16`, `157.139/16`, `10/8` to the
on-prem Transit Gateway and `0.0.0.0/0` to a NAT gateway, and RAM-shared Route 53
Resolver rules forward `weill.cornell.edu` / `med.cornell.edu` / `wcmc-ad.net`
DNS to the on-prem resolvers (140.251.3.123 / 157.139.3.101). The public `dmz`
subnets do **not** carry the TGW route — on-prem-touching tasks must use the
`*-pri-*-app` subnets.

### Reachability — verified 2026-06-18

- **Network layer** (both VPCs): a throwaway Fargate probe in each VPC's app
  subnet resolved `edprovider.weill.cornell.edu` → `10.63.215.108` and TCP
  connected to `:636` in ~10 ms.
- **Application layer** (scholars-dev): the real ETL image ran
  `npm run etl:ed:admins:probe`, which does a live LDAPS `bind()` (TLS + cert
  validation) and a paged search — it bound and returned **2440 org-unit
  entries**. End-to-end confirmed.

## Architecture

A two-step Step Functions state machine (`scholars-ed-email-visibility-<env>`),
fired weekly by an EventBridge rule:

```
export  (npm run etl:ed:export-email-visibility)   ENI in <on-prem VPC> app subnets
        reads WCM LDAP :636 → writes NDJSON to
        s3://wcmc-reciterai-artifacts/ed/email-visibility/bridge.ndjson
   │  (Catch → SNS etl-failures-<env> + Fail; import never runs on a stale file)
   ▼
import  (npm run etl:ed:import-email-visibility)    ENI in the Sps VPC (PRIVATE_WITH_EGRESS)
        reads the NDJSON → writes Scholar.emailVisibility in Aurora
```

Both steps run the **shared ETL task def** (`sps-etl-<env>`, same image + injected
`SCHOLARS_LDAP_*` / `DATABASE_URL` secrets). The only per-step differences are the
container `command` and the network placement — ECS puts the awsvpc ENI in
whatever subnets the network config names, independent of the cluster's own VPC,
so the export can land in the on-prem VPC while launching on the Sps cluster.
The export writes via the task role's IAM credentials; the role carries a narrow
`s3:PutObject` grant scoped to `wcmc-reciterai-artifacts/ed/*` (it already had
`s3:GetObject` for the import).

- **Schedule:** weekly, Sunday 05:00 UTC (release codes change slowly; ahead of
  the 06:00 backup / 07:00 nightly / 08:00 weekly cadences).
- **Alarm:** `sps-ed-email-visibility-cadence-<env>` — fires if no execution
  starts in a trailing 7-day window (silent schedule death / IAM gap). Per-step
  failures already notify via the Catch above.

## Gating

The whole bridge is **creation-gated** on `edEmailVisibilityBridgeEnabled`
(`cdk/lib/config.ts`), mirroring `curationBackupScheduleEnabled`:

- **staging:** `true` — built + scheduled (the on-prem path is proven there).
- **prod:** `false` — nothing is created (no SG in scholars-prod, no state
  machine, no `ed/*` PutObject grant) until the prod path is verified and the
  flag flips.

## Activating on staging

The ETL stack deploy is operator-gated (`reciter` is AccessDenied on the ETL
deploy role; CD only rolls the image, not stack resources). An operator runs:

```
cd cdk
npx cdk diff  Sps-Etl-staging -c env=staging   # confirm: new SM + rule + SG + alarm + ed/* PutObject
npx cdk deploy Sps-Etl-staging -c env=staging
```

Then verify:

```
# Fire it on demand (don't wait for Sunday):
aws stepfunctions start-execution \
  --state-machine-arn <EdEmailVisibilityBridgeStateMachineArn output> \
  --input '{}'

# Watch both steps:
aws logs tail /aws/states/ed-email-visibility-staging --follow
# Export step logs land in /aws/ecs/sps-etl-staging (streamPrefix etl).

# Confirm the artifact refreshed:
aws s3 ls s3://wcmc-reciterai-artifacts/ed/email-visibility/bridge.ndjson

# Spot-check a scholar's emailVisibility in the app after the import step.
```

To start only the import half (S3 already fresh):
`--input '{"startFrom":"EdEmailVisibilityImport"}'`.

## Activating on prod

1. **Verify the scholars-prod path** the same way staging was proven — run a
   one-off probe in `scholars-prod` (`subnet-069dc77801ee2d8f3` + the VPC default
   SG): `aws ecs run-task --cluster sps-cluster-prod --task-definition sps-etl-prod
   --network-configuration '{...scholars-prod app subnet...}' --overrides
   '{command: ["npm","run","etl:ed:admins:probe"]}'`. Expect a successful LDAPS
   bind + org-unit search. (Network reachability for scholars-prod was confirmed
   2026-06-18; this re-confirms the app-layer bind from prod.)
2. **Flip the flag** — `edEmailVisibilityBridgeEnabled: true` in the `prod` block
   of `cdk/lib/config.ts`.
3. **Deploy** — `npx cdk diff Sps-Etl-prod -c env=prod` (confirm it *adds* the SM
   + rule + SG + alarm + ed/* PutObject and changes nothing else), then
   `npx cdk deploy Sps-Etl-prod -c env=prod`.
4. **Verify** as on staging, against the prod state machine ARN.

## Notes / future

- This bridge covers `emailVisibility` only. The full `etl:ed` ED sync still
  needs **both** LDAP and the Aurora DB; the new VPC reaches LDAP but not the Sps
  RDS, so running the whole sync there would require VPC-peering scholars-dev/prod
  ↔ the Sps VPC (or relocating the DB). The export→S3→import split keeps the DB
  write in the Sps VPC and needs no peering.
- Sibling WCM-side exports (`ed/*` steward-names, `mentoring/*`, `citations/*`)
  follow the same shape and could move into this VPC the same way if/when they
  warrant automation.
