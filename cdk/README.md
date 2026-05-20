# Scholars Profile System — infrastructure (AWS CDK)

AWS CDK (TypeScript) infrastructure for the Scholars Profile System. The tool,
language, in-repo location, six-stack decomposition, environment model, and
threat model are recorded in
[`../docs/ADR-008-infrastructure-as-code.md`](../docs/ADR-008-infrastructure-as-code.md).

This is a **standalone npm project** — its own `package.json` and
`node_modules`, excluded from the Next.js application's build, typecheck, and
ESLint.

## Layout

| Path                            | Purpose                                                              |
| ------------------------------- | -------------------------------------------------------------------- |
| `bin/sps-infra.ts`              | CDK app entry — instantiates the stacks per environment              |
| `lib/config.ts`                 | Per-environment configuration (`staging`, `prod`)                    |
| `lib/network-stack.ts`          | `NetworkStack` — VPC and security groups (Phase 0)                   |
| `lib/dr-backup-vault-stack.ts`  | `DrBackupVaultStack` — DR-region BackupVault, `us-west-2` (Phase 1)  |
| `lib/data-stack.ts`             | `DataStack` — Aurora, OpenSearch, AWS Backup plan (Phase 1)          |
| `lib/secrets-stack.ts`          | `SecretsStack` — empty Secrets Manager entries (Phase 1)             |
| `test/`                         | Jest snapshot tests + targeted CDK assertions                        |

## Commands

```sh
npm ci                            # install
npm run synth                     # synthesize CloudFormation (no AWS account needed)
npm run lint                      # ESLint
npm run typecheck                 # tsc --noEmit
npm test                          # jest snapshot + assertion tests
npm run synth -- -c env=prod      # synthesize the production environment
```

## Environments

Staging and production are **separate AWS accounts** (ADR-008). The same stack
code is parameterized by `-c env=staging|prod` (defaults to `staging`). Account
ids are passed at deploy time with `-c <env>Account=<id>` and are never
committed; with the account context absent, `cdk synth` runs
environment-agnostic — which is what CI does.

`cdk synth` and `cdk diff` are safe to run locally. `cdk bootstrap` and
`cdk deploy` create or modify real AWS resources and are run by an account
holder — never autonomously.

## Bootstrapping

Each AWS account that hosts an SPS environment must be `cdk bootstrap`-ed
**in both regions** before the first deploy of that environment:

```sh
cdk bootstrap aws://<account>/us-east-1     # primary
cdk bootstrap aws://<account>/us-west-2     # DR (B10 — BackupVault destination)
```

This is a one-time per account / per region setup. CI does not run it.

## Post-deploy: seeding the empty secrets

`SecretsStack` creates seven Secrets Manager entries with **no values** — per
ADR-008's hard rule, no plaintext secret ever appears in CDK source or in the
synthesized template. After the first `cdk deploy Sps-Secrets-<env>`, the
account holder seeds the values out-of-band:

| Secret name                              | How to seed                                                  |
| ---------------------------------------- | ------------------------------------------------------------ |
| `scholars/db/app-rw`                     | DSN once the `app_rw` MySQL user exists                       |
| `scholars/db/app-ro`                     | DSN once the `app_ro` MySQL user exists                       |
| `scholars/db/etl`                        | DSN once the `etl` MySQL user exists                          |
| `scholars/opensearch/app`                | OpenSearch user created via the `_security` API               |
| `scholars/opensearch/etl`                | OpenSearch user created via the `_security` API               |
| `scholars/revalidate-token`              | `openssl rand -hex 32` — quarterly calendar rotation per [`docs/revalidate-token-rotation.md`](../docs/revalidate-token-rotation.md) |
| `scholars/saml-sp/<env>/private-key`     | PEM private key matching the SP cert registered with WCM IT   |

Seeding pattern (run by the account holder):

```sh
aws secretsmanager put-secret-value \
  --secret-id scholars/revalidate-token \
  --secret-string "$(openssl rand -hex 32)"
```

The Aurora **master** secret (`scholars/db/master`) is created and
auto-rotated by `DataStack` on a 30-day cadence; it does not need manual
seeding. (ADR-008 nominally locates RDS rotation in `SecretsStack`; it
actually lives in `DataStack` next to the cluster and its auto-generated
master secret — a comment in `lib/data-stack.ts` explains why the
two-stack split CDK would require creates a structural cycle.) The three
application DSN secrets above are **calendar-rotated by the account
holder** — auto-rotation for app-tier users is out of scope for this phase.

## OpenSearch admin

`DataStack` provisions the OpenSearch domain with fine-grained access
control. The FGAC master is an IAM role (`sps-opensearch-master-<env>`) with
an `AccountRootPrincipal` trust policy — there is no master *secret* to seed.
To administer the domain, an account holder assumes the role and uses the
`_security` API to create the `scholars/opensearch/app` and
`scholars/opensearch/etl` internal users, then populates the matching
Secrets Manager entries.

## Phased rollout

Provisioning follows the phased roadmap in ADR-008 — one stack family per
reviewable PR.

| Phase | Stacks                                                     | Status   |
| ----- | ---------------------------------------------------------- | -------- |
| 0     | `NetworkStack`, `Dockerfile`, `cdk synth` CI job           | shipped (#386) |
| 1     | `DataStack`, `SecretsStack`, `DrBackupVaultStack`          | this PR  |
| 2     | `AppStack` (ECR / ECS / ALB / CloudFront / WAF / migration task) | next |
| 3     | `EtlStack` (Step Functions + Lambdas) + `scholars/etl/{source}` secrets | — |
| 4     | `NetworkStack` VPC endpoints (B17)                         | —        |
| 5     | `ObservabilityStack` + staging-environment acceptance      | —        |
