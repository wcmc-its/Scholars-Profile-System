/**
 * `app/edit/usage/page.tsx` — the 2026-09 revision layout: KPI row, pageviews
 * chart, ranked Top profiles / Top search terms (names resolved from slugs,
 * Show all), Traffic sources cards, and the uptime card. Each data source
 * fails soft on its own. Renders are scoped to the page root.
 */
import { fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockCanViewUsage: vi.fn(),
  mockLoadUsage: vi.fn(),
  mockLoadHealth: vi.fn(),
  mockFindMany: vi.fn(),
  mockPush: vi.fn(),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`__REDIRECT__:${url}`);
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: h.mockRedirect,
  notFound: vi.fn(),
  useRouter: () => ({ push: h.mockPush }),
}));
vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: h.mockGetEditSession }));
vi.mock("@/lib/edit/usage-access", () => ({ canViewUsage: h.mockCanViewUsage }));
vi.mock("@/lib/api/usage-summary", () => ({ loadUsageSummary: h.mockLoadUsage }));
vi.mock("@/lib/api/service-health", () => ({ loadServiceHealth: h.mockLoadHealth }));
vi.mock("@/components/edit/console-shell", () => ({
  ConsoleShell: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/components/edit/forbidden-edit-page", () => ({
  ForbiddenEditPage: () => <div data-testid="forbidden" />,
}));
vi.mock("@/components/edit/scholar-hover-card", () => ({
  ScholarHoverCard: ({ children, cwid }: { children: React.ReactNode; cwid: string }) => (
    <span data-hover-cwid={cwid}>{children}</span>
  ),
}));
vi.mock("@/lib/edit/honor-queue", () => ({
  isHonorsQueueTabVisible: () => false,
  countPendingHonors: vi.fn(),
}));
vi.mock("@/lib/edit/slug-request", () => ({
  isSlugRequestEnabled: () => false,
  countPendingSlugRequests: vi.fn(),
}));
vi.mock("@/lib/edit/authz", () => ({ logEditDenial: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { read: { scholar: { findMany: h.mockFindMany } }, write: {} } }));

import EditUsagePage from "@/app/edit/usage/page";
import {
  fillDayGaps,
  isWeekend,
  monthLabel,
  niceCeil,
  pctLabel,
  shortDay,
} from "@/app/edit/usage/usage-format";
import { PageviewsChart, UsageRangePicker } from "@/app/edit/usage/usage-widgets";

const ADMIN = { cwid: "adm001", isSuperuser: true, isCommsSteward: false };

const days = Array.from({ length: 4 }, (_, i) => ({
  day: `2026-08-${String(26 + i).padStart(2, "0")}`,
  views: [120, 700, 0, 80][i],
}));

const SUMMARY = {
  windowDays: 30,
  totalPageviews: 900,
  pageviewsByDay: days,
  topProfiles: Array.from({ length: 22 }, (_, i) => ({
    slug: `test-person-${i + 1}`,
    views: 100 - i,
  })),
  searchTerms: [
    { term: "widgets", searches: 12 },
    { term: "gizmos", searches: 3 },
  ],
  referrers: [
    { label: "(direct)", hits: 900 },
    { label: "example.org", hits: 100 },
  ],
  geo: [{ label: "North America", hits: 1000 }],
  device: [
    { label: "desktop", hits: 990 },
    { label: "mobile", hits: 10 },
  ],
};

const HEALTH = {
  windowDays: 30,
  uptimePercent: 99.987,
  alarmFirings: 2,
  monthly: [
    { month: "2026-07", availabilityPercent: 99.5, totalRequests: 500, lowTraffic: true },
    { month: "2026-08", availabilityPercent: 99.98, totalRequests: 40_000, lowTraffic: false },
  ],
};

async function renderPage(params: Record<string, string> = {}) {
  const { container } = render(
    <main data-testid="root">
      {await EditUsagePage({ searchParams: Promise.resolve(params) })}
    </main>,
  );
  return within(container.querySelector('[data-testid="root"]') as HTMLElement);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.mockGetEditSession.mockResolvedValue(ADMIN);
  h.mockCanViewUsage.mockResolvedValue(true);
  h.mockLoadUsage.mockResolvedValue(SUMMARY);
  h.mockLoadHealth.mockResolvedValue(HEALTH);
  h.mockFindMany.mockResolvedValue([
    { slug: "test-person-1", cwid: "tst0001", preferredName: "Test Person One" },
  ]);
});

describe("/edit/usage", () => {
  it("renders the forbidden page for a viewer without usage access", async () => {
    h.mockCanViewUsage.mockResolvedValue(false);
    const root = await renderPage();
    expect(root.getByTestId("forbidden")).toBeTruthy();
    expect(h.mockLoadUsage).not.toHaveBeenCalled();
  });

  it("shows the date span and the four KPI tiles", async () => {
    const root = await renderPage();
    expect(root.getByText(/Site-wide usage, Aug 26 – Aug 29\./)).toBeTruthy();
    expect(root.getByTestId("usage-total-pageviews").textContent).toBe("900");
    expect(root.getByText("about 225 a day")).toBeTruthy();
    expect(root.getByTestId("usage-busiest-day").textContent).toBe("700");
    expect(root.getByTestId("usage-busiest-day").nextElementSibling?.textContent).toBe("Aug 27");
    expect(root.getByTestId("service-health-uptime").textContent).toBe("99.99%");
    expect(root.getByTestId("service-health-alarm-firings").textContent).toBe("2");
  });

  it("names resolved profiles (with the hover card), keeps unresolved slugs, and toggles Show all", async () => {
    const root = await renderPage();
    const profiles = within(root.getByTestId("usage-top-profiles"));
    const named = profiles.getByText("Test Person One");
    expect(named.closest("a")?.getAttribute("href")).toBe("/test-person-1");
    expect(named.closest("[data-hover-cwid]")?.getAttribute("data-hover-cwid")).toBe("tst0001");
    expect(profiles.getByText("/test-person-2")).toBeTruthy();
    expect(profiles.queryByText("/test-person-21")).toBeNull();
    fireEvent.click(profiles.getByRole("button", { name: "Show all 22" }));
    expect(profiles.getByText("/test-person-22")).toBeTruthy();
    expect(profiles.getByRole("button", { name: "Show top 20" })).toBeTruthy();

    const terms = within(root.getByTestId("usage-top-search-terms"));
    expect(terms.getByText("widgets")).toBeTruthy();
    expect(terms.queryByRole("button", { name: /Show all/ })).toBeNull();
  });

  it("falls back to slugs when the name lookup fails", async () => {
    h.mockFindMany.mockRejectedValue(new Error("db down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const root = await renderPage();
    expect(within(root.getByTestId("usage-top-profiles")).getByText("/test-person-1")).toBeTruthy();
  });

  it("renders traffic-source cards with shares and the all-requests total", async () => {
    const root = await renderPage();
    const traffic = within(root.getByTestId("usage-traffic-sources"));
    expect(traffic.getByText(/All requests \(1,000 hits\)/)).toBeTruthy();
    expect(traffic.getByText("Desktop")).toBeTruthy();
    expect(traffic.getByText("99.0%")).toBeTruthy();
    expect(traffic.getByText("1.0%")).toBeTruthy();
  });

  it("renders the uptime card with month labels and a lighter low-traffic bar", async () => {
    const root = await renderPage();
    const card = root.getByTestId("service-health-trend");
    const c = within(card);
    expect(c.getByText("Jul 2026")).toBeTruthy();
    expect(c.getByText("99.50%")).toBeTruthy();
    expect(card.querySelectorAll('[data-low-traffic="true"]')).toHaveLength(1);
    expect(c.getByText(/Bars span 99%–100%/)).toBeTruthy();
  });

  it("fails soft per source: Athena down keeps service health, CloudWatch down keeps usage", async () => {
    h.mockLoadUsage.mockRejectedValue(new Error("athena"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    let root = await renderPage();
    expect(root.getByTestId("edit-usage-unavailable")).toBeTruthy();
    expect(root.getByTestId("service-health-uptime")).toBeTruthy();

    h.mockLoadUsage.mockResolvedValue(SUMMARY);
    h.mockLoadHealth.mockRejectedValue(new Error("cloudwatch"));
    document.body.innerHTML = "";
    root = await renderPage();
    expect(root.getByTestId("service-health-unavailable")).toBeTruthy();
    expect(root.queryByTestId("service-health-trend")).toBeNull();
    expect(root.getByTestId("usage-total-pageviews")).toBeTruthy();
  });
});

describe("/edit/usage range", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-25T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads the default 30-day window and labels the dropdown", async () => {
    const root = await renderPage();
    expect(h.mockLoadUsage).toHaveBeenCalledWith(
      expect.objectContaining({ key: "30", since: "2026-08-26", until: "2026-09-24" }),
    );
    expect(root.getByTestId("usage-range-trigger").textContent).toContain("Last 30 days");
  });

  it("loads the window named by ?range= (since launch)", async () => {
    const root = await renderPage({ range: "launch" });
    expect(h.mockLoadUsage).toHaveBeenCalledWith(
      expect.objectContaining({ key: "launch", since: "2026-07-01", until: "2026-09-24" }),
    );
    expect(root.getByTestId("usage-range-trigger").textContent).toContain("Since launch");
  });

  it("shows a custom range's dates on the trigger", async () => {
    const root = await renderPage({ range: "custom", from: "2026-08-01", to: "2026-08-15" });
    expect(h.mockLoadUsage).toHaveBeenCalledWith(
      expect.objectContaining({ since: "2026-08-01", until: "2026-08-15" }),
    );
    expect(root.getByTestId("usage-range-trigger").textContent).toContain("Aug 1 – Aug 15");
  });

  it("falls back to the requested window in the subtitle when no days have data", async () => {
    h.mockLoadUsage.mockResolvedValue({ ...SUMMARY, pageviewsByDay: [], totalPageviews: 0 });
    const root = await renderPage({ range: "7" });
    expect(root.getByText(/Site-wide usage, Sep 18 – Sep 24\./)).toBeTruthy();
    expect(root.getByTestId("usage-pageviews-empty").textContent).toContain("in this range");
  });

  it("navigates to the chosen range and to an applied custom range", async () => {
    const root = await renderPage();
    fireEvent.click(root.getByTestId("usage-range-trigger"));
    // Radix portals the menu to document.body.
    const menu = within(document.body);
    fireEvent.click(menu.getByRole("button", { name: /Last 90 days/ }));
    expect(h.mockPush).toHaveBeenCalledWith("/edit/usage?range=90");

    fireEvent.click(root.getByTestId("usage-range-trigger"));
    fireEvent.click(within(document.body).getByRole("button", { name: /Custom range/ }));
    const form = within(within(document.body).getByTestId("usage-range-custom"));
    fireEvent.change(form.getByLabelText("From"), { target: { value: "2026-08-01" } });
    fireEvent.change(form.getByLabelText("To"), { target: { value: "2026-08-15" } });
    fireEvent.click(form.getByRole("button", { name: "Apply" }));
    expect(h.mockPush).toHaveBeenLastCalledWith(
      "/edit/usage?range=custom&from=2026-08-01&to=2026-08-15",
    );
  });
});

describe("PageviewsChart", () => {
  const series = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      day: new Date(Date.UTC(2026, 6, 1 + i)).toISOString().slice(0, 10),
      views: 10 + i,
    }));
  const labelled = (n: number) => {
    const { getByTestId } = render(<PageviewsChart data={series(n)} />);
    const axis = getByTestId("usage-pageviews-chart").querySelector('[aria-hidden="true"].flex');
    return [...(axis?.children ?? [])].filter((s) => s.textContent !== "").length;
  };

  it("labels every 4th day for a month and about eight days for a long range", () => {
    expect(labelled(30)).toBe(8); // i = 0, 4, ..., 28
    document.body.innerHTML = "";
    expect(labelled(90)).toBe(8); // stride 12: i = 0, 12, ..., 84
    document.body.innerHTML = "";
    expect(labelled(7)).toBe(7);
  });
});

describe("PageviewsChart gaps", () => {
  it("draws a day with no rollup row as an empty slot, not a zero bar", () => {
    const { getByTestId, getByText } = render(
      <PageviewsChart
        data={[
          { day: "2026-08-26", views: 120 },
          { day: "2026-08-27", views: null },
          { day: "2026-08-28", views: 0 },
        ]}
      />,
    );
    const chart = getByTestId("usage-pageviews-chart");
    const slots = [...(chart.querySelector('[role="img"]')?.children ?? [])];
    expect(slots).toHaveLength(3);
    expect(slots[1].getAttribute("data-gap")).toBe("true");
    expect(slots[1].children).toHaveLength(0); // no bar at all
    expect(slots[2].getAttribute("data-gap")).toBeNull();
    expect(slots[2].children).toHaveLength(1); // a real zero keeps its (0-height) bar
    expect(chart.querySelector('[role="img"]')?.getAttribute("aria-label")).toContain(
      "1 with no data",
    );
    fireEvent.mouseEnter(slots[1]);
    expect(getByText("Aug 27: no data")).toBeTruthy();
  });

  it("the page lays the requested window on the axis, gaps included", async () => {
    h.mockLoadUsage.mockResolvedValue({
      ...SUMMARY,
      since: "2026-08-25",
      until: "2026-08-31",
    });
    const root = await renderPage();
    const slots = [
      ...(root.getByTestId("usage-pageviews-chart").querySelector('[role="img"]')?.children ?? []),
    ];
    // 7 window days; the fixture has rows for Aug 26-29 only.
    expect(slots).toHaveLength(7);
    expect(slots.filter((s) => s.getAttribute("data-gap") === "true")).toHaveLength(3);
  });
});

describe("UsageRangePicker", () => {
  it("re-seeds the custom inputs and panel when the range props change (same-route push)", () => {
    const { rerender, getByTestId } = render(
      <UsageRangePicker
        current="custom"
        since="2026-08-01"
        until="2026-08-15"
        maxDate="2026-09-24"
      />,
    );
    fireEvent.click(getByTestId("usage-range-trigger"));
    let form = within(within(document.body).getByTestId("usage-range-custom"));
    expect((form.getByLabelText("From") as HTMLInputElement).value).toBe("2026-08-01");
    // A half-typed edit, then the page re-renders with a new resolved range.
    fireEvent.change(form.getByLabelText("From"), { target: { value: "2026-07-10" } });
    rerender(
      <UsageRangePicker
        current="custom"
        since="2026-09-01"
        until="2026-09-10"
        maxDate="2026-09-24"
      />,
    );
    form = within(within(document.body).getByTestId("usage-range-custom"));
    expect((form.getByLabelText("From") as HTMLInputElement).value).toBe("2026-09-01");
    expect((form.getByLabelText("To") as HTMLInputElement).value).toBe("2026-09-10");
    // Switching to a preset closes the custom panel it had open.
    rerender(
      <UsageRangePicker current="30" since="2026-08-26" until="2026-09-24" maxDate="2026-09-24" />,
    );
    expect(within(document.body).queryByTestId("usage-range-custom")).toBeNull();
  });
});

describe("fillDayGaps", () => {
  it("fills missing days in the window with null and keeps real zeros", () => {
    expect(
      fillDayGaps(
        [
          { day: "2026-08-27", views: 5 },
          { day: "2026-08-29", views: 0 },
        ],
        "2026-08-26",
        "2026-08-30",
      ),
    ).toEqual([
      { day: "2026-08-26", views: null },
      { day: "2026-08-27", views: 5 },
      { day: "2026-08-28", views: null },
      { day: "2026-08-29", views: 0 },
      { day: "2026-08-30", views: null },
    ]);
  });

  it("falls back to the data's own span without bounds, and is empty for no data", () => {
    expect(
      fillDayGaps([
        { day: "2026-08-31", views: 1 },
        { day: "2026-09-02", views: 2 },
      ]),
    ).toEqual([
      { day: "2026-08-31", views: 1 },
      { day: "2026-09-01", views: null },
      { day: "2026-09-02", views: 2 },
    ]);
    expect(fillDayGaps([], "2026-08-01", "2026-08-05")).toEqual([]);
  });
});

describe("fillDayGaps slot cap", () => {
  it("never drops real rows when the window is longer than the slot cap", () => {
    const rows = [
      { day: "2026-07-01", views: 10 },
      { day: "2026-09-24", views: 20 },
    ];
    const out = fillDayGaps(rows, "2020-01-01", "2026-09-24");
    // Trimmed to the data span, not a capped run of pre-data nulls.
    expect(out[0]).toEqual({ day: "2026-07-01", views: 10 });
    expect(out[out.length - 1]).toEqual({ day: "2026-09-24", views: 20 });
    expect(out).toHaveLength(86);
    expect(out.filter((d) => d.views !== null)).toHaveLength(2);
  });

  it("returns the rows unfilled when even the data span exceeds the cap", () => {
    const rows = [
      { day: "2020-01-01", views: 1 },
      { day: "2026-09-24", views: 2 },
    ];
    expect(fillDayGaps(rows, "2020-01-01", "2026-09-24")).toEqual(rows);
  });

  it("widens the axis to cover a row outside the requested window", () => {
    const out = fillDayGaps([{ day: "2026-08-24", views: 3 }], "2026-08-25", "2026-08-26");
    expect(out.map((d) => d.day)).toEqual(["2026-08-24", "2026-08-25", "2026-08-26"]);
    expect(out[0].views).toBe(3);
  });
});

describe("UsageRangePicker date floor", () => {
  it("sets min= on both custom date inputs", () => {
    const { getByTestId } = render(
      <UsageRangePicker
        current="custom"
        since="2026-08-01"
        until="2026-08-15"
        maxDate="2026-09-24"
      />,
    );
    fireEvent.click(getByTestId("usage-range-trigger"));
    const form = within(within(document.body).getByTestId("usage-range-custom"));
    for (const name of ["From", "To"]) {
      const input = form.getByLabelText(name) as HTMLInputElement;
      expect(input.min).toBe("2026-05-22");
      expect(input.max).toBe("2026-09-24");
    }
  });
});

describe("usage-format helpers", () => {
  it("formats days, months, shares and nice ceilings", () => {
    expect(shortDay("2026-09-03")).toBe("Sep 3");
    expect(monthLabel("2026-07")).toBe("Jul 2026");
    expect(niceCeil(730)).toBe(800);
    expect(niceCeil(95)).toBe(100);
    expect(niceCeil(0)).toBe(1);
    expect(pctLabel(0.00001)).toBe("<0.01%");
    expect(pctLabel(0.005)).toBe("0.50%");
    expect(isWeekend("2026-08-29")).toBe(true); // a Saturday
    expect(isWeekend("2026-08-26")).toBe(false);
  });
});
