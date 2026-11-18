/**
 * Report 23 — Vice Chairs across departments (`loadViceChairReport`).
 *
 *  - a holder who has left WCM is not listed;
 *  - filters: area (a code, or `general` for no area), department, site
 *    (`any` = any site-based role), and a name/title search;
 *  - rows sort by department, then modifier rank, then name;
 *  - an adjunct-titled holder is marked not full-time faculty.
 */
import { describe, expect, it, vi } from "vitest";

import { loadViceChairReport, parseViceChairReportParams } from "@/lib/edit/unit-leadership-report";

const holder = (name: string, over: Record<string, unknown> = {}) => ({
  preferredName: name,
  primaryTitle: "Professor of Medicine",
  edPrimaryTitle: null,
  roleCategory: "full_time_faculty",
  deletedAt: null,
  status: "active",
  ...over,
});
const ROWS = [
  { id: "1", cwid: "a", entityId: "N1", displayTitle: "Vice Chair of Research", tier: "vice", functions: "research", areaText: null, site: null, scholar: holder("Zoe Med") },
  { id: "2", cwid: "b", entityId: "N1", displayTitle: "Executive Vice Chair", tier: "executive", functions: "", areaText: null, site: null, scholar: holder("Yan Med") },
  { id: "3", cwid: "c", entityId: "N2", displayTitle: "Associate Vice Chair of Research", tier: "associate", functions: "research", areaText: null, site: null, scholar: holder("Abe Anes", { primaryTitle: "Adjunct Professor of Anesthesiology" }) },
  { id: "4", cwid: "d", entityId: "N1", displayTitle: "Vice Chair, Weill Department of Medicine", tier: "vice", functions: "", areaText: null, site: "nyp_queens", scholar: holder("Sam Site") },
  { id: "5", cwid: "e", entityId: "N1", displayTitle: "Vice Chair of Education", tier: "vice", functions: "education", areaText: null, site: null, scholar: holder("Gone Person", { deletedAt: new Date() }) },
  { id: "6", cwid: "a", entityId: "N1", displayTitle: "Vice Chair of Innovation", tier: "vice", functions: "innovation", areaText: null, site: null, scholar: holder("Zoe Med") },
];
const client = () =>
  ({
    unitLeadershipRole: { findMany: vi.fn().mockResolvedValue(ROWS) },
    department: {
      findMany: vi.fn().mockResolvedValue([
        { code: "N1", name: "Medicine" },
        { code: "N2", name: "Anesthesiology" },
      ]),
    },
  }) as never;
const run = (sp: Record<string, string> = {}) => loadViceChairReport(client(), parseViceChairReportParams(sp));

describe("loadViceChairReport", () => {
  it("lists active holders, sorted by department, modifier rank, then name", async () => {
    const r = await run();
    expect(r.total).toBe(5);
    expect(r.people).toBe(4);
    expect(r.departments).toEqual([
      { code: "N2", name: "Anesthesiology", count: 1 },
      { code: "N1", name: "Medicine", count: 4 },
    ]);
    expect(r.rows.map((x) => x.id)).toEqual(["3", "2", "4", "1", "6"]);
    expect(r.rows.find((x) => x.id === "3")?.fullTimeFaculty).toBe(false);
    expect(r.rows.find((x) => x.id === "1")?.fullTimeFaculty).toBe(true);
  });

  it.each([
    [{ area: "research" }, ["3", "1"]],
    [{ area: "general" }, ["2", "4"]],
    [{ dept: "N2" }, ["3"]],
    [{ site: "any" }, ["4"]],
    [{ site: "nyp_queens" }, ["4"]],
    [{ site: "nyp_westchester" }, []],
    [{ q: "zoe" }, ["1", "6"]],
    [{ q: "EXECUTIVE" }, ["2"]],
    [{ area: "research", dept: "N1" }, ["1"]],
    [{ area: "nonsense", site: "nowhere" }, ["3", "2", "4", "1", "6"]],
  ])("filters %j", async (sp, ids) => {
    expect((await run(sp as Record<string, string>)).rows.map((x) => x.id)).toEqual(ids);
  });
});
