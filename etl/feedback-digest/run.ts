/**
 * Weekly feedback digest runner (#538, docs/feedback-badge-spec.md § "Weekly
 * digest email"). Entry point: `npm run etl:feedback-digest` (index.ts), the
 * single step of the `scholars-feedback-digest-<env>` state machine.
 *
 * Window: (previous successful run's start, this run's start]. The spec names
 * an `EtlState` key for the last-run time, but `etl_state` is a single row of
 * typed columns, not a key/value store, so the window is anchored on the
 * `etl_run` rows this step already writes (source {@link FEEDBACK_DIGEST_SOURCE}):
 * a run is only marked `success` after the mail is accepted, so a failed or
 * missed week rolls into the next digest instead of being lost. First run (no
 * prior success): the last 7 days.
 *
 * An empty window sends nothing (the run still records success).
 *
 * Disabled (exit 0, no mail, no state change) when FEEDBACK_DIGEST_RECIPIENT is
 * empty. A send failure throws, so the run is marked `failed`, the process
 * exits non-zero and the state machine's status alarm pages.
 */
import { buildFeedbackDigest, type DigestRow } from "@/lib/feedback/digest";

export const FEEDBACK_DIGEST_SOURCE = "FeedbackDigest";
const FIRST_RUN_LOOKBACK_MS = 7 * 86_400_000;

/** The slice of Prisma + mailer the runner uses (tiny for tests). */
export type FeedbackDigestDeps = {
  lastSuccessStart: () => Promise<Date | null>;
  rowsBetween: (from: Date, to: Date) => Promise<DigestRow[]>;
  startRun: (startedAt: Date) => Promise<string>;
  finishRun: (id: string, status: "success" | "failed", rows: number, error?: string) => Promise<void>;
  send: (to: string, subject: string, text: string) => Promise<void>;
  env: { FEEDBACK_DIGEST_RECIPIENT?: string; FEEDBACK_SITE_ORIGIN?: string };
  now: () => Date;
  log: (msg: string) => void;
};

/** Recipients from a comma-separated env value. */
export function parseRecipients(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Returns what happened; throws on a send failure (after recording it). */
export async function runFeedbackDigest(deps: FeedbackDigestDeps): Promise<"disabled" | "empty" | "sent"> {
  const recipients = parseRecipients(deps.env.FEEDBACK_DIGEST_RECIPIENT);
  if (recipients.length === 0) {
    deps.log("[feedback-digest] FEEDBACK_DIGEST_RECIPIENT is empty; digest disabled, nothing sent");
    return "disabled";
  }
  const to = deps.now();
  const from = (await deps.lastSuccessStart()) ?? new Date(to.getTime() - FIRST_RUN_LOOKBACK_MS);
  const runId = await deps.startRun(to);
  try {
    const rows = await deps.rowsBetween(from, to);
    // Empty week: no mail, but still a success so the window advances. A
    // broken job is the status/cadence alarms' job, not an empty email's.
    if (rows.length === 0) {
      await deps.finishRun(runId, "success", 0);
      deps.log("[feedback-digest] no submissions this window; nothing sent");
      return "empty";
    }
    const mail = buildFeedbackDigest({
      rows,
      from,
      to,
      baseUrl: deps.env.FEEDBACK_SITE_ORIGIN ?? "",
    });
    // sendMail takes one To address; one message per recipient.
    for (const r of recipients) await deps.send(r, mail.subject, mail.text);
    await deps.finishRun(runId, "success", rows.length);
    deps.log(`[feedback-digest] sent ${rows.length} submission(s) to ${recipients.length} recipient(s)`);
    return "sent";
  } catch (err) {
    await deps
      .finishRun(runId, "failed", 0, err instanceof Error ? err.message : String(err))
      .catch(() => deps.log(`[feedback-digest] could not mark run ${runId} failed`));
    throw err;
  }
}
