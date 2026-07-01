import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { type Construct } from "constructs";
import { type SpsEnvConfig } from "./config";

/** A placement tier in the estate-consolidation subnet layout (plan §4.4). */
export type SharedTier = "app" | "data" | "alb";

/** A security-group tier NetworkStack publishes to SSM (item-3 pass 1). */
export type SharedSgTier = "app" | "etl" | "alb";

/** SSM parameter name NetworkStack (item-3 pass 1) publishes a `net/*` id under. */
const netParamName = (cfg: SpsEnvConfig, name: string): string =>
  `/sps/${cfg.envName}/net/${name}`;

/**
 * Resolve the {@link ec2.SubnetSelection} for one placement tier.
 *
 * When {@link SpsEnvConfig.useSharedVpc} is off (the shipped default) this
 * returns the standalone Sps VPC's `PRIVATE_WITH_EGRESS` tier (compute/data) or
 * `PUBLIC` tier (alb) — byte-identical to pre-consolidation synth.
 *
 * When it is on, `subnetType` filtering is unreliable on an imported VPC, so we
 * import the tier's explicit its-reciter subnet ids by attributes (no context
 * lookup → deterministic synth). The per-tier id arrays in `sharedVpc` are
 * **AZ-ordered**: subnet `i` is paired with `availabilityZones[i]`, which Aurora
 * (writer+reader) and the zone-aware OpenSearch domain depend on. `idPrefix`
 * scopes the imported `Subnet` construct ids; pass a distinct prefix per call
 * site and call once per tier per stack (a repeat call collides the ids).
 */
export function resolveTierSubnets(
  scope: Construct,
  cfg: SpsEnvConfig,
  tier: SharedTier,
  idPrefix: string,
): ec2.SubnetSelection {
  if (!cfg.useSharedVpc) {
    return {
      subnetType:
        tier === "alb"
          ? ec2.SubnetType.PUBLIC
          : ec2.SubnetType.PRIVATE_WITH_EGRESS,
    };
  }
  const sv = cfg.sharedVpc;
  const ids =
    tier === "data"
      ? sv.dataSubnetIds
      : tier === "alb"
        ? sv.albSubnetIds
        : sv.appSubnetIds;
  return {
    subnets: ids.map((id, i) =>
      ec2.Subnet.fromSubnetAttributes(scope, `${idPrefix}${i}`, {
        subnetId: id,
        availabilityZone: sv.availabilityZones[i],
      }),
    ),
  };
}

/**
 * Import a security group by id, flag-appropriate. When `useSharedVpc` is off
 * (shipped default) the standalone CDK-created SG id is read from the
 * `/sps/<env>/net/<tier>-sg-id` param NetworkStack publishes — byte-identical to
 * pre-consolidation synth. When it is on, the out-of-band shared SG id is read
 * **directly from the `cfg.sharedVpc.<tier>SgId` config literal**, NOT from
 * Network's SSM echo: a consumer that read the param would depend on Network
 * running first, forcing producer-first ordering and re-creating the export
 * lock. Reading the literal lets the flip deploy **consumers-first** (Data → App
 * → Etl before Network; item-3 §4) — the fail-closed `assertSharedVpcConfig`
 * guarantees the literal is populated before `useSharedVpc` is flipped. Either
 * way this replaces the cross-stack SG handle consumers received from
 * NetworkStack, severing the `Ref` export that would otherwise lock the flip.
 *
 * **`mutable: false` is deliberate.** Every ingress rule these SGs receive is an
 * explicit standalone L1 `CfnSecurityGroupIngress` keyed on `.securityGroupId`
 * (they survive the switch untouched); nothing in CDK calls `.addIngressRule`
 * on them. Left mutable, the ALB's `open:true` listener would re-materialise its
 * "allow anyone :80" rule *into the consumer stack*, duplicating the explicit
 * `PublicAlbIngressFromInternet` L1 rule. Immutable, CDK suppresses that auto
 * rule (as it did when the SG lived in NetworkStack), keeping the template exact.
 * The out-of-band SGs' base ingress is owned by the shared-VPC team, not CDK.
 */
export function resolveSharedSg(
  scope: Construct,
  cfg: SpsEnvConfig,
  tier: SharedSgTier,
  idPrefix: string,
): ec2.ISecurityGroup {
  const sgId = cfg.useSharedVpc
    ? tier === "app"
      ? cfg.sharedVpc.appSgId
      : tier === "etl"
        ? cfg.sharedVpc.etlSgId
        : cfg.sharedVpc.albSgId
    : ssm.StringParameter.valueForStringParameter(
        scope,
        netParamName(cfg, `${tier}-sg-id`),
      );
  return ec2.SecurityGroup.fromSecurityGroupId(scope, idPrefix, sgId, {
    mutable: false,
  });
}
