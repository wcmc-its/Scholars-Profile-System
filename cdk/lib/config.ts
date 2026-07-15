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
  /**
   * Number of dedicated OpenSearch master nodes; 0 = none (#1509). Prod runs 3
   * so cluster coordination moves off the data path and survives losing one
   * data node/AZ (quorum 2-of-3) instead of the current 2-data-node domain's
   * 2-of-2 vote, where either node's loss takes search fully down. Other envs
   * run 0 — a single/low-traffic domain gains nothing from dedicated masters.
   * NB: the VPC has two AZs, so three masters distribute 2+1 across those two
   * AZs; full 3-AZ master placement would need NetworkStack at three AZs (same
   * out-of-scope caveat as the data-node count above).
   */
  readonly opensearchMasterNodes: number;
  /** Dedicated master instance type; ignored when opensearchMasterNodes is 0. */
  readonly opensearchMasterNodeInstanceType: string;

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
   *
   * Cutover (docs/sps-vpc-consolidation-plan.md §6.2): once compute moves to the
   * shared its-reciter app2 tier, the source IP changes to `10.46.160.x`, so
   * staging must re-scope from `10.20.%` to `10.46.160.%` (the two app2 /25s =
   * `10.46.160.0/24`) — or `%` — together with the live in-DB regrant, else
   * app_rw auth fails closed (MySQL 1410). One of the prerequisites
   * {@link assertCutoverGate} lists before {@link useSharedVpc} may be flipped.
   * Prod stays `%`, unaffected by the source move.
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
   *
   * To turn prod schedules on: flip THIS flag to `true` and
   * `cdk deploy Sps-Etl-prod`. Do NOT enable the rules out of band with
   * `aws events enable-rule` — the rules synthesize `enabled:
   * envConfig.etlSchedulesEnabled` (etl-stack.ts), so an out-of-band enable
   * drifts from the template and the next Sps-Etl-prod deploy that touches a
   * rule silently reverts it to DISABLED. The config flag is the single source
   * of truth (#1512).
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
   * Whether the standalone daily DynamoDB→MySQL projection (`etl:dynamodb`, the
   * step that mirrors ReciterAI's `reciterai` table into the `opportunity` +
   * scholar tables) runs on its OWN schedule, separate from the nightly cadence.
   *
   * `etl:dynamodb` is already a nightly step, but it sits AFTER `etl:ed`, which
   * is blocked by the on-prem-routing gap (#443) — so the nightly aborts before
   * reaching it and freshly-published opportunities 404 until someone re-projects
   * by hand. This standalone schedule keeps the funding-matcher corpus fresh
   * independent of the blocked nightly (#1218). A DEDICATED, creation-gating flag
   * (like {@link curationBackupScheduleEnabled}): `true` in staging (the matcher
   * is live there); `false` in prod until the prod corpus is published and the
   * #443 fix lands — at which point the nightly reaches `etl:dynamodb` again and
   * this stopgap can be retired. Gating CREATION (not just the rule's Enabled
   * flag) keeps the extra state machine + rule + alarm out of prod entirely.
   */
  readonly opportunityProjectionScheduleEnabled: boolean;
  /**
   * Whether the reverse grant→researcher matcher runs the subtopic-grain path
   * (require/penalize DSL + BM25 boost) instead of the proven topic-vector path.
   * Surfaced to the app container as `GRANT_MATCHER_SUBTOPIC_GRAIN` ("on"/"off").
   * The path ALSO self-gates on the opportunity carrying a compiled `match_dsl`,
   * so with the flag on it still no-ops (→ topic-vector) on opportunities not yet
   * reprojected. `true` in staging (corpus backfilled + reprojected); `false` in
   * prod until the prod corpus carries match_dsl/match_query and staging soaks.
   * See docs/grant-matching-productionization-handoff.md.
   */
  readonly grantMatcherSubtopicGrain: boolean;
  /**
   * Absolute-fit abstention floor for the reverse matcher, surfaced as
   * `GRANT_MATCHER_ABSTAIN_FLOOR`. When a grant's top-8 mean pool-normalized
   * relevance (`meanTopRel` ∈ [0,1]) falls below this, the result is flagged
   * `abstain` ("no strong WCM match") instead of returning a tangential top-8.
   * Only meaningful with subtopic-grain on (the topic-vector path has no
   * per-pub relevance → meanTopRel 0 → everything abstains): keep this 0 wherever
   * grantMatcherSubtopicGrain is false. `0` disables. Offline prior 0.10
   * (match_v9b); staging-first so the floor can be re-validated before prod.
   * See ReciterAI #287, docs/grant-eval-harness-handoff.md §5.1.
   */
  readonly grantMatcherAbstainFloor: number;
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
   * Whether this environment's stacks place their resources in the shared,
   * TGW-attached its-reciter-vpc01 ({@link sharedVpc}, imported by id) instead
   * of creating their own Sps VPC. **Default `false` in both envs** — the
   * estate-consolidation cutover (docs/sps-vpc-consolidation-plan.md) flips it
   * per-env, staging first, and only after the data tier has been migrated by
   * dump/restore + reindex (an operational step, NOT a flag flip). Governs CDK
   * topology only: NetworkStack create→import plus every downstream subnet/SG
   * selection. OFF means the stacks synthesize exactly as before this PR, so a
   * dormant `false` is a no-op against the live envs. Supersedes the deleted
   * #1310 peering flags (`etlVpcPeeringEnabled` / `etlCadenceVpcRelocated`):
   * a single shared VPC has no peer, so the whole peering field-set collapses
   * into this one topology switch + {@link sharedVpc} (plan §8.8).
   */
  readonly useSharedVpc: boolean;
  /**
   * The shared its-reciter-vpc01 (`vpc-08a1873fc8eebae28`, acct 665083158573,
   * us-east-1), imported by attributes — no `fromLookup`, so synth stays
   * deterministic without account creds. Subnet ids were discovered 2026-06-30
   * by read-only AWS describe (plan §4.4): compute (app service + internal ALB +
   * every ETL task) lands in the **app2** /25 tier; Aurora + OpenSearch in the
   * **db** /27 tier; an optional public ALB in the **dmz** tier (unused under
   * the NetScaler front, §7). Both envs share ONE descriptor by design — env
   * isolation is by per-env security group, never by network (plan §4.5). Read
   * only when {@link useSharedVpc} is true.
   */
  readonly sharedVpc: {
    readonly vpcId: string;
    readonly availabilityZones: readonly string[];
    /** app2 /25 — app service + internal ALB + ETL task ENIs. */
    readonly appSubnetIds: readonly string[];
    /** db /27 — Aurora + OpenSearch ENIs (prod needs ≥2 AZs). */
    readonly dataSubnetIds: readonly string[];
    /** dmz — optional public ALB only; unused under the NetScaler front (§7). */
    readonly albSubnetIds: readonly string[];
    /**
     * Out-of-band pre-provisioned security-group ids in the shared VPC (option 2,
     * item-3 pass 1; docs/cutover-item3-implementation-map-2026-06-30.md). The
     * shared-VPC team (its-reciter-vpc01 owners) creates the app/etl/alb SGs —
     * **with default allow-all egress** — and owns their base ingress; NetworkStack
     * echoes the flag-appropriate id to SSM and every consumer imports by id
     * (`fromSecurityGroupId`), so no SG replaces at the `useSharedVpc` flip. Empty
     * in the shipped config (flag-off) — {@link assertSharedVpcConfig} fails closed
     * if `useSharedVpc` is flipped before these are filled.
     */
    readonly appSgId: string;
    readonly etlSgId: string;
    readonly albSgId: string;
  };
  /**
   * Cutover de-coupling flag (docs/sps-vpc-consolidation-plan.md §8.4; review
   * w26gz881i). When `false` (shipped default both envs) the app + ETL tasks read
   * `OPENSEARCH_NODE` as a plaintext env baked from
   * `Fn.importValue("Sps-Data-<env>-OpenSearchDomainEndpoint")` — the current
   * behavior, byte-identical. When `true`, that named CFN export is no longer
   * imported; instead `OPENSEARCH_NODE` is injected from the `node` key of the
   * `scholars/<env>/opensearch/{app,etl}` secret. This removes the Data→App/Etl
   * export so the consolidation cutover (immutable-subnet-group replace of the
   * OpenSearch domain) is not blocked by CFN's "cannot update an export in use".
   *
   * **Fail-closed ordering:** flip to `true` (and `cdk deploy Sps-App/Etl-<env>`)
   * ONLY after backfilling the `node` key (holding the current `https://<endpoint>`)
   * into BOTH `opensearch/app` and `opensearch/etl` in that env — an absent key
   * fails ECS task-start (search 500s).
   */
  readonly openSearchNodeFromSecret: boolean;
  /**
   * Aurora cluster/instance SNAPSHOT identifier to restore the data tier FROM
   * during the estate-consolidation cutover (plan §8.5/§8.6). When set, DataStack
   * builds `rds.DatabaseClusterFromSnapshot` (data-bearing, restored ALONGSIDE the
   * live cluster — reversible "abandon new, keep old") instead of a fresh, empty
   * `rds.DatabaseCluster`. Required by {@link assertCutoverGate} once
   * {@link useSharedVpc} is on — flipping the VPC topology without it would
   * CFN-replace the live cluster into an empty datastore (§8.6 forbids this).
   * Undefined in the shipped config → the standalone `DatabaseCluster` path,
   * byte-identical to today.
   */
  readonly auroraSnapshotIdentifier?: string;
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
   * CloudFront custom domain (alias) attached to the EdgeStack distribution.
   * Committed here (non-secret -- it is the public URL) so a bare
   * `cdk deploy Sps-Edge-<env>` no longer strips the alias off the live
   * distribution (#1506). A `-c edgeCustomDomain=...` context flag still wins
   * when supplied. Paired with {@link edgeCertArn}; both must be present for the
   * alias to attach.
   */
  readonly edgeCustomDomain: string;
  /**
   * ACM certificate ARN for {@link edgeCustomDomain}. MUST be in us-east-1
   * (CloudFront viewer-cert requirement). Committed for the same
   * bare-deploy-no-strip reason as {@link edgeCustomDomain} (#1506); the ARN
   * carries only the already-committed account id, no secret. `-c edgeCertArn=...`
   * still overrides.
   */
  readonly edgeCertArn: string;
  /**
   * CloudFront standard-access-log S3 bucket name (EdgeStack-owned; raw logs at
   * `cf/<env>/`). Referenced by NAME (s3.Bucket.fromBucketName) by AnalyticsStack
   * for the same Edge-decoupling reason as {@link cloudFrontDistributionId}.
   * CFN-generated name, stable (the bucket is RETAIN).
   */
  readonly cloudFrontLogsBucketName: string;

  // --- Edge -> ALB origin TLS (#1507) ---

  /**
   * Custom origin hostname CloudFront uses when the origin leg runs over HTTPS
   * (#1507). The public ALB's AWS-assigned `*.elb.amazonaws.com` DNS name cannot
   * carry a public ACM cert, so an HTTPS origin needs a hostname we control that
   * DNS-resolves to the ALB and whose cert the ALB's :443 listener presents.
   *
   * Empty = the operator has NOT cut the DNS record yet, so CloudFront keeps its
   * HTTP_ONLY origin on the ALB DNS name even if {@link edgeOriginCertArn} is set.
   * Synth cannot see DNS, so a non-empty value here IS the operator's assertion
   * that the record resolves to the ALB. Set it only once that is true.
   */
  readonly edgeOriginHostname: string;
  /**
   * ACM certificate ARN (ALB region, us-east-1) presented by the public ALB's
   * :443 listener (#1507). The *regional* ALB cert -- distinct from the us-east-1
   * CloudFront *viewer* cert. A wildcard (`*.weill.cornell.edu`) covers every env
   * and every origin hostname, so both envs may share one ARN.
   *
   * Empty = the ALB stays HTTP-:80-only. Set it to add the :443 listener, its
   * X-Origin-Verify forward rule, and the :443 SG ingress -- which is all a
   * NetScaler front needs, since it dials the ALB directly.
   *
   * This ARN alone does NOT move CloudFront: the origin leg flips to HTTPS_ONLY
   * only when {@link edgeOriginHostname} is ALSO set (see edge-stack.ts). The two
   * gates are separate because the ALB listener needs a cert while CloudFront
   * needs a cert *and* a resolvable hostname.
   *
   * Ships dark. Deploy Sps-App-<env> (adds :443) and verify :443 serves BEFORE
   * seeding the hostname + deploying Sps-Edge-<env> (flips the origin).
   */
  readonly edgeOriginCertArn: string;

  // --- Observability metric-by-name decouple (cutover) ---

  /**
   * Whether ObservabilityStack reads its Aurora + OpenSearch metrics by literal
   * NAME (config) instead of via the DataStack `auroraCluster` / `opensearchDomain`
   * L2 handles. OFF (shipped) keeps the handle path — byte-identical, and the two
   * cross-stack `Ref` exports DataStack publishes for Observability stay intact.
   * ON severs those two Data→Observability export edges so the estate-consolidation
   * `useSharedVpc` flip can replace the cluster/domain without CloudFormation's
   * "cannot update an export in use" (the decouple campaign,
   * docs/cutover-decouple-increments-2026-06-30.md). A DEDICATED flag, NOT tied to
   * {@link useSharedVpc}: {@link assertCutoverGate} hard-throws while useSharedVpc
   * is on without the data path, so a useSharedVpc-gated branch could not be
   * synthesized or snapshot-tested — this flag lets the edge-severance ship and
   * deploy (Observability-stack-only, BEFORE the Data deploy) on its own.
   *
   * MUST flip only once {@link auroraClusterIdentifier} / {@link opensearchDomainName}
   * point at live resources (the snapshot-restored cluster/domain assigned explicit
   * identifiers at cutover) — else the by-name metrics resolve to empty AWS/RDS +
   * AWS/ES dimensions and the alarms silently never fire (NOT_BREACHING).
   */
  readonly observabilityMetricsByName: boolean;
  /**
   * Aurora cluster identifier (`DBClusterIdentifier`) the by-name Observability
   * metrics key on when {@link observabilityMetricsByName} is true. Empty in the
   * shipped config (unused while the flag is off); assigned the snapshot-restored
   * cluster's explicit identifier at cutover. Referenced by NAME for the same
   * Data/Edge-decoupling reason as {@link cloudFrontDistributionId}.
   */
  readonly auroraClusterIdentifier: string;
  /**
   * OpenSearch domain name (`DomainName`) the by-name Observability metrics key on
   * when {@link observabilityMetricsByName} is true. Empty in the shipped config
   * (unused while the flag is off); assigned the fresh domain's explicit name at
   * cutover.
   */
  readonly opensearchDomainName: string;
  /**
   * Public ALB "full name" (the `LoadBalancer` CloudWatch dimension value,
   * `app/<name>/<id>`) the by-name Observability ALB metrics key on when
   * {@link observabilityMetricsByName} is true. Empty in the shipped config
   * (unused while the flag is off); assigned the replaced ALB's full name at
   * cutover. Severs the App->Observability ALB `LoadBalancerFullName` export.
   */
  readonly publicAlbFullName: string;
  /**
   * Public target-group "full name" (`targetgroup/<name>/<id>`, the `TargetGroup`
   * CloudWatch dimension) the by-name unhealthy-hosts metric keys on when
   * {@link observabilityMetricsByName} is true. Empty in the shipped config;
   * assigned at cutover. Severs the App->Observability `TargetGroupFullName` export.
   */
  readonly publicTargetGroupFullName: string;
}

/**
 * its-reciter-vpc01 — the single shared, TGW-attached VPC both envs consolidate
 * into (acct 665083158573, us-east-1). Imported by attributes (no context
 * lookup → deterministic synth). Ids discovered 2026-06-30 by read-only AWS
 * describe (plan §4.4). SHARED across envs on purpose — isolation is by per-env
 * security group, never by network (plan §4.5). Consumed only when an env's
 * {@link SpsEnvConfig.useSharedVpc} is true. Each per-tier id array is
 * AZ-ordered: index i pairs with `availabilityZones[i]` (1a, then 1b), which
 * resolveTierSubnets relies on for AZ-correct Aurora/OpenSearch placement.
 */
const SHARED_VPC = {
  vpcId: "vpc-08a1873fc8eebae28",
  availabilityZones: ["us-east-1a", "us-east-1b"],
  // app2 /25 (162 free) — app service + internal ALB + ETL task ENIs.
  appSubnetIds: ["subnet-0c6593fb9c9a165c3", "subnet-070cbc242efbddc3c"],
  // db /27 (40 free across 2 AZ) — Aurora + OpenSearch ENIs.
  dataSubnetIds: ["subnet-0d35923e345653d0d", "subnet-099a9ebefc36ee888"],
  // dmz (public, IGW) — optional public ALB only; unused under NetScaler (§7).
  albSubnetIds: ["subnet-09a6fab648280ca19", "subnet-0485fefe267b06736"],
  // Out-of-band pre-provisioned SGs (item-3 pass 1). Left empty here = the
  // per-env default; each env overrides with its OWN SGs via a spread (staging
  // done, prod TODO at its cutover) because isolation is by per-env SG (plan
  // §4.5). Empty is safe while useSharedVpc is off (assertSharedVpcConfig gates
  // the flip on these being non-empty).
  appSgId: "",
  etlSgId: "",
  albSgId: "",
} as const;

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
    // #626 bumped t3.small → t3.medium (the burstable t3.small's ~1 GB heap
    // could not finish a `search:index` bulk rebuild). t3.medium's ~2 GB heap
    // then proved too small in turn: JVM pressure idled at ~50% and spiked to
    // 91–97%, tripping the parent circuit breaker (95%, real-memory) on bursty
    // query workloads — the sponsor-match fan-out is ~40–60 sequential
    // searchPeople calls per request and 502'd on `circuit_breaking_exception`
    // while refusing a 2 KB request. m6g.large (8 GB, ~4 GB heap) is also
    // *prod's* node type, so a staging result now means something. +$40/mo.
    opensearchDataNodeInstanceType: "m6g.large.search",
    // Single-node staging domain — no dedicated masters (#1509 is a prod HA fix).
    opensearchMasterNodes: 0,
    opensearchMasterNodeInstanceType: "m6g.large.search",
    awsBackupRetentionDays: 14,
    appDesiredCount: 1,
    // #596 — staging is low-traffic (internal QA + VPN circulation); a small
    // ceiling proves the scaling path works without provisioning prod-sized
    // headroom. Revisit with #554 numbers.
    appMaxCount: 3,
    // 2026-06-26 — bumped 512→1024 (0.5→1 vCPU; memory follows to the Fargate
    // minimum for 1024 CPU). A §6 concurrency load-test showed the app-tier CPU
    // saturating on the per-request taxonomy resolve (matchQueryToTaxonomy,
    // request-scoped-cache-only) well before OpenSearch — the 0.5 vCPU task was
    // the binding constraint under ~3-5 concurrent searches.
    appCpu: 1024,
    appMemoryMiB: 2048,
    migrationTaskCpu: 512,
    migrationTaskMemoryMiB: 1024,
    // Item-3 cutover (2026-07-02): the app now connects from the shared VPC's
    // app2 tier (10.46.160.0/24), so app_rw/app_ro/etl were re-granted to
    // `@'10.46.160.%'` on the restored cluster (the old `@'10.20.%'` grants remain,
    // harmless). The seeder's app_rw tighten + db-bootstrap's audit grant target
    // this host. Pre-cutover this was `'10.20.%'` (standalone-VPC CIDR).
    appRwGranteeHost: "10.46.160.%",
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
    // #1218 — daily standalone DynamoDB projection so the funding-matcher corpus
    // stays fresh while the nightly is blocked at etl:ed (#443). On in staging
    // (matcher is live here); idempotent upsert, so safe from launch.
    opportunityProjectionScheduleEnabled: true,
    // grant→researcher matcher: subtopic-grain path ON in staging (corpus
    // backfilled + reprojected). Self-gates on per-opportunity match_dsl.
    grantMatcherSubtopicGrain: true,
    // abstention floor ON in staging (0.10, match_v9b offline prior). Safe only
    // because subtopic-grain is on here; re-validate on the broken-tail grants
    // (angelman/progeria/msts) before promoting to prod.
    grantMatcherAbstainFloor: 0.1,
    // #443 — staging runs the ED email-visibility bridge in scholars-dev, whose
    // on-prem LDAP reach is proven (2026-06-18: in-VPC LDAPS bind + 2440-unit
    // search). Only the two private `app` subnets (TGW + NAT routes) are listed.
    edExportVpc: {
      vpcId: "vpc-02c4dd698f3e3869c",
      availabilityZones: ["us-east-1a", "us-east-1b"],
      appSubnetIds: ["subnet-08cab06d3084fba41", "subnet-07ffed73356c01f6c"],
    },
    edEmailVisibilityBridgeEnabled: true,
    // Estate consolidation (docs/sps-vpc-consolidation-plan.md): ON — item-3
    // staging cutover 2026-07-02. Every stack now imports the shared its-reciter-
    // vpc01 substrate; DataStack restores the FINAL freeze-time snapshot into a
    // NEW DatabaseClusterFromSnapshot + fresh OS domain alongside the RETAIN'd old
    // ones. assertCutoverGate requires auroraSnapshotIdentifier below.
    useSharedVpc: true,
    // Final freeze-time staging snapshot (taken after ETL quiesce + write-freeze,
    // 2026-07-02). Selects the DatabaseClusterFromSnapshot data-bearing path.
    auroraSnapshotIdentifier: "sps-data-staging-cutover-final-20260702",
    // Staging's own pre-provisioned SGs in the shared VPC (item-3 G8, created
    // out-of-band 2026-07-02, allow-all egress / no ingress). Per-env override
    // of SHARED_VPC's empty SG fields — isolation is by per-env SG (plan §4.5),
    // so staging and prod cannot share SG ids even though they share the VPC +
    // subnets. Inert while useSharedVpc is off (resolveSharedSg only reads these
    // at flag-on); assertSharedVpcConfig gates the flip on them being non-empty.
    sharedVpc: {
      ...SHARED_VPC,
      appSgId: "sg-010c270a395b4854b",
      etlSgId: "sg-016b62e11314e7050",
      albSgId: "sg-0ab492e161a9e9976",
    },
    // Cutover de-coupling (increment-1): ON — the opensearch/{app,etl} `node`
    // key was backfilled 2026-07-02 with the CURRENT staging endpoint, so App/Etl
    // read OPENSEARCH_NODE from the secret (same endpoint) instead of the Data
    // cross-stack export. Byte-identical in effect; severs the App/Etl→Data
    // OpenSearchDomainEndpoint export ahead of the useSharedVpc cutover. See flag JSDoc.
    openSearchNodeFromSecret: true,
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
    // Committed edge alias + us-east-1 viewer cert so a bare Edge deploy stops
    // stripping them (#1506). Live values read from the distribution config.
    edgeCustomDomain: "scholars-staging.weill.cornell.edu",
    edgeCertArn:
      "arn:aws:acm:us-east-1:665083158573:certificate/f50f0b04-dc62-4d8e-97b8-2761d1efdd0f",
    cloudFrontLogsBucketName: "sps-edge-staging-logsbucket9c4d8843-kyqasc6ziviz",
    // #1507 -- HTTPS origin leg, two gates.
    // edgeOriginCertArn: seed with the wildcard ARN to add the ALB :443 listener
    //   (+ X-Origin-Verify rule, + :443 SG ingress). That alone serves NetScaler.
    // edgeOriginHostname: seed ONLY once the record resolves to the public ALB --
    //   it is what flips CloudFront's origin to HTTPS_ONLY against that name.
    //   Intended value: "scholars-staging-origin.weill.cornell.edu".
    edgeOriginHostname: "",
    edgeOriginCertArn: "",
    // Observability metric-by-name decouple (cutover, item-3 Phase B2): ON.
    // Severs the Data->Observability (Aurora/OS) + App->Observability (ALB) cross-
    // stack Ref exports so the useSharedVpc flip can replace those resources without
    // "cannot update an export in use". Seeded with the CURRENT LIVE names so alarms
    // stay functional through the freeze (the flag can't synth with empty ids —
    // observability-stack.ts throws). Swapped to the new snapshot-restored cluster/
    // fresh-domain/auto-named-ALB names once they exist (Phase C Observability redeploy).
    observabilityMetricsByName: true,
    // Post-cutover (Phase C): swapped from the transitional CURRENT-live names to
    // the NEW snapshot-restored cluster / fresh domain / auto-named replaced ALB+TG.
    auroraClusterIdentifier: "sps-data-staging-auroraclusterfromsnapshot7b6a45d8-8kp4eh79cfrn",
    opensearchDomainName: "opensearchshare-mhshucea3jvk",
    publicAlbFullName: "app/Sps-Ap-Publi-28Px8J5FO9hH/54dece3b8bad13da",
    publicTargetGroupFullName: "targetgroup/Sps-Ap-Publi-VGHKKQ7XZH2E/7db931046bbc72ff",
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
    // #1509 — 3 dedicated masters so a single data-node/AZ loss degrades search
    // to yellow (quorum holds) instead of red. Blocks the #731 RI purchase until
    // the topology settles. Stateful blue/green: deploy in a low-traffic window,
    // and verify every index has number_of_replicas >= 1 FIRST (else a data-node
    // loss goes red anyway).
    opensearchMasterNodes: 3,
    opensearchMasterNodeInstanceType: "m6g.large.search",
    awsBackupRetentionDays: 35,
    appDesiredCount: 2,
    // #596 — 3x the 2-task floor gives room to absorb a Wave-4 (WCM-wide,
    // #506 Gate D5) spike on the uncacheable origin paths before the ALB
    // queue saturates. Conservative placeholder; the true ceiling is a
    // function of the #554 RPS / CPU-per-task numbers (P0, Gate A).
    appMaxCount: 6,
    // 2026-06-26 — bumped 1024→2048 (1→2 vCPU; memory follows to the Fargate
    // minimum for 2048 CPU). Same per-request taxonomy-resolve CPU cost as
    // staging (matchQueryToTaxonomy is request-scoped-cache-only); prod's higher
    // go-live concurrency makes the app-tier CPU the likely binding constraint,
    // so add headroom ahead of launch (mirrors the staging bump).
    appCpu: 2048,
    appMemoryMiB: 4096,
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
    // runbook review. To turn them on, flip this flag to true and
    // `cdk deploy Sps-Etl-prod` (NOT `aws events enable-rule` — see the flag
    // JSDoc: out-of-band enable drifts and gets reverted by the next deploy).
    // Verified DISABLED in AWS 2026-07-07, so config == live state (no drift).
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
    // #1218 — standalone DynamoDB projection ships disabled on prod: the prod
    // opportunity corpus isn't published yet and the matcher is dark there. Flip
    // when the prod corpus lands (or leave off once #443 unblocks the nightly).
    opportunityProjectionScheduleEnabled: false,
    // grant→researcher matcher: subtopic-grain path OFF in prod until the prod
    // corpus carries match_dsl/match_query and staging soaks clean.
    grantMatcherSubtopicGrain: false,
    // abstention floor OFF in prod (must stay 0 while subtopic-grain is off, or
    // meanTopRel=0 would abstain every grant). Enable with grantMatcherSubtopicGrain.
    grantMatcherAbstainFloor: 0,
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
    // Estate consolidation (docs/sps-vpc-consolidation-plan.md): ON — item-3 prod
    // cutover 2026-07-05 (staging soaked clean 07-04/07-05). Every stack imports
    // the shared its-reciter-vpc01 substrate; DataStack restores the FINAL
    // freeze-time snapshot into a NEW DatabaseClusterFromSnapshot + fresh OS domain
    // alongside the RETAIN'd old ones. assertCutoverGate requires the snapshot id.
    useSharedVpc: true,
    // Final freeze-time prod snapshot (taken after ETL quiesce + write-freeze,
    // 2026-07-06 UTC). Selects the DatabaseClusterFromSnapshot data-bearing path.
    auroraSnapshotIdentifier: "sps-data-prod-cutover-final-20260706t024926z",
    // Prod's own pre-provisioned SGs in the shared VPC (item-3 prod cutover,
    // created out-of-band 2026-07-05, allow-all egress / no ingress). Per-env
    // override of SHARED_VPC's empty SG fields — isolation is by per-env SG (plan
    // §4.5), so prod and staging cannot share SG ids even though they share the
    // VPC + subnets. Inert while useSharedVpc is off (resolveSharedSg only reads
    // these at flag-on); assertSharedVpcConfig gates the flip on them being non-empty.
    sharedVpc: {
      ...SHARED_VPC,
      appSgId: "sg-098a71afdd462d988",
      etlSgId: "sg-03babbb300ddb3b95",
      albSgId: "sg-06422c1b27dc4e17d",
    },
    // Cutover de-coupling: ON — prod `opensearch/{app,etl}` `node` seeded
    // 2026-07-05 with the current prod endpoint, so App/Etl read OPENSEARCH_NODE
    // from the secret (same endpoint → byte-identical) ahead of the topology flip.
    openSearchNodeFromSecret: true,
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
    // Committed edge alias + us-east-1 viewer cert so a bare Edge deploy stops
    // stripping them (#1506). Live values read from the distribution config.
    edgeCustomDomain: "scholars.weill.cornell.edu",
    edgeCertArn:
      "arn:aws:acm:us-east-1:665083158573:certificate/95f77e69-4abc-4d2c-b081-b8b5b8572fd6",
    cloudFrontLogsBucketName: "sps-edge-prod-logsbucket9c4d8843-8swcfno13icn",
    // #1507 -- HTTPS origin leg, two gates.
    // edgeOriginCertArn: seed with the wildcard ARN to add the ALB :443 listener
    //   (+ X-Origin-Verify rule, + :443 SG ingress). That alone serves NetScaler.
    // edgeOriginHostname: seed ONLY once the record resolves to the public ALB --
    //   it is what flips CloudFront's origin to HTTPS_ONLY against that name.
    //   Intended value: "scholars-origin.weill.cornell.edu".
    edgeOriginHostname: "",
    edgeOriginCertArn: "",
    // Observability metric-by-name decouple (cutover, item-3 prod window): ON.
    // Severs the Data->Observability (Aurora/OS) + App->Observability (ALB) cross-
    // stack Ref exports so the useSharedVpc flip can replace those resources without
    // "cannot update an export in use". Swapped from the old transitional names to
    // the new snapshot-restored cluster / fresh domain / auto-named ALB+TG after the
    // 2026-07-06 prod cutover (App-cut + edge repoint complete; old tier retained).
    observabilityMetricsByName: true,
    auroraClusterIdentifier: "sps-data-prod-auroraclusterfromsnapshot7b6a45d8-ylbuldcja7bm",
    opensearchDomainName: "opensearchshare-hr8gdfznbeww",
    publicAlbFullName: "app/Sps-Ap-Publi-dZ0soKIosV6j/a43ae4ad91d52643",
    publicTargetGroupFullName: "targetgroup/Sps-Ap-Publi-TL07SCGAWNJM/4cc4b1d7b17c0f8c",
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
  const cfg = ENV_CONFIG[name];
  assertSharedVpcConfig(cfg);
  return cfg;
}

/**
 * Footgun guard for the estate consolidation (docs/sps-vpc-consolidation-plan.md).
 * When {@link SpsEnvConfig.useSharedVpc} is on, every stack imports
 * its-reciter-vpc01 by id and places resources into explicit subnet ids — an
 * empty vpcId yields an import with an empty id, and a missing subnet tier
 * yields an empty subnet selection, both of which only fail at CloudFormation
 * deploy. Fail at SYNTH instead. Also requires ≥2 AZs (prod Aurora writer+reader
 * and zone-aware OpenSearch span two). Short-circuits when the flag is off, so
 * the real ENV_CONFIG entries (both `useSharedVpc: false`) never trip it.
 * Exported so it can be unit-tested with synthetic shared-VPC-on configs.
 */
export function assertSharedVpcConfig(cfg: SpsEnvConfig): void {
  if (!cfg.useSharedVpc) {
    return;
  }
  const v = cfg.sharedVpc;
  if (!v.vpcId) {
    throw new Error(
      `Invalid config for env="${cfg.envName}": useSharedVpc requires ` +
        `sharedVpc.vpcId (the its-reciter-vpc01 id imported by attributes; an ` +
        `empty id yields an import that only fails at deploy). See ` +
        `docs/sps-vpc-consolidation-plan.md.`,
    );
  }
  const tiers: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["appSubnetIds", v.appSubnetIds],
    ["dataSubnetIds", v.dataSubnetIds],
    ["albSubnetIds", v.albSubnetIds],
  ];
  for (const [name, ids] of tiers) {
    if (ids.length === 0) {
      throw new Error(
        `Invalid config for env="${cfg.envName}": useSharedVpc requires at least ` +
          `one sharedVpc.${name} (subnetType filtering is unreliable on an imported ` +
          `VPC, so each tier needs explicit its-reciter subnet ids; an empty list ` +
          `yields an empty subnet selection that only fails at deploy). See ` +
          `docs/sps-vpc-consolidation-plan.md.`,
      );
    }
  }
  if (v.availabilityZones.length < 2) {
    throw new Error(
      `Invalid config for env="${cfg.envName}": useSharedVpc requires ≥2 ` +
        `sharedVpc.availabilityZones (prod Aurora writer+reader and zone-aware ` +
        `OpenSearch span two AZs). See docs/sps-vpc-consolidation-plan.md.`,
    );
  }
  const sgs: ReadonlyArray<readonly [string, string]> = [
    ["appSgId", v.appSgId],
    ["etlSgId", v.etlSgId],
    ["albSgId", v.albSgId],
  ];
  for (const [name, id] of sgs) {
    if (!id) {
      throw new Error(
        `Invalid config for env="${cfg.envName}": useSharedVpc requires ` +
          `sharedVpc.${name} (the out-of-band pre-provisioned SG id in the shared ` +
          `VPC; an empty id yields an import that only fails at deploy). Fill it ` +
          `from the shared-VPC team's provisioned SG. See ` +
          `docs/cutover-item3-implementation-map-2026-06-30.md.`,
      );
    }
  }
}

/**
 * Cutover gate for the estate consolidation
 * (docs/sps-vpc-consolidation-plan.md §6.2/§8.5/§8.6; tracker #1370). Called from
 * the `bin` entrypoint — NOT from {@link resolveEnvConfig} — so the flag-on
 * placement unit tests (which synth stacks with `useSharedVpc:true` directly) are
 * unaffected.
 *
 * `useSharedVpc` is NOT yet safe to flip. As built, DataStack holds a single
 * in-place `rds.DatabaseCluster` + `opensearchservice.Domain`; flipping the flag
 * changes their immutable subnet group, so CloudFormation REPLACES both in place
 * — and a replace provisions a FRESH EMPTY cluster/domain UNLESS the snapshot-
 * restore path ({@link SpsEnvConfig.auroraSnapshotIdentifier}) is selected. The
 * plan forbids the empty in-place replace: §8.5/§8.6
 * require the data tier to move as a NEW resource (`DatabaseClusterFromSnapshot` +
 * a fresh OpenSearch domain) stood up ALONGSIDE the live one (reversible —
 * "abandon new, keep old"), "NOT an in-place flip of the old VPC".
 *
 * So this is a conditional tripwire, not an acknowledgement: while `useSharedVpc`
 * is on WITHOUT an {@link SpsEnvConfig.auroraSnapshotIdentifier}, synth throws —
 * which also fails CI on a premature `useSharedVpc:true` flip before the
 * snapshot-restore data path is wired (shipped config is `false`, so the gate is
 * inert today). Setting a snapshot id selects the DataStack
 * `DatabaseClusterFromSnapshot` branch and lifts the throw; the remaining §6
 * operator prerequisites are named in the message but are out-of-band and not
 * synth-enforceable, so the gate still gives no false "looks safe" signal.
 */
export function assertCutoverGate(cfg: SpsEnvConfig): void {
  if (!cfg.useSharedVpc) {
    return; // standalone topology — nothing replaces, nothing to gate
  }
  if (!cfg.auroraSnapshotIdentifier) {
    throw new Error(
      `Refusing to synth/deploy env="${cfg.envName}" with useSharedVpc=true and ` +
        `no auroraSnapshotIdentifier: it is not yet deployable. Flipping ` +
        `useSharedVpc without a snapshot id would CFN-REPLACE the in-place Aurora ` +
        `cluster + OpenSearch domain into EMPTY datastores — the plan forbids ` +
        `this (§8.6: the data tier must move as a NEW resource via ` +
        `DatabaseClusterFromSnapshot, not an in-place flip). Set ` +
        `auroraSnapshotIdentifier to the prod cluster snapshot id (DataStack then ` +
        `restores it alongside the live cluster), and the operator must complete ` +
        `the §6 prerequisites:\n` +
        `  1. snapshot-restore data path: the NEW DatabaseClusterFromSnapshot ` +
        `cluster + fresh OpenSearch domain stood up alongside the live ones ` +
        `(§5.4/§8.5);\n` +
        `  2. re-scope appRwGranteeHost off the decommissioned CIDR ` +
        `("${cfg.appRwGranteeHost}") → "10.46.160.%" (or "%") AND re-issue the live ` +
        `app_rw/app_ro/sps_migrate/sps_bootstrap GRANTs for the 10.46.x source ` +
        `(§6.2) — else app_rw auth fails closed (MySQL 1410);\n` +
        `  3. reseed every DSN + OpenSearch endpoint secret with the new endpoints ` +
        `(§6.4/§6.8) — a stale DSN silently regresses every write.\n` +
        `See docs/sps-vpc-consolidation-plan.md §6.2/§6.8/§8.5/§8.6.`,
    );
  }
  // useSharedVpc on AND a snapshot id set → DataStack builds the data-bearing
  // DatabaseClusterFromSnapshot path, so the synth tripwire lifts. The remaining
  // §6 operator prerequisites (appRwGranteeHost regrant, DSN/endpoint reseed) are
  // out-of-band and NOT synth-enforceable — they are named in the throw above.
}
