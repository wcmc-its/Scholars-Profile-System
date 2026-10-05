import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AppStack } from "../lib/app-stack";
import { DataStack } from "../lib/data-stack";
import { DrBackupVaultStack } from "../lib/dr-backup-vault-stack";
import { NetworkStack } from "../lib/network-stack";
import { importSharedVpc } from "../lib/shared-vpc-subnets";
import { makeFixture } from "./test-utils";

// #1458: with useSharedVpc on, bin/sps-infra.ts no longer synthesizes
// Sps-Network-<env>; Data and App import the shared VPC themselves. These pin
// that dropping the NetworkStack-supplied VPC leaves their templates unchanged.
type Env = "staging" | "prod";

function dataTemplate(envName: Env, viaNetwork: boolean): unknown {
  const f = makeFixture(envName);
  const vpc = viaNetwork
    ? new NetworkStack(f.app, `Sps-Network-${envName}`, {
        env: f.env,
        envConfig: f.envConfig,
      }).vpc
    : undefined;
  const dr = new DrBackupVaultStack(f.app, `Sps-DrBackupVault-${envName}`, {
    env: f.drEnv,
    envConfig: f.envConfig,
    crossRegionReferences: true,
  });
  const stack = new DataStack(f.app, `Sps-Data-${envName}`, {
    env: f.env,
    envConfig: f.envConfig,
    crossRegionReferences: true,
    vpc,
    drBackupVault: dr.vault,
  });
  return Template.fromStack(stack).toJSON();
}

function appTemplate(envName: Env, viaNetwork: boolean): unknown {
  const f = makeFixture(envName);
  const vpc = viaNetwork
    ? new NetworkStack(f.app, `Sps-Network-${envName}`, {
        env: f.env,
        envConfig: f.envConfig,
      }).vpc
    : undefined;
  const stack = new AppStack(f.app, `Sps-App-${envName}`, {
    env: f.env,
    envConfig: f.envConfig,
    vpc,
  });
  return Template.fromStack(stack).toJSON();
}

describe("shared VPC import without NetworkStack (#1458)", () => {
  for (const envName of ["staging", "prod"] as const) {
    it(`${envName} ships useSharedVpc on (precondition)`, () => {
      expect(makeFixture(envName).envConfig.useSharedVpc).toBe(true);
    });

    it(`${envName} DataStack template is identical with or without the NetworkStack vpc`, () => {
      expect(dataTemplate(envName, false)).toEqual(dataTemplate(envName, true));
    });

    it(`${envName} AppStack template is identical with or without the NetworkStack vpc`, () => {
      expect(appTemplate(envName, false)).toEqual(appTemplate(envName, true));
    });
  }

  it("importSharedVpc throws when useSharedVpc is off", () => {
    const f = makeFixture("staging");
    const stack = new Stack(f.app, "Probe", { env: f.env });
    expect(() =>
      importSharedVpc(stack, { ...f.envConfig, useSharedVpc: false }),
    ).toThrow(/useSharedVpc=false/);
  });

  it("importSharedVpc returns the configured shared VPC id", () => {
    const f = makeFixture("prod");
    const stack = new Stack(f.app, "Probe", { env: f.env });
    expect(importSharedVpc(stack, f.envConfig).vpcId).toBe(
      f.envConfig.sharedVpc.vpcId,
    );
  });
});
