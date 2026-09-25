/**
 * Report 10 (Display titles): the rubric is rendered FROM `TITLE_RANK` /
 * `TITLE_RANK_LABEL` (a ladder change shows up without touching the body)
 * and sits collapsed behind a toggle that `#rubric` opens; the export's
 * Criteria rows state every filter, "All" when unset; the sheet row's
 * columns; the page opens on the "Needs review" tab with per-tab counts; the
 * reason chips count within the tab and toggle `?reason=`; the pin control is
 * for superuser / comms_steward only (a person-gate grantee may look, not
 * set) and posts the existing `/api/edit/field` write; and the download link
 * carries the page's own query string, tab included. Fixture people are
 * invented.
 */
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ load: vi.fn(), refresh: vi.fn() }));

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh }) }));
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

const NO_ROLES = { chair: false, chief: false, centerDirector: false };

function fixture(
  cwid: string,
  name: string,
  edPrimaryTitle: string,
  extra: { override?: string; appt?: string } = {},
) {
  const options = buildTitleOptions({
    workingTitle: null,
    chiefTitle: null,
    centerHeadTitle: null,
    edPrimaryTitle,
    appointmentTitles: extra.appt ? [{ title: extra.appt }] : [],
  });
  const row = classifyTitleRow(
    {
      cwid,
      primaryTitle: extra.override ?? options[0]?.value ?? null,
      override: extra.override ?? null,
      options,
      workingTitle: null,
      texts: [{ title: edPrimaryTitle }, ...(extra.appt ? [{ title: extra.appt }] : [])],
    },
    { ...NO_ROLES, chair: Boolean(extra.appt) },
    name,
  );
  if (!row) throw new Error(`fixture ${cwid} is not listed`);
  return row;
}

// fyi: a chair the ladder resolved cleanly.
const CHAIR = fixture("zza9001", "Ann Testperson", "Professor of Surgery", {
  appt: "Chair of Surgery",
});
// review: a pin that chose an academic title over a chair (leadership lost).
const PINNED = fixture("zzb9002", "Bob Exampleton", "Professor of Medicine", {
  appt: "Chair of Medicine",
  override: "Professor of Medicine",
});
// review: chair text with no chair role (mismatch).
const MISMATCH = fixture("zzc9003", "Cy Samplewell", "Chair of Pediatrics");
// pinned: a pin that matches the ladder, no issue.
const PIN_CLEAN = fixture("zzd9004", "Dee Mockford", "Professor of Pediatrics", {
  appt: "Chair of Pediatrics",
  override: "Chair of Pediatrics",
});
const ROWS: TitleDashboardRow[] = [CHAIR, PINNED, MISMATCH, PIN_CLEAN];

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
  h.refresh.mockReset();
});

describe("rubric", () => {
  it("is every TITLE_RANK entry, by rank, with its TITLE_RANK_LABEL; 'Anything else' last", () => {
    const keys = Object.keys(TITLE_RANK) as Array<keyof typeof TITLE_RANK>;
    expect(RUBRIC_ROWS).toHaveLength(keys.length);
    expect(RUBRIC_ROWS.map((r) => r.rank)).toEqual(
      [...RUBRIC_ROWS.map((r) => r.rank)].sort((a, b) => a - b),
    );
    for (const r of RUBRIC_ROWS) expect(r.label).toBe(TITLE_RANK_LABEL[r.key]);
    expect(RUBRIC_ROWS.at(-1)?.label).toBe("Anything else");
  });

  it("renders at #rubric, collapsed, and the toggle shows the ladder and rules", async () => {
    const q = await renderBody(SUPER);
    const rubric = q.getByTestId("title-rubric");
    expect(rubric.id).toBe("rubric");
    const ladder = q.getByTestId("title-rubric-ladder");
    expect(ladder.closest("[hidden]")).not.toBeNull();
    const toggle = q.getByTestId("title-rubric-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(ladder.closest("[hidden]")).toBeNull();
    const cells = [...ladder.querySelectorAll("li")].map((li) =>
      [...li.querySelectorAll("span")].map((s) => s.textContent),
    );
    expect(cells[0]).toEqual(["1", TITLE_RANK_LABEL.deanProvost]);
    expect(cells).toContainEqual(["8.5", TITLE_RANK_LABEL.viceChair]);
    expect(cells.at(-1)).toEqual(["—", "Anything else"]);
    expect(within(rubric).getByText("Pins always win.")).toBeTruthy();
  });

  it("opens by itself when the page lands on #rubric (the /edit title picker's link)", async () => {
    window.location.hash = "#rubric";
    const q = await renderBody(SUPER);
    expect(q.getByTestId("title-rubric-toggle").getAttribute("aria-expanded")).toBe("true");
  });
});

describe("export rows", () => {
  it("Criteria states every filter, 'All' when unset", () => {
    expect(titleDashboardCriteria(parseTitleDashboardParams(new URLSearchParams()))).toEqual([
      ["Tab", "All"],
      ["Reason", "All"],
      ["Rank band", "All"],
      ["Pinned", "All"],
      ["Winning rule", "All"],
      ["Search", "All"],
    ]);
    const set = parseTitleDashboardParams(
      new URLSearchParams(
        "tab=pinned&reason=pinned&band=leadership&pinned=yes&rule=override&q=surg",
      ),
    );
    expect(titleDashboardCriteria(set)).toEqual([
      ["Tab", "Pinned"],
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
    expect(row.slice(0, 5)).toEqual([
      "Ann Testperson",
      "zza9001",
      "Chair of Surgery",
      "Appointment title",
      "4",
    ]);
    expect(row[5]).toBe("Professor of Surgery");
    expect(row[6]).toBe("12");
    const pinned = titleDashboardSheetRow(PINNED);
    expect(pinned[3]).toBe("Pinned");
    expect(pinned[8]).toBe("Professor of Medicine");
  });
});

describe("report 10 body", () => {
  it("opens on Needs review, with each tab's count over every listed scholar", async () => {
    const q = await renderBody(SUPER);
    const tab = (t: string) => q.getByTestId(`display-titles-tab-${t}`);
    expect(tab("review").getAttribute("aria-current")).toBe("page");
    expect(tab("review").textContent).toBe("Needs review2");
    expect(tab("pinned").textContent).toBe("Pinned1");
    expect(tab("fyi").textContent).toBe("Leadership, no issues1");
    expect(tab("all").textContent).toBe("All4");
    // The default tab stays off the URL; the others carry it.
    expect(tab("review").getAttribute("href")).toBe(BASE);
    expect(tab("all").getAttribute("href")).toBe(`${BASE}?tab=all`);
    expect(q.getByTestId("title-row-zzc9003")).toBeTruthy();
    expect(q.getByTestId("title-row-zzb9002")).toBeTruthy();
    expect(q.queryByTestId("title-row-zza9001")).toBeNull();
    expect(q.queryByTestId("title-row-zzd9004")).toBeNull();
    expect(q.getByTestId("display-titles-count").textContent).toBe("2 of 2 scholars");
  });

  it("filters within the tab; the count reads shown of in-tab", async () => {
    const q = await renderBody(SUPER, { tab: "all", pinned: "yes" });
    expect(q.getByTestId("title-row-zzb9002")).toBeTruthy();
    expect(q.getByTestId("title-row-zzd9004")).toBeTruthy();
    expect(q.queryByTestId("title-row-zza9001")).toBeNull();
    expect(q.getByTestId("display-titles-count").textContent).toBe("2 of 4 scholars");
  });

  it("reason chips count within the tab and toggle ?reason=", async () => {
    const q = await renderBody(SUPER, { tab: "all" });
    const leadership = q.getByTestId("display-titles-reason-leadership");
    expect(leadership.textContent).toBe("Leadership · 4");
    expect(leadership.getAttribute("href")).toBe(`${BASE}?tab=all&reason=leadership`);
    expect(q.getByTestId("display-titles-reason-mismatch").textContent).toBe("Mismatch · 1");
    // No row is contested, so no chip for it.
    expect(q.queryByTestId("display-titles-reason-contested")).toBeNull();
    cleanup();
    const on = await renderBody(SUPER, { tab: "all", reason: "mismatch" });
    const chip = on.getByTestId("display-titles-reason-mismatch");
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(chip.getAttribute("href")).toBe(`${BASE}?tab=all`);
    expect(on.getByTestId("display-titles-count").textContent).toBe("1 of 4 scholars");
  });

  it("the download carries the same query string, tab included", async () => {
    const q = await renderBody(SUPER, { reason: "pinned", q: "bob", tab: "all" });
    expect(q.getByTestId("display-titles-download").getAttribute("href")).toBe(
      "/api/edit/reports/display-titles?tab=all&reason=pinned&q=bob",
    );
    cleanup();
    const d = await renderBody(SUPER);
    expect(d.getByTestId("display-titles-download").getAttribute("href")).toBe(
      "/api/edit/reports/display-titles?tab=review",
    );
  });

  it("superuser gets Change per row; a grantee does not", async () => {
    const su = await renderBody(SUPER);
    expect(su.getByTestId("title-change-zzc9003")).toBeTruthy();
    cleanup();
    const g = await renderBody(GRANTEE);
    expect(g.getByTestId("title-row-zzc9003")).toBeTruthy();
    expect(g.queryByTestId("title-change-zzc9003")).toBeNull();
  });

  it("Change opens the pin panel; Pin this posts the existing field write and refreshes", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ primaryTitle: "Professor of Surgery" })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const q = await renderBody(SUPER, { tab: "all" });
    fireEvent.click(q.getByTestId("title-change-zza9001"));
    const panel = q.getByTestId("title-pin-panel-zza9001");
    expect(within(panel).getByText("Displayed now")).toBeTruthy();
    // Not pinned: no Unpin.
    expect(within(panel).queryByText("Unpin")).toBeNull();
    await act(async () => {
      fireEvent.click(within(panel).getByText("Pin this"));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/edit/field");
    expect(JSON.parse(String(init.body))).toEqual({
      op: "set",
      entityType: "scholar",
      entityId: "zza9001",
      fieldName: "primaryTitle",
      value: "Professor of Surgery",
    });
    expect(h.refresh).toHaveBeenCalled();
  });

  it("a pinned row offers Unpin, which clears with an empty value", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ primaryTitle: "Chair of Medicine" })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const q = await renderBody(SUPER, { tab: "pinned" });
    fireEvent.click(q.getByTestId("title-change-zzd9004"));
    await act(async () => {
      fireEvent.click(q.getByTestId("title-unpin-zzd9004"));
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).value).toBe("");
  });
});
