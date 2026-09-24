/**
 * GET /api/departments/[slug]/collaboration — the gate ladder: kill switch,
 * slug charset, department existence / unit suppression, the ≥2-populated-
 * divisions data gate, then the payload. Synthetic slugs / codes only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const {
  networkEnabled,
  getDepartment,
  getDivisionCounts,
  getCollaboration,
  prismaTouched,
} = vi.hoisted(() => ({
  networkEnabled: vi.fn(),
  getDepartment: vi.fn(),
  getDivisionCounts: vi.fn(),
  getCollaboration: vi.fn(),
  prismaTouched: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: new Proxy(
    {},
    {
      get: (_t, prop) => {
        prismaTouched(prop);
        return undefined;
      },
    },
  ),
}));
vi.mock("@/lib/center-collaboration/flags", () => ({
  isCenterCollaborationNetworkEnabled: networkEnabled,
  isCenterCollaborationGrantAxisEnabled: () => false,
}));
vi.mock("@/lib/api/departments", () => ({ getDepartment }));
vi.mock("@/lib/api/unit-members", () => ({
  getDepartmentDivisionMemberCounts: getDivisionCounts,
}));
vi.mock("@/lib/api/department-collaboration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/department-collaboration")>()),
  getDepartmentCollaboration: getCollaboration,
}));

import { GET } from "@/app/api/departments/[slug]/collaboration/route";

const PAYLOAD = {
  programs: [{ code: "DIV_A", label: "Alpha Division", color: "#0072B2" }],
  nodes: [],
  papers: [],
  awards: [],
  grantAxis: false,
  generatedAt: "2026-01-01T00:00:00.000Z",
};

function call(slug: string) {
  return GET({} as NextRequest, { params: Promise.resolve({ slug }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  networkEnabled.mockReturnValue(true);
  getDepartment.mockResolvedValue({ dept: { code: "TSTDEPT", slug: "test-dept" } });
  getDivisionCounts.mockResolvedValue(
    new Map([
      ["DIV_A", 4],
      ["DIV_B", 2],
    ]),
  );
  getCollaboration.mockResolvedValue(PAYLOAD);
});

describe("GET /api/departments/[slug]/collaboration", () => {
  it("404 when the collaboration flag is off", async () => {
    networkEnabled.mockReturnValue(false);
    const res = await call("test-dept");
    expect(res.status).toBe(404);
    expect(getDepartment).not.toHaveBeenCalled();
  });

  it("400 on a bad slug, without querying anything", async () => {
    const res = await call("A B");
    expect(res.status).toBe(400);
    expect(getDepartment).not.toHaveBeenCalled();
    expect(getCollaboration).not.toHaveBeenCalled();
    expect(prismaTouched).not.toHaveBeenCalled();
  });

  it("404 for an unknown or unit-suppressed department", async () => {
    getDepartment.mockResolvedValue(null);
    const res = await call("test-dept");
    expect(res.status).toBe(404);
    expect(getCollaboration).not.toHaveBeenCalled();
  });

  it("404 when fewer than 2 divisions have public members", async () => {
    getDivisionCounts.mockResolvedValue(
      new Map([
        ["DIV_A", 4],
        ["DIV_B", 0],
      ]),
    );
    const res = await call("test-dept");
    expect(res.status).toBe(404);
    expect(getCollaboration).not.toHaveBeenCalled();
  });

  it("200 with the payload for an eligible department", async () => {
    const res = await call("test-dept");
    expect(res.status).toBe(200);
    expect(getDivisionCounts).toHaveBeenCalledWith("TSTDEPT");
    expect(getCollaboration).toHaveBeenCalledWith({ code: "TSTDEPT" });
    expect(await res.json()).toEqual(PAYLOAD);
  });
});
