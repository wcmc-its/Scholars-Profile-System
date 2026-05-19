# Scholars Profile System — infrastructure (AWS CDK)

AWS CDK (TypeScript) infrastructure for the Scholars Profile System. The tool,
language, in-repo location, six-stack decomposition, environment model, and
threat model are recorded in
[`../docs/ADR-008-infrastructure-as-code.md`](../docs/ADR-008-infrastructure-as-code.md).

This is a **standalone npm project** — its own `package.json` and
`node_modules`, excluded from the Next.js application's build, typecheck, and
ESLint.

## Layout

| Path                  | Purpose                                                  |
| --------------------- | -------------------------------------------------------- |
| `bin/sps-infra.ts`    | CDK app entry — instantiates the stacks per environment  |
| `lib/config.ts`       | Per-environment configuration (`staging`, `prod`)        |
| `lib/network-stack.ts`| `NetworkStack` — the VPC and security groups             |

## Commands

```sh
npm ci                          # install
npm run synth                    # synthesize CloudFormation (no AWS account needed)
npm run lint                     # ESLint
npm run typecheck                # tsc --noEmit
npm run synth -- -c env=prod     # synthesize the production environment
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

## Phased rollout

Provisioning follows the phased roadmap in ADR-008 — one stack family per
reviewable PR. Phase 0 (this directory's initial commit) is `NetworkStack`.
