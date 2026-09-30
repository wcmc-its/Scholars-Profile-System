/**
 * `components/edit/opportunity-intake-panel.tsx` — redesign 2026-08
 * (`Submissions Redesign.dc.html`): batch-grouping by shared note + submitter,
 * the status filter tabs, and the second pass — split domain/path URLs,
 * Created chips carrying the GET join's corpus titles (slug fallback), the
 * inline-vs-clamped reject reason, and the note field's progressive
 * disclosure. All front-end reorganizations of data already on each row (the
 * chip titles ride in on the same GET).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

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

function mockFetch(
  submissions: unknown[] = SUBMISSIONS,
  opportunityTitles: Record<string, string> = {},
  submitterNames: Record<string, string> = {},
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ submissions, opportunityTitles, submitterNames }),
    })),
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
    // lone item's "batch" of one gets no note header, just the bare row. Anchor on the
    // GROUP card testid: `closest("div")` would grab the row's inner column wrapper,
    // which never contains the digest header, making this assertion vacuous.
    const soloCard = screen.getByText("c.org").closest('[data-testid="intake-group"]')!;
    expect(within(soloCard as HTMLElement).queryByText(DIGEST)).toBeNull();

    // s4 (no note) never gets a batch header either.
    expect(screen.getByText("solo.org")).toBeTruthy();
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
    expect(screen.getByText("b.org")).toBeTruthy();
    expect(screen.queryByText("a.org")).toBeNull();
    // Switching tabs doesn't change the counts.
    expect(screen.getByText("Processed 3")).toBeTruthy();
  });
});

describe("OpportunityIntakePanel — split URLs and Created chips (redesign second pass)", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("splits each URL into bold domain (www stripped) + muted ellipsized path, one external link", async () => {
    mockFetch([
      submission({
        submissionId: "u1",
        url: "https://www.sponsor.org/research/grants?cycle=2027",
      }),
    ]);
    render(<OpportunityIntakePanel />);
    const domain = await screen.findByText("sponsor.org");
    expect(domain.className).toContain("font-semibold");
    const link = domain.closest("a")!;
    expect(link.getAttribute("href")).toBe("https://www.sponsor.org/research/grants?cycle=2027");
    expect(link.getAttribute("target")).toBe("_blank");
    // The path lives INSIDE the same link, one-line-ellipsized.
    const path = within(link).getByText("/research/grants?cycle=2027");
    expect(path.className).toContain("truncate");
  });

  it("Created chips show the joined corpus title and deep-link the opportunity", async () => {
    mockFetch(
      [
        submission({
          submissionId: "p1",
          url: "https://a.org/grants",
          producedOpportunityIds: ["manual_url:a-1"],
        }),
      ],
      { "manual_url:a-1": "Hartwell Biomedical Research Fellowship" },
    );
    render(<OpportunityIntakePanel />);
    const chip = await screen.findByText("Hartwell Biomedical Research Fellowship");
    expect(chip.closest("a")!.getAttribute("href")).toBe(
      "/edit/grant-matcha?opp=manual_url%3Aa-1",
    );
    expect(screen.getByText("Created")).toBeTruthy();
    // The raw slug no longer leaks into the row once the title resolves.
    expect(screen.queryByText("manual_url:a-1")).toBeNull();
  });

  it("a suppressed submission still shows its created row's title (the join has no suppressed filter)", async () => {
    mockFetch(
      [
        submission({
          submissionId: "sup1",
          url: "https://a.org/grants",
          status: "suppressed",
          producedOpportunityIds: ["manual_url:a-1"],
        }),
      ],
      { "manual_url:a-1": "Retracted But Titled" },
    );
    render(<OpportunityIntakePanel />);
    const chip = await screen.findByText("Retracted But Titled");
    // …but UNLINKED: the detail route 404s suppressed rows, so a link would land on
    // "Couldn't load that opportunity".
    expect(chip.closest("a")).toBeNull();
  });

  it("batch header shows 'Name (cwid)' when the submitter resolves, bare cwid when not", async () => {
    mockFetch(SUBMISSIONS, {}, { paa2013: "Paul Albert" });
    render(<OpportunityIntakePanel />);
    expect(await screen.findByText(/2 submissions · Paul Albert \(paa2013\) ·/)).toBeTruthy();

    cleanup();
    mockFetch(SUBMISSIONS, {}, {});
    render(<OpportunityIntakePanel />);
    expect(await screen.findByText(/2 submissions · paa2013 ·/)).toBeTruthy();
  });

  it("a created id whose corpus row no longer exists degrades to the slug", async () => {
    mockFetch([
      submission({
        submissionId: "p2",
        url: "https://a.org/grants",
        producedOpportunityIds: ["manual_url:gone-1"],
      }),
    ]);
    render(<OpportunityIntakePanel />);
    expect(await screen.findByText("manual_url:gone-1")).toBeTruthy();
  });
});

describe("OpportunityIntakePanel — reject reasons and the note disclosure", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("keeps the batch-note field hidden until the disclosure link opens it", async () => {
    mockFetch([]);
    render(<OpportunityIntakePanel />);
    await waitFor(() => expect(screen.getByText("No submissions yet.")).toBeTruthy());

    expect(screen.queryByLabelText("Description for this batch (optional)")).toBeNull();
    fireEvent.click(screen.getByText("Add a description for this batch (optional)"));
    expect(screen.getByLabelText("Description for this batch (optional)")).toBeTruthy();
  });

  it("renders a short reject reason inline (maroon, no box) and clamps a long one with a toggle", async () => {
    const longReason =
      "The page resolves to a sponsor newsroom archive with no funding program details; " +
      "the extractor found no eligibility, deadline, or award fields after following two " +
      "redirects, so the pipeline judged it non-actionable.";
    mockFetch([
      submission({
        submissionId: "r1",
        url: "https://short.org/x",
        status: "rejected",
        rejectReason: "No funding programs found",
      }),
      submission({
        submissionId: "r2",
        url: "https://long.org/x",
        status: "rejected",
        rejectReason: longReason,
      }),
    ]);
    render(<OpportunityIntakePanel />);

    const short = await screen.findByText("No funding programs found");
    expect(short.className).toContain("text-apollo-maroon");
    // Inline — no tinted box anywhere up its chain.
    expect(short.closest("div")!.className).not.toContain("bg-apollo-lock-bg");

    const long = screen.getByText(longReason);
    expect(long.className).toContain("line-clamp-2");
    expect(long.closest("div")!.className).toContain("bg-apollo-lock-bg");

    fireEvent.click(screen.getByText("Show more"));
    expect(screen.getByText(longReason).className).not.toContain("line-clamp-2");
    fireEvent.click(screen.getByText("Show less"));
    expect(screen.getByText(longReason).className).toContain("line-clamp-2");
  });
});
