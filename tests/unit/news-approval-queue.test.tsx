/**
 * `components/edit/news-approval-queue.tsx` — the `/edit/news-queue` redesign.
 * Pins: one card per story; "Approve all" approves each waiting mention; a
 * contested name blocks Approve / Hide until a scholar is picked, then posts the
 * picked row; Hide posts `approve_hidden`; the filter rail and search narrow the
 * list; the contested banner's "Show only these"; the status bar's Undo; and the
 * "Wrong person? Enter CWID" override. All people are invented.
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

  describe("Undo in the status bar", () => {
    /** The decision route answers with a decision id per call; undo answers ok. */
    function routeFetch(undoStatus = 200, undoError?: string) {
      let n = 0;
      fetchMock.mockImplementation(async (url: string) => {
        if (url === "/api/edit/news-mention/undo") {
          return new Response(
            JSON.stringify(undoError ? { ok: false, error: undoError } : { ok: true, restored: 1 }),
            { status: undoStatus },
          );
        }
        n += 1;
        return new Response(JSON.stringify({ ok: true, decisionId: `dec-${n}` }), { status: 200 });
      });
    }

    it("sends every decision id the last click made, then says so", async () => {
      routeFetch();
      render(
        <NewsApprovalQueue pending={[lab1, lab2]} approved={[]} rejected={[]} counts={COUNTS} />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Approve all" }));
      const undo = await screen.findByTestId("news-queue-toast-undo");
      refresh.mockClear();
      fireEvent.click(undo);
      await waitFor(() =>
        expect(screen.getByTestId("news-queue-toast").textContent).toContain("Undone"),
      );
      const undoCall = fetchMock.mock.calls.find((c) => c[0] === "/api/edit/news-mention/undo")!;
      expect(JSON.parse((undoCall[1] as RequestInit).body as string)).toEqual({
        decisionIds: ["dec-1", "dec-2"],
      });
      expect(refresh).toHaveBeenCalled();
      // Once undone there is nothing left to take back.
      expect(screen.queryByTestId("news-queue-toast-undo")).toBeNull();
    });

    it("explains a refused undo", async () => {
      routeFetch(409, "undo_expired");
      render(<NewsApprovalQueue pending={[lab1]} approved={[]} rejected={[]} counts={COUNTS} />);
      fireEvent.click(screen.getByTestId("news-queue-approve-a"));
      fireEvent.click(await screen.findByTestId("news-queue-toast-undo"));
      expect((await screen.findByRole("alert")).textContent).toContain("too late to undo");
    });

    it("offers no Undo when the route returned no decision id", async () => {
      render(<NewsApprovalQueue pending={[lab1]} approved={[]} rejected={[]} counts={COUNTS} />);
      fireEvent.click(screen.getByTestId("news-queue-approve-a"));
      await screen.findByTestId("news-queue-toast");
      expect(screen.queryByTestId("news-queue-toast-undo")).toBeNull();
    });
  });

  describe("Wrong person? Enter CWID", () => {
    function directory(found: boolean) {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.startsWith("/api/edit/scholar-card/")) {
          return found
            ? new Response(JSON.stringify({ cwid: "zzz9009", name: "Quinn Fictional" }), {
                status: 200,
              })
            : new Response("Not found", { status: 404 });
        }
        return new Response(JSON.stringify({ ok: true, decisionId: "dec-1" }), { status: 200 });
      });
    }

    it("checks the CWID, shows the override, and approves for that scholar", async () => {
      directory(true);
      render(<NewsApprovalQueue pending={[lab1]} approved={[]} rejected={[]} counts={COUNTS} />);
      fireEvent.click(screen.getByTestId("news-queue-override-a-open"));
      fireEvent.change(screen.getByTestId("news-queue-override-a-input"), {
        target: { value: " ZZZ9009 " },
      });
      fireEvent.click(screen.getByTestId("news-queue-override-a-apply"));
      const pill = await screen.findByTestId("news-override-pill");
      expect(pill.textContent).toBe("Override · was zzz1001");
      expect(fetchMock.mock.calls[0][0]).toBe("/api/edit/scholar-card/zzz9009");
      const mention = screen.getByTestId("news-queue-group-a");
      expect(within(mention).getByText("Quinn Fictional")).toBeTruthy();

      fireEvent.click(screen.getByTestId("news-queue-approve-a"));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)).toEqual({
        id: "a1",
        decision: "approve",
        cwid: "zzz9009",
      });
      expect((await screen.findByTestId("news-queue-toast")).textContent).toContain(
        "for Quinn Fictional, not Ivy Invented",
      );
    });

    it("refuses a CWID the directory does not know, and stages nothing", async () => {
      directory(false);
      render(<NewsApprovalQueue pending={[lab1]} approved={[]} rejected={[]} counts={COUNTS} />);
      fireEvent.click(screen.getByTestId("news-queue-override-a-open"));
      fireEvent.change(screen.getByTestId("news-queue-override-a-input"), {
        target: { value: "zzz9009" },
      });
      fireEvent.click(screen.getByTestId("news-queue-override-a-apply"));
      expect((await screen.findByRole("alert")).textContent).toContain(
        "No scholar with CWID zzz9009",
      );
      expect(screen.queryByTestId("news-override-pill")).toBeNull();
    });

    it("a malformed CWID cannot be applied", () => {
      render(<NewsApprovalQueue pending={[lab1]} approved={[]} rejected={[]} counts={COUNTS} />);
      fireEvent.click(screen.getByTestId("news-queue-override-a-open"));
      fireEvent.change(screen.getByTestId("news-queue-override-a-input"), {
        target: { value: "1 bad" },
      });
      expect(
        (screen.getByTestId("news-queue-override-a-apply") as HTMLButtonElement).disabled,
      ).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("on a contested name, the override unblocks Approve without a pick", async () => {
      directory(true);
      render(
        <NewsApprovalQueue pending={[contested]} approved={[]} rejected={[]} counts={COUNTS} />,
      );
      const key = contested.key;
      fireEvent.click(screen.getByTestId(`news-queue-override-${key}-open`));
      fireEvent.change(screen.getByTestId(`news-queue-override-${key}-input`), {
        target: { value: "zzz9009" },
      });
      fireEvent.click(screen.getByTestId(`news-queue-override-${key}-apply`));
      await screen.findByTestId("news-override-pill");
      // The candidate radios go away: none of them is the person.
      expect(screen.queryByTestId(`news-queue-contested-${key}`)).toBeNull();
      const approve = screen.getByTestId(`news-queue-approve-${key}`) as HTMLButtonElement;
      expect(approve.disabled).toBe(false);
      fireEvent.click(approve);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)).toEqual({
        id: "d1",
        decision: "approve",
        cwid: "zzz9009",
      });
    });

    it("Approve all clears the staged override of the group it decided (keyed by group, not story)", async () => {
      directory(true);
      render(
        <NewsApprovalQueue pending={[lab1, lab2]} approved={[]} rejected={[]} counts={COUNTS} />,
      );
      fireEvent.click(screen.getByTestId("news-queue-override-a-open"));
      fireEvent.change(screen.getByTestId("news-queue-override-a-input"), {
        target: { value: "zzz9009" },
      });
      fireEvent.click(screen.getByTestId("news-queue-override-a-apply"));
      await screen.findByTestId("news-override-pill");
      fireEvent.click(screen.getByRole("button", { name: "Approve all" }));
      await screen.findByTestId("news-queue-toast");
      // The refresh is mocked, so the decided group still renders: a stale
      // override would still show its pill (and re-send its cwid next time).
      await waitFor(() => expect(screen.queryByTestId("news-override-pill")).toBeNull());
    });

    it("a failed Approve all step keeps that group's override", async () => {
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.startsWith("/api/edit/scholar-card/")) {
          return new Response(JSON.stringify({ cwid: "zzz9009", name: "Quinn Fictional" }), {
            status: 200,
          });
        }
        const body = JSON.parse(init!.body as string) as { id: string };
        return body.id === "b1"
          ? new Response(JSON.stringify({ ok: false, error: "write_failed" }), { status: 500 })
          : new Response(JSON.stringify({ ok: true, decisionId: "dec-1" }), { status: 200 });
      });
      render(
        <NewsApprovalQueue pending={[lab1, lab2]} approved={[]} rejected={[]} counts={COUNTS} />,
      );
      fireEvent.click(screen.getByTestId("news-queue-override-b-open"));
      fireEvent.change(screen.getByTestId("news-queue-override-b-input"), {
        target: { value: "zzz9009" },
      });
      fireEvent.click(screen.getByTestId("news-queue-override-b-apply"));
      await screen.findByTestId("news-override-pill");
      fireEvent.click(screen.getByRole("button", { name: "Approve all" }));
      await screen.findByRole("alert");
      // a1 saved first, b1 failed: b's override is still staged for a retry.
      expect(screen.getByTestId("news-queue-toast").textContent).toContain("Saved 1 of 2");
      expect(screen.getByTestId("news-override-pill")).toBeTruthy();
    });
  });
});
