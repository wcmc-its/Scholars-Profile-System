/**
 * `components/edit/media-highlights-queue.tsx` — the redesigned Media highlights
 * review surface: tab counts, the filter rail, the search, per-card and bulk
 * decisions, the keyboard shortcuts, and the contested-group guard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { MediaHighlightsQueue } from "@/components/edit/media-highlights-queue";
import type { NewsQueueGroup, NewsQueueRow } from "@/lib/edit/news-queue";

function row(over: Partial<NewsQueueRow>): NewsQueueRow {
  return {
    id: "clip-1",
    cwid: "abc1001",
    slug: "invented-person",
    scholarName: "Invented Person",
    roleLabel: "Full-time faculty",
    roleCategory: "FULL_TIME_FACULTY",
    title: "Professor of Imaginary Studies",
    department: "Imaginary Studies",
    articleTitle: "Invented Institute names a new imaging lead",
    articleUrl: "https://press.example.org/imaging-lead",
    publishedAt: "2026-09-01",
    outlet: "Example Gazette",
    possibleRepeatOf: null,
    placements: [],
    leadOf: null,
    detectedName: "Invented Person",
    likelihood: "HIGH",
    matchBasis: "TAG",
    contextSnippet: null,
    declinedByScholar: false,
    contextSnippetMatches: [],
    source: "NAME",
    sourceRef: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    decidedAt: "2026-09-01T00:00:00.000Z",
    competingCwids: [],
    showOnProfile: true,
    prominence: 0,
    leadershipTier: 3,
    decidedByName: null,
    ...over,
  };
}

const single = (over: Partial<NewsQueueRow>): NewsQueueGroup => {
  const r = row(over);
  return { key: r.id, rows: [r], detectedName: r.detectedName, contested: false };
};

const PENDING: NewsQueueGroup[] = [
  single({ id: "clip-1" }),
  single({
    id: "clip-2",
    cwid: "def2002",
    scholarName: "Madeup Scholar",
    detectedName: "Madeup Scholar",
    articleTitle: "A second fictional headline",
    likelihood: "MEDIUM",
    roleLabel: "Affiliated faculty",
    leadOf: {
      id: "clip-9",
      title: "The original fictional story",
      url: "https://press.example.org/o",
      status: "published",
    },
  }),
];

const COUNTS = { approved: 7, approvedHidden: 2 };
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  refresh.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const bodies = () =>
  fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));

function renderQueue(pending = PENDING) {
  return render(
    <MediaHighlightsQueue pending={pending} approved={[]} rejected={[]} counts={COUNTS} />,
  );
}

describe("MediaHighlightsQueue", () => {
  it("shows counts on the tabs and the pending count in the toolbar", () => {
    renderQueue();
    expect(screen.getByTestId("mh-queue-tab-pending").textContent).toBe("pending2");
    expect(screen.getByTestId("mh-queue-tab-approved").textContent).toBe("approved7");
    expect(screen.getByTestId("mh-queue-count").textContent).toBe("2 awaiting review");
  });

  it("filters by certainty and duplicates from the rail, and Clear resets", () => {
    const { container } = renderQueue();
    const rail = within(container.querySelector("[data-testid=mh-queue-rail]") as HTMLElement);
    fireEvent.click(rail.getByTestId("mh-queue-filter-cert-MEDIUM"));
    expect(screen.getByTestId("mh-queue-count").textContent).toBe("1 awaiting review of 2");
    expect(screen.queryByTestId("mh-queue-card-clip-1")).toBeNull();
    fireEvent.click(rail.getByText("Clear"));
    fireEvent.click(rail.getByTestId("mh-queue-filter-dup"));
    expect(screen.queryByTestId("mh-queue-card-clip-1")).toBeNull();
    expect(screen.getByTestId("mh-queue-copy-of").textContent).toContain(
      "Same story as an approved clip",
    );
  });

  it("searches scholar and detected names", () => {
    renderQueue();
    fireEvent.change(screen.getByTestId("mh-queue-search"), { target: { value: "madeup" } });
    expect(screen.queryByTestId("mh-queue-card-clip-1")).toBeNull();
    expect(screen.getByTestId("mh-queue-card-clip-2")).toBeTruthy();
  });

  it("posts a card's Approve but hide and confirms it in the status bar", async () => {
    renderQueue();
    fireEvent.click(screen.getByTestId("mh-queue-approve-hidden-clip-1"));
    await waitFor(() =>
      expect(screen.getByTestId("mh-queue-toast").textContent).toContain("Approved and hidden"),
    );
    expect(bodies()).toEqual([{ id: "clip-1", decision: "approve_hidden" }]);
    expect(refresh).toHaveBeenCalled();
  });

  it("bulk-approves every selected card", async () => {
    renderQueue();
    fireEvent.click(screen.getByTestId("mh-queue-select-all"));
    const bar = within(screen.getByTestId("mh-queue-bulk-bar"));
    expect(bar.getByText("2 selected")).toBeTruthy();
    fireEvent.click(bar.getByText("Approve"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(bodies()).toEqual([
      { id: "clip-1", decision: "approve" },
      { id: "clip-2", decision: "approve" },
    ]);
    await waitFor(() =>
      expect(screen.getByTestId("mh-queue-toast").textContent).toBe("Approved 2 clips.Dismiss"),
    );
  });

  it("J moves focus and R rejects the focused card", async () => {
    renderQueue();
    expect(screen.getByTestId("mh-queue-card-clip-1").getAttribute("data-focused")).toBe("true");
    fireEvent.keyDown(window, { key: "j" });
    expect(screen.getByTestId("mh-queue-card-clip-2").getAttribute("data-focused")).toBe("true");
    fireEvent.keyDown(window, { key: "r" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(bodies()).toEqual([{ id: "clip-2", decision: "reject" }]);
  });

  it("ignores shortcuts while typing in the search box", () => {
    renderQueue();
    fireEvent.keyDown(screen.getByTestId("mh-queue-search"), { key: "a" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps a contested group out of bulk selection and the A shortcut", () => {
    const contested: NewsQueueGroup = {
      key: "ref-1",
      rows: [
        row({ id: "clip-5" }),
        row({ id: "clip-6", cwid: "ghi3003", scholarName: "Invented Person-Other" }),
      ],
      detectedName: "Invented Person",
      contested: true,
    };
    renderQueue([contested]);
    expect(screen.queryByTestId("mh-queue-select-ref-1")).toBeNull();
    expect(screen.getAllByText("This is the one")).toHaveLength(2);
    expect(screen.getByText("None of these")).toBeTruthy();
    fireEvent.keyDown(window, { key: "a" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says the queue is clear when nothing is pending", () => {
    renderQueue([]);
    expect(screen.getByTestId("mh-queue-empty").textContent).toBe(
      "Queue clear. Nothing awaiting review.",
    );
  });
});
