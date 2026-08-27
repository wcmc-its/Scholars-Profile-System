/**
 * #2533 — `CenterMembersClient` flat (unprogrammed-center) roster: the
 * Appointment chip must survive pagination, a real navigation. Mirrors the
 * `?type=` deep-link pattern PR #2532 shipped for `DepartmentFacultyClient`.
 * Covered:
 *  - the active chip is carried as `type=` on the page-2 pagination href.
 *  - `?type=` on window.location at mount seeds the chip.
 *  - an unrecognized `?type=` value is ignored and "All" stays active.
 * PersonRow is stubbed so the test targets the chip/href logic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

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
// always assumed.
function flatResult(page: number): CenterMembersResult {
  return {
    mode: "flat",
    hits: Array.from({ length: 21 }, (_, i) => hit(`m${i}`, FT)),
    total: 21,
    page,
    pageSize: 20,
    roleCategoryCounts: {},
  };
}

beforeEach(() => {
  window.history.replaceState(null, "", "/centers/meyer-cancer-center");
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("CenterMembersClient — flat roster chip/pagination round-trip (#2533)", () => {
  it("carries the active chip as type= on the page-2 pagination link", () => {
    render(<CenterMembersClient result={flatResult(1)} centerSlug="meyer-cancer-center" />);

    fireEvent.click(screen.getByRole("button", { name: /Full-time faculty/ }));

    const page2 = screen.getByRole("link", { name: "2" });
    expect(page2.getAttribute("href")).toBe(
      "/centers/meyer-cancer-center?page=2&type=Full-time+faculty",
    );
  });

  it("seeds the chip from ?type= on mount", () => {
    window.history.replaceState(
      null,
      "",
      "/centers/meyer-cancer-center?type=Full-time+faculty",
    );
    render(<CenterMembersClient result={flatResult(1)} centerSlug="meyer-cancer-center" />);

    const chip = screen.getByRole("button", { name: /Full-time faculty/ });
    expect(chip.className).toContain("bg-[var(--color-accent-slate)]");
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
});
