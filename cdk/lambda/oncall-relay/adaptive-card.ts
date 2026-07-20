// Pure formatter: CloudWatch alarm payload -> Adaptive Card envelope POSTed
// to a Power Automate "When an HTTP request is received" workflow. Decoupled
// from network + Secrets Manager so the formatter is independently testable.
//
// Navigation lives in `Action.OpenUrl` buttons. #1793 also mirrored them as
// markdown links in the card body, on the theory that buttons are inert on
// the flow-bot delivery path; that theory was wrong -- the real bug was a
// dead URL (#1802, the region display name). With a valid URL a live staging
// card proved the native buttons work, so the mirrored body links were
// removed as clutter.

/** Schema of the inner `Message` JSON CloudWatch alarms publish to SNS. */
export interface CloudWatchAlarmPayload {
  readonly AlarmName: string;
  readonly AlarmDescription?: string;
  readonly NewStateValue: "ALARM" | "OK" | "INSUFFICIENT_DATA" | string;
  readonly NewStateReason?: string;
  readonly StateChangeTime?: string;
  readonly Region?: string;
  readonly AWSAccountId?: string;
}

/**
 * Severity tier assigned by the relay from the originating SNS topic. P1
 * ("page") posts to the primary on-call Teams channel; P2 ("warn") posts to a
 * separate, quieter channel (data-freshness, reconciler, and resource-pressure
 * signals). Rendered as a card fact so the tier is visible even if a P2 alert
 * falls back to the primary channel.
 */
export type AlertSeverity = "page" | "warn";

/**
 * Schema of the custom JSON the EtlStack Step Functions publish to the
 * `etl-failures-<env>` topic — the per-step failure Catch (`NotifyEd` etc.)
 * and the annual approval gate. Distinct from {@link CloudWatchAlarmPayload}:
 * the ETL status/cadence CloudWatch alarms ALSO publish to that topic via an
 * SnsAction, but those carry the alarm shape and still flow through
 * {@link buildAdaptiveCard}. The handler discriminates on the presence of
 * `AlarmName` ({@link isCloudWatchAlarmPayload}).
 */
export interface EtlEventPayload {
  readonly env?: string;
  readonly step?: string;
  readonly action?: string;
  readonly stateMachine?: string;
  readonly execution?: string;
  readonly error?: unknown;
  readonly runbook?: string;
}

/** Adaptive Card envelope shape accepted by the Teams Workflows webhook. */
export interface AdaptiveCardEnvelope {
  readonly type: "message";
  readonly attachments: ReadonlyArray<{
    readonly contentType: "application/vnd.microsoft.card.adaptive";
    readonly content: Record<string, unknown>;
  }>;
}

/** Truncate-with-ellipsis cap on Reason text. Teams flattens long facts. */
const REASON_MAX_CHARS = 1024;

/** Adaptive Card spec version we tested with. Pinned per SPEC § Risks #2. */
const ADAPTIVE_CARD_VERSION = "1.5";

/** State -> emoji map. Handler constant, not configurable. */
const STATE_EMOJI: Readonly<Record<string, string>> = {
  ALARM: "\u{1F6A8}",
  OK: "\u{2705}",
  INSUFFICIENT_DATA: "\u{2753}",
};

/** Fallback emoji for any future state CloudWatch might invent. */
const UNKNOWN_STATE_EMOJI = "\u{2753}";

/**
 * Lead glyph for the P2/warn tier (warning sign). Distinguishes warn cards at
 * a glance from the page tier's alarm glyph -- useful even if a warn card
 * falls back to the page channel before the warn webhook is provisioned.
 */
const WARN_EMOJI = "\u{26A0}\u{FE0F}";

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "\u{2026}";
}

function reasonFact(reason: string | undefined): string {
  if (reason === undefined || reason.length === 0) {
    return "(no reason provided)";
  }
  return truncate(reason, REASON_MAX_CHARS);
}

function cloudwatchConsoleUrl(alarmName: string, region: string): string {
  const encoded = encodeURIComponent(alarmName);
  return `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#alarmsV2:alarm/${encoded}`;
}

/**
 * Console deep-link to the reliability dashboard for the alarm's env, derived
 * from the `-prod` / `-staging` suffix on the alarm name (every SPS alarm
 * carries the env literal -- Footgun #4). Returns `undefined` when the env is
 * not recognisable, so the action is omitted rather than guessed. The first
 * thing an operator wants after the alarm name is the at-a-glance board, not
 * the single-metric alarm page.
 */
function reliabilityDashboardUrl(
  alarmName: string,
  region: string,
): string | undefined {
  const env = alarmName.endsWith("-prod")
    ? "prod"
    : alarmName.endsWith("-staging")
      ? "staging"
      : undefined;
  if (env === undefined) return undefined;
  return `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#dashboards:name=sps-reliability-${env}`;
}

/** Human-readable severity label for the card fact. */
function severityLabel(severity: AlertSeverity): string {
  return severity === "warn" ? "P2 (warn)" : "P1 (page)";
}

export function buildAdaptiveCard(
  alarm: CloudWatchAlarmPayload,
  severity?: AlertSeverity,
): AdaptiveCardEnvelope {
  // `alarm.Region` on the CloudWatch SNS payload is the DISPLAY name
  // ("US East (N. Virginia)"), NOT a region code -- dropping it into a console
  // URL yields spaces + parens and a dead link (breaks the Action.OpenUrl
  // buttons AND the markdown link parser). Console URLs must use the region
  // code; SPS is single-region us-east-1 (same as buildEtlCard below).
  // ponytail: hardcode us-east-1; parse AlarmArn[3] if this ever goes multi-region.
  const region = "us-east-1";
  const regionDisplay = alarm.Region ?? region;
  const stateEmoji = STATE_EMOJI[alarm.NewStateValue] ?? UNKNOWN_STATE_EMOJI;
  // P2/warn ALARM cards lead with the warning glyph so the lower tier reads at
  // a glance (and stays distinguishable if a warn card falls back to the page
  // channel). The alarm glyph stays the P1 lead; OK/INSUFFICIENT keep their
  // state glyph (those transitions aren't wired today, but render correctly).
  const leadEmoji =
    severity === "warn" && alarm.NewStateValue === "ALARM"
      ? WARN_EMOJI
      : stateEmoji;
  const when = alarm.StateChangeTime ?? "(unknown)";

  // Facts are looked up by title (order-independent) on the receiving side.
  // State first, then severity + description, then the raw reason. The alarm's
  // Description is the single source of the "what / why / what-to-do" context
  // (the alarm definitions in cdk append a "Next:" first-response hint), so the
  // card has no separate course-of-action field -- it just renders Description.
  const facts: Array<{ title: string; value: string }> = [
    { title: "State", value: alarm.NewStateValue },
  ];
  if (severity !== undefined) {
    facts.push({ title: "Severity", value: severityLabel(severity) });
  }
  if (
    alarm.AlarmDescription !== undefined &&
    alarm.AlarmDescription.length > 0
  ) {
    facts.push({
      title: "Description",
      value: truncate(alarm.AlarmDescription, REASON_MAX_CHARS),
    });
  }
  facts.push({ title: "Reason", value: reasonFact(alarm.NewStateReason) });
  facts.push({ title: "Region", value: regionDisplay });
  facts.push({ title: "When", value: when });

  // CloudWatch alarm page stays first (actions[0]); the reliability dashboard
  // is the natural second click and is added only when the env is known.
  const actions: Array<{ type: string; title: string; url: string }> = [
    {
      type: "Action.OpenUrl",
      title: "View in CloudWatch",
      url: cloudwatchConsoleUrl(alarm.AlarmName, region),
    },
  ];
  const dashboardUrl = reliabilityDashboardUrl(alarm.AlarmName, region);
  if (dashboardUrl !== undefined) {
    actions.push({
      type: "Action.OpenUrl",
      title: "View reliability dashboard",
      url: dashboardUrl,
    });
  }

  const body: Array<Record<string, unknown>> = [
    {
      type: "TextBlock",
      text: `${leadEmoji} ${alarm.AlarmName}`,
      weight: "Bolder",
      size: "Medium",
      wrap: true,
    },
    {
      type: "FactSet",
      facts,
    },
  ];

  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: ADAPTIVE_CARD_VERSION,
          body,
          actions,
        },
      },
    ],
  };
}

/**
 * Discriminator for the two payload shapes the relay receives on the
 * etl-failures topic. CloudWatch alarms always carry a string `AlarmName`;
 * the ETL Step Functions custom payloads never do.
 */
export function isCloudWatchAlarmPayload(
  p: unknown,
): p is CloudWatchAlarmPayload {
  return (
    typeof p === "object" &&
    p !== null &&
    typeof (p as Record<string, unknown>).AlarmName === "string"
  );
}

/**
 * Subset of the ECS `DescribeTasks` response that Step Functions packs, as a
 * JSON *string*, into a `States.TaskFailed` Cause. Only the fields an operator
 * acts on are declared -- everything else in the blob is network plumbing.
 */
interface EcsTaskCause {
  readonly StoppedReason?: string;
  readonly StopCode?: string;
  readonly ClusterArn?: string;
  readonly TaskArn?: string;
  readonly Containers?: ReadonlyArray<{
    readonly Name?: string;
    readonly ExitCode?: number;
    readonly Reason?: string;
  }>;
  readonly Overrides?: {
    readonly ContainerOverrides?: ReadonlyArray<{
      readonly Command?: ReadonlyArray<string>;
    }>;
  };
}

/** Last `/`-delimited segment of an ARN (task id, cluster name). */
function arnTail(arn: string | undefined): string | undefined {
  if (arn === undefined) return undefined;
  const tail = arn.split("/").pop();
  return tail === undefined || tail.length === 0 ? undefined : tail;
}

/**
 * Reduce a States `Cause` to operator-actionable parts. An EcsRunTask failure
 * arrives as the whole ~2.3KB DescribeTasks JSON -- subnet id, ENI id, MAC,
 * private IP, every ARN, image digest -- which both buried the signal past the
 * 1024-char truncation and spilled internal network detail into Teams. Keep
 * the failing container + exit code, the command it ran (that names the ETL
 * step), why ECS stopped it, and the cluster/task id to pull logs with.
 *
 * A Cause we can't recognise is returned verbatim rather than dropped: a
 * truncated blob still beats an empty fact.
 */
function causeParts(cause: unknown): string[] {
  if (typeof cause !== "string" || cause.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(cause);
  } catch {
    return [cause]; // plain-text Cause (a Lambda/script error message)
  }
  if (typeof parsed !== "object" || parsed === null) return [cause];
  const task = parsed as EcsTaskCause;

  const parts: string[] = [];
  for (const c of task.Containers ?? []) {
    if (c.ExitCode === 0) continue; // a sidecar that exited cleanly isn't the failure
    const name = c.Name ?? "container";
    parts.push(
      c.ExitCode === undefined
        ? `container "${name}" failed`
        : `container "${name}" exited ${c.ExitCode}`,
    );
    if (c.Reason !== undefined && c.Reason.length > 0) parts.push(c.Reason);
  }
  const command = (task.Overrides?.ContainerOverrides ?? []).find(
    (o) => (o.Command ?? []).length > 0,
  )?.Command;
  if (command !== undefined) parts.push(`cmd: ${command.join(" ")}`);
  if (task.StoppedReason !== undefined && task.StoppedReason.length > 0) {
    parts.push(
      task.StopCode !== undefined
        ? `${task.StopCode}: ${task.StoppedReason}`
        : task.StoppedReason,
    );
  }
  const taskId = arnTail(task.TaskArn);
  if (taskId !== undefined) {
    const cluster = arnTail(task.ClusterArn);
    parts.push(cluster !== undefined ? `task ${taskId} in ${cluster}` : `task ${taskId}`);
  }
  return parts.length > 0 ? parts : [cause];
}

/**
 * Render `error` (a States error object or a string) as one safe fact line.
 * Single line on purpose -- Adaptive Card Fact values flatten newlines
 * inconsistently across Teams clients, so the parts are joined with a dash.
 */
function errorFact(error: unknown): string {
  if (error === undefined || error === null) return "(none)";
  if (typeof error === "string") {
    return error.length === 0 ? "(empty)" : truncate(error, REASON_MAX_CHARS);
  }
  const states = error as { readonly Error?: unknown; readonly Cause?: unknown };
  if (typeof states.Error === "string") {
    return truncate(
      [states.Error, ...causeParts(states.Cause)].join(" \u{2014} "),
      REASON_MAX_CHARS,
    );
  }
  try {
    return truncate(JSON.stringify(error), REASON_MAX_CHARS);
  } catch {
    return "(unserializable)";
  }
}

function stepFunctionsConsoleUrl(region: string): string {
  return `https://${region}.console.aws.amazon.com/states/home?region=${region}#/statemachines`;
}

/**
 * Card for an ETL Step Functions event (per-step failure or approval gate).
 * Same no-markdown, truncated, injection-safe posture as the alarm card. Only
 * the fields present on the payload are rendered, so it degrades cleanly as
 * the publisher's message shape evolves.
 */
export function buildEtlCard(payload: EtlEventPayload): AdaptiveCardEnvelope {
  const region = "us-east-1";
  const what = payload.step ?? payload.action ?? "event";
  const env = payload.env ?? "(unknown)";

  const facts: Array<{ title: string; value: string }> = [
    { title: "Env", value: env },
    { title: "Step", value: what },
  ];
  if (payload.stateMachine !== undefined) {
    facts.push({ title: "State machine", value: payload.stateMachine });
  }
  if (payload.execution !== undefined) {
    facts.push({ title: "Execution", value: payload.execution });
  }
  facts.push({ title: "Error", value: errorFact(payload.error) });
  if (payload.runbook !== undefined) {
    facts.push({ title: "Runbook", value: truncate(payload.runbook, REASON_MAX_CHARS) });
  }

  const actions = [
    {
      type: "Action.OpenUrl",
      title: "View in Step Functions",
      url: stepFunctionsConsoleUrl(region),
    },
  ];
  const body: Array<Record<string, unknown>> = [
    {
      type: "TextBlock",
      text: `\u{1F6A8} SPS ETL ${env} \u{2014} ${what}`,
      weight: "Bolder",
      size: "Medium",
      wrap: true,
    },
    { type: "FactSet", facts },
  ];

  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: ADAPTIVE_CARD_VERSION,
          body,
          actions,
        },
      },
    ],
  };
}
