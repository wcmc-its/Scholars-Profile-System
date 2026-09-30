/**
 * The three core report downloads under "All cores" (`center=all&kind=core`):
 * each reads the roll-up scope (`loadCoreScope`, the deduped union), writes
 * "Core: All N" into the Criteria sheet (`{ allCount }`) and names the file
 * `all-cores-…`; report 11 still REFUSES above `SCHOLAR_EXPORT_CAP` (409, no
 * workbook, never truncated); report 12 hands the per-core map to the merge.
 * Single-core downloads keep their name. Ids are invented.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  gate: vi.fn(),
  pmids: vi.fn(),
  scope: vi.fn(),
  users: vi.fn(),
  usersWb: vi.fn(),
  outputPubs: vi.fn(),
  outputWb: vi.fn(),
  awards: vi.fn(),
  grantsWb: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} }, prisma: {} }));
vi.mock("@/lib/edit/core-report-common", async (orig) => ({
  ...(await orig<typeof import("@/lib/edit/core-report-common")>()),
  gateCoreReportDownload: h.gate,
  loadCoreConfirmedPmids: h.pmids,
  loadCoreScope: h.scope,
}));
vi.mock("@/lib/edit/core-users-report", async (orig) => ({
  ...(await orig<typeof import("@/lib/edit/core-users-report")>()),
  loadCoreUsersReport: h.users,
  buildCoreUsersWorkbook: h.usersWb,
}));
vi.mock("@/lib/edit/core-output-report", async (orig) => ({
  ...(await orig<typeof import("@/lib/edit/core-output-report")>()),
  loadCoreOutputPubs: h.outputPubs,
  buildCoreOutputWorkbook: h.outputWb,
}));
vi.mock("@/lib/edit/core-grants-report", async (orig) => ({
  ...(await orig<typeof import("@/lib/edit/core-grants-report")>()),
  loadCoreGrantAwards: h.awards,
  buildCoreGrantsWorkbook: h.grantsWb,
}));

import { GET as grantsGET } from "@/app/api/edit/reports/core-grants/route";
import { GET as outputGET } from "@/app/api/edit/reports/core-output-over-time/route";
import { GET as usersGET } from "@/app/api/edit/reports/core-users/route";

const req = (path: string, qs: string) =>
  ({
    nextUrl: new URL(`http://x/api/edit/reports/${path}?${qs}`),
  }) as unknown as import("next/server").NextRequest;
const ALL_QS = "center=all&kind=core";
const BY_CORE = new Map([
  ["1", ["100", "200"]],
  ["2", ["200"]],
  ["3", []],
]);
const people = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ cwid: `p${i}`, name: `P${i}`, papers: 1 }));
const filename = (res: Response) =>
  /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1];

beforeEach(() => {
  vi.clearAllMocks();
  h.gate.mockResolvedValue({
    ok: true,
    coreId: "all",
    ctx: { unit: { name: "All cores" } },
    session: { isSuperuser: true },
  });
  h.scope.mockResolvedValue({ coreIds: ["1", "2", "3"], byCore: BY_CORE, pmids: ["100", "200"] });
  for (const wb of [h.usersWb, h.outputWb, h.grantsWb]) wb.mockResolvedValue(Buffer.from("xlsx"));
});

describe("all-cores downloads", () => {
  it("report 11: the union, 'All 3' criteria, an all-cores file", async () => {
    h.users.mockResolvedValue({
      people: people(2),
      departments: [],
      typeOptions: [],
      deptOptions: [],
    });
    const res = await usersGET(req("core-users", ALL_QS));
    expect(res.status).toBe(200);
    expect(h.users).toHaveBeenCalledWith("all", ["100", "200"], expect.anything());
    expect(h.pmids).not.toHaveBeenCalled();
    expect(h.usersWb.mock.calls[0][0]).toEqual({ allCount: 3 });
    expect(filename(res)).toMatch(/^all-cores-core-users-\d{4}-\d{2}-\d{2}\.xlsx$/);
  });

  it("report 11 over the scholar cap: 409 and no workbook, as for one core", async () => {
    h.users.mockResolvedValue({
      people: people(51),
      departments: [],
      typeOptions: [],
      deptOptions: [],
    });
    const res = await usersGET(req("core-users", ALL_QS));
    expect(res.status).toBe(409);
    expect(h.usersWb).not.toHaveBeenCalled();
  });

  it("report 12: the per-core map reaches the merge; all-cores file", async () => {
    h.outputPubs.mockResolvedValue([]);
    const res = await outputGET(req("core-output-over-time", `${ALL_QS}&from=2018&to=2026`));
    expect(h.outputPubs).toHaveBeenCalledWith("all", ["100", "200"], BY_CORE);
    expect(h.outputWb.mock.calls[0][0]).toEqual({ allCount: 3 });
    expect(filename(res)).toMatch(/^all-cores-output-2018-2026-\d{4}-\d{2}-\d{2}\.xlsx$/);
  });

  it("report 13: the union's grants; all-cores file", async () => {
    h.awards.mockResolvedValue({ awards: [], pmidsByKey: new Map() });
    const res = await grantsGET(req("core-grants", ALL_QS));
    expect(h.awards.mock.calls[0][0]).toEqual(["100", "200"]);
    expect(h.grantsWb.mock.calls[0][0]).toEqual({ allCount: 3 });
    expect(filename(res)).toMatch(/^all-cores-grants-\d{4}-\d{2}-\d{2}\.xlsx$/);
  });

  it("one core: no roll-up scope read, the core's name on the file and in Criteria", async () => {
    h.gate.mockResolvedValue({
      ok: true,
      coreId: "14",
      ctx: { unit: { name: "Alpha Core" } },
      session: {},
    });
    h.pmids.mockResolvedValue(["100"]);
    h.outputPubs.mockResolvedValue([]);
    const res = await outputGET(
      req("core-output-over-time", "center=14&kind=core&from=2018&to=2026"),
    );
    expect(h.scope).not.toHaveBeenCalled();
    expect(h.outputPubs).toHaveBeenCalledWith("14", ["100"], undefined);
    expect(h.outputWb.mock.calls[0][0]).toBe("Alpha Core");
    expect(filename(res)).toMatch(/^Alpha Core output 2018-2026 \d{4}-\d{2}-\d{2}\.xlsx$/);
  });

  it("a refused gate stops the route before any read", async () => {
    const refused = new Response(null, { status: 403 });
    h.gate.mockResolvedValue({ ok: false, response: refused });
    const res = await usersGET(req("core-users", ALL_QS));
    expect(res.status).toBe(403);
    expect(h.scope).not.toHaveBeenCalled();
    expect(h.users).not.toHaveBeenCalled();
  });
});
