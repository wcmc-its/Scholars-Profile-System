/**
 * #2652 — `app/edit/biosketch/worksheet/page.tsx` authorization + wiring.
 *
 * The gate, in order: `EDIT_BIOSKETCH_GENERATE` off → 404 (before any session or DB work);
 * missing / oversized `?id` → 404; signed-out → SAML redirect carrying the full worksheet URL;
 * unknown generation → 404 (before authz — the row's `cwid` IS the authz key); authz deny →
 * the reduced-chrome `ForbiddenEditPage` shell + a logged denial, with NO edit-context or honors
 * read and NO cwid echoed to the 403; authz allow → the edit context, published honors, the
 * WHOLE appointment history (not the edit context's active-only set) and the newest other-mode
 * draft load, and the worksheet renders keyed on the ROW's cwid (never the caller's); #536
 * hidden class + non-superuser → 404 (superuser bypasses), as on the scholar editor. Follows the #955
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
  mockAppointmentFindMany,
  mockSuppressionFindMany,
  mockGenerationFindFirst,
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
  mockAppointmentFindMany: vi.fn(),
  mockSuppressionFindMany: vi.fn(),
  mockGenerationFindFirst: vi.fn(),
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
// `coerceEntries` stays real: the other-mode draft's stored JSON goes through it on the page.
vi.mock("@/lib/edit/biosketch-provenance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edit/biosketch-provenance")>()),
  getBiosketchGeneration: mockGetGeneration,
}));
vi.mock("@/lib/edit/overview-authz", () => ({ authorizeOverviewWrite: mockAuthorize }));
vi.mock("@/lib/edit/authz", () => ({ logEditDenial: mockLogDenial }));
vi.mock("@/lib/api/edit-context", () => ({ loadEditContext: mockLoadEditContext }));
vi.mock("@/lib/eligibility", () => ({ isPubliclyDisplayed: mockIsPubliclyDisplayed }));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      honor: { findMany: mockHonorFindMany },
      appointment: { findMany: mockAppointmentFindMany },
      suppression: { findMany: mockSuppressionFindMany },
      biosketchGeneration: { findFirst: mockGenerationFindFirst },
    },
    write: {},
  },
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
  // The edit context's appointment set is ACTIVE rows only, so the page must NOT read it for
  // SciENcv's whole-career block. A decoy title pins that: it appears nowhere in the table
  // rows below, so it can only reach the worksheet through `ctx.appointments`.
  appointments: [
    {
      title: "Decoy (edit context)",
      organization: "Example Dept",
      startDate: "2022-01-01",
      endDate: null,
      state: "shown",
    },
  ],
};
const HONORS = [{ name: "Best Paper", organization: "Society", year: 2024 }];
/** The table rows for the owner, as Prisma returns them (Date columns), in no useful order. */
const APPOINTMENT_ROWS = [
  {
    externalId: "appt-assistant",
    title: "Assistant Professor",
    organization: "Example Dept",
    startDate: new Date("2015-07-01T00:00:00.000Z"),
    endDate: new Date("2020-06-30T00:00:00.000Z"),
  },
  {
    externalId: "appt-chair",
    title: "Chair",
    organization: "Example Dept",
    startDate: new Date("2022-01-01T00:00:00.000Z"),
    endDate: null,
  },
  {
    externalId: "appt-suppressed",
    title: "Adjunct",
    organization: "Elsewhere",
    startDate: new Date("2018-01-01T00:00:00.000Z"),
    endDate: null,
  },
  {
    // A 3-day WOOFA effective-dating artifact (`looksLikeArtifactAppointment`), not a job.
    externalId: "appt-artifact",
    title: "Assistant Professor (Interim)",
    organization: "Example Dept",
    startDate: new Date("2015-06-28T00:00:00.000Z"),
    endDate: new Date("2015-07-01T00:00:00.000Z"),
  },
  {
    externalId: "appt-associate",
    title: "Associate Professor",
    organization: "Example Dept",
    startDate: new Date("2020-07-01T00:00:00.000Z"),
    endDate: null,
  },
  {
    // Historical (expired years ago) — exactly the row the edit context never carries.
    externalId: "appt-fellow",
    title: "Research Fellow",
    organization: "Elsewhere U",
    startDate: new Date("2010-09-01T00:00:00.000Z"),
    endDate: new Date("2013-08-31T00:00:00.000Z"),
  },
];
const OTHER_DRAFT_ROW = {
  // Pre-v7 rows stored a plain `string[]`; `coerceEntries` lifts it to `{ title, body }`.
  entries: ["My statement, from an older draft."],
  createdAt: new Date("2026-08-15T09:30:00.000Z"),
};

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
  mockAppointmentFindMany.mockResolvedValue(APPOINTMENT_ROWS);
  mockSuppressionFindMany.mockResolvedValue([{ entityId: "appt-suppressed" }]);
  mockGenerationFindFirst.mockResolvedValue(null);
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
    expect(mockAppointmentFindMany).not.toHaveBeenCalled();
    expect(mockGenerationFindFirst).not.toHaveBeenCalled();
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

  it("appointments: the WHOLE history from the table, not the edit context's active-only set", async () => {
    const p = await worksheetProps();
    // Every row, no active-only predicate — the expired rows are the point.
    expect(mockAppointmentFindMany).toHaveBeenCalledOnce();
    expect(mockAppointmentFindMany.mock.calls[0]![0].where).toEqual({ cwid: OWNER });
    const titles = (p.appointments as Array<{ title: string }>).map((a) => a.title);
    expect(titles).toContain("Research Fellow");
    expect(titles).not.toContain("Decoy (edit context)");
  });

  it("appointments: the profile's #160 suppression exclusion + artifact drop, in SciENcv order", async () => {
    const p = await worksheetProps();
    expect(mockSuppressionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          entityType: "appointment",
          entityId: { in: APPOINTMENT_ROWS.map((a) => a.externalId) },
          revokedAt: null,
        }),
      }),
    );
    // Current (no end date) first, newest start first; then ended, most recently ended first.
    // The suppressed Adjunct and the 3-day (Interim) artifact are gone; dates are ISO days.
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
      {
        title: "Research Fellow",
        organization: "Elsewhere U",
        startDate: "2010-09-01",
        endDate: "2013-08-31",
      },
    ]);
  });

  it("appointments: no rows → no suppression query, empty list", async () => {
    mockAppointmentFindMany.mockResolvedValue([]);
    const p = await worksheetProps();
    expect(mockSuppressionFindMany).not.toHaveBeenCalled();
    expect(p.appointments).toEqual([]);
  });

  it("other-mode draft: a Contributions worksheet reads the newest Personal Statement and passes it, dated", async () => {
    mockGenerationFindFirst.mockResolvedValue(OTHER_DRAFT_ROW);
    const p = await worksheetProps();
    expect(mockGenerationFindFirst).toHaveBeenCalledOnce();
    expect(mockGenerationFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { cwid: OWNER, mode: "personal_statement" },
        orderBy: { createdAt: "desc" },
      }),
    );
    expect(p.otherDraft).toEqual({
      entries: [{ title: "", body: "My statement, from an older draft." }],
      createdAt: "2026-08-15T09:30:00.000Z",
    });
  });

  it("other-mode draft: a Personal Statement worksheet reads the newest Contributions draft", async () => {
    mockGetGeneration.mockResolvedValue({
      ...GENERATION,
      mode: "personal_statement",
      entries: [{ title: "", body: "The statement." }],
    });
    mockGenerationFindFirst.mockResolvedValue({
      entries: [{ title: "Heading", body: "Body." }],
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
    });
    const p = await worksheetProps();
    expect(mockGenerationFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { cwid: OWNER, mode: "contributions" } }),
    );
    expect(p.otherDraft).toEqual({
      entries: [{ title: "Heading", body: "Body." }],
      createdAt: "2026-07-01T00:00:00.000Z",
    });
  });

  it("other-mode draft: none on file → null (the block keeps its note)", async () => {
    const p = await worksheetProps();
    expect(mockGenerationFindFirst).toHaveBeenCalledOnce();
    expect(p.otherDraft).toBeNull();
  });
});
