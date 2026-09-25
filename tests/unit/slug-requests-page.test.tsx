/**
 * `app/edit/slug-requests/page.tsx` — the old queue address, now a redirect to
 * Profile URLs (`/edit/slugs`), where the queue sits above the registry.
 * Still: signed-out → SAML login first; flag off → 404 (mirroring the
 * endpoints). Authorization is `/edit/slugs`' own superuser re-check.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockGetEditSession, mockRedirect, mockNotFound, mockEnabled } = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`__REDIRECT__:${url}`);
  }),
  mockNotFound: vi.fn(() => {
    throw new Error("__NOTFOUND__");
  }),
  mockEnabled: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: mockRedirect, notFound: mockNotFound }));
vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: mockGetEditSession }));
vi.mock("@/lib/edit/slug-request", () => ({ isSlugRequestEnabled: mockEnabled }));

import SlugRequestsPage from "@/app/edit/slug-requests/page";

const ADMIN = { cwid: "adm001", isSuperuser: true };

beforeEach(() => {
  vi.clearAllMocks();
  mockEnabled.mockReturnValue(true);
});

describe("/edit/slug-requests — redirect to Profile URLs", () => {
  it("signed-out → SAML redirect with ?return=/edit/slug-requests", async () => {
    mockGetEditSession.mockResolvedValue(null);
    await expect(SlugRequestsPage()).rejects.toThrow(
      "__REDIRECT__:/api/auth/saml/login?return=/edit/slug-requests",
    );
  });

  it("flag off → notFound", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    mockEnabled.mockReturnValue(false);
    await expect(SlugRequestsPage()).rejects.toThrow("__NOTFOUND__");
  });

  it("signed in + flag on → /edit/slugs", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    await expect(SlugRequestsPage()).rejects.toThrow("__REDIRECT__:/edit/slugs");
  });
});
