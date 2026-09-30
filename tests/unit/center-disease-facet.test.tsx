/**
 * D1 — the public center roster's "Disease focus" facet (`DiseaseFocusFacet`
 * inside `CenterMembersClient`'s grouped roster):
 *  - absent when no member carries published diseases;
 *  - placed after Program and before Membership type;
 *  - counts per disease, sorted count desc; top 8 then "Show all N" / "Show fewer";
 *  - "Primary focus" recomputes counts over focus === "primary" only;
 *  - "Search diseases…" filters the options;
 *  - selecting filters the roster (OR within, AND with other facets);
 *  - the DISEASES card row is wired from `m.diseases`.
 * PersonRow is stubbed so the test targets the facet logic.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("@/components/department/person-row", () => ({
  PersonRow: ({
    hit,
    diseaseRow,
  }: {
    hit: { cwid: string; preferredName: string };
    diseaseRow?: ReactNode;
  }) => (
    <div data-testid="person" data-cwid={hit.cwid}>
      {hit.preferredName}
      {diseaseRow}
    </div>
  ),
}));

import { CenterMembersClient } from "@/components/center/center-members-client";
import type { CenterMembersResult } from "@/lib/api/centers";
import type { CenterMemberDisease } from "@/lib/center-member-diseases";

function dz(code: string, focus: string | null, rank: number | null = 1): CenterMemberDisease {
  return { diseaseCode: code, label: `${code} label`, focus, rank };
}

function hit(
  cwid: string,
  membershipType: "research" | "clinical",
  diseases?: CenterMemberDisease[],
) {
  return {
    cwid,
    preferredName: cwid.toUpperCase(),
    slug: cwid,
    primaryTitle: null,
    divisionName: null,
    departmentName: "Medicine",
    identityImageEndpoint: "",
    roleCategory: "Full-time faculty",
    overview: null,
    professorialRank: null,
    primaryOrgCode: null,
    pubCount: 0,
    grantCount: 0,
    membershipType,
    membershipRoleLabel: null,
    ...(diseases ? { diseases } : {}),
  };
}

// d1..d10 each appear once on member x (so x has 10); BREAST appears on a,b,c.
const MANY = Array.from({ length: 10 }, (_, i) => dz(`D${i + 1}`, "secondary", i + 1));

const grouped: CenterMembersResult = {
  mode: "grouped",
  total: 5,
  groups: [
    {
      code: "P1",
      label: "Program One",
      members: [
        hit("a", "research", [dz("BREAST", "primary"), dz("LUNG", "secondary", 2)]),
        hit("b", "clinical", [dz("BREAST", "secondary"), dz("LUNG", "primary", 2)]),
      ],
    },
    {
      code: "P2",
      label: "Program Two",
      members: [
        hit("c", "research", [dz("BREAST", null, null)]),
        hit("x", "clinical", MANY),
        hit("n", "research"),
      ],
    },
  ],
};

const personCwids = () =>
  screen.getAllByTestId("person").map((el) => el.getAttribute("data-cwid")).sort();

function facet() {
  const heading = screen.getByRole("heading", { name: "Disease focus" });
  return heading.closest("div.flex.flex-col") as HTMLElement;
}

function countFor(label: string): string | null {
  const cb = within(facet()).getByRole("checkbox", { name: new RegExp(`^${label} `) });
  return cb.getAttribute("aria-labelledby")
    ? document.getElementById(cb.getAttribute("aria-labelledby")!.split(" ")[1])!.textContent
    : null;
}

beforeEach(() => {
  window.history.replaceState(null, "", "/centers/x");
});

describe("Disease focus facet", () => {
  it("is absent when no member has published diseases", () => {
    const bare: CenterMembersResult = {
      mode: "grouped",
      total: 2,
      groups: [
        { code: "P1", label: "Program One", members: [hit("a", "research")] },
        { code: "P2", label: "Program Two", members: [hit("b", "clinical")] },
      ],
    };
    render(<CenterMembersClient result={bare} centerSlug="x" />);
    expect(screen.queryByRole("heading", { name: "Disease focus" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Program" })).toBeTruthy();
  });

  it("sits after Program and before Membership type, with info + scope toggle", () => {
    render(<CenterMembersClient result={grouped} centerSlug="x" />);
    const headings = screen
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent);
    const i = headings.indexOf("Disease focus");
    expect(headings[i - 1]).toBe("Program");
    expect(headings[i + 1]).toBe("Membership type");
    expect(screen.getByRole("button", { name: "About Disease focus" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Any involvement" }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("counts each disease, sorted count desc, top 8 then Show all / Show fewer", () => {
    render(<CenterMembersClient result={grouped} centerSlug="x" />);
    const labels = () =>
      within(facet())
        .getAllByRole("checkbox")
        .map((cb) => document.getElementById(cb.id + "-label")!.textContent);
    // 12 options: BREAST(3), LUNG(2), D1..D10(1)
    expect(labels()).toHaveLength(8);
    expect(labels()[0]).toBe("BREAST label");
    expect(labels()[1]).toBe("LUNG label");
    expect(countFor("BREAST label")).toBe("3");
    fireEvent.click(within(facet()).getByRole("button", { name: /Show all 12/ }));
    expect(labels()).toHaveLength(12);
    fireEvent.click(within(facet()).getByRole("button", { name: /Show fewer/ }));
    expect(labels()).toHaveLength(8);
  });

  it("Primary focus recounts over primary-focus diseases only", () => {
    render(<CenterMembersClient result={grouped} centerSlug="x" />);
    fireEvent.click(screen.getByRole("radio", { name: "Primary focus" }));
    expect(screen.getByRole("radio", { name: "Primary focus" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    // BREAST primary only on a (c's manual add has no focus); LUNG primary only on b.
    expect(countFor("BREAST label")).toBe("1");
    expect(countFor("LUNG label")).toBe("1");
  });

  it("Search diseases… filters the option list", () => {
    render(<CenterMembersClient result={grouped} centerSlug="x" />);
    fireEvent.change(screen.getByPlaceholderText("Search diseases…"), {
      target: { value: "lung" },
    });
    const boxes = within(facet()).getAllByRole("checkbox");
    expect(boxes).toHaveLength(1);
    expect(document.getElementById(boxes[0].id + "-label")!.textContent).toBe("LUNG label");
  });

  it("filters the roster: OR within the facet, AND with Membership type, scope-aware", () => {
    render(<CenterMembersClient result={grouped} centerSlug="x" />);
    const toggle = (label: string) =>
      fireEvent.click(within(facet()).getByRole("checkbox", { name: new RegExp(`^${label} `) }));

    toggle("BREAST label");
    expect(personCwids()).toEqual(["a", "b", "c"]);
    toggle("LUNG label");
    expect(personCwids()).toEqual(["a", "b", "c"]);

    // AND with Membership type = Clinical
    const typeFacet = screen
      .getByRole("heading", { name: "Membership type" })
      .closest("div.flex.flex-col") as HTMLElement;
    fireEvent.click(within(typeFacet).getByRole("checkbox", { name: /^Clinical / }));
    expect(personCwids()).toEqual(["b"]);
    fireEvent.click(within(typeFacet).getByRole("checkbox", { name: /^Clinical / }));

    // Primary scope: BREAST|LUNG primary → a (BREAST) and b (LUNG); c's manual add drops.
    fireEvent.click(screen.getByRole("radio", { name: "Primary focus" }));
    expect(personCwids()).toEqual(["a", "b"]);
  });

  it("wires the DISEASES card row for members with diseases only", () => {
    render(<CenterMembersClient result={grouped} centerSlug="x" />);
    const rowOf = (cwid: string) =>
      screen.getAllByTestId("person").find((el) => el.getAttribute("data-cwid") === cwid)!;
    expect(within(rowOf("a")).getByText("DISEASES")).toBeTruthy();
    expect(within(rowOf("n")).queryByText("DISEASES")).toBeNull();
  });
});
