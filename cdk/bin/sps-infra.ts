#!/usr/bin/env node
import { App, type Environment, Tags } from "aws-cdk-lib";
import { AnalyticsStack } from "../lib/analytics-stack";
import { AppStack } from "../lib/app-stack";
import { assertCutoverGate, resolveEnvConfig } from "../lib/config";
import { DataStack } from "../lib/data-stack";
import { DrBackupVaultStack } from "../lib/dr-backup-vault-stack";
import { EdgeStack } from "../lib/edge-stack";
import { EtlStack } from "../lib/etl-stack";
import { NetworkStack } from "../lib/network-stack";
import { SpsObservabilityStack } from "../lib/observability-stack";
import { SecretsStack } from "../lib/secrets-stack";

const app = new App();

// `-c env=staging|prod` selects the environment; defaults to staging.
const envConfig = resolveEnvConfig(app.node.tryGetContext("env"));

// Estate-consolidation cutover gate (docs/sps-vpc-consolidation-plan.md
// §6.2/§8.5/§8.6; #1370): useSharedVpc is not yet deployable — flipping it would
// CFN-replace Aurora/OpenSearch in place into empty datastores. Hard-throws while
// the flag is on (shipped config is false → inert today; also fails CI on any
// premature useSharedVpc:true commit). Lifted by the snapshot-restore cutover task.
assertCutoverGate(envConfig);

// ADR-008: staging and production are separate AWS accounts. The account id is
// supplied at deploy time via `-c <envName>Account=<id>` and is never
// committed. When it is absent — as in CI — the stack synthesizes
// environment-agnostic.
const account = app.node.tryGetContext(`${envConfig.envName}Account`) as
  | string
  | undefined;

const env: Environment = { account, region: envConfig.region };
const drEnv: Environment = { account, region: envConfig.drRegion };

const networkStack = new NetworkStack(app, `Sps-Network-${envConfig.envName}`, {
  env,
  envConfig,
  description: `SPS network — VPC and security groups, ${envConfig.envName} (ADR-008).`,
});

// DR-region BackupVault — referenced cross-region by DataStack's BackupPlan
// copyAction (B10). `crossRegionReferences: true` on both stacks lets CDK
// wire the dependency via SSM parameter export/import.
const drBackupVaultStack = new DrBackupVaultStack(
  app,
  `Sps-DrBackupVault-${envConfig.envName}`,
  {
    env: drEnv,
    envConfig,
    crossRegionReferences: true,
    description: `SPS DR BackupVault — ${envConfig.drRegion}, ${envConfig.envName} (ADR-008 B10).`,
  },
);

const dataStack = new DataStack(app, `Sps-Data-${envConfig.envName}`, {
  env,
  envConfig,
  crossRegionReferences: true,
  vpc: networkStack.vpc,
  drBackupVault: drBackupVaultStack.vault,
  description: `SPS data — Aurora MySQL, OpenSearch, AWS Backup, ${envConfig.envName} (ADR-008).`,
});

new SecretsStack(app, `Sps-Secrets-${envConfig.envName}`, {
  env,
  envConfig,
  description: `SPS secrets — empty Secrets Manager entries, ${envConfig.envName} (ADR-008).`,
});

// AppStack — compute and ingress plane (B05 + B06 + B09-CDK + B17).
// SecretsStack is not threaded in: AppStack looks up the five consumer
// secrets by name via Secret.fromSecretNameV2 so the two stacks stay
// loosely coupled (same pattern NetworkStack -> DataStack uses for SGs
// is inverted here — AppStack reads SecretsStack's resources by ARN
// rather than receiving them as constructor props).
const appStack = new AppStack(app, `Sps-App-${envConfig.envName}`, {
  env,
  envConfig,
  vpc: networkStack.vpc,
  description: `SPS application plane — ECR, ECS Fargate, ALBs, VPC endpoints, ${envConfig.envName} (ADR-008).`,
});

// EtlStack — Step Functions state machines + cadence/status alarms
// (B08 + B20). Consumes the AppStack ECS cluster + the dedicated ETL ECR
// repo via stack props (CDK auto-wires the cross-stack export). The ETL
// image is the `scholars-etl-*` repo, not the standalone app image (#454).
// The internal ALB SG id
// is consumed via Fn::ImportValue of AppStack's `InternalAlbSecurityGroupId`
// export (one additive output — see plan resolved item #3).
const etlStack = new EtlStack(app, `Sps-Etl-${envConfig.envName}`, {
  env,
  envConfig,
  vpc: networkStack.vpc,
  ecsCluster: appStack.ecsCluster,
  etlEcrRepository: appStack.etlEcrRepository,
  description: `SPS ETL orchestration — Step Functions state machines + alarms, ${envConfig.envName} (ADR-008 B08+B20).`,
});

// ObservabilityStack — SLO alarms, SNS topic, the reliability dashboard, and
// (prod only) the account cost guardrails (B22). Receives the AppStack +
// DataStack instances as props so the alarm + dashboard definitions reference
// the L2 ALB / target group / Aurora / OpenSearch constructs directly —
// string-interpolating against env-known resource names would lose the
// synth-time guarantee that the names line up. The dashboard's CloudFront
// widgets read the distribution id from config (envConfig.cloudFrontDistributionId),
// NOT an EdgeStack handle, so this stack deploys standalone while EdgeStack is
// frozen behind the NetScaler/WAF (#502) decision.
new SpsObservabilityStack(
  app,
  `Sps-Observability-${envConfig.envName}`,
  {
    env,
    envConfig,
    appStack,
    dataStack,
    etlStack,
    description: `SPS observability — alarms, SNS, dashboard, ${envConfig.envName === "prod" ? "and account budget + cost-anomaly monitor, " : ""}${envConfig.envName} (ADR-008 B22).`,
  },
);

// EdgeStack — CloudFront cache-behavior split + VIVO/legacy 301 redirect
// front for the public ALB (B07 + B14). Receives the AppStack instance as a
// prop so the CloudFront origin can reference the public ALB directly; CDK
// auto-wires the cross-stack reference. Custom domain + ACM cert attach when
// `-c edgeCustomDomain=...` and `-c edgeCertArn=...` are both supplied
// (see plan D2's bootstrap two-step).
new EdgeStack(app, `Sps-Edge-${envConfig.envName}`, {
  env,
  envConfig,
  publicAlb: appStack.publicAlb,
  // The static-asset bucket (#700) grants this role PutObject so the deploy
  // workflow can sync `.next/static` to S3. Passed as the ARN string; CDK
  // resolves the cross-stack reference.
  deployRoleArn: appStack.deployRole.roleArn,
  description: `SPS edge — CloudFront distribution fronting the public ALB, ${envConfig.envName} (ADR-008 B07+B14).`,
});

// AnalyticsStack — CloudFront usage analytics (ADR-008's 9th stack). Reads the
// raw CloudFront access-log bucket BY NAME (envConfig.cloudFrontLogsBucketName)
// and rolls the logs into a durable, pre-aggregated `daily_usage` table (Glue +
// Athena + a nightly rollup Lambda) for marketing metrics. Aggregates only — no
// raw client IPs land in the durable table (PII posture, see stack JSDoc).
// Referenced by name (not an EdgeStack handle) so it deploys standalone while
// EdgeStack is frozen (#502).
new AnalyticsStack(app, `Sps-Analytics-${envConfig.envName}`, {
  env,
  envConfig,
  description: `SPS usage analytics — Glue + Athena over CloudFront logs + nightly rollup, ${envConfig.envName} (ADR-008 9th stack).`,
});

// Tag every resource for cost allocation and ownership clarity.
Tags.of(app).add("Project", "scholars-profile-system");
Tags.of(app).add("Environment", envConfig.envName);
Tags.of(app).add("ManagedBy", "cdk");
