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

    it("creates two NAT gateways in prod", () => {
      template.resourceCountIs("AWS::EC2::NatGateway", 2);
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
  });
});
