/**
 * Dept "Active grants" card — two behavioral contracts.
 *
 * 1. The title links to NIH RePORTER, emulating the scholar profile's
 *    grant-details link. NIH grants (an applId is known, from the ETL column or
 *    the client resolver) get a linked title; non-NIH grants keep plain text.
 * 2. #2074 — each investigator chip's tooltip names THAT PERSON'S role. The old
 *    code branched on `isMultiPi` alone and both arms asserted principal-
 *    investigator standing, so a Co-Investigator chip (which this card renders
 *    whenever the award has no PI row in the unit) was labelled the principal
 *    investigator.
 *
 * `HoverTooltip` is mocked to surface its `text` prop as an attribute: it wraps
 * Radix, which PORTALS the bubble and only mounts it on hover, so the string is
 * absent from the rendered DOM otherwise.
 */
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

vi.mock("@/components/ui/hover-tooltip", () => ({
  HoverTooltip: ({ text, children }: { text: string; children: React.ReactNode }) => (
    <span data-tooltip={text}>{children}</span>
  ),
}));

import { GrantCard } from "@/components/department/grant-card";
import type { DeptGrantCard } from "@/lib/api/dept-highlights";
import type { AuthorChip } from "@/components/publication/author-chip-row";

const baseGrant: DeptGrantCard = {
  externalId: "INFOED-123-abc1001",
  awardNumber: "R01 CA245678",
  funder: "NIH",
  title: "A study of grant title linking",
  startDate: new Date("2023-01-01"),
  endDate: new Date("2028-12-31"),
  isRecentlyCompleted: false,
  pis: [],
  isMultiPi: false,
  applId: null,
};

const REPORTER = 'a[href^="https://reporter.nih.gov/project-details/"]';

describe("Dept GrantCard — title link", () => {
  it("links the title to RePORTER when the ETL applId is present", () => {
    const { container } = render(
      <GrantCard grant={{ ...baseGrant, applId: 10412345 }} />,
    );
    const link = container.querySelector(REPORTER);
    expect(link?.getAttribute("href")).toBe(
      "https://reporter.nih.gov/project-details/10412345",
    );
    expect(link?.textContent).toContain("A study of grant title linking");
  });

  it("links the title using the client-resolved applId fallback", () => {
    const { container } = render(
      <GrantCard grant={baseGrant} applIdFallback={9987654} />,
    );
    expect(container.querySelector(REPORTER)?.getAttribute("href")).toBe(
      "https://reporter.nih.gov/project-details/9987654",
    );
  });

  it("renders a plain-text title (no link) when no applId is known", () => {
    const { container, getByText } = render(<GrantCard grant={baseGrant} />);
    expect(container.querySelector(REPORTER)).toBeNull();
    expect(getByText("A study of grant title linking")).toBeTruthy();
  });
});

describe("Dept GrantCard — investigator chip tooltip (#2074)", () => {
  const chip = (grantRole: string | null): AuthorChip => ({
    name: "Test Person",
    cwid: "abc1001",
    slug: "test-person",
    identityImageEndpoint: null,
    isFirst: true,
    isLast: false,
    roleCategory: "faculty",
    grantRole,
  });

  const tip = (grant: DeptGrantCard) =>
    render(<GrantCard grant={grant} />)
      .container.querySelector("[data-tooltip]")
      ?.getAttribute("data-tooltip");

  it("does NOT call a Co-Investigator the principal investigator", () => {
    // The regression. This chip is rendered whenever the award has no PI row in
    // the unit, and previously read "Principal investigator".
    const t = tip({ ...baseGrant, pis: [chip("Co-I")] });
    expect(t).not.toMatch(/principal investigator/i);
    expect(t).toBe("Co-Investigator");
  });

  it("reads MPI for a Co-PI — InfoEd's non-contact PD/PI is an NIH multiple-PI", () => {
    // Role alone suffices; `isMultiPi` is not needed for a Co-PI row.
    expect(tip({ ...baseGrant, pis: [chip("Co-PI")], isMultiPi: false })).toMatch(/Multiple/);
  });

  it("reads MPI for the CONTACT PI of a multi-PI award", () => {
    expect(tip({ ...baseGrant, pis: [chip("PI")], isMultiPi: true })).toMatch(/Multiple/);
  });

  it("reads plain PI for a sole PI", () => {
    const t = tip({ ...baseGrant, pis: [chip("PI")], isMultiPi: false });
    expect(t).toBe("Principal Investigator");
    expect(t).not.toMatch(/Multiple/);
  });

  it("says only 'Investigator' when the role is unknown", () => {
    // Fail SAFE: an absent role must never be described as PI standing.
    expect(tip({ ...baseGrant, pis: [chip(null)] })).toBe("Investigator");
  });

  it("labels each chip by its OWN role when a card carries several", () => {
    // Guards the per-chip plumbing: a card-level role would label both the same.
    const { container } = render(
      <GrantCard
        grant={{
          ...baseGrant,
          isMultiPi: true,
          pis: [
            { ...chip("PI"), cwid: "aaa1", name: "Lead" },
            { ...chip("Co-I"), cwid: "bbb2", name: "Helper" },
          ],
        }}
      />,
    );
    const tips = Array.from(container.querySelectorAll("[data-tooltip]")).map((n) =>
      n.getAttribute("data-tooltip"),
    );
    expect(tips).toHaveLength(2);
    expect(tips[0]).toMatch(/Multiple/);
    expect(tips[1]).toBe("Co-Investigator");
  });
});
