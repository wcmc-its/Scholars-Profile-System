/**
 * `lib/auth/global-roles.ts` — the "is this CWID any of the global
 * LDAP-group roles" resolver "View as" (#637) needs at the POST target-check
 * and the session probe's profile-less display fallback. Mocks each
 * `is<Role>` predicate directly (`vi.mock`) rather than hitting LDAP, mirroring
 * how `impersonation-display.test.ts` stubs Prisma.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/honors-curator", () => ({ isHonorsCurator: vi.fn(async () => false) }));
vi.mock("@/lib/auth/data-sharing-viewer", () => ({ isDataSharingViewer: vi.fn(async () => false) }));
vi.mock("@/lib/auth/development", () => ({ isDeveloper: vi.fn(async () => false) }));
vi.mock("@/lib/auth/observer", () => ({ isObserver: vi.fn(async () => false) }));
vi.mock("@/lib/auth/content-editor", () => ({ isContentEditor: vi.fn(async () => false) }));
vi.mock("@/lib/auth/core-director", () => ({ isCoreDirector: vi.fn(async () => false) }));

import { isHonorsCurator } from "@/lib/auth/honors-curator";
import { isDataSharingViewer } from "@/lib/auth/data-sharing-viewer";
import { isDeveloper } from "@/lib/auth/development";
import { isObserver } from "@/lib/auth/observer";
import { isCoreDirector } from "@/lib/auth/core-director";
import { resolveGlobalRole } from "@/lib/auth/global-roles";

describe("resolveGlobalRole", () => {
  beforeEach(() => {
    vi.mocked(isHonorsCurator).mockClear().mockResolvedValue(false);
    vi.mocked(isDataSharingViewer).mockClear().mockResolvedValue(false);
    vi.mocked(isDeveloper).mockClear().mockResolvedValue(false);
    vi.mocked(isObserver).mockClear().mockResolvedValue(false);
    vi.mocked(isCoreDirector).mockClear().mockResolvedValue(false);
  });

  it("resolves core_director (functional role grant, no LDAP group)", async () => {
    vi.mocked(isCoreDirector).mockResolvedValueOnce(true);
    expect(await resolveGlobalRole("cd001")).toBe("core_director");
  });

  it("returns null when no predicate matches", async () => {
    expect(await resolveGlobalRole("nobody1")).toBeNull();
  });

  it("returns null for an empty cwid without calling any predicate", async () => {
    expect(await resolveGlobalRole("")).toBeNull();
    expect(isHonorsCurator).not.toHaveBeenCalled();
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

  it("resolves observer (a profile-less observer is a View-as target and lands on Profiles)", async () => {
    vi.mocked(isObserver).mockResolvedValueOnce(true);
    expect(await resolveGlobalRole("obs001")).toBe("observer");
  });

  it("ranks observer last: a narrower role held alongside it wins", async () => {
    vi.mocked(isDeveloper).mockResolvedValueOnce(true);
    vi.mocked(isObserver).mockResolvedValueOnce(true);
    expect(await resolveGlobalRole("devobs001")).toBe("development");
  });

  it("is fail-closed: a thrown predicate counts as not-this-role, not a grant", async () => {
    vi.mocked(isHonorsCurator).mockRejectedValueOnce(new Error("ldap down"));
    vi.mocked(isDataSharingViewer).mockResolvedValueOnce(true);
    expect(await resolveGlobalRole("flaky001")).toBe("data_sharing_viewer");
  });

  it("breaks a multi-role match by table order (honors_curator before the rest)", async () => {
    vi.mocked(isHonorsCurator).mockResolvedValueOnce(true);
    vi.mocked(isDeveloper).mockResolvedValueOnce(true);
    expect(await resolveGlobalRole("both001")).toBe("honors_curator");
  });
});
