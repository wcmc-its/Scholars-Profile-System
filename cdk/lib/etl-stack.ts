import {
  CfnOutput,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as events from "aws-cdk-lib/aws-events";
import * as eventsTargets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sns from "aws-cdk-lib/aws-sns";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import { type Construct } from "constructs";
import { type SpsEnvConfig } from "./config";

/** Props for {@link EtlStack}. */
export interface EtlStackProps extends StackProps {
  /** Resolved per-environment configuration. */
  readonly envConfig: SpsEnvConfig;
  /** VPC every workload runs in (from NetworkStack). */
  readonly vpc: ec2.IVpc;
  /** SG attached to ETL Fargate tasks (from NetworkStack). */
  readonly etlSecurityGroup: ec2.ISecurityGroup;
  /** ECS cluster the ETL task family runs in (from AppStack). */
  readonly ecsCluster: ecs.ICluster;
  /**
   * ECR repo holding the dedicated ETL batch image (from AppStack). The ETL
   * scripts are `tsx`-based and need the full dep tree + source, so they run
   * the `scholars-etl-*` image, not the standalone app image (#454).
   */
  readonly etlEcrRepository: ecr.IRepository;
}

/**
 * One step in a state machine. `id` is the construct id (and the
 * `$.startFrom` token operators pass to skip ahead); `npmScript` is the
 * `npm run` script the container executes; `external` marks sources that
 * need a per-source secret from SecretsStack.
 */
interface StepSpec {
  readonly id: string;
  readonly npmScript: string;
  readonly external: boolean;
}

/**
 * EtlStack — Step Functions state machines + cadence/status alarms
 * (B08 + B20).
 *
 * Stack 4 of the six in ADR-008. Provisions three Step Functions state
 * machines (nightly / weekly / annual), the EventBridge cadence rules that
 * fire them, an SNS topic for failures, two CloudWatch alarms per state
 * machine (status + cadence), the SG-to-SG ingress that finally makes the
 * internal ALB reachable from the ETL task family, and a single Fargate
 * task family that runs `npm run etl:<source>` against the dedicated ETL
 * batch image (`scholars-etl-*`, not the standalone app image -- #454).
 *
 * Deliberate deviations from `docs/PRODUCTION_ADDENDUM.md` and the source
 * issue text — documented inline and in PRODUCTION_ADDENDUM § EtlStack:
 *
 * - **D1.** Task integration is ECS RunTask `.sync` (`RUN_JOB`), not
 *   Lambda. Today's `etl/*` scripts are Node entrypoints invoked via
 *   `npm run etl:<source>` against the ETL batch image; packaging each as a
 *   Lambda would multiply build/CI/maintenance surface and run into the
 *   15-min Lambda execution cap for `reciter` and similar long ETLs.
 * - **D3.** The annual hierarchy state machine's manual-approval gate is
 *   an `SnsPublish.waitForTaskToken` directly — no bespoke Lambda. An
 *   operator runs `aws stepfunctions send-task-success --task-token <t>`
 *   from the runbook.
 * - **D4.** Cadence + status alarms use the native Step Functions
 *   `ExecutionsFailed` and `ExecutionsStarted` metrics. An Aurora-polling
 *   Lambda variant is not introduced here; the metric-based alarms cover
 *   the same failure modes with fewer moving parts.
 * - **D7.** Cadences: nightly `cron(0 7 * * ? *)`, weekly
 *   `cron(0 8 ? * SUN *)`, annual `cron(0 9 1 7 ? *)` — all UTC.
 *
 * Cross-stack handoff: this stack consumes the AppStack ECS cluster and
 * the dedicated ETL ECR repo via constructor props (CDK auto-wires the
 * cross-stack export).
 * The internal ALB security group id is consumed via
 * `Fn::ImportValue("Sps-App-${env}-InternalAlbSecurityGroupId")` — the
 * one additive `CfnOutput` we added to AppStack for that purpose (per the
 * plan's resolved coordination item #3).
 */
export class EtlStack extends Stack {
  /** SNS topic every failure / cadence alarm publishes to (B23 wires PagerDuty). */
  public readonly failureTopic: sns.Topic;
  /** Fargate task family every state-machine step launches. */
  public readonly etlTaskDefinition: ecs.FargateTaskDefinition;
  /** Three cadence state machines: nightly, weekly, annual. */
  public readonly nightlyStateMachine: sfn.StateMachine;
  public readonly weeklyStateMachine: sfn.StateMachine;
  public readonly annualStateMachine: sfn.StateMachine;
  /** #595 data-freshness heartbeat — daily etl_run staleness check. */
  public readonly heartbeatStateMachine: sfn.StateMachine;
  /** #393 suppression search-index reconciler (ADR-005 layer 3), ~5 min cadence. */
  public readonly reconcileStateMachine: sfn.StateMachine;
  /** #353 durable CloudFront-invalidation reconciler (ADR-005 layer 3), ~5 min cadence. */
  public readonly cdnReconcileStateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: EtlStackProps) {
    super(scope, id, props);

    const { envConfig, etlSecurityGroup, ecsCluster, etlEcrRepository } = props;
    const env = envConfig.envName;
    // `vpc` is in props for future SG lookups + API consistency with the
    // other stacks. ECS RunTask resolves the VPC from `ecsCluster`, so
    // we don't reference it directly here.
    void props.vpc;

    // ------------------------------------------------------------------
    // SG-to-SG ingress: internal ALB SG admits :80 from the ETL SG.
    //
    // AppStack left the internal ALB unreachable on purpose — its TODO at
    // the SG construction comment names EtlStack as the owner of this
    // rule. AppStack exports the SG id as `Sps-App-${env}-InternalAlbSecurityGroupId`
    // (one additive CfnOutput per the plan); we import it and attach a
    // standalone `CfnSecurityGroupIngress` so the rule sits in this stack
    // regardless of which SG it modifies (mirrors AppStack's pattern that
    // breaks the App <-> Network cycle).
    // ------------------------------------------------------------------
    const internalAlbSgId = Fn.importValue(
      `Sps-App-${env}-InternalAlbSecurityGroupId`,
    );
    new ec2.CfnSecurityGroupIngress(this, "InternalAlbIngressFromEtl", {
      groupId: internalAlbSgId,
      ipProtocol: "tcp",
      fromPort: 80,
      toPort: 80,
      sourceSecurityGroupId: etlSecurityGroup.securityGroupId,
      description: `ETL SG to SPS internal ALB HTTP (${env}) -- /api/revalidate`,
    });

    // ------------------------------------------------------------------
    // ETL secrets, looked up by name (SecretsStack owns the stubs; values
    // are seeded out-of-band). Two classes:
    //
    //  - **Shared** -- db/etl writer DSN + opensearch/etl user + the
    //    revalidate bearer the closing revalidate step posts.
    //  - **Per-source credentials** -- the six external sources whose
    //    config loaders read granular `SCHOLARS_*` connection vars
    //    (ed/asms/infoed/coi/reciter/jenzabar). Each secret's JSON keys are exactly
    //    those granular var names (pinned during staging/prod bring-up); we
    //    fan each key out into its own env var below so the script reads
    //    `process.env.SCHOLARS_*` with no SDK fetch coupling (#442).
    //
    // The dynamodb/spotlight/hierarchy sources reach ReciterAI's DynamoDB
    // table and S3 buckets through the task role (IAM), not an injected
    // credential -- so they are deliberately absent from the consumer ARN
    // list, and their non-secret config (table name, bucket names, prefix)
    // lives in the task `environment:` block. Nine consumer ARNs total.
    // ------------------------------------------------------------------
    const dbEtlSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "EtlDbSecret",
      `scholars/${env}/db/etl`,
    );
    const opensearchEtlSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "EtlOpensearchSecret",
      `scholars/${env}/opensearch/etl`,
    );
    const revalidateTokenSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "RevalidateTokenSecret",
      `scholars/${env}/revalidate-token`,
    );

    /**
     * One external source whose config loader reads granular `SCHOLARS_*`
     * connection vars. `keys` are the secret's JSON field names -- identical
     * to the env-var names the source reads -- each injected via
     * `ecs.Secret.fromSecretsManager(secret, key)`. A key absent from the
     * seeded secret JSON fails ECS task-start, so this list must mirror the
     * pinned shape exactly.
     */
    interface CredentialedSource {
      readonly constructId: string;
      readonly secretName: string;
      readonly keys: readonly string[];
    }
    const credentialedSources: readonly CredentialedSource[] = [
      {
        constructId: "EtlSecretEd",
        secretName: `scholars/${env}/etl/ed`,
        keys: [
          "SCHOLARS_LDAP_URL",
          "SCHOLARS_LDAP_BIND_DN",
          "SCHOLARS_LDAP_BIND_PASSWORD",
        ],
      },
      {
        constructId: "EtlSecretAsms",
        secretName: `scholars/${env}/etl/asms`,
        keys: [
          "SCHOLARS_ASMS_HOST",
          "SCHOLARS_ASMS_PORT",
          "SCHOLARS_ASMS_DATABASE",
          "SCHOLARS_ASMS_USERNAME",
          "SCHOLARS_ASMS_PASSWORD",
        ],
      },
      {
        constructId: "EtlSecretInfoed",
        secretName: `scholars/${env}/etl/infoed`,
        keys: [
          "SCHOLARS_INFOED_DB_URL",
          "SCHOLARS_INFOED_USERNAME",
          "SCHOLARS_INFOED_PASSWORD",
        ],
      },
      {
        constructId: "EtlSecretCoi",
        secretName: `scholars/${env}/etl/coi`,
        keys: [
          "SCHOLARS_COI_URL",
          "SCHOLARS_COI_PORT",
          "SCHOLARS_COI_DATABASE",
          "SCHOLARS_COI_USERNAME",
          "SCHOLARS_COI_PASSWORD",
        ],
      },
      {
        constructId: "EtlSecretReciter",
        secretName: `scholars/${env}/etl/reciter`,
        keys: [
          "SCHOLARS_RECITERDB_HOST",
          "SCHOLARS_RECITERDB_PORT",
          "SCHOLARS_RECITERDB_DATABASE",
          "SCHOLARS_RECITERDB_USERNAME",
          "SCHOLARS_RECITERDB_PASSWORD",
        ],
      },
      {
        // #608 -- the weekly etl:jenzabar step reads PhD primary-mentor rows
        // from the Jenzabar SQL Server via lib/sources/mssql-jenzabar.ts. The
        // etl/hierarchy secret's legacy "Jenzabar" wording is stale (hierarchy
        // now reads ReciterAI S3 via IAM), so Jenzabar gets its own stub.
        constructId: "EtlSecretJenzabar",
        secretName: `scholars/${env}/etl/jenzabar`,
        keys: [
          "SCHOLARS_JENZABAR_SERVER",
          "SCHOLARS_JENZABAR_PORT",
          "SCHOLARS_JENZABAR_DATABASE",
          "SCHOLARS_JENZABAR_USERNAME",
          "SCHOLARS_JENZABAR_PASSWORD",
        ],
      },
      {
        // #746 — the etl:reciter-refresh scanner delivers self-edit "Not mine"
        // rejects to ReCiter's gold standard and fires the delayed, per-uid
        // re-score (analysisRefreshFlag=true). Holds the ReCiter ADMIN api-key,
        // so it lives ONLY in the ETL task — never the public web app — keeping
        // the admin credential out of the internet-facing tier. The base URL is
        // not secret but travels with the key so the two can't drift. Dormant
        // until RECITER_REJECT_SEND=on (env below) + the secret is seeded.
        constructId: "EtlSecretReciterApi",
        secretName: `scholars/${env}/reciter-api`,
        keys: ["RECITER_API_BASE_URL", "RECITER_API_KEY"],
      },
    ];
    const perSourceSecrets = credentialedSources.map((src) =>
      secretsmanager.Secret.fromSecretNameV2(
        this,
        src.constructId,
        src.secretName,
      ),
    );
    const allConsumerSecretArns: string[] = [
      dbEtlSecret.secretArn,
      opensearchEtlSecret.secretArn,
      revalidateTokenSecret.secretArn,
      ...perSourceSecrets.map((s) => s.secretArn),
    ];

    // ------------------------------------------------------------------
    // CloudWatch log group for the ETL task family.
    // ------------------------------------------------------------------
    const logRetention =
      env === "prod" ? logs.RetentionDays.THREE_MONTHS : logs.RetentionDays.ONE_MONTH;
    const etlLogGroup = new logs.LogGroup(this, "EtlLogGroup", {
      logGroupName: `/aws/ecs/sps-etl-${env}`,
      retention: logRetention,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ------------------------------------------------------------------
    // IAM role split — same execution/task pattern AppStack uses (B06).
    //
    // - Execution role: ECR pull, secret injection at task-start, log
    //   stream write. `secretsmanager:GetSecretValue` resource list is the
    //   eight concrete ARNs above -- never `*`. Asserted in the tests.
    // - Task role: identity the running ETL Node process assumes. Today
    //   the scripts read secrets via env vars (injected by ECS), so the
    //   task role itself has zero AWS-API permissions.
    // ------------------------------------------------------------------
    const taskExecutionRole = new iam.Role(this, "EtlTaskExecutionRole", {
      roleName: `sps-etl-task-exec-${env}`,
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: `SPS ETL ECS task-execution role (${env}). Pulls images, injects secrets, writes logs.`,
    });
    taskExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ecr:GetAuthorizationToken"],
        resources: ["*"],
      }),
    );
    taskExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
        ],
        resources: [etlEcrRepository.repositoryArn],
      }),
    );
    taskExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["secretsmanager:GetSecretValue"],
        resources: allConsumerSecretArns,
      }),
    );
    taskExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [etlLogGroup.logGroupArn, `${etlLogGroup.logGroupArn}:*`],
      }),
    );

    const taskRole = new iam.Role(this, "EtlTaskRole", {
      roleName: `sps-etl-task-${env}`,
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: `SPS ETL ECS task role (${env}). ETL runtime identity; read-only access to the three ReciterAI-published IAM-based sources (DynamoDB table + spotlight/hierarchy artifact buckets).`,
    });

    // ------------------------------------------------------------------
    // ReciterAI source grants (read-only).
    //
    // Three ETL steps reach their inputs through THIS task role rather than
    // an injected per-source secret. The `environment:` block below pins
    // their non-secret config (table/bucket names); this policy is the
    // matching IAM grant. Without it each step fails closed at run time
    // (AccessDenied -> exit 1 -> the step's Retry/Catch in the state
    // machine). Each resource is exactly what the step reads -- never a
    // service-wide `*`:
    //
    //   etl:dynamodb     (nightly) dynamodb:Scan  table/reciterai
    //   etl:spotlight    (weekly)  s3:GetObject   wcmc-reciterai-artifacts/spotlight/*
    //   etl:scholar-tool (nightly) s3:GetObject   wcmc-reciterai-artifacts/tools/*
    //   etl:hierarchy    (annual)  s3:GetObject   wcmc-reciterai-hierarchy/*
    //   etl:ed:import-email-visibility (bridge) s3:GetObject wcmc-reciterai-artifacts/ed/*
    //
    // Read-only: the steps Scan the table and GetObject the artifacts; they
    // never write back to ReciterAI's (account-shared) stores. The bucket
    // and table names are the same literals injected in `environment:` below
    // -- a rename must touch both. Spotlight, tools, and ed are prefix-scoped
    // (`spotlight/*`, `tools/*`, `ed/*`) because `wcmc-reciterai-artifacts` is a
    // shared bucket; hierarchy takes the whole bucket because
    // `wcmc-reciterai-hierarchy` is dedicated to it. The `ed/*` prefix is the
    // email-visibility bridge artifact (a WCM-side client uploads the release
    // codes there; the in-VPC import reads them — #443 LDAP workaround).
    // No secretsmanager reference, so the "zero secretsmanager on the ETL
    // task role" assertion (etl-stack.test.ts) still holds.
    // ------------------------------------------------------------------
    new iam.Policy(this, "EtlTaskRoleReciterAiPolicy", {
      policyName: `sps-etl-task-${env}-reciterai`,
      roles: [taskRole],
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["dynamodb:Scan"],
          resources: [
            `arn:aws:dynamodb:${this.region}:${this.account}:table/reciterai`,
          ],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["s3:GetObject"],
          resources: [
            "arn:aws:s3:::wcmc-reciterai-artifacts/spotlight/*",
            "arn:aws:s3:::wcmc-reciterai-artifacts/tools/*",
            "arn:aws:s3:::wcmc-reciterai-artifacts/ed/*",
            "arn:aws:s3:::wcmc-reciterai-hierarchy/*",
          ],
        }),
      ],
    });

    // ------------------------------------------------------------------
    // ETL task family. One image, one container -- per-step
    // differentiation lives in ContainerOverrides at state-machine task
    // construction time (`command: ["npm","run","etl:<source>"]`). Base
    // env carries the db/etl + opensearch/etl + revalidate-token secrets
    // every step needs; each external source's per-source secret is fanned
    // out into the granular `SCHOLARS_*` env vars its config loader reads
    // (#442). The IAM-based sources (dynamodb/spotlight/hierarchy) take
    // their non-secret config from the `environment:` block.
    // ------------------------------------------------------------------
    const containerImage = ecs.ContainerImage.fromEcrRepository(
      etlEcrRepository,
      "latest",
    );
    this.etlTaskDefinition = new ecs.FargateTaskDefinition(
      this,
      "EtlTaskDefinition",
      {
        family: `sps-etl-${env}`,
        cpu: envConfig.etlTaskCpu,
        memoryLimitMiB: envConfig.etlTaskMemoryMiB,
        executionRole: taskExecutionRole,
        taskRole,
      },
    );
    const containerSecrets: { [k: string]: ecs.Secret } = {
      DATABASE_URL: ecs.Secret.fromSecretsManager(dbEtlSecret),
      OPENSEARCH_USER: ecs.Secret.fromSecretsManager(
        opensearchEtlSecret,
        "username",
      ),
      OPENSEARCH_PASS: ecs.Secret.fromSecretsManager(
        opensearchEtlSecret,
        "password",
      ),
      // Read by etl/orchestrate.ts as SCHOLARS_REVALIDATE_TOKEN -- the
      // env-var name is the contract. #447
      SCHOLARS_REVALIDATE_TOKEN:
        ecs.Secret.fromSecretsManager(revalidateTokenSecret),
    };
    // Fan each per-source secret out into the granular `SCHOLARS_*` env
    // vars its config loader reads (#442). The injected env-var name equals
    // the secret's JSON key; ECS only injects keys whose secret the
    // execution role can read (resource list above), and a key absent from
    // the secret JSON fails task-start -- so `keys` must match the seeded
    // shape exactly.
    for (const [i, src] of credentialedSources.entries()) {
      for (const key of src.keys) {
        containerSecrets[key] = ecs.Secret.fromSecretsManager(
          perSourceSecrets[i],
          key,
        );
      }
    }
    const etlContainer = this.etlTaskDefinition.addContainer("etl", {
      image: containerImage,
      containerName: "etl",
      essential: true,
      logging: ecs.LogDriver.awsLogs({
        logGroup: etlLogGroup,
        streamPrefix: "etl",
      }),
      // Non-secret config the IAM-based sources read. Values match the
      // source-script defaults; pinned here so the deployed config is
      // explicit rather than implicit in code (#442). These resources are
      // reached via the task role (IAM), not an injected credential -- the
      // EtlTaskRoleReciterAiPolicy above is the matching read grant:
      //   dynamodb  -> ReciterAI publication table (task-role scan)
      //   spotlight -> ReciterAI artifacts bucket + key prefix
      //   hierarchy -> ReciterAI hierarchy bucket
      environment: {
        NODE_ENV: "production",
        // #485 — the search:index build holds the full corpus graph in memory
        // (178k+ publications). Node's default old-space cap (~2 GB) OOM-kills
        // the task well under the container limit; pin the heap to ~85% of the
        // 8 GB task memory (etlTaskMemoryMiB) so it can use what's allocated.
        NODE_OPTIONS: "--max-old-space-size=7168",
        SCHOLARS_DYNAMODB_TABLE: "reciterai",
        ARTIFACTS_BUCKET: "wcmc-reciterai-artifacts",
        ARTIFACT_PREFIX: "spotlight",
        HIERARCHY_BUCKET: "wcmc-reciterai-hierarchy",
        // #794 — A2 canonical tools taxonomy (etl:scholar-tool). Same shared
        // artifacts bucket as spotlight, under the tools/ prefix.
        TOOLS_BUCKET: "wcmc-reciterai-artifacts",
        TOOLS_PREFIX: "tools",
        // scholar_tool producer switch (#794). "ddb" (legacy DynamoDB Block 5)
        // is the reversible default; "s3" makes etl:scholar-tool the sole
        // scholar_tool writer over the A2 canonical taxonomy and also populates
        // scholar_family (the #799 Methods lens). STAGING-FIRST cutover: "s3" in
        // staging now, prod stays "ddb" until the staging soak completes and the
        // prod cutover is signed off (it reverses a team deferral + unblocks
        // ReciterAI's legacy TOOL# deletion). Applied via cdk deploy
        // --exclusively Sps-Etl-<env>; run etl:scholar-tool after the deploy.
        SCHOLAR_TOOL_SOURCE: env === "staging" ? "s3" : "ddb",
        // OpenSearch domain endpoint (https://...) imported from DataStack;
        // the search-index step's lib/search.ts reads OPENSEARCH_NODE and
        // authenticates with the OPENSEARCH_USER/PASS secrets above. #447
        OPENSEARCH_NODE: `https://${Fn.importValue(
          `Sps-Data-${env}-OpenSearchDomainEndpoint`,
        )}`,
        // #479 — cadence revalidate step POSTs to /api/revalidate on the
        // VPC-private internal ALB (HTTP :80; no TLS on the internal listener).
        // The ETL SG -> internal-ALB-SG :80 ingress is already opened at the
        // top of this stack. `etl/revalidate/index.ts` validates this origin
        // against its allowlist before sending the bearer token.
        SCHOLARS_BASE_URL: `http://${Fn.importValue(
          `Sps-App-${env}-InternalAlbDns`,
        )}`,
        // #746 — the etl:reciter-refresh scanner (operator-run for now) reads
        // this to deliver any deferred ReCiter rejects and fire the delayed,
        // per-uid feature-generator re-score. STAGING-FIRST: ON in staging, OFF
        // in prod until the staging soak completes; the EventBridge → Step
        // Function schedule is a follow-up.
        RECITER_REJECT_SEND: env === "staging" ? "on" : "off",
      },
      secrets: containerSecrets,
    });

    // ------------------------------------------------------------------
    // SNS topic. No subscriptions in this PR; B23 wires PagerDuty.
    // Server-side encryption ON (cheap default that any future external
    // subscriber inherits without re-deploying this stack).
    // ------------------------------------------------------------------
    this.failureTopic = new sns.Topic(this, "EtlFailureTopic", {
      topicName: `etl-failures-${env}`,
      displayName: `SPS ETL failures (${env})`,
    });

    // Allow Step Functions and EventBridge to publish failure notifications.
    this.failureTopic.grantPublish(
      new iam.ServicePrincipal("states.amazonaws.com"),
    );

    // ------------------------------------------------------------------
    // Helper -- build one step (an EcsRunTask) plus its retry/catch.
    // Returns a Chain so the caller can wire it inline.
    // ------------------------------------------------------------------
    const buildStep = (spec: StepSpec): sfn.IChainable => {
      const task = new tasks.EcsRunTask(this, `Task${spec.id}`, {
        integrationPattern: sfn.IntegrationPattern.RUN_JOB,
        cluster: ecsCluster,
        taskDefinition: this.etlTaskDefinition,
        launchTarget: new tasks.EcsFargateLaunchTarget({
          platformVersion: ecs.FargatePlatformVersion.LATEST,
        }),
        assignPublicIp: false,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [etlSecurityGroup],
        containerOverrides: [
          {
            containerDefinition: etlContainer,
            command: ["npm", "run", spec.npmScript],
          },
        ],
        // .sync polls every 5 s; 24 h cap is well past the longest
        // observed ETL (reciter ~12 min). Failure of the underlying ECS
        // task surfaces as States.TaskFailed for the Retry/Catch block.
        taskTimeout: sfn.Timeout.duration(Duration.hours(24)),
      });
      task.addRetry({
        errors: ["States.TaskFailed", "States.Timeout"],
        maxAttempts: 2,
        backoffRate: 2,
        interval: Duration.seconds(30),
      });
      const onFailure = new tasks.SnsPublish(this, `Notify${spec.id}`, {
        topic: this.failureTopic,
        subject: `SPS ETL ${env} -- ${spec.id} failed`,
        message: sfn.TaskInput.fromObject({
          env,
          step: spec.id,
          stateMachine: sfn.JsonPath.stateMachineName,
          execution: sfn.JsonPath.executionName,
          error: sfn.JsonPath.stringAt("$.error"),
        }),
      }).next(new sfn.Fail(this, `Fail${spec.id}`, { cause: `${spec.id} failed` }));
      task.addCatch(onFailure, {
        errors: ["States.ALL"],
        resultPath: "$.error",
      });
      return task;
    };

    // ------------------------------------------------------------------
    // Helper -- build a state machine from an ordered list of steps,
    // prefixing it with a top-level Choice on $.startFrom so operators
    // can skip ahead (`aws stepfunctions start-execution --input
    // '{"startFrom":"<id>"}'`). Falls through to step[0] when the input
    // is absent or matches the first step.
    // ------------------------------------------------------------------
    const buildStateMachine = (
      smId: string,
      cadenceName: string,
      steps: ReadonlyArray<StepSpec>,
      tail?: sfn.IChainable,
    ): sfn.StateMachine => {
      if (steps.length === 0) {
        throw new Error("state machine requires at least one step");
      }
      // Build each step task once; the Choice fans into the same task
      // graph by chaining task[i] -> task[i+1] -> ... -> tail. Wiring the
      // success transitions mutates the underlying State -- the Chain
      // value itself is discarded.
      const stepTasks = steps.map((s) => buildStep(s));
      const startStates = stepTasks as sfn.TaskStateBase[];
      for (let i = 0; i < startStates.length - 1; i++) {
        startStates[i].next(startStates[i + 1]);
      }
      if (tail !== undefined) {
        startStates[startStates.length - 1].next(tail);
      }
      // Top-level Choice. Each branch enters at a different stepTask;
      // because each stepTask was already chained to its successor above,
      // entering mid-chain still walks the rest of the sequence.
      const choice = new sfn.Choice(this, `${smId}StartFromChoice`);
      for (let i = 0; i < steps.length; i++) {
        choice.when(
          // Guard the value test with isPresent. A scheduled invocation
          // passes `{}` (no startFrom key), and Step Functions raises
          // `States.Runtime: Invalid path '$.startFrom'` when a Choice tests
          // a path that is absent from the input. isPresent makes the And
          // short-circuit to false for the missing-key case, so it falls
          // through to .otherwise(step[0]) instead of failing the execution.
          sfn.Condition.and(
            sfn.Condition.isPresent("$.startFrom"),
            sfn.Condition.stringEquals("$.startFrom", steps[i].id),
          ),
          stepTasks[i],
        );
      }
      choice.otherwise(stepTasks[0] as sfn.State);
      const logGroup = new logs.LogGroup(this, `${smId}LogGroup`, {
        logGroupName: `/aws/states/${cadenceName}-${env}`,
        retention: logRetention,
        removalPolicy: RemovalPolicy.RETAIN,
      });
      return new sfn.StateMachine(this, smId, {
        stateMachineName: `scholars-${cadenceName}-${env}`,
        stateMachineType: sfn.StateMachineType.STANDARD,
        definitionBody: sfn.DefinitionBody.fromChainable(choice),
        // 24 h hard cap so a wedged execution can't outlive its cadence.
        timeout: Duration.hours(24),
        logs: {
          destination: logGroup,
          level: sfn.LogLevel.ERROR,
          includeExecutionData: false,
        },
        tracingEnabled: true,
      });
    };

    // ------------------------------------------------------------------
    // Cadence definitions. The nightly machine carries the ED chain head
    // first (orchestrate.ts already aborts the cascade on ED failure --
    // we do the same here implicitly via the Catch block on the first
    // step). Both cadences close with a full OpenSearch rebuild
    // (`search:index` -- atomic alias-swap, so reads never see a gap)
    // then an ISR revalidate sweep (#479 — POSTs to /api/revalidate on
    // the internal ALB; without it ISR pages only refresh on their 6h
    // TTL after a cadence run). mesh-coverage runs nightly only: it
    // recomputes the publication.mesh_terms numerator off ReCiter, which
    // is a nightly source, so a weekly pass would recompute against an
    // unchanged snapshot. dynamodb runs nightly too: ReciterAI recomputes the
    // per-publication Impact / topic / synopsis outputs daily, so a weekly pull
    // surfaced them up to a week late -- nightly keeps Scholars within a day of
    // the upstream scores. (spotlight stays weekly: it is a rotating showcase,
    // and it reads the already-persisted Impact, now refreshed nightly.)
    // Per-cadence step ids keep `Task${id}` unique
    // (otherwise the `Task${id}` construct id collides across machines).
    // (vivo-redirect is a manual cutover-prep tool, never a cadence step.)
    // ------------------------------------------------------------------
    const nightlySteps: ReadonlyArray<StepSpec> = [
      { id: "Ed", npmScript: "etl:ed", external: true },
      { id: "Reciter", npmScript: "etl:reciter", external: true },
      // PubMed competing-interest statements — same WCM-ReciterDB path as Reciter
      // (reads reporting_conflicts), so external:true and placed right after it.
      // Seeds publication_conflict_statement for the COI-gap source below.
      { id: "ReciterCoiStatements", npmScript: "etl:reciter:coi-statements", external: true },
      { id: "Asms", npmScript: "etl:asms", external: true },
      { id: "Infoed", npmScript: "etl:infoed", external: true },
      { id: "Coi", npmScript: "etl:coi", external: true },
      // COI-gap recommendations — reads SPS-DB only (disclosed COI from the Coi
      // step + the PubMed statements above), so external:false. Computes whatever
      // its inputs hold; zero candidates until the WCM statement path is flowing.
      { id: "CoiGap", npmScript: "etl:coi-gap", external: false },
      // After the source ETLs (so a freshly matched publication is enriched the
      // same night) and before search:index (so the rebuilt index carries the
      // day's scores).
      { id: "Dynamodb", npmScript: "etl:dynamodb", external: true },
      // #794 — A2 canonical tools taxonomy → scholar_tool. Runs after Dynamodb
      // (whose scholar projection the cwid FK targets) and before SearchIndex.
      // external:true — reads s3://wcmc-reciterai-artifacts/tools/ via the task
      // role (no per-source secret). A no-op while SCHOLAR_TOOL_SOURCE=ddb;
      // the sole scholar_tool writer once flipped to s3.
      { id: "Tools", npmScript: "etl:scholar-tool", external: true },
      { id: "MeshCoverageNightly", npmScript: "etl:mesh-coverage", external: false },
      // #604 -- stamp publication_type='Retraction' on PubMed-retracted originals
      // ReCiter hasn't re-fetched yet. MUST run after Reciter (whose upsert
      // overwrites publication_type from ReciterDB) and before SearchIndex (so
      // the rebuilt index reflects the stamp). Re-applying nightly is how an
      // un-retraction self-heals: Reciter restores the real type, then this step
      // simply no longer re-stamps the PMID. external:false -- it reads public
      // PubMed E-utilities (NAT egress), no per-source WCM secret.
      { id: "PubMedRetractions", npmScript: "etl:pubmed-retractions", external: false },
      { id: "SearchIndexNightly", npmScript: "search:index", external: false },
      { id: "RevalidateNightly", npmScript: "etl:revalidate", external: false },
    ];
    const weeklySteps: ReadonlyArray<StepSpec> = [
      { id: "Completeness", npmScript: "etl:completeness", external: false },
      { id: "Spotlight", npmScript: "etl:spotlight", external: true },
      // Grant-enrichment sources (#608). They key off the `grant` table that
      // etl:infoed refreshes nightly; none needs 24h freshness, so they batch
      // here weekly instead of weighting the nightly critical path. RePORTER +
      // NSF precede search:index so the funding index carries the refreshed
      // abstracts/keywords; Jenzabar (mentoring chips, ISR-only -- not indexed)
      // need only precede the closing revalidate. All three are full-scan, not
      // new-rows-only: RePORTER's grant<->publication bridge and renewal-year
      // applId/abstract updates accrue to EXISTING grants, so a delta scan
      // would miss them. RePORTER reads ReciterDB (etl/reciter secret), Jenzabar
      // reads its own MSSQL credential (etl/jenzabar), and NSF hits the public
      // NSF Awards API (no credential -- NAT egress only, so external: false).
      { id: "ReporterWeekly", npmScript: "etl:reporter", external: true },
      { id: "NsfWeekly", npmScript: "etl:nsf", external: false },
      { id: "JenzabarWeekly", npmScript: "etl:jenzabar", external: true },
      // #658 -- the remaining grant/PI enrichers, completing the set. Both read
      // PUBLIC sources (Gates BMGF CSV; NIH RePORTER API) over NAT egress with no
      // credential -> external: false, no SecretsStack wiring. Gates (an NSF twin:
      // 90-day TTL + source-precedence guard) precedes search:index so its abstracts
      // are indexed; nih-profile feeds profile/grant deep-links, not the index.
      { id: "GatesWeekly", npmScript: "etl:gates", external: false },
      { id: "NihProfileWeekly", npmScript: "etl:nih-profile", external: false },
      { id: "SearchIndexWeekly", npmScript: "search:index", external: false },
      { id: "RevalidateWeekly", npmScript: "etl:revalidate", external: false },
    ];
    const annualSteps: ReadonlyArray<StepSpec> = [
      { id: "Hierarchy", npmScript: "etl:hierarchy", external: true },
    ];

    // Annual machine appends a manual-approval gate after the hierarchy
    // step. The gate is an SnsPublish with waitForTaskToken: an operator
    // monitors `etl-failures-${env}` (or the topic forwarded to PagerDuty
    // by B23) and runs `aws stepfunctions send-task-success --task-token
    // <t>` from the runbook before the state machine continues.
    const approvalGate = new tasks.SnsPublish(this, "AnnualApprovalGate", {
      topic: this.failureTopic,
      integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      subject: `SPS annual ETL ${env} -- manual approval required`,
      message: sfn.TaskInput.fromObject({
        env,
        action: "approve-annual-hierarchy",
        taskToken: sfn.JsonPath.taskToken,
        runbook: "docs/PRODUCTION_ADDENDUM.md § EtlStack annual approval",
      }),
      // 7 day cap on the approval window -- if no one approves in a week
      // the execution fails and pages.
      taskTimeout: sfn.Timeout.duration(Duration.days(7)),
    });
    approvalGate.addCatch(
      new tasks.SnsPublish(this, "NotifyAnnualApprovalGate", {
        topic: this.failureTopic,
        subject: `SPS annual ETL ${env} -- approval gate failed/timed out`,
        message: sfn.TaskInput.fromObject({ env, step: "AnnualApprovalGate" }),
      }).next(
        new sfn.Fail(this, "FailAnnualApprovalGate", { cause: "approval gate failed" }),
      ),
      { errors: ["States.ALL"], resultPath: "$.error" },
    );

    this.nightlyStateMachine = buildStateMachine(
      "NightlyStateMachine",
      "nightly",
      nightlySteps,
    );
    this.weeklyStateMachine = buildStateMachine(
      "WeeklyStateMachine",
      "weekly",
      weeklySteps,
    );
    this.annualStateMachine = buildStateMachine(
      "AnnualStateMachine",
      "annual",
      annualSteps,
      approvalGate,
    );

    // #595 — data-freshness heartbeat. A single step (`etl:freshness`) reads
    // the `etl_run` audit table and exits non-zero when any tracked source's
    // last SUCCESS is older than its cadence SLA. Runs on its OWN schedule
    // (independent of the cadence machines) so it detects "green-but-stale":
    // an execution that reported success while a source's data did not refresh,
    // or a source quietly dropped from the cadence — neither of which the
    // ExecutionsFailed/ExecutionsStarted alarms below can see. A non-zero exit
    // surfaces via the existing per-machine status alarm (added to `cadences`
    // below) -> failureTopic -> on-call relay. external: false — it reads only
    // the in-VPC Aurora (DATABASE_URL), no WCM source, so it stays green even
    // when the WCM-dependent cadence steps cannot reach their sources.
    const freshnessSteps: ReadonlyArray<StepSpec> = [
      { id: "Freshness", npmScript: "etl:freshness", external: false },
    ];
    this.heartbeatStateMachine = buildStateMachine(
      "HeartbeatStateMachine",
      "heartbeat",
      freshnessSteps,
    );

    // ------------------------------------------------------------------
    // EventBridge schedules (D7). Per-env `etlSchedulesEnabled` flips the
    // rule's `Enabled` flag at deploy time -- staging ships enabled, prod
    // ships disabled so the first deploy never auto-starts an execution
    // before the runbook is reviewed.
    // ------------------------------------------------------------------
    const buildSchedule = (
      ruleId: string,
      cadenceName: string,
      cron: events.Schedule,
      stateMachine: sfn.StateMachine,
    ): events.Rule => {
      const rule = new events.Rule(this, ruleId, {
        ruleName: `sps-etl-${cadenceName}-${env}`,
        description: `SPS ETL ${cadenceName} cadence (${env}). D7.`,
        schedule: cron,
        enabled: envConfig.etlSchedulesEnabled,
      });
      rule.addTarget(
        new eventsTargets.SfnStateMachine(stateMachine, {
          // Empty input -> the isPresent-guarded Choice (buildStateMachine)
          // falls through to step[0]. The guard is load-bearing: without it
          // Step Functions raises `Invalid path '$.startFrom'` on this `{}`.
          input: events.RuleTargetInput.fromObject({}),
        }),
      );
      return rule;
    };

    buildSchedule(
      "NightlyScheduleRule",
      "nightly",
      events.Schedule.expression("cron(0 7 * * ? *)"),
      this.nightlyStateMachine,
    );
    buildSchedule(
      "WeeklyScheduleRule",
      "weekly",
      events.Schedule.expression("cron(0 8 ? * SUN *)"),
      this.weeklyStateMachine,
    );
    buildSchedule(
      "AnnualScheduleRule",
      "annual",
      events.Schedule.expression("cron(0 9 1 7 ? *)"),
      this.annualStateMachine,
    );
    // #595 — heartbeat runs daily at 13:00 UTC, ~6h after the nightly window
    // (07:00) and after the Sunday weekly (08:00), so a failed or missed
    // overnight cadence shows up as staleness the same day. Gated on the same
    // `etlSchedulesEnabled` flag as the cadences: where cadences are disabled
    // (prod pre-launch) there is no fresh data to expect, so the heartbeat
    // would only false-alarm; it activates with the cadences at launch.
    buildSchedule(
      "HeartbeatScheduleRule",
      "heartbeat",
      events.Schedule.expression("cron(0 13 * * ? *)"),
      this.heartbeatStateMachine,
    );

    // ------------------------------------------------------------------
    // CloudWatch alarms (D4). One status alarm per state machine (4: nightly,
    // weekly, annual, heartbeat) plus a cadence alarm for the sub-weekly
    // machines (nightly + weekly + heartbeat = 3), seven total. (#595 added the
    // heartbeat machine + its two alarms.)
    //
    // - **Status alarm** -- ExecutionsFailed sum > 0 over one period at
    //   the cadence interval. Catches every failed execution including
    //   ones that crash before the per-step Catch block runs. Created for
    //   all three machines.
    // - **Cadence alarm** -- ExecutionsStarted sum < 1 over `cadenceWindow`.
    //   Catches EventBridge-rule disable / IAM gap / etc.
    //   `treatMissingData: BREACHING` so a total absence of metric data
    //   alarms (rather than the AWS default of NotBreaching which would
    //   silently miss this).
    //
    //   **Deploy-only constraint (CloudWatch):** for alarms whose period is
    //   >= 1h, `EvaluationPeriods * Period` must be <= 604800s (one week).
    //   `cdk synth` and the cdk-assertions snapshots do NOT catch this --
    //   only the CloudFormation create does (it rolled back staging once).
    //   So the weekly window is capped at exactly 7 days, and the **annual
    //   machine gets no cadence alarm**: a yearly "no execution started"
    //   window can't be expressed, and a 7-day window would false-alarm ~51
    //   weeks a year. The annual run is operator-triggered behind a manual
    //   approval gate, so a missed cadence is caught by the calendar/runbook;
    //   its status alarm still covers execution failures. A synth-time guard
    //   in the tests asserts the <=604800 product for every alarm.
    // ------------------------------------------------------------------
    const alarmAction = new cloudwatchActions.SnsAction(this.failureTopic);
    interface CadenceArgs {
      readonly id: string;
      readonly cadenceLabel: string;
      readonly stateMachine: sfn.StateMachine;
      /**
       * Trailing window for the cadence alarm (ExecutionsStarted Sum < 1 over
       * this window => cadence missed). Must keep `1 * window <= 604800s` per
       * the CloudWatch constraint above. Omitted => no cadence alarm.
       */
      readonly cadenceWindow?: Duration;
    }
    const cadences: ReadonlyArray<CadenceArgs> = [
      {
        id: "Nightly",
        cadenceLabel: "nightly",
        // 25 % grace on top of 24h; 108000s <= 604800s.
        cadenceWindow: Duration.hours(30),
        stateMachine: this.nightlyStateMachine,
      },
      {
        id: "Weekly",
        cadenceLabel: "weekly",
        // Capped at the CloudWatch max (7d = 604800s); the 7-day cadence
        // leaves no room for grace within the limit.
        cadenceWindow: Duration.days(7),
        stateMachine: this.weeklyStateMachine,
      },
      {
        id: "Annual",
        cadenceLabel: "annual",
        // No cadence alarm -- see the deploy-only-constraint note above.
        stateMachine: this.annualStateMachine,
      },
      {
        // #595 heartbeat. Status alarm: a non-zero `etl:freshness` exit
        // (>=1 stale source) trips it -> failureTopic -> relay -> Teams.
        // Cadence alarm: 30h window (daily + 25% grace, 108000s <= 604800s)
        // catches the heartbeat itself going dark so the monitor can't fail
        // silently.
        id: "Heartbeat",
        cadenceLabel: "heartbeat",
        cadenceWindow: Duration.hours(30),
        stateMachine: this.heartbeatStateMachine,
      },
    ];
    for (const c of cadences) {
      const dimensions = {
        StateMachineArn: c.stateMachine.stateMachineArn,
      };
      const failedMetric = new cloudwatch.Metric({
        namespace: "AWS/States",
        metricName: "ExecutionsFailed",
        statistic: cloudwatch.Stats.SUM,
        period: Duration.hours(1),
        dimensionsMap: dimensions,
      });
      const statusAlarm = new cloudwatch.Alarm(this, `${c.id}StatusAlarm`, {
        alarmName: `sps-etl-${c.cadenceLabel}-status-${env}`,
        alarmDescription: `SPS ETL ${c.cadenceLabel} (${env}) -- execution failed.`,
        metric: failedMetric,
        evaluationPeriods: 1,
        threshold: 0,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      statusAlarm.addAlarmAction(alarmAction);
      if (c.cadenceWindow !== undefined) {
        const startedMetric = new cloudwatch.Metric({
          namespace: "AWS/States",
          metricName: "ExecutionsStarted",
          statistic: cloudwatch.Stats.SUM,
          period: c.cadenceWindow,
          dimensionsMap: dimensions,
        });
        const cadenceAlarm = new cloudwatch.Alarm(this, `${c.id}CadenceAlarm`, {
          alarmName: `sps-etl-${c.cadenceLabel}-cadence-${env}`,
          alarmDescription: `SPS ETL ${c.cadenceLabel} (${env}) -- cadence missed (no execution started in period).`,
          metric: startedMetric,
          evaluationPeriods: 1,
          threshold: 1,
          comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.BREACHING,
        });
        cadenceAlarm.addAlarmAction(alarmAction);
      }
    }

    // ------------------------------------------------------------------
    // #393 PR-2 -- suppression search-index reconciler (ADR-005 layer 3).
    //
    // PR-1 (#580) shipped the worker: `npm run search:reconcile` ->
    // `tsx etl/search-reconcile/index.ts`, exit 0 = every stale row reflected
    // (or none were stale), exit 1 = >=1 row failed to reflect again. This
    // wires the continuous ~5 min cadence + alarms that drive it.
    //
    // Compute: a dedicated LEAN Fargate task def (256/512) on the SAME ETL
    // image, run by a minimal single-step STANDARD state machine -- the same
    // EcsRunTask `.sync` + retry/catch + AWS/States alarm shape the cadence
    // machines use (ETL D1 "no Lambda"; #353 also targets the ECS task role,
    // not a Lambda). Lean on CPU/RAM/secrets, not on image (same fat image,
    // so the cold start is unchanged ~30-60s -- fine for a background backstop
    // on a 5 min cadence).
    //
    // Least-privilege: the worker reads the suppression/scholar/pub rows
    // (db.read), stamps the sentinel (db.write -> single DATABASE_URL, no RO
    // split in-container), and talks to OpenSearch (searchClient: OPENSEARCH_NODE
    // env + OPENSEARCH_USER/PASS). So its exec role lists EXACTLY 2 secret ARNs
    // (db/etl + opensearch/etl) vs the ETL task's 8 -- no per-source SCHOLARS_*
    // secrets, no revalidate token, no IAM-source bucket config, and no
    // NODE_OPTIONS heap cap (it never loads the 178k-pub corpus; its memory is
    // bounded by the worker's `take: batchSize`=200).
    //
    // Backstop, not propagation path: ADR-005 layer 1 is the synchronous
    // fast-path the suppress/revoke routes call inline post-commit (<1s p95).
    // This layer-3 reconciler only recovers fast-path writes lost to a crash /
    // outage / `bulk` partial-failure; the ~5 min SLA is that recovery floor,
    // not everyday hide latency.
    //
    // #353 (durable CloudFront invalidation) shares this schedule/alarm shape
    // but is blocked on the #502 WAF-topology decision and uses a
    // non-recomputable invalidation outbox rather than this recomputable
    // sentinel, so it is NOT combined here -- it can graft on later.
    // ------------------------------------------------------------------
    const reconcileLogGroup = new logs.LogGroup(this, "ReconcileLogGroup", {
      logGroupName: `/aws/ecs/sps-reconcile-${env}`,
      retention: logRetention,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const reconcileExecutionRole = new iam.Role(
      this,
      "ReconcileTaskExecutionRole",
      {
        roleName: `sps-reconcile-task-exec-${env}`,
        assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
        description: `SPS reconciler ECS task-execution role (${env}). Pulls the ETL image, injects the db/etl + opensearch/etl secrets, writes logs.`,
      },
    );
    reconcileExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ecr:GetAuthorizationToken"],
        resources: ["*"],
      }),
    );
    reconcileExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
        ],
        resources: [etlEcrRepository.repositoryArn],
      }),
    );
    // Exactly the two secrets the reconcile worker reads -- never the 8 the
    // ETL task carries (asserted in the tests).
    reconcileExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["secretsmanager:GetSecretValue"],
        resources: [dbEtlSecret.secretArn, opensearchEtlSecret.secretArn],
      }),
    );
    reconcileExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [
          reconcileLogGroup.logGroupArn,
          `${reconcileLogGroup.logGroupArn}:*`,
        ],
      }),
    );

    const reconcileTaskRole = new iam.Role(this, "ReconcileTaskRole", {
      roleName: `sps-reconcile-task-${env}`,
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: `SPS reconciler ECS task role (${env}). Runtime identity; zero AWS API permissions (reads everything via injected env).`,
    });

    const reconcileTaskDefinition = new ecs.FargateTaskDefinition(
      this,
      "ReconcileTaskDefinition",
      {
        family: `sps-reconcile-${env}`,
        // Lean: the worker processes <=200 rows, not the corpus. 256/512 with
        // wide headroom; ~16x cheaper than reusing the 8 GB ETL task def at a
        // 5 min cadence.
        cpu: 256,
        memoryLimitMiB: 512,
        executionRole: reconcileExecutionRole,
        taskRole: reconcileTaskRole,
      },
    );
    const reconcileContainer = reconcileTaskDefinition.addContainer(
      "reconcile",
      {
        image: ecs.ContainerImage.fromEcrRepository(etlEcrRepository, "latest"),
        // Container name `reconcile` (not `etl`) keeps the two task defs'
        // containers unambiguous for the tests.
        containerName: "reconcile",
        essential: true,
        logging: ecs.LogDriver.awsLogs({
          logGroup: reconcileLogGroup,
          streamPrefix: "reconcile",
        }),
        environment: {
          NODE_ENV: "production",
          // searchClient() reads OPENSEARCH_NODE; OPENSEARCH_USER/PASS arrive
          // as secrets below. Same cross-stack import the ETL container uses.
          OPENSEARCH_NODE: `https://${Fn.importValue(
            `Sps-Data-${env}-OpenSearchDomainEndpoint`,
          )}`,
        },
        secrets: {
          // db.read + db.write collapse onto this single DSN (no
          // DATABASE_URL_RO in-container), exactly as the search:index step
          // runs.
          DATABASE_URL: ecs.Secret.fromSecretsManager(dbEtlSecret),
          OPENSEARCH_USER: ecs.Secret.fromSecretsManager(
            opensearchEtlSecret,
            "username",
          ),
          OPENSEARCH_PASS: ecs.Secret.fromSecretsManager(
            opensearchEtlSecret,
            "password",
          ),
        },
      },
    );

    const reconcileTask = new tasks.EcsRunTask(this, "TaskReconcile", {
      integrationPattern: sfn.IntegrationPattern.RUN_JOB,
      cluster: ecsCluster,
      taskDefinition: reconcileTaskDefinition,
      launchTarget: new tasks.EcsFargateLaunchTarget({
        platformVersion: ecs.FargatePlatformVersion.LATEST,
      }),
      assignPublicIp: false,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [etlSecurityGroup],
      containerOverrides: [
        {
          containerDefinition: reconcileContainer,
          command: ["npm", "run", "search:reconcile"],
        },
      ],
      // Bounded well under the 15 min state-machine timeout so a wedged run
      // dies before the next 5 min fire stacks on it.
      taskTimeout: sfn.Timeout.duration(Duration.minutes(14)),
    });
    reconcileTask.addRetry({
      errors: ["States.TaskFailed", "States.Timeout"],
      maxAttempts: 2,
      backoffRate: 2,
      interval: Duration.seconds(30),
    });
    reconcileTask.addCatch(
      new tasks.SnsPublish(this, "NotifyReconcile", {
        topic: this.failureTopic,
        subject: `SPS reconciler ${env} -- run failed`,
        message: sfn.TaskInput.fromObject({
          env,
          step: "Reconcile",
          stateMachine: sfn.JsonPath.stateMachineName,
          execution: sfn.JsonPath.executionName,
          error: sfn.JsonPath.stringAt("$.error"),
        }),
      }).next(
        new sfn.Fail(this, "FailReconcile", { cause: "reconcile run failed" }),
      ),
      { errors: ["States.ALL"], resultPath: "$.error" },
    );

    const reconcileSmLogGroup = new logs.LogGroup(this, "ReconcileSmLogGroup", {
      logGroupName: `/aws/states/reconcile-${env}`,
      retention: logRetention,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.reconcileStateMachine = new sfn.StateMachine(
      this,
      "ReconcileStateMachine",
      {
        stateMachineName: `scholars-reconcile-${env}`,
        stateMachineType: sfn.StateMachineType.STANDARD,
        definitionBody: sfn.DefinitionBody.fromChainable(reconcileTask),
        // 15 min hard cap (vs the cadences' 24h): the worker is bounded to
        // <=200 rows, so a longer-running execution is wedged and must not
        // pile up at the 5 min cadence.
        timeout: Duration.minutes(15),
        logs: {
          destination: reconcileSmLogGroup,
          level: sfn.LogLevel.ERROR,
          includeExecutionData: false,
        },
        tracingEnabled: true,
      },
    );

    // EventBridge rate(5 min) schedule. `reconcileScheduleEnabled` is true in
    // both envs (continuous backstop -- see config flag JSDoc). retryAttempts: 0
    // -- a missed fire is recovered by the next 5 min fire and the idempotent
    // worker makes an overlapping run benign, so neither a delivery retry nor a
    // DLQ is wanted.
    const reconcileRule = new events.Rule(this, "ReconcileScheduleRule", {
      ruleName: `sps-reconcile-${env}`,
      description: `SPS suppression search-index reconciler -- 5 min cadence (${env}). #393.`,
      schedule: events.Schedule.rate(Duration.minutes(5)),
      enabled: envConfig.reconcileScheduleEnabled,
    });
    reconcileRule.addTarget(
      new eventsTargets.SfnStateMachine(this.reconcileStateMachine, {
        input: events.RuleTargetInput.fromObject({}),
        retryAttempts: 0,
      }),
    );

    // Alarms. The cadence alarm is the load-bearing one: silent schedule death
    // (rule disabled, IAM gap) is the failure mode that actually hurts a
    // backstop, more than any single run failing. Both periods are 15 min
    // (< 1h) so the <=604800s evaluation-window cap above does not apply.
    const reconcileDimensions = {
      StateMachineArn: this.reconcileStateMachine.stateMachineArn,
    };
    const reconcileStatusAlarm = new cloudwatch.Alarm(
      this,
      "ReconcileStatusAlarm",
      {
        alarmName: `sps-reconcile-status-${env}`,
        alarmDescription: `SPS reconciler (${env}) -- run failed (>=1 suppression row could not be reflected into the index).`,
        metric: new cloudwatch.Metric({
          namespace: "AWS/States",
          metricName: "ExecutionsFailed",
          statistic: cloudwatch.Stats.SUM,
          period: Duration.minutes(15),
          dimensionsMap: reconcileDimensions,
        }),
        evaluationPeriods: 1,
        threshold: 0,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        // An idle 15 min window (no executions) is not a failure -- the cadence
        // alarm below owns absence.
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      },
    );
    reconcileStatusAlarm.addAlarmAction(alarmAction);

    const reconcileCadenceAlarm = new cloudwatch.Alarm(
      this,
      "ReconcileCadenceAlarm",
      {
        alarmName: `sps-reconcile-cadence-${env}`,
        alarmDescription: `SPS reconciler (${env}) -- cadence missed (no execution started in 15 min = 3 missed 5 min fires).`,
        metric: new cloudwatch.Metric({
          namespace: "AWS/States",
          metricName: "ExecutionsStarted",
          statistic: cloudwatch.Stats.SUM,
          period: Duration.minutes(15),
          dimensionsMap: reconcileDimensions,
        }),
        evaluationPeriods: 1,
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        // Total metric absence => the schedule is dead => breach.
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      },
    );
    reconcileCadenceAlarm.addAlarmAction(alarmAction);

    // ------------------------------------------------------------------
    // #353 PR-2 -- durable CloudFront-invalidation reconciler (ADR-005 layer 3).
    //
    // PR-1 (#823) shipped the worker: `npm run cdn:reconcile` ->
    // `tsx etl/cdn-reconcile/index.ts`, exit 0 = every pending edge purge
    // replayed (or none were pending), exit 1 = >=1 row failed to invalidate
    // again. This wires the continuous ~5 min cadence + alarms that drive it,
    // mirroring the #393 search-index reconciler above 1:1.
    //
    // Compute: a dedicated LEAN Fargate task def (256/512) on the SAME ETL
    // image, run by a minimal single-step STANDARD state machine -- the same
    // EcsRunTask `.sync` + retry/catch + AWS/States alarm shape the #393
    // reconciler and the cadence machines use. Lean on CPU/RAM/secrets, not on
    // image (same fat image, so the cold start is unchanged ~30-60s -- fine for
    // a background backstop on a 5 min cadence).
    //
    // Least-privilege, and TIGHTER than #393: the worker reads the
    // `cdn_invalidation` outbox (db.read), stamps the sentinel (db.write ->
    // single DATABASE_URL), and replays the remembered paths via
    // `cloudfront:CreateInvalidation`. It never touches OpenSearch, so its
    // exec role lists EXACTLY 1 secret ARN (db/etl) -- NOT the opensearch/etl
    // secret the #393 reconciler also carries. The TASK role -- the one thing
    // #393 lacked -- carries the single `cloudfront:CreateInvalidation` grant
    // (the synchronous fast-path in `lib/edit/revalidation.ts` runs on the web
    // task, granted in AppStack; this background replay runs here).
    //
    // Backstop, not propagation path: ADR-005 layer 1 is the synchronous
    // `CreateInvalidation` the suppress/rename routes issue inline post-commit.
    // This layer-3 reconciler only recovers fast-path purges lost to a crash /
    // outage / SDK error; the ~5 min SLA is that recovery floor, not everyday
    // edge-cache purge latency.
    //
    // Dormant-safe: the task injects NO SCHOLARS_CLOUDFRONT_DISTRIBUTION_ID, so
    // the worker no-ops without touching the DB (empty-queue-safe) until the
    // operator supplies the distribution id at enable time -- exactly as the
    // synchronous invalidation path is dormant pre-launch. This keeps the
    // reconciler decoupled from the #502-frozen EdgeStack distribution.
    // ------------------------------------------------------------------
    const cdnReconcileLogGroup = new logs.LogGroup(
      this,
      "CdnReconcileLogGroup",
      {
        logGroupName: `/aws/ecs/sps-cdn-reconcile-${env}`,
        retention: logRetention,
        removalPolicy: RemovalPolicy.RETAIN,
      },
    );

    const cdnReconcileExecutionRole = new iam.Role(
      this,
      "CdnReconcileTaskExecutionRole",
      {
        roleName: `sps-cdn-reconcile-task-exec-${env}`,
        assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
        description: `SPS CloudFront-invalidation reconciler ECS task-execution role (${env}). Pulls the ETL image, injects the db/etl secret, writes logs.`,
      },
    );
    cdnReconcileExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ecr:GetAuthorizationToken"],
        resources: ["*"],
      }),
    );
    cdnReconcileExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
        ],
        resources: [etlEcrRepository.repositoryArn],
      }),
    );
    // Exactly the ONE secret the cdn-reconcile worker reads (db/etl); never the
    // opensearch/etl secret the #393 reconciler carries, and never the 8 the ETL
    // task carries (asserted in the tests).
    cdnReconcileExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["secretsmanager:GetSecretValue"],
        resources: [dbEtlSecret.secretArn],
      }),
    );
    cdnReconcileExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [
          cdnReconcileLogGroup.logGroupArn,
          `${cdnReconcileLogGroup.logGroupArn}:*`,
        ],
      }),
    );

    const cdnReconcileTaskRole = new iam.Role(this, "CdnReconcileTaskRole", {
      roleName: `sps-cdn-reconcile-task-${env}`,
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: `SPS CloudFront-invalidation reconciler ECS task role (${env}). Runtime identity; cloudfront:CreateInvalidation only (scoped to a distribution ARN).`,
    });
    // The one grant #393 lacked: replay the remembered paths via
    // CreateInvalidation. Scoped to a distribution ARN (CloudFront is global, so
    // there is no region segment), NEVER a bare `*`. No other permission.
    cdnReconcileTaskRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["cloudfront:CreateInvalidation"],
        resources: [`arn:aws:cloudfront::${this.account}:distribution/*`],
      }),
    );

    const cdnReconcileTaskDefinition = new ecs.FargateTaskDefinition(
      this,
      "CdnReconcileTaskDefinition",
      {
        family: `sps-cdn-reconcile-${env}`,
        // Lean: the worker processes <=200 rows, not the corpus. 256/512 with
        // wide headroom; same lean sizing as the #393 reconciler.
        cpu: 256,
        memoryLimitMiB: 512,
        executionRole: cdnReconcileExecutionRole,
        taskRole: cdnReconcileTaskRole,
      },
    );
    const cdnReconcileContainer = cdnReconcileTaskDefinition.addContainer(
      "cdn-reconcile",
      {
        image: ecs.ContainerImage.fromEcrRepository(etlEcrRepository, "latest"),
        // Container name `cdn-reconcile` (not `etl` / `reconcile`) keeps the
        // three task defs' containers unambiguous for the tests.
        containerName: "cdn-reconcile",
        essential: true,
        logging: ecs.LogDriver.awsLogs({
          logGroup: cdnReconcileLogGroup,
          streamPrefix: "cdn-reconcile",
        }),
        environment: {
          NODE_ENV: "production",
          // NO SCHOLARS_CLOUDFRONT_DISTRIBUTION_ID: dormant-safe -- the worker
          // no-ops without touching the DB until the operator supplies it at
          // enable time. No OPENSEARCH_* either (this worker never reads it).
        },
        secrets: {
          // db.read + db.write collapse onto this single DSN (no
          // DATABASE_URL_RO in-container), exactly as the #393 reconciler runs.
          DATABASE_URL: ecs.Secret.fromSecretsManager(dbEtlSecret),
        },
      },
    );

    const cdnReconcileTask = new tasks.EcsRunTask(this, "TaskCdnReconcile", {
      integrationPattern: sfn.IntegrationPattern.RUN_JOB,
      cluster: ecsCluster,
      taskDefinition: cdnReconcileTaskDefinition,
      launchTarget: new tasks.EcsFargateLaunchTarget({
        platformVersion: ecs.FargatePlatformVersion.LATEST,
      }),
      assignPublicIp: false,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [etlSecurityGroup],
      containerOverrides: [
        {
          containerDefinition: cdnReconcileContainer,
          command: ["npm", "run", "cdn:reconcile"],
        },
      ],
      // Bounded well under the 15 min state-machine timeout so a wedged run
      // dies before the next 5 min fire stacks on it.
      taskTimeout: sfn.Timeout.duration(Duration.minutes(14)),
    });
    cdnReconcileTask.addRetry({
      errors: ["States.TaskFailed", "States.Timeout"],
      maxAttempts: 2,
      backoffRate: 2,
      interval: Duration.seconds(30),
    });
    cdnReconcileTask.addCatch(
      new tasks.SnsPublish(this, "NotifyCdnReconcile", {
        topic: this.failureTopic,
        subject: `SPS CloudFront-invalidation reconciler ${env} -- run failed`,
        message: sfn.TaskInput.fromObject({
          env,
          step: "CdnReconcile",
          stateMachine: sfn.JsonPath.stateMachineName,
          execution: sfn.JsonPath.executionName,
          error: sfn.JsonPath.stringAt("$.error"),
        }),
      }).next(
        new sfn.Fail(this, "FailCdnReconcile", {
          cause: "cdn reconcile run failed",
        }),
      ),
      { errors: ["States.ALL"], resultPath: "$.error" },
    );

    const cdnReconcileSmLogGroup = new logs.LogGroup(
      this,
      "CdnReconcileSmLogGroup",
      {
        logGroupName: `/aws/states/cdn-reconcile-${env}`,
        retention: logRetention,
        removalPolicy: RemovalPolicy.RETAIN,
      },
    );
    this.cdnReconcileStateMachine = new sfn.StateMachine(
      this,
      "CdnReconcileStateMachine",
      {
        stateMachineName: `scholars-cdn-reconcile-${env}`,
        stateMachineType: sfn.StateMachineType.STANDARD,
        definitionBody: sfn.DefinitionBody.fromChainable(cdnReconcileTask),
        // 15 min hard cap (vs the cadences' 24h): the worker is bounded to
        // <=200 rows, so a longer-running execution is wedged and must not
        // pile up at the 5 min cadence.
        timeout: Duration.minutes(15),
        logs: {
          destination: cdnReconcileSmLogGroup,
          level: sfn.LogLevel.ERROR,
          includeExecutionData: false,
        },
        tracingEnabled: true,
      },
    );

    // EventBridge rate(5 min) schedule. `cdnReconcileScheduleEnabled` is true in
    // both envs (continuous backstop -- see config flag JSDoc). retryAttempts: 0
    // -- a missed fire is recovered by the next 5 min fire and the idempotent
    // worker makes an overlapping run benign, so neither a delivery retry nor a
    // DLQ is wanted.
    const cdnReconcileRule = new events.Rule(this, "CdnReconcileScheduleRule", {
      ruleName: `sps-cdn-reconcile-${env}`,
      description: `SPS CloudFront-invalidation reconciler -- 5 min cadence (${env}). #353.`,
      schedule: events.Schedule.rate(Duration.minutes(5)),
      enabled: envConfig.cdnReconcileScheduleEnabled,
    });
    cdnReconcileRule.addTarget(
      new eventsTargets.SfnStateMachine(this.cdnReconcileStateMachine, {
        input: events.RuleTargetInput.fromObject({}),
        retryAttempts: 0,
      }),
    );

    // Alarms. The cadence alarm is the load-bearing one: silent schedule death
    // (rule disabled, IAM gap) is the failure mode that actually hurts a
    // backstop, more than any single run failing. Both periods are 15 min.
    const cdnReconcileDimensions = {
      StateMachineArn: this.cdnReconcileStateMachine.stateMachineArn,
    };
    const cdnReconcileStatusAlarm = new cloudwatch.Alarm(
      this,
      "CdnReconcileStatusAlarm",
      {
        alarmName: `sps-cdn-reconcile-status-${env}`,
        alarmDescription: `SPS CloudFront-invalidation reconciler (${env}) -- run failed (>=1 pending edge purge could not be replayed).`,
        metric: new cloudwatch.Metric({
          namespace: "AWS/States",
          metricName: "ExecutionsFailed",
          statistic: cloudwatch.Stats.SUM,
          period: Duration.minutes(15),
          dimensionsMap: cdnReconcileDimensions,
        }),
        evaluationPeriods: 1,
        threshold: 0,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        // An idle 15 min window (no executions) is not a failure -- the cadence
        // alarm below owns absence.
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      },
    );
    cdnReconcileStatusAlarm.addAlarmAction(alarmAction);

    const cdnReconcileCadenceAlarm = new cloudwatch.Alarm(
      this,
      "CdnReconcileCadenceAlarm",
      {
        alarmName: `sps-cdn-reconcile-cadence-${env}`,
        alarmDescription: `SPS CloudFront-invalidation reconciler (${env}) -- cadence missed (no execution started in 15 min = 3 missed 5 min fires).`,
        metric: new cloudwatch.Metric({
          namespace: "AWS/States",
          metricName: "ExecutionsStarted",
          statistic: cloudwatch.Stats.SUM,
          period: Duration.minutes(15),
          dimensionsMap: cdnReconcileDimensions,
        }),
        evaluationPeriods: 1,
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        // Total metric absence => the schedule is dead => breach.
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      },
    );
    cdnReconcileCadenceAlarm.addAlarmAction(alarmAction);

    // ------------------------------------------------------------------
    // Outputs. Surface the SNS topic ARN (B23 subscribes PagerDuty),
    // each state-machine ARN (operator runbook uses them in
    // start-execution / describe-execution calls), and the ETL task
    // family for parity with AppStack's similar outputs.
    // ------------------------------------------------------------------
    new CfnOutput(this, "EtlFailureTopicArn", {
      value: this.failureTopic.topicArn,
      description: "SPS ETL failure SNS topic ARN (B23 subscribes PagerDuty).",
    });
    new CfnOutput(this, "EtlTaskFamily", {
      value: this.etlTaskDefinition.family,
      description: "SPS ETL Fargate task family.",
    });
    new CfnOutput(this, "NightlyStateMachineArn", {
      value: this.nightlyStateMachine.stateMachineArn,
      description: "SPS nightly ETL state machine ARN.",
    });
    new CfnOutput(this, "WeeklyStateMachineArn", {
      value: this.weeklyStateMachine.stateMachineArn,
      description: "SPS weekly ETL state machine ARN.",
    });
    new CfnOutput(this, "AnnualStateMachineArn", {
      value: this.annualStateMachine.stateMachineArn,
      description: "SPS annual ETL state machine ARN.",
    });
    new CfnOutput(this, "HeartbeatStateMachineArn", {
      value: this.heartbeatStateMachine.stateMachineArn,
      description: "SPS data-freshness heartbeat state machine ARN (#595).",
    });
    new CfnOutput(this, "ReconcileStateMachineArn", {
      value: this.reconcileStateMachine.stateMachineArn,
      description:
        "SPS suppression search-index reconciler state machine ARN (#393).",
    });
    new CfnOutput(this, "CdnReconcileStateMachineArn", {
      value: this.cdnReconcileStateMachine.stateMachineArn,
      description:
        "SPS CloudFront-invalidation reconciler state machine ARN (#353).",
    });
  }
}
