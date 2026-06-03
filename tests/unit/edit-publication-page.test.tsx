/**
 * `app/edit/publication/[pmid]/page.tsx` — route-level authorization matrix
 * (#356 Phase 7 C7, plan §10.1).
 *
 * Unlike `/edit/scholar/[cwid]`, there is no self path: every successful GET
 * requires a superuser session. Branches:
 *
 *   1. signed-out → SAML redirect with `?return=…`.
 *   2. signed-in non-superuser → ForbiddenEditPage + edit_authz_denied log.
 *   3. signed-in superuser → PublicationTakedownPage with the loaded ctx.
 *   4. signed-in superuser + loadPublicationTakedownContext null → notFound().
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockGetEditSession,
  mockLoadCtx,
  mockRedirect,
  mockNotFound,
  mockPublicationTakedownPage,
  mockForbiddenEditPage,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockLoadCtx: vi.fn(),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`__REDIRECT__:${url}`);
  }),
  mockNotFound: vi.fn(() => {
    throw new Error("__NOT_FOUND__");
  }),
  mockPublicationTakedownPage: vi.fn(() => null),
  mockForbiddenEditPage: vi.fn(() => null),
}));

vi.mock("next/navigation", () => ({
  redirect: mockRedirect,
  notFound: mockNotFound,
}));
vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: mockGetEditSession }));
vi.mock("@/lib/api/publication-takedown-context", () => ({
  loadPublicationTakedownContext: mockLoadCtx,
}));
vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} } }));
vi.mock("@/components/edit/publication-takedown-page", () => ({
  PublicationTakedownPage: mockPublicationTakedownPage,
}));
vi.mock("@/components/edit/forbidden-edit-page", () => ({
  ForbiddenEditPage: mockForbiddenEditPage,
}));

import EditPublicationPage from "@/app/edit/publication/[pmid]/page";

const SELF = { cwid: "self01", isSuperuser: false };
const ADMIN = { cwid: "adm001", isSuperuser: true };

function params(pmid: string): Promise<{ pmid: string }> {
  return Promise.resolve({ pmid });
}

function fakeCtx(pmid: string) {
  return {
    publication: { pmid, title: "A study", journal: "Cell", year: 2024, doi: null },
    authors: [],
    takedown: null,
    derivedDark: false,
  };
}

type ReactElementLike = { type: unknown; props: Record<string, unknown> };
const asElement = (v: unknown) => v as ReactElementLike;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mockGetEditSession.mockResolvedValue(null);
  mockLoadCtx.mockResolvedValue(null);
});

describe("/edit/publication/[pmid] — authorization matrix", () => {
  it("signed-out → SAML redirect with the requested URL as ?return=", async () => {
    mockGetEditSession.mockResolvedValue(null);
    await expect(EditPublicationPage({ params: params("12345") })).rejects.toThrow(
      "__REDIRECT__:/api/auth/saml/login?return=/edit/publication/12345",
    );
    expect(mockLoadCtx).not.toHaveBeenCalled();
  });

  it("signed-in non-superuser → ForbiddenEditPage + edit_authz_denied log line", async () => {
    mockGetEditSession.mockResolvedValue(SELF);
    const result = asElement(await EditPublicationPage({ params: params("12345") }));
    expect(result.type).toBe(mockForbiddenEditPage);
    expect(mockLoadCtx).not.toHaveBeenCalled();
    const line = (console.warn as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.event).toBe("edit_authz_denied");
    expect(parsed.reason).toBe("not_superuser_get");
    expect(parsed.path).toBe("/edit/publication/12345");
  });

  it("signed-in superuser → PublicationTakedownPage with loaded ctx", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    mockLoadCtx.mockResolvedValue(fakeCtx("12345"));
    const result = asElement(await EditPublicationPage({ params: params("12345") }));
    expect(result.type).toBe(mockPublicationTakedownPage);
    const ctx = result.props.ctx as { publication: { pmid: string } };
    expect(ctx.publication.pmid).toBe("12345");
    expect(mockLoadCtx).toHaveBeenCalledWith("12345", expect.anything());
  });

  it("loadPublicationTakedownContext returns null → notFound()", async () => {
    mockGetEditSession.mockResolvedValue(ADMIN);
    mockLoadCtx.mockResolvedValue(null);
    await expect(EditPublicationPage({ params: params("missing") })).rejects.toThrow(
      "__NOT_FOUND__",
    );
  });

  it("URL-encodes the return path for a pmid that needs encoding", async () => {
    mockGetEditSession.mockResolvedValue(null);
    await expect(EditPublicationPage({ params: params("a/b c") })).rejects.toThrow(
      "__REDIRECT__:/api/auth/saml/login?return=/edit/publication/a%2Fb%20c",
    );
  });
});
