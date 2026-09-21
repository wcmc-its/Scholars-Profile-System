/**
 * People result card — the non-WCMC primary institution joins the department
 * line (absence-as-default, like the profile header and popover); a WCM
 * scholar's card is byte-identical to before.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/components/scholar/headshot-avatar", () => ({
  HeadshotAvatar: () => <div data-testid="avatar" />,
}));

import { PeopleResultCard } from "@/components/search/people-result-card";
import type { PeopleHit } from "@/lib/api/search";

function makeHit(overrides: Partial<PeopleHit>): PeopleHit {
  return {
    cwid: "abc1234",
    slug: "jane-doe",
    preferredName: "Jane Doe",
    primaryTitle: "Professor of Medicine",
    primaryDepartment: "Medicine",
    deptName: "Medicine",
    divisionName: null,
    roleCategory: "full_time_faculty",
    pubCount: 100,
    grantCount: 0,
    hasActiveGrants: false,
    identityImageEndpoint: "https://example.com/abc1234.png",
    evidence: { kind: "none" },
    ...overrides,
  };
}

const baseProps = {
  q: "",
  position: 0,
  total: 1,
  filters: { deptDiv: [], personType: [], activity: [] },
};

describe("PeopleResultCard — primary institution on the department line", () => {
  it("appends the institution for a non-WCMC scholar", () => {
    render(<PeopleResultCard hit={makeHit({ primaryOrgCode: "HSS" })} {...baseProps} />);
    expect(
      screen.getByText("Department of Medicine · Hospital for Special Surgery"),
    ).toBeTruthy();
  });

  it("renders a WCMC scholar (and a hit without the field) unchanged", () => {
    const { unmount } = render(
      <PeopleResultCard hit={makeHit({ primaryOrgCode: "WCMC" })} {...baseProps} />,
    );
    expect(screen.getByText("Department of Medicine")).toBeTruthy();
    expect(screen.queryByText(/Weill Cornell Medicine|WCMC/)).toBeNull();
    unmount();
    render(<PeopleResultCard hit={makeHit({})} {...baseProps} />);
    expect(screen.getByText("Department of Medicine")).toBeTruthy();
  });
});
