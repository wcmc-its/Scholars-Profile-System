# docs/ADR-008 — Infrastructure-as-Code: AWS CDK, TypeScript, in-repo, six stacks

**Status:** Accepted
**Date:** 2026-05-19
**Authors:** Scholars Profile System development team
**Supersedes:** —
**Superseded by:** —

## Context

The Scholars Profile System has no infrastructure-as-code. There is no `Dockerfile`, no CDK project, and no deploy pipeline; the application has never been containerized or deployed. Every remaining item in the #99 production-readiness backlog that is not already shipped is infrastructure work.

[`ADR-004`](./ADR-004-deploy-strategy.md) commits the *deploy* architecture — an ECS service running rolling deploys behind an Application Load Balancer, fronted by CloudFront, with Aurora MySQL as the primary store — and states the constraint that "CDK / IaC stays small and reviewable." [`PRODUCTION_ADDENDUM.md`](./PRODUCTION_ADDENDUM.md) specifies the writer-endpoint auth and secret layout, the Step Functions ETL orchestration, and the schema-migration pipeline. Neither document decides *how* that infrastructure is expressed as code, *where* the code lives, or *how it is decomposed*.

This ADR closes those questions. It is the paired decision to `ADR-004`: where `ADR-004` chose the deploy strategy, ADR-008 chooses the IaC that expresses it. The ECS deployment circuit breaker, the `minimumHealthyPercent` / `maximumPercent` configuration, the one-shot `prisma migrate deploy` task, the public and internal-only ALB listeners, and the Step Functions state machines are all CDK resources governed by this ADR.

ADR-008 decides structure; it does not provision anything. The six stacks are built and deployed over a phased rollout — one reviewable PR per phase — tracked under #99.

## Decision

**1. Tool — AWS CDK.** `ADR-004` already names CDK, and the organization runs CDK in production (`ReCiter-CDK`). ADR-008 formalizes CDK as the SPS IaC tool.

**2. Language — TypeScript.** SPS is a TypeScript codebase maintained by a TypeScript team. CDK-TS shares the application's toolchain — npm, `tsc`, ESLint — and the same language for reviewers. `ReCiter-CDK` is written in Java; that was a different system's choice and is not a house standard binding SPS.

**3. Location — a `cdk/` directory inside this repository.** The CDK code is its own npm project — its own `package.json`, its own `node_modules`, its own `tsconfig.json` — and is excluded from the Next.js build (`tsconfig.json` `exclude`, `.dockerignore`). Co-location means an infrastructure change and the application change that depends on it — a new secret and the code that reads it; a new environment variable and its consumer — land in **one reviewable PR**. The alternative — a sibling `Scholars-Profile-System-CDK` repo, matching `ReCiter-CDK`'s separation — adds cross-repo version coordination for no benefit at this size.

**4. Stack decomposition — six stacks, split by blast radius and change cadence:**

| Stack | Owns | Change cadence |
|---|---|---|
| `NetworkStack` | VPC, subnets, security groups, VPC endpoints (B17) | rare |
| `DataStack` | Aurora MySQL — PITR / snapshots / cross-region copy (B10) — and the OpenSearch domain | rare; deletion-protected |
| `SecretsStack` | Secrets Manager secret *definitions* and RDS rotation (B06) | rare |
| `AppStack` | ECR, ECS cluster / service / task definitions with the role split (B06), public + internal ALB listeners (B05), CloudFront + WAF (B07, B26), the one-shot migration task (B09) | every deploy |
| `EtlStack` | ETL Lambdas, the ETL security group, Step Functions state machines (B08), EventBridge schedules, the `etl-failures` SNS topic | per ETL change |
| `ObservabilityStack` | CloudWatch alarms, log retention, cost alarms (B20 / B22), SNS → on-call (B23), X-Ray (B24) | occasional |

The frequently-deployed `AppStack` is structurally isolated from the stateful `DataStack`: a bad application deploy operates on a different CloudFormation stack than the one that owns the database, so it cannot tear the database down. `DataStack` and `NetworkStack` carry `RemovalPolicy.RETAIN` and deletion protection.

**5. Environments — staging and production, in separate AWS accounts.** The same stack code is parameterized by CDK context (`-c env=staging|prod`); per `ADR-004`, staging gates the production deploy. The two environments are deployed to **separate AWS accounts** — not one account holding two stack sets. The primary region is `us-east-1`; the named disaster-recovery region, for B10's cross-region Aurora snapshot copy, is `us-west-2`. Account IDs are supplied as CDK context at deploy time and are never committed; with context absent, `cdk synth` runs environment-agnostic — which is what CI does.

**6. Deploy pipeline runner — GitHub Actions.** The build → ECR push → migration task → ECS service update pipeline (`ADR-004`, `PRODUCTION_ADDENDUM.md § Schema migration policy`) runs as a GitHub Actions workflow extending the existing `ci.yml`. GitHub Actions authenticates to AWS by **OIDC federation to a scoped IAM role** — there are no long-lived AWS access keys stored as CI secrets. Staging-gates-production is enforced with GitHub Environments and required reviewers. (This ADR records the runner decision; Phase 0 adds only the `cdk synth` CI job — the deploy workflow itself lands with `AppStack`.)

### Threat model

ADR-008 governs *infrastructure definition*. The controls below are the ones the IaC structure is responsible for; each is enforced in CDK and reviewable in `cdk synth` output. The model states what an attacker must not be able to do *given the infrastructure as defined* — application-layer defenses are a separate surface (see *out of scope*).

**In scope — controls the IaC structure enforces:**

- **IAM least privilege.** The ECS *task-execution role* receives `secretsmanager:GetSecretValue` scoped to the SPS secret ARNs and nothing else. The ECS *task role* — the runtime identity of application code — receives **no** secret access at all; application code sees secret values only as environment variables injected at task start. This is the AWS-recommended ECS pattern (Well-Architected Framework, Security Pillar). It mitigates a compromised application process enumerating, reading, or rotating secrets beyond the ones it was started with.
- **Network reachability.** ECS tasks, Aurora, and OpenSearch sit in private subnets. `/api/revalidate` is reachable only through an internal ALB listener whose security group admits ingress solely from the ETL security group — security-group-to-security-group, no IP allowlist. This mitigates direct internet exposure of the only ETL-triggered writer endpoint.
- **Egress confinement.** VPC endpoints (B17) keep Secrets Manager, S3, and OpenSearch traffic on the AWS network rather than traversing the public internet via the NAT gateway.
- **Edge filtering.** AWS WAF is attached to the CloudFront distribution (B26).
- **Environment isolation at the account boundary.** Staging and production are separate AWS accounts (decision 5). A misconfigured IAM grant, an over-broad resource policy, or a `cdk deploy` run against the wrong context cannot reach production resources from a staging operation — the blast radius of any staging mistake is the staging account.
- **Blast-radius isolation within an account.** The stateful stacks (`DataStack`, `NetworkStack`) are deletion-protected and are separate CloudFormation stacks from the deploy-frequently `AppStack`.
- **No long-lived cloud credentials in CI.** The deploy pipeline authenticates by OIDC federation (decision 6); the AWS IAM deploy role's trust policy admits only this repository's GitHub Actions workflows. There is no static `AWS_ACCESS_KEY_ID` in repository or organization secrets to leak.
- **Drift detection.** CDK is the single source of truth for infrastructure; `cdk diff` surfaces any change made directly in the AWS console.

**Enforceable rule (hard):** **No secret value ever appears in CDK source or in a synthesized CloudFormation template.** CDK references every secret by ARN only. Secret *values* are provisioned and rotated out-of-band. Reviewing the `cdk synth` output of the `SecretsStack` PR confirms zero plaintext secrets; a violation blocks the PR. Secret-value ownership is settled: the account holder provisions the initial values after `cdk deploy` and owns the calendar rotation of the OpenSearch, `revalidate-token`, and per-source ETL secrets; the database credentials rotate automatically through the Secrets Manager RDS rotation Lambda defined in `SecretsStack`.

**Out of scope (explicit):**

- **Application-layer authentication and authorization** — the SAML SSO and Enterprise Directory authorization for the writer endpoints (B01 / B02, shipped). ADR-008 provisions the *secrets those flows consume*; it does not own the auth logic.
- **Secret values themselves** — provisioned out-of-band per the hard rule above; ADR-008 owns only the empty secret definitions.
- **AWS Organization-level controls** — SCPs, GuardDuty, organization-wide CloudTrail. Assumed to be administered at the Organization level above this project.
- **Runtime intrusion detection and incident response** — a different control surface than infrastructure definition.

### Verification model — and its honest limit

- **In CI:** `cdk synth`, `tsc`, and ESLint run against `cdk/` on every PR. They prove the templates are well-formed and type-correct, and they need no AWS account. This is added as a dedicated CI job in Phase 0.
- **Not automatable in this repository:** `cdk diff` and `cdk deploy` require AWS credentials and are run by an account holder. CDK authored under this ADR is reviewable and synth-valid, but it is **unverified against a live AWS account until it is deployed** — a materially weaker safety net than the application-code backlog, where `npm test` and `npm run build` exercise real behavior. Production-infrastructure correctness ultimately rests on a `cdk diff` review and a staging deploy, not on the CI synth gate alone. This limit is stated so it is not mistaken for stronger assurance than it is.

## Consequences

**Positive outcomes:**

The frequently-deployed `AppStack` is a different CloudFormation stack from the stateful `DataStack`; a failed or malformed app deploy cannot delete the database. Staging and production are separate accounts, so no staging operation can mutate production. Co-locating `cdk/` with the application means a coupled infrastructure-and-application change is one PR, reviewed once, by reviewers using one language. The CI synth gate catches malformed templates before review.

**Negative outcomes and mitigations:**

The CI synth gate is weaker than the application-code test gate — see *Verification model* above. Mitigation: every stack PR carries a `cdk diff` reviewed by an account holder, and the staging environment (B13) is the pre-production gate per `ADR-004`. Separate accounts add a one-time `cdk bootstrap` per account and a deploy IAM role per account; this cost is paid once and is the price of the account-boundary isolation it buys.

**Operational implications:**

The division of labor is fixed. The six stacks, the `Dockerfile`, the ETL Lambda-handler wrappers, and the CI synth job are authored and `cdk synth`-verified in-repo; `cdk bootstrap`, the secret values, `cdk diff` review, `cdk deploy`, and validation of the deployed result against AWS are owned by an account holder. `cdk deploy` is never run autonomously.

The six stacks are provisioned over a phased rollout — Foundation (network), Data & Secrets, App & Edge, ETL orchestration, Network hardening, and Observability & the staging gate — one reviewable PR per phase. The phase-to-B-item mapping is tracked under #99.

**Forward compatibility:**

If a future high-RPS write path makes progressive traffic-shifting load-bearing, `ADR-004` is revisited and the change lands in `AppStack` under this ADR. The disaster-recovery region (`us-west-2`) is named now so B10's cross-region snapshot copy has a target without reopening this decision.

## Alternatives Considered

**Terraform, Pulumi, or raw CloudFormation.** Rejected. `ADR-004` commits CDK and the organization already runs CDK; a second IaC tool means a second state model, a second toolchain, and a second skill set for no gain.

**CDK in Java, to match `ReCiter-CDK`.** Rejected. SPS is a TypeScript codebase; CDK-TS shares the application toolchain and lowers the review barrier for the SPS team. `ReCiter-CDK`'s language was a different system's decision, not a standard binding SPS.

**A sibling `Scholars-Profile-System-CDK` repository.** Considered — it is `ReCiter-CDK`'s model. Rejected in favor of in-repo `cdk/`: at this size a separate repo only adds cross-repo version coordination, and it forfeits single-PR review of a coupled infrastructure-and-application change.

**ClickOps — console-provisioned infrastructure, no IaC.** Rejected. Console-provisioned infrastructure is unreviewable and undriftable, and it makes the staging-production parity that `ADR-004` depends on (B13) impossible to guarantee.

**One AWS account holding two environments.** Rejected as the environment model. A single account hosting both staging and production has no account-boundary isolation: a misconfigured IAM policy, an over-broad resource policy, or a `cdk deploy` run with the wrong `-c env` context can mutate production from what was meant to be a staging operation. Separate accounts make that class of mistake structurally impossible. The stack code is identical either way, so the isolation is bought at only the one-time per-account bootstrap cost.

**AWS CodePipeline for the deploy runner.** Considered. CodePipeline keeps the deploy entirely inside AWS with no GitHub-to-AWS trust relationship, and its staging-to-production promotion gates are native. Rejected in favor of GitHub Actions: the repository's CI already runs on GitHub Actions, OIDC federation removes the long-lived-credential concern that historically favored an in-AWS runner, and GitHub Environments with required reviewers provide the same promotion gate. CodePipeline would add CodeBuild and CodePipeline as CDK resources and a second CI system to operate — against `ADR-004`'s "small and reviewable" constraint.

## References

- [`ADR-004`](./ADR-004-deploy-strategy.md) — deploy strategy (ECS rolling); the deploy architecture this IaC expresses.
- [`PRODUCTION_ADDENDUM.md`](./PRODUCTION_ADDENDUM.md) — writer-endpoint auth and secret layout, Step Functions ETL orchestration, schema-migration pipeline.
- [`PRODUCTION_BACKLOG.md`](./PRODUCTION_BACKLOG.md) / #99 — the production-readiness backlog; the infra B-series (B05–B26) provisioned under this ADR.
- AWS Well-Architected Framework, Security Pillar — IAM least privilege; the ECS task-execution-role / task-role split.
- B05 (#104), B06 (#105), B07 (#106), B08 (#107), B09 (#108), B10 (#109), B13 (#112), B17 (#116), B20 (#119), B22 (#121), B23 (#122), B24 (#123), B26 (#125) — the infra items mapped onto the six stacks.
