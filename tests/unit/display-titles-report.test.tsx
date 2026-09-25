/**
 * Report 10 (Display titles): the rubric is rendered FROM `TITLE_RANK` /
 * `TITLE_RANK_LABEL` (a ladder change shows up without touching the body);
 * the export's Criteria rows state every filter, "All" when unset; the sheet
 * row's columns; the body's pin control is for superuser / comms_steward only
 * (a person-gate grantee may look, not set); and the download link carries
 * the page's own query string. Fixture people are invented.
 */
import { cleanup, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/edit/title-dashboard", async (orig) => ({
  ...(await orig<typeof import("@/lib/edit/title-dashboard")>()),
  loadTitleDashboard: h.load,
}));

import {
  renderDisplayTitlesReport,
  RUBRIC_ROWS,
} from "@/components/edit/reports/display-titles-body";
import {
  classifyTitleRow,
  parseTitleDashboardParams,
  titleDashboardCriteria,
  type TitleDashboardRow,
} from "@/lib/edit/title-dashboard";
import { TITLE_DASHBOARD_COLUMNS, titleDashboardSheetRow } from "@/lib/edit/title-dashboard-xlsx";
import { buildTitleOptions, TITLE_RANK, TITLE_RANK_LABEL } from "@/lib/scholar-title";

afterEach(cleanup);

const NO_ROLES = { chair: false, chief: false, centerDirector: false };

function fixture(cwid: string, name: string, edPrimaryTitle: string, extra: { override?: string; appt?: string } = {}) {
  const options = buildTitleOptions({
    workingTitle: null,
    chiefTitle: null,
    centerHeadTitle: null,
    edPrimaryTitle,
    appointmentTitles: extra.appt ? [{ title: extra.appt }] : [],
  });
  const row = classifyTitleRow(
    { cwid, primaryTitle: extra.override ?? options[0]?.value ?? null, override: extra.override ?? null, options, workingTitle: null,
      texts: [{ title: edPrimaryTitle }, ...(extra.appt ? [{ title: extra.appt }] : [])] },
    { ...NO_ROLES, chair: Boolean(extra.appt) },
    name,
  );
  if (!row) throw new Error(`fixture ${cwid} is not listed`);
  return row;
}

const CHAIR = fixture("zza9001", "Ann Testperson", "Professor of Surgery", { appt: "Chair of Surgery" });
const PINNED = fixture("zzb9002", "Bob Exampleton", "Professor of Medicine", {
  appt: "Chair of Medicine",
  override: "Professor of Medicine",
});
const ROWS: TitleDashboardRow[] = [CHAIR, PINNED];

const SUPER = { cwid: "zzs0001", isSuperuser: true, isCommsSteward: false };
const GRANTEE = { cwid: "zzg0001", isSuperuser: false, isCommsSteward: false };
const BASE = "/edit/reports/display-titles";

async function renderBody(session: object, searchParams: Record<string, string> = {}) {
  const { main } = await renderDisplayTitlesReport({
    n: "10",
    scopes: new Set(["*"]),
    session,
    searchParams,
    basePath: BASE,
  } as unknown as Parameters<typeof renderDisplayTitlesReport>[0]);
  const r = render(<div data-testid="body">{main}</div>);
  return within(r.getByTestId("body"));
}

beforeEach(() => {
  h.load.mockReset().mockResolvedValue(ROWS);
});

describe("rubric", () => {
  it("is every TITLE_RANK entry, by rank, with its TITLE_RANK_LABEL; 'Anything else' last", () => {
    const keys = Object.keys(TITLE_RANK) as Array<keyof typeof TITLE_RANK>;
    expect(RUBRIC_ROWS).toHaveLength(keys.length);
    expect(RUBRIC_ROWS.map((r) => r.rank)).toEqual([...RUBRIC_ROWS.map((r) => r.rank)].sort((a, b) => a - b));
    for (const r of RUBRIC_ROWS) expect(r.label).toBe(TITLE_RANK_LABEL[r.key]);
    expect(RUBRIC_ROWS.at(-1)?.label).toBe("Anything else");
  });

  it("renders at #rubric with the ranks shown as the ladder numbers", async () => {
    const q = await renderBody(SUPER);
    const rubric = q.getByTestId("title-rubric");
    expect(rubric.id).toBe("rubric");
    const cells = [...q.getByTestId("title-rubric-ladder").querySelectorAll("tbody tr")].map((tr) =>
      [...tr.querySelectorAll("td")].map((td) => td.textContent),
    );
    expect(cells[0]).toEqual(["1", TITLE_RANK_LABEL.deanProvost]);
    expect(cells).toContainEqual(["8.5", TITLE_RANK_LABEL.viceChair]);
    expect(cells.at(-1)).toEqual(["—", "Anything else"]);
    expect(within(rubric).getByText("Pins always win.")).toBeTruthy();
  });
});

describe("export rows", () => {
  it("Criteria states every filter, 'All' when unset", () => {
    expect(titleDashboardCriteria(parseTitleDashboardParams(new URLSearchParams()))).toEqual([
      ["Reason", "All"],
      ["Rank band", "All"],
      ["Pinned", "All"],
      ["Winning rule", "All"],
      ["Search", "All"],
    ]);
    const set = parseTitleDashboardParams(
      new URLSearchParams("reason=pinned&band=leadership&pinned=yes&rule=override&q=surg"),
    );
    expect(titleDashboardCriteria(set)).toEqual([
      ["Reason", "Pinned"],
      ["Rank band", "Leadership (ranks 1–8.5)"],
      ["Pinned", "Yes"],
      ["Winning rule", "Pinned"],
      ["Search", "surg"],
    ]);
  });

  it("one sheet row per scholar, in column order, no email", () => {
    expect(TITLE_DASHBOARD_COLUMNS.some((c) => /e-?mail/i.test(c))).toBe(false);
    const row = titleDashboardSheetRow(CHAIR);
    expect(row).toHaveLength(TITLE_DASHBOARD_COLUMNS.length);
    expect(row.slice(0, 5)).toEqual(["Ann Testperson", "zza9001", "Chair of Surgery", "Appointment title", "4"]);
    expect(row[5]).toBe("Professor of Surgery");
    expect(row[6]).toBe("12");
    const pinned = titleDashboardSheetRow(PINNED);
    expect(pinned[3]).toBe("Pinned");
    expect(pinned[8]).toBe("Professor of Medicine");
  });
});

describe("report 10 body", () => {
  it("headline counts: listed and after filters", async () => {
    const q = await renderBody(SUPER, { pinned: "yes" });
    // dt before dd in the DOM (the dl is flex-col-reverse).
    const stats = q.getByTestId("report-stats").textContent ?? "";
    expect(stats).toContain("scholars listed2");
    expect(stats).toContain("after filters1");
    expect(q.getByTestId("title-row-zzb9002")).toBeTruthy();
    expect(q.queryByTestId("title-row-zza9001")).toBeNull();
  });

  it("the download carries the same query string", async () => {
    const q = await renderBody(SUPER, { reason: "pinned", q: "bob" });
    expect(q.getByTestId("display-titles-download").getAttribute("href")).toBe(
      "/api/edit/reports/display-titles?reason=pinned&q=bob",
    );
  });

  it("superuser gets a Change disclosure per row; a grantee does not", async () => {
    const su = await renderBody(SUPER);
    expect(su.getByTestId("title-change-zza9001")).toBeTruthy();
    cleanup();
    const g = await renderBody(GRANTEE);
    expect(g.getByTestId("title-row-zza9001")).toBeTruthy();
    expect(g.queryByTestId("title-change-zza9001")).toBeNull();
  });
});
