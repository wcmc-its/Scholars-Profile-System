/**
 * `components/edit/news-queue.tsx` — the Pending tab's "Approve but hide" button
 * POSTs `decision: "approve_hidden"` to the decision route, on both a single
 * candidate and a contested group's candidates.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { NewsQueue } from "@/components/edit/news-queue";
import type { NewsQueueGroup, NewsQueueRow } from "@/lib/edit/news-queue";

function row(over: Partial<NewsQueueRow>): NewsQueueRow {
  return {
    id: "news-1",
    cwid: "abc1001",
    slug: "invented-person",
    scholarName: "Invented Person",
    roleLabel: null,
    roleCategory: null,
    title: null,
    department: null,
    articleTitle: "Invented Institute names a new imaging lead",
    articleUrl: "https://news.example.org/imaging-lead",
    publishedAt: null,
    outlet: null,
    detectedName: "Invented Person",
    likelihood: "HIGH",
    matchBasis: "BODY",
    contextSnippet: null,
    declinedByScholar: false,
    contextSnippetMatches: [],
    source: "NAME",
    sourceRef: "https://news.example.org/imaging-lead|invented person",
    createdAt: "2026-09-01T00:00:00.000Z",
    decidedAt: "2026-09-01T00:00:00.000Z",
    competingCwids: [],
    showOnProfile: true,
    prominence: 0,
    leadershipTier: 3,
    decidedByName: null,
    outlet: null,
    ...over,
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const COUNTS = { approved: 0, approvedHidden: 0 };

describe("NewsQueue — Approve but hide", () => {
  it("posts approve_hidden for an uncontested pending row", async () => {
    const pending: NewsQueueGroup[] = [
      { key: "k1", rows: [row({})], detectedName: "Invented Person", contested: false },
    ];
    render(<NewsQueue pending={pending} approved={[]} rejected={[]} counts={COUNTS} />);
    const btn = screen.getByTestId("news-queue-approve-hidden-news-1");
    expect(btn.textContent).toBe("Approve but hide");
    fireEvent.click(btn);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/edit/news-mention/decision");
    expect(JSON.parse(init.body as string)).toEqual({ id: "news-1", decision: "approve_hidden" });
  });

  it("offers it on every candidate of a contested group", () => {
    const pending: NewsQueueGroup[] = [
      {
        key: "k1",
        rows: [row({ id: "news-1" }), row({ id: "news-2", cwid: "def2002" })],
        detectedName: "Invented Person",
        contested: true,
      },
    ];
    const { container } = render(
      <NewsQueue pending={pending} approved={[]} rejected={[]} counts={COUNTS} />,
    );
    const scope = within(container);
    expect(scope.getByTestId("news-queue-approve-hidden-news-1")).toBeTruthy();
    expect(scope.getByTestId("news-queue-approve-hidden-news-2")).toBeTruthy();
  });
});
