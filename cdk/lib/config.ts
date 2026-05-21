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
  /** Disaster-recovery region for B10's cross-region snapshot copy (ADR-008). */
  readonly drRegion: string;
  /** IPv4 CIDR block for the VPC; distinct per environment. */
  readonly vpcCidr: string;
  /** Number of NAT gateways — one per AZ in production, one in staging. */
  readonly natGateways: number;

  // --- DataStack (Phase 1) ---

  /** Aurora Serverless v2 minimum capacity (ACUs). */
  readonly auroraMinCapacity: number;
  /** Aurora Serverless v2 maximum capacity (ACUs). */
  readonly auroraMaxCapacity: number;
  /**
   * Number of Aurora reader instances in addition to the writer. Zero in
   * staging (writer-only); one in production (reader endpoint backs the
   * `db.read` PrismaClient per PRODUCTION_ADDENDUM.md § Reader/writer split).
   */
  readonly auroraReaderCount: number;
  /**
   * Aurora backup retention in days — drives the PITR window and native
   * automated snapshot retention (Aurora ties them). B10 §1 sets the PITR
   * window at 14 days; AWS Backup (below) provides the longer 35-day
   * archive that the same B10 row asks for.
   */
  readonly auroraBackupRetentionDays: number;
  /**
   * Number of OpenSearch data nodes. One in staging (single-AZ); two in
   * production (multi-AZ across the VPC's two AZs — the multi-AZ-with-standby
   * mode that AWS recommends needs three AZs, which would require bumping
   * NetworkStack from two AZs to three and is out of scope for this phase).
   */
  readonly opensearchDataNodes: number;
  /** OpenSearch data-node instance type. */
  readonly opensearchDataNodeInstanceType: string;

  // --- AWS Backup (B10) ---

  /**
   * AWS Backup vault retention in days for the daily plan. Longer than the
   * Aurora native backup window — this is the archive layer that gives B10
   * its 35-day target in prod while keeping the Aurora retention at the
   * documented 14 days.
   */
  readonly awsBackupRetentionDays: number;
}

const ENV_CONFIG: Record<EnvName, SpsEnvConfig> = {
  staging: {
    envName: "staging",
    region: "us-east-1",
    drRegion: "us-west-2",
    vpcCidr: "10.20.0.0/16",
    natGateways: 1,
    auroraMinCapacity: 0.5,
    auroraMaxCapacity: 2,
    auroraReaderCount: 0,
    auroraBackupRetentionDays: 14,
    opensearchDataNodes: 1,
    opensearchDataNodeInstanceType: "t3.small.search",
    awsBackupRetentionDays: 14,
  },
  prod: {
    envName: "prod",
    region: "us-east-1",
    drRegion: "us-west-2",
    vpcCidr: "10.10.0.0/16",
    // One NAT gateway in prod, not two — the account is at its EIP cap
    // (7 EIPs already in use across ReCiter + staging SPS, allocation
    // request denied 2026-05-20). A second prod NAT pushes past the cap.
    // Trade-off accepted at launch: if the NAT's AZ fails, ECS tasks in
    // the other AZ lose outbound; for a CDN-fronted read-mostly app the
    // user-visible impact is small. Raise the EIP quota and bump this
    // to 2 post-launch.
    natGateways: 1,
    auroraMinCapacity: 1,
    auroraMaxCapacity: 8,
    auroraReaderCount: 1,
    auroraBackupRetentionDays: 14,
    opensearchDataNodes: 2,
    opensearchDataNodeInstanceType: "m6g.large.search",
    awsBackupRetentionDays: 35,
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
