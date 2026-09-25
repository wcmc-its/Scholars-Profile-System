/**
 * `components/edit/news-approval-queue.tsx` — the `/edit/news-queue` redesign.
 * Pins: one card per story; "Approve all" approves each waiting mention; a
 * contested name blocks Approve / Hide until a scholar is picked, then posts the
 * picked row; Hide posts `approve_hidden`; the filter rail and search narrow the
 * list; the contested banner's "Show only these". All people are invented.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { buildStories, NewsApprovalQueue } from "@/components/edit/news-approval-queue";
import type { NewsQueueGroup, NewsQueueRow } from "@/lib/edit/news-queue";

function row(over: Partial<NewsQueueRow>): NewsQueueRow {
  return {
    id: "n1",
    cwid: "zzz1001",
    slug: null,
    scholarName: "Ivy Invented",
    roleLabel: "Full-time faculty",
    roleCategory: "full_time_faculty",
    title: "Professor of Examples",
    department: "Examples",
    articleTitle: "Invented Institute opens a lab",
    articleUrl: "https://news.example.org/lab",
    publishedAt: "2025-05-15",
    outlet: null,
    possibleRepeatOf: null,
    placements: [],
    leadOf: null,
    detectedName: "Ivy Invented",
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
const g = (key: string, rows: NewsQueueRow[]): NewsQueueGroup => ({
  key,
  rows,
  detectedName: rows[0].detectedName,
  contested: new Set(rows.map((r) => r.cwid)).size > 1,
});

const COUNTS = { approved: 0, approvedHidden: 0 };
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  refresh.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const lab1 = g("a", [row({ id: "a1", cwid: "zzz1001", scholarName: "Ivy Invented" })]);
const lab2 = g("b", [
  row({
    id: "b1",
    cwid: "zzz1002",
    scholarName: "Max Madeup",
    detectedName: "Max Madeup",
    matchBasis: "BODY",
  }),
]);
const other = g("c", [
  row({
    id: "c1",
    cwid: "zzz1003",
    scholarName: "Pat Placeholder",
    detectedName: "Pat Placeholder",
    articleTitle: "A different story",
    articleUrl: "https://news.example.org/other",
    publishedAt: "2024-02-01",
    roleLabel: "Doctoral student",
  }),
]);
const contested = g("https://news.example.org/other|sam sample", [
  row({
    id: "d1",
    cwid: "zzz2001",
    scholarName: "Sam Sample",
    detectedName: "Sam Sample",
    articleTitle: "A different story",
    articleUrl: "https://news.example.org/other",
    publishedAt: "2024-02-01",
    likelihood: "MEDIUM",
    matchBasis: "BODY",
    sourceRef: "https://news.example.org/other|sam sample",
  }),
  row({
    id: "d2",
    cwid: "zzz2002",
    scholarName: "Sam Sample",
    detectedName: "Sam Sample",
    articleTitle: "A different story",
    articleUrl: "https://news.example.org/other",
    publishedAt: "2024-02-01",
    likelihood: "MEDIUM",
    matchBasis: "BODY",
    sourceRef: "https://news.example.org/other|sam sample",
  }),
]);

describe("buildStories", () => {
  it("buckets groups by article URL and 'people' puts the biggest story first", () => {
    const stories = buildStories([lab1, lab2, other], "recent");
    expect(stories.map((s) => s.groups.length)).toEqual([2, 1]);
    expect(buildStories([other, lab1, lab2], "people")[0].url).toBe("https://news.example.org/lab");
  });
});

describe("NewsApprovalQueue", () => {
  it("renders one card per story and Approve all approves each waiting mention", async () => {
    render(
      <NewsApprovalQueue
        pending={[lab1, lab2, other]}
        approved={[]}
        rejected={[]}
        counts={COUNTS}
      />,
    );
    const card = screen.getByTestId("news-queue-story-https://news.example.org/lab");
    expect(within(card).getByText("2 scholars named")).toBeTruthy();
    expect(screen.getByTestId("news-queue-filter-count").textContent).toBe(
      "3 mentions in 2 stories",
    );

    fireEvent.click(within(card).getByRole("button", { name: "Approve all" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const bodies = fetchMock.mock.calls.map((c) =>
      JSON.parse((c[1] as RequestInit).body as string),
    );
    expect(bodies).toEqual(
      expect.arrayContaining([
        { id: "a1", decision: "approve" },
        { id: "b1", decision: "approve" },
      ]),
    );
    await waitFor(() =>
      expect(screen.getByTestId("news-queue-toast").textContent).toContain("Approved 2 mentions"),
    );
    expect(refresh).toHaveBeenCalled();
  });

  it("contested: Approve and Hide wait for a pick, then act on the picked row", async () => {
    render(<NewsApprovalQueue pending={[contested]} approved={[]} rejected={[]} counts={COUNTS} />);
    expect(screen.getByTestId("news-queue-contested-banner").textContent).toContain(
      "1mention matches",
    );
    const mention = screen.getByTestId(`news-queue-group-${contested.key}`);
    const approve = within(mention).getByRole("button", { name: "Approve" }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(within(mention).getByText("None of these")).toBeTruthy();

    fireEvent.click(within(mention).getAllByRole("radio")[1]);
    fireEvent.click(screen.getByTestId("news-queue-approve-hidden-d2"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      id: "d2",
      decision: "approve_hidden",
    });
  });

  it("the rail and search narrow the stories", () => {
    render(
      <NewsApprovalQueue
        pending={[lab1, lab2, other]}
        approved={[]}
        rejected={[]}
        counts={COUNTS}
      />,
    );
    const rail = screen.getAllByTestId("news-queue-rail")[0];
    fireEvent.click(within(rail).getByRole("checkbox", { name: /Name in text/ }));
    expect(screen.getByTestId("news-queue-filter-count").textContent).toBe("1 mention in 1 story");
    fireEvent.click(within(rail).getByRole("button", { name: "Clear" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search scholar or story" }), {
      target: { value: "different" },
    });
    expect(screen.getByTestId("news-queue-filter-count").textContent).toBe("1 mention in 1 story");
  });

  it("Show only these narrows Pending to contested names", () => {
    render(
      <NewsApprovalQueue pending={[lab1, contested]} approved={[]} rejected={[]} counts={COUNTS} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show only these" }));
    expect(screen.queryByTestId("news-queue-story-https://news.example.org/lab")).toBeNull();
    expect(screen.getByTestId("news-queue-story-https://news.example.org/other")).toBeTruthy();
  });

  it("Approved keeps the visibility toggle; Rejected keeps the blast-radius note", async () => {
    const hidden = g("h", [row({ id: "h1", showOnProfile: false })]);
    const rej = g("https://news.example.org/other|sam sample", [contested.rows[0]]);
    render(
      <NewsApprovalQueue
        pending={[g(contested.key, [contested.rows[1]])]}
        approved={[hidden]}
        rejected={[rej]}
        counts={{ approved: 1, approvedHidden: 1 }}
      />,
    );
    fireEvent.click(screen.getByTestId("news-queue-tab-approved"));
    expect(screen.getByTestId("news-queue-visibility-h1").textContent).toBe("Approved, hidden");
    fireEvent.click(screen.getByRole("button", { name: /^Show / }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/edit/news-mention");

    fireEvent.click(screen.getByTestId("news-queue-tab-rejected"));
    expect(screen.getByTestId("news-queue-blast-d1").textContent).toBe(
      "Rejects 1 other candidate matched to this name.",
    );
  });
});
