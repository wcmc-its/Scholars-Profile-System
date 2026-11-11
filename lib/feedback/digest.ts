/**
 * Weekly feedback digest — the pure email builder (#538,
 * docs/feedback-badge-spec.md § "Weekly digest email").
 *
 * Input: the `feedback_submission` rows since the last digest. Output: a
 * plain-text email. Run by `etl/feedback-digest` on the
 * `scholars-feedback-digest-<env>` schedule.
 *
 * Privacy (spec § "No raw CWID in body"): the row type below deliberately has
 * no `cwid` / `contactEmail` fields, and the builder never prints anything but
 * aggregates and the free-text answers, so a forwarded digest cannot leak who
 * answered. The lead joins to Scholar at export time if they need to.
 */

/** The columns the digest reads. `cwid` / `contactEmail` are deliberately absent. */
export type DigestRow = {
  submittedAt: Date;
  mode: "contextual" | "generic";
  purpose: string | null;
  usefulness: number | null;
  accuracy: number | null;
  wouldUseAgain: number | null;
  taskFailureIntent: string | null;
  whatMissing: string | null;
  oneChange: string | null;
  whatHelped: string | null;
};

/** Verbatim answers shown per section. */
export const DIGEST_VERBATIM_CAP = 10;

const PURPOSE_LABEL: Record<string, string> = {
  lookup_person: "Look up a person",
  lookup_topic: "Look up a topic",
  browse_unit: "Browse a unit",
  research_story: "Research a story",
  evaluate_scholars: "Evaluate Scholars",
  other: "Other",
};

const WOULD_USE_AGAIN_LABEL = ["Definitely not", "Probably not", "Unsure", "Probably", "Definitely"];

/** "YYYY-MM-DD" of an instant, UTC. */
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function mean(xs: number[]): string {
  if (xs.length === 0) return "n/a";
  return `${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1)} of 5 (n=${xs.length})`;
}

/** Answers can carry newlines; keep each on one indented line. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export type DigestInput = {
  rows: readonly DigestRow[];
  /** Window the rows cover: (from, to]. */
  from: Date;
  to: Date;
  /** Site origin for the export link, e.g. "https://scholars.weill.cornell.edu". */
  baseUrl: string;
};

/** Build the digest email. Rows may arrive in any order. */
export function buildFeedbackDigest({ rows, from, to, baseUrl }: DigestInput): {
  subject: string;
  text: string;
} {
  const week = isoDay(from);
  const n = rows.length;
  const exportUrl = `${baseUrl.replace(/\/+$/, "")}/api/feedback/export?from=${isoDay(from)}&to=${isoDay(to)}`;

  if (n === 0) {
    return {
      subject: `Scholars feedback — 0 new submissions (week of ${week})`,
      // Silence is ambiguous (no traffic, or a broken job), so say so.
      text: "No new feedback this week.\n",
    };
  }

  const newest = [...rows].sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime());
  const lines: string[] = [];
  lines.push(`${n} new ${n === 1 ? "submission" : "submissions"}, ${isoDay(from)} to ${isoDay(to)}.`, "");

  // Count by purpose (Q1), busiest first.
  const purposes = new Map<string, number>();
  for (const r of rows) {
    const k = r.purpose ?? "(not answered)";
    purposes.set(k, (purposes.get(k) ?? 0) + 1);
  }
  lines.push("Why people came");
  for (const [k, c] of [...purposes].sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${PURPOSE_LABEL[k] ?? k}: ${c}`);
  }
  lines.push("");

  // Means. Usefulness only from contextual rows (a generic "Scholars overall"
  // rating is a different question); accuracy only where it was asked.
  lines.push(
    `Usefulness (contextual only): ${mean(
      rows.filter((r) => r.mode === "contextual" && r.usefulness !== null).map((r) => r.usefulness!),
    )}`,
  );
  lines.push(`Accuracy: ${mean(rows.filter((r) => r.accuracy !== null).map((r) => r.accuracy!))}`);
  lines.push("");

  // Would use again (Q5) as a text histogram.
  const answered = rows.filter((r) => r.wouldUseAgain !== null && r.wouldUseAgain >= 1 && r.wouldUseAgain <= 5);
  lines.push(`Would use Scholars again (n=${answered.length})`);
  for (let v = 5; v >= 1; v--) {
    const c = answered.filter((r) => r.wouldUseAgain === v).length;
    lines.push(`  ${WOULD_USE_AGAIN_LABEL[v - 1]!.padEnd(15)} ${"#".repeat(c)}${c > 0 ? " " : ""}${c}`);
  }
  lines.push("");

  // Actionable verbatims: the three "what went wrong" textareas, newest first.
  const actionable = newest
    .flatMap((r) => [
      r.taskFailureIntent && `Couldn't do: ${oneLine(r.taskFailureIntent)}`,
      r.whatMissing && `Missing: ${oneLine(r.whatMissing)}`,
      r.oneChange && `Change: ${oneLine(r.oneChange)}`,
    ])
    .filter((x): x is string => Boolean(x));
  lines.push(`What to fix (${Math.min(actionable.length, DIGEST_VERBATIM_CAP)} of ${actionable.length}, newest first)`);
  lines.push(...(actionable.length ? actionable.slice(0, DIGEST_VERBATIM_CAP).map((s) => `  - ${s}`) : ["  (none)"]));
  lines.push("");

  const praise = newest.filter((r) => r.whatHelped).map((r) => oneLine(r.whatHelped!));
  lines.push(`What's working (${Math.min(praise.length, DIGEST_VERBATIM_CAP)} of ${praise.length}, newest first)`);
  lines.push(...(praise.length ? praise.slice(0, DIGEST_VERBATIM_CAP).map((s) => `  - ${s}`) : ["  (none)"]));
  lines.push("");

  lines.push(`Full data (CSV, access-controlled): ${exportUrl}`);

  return {
    subject: `Scholars feedback — ${n} new ${n === 1 ? "submission" : "submissions"} (week of ${week})`,
    text: `${lines.join("\n")}\n`,
  };
}
