import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as route53resolver from "aws-cdk-lib/aws-route53resolver";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { type Construct } from "constructs";
import { type SpsEnvConfig } from "./config";

/** Props for {@link NetworkStack}. */
export interface NetworkStackProps extends StackProps {
  /** Resolved per-environment configuration. */
  readonly envConfig: SpsEnvConfig;
}

/**
 * NetworkStack — the VPC and security groups for the Scholars Profile System.
 *
 * Stack 1 of the six defined in ADR-008. It owns the network substrate every
 * other stack attaches to: a two-AZ VPC with public and private-with-egress
 * subnets, and the three security groups that define reachability between the
 * ECS application tasks, the ETL Lambdas, and the load balancer.
 *
 * Phase 0 creates the security groups with no ingress rules — default-deny.
 * The security-group-to-security-group ingress (ALB → app, and ETL → the
 * internal `/api/revalidate` listener; B05) is added in Phase 2 / Phase 3,
 * when the load balancer and its listeners exist. VPC endpoints (B17) are
 * added to this stack in Phase 4. The groups are exposed as readonly
 * properties so the later stacks reference them across stack boundaries.
 */
export class NetworkStack extends Stack {
  /**
   * The VPC every Scholars Profile System workload runs in — either a VPC this
   * stack creates (default) or, when {@link SpsEnvConfig.useSharedVpc} is on,
   * the shared its-reciter-vpc01 imported by attributes (plan §5.3). Typed
   * `IVpc` so both paths satisfy it.
   */
  public readonly vpc: ec2.IVpc;

  /** Security group for the ECS application tasks. */
  public readonly appSecurityGroup: ec2.SecurityGroup;

  /** Security group for the ETL Lambdas. */
  public readonly etlSecurityGroup: ec2.SecurityGroup;

  /** Security group for the Application Load Balancer. */
  public readonly albSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    const { envConfig } = props;

    // Estate consolidation (plan §5.3): when useSharedVpc is on, import the
    // shared its-reciter-vpc01 by attributes (no context lookup → deterministic
    // synth) and own no VPC/subnets/NAT/IGW. Otherwise create the standalone Sps
    // VPC exactly as before — the default both envs ship, so flag-off synth is
    // byte-identical. Downstream stacks select explicit per-tier subnet ids when
    // shared (subnetType filtering is unreliable on an imported VPC); the VPC
    // attributes list every tier so the import is complete.
    if (envConfig.useSharedVpc) {
      const sv = envConfig.sharedVpc;
      // Only vpcId + AZs — every downstream placement selects explicit per-tier
      // subnet ids (resolveTierSubnets), so the import needs no subnet lists,
      // and omitting them avoids CDK's "privateSubnetIds must be a multiple of
      // availabilityZones" pairing (which could mis-assign a subnet's AZ).
      this.vpc = ec2.Vpc.fromVpcAttributes(this, "SharedVpc", {
        vpcId: sv.vpcId,
        availabilityZones: [...sv.availabilityZones],
      });
    } else {
      // Two AZs — enough for an ALB and a Multi-AZ Aurora cluster, no more than
      // the workload needs. Public subnets carry the ALB and the NAT gateways;
      // private-with-egress subnets carry the ECS tasks, Aurora, OpenSearch, and
      // the ETL Lambdas — unreachable from the internet, able only to reach out
      // through the NAT gateway.
      this.vpc = new ec2.Vpc(this, "Vpc", {
        ipAddresses: ec2.IpAddresses.cidr(envConfig.vpcCidr),
        availabilityZones: ["us-east-1a", "us-east-1b"],
        natGateways: envConfig.natGateways,
        subnetConfiguration: [
          { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
          {
            name: "private",
            subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
            cidrMask: 22,
          },
        ],
      });
    }

    // WCM-internal DNS resolution. The ETL (and any in-VPC client) must resolve
    // WCM-internal hostnames -- ED LDAP (edprovider.weill.cornell.edu) and the
    // ASMS/InfoEd/COI/ReciterDB sources -- to pull source data. Resolution is
    // delegated to the Central Services account's (091981818184) RAM-shared
    // Route 53 Resolver FORWARD rules ("Resolver Share <domain>"); associating
    // them with this VPC sends those domains to the shared outbound endpoint --
    // the same wiring ReCiter's EKS VPC uses. The rule ids are account-level
    // (shared once into 665083158573), so they are identical for staging and
    // prod. NOTE: resolution is necessary but not sufficient -- reaching the
    // resolved IPs also needs the Central Services TGW attachment + WCM-side
    // firewall for this VPC's CIDR, which are owned by 091981818184 / WCM
    // network and tracked separately. ResolverRuleId is a stable shared-resource
    // id, intentionally inlined (no CDK construct exists for an out-of-account
    // shared rule).
    // Skipped when sharing its-reciter-vpc01: a resolver rule associates to a
    // VPC exactly once, and its-reciter already associates all three (plan
    // §5.3 / G7), so re-associating would fail RuleAlreadyAssociated. SPS owns
    // these associations only for the standalone Sps VPC it creates.
    if (!envConfig.useSharedVpc) {
      const wcmResolverRules: ReadonlyArray<{ key: string; ruleId: string }> = [
        { key: "WeillCornellEdu", ruleId: "rslvr-rr-58457e95d34548148" },
        { key: "MedCornellEdu", ruleId: "rslvr-rr-467f0939c1f2458e9" },
        { key: "WcmcAdNet", ruleId: "rslvr-rr-56f32331b3a1441ba" },
      ];
      for (const { key, ruleId } of wcmResolverRules) {
        new route53resolver.CfnResolverRuleAssociation(
          this,
          `WcmResolverAssoc${key}`,
          {
            resolverRuleId: ruleId,
            vpcId: this.vpc.vpcId,
            name: `sps-${envConfig.envName}-${key.toLowerCase()}`,
          },
        );
      }
    }

    // Security groups. Each is created with egress allowed and no ingress
    // rules; the SG-to-SG ingress that defines reachability is added by the
    // stacks that own the listeners and services (ADR-008, B05). Defining the
    // groups here keeps the network topology in one reviewable place.
    this.albSecurityGroup = new ec2.SecurityGroup(this, "AlbSecurityGroup", {
      vpc: this.vpc,
      description: `SPS Application Load Balancer (${envConfig.envName})`,
      allowAllOutbound: true,
    });

    this.appSecurityGroup = new ec2.SecurityGroup(this, "AppSecurityGroup", {
      vpc: this.vpc,
      description: `SPS ECS application tasks (${envConfig.envName})`,
      allowAllOutbound: true,
    });

    this.etlSecurityGroup = new ec2.SecurityGroup(this, "EtlSecurityGroup", {
      vpc: this.vpc,
      description: `SPS ETL Lambdas (${envConfig.envName})`,
      allowAllOutbound: true,
    });

    // Item-3 pass 1 (publish; docs/cutover-item3-implementation-map-2026-06-30.md).
    // Echo the flag-appropriate network ids to SSM so pass-2 consumers import them
    // by id (fromVpcAttributes / resolveTierSubnets / fromSecurityGroupId) instead
    // of cross-stack Ref handles — that severs the export edges that would lock the
    // useSharedVpc flip. Flag-off the values are this stack's standalone resources;
    // flag-on they are the shared its-reciter ids from config. Nothing reads these
    // until pass 2, so publishing them is additive and flag-off byte-behavioral.
    const shared = envConfig.useSharedVpc;
    const sv = envConfig.sharedVpc;
    const netParam = (name: string, value: string): void => {
      new ssm.StringParameter(this, `Net-${name}`, {
        parameterName: `/sps/${envConfig.envName}/net/${name}`,
        stringValue: value,
      });
    };

    netParam("vpc-id", this.vpc.vpcId);

    // Two AZs → exactly two subnet ids per tier. Write one param per AZ (fixed
    // count) because an SSM string-list reads back as a synth-opaque token pass-2
    // could not map over. Flag-off the standalone tiers are private (app+data) and
    // public (alb); flag-on they are the explicit its-reciter per-tier ids.
    const privateIds = shared
      ? null
      : this.vpc.selectSubnets({
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        }).subnetIds;
    const publicIds = shared
      ? null
      : this.vpc.selectSubnets({ subnetType: ec2.SubnetType.PUBLIC }).subnetIds;
    const tierSubnetIds: ReadonlyArray<readonly [string, readonly string[]]> = [
      ["app", shared ? sv.appSubnetIds : privateIds!],
      ["data", shared ? sv.dataSubnetIds : privateIds!],
      ["alb", shared ? sv.albSubnetIds : publicIds!],
    ];
    for (const [tier, ids] of tierSubnetIds) {
      ids.forEach((id, i) => netParam(`${tier}-subnet-${i}`, id));
    }

    netParam("app-sg-id", shared ? sv.appSgId : this.appSecurityGroup.securityGroupId);
    netParam("etl-sg-id", shared ? sv.etlSgId : this.etlSecurityGroup.securityGroupId);
    netParam("alb-sg-id", shared ? sv.albSgId : this.albSecurityGroup.securityGroupId);

    // exportValue pins (item-3 pass 1): keep the auto-generated cross-stack Ref
    // exports for the VPC + 3 SGs (+ the imported subnets) alive after pass-2 drops
    // the consumer imports, so a producer-first NetworkStack redeploy during the
    // transition never hits "cannot delete export in use". Only meaningful flag-off
    // (the standalone resources these export); flag-on there are no such exports.
    // Removed in the pass-4 cleanup once every consumer is confirmed repointed.
    if (!shared) {
      this.exportValue(this.vpc.vpcId);
      this.exportValue(this.appSecurityGroup.securityGroupId);
      this.exportValue(this.etlSecurityGroup.securityGroupId);
      this.exportValue(this.albSecurityGroup.securityGroupId);
      // The private tier also exports a route-table ref (a consumer routes through
      // it); the public tier exports only its subnet ref. Pin exactly the set
      // `cdk synth Sps-Network-<env>` shows so no in-use export is orphaned.
      for (const subnet of this.vpc.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      }).subnets) {
        this.exportValue(subnet.subnetId);
        this.exportValue(subnet.routeTable.routeTableId);
      }
      for (const subnet of this.vpc.selectSubnets({
        subnetType: ec2.SubnetType.PUBLIC,
      }).subnets) {
        this.exportValue(subnet.subnetId);
      }
    }

    // Outputs — surfaced so the `cdk diff` / deploy review (ADR-008's
    // verification model) and the later stacks have stable references.
    new CfnOutput(this, "VpcId", {
      value: this.vpc.vpcId,
      description: "SPS VPC id",
    });
    new CfnOutput(this, "AppSecurityGroupId", {
      value: this.appSecurityGroup.securityGroupId,
      description: "SPS application-tier security group id",
    });
    new CfnOutput(this, "EtlSecurityGroupId", {
      value: this.etlSecurityGroup.securityGroupId,
      description: "SPS ETL security group id",
    });
    new CfnOutput(this, "AlbSecurityGroupId", {
      value: this.albSecurityGroup.securityGroupId,
      description: "SPS load-balancer security group id",
    });
  }
}
