/**
 * D1 — the public center card's DISEASES row (`CenterDiseaseRow`), and its
 * placement ABOVE the TOPICS row via `PersonRow`'s `diseaseRow` slot.
 */
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";

import { CenterDiseaseRow } from "@/components/center/center-disease-row";
import { PersonRow } from "@/components/department/person-row";
import type { CenterMemberDisease } from "@/lib/center-member-diseases";

function dz(code: string, focus: string | null, rank: number | null): CenterMemberDisease {
  return { diseaseCode: code, label: `${code} label`, focus, rank };
}

describe("CenterDiseaseRow", () => {
  it("renders nothing when there are no diseases", () => {
    const { container } = render(<CenterDiseaseRow diseases={[]} />);
    expect(container.innerHTML).toBe("");
    const { container: c2 } = render(<CenterDiseaseRow />);
    expect(c2.innerHTML).toBe("");
  });

  it("highlights primary-focus chips with the slate tint; others outlined", () => {
    render(
      <CenterDiseaseRow diseases={[dz("BREAST", "primary", 1), dz("LUNG", "secondary", 2)]} />,
    );
    const list = screen.getByRole("list", { name: "Disease focus" });
    const [primary, other] = within(list).getAllByRole("listitem").map((li) => li.firstElementChild!);
    expect(primary.textContent).toBe("BREAST label");
    expect(primary.getAttribute("data-focus")).toBe("primary");
    expect(primary.className).toContain("bg-apollo-slate-tint");
    expect(primary.className).toContain("border-apollo-slate-tint-border");
    expect(other.getAttribute("data-focus")).toBe("other");
    expect(other.className).not.toContain("bg-apollo-slate-tint");
    expect(other.className).toContain("border-apollo-slate");
    // Chips are not links.
    expect(within(list).queryAllByRole("link")).toHaveLength(0);
  });

  it("caps at 3 chips then '+N more'", () => {
    render(
      <CenterDiseaseRow
        diseases={[
          dz("A", "primary", 1),
          dz("B", "secondary", 2),
          dz("C", "secondary", 3),
          dz("D", "peripheral", 4),
          dz("E", null, null),
        ]}
      />,
    );
    expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByText("+2 more")).toBeTruthy();
  });

  it("shows no '+N more' at or under the cap", () => {
    render(<CenterDiseaseRow diseases={[dz("A", "primary", 1), dz("B", "secondary", 2)]} />);
    expect(screen.queryByText(/more$/)).toBeNull();
  });
});

describe("PersonRow diseaseRow slot", () => {
  const hit = {
    cwid: "m1",
    preferredName: "Test Member",
    slug: "test-member",
    primaryTitle: null,
    divisionName: null,
    departmentName: "Medicine",
    identityImageEndpoint: "",
    roleCategory: "Full-time faculty",
    roleCategoryRaw: "full_time_faculty",
    overview: null,
    pubCount: 0,
    grantCount: 0,
  };

  it("renders the DISEASES row above the TOPICS row", () => {
    const { container } = render(
      <PersonRow
        hit={hit}
        meshChips={[{ ui: "D001", label: "Topic One" }]}
        diseaseRow={<CenterDiseaseRow diseases={[dz("BREAST", "primary", 1)]} />}
      />,
    );
    const text = container.textContent ?? "";
    expect(text.indexOf("DISEASES")).toBeGreaterThan(-1);
    expect(text.indexOf("TOPICS")).toBeGreaterThan(text.indexOf("DISEASES"));
  });

  it("renders no DISEASES row when the slot is omitted (department cards)", () => {
    const { container } = render(
      <PersonRow hit={hit} meshChips={[{ ui: "D001", label: "Topic One" }]} />,
    );
    expect(container.textContent).not.toContain("DISEASES");
    expect(container.textContent).toContain("TOPICS");
  });
});
