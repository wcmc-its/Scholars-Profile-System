/**
 * #552 program-nav follow-up — `CenterMembersClient` grouped layout: the sticky
 * PROGRAM scroll-spy nav + APPOINTMENT filter. Covers the locked decisions:
 *  - PROGRAM row is navigation only; shown only when ≥2 sections exist.
 *  - APPOINTMENT filter reshapes the program sections AND their chip counts —
 *    sections (and their nav chips) that empty out under the filter drop.
 *  - "Other" renders as a section/chip.
 * PersonRow is stubbed so the test targets the grouping/filter logic, not the
 * person-row internals.
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
import type { CenterMembersResult } from "@/lib/api/centers";

function hit(cwid: string, roleCategory: string) {
  return {
    cwid,
    preferredName: cwid.toUpperCase(),
    slug: cwid,
    primaryTitle: null,
    divisionName: null,
    departmentName: "Dept",
    identityImageEndpoint: "",
    roleCategory,
    overview: null,
    pubCount: 0,
    grantCount: 0,
  };
}

const FT = "Full-time faculty";
const AFF = "Affiliated faculty";

const grouped: CenterMembersResult = {
  mode: "grouped",
  total: 5,
  groups: [
    { label: "Cancer Biology", members: [hit("a", FT), hit("b", FT)] },
    { label: "Cancer Therapeutics", members: [hit("c", FT), hit("d", AFF)] },
    { label: "Other", members: [hit("e", AFF)] },
  ],
};

const personCwids = () =>
  screen.getAllByTestId("person").map((el) => el.getAttribute("data-cwid"));

describe("CenterMembersClient — grouped program nav (#552)", () => {
  it("renders the PROGRAM nav + APPOINTMENT row + a section per group", () => {
    render(<CenterMembersClient result={grouped} centerSlug="x" />);

    expect(screen.getByText("Program")).toBeTruthy();
    expect(screen.getByText("Appointment")).toBeTruthy();

    // Program nav chips (buttons) for each section.
    expect(screen.getByRole("button", { name: /Cancer Biology/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Cancer Therapeutics/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Other/ })).toBeTruthy();

    // Anchored section headings.
    expect(screen.getByRole("heading", { name: "Cancer Biology" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Other" })).toBeTruthy();

    // All 5 members render (single page, no pagination).
    expect(personCwids().sort()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("APPOINTMENT filter reshapes sections + drops emptied ones (decision 2)", () => {
    render(<CenterMembersClient result={grouped} centerSlug="x" />);

    fireEvent.click(screen.getByRole("button", { name: /Affiliated faculty/ }));

    // Cancer Biology (all full-time) drops entirely — section AND nav chip.
    expect(screen.queryByRole("heading", { name: "Cancer Biology" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Cancer Biology/ })).toBeNull();

    // Cancer Therapeutics keeps only its affiliated member; Other keeps its.
    expect(screen.getByRole("heading", { name: "Cancer Therapeutics" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Other" })).toBeTruthy();
    expect(personCwids().sort()).toEqual(["d", "e"]);
  });

  it("hides the PROGRAM nav when there is only one section", () => {
    const single: CenterMembersResult = {
      mode: "grouped",
      total: 2,
      groups: [{ label: "Cancer Biology", members: [hit("a", FT), hit("b", FT)] }],
    };
    render(<CenterMembersClient result={single} centerSlug="x" />);

    expect(screen.queryByText("Program")).toBeNull(); // no nav
    expect(screen.getByText("Appointment")).toBeTruthy(); // filter still shown
    expect(screen.getByRole("heading", { name: "Cancer Biology" })).toBeTruthy();
  });
});
