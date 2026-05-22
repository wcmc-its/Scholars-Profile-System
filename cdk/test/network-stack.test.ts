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
  });
});
