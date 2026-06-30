import * as ec2 from "aws-cdk-lib/aws-ec2";
import { type Construct } from "constructs";
import { type SpsEnvConfig } from "./config";

/** A placement tier in the estate-consolidation subnet layout (plan §4.4). */
export type SharedTier = "app" | "data" | "alb";

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
