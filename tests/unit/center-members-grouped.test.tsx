/**
 * #552 facet-sidebar follow-on — `CenterMembersClient` grouped layout: the left
 * facet sidebar (Program / Membership type / Department / Professorial rank) over
 * program-grouped sections, plus the existing Appointment (role) chip row.
 * Covered:
 *  - all three facets + Appointment render; a section per group; all members.
 *  - Program facet narrows to the selected program section(s).
 *  - Membership-type facet narrows to research/clinical (and hides when single-type, #1570).
 *  - Department facet narrows to a department.
 *  - Professorial-rank facet narrows to a rank (#1570).
 *  - Appointment chip composes with the facets and drops emptied sections.
 *  - "Clear" resets the sidebar facets.
 *  - Program facet hides when the center has a single program.
 * PersonRow is stubbed so the test targets the facet/grouping logic.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("@/components/department/person-row", () => ({
  // Surface the #962 chip labels so the chip-wiring can be asserted without the
  // real component; chips don't affect facet/grouping logic.
  PersonRow: ({
    hit,
    methodChips,
  }: {
    hit: { cwid: string; preferredName: string };
    methodChips?: Array<{ familyLabel: string }>;
  }) => (
    <div
      data-testid="person"
      data-cwid={hit.cwid}
      data-chips={(methodChips ?? []).map((c) => c.familyLabel).join("|")}
    >
      {hit.preferredName}
    </div>
  ),
}));

import { CenterMembersClient } from "@/components/center/center-members-client";
import type {
  CenterMemberFamily,
  CenterMembersResult,
  CenterMembershipType,
} from "@/lib/api/centers";

function fam(supercategory: string, label: string, pmidCount: number): CenterMemberFamily {
  return {
    value: `${supercategory}::${label}`,
    supercategory,
    familyLabel: label,
    pmidCount,
    exemplarTools: [],
  };
}

function hit(
  cwid: string,
  roleCategory: string,
  membershipType: CenterMembershipType,
  departmentName: string,
  methodFamilies?: CenterMemberFamily[],
  professorialRank: string | null = null,
) {
  return {
    cwid,
    preferredName: cwid.toUpperCase(),
    slug: cwid,
    primaryTitle: null,
    divisionName: null,
    departmentName,
    identityImageEndpoint: "",
    roleCategory,
    overview: null,
    professorialRank,
    pubCount: 0,
    grantCount: 0,
    membershipType,
    ...(methodFamilies
      ? { methodFamilies, topMethods: methodFamilies.slice(0, 3) }
      : {}),
  };
}

const FT = "Full-time faculty";
const AFF = "Affiliated faculty";

const grouped: CenterMembersResult = {
  mode: "grouped",
  total: 5,
  groups: [
    {
      code: "CB",
      label: "Cancer Biology",
      members: [hit("a", FT, "research", "Medicine"), hit("b", FT, "clinical", "Medicine")],
    },
    {
      code: "CT",
      label: "Cancer Therapeutics",
      members: [hit("c", FT, "research", "Pathology"), hit("d", AFF, "clinical", "Pathology")],
    },
    { code: null, label: "Other", members: [hit("e", AFF, "research", "Surgery")] },
  ],
};

const personCwids = () =>
  screen.getAllByTestId("person").map((el) => el.getAttribute("data-cwid"));

describe("CenterMembersClient — grouped facet sidebar (#552)", () => {
  it("renders the three facets + Appointment + a section per group", () => {
    render(<CenterMembersClient result={grouped} centerSlug="x" />);

    expect(screen.getByRole("heading", { name: "Program" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Membership type" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Department" })).toBeTruthy();
    expect(screen.getByText("Appointment")).toBeTruthy();

    // Anchored section headings + all five members on one page.
    expect(screen.getByRole("heading", { name: "Cancer Biology" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Other" })).toBeTruthy();
    expect(personCwids().sort()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("Program facet narrows to the selected program + drops the redundant header", () => {
    render(<CenterMembersClient result={grouped} centerSlug="x" />);
    fireEvent.click(screen.getByRole("button", { name: /Cancer Therapeutics/ }));

    expect(screen.queryByRole("heading", { name: "Cancer Biology" })).toBeNull();
    // Single program selected → the lone section header is suppressed (it would
    // just echo the active Program filter).
    expect(screen.queryByRole("heading", { name: "Cancer Therapeutics" })).toBeNull();
    expect(personCwids().sort()).toEqual(["c", "d"]);
  });

  it("Membership-type facet narrows to research/clinical", () => {
    render(<CenterMembersClient result={grouped} centerSlug="x" />);
    fireEvent.click(screen.getByRole("button", { name: /Clinical/ }));
    expect(personCwids().sort()).toEqual(["b", "d"]);
  });

  it("Department facet narrows to a department", () => {
    render(<CenterMembersClient result={grouped} centerSlug="x" />);
    fireEvent.click(screen.getByRole("button", { name: /Pathology/ }));
    expect(personCwids().sort()).toEqual(["c", "d"]);
  });

  it("Appointment chip composes with facets + drops emptied sections", () => {
    render(<CenterMembersClient result={grouped} centerSlug="x" />);
    fireEvent.click(screen.getByRole("button", { name: /Affiliated faculty/ }));

    // Cancer Biology (all full-time) drops; Therapeutics + Other keep affiliates.
    expect(screen.queryByRole("heading", { name: "Cancer Biology" })).toBeNull();
    expect(personCwids().sort()).toEqual(["d", "e"]);
  });

  it("Clear resets the sidebar facets", () => {
    render(<CenterMembersClient result={grouped} centerSlug="x" />);
    fireEvent.click(screen.getByRole("button", { name: /Cancer Therapeutics/ }));
    expect(personCwids().sort()).toEqual(["c", "d"]);

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(personCwids().sort()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("hides the Program facet when the center has a single program", () => {
    const single: CenterMembersResult = {
      mode: "grouped",
      total: 2,
      groups: [
        {
          code: "CB",
          label: "Cancer Biology",
          members: [hit("a", FT, "research", "Medicine"), hit("b", FT, "clinical", "Medicine")],
        },
      ],
    };
    render(<CenterMembersClient result={single} centerSlug="x" />);

    expect(screen.queryByRole("heading", { name: "Program" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Membership type" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Cancer Biology" })).toBeTruthy();
  });

  it("singleProgram (program page) hides the lone section header but keeps facets + members", () => {
    const single: CenterMembersResult = {
      mode: "grouped",
      total: 2,
      groups: [
        {
          code: "CB",
          label: "Cancer Biology",
          members: [hit("a", FT, "research", "Medicine"), hit("b", FT, "clinical", "Medicine")],
        },
      ],
    };
    render(<CenterMembersClient result={single} centerSlug="x" singleProgram />);

    // On a dedicated program page the section header would just echo the page
    // title, so it's suppressed; the facets + members still render.
    expect(screen.queryByRole("heading", { name: "Cancer Biology" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Membership type" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Department" })).toBeTruthy();
    expect(personCwids().sort()).toEqual(["a", "b"]);
  });

  it("hides the Membership-type facet when every member shares one type (#1570)", () => {
    const allResearch: CenterMembersResult = {
      mode: "grouped",
      total: 3,
      groups: [
        {
          code: "CB",
          label: "Cancer Biology",
          members: [hit("a", FT, "research", "Medicine"), hit("b", FT, "research", "Pathology")],
        },
        {
          code: "CT",
          label: "Cancer Therapeutics",
          members: [hit("c", AFF, "research", "Surgery")],
        },
      ],
    };
    render(<CenterMembersClient result={allResearch} centerSlug="x" />);

    // One-option facet can't filter anything → suppressed; the rest still render.
    expect(screen.queryByRole("heading", { name: "Membership type" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Program" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Department" })).toBeTruthy();
  });

  it("Professorial-rank facet renders last and narrows to the selected rank (#1570)", () => {
    const withRanks: CenterMembersResult = {
      mode: "grouped",
      total: 3,
      groups: [
        {
          code: "CB",
          label: "Cancer Biology",
          members: [
            hit("a", FT, "research", "Medicine", undefined, "Professor"),
            hit("b", FT, "research", "Medicine", undefined, "Assistant Professor"),
          ],
        },
        {
          code: "CT",
          label: "Cancer Therapeutics",
          members: [hit("c", FT, "research", "Pathology", undefined, "Professor")],
        },
      ],
    };
    render(<CenterMembersClient result={withRanks} centerSlug="x" />);

    // Renders, and after the (previously last) Department facet.
    expect(screen.getByRole("heading", { name: "Professorial rank" })).toBeTruthy();
    const headings = screen.getAllByRole("heading").map((h) => h.textContent);
    expect(headings.indexOf("Professorial rank")).toBeGreaterThan(
      headings.indexOf("Department"),
    );

    // Selecting "Professor" keeps the two Professors, drops the Assistant Professor.
    fireEvent.click(screen.getByRole("button", { name: /^Professor/ }));
    expect(personCwids().sort()).toEqual(["a", "c"]);
  });
});

const SC = "imaging_image_analysis";
const DL = fam(SC, "Deep learning", 12);
const MRI = fam(SC, "MRI", 6);
const SEQ = fam(SC, "Sequencing", 8);

// a: {DL, MRI}; b: {MRI}; c: {SEQ}; d: no families (flag off OR no public data).
const withMethods: CenterMembersResult = {
  mode: "grouped",
  total: 4,
  groups: [
    {
      code: "CB",
      label: "Cancer Biology",
      members: [
        hit("a", FT, "research", "Medicine", [DL, MRI]),
        hit("b", FT, "clinical", "Medicine", [MRI]),
      ],
    },
    {
      code: "CT",
      label: "Cancer Therapeutics",
      members: [
        hit("c", FT, "research", "Pathology", [SEQ]),
        hit("d", AFF, "clinical", "Pathology"),
      ],
    },
  ],
};

describe("CenterMembersClient — Methods & tools facet (#962)", () => {
  it("renders the facet + per-member chips when ≥1 member has public families", () => {
    render(<CenterMembersClient result={withMethods} centerSlug="x" />);

    expect(screen.getByRole("heading", { name: "Methods & tools" })).toBeTruthy();
    // #962 follow-up — Methods & tools ranks ABOVE Department in the sidebar.
    const facetHeadings = screen.getAllByRole("heading").map((h) => h.textContent);
    expect(facetHeadings.indexOf("Methods & tools")).toBeLessThan(
      facetHeadings.indexOf("Department"),
    );
    // Chips piped to PersonRow (top-N familyLabels) for the equipped members only.
    const chips = Object.fromEntries(
      screen
        .getAllByTestId("person")
        .map((el) => [el.getAttribute("data-cwid"), el.getAttribute("data-chips")]),
    );
    expect(chips.a).toBe("Deep learning|MRI");
    expect(chips.b).toBe("MRI");
    expect(chips.c).toBe("Sequencing");
    expect(chips.d).toBe(""); // no public families → no chips
  });

  it("is ABSENT when no member carries a family (flag off / no data)", () => {
    render(<CenterMembersClient result={grouped} centerSlug="x" />);
    expect(screen.queryByRole("heading", { name: "Methods & tools" })).toBeNull();
  });

  it("narrows rows to members with the selected family — OR within the facet", () => {
    render(<CenterMembersClient result={withMethods} centerSlug="x" />);
    // Selecting MRI keeps a (has {DL,MRI}) and b (has {MRI}); drops c, d.
    fireEvent.click(screen.getByRole("button", { name: /^MRI/ }));
    expect(personCwids().sort()).toEqual(["a", "b"]);
  });

  it("composes AND-across with the Organizational-unit facet", () => {
    render(<CenterMembersClient result={withMethods} centerSlug="x" />);
    fireEvent.click(screen.getByRole("button", { name: /^MRI/ })); // a, b
    fireEvent.click(screen.getByRole("button", { name: /Medicine/ })); // a, b (dept)
    expect(personCwids().sort()).toEqual(["a", "b"]);
  });

  it("Clear resets the Methods facet too", () => {
    render(<CenterMembersClient result={withMethods} centerSlug="x" />);
    fireEvent.click(screen.getByRole("button", { name: /^Sequencing/ }));
    expect(personCwids().sort()).toEqual(["c"]);

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(personCwids().sort()).toEqual(["a", "b", "c", "d"]);
  });
});

// --- #1105 program-page section-header links --------------------------------
describe("CenterMembersClient — program-page header links (#1105)", () => {
  it("links eligible program headers and skips Other / ZY when flag on", () => {
    const withOther: CenterMembersResult = {
      mode: "grouped",
      total: 3,
      groups: [
        { code: "CB", label: "Cancer Biology", members: [hit("a", FT, "research", "Medicine")] },
        { code: "ZY", label: "Non-aligned Clinical", members: [hit("z", FT, "clinical", "Medicine")] },
        { code: null, label: "Other", members: [hit("o", FT, "research", "Surgery")] },
      ],
    };
    render(
      <CenterMembersClient
        result={withOther}
        centerSlug="meyer-cancer-center"
        programPagesEnabled
      />,
    );
    const link = screen.getByRole("link", { name: "Cancer Biology" });
    expect(link.getAttribute("href")).toBe(
      "/centers/meyer-cancer-center/programs/CB",
    );
    // ZY and Other headers exist as plain text, not links.
    expect(screen.queryByRole("link", { name: "Non-aligned Clinical" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Other" })).toBeNull();
  });

  it("renders plain-text headers (no links) when the flag is off", () => {
    const two: CenterMembersResult = {
      mode: "grouped",
      total: 2,
      groups: [
        { code: "CB", label: "Cancer Biology", members: [hit("a", FT, "research", "Medicine")] },
        { code: "CT", label: "Cancer Therapeutics", members: [hit("c", FT, "research", "Pathology")] },
      ],
    };
    render(<CenterMembersClient result={two} centerSlug="meyer-cancer-center" />);
    expect(screen.queryByRole("link", { name: "Cancer Biology" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Cancer Biology" })).toBeTruthy();
  });
});
