# AWS account logging strategy

**Audience.** ITS colleagues asking *"what does the Library AWS account log, how long is it kept, and does that meet WCM policy?"* This covers the whole account (ReCiter, Scholars, ReciterAI, VIVO dev), not just SPS. For SPS's own application log groups and Logs Insights recipes, see [`logging-reference.md`](./logging-reference.md).

This is the public summary. A detailed internal version lives outside this repo, in the Library's AWS account notes, because this repo is public. It covers resource names, Athena tables and queries, bucket policy, and SIEM onboarding status. Ask the Library's AWS account owner for it.

**As of 2026-11-02.** ITS Security reviewed the design on 2026-11-02. Application logs are kept indefinitely in CloudWatch. Security logs (VPC flow logs, Kubernetes audit) are moving to a dedicated S3 bucket queried with Athena. Their CloudWatch history is exported there before any retention is applied.

## Principles

1. **Application logs are kept indefinitely.** Troubleshooting often means going back months, so app log groups never expire. Cost is controlled by logging less noise (per-item detail at DEBUG, not INFO), not by deleting history.
2. **Security logs go to S3, not CloudWatch.** They are high volume and rarely read, so S3 with Athena costs a fraction of CloudWatch ingest and storage. They stay in queryable storage tiers.
3. **Nothing is deleted before it is exported and verified.** Before retention is set on a security log group, its history is exported to S3 and record counts are checked against the source.
4. **Metrics telemetry is sized to what we use.** Container Insights runs in standard mode and Application Signals is off; no dashboard or alarm needed the extra data.
5. **ITS Security reviews changes to security logging first.**

## Retention by log type

| Log type | Where | Retention |
|---|---|---|
| Application container logs (EKS) | CloudWatch | Indefinite |
| Lambda and ECS application logs (non-SPS) | CloudWatch | Indefinite for most groups |
| SPS application logs | CloudWatch | 30 days staging, 90 days prod, set in CDK ([`logging-reference.md`](./logging-reference.md)) |
| VPC flow logs (ReCiter VPCs) | S3, Parquet | Indefinite. Glacier Instant Retrieval after 30 days, never deeper. |
| VPC flow logs (Scholars VPCs) | CloudWatch | 365 days |
| Kubernetes audit and authenticator logs | CloudWatch, with history exported to S3 | 1 year in CloudWatch (planned), exported history kept in S3 |
| CloudTrail | CloudWatch and S3, plus the Control Tower organization trail | 365 days in CloudWatch, indefinite in S3 |
| WAF logs | CloudWatch | 90 days |
| Container Insights performance logs | CloudWatch | 90 days |

## Security log storage

The security log bucket follows ITS Security's recommendations:

- Block Public Access on, with SSE-S3 encryption and ACLs disabled.
- Versioning on; deleted objects stay recoverable for 180 days.
- Only the AWS log delivery and CloudWatch export services may write, each scoped to this account. TLS is required.
- Read access is limited to account admins, ITS Security and Security Operations.
- Objects move to Glacier Instant Retrieval at 30 days and never to Glacier Flexible Retrieval or Deep Archive, so everything stays queryable in Athena.

Flow logs use a custom version 5 format with the fields ITS Security asked for: VPC, subnet and instance IDs, TCP flags, packet source and destination, AWS service, flow direction and traffic path.

## Policy mapping

| Requirement | Source | How it is met |
|---|---|---|
| Audit logging on | WCM Cloud Security Standard, Logging 3.1 | Kubernetes audit and authenticator logging enabled; CloudTrail on |
| Forward security logs to the SIEM | Logging 3.2 | Being onboarded with ITS (flow logs via S3 notifications, Kubernetes audit via a log subscription) |
| Keep logs at least 1 year | Logging 3.3 | See retention table above |
| 180 days immediately available | ITS 500.11 §5.01 | S3 Standard, then Glacier Instant Retrieval; both queryable |
| 7 years if High Risk data | ITS 500.03, Cornell Policy 4.7 | Not applicable: the ReCiter cluster holds publication metadata and directory information. Revisit if that changes. |
| Workload identity traceable | Cloud Standard, Kubernetes section | Kubernetes authenticator logs |
