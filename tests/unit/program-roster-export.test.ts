/** The roster's Excel download: who gets it and what is in the file. */
import ExcelJS from "exceljs";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ identity: vi.fn(), load: vi.fn() }));
vi.mock("@/lib/edit/request", async () => {
  const { NextResponse } = await import("next/server");
  return {
    resolveEditIdentity: h.identity,
    editError: (status: number, error: string) => NextResponse.json({ ok: false, error }, { status }),
  };
});
vi.mock("@/lib/edit/program-roster.server", () => ({ loadProgramRoster: h.load }));
vi.mock("@/lib/db", () => ({ db: { read: {} } }));

import { GET } from "@/app/api/edit/program-roster/export/route";

const NONE = { cwid: "x00001", isSuperuser: false, isCommsSteward: false };
const EDITOR = { ...NONE, cwid: "edi001", isProgramRosterEditor: true };
const as = (session: unknown, impersonatedCwid: string | null = null) =>
  h.identity.mockResolvedValue({ session, realCwid: "edi001", impersonatedCwid });
const entry = (i: number, year: number, programId = "p1") => ({
  id: `e${i}-${year}`,
  programId,
  mentee: { cwid: `tra${i}`, name: i === 0 ? "=Avery Quill" : `Trainee ${i}` },
  year,
  researchProgram: null,
  mentors: [{ cwid: "men001", name: "Jordan Vale" }],
});
const get = (qs = "program=p1") => GET(new NextRequest(`http://localhost/api/edit/program-roster/export?${qs}`));
const log = vi.spyOn(console, "log");
const PROGRAMS = [{ id: "p1", name: "Summer program", shortLabel: 'S"U/M', description: null, retiredAt: null }];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("EDIT_PROGRAM_ROSTER", "on");
  log.mockImplementation(() => {});
  as(EDITOR);
  h.load.mockResolvedValue({
    programs: PROGRAMS,
    entries: [0, 1, 2, 3, 4].map((i) => entry(i, 2026)).concat(entry(5, 2025), entry(6, 2026, "other")),
  });
});

describe("program roster export", () => {
  it.each<[string, Record<string, unknown>]>([
    ["no role", NONE],
    ["comms_steward", { ...NONE, isCommsSteward: true }],
    ["observer", { ...NONE, isCommsSteward: true, isObserver: true }],
    ["content editor", { ...NONE, isCommsSteward: true, isContentEditor: true }],
    ["an overlay a non-superuser started", { ...EDITOR, sensitiveDashboardsBlocked: true }],
  ])("%s gets 404 and nothing is read", async (_n, s) => {
    as(s);
    expect((await get()).status).toBe(404);
    expect(h.load).not.toHaveBeenCalled();
  });

  it("signed out is 401; the flag off is 404; a bad year is 400; an unknown program is 404", async () => {
    h.identity.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
    as(EDITOR);
    expect((await get("program=p1&year=26")).status).toBe(400);
    expect((await get("program=nope")).status).toBe(404);
    expect((await get("")).status).toBe(404);
    vi.stubEnv("EDIT_PROGRAM_ROSTER", "off");
    expect((await get()).status).toBe(404);
  });

  it("writes one program's filtered people, all-years mentor counts and the criteria; logs no names", async () => {
    const res = await get("program=p1&year=2026");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toMatch(/filename="SUM roster \d{4}-\d\d-\d\d\.xlsx"/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await res.arrayBuffer());
    const rows = (name: string) =>
      (wb.getWorksheet(name)!.getSheetValues() as unknown[][]).filter(Boolean).map((r) => r.slice(1));
    expect(rows("People")).toHaveLength(6); // header + five of 2026
    expect(rows("People")[1]).toEqual(["=Avery Quill", "tra0", 2026, "Jordan Vale", "men001", ""]); // text, not a formula
    expect(rows("Mentors")[1]).toEqual(["Jordan Vale", "men001", 6, 5, 2025, 2026]);
    expect(rows("Criteria")).toContainEqual(["Year", "2026"]);
    const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes("export_program_roster"))!;
    expect(JSON.parse(line)).toMatchObject({ realCwid: "edi001", impersonatedCwid: null, rows: 5 });
    expect(line).not.toMatch(/Quill|tra0|Vale/);
  });

  it("is exempt from the 50-person export cap: a list of 120 downloads in full", async () => {
    const many = Array.from({ length: 120 }, (_, i) => entry(i, 2026));
    h.load.mockResolvedValue({ programs: PROGRAMS, entries: many });
    const res = await get();
    expect(res.status).toBe(200);
    const line = log.mock.calls.map((c) => String(c[0])).findLast((l) => l.includes("export_program_roster"))!;
    expect(JSON.parse(line)).toMatchObject({ rows: 120 });
  });
});
