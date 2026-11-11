/**
 * #538 weekly feedback digest: the pure builder (lib/feedback/digest.ts) and the
 * runner's window / state / failure semantics (etl/feedback-digest/run.ts).
 * All answers here are invented.
 */
import { describe, expect, it, vi } from "vitest";

import { type FeedbackDigestDeps, parseRecipients, runFeedbackDigest } from "@/etl/feedback-digest/run";
import { DIGEST_VERBATIM_CAP, type DigestRow, buildFeedbackDigest } from "@/lib/feedback/digest";

const FROM = new Date("2026-11-02T14:00:00.000Z");
const TO = new Date("2026-11-09T14:00:00.000Z");

const row = (over: Partial<DigestRow> = {}): DigestRow => ({
  submittedAt: new Date("2026-11-05T12:00:00.000Z"),
  mode: "contextual",
  purpose: "lookup_person",
  usefulness: null,
  accuracy: null,
  wouldUseAgain: null,
  taskFailureIntent: null,
  whatMissing: null,
  oneChange: null,
  whatHelped: null,
  ...over,
});

const build = (rows: DigestRow[]) =>
  buildFeedbackDigest({ rows, from: FROM, to: TO, baseUrl: "https://scholars.example.edu/" });

describe("buildFeedbackDigest", () => {
  it("empty week: says so, so silence never looks like a broken job", () => {
    const d = build([]);
    expect(d.subject).toBe("Scholars feedback — 0 new submissions (week of 2026-11-02)");
    expect(d.text).toBe("No new feedback this week.\n");
  });

  it("subject counts submissions and names the week by its start", () => {
    expect(build([row()]).subject).toBe("Scholars feedback — 1 new submission (week of 2026-11-02)");
    expect(build([row(), row()]).subject).toBe("Scholars feedback — 2 new submissions (week of 2026-11-02)");
  });

  it("counts by purpose, busiest first", () => {
    const t = build([row(), row(), row({ purpose: "lookup_topic" }), row({ purpose: null })]).text;
    expect(t).toContain("  Look up a person: 2\n  Look up a topic: 1\n  (not answered): 1");
  });

  it("usefulness averages contextual rows only; accuracy averages answered rows only", () => {
    const t = build([
      row({ usefulness: 4, accuracy: 2 }),
      row({ usefulness: 2 }),
      row({ mode: "generic", usefulness: 5 }),
    ]).text;
    expect(t).toContain("Usefulness (contextual only): 3.0 of 5 (n=2)");
    expect(t).toContain("Accuracy: 2.0 of 5 (n=1)");
    expect(build([row()]).text).toContain("Accuracy: n/a");
  });

  it("would-use-again histogram, Definitely at the top", () => {
    const t = build([row({ wouldUseAgain: 5 }), row({ wouldUseAgain: 5 }), row({ wouldUseAgain: 1 })]).text;
    expect(t).toContain("Would use Scholars again (n=3)");
    expect(t).toContain("  Definitely      ## 2");
    expect(t).toContain("  Probably        0");
    expect(t).toContain("  Definitely not  # 1");
  });

  it("actionable verbatims: newest first, all three textareas, capped at 10", () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      row({
        submittedAt: new Date(Date.UTC(2026, 10, 3, i)),
        whatMissing: `missing ${i}`,
      }),
    );
    rows.push(
      row({
        submittedAt: new Date("2026-11-08T00:00:00.000Z"),
        taskFailureIntent: "find a  grant\nnumber",
        oneChange: "add ORCID",
      }),
    );
    const t = build(rows).text;
    expect(t).toContain(`What to fix (${DIGEST_VERBATIM_CAP} of 14, newest first)`);
    expect(t).toContain("  - Couldn't do: find a grant number\n  - Change: add ORCID\n  - Missing: missing 11");
    expect(t).not.toContain("missing 2\n");
    expect(t).not.toContain("missing 3\n");
  });

  it("praise goes in its own What's working section", () => {
    const t = build([row({ whatHelped: "fast search" })]).text;
    expect(t).toContain("What's working (1 of 1, newest first)\n  - fast search");
    expect(t).toContain("What to fix (0 of 0, newest first)\n  (none)");
  });

  it("links the export for the same window", () => {
    expect(build([row()]).text).toContain(
      "https://scholars.example.edu/api/feedback/export?from=2026-11-02&to=2026-11-09",
    );
  });

  it("never prints a CWID or contact email, even if a caller passes them", () => {
    const leaky = { ...row({ whatHelped: "ok" }), cwid: "zzz9999", contactEmail: "person@example.org" };
    const { subject, text } = build([leaky as DigestRow]);
    expect(subject + text).not.toContain("zzz9999");
    expect(subject + text).not.toContain("person@example.org");
  });
});

describe("runFeedbackDigest", () => {
  const deps = (over: Partial<FeedbackDigestDeps> = {}) => {
    const d = {
      lastSuccessStart: vi.fn(async () => FROM as Date | null),
      rowsBetween: vi.fn(async () => [row({ whatHelped: "nice" })]),
      startRun: vi.fn(async () => "run-1"),
      finishRun: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
      env: { FEEDBACK_DIGEST_RECIPIENT: "a@example.org, b@example.org", FEEDBACK_SITE_ORIGIN: "https://s.example.edu" },
      now: () => TO,
      log: vi.fn(),
      ...over,
    };
    return d;
  };

  it("parseRecipients splits, trims, drops blanks", () => {
    expect(parseRecipients(" a@x.org , ,b@x.org ")).toEqual(["a@x.org", "b@x.org"]);
    expect(parseRecipients(" ")).toEqual([]);
    expect(parseRecipients(undefined)).toEqual([]);
  });

  it("covers (last successful run start, now], mails each recipient, then records success", async () => {
    const d = deps();
    await expect(runFeedbackDigest(d)).resolves.toBe("sent");
    expect(d.startRun).toHaveBeenCalledWith(TO);
    expect(d.rowsBetween).toHaveBeenCalledWith(FROM, TO);
    expect(d.send).toHaveBeenCalledTimes(2);
    expect(vi.mocked(d.send).mock.calls.map((c) => c[0])).toEqual(["a@example.org", "b@example.org"]);
    expect(d.finishRun).toHaveBeenCalledWith("run-1", "success", 1);
    // Success is recorded only after every send went out.
    expect(vi.mocked(d.finishRun).mock.invocationCallOrder[0]!).toBeGreaterThan(
      vi.mocked(d.send).mock.invocationCallOrder[1]!,
    );
  });

  it("first run (no prior success) looks back 7 days", async () => {
    const d = deps({ lastSuccessStart: vi.fn(async () => null) });
    await runFeedbackDigest(d);
    expect(d.rowsBetween).toHaveBeenCalledWith(new Date(TO.getTime() - 7 * 86_400_000), TO);
  });

  it("an empty recipient disables it: no run row, no mail", async () => {
    const d = deps({ env: { FEEDBACK_DIGEST_RECIPIENT: " " } });
    await expect(runFeedbackDigest(d)).resolves.toBe("disabled");
    expect(d.startRun).not.toHaveBeenCalled();
    expect(d.send).not.toHaveBeenCalled();
  });

  it("a send failure records the run as failed and rethrows (so the window is retried next week)", async () => {
    const d = deps({ send: vi.fn(async () => Promise.reject(new Error("MessageRejected"))) });
    await expect(runFeedbackDigest(d)).rejects.toThrow("MessageRejected");
    expect(d.finishRun).toHaveBeenCalledWith("run-1", "failed", 0, "MessageRejected");
    expect(d.finishRun).not.toHaveBeenCalledWith("run-1", "success", expect.anything());
  });
});
