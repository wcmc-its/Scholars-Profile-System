/**
 * `components/edit/reports-index.tsx` — the Reports IA redesign's cross-unit
 * index (`2a`/`1a`/`3a`, 2026-08-14). Table mode: filter rail + sortable rows,
 * one per unit, row links to that unit's report list. Bands mode: every unit
 * inline with its own 5 report rows, live ones clickable, others muted.
 * `SingleUnitReportsTable` (`3a`) is the same report-row shape as one band's
 * body, without the band header — used when an actor has exactly one
 * reportable unit, which is the common case today.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import {
  ReportsIndex,
  SingleUnitReportsTable,
  type ReportsIndexUnit,
} from "@/components/edit/reports-index";

const REPORTS = [
  { n: 1 as const, label: "1. Optimize membership", description: "Membership recs." },
  { n: 2 as const, label: "2. NCI Table 2a", description: "Funding review." },
  { n: 3 as const, label: "3. Publications", description: "Pubs by program." },
  { n: 4 as const, label: "4. Grants", description: "Active grants." },
  { n: 5 as const, label: "5. Clinical Trials", description: "Active trials." },
];

function perReport(liveNs: number[]): ReportsIndexUnit["perReport"] {
  return REPORTS.map((r) => ({
    n: r.n,
    live: liveNs.includes(r.n),
    lastRefreshedAt: liveNs.includes(r.n) && r.n <= 2 ? "2026-08-11T00:00:00.000Z" : null,
  }));
}

const MEYER: ReportsIndexUnit = {
  code: "meyer",
  name: "Sandra and Edward Meyer Cancer Center",
  centerType: "center",
  editHref: "/edit/center/meyer",
  liveCount: 2,
  totalCount: 5,
  lastRefreshedAt: "2026-08-11T00:00:00.000Z",
  perReport: perReport([1, 2]),
};

const EPIC: ReportsIndexUnit = {
  code: "epic",
  name: "Englander Institute for Precision Medicine",
  centerType: "institute",
  editHref: "/edit/center/epic",
  liveCount: 0,
  totalCount: 5,
  lastRefreshedAt: null,
  perReport: perReport([]),
};

describe("ReportsIndex — table mode (2a)", () => {
  it("renders one row per unit, each linking to that unit's report list", () => {
    render(<ReportsIndex units={[MEYER, EPIC]} reports={REPORTS} mode="table" />);
    const meyerLink = screen.getByTestId("reports-index-link-meyer");
    expect(meyerLink.getAttribute("href")).toBe("/edit/reports?center=meyer");
    expect(screen.getByTestId("reports-index-link-epic").getAttribute("href")).toBe(
      "/edit/reports?center=epic",
    );
  });

  it("shows live count as N of M, and — for a unit with none yet", () => {
    render(<ReportsIndex units={[MEYER, EPIC]} reports={REPORTS} mode="table" />);
    expect(screen.getByTestId("reports-index-row-meyer").textContent).toContain("2 of 5");
    expect(screen.getByTestId("reports-index-row-epic").textContent).toContain("—");
  });

  it("filters by name", () => {
    render(<ReportsIndex units={[MEYER, EPIC]} reports={REPORTS} mode="table" />);
    fireEvent.change(screen.getByTestId("reports-index-filter-name"), { target: { value: "Englander" } });
    expect(screen.queryByTestId("reports-index-row-meyer")).toBeNull();
    expect(screen.getByTestId("reports-index-row-epic")).toBeTruthy();
  });

  it("the 'None yet' toggle isolates units with zero live reports — the mockup's own filter bucket", () => {
    render(<ReportsIndex units={[MEYER, EPIC]} reports={REPORTS} mode="table" />);
    fireEvent.click(screen.getByTestId("reports-index-filter-none-yet"));
    expect(screen.queryByTestId("reports-index-row-meyer")).toBeNull();
    expect(screen.getByTestId("reports-index-row-epic")).toBeTruthy();
  });

  it("the Unit type checkboxes narrow to Center or Institute", () => {
    render(<ReportsIndex units={[MEYER, EPIC]} reports={REPORTS} mode="table" />);
    fireEvent.click(screen.getByTestId("reports-index-filter-institute"));
    expect(screen.getByTestId("reports-index-row-meyer")).toBeTruthy();
    expect(screen.queryByTestId("reports-index-row-epic")).toBeNull();
  });
});

describe("ReportsIndex — bands mode (1a)", () => {
  it("renders a band per unit with its own report rows beneath", () => {
    render(<ReportsIndex units={[MEYER, EPIC]} reports={REPORTS} mode="bands" />);
    expect(screen.getByTestId("reports-index-band-meyer")).toBeTruthy();
    expect(screen.getByTestId("reports-index-band-epic")).toBeTruthy();
  });

  it("a live report row is a link to /edit/reports/N; a not-live one is plain muted text", () => {
    render(<ReportsIndex units={[MEYER]} reports={REPORTS} mode="bands" />);
    const link = screen.getByTestId("reports-index-band-link-meyer-1");
    expect(link.getAttribute("href")).toBe("/edit/reports/1?center=meyer");
    // Report 3 is not live for Meyer in this fixture — no link, just text.
    expect(screen.queryByTestId("reports-index-band-link-meyer-3")).toBeNull();
    const band = screen.getByTestId("reports-index-band-meyer");
    expect(within(band).getByText("3. Publications")).toBeTruthy();
  });

  it("the band header shows the unit's type, live count, and an Edit center profile link", () => {
    render(<ReportsIndex units={[EPIC]} reports={REPORTS} mode="bands" />);
    const band = screen.getByTestId("reports-index-band-epic");
    expect(band.textContent).toContain("Institute");
    expect(band.textContent).toContain("0 of 5 reports live");
    expect(screen.getByTestId("reports-index-edit-epic").getAttribute("href")).toBe("/edit/center/epic");
  });
});

describe("SingleUnitReportsTable — 3a (exactly one reportable unit)", () => {
  it("renders the same Report | Focus | Last refreshed table shape as a band, no band header", () => {
    render(<SingleUnitReportsTable centerCode="meyer" perReport={perReport([1, 2])} reports={REPORTS} />);
    const table = screen.getByTestId("single-unit-reports-table");
    expect(within(table).getByText("Report")).toBeTruthy();
    expect(within(table).getByText("Focus")).toBeTruthy();
    expect(within(table).getByText("Last refreshed")).toBeTruthy();
    // No band header row — nothing states a unit name/live-count inside the table itself.
    expect(within(table).queryByText(/reports live/)).toBeNull();
  });

  it("a live report is a link to /edit/reports/N?center=…; a not-live one is plain muted text", () => {
    render(<SingleUnitReportsTable centerCode="meyer" perReport={perReport([1, 2])} reports={REPORTS} />);
    const link = screen.getByTestId("reports-index-band-link-meyer-1");
    expect(link.getAttribute("href")).toBe("/edit/reports/1?center=meyer");
    expect(screen.queryByTestId("reports-index-band-link-meyer-3")).toBeNull();
    const table = screen.getByTestId("single-unit-reports-table");
    expect(within(table).getByText("3. Publications")).toBeTruthy();
  });
});
