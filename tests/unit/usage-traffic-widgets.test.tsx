/**
 * app/edit/usage/traffic-widgets — the traffic sections' client island: KPI
 * tiles, the edge firewall chart and its event markers, multi-select source
 * chips (bar totals + caption + referrer filter), Visits/Share, "Show 25
 * more", search, page-type tabs and "Arrived from". The list route is a
 * mocked fetch.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TopPages, TrafficSection, isSitePath } from "@/app/edit/usage/traffic-widgets";
import type { TrafficOverview } from "@/lib/analytics/traffic-view";
import type { EdgeDecisions } from "@/lib/api/usage-edge";

const OVERVIEW: TrafficOverview = {
  since: "2026-10-17",
  until: "2026-11-15",
  firstDt: "2026-11-02",
  kpi: {
    hits: 11_300_000,
    pageviews: 4_450_000,
    visitorsAvg: 1234,
    visitorDays: 14,
    engagedAvg: 310,
    engagedDays: 3,
  },
  sourcesDaily: [
    { dt: "2026-11-03", category: "WCM", visits: 40 },
    { dt: "2026-11-03", category: "Search engines", visits: 10 },
    { dt: "2026-11-10", category: "WCM", visits: 300 },
    { dt: "2026-11-11", category: "Search engines", visits: 1200 },
    { dt: "2026-11-12", category: "Old VIVO", visits: 500 },
  ],
  referrers: { total: 2100, other: 50, siteOnly: 1845 },
  aiDaily: [{ dt: "2026-11-10", referral: 3, fetch: 20, crawler: 900 }],
  vendors: [
    { vendor: "OpenAI", count: 700 },
    { vendor: "Anthropic", count: 220 },
  ],
};

type ListRow = { label: string; category?: string; visits: number };
const rowsOf = (n: number, from = 0): ListRow[] =>
  Array.from({ length: n }, (_, i) => ({
    label: `site-${from + i + 1}.example`,
    category: "Other",
    visits: 1000 - from - i,
  }));

const fetchMock = vi.fn();

function respond(body: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
}

function urls(): URL[] {
  return fetchMock.mock.calls.map((c) => new URL(String(c[0]), "http://localhost"));
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation((input: string) => {
    const u = new URL(input, "http://localhost");
    const offset = Number(u.searchParams.get("offset"));
    if (u.searchParams.get("list") === "referrers") {
      return respond({ rows: offset === 0 ? rowsOf(25) : rowsOf(5, 25), total: 30 });
    }
    return respond({
      rows: [
        { label: "/", visits: 50 },
        { label: "/test-person-1", visits: 5 },
      ],
      total: 2,
    });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A week of edge decisions holding the 2026-11-11 event, not the 2026-11-21 one. */
const EDGE: EdgeDecisions = {
  status: "ok",
  days: Array.from({ length: 7 }, (_, i) => ({
    dt: `2026-11-${String(9 + i).padStart(2, "0")}`,
    allowed: 1000,
    challenged: i === 6 ? 500 : 0,
    blocked: 20,
  })),
};

async function renderSection(edge?: EdgeDecisions) {
  render(<TrafficSection overview={OVERVIEW} rangeQuery="range=30" edge={edge} />);
  await waitFor(() =>
    expect(screen.getAllByTestId("traffic-list-count")[0].textContent).toContain("of 30"),
  );
  return screen.getByTestId("usage-traffic");
}

const barTotals = () => screen.getAllByTestId("traffic-bar-total").map((t) => t.textContent);

describe("TrafficSection", () => {
  it("shows the KPIs, the estimate badge and the data-start note", async () => {
    await renderSection();
    expect(screen.getByTestId("traffic-hits").textContent).toBe("11.3M");
    expect(screen.getByTestId("traffic-pageviews").textContent).toBe("4.45M");
    expect(screen.getByTestId("traffic-visitors").textContent).toBe("1,234");
    expect(screen.getAllByText("Estimate")).toHaveLength(2);
    expect(screen.getByTestId("traffic-start-note").textContent).toContain(
      "Traffic detail starts Nov 2.",
    );
  });

  it("leads the KPI row with engaged visits, the same kind of tile as visitors", async () => {
    await renderSection();
    const engaged = screen.getByTestId("traffic-engaged");
    expect(engaged.textContent).toBe("310");
    const tile = engaged.parentElement!;
    expect(tile.previousElementSibling).toBeNull();
    expect(screen.getByText("Visitors a day, incl. undetected bots")).toBeTruthy();
    expect(tile.className).toBe(screen.getByTestId("traffic-visitors").parentElement!.className);
    expect(within(tile).getByText("Engaged visits a day")).toBeTruthy();
    expect(
      within(tile).getByText(/clicked a search result or opened a profile preview/),
    ).toBeTruthy();
    expect(within(tile).queryByText(/Not recorded/)).toBeNull();
  });

  it("an engaged tile with no day of data shows a dash and says so", async () => {
    render(
      <TrafficSection
        overview={{ ...OVERVIEW, kpi: { ...OVERVIEW.kpi, engagedAvg: null, engagedDays: 0 } }}
        rangeQuery="range=30"
      />,
    );
    await waitFor(() => expect(screen.getAllByTestId("traffic-list-count").length).toBe(2));
    const engaged = screen.getByTestId("traffic-engaged");
    expect(engaged.textContent).toBe("—");
    expect(engaged.parentElement!.textContent).toContain("Not recorded for this range yet.");
  });

  it("draws the edge chart per day under the KPIs, marking only events in its range", async () => {
    await renderSection(EDGE);
    const edge = screen.getByTestId("traffic-edge");
    // Directly after the KPI tiles, before "Where visits come from".
    expect(edge.previousElementSibling?.contains(screen.getByTestId("traffic-hits"))).toBe(true);
    expect(edge.nextElementSibling).toBe(screen.getByTestId("traffic-sources"));
    const card = within(edge);
    expect(card.getByText("Edge firewall decisions per day")).toBeTruthy();
    // One stack per day: 7 allowed + 7 blocked + 1 challenged segment.
    expect(edge.querySelectorAll("svg rect")).toHaveLength(15);
    expect(card.getByText("Nov 15: Challenged 500 (32.9%)")).toBeTruthy();
    // Legend totals over the range.
    expect(card.getByText("7,000")).toBeTruthy();
    expect(card.getByText("140")).toBeTruthy();
    expect(card.getByText(/Pageviews and visitors don't include them\./)).toBeTruthy();
    expect(card.getByText("How bot traffic is handled")).toBeTruthy();
    // Nov 11 is in the week; Nov 21 is not.
    const markers = card.getAllByTestId("usage-day-marker");
    expect(markers.map((m) => m.getAttribute("data-date"))).toEqual(["2026-11-11"]);
    expect(markers[0].textContent).toBe("VIVO cutover");
    expect(card.queryByText("Bot block rules, bot filter backfill")).toBeNull();
    expect(card.getByRole("img").getAttribute("aria-label")).toContain(
      "marked: Nov 11 VIVO cutover",
    );
  });

  it("the edge chart says when CloudWatch is unavailable, and is absent without edge data", async () => {
    await renderSection({ status: "unavailable" });
    expect(screen.getByTestId("traffic-edge-unavailable").textContent).toBe(
      "Edge firewall counts are temporarily unavailable.",
    );
    expect(within(screen.getByTestId("traffic-edge")).queryByRole("img")).toBeNull();
    cleanup();
    await renderSection();
    expect(screen.queryByTestId("traffic-edge")).toBeNull();
  });

  it("draws one bar per week from the first rollup day, total above each", async () => {
    await renderSection();
    // Weeks Nov 2-8 and Nov 9-15 (the range starts Oct 17, the data Nov 2).
    expect(barTotals()).toEqual(["50", "2,000"]);
    const table = within(screen.getByTestId("traffic-sources")).getByRole("table");
    expect(within(table).getByText("Nov 9–15")).toBeTruthy();
    expect(within(table).getByText("Nov 2–8")).toBeTruthy();
    expect(
      screen.getByText(
        /50 referred visits \(2\.4%\) came from referrers past each day's top 5,000/,
      ),
    ).toBeTruthy();
  });

  it("multi-selects sources: combined totals, caption, referrer filter, All sources clears", async () => {
    await renderSection();
    const sources = within(screen.getByRole("group", { name: "Sources" }));
    fireEvent.click(sources.getByRole("button", { name: "WCM" }));
    expect(barTotals()).toEqual(["40", "300"]);
    fireEvent.click(sources.getByRole("button", { name: "Search engines" }));
    expect(barTotals()).toEqual(["50", "1,500"]);
    expect(sources.getByRole("button", { name: "WCM" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("traffic-sources-caption").textContent).toContain(
      "number above each bar is WCM, Search engines combined",
    );
    await waitFor(() =>
      expect(urls().some((u) => u.searchParams.get("cats") === "Search engines,WCM")).toBe(true),
    );
    // Share mode: the selection's share of each bar.
    fireEvent.click(screen.getByRole("tab", { name: "Share" }));
    expect(barTotals()).toEqual(["100.0%", "75.0%"]);
    fireEvent.click(sources.getByRole("button", { name: "All sources" }));
    expect(barTotals()).toEqual(["50", "2,000"]);
  });

  it("switches to months", async () => {
    await renderSection();
    fireEvent.click(screen.getByRole("tab", { name: "By month" }));
    expect(barTotals()).toEqual(["2,050"]);
    expect(
      within(screen.getByTestId("traffic-sources")).getAllByText("November 2–15").length,
    ).toBeGreaterThan(0);
    expect(screen.getByTestId("traffic-download-excel").getAttribute("href")).toBe(
      "/api/edit/usage/traffic/export?range=30&grain=month",
    );
  });

  it("pages the referrer list with Show 25 more", async () => {
    await renderSection();
    const list = within(screen.getByTestId("traffic-referrers"));
    expect(list.getByTestId("traffic-list-count").textContent).toBe(
      "Showing 25 of 30 referring sites, busiest first",
    );
    fireEvent.click(list.getByRole("button", { name: "Show 25 more" }));
    await waitFor(() =>
      expect(list.getByTestId("traffic-list-count").textContent).toBe(
        "Showing 30 of 30 referring sites, busiest first",
      ),
    );
    expect(list.queryByRole("button", { name: "Show 25 more" })).toBeNull();
    expect(urls().some((u) => u.searchParams.get("offset") === "25")).toBe(true);
    expect(list.getByText("90.0% of referrals name only the site", { exact: false })).toBeTruthy();
  });

  it("searches all referrers after a pause", async () => {
    await renderSection();
    fireEvent.change(screen.getByLabelText(/Search all referring sites/), {
      target: { value: "Radiology" },
    });
    await waitFor(() =>
      expect(urls().some((u) => u.searchParams.get("q") === "Radiology")).toBe(true),
    );
    await waitFor(() =>
      expect(
        within(screen.getByTestId("traffic-referrers")).getByTestId("traffic-list-count")
          .textContent,
      ).toContain("matching referring sites"),
    );
  });

  it("filters top pages by type and switches to landing pages for Arrived from", async () => {
    await renderSection();
    const pages = within(screen.getByTestId("traffic-pages"));
    fireEvent.click(pages.getByRole("tab", { name: "Profiles" }));
    await waitFor(() =>
      expect(
        urls().some(
          (u) => u.searchParams.get("list") === "pages" && u.searchParams.get("kind") === "profile",
        ),
      ).toBe(true),
    );
    const arrived = within(pages.getByRole("group", { name: "Arrived from" }));
    fireEvent.click(arrived.getByRole("button", { name: "WCM" }));
    fireEvent.click(arrived.getByRole("button", { name: "AI crawlers" }));
    await waitFor(() =>
      expect(
        urls().some(
          (u) => u.searchParams.get("cats") === "WCM" && u.searchParams.get("ai") === "crawler",
        ),
      ).toBe(true),
    );
    expect(pages.getByText(/Showing landing pages for WCM, AI crawlers/)).toBeTruthy();
    await waitFor(() =>
      expect(pages.getByTestId("traffic-list-count").textContent).toBe(
        "Showing 2 of 2 matching landing pages, busiest first",
      ),
    );
  });

  it("a unit-scoped page drops the Hits tile; a superuser's keeps it", async () => {
    const { unmount } = render(<TrafficSection overview={OVERVIEW} rangeQuery="range=30" scoped />);
    expect(screen.queryByTestId("traffic-hits")).toBeNull();
    expect(screen.getByTestId("traffic-engaged")).toBeTruthy();
    unmount();
    render(<TrafficSection overview={OVERVIEW} rangeQuery="range=30" />);
    expect(screen.getByTestId("traffic-hits")).toBeTruthy();
  });

  it("a unit-scoped page: the section drops Top pages, which the page draws itself", async () => {
    render(<TrafficSection overview={OVERVIEW} rangeQuery="range=30" scoped />);
    await waitFor(() =>
      expect(screen.getByTestId("traffic-list-count").textContent).toContain("of 30"),
    );
    expect(screen.queryByTestId("traffic-pages")).toBeNull();
    expect(screen.getByTestId("traffic-referrers")).toBeTruthy();
    expect(urls().every((u) => u.searchParams.get("list") === "referrers")).toBe(true);
  });

  it("a unit-scoped Top pages card says whose pages it lists and has no page-type tabs", async () => {
    render(<TopPages rangeQuery="range=30" exportHref="/api/edit/usage/traffic/export?range=30&grain=week" scoped />);
    const pages = within(screen.getByTestId("traffic-pages"));
    await waitFor(() =>
      expect(pages.getByTestId("traffic-list-count").textContent).toContain("of 2"),
    );
    expect(pages.getByText("Profile pages of the people in your units")).toBeTruthy();
    expect(pages.queryByRole("tab")).toBeNull();
    expect(pages.getByRole("group", { name: "Arrived from" })).toBeTruthy();
    // The scope is the server's: the request carries no unit or slug.
    expect([...urls()[0].searchParams.keys()].sort()).toEqual(["kind", "list", "offset", "range"]);
  });

  it("shows the AI series and companies", async () => {
    await renderSection();
    const ai = within(screen.getByTestId("traffic-ai"));
    expect(within(screen.getByTestId("traffic-ai-crawler")).getByText("900")).toBeTruthy();
    expect(ai.getByText("OpenAI")).toBeTruthy();
    expect(ai.getByText("220")).toBeTruthy();
  });

  it("says when the range ends before traffic detail starts", async () => {
    await act(async () => {
      render(
        <TrafficSection overview={{ ...OVERVIEW, firstDt: "2026-12-01" }} rangeQuery="range=30" />,
      );
    });
    expect(screen.getByTestId("traffic-empty").textContent).toBe(
      "Traffic detail starts Dec 1, after this range ends.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("isSitePath", () => {
  it("links only same-site paths", () => {
    expect(isSitePath("/")).toBe(true);
    expect(isSitePath("/topics/cancer")).toBe(true);
    expect(isSitePath("//evil.example/x")).toBe(false);
    expect(isSitePath("/\\evil.example")).toBe(false);
    expect(isSitePath("/\t/evil.example")).toBe(false);
    expect(isSitePath("(other)")).toBe(false);
    expect(isSitePath("javascript:alert(1)")).toBe(false);
  });
});
