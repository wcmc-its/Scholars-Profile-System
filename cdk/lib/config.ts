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

  // --- AppStack (Phase 2) ---

  /**
   * Desired ECS task count for the SPS application service. Staging runs
   * one task; prod runs two so a single AZ failure does not take the app
   * fully offline. Tunable here so the bootstrap deploy can be temporarily
   * driven to zero via `-c appDesiredCount=0` while the first image is
   * pushed to ECR (see `feat-infra-phase2-appstack.md § Deploy strategy`).
   */
  readonly appDesiredCount: number;
  /**
   * Fargate CPU units for the app task definition. Must combine with
   * {@link appMemoryMiB} to form a valid Fargate (cpu, memory) pair —
   * AppStack's tests assert the combination against a small allowlist
   * since the L2 helper accepts invalid pairs and AWS only rejects them
   * at run time.
   */
  readonly appCpu: number;
  /** Fargate memory (MiB) for the app task definition. */
  readonly appMemoryMiB: number;
  /**
   * Fargate CPU units for the one-shot `prisma migrate deploy` task.
   * Smaller than the app task — the migration runs briefly and is
   * single-threaded against Aurora.
   */
  readonly migrationTaskCpu: number;
  /** Fargate memory (MiB) for the migration task definition. */
  readonly migrationTaskMemoryMiB: number;
  /**
   * SAML SP entityID this environment registers with the WCM IdP (#466).
   * The app advertises it in `/api/auth/saml/metadata` and the IdP must have
   * the exact same value on file, else login fails with a SAML Responder
   * error. Per-env because the two SPs (`scholars-staging` / `scholars`) are
   * distinct entities. Convention is the SP metadata URL (matches
   * `.env.example`); the registered value is config-driven so confirming it
   * with the SAML contact is a config edit, not a code change.
   */
  readonly samlSpEntityId: string;
  /**
   * SAML SP Assertion Consumer Service URL — where the IdP POSTs the
   * SAMLResponse (#466). Always `https://<host>/api/auth/saml/callback`
   * (the route is `/callback`, not `/acs`); per-env off the public host.
   * Must be browser-reachable (custom-domain DNS live) for the round-trip
   * to complete, so E2E waits on the app-CNAME even though the wiring lands
   * now.
   */
  readonly samlSpAcsUrl: string;

  // --- EtlStack (Phase 3) ---

  /**
   * Whether the EventBridge schedules that fire the nightly / weekly /
   * annual state machines are enabled at deploy time. `true` in staging so
   * the cadence runs immediately after the first deploy; `false` in prod so
   * the first deploy never auto-starts a run before the runbook is reviewed.
   * Flipped to `true` post-launch via `aws events enable-rule` (out of band)
   * or by changing this flag and redeploying.
   */
  readonly etlSchedulesEnabled: boolean;
  /**
   * Fargate CPU units for the ETL task family. Tunable per-step via
   * `Overrides.ContainerOverrides[].Cpu`; this is the base allocation.
   */
  readonly etlTaskCpu: number;
  /** Fargate memory (MiB) for the ETL task family. */
  readonly etlTaskMemoryMiB: number;
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
    appDesiredCount: 1,
    appCpu: 512,
    appMemoryMiB: 1024,
    migrationTaskCpu: 512,
    migrationTaskMemoryMiB: 1024,
    // Staging announces the PROD SP entityID, not its own host (#466). WCM
    // registered a single SP (the prod entityID, tied to the filed cert) and
    // confirmed it covers staging too -- the staging-host entityID is not
    // registered, so announcing it gets "Metadata not found" from the IdP.
    // The ACS below stays the staging host (the IdP allows the staging ACS on
    // that SP), so the response still comes back to staging.
    samlSpEntityId: "https://scholars.weill.cornell.edu/api/auth/saml/metadata",
    samlSpAcsUrl:
      "https://scholars-staging.weill.cornell.edu/api/auth/saml/callback",
    etlSchedulesEnabled: true,
    etlTaskCpu: 1024,
    etlTaskMemoryMiB: 2048,
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
    appDesiredCount: 2,
    appCpu: 1024,
    appMemoryMiB: 2048,
    migrationTaskCpu: 512,
    migrationTaskMemoryMiB: 1024,
    samlSpEntityId: "https://scholars.weill.cornell.edu/api/auth/saml/metadata",
    samlSpAcsUrl: "https://scholars.weill.cornell.edu/api/auth/saml/callback",
    // Prod schedules ship disabled — first run is operator-driven after
    // runbook review, then `aws events enable-rule` flips them on (see
    // PRODUCTION_ADDENDUM § EtlStack).
    etlSchedulesEnabled: false,
    etlTaskCpu: 2048,
    etlTaskMemoryMiB: 4096,
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
