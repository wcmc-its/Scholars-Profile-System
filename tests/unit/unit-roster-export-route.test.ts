/**
 * GET /edit/center/[code]/export — roster CSV download gating + headers + body
 * (#1102). The unit CODE is the authorization boundary: the route re-derives the
 * actor's role via `loadUnitEditContext` and 404s when that returns null.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockSession, mockEnabled, mockCtx } = vi.hoisted(() => ({
  mockSession: vi.fn(),
  mockEnabled: vi.fn(),
  mockCtx: vi.fn(),
}));

vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: mockSession }));
vi.mock("@/lib/api/unit-edit-context", () => ({ loadUnitEditContext: mockCtx }));
vi.mock("@/lib/edit/unit-roster-export", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/edit/unit-roster-export")>();
  // Keep the real CSV builder / status derivation; mock only the flag gate.
  return { ...actual, isUnitRosterExportEnabled: mockEnabled };
});
vi.mock("@/lib/db", () => ({ db: { read: {} } }));

import { GET } from "@/app/edit/center/[code]/export/route";

const PAST = "2000-01-01";
const FUTURE = "2999-01-01";

const ctxFixture = {
  unit: { unitType: "center", code: "MCC" },
  roster: [
    {
      cwid: "act1",
      name: "Active Person",
      title: "Professor",
      source: "manual",
      membershipType: "research",
      programCode: "CPC",
      startDate: null,
      endDate: null,
    },
    {
      cwid: "pen1",
      name: "Pending Person, MD",
      title: null,
      source: "manual",
      membershipType: "clinical",
      programCode: null,
      startDate: FUTURE,
      endDate: null,
    },
    {
      cwid: "ina1",
      name: "Inactive Person",
      title: "Lecturer",
      source: "ED",
      membershipType: null,
      programCode: "CPC",
      startDate: null,
      endDate: PAST,
    },
  ],
  programs: [{ code: "CPC", label: "Cancer Prevention & Control", sortOrder: 0 }],
} as const;

const req = (qs = "") =>
  new NextRequest(`http://localhost/edit/center/MCC/export${qs}`);
const ctx = (code = "MCC") => ({ params: Promise.resolve({ code }) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  mockSession.mockResolvedValue({ cwid: "edt1", isSuperuser: true, isCommsSteward: false });
  mockEnabled.mockReturnValue(true);
  mockCtx.mockResolvedValue(ctxFixture);
});

describe("/edit/center/[code]/export gating", () => {
  it("404s when the flag is off", async () => {
    mockEnabled.mockReturnValue(false);
    const res = await GET(req(), ctx());
    expect(res.status).toBe(404);
    expect(mockCtx).not.toHaveBeenCalled();
  });

  it("401s with no session", async () => {
    mockSession.mockResolvedValue(null);
    const res = await GET(req(), ctx());
    expect(res.status).toBe(401);
    expect(mockCtx).not.toHaveBeenCalled();
  });

  it("404s when the actor can't edit this center (loadUnitEditContext null)", async () => {
    mockCtx.mockResolvedValue(null);
    const res = await GET(req(), ctx("NOPE"));
    expect(res.status).toBe(404);
    // The code from the path — not a query param — is the scope passed to the loader.
    expect(mockCtx).toHaveBeenCalledWith(
      "center",
      "NOPE",
      expect.anything(),
      expect.anything(),
    );
  });

  it("returns a CSV attachment with the roster header + rows for an authorized actor", async () => {
    const res = await GET(req(), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toMatch(
      /attachment; filename="center-MCC-roster-\d{4}-\d{2}-\d{2}\.csv"/,
    );
    expect(res.headers.get("cache-control")).toBe("no-store");

    const text = await res.text();
    const lines = text.trim().split("\r\n");
    expect(lines[0]).toBe(
      "cwid,name,title,membership_type,program_code,program_label,start_date,end_date,status,source",
    );
    // All three members present (active + pending + inactive) by default.
    expect(lines).toHaveLength(4);
    // program_label resolved from the taxonomy; status derived; no email column.
    expect(text).toContain("act1,Active Person,Professor,research,CPC,Cancer Prevention & Control,,,active,manual");
    expect(text).toContain("CPC,Cancer Prevention & Control");
    expect(text).toContain(",pending,");
    expect(text).toContain(",inactive,ED");
  });

  it("honors ?activeOnly=1 — drops pending + inactive rows", async () => {
    const res = await GET(req("?activeOnly=1"), ctx());
    const text = await res.text();
    const lines = text.trim().split("\r\n");
    expect(lines).toHaveLength(2); // header + the one active member
    expect(text).toContain("act1");
    expect(text).not.toContain("pen1");
    expect(text).not.toContain("ina1");
  });

  it("emits one structured export_unit_members access-log line", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await GET(req(), ctx());
    const logged = spy.mock.calls.map((c) => String(c[0])).find((l) => l.includes("export_unit_members"));
    expect(logged).toBeDefined();
    const parsed = JSON.parse(logged as string);
    expect(parsed).toMatchObject({
      event: "export_unit_members",
      cwid: "edt1",
      unitType: "center",
      unitCode: "MCC",
      rows: 3,
    });
  });
});
