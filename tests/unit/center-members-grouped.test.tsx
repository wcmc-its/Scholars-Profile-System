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
 *  - Institution facet (primaryOrgCode, #2695) narrows to an institution; hides when single-code.
 *  - Appointment chip composes with the facets and drops emptied sections.
 *  - "Clear" resets the sidebar facets.
 *  - Program facet hides when the center has a single program.
 * PersonRow is stubbed so the test targets the facet/grouping logic.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("@/components/department/person-row", () => ({
  // Surface the #962 chip labels so the chip-wiring can be asserted without the
  // real component; chips don't affect facet/grouping logic.
  PersonRow: ({
    hit,
    methodChips,
    meshChips,
    trailingBadge,
  }: {
    hit: { cwid: string; preferredName: string };
    methodChips?: Array<{ familyLabel: string }>;
    meshChips?: Array<{ label: string }>;
    trailingBadge?: ReactNode;
  }) => (
    <div
      data-testid="person"
      data-cwid={hit.cwid}
      data-chips={(methodChips ?? []).map((c) => c.familyLabel).join("|")}
      data-mesh={(meshChips ?? []).map((c) => c.label).join("|")}
    >
      {hit.preferredName}
      {trailingBadge}
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
  membershipType: CenterMembershipType | null,
  departmentName: string,
  methodFamilies?: CenterMemberFamily[],
  professorialRank: string | null = null,
  membershipRoleLabel: string | null = null,
  primaryOrgCode: string | null = null,
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
    primaryOrgCode,
    pubCount: 0,
    grantCount: 0,
    membershipType,
    membershipRoleLabel,
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
    fireEvent.click(screen.getByRole("checkbox", { name: /Cancer Therapeutics/ }));

    expect(screen.queryByRole("heading", { name: "Cancer Biology" })).toBeNull();
    // Single program selected → the lone section header is suppressed (it would
    // just echo the active Program filter).
    expect(screen.queryByRole("heading", { name: "Cancer Therapeutics" })).toBeNull();
    expect(personCwids().sort()).toEqual(["c", "d"]);
  });

  it("Membership-type facet narrows to research/clinical", () => {
    render(<CenterMembersClient result={grouped} centerSlug="x" />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Clinical/ }));
    expect(personCwids().sort()).toEqual(["b", "d"]);
  });

  it("Department facet narrows to a department", () => {
    render(<CenterMembersClient result={grouped} centerSlug="x" />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Pathology/ }));
    expect(personCwids().sort()).toEqual(["c", "d"]);
  });

  it("Appointment chip composes with facets + drops emptied sections", () => {
    render(<CenterMembersClient result={grouped} centerSlug="x" />);
    fireEvent.click(screen.getByRole("button", { name: /Affiliated faculty/ }));

    // Cancer Biology (all full-time) drops; Therapeutics + Other keep affiliates.
    expect(screen.queryByRole("heading", { name: "Cancer Biology" })).toBeNull();
    expect(personCwids().sort()).toEqual(["d", "e"]);
  });

  it("shows a visible 'Showing 1–N of N scholars' line that tracks the filters (Unit Page v2)", () => {
    render(<CenterMembersClient result={grouped} centerSlug="x" />);
    expect(screen.getByText("Showing 1–5 of 5 scholars")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /Pathology/ }));
    expect(screen.getByText("Showing 1–2 of 2 scholars")).toBeTruthy();
  });

  it("program headers show the program's TOTAL size while facets narrow it (Unit Page v2)", () => {
    render(<CenterMembersClient result={grouped} centerSlug="x" />);
    // Cancer Biology has 2 members (a, b); the Clinical facet narrows it to b.
    fireEvent.click(screen.getByRole("checkbox", { name: /Clinical/ }));
    const header = screen.getByRole("heading", { name: "Cancer Biology" }).parentElement!;
    expect(header.textContent).toContain("2 members");
  });

  it("empty state offers 'Clear filters', which also resets the Appointment chip", () => {
    render(<CenterMembersClient result={grouped} centerSlug="x" />);
    fireEvent.click(screen.getByRole("checkbox", { name: /^Pathology/ })); // c, d
    fireEvent.click(screen.getByRole("checkbox", { name: /^Research/ })); // c
    fireEvent.click(screen.getByRole("button", { name: /Affiliated faculty/ })); // none
    expect(screen.getByText(/No scholars match these filters\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(personCwids().sort()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("Clear resets the sidebar facets", () => {
    render(<CenterMembersClient result={grouped} centerSlug="x" />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Cancer Therapeutics/ }));
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

  it("Professorial-rank facet renders after Department and narrows to the selected rank (#1570)", () => {
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
    fireEvent.click(screen.getByRole("checkbox", { name: /^Professor/ }));
    expect(personCwids().sort()).toEqual(["a", "c"]);
  });

  it("Institution facet renders after Professorial rank + narrows to a code (#2695)", () => {
    const withInsts: CenterMembersResult = {
      mode: "grouped",
      total: 4,
      groups: [
        {
          code: "CB",
          label: "Cancer Biology",
          members: [
            hit("a", FT, "research", "Medicine", undefined, "Professor", null, "WCMC"),
            hit("b", FT, "research", "Medicine", undefined, "Assistant Professor", null, "HSS"),
          ],
        },
        {
          code: "CT",
          label: "Cancer Therapeutics",
          members: [
            hit("c", FT, "research", "Pathology", undefined, "Professor", null, "MSKCC"),
            hit("d", FT, "research", "Pathology", undefined, "Professor", null, "WCMC"),
          ],
        },
      ],
    };
    render(<CenterMembersClient result={withInsts} centerSlug="x" />);

    const headings = screen.getAllByRole("heading").map((h) => h.textContent);
    expect(headings.indexOf("Institution")).toBeGreaterThan(
      headings.indexOf("Professorial rank"),
    );
    // Three options, count-desc, labelled via institutionDisplayName (home → WCM).
    const wcm = screen.getByRole("checkbox", { name: /^Weill Cornell Medicine/ });
    expect(wcm.closest("li")!.textContent).toContain("2");
    const hss = screen.getByRole("checkbox", { name: /^Hospital for Special Surgery/ });
    expect(hss.closest("li")!.textContent).toContain("1");
    expect(
      screen.getByRole("checkbox", { name: /^Memorial Sloan Kettering/ }).closest("li")!
        .textContent,
    ).toContain("1");

    fireEvent.click(hss);
    expect(personCwids()).toEqual(["b"]);
  });

  it("hides the Institution facet when every member shares one code (#2695)", () => {
    const sameInst: CenterMembersResult = {
      mode: "grouped",
      total: 2,
      groups: [
        {
          code: "CB",
          label: "Cancer Biology",
          members: [
            hit("a", FT, "research", "Medicine", undefined, "Professor", null, "WCMC"),
            hit("b", FT, "research", "Pathology", undefined, "Assistant Professor", null, "WCMC"),
          ],
        },
      ],
    };
    render(<CenterMembersClient result={sameInst} centerSlug="x" />);
    expect(screen.queryByRole("heading", { name: "Institution" })).toBeNull();
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
    fireEvent.click(screen.getByRole("checkbox", { name: /^MRI/ }));
    expect(personCwids().sort()).toEqual(["a", "b"]);
  });

  it("composes AND-across with the Organizational-unit facet", () => {
    render(<CenterMembersClient result={withMethods} centerSlug="x" />);
    fireEvent.click(screen.getByRole("checkbox", { name: /^MRI/ })); // a, b
    fireEvent.click(screen.getByRole("checkbox", { name: /Medicine/ })); // a, b (dept)
    expect(personCwids().sort()).toEqual(["a", "b"]);
  });

  it("Clear resets the Methods facet too", () => {
    render(<CenterMembersClient result={withMethods} centerSlug="x" />);
    fireEvent.click(screen.getByRole("checkbox", { name: /^Sequencing/ }));
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

  it("CHPC fellows — a vocabulary membership-role label renders as a badge, and never doubles up with Research/Clinical", () => {
    const withRoleLabel: CenterMembersResult = {
      mode: "grouped",
      total: 3,
      groups: [
        {
          code: "CB",
          label: "Cancer Biology",
          members: [
            hit("fellow", FT, null, "Medicine", undefined, null, "Core Faculty Fellow"),
            hit("researcher", FT, "research", "Medicine"),
            hit("plain", FT, null, "Medicine", undefined, null, null),
          ],
        },
      ],
    };
    render(<CenterMembersClient result={withRoleLabel} centerSlug="x" />);

    const rows = screen.getAllByTestId("person");
    const byId = new Map(rows.map((el) => [el.getAttribute("data-cwid"), el]));
    expect(byId.get("fellow")?.textContent).toContain("Core Faculty Fellow");
    expect(byId.get("fellow")?.textContent).not.toContain("Research");
    expect(byId.get("researcher")?.textContent).toContain("Research");
    expect(byId.get("plain")?.textContent).not.toContain("Research");
    expect(byId.get("plain")?.textContent).not.toContain("Core Faculty Fellow");
  });
});

describe("CenterMembersClient — grouped roster toolbar (Unit Page v2)", () => {
  const named = (
    cwid: string,
    preferredName: string,
    pubCount: number,
    primaryTitle: string | null = null,
  ) => ({ ...hit(cwid, FT, "research", "Medicine"), preferredName, pubCount, primaryTitle });
  const result: CenterMembersResult = {
    mode: "grouped",
    total: 5,
    groups: [
      {
        code: "CB",
        label: "Cancer Biology",
        members: [named("g1", "Amy Zimmer", 1), named("g2", "Zed Adams", 30)],
      },
      {
        code: "CT",
        label: "Cancer Therapeutics",
        members: [
          named("g3", "Bo Young", 5, "Chief of Oncology"),
          named("g4", "Cy Baker", 9),
          named("g5", "José Moreno", 2),
        ],
      },
    ],
  };
  const sectionHeads = (root: HTMLElement) =>
    within(root)
      .getAllByRole("heading", { level: 2 })
      .map((h) => h.textContent);
  const cwidsIn = (root: HTMLElement) =>
    within(root)
      .getAllByTestId("person")
      .map((el) => el.getAttribute("data-cwid"));

  it("renders the filter input and defaults to surname order within each section", () => {
    window.history.replaceState(null, "", "/centers/x");
    const { container } = render(<CenterMembersClient result={result} centerSlug="x" />);
    expect(
      within(container).getByRole("searchbox", { name: "Filter scholars by name or title" }),
    ).toBeTruthy();
    expect(within(container).getByRole("combobox", { name: "Sort" })).toBeTruthy();
    expect(cwidsIn(container)).toEqual(["g2", "g1", "g4", "g5", "g3"]);
  });

  it("sort=pubs ranks rows WITHIN each section; section order stays fixed", () => {
    window.history.replaceState(null, "", "/centers/x");
    const { container } = render(
      <CenterMembersClient result={result} centerSlug="x" initialSort="pubs" />,
    );
    expect(sectionHeads(container)).toEqual(["Cancer Biology", "Cancer Therapeutics"]);
    expect(cwidsIn(container)).toEqual(["g2", "g1", "g4", "g3", "g5"]);
  });

  it("the name/title filter hides emptied sections and is accent-blind", () => {
    window.history.replaceState(null, "", "/centers/x");
    const { container } = render(<CenterMembersClient result={result} centerSlug="x" />);
    const input = within(container).getByRole("searchbox");
    fireEvent.change(input, { target: { value: "jose" } });
    expect(cwidsIn(container)).toEqual(["g5"]);
    expect(sectionHeads(container)).toEqual(["Cancer Therapeutics"]);
    expect(within(container).getByText(/Showing 1–1 of 1 scholar$/)).toBeTruthy();
    expect(window.location.search).toContain("q=jose");

    fireEvent.change(input, { target: { value: "oncology" } });
    expect(cwidsIn(container)).toEqual(["g3"]);
  });

  it("seeds ?q= and ?sort= from the URL (the program page reads neither server-side)", () => {
    window.history.replaceState(null, "", "/centers/x/programs/CT?sort=pubs&q=er");
    const { container } = render(<CenterMembersClient result={result} centerSlug="x" />);
    expect((within(container).getByRole("searchbox") as HTMLInputElement).value).toBe("er");
    expect(cwidsIn(container)).toEqual(["g1", "g4"]);
    // …and sort=pubs is live: with the query cleared, rows rank by pub count.
    fireEvent.change(within(container).getByRole("searchbox"), { target: { value: "" } });
    expect(cwidsIn(container)).toEqual(["g2", "g1", "g4", "g3", "g5"]);
  });

  it("Clear filters (empty state) resets the name filter too", () => {
    window.history.replaceState(null, "", "/centers/x");
    const { container } = render(<CenterMembersClient result={result} centerSlug="x" />);
    const input = within(container).getByRole("searchbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "nobody-matches" } });
    fireEvent.click(within(container).getByRole("button", { name: "Clear filters" }));
    expect(input.value).toBe("");
    expect(cwidsIn(container)).toHaveLength(5);
  });
});

describe("CenterMembersClient — TOPICS (MeSH) chips, Unit Page v2", () => {
  it("passes each grouped member's `topMesh` to its row", () => {
    const withMesh: CenterMembersResult = {
      mode: "grouped",
      total: 2,
      groups: [
        {
          code: "CB",
          label: "Cancer Biology",
          members: [
            { ...hit("a", FT, "research", "Medicine"), topMesh: [{ ui: "D000001", label: "Alpha" }] },
            hit("b", FT, "clinical", "Medicine"),
          ],
        },
      ],
    };
    const { container } = render(<CenterMembersClient result={withMesh} centerSlug="x" />);
    const mesh = Object.fromEntries(
      within(container)
        .getAllByTestId("person")
        .map((el) => [el.getAttribute("data-cwid"), el.getAttribute("data-mesh")]),
    );
    expect(mesh.a).toBe("Alpha");
    expect(mesh.b).toBe("");
  });
});
