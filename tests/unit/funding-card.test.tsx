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
  accountNumber: null,
  centralOffice: null,
  intakeType: null,
  datesSource: null,
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

const recordLines = (c: HTMLElement) =>
  [...c.querySelectorAll('[data-slot="grant-record"]')].map((n) => n.textContent);

describe("FundingCard — #2180 record-level routing line", () => {
  it("shows account, office, intake type, and dates source together", () => {
    const { container } = render(
      <FundingCard
        cwid="abc1001"
        mode="superuser"
        scholarName="Jane"
        grants={[
          grant({
            accountNumber: "12345",
            centralOffice: "JCTO",
            intakeType: "Clinical Trial Agreement",
            datesSource: "infoed",
          }),
        ]}
      />,
    );
    expect(recordLines(container)).toEqual([
      "InfoEd account 12345 · Office: JCTO · Intake type: Clinical Trial Agreement · Dates from InfoEd",
    ]);
  });

  it("degrades field by field — a missing office is omitted, never guessed", () => {
    const { container } = render(
      <FundingCard
        cwid="abc1001"
        mode="self"
        scholarName="Jane"
        grants={[
          grant({
            accountNumber: "777",
            centralOffice: null,
            intakeType: "Clinical Trial Agreement",
            datesSource: "reporter",
          }),
        ]}
      />,
    );
    const [line] = recordLines(container);
    expect(line).toBe(
      "InfoEd account 777 · Intake type: Clinical Trial Agreement · Dates from NIH RePORTER (missing in InfoEd)",
    );
    expect(line).not.toMatch(/Office|OSRA/);
  });

  it("renders no record line for a row with nothing recorded (a RePORTER row)", () => {
    const { container } = render(
      <FundingCard
        cwid="abc1001"
        mode="self"
        scholarName="Jane"
        grants={[grant({ source: "RePORTER" })]}
      />,
    );
    expect(recordLines(container)).toEqual([]);
    expect(container.textContent).not.toContain("quote its account number");
  });

  it("keeps the record line out of the row checkbox's accessible name", () => {
    const { container } = render(
      <FundingCard
        cwid="abc1001"
        mode="self"
        scholarName="Jane"
        grants={[grant({ accountNumber: "12345", centralOffice: "OSRA", datesSource: "infoed" })]}
      />,
    );
    const box = container.querySelector('[role="checkbox"]');
    expect(box).not.toBeNull();
    expect(box?.getAttribute("aria-label")).not.toContain("12345");
    expect(container.textContent).toContain("quote its account number");
  });
});
