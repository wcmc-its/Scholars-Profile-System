/**
 * GET /api/edit/reports/mentored-publications — the `.xlsx` download route's
 * gating, param handling and headers. Mirrors `data-sharing-export-route.
 * test.ts`: session / scope / loader / builder all mocked at the module
 * boundary so each block asserts what the route wires where.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  mockSession: vi.fn(),
  mockGetReportScopes: vi.fn(),
  mockLoadGradYears: vi.fn(),
  mockLoadReport: vi.fn(),
  mockBuild: vi.fn(),
}));

vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: h.mockSession }));
vi.mock("@/lib/edit/report-access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edit/report-access")>();
  return { ...actual, getReportScopes: h.mockGetReportScopes };
});
vi.mock("@/lib/edit/mentored-publications-report", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edit/mentored-publications-report")>();
  return {
    ...actual,
    loadMentoredGradYears: h.mockLoadGradYears,
    loadMentoredPublicationsReport: h.mockLoadReport,
  };
});
vi.mock("@/lib/edit/mentored-publications-xlsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edit/mentored-publications-xlsx")>();
  return { ...actual, buildMentoredPublicationsWorkbook: h.mockBuild };
});
vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} }, prisma: {} }));

import { GET } from "@/app/api/edit/reports/mentored-publications/route";

const req = (query = "") => new Request(`http://sps.test/api/edit/reports/mentored-publications${query}`);
const GENERATED = new Date("2026-09-18T10:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  h.mockSession.mockResolvedValue({ cwid: "usr0001", isSuperuser: false, isCommsSteward: false });
  h.mockGetReportScopes.mockResolvedValue(new Set(["md", "ecr"]));
  h.mockLoadGradYears.mockResolvedValue([2026, 2025, 2024]);
  h.mockLoadReport.mockImplementation(async (args: { scopes: string[]; gradYears: number[] | null; tail: number }) => ({
    summary: [],
    detail: [],
    generatedAt: GENERATED,
    filters: { ...args },
  }));
  h.mockBuild.mockResolvedValue(Buffer.from("xlsx-bytes"));
});

describe("gating", () => {
  it("401 with no session", async () => {
    h.mockSession.mockResolvedValue(null);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(h.mockLoadReport).not.toHaveBeenCalled();
  });

  it("403 when the caller holds no scope at all (fail closed)", async () => {
    h.mockGetReportScopes.mockResolvedValue(new Set());
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(h.mockLoadReport).not.toHaveBeenCalled();
  });

  it("403 when program is outside the caller's scopes", async () => {
    const res = await GET(req("?program=mdphd"));
    expect(res.status).toBe(403);
    expect(h.mockLoadReport).not.toHaveBeenCalled();
  });

  it("400 on malformed params", async () => {
    expect((await GET(req("?years=20x4"))).status).toBe(400);
    expect((await GET(req("?tail=9"))).status).toBe(400);
    expect((await GET(req("?program=phd"))).status).toBe(400);
    expect(h.mockLoadReport).not.toHaveBeenCalled();
  });
});

describe("response", () => {
  it("defaults to the two most recent years across the caller's scopes and names the file for them", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(h.mockLoadGradYears).toHaveBeenCalledWith(["md", "ecr"]);
    expect(h.mockLoadReport).toHaveBeenCalledWith({ scopes: ["md", "ecr"], gradYears: [2026, 2025], tail: 1 });
    expect(res.headers.get("content-type")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="Mentored Publications All 2026-2025 - 2026-09-18.xlsx"',
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("xlsx-bytes");
  });

  it("an explicit program narrows the loader to that one scope and names the file for it", async () => {
    const res = await GET(req("?program=md&years=2024,2025&tail=2"));
    expect(res.status).toBe(200);
    expect(h.mockLoadGradYears).not.toHaveBeenCalled();
    expect(h.mockLoadReport).toHaveBeenCalledWith({ scopes: ["md"], gradYears: [2024, 2025], tail: 2 });
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="Mentored Publications MD 2024-2025 - 2026-09-18.xlsx"',
    );
  });

  it("years=all passes no year filter", async () => {
    await GET(req("?years=all"));
    expect(h.mockLoadReport).toHaveBeenCalledWith({ scopes: ["md", "ecr"], gradYears: null, tail: 1 });
  });

  it("a superuser's '*' scope reaches the loader as '*'", async () => {
    h.mockSession.mockResolvedValue({ cwid: "adm0001", isSuperuser: true, isCommsSteward: false });
    h.mockGetReportScopes.mockResolvedValue(new Set(["*"]));
    await GET(req("?program=mdphd&years=2025"));
    expect(h.mockLoadReport).toHaveBeenCalledWith({ scopes: ["mdphd"], gradYears: [2025], tail: 1 });
    await GET(req("?years=2025"));
    expect(h.mockLoadReport).toHaveBeenLastCalledWith({ scopes: ["*"], gradYears: [2025], tail: 1 });
  });
});
