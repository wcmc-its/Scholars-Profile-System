/**
 * Start the deployed honors-list scrape from the console (the Sources tab's
 * Run now). Server-only.
 *
 * The mechanism is the dedicated Step Functions machine `scholars-honors-<env>`
 * (cdk/lib/etl-stack.ts), the same one the weekly schedule fires, so a Run now
 * is exactly a scheduled run narrowed to one list: same task definition, same
 * network placement, same failure Catch to the ETL topic. The app task role
 * holds `states:StartExecution` on that one machine and nothing else
 * (`TaskRoleHonorsRunNowPolicy`, cdk/lib/app-stack.ts).
 *
 * Execution input — the shape the state machine reads into the container env:
 *   { "lists": "<id>[,<id>]", "trigger": "manual" }
 */
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";

/** HONORS_RUN_NOW === "on" (per-env in cdk/lib/app-stack.ts; off in both envs). */
export function isHonorsRunNowEnabled(): boolean {
  return process.env.HONORS_RUN_NOW === "on";
}

/** The machine's ARN, wired per env as HONORS_STATE_MACHINE_ARN. */
export function honorsStateMachineArn(): string | null {
  const arn = process.env.HONORS_STATE_MACHINE_ARN?.trim();
  return arn ? arn : null;
}

export type StartHonorsRun = (input: {
  lists: string[];
  requestId: string;
}) => Promise<{ executionArn: string }>;

let client: SFNClient | null = null;

/** Start one execution. Throws when the ARN is not configured or the call fails. */
export const startHonorsRun: StartHonorsRun = async ({ lists, requestId }) => {
  const stateMachineArn = honorsStateMachineArn();
  if (!stateMachineArn) throw new Error("HONORS_STATE_MACHINE_ARN is not set");
  client ??= new SFNClient({});
  const out = await client.send(
    new StartExecutionCommand({
      stateMachineArn,
      // Execution names must be unique per machine for 90 days; the request id
      // is, and it ties the execution to its audit row.
      name: `run-now-${requestId}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80),
      input: JSON.stringify({ lists: lists.join(","), trigger: "manual" }),
    }),
  );
  if (!out.executionArn) throw new Error("StartExecution returned no executionArn");
  return { executionArn: out.executionArn };
};
