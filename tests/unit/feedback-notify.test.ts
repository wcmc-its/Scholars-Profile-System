import { describe, expect, it } from "vitest";
import { buildFeedbackNotice } from "@/lib/feedback/notify";

const base = { pageUrl: "https://x/edit", cwid: "abc1234", role: "wcm_faculty", contactEmail: null, followupOptin: false };

describe("buildFeedbackNotice", () => {
  it("skips metric-only submissions", () => {
    expect(buildFeedbackNotice({ ...base, texts: [["Comment", null], ["Missing", "  "]] })).toBeNull();
  });
  it("includes only non-empty texts plus context", () => {
    const m = buildFeedbackNotice({ ...base, texts: [["Comment", " edits don't stick "], ["Missing", null]] })!;
    expect(m.subject).toBe("Scholars feedback from abc1234");
    expect(m.text).toContain("Comment:\nedits don't stick\n");
    expect(m.text).not.toContain("Missing");
    expect(m.text).toContain("Page: https://x/edit");
  });
});
