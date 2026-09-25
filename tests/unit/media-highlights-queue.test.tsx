/**
 * `components/edit/media-highlights-queue.tsx` — the redesigned Media highlights
 * review surface: tab counts, the filter rail, the search, per-card and bulk
 * decisions, the keyboard shortcuts, the contested-group guard, the mockup's
 * slate / amber certainty pills, Undo in the status bar, and "Wrong person?
 * Reassign". All people are invented.
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
      expect(screen.getByTestId("mh-queue-toast").textContent).toContain("Approved 2 clips."),
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

  it("colours the certainty pill slate for High and amber otherwise, per the mockup", () => {
    renderQueue();
    expect(screen.getByTestId("mh-queue-likelihood-HIGH").className).toContain(
      "bg-apollo-slate-tint",
    );
    expect(screen.getByTestId("mh-queue-likelihood-MEDIUM").className).toContain(
      "bg-apollo-amber-tint",
    );
    expect(screen.getByTestId("mh-queue-likelihood-HIGH").className).not.toContain("green");
  });

  describe("Undo in the status bar", () => {
    function routeFetch() {
      let n = 0;
      fetchMock.mockImplementation(async (url: string) => {
        if (url === "/api/edit/news-mention/undo") {
          return new Response(JSON.stringify({ ok: true, restored: 2 }), { status: 200 });
        }
        n += 1;
        return new Response(JSON.stringify({ ok: true, decisionId: `dec-${n}` }), { status: 200 });
      });
    }
    const undoBody = () => {
      const call = fetchMock.mock.calls.find((c) => c[0] === "/api/edit/news-mention/undo")!;
      return JSON.parse((call[1] as RequestInit).body as string);
    };

    it("takes back a card decision", async () => {
      routeFetch();
      renderQueue();
      fireEvent.click(screen.getByTestId("mh-queue-approve-hidden-clip-1"));
      fireEvent.click(await screen.findByTestId("mh-queue-toast-undo"));
      await waitFor(() =>
        expect(screen.getByTestId("mh-queue-toast").textContent).toContain("Undone"),
      );
      expect(undoBody()).toEqual({ decisionIds: ["dec-1"] });
    });

    it("takes back a whole bulk action at once", async () => {
      routeFetch();
      renderQueue();
      fireEvent.click(screen.getByTestId("mh-queue-select-all"));
      fireEvent.click(within(screen.getByTestId("mh-queue-bulk-bar")).getByText("Reject"));
      fireEvent.click(await screen.findByTestId("mh-queue-toast-undo"));
      await waitFor(() => expect(undoBody().decisionIds).toHaveLength(2));
      expect([...undoBody().decisionIds].sort()).toEqual(["dec-1", "dec-2"]);
    });
  });

  describe("Wrong person? Reassign", () => {
    function directory(hasProfile: boolean) {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.startsWith("/api/directory/people")) {
          return new Response(
            JSON.stringify({
              ok: true,
              people: [{ cwid: "zzz9009", name: "Quinn Fictional", title: null, dept: null }],
            }),
            { status: 200 },
          );
        }
        if (url.startsWith("/api/edit/scholar-card/")) {
          return hasProfile
            ? new Response(JSON.stringify({ cwid: "zzz9009", name: "Quinn Fictional" }), {
                status: 200,
              })
            : new Response("Not found", { status: 404 });
        }
        return new Response(JSON.stringify({ ok: true, decisionId: "dec-1" }), { status: 200 });
      });
    }
    async function pickQuinn() {
      fireEvent.click(screen.getByTestId("mh-queue-reassign-clip-1-open"));
      fireEvent.change(screen.getByTestId("mh-queue-reassign-clip-1-input"), {
        target: { value: "Quinn" },
      });
      fireEvent.mouseDown(await screen.findByTestId("mh-queue-reassign-clip-1-option-zzz9009"));
    }
    const decisionBodies = () =>
      fetchMock.mock.calls
        .filter((c) => c[0] === "/api/edit/news-mention/decision")
        .map((c) => JSON.parse((c[1] as RequestInit).body as string));

    it("stages the picked scholar and Approve credits them", async () => {
      directory(true);
      renderQueue();
      await pickQuinn();
      const staged = await screen.findByTestId("mh-queue-override");
      expect(staged.textContent).toContain("Quinn Fictional");
      const card = screen.getByTestId("mh-queue-card-clip-1");
      expect(within(card).getByText("Reassigned from Invented Person")).toBeTruthy();
      fireEvent.click(screen.getByTestId("mh-queue-approve-clip-1"));
      await waitFor(() => expect(decisionBodies()).toHaveLength(1));
      expect(decisionBodies()[0]).toEqual({ id: "clip-1", decision: "approve", cwid: "zzz9009" });
      expect((await screen.findByTestId("mh-queue-toast")).textContent).toContain(
        "for Quinn Fictional, reassigned from Invented Person",
      );
    });

    it("the A shortcut honours a staged reassign", async () => {
      directory(true);
      renderQueue();
      await pickQuinn();
      await screen.findByTestId("mh-queue-override");
      fireEvent.click(screen.getByTestId("mh-queue-card-clip-1"));
      fireEvent.keyDown(window, { key: "a" });
      await waitFor(() => expect(decisionBodies()).toHaveLength(1));
      expect(decisionBodies()[0]).toMatchObject({ cwid: "zzz9009" });
    });

    it("Revert drops the staged scholar", async () => {
      directory(true);
      renderQueue();
      await pickQuinn();
      await screen.findByTestId("mh-queue-override");
      fireEvent.click(screen.getByTestId("mh-queue-reassign-clip-1-revert"));
      expect(screen.queryByTestId("mh-queue-override")).toBeNull();
      fireEvent.click(screen.getByTestId("mh-queue-approve-clip-1"));
      await waitFor(() => expect(decisionBodies()).toHaveLength(1));
      expect(decisionBodies()[0]).toEqual({ id: "clip-1", decision: "approve" });
    });

    it("refuses a directory person with no scholar profile", async () => {
      directory(false);
      renderQueue();
      await pickQuinn();
      expect((await screen.findByRole("alert")).textContent).toContain("has no scholar profile");
      expect(screen.queryByTestId("mh-queue-override")).toBeNull();
    });
  });
});
