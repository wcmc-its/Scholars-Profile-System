/**
 * `npm run etl:feedback-digest` — the weekly feedback digest (see run.ts).
 * Wires the runner to Prisma and the SES mailer, then exits.
 */
import { db } from "@/lib/db";
import { sendMail } from "@/lib/edit/mailer";

import { FEEDBACK_DIGEST_SOURCE, runFeedbackDigest } from "./run";

runFeedbackDigest({
  lastSuccessStart: async () =>
    (
      await db.write.etlRun.findFirst({
        where: { source: FEEDBACK_DIGEST_SOURCE, status: "success" },
        orderBy: { startedAt: "desc" },
        select: { startedAt: true },
      })
    )?.startedAt ?? null,
  rowsBetween: (from, to) =>
    db.write.feedbackSubmission.findMany({
      where: { submittedAt: { gt: from, lte: to } },
      // cwid / contactEmail deliberately not selected: the digest never shows them.
      select: {
        submittedAt: true,
        mode: true,
        purpose: true,
        usefulness: true,
        accuracy: true,
        wouldUseAgain: true,
        taskFailureIntent: true,
        whatMissing: true,
        oneChange: true,
        whatHelped: true,
      },
    }),
  startRun: async (startedAt) =>
    (await db.write.etlRun.create({ data: { source: FEEDBACK_DIGEST_SOURCE, status: "running", startedAt } })).id,
  finishRun: async (id, status, rows, error) => {
    await db.write.etlRun.update({
      where: { id },
      data: { status, completedAt: new Date(), rowsProcessed: rows, errorMessage: error ?? null },
    });
  },
  send: async (to, subject, text) => {
    await sendMail({ to, subject, text });
  },
  env: {
    FEEDBACK_DIGEST_RECIPIENT: process.env.FEEDBACK_DIGEST_RECIPIENT,
    FEEDBACK_SITE_ORIGIN: process.env.FEEDBACK_SITE_ORIGIN,
  },
  now: () => new Date(),
  log: (m) => console.log(m),
})
  .then(() => (process.exitCode = 0))
  .catch((err) => {
    console.error("[feedback-digest] failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.write.$disconnect();
    await db.read.$disconnect();
  });
