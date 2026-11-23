/**
 * Instant email per feedback submission that carries free text. Volume is tiny,
 * so each comment goes out as it lands instead of waiting for the weekly digest
 * (which still includes it). Recipients reuse the digest's SSM list
 * (`FEEDBACK_NOTIFY_RECIPIENT`, comma-separated); empty = off. Never throws:
 * the submission is already saved, a mail failure must not 500 the respondent.
 */
import { sendMail } from "@/lib/edit/mailer";

export type FeedbackNotice = {
  pageUrl: string | null;
  cwid: string | null;
  role: string | null;
  contactEmail: string | null;
  followupOptin: boolean;
  texts: Array<[label: string, value: string | null | undefined]>;
};

export function buildFeedbackNotice(n: FeedbackNotice): { subject: string; text: string } | null {
  const texts = n.texts.filter((t): t is [string, string] => Boolean(t[1]?.trim()));
  if (texts.length === 0) return null;
  const lines = [
    ...texts.map(([label, v]) => `${label}:\n${v.trim()}\n`),
    `Page: ${n.pageUrl ?? "(generic)"}`,
    `CWID: ${n.cwid ?? "(anonymous)"}`,
    `Role: ${n.role ?? "(not given)"}`,
    `Contact: ${n.contactEmail ?? "(none)"}${n.followupOptin ? " (OK to follow up)" : ""}`,
  ];
  return { subject: `Scholars feedback${n.cwid ? ` from ${n.cwid}` : ""}`, text: lines.join("\n") };
}

export async function notifyFeedback(n: FeedbackNotice): Promise<void> {
  const to = (process.env.FEEDBACK_NOTIFY_RECIPIENT ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const mail = buildFeedbackNotice(n);
  if (to.length === 0 || !mail) return;
  for (const addr of to) {
    try {
      await sendMail({ to: addr, ...mail });
    } catch (e) {
      console.error("[feedback-notify] send failed", (e as Error).message);
    }
  }
}
