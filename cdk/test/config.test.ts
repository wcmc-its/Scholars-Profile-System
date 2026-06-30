import { assertSharedVpcConfig, resolveEnvConfig } from "../lib/config";

// docs/sps-vpc-consolidation-plan.md — when useSharedVpc is on, every stack
// imports its-reciter-vpc01 by id and places resources into explicit subnet
// ids; an empty vpcId, a missing subnet tier, or <2 AZs would synth an import /
// subnet selection that only fails at CloudFormation deploy. resolveEnvConfig
// runs this guard; it is exported so the invariant is testable with synthetic
// shared-VPC-on configs (the shipped entries are both useSharedVpc:false).
describe("assertSharedVpcConfig", () => {
  const base = resolveEnvConfig("staging");

  it("passes for the shipped config (useSharedVpc off)", () => {
    expect(() => assertSharedVpcConfig(base)).not.toThrow();
  });

  it("passes when useSharedVpc is on with the shipped sharedVpc descriptor", () => {
    expect(() =>
      assertSharedVpcConfig({ ...base, useSharedVpc: true }),
    ).not.toThrow();
  });

  it("throws when shared-VPC-on with an empty vpcId", () => {
    expect(() =>
      assertSharedVpcConfig({
        ...base,
        useSharedVpc: true,
        sharedVpc: { ...base.sharedVpc, vpcId: "" },
      }),
    ).toThrow(/useSharedVpc requires sharedVpc\.vpcId/);
  });

  for (const tier of [
    "appSubnetIds",
    "dataSubnetIds",
    "albSubnetIds",
  ] as const) {
    it(`throws when shared-VPC-on with no ${tier}`, () => {
      expect(() =>
        assertSharedVpcConfig({
          ...base,
          useSharedVpc: true,
          sharedVpc: { ...base.sharedVpc, [tier]: [] },
        }),
      ).toThrow(
        new RegExp(`useSharedVpc requires at least one sharedVpc\\.${tier}`),
      );
    });
  }

  it("throws when shared-VPC-on with fewer than two AZs", () => {
    expect(() =>
      assertSharedVpcConfig({
        ...base,
        useSharedVpc: true,
        sharedVpc: { ...base.sharedVpc, availabilityZones: ["us-east-1a"] },
      }),
    ).toThrow(/useSharedVpc requires ≥2 sharedVpc\.availabilityZones/);
  });
});

// Both envs share ONE sharedVpc descriptor by design (isolation is by per-env
// security group, never network — plan §4.5); the ED-export VPC is a separate,
// untouched field used only by the email-visibility bridge.
describe("sharedVpc descriptor", () => {
  for (const env of ["staging", "prod"] as const) {
    it(`${env}: ships useSharedVpc off and a populated sharedVpc`, () => {
      const cfg = resolveEnvConfig(env);
      expect(cfg.useSharedVpc).toBe(false);
      expect(cfg.sharedVpc.vpcId).toMatch(/^vpc-/);
      expect(cfg.sharedVpc.appSubnetIds.length).toBeGreaterThan(0);
      expect(cfg.sharedVpc.dataSubnetIds.length).toBeGreaterThan(0);
      // The shared VPC is NOT the ED-export VPC (independently flippable).
      expect(cfg.sharedVpc.vpcId).not.toBe(cfg.edExportVpc.vpcId);
    });
  }
});
