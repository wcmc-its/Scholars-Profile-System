/**
 * `components/edit/edit-activity-dashboard.tsx` — the /edit/activity body
 * (2026-09 redesign): KPI tiles, the per-day chart as a feed filter, the
 * editor / category / system filters, same-minute grouping, and day headers
 * in Eastern time. All people and ids here are fake.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import {
  EditActivityDashboard,
  appendOlder,
  dayAxis,
  easternDayKey,
  groupFeed,
  niceMax,
} from "@/components/edit/edit-activity-dashboard";
import type { EditActivitySummary, RecentEdit } from "@/lib/api/edit-activity";

const edit = (over: Partial<RecentEdit>): RecentEdit => ({
  id: "r0",
  ts: "2026-09-24T18:38:00.000Z",
  actorCwid: "edt0001",
  impersonatedCwid: null,
  action: "field_override",
  entityType: "scholar",
  entityId: "sch0001",
  changes: [],
  detail: null,
  ...over,
});

function summary(over: Partial<EditActivitySummary> = {}): EditActivitySummary {
  return {
    windowDays: 30,
    generatedAt: "2026-09-24T20:00:00.000Z",
    totalEdits: 12,
    editorStats: { editors: 3, automatedEditors: 1, automatedEdits: 3 },
    entityNames: { "center:ctr_one": "Center One" },
    perDay: [
      { day: "2026-09-24", edits: 8 },
      { day: "2026-09-23", edits: 4 },
    ],
    topEditors: [
      { actorCwid: "edt0001", edits: 7 },
      { actorCwid: "system-autolock", edits: 3 },
      { actorCwid: "edt0002", edits: 2 },
    ],
    topEntities: [
      { entityType: "center", entityId: "ctr_one", edits: 5 },
      { entityType: "scholar", entityId: "sch0001", edits: 3 },
    ],
    recent: [
      edit({
        id: "a",
        changes: [{ field: "Primary title", before: null, after: "Professor of Examples" }],
      }),
      edit({
        id: "b",
        ts: "2026-09-24T15:06:00.000Z",
        actorCwid: "system-autolock",
        action: "news_mention_update",
        entityType: "news_mention",
        entityId: "n-1",
        changes: [{ field: "Status", before: "pending", after: "published" }],
      }),
      edit({
        id: "c",
        ts: "2026-09-24T15:06:10.000Z",
        actorCwid: "system-autolock",
        action: "news_mention_update",
        entityType: "news_mention",
        entityId: "n-2",
        changes: [{ field: "Status", before: "pending", after: "published" }],
      }),
      edit({
        id: "d",
        ts: "2026-09-23T14:00:00.000Z",
        actorCwid: "edt0002",
        action: "roster_change",
        entityType: "center",
        entityId: "ctr_one",
      }),
    ],
    people: {
      edt0001: { name: "Ada Editor", title: "Librarian" },
      sch0001: { name: "Sam Scholar", title: null },
    },
    nextCursor: null,
    ...over,
  };
}

describe("pure helpers", () => {
  it("easternDayKey uses Eastern time, not UTC", () => {
    // 01:30 UTC on the 25th is still the evening of the 24th in New York.
    expect(easternDayKey("2026-09-25T01:30:00.000Z")).toBe("2026-09-24");
  });
  it("dayAxis lists N days ending on the given day, oldest first", () => {
    const axis = dayAxis("2026-09-24", 30);
    expect(axis).toHaveLength(30);
    expect(axis[0]).toBe("2026-08-26");
    expect(axis[29]).toBe("2026-09-24");
  });
  it("niceMax rounds up to a readable axis top", () => {
    expect(niceMax(392)).toBe(500);
    expect(niceMax(8)).toBe(10);
    expect(niceMax(0)).toBe(1);
  });
  it("groupFeed merges same-minute identical edits; news mentions group across ids", () => {
    const g = groupFeed(summary().recent);
    expect(g.map((x) => x.members.length)).toEqual([1, 2, 1]);
  });
});

describe("EditActivityDashboard", () => {
  it("renders the KPI tiles from the summary", () => {
    render(<EditActivityDashboard summary={summary()} />);
    const kpis = screen.getByTestId("edit-activity-kpis").textContent ?? "";
    expect(kpis).toContain("12");
    expect(kpis).toContain("on 2 of 30 days");
    expect(kpis).toContain("2 people, 1 automated");
    expect(kpis).toContain("75%"); // 9 of 12 by people
    expect(kpis).toContain("Sep 24");
  });

  it("groups the feed under Eastern day headings with that day's count", () => {
    render(<EditActivityDashboard summary={summary()} />);
    const day = screen.getByTestId("edit-activity-day-2026-09-24");
    expect(day.textContent).toContain("Thu, Sep 24");
    expect(day.textContent).toContain("8 edits that day");
    expect(day.textContent).toContain("2 news mentions");
    expect(day.textContent).toContain("×2");
  });

  it("clicking a day's bar filters the feed to that day; again clears it", () => {
    render(<EditActivityDashboard summary={summary()} />);
    fireEvent.click(screen.getByTestId("edit-activity-bar-2026-09-23"));
    expect(screen.queryByTestId("edit-activity-day-2026-09-24")).toBeNull();
    expect(screen.getByTestId("edit-activity-day-2026-09-23")).toBeTruthy();
    fireEvent.click(screen.getByTestId("edit-activity-bar-2026-09-23"));
    expect(screen.getByTestId("edit-activity-day-2026-09-24")).toBeTruthy();
  });

  it("picking an editor filters the feed and shows a clearable chip", () => {
    render(<EditActivityDashboard summary={summary()} />);
    fireEvent.click(screen.getByTestId("edit-activity-editor-edt0002"));
    expect(screen.getByTestId("edit-activity-editor-chip")).toBeTruthy();
    expect(screen.queryByTestId("edit-activity-row-a")).toBeNull();
    expect(screen.getByTestId("edit-activity-row-d")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear the editor filter" }));
    expect(screen.getByTestId("edit-activity-row-a")).toBeTruthy();
  });

  it("category chips and Hide system edits narrow the feed", () => {
    render(<EditActivityDashboard summary={summary()} />);
    fireEvent.click(screen.getByTestId("edit-activity-category-news"));
    expect(screen.getByTestId("edit-activity-row-b")).toBeTruthy();
    expect(screen.queryByTestId("edit-activity-row-a")).toBeNull();
    fireEvent.click(screen.getByTestId("edit-activity-hide-system"));
    expect(screen.getByTestId("edit-activity-feed-empty").textContent).toBe(
      "No edits match these filters.",
    );
  });

  it("resolves names: editor and scholar via people, center via entityNames, links history", () => {
    render(<EditActivityDashboard summary={summary()} />);
    const entities = screen.getByTestId("edit-activity-top-entities");
    const center = within(entities).getByRole("link", { name: "Center One" });
    expect(center.getAttribute("href")).toBe("/edit/center/ctr_one/history");
    expect(within(entities).getByRole("link", { name: "Sam Scholar" })).toBeTruthy();
    const editors = screen.getByTestId("edit-activity-top-editors");
    expect(editors.textContent).toContain("Ada Editor");
    expect(editors.textContent).toContain("System");
  });

  it("marks an empty 'before' as empty and keeps the after value", () => {
    render(<EditActivityDashboard summary={summary()} />);
    const row = screen.getByTestId("edit-activity-row-a");
    expect(row.textContent).toContain("Primary title");
    expect(row.textContent).toContain("empty");
    expect(row.textContent).toContain("Professor of Examples");
  });
});

describe("Load older", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** One older page: row "e" repeats row "d" in the same minute (so the group
   *  must merge across the page boundary), "f" is a new, older day by another
   *  editor, and "d" itself is repeated (a retried page) to prove dedupe. */
  const olderPage = (nextCursor: string | null) => ({
    ok: true,
    recent: [
      edit({
        id: "d",
        ts: "2026-09-23T14:00:00.000Z",
        actorCwid: "edt0002",
        action: "roster_change",
        entityType: "center",
        entityId: "ctr_one",
      }),
      edit({
        id: "e",
        ts: "2026-09-23T14:00:00.000Z",
        actorCwid: "edt0002",
        action: "roster_change",
        entityType: "center",
        entityId: "ctr_one",
      }),
      edit({
        id: "f",
        ts: "2026-09-22T16:00:00.000Z",
        actorCwid: "edt0003",
        entityId: "sch0009",
        changes: [{ field: "Overview", before: "old text", after: "new text" }],
      }),
    ],
    nextCursor,
    people: { edt0003: { name: "Olga Older", title: null } },
    entityNames: {},
  });

  const stubFetch = (...responses: Array<{ status: number; body: unknown }>) => {
    const fn = vi.fn();
    for (const r of responses) {
      fn.mockResolvedValueOnce({
        ok: r.status === 200,
        status: r.status,
        json: async () => r.body,
      });
    }
    vi.stubGlobal("fetch", fn);
    return fn;
  };

  it("appendOlder keeps order and drops ids already loaded", () => {
    const merged = appendOlder(
      [edit({ id: "a" }), edit({ id: "b" })],
      [edit({ id: "b" }), edit({ id: "c" }), edit({ id: "c" })],
    );
    expect(merged.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("shows no Load older control when the summary has no cursor", () => {
    render(<EditActivityDashboard summary={summary()} />);
    expect(screen.queryByTestId("edit-activity-load-older")).toBeNull();
  });

  it("appends the older page: merges a same-minute group across the boundary, adds a day, keeps filters", async () => {
    const fetchMock = stubFetch({ status: 200, body: olderPage(null) });
    render(
      <EditActivityDashboard
        summary={summary({ totalEdits: 40, nextCursor: "2026-09-23T14:00:00.000Z_4" })}
      />,
    );
    expect(screen.getByTestId("edit-activity-feed-footer").textContent).toContain(
      "The feed holds the latest 4",
    );

    // Filter to editor edt0002 first; the filter must still apply after loading.
    fireEvent.click(screen.getByTestId("edit-activity-editor-edt0002"));
    fireEvent.click(screen.getByTestId("edit-activity-load-older"));

    await vi.waitFor(() =>
      expect(screen.getByTestId("edit-activity-row-d").textContent).toContain("×2"),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "/api/edit/activity/recent?cursor=2026-09-23T14%3A00%3A00.000Z_4",
    );
    // Row "d" absorbed "e" (same minute, same edit): no separate "e" row.
    expect(screen.queryByTestId("edit-activity-row-e")).toBeNull();
    // The older-day row is hidden by the editor filter...
    expect(screen.queryByTestId("edit-activity-row-f")).toBeNull();
    // ...and appears under its own day heading, with its fetched name, once cleared.
    fireEvent.click(screen.getByRole("button", { name: "Clear the editor filter" }));
    const day = screen.getByTestId("edit-activity-day-2026-09-22");
    expect(day.textContent).toContain("Tue, Sep 22");
    expect(within(day).getByTestId("edit-activity-row-f").textContent).toContain("Olga Older");
    // 4 + 2 new ids (the repeated "d" is dropped); no cursor left, so no button.
    expect(screen.getByTestId("edit-activity-feed-footer").textContent).toContain(
      "The feed holds the latest 6",
    );
    expect(screen.queryByTestId("edit-activity-load-older")).toBeNull();
  });

  it("keeps the button, with the next cursor, while more pages remain", async () => {
    const fetchMock = stubFetch(
      { status: 200, body: olderPage("2026-09-22T16:00:00.000Z_2") },
      {
        status: 200,
        body: { ok: true, recent: [], nextCursor: null, people: {}, entityNames: {} },
      },
    );
    render(<EditActivityDashboard summary={summary({ totalEdits: 40, nextCursor: "c1_4" })} />);
    fireEvent.click(screen.getByTestId("edit-activity-load-older"));
    await screen.findByTestId("edit-activity-row-f");
    fireEvent.click(screen.getByTestId("edit-activity-load-older"));
    await vi.waitFor(() => expect(screen.queryByTestId("edit-activity-load-older")).toBeNull());
    expect(String(fetchMock.mock.calls[1]![0])).toContain("cursor=2026-09-22T16%3A00%3A00.000Z_2");
  });

  it("a failed page shows an error and offers Try again without dropping rows", async () => {
    stubFetch(
      { status: 503, body: { ok: false, error: "activity_unavailable" } },
      { status: 200, body: olderPage(null) },
    );
    render(<EditActivityDashboard summary={summary({ totalEdits: 40, nextCursor: "c1_4" })} />);
    fireEvent.click(screen.getByTestId("edit-activity-load-older"));
    expect(await screen.findByTestId("edit-activity-load-older-error")).toBeTruthy();
    expect(screen.getByTestId("edit-activity-load-older").textContent).toBe("Try again");
    expect(screen.getByTestId("edit-activity-row-a")).toBeTruthy();
    fireEvent.click(screen.getByTestId("edit-activity-load-older"));
    expect(await screen.findByTestId("edit-activity-row-f")).toBeTruthy();
    expect(screen.queryByTestId("edit-activity-load-older-error")).toBeNull();
  });

  it("an empty filtered feed points at Load older while older pages exist", () => {
    render(<EditActivityDashboard summary={summary({ totalEdits: 40, nextCursor: "c1_4" })} />);
    fireEvent.click(screen.getByTestId("edit-activity-category-access"));
    expect(screen.getByTestId("edit-activity-feed-empty").textContent).toBe(
      "No loaded edits match these filters. Load older edits to look further back.",
    );
  });
});
