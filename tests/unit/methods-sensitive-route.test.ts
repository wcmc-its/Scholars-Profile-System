/**
 * #801 — authorization boundary for GET /api/edit/methods-sensitive/[cwid].
 * The route reveals a scholar's audience-gated families ONLY to that scholar
 * (self) or a site admin (superuser); any other viewer — anonymous or a
 * different authenticated user — must get [] (no cross-scholar leak).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/edit/methods-sensitive/[cwid]/route";
import { getSession } from "@/lib/auth/session-server";
import { isSuperuser } from "@/lib/auth/superuser";
import { loadSensitiveScholarFamilies } from "@/lib/api/profile";

vi.mock("@/lib/auth/session-server", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/superuser", () => ({ isSuperuser: vi.fn() }));
vi.mock("@/lib/api/profile", () => ({ loadSensitiveScholarFamilies: vi.fn() }));

const GATED = [
  {
    familyId: "fam_gemm",
    familyLabel: "Genetically engineered mouse models",
    supercategory: "animal_cell_models",
    pubCount: 11,
    exemplarTools: ["Cre-lox"],
    exemplarContexts: {},
    pmids: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"],
    definition: null,
    definitionSource: null,
  },
];

function call(cwid: string) {
  return GET(new Request("http://localhost/api/edit/methods-sensitive/" + cwid), {
    params: Promise.resolve({ cwid }),
  });
}

afterEach(() => {
  vi.mocked(getSession).mockReset();
  vi.mocked(isSuperuser).mockReset();
  vi.mocked(loadSensitiveScholarFamilies).mockReset();
});

describe("GET /api/edit/methods-sensitive/[cwid]", () => {
  it("returns [] for an anonymous viewer (no session)", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const body = await (await call("aog")).json();
    expect(body.families).toEqual([]);
    expect(loadSensitiveScholarFamilies).not.toHaveBeenCalled();
  });

  it("returns [] for a different authenticated viewer who is not an admin", async () => {
    vi.mocked(getSession).mockResolvedValue({ cwid: "someoneelse" } as never);
    vi.mocked(isSuperuser).mockResolvedValue(false);
    const body = await (await call("aog")).json();
    expect(body.families).toEqual([]);
    expect(body.viewer).toBe("other");
    expect(loadSensitiveScholarFamilies).not.toHaveBeenCalled();
  });

  it("returns the gated families to the scholar themselves (self)", async () => {
    vi.mocked(getSession).mockResolvedValue({ cwid: "aog" } as never);
    vi.mocked(loadSensitiveScholarFamilies).mockResolvedValue(GATED);
    const body = await (await call("aog")).json();
    expect(body.viewer).toBe("self");
    expect(body.families).toEqual(GATED);
    expect(isSuperuser).not.toHaveBeenCalled(); // self short-circuits the admin check
  });

  it("returns the gated families to a superuser viewing another scholar (admin)", async () => {
    vi.mocked(getSession).mockResolvedValue({ cwid: "admin1" } as never);
    vi.mocked(isSuperuser).mockResolvedValue(true);
    vi.mocked(loadSensitiveScholarFamilies).mockResolvedValue(GATED);
    const body = await (await call("aog")).json();
    expect(body.viewer).toBe("admin");
    expect(body.families).toEqual(GATED);
  });
});
