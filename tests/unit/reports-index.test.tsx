/**
 * `components/edit/reports-index.tsx` — the Reports IA redesign's cross-unit
 * index (`2a`/`1a`/`3a`, 2026-08-14), widened to department/division units by
 * the org-unit publications reports plan (2026-08-16). Table mode: filter
 * rail + sortable rows, one per unit, row links to that unit's report list.
 * Bands mode: every unit inline with its OWN report rows (a center's six vs.
 * a department/division's two — see the component's doc comment for why
 * `reports` moved onto each unit instead of staying a shared prop).
 * `SingleUnitReportsTable` (`3a`) is the same report-row shape as one band's
 * body, without the band header — used when an actor has exactly one
 * reportable unit, which is the common case today.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import {
  ReportsIndex,
  SingleUnitReportsTable,
  type ReportsIndexReport,
  type ReportsIndexUnit,
} from "@/components/edit/reports-index";

const CENTER_REPORTS: ReportsIndexReport[] = [
  { n: 1, label: "1. Optimize membership", description: "Membership recs." },
  { n: 2, label: "2. NCI Table 2a", description: "Funding review." },
  { n: 3, label: "3. Publications", description: "Pubs by program." },
  { n: 4, label: "4. Grants", description: "Active grants." },
  { n: 5, label: "5. Clinical Trials", description: "Active trials." },
  { n: 6, label: "6. NIH-funded pubs", description: "NIH RePORTER-linked pubs." },
];

const UNIT_REPORTS: ReportsIndexReport[] = [
  { n: 3, label: "3. Publications", description: "Pubs by member." },
  { n: 6, label: "6. NIH-funded pubs", description: "NIH RePORTER-linked pubs." },
];

function perReport(liveNs: number[], reports: ReportsIndexReport[] = CENTER_REPORTS): ReportsIndexUnit["perReport"] {
  return reports.map((r) => ({
    n: r.n,
    live: liveNs.includes(r.n),
    lastRefreshedAt: liveNs.includes(r.n) && r.n <= 2 ? "2026-08-11T00:00:00.000Z" : null,
  }));
}

const MEYER: ReportsIndexUnit = {
  code: "meyer",
  kind: "center",
  name: "Sandra and Edward Meyer Cancer Center",
  centerType: "center",
  editHref: "/edit/center/meyer",
  liveCount: 2,
  totalCount: 6,
  lastRefreshedAt: "2026-08-11T00:00:00.000Z",
  reports: CENTER_REPORTS,
  perReport: perReport([1, 2]),
};

const EPIC: ReportsIndexUnit = {
  code: "epic",
  kind: "center",
  name: "Englander Institute for Precision Medicine",
  centerType: "institute",
  editHref: "/edit/center/epic",
  liveCount: 0,
  totalCount: 6,
  lastRefreshedAt: null,
  reports: CENTER_REPORTS,
  perReport: perReport([]),
};

const DEPT: ReportsIndexUnit = {
  code: "surg",
  kind: "department",
  name: "Department of Surgery",
  centerType: null,
  editHref: "/edit/department/surg",
  liveCount: 1,
  totalCount: 2,
  lastRefreshedAt: null,
  reports: UNIT_REPORTS,
  perReport: perReport([3], UNIT_REPORTS),
};

const DIVISION: ReportsIndexUnit = {
  code: "n001",
  kind: "division",
  name: "Cardiology (Medicine)",
  centerType: null,
  editHref: "/edit/division/n001",
  liveCount: 0,
  totalCount: 2,
  lastRefreshedAt: null,
  reports: UNIT_REPORTS,
  perReport: perReport([], UNIT_REPORTS),
};

describe("ReportsIndex — table mode (2a)", () => {
  it("renders one row per unit, each linking to that unit's report list", () => {
    render(<ReportsIndex units={[MEYER, EPIC]} mode="table" />);
    const meyerLink = screen.getByTestId("reports-index-link-meyer");
    expect(meyerLink.getAttribute("href")).toBe("/edit/reports?center=meyer");
    expect(screen.getByTestId("reports-index-link-epic").getAttribute("href")).toBe(
      "/edit/reports?center=epic",
    );
  });

  it("shows live count as N of M, and — for a unit with none yet", () => {
    render(<ReportsIndex units={[MEYER, EPIC]} mode="table" />);
    expect(screen.getByTestId("reports-index-row-meyer").textContent).toContain("2 of 6");
    expect(screen.getByTestId("reports-index-row-epic").textContent).toContain("—");
  });

  it("filters by name", () => {
    render(<ReportsIndex units={[MEYER, EPIC]} mode="table" />);
    fireEvent.change(screen.getByTestId("reports-index-filter-name"), { target: { value: "Englander" } });
    expect(screen.queryByTestId("reports-index-row-meyer")).toBeNull();
    expect(screen.getByTestId("reports-index-row-epic")).toBeTruthy();
  });

  it("the 'None yet' toggle isolates units with zero live reports — the mockup's own filter bucket", () => {
    render(<ReportsIndex units={[MEYER, EPIC]} mode="table" />);
    fireEvent.click(screen.getByTestId("reports-index-filter-none-yet"));
    expect(screen.queryByTestId("reports-index-row-meyer")).toBeNull();
    expect(screen.getByTestId("reports-index-row-epic")).toBeTruthy();
  });

  it("the Unit type checkboxes narrow to Center or Institute", () => {
    render(<ReportsIndex units={[MEYER, EPIC]} mode="table" />);
    fireEvent.click(screen.getByTestId("reports-index-filter-institute"));
    expect(screen.getByTestId("reports-index-row-meyer")).toBeTruthy();
    expect(screen.queryByTestId("reports-index-row-epic")).toBeNull();
  });

  it("the Department checkbox defaults unchecked — a department unit stays hidden until toggled on", () => {
    render(<ReportsIndex units={[MEYER, DEPT]} mode="table" />);
    expect(screen.queryByTestId("reports-index-row-surg")).toBeNull();
    fireEvent.click(screen.getByTestId("reports-index-filter-department"));
    expect(screen.getByTestId("reports-index-row-surg")).toBeTruthy();
  });

  it("the Division checkbox defaults unchecked — a division unit stays hidden until toggled on", () => {
    render(<ReportsIndex units={[MEYER, DIVISION]} mode="table" />);
    expect(screen.queryByTestId("reports-index-row-n001")).toBeNull();
    fireEvent.click(screen.getByTestId("reports-index-filter-division"));
    expect(screen.getByTestId("reports-index-row-n001")).toBeTruthy();
  });

  it("a department/division row link carries &kind= so it resolves to the right unit type", () => {
    render(<ReportsIndex units={[DEPT, DIVISION]} mode="table" />);
    fireEvent.click(screen.getByTestId("reports-index-filter-department"));
    fireEvent.click(screen.getByTestId("reports-index-filter-division"));
    expect(screen.getByTestId("reports-index-link-surg").getAttribute("href")).toBe(
      "/edit/reports?center=surg&kind=department",
    );
    expect(screen.getByTestId("reports-index-link-n001").getAttribute("href")).toBe(
      "/edit/reports?center=n001&kind=division",
    );
  });
});

describe("ReportsIndex — bands mode (1a)", () => {
  it("renders a band per unit with its own report rows beneath", () => {
    render(<ReportsIndex units={[MEYER, EPIC]} mode="bands" />);
    expect(screen.getByTestId("reports-index-band-meyer")).toBeTruthy();
    expect(screen.getByTestId("reports-index-band-epic")).toBeTruthy();
  });

  it("a live report row is a link to /edit/reports/N; a not-live one is plain muted text", () => {
    render(<ReportsIndex units={[MEYER]} mode="bands" />);
    const link = screen.getByTestId("reports-index-band-link-meyer-1");
    expect(link.getAttribute("href")).toBe("/edit/reports/1?center=meyer");
    // Report 3 is not live for Meyer in this fixture — no link, just text.
    expect(screen.queryByTestId("reports-index-band-link-meyer-3")).toBeNull();
    const band = screen.getByTestId("reports-index-band-meyer");
    expect(within(band).getByText("3. Publications")).toBeTruthy();
  });

  it("the band header shows the unit's type, live count, and an Edit center profile link", () => {
    render(<ReportsIndex units={[EPIC]} mode="bands" />);
    const band = screen.getByTestId("reports-index-band-epic");
    expect(band.textContent).toContain("Institute");
    expect(band.textContent).toContain("0 of 6 reports live");
    expect(screen.getByTestId("reports-index-edit-epic").getAttribute("href")).toBe("/edit/center/epic");
  });

  it("a department band only lists its own 2-report catalog, never a report 1/2/4/5 row", () => {
    render(<ReportsIndex units={[DEPT]} mode="bands" />);
    const band = screen.getByTestId("reports-index-band-surg");
    expect(band.textContent).toContain("Department");
    expect(band.textContent).toContain("1 of 2 reports live");
    expect(within(band).getByText("3. Publications")).toBeTruthy();
    expect(within(band).getByText("6. NIH-funded pubs")).toBeTruthy();
    expect(within(band).queryByText(/Optimize membership|NCI Table|^4\.|^5\./)).toBeNull();
  });

  it("a department's live report link carries &kind=department", () => {
    render(<ReportsIndex units={[DEPT]} mode="bands" />);
    const link = screen.getByTestId("reports-index-band-link-surg-3");
    expect(link.getAttribute("href")).toBe("/edit/reports/3?center=surg&kind=department");
  });
});

describe("SingleUnitReportsTable — 3a (exactly one reportable unit)", () => {
  it("renders the same Report | Focus | Last refreshed table shape as a band, no band header", () => {
    render(<SingleUnitReportsTable unitCode="meyer" perReport={perReport([1, 2])} reports={CENTER_REPORTS} />);
    const table = screen.getByTestId("single-unit-reports-table");
    expect(within(table).getByText("Report")).toBeTruthy();
    expect(within(table).getByText("Focus")).toBeTruthy();
    expect(within(table).getByText("Last refreshed")).toBeTruthy();
    // No band header row — nothing states a unit name/live-count inside the table itself.
    expect(within(table).queryByText(/reports live/)).toBeNull();
  });

  it("a live report is a link to /edit/reports/N?center=…; a not-live one is plain muted text", () => {
    render(<SingleUnitReportsTable unitCode="meyer" perReport={perReport([1, 2])} reports={CENTER_REPORTS} />);
    const link = screen.getByTestId("reports-index-band-link-meyer-1");
    expect(link.getAttribute("href")).toBe("/edit/reports/1?center=meyer");
    expect(screen.queryByTestId("reports-index-band-link-meyer-3")).toBeNull();
    const table = screen.getByTestId("single-unit-reports-table");
    expect(within(table).getByText("3. Publications")).toBeTruthy();
  });

  it("unitKind defaults to center — no &kind= param when omitted", () => {
    render(<SingleUnitReportsTable unitCode="meyer" perReport={perReport([1])} reports={CENTER_REPORTS} />);
    expect(screen.getByTestId("reports-index-band-link-meyer-1").getAttribute("href")).toBe(
      "/edit/reports/1?center=meyer",
    );
  });

  it("a department's live report link carries &kind=department", () => {
    render(
      <SingleUnitReportsTable
        unitCode="surg"
        unitKind="department"
        perReport={perReport([3], UNIT_REPORTS)}
        reports={UNIT_REPORTS}
      />,
    );
    const link = screen.getByTestId("reports-index-band-link-surg-3");
    expect(link.getAttribute("href")).toBe("/edit/reports/3?center=surg&kind=department");
  });
});
