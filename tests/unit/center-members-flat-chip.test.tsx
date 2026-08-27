/**
 * #2537/#2234/#2235 — `CenterMembersClient` flat (unprogrammed-center) roster:
 * the Appointment chip joins the server-filtered fetch path, mirroring the
 * `?type=` machinery PR #2537's dept client half ships (mock fetch like
 * `department-faculty-client-facet.test.tsx` does).
 * Covered:
 *  - "All" (no `centerCode`, or no selection): no fetch, SSR roster +
 *    real-href pagination unchanged (`?type=` still carried, #2533).
 *  - selecting a chip (with `centerCode`) fetches
 *    `/api/units/center/<code>/members?type=…&page=0`, replaces the rendered
 *    rows, and the header reflects the FILTERED total.
 *  - chips render WHOLE-CENTER counts from `roleCategoryCounts`, unaffected by
 *    the active chip (#2235).
 *  - `page: 1` (1-indexed, #2234) renders "Showing 1–20", never "-19–0".
 *  - `?type=` deep-link seeds the chip and fetches.
 * PersonRow is stubbed so the test targets the chip/fetch/href logic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/components/department/person-row", () => ({
  PersonRow: ({ hit }: { hit: { cwid: string; preferredName: string } }) => (
    <div data-testid="person" data-cwid={hit.cwid}>
      {hit.preferredName}
    </div>
  ),
}));

import { CenterMembersClient } from "@/components/center/center-members-client";
import type { CenterMemberHit, CenterMembersResult } from "@/lib/api/centers";

const FT = "Full-time faculty";

function hit(cwid: string, roleCategory: string): CenterMemberHit {
  return {
    cwid,
    preferredName: cwid.toUpperCase(),
    slug: cwid,
    primaryTitle: null,
    divisionName: null,
    departmentName: "Medicine",
    identityImageEndpoint: "",
    roleCategory,
    overview: null,
    professorialRank: null,
    pubCount: 0,
    grantCount: 0,
    membershipType: "research",
  };
}

// 21 members across two pages (pageSize 20) so pagination controls render.
// `page` here is the 1-indexed display page (#2537) — matches what
// `getCenterMembers`'s flat mode now returns and what `FlatMembers` has
// always assumed. `roleCategoryCounts` is whole-center (#2235) — populated to
// match the fixture so the "Full-time faculty" chip renders (a 0 count hides
// a non-"All" chip).
function flatResult(page: number): CenterMembersResult {
  return {
    mode: "flat",
    hits: Array.from({ length: 21 }, (_, i) => hit(`m${i}`, FT)),
    total: 21,
    page,
    pageSize: 20,
    roleCategoryCounts: { [FT]: 21 },
  };
}

beforeEach(() => {
  window.history.replaceState(null, "", "/centers/meyer-cancer-center");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("CenterMembersClient — flat roster, unfiltered/no-centerCode (#2533)", () => {
  it("carries the active chip as type= on the page-2 pagination link, no fetch, when there's no centerCode", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<CenterMembersClient result={flatResult(1)} centerSlug="meyer-cancer-center" />);

    fireEvent.click(screen.getByRole("button", { name: /Full-time faculty/ }));

    const page2 = screen.getByRole("link", { name: "2" });
    expect(page2.getAttribute("href")).toBe(
      "/centers/meyer-cancer-center?page=2&type=Full-time+faculty",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("seeds the chip from ?type= on mount (no centerCode → no fetch)", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(
      null,
      "",
      "/centers/meyer-cancer-center?type=Full-time+faculty",
    );
    render(<CenterMembersClient result={flatResult(1)} centerSlug="meyer-cancer-center" />);

    const chip = screen.getByRole("button", { name: /Full-time faculty/ });
    expect(chip.className).toContain("bg-[var(--color-accent-slate)]");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores an unrecognized ?type= value and keeps All active", () => {
    window.history.replaceState(
      null,
      "",
      "/centers/meyer-cancer-center?type=Bogus+Category",
    );
    render(<CenterMembersClient result={flatResult(1)} centerSlug="meyer-cancer-center" />);

    const allChip = screen.getByRole("button", { name: /^All/ });
    expect(allChip.className).toContain("bg-[var(--color-accent-slate)]");
  });

  it("All → no fetch, SSR pagination hrefs intact (?type= still carried)", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <CenterMembersClient
        result={flatResult(1)}
        centerSlug="meyer-cancer-center"
        centerCode="MEYER"
      />,
    );
    const page2 = screen.getByRole("link", { name: "2" });
    expect(page2.getAttribute("href")).toBe("/centers/meyer-cancer-center?page=2");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("CenterMembersClient — flat roster server-filtered chip (#2537)", () => {
  it("selecting a chip fetches /api/units/center/<code>/members?type= and replaces the roster", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          hits: Array.from({ length: 26 }, (_, i) => hit(`flt${i}`, FT)).slice(0, 20),
          total: 26,
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <CenterMembersClient
        result={flatResult(1)}
        centerSlug="meyer-cancer-center"
        centerCode="MEYER"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Full-time faculty/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe(
      "/api/units/center/MEYER/members?type=Full-time+faculty&page=0",
    );

    // Header reflects the FILTERED total (26), not the whole-center total (21).
    await waitFor(() =>
      expect(screen.getByText(/Showing 1–20 of 26 members/)).toBeTruthy(),
    );
    // Two filtered pages (26 / 20) → pagination renders client-side.
    const page2 = screen.getByRole("link", { name: "2" });
    expect(page2.getAttribute("href")).toBe("#");
  });

  it("chips render WHOLE-CENTER counts from roleCategoryCounts, unaffected by the active chip (#2235)", async () => {
    const result: CenterMembersResult = {
      mode: "flat",
      hits: [hit("a", FT), hit("b", FT)],
      total: 2,
      page: 1,
      pageSize: 20,
      roleCategoryCounts: { [FT]: 41, "Doctoral students": 3 },
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [hit("f", FT)], total: 1 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <CenterMembersClient result={result} centerSlug="meyer-cancer-center" centerCode="MEYER" />,
    );
    // Before filtering: whole-center counts, not the 2-row SSR page.
    expect(screen.getByRole("button", { name: /Full-time faculty 41/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Full-time faculty/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // After filtering: the chip count stays whole-center (41), not the
    // filtered page's row count (1).
    expect(screen.getByRole("button", { name: /Full-time faculty 41/ })).toBeTruthy();
  });

  it("renders 'Showing 1–20' on page 1, never '-19–0' (#2234 regression)", () => {
    render(<CenterMembersClient result={flatResult(1)} centerSlug="meyer-cancer-center" />);
    expect(screen.getByText(/Showing 1–20 of 21 members/)).toBeTruthy();
  });

  it("?type= deep link with centerCode seeds the chip and fetches", async () => {
    window.history.replaceState(
      null,
      "",
      "/centers/meyer-cancer-center?type=Full-time+faculty",
    );
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [hit("seg00001", FT)], total: 1 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <CenterMembersClient
        result={flatResult(1)}
        centerSlug="meyer-cancer-center"
        centerCode="MEYER"
      />,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/units/center/MEYER/members?type=Full-time+faculty&page=0",
    );
    await waitFor(() => expect(screen.getByText("SEG00001")).toBeTruthy());
  });

  it("a failed filter fetch keeps the previous result and shows a retryable error", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("500"));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <CenterMembersClient
        result={flatResult(1)}
        centerSlug="meyer-cancer-center"
        centerCode="MEYER"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Full-time faculty/ }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy());
    expect(screen.queryByText("No members match these filters.")).toBeNull();
  });
});
