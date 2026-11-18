/**
 * Vice Chairs on PUBLIC pages: the department page list and the profile title
 * lines.
 *
 *  - a holder who is not publicly displayed (hidden class, deleted, inactive)
 *    never appears on the department page;
 *  - tier order, Executive first; site-based roles grouped under their site;
 *  - the profile line appends the department unless the title already names
 *    it, and skips `showOnProfile = false` rows (filtered in the query).
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { ViceChairsList } from "@/components/department/vice-chairs-list";
import {
  loadProfileViceChairTitles,
  loadPublicViceChairs,
  viceChairTitleLine,
} from "@/lib/api/unit-leadership-roles";

const holder = (over: Record<string, unknown> = {}) => ({
  preferredName: "Ann Example",
  slug: "ann-example",
  roleCategory: "full_time_faculty",
  deletedAt: null,
  status: "active",
  ...over,
});

describe("loadPublicViceChairs", () => {
  it("orders by tier then name and drops holders who are not public", async () => {
    const findMany = vi.fn().mockResolvedValue([
      { cwid: "c1", displayTitle: "Vice Chair for Research", tier: "vice", site: null, scholar: holder({ preferredName: "Zed" }) },
      { cwid: "c2", displayTitle: "Executive Vice Chair", tier: "executive", site: null, scholar: holder({ preferredName: "Yan" }) },
      { cwid: "c3", displayTitle: "Vice Chair of Education", tier: "vice", site: null, scholar: holder({ preferredName: "Abe" }) },
      { cwid: "c4", displayTitle: "Vice Chair", tier: "vice", site: null, scholar: holder({ deletedAt: new Date() }) },
      { cwid: "c5", displayTitle: "Vice Chair", tier: "vice", site: null, scholar: holder({ status: "suppressed" }) },
      { cwid: "c6", displayTitle: "Vice Chair", tier: "vice", site: null, scholar: holder({ roleCategory: "doctoral_student" }) },
    ]);
    const out = await loadPublicViceChairs("N1", { unitLeadershipRole: { findMany } } as never);
    expect(out.map((v) => v.cwid)).toEqual(["c2", "c3", "c1"]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { entityType: "department", entityId: "N1" } }),
    );
  });
});

describe("viceChairTitleLine", () => {
  it.each([
    ["Vice Chair for Research", "Vice Chair for Research, Weill Department of Medicine"],
    ["Vice Chair, Weill Department of Medicine", "Vice Chair, Weill Department of Medicine"],
    ["Vice Chair (Department of Medicine)", "Vice Chair (Department of Medicine)"],
    ["Vice Chair of Medicine", "Vice Chair of Medicine"],
  ])("%s", (title, line) => {
    expect(viceChairTitleLine(title, "Weill Department of Medicine", "Medicine")).toBe(line);
  });
});

describe("loadProfileViceChairTitles", () => {
  it("reads only showOnProfile rows and orders by tier", async () => {
    const roleFindMany = vi.fn().mockResolvedValue([
      { entityId: "N1", displayTitle: "Vice Chair, Research", tier: "vice" },
      { entityId: "N1", displayTitle: "Executive Vice Chair", tier: "executive" },
      { entityId: "GONE", displayTitle: "Vice Chair", tier: "vice" },
    ]);
    const deptFindMany = vi.fn().mockResolvedValue([{ code: "N1", name: "Psychiatry", officialName: null }]);
    const out = await loadProfileViceChairTitles("c1", {
      unitLeadershipRole: { findMany: roleFindMany },
      department: { findMany: deptFindMany },
    } as never);
    expect(out).toEqual(["Executive Vice Chair, Psychiatry", "Vice Chair, Research, Psychiatry"]);
    expect(roleFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { cwid: "c1", entityType: "department", showOnProfile: true } }),
    );
  });

  it("makes no department query for a scholar with no roles", async () => {
    const deptFindMany = vi.fn();
    const out = await loadProfileViceChairTitles("c1", {
      unitLeadershipRole: { findMany: vi.fn().mockResolvedValue([]) },
      department: { findMany: deptFindMany },
    } as never);
    expect(out).toEqual([]);
    expect(deptFindMany).not.toHaveBeenCalled();
  });
});

describe("ViceChairsList", () => {
  const v = (cwid: string, preferredName: string, displayTitle: string, site: string | null = null) =>
    ({ cwid, preferredName, slug: cwid, displayTitle, tier: "vice", site }) as never;

  it("uses two columns only for a list of six or more", () => {
    const many = Array.from({ length: 6 }, (_, i) => v(`c${i}`, `Person ${i}`, "Vice Chair"));
    const { container, rerender } = render(<ViceChairsList viceChairs={many} />);
    expect(container.querySelector("ul")?.getAttribute("data-columns")).toBe("2");
    expect(container.querySelector("ul")?.className).toContain("lg:columns-2");
    rerender(<ViceChairsList viceChairs={many.slice(0, 5)} />);
    expect(container.querySelector("ul")?.getAttribute("data-columns")).toBe("1");
  });

  it("renders nothing for an empty list", () => {
    const { container } = render(<ViceChairsList viceChairs={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("lists names linked to profiles with the published title, site roles under their site", () => {
    render(
      <ViceChairsList
        viceChairs={[
          v("c1", "Ann Example", "Vice Chair for Research"),
          v("c2", "Sam Site", "Vice Chair, Weill Department of Medicine", "nyp_queens"),
        ]}
      />,
    );
    const section = screen.getByTestId("vice-chairs");
    expect(section.textContent).toContain("Ann Example, Vice Chair for Research");
    expect(screen.getByText("NewYork-Presbyterian Queens").tagName).toBe("H3");
    const link = screen.getByText("Sam Site").closest("a");
    expect(link?.getAttribute("href")).toContain("c2");
    // The site heading comes after the general list.
    expect(section.textContent?.indexOf("Ann Example")).toBeLessThan(section.textContent!.indexOf("NewYork-Presbyterian Queens"));
  });
});
