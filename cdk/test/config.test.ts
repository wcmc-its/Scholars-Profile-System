import { assertEtlMigrationInvariants, resolveEnvConfig } from "../lib/config";

// docs/etl-vpc-migration-handoff.md (shared-VPC plan) — the cadence cannot
// relocate into the shared its-reciter-vpc01 before (a) the VPC peering exists
// (every datastore write would be stranded) and (b) the per-env ETL SG id the
// datastores reference is set (an empty id would synth a broken ingress rule).
// resolveEnvConfig enforces these; the guard is exported so the invariant is
// testable with synthetic configs.
describe("assertEtlMigrationInvariants", () => {
  const base = resolveEnvConfig("staging");
  const ETL_SG = "sg-staging-etl-test";
  // A fully-filled etlComputeVpc — the shipped config leaves these as ""/[]
  // placeholders (pending networking), so any "passes when peered/relocated"
  // case must supply real-shaped ids to clear the synth-time guards.
  const ETL_VPC = {
    vpcId: "vpc-its-reciter-test",
    availabilityZones: ["us-east-1a", "us-east-1b"],
    appSubnetIds: ["subnet-lts-a", "subnet-lts-b"],
  };

  it("passes for the shipped config (both flags off)", () => {
    expect(() => assertEtlMigrationInvariants(base)).not.toThrow();
  });

  it("passes for the intended phase-1 state (peering on + ids, relocation off)", () => {
    expect(() =>
      assertEtlMigrationInvariants({
        ...base,
        etlVpcPeeringEnabled: true,
        etlComputeSecurityGroupId: ETL_SG,
        etlComputeVpc: ETL_VPC,
      }),
    ).not.toThrow();
  });

  it("passes when both are on (fully activated)", () => {
    expect(() =>
      assertEtlMigrationInvariants({
        ...base,
        etlVpcPeeringEnabled: true,
        etlCadenceVpcRelocated: true,
        etlComputeSecurityGroupId: ETL_SG,
        etlComputeVpc: ETL_VPC,
      }),
    ).not.toThrow();
  });

  it("throws when the cadence is relocated without peering", () => {
    expect(() =>
      assertEtlMigrationInvariants({ ...base, etlCadenceVpcRelocated: true }),
    ).toThrow(/etlCadenceVpcRelocated requires etlVpcPeeringEnabled/);
  });

  it("throws when peered without the per-env ETL SG id", () => {
    // base.etlComputeSecurityGroupId is the "" placeholder; peering needs it set
    // because the SG-reference ingress is created at peer time, for the probe.
    expect(() =>
      assertEtlMigrationInvariants({
        ...base,
        etlVpcPeeringEnabled: true,
        etlComputeVpc: ETL_VPC,
      }),
    ).toThrow(/etlVpcPeeringEnabled requires etlComputeSecurityGroupId/);
  });

  it("throws when peered without the etlComputeVpc.vpcId (empty placeholder)", () => {
    // SG id supplied, but base.etlComputeVpc.vpcId is still "" — the peering
    // connection's peerVpcId would be empty and fail only at deploy.
    expect(() =>
      assertEtlMigrationInvariants({
        ...base,
        etlVpcPeeringEnabled: true,
        etlComputeSecurityGroupId: ETL_SG,
      }),
    ).toThrow(/etlVpcPeeringEnabled requires etlComputeVpc\.vpcId/);
  });

  it("throws when relocated without any etlComputeVpc.appSubnetIds", () => {
    expect(() =>
      assertEtlMigrationInvariants({
        ...base,
        etlVpcPeeringEnabled: true,
        etlCadenceVpcRelocated: true,
        etlComputeSecurityGroupId: ETL_SG,
        etlComputeVpc: { ...ETL_VPC, appSubnetIds: [] },
      }),
    ).toThrow(/etlCadenceVpcRelocated requires at least one etlComputeVpc\.appSubnetId/);
  });

  it("throws when etlPeerCidrs is empty", () => {
    expect(() =>
      assertEtlMigrationInvariants({ ...base, etlPeerCidrs: [] }),
    ).toThrow(/etlPeerCidrs must hold 1–2/);
  });

  it("throws when etlPeerCidrs has more than two entries", () => {
    expect(() =>
      assertEtlMigrationInvariants({
        ...base,
        etlPeerCidrs: ["10.46.134.0/24", "10.46.160.0/24", "10.46.200.0/24"],
      }),
    ).toThrow(/etlPeerCidrs must hold 1–2/);
  });
});

// Guard against accidentally pointing the relocated ETL compute back at the
// ED-export VPC (scholars-dev/prod): etlComputeVpc is a SEPARATE field
// (its-reciter-vpc01) so the bridge and the cadence are independently flippable.
describe("etlComputeVpc is distinct from edExportVpc", () => {
  for (const env of ["staging", "prod"] as const) {
    it(`${env}: etlComputeVpc.vpcId !== edExportVpc.vpcId`, () => {
      const cfg = resolveEnvConfig(env);
      expect(cfg.etlComputeVpc.vpcId).not.toBe(cfg.edExportVpc.vpcId);
    });
  }
});
