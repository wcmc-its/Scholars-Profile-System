import { Template } from "aws-cdk-lib/assertions";
import { NetworkStack } from "../lib/network-stack";
import { makeFixture } from "./test-utils";

describe("NetworkStack", () => {
  describe("prod", () => {
    const fixture = makeFixture("prod");
    const stack = new NetworkStack(fixture.app, "Sps-Network-prod", {
      env: fixture.env,
      envConfig: fixture.envConfig,
    });
    const template = Template.fromStack(stack);

    it("matches the snapshot", () => {
      expect(template.toJSON()).toMatchSnapshot();
    });

    it("creates exactly one VPC", () => {
      template.resourceCountIs("AWS::EC2::VPC", 1);
    });

    it("creates one NAT gateway in prod (EIP-cap-constrained — see config.ts)", () => {
      template.resourceCountIs("AWS::EC2::NatGateway", 1);
    });

    it("creates the three named security groups", () => {
      template.resourceCountIs("AWS::EC2::SecurityGroup", 3);
      for (const name of [
        "SPS Application Load Balancer (prod)",
        "SPS ECS application tasks (prod)",
        "SPS ETL Lambdas (prod)",
      ]) {
        template.hasResourceProperties("AWS::EC2::SecurityGroup", {
          GroupDescription: name,
        });
      }
    });

    it("creates no SecurityGroupIngress rules — default-deny in Phase 0", () => {
      template.resourceCountIs("AWS::EC2::SecurityGroupIngress", 0);
    });

    // #458/#443: the three RAM-shared WCM Resolver rules must stay
    // associated with the VPC so the ETL can resolve WCM-internal
    // hostnames. The rule ids are account-level shared-resource ids that
    // cannot be derived — pin them so a refactor can't silently drop or
    // mistype an association.
    it("associates the three WCM Route53 Resolver rules with the VPC", () => {
      template.resourceCountIs(
        "AWS::Route53Resolver::ResolverRuleAssociation",
        3,
      );
      for (const [ruleId, name] of [
        ["rslvr-rr-58457e95d34548148", "sps-prod-weillcornelledu"],
        ["rslvr-rr-467f0939c1f2458e9", "sps-prod-medcornelledu"],
        ["rslvr-rr-56f32331b3a1441ba", "sps-prod-wcmcadnet"],
      ] as const) {
        template.hasResourceProperties(
          "AWS::Route53Resolver::ResolverRuleAssociation",
          { ResolverRuleId: ruleId, Name: name },
        );
      }
    });

    it("synthesizes literal AZ names, not Fn::Select placeholders", () => {
      const subnets = template.findResources("AWS::EC2::Subnet");
      const azs = Object.values(subnets).map(
        (r) => (r as { Properties: { AvailabilityZone: unknown } }).Properties.AvailabilityZone,
      );
      expect(azs).toHaveLength(4);
      for (const az of azs) {
        expect(typeof az).toBe("string");
      }
      expect(new Set(azs)).toEqual(new Set(["us-east-1a", "us-east-1b"]));
    });
  });

  describe("staging", () => {
    const fixture = makeFixture("staging");
    const stack = new NetworkStack(fixture.app, "Sps-Network-staging", {
      env: fixture.env,
      envConfig: fixture.envConfig,
    });
    const template = Template.fromStack(stack);

    it("creates exactly one NAT gateway in staging", () => {
      template.resourceCountIs("AWS::EC2::NatGateway", 1);
    });

    it("synthesizes literal AZ names, not Fn::Select placeholders", () => {
      const subnets = template.findResources("AWS::EC2::Subnet");
      const azs = Object.values(subnets).map(
        (r) => (r as { Properties: { AvailabilityZone: unknown } }).Properties.AvailabilityZone,
      );
      expect(azs).toHaveLength(4);
      for (const az of azs) {
        expect(typeof az).toBe("string");
      }
      expect(new Set(azs)).toEqual(new Set(["us-east-1a", "us-east-1b"]));
    });

    it("creates no VPC peering connection by default (etlVpcPeeringEnabled off)", () => {
      template.resourceCountIs("AWS::EC2::VPCPeeringConnection", 0);
      // No peer-CIDR route either (the base VPC still has its NAT/IGW routes).
      const peerRoutes = Object.values(
        template.findResources("AWS::EC2::Route"),
      ).filter((r) => r.Properties?.DestinationCidrBlock === "10.46.134.0/24");
      expect(peerRoutes).toHaveLength(0);
    });
  });

  // docs/etl-vpc-migration-handoff.md (shared-VPC plan), step 1 — the Sps side
  // of the ETL cadence VPC peering to lts-reciter-vpc01. Built only when
  // etlVpcPeeringEnabled is flipped on. The real lts-reciter vpcId is a config
  // placeholder (pending networking, plan §12 Q1), so the fixture overrides
  // etlComputeVpc with a synthetic id — this tests the retargeting wiring
  // (peerVpcId = etlComputeVpc.vpcId), not the unknown real id.
  describe("ETL cadence VPC peering (etlVpcPeeringEnabled)", () => {
    const fixture = makeFixture("staging");
    const stack = new NetworkStack(fixture.app, "Sps-Network-staging", {
      env: fixture.env,
      envConfig: {
        ...fixture.envConfig,
        etlVpcPeeringEnabled: true,
        etlComputeVpc: {
          vpcId: "vpc-lts-reciter-test",
          availabilityZones: ["us-east-1a", "us-east-1b"],
          appSubnetIds: ["subnet-lts-a", "subnet-lts-b"],
        },
        etlPeerCidrs: ["10.46.134.0/24"],
      },
    });
    const template = Template.fromStack(stack);

    it("creates one peering connection to lts-reciter-vpc01 (same-account, no owner id)", () => {
      template.resourceCountIs("AWS::EC2::VPCPeeringConnection", 1);
      template.hasResourceProperties("AWS::EC2::VPCPeeringConnection", {
        // peerVpcId = etlComputeVpc (lts-reciter-vpc01); no PeerOwnerId /
        // PeerRegion → same-account, same-region, auto-accepted.
        PeerVpcId: "vpc-lts-reciter-test",
      });
      const peerings = Object.values(
        template.findResources("AWS::EC2::VPCPeeringConnection"),
      );
      expect(peerings[0]?.Properties?.PeerOwnerId).toBeUndefined();
      expect(peerings[0]?.Properties?.PeerRegion).toBeUndefined();
    });

    it("adds one return route per (route table × etlPeerCidrs): 1 CIDR × 2 RTs = 2", () => {
      // Two AZs → two private subnets → two route tables → two peer routes
      // (alongside the VPC's existing NAT/IGW routes).
      const peerRoutes = Object.values(
        template.findResources("AWS::EC2::Route"),
      ).filter((r) => r.Properties?.DestinationCidrBlock === "10.46.134.0/24");
      expect(peerRoutes).toHaveLength(2);
      for (const route of peerRoutes) {
        expect(route.Properties?.VpcPeeringConnectionId).toBeDefined();
      }
    });
  });

  // ENIs straddling both lts-reciter subnets → two placement CIDRs → one
  // CfnRoute per (cidr, route table). Synth succeeding with 4 routes implies
  // the construct ids are unique (a collision throws at synth).
  describe("ETL cadence VPC peering with two placement CIDRs", () => {
    const fixture = makeFixture("staging");
    const stack = new NetworkStack(fixture.app, "Sps-Network-staging", {
      env: fixture.env,
      envConfig: {
        ...fixture.envConfig,
        etlVpcPeeringEnabled: true,
        etlComputeVpc: {
          vpcId: "vpc-lts-reciter-test",
          availabilityZones: ["us-east-1a", "us-east-1b"],
          appSubnetIds: ["subnet-lts-a", "subnet-lts-b"],
        },
        etlPeerCidrs: ["10.46.134.0/24", "10.46.160.0/24"],
      },
    });
    const template = Template.fromStack(stack);

    it("creates one CfnRoute per (cidr, route table) = 2 × 2 = 4", () => {
      const allRoutes = Object.values(template.findResources("AWS::EC2::Route"));
      const c1 = allRoutes.filter(
        (r) => r.Properties?.DestinationCidrBlock === "10.46.134.0/24",
      );
      const c2 = allRoutes.filter(
        (r) => r.Properties?.DestinationCidrBlock === "10.46.160.0/24",
      );
      expect(c1).toHaveLength(2);
      expect(c2).toHaveLength(2);
    });
  });
});
