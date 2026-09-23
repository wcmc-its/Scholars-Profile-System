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
  h.mockLoadReport.mockImplementation(
    async (args: {
      scopes: string[];
      types: string[];
      gradYears: number[] | null;
      tail: number;
      pubs: "mentored" | "all";
    }) => ({
      summary: [],
      detail: [],
      publications: [],
      generatedAt: GENERATED,
      filters: { ...args },
      allPubsLoaded: args.pubs === "all" ? true : null,
    }),
  );
  h.mockBuild.mockResolvedValue(Buffer.from("xlsx-bytes"));
});

const MENTORED = { pubs: "mentored" } as const;
/** An md+ecr holder's default types. */
const AOC_ECR = { types: ["aoc", "ecr"] } as const;

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

  it("a roster type outside the caller's scopes is dropped, never a 403; nothing left → the default", async () => {
    const res = await GET(req("?mtype=mdphd,thesis&years=2025"));
    expect(res.status).toBe(200);
    expect(h.mockLoadReport).toHaveBeenCalledWith({
      scopes: ["md", "ecr"],
      types: ["thesis"],
      gradYears: [2025],
      tail: 1,
      ...MENTORED,
    });
    await GET(req("?mtype=mdphd&years=2025"));
    expect(h.mockLoadReport).toHaveBeenLastCalledWith({
      scopes: ["md", "ecr"],
      ...AOC_ECR,
      gradYears: [2025],
      tail: 1,
      ...MENTORED,
    });
  });

  it("400 on malformed params", async () => {
    expect((await GET(req("?years=20x4"))).status).toBe(400);
    expect((await GET(req("?tail=9"))).status).toBe(400);
    expect((await GET(req("?mtype=phd"))).status).toBe(400);
    expect(await (await GET(req("?mtype=phd"))).text()).toBe("invalid_types");
    expect((await GET(req("?pubs=everything"))).status).toBe(400);
    expect(await (await GET(req("?pubs=everything"))).text()).toBe("invalid_pubs");
    expect((await GET(req("?view=raw"))).status).toBe(400);
    expect(h.mockLoadReport).not.toHaveBeenCalled();
  });
});

describe("response", () => {
  it("defaults to the caller's roster types and the two most recent years across them, and names the file for both", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(h.mockLoadGradYears).toHaveBeenCalledWith(["md", "ecr"], ["aoc", "ecr"]);
    expect(h.mockLoadReport).toHaveBeenCalledWith({
      scopes: ["md", "ecr"],
      ...AOC_ECR,
      gradYears: [2026, 2025],
      tail: 1,
      ...MENTORED,
    });
    expect(res.headers.get("content-type")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="Mentored Publications MD+ECR 2026-2025 - 2026-09-18.xlsx"',
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("xlsx-bytes");
  });

  it("year-less learners in scope: the default adds 'unknown' and the filename says so", async () => {
    h.mockLoadGradYears.mockResolvedValue([2026, 2025, 2024, null]);
    const res = await GET(req());
    expect(h.mockLoadReport).toHaveBeenCalledWith({
      scopes: ["md", "ecr"],
      ...AOC_ECR,
      gradYears: [2026, 2025, null],
      tail: 1,
      ...MENTORED,
    });
    expect(res.headers.get("content-disposition")).toContain("2026-2025-unknown");
  });

  it("explicit types reach the loader (scopes untouched) and name the file: one or two labels joined by +, more = Mixed", async () => {
    const res = await GET(req("?mtype=aoc&years=2024,2025&tail=2"));
    expect(res.status).toBe(200);
    expect(h.mockLoadGradYears).not.toHaveBeenCalled();
    expect(h.mockLoadReport).toHaveBeenCalledWith({
      scopes: ["md", "ecr"],
      types: ["aoc"],
      gradYears: [2024, 2025],
      tail: 2,
      ...MENTORED,
    });
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="Mentored Publications MD 2024-2025 - 2026-09-18.xlsx"',
    );
    const two = await GET(req("?mtype=thesis,likely&years=2025"));
    expect(two.headers.get("content-disposition")).toBe(
      'attachment; filename="Mentored Publications PhD-MD-PhD thesis advisor+Likely mentee (from co-authorship) 2025 - 2026-09-18.xlsx"',
    );
    const three = await GET(req("?mtype=aoc,ecr,thesis&years=2025"));
    expect(three.headers.get("content-disposition")).toBe(
      'attachment; filename="Mentored Publications Mixed 2025 - 2026-09-18.xlsx"',
    );
  });

  it("a legacy program=<scope> link still works: it reads as that roster type", async () => {
    await GET(req("?program=md&years=2025"));
    expect(h.mockLoadReport).toHaveBeenCalledWith({
      scopes: ["md", "ecr"],
      types: ["aoc"],
      gradYears: [2025],
      tail: 1,
      ...MENTORED,
    });
  });

  it("years=all passes no year filter", async () => {
    await GET(req("?years=all"));
    expect(h.mockLoadReport).toHaveBeenCalledWith({
      scopes: ["md", "ecr"],
      ...AOC_ECR,
      gradYears: null,
      tail: 1,
      ...MENTORED,
    });
  });

  it("pubs=all reaches the loader and suffixes the filename; view is accepted and ignored", async () => {
    const res = await GET(req("?mtype=aoc&years=2025&pubs=all&view=publications"));
    expect(res.status).toBe(200);
    expect(h.mockLoadReport).toHaveBeenCalledWith({
      scopes: ["md", "ecr"],
      types: ["aoc"],
      gradYears: [2025],
      tail: 1,
      pubs: "all",
    });
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="Mentored Publications MD 2025 All Pubs - 2026-09-18.xlsx"',
    );
  });

  it("a superuser's '*' scope reaches the loader as '*', every confirmed type by default, any type on request", async () => {
    h.mockSession.mockResolvedValue({ cwid: "adm0001", isSuperuser: true, isCommsSteward: false });
    h.mockGetReportScopes.mockResolvedValue(new Set(["*"]));
    await GET(req("?mtype=mdphd&years=2025"));
    expect(h.mockLoadReport).toHaveBeenCalledWith({
      scopes: ["*"],
      types: ["mdphd"],
      gradYears: [2025],
      tail: 1,
      ...MENTORED,
    });
    await GET(req("?years=2025"));
    expect(h.mockLoadReport).toHaveBeenLastCalledWith({
      scopes: ["*"],
      types: ["aoc", "mdphd", "ecr", "thesis", "postdoc", "faculty"],
      gradYears: [2025],
      tail: 1,
      ...MENTORED,
    });
  });
});
