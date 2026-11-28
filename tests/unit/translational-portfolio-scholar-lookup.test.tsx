/**
 * @vitest-environment jsdom
 *
 * Report 26's scholar type-ahead: the route (report 26's gate, a link only
 * for a scholar this viewer may open, the report's state carried in `r` and
 * re-parsed so it holds report filters only), and the rail box (matches drop
 * down under it as you type, typing and Enter never submit the rail's
 * auto-submitting form, Enter opens the first match). Fixture people are
 * invented.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  session: vi.fn(),
  canView: vi.fn(),
  lookup: vi.fn(),
  access: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} }, prisma: {} }));
vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: h.session }));
vi.mock("@/lib/auth/partner-login", () => ({ getPartnerEditSession: async () => null }));
vi.mock("@/lib/edit/bibliometrics-access", () => ({ loadBibliometricsAccess: h.access }));
vi.mock("@/lib/edit/translational-portfolio-report", async (actual) => ({
  ...(await actual<typeof import("@/lib/edit/translational-portfolio-report")>()),
  isTranslationalPortfolioReportEnabled: () => true,
  canViewTranslationalPortfolioReport: h.canView,
  lookupScholars: h.lookup,
}));

import { GET } from "@/app/api/edit/reports/translational-portfolio/scholars/route";
import { ScholarLookup } from "@/components/edit/reports/translational-portfolio-client";

const who = (cwid: string, name: string) => ({ cwid, name, title: "Professor", department: "Examples", slug: null });
const get = (qs: string) => GET(new Request(`https://x.test/api/edit/reports/translational-portfolio/scholars?${qs}`));

beforeEach(() => {
  h.session.mockReset().mockResolvedValue({ cwid: "sup0001", isSuperuser: true });
  h.canView.mockReset().mockResolvedValue(true);
  h.lookup.mockReset().mockResolvedValue([who("abc2001", "Example Lookup A"), who("abc2002", "Example Lookup B")]);
  h.access.mockReset().mockResolvedValue(new Set(["abc2001"]));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the type-ahead route", () => {
  it("links only the scholars this viewer may open, under the report's state", async () => {
    const r = encodeURIComponent("unit=dept:N1&from=2021&to=2024&cwid=zzz9&by=area");
    const res = await get(`q=Example&r=${r}`);
    expect(res.status).toBe(200);
    const { matches } = (await res.json()) as { matches: { cwid: string; href: string | null }[] };
    expect(h.lookup).toHaveBeenCalledWith("Example");
    expect(h.access).toHaveBeenCalledWith(["abc2001", "abc2002"]);
    expect(matches.map((m) => m.cwid)).toEqual(["abc2001", "abc2002"]);
    expect(matches[1].href).toBeNull();
    const sp = new URLSearchParams(matches[0].href!.split("?")[1]);
    expect(matches[0].href!.startsWith("/edit/scholar/abc2001/translational-portfolio?")).toBe(true);
    // Re-parsed by the report's parser: the report's filters, never another scholar.
    expect(sp.get("r")).toBe("unit=dept%3AN1&from=2021&to=2024&by=area");
  });

  it("answers no one outside report 26's gate", async () => {
    h.canView.mockResolvedValue(false);
    expect((await get("q=Example")).status).toBe(403);
    h.session.mockResolvedValue(null);
    expect((await get("q=Example")).status).toBe(401);
    expect(h.lookup).not.toHaveBeenCalled();
  });
});

describe("the rail's lookup box", () => {
  it("drops matches under the box as you type, never submits the rail, and Enter opens the first", async () => {
    vi.useFakeTimers();
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          matches: [
            { cwid: "abc2001", name: "Example Lookup A", title: null, department: "Examples", href: "/edit/scholar/abc2001/translational-portfolio?r=x" },
            { cwid: "abc2002", name: "Example Lookup B", title: null, department: null, href: null },
          ],
        }),
      })),
    );
    const submit = vi.fn();
    render(
      <form onChange={submit} onSubmit={(e) => (e.preventDefault(), submit())}>
        <ScholarLookup report="from=2021&to=2024" />
      </form>,
    );
    const input = screen.getByTestId("portfolio-lookup-input");
    fireEvent.change(input, { target: { value: "Ex" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    const list = screen.getByTestId("portfolio-lookup");
    expect(list.parentElement).toBe(input.parentElement); // under the box, not elsewhere on the page
    expect(screen.getAllByTestId("portfolio-lookup-option").map((o) => o.textContent)).toEqual([
      "Example Lookup AExamples · abc2001",
      "Example Lookup Babc2002You can’t open this scholar’s portfolio.",
    ]);
    expect(String((fetch as unknown as { mock: { calls: string[][] } }).mock.calls[0][0])).toContain("r=from%3D2021%26to%3D2024");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(assign).toHaveBeenCalledWith("/edit/scholar/abc2001/translational-portfolio?r=x");
    expect(submit).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
