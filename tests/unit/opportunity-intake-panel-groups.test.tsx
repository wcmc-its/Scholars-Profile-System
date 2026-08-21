/**
 * `components/edit/opportunity-intake-panel.tsx` — redesign 2026-08
 * (`Submissions Redesign.dc.html`): batch-grouping by shared note + submitter,
 * and the status filter tabs. Both are pure front-end reorganizations of data
 * already on each submission row, but the grouping is a loop with real
 * branch logic, so it gets its own check.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { OpportunityIntakePanel } from "@/components/edit/opportunity-intake-panel";

function submission(overrides: Record<string, unknown>) {
  return {
    submissionId: overrides.submissionId,
    url: overrides.url,
    normalizedUrl: overrides.url,
    note: null,
    submittedBy: "paa2013",
    submittedAt: "2026-08-20T12:00:00.000Z",
    status: "processed",
    processedAt: "2026-08-20T13:00:00.000Z",
    producedOpportunityIds: [],
    rejectReason: null,
    ...overrides,
  };
}

const DIGEST = "[ALLPROTOCOLS] Major Funding Digest, week of 2026-08-17";

const SUBMISSIONS = [
  submission({
    submissionId: "s1",
    url: "https://a.org/grants",
    note: DIGEST,
    submittedBy: "paa2013",
    status: "processed",
    producedOpportunityIds: ["manual_url:a-1"],
  }),
  submission({
    submissionId: "s2",
    url: "https://b.org/grants",
    note: DIGEST,
    submittedBy: "paa2013",
    status: "rejected",
    rejectReason: "No funding programs found on the page",
  }),
  // A different submitter with the SAME note text does not join the batch.
  submission({
    submissionId: "s3",
    url: "https://c.org/grants",
    note: DIGEST,
    submittedBy: "flm4001",
    status: "processed",
    producedOpportunityIds: ["manual_url:c-1"],
  }),
  // No note — a one-off submission, never grouped.
  submission({
    submissionId: "s4",
    url: "https://solo.org/grants",
    note: null,
    submittedBy: "paa2013",
    status: "processed",
    producedOpportunityIds: ["manual_url:solo-1"],
  }),
];

function mockFetch(submissions: unknown[] = SUBMISSIONS) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ submissions }) })),
  );
}

describe("OpportunityIntakePanel — batches and status tabs", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("groups consecutive same-note-and-submitter rows into one batch card", async () => {
    mockFetch();
    render(<OpportunityIntakePanel />);
    await waitFor(() => expect(screen.getByText(DIGEST)).toBeTruthy());

    // One batch header for s1+s2 (2 submissions), not three separate headers.
    expect(screen.getAllByText(DIGEST)).toHaveLength(1);
    expect(screen.getByText("2 submissions · paa2013 · Aug 20, 2026")).toBeTruthy();

    // s3 (different submitter, same note text) is its own group — no header, since a
    // lone item's "batch" of one gets no note header, just the bare row.
    const soloCard = screen.getByText("https://c.org/grants").closest("div")!;
    expect(within(soloCard).queryByText(DIGEST)).toBeNull();

    // s4 (no note) never gets a batch header either.
    expect(screen.getByText("https://solo.org/grants")).toBeTruthy();
  });

  it("filters by status tab, with counts from the full list", async () => {
    mockFetch();
    render(<OpportunityIntakePanel />);
    await waitFor(() => expect(screen.getByText("All 4")).toBeTruthy());

    expect(screen.getByText("Processed 3")).toBeTruthy();
    expect(screen.getByText("Rejected 1")).toBeTruthy();
    // No pending/suppressed rows in this fixture — those tabs don't render at all.
    expect(screen.queryByText(/Pending/)).toBeNull();
    expect(screen.queryByText(/Suppressed/)).toBeNull();

    fireEvent.click(screen.getByText("Rejected 1"));
    expect(screen.getByText("https://b.org/grants")).toBeTruthy();
    expect(screen.queryByText("https://a.org/grants")).toBeNull();
    // Switching tabs doesn't change the counts.
    expect(screen.getByText("Processed 3")).toBeTruthy();
  });
});
