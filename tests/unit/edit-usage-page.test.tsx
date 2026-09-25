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
import { isWeekend, monthLabel, niceCeil, pctLabel, shortDay } from "@/app/edit/usage/usage-format";

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
