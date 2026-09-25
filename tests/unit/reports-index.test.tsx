/**
 * `components/edit/reports-index.tsx` — the Reports Index redesign
 * (2026-09-25): one list grouped by unit for every viewer, whole-row link
 * cards, a search box, scope segments with counts, the NCI 2A "In progress"
 * toggle, and the filters mirrored into the URL. Access is plain text from the
 * REAL `accessSummary` (not mocked) — the same string the report header badge
 * shows — and no access popover renders on the index.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, within } from "@testing-library/react";

import type { ReportAccessPopoverProps } from "@/components/edit/report-access-popover";
import {
  dataLabel,
  ReportsIndex,
  type ReportsIndexReport,
  type ReportsIndexUnit,
} from "@/components/edit/reports-index";
import { parseReportsIndexScope } from "@/lib/edit/reports-index-scope";

const UNIT_ACCESS = { mode: "unit" } as const;
const grant = (cwid: string) => ({
  reportKey: "article-count",
  scopeKey: "*",
  cwid,
  granteeName: null,
  name: cwid,
  grantedBy: "adm0001",
  grantedAt: "2026-09-18T12:00:00.000Z",
});
const ARTICLE_ACCESS: ReportAccessPopoverProps = {
  mode: "person",
  reportKey: "article-count",
  initialRows: [grant("usr0001"), grant("usr0002")],
  scopeOptions: [["*", "Whole report"]],
  canManage: true,
  audience: "All unit administrators",
};
const PROGRAM_ACCESS: ReportAccessPopoverProps = {
  mode: "person",
  reportKey: "mentored-publications",
  initialRows: [],
  scopeOptions: [["*", "All programs"]],
  canManage: false,
};

const report = (
  n: ReportsIndexReport["n"],
  name: string,
  description: string,
  access = UNIT_ACCESS as ReportAccessPopoverProps,
) => ({
  n,
  slug: name.toLowerCase().replace(/\s+/g, "-"),
  name,
  description,
  access,
});

const INSTITUTION: ReportsIndexUnit = {
  code: "institution",
  kind: "institution",
  name: "Institution-wide",
  editHref: "/edit/reports/article-counts",
  reports: [report(8, "Article counts", "Distinct articles per year.", ARTICLE_ACCESS)],
  perReport: [{ n: 8, live: true, lastRefreshedAt: null }],
};
const PROGRAMS: ReportsIndexUnit = {
  code: "mentoring-programs",
  kind: "program",
  name: "Mentoring programs",
  editHref: "/edit/reports/mentored-publications",
  reports: [
    report(7, "Mentored publications", "Learner and mentor co-authorship.", PROGRAM_ACCESS),
  ],
  perReport: [{ n: 7, live: true, lastRefreshedAt: null }],
};
const MEYER: ReportsIndexUnit = {
  code: "meyer",
  kind: "center",
  name: "Meyer Cancer Center",
  editHref: "/edit/center/meyer",
  reports: [
    report(1, "Optimize membership", "People to consider adding."),
    report(2, "NCI Table 2a", "Funded projects of center members."),
    report(3, "Publications", "Publications by current members."),
    report(4, "Grants", "Active grants."),
  ],
  perReport: [
    { n: 1, live: true, lastRefreshedAt: "2026-09-20T16:00:00.000Z" },
    {
      n: 2,
      live: true,
      lastRefreshedAt: "2026-07-14T00:00:00.000Z",
      reportingCycle: "osra-2026-07-14",
      toReview: 58,
    },
    { n: 3, live: true, lastRefreshedAt: null },
    { n: 4, live: false, lastRefreshedAt: null },
  ],
};
const SURGERY: ReportsIndexUnit = {
  code: "surg",
  kind: "department",
  name: "Surgery",
  editHref: "/edit/department/surg",
  reports: [
    report(3, "Publications", "Publications by current members."),
    report(6, "NIH-funded pubs", "NIH-linked."),
  ],
  perReport: [
    { n: 3, live: true, lastRefreshedAt: null },
    { n: 6, live: true, lastRefreshedAt: null },
  ],
};

const ALL = [INSTITUTION, PROGRAMS, MEYER];

const replaceState = vi.spyOn(window.history, "replaceState");
beforeEach(() => {
  window.history.pushState(null, "", "/edit/reports");
  replaceState.mockClear();
});
afterEach(() => replaceState.mockClear());

const groupNames = (c: HTMLElement) =>
  Array.from(c.querySelectorAll("section h2")).map((h) => h.textContent);
const rowIds = (c: HTMLElement) =>
  Array.from(c.querySelectorAll("[data-testid^='reports-index-row-']")).map((r) =>
    r.getAttribute("data-testid"),
  );

describe("ReportsIndex — grouped list", () => {
  it("renders one section per unit, in the given order, each with an 'N reports' count", () => {
    const { container } = render(<ReportsIndex units={ALL} />);
    expect(groupNames(container)).toEqual([
      "Institution-wide",
      "Mentoring programs",
      "Meyer Cancer Center",
    ]);
    const meyer = within(
      container.querySelector("[data-testid='reports-index-group-meyer']") as HTMLElement,
    );
    expect(meyer.getByText("4 reports")).toBeTruthy();
    const inst = within(
      container.querySelector("[data-testid='reports-index-group-institution']") as HTMLElement,
    );
    expect(inst.getByText("1 report")).toBeTruthy();
  });

  it("a live row is ONE whole-row link carrying '#N', name, summary, meta line and chevron", () => {
    const { container } = render(<ReportsIndex units={ALL} />);
    const row = within(container).getByTestId("reports-index-row-meyer-3");
    expect(row.tagName).toBe("A");
    expect(row.getAttribute("href")).toBe("/edit/reports/publications?center=meyer");
    expect(row.textContent).toContain("#3");
    expect(row.textContent).toContain("Publications");
    expect(row.textContent).toContain("Publications by current members.");
    expect(within(row).getByTestId("reports-index-access").textContent).toBe(
      "Unit owners and curators",
    );
    expect(within(row).getByTestId("reports-index-data").textContent).toBe("Live data");
    expect(row.querySelector("svg.lucide-chevron-right")).not.toBeNull();
  });

  it("a pseudo-unit's row links without unit params; a department's carries &kind=", () => {
    const { container } = render(<ReportsIndex units={[...ALL, SURGERY]} />);
    const c = within(container);
    expect(c.getByTestId("reports-index-row-institution-8").getAttribute("href")).toBe(
      "/edit/reports/article-counts",
    );
    expect(c.getByTestId("reports-index-row-mentoring-programs-7").getAttribute("href")).toBe(
      "/edit/reports/mentored-publications",
    );
    expect(c.getByTestId("reports-index-row-surg-6").getAttribute("href")).toBe(
      "/edit/reports/nih-funded-pubs?center=surg&kind=department",
    );
  });

  it("a report with no data yet stays listed as a muted, non-link row reading 'No data yet' — never 'In progress'", () => {
    const { container } = render(<ReportsIndex units={ALL} />);
    const row = within(container).getByTestId("reports-index-row-meyer-4");
    expect(row.tagName).toBe("DIV");
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.querySelector("a")).toBeNull();
    expect(within(row).getByTestId("reports-index-data").textContent).toBe("No data yet");
    expect(row.textContent).not.toContain("In progress");
  });

  it("data labels: report 1 is a dated snapshot, report 2 names its cycle", () => {
    const { container } = render(<ReportsIndex units={ALL} />);
    const c = within(container);
    expect(
      within(c.getByTestId("reports-index-row-meyer-1")).getByTestId("reports-index-data")
        .textContent,
    ).toBe("Snapshot · refreshed Sep 20, 2026");
    expect(
      within(c.getByTestId("reports-index-row-meyer-2")).getByTestId("reports-index-data")
        .textContent,
    ).toBe("Cycle osra-2026-07-14");
  });

  it("access is plain text in the row: audience + '+ N others'; no popover trigger on the index", () => {
    const { container } = render(<ReportsIndex units={ALL} />);
    const c = within(container);
    expect(
      within(c.getByTestId("reports-index-row-institution-8")).getByTestId("reports-index-access")
        .textContent,
    ).toBe("All unit administrators + 2 others");
    expect(
      within(c.getByTestId("reports-index-row-mentoring-programs-7")).getByTestId(
        "reports-index-access",
      ).textContent,
    ).toBe("Superusers and comms stewards");
    expect(c.queryByTestId("report-access-trigger")).toBeNull();
    expect(container.querySelector("button[aria-label='Who can run this report']")).toBeNull();
  });

  it("keeps an 'Edit <kind> profile' link on a unit group, none on a pseudo-unit", () => {
    const { container } = render(<ReportsIndex units={[...ALL, SURGERY]} />);
    const c = within(container);
    expect(c.getByTestId("reports-index-edit-meyer").getAttribute("href")).toBe(
      "/edit/center/meyer",
    );
    expect(c.getByTestId("reports-index-edit-meyer").textContent).toBe("Edit center profile");
    expect(c.getByTestId("reports-index-edit-surg").textContent).toBe("Edit department profile");
    expect(c.queryByTestId("reports-index-edit-institution")).toBeNull();
    expect(c.queryByTestId("reports-index-edit-mentoring-programs")).toBeNull();
  });
});

describe("ReportsIndex — search", () => {
  const search = (container: HTMLElement, value: string) =>
    fireEvent.change(within(container).getByTestId("reports-index-search"), { target: { value } });

  it("matches the report name, summary, unit name and number", () => {
    const { container } = render(<ReportsIndex units={ALL} />);
    search(container, "grants");
    expect(rowIds(container)).toEqual(["reports-index-row-meyer-4"]);
    search(container, "co-authorship");
    expect(rowIds(container)).toEqual(["reports-index-row-mentoring-programs-7"]);
    search(container, "meyer");
    expect(rowIds(container)).toHaveLength(4);
    search(container, "#8");
    expect(rowIds(container)).toEqual(["reports-index-row-institution-8"]);
  });

  it("no match → 'No reports match.' with a Clear filters button that restores the list", () => {
    const { container } = render(<ReportsIndex units={ALL} />);
    search(container, "zzz");
    const empty = within(container).getByTestId("reports-index-empty");
    expect(empty.textContent).toContain("No reports match.");
    fireEvent.click(within(empty).getByRole("button", { name: "Clear filters" }));
    expect(rowIds(container)).toHaveLength(6);
    expect((within(container).getByTestId("reports-index-search") as HTMLInputElement).value).toBe(
      "",
    );
  });

  it("no units at all → a plain empty line, no Clear filters", () => {
    const { container } = render(<ReportsIndex units={[]} />);
    const empty = within(container).getByTestId("reports-index-empty");
    expect(empty.textContent).toBe("No reports to show.");
    expect(within(empty).queryByRole("button")).toBeNull();
  });
});

describe("ReportsIndex — scope segments", () => {
  const seg = (container: HTMLElement, k: string) =>
    within(container).queryByTestId(`reports-index-scope-${k}`);

  it("All / Institution-wide / Programs / Centers with report counts; the optional kinds only when present", () => {
    const { container } = render(<ReportsIndex units={ALL} />);
    expect(seg(container, "all")?.textContent).toBe("All 6");
    expect(seg(container, "institution")?.textContent).toBe("Institution-wide 1");
    expect(seg(container, "program")?.textContent).toBe("Programs 1");
    expect(seg(container, "center")?.textContent).toBe("Centers 4");
    expect(seg(container, "department")).toBeNull();
    expect(seg(container, "division")).toBeNull();
    expect(seg(container, "core")).toBeNull();

    fireEvent.click(seg(container, "center")!);
    expect(seg(container, "center")?.getAttribute("aria-pressed")).toBe("true");
    expect(groupNames(container)).toEqual(["Meyer Cancer Center"]);
  });

  it("counts follow the search", () => {
    const { container } = render(<ReportsIndex units={ALL} />);
    fireEvent.change(within(container).getByTestId("reports-index-search"), {
      target: { value: "publications" },
    });
    expect(seg(container, "all")?.textContent).toBe("All 2");
    expect(seg(container, "center")?.textContent).toBe("Centers 1");
    expect(seg(container, "institution")?.textContent).toBe("Institution-wide 0");
  });

  it("scoped viewer (hideUnderAll off): departments show under All", () => {
    const { container } = render(<ReportsIndex units={[...ALL, SURGERY]} />);
    expect(seg(container, "department")?.textContent).toBe("Departments 2");
    expect(groupNames(container)).toContain("Surgery");
  });

  it("global viewer: departments are off under All, shown by their own segment, and reached by search", () => {
    const { container } = render(<ReportsIndex units={[...ALL, SURGERY]} hideUnderAll />);
    expect(groupNames(container)).not.toContain("Surgery");
    expect(seg(container, "all")?.textContent).toBe("All 6");
    expect(seg(container, "department")?.textContent).toBe("Departments 2");

    fireEvent.click(seg(container, "department")!);
    expect(groupNames(container)).toEqual(["Surgery"]);

    fireEvent.click(seg(container, "all")!);
    fireEvent.change(within(container).getByTestId("reports-index-search"), {
      target: { value: "surgery" },
    });
    expect(groupNames(container)).toEqual(["Surgery"]);
  });
});

describe("ReportsIndex — In progress (NCI 2A review)", () => {
  it("the pill reads 'In progress · N to review' on report 2 only; the toggle counts and filters to it", () => {
    const { container } = render(<ReportsIndex units={ALL} />);
    const c = within(container);
    expect(c.getByTestId("reports-index-review-pill-meyer").textContent).toBe(
      "In progress · 58 to review",
    );
    expect(
      within(c.getByTestId("reports-index-row-meyer-2")).getByTestId(
        "reports-index-review-pill-meyer",
      ),
    ).toBeTruthy();
    const toggle = c.getByTestId("reports-index-review");
    expect(toggle.textContent).toBe("In progress 1");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(rowIds(container)).toEqual(["reports-index-row-meyer-2"]);
  });

  it("nothing left to review → no pill, toggle reads 0", () => {
    const reviewed: ReportsIndexUnit = {
      ...MEYER,
      perReport: MEYER.perReport.map((p) => (p.n === 2 ? { ...p, toReview: 0 } : p)),
    };
    const { container } = render(<ReportsIndex units={[reviewed]} />);
    expect(within(container).queryByTestId("reports-index-review-pill-meyer")).toBeNull();
    expect(within(container).getByTestId("reports-index-review").textContent).toBe("In progress 0");
  });

  it("no toggle at all for a viewer with no NCI 2A report", () => {
    const { container } = render(<ReportsIndex units={[INSTITUTION, SURGERY]} />);
    expect(within(container).queryByTestId("reports-index-review")).toBeNull();
  });
});

describe("ReportsIndex — URL params", () => {
  it("starts from the initial filters", () => {
    const { container } = render(
      <ReportsIndex
        units={ALL}
        initialQuery="grants"
        initialScope="center"
        initialReview={false}
      />,
    );
    expect(rowIds(container)).toEqual(["reports-index-row-meyer-4"]);
    expect(
      within(container).getByTestId("reports-index-scope-center").getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("an initial scope with no segment falls back to All", () => {
    const { container } = render(<ReportsIndex units={ALL} initialScope="core" />);
    expect(
      within(container).getByTestId("reports-index-scope-all").getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("mirrors q / scope / review into the URL, keeping ?center=", () => {
    window.history.pushState(null, "", "/edit/reports?center=meyer");
    const { container } = render(<ReportsIndex units={ALL} />);
    fireEvent.change(within(container).getByTestId("reports-index-search"), {
      target: { value: "nci" },
    });
    fireEvent.click(within(container).getByTestId("reports-index-scope-center"));
    fireEvent.click(within(container).getByTestId("reports-index-review"));
    expect(replaceState).toHaveBeenLastCalledWith(
      null,
      "",
      "?center=meyer&q=nci&scope=center&review=1",
    );
    fireEvent.click(within(container).getByTestId("reports-index-scope-all"));
    fireEvent.click(within(container).getByTestId("reports-index-review"));
    fireEvent.change(within(container).getByTestId("reports-index-search"), {
      target: { value: "" },
    });
    expect(replaceState).toHaveBeenLastCalledWith(null, "", "?center=meyer");
  });

  it("parseReportsIndexScope accepts the known segments only", () => {
    expect(parseReportsIndexScope("department")).toBe("department");
    expect(parseReportsIndexScope("bogus")).toBe("all");
    expect(parseReportsIndexScope(undefined)).toBe("all");
  });
});

describe("dataLabel", () => {
  it("covers every state", () => {
    expect(dataLabel(3, undefined)).toBe("No data yet");
    expect(dataLabel(1, { n: 1, live: false, lastRefreshedAt: "2026-09-20T16:00:00.000Z" })).toBe(
      "No data yet",
    );
    expect(dataLabel(1, { n: 1, live: true, lastRefreshedAt: null })).toBe("Snapshot");
    expect(dataLabel(2, { n: 2, live: true, lastRefreshedAt: null, reportingCycle: null })).toBe(
      "Live data",
    );
    expect(dataLabel(9, { n: 9, live: true, lastRefreshedAt: null })).toBe("Live data");
  });
});
