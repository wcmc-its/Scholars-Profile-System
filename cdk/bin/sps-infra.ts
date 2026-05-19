#!/usr/bin/env node
import { App, type Environment, Tags } from "aws-cdk-lib";
import { resolveEnvConfig } from "../lib/config";
import { NetworkStack } from "../lib/network-stack";

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

new NetworkStack(app, `Sps-Network-${envConfig.envName}`, {
  env,
  envConfig,
  description: `SPS network — VPC and security groups, ${envConfig.envName} (ADR-008).`,
});

// Tag every resource for cost allocation and ownership clarity.
Tags.of(app).add("Project", "scholars-profile-system");
Tags.of(app).add("Environment", envConfig.envName);
Tags.of(app).add("ManagedBy", "cdk");
