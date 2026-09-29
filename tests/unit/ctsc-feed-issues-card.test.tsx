/**
 * `components/edit/ctsc-feed-issues-card.tsx` — the CTSC "Feed CWID issues"
 * card: issue pills with comma-formatted counts, filtering, badge only in the
 * All view, and a fact/instruction box for every reason (null-safe).
 * All names / CWIDs / emails below are fake.
 */
import { describe, expect, it } from "vitest";
import { render, fireEvent, within } from "@testing-library/react";

import {
  CTSC_FEED_ISSUES_PAGE_SIZE,
  CtscFeedIssuesCard,
  REASONS,
  formatRebuiltAt,
  type CtscFeedIssueRow,
} from "@/components/edit/ctsc-feed-issues-card";

let pk = 1;
function row(over: Partial<CtscFeedIssueRow> = {}): CtscFeedIssueRow {
  return {
    primaryKey: pk++,
    name: "Test Person",
    institution: "Example Hospital",
    feedCwid: null,
    reason: "email-match-name-differs",
    suggestedCwid: "zzz0001",
    suggestedName: "Other Person",
    matchedEmail: "zzz0001@example.org",
    ...over,
  };
}

function renderCard(issues: CtscFeedIssueRow[], syncedAt: string | null = "2026-09-29T06:00:00.000Z") {
  const { container } = render(<CtscFeedIssuesCard issues={issues} syncedAt={syncedAt} />);
  const card = container.querySelector<HTMLElement>('[data-slot="ctsc-feed-issues-card"]');
  if (!card) throw new Error("card not rendered");
  return within(card);
}

describe("CtscFeedIssuesCard", () => {
  it("renders the header copy and the rebuilt timestamp in New York time", () => {
    const card = renderCard([row()]);
    expect(card.getByText(/couldn’t be matched cleanly/)).toBeTruthy();
    expect(card.getByTestId("ctsc-feed-issues-rebuilt").textContent).toBe("Last rebuilt Sep 29, 2026 · 2:00 AM");
  });

  it("formatRebuiltAt handles EST and bad input", () => {
    expect(formatRebuiltAt("2026-01-15T07:05:00.000Z")).toBe("Jan 15, 2026 · 2:05 AM");
    expect(formatRebuiltAt("nope")).toBeNull();
  });

  it("renders pills with thousands-separated counts and aria-pressed", () => {
    const issues = [
      ...Array.from({ length: 1033 }, () => row({ reason: "blank-resolved" })),
      ...Array.from({ length: 2 }, () => row({ reason: "email-ambiguous" })),
    ];
    const card = renderCard(issues);
    const all = card.getByTestId("ctsc-feed-issues-filter-all");
    expect(all.textContent).toBe("All issues1,035");
    expect(all.getAttribute("aria-pressed")).toBe("true");
    const blank = card.getByTestId("ctsc-feed-issues-filter-blank-resolved");
    expect(blank.textContent).toBe("Blank CWID, found via email1,033");
    expect(blank.getAttribute("aria-pressed")).toBe("false");
    // Absent reasons get no pill.
    expect(card.queryByTestId("ctsc-feed-issues-filter-retired-cwid")).toBeNull();
    // Paged: first page only, counts comma-formatted.
    expect(card.getByTestId("ctsc-feed-issues-count").textContent).toBe(
      `Showing ${CTSC_FEED_ISSUES_PAGE_SIZE} of 1,035`,
    );
    fireEvent.click(card.getByTestId("ctsc-feed-issues-more"));
    expect(card.getByTestId("ctsc-feed-issues-count").textContent).toBe(
      `Showing ${CTSC_FEED_ISSUES_PAGE_SIZE * 2} of 1,035`,
    );
  });

  it("filters by issue and shows the badge only in the All view", () => {
    const a = row({ reason: "duplicate-record", feedCwid: "zzz0002" });
    const b = row({ reason: "retired-cwid", feedCwid: "zzz0003" });
    const card = renderCard([a, b]);
    expect(card.getByTestId("ctsc-feed-issues-count").textContent).toBe("2 records");
    expect(within(card.getByTestId(`ctsc-feed-issue-${a.primaryKey}`)).getByText("Duplicate record")).toBeTruthy();

    fireEvent.click(card.getByTestId("ctsc-feed-issues-filter-retired-cwid"));
    expect(card.getByTestId("ctsc-feed-issues-filter-retired-cwid").getAttribute("aria-pressed")).toBe("true");
    expect(card.getByTestId("ctsc-feed-issues-active-label").textContent).toBe("Retired CWID");
    expect(card.getByTestId("ctsc-feed-issues-count").textContent).toBe("1 record");
    expect(card.queryByTestId(`ctsc-feed-issue-${a.primaryKey}`)).toBeNull();
    const rb = within(card.getByTestId(`ctsc-feed-issue-${b.primaryKey}`));
    expect(rb.queryByText("Retired CWID")).toBeNull(); // no badge when filtered
  });

  it("email-match-name-differs: fact line + instruction", () => {
    const r = row();
    const card = renderCard([r]);
    const li = within(card.getByTestId(`ctsc-feed-issue-${r.primaryKey}`));
    expect(li.getByTestId("ctsc-feed-issue-fact").textContent).toBe(
      "zzz0001@example.orgbelongs toOther Person(zzz0001)",
    );
    expect(li.getByTestId("ctsc-feed-issue-instruction").textContent).toBe(
      "If that’s this person, set the CWID; otherwise fix the email.",
    );
    expect(li.getByText("#" + r.primaryKey)).toBeTruthy();
  });

  it("renders every reason with full fields and with all-null fields", () => {
    for (const reason of Object.keys(REASONS)) {
      const full = row({ reason, feedCwid: "zzz0009" });
      const bare = row({
        reason,
        institution: null,
        feedCwid: null,
        suggestedCwid: null,
        suggestedName: null,
        matchedEmail: null,
      });
      const { container, unmount } = render(<CtscFeedIssuesCard issues={[full, bare]} syncedAt={null} />);
      const card = within(container.querySelector<HTMLElement>('[data-slot="ctsc-feed-issues-card"]')!);
      const f = within(card.getByTestId(`ctsc-feed-issue-${full.primaryKey}`));
      expect(f.getByTestId("ctsc-feed-issue-instruction").textContent).not.toBe("");
      expect(f.getAllByTestId("ctsc-feed-issue-fact").length).toBeGreaterThan(0);
      const b = within(card.getByTestId(`ctsc-feed-issue-${bare.primaryKey}`));
      expect(b.getByTestId("ctsc-feed-issue-instruction").textContent).not.toMatch(/null|undefined/);
      for (const el of b.queryAllByTestId("ctsc-feed-issue-fact")) {
        expect(el.textContent).not.toMatch(/null|undefined/);
      }
      expect(card.queryByTestId("ctsc-feed-issues-rebuilt")).toBeNull();
      unmount();
    }
  });

  it("per-reason instructions keep their meaning", () => {
    const cases: [Partial<CtscFeedIssueRow>, RegExp][] = [
      [{ reason: "blank-resolved" }, /CWID is blank\. Set it to zzz0001\./],
      [{ reason: "not-in-ed", feedCwid: "zzz0009" }, /Change CWID zzz0009 to zzz0001\./],
      [{ reason: "not-in-ed", feedCwid: "zzz0009", suggestedCwid: null, suggestedName: null, matchedEmail: null }, /Look the person up and correct the CWID, or clear it\./],
      [{ reason: "retired-cwid", feedCwid: "zzz0009", suggestedCwid: null }, /current CWID/],
      [{ reason: "cwid-email-conflict", feedCwid: "zzz0009" }, /Check which is right\./],
      [{ reason: "email-ambiguous" }, /Set the CWID by hand\./],
      [{ reason: "duplicate-record", feedCwid: "zzz0009" }, /Merge or remove one\./],
    ];
    for (const [over, re] of cases) {
      const r = row(over);
      const { container, unmount } = render(<CtscFeedIssuesCard issues={[r]} syncedAt={null} />);
      const card = within(container.querySelector<HTMLElement>('[data-slot="ctsc-feed-issues-card"]')!);
      expect(card.getByTestId("ctsc-feed-issue-instruction").textContent).toMatch(re);
      unmount();
    }
  });

  it("unknown reasons still get a pill and a row", () => {
    const r = row({ reason: "brand-new-reason" });
    const card = renderCard([r]);
    expect(card.getByTestId("ctsc-feed-issues-filter-brand-new-reason")).toBeTruthy();
    expect(card.getByTestId(`ctsc-feed-issue-${r.primaryKey}`)).toBeTruthy();
  });

  it("empty state", () => {
    const card = renderCard([]);
    expect(card.getByText(/No issues/)).toBeTruthy();
  });
});
