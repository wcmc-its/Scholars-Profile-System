/**
 * Funding panel is multi-source (#1307 RePORTER backfill): the header source
 * line names both InfoEd and NIH RePORTER only when a RePORTER-sourced grant is
 * present, and each row routes "Request a change" by its own system of record.
 */
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FundingCard } from "@/components/edit/funding-card";
import type { EditContextGrant } from "@/lib/api/edit-context";

const grant = (over: Partial<EditContextGrant>): EditContextGrant => ({
  externalId: "g1",
  title: "A grant",
  role: "Principal Investigator",
  source: "InfoEd",
  funderLabel: "NIH",
  startYear: 2018,
  endYear: 2022,
  isActive: false,
  state: "shown",
  suppressionId: null,
  ...over,
});

const sourceText = (c: HTMLElement) =>
  c.querySelector('[data-slot="field-source"]')?.textContent ?? null;

describe("FundingCard — source header reflects the grant systems", () => {
  it("names InfoEd only when there are no RePORTER grants", () => {
    const { container } = render(
      <FundingCard cwid="abc1001" mode="self" scholarName="Jane" grants={[grant({})]} />,
    );
    expect(sourceText(container)).toBe("Source: InfoEd");
  });

  it("names InfoEd and NIH RePORTER when a RePORTER grant is present", () => {
    const { container } = render(
      <FundingCard
        cwid="abc1001"
        mode="self"
        scholarName="Jane"
        grants={[grant({}), grant({ externalId: "g2", source: "RePORTER" })]}
      />,
    );
    expect(sourceText(container)).toBe("Source: InfoEd and NIH RePORTER");
  });
});
