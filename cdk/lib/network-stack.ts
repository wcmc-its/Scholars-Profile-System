import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as route53resolver from "aws-cdk-lib/aws-route53resolver";
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
  /** The VPC every Scholars Profile System workload runs in. */
  public readonly vpc: ec2.Vpc;

  /** Security group for the ECS application tasks. */
  public readonly appSecurityGroup: ec2.SecurityGroup;

  /** Security group for the ETL Lambdas. */
  public readonly etlSecurityGroup: ec2.SecurityGroup;

  /** Security group for the Application Load Balancer. */
  public readonly albSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    const { envConfig } = props;

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

    // ------------------------------------------------------------------
    // ETL cadence VPC peering (docs/etl-vpc-migration-handoff.md, shared-VPC plan).
    //
    // The ETL cadence relocates into the shared TGW-attached its-reciter-vpc01
    // (envConfig.etlComputeVpc), which hosts BOTH envs' ETL, to read on-prem +
    // 10.46.x sources, and reaches Aurora / OpenSearch / the internal ALB back
    // here over an intra-account VPC peering connection. This stack owns the
    // requester side:
    //   - the peering connection itself. Same account + same region, so AWS
    //     auto-accepts it on create — no manual accept step.
    //   - the RETURN route on each Sps private subnet's route table
    //     (etlPeerCidrs → pcx), so a datastore's reply to a relocated task
    //     (10.46.x) goes to the peer instead of following the VPC's default
    //     local/NAT path. (Aurora, OpenSearch, and the in-Sps ETL all live in
    //     the `private` PRIVATE_WITH_EGRESS subnets here — there is no isolated
    //     tier — so these are the only route tables that need the route.)
    //
    // The its-reciter-side route (10.20/16 [staging] / 10.10/16 [prod] → this
    // pcx) is added out-of-band in that VPC; it isn't ours to mutate from CDK.
    //
    // Gated on its OWN flag, separate from etlCadenceVpcRelocated, so the peer
    // + the datastore ingress can go up and be probed from its-reciter-vpc01
    // BEFORE the cadence tasks move. resolveEnvConfig enforces relocated ⇒ peered.
    // ------------------------------------------------------------------
    if (envConfig.etlVpcPeeringEnabled) {
      const peering = new ec2.CfnVPCPeeringConnection(
        this,
        "EtlCadenceVpcPeering",
        {
          vpcId: this.vpc.vpcId,
          peerVpcId: envConfig.etlComputeVpc.vpcId,
          // Same account + region → omit peerOwnerId/peerRegion (auto-accepted).
          tags: [
            {
              key: "Name",
              value: `sps-etl-cadence-peer-${envConfig.envName}`,
            },
          ],
        },
      );
      const seenRouteTables = new Set<string>();
      this.vpc.privateSubnets.forEach((subnet, i) => {
        const routeTableId = subnet.routeTable.routeTableId;
        if (seenRouteTables.has(routeTableId)) {
          return;
        }
        seenRouteTables.add(routeTableId);
        // One return route per (route table, its-reciter placement CIDR). The
        // route-table id is a CFN token (can't be a construct-id segment), so
        // the id combines the dedup index with a slug of the literal CIDR —
        // unique per pair even when etlPeerCidrs holds both subnets.
        envConfig.etlPeerCidrs.forEach((cidr) => {
          const cidrSlug = cidr.replace(/[./]/g, "_");
          new ec2.CfnRoute(this, `EtlCadencePeerRoute${i}-${cidrSlug}`, {
            routeTableId,
            destinationCidrBlock: cidr,
            vpcPeeringConnectionId: peering.ref,
          });
        });
      });
      new CfnOutput(this, "EtlCadenceVpcPeeringId", {
        value: peering.ref,
        description:
          "ETL cadence VPC peering connection id (Sps ↔ its-reciter-vpc01). Add the its-reciter-side route 10.20/16 [staging] / 10.10/16 [prod] → this pcx out-of-band.",
      });
    }
  }
}
