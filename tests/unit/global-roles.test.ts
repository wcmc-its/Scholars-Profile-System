/**
 * `lib/auth/global-roles.ts` — the "is this CWID any of the four global
 * LDAP-group roles" resolver "View as" (#637) needs at the POST target-check
 * and the session probe's profile-less display fallback. Mocks each
 * `is<Role>` predicate directly (`vi.mock`) rather than hitting LDAP, mirroring
 * how `impersonation-display.test.ts` stubs Prisma.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/cv-generator", () => ({ isCvGenerator: vi.fn(async () => false) }));
vi.mock("@/lib/auth/honors-curator", () => ({ isHonorsCurator: vi.fn(async () => false) }));
vi.mock("@/lib/auth/data-sharing-viewer", () => ({ isDataSharingViewer: vi.fn(async () => false) }));
vi.mock("@/lib/auth/development", () => ({ isDeveloper: vi.fn(async () => false) }));

import { isCvGenerator } from "@/lib/auth/cv-generator";
import { isHonorsCurator } from "@/lib/auth/honors-curator";
import { isDataSharingViewer } from "@/lib/auth/data-sharing-viewer";
import { isDeveloper } from "@/lib/auth/development";
import { resolveGlobalRole } from "@/lib/auth/global-roles";

describe("resolveGlobalRole", () => {
  beforeEach(() => {
    vi.mocked(isCvGenerator).mockClear().mockResolvedValue(false);
    vi.mocked(isHonorsCurator).mockClear().mockResolvedValue(false);
    vi.mocked(isDataSharingViewer).mockClear().mockResolvedValue(false);
    vi.mocked(isDeveloper).mockClear().mockResolvedValue(false);
  });

  it("returns null when no predicate matches", async () => {
    expect(await resolveGlobalRole("nobody1")).toBeNull();
  });

  it("returns null for an empty cwid without calling any predicate", async () => {
    expect(await resolveGlobalRole("")).toBeNull();
    expect(isCvGenerator).not.toHaveBeenCalled();
  });

  it("resolves cv_generator", async () => {
    vi.mocked(isCvGenerator).mockResolvedValueOnce(true);
    expect(await resolveGlobalRole("cvg001")).toBe("cv_generator");
  });

  it("resolves honors_curator", async () => {
    vi.mocked(isHonorsCurator).mockResolvedValueOnce(true);
    expect(await resolveGlobalRole("hon001")).toBe("honors_curator");
  });

  it("resolves data_sharing_viewer", async () => {
    vi.mocked(isDataSharingViewer).mockResolvedValueOnce(true);
    expect(await resolveGlobalRole("dsv001")).toBe("data_sharing_viewer");
  });

  it("resolves development", async () => {
    vi.mocked(isDeveloper).mockResolvedValueOnce(true);
    expect(await resolveGlobalRole("dev001")).toBe("development");
  });

  it("is fail-closed: a thrown predicate counts as not-this-role, not a grant", async () => {
    vi.mocked(isCvGenerator).mockRejectedValueOnce(new Error("ldap down"));
    vi.mocked(isHonorsCurator).mockResolvedValueOnce(true);
    expect(await resolveGlobalRole("flaky001")).toBe("honors_curator");
  });

  it("breaks a multi-role match by table order (cv_generator before the rest)", async () => {
    vi.mocked(isCvGenerator).mockResolvedValueOnce(true);
    vi.mocked(isDeveloper).mockResolvedValueOnce(true);
    expect(await resolveGlobalRole("both001")).toBe("cv_generator");
  });
});
