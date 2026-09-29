/**
 * The three core-only report bodies render (reports 11–13): headline, tabs
 * that keep the core addressed (`center=<coreId>&kind=core`), the table /
 * bars, the download link or — for report 11 over `SCHOLAR_EXPORT_CAP` — the
 * refusal note with NO link, and report 13's non-NIH note. Report 11's full
 * body is rendered once with its loaders mocked, to pin the rail's hidden core
 * inputs. Assertions are scoped to the rendered container, never
 * `document.body`. Fixture data is invented.
 */
import { cleanup, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ pmids: vi.fn(), load: vi.fn() }));

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} }, prisma: {} }));
vi.mock("@/lib/edit/core-report-common", async (orig) => ({
  ...(await orig<typeof import("@/lib/edit/core-report-common")>()),
  loadCoreConfirmedPmids: h.pmids,
}));
vi.mock("@/lib/edit/core-users-report", async (orig) => ({
  ...(await orig<typeof import("@/lib/edit/core-users-report")>()),
  loadCoreUsersReport: h.load,
}));

import { CoreGrantsView } from "@/components/edit/reports/core-grants-body";
import { CoreOutputView } from "@/components/edit/reports/core-output-over-time-body";
import { CoreUsersView, renderCoreUsersReport } from "@/components/edit/reports/core-users-body";
import { buildCoreOutput, parseCoreOutputParams } from "@/lib/edit/core-output-report";
import { filterAwards, parseCoreGrantsParams, type AwardRow } from "@/lib/edit/core-grants-report";
import {
  buildCoreUsers,
  parseCoreUsersParams,
  type CoreAuthorship,
} from "@/lib/edit/core-users-report";
import type { UnitReportProps } from "@/lib/edit/report-registry";

afterEach(cleanup);

const CORE = "14";

function authorships(n: number): CoreAuthorship[] {
  return Array.from({ length: n }, (_, i) => ({
    cwid: `u${i}`,
    name: `User ${i}`,
    deptCode: "MED",
    department: "Medicine",
    roleCategory: "full_time_faculty",
    pmid: String(i),
    year: 2024,
  }));
}

function users(n: number, clients: string[] = []) {
  return buildCoreUsers(authorships(n), {
    whoMatch: null,
    clientCwids: new Set(clients),
    params: { client: "any", minPapers: 0, from: null, to: null },
  });
}

describe("report 11 — CoreUsersView", () => {
  const BASE = "/edit/reports/core-users";

  it("lists people with the known-client marker, and a download link scoped to the core", () => {
    const { container } = render(
      <CoreUsersView
        coreId={CORE}
        basePath={BASE}
        params={parseCoreUsersParams(new URLSearchParams())}
        result={users(2, ["u1"])}
        totalConfirmed={2}
      />,
    );
    const view = within(container);
    const table = view.getByTestId("core-users-table");
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(within(table).getAllByTestId("core-users-known-client")).toHaveLength(1);
    expect(view.getByTestId("core-users-download").getAttribute("href")).toBe(
      "/api/edit/reports/core-users?center=14&kind=core",
    );
    expect(view.getByTestId("core-users-view-departments").getAttribute("href")).toBe(
      `${BASE}?center=14&kind=core&view=departments`,
    );
  });

  it("below lg: stacked cards carry papers + active years; the table is desktop-only", () => {
    const { container } = render(
      <CoreUsersView
        coreId={CORE}
        basePath={BASE}
        params={parseCoreUsersParams(new URLSearchParams())}
        result={users(2, ["u1"])}
        totalConfirmed={2}
      />,
    );
    const view = within(container);
    const cards = view.getByTestId("core-users-cards");
    expect(cards.className).toContain("lg:hidden");
    expect(view.getByTestId("core-users-table").parentElement!.className).toContain("hidden");
    const items = within(cards).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toMatch(/\d+ papers?/);
    expect(cards.textContent).toContain("Known client");
  });

  it("over the scholar-list cap: no download link, the note says why", () => {
    const { container } = render(
      <CoreUsersView
        coreId={CORE}
        basePath={BASE}
        params={parseCoreUsersParams(new URLSearchParams())}
        result={users(51)}
        totalConfirmed={51}
      />,
    );
    const view = within(container);
    expect(view.queryByTestId("core-users-download")).toBeNull();
    expect(view.getByTestId("core-users-download-note").textContent).toMatch(
      /51 people match.*50 or fewer/,
    );
  });

  it("Departments tab shows the roll-up bars", () => {
    const { container } = render(
      <CoreUsersView
        coreId={CORE}
        basePath={BASE}
        params={parseCoreUsersParams(new URLSearchParams("view=departments"))}
        result={users(3)}
        totalConfirmed={3}
      />,
    );
    const bars = within(container).getByTestId("core-users-departments");
    expect(bars.textContent).toContain("Medicine");
    expect(bars.textContent).toContain("3 · 3");
  });

  it("the full body's rail keeps the core addressed on submit", async () => {
    h.pmids.mockResolvedValue(["0", "1"]);
    h.load.mockResolvedValue(users(2));
    const out = await renderCoreUsersReport({
      n: "11",
      code: CORE,
      kind: "core",
      ctx: { unit: { name: "Research Informatics" } },
      session: {} as UnitReportProps["session"],
      searchParams: { center: CORE, kind: "core" },
      basePath: BASE,
    });
    const { container } = render(<>{out.main}</>);
    const form = within(container).getAllByTestId("core-users-filters")[0] as HTMLFormElement;
    expect((form.elements.namedItem("center") as HTMLInputElement).value).toBe(CORE);
    expect((form.elements.namedItem("kind") as HTMLInputElement).value).toBe("core");
  });
});

describe("report 12 — CoreOutputView", () => {
  const NOW = new Date("2026-09-28T12:00:00Z");
  const params = parseCoreOutputParams(new URLSearchParams("from=2025&to=2026"), NOW);
  const result = buildCoreOutput(
    [
      { pmid: "1", title: "Paper one", journal: "J", year: 2025, dateAdded: null, evidence: "ack" },
      {
        pmid: "2",
        title: "Paper two",
        journal: "J",
        year: 2026,
        dateAdded: null,
        evidence: "manual",
      },
    ],
    params,
  );

  it("one bar per year, the current year tagged YTD, each opening to its papers", () => {
    const { container } = render(
      <CoreOutputView
        coreId={CORE}
        basePath="/edit/reports/core-output-over-time"
        params={params}
        result={result}
        now={NOW}
      />,
    );
    const bars = within(container).getByTestId("core-output-years");
    const items = within(bars)
      .getAllByRole("listitem")
      .filter((li) => li.querySelector("details"));
    expect(items).toHaveLength(2);
    expect(items[1].textContent).toContain("YTD");
    expect(items[1].textContent).toContain("Paper two");
    expect(items[1].textContent).toContain("Manually added");
    expect(within(container).getByTestId("core-output-download").getAttribute("href")).toContain(
      "center=14&kind=core",
    );
  });

  it("Publications tab lists the papers", () => {
    const { container } = render(
      <CoreOutputView
        coreId={CORE}
        basePath="/edit/reports/core-output-over-time"
        params={{ ...params, view: "publications" }}
        result={result}
        now={NOW}
      />,
    );
    expect(
      within(within(container).getByTestId("core-output-table")).getAllByRole("row"),
    ).toHaveLength(3);
  });

  it("Publications tab below lg: stacked cards carry year + evidence", () => {
    const { container } = render(
      <CoreOutputView
        coreId={CORE}
        basePath="/edit/reports/core-output-over-time"
        params={{ ...params, view: "publications" }}
        result={result}
        now={NOW}
      />,
    );
    const cards = within(container).getByTestId("core-output-cards");
    expect(cards.className).toContain("lg:hidden");
    const items = within(cards).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    const p = result.publications[0];
    expect(items[0].textContent).toContain(String(p.basisYear));
  });
});

describe("report 13 — CoreGrantsView", () => {
  const award: AwardRow = {
    key: "TR002384",
    awardNumber: "UL1TR002384",
    title: "Clinical and Translational Science Center",
    piCwid: "pi0001",
    piName: "Pat PI",
    funder: "NIH",
    mechanism: "UL1",
    start: "2019-07-01",
    end: "2029-06-30",
    active: true,
    papers: 24,
  };

  it("one row per award with the non-NIH note under the headline", () => {
    const { container } = render(
      <CoreGrantsView
        coreId={CORE}
        basePath="/edit/reports/core-grants"
        params={parseCoreGrantsParams(new URLSearchParams())}
        result={filterAwards([award], parseCoreGrantsParams(new URLSearchParams()))}
      />,
    );
    const view = within(container);
    expect(view.getAllByTestId("core-grants-row")).toHaveLength(1);
    expect(view.getByTestId("core-grants-row").textContent).toContain("Pat PI");
    expect(view.getByTestId("core-grants-nih-note").textContent).toBe(
      "Only NIH grants held by Weill Cornell investigators can be linked to papers. Other funding won't appear here.",
    );
    expect(view.getByTestId("core-grants-view-funders").getAttribute("href")).toBe(
      "/edit/reports/core-grants?center=14&kind=core&view=funders",
    );
  });

  it("below lg: stacked cards keep period, status and papers on screen", () => {
    const { container } = render(
      <CoreGrantsView
        coreId={CORE}
        basePath="/edit/reports/core-grants"
        params={parseCoreGrantsParams(new URLSearchParams())}
        result={filterAwards([award], parseCoreGrantsParams(new URLSearchParams()))}
      />,
    );
    const view = within(container);
    const cards = view.getByTestId("core-grants-cards");
    expect(cards.className).toContain("lg:hidden");
    expect(view.getByTestId("core-grants-table").parentElement!.className).toContain("hidden");
    const card = within(cards).getByRole("listitem");
    expect(card.textContent).toContain("Pat PI");
    expect(card.textContent).toContain("Active");
    expect(card.textContent).toContain("24 papers");
  });
});
