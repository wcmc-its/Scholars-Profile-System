/**
 * Dept "Active grants" card — title links to NIH RePORTER, emulating the
 * scholar profile's grant-details link. NIH grants (an applId is known, from
 * the ETL column or the client resolver) get a linked title; non-NIH grants
 * (no applId) keep a plain-text title. This is the behavioral contract of the
 * feature, so it's the one branch worth guarding.
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { GrantCard } from "@/components/department/grant-card";
import type { DeptGrantCard } from "@/lib/api/dept-highlights";

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
