/**
 * `components/edit/honors-queue.tsx` — the 2026-09 redesign. Pins the behaviour
 * the new layout carries: Possible is the default tab; a contested line's single
 * Approve stays disabled until a candidate is picked, then POSTs that candidate;
 * a decided card stays in place with its outcome; the read-only tabs group by
 * scholar / award / none and filter by the search box. All names are invented.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { buildListSections, HonorsQueue, rosterSourceUrl } from "@/components/edit/honors-queue";
import type {
  HonorListRunView,
  HonorListStatus,
  HonorQueueGroup,
  HonorQueueRow,
  HonorSourcesSummary,
} from "@/lib/edit/honor-queue";

function row(over: Partial<HonorQueueRow>): HonorQueueRow {
  return {
    id: "h1",
    cwid: "zzz1001",
    slug: null,
    scholarName: "Ada Example",
    roleLabel: "Full-time faculty",
    roleCategory: "full_time_faculty",
    title: "Professor of Testing",
    department: "Testing",
    category: "ACADEMY_MEMBERSHIP",
    name: "Member",
    organization: "Invented Academy",
    year: 2024,
    prestige: 0,
    source: "SEED",
    sourceRef: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    decidedAt: "2026-01-01T00:00:00.000Z",
    decidedByName: null,
    rejectionReason: null,
    superseded: false,
    competingCwids: [],
    evidence: null,
    ...over,
  };
}

function grp(
  key: string,
  rows: HonorQueueRow[],
  rosterMatchedName: string | null = null,
): HonorQueueGroup {
  return { key, rows, rosterMatchedName, contested: new Set(rows.map((r) => r.cwid)).size > 1 };
}

const NO_SOURCES: HonorSourcesSummary = { sources: [], runs: [], lists: [] };

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

const contested = grp(
  "roster|B. Sample|2023",
  [
    row({
      id: "c1",
      cwid: "zzz2001",
      scholarName: "Bo Sample",
      name: "Investigator",
      organization: "Invented Institute",
    }),
    row({
      id: "c2",
      cwid: "zzz2002",
      scholarName: "Bea Sample",
      name: "Investigator",
      organization: "Invented Institute",
    }),
  ],
  "B. Sample",
);
const single = grp("single", [row({ id: "s1" })], "Ada Example");

describe("HonorsQueue redesign — Possible", () => {
  it("opens on Possible with an amber count and the tab note", () => {
    const { container } = render(
      <HonorsQueue
        pending={[single, contested]}
        approved={[]}
        rejected={[]}
        userAsserted={[]}
        sources={NO_SOURCES}
      />,
    );
    const tab = screen.getByRole("tab", { name: /Possible/ });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(within(tab).getByText("3").className).toContain("bg-apollo-amber-tint");
    expect(container.querySelector('[data-slot="honors-tab-note"]')?.textContent).toBe(
      "3 honors awaiting a decision, including 1 where more than one person matches the same award.",
    );
    expect(screen.getByText("Listed as “B. Sample”")).toBeTruthy();
  });

  it("contested: Approve is blocked until a pick, then approves the picked candidate", async () => {
    const { container } = render(
      <HonorsQueue
        pending={[contested]}
        approved={[]}
        rejected={[]}
        userAsserted={[]}
        sources={NO_SOURCES}
      />,
    );
    const card = container.querySelector('[data-slot="honor-group-contested"]') as HTMLElement;
    const blocked = within(card).getByRole("button", {
      name: "Pick a scholar to approve",
    }) as HTMLButtonElement;
    expect(blocked.disabled).toBe(true);
    expect(within(card).getByRole("button", { name: "None of these" })).toBeTruthy();

    fireEvent.click(within(card).getByRole("radio", { name: "Bea Sample" }));
    fireEvent.click(within(card).getByRole("button", { name: "Approve for Bea Sample" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ id: "c2", decision: "approve" });
    await waitFor(() => expect(within(card).getByText("Approved for Bea Sample")).toBeTruthy());
    // The card stays; its actions go away; the Possible count drops.
    expect(within(card).queryByRole("button", { name: /Approve/ })).toBeNull();
    expect(within(screen.getByRole("tab", { name: /Possible/ })).getByText("0")).toBeTruthy();
    expect(refresh).toHaveBeenCalled();
  });

  it("single: Reject posts a reject and marks the card Rejected", async () => {
    const { container } = render(
      <HonorsQueue
        pending={[single]}
        approved={[]}
        rejected={[]}
        userAsserted={[]}
        sources={NO_SOURCES}
      />,
    );
    const card = container.querySelector('[data-slot="honor-group"]') as HTMLElement;
    expect(within(card).getByRole("button", { name: "Approve for Ada Example" })).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(within(card).getByText("Rejected")).toBeTruthy());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ id: "s1", decision: "reject" });
  });
});

describe("HonorsQueue redesign — read-only tabs", () => {
  const known = [
    grp("k1", [
      row({
        id: "k1",
        cwid: "zzz3001",
        scholarName: "Cy Zed",
        name: "Fellow",
        organization: "Made-up Society",
      }),
    ]),
    grp("k2", [
      row({
        id: "k2",
        cwid: "zzz3002",
        scholarName: "Di Alpha, MD",
        name: "Member",
        organization: "Invented Academy",
      }),
    ]),
    grp("k3", [
      row({
        id: "k3",
        cwid: "zzz3002",
        scholarName: "Di Alpha, MD",
        name: "Fellow",
        organization: "Made-up Society",
      }),
    ]),
  ];

  it("Known groups by scholar by default, A–Z by surname, and search narrows it", () => {
    const { container } = render(
      <HonorsQueue
        pending={[]}
        approved={known}
        rejected={[]}
        userAsserted={[]}
        sources={NO_SOURCES}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /Known/ }));
    const headings = [...container.querySelectorAll('[data-slot="honor-list-heading"]')].map(
      (h) => h.textContent,
    );
    expect(headings).toEqual(["Di Alpha, MD", "Cy Zed"]);
    expect(container.querySelector('[data-slot="honors-list-footer"]')?.textContent).toBe(
      "Showing 3 of 3 honors.",
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "Search honors" }), {
      target: { value: "invented" },
    });
    expect(
      [...container.querySelectorAll('[data-slot="honor-list-heading"]')].map((h) => h.textContent),
    ).toEqual(["Di Alpha, MD"]);
  });

  it("Award grouping puts the biggest honor first", () => {
    const { container } = render(
      <HonorsQueue
        pending={[]}
        approved={known}
        rejected={[]}
        userAsserted={[]}
        sources={NO_SOURCES}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /Known/ }));
    fireEvent.click(screen.getByRole("button", { name: "Award" }));
    const headings = [...container.querySelectorAll('[data-slot="honor-list-heading"]')].map(
      (h) => h.textContent,
    );
    expect(headings).toEqual(["Fellow", "Member"]);
  });
});

describe("buildListSections", () => {
  const rows = [
    row({ id: "a", cwid: "zzz1", scholarName: "Eve Young", decidedAt: "2026-01-01T00:00:00.000Z" }),
    row({ id: "b", cwid: "zzz2", scholarName: "Al Brown", decidedAt: "2026-03-01T00:00:00.000Z" }),
    row({
      id: "c",
      cwid: "zzz1",
      scholarName: "Eve Young",
      name: "Fellow",
      decidedAt: "2026-02-01T00:00:00.000Z",
    }),
  ];
  it("none → one unheaded section, newest decision first", () => {
    const secs = buildListSections(rows, "none");
    expect(secs).toHaveLength(1);
    expect(secs[0].label).toBeNull();
    expect(secs[0].rows.map((r) => r.id)).toEqual(["b", "c", "a"]);
  });
  it("scholar → one section per cwid, with an honor count", () => {
    const secs = buildListSections(rows, "scholar");
    expect(secs.map((s) => [s.label, s.sub])).toEqual([
      ["Al Brown", "1 honor"],
      ["Eve Young", "2 honors"],
    ]);
  });
  it("award → keyed on honor + organization", () => {
    const secs = buildListSections(rows, "award");
    expect(secs.map((s) => s.sub)).toEqual([
      "Invented Academy · 2 scholars",
      "Invented Academy · 1 scholar",
    ]);
  });
});

describe("rosterSourceUrl", () => {
  it("links only an http(s) roster segment", () => {
    expect(rosterSourceUrl("https://example.org/roster|A. Person|2020")).toBe(
      "https://example.org/roster",
    );
    expect(rosterSourceUrl("asci|A. Person|2020")).toBeNull();
    expect(rosterSourceUrl(null)).toBeNull();
  });
});

describe("HonorsQueue: undo, reasons, decided-by", () => {
  beforeEach(() => {
    // A fresh Response per call: a body can be read once, and these tests POST twice.
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
  });

  it("approve shows a toast; its Undo posts undo for the approved row and reopens the card", async () => {
    const { container } = render(
      <HonorsQueue
        pending={[contested]}
        approved={[]}
        rejected={[]}
        userAsserted={[]}
        sources={NO_SOURCES}
      />,
    );
    const card = container.querySelector('[data-slot="honor-group-contested"]') as HTMLElement;
    fireEvent.click(within(card).getByRole("radio", { name: "Bea Sample" }));
    fireEvent.click(within(card).getByRole("button", { name: "Approve for Bea Sample" }));
    const toast = await waitFor(() => {
      const t = container.querySelector('[data-slot="honors-toast"]') as HTMLElement | null;
      expect(t).not.toBeNull();
      return t as HTMLElement;
    });
    expect(toast.textContent).toContain(
      "Approved Investigator, Invented Institute for Bea Sample.",
    );

    fireEvent.click(within(toast).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ id: "c2", decision: "undo" });
    await waitFor(() => expect(container.querySelector('[data-slot="honors-toast"]')).toBeNull());
    // The line is open again: pick-then-approve, and the count is back.
    expect(within(card).getByRole("button", { name: /Approve/ })).toBeTruthy();
    expect(within(card).queryByText("Approved for Bea Sample")).toBeNull();
    expect(within(screen.getByRole("tab", { name: /Possible/ })).getByText("2")).toBeTruthy();
  });

  it("None of these sends the picked reason with every reject; the card's Undo reverts each", async () => {
    const { container } = render(
      <HonorsQueue
        pending={[contested]}
        approved={[]}
        rejected={[]}
        userAsserted={[]}
        sources={NO_SOURCES}
      />,
    );
    const card = container.querySelector('[data-slot="honor-group-contested"]') as HTMLElement;
    fireEvent.change(within(card).getByRole("combobox", { name: "Rejection reason (optional)" }), {
      target: { value: "Name collision" },
    });
    fireEvent.click(within(card).getByRole("button", { name: "None of these" }));
    await waitFor(() => expect(within(card).getByText("Rejected")).toBeTruthy());
    expect(fetchMock.mock.calls.map((c) => JSON.parse(c[1].body))).toEqual([
      { id: "c1", decision: "reject", reason: "Name collision" },
      { id: "c2", decision: "reject", reason: "Name collision" },
    ]);

    fireEvent.click(within(card).getByRole("button", { name: "Undo" }));
    // ONE all-or-nothing request for every rejected candidate, not one per row.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({
      ids: ["c1", "c2"],
      decision: "undo",
    });
    await waitFor(() => expect(within(card).queryByText("Rejected")).toBeNull());
  });

  it("a failed multi-row undo leaves the None of these card whole and still undoable", async () => {
    // Regression: the per-row loop used to break on the first failure, leaving
    // some candidates reopened server-side while the card still read "Rejected".
    const { container } = render(
      <HonorsQueue
        pending={[contested]}
        approved={[]}
        rejected={[]}
        userAsserted={[]}
        sources={NO_SOURCES}
      />,
    );
    const card = container.querySelector('[data-slot="honor-group-contested"]') as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "None of these" }));
    await waitFor(() => expect(within(card).getByText("Rejected")).toBeTruthy());
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ ok: false, error: "line_already_awarded" }), {
          status: 409,
        }),
    );
    fireEvent.click(within(card).getByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/has since been approved/),
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(within(card).getByText("Rejected")).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Undo" })).toBeTruthy();
  });

  it("a failed undo keeps the decision and says so", async () => {
    const { container } = render(
      <HonorsQueue
        pending={[single]}
        approved={[]}
        rejected={[]}
        userAsserted={[]}
        sources={NO_SOURCES}
      />,
    );
    const card = container.querySelector('[data-slot="honor-group"]') as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(within(card).getByText("Rejected")).toBeTruthy());
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ ok: false, error: "not_undoable" }), { status: 409 }),
    );
    fireEvent.click(within(card).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/can't be undone/));
    expect(within(card).getByText("Rejected")).toBeTruthy();
  });

  it("Rejected shows the Reason column with the date and curator under it", () => {
    const { container } = render(
      <HonorsQueue
        pending={[]}
        approved={[]}
        rejected={[
          grp("r1", [
            row({
              id: "r1",
              rejectionReason: "Different person",
              decidedByName: "Cora Curator",
              decidedAt: "2026-09-15T12:00:00.000Z",
            }),
          ]),
          grp("r2", [row({ id: "r2", cwid: "zzz1002", scholarName: "Bo Example" })]),
        ]}
        userAsserted={[]}
        sources={NO_SOURCES}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /Rejected/ }));
    const table = container.querySelector('[data-slot="honors-rejected-table"]') as HTMLElement;
    expect(within(table).getByText("Reason")).toBeTruthy();
    expect(within(table).getByText("Different person")).toBeTruthy();
    const by = [...table.querySelectorAll('[data-slot="honor-decided-by"]')].map(
      (e) => e.textContent,
    );
    expect(by).toContain("Sep 15, 2026 by Cora Curator");
    // No reason recorded ⇒ an em dash, never a blank cell.
    expect(within(table).getByText("—", { selector: "span:not([data-slot])" })).toBeTruthy();
  });

  it("Known's Added reads 'date by curator' when a decider is recorded", () => {
    const { container } = render(
      <HonorsQueue
        pending={[]}
        approved={[
          grp("k1", [
            row({
              id: "k1",
              decidedByName: "Cora Curator",
              decidedAt: "2026-09-15T12:00:00.000Z",
            }),
          ]),
        ]}
        rejected={[]}
        userAsserted={[]}
        sources={NO_SOURCES}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /Known/ }));
    const table = container.querySelector('[data-slot="honors-approved-table"]') as HTMLElement;
    expect(within(table).getByText("Sep 15, 2026 by Cora Curator")).toBeTruthy();
  });
});

describe("HonorsQueue: Sources tab", () => {
  const summary: HonorSourcesSummary = {
    sources: [
      {
        key: "https://example.org/members",
        name: "Member",
        organization: "Invented Academy",
        url: "https://example.org/members",
        host: "example.org",
        lines: 12,
        pendingLines: 3,
        approved: 8,
        rejected: 1,
      },
      {
        key: "invented-list",
        name: "Fellow",
        organization: "Made-up Society",
        url: null,
        host: null,
        lines: 4,
        pendingLines: 0,
        approved: 4,
        rejected: 0,
      },
    ],
    runs: [
      {
        source: "HonorsSeed-Import",
        startedAt: "2026-09-01T15:00:00.000Z",
        completedAt: null,
        status: "failed",
        rowsProcessed: 0,
        errorMessage: "invented failure",
      },
      {
        source: "HonorsSeed-Import",
        startedAt: "2026-08-01T15:00:00.000Z",
        completedAt: "2026-08-01T15:01:00.000Z",
        status: "success",
        rowsProcessed: 250,
        errorMessage: null,
      },
    ],
    lists: [],
  };

  it("lists each roster read-only, with the last load and its error, and no Run now", () => {
    const { container } = render(
      <HonorsQueue
        pending={[single]}
        approved={[]}
        rejected={[]}
        userAsserted={[]}
        sources={summary}
      />,
    );
    const tab = screen.getByRole("tab", { name: /Sources/ });
    expect(within(tab).getByText("2")).toBeTruthy();
    fireEvent.click(tab);
    const panel = container.querySelector('[data-slot="honors-sources"]') as HTMLElement;
    expect(panel.querySelectorAll('[data-slot="honors-source"]')).toHaveLength(2);
    const link = within(panel).getByRole("link", { name: "example.org" });
    expect(link.getAttribute("href")).toBe("https://example.org/members");
    expect(panel.querySelector('[data-slot="honors-sources-last-run"]')?.textContent).toMatch(
      /Last full load Sep 1, 2026.*Failed/,
    );
    expect(panel.querySelector('[data-slot="honors-sources-error"]')?.textContent).toBe(
      "invented failure",
    );
    expect(panel.querySelector('[data-slot="honors-sources-runs"]')).not.toBeNull();
    expect(within(panel).queryByRole("button", { name: /Run now/ })).toBeNull();
    // The Possible-only toolbar is gone here.
    expect(container.querySelector('[data-slot="honors-person-filter"]')).toBeNull();
  });

  it("an empty summary says no load is recorded", () => {
    const { container } = render(
      <HonorsQueue
        pending={[]}
        approved={[]}
        rejected={[]}
        userAsserted={[]}
        sources={NO_SOURCES}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /Sources/ }));
    const panel = container.querySelector('[data-slot="honors-sources"]') as HTMLElement;
    expect(panel.textContent).toContain("No full load recorded yet");
    expect(panel.textContent).toContain("No honor lists loaded yet.");
  });
});

describe("HonorsQueue: scraped lists and Run now", () => {
  const T = "2026-09-20T10:00:00.000Z";
  function run(over: Partial<HonorListRunView>): HonorListRunView {
    return {
      id: "run-1",
      status: "success",
      trigger: "schedule",
      createdAt: T,
      finishedAt: T,
      onListTotal: 1234,
      matched: 7,
      newCandidates: 2,
      errorMessage: null,
      ...over,
    };
  }
  function list(over: Partial<HonorListStatus>): HonorListStatus {
    return {
      id: "invented-fellows",
      honorName: "Fellow",
      organization: "Invented Academy",
      rosterUrl: "https://example.org/fellows",
      host: "example.org",
      schedule: "Weekly",
      latest: run({}),
      lastFinished: run({}),
      active: false,
      ...over,
    };
  }
  function summaryWith(lists: HonorListStatus[]): HonorSourcesSummary {
    return {
      sources: [
        {
          // Rolled up from seeded rows of the SAME roster: shown once, as the list.
          key: "https://example.org/fellows",
          name: "Fellow",
          organization: "Invented Academy",
          url: "https://example.org/fellows",
          host: "example.org",
          lines: 3,
          pendingLines: 1,
          approved: 2,
          rejected: 0,
        },
        {
          key: "seed-only-roster",
          name: "Member",
          organization: "Made-up Society",
          url: null,
          host: null,
          lines: 4,
          pendingLines: 0,
          approved: 4,
          rejected: 0,
        },
      ],
      runs: [],
      lists,
    };
  }
  function open(lists: HonorListStatus[], runNowEnabled: boolean) {
    const utils = render(
      <HonorsQueue
        pending={[]}
        approved={[]}
        rejected={[]}
        userAsserted={[]}
        sources={summaryWith(lists)}
        runNowEnabled={runNowEnabled}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /Sources/ }));
    return utils.container.querySelector('[data-slot="honors-sources"]') as HTMLElement;
  }

  it("shows each scraped list's last run, on-list and WCM counts; seed rosters stay Manual", () => {
    const panel = open([list({})], false);
    const row = panel.querySelector('[data-list="invented-fellows"]') as HTMLElement;
    expect(row.textContent).toContain("Weekly");
    expect(row.textContent).toContain("Sep 20, 2026");
    expect(row.textContent).toContain("Succeeded");
    expect(row.textContent).toContain("1,234");
    expect(row.textContent).toContain("7");
    // The same roster's seed rollup is not listed a second time.
    const manual = panel.querySelectorAll('[data-slot="honors-source"]');
    expect(manual).toHaveLength(1);
    expect(manual[0].textContent).toContain("Manual");
    // 1 scraped + 1 seed-only list.
    expect(screen.getByRole("tab", { name: /Sources/ }).textContent).toContain("2");
  });

  it("offers no Run now while HONORS_RUN_NOW is off", () => {
    const panel = open([list({})], false);
    expect(within(panel).queryByRole("button", { name: /Run now/ })).toBeNull();
  });

  it("Run now POSTs the list id, then shows it queued and refreshes", async () => {
    const panel = open([list({})], true);
    fireEvent.click(within(panel).getByRole("button", { name: "Run now" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/edit/honor/sources/run");
    expect(JSON.parse(init.body as string)).toEqual({ list: "invented-fellows" });
    const button = await within(panel).findByRole("button", { name: "Queued" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(refresh).toHaveBeenCalled();
  });

  it("a list with a run in flight shows it and disables Run now", () => {
    const panel = open(
      [list({ active: true, latest: run({ status: "running", finishedAt: null }) })],
      true,
    );
    const row = panel.querySelector('[data-list="invented-fellows"]') as HTMLElement;
    expect(row.textContent).toContain("Running now…");
    const button = within(row).getByRole("button", { name: "Running…" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    // The previous finished run's counts stay on screen meanwhile.
    expect(row.textContent).toContain("1,234");
  });

  it("a failed run shows its error and dashes for the counts; a partial one is amber", () => {
    const failed = run({
      status: "failed",
      errorMessage: "HTTP 403 on https://example.org/fellows",
    });
    const panel = open(
      [
        list({ latest: failed, lastFinished: failed }),
        list({
          id: "invented-two",
          rosterUrl: "https://example.org/two",
          latest: run({ status: "partial", errorMessage: "Stopped early: page 3" }),
          lastFinished: run({ status: "partial", errorMessage: "Stopped early: page 3" }),
        }),
      ],
      true,
    );
    const bad = panel.querySelector('[data-list="invented-fellows"]') as HTMLElement;
    expect(bad.textContent).toContain("Failed");
    expect(bad.querySelector('[data-slot="honors-list-error"]')?.textContent).toBe(
      "HTTP 403 on https://example.org/fellows",
    );
    expect(bad.textContent).not.toContain("1,234");
    const part = panel.querySelector('[data-list="invented-two"]') as HTMLElement;
    expect(part.textContent).toContain("Partial");
    expect(part.textContent).toContain("1,234");
    expect(panel.textContent).toMatch(/1\s*partial/);
    expect(panel.textContent).toMatch(/1\s*failed/);
  });

  it("a run that never finished reads Did not finish and can be run again", () => {
    const stalled = run({ status: "stalled", finishedAt: null });
    const panel = open([list({ latest: stalled, active: false })], true);
    const row = panel.querySelector('[data-list="invented-fellows"]') as HTMLElement;
    expect(row.textContent).toContain("Did not finish");
    expect(
      (within(row).getByRole("button", { name: "Run now" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("says so when the list is already running server-side", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: "already_running" }), { status: 409 }),
    );
    const panel = open([list({})], true);
    fireEvent.click(within(panel).getByRole("button", { name: "Run now" }));
    expect((await within(panel).findByRole("alert")).textContent).toMatch(
      /already queued or running/,
    );
  });
});

describe("HonorsQueue: candidate evidence", () => {
  it("shows a scraped candidate's evidence line; a seeded one shows none", () => {
    const scraped = grp(
      "https://example.org/fellows|Ada Example|2024",
      [row({ id: "e1", evidence: "Name and institution match: listed at Weill Cornell Medicine" })],
      "Ada Example",
    );
    const seeded = grp(
      "seed-line",
      [row({ id: "e2", cwid: "zzz2002", evidence: null })],
      "B. Example",
    );
    const { container } = render(
      <HonorsQueue
        pending={[scraped, seeded]}
        approved={[]}
        rejected={[]}
        userAsserted={[]}
        sources={NO_SOURCES}
      />,
    );
    const ev = container.querySelectorAll('[data-slot="honor-evidence"]');
    expect(ev).toHaveLength(1);
    expect(ev[0].textContent).toBe("Name and institution match: listed at Weill Cornell Medicine");
  });
});
