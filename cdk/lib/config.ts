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
   *
   * Doubles as the autoscaling MIN capacity (#596) — the service never
   * scales below this floor, so a single-AZ failure still leaves the
   * prod minimum (2) spread across AZs.
   */
  readonly appDesiredCount: number;
  /**
   * Autoscaling MAX task count for the app service (#596). The ECS service
   * scales between {@link appDesiredCount} (min) and this ceiling on CPU and
   * ALB request-count target-tracking. Sized to absorb a launch / outreach-
   * wave spike on the uncacheable origin paths (`/api/search*`, `/edit*`,
   * `/api/auth/*`) without manual intervention; cacheable traffic is shed by
   * CloudFront + ISR upstream and does not reach a task.
   *
   * These are conservative placeholders pending the #554 load-test numbers
   * (P0, Gate A) — revisit the ceiling and the target thresholds once real
   * RPS / CPU-per-task figures exist. Must be >= {@link appDesiredCount}
   * (asserted at synth time in app-stack.test.ts).
   */
  readonly appMaxCount: number;
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
   * Host pattern of the `app_rw` account the #493 db-bootstrap grants
   * `INSERT ON scholars_audit.manual_edit_audit` to. Read by db-bootstrap.ts as
   * GRANTEE_HOST. Per-env because the app users were provisioned with different
   * host scopes: prod is `'app_rw'@'%'`, staging is `'app_rw'@'10.20.%'` (scoped
   * to the staging VPC CIDR; confirmed 2026-05-30 via SELECT CURRENT_USER() from
   * an in-VPC app_rw connection). A wrong value fails the deploy loud at the
   * GRANT -- MySQL 1410, since the least-privilege sps_bootstrap can't
   * auto-create the missing `@'host'` account -- so it is fail-closed, not
   * silent. NOT derivable from {@link vpcCidr}: prod uses `%` despite its
   * 10.10/16 CIDR.
   */
  readonly appRwGranteeHost: string;
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
  /**
   * Content-Security-Policy rollout mode (#374). Surfaced as the
   * `SECURITY_CSP_MODE` env var on the app task; `lib/security-headers.ts`
   * `resolveCspMode()` reads it. `"report-only"` (the default both envs ship
   * at launch) sends the policy as `Content-Security-Policy-Report-Only`;
   * `"enforce"` flips the same policy value to the enforcing
   * `Content-Security-Policy` header. Per-env so staging can be promoted to
   * `enforce` first — once its post-#636 report feed is confirmed clean under
   * real traffic — before prod, each promotion a one-line edit + `cdk deploy
   * Sps-App-<env>` (CD re-rolls the image only, never the task-def env). The
   * value is the same in both modes, so the flip is reversible by flipping
   * back.
   */
  readonly cspMode: "report-only" | "enforce";

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
   * Whether the EventBridge rule that fires the #393 suppression search-index
   * reconciler (ADR-005 layer 3) is enabled at deploy time. Distinct from
   * {@link etlSchedulesEnabled} on purpose: the reconciler is a CONTINUOUS
   * durability backstop that must run in prod from launch, whereas the
   * nightly / weekly / annual cadences ship disabled in prod behind a one-time
   * runbook gate. Reusing the cadence flag would couple the two — flipping the
   * reconciler on would also auto-start the heavy cadences. `true` in both envs;
   * safe to enable in prod pre-launch because the candidate query returns empty
   * (no suppressions yet) so the run is a no-op.
   */
  readonly reconcileScheduleEnabled: boolean;
  /**
   * Whether the EventBridge rule that fires the #353 durable
   * CloudFront-invalidation reconciler (ADR-005 layer 3, the CDN analogue of the
   * #393 search-index reconciler) is enabled at deploy time. A SEPARATE flag from
   * {@link reconcileScheduleEnabled} on purpose: the two reconcilers cover
   * different durability paths (edge-cache purge vs search-index suppression) and
   * must be independently controllable -- flipping one off must never silence the
   * other. Like its sibling it is a CONTINUOUS durability backstop that must run
   * in prod from launch, unlike the runbook-gated nightly / weekly / annual
   * cadences. `true` in both envs; safe to enable in prod pre-launch because the
   * task is empty-queue-safe: the worker no-ops without touching the DB while
   * SCHOLARS_CLOUDFRONT_DISTRIBUTION_ID is unset (the operator supplies it at
   * enable time), and the `cdn_invalidation` outbox is never written until then.
   */
  readonly cdnReconcileScheduleEnabled: boolean;
  /**
   * Whether the EventBridge rule that fires the daily curated-tables logical
   * backup (`backup:curated`, #1032 — a read-only mysqldump-equivalent of the
   * hand-curated org-unit + methods/tools-overlay tables to the curation backup
   * S3 bucket) is enabled at deploy time. A DEDICATED flag, decoupled from
   * {@link etlSchedulesEnabled} on purpose: the backup cadence must be
   * independently controllable, so flipping the heavy nightly/weekly/annual ETL
   * cadences on or off never touches the backup, and vice versa. `true` in
   * staging so it runs from the first deploy after activation; `false` in prod
   * until the prod curated-tables backup is activated (`cdk deploy Sps-Etl-prod`
   * creates the bucket + grant + env, then flip this flag) — see
   * docs/curation-backup-runbook.md § Prod.
   */
  readonly curationBackupScheduleEnabled: boolean;
  /**
   * The externally-created, TGW-attached VPC that on-prem-reachable ETL tasks
   * run in — specifically the ED LDAP → S3 email-visibility export (#443).
   * Created out-of-band by WCM networking (NOT by our CDK): staging →
   * `scholars-dev`, prod → `scholars-prod`. Its private `app` subnets route
   * 140.251/16 + 157.139/16 + 10/8 to the on-prem Transit Gateway and forward
   * weill.cornell.edu DNS to the on-prem resolvers, so a Fargate task placed
   * there reaches `edprovider.weill.cornell.edu:636` — which the Sps app VPC
   * cannot (it is not TGW-attached). Only the private app subnets are listed
   * (they carry the TGW + NAT routes; the public dmz subnets do not). Imported
   * by attributes (no context lookup) so synth stays deterministic without
   * account creds. Used only when {@link edEmailVisibilityBridgeEnabled} is true.
   */
  readonly edExportVpc: {
    readonly vpcId: string;
    readonly availabilityZones: readonly string[];
    readonly appSubnetIds: readonly string[];
  };
  /**
   * Whether the weekly ED email-visibility bridge is created + scheduled: a
   * two-step Step Functions chain that runs `etl:ed:export-email-visibility`
   * (LDAP→S3) in {@link edExportVpc}, then `etl:ed:import-email-visibility`
   * (S3→RDS) in the Sps VPC — replacing the manual WCM-side export the #443
   * on-prem-routing gap forced. A DEDICATED, creation-gating flag (like
   * {@link curationBackupScheduleEnabled}): `true` in staging (the on-prem TGW
   * path is proven there — verified 2026-06-18 with a real in-VPC LDAPS bind),
   * `false` in prod until scholars-prod is verified end-to-end and the runbook
   * is reviewed. Gating CREATION (not just the rule's Enabled flag) keeps the
   * imported-VPC security group, the state machine, and the ed/* PutObject
   * grant out of prod entirely until the flag flips. See
   * docs/onprem-ed-export-runbook.md.
   */
  readonly edEmailVisibilityBridgeEnabled: boolean;
  /**
   * Whether the regular ETL cadence task family (nightly / weekly / annual +
   * heartbeat) runs in {@link edExportVpc} (scholars-dev / scholars-prod,
   * TGW-attached) instead of the Sps VPC, reaching Aurora / OpenSearch / the
   * internal ALB back in the Sps VPC over an intra-account VPC peering
   * connection. The ETL is two-sided — it reads on-prem LDAP + the 10.46.x
   * source DBs (TGW-only) and writes the Sps-VPC datastores — and the Sps VPC
   * cannot be TGW-attached (10.20/10.10 overlap), so the compute moves and
   * peers back. **OFF in both envs** until that peering + the datastore CIDR
   * ingress ({@link etlPeerCidr}) are in place and the source-reach probe
   * passes from scholars-dev: the placement move regresses the
   * (currently-working) write side if it lands first. Gating it here keeps the
   * scholars-dev cadence SG + the CIDR ingress rules out of the template until
   * an operator flips it. See docs/etl-vpc-migration-handoff.md.
   */
  readonly etlCadenceVpcRelocated: boolean;
  /**
   * CIDR of the TGW-attached ETL VPC ({@link edExportVpc}) that the Sps-side
   * datastores (Aurora 3306, OpenSearch 443, internal ALB 80) admit once
   * {@link etlCadenceVpcRelocated} is true: scholars-dev = `10.46.231.0/24`,
   * scholars-prod = `10.46.230.0/24`. Referenced only when relocated.
   */
  readonly etlPeerCidr: string;
  /**
   * Fargate CPU units for the ETL task family. Tunable per-step via
   * `Overrides.ContainerOverrides[].Cpu`; this is the base allocation.
   */
  readonly etlTaskCpu: number;
  /** Fargate memory (MiB) for the ETL task family. */
  readonly etlTaskMemoryMiB: number;

  // --- AnalyticsStack (the 9th stack) ---

  /**
   * Whether the EventBridge rule that fires the nightly CloudFront-usage
   * rollup Lambda is enabled at deploy time. `true` in BOTH envs: the rollup
   * is idempotent (it delete-then-inserts each dt partition) and cheap (it
   * scans only the WCM-only pre-launch CF log volume), so leaving it on from
   * the first deploy means the durable `daily_usage` history starts
   * accumulating immediately -- and the rollups must survive the raw CF
   * logs' 90-day expiry, so the earlier they start the more history we keep.
   * Distinct from {@link etlSchedulesEnabled} (which ships prod disabled
   * behind a runbook gate) because this rollup reads existing logs only and
   * never starts an ETL run. Flip to `false` to ship the rollup paused
   * without a code change.
   */
  readonly usageRollupScheduleEnabled: boolean;
  /**
   * CloudFront distribution id, referenced by NAME (literal) for the
   * reliability dashboard's CloudFront row -- deliberately NOT via the EdgeStack
   * L2 handle. Importing it would force an Edge redeploy, and EdgeStack is
   * frozen behind the NetScaler/WAF (#502) decision; a redeploy without the live
   * `-c edgeCustomDomain/edgeCertArn/edgeAllowedCidrs` context would strip the
   * prod alias/cert/WAF off the live distribution. The id is stable (the
   * distribution is RETAIN). Switch back to edgeStack.distribution.distributionId
   * once Edge unfreezes if the synth-time handle is preferred.
   */
  readonly cloudFrontDistributionId: string;
  /**
   * CloudFront standard-access-log S3 bucket name (EdgeStack-owned; raw logs at
   * `cf/<env>/`). Referenced by NAME (s3.Bucket.fromBucketName) by AnalyticsStack
   * for the same Edge-decoupling reason as {@link cloudFrontDistributionId}.
   * CFN-generated name, stable (the bucket is RETAIN).
   */
  readonly cloudFrontLogsBucketName: string;
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
    // #626 — bumped from t3.small.search: the burstable t3.small (2 GB, ~1 GB
    // heap) could not complete a full `search:index` bulk rebuild. With the
    // write queue empty it still 429'd every chunk — AWS throttling the
    // credit-exhausted burstable instance, not OpenSearch backpressure. t3.medium
    // (4 GB, ~2 GB heap, more burst credits) gives the rebuild headroom, paired
    // with the paced bulk writer (#627). Still single-node — staging is low-traffic.
    opensearchDataNodeInstanceType: "t3.medium.search",
    awsBackupRetentionDays: 14,
    appDesiredCount: 1,
    // #596 — staging is low-traffic (internal QA + VPN circulation); a small
    // ceiling proves the scaling path works without provisioning prod-sized
    // headroom. Revisit with #554 numbers.
    appMaxCount: 3,
    appCpu: 512,
    appMemoryMiB: 1024,
    migrationTaskCpu: 512,
    migrationTaskMemoryMiB: 1024,
    // Staging's app user is `'app_rw'@'10.20.%'` (VPC-CIDR-scoped), confirmed
    // 2026-05-30 via SELECT CURRENT_USER() from an in-VPC app_rw connection.
    // The bootstrap default of `%` 1410'd here because that account is absent.
    appRwGranteeHost: "10.20.%",
    // Staging announces the PROD SP entityID, not its own host (#466). WCM
    // registered a single SP (the prod entityID, tied to the filed cert) and
    // confirmed it covers staging too -- the staging-host entityID is not
    // registered, so announcing it gets "Metadata not found" from the IdP.
    // The ACS below stays the staging host (the IdP allows the staging ACS on
    // that SP), so the response still comes back to staging.
    samlSpEntityId: "https://scholars.weill.cornell.edu/api/auth/saml/metadata",
    samlSpAcsUrl:
      "https://scholars-staging.weill.cornell.edu/api/auth/saml/callback",
    // #374 — promoted to enforce 2026-06-08. The post-#636 report feed ran
    // clean (its one violation pattern, a SAML-login RSC prefetch, was fixed by
    // prefetch={false} in 7274cec; zero non-probe violations in the trailing
    // 48h; an active Playwright pass over home/search/profile/topic/about found
    // none). Takes effect because the CSP is emitted at runtime from
    // middleware.ts (#780) — next.config headers() baked the mode at build time
    // and could never flip a deployed image. Prod stays report-only until
    // staging soaks clean in enforce.
    cspMode: "enforce",
    etlSchedulesEnabled: true,
    // #393 — continuous reconciler backstop; enabled both envs (see flag JSDoc).
    reconcileScheduleEnabled: true,
    // #353 -- continuous CloudFront-invalidation reconciler backstop; enabled
    // both envs (empty-queue-safe pre-launch). See flag JSDoc.
    cdnReconcileScheduleEnabled: true,
    // #1032 — daily curated-tables logical backup; enabled in staging (the
    // backup is live + verified here). Read-only + tiny, so safe from launch.
    curationBackupScheduleEnabled: true,
    // #443 — staging runs the ED email-visibility bridge in scholars-dev, whose
    // on-prem LDAP reach is proven (2026-06-18: in-VPC LDAPS bind + 2440-unit
    // search). Only the two private `app` subnets (TGW + NAT routes) are listed.
    edExportVpc: {
      vpcId: "vpc-02c4dd698f3e3869c",
      availabilityZones: ["us-east-1a", "us-east-1b"],
      appSubnetIds: ["subnet-08cab06d3084fba41", "subnet-07ffed73356c01f6c"],
    },
    edEmailVisibilityBridgeEnabled: true,
    // ETL cadence VPC relocation (docs/etl-vpc-migration-handoff.md) — OFF
    // until the scholars-dev ↔ Sps-Network-staging peering + the datastore CIDR
    // ingress exist and the source-reach probe passes from scholars-dev. Flip
    // to true only after peering is up, or the cadence loses DB/index reach.
    etlCadenceVpcRelocated: false,
    etlPeerCidr: "10.46.231.0/24",
    // #485 — search:index OOM-killed at 2048 MiB building the full corpus
    // (178k+ pubs). 8 GB + the NODE_OPTIONS heap cap (EtlStack) clears it;
    // 2 vCPU also speeds the build, easing throttle pressure on the node.
    etlTaskCpu: 2048,
    etlTaskMemoryMiB: 8192,
    // The 9th stack -- idempotent + cheap, so on from launch (see flag JSDoc).
    usageRollupScheduleEnabled: true,
    // Live EdgeStack-owned resources, referenced by name to decouple the
    // dashboard + analytics deploys from the frozen Edge stack (see JSDoc).
    cloudFrontDistributionId: "E17NRWINXLP3B3",
    cloudFrontLogsBucketName: "sps-edge-staging-logsbucket9c4d8843-kyqasc6ziviz",
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
    // #596 — 3x the 2-task floor gives room to absorb a Wave-4 (WCM-wide,
    // #506 Gate D5) spike on the uncacheable origin paths before the ALB
    // queue saturates. Conservative placeholder; the true ceiling is a
    // function of the #554 RPS / CPU-per-task numbers (P0, Gate A).
    appMaxCount: 6,
    appCpu: 1024,
    appMemoryMiB: 2048,
    migrationTaskCpu: 512,
    migrationTaskMemoryMiB: 1024,
    // Prod's app user is `'app_rw'@'%'` (the bootstrap GRANT + verify both
    // passed on prod, which proves `'app_rw'@'%'` exists). Unchanged behavior.
    appRwGranteeHost: "%",
    samlSpEntityId: "https://scholars.weill.cornell.edu/api/auth/saml/metadata",
    samlSpAcsUrl: "https://scholars.weill.cornell.edu/api/auth/saml/callback",
    // #374 — promoted to enforce 2026-06-08, after staging ran enforce cleanly
    // (browser pass: zero blocked resources) and prod ran report-only via the
    // same middleware/policy. Takes effect because the CSP is emitted at runtime
    // from middleware.ts (prod now on the 4b6ec0e image); prod's task def
    // previously carried no SECURITY_CSP_MODE, so this cdk deploy adds it as
    // enforce. The policy value is identical to report-only, so revert =
    // flip back + cdk deploy.
    cspMode: "enforce",
    // Prod schedules ship disabled — first run is operator-driven after
    // runbook review, then `aws events enable-rule` flips them on (see
    // PRODUCTION_ADDENDUM § EtlStack).
    etlSchedulesEnabled: false,
    // #393 — the reconciler backstop runs in prod from launch (empty-queue-safe
    // pre-launch), unlike the runbook-gated cadences above. See flag JSDoc.
    reconcileScheduleEnabled: true,
    // #353 -- the CloudFront-invalidation reconciler backstop runs in prod from
    // launch too (empty-queue-safe; no-ops until SCHOLARS_CLOUDFRONT_DISTRIBUTION_ID
    // is set). See flag JSDoc.
    cdnReconcileScheduleEnabled: true,
    // #1032 — curated-tables backup NOT YET ACTIVATED on prod. Ships disabled:
    // the prod bucket/grant/env don't exist until `cdk deploy Sps-Etl-prod`, so
    // the rule would target a task def without CURATION_BACKUP_BUCKET. Activate
    // prod (deploy + first verify run) then flip this to true. See
    // docs/curation-backup-runbook.md § Prod.
    curationBackupScheduleEnabled: false,
    // #443 — prod's on-prem-reachable VPC is scholars-prod. Wired but NOT yet
    // activated: edEmailVisibilityBridgeEnabled stays false until the
    // scholars-prod path is verified end-to-end (the same in-VPC bind probe as
    // staging) and the runbook is reviewed; flipping it then creates the bridge.
    edExportVpc: {
      vpcId: "vpc-0b8006fee120df6bc",
      availabilityZones: ["us-east-1a", "us-east-1b"],
      appSubnetIds: ["subnet-069dc77801ee2d8f3", "subnet-0ceec7bb2f059e162"],
    },
    edEmailVisibilityBridgeEnabled: false,
    // ETL cadence VPC relocation — OFF; replicate the staging peer-and-move on
    // scholars-prod ↔ Sps-Network-prod and verify before flipping (prod ETL
    // schedules are off anyway). See docs/etl-vpc-migration-handoff.md.
    etlCadenceVpcRelocated: false,
    etlPeerCidr: "10.46.230.0/24",
    // #485 — match staging's 8 GB headroom for the search:index corpus build
    // (paired with the NODE_OPTIONS heap cap in EtlStack). Prod's 2-node
    // m6g.large.search domain already handles the bulk write rate.
    etlTaskCpu: 2048,
    etlTaskMemoryMiB: 8192,
    // The 9th stack -- idempotent + cheap, so on from launch (see flag JSDoc).
    usageRollupScheduleEnabled: true,
    // Live EdgeStack-owned resources, referenced by name to decouple the
    // dashboard + analytics deploys from the frozen Edge stack (see JSDoc).
    cloudFrontDistributionId: "E28NKDFXC7K2ZL",
    cloudFrontLogsBucketName: "sps-edge-prod-logsbucket9c4d8843-8swcfno13icn",
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
