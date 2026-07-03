# ETL on-prem / cross-VPC connectivity gap (daily ETL blocked)

**Status:** BLOCKED on networking. Request emailed to Fabrice (networking) **2026-06-18**, awaiting the TGW attach. Tracked on issue #443 ("Run ETL pipelines" task).

## Problem

The staging nightly ETL (`scholars-nightly-staging`, EventBridge `cron(0 7 * * ? *)`, enabled) has failed at its first step (`etl:ed`) every night for 8+ days and aborts the whole cascade (`ExecutionFailed: "Ed failed"`). So effectively no ETL steps complete on staging. Prod ETL schedules are off (`etlSchedulesEnabled: false`), so prod isn't failing, but it has the same gap.

**Root cause:** the ETL runs in the Sps VPCs (`Sps-Network-staging` 10.20.0.0/16, `vpc-04f5b7f7979245d77` / `Sps-Network-prod` 10.10.0.0/16, `vpc-0d0209cbfd298c892`), and **neither is attached to the Transit Gateway**. Every credentialed ETL source lives in `10.x` space reachable only via the TGW. The Sps VPC route tables are local + NAT only, so all sources time out.

## Evidence (TCP-connect probe, 2026-06-18)

Same probe run from each VPC (throwaway Fargate task, `net.connect`, 8s timeout):

| Source | Host / IP:port | from `scholars-dev` (TGW) | from Sps ETL VPC |
|---|---|---|---|
| ReciterDB | `reciter-analysis-report-db-kms…` 10.46.134.208:3306 | OK ~6ms | timeout |
| ASMS | `asms-prod-sqlserver-db…` 10.46.187.110:1433 | OK ~4ms | timeout |
| COI | `asms-frt-prod-mysql-db…` 10.46.187.20:3306 | OK ~4ms | timeout |
| Jenzabar | `JZWCN-SQL-PRD.med.cornell.edu` 10.46.5.51:1433 | (10.46/16, supernet-covered) | timeout |
| ED LDAP | `edprovider` 10.63.215.108:636 / `ed` 10.63.215.64 | OK ~9ms | timeout |
| InfoEd | 10.20.91.8:1433 | timeout (overlap) | timeout (overlap) |

A TGW-attached VPC reaches 4 of 5 source ranges; the Sps ETL VPC reaches none. Staging and prod ETL hit the **same** source ranges (staging already reads the prod upstreams: asms-prod / coi-prod / InfoEdProd).

## The ask (sent to Fabrice 2026-06-18)

Attach both `Sps-Network-staging` (10.20.0.0/16, vpc-04f5b7f7979245d77) and `Sps-Network-prod` (10.10.0.0/16, vpc-0d0209cbfd298c892) to the TGW, with routes to:
- `10.46.0.0/16` — ReciterDB, ASMS, COI, Jenzabar
- `10.63.215.0/24` — ED LDAP (edprovider + ed)

The source security groups must also allow both Sps CIDRs (10.20/16 + 10.10/16). One change covers both environments. 

## InfoEd caveat (separate)

InfoEd is at `10.20.91.8`, which overlaps the staging VPC's own `10.20/16` CIDR, so it's unreachable from there regardless of the TGW attach (the local route wins). Needs a re-IP or a proxy. From prod's `10.10` VPC there's no overlap, so it may be routable once that VPC is attached. The overlap is likely why networking built new, non-overlapping VPCs (10.46.230/231) rather than attaching the existing Sps ones.

## Next steps (once networking lands)

1. Re-probe the sources from the Sps VPC to confirm reachability (etl SG `sg-09b494047547ea148`, a Sps private subnet).
2. Re-run `scholars-nightly-staging` and verify it completes past `etl:ed`.
3. Confirm each external step connects: ed, reciter, reciter-coi-statements, asms, infoed, coi, reporter, jenzabar.
4. Resolve InfoEd separately (re-IP / proxy).
5. When ready, flip `etlSchedulesEnabled: true` for prod after the prod VPC is attached.

## Related

- Email-visibility bridge (the per-field workaround already shipped): `docs/onprem-ed-export-runbook.md` (#443, PR #1100, deployed + verified on staging 2026-06-18).
- Probe gotcha: a throwaway probe task must use the **etl SG** (`sg-09b…`), not the Sps default SG — the default can't reach the CloudWatch Logs VPC interface endpoint (`ResourceInitializationError: cannot find log group`).
