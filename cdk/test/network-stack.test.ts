import { Template } from "aws-cdk-lib/assertions";
import { NetworkStack } from "../lib/network-stack";
import { makeFixture } from "./test-utils";

describe("NetworkStack", () => {
  // Estate consolidation (plan §5.3): with useSharedVpc on, the stack imports
  // its-reciter-vpc01 instead of creating a VPC, and drops the resolver-rule
  // associations (its-reciter already has them — re-associating would fail).
  describe("shared VPC (useSharedVpc on)", () => {
    const fixture = makeFixture("staging");
    const stack = new NetworkStack(fixture.app, "Sps-Network-staging-shared", {
      env: fixture.env,
      envConfig: { ...fixture.envConfig, useSharedVpc: true },
    });
    const template = Template.fromStack(stack);

    it("creates no VPC / subnets / NAT / IGW (imports the shared VPC)", () => {
      template.resourceCountIs("AWS::EC2::VPC", 0);
      template.resourceCountIs("AWS::EC2::Subnet", 0);
      template.resourceCountIs("AWS::EC2::NatGateway", 0);
      template.resourceCountIs("AWS::EC2::InternetGateway", 0);
    });

    it("drops the WCM resolver-rule associations", () => {
      template.resourceCountIs(
        "AWS::Route53Resolver::ResolverRuleAssociation",
        0,
      );
    });

    it("defines the per-env security groups against the imported VPC", () => {
      template.hasResourceProperties("AWS::EC2::SecurityGroup", {
        VpcId: "vpc-08a1873fc8eebae28",
      });
    });
  });

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

    it("creates no NAT gateway in staging (imports shared its-reciter-vpc01, item-3 cutover)", () => {
      // Post-item-3 staging is on the shared VPC (useSharedVpc:true), so
      // NetworkStack imports it via fromVpcAttributes and creates no NAT.
      template.resourceCountIs("AWS::EC2::NatGateway", 0);
    });

    it("imports the shared VPC — creates no VPC or subnets in staging", () => {
      // fromVpcAttributes import: no standalone VPC/subnets are synthesized.
      // (The standalone literal-AZ invariant is covered by the prod block, which
      // is still flag-off until its own cutover.)
      template.resourceCountIs("AWS::EC2::VPC", 0);
      expect(Object.keys(template.findResources("AWS::EC2::Subnet"))).toHaveLength(0);
    });

    it("creates no VPC peering connection (consolidation has no peer)", () => {
      template.resourceCountIs("AWS::EC2::VPCPeeringConnection", 0);
      // No peer-CIDR route either (the base VPC still has its NAT/IGW routes).
      const peerRoutes = Object.values(
        template.findResources("AWS::EC2::Route"),
      ).filter((r) => r.Properties?.DestinationCidrBlock === "10.46.134.0/24");
      expect(peerRoutes).toHaveLength(0);
    });
  });

});
