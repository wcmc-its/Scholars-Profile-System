/**
 * #2652 — `app/edit/biosketch/worksheet/page.tsx` authorization + wiring.
 *
 * The gate, in order: `EDIT_BIOSKETCH_GENERATE` off → 404 (before any session or DB work);
 * missing / oversized `?id` → 404; signed-out → SAML redirect carrying the full worksheet URL;
 * unknown generation → 404 (before authz — the row's `cwid` IS the authz key); authz deny →
 * the reduced-chrome `ForbiddenEditPage` shell + a logged denial, with NO edit-context or honors
 * read and NO cwid echoed to the 403; authz allow → the edit context + published honors load
 * and the worksheet renders keyed on the ROW's cwid (never the caller's); #536 hidden class +
 * non-superuser → 404 (superuser bypasses), as on the scholar editor. Follows the #955
 * finding #11 page-test pattern (`tests/unit/scholar-history-page.test.tsx`): the view + the
 * forbidden component are mocked (module-hoisted), so we assert on the returned element type
 * and props, not a render.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockEnabled,
  mockResolveIdentity,
  mockGetGeneration,
  mockAuthorize,
  mockLogDenial,
  mockLoadEditContext,
  mockHonorFindMany,
  mockIsPubliclyDisplayed,
  mockForbidden,
  mockWorksheet,
  mockRedirect,
  mockNotFound,
} = vi.hoisted(() => ({
  mockEnabled: vi.fn(),
  mockResolveIdentity: vi.fn(),
  mockGetGeneration: vi.fn(),
  mockAuthorize: vi.fn(),
  mockLogDenial: vi.fn(),
  mockLoadEditContext: vi.fn(),
  mockHonorFindMany: vi.fn(),
  mockIsPubliclyDisplayed: vi.fn(),
  mockForbidden: vi.fn(() => null),
  mockWorksheet: vi.fn(() => null),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`__REDIRECT__:${url}`);
  }),
  mockNotFound: vi.fn(() => {
    throw new Error("__NOTFOUND__");
  }),
}));

vi.mock("next/navigation", () => ({ redirect: mockRedirect, notFound: mockNotFound }));
vi.mock("@/lib/edit/biosketch-generator", () => ({ isBiosketchGenerateEnabled: mockEnabled }));
vi.mock("@/lib/edit/request", () => ({ resolveEditIdentity: mockResolveIdentity }));
vi.mock("@/lib/edit/biosketch-provenance", () => ({ getBiosketchGeneration: mockGetGeneration }));
vi.mock("@/lib/edit/overview-authz", () => ({ authorizeOverviewWrite: mockAuthorize }));
vi.mock("@/lib/edit/authz", () => ({ logEditDenial: mockLogDenial }));
vi.mock("@/lib/api/edit-context", () => ({ loadEditContext: mockLoadEditContext }));
vi.mock("@/lib/eligibility", () => ({ isPubliclyDisplayed: mockIsPubliclyDisplayed }));
vi.mock("@/lib/db", () => ({
  db: { read: { honor: { findMany: mockHonorFindMany } }, write: {} },
}));
vi.mock("@/components/edit/forbidden-edit-page", () => ({ ForbiddenEditPage: mockForbidden }));
vi.mock("@/components/edit/sciencv-worksheet", () => ({ SciencvWorksheet: mockWorksheet }));

import BiosketchWorksheetPage from "@/app/edit/biosketch/worksheet/page";

type El = { type: unknown; props: Record<string, unknown> };
const asEl = (v: unknown) => v as El;
const sp = (id?: string | string[]) =>
  Promise.resolve(id === undefined ? {} : { id }) as Promise<{ id?: string | string[] }>;

const OWNER = "own0001";
const GEN_ID = "6f1d2c3b-0000-4000-8000-000000000001";
const CREATED_AT = new Date("2026-09-01T12:00:00.000Z");
const GENERATION = {
  id: GEN_ID,
  cwid: OWNER,
  mode: "contributions",
  entries: [{ title: "A heading", body: "A body." }],
  products: null,
  createdAt: CREATED_AT,
};
const SCHOLAR_FIELDS = {
  preferredName: "Pat Example",
  fullName: "Patricia Q. Example",
  orcid: "0000-0002-1825-0097",
  primaryTitle: "Associate Professor of Testing",
};
const CTX = {
  scholar: { ...SCHOLAR_FIELDS, roleCategory: "full_time_faculty" },
  educations: [
    { degree: "PhD", institution: "Example U", field: "Biostatistics", year: 2010, state: "shown" },
    { degree: "MS", institution: "Hidden U", field: "Stats", year: 2006, state: "hidden_by_self" },
  ],
  appointments: [
    {
      title: "Assistant Professor",
      organization: "Example Dept",
      startDate: "2015-07-01",
      endDate: "2020-06-30",
      state: "shown",
    },
    {
      title: "Chair",
      organization: "Example Dept",
      startDate: "2022-01-01",
      endDate: null,
      state: "locked",
    },
    {
      title: "Adjunct",
      organization: "Elsewhere",
      startDate: "2018-01-01",
      endDate: null,
      state: "removed_by_admin",
    },
    {
      title: "Associate Professor",
      organization: "Example Dept",
      startDate: "2020-07-01",
      endDate: null,
      state: "shown",
    },
  ],
};
const HONORS = [{ name: "Best Paper", organization: "Society", year: 2024 }];

/** Wire a non-impersonating signed-in actor. */
function signedInAs(cwid: string, opts: { isSuperuser?: boolean } = {}) {
  mockResolveIdentity.mockResolvedValue({
    session: { cwid, isSuperuser: opts.isSuperuser ?? false },
    realCwid: cwid,
    impersonatedCwid: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnabled.mockReturnValue(true);
  mockGetGeneration.mockResolvedValue(GENERATION);
  mockAuthorize.mockResolvedValue({ ok: true, viaUnitAdminUnit: null });
  mockLoadEditContext.mockResolvedValue(CTX);
  mockHonorFindMany.mockResolvedValue(HONORS);
  mockIsPubliclyDisplayed.mockReturnValue(true);
});

describe("/edit/biosketch/worksheet — gate order", () => {
  it("flag OFF → 404 before any session or DB work", async () => {
    mockEnabled.mockReturnValue(false);
    signedInAs(OWNER);
    await expect(BiosketchWorksheetPage({ searchParams: sp(GEN_ID) })).rejects.toThrow(
      "__NOTFOUND__",
    );
    expect(mockResolveIdentity).not.toHaveBeenCalled();
    expect(mockGetGeneration).not.toHaveBeenCalled();
    expect(mockLoadEditContext).not.toHaveBeenCalled();
  });

  it("no ?id → 404 before the session resolves", async () => {
    signedInAs(OWNER);
    await expect(BiosketchWorksheetPage({ searchParams: sp() })).rejects.toThrow("__NOTFOUND__");
    await expect(BiosketchWorksheetPage({ searchParams: sp("   ") })).rejects.toThrow(
      "__NOTFOUND__",
    );
    expect(mockResolveIdentity).not.toHaveBeenCalled();
    expect(mockGetGeneration).not.toHaveBeenCalled();
  });

  it("oversized or repeated ?id → 404, no row read", async () => {
    signedInAs(OWNER);
    await expect(BiosketchWorksheetPage({ searchParams: sp("x".repeat(65)) })).rejects.toThrow(
      "__NOTFOUND__",
    );
    await expect(BiosketchWorksheetPage({ searchParams: sp([GEN_ID, GEN_ID]) })).rejects.toThrow(
      "__NOTFOUND__",
    );
    expect(mockGetGeneration).not.toHaveBeenCalled();
  });

  it("signed-out → SAML redirect carrying the full worksheet URL, no row read", async () => {
    mockResolveIdentity.mockResolvedValue(null);
    await expect(BiosketchWorksheetPage({ searchParams: sp(GEN_ID) })).rejects.toThrow(
      `__REDIRECT__:/api/auth/saml/login?return=${encodeURIComponent(
        `/edit/biosketch/worksheet?id=${GEN_ID}`,
      )}`,
    );
    expect(mockGetGeneration).not.toHaveBeenCalled();
    expect(mockAuthorize).not.toHaveBeenCalled();
  });

  it("unknown generation → 404 before authz (nothing to authorize on)", async () => {
    signedInAs(OWNER);
    mockGetGeneration.mockResolvedValue(null);
    await expect(BiosketchWorksheetPage({ searchParams: sp(GEN_ID) })).rejects.toThrow(
      "__NOTFOUND__",
    );
    expect(mockGetGeneration).toHaveBeenCalledWith(GEN_ID);
    expect(mockAuthorize).not.toHaveBeenCalled();
    expect(mockLoadEditContext).not.toHaveBeenCalled();
  });
});

describe("/edit/biosketch/worksheet — authorization", () => {
  it("authorizes on the ROW's cwid with the caller's real identity, not the caller's cwid", async () => {
    signedInAs("prx0001");
    await BiosketchWorksheetPage({ searchParams: sp(GEN_ID) });
    expect(mockAuthorize).toHaveBeenCalledOnce();
    expect(mockAuthorize).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: OWNER,
        realCwid: "prx0001",
        impersonatedCwid: null,
        session: expect.objectContaining({ cwid: "prx0001" }),
      }),
    );
  });

  it("deny → ForbiddenEditPage shell + logged denial; no edit-context or honors read; no cwid on the 403", async () => {
    signedInAs("nob0001");
    mockAuthorize.mockResolvedValue({ ok: false, reason: "not_self" });
    const result = asEl(await BiosketchWorksheetPage({ searchParams: sp(GEN_ID) }));
    // Reduced-chrome shell: a bare div + ConsoleTopBar, ForbiddenEditPage as the second child.
    expect(result.type).toBe("div");
    const forbidden = asEl((result.props.children as unknown[])[1]);
    expect(forbidden.type).toBe(mockForbidden);
    // The caller supplied only the opaque id; the row's cwid must not be echoed back to them.
    expect(forbidden.props.targetCwid).toBeUndefined();
    expect(mockLogDenial).toHaveBeenCalledWith({
      actorCwid: "nob0001",
      targetCwid: OWNER,
      path: "/edit/biosketch/worksheet",
      reason: "not_self",
    });
    expect(mockLoadEditContext).not.toHaveBeenCalled();
    expect(mockHonorFindMany).not.toHaveBeenCalled();
    expect(mockWorksheet).not.toHaveBeenCalled();
  });

  it("proxy_conflict deny is a deny (no fall-through to render)", async () => {
    signedInAs("prx0001");
    mockAuthorize.mockResolvedValue({ ok: false, reason: "proxy_conflict" });
    const result = asEl(await BiosketchWorksheetPage({ searchParams: sp(GEN_ID) }));
    expect(result.type).toBe("div");
    expect(asEl((result.props.children as unknown[])[1]).type).toBe(mockForbidden);
    expect(mockLogDenial).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "proxy_conflict" }),
    );
    expect(mockLoadEditContext).not.toHaveBeenCalled();
  });

  it("allow (self) → loads the context + published honors for the row's cwid, renders the worksheet with the self back link", async () => {
    signedInAs(OWNER);
    const result = asEl(await BiosketchWorksheetPage({ searchParams: sp(GEN_ID) }));
    expect(result.type).toBe("div");
    expect(mockLogDenial).not.toHaveBeenCalled();
    expect(mockLoadEditContext).toHaveBeenCalledWith(OWNER, expect.anything());
    expect(mockHonorFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { cwid: OWNER, status: "published", showOnProfile: true },
      }),
    );
    const main = asEl((result.props.children as unknown[])[1]);
    expect(main.type).toBe("main");
    const worksheet = asEl(main.props.children);
    expect(worksheet.type).toBe(mockWorksheet);
    expect(worksheet.props.cwid).toBe(OWNER);
    expect(worksheet.props.backHref).toBe("/edit?attr=biosketch");
    expect(worksheet.props.honors).toEqual(HONORS);
    expect(worksheet.props.generation).toEqual({
      id: GEN_ID,
      mode: "contributions",
      entries: GENERATION.entries,
      products: null,
      createdAt: "2026-09-01T12:00:00.000Z",
    });
  });

  it("allow (delegate on another scholar) → worksheet keyed on the ROW's cwid, back link to that scholar's editor", async () => {
    signedInAs("adm0001", { isSuperuser: true });
    const result = asEl(await BiosketchWorksheetPage({ searchParams: sp(GEN_ID) }));
    const worksheet = asEl(asEl((result.props.children as unknown[])[1]).props.children);
    expect(worksheet.type).toBe(mockWorksheet);
    expect(worksheet.props.cwid).toBe(OWNER);
    expect(worksheet.props.backHref).toBe(`/edit/scholar/${OWNER}?attr=biosketch`);
    expect(mockLoadEditContext).toHaveBeenCalledWith(OWNER, expect.anything());
  });

  it("allow but scholar context absent → 404", async () => {
    signedInAs(OWNER);
    mockLoadEditContext.mockResolvedValue(null);
    await expect(BiosketchWorksheetPage({ searchParams: sp(GEN_ID) })).rejects.toThrow(
      "__NOTFOUND__",
    );
    expect(mockWorksheet).not.toHaveBeenCalled();
  });

  it("#536 hidden class + non-superuser (even self) → 404, keyed on the row scholar's role", async () => {
    signedInAs(OWNER);
    mockIsPubliclyDisplayed.mockReturnValue(false);
    await expect(BiosketchWorksheetPage({ searchParams: sp(GEN_ID) })).rejects.toThrow(
      "__NOTFOUND__",
    );
    expect(mockIsPubliclyDisplayed).toHaveBeenCalledWith("full_time_faculty");
    expect(mockWorksheet).not.toHaveBeenCalled();
  });

  it("#536 hidden class + superuser → renders (superuser bypasses)", async () => {
    signedInAs("adm0001", { isSuperuser: true });
    mockIsPubliclyDisplayed.mockReturnValue(false);
    const result = asEl(await BiosketchWorksheetPage({ searchParams: sp(GEN_ID) }));
    const worksheet = asEl(asEl((result.props.children as unknown[])[1]).props.children);
    expect(worksheet.type).toBe(mockWorksheet);
  });
});

describe("/edit/biosketch/worksheet — what reaches the worksheet", () => {
  async function worksheetProps() {
    signedInAs(OWNER);
    const result = asEl(await BiosketchWorksheetPage({ searchParams: sp(GEN_ID) }));
    return asEl(asEl((result.props.children as unknown[])[1]).props.children).props;
  }

  it("passes only the four identity fields the worksheet needs (no roleCategory)", async () => {
    const p = await worksheetProps();
    expect(p.scholar).toEqual(SCHOLAR_FIELDS);
  });

  it("education: shown rows only, without the edit-state field", async () => {
    const p = await worksheetProps();
    expect(p.educations).toEqual([
      { degree: "PhD", institution: "Example U", field: "Biostatistics", year: 2010 },
    ]);
  });

  it("appointments: shown + locked only, reverse chronological by start date", async () => {
    const p = await worksheetProps();
    expect(p.appointments).toEqual([
      { title: "Chair", organization: "Example Dept", startDate: "2022-01-01", endDate: null },
      {
        title: "Associate Professor",
        organization: "Example Dept",
        startDate: "2020-07-01",
        endDate: null,
      },
      {
        title: "Assistant Professor",
        organization: "Example Dept",
        startDate: "2015-07-01",
        endDate: "2020-06-30",
      },
    ]);
  });
});
