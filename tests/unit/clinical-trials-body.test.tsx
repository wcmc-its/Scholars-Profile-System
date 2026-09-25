/**
 * Report 5's redesigned page: `clinical-trials-body.tsx` (the card, the
 * empty state, the footer note, the URL filters handed to the client) and
 * `clinical-trials-results.tsx` (headline numbers, download link and note,
 * Trials / By member tabs, search / status / phase filters narrowing the
 * numbers, the tabs and the download, the URL kept in step, "Local only ·
 * no NCT", the By member sort and expand, the empty state). Assertions are
 * scoped to the rendered container, never `document.body`. Fixture people
 * and trials are invented.
 */
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} }, prisma: {} }));
vi.mock("@/lib/center-collaboration/clinical-trials-report", () => ({
  loadClinicalTrialsReport: h.load,
}));

import { renderClinicalTrialsReport } from "@/components/edit/reports/clinical-trials-body";
import {
  ClinicalTrialsResults,
  sortMembers,
} from "@/components/edit/reports/clinical-trials-results";
import type { ClinicalTrialsReportRow } from "@/lib/center-collaboration/clinical-trials-report";
import {
  CLINICAL_TRIALS_DEFAULTS,
  groupTrials,
  summarizeMembers,
  type ClinicalTrialsParams,
} from "@/lib/edit/clinical-trials-report";
import type { UnitReportProps } from "@/lib/edit/report-registry";

afterEach(cleanup);

const BASE = "/edit/reports/clinical-trials";

function row(over: Partial<ClinicalTrialsReportRow>): ClinicalTrialsReportRow {
  return {
    cwid: "aaa1001",
    personName: "Ada Anders",
    department: "Medicine",
    role: "Principal Investigator",
    protocolNumber: "P-1",
    nctNumber: "NCT00000001",
    title: "A study",
    phase: "PHASE2",
    principalSponsor: "Acme Pharma",
    status: "OPEN TO ACCRUAL",
    isActive: true,
    ...over,
  };
}

const ROWS = [
  row({ protocolNumber: "P-1", title: "Beta trial of widgets" }),
  row({
    protocolNumber: "P-2",
    title: "Alpha local study",
    status: "SUSPENDED",
    nctNumber: null,
    phase: null,
  }),
  row({
    protocolNumber: "P-3",
    title: "Gamma trial",
    status: "IRB STUDY CLOSURE",
    nctNumber: "NCT00000003",
    cwid: "bbb2002",
    personName: "Bo Brandt",
    department: "Surgery",
  }),
];

function renderResults(initial: Partial<ClinicalTrialsParams> = {}, rows = ROWS, cap = 50) {
  return render(
    <ClinicalTrialsResults
      trials={groupTrials(rows)}
      initial={{ ...CLINICAL_TRIALS_DEFAULTS, ...initial }}
      basePath={BASE}
      centerCode="CC"
      keepQuery="center=CC"
      cap={cap}
    />,
  );
}

const statValues = (c: HTMLElement) =>
  Array.from(within(c).getByTestId("ct-stats").querySelectorAll("dd")).map((d) => d.textContent);

beforeEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("ClinicalTrialsResults", () => {
  it("shows the headline numbers, the tabs and every trial", () => {
    const { container } = renderResults();
    expect(statValues(container)).toEqual(["3", "2", "1", "2"]);
    expect(within(container).getByTestId("ct-stats").textContent).toContain(
      "members on trials · 3 links",
    );
    expect(within(container).getByTestId("ct-view-trials").textContent).toBe("Trials (3)");
    expect(within(container).getByTestId("ct-view-members").textContent).toBe("By member (2)");
    expect(within(container).getAllByTestId("ct-trial-row")).toHaveLength(3);
    expect(within(container).getByTestId("ct-download").getAttribute("href")).toBe(
      "/api/edit/reports/clinical-trials?center=CC",
    );
    expect(within(container).getByTestId("ct-download-note").textContent).toContain(
      "Trials, Investigators and Criteria sheets",
    );
  });

  it("offers all four OnCore statuses and no role or sponsor-type filter", () => {
    const { container } = renderResults();
    const opts = Array.from(
      within(container).getByTestId("ct-status").querySelectorAll("option"),
    ).map((o) => o.textContent);
    expect(opts).toEqual([
      "Any status",
      "Open to accrual",
      "Closed to accrual",
      "Closed (IRB study closure)",
      "Temporarily suspended",
    ]);
    expect(within(container).getByTestId("ct-filters").querySelectorAll("select")).toHaveLength(2);
    expect(container.textContent).not.toMatch(/Any role|sponsor type|As investigator/i);
  });

  it("labels a trial with no NCT 'Local only · no NCT' with the not-registered tooltip, and links the rest", () => {
    const { container } = renderResults();
    const local = within(container).getByTestId("ct-local-only");
    expect(local.textContent).toBe("Local only · no NCT");
    expect(local.getAttribute("title")).toBe("Not registered on ClinicalTrials.gov");
    expect(within(container).getByText("NCT00000001 ↗").getAttribute("href")).toBe(
      "https://clinicaltrials.gov/study/NCT00000001",
    );
  });

  it("a status filter narrows the numbers, the tabs, the download and the URL; suspended trials are kept", () => {
    const { container } = renderResults();
    fireEvent.change(within(container).getByTestId("ct-status"), {
      target: { value: "suspended" },
    });
    expect(statValues(container)).toEqual(["1", "1", "0", "0"]);
    expect(within(container).getByTestId("ct-view-trials").textContent).toBe("Trials (1)");
    expect(within(container).getAllByTestId("ct-trial-row")[0].textContent).toContain(
      "Temporarily suspended",
    );
    expect(within(container).getByTestId("ct-download").getAttribute("href")).toBe(
      "/api/edit/reports/clinical-trials?center=CC&status=suspended",
    );
    expect(window.location.pathname + window.location.search).toBe(
      `${BASE}?center=CC&status=suspended`,
    );
  });

  it("search and phase narrow too, and Clear filters resets them", () => {
    const { container } = renderResults();
    fireEvent.change(within(container).getByTestId("ct-search"), { target: { value: "brandt" } });
    expect(within(container).getAllByTestId("ct-trial-row")).toHaveLength(1);
    fireEvent.change(within(container).getByTestId("ct-phase"), { target: { value: "nr" } });
    expect(within(container).getByTestId("ct-empty").textContent).toBe(
      "No trials match these filters.",
    );
    expect(within(container).getByTestId("ct-download").getAttribute("href")).toBe(
      "/api/edit/reports/clinical-trials?center=CC&q=brandt&phase=nr",
    );
    fireEvent.click(within(container).getByTestId("ct-clear"));
    expect(within(container).getAllByTestId("ct-trial-row")).toHaveLength(3);
    expect(within(container).queryByTestId("ct-clear")).toBeNull();
  });

  it("opens on the URL's filters and tab", () => {
    const { container } = renderResults({ view: "members", status: "irb" });
    expect(within(container).getByTestId("ct-members-table")).toBeTruthy();
    expect(within(container).getAllByTestId("ct-member-row")).toHaveLength(1);
    expect((within(container).getByTestId("ct-status") as HTMLSelectElement).value).toBe("irb");
  });

  it("By member: Trials as PI and Open to accrual columns, department, and an expandable trial list", () => {
    const { container } = renderResults();
    fireEvent.click(within(container).getByTestId("ct-view-members"));
    expect(window.location.search).toBe("?center=CC&view=members");
    const table = within(container).getByTestId("ct-members-table");
    const heads = Array.from(table.querySelectorAll("th")).map((t) => t.textContent);
    expect(heads).toEqual(["Member", "Trials as PI↓", "Open to accrual"]);
    const rows = within(container).getAllByTestId("ct-member-row");
    expect(rows[0].textContent).toContain("Ada Anders");
    expect(rows[0].textContent).toContain("Medicine");
    expect(within(container).queryByTestId("ct-member-trials")).toBeNull();
    fireEvent.click(rows[0]);
    const list = within(container).getByTestId("ct-member-trials");
    expect(list.querySelectorAll("li")).toHaveLength(2);
    expect(list.textContent).toContain("Local only · no NCT");
    expect(list.textContent).toContain("Principal investigator");
  });

  it("warns that the Investigators sheet is left out above the cap", () => {
    const { container } = renderResults({}, ROWS, 1);
    const note = within(container).getByTestId("ct-download-note");
    expect(note.textContent).toContain("Investigators sheet is left out above 1 people (2 match)");
  });

  it("sorts members by name, trials as PI or open trials", () => {
    const members = summarizeMembers(groupTrials(ROWS));
    expect(sortMembers(members, "pi", -1).map((m) => m.cwid)).toEqual(["aaa1001", "bbb2002"]);
    expect(sortMembers(members, "pi", 1).map((m) => m.cwid)).toEqual(["bbb2002", "aaa1001"]);
    expect(sortMembers(members, "name", -1).map((m) => m.cwid)).toEqual(["bbb2002", "aaa1001"]);
    expect(sortMembers(members, "open", -1).map((m) => m.cwid)).toEqual(["aaa1001", "bbb2002"]);
  });
});

function props(searchParams: UnitReportProps["searchParams"] = {}): UnitReportProps {
  return {
    n: "5",
    code: "CC",
    kind: "center",
    ctx: { unit: { name: "Test Center" } },
    session: {} as UnitReportProps["session"],
    searchParams,
    basePath: BASE,
  };
}

describe("renderClinicalTrialsReport", () => {
  it("hands the URL's filters to the results and states the PI-only scope", async () => {
    h.load.mockResolvedValue(ROWS);
    const out = await renderClinicalTrialsReport(props({ center: "CC", status: "open" }));
    const { container } = render(<>{out.main}</>);
    expect(within(container).getAllByTestId("ct-trial-row")).toHaveLength(1);
    expect(within(container).getByRole("note").textContent).toContain("Principal Investigator");
    expect(h.load).toHaveBeenCalledWith(expect.anything(), "CC");
  });

  it("shows a no-data line when the center's members have no trials", async () => {
    h.load.mockResolvedValue([]);
    const out = await renderClinicalTrialsReport(props());
    const { container } = render(<>{out.main}</>);
    expect(within(container).getByTestId("ct-no-data")).toBeTruthy();
    expect(within(container).queryByTestId("clinical-trials-results")).toBeNull();
  });
});
