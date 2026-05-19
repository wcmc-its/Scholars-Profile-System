/**
 * Per-environment configuration for the Scholars Profile System infrastructure.
 *
 * ADR-008: staging and production are separate AWS accounts. Account ids are
 * supplied as CDK context at deploy time (`-c <envName>Account=<id>`) and are
 * never committed; with the account context absent the stacks synthesize
 * environment-agnostic, which is what CI does.
 */

/** The two deployment environments. */
export type EnvName = "staging" | "prod";

/** Resolved configuration for one environment. */
export interface SpsEnvConfig {
  /** Environment name — drives stack naming. */
  readonly envName: EnvName;
  /** Primary AWS region (ADR-008). */
  readonly region: string;
  /** IPv4 CIDR block for the VPC; distinct per environment. */
  readonly vpcCidr: string;
  /** Number of Availability Zones the VPC spans. */
  readonly maxAzs: number;
  /** Number of NAT gateways — one per AZ in production, one in staging. */
  readonly natGateways: number;
}

const ENV_CONFIG: Record<EnvName, SpsEnvConfig> = {
  staging: {
    envName: "staging",
    region: "us-east-1",
    vpcCidr: "10.20.0.0/16",
    maxAzs: 2,
    natGateways: 1,
  },
  prod: {
    envName: "prod",
    region: "us-east-1",
    vpcCidr: "10.10.0.0/16",
    maxAzs: 2,
    natGateways: 2,
  },
};

function isEnvName(value: string): value is EnvName {
  return value === "staging" || value === "prod";
}

/**
 * Resolve the environment config from the `-c env=<name>` CDK context value.
 * Defaults to `staging` when the context is unset.
 *
 * @throws if the context value is neither `staging` nor `prod`.
 */
export function resolveEnvConfig(envContext: unknown): SpsEnvConfig {
  const name = envContext == null ? "staging" : String(envContext);
  if (!isEnvName(name)) {
    throw new Error(
      `Unknown CDK context env="${name}" — pass -c env=staging or -c env=prod.`,
    );
  }
  return ENV_CONFIG[name];
}
