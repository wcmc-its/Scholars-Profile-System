/**
 * #866 UC-A — internal-viewer reveal for GET /api/profile/[cwid]/sensitive-families.
 * This route broadens the #801 {self, admin} reveal to ANY internal viewer (an
 * authenticated session OR an on-WCM-network viewer). The gate is entirely
 * server-side and default-safe:
 *   - sensitivity gate off → []  ("off")
 *   - external viewer      → []  ("external")
 *   - internal viewer      → the gated families for ANY cwid (no self/admin check)
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/profile/[cwid]/sensitive-families/route";
import { resolveViewerContext } from "@/lib/auth/viewer-context";
import { isMethodsLensSensitiveGateOn } from "@/lib/profile/methods-lens-flags";
import { loadSensitiveScholarFamilies } from "@/lib/api/profile";

vi.mock("@/lib/auth/viewer-context", () => ({ resolveViewerContext: vi.fn() }));
vi.mock("@/lib/profile/methods-lens-flags", () => ({ isMethodsLensSensitiveGateOn: vi.fn() }));
vi.mock("@/lib/api/profile", () => ({ loadSensitiveScholarFamilies: vi.fn() }));

const GATED = [
  {
    familyId: "fam_gemm",
    familyLabel: "Genetically engineered mouse models",
    supercategory: "animal_cell_models",
    pubCount: 11,
    exemplarTools: ["Cre-lox"],
    pmids: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"],
  },
];

function call(cwid: string) {
  return GET(
    new Request("http://localhost/api/profile/" + cwid + "/sensitive-families") as never,
    { params: Promise.resolve({ cwid }) },
  );
}

afterEach(() => {
  vi.mocked(resolveViewerContext).mockReset();
  vi.mocked(isMethodsLensSensitiveGateOn).mockReset();
  vi.mocked(loadSensitiveScholarFamilies).mockReset();
});

describe("GET /api/profile/[cwid]/sensitive-families", () => {
  it("returns [] when the sensitivity gate is off (never loads or resolves a viewer)", async () => {
    vi.mocked(isMethodsLensSensitiveGateOn).mockReturnValue(false);
    const body = await (await call("aog")).json();
    expect(body.families).toEqual([]);
    expect(body.viewer).toBe("off");
    expect(resolveViewerContext).not.toHaveBeenCalled();
    expect(loadSensitiveScholarFamilies).not.toHaveBeenCalled();
  });

  it("returns [] for an external viewer (no session, not on-network)", async () => {
    vi.mocked(isMethodsLensSensitiveGateOn).mockReturnValue(true);
    vi.mocked(resolveViewerContext).mockResolvedValue({ internal: false, basis: null });
    const body = await (await call("aog")).json();
    expect(body.families).toEqual([]);
    expect(body.viewer).toBe("external");
    expect(loadSensitiveScholarFamilies).not.toHaveBeenCalled();
  });

  it("returns the gated families to a session viewer for ANY cwid (no self/admin check)", async () => {
    vi.mocked(isMethodsLensSensitiveGateOn).mockReturnValue(true);
    vi.mocked(resolveViewerContext).mockResolvedValue({
      internal: true,
      basis: "session",
      cwid: "someoneelse",
    });
    vi.mocked(loadSensitiveScholarFamilies).mockResolvedValue(GATED);
    const body = await (await call("aog")).json();
    expect(body.viewer).toBe("session");
    expect(body.families).toEqual(GATED);
    expect(loadSensitiveScholarFamilies).toHaveBeenCalledWith("aog");
  });

  it("returns the gated families to an on-network (anonymous) internal viewer", async () => {
    vi.mocked(isMethodsLensSensitiveGateOn).mockReturnValue(true);
    vi.mocked(resolveViewerContext).mockResolvedValue({ internal: true, basis: "network" });
    vi.mocked(loadSensitiveScholarFamilies).mockResolvedValue(GATED);
    const body = await (await call("aog")).json();
    expect(body.viewer).toBe("network");
    expect(body.families).toEqual(GATED);
    expect(loadSensitiveScholarFamilies).toHaveBeenCalledWith("aog");
  });
});
