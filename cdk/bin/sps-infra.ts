#!/usr/bin/env node
import { App, type Environment, Tags } from "aws-cdk-lib";
import { AppStack } from "../lib/app-stack";
import { resolveEnvConfig } from "../lib/config";
import { DataStack } from "../lib/data-stack";
import { DrBackupVaultStack } from "../lib/dr-backup-vault-stack";
import { NetworkStack } from "../lib/network-stack";
import { SecretsStack } from "../lib/secrets-stack";

const app = new App();

// `-c env=staging|prod` selects the environment; defaults to staging.
const envConfig = resolveEnvConfig(app.node.tryGetContext("env"));

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

new DataStack(app, `Sps-Data-${envConfig.envName}`, {
  env,
  envConfig,
  crossRegionReferences: true,
  vpc: networkStack.vpc,
  appSecurityGroup: networkStack.appSecurityGroup,
  etlSecurityGroup: networkStack.etlSecurityGroup,
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
new AppStack(app, `Sps-App-${envConfig.envName}`, {
  env,
  envConfig,
  vpc: networkStack.vpc,
  appSecurityGroup: networkStack.appSecurityGroup,
  etlSecurityGroup: networkStack.etlSecurityGroup,
  albSecurityGroup: networkStack.albSecurityGroup,
  description: `SPS application plane — ECR, ECS Fargate, ALBs, VPC endpoints, ${envConfig.envName} (ADR-008).`,
});

// Tag every resource for cost allocation and ownership clarity.
Tags.of(app).add("Project", "scholars-profile-system");
Tags.of(app).add("Environment", envConfig.envName);
Tags.of(app).add("ManagedBy", "cdk");
