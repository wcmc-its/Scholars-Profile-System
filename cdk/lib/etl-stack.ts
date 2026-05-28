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
  /** Three state machines: nightly, weekly, annual. */
  public readonly nightlyStateMachine: sfn.StateMachine;
  public readonly weeklyStateMachine: sfn.StateMachine;
  public readonly annualStateMachine: sfn.StateMachine;

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
    //  - **Per-source credentials** -- the five external sources whose
    //    config loaders read granular `SCHOLARS_*` connection vars
    //    (ed/asms/infoed/coi/reciter). Each secret's JSON keys are exactly
    //    those granular var names (pinned during staging/prod bring-up); we
    //    fan each key out into its own env var below so the script reads
    //    `process.env.SCHOLARS_*` with no SDK fetch coupling (#442).
    //
    // The dynamodb/spotlight/hierarchy sources reach ReciterAI's DynamoDB
    // table and S3 buckets through the task role (IAM), not an injected
    // credential -- so they are deliberately absent from the consumer ARN
    // list, and their non-secret config (table name, bucket names, prefix)
    // lives in the task `environment:` block. Eight consumer ARNs total.
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
      description: `SPS ETL ECS task role (${env}). ETL runtime identity; zero AWS API permissions today.`,
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
      // reached via the task role (IAM), not an injected credential:
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
          sfn.Condition.stringEquals("$.startFrom", steps[i].id),
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
    // unchanged snapshot. Per-cadence step ids keep `Task${id}` unique
    // (otherwise the `Task${id}` construct id collides across machines).
    // (vivo-redirect is a manual cutover-prep tool, never a cadence step.)
    // ------------------------------------------------------------------
    const nightlySteps: ReadonlyArray<StepSpec> = [
      { id: "Ed", npmScript: "etl:ed", external: true },
      { id: "Reciter", npmScript: "etl:reciter", external: true },
      { id: "Asms", npmScript: "etl:asms", external: true },
      { id: "Infoed", npmScript: "etl:infoed", external: true },
      { id: "Coi", npmScript: "etl:coi", external: true },
      { id: "MeshCoverageNightly", npmScript: "etl:mesh-coverage", external: false },
      { id: "SearchIndexNightly", npmScript: "search:index", external: false },
      { id: "RevalidateNightly", npmScript: "etl:revalidate", external: false },
    ];
    const weeklySteps: ReadonlyArray<StepSpec> = [
      { id: "Dynamodb", npmScript: "etl:dynamodb", external: true },
      { id: "Completeness", npmScript: "etl:completeness", external: false },
      { id: "Spotlight", npmScript: "etl:spotlight", external: true },
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
          // Default empty input -> Choice falls through to step[0].
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

    // ------------------------------------------------------------------
    // CloudWatch alarms (D4). One status alarm per state machine (3) plus
    // a cadence alarm for the sub-weekly machines (nightly + weekly = 2),
    // five total.
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
  }
}
