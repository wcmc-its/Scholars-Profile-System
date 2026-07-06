import {
  assertCutoverGate,
  assertSharedVpcConfig,
  resolveEnvConfig,
} from "../lib/config";

// docs/sps-vpc-consolidation-plan.md — when useSharedVpc is on, every stack
// imports its-reciter-vpc01 by id and places resources into explicit subnet
// ids; an empty vpcId, a missing subnet tier, or <2 AZs would synth an import /
// subnet selection that only fails at CloudFormation deploy. resolveEnvConfig
// runs this guard; it is exported so the invariant is testable with synthetic
// shared-VPC-on configs (the shipped entries are both useSharedVpc:false).
describe("assertSharedVpcConfig", () => {
  const base = resolveEnvConfig("staging");

  // The shipped descriptor ships EMPTY out-of-band SG ids (item-3 pass 1 — the
  // shared-VPC team provisions those later), so a flip-ready descriptor supplies
  // them. assertSharedVpcConfig gates the flip on these; see the empty-SG cases.
  const readySharedVpc = {
    ...base.sharedVpc,
    appSgId: "sg-0app0000000000",
    etlSgId: "sg-0etl0000000000",
    albSgId: "sg-0alb0000000000",
  };

  it("passes for the shipped config (useSharedVpc off)", () => {
    expect(() => assertSharedVpcConfig(base)).not.toThrow();
  });

  it("passes when useSharedVpc is on with a complete sharedVpc descriptor", () => {
    expect(() =>
      assertSharedVpcConfig({
        ...base,
        useSharedVpc: true,
        sharedVpc: readySharedVpc,
      }),
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

  for (const sg of ["appSgId", "etlSgId", "albSgId"] as const) {
    it(`throws when shared-VPC-on with an empty ${sg}`, () => {
      expect(() =>
        assertSharedVpcConfig({
          ...base,
          useSharedVpc: true,
          sharedVpc: { ...readySharedVpc, [sg]: "" },
        }),
      ).toThrow(new RegExp(`useSharedVpc requires sharedVpc\\.${sg}`));
    });
  }
});

// Cutover gate (docs/sps-vpc-consolidation-plan.md §6.2/§8.5/§8.6; #1370). Runs at
// the `bin` entrypoint, not in resolveEnvConfig, so it does not touch the flag-on
// placement tests (which synth stacks directly). useSharedVpc is a hard tripwire
// until the snapshot-restore data path lands: flipping it would CFN-replace the
// in-place Aurora/OpenSearch into empty datastores (forbidden, §8.6).
describe("assertCutoverGate", () => {
  it("is a no-op for the shipped config (useSharedVpc off) in both envs", () => {
    expect(() => assertCutoverGate(resolveEnvConfig("staging"))).not.toThrow();
    expect(() => assertCutoverGate(resolveEnvConfig("prod"))).not.toThrow();
  });

  for (const env of ["staging", "prod"] as const) {
    it(`hard-throws when useSharedVpc is flipped on WITHOUT a snapshot id for ${env} (also fails CI on a premature flip)`, () => {
      // Force the no-snapshot-id case explicitly: staging now ships a real
      // auroraSnapshotIdentifier (item-3 cutover), so overriding only useSharedVpc
      // would leave the id set and the gate would (correctly) not throw.
      const cfg = { ...resolveEnvConfig(env), useSharedVpc: true, auroraSnapshotIdentifier: undefined };
      expect(() => assertCutoverGate(cfg)).toThrow(/not yet deployable/);
      // The message names the prerequisites so the gate gives no false "safe" signal.
      expect(() => assertCutoverGate(cfg)).toThrow(/auroraSnapshotIdentifier/);
      expect(() => assertCutoverGate(cfg)).toThrow(
        /DatabaseClusterFromSnapshot/,
      );
      expect(() => assertCutoverGate(cfg)).toThrow(/appRwGranteeHost/);
      expect(() => assertCutoverGate(cfg)).toThrow(/reseed/);
    });

    it(`does NOT throw when useSharedVpc is on AND an auroraSnapshotIdentifier is set for ${env} (the snapshot-restore data path is wired)`, () => {
      const cfg = {
        ...resolveEnvConfig(env),
        useSharedVpc: true,
        auroraSnapshotIdentifier: "sps-cutover-snapshot",
      };
      expect(() => assertCutoverGate(cfg)).not.toThrow();
    });
  }
});

// Both envs share the shared VPC + subnets, but carry their OWN per-env SG ids
// (isolation is by per-env security group, never network — plan §4.5): staging
// overrides SHARED_VPC's empty SG fields via a spread, prod stays on the bare
// const until its cutover. The ED-export VPC is a separate, untouched field
// used only by the email-visibility bridge.
describe("sharedVpc descriptor", () => {
  for (const env of ["staging", "prod"] as const) {
    it(`${env}: ships the expected useSharedVpc flag and a populated sharedVpc`, () => {
      const cfg = resolveEnvConfig(env);
      // staging is cut over (item-3, 2026-07-02); prod stays standalone until its cutover.
      expect(cfg.useSharedVpc).toBe(env === "staging");
      expect(cfg.sharedVpc.vpcId).toMatch(/^vpc-/);
      expect(cfg.sharedVpc.appSubnetIds.length).toBeGreaterThan(0);
      expect(cfg.sharedVpc.dataSubnetIds.length).toBeGreaterThan(0);
      // The shared VPC is NOT the ED-export VPC (independently flippable).
      expect(cfg.sharedVpc.vpcId).not.toBe(cfg.edExportVpc.vpcId);
    });
  }

  // Per-env SG isolation: each env carries its OWN G8 SGs in the shared VPC
  // (staging item-3 2026-07-02, prod item-3 2026-07-05). Isolation is by per-env
  // SG (plan §4.5), so if a future edit put both envs on the shared const's SGs
  // they would collide — this asserts every tier's SG differs across envs.
  it("staging and prod each carry their own distinct SGs", () => {
    const staging = resolveEnvConfig("staging").sharedVpc;
    const prod = resolveEnvConfig("prod").sharedVpc;
    for (const sg of [
      staging.appSgId,
      staging.etlSgId,
      staging.albSgId,
      prod.appSgId,
      prod.etlSgId,
      prod.albSgId,
    ]) {
      expect(sg).toMatch(/^sg-/);
    }
    expect(staging.appSgId).not.toBe(prod.appSgId);
    expect(staging.etlSgId).not.toBe(prod.etlSgId);
    expect(staging.albSgId).not.toBe(prod.albSgId);
  });
});
