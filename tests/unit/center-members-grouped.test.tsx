/**
 * #552 facet-sidebar follow-on — `CenterMembersClient` grouped layout: the left
 * facet sidebar (Program / Membership type / Organizational unit) over
 * program-grouped sections, plus the existing Appointment (role) chip row.
 * Covered:
 *  - all three facets + Appointment render; a section per group; all members.
 *  - Program facet narrows to the selected program section(s).
 *  - Membership-type facet narrows to research/clinical.
 *  - Organizational-unit facet narrows to a department.
 *  - Appointment chip composes with the facets and drops emptied sections.
 *  - "Clear" resets the sidebar facets.
 *  - Program facet hides when the center has a single program.
 * PersonRow is stubbed so the test targets the facet/grouping logic.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("@/components/department/person-row", () => ({
  PersonRow: ({ hit }: { hit: { cwid: string; preferredName: string } }) => (
    <div data-testid="person" data-cwid={hit.cwid}>
      {hit.preferredName}
    </div>
  ),
}));

import { CenterMembersClient } from "@/components/center/center-members-client";
import type { CenterMembersResult, CenterMembershipType } from "@/lib/api/centers";

function hit(
  cwid: string,
  roleCategory: string,
  membershipType: CenterMembershipType,
  departmentName: string,
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
    pubCount: 0,
    grantCount: 0,
    membershipType,
  };
}

const FT = "Full-time faculty";
const AFF = "Affiliated faculty";

const grouped: CenterMembersResult = {
  mode: "grouped",
  total: 5,
  groups: [
    {
      label: "Cancer Biology",
      members: [hit("a", FT, "research", "Medicine"), hit("b", FT, "clinical", "Medicine")],
    },
    {
      label: "Cancer Therapeutics",
      members: [hit("c", FT, "research", "Pathology"), hit("d", AFF, "clinical", "Pathology")],
    },
    { label: "Other", members: [hit("e", AFF, "research", "Surgery")] },
  ],
};

const personCwids = () =>
  screen.getAllByTestId("person").map((el) => el.getAttribute("data-cwid"));

describe("CenterMembersClient — grouped facet sidebar (#552)", () => {
  it("renders the three facets + Appointment + a section per group", () => {
    render(<CenterMembersClient result={grouped} centerSlug="x" />);

    expect(screen.getByRole("heading", { name: "Program" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Membership type" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Organizational unit" })).toBeTruthy();
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

  it("Organizational-unit facet narrows to a department", () => {
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
});
