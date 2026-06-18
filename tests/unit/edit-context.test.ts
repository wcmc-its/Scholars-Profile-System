/**
 * `lib/api/edit-context.ts` — the suppression-OFF read for the `/edit` self
 * surface (Phase 6 C1, D6.1).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// `loadEditContext`'s default mentee-loader calls `getMenteesForMentor`, which
// opens a live reporting-DB connection. Mock it to an empty list so the suite
// needs no reporting DB; the mentee-specific tests below inject their own loader
// via the 4th `loadEditContext` arg, bypassing this default entirely.
vi.mock("@/lib/api/mentoring", () => ({
  // #843 — getMenteesForMentor now returns { mentees, copubSourceAvailable };
  // defaultLoadMentees destructures `.mentees`, so the mock must match.
  getMenteesForMentor: vi.fn(async () => ({ mentees: [], copubSourceAvailable: true })),
}));

import { loadEditContext } from "@/lib/api/edit-context";
import { getMenteesForMentor } from "@/lib/api/mentoring";
import { REJECT_REASON } from "@/lib/edit/reject-reason";

type AnyMock = ReturnType<typeof vi.fn>;
type FakeClient = {
  scholar: { findUnique: AnyMock };
  suppression: { findMany: AnyMock };
  publicationAuthor: { findMany: AnyMock };
  fieldOverride: { findUnique: AnyMock };
  appointment: { findMany: AnyMock };
  education: { findMany: AnyMock };
  grant: { findMany: AnyMock };
  department: { findFirst: AnyMock };
  coiActivity: { findMany: AnyMock };
  coiGapCandidate: { findMany: AnyMock };
  publication: { findMany: AnyMock };
  publicationConflictStatement: { findMany: AnyMock };
};
type EditContextClient = Parameters<typeof loadEditContext>[1];

const SELF = "self01";

function fakeClient(): FakeClient {
  // `fieldOverride.findUnique` is called twice — once for `overview` (Phase 3
  // read-merge) and once for `slug` (Phase 7 superuser slug-card baseline).
  // Default both to "no override"; per-test overrides may set values keyed on
  // the requested fieldName via `mockImplementation`, or simply
  // `mockResolvedValue` to set both at once.
  return {
    scholar: { findUnique: vi.fn() },
    suppression: { findMany: vi.fn().mockResolvedValue([]) },
    publicationAuthor: { findMany: vi.fn().mockResolvedValue([]) },
    fieldOverride: { findUnique: vi.fn().mockResolvedValue(null) },
    // #160 entity attributes — default to "no rows" so the existing tests
    // (which exercise only scholar + publications) trigger zero entity-
    // suppression queries (guarded on externalIds.length > 0) and stay green.
    appointment: { findMany: vi.fn().mockResolvedValue([]) },
    education: { findMany: vi.fn().mockResolvedValue([]) },
    grant: { findMany: vi.fn().mockResolvedValue([]) },
    department: { findFirst: vi.fn().mockResolvedValue(null) },
    // COI — read-only; default to "no disclosures".
    coiActivity: { findMany: vi.fn().mockResolvedValue([]) },
    // COI-gap candidates — default to "none". Only queried when the loader is
    // called with `{ includeCoiGap: true }` (the self-only gate).
    coiGapCandidate: { findMany: vi.fn().mockResolvedValue([]) },
    // Publications — the COI-gap loader joins this by pmid for the per-source
    // year + sort date. Default to "no rows" (year/ts fall back to null/0).
    publication: { findMany: vi.fn().mockResolvedValue([]) },
    // #1112 — the COI-gap loader joins this by pmid for Paper view's verbatim
    // `fullText`. Default to "no statement row" (fullText falls back to clause).
    publicationConflictStatement: { findMany: vi.fn().mockResolvedValue([]) },
  };
}

/**
 * Build a `fieldOverride.findUnique` implementation that returns the requested
 * value per `fieldName`. Use when a test sets distinct values for `overview`
 * and `slug` overrides at once. A `null` map entry is "no override".
 */
function fieldOverrideMap(map: { overview?: string | null; slug?: string | null }) {
  return (args: {
    where: {
      entityType_entityId_fieldName: {
        entityType: string;
        entityId: string;
        fieldName: string;
      };
    };
  }) => {
    const field = args.where.entityType_entityId_fieldName.fieldName;
    const v = map[field as keyof typeof map];
    return Promise.resolve(v === undefined || v === null ? null : { value: v });
  };
}

const asClient = (c: FakeClient) => c as unknown as EditContextClient;

function scholarRow(over: { overview?: string | null; deletedAt?: Date | null } = {}) {
  return {
    cwid: SELF,
    slug: "self-slug",
    preferredName: "Alex Self",
    fullName: "Alex Self, MD",
    overview: over.overview ?? null,
    deletedAt: over.deletedAt ?? null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadEditContext — boundary cases", () => {
  it("returns null when the scholar row does not exist", async () => {
    const c = fakeClient();
    c.scholar.findUnique.mockResolvedValue(null);
    const ctx = await loadEditContext(SELF, asClient(c));
    expect(ctx).toBeNull();
    // No follow-on queries.
    expect(c.suppression.findMany).not.toHaveBeenCalled();
    expect(c.publicationAuthor.findMany).not.toHaveBeenCalled();
  });

  it("returns null when the scholar is soft-deleted", async () => {
    const c = fakeClient();
    c.scholar.findUnique.mockResolvedValue(scholarRow({ deletedAt: new Date("2024-01-01") }));
    const ctx = await loadEditContext(SELF, asClient(c));
    expect(ctx).toBeNull();
  });

  it("returns a row with empty publications when the scholar has no authorships", async () => {
    const c = fakeClient();
    c.scholar.findUnique.mockResolvedValue(scholarRow({ overview: "<p>seed</p>" }));
    const ctx = await loadEditContext(SELF, asClient(c));
    expect(ctx).not.toBeNull();
    expect(ctx!.publications).toHaveLength(0);
    expect(ctx!.scholar.cwid).toBe(SELF);
    // The pmid-scoped queries are skipped (publication suppression load + confirmed authors).
    expect(c.suppression.findMany).toHaveBeenCalledTimes(1); // just the scholar one
  });

  it("default mentee-loader skips the co-pub query on the edit surface (#955 #5)", async () => {
    const c = fakeClient();
    c.scholar.findUnique.mockResolvedValue(scholarRow());
    await loadEditContext(SELF, asClient(c));
    // The /edit Mentees panel renders no co-pub count, so the default loader asks
    // getMenteesForMentor to skip that source.
    expect(vi.mocked(getMenteesForMentor)).toHaveBeenCalledWith(
      SELF,
      expect.objectContaining({ includeCopubs: false, sort: "class-year" }),
    );
  });
});

describe("loadEditContext — overview merge (Phase 3 read-merge)", () => {
  it("returns the field_override value when present", async () => {
    const c = fakeClient();
    c.scholar.findUnique.mockResolvedValue(scholarRow({ overview: "<p>seed</p>" }));
    c.fieldOverride.findUnique.mockImplementation(fieldOverrideMap({ overview: "<p>edited</p>" }));
    const ctx = await loadEditContext(SELF, asClient(c));
    expect(ctx!.scholar.overview).toBe("<p>edited</p>");
  });

  it("returns the ETL column when no field_override exists", async () => {
    const c = fakeClient();
    c.scholar.findUnique.mockResolvedValue(scholarRow({ overview: "<p>seed</p>" }));
    c.fieldOverride.findUnique.mockResolvedValue(null);
    const ctx = await loadEditContext(SELF, asClient(c));
    expect(ctx!.scholar.overview).toBe("<p>seed</p>");
  });

  it("returns an empty string when the override is the empty string (cleared bio)", async () => {
    const c = fakeClient();
    c.scholar.findUnique.mockResolvedValue(scholarRow({ overview: "<p>seed</p>" }));
    c.fieldOverride.findUnique.mockImplementation(fieldOverrideMap({ overview: "" }));
    const ctx = await loadEditContext(SELF, asClient(c));
    expect(ctx!.scholar.overview).toBe("");
  });

  it("returns an empty string when neither override nor column is set", async () => {
    const c = fakeClient();
    c.scholar.findUnique.mockResolvedValue(scholarRow({ overview: null }));
    c.fieldOverride.findUnique.mockResolvedValue(null);
    const ctx = await loadEditContext(SELF, asClient(c));
    expect(ctx!.scholar.overview).toBe("");
  });
});

describe("loadEditContext — visibility-card state", () => {
  it("ownRow=null, adminRow=null when no scholar suppressions exist", async () => {
    const c = fakeClient();
    c.scholar.findUnique.mockResolvedValue(scholarRow());
    const ctx = await loadEditContext(SELF, asClient(c));
    expect(ctx!.scholar.suppression.ownRow).toBeNull();
    expect(ctx!.scholar.suppression.adminRow).toBeNull();
  });

  it("self-applied: ownRow set, adminRow null", async () => {
    const c = fakeClient();
    c.scholar.findUnique.mockResolvedValue(scholarRow());
    c.suppression.findMany.mockResolvedValue([
      { id: "sup-1", reason: "privacy", createdBy: SELF, createdAt: new Date("2026-05-01") },
    ]);
    const ctx = await loadEditContext(SELF, asClient(c));
    expect(ctx!.scholar.suppression.ownRow).toEqual({ id: "sup-1", reason: "privacy" });
    expect(ctx!.scholar.suppression.adminRow).toBeNull();
  });

  it("admin-applied: adminRow set, ownRow null", async () => {
    const c = fakeClient();
    c.scholar.findUnique.mockResolvedValue(scholarRow());
    c.suppression.findMany.mockResolvedValue([
      {
        id: "sup-2",
        reason: "compliance",
        createdBy: "admin99",
        createdAt: new Date("2026-05-02"),
      },
    ]);
    const ctx = await loadEditContext(SELF, asClient(c));
    expect(ctx!.scholar.suppression.ownRow).toBeNull();
    expect(ctx!.scholar.suppression.adminRow).toEqual({
      id: "sup-2",
      reason: "compliance",
      createdAt: new Date("2026-05-02"),
    });
  });

  it("both: edge case 4 — self + admin coexist", async () => {
    const c = fakeClient();
    c.scholar.findUnique.mockResolvedValue(scholarRow());
    c.suppression.findMany.mockResolvedValue([
      { id: "sup-self", reason: "privacy", createdBy: SELF, createdAt: new Date("2026-05-01") },
      {
        id: "sup-adm",
        reason: "compliance",
        createdBy: "admin99",
        createdAt: new Date("2026-05-02"),
      },
    ]);
    const ctx = await loadEditContext(SELF, asClient(c));
    expect(ctx!.scholar.suppression.ownRow).toEqual({ id: "sup-self", reason: "privacy" });
    expect(ctx!.scholar.suppression.adminRow).toEqual({
      id: "sup-adm",
      reason: "compliance",
      createdAt: new Date("2026-05-02"),
    });
  });
});

describe("loadEditContext — publication state annotation", () => {
  function withOnePub(pmid: string, pubSuppressions: unknown[], confirmedAuthors: unknown[]) {
    const c = fakeClient();
    c.scholar.findUnique.mockResolvedValue(scholarRow());
    c.publicationAuthor.findMany
      // First call — authorships for the scholar.
      .mockResolvedValueOnce([
        { publication: { pmid, title: "T", journal: "J", year: 2025 } },
      ])
      // Second call — confirmed displayed authors across the pmid set.
      .mockResolvedValueOnce(confirmedAuthors);
    // Two suppression.findMany calls: scholar-level (already mocked to []) then pub-level.
    c.suppression.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce(pubSuppressions);
    return c;
  }

  it("state='shown' when no suppression covers the pmid", async () => {
    const c = withOnePub("pmid-1", [], [{ pmid: "pmid-1", cwid: SELF }]);
    const ctx = await loadEditContext(SELF, asClient(c));
    expect(ctx!.publications).toHaveLength(1);
    expect(ctx!.publications[0]).toMatchObject({
      pmid: "pmid-1",
      state: "shown",
      suppressionId: null,
    });
  });

  it("state='hidden_by_self' when only this scholar's per-author hide exists, carries suppressionId", async () => {
    const c = withOnePub(
      "pmid-2",
      [{ id: "sup-x", entityId: "pmid-2", contributorCwid: SELF }],
      [{ pmid: "pmid-2", cwid: SELF }],
    );
    const ctx = await loadEditContext(SELF, asClient(c));
    expect(ctx!.publications[0]).toMatchObject({
      state: "hidden_by_self",
      suppressionId: "sup-x",
    });
  });

  it("state='removed_by_admin' when a whole-pub takedown covers the pmid", async () => {
    const c = withOnePub(
      "pmid-3",
      [{ id: "sup-admin", entityId: "pmid-3", contributorCwid: null }],
      [{ pmid: "pmid-3", cwid: SELF }],
    );
    const ctx = await loadEditContext(SELF, asClient(c));
    expect(ctx!.publications[0]).toMatchObject({
      state: "removed_by_admin",
      suppressionId: null,
    });
  });

  it("admin-takedown outranks a self-hide on the same pmid", async () => {
    const c = withOnePub(
      "pmid-4",
      [
        { id: "sup-self", entityId: "pmid-4", contributorCwid: SELF },
        { id: "sup-adm", entityId: "pmid-4", contributorCwid: null },
      ],
      [{ pmid: "pmid-4", cwid: SELF }],
    );
    const ctx = await loadEditContext(SELF, asClient(c));
    expect(ctx!.publications[0].state).toBe("removed_by_admin");
    // No "Show" button is rendered for admin-removed; suppressionId is also null.
    expect(ctx!.publications[0].suppressionId).toBeNull();
  });

  it("a co-author's hide is ignored — the scholar's own row stays 'shown'", async () => {
    const c = withOnePub(
      "pmid-5",
      [{ id: "sup-coauthor", entityId: "pmid-5", contributorCwid: "other7" }],
      // The co-author was hidden, so they're not in the displayed set; self remains.
      [{ pmid: "pmid-5", cwid: SELF }],
    );
    const ctx = await loadEditContext(SELF, asClient(c));
    expect(ctx!.publications[0].state).toBe("shown");
    expect(ctx!.publications[0].suppressionId).toBeNull();
  });

  // #750 — a reject and a Hide are both per-author rows with
  // `contributorCwid === cwid`; only `suppression.reason` tells them apart.
  it("state='rejected' when the self per-author suppression carries the reject reason; no Show id", async () => {
    const c = withOnePub(
      "pmid-6",
      [{ id: "sup-rej", entityId: "pmid-6", contributorCwid: SELF, reason: REJECT_REASON }],
      [{ pmid: "pmid-6", cwid: SELF }],
    );
    const ctx = await loadEditContext(SELF, asClient(c));
    expect(ctx!.publications[0]).toMatchObject({
      state: "rejected",
      // No Show control for a reject — un-hiding locally would diverge from
      // ReCiter's gold standard, so suppressionId is withheld.
      suppressionId: null,
      isSoleDisplayedAuthor: false,
    });
  });

  it("state='hidden_by_self' (not 'rejected') when the self row carries a non-reject Hide reason", async () => {
    const c = withOnePub(
      "pmid-7",
      [
        {
          id: "sup-hide",
          entityId: "pmid-7",
          contributorCwid: SELF,
          reason: "Hidden by the author via /edit",
        },
      ],
      [{ pmid: "pmid-7", cwid: SELF }],
    );
    const ctx = await loadEditContext(SELF, asClient(c));
    expect(ctx!.publications[0]).toMatchObject({
      state: "hidden_by_self",
      suppressionId: "sup-hide",
    });
  });

  it("an admin whole-pub takedown still outranks a self reject on the same pmid", async () => {
    const c = withOnePub(
      "pmid-8",
      [
        { id: "sup-rej", entityId: "pmid-8", contributorCwid: SELF, reason: REJECT_REASON },
        { id: "sup-adm", entityId: "pmid-8", contributorCwid: null, reason: "compliance" },
      ],
      [{ pmid: "pmid-8", cwid: SELF }],
    );
    const ctx = await loadEditContext(SELF, asClient(c));
    expect(ctx!.publications[0].state).toBe("removed_by_admin");
    expect(ctx!.publications[0].suppressionId).toBeNull();
  });
});

describe("loadEditContext — isSoleDisplayedAuthor", () => {
  function withDisplayedSet(displayed: string[], pubSuppressions: unknown[] = []) {
    const c = fakeClient();
    c.scholar.findUnique.mockResolvedValue(scholarRow());
    c.publicationAuthor.findMany
      .mockResolvedValueOnce([
        { publication: { pmid: "pmid-9", title: "T", journal: "J", year: 2025 } },
      ])
      .mockResolvedValueOnce(displayed.map((cwid) => ({ pmid: "pmid-9", cwid })));
    c.suppression.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce(pubSuppressions);
    return c;
  }

  it("true when this scholar is the only displayed author", async () => {
    const c = withDisplayedSet([SELF]);
    const ctx = await loadEditContext(SELF, asClient(c));
    expect(ctx!.publications[0].isSoleDisplayedAuthor).toBe(true);
  });

  it("false when a co-author is also displayed", async () => {
    const c = withDisplayedSet([SELF, "other7"]);
    const ctx = await loadEditContext(SELF, asClient(c));
    expect(ctx!.publications[0].isSoleDisplayedAuthor).toBe(false);
  });

  it("false when state != 'shown' (no hide click is reachable, dialog is irrelevant)", async () => {
    const c = withDisplayedSet([SELF, "other7"], [
      { id: "sup-self", entityId: "pmid-9", contributorCwid: SELF },
    ]);
    const ctx = await loadEditContext(SELF, asClient(c));
    expect(ctx!.publications[0].state).toBe("hidden_by_self");
    expect(ctx!.publications[0].isSoleDisplayedAuthor).toBe(false);
  });

  it("true when a co-author exists but is per-author-hidden (so the displayed set is just self)", async () => {
    // ETL returns both authors confirmed; the co-author has a hide on this pmid;
    // displayed set after exclusion is {self}, so a hide-now would derive-dark.
    const c = fakeClient();
    c.scholar.findUnique.mockResolvedValue(scholarRow());
    c.publicationAuthor.findMany
      .mockResolvedValueOnce([
        { publication: { pmid: "pmid-9", title: "T", journal: "J", year: 2025 } },
      ])
      .mockResolvedValueOnce([
        { pmid: "pmid-9", cwid: SELF },
        { pmid: "pmid-9", cwid: "coauth1" },
      ]);
    c.suppression.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "sup-co", entityId: "pmid-9", contributorCwid: "coauth1" },
      ]);
    const ctx = await loadEditContext(SELF, asClient(c));
    expect(ctx!.publications[0].state).toBe("shown");
    expect(ctx!.publications[0].isSoleDisplayedAuthor).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 7 — slugOverride baseline (the superuser slug-card)
// ---------------------------------------------------------------------------

describe("loadEditContext — slugOverride (Phase 7 read for the superuser slug-card)", () => {
  it("returns null when no field_override(slug) row exists", async () => {
    const c = fakeClient();
    c.scholar.findUnique.mockResolvedValue(scholarRow());
    // Both overview and slug findUnique return null by default.
    const ctx = await loadEditContext(SELF, asClient(c));
    expect(ctx!.scholar.slugOverride).toBeNull();
  });

  it("returns the override value when a field_override(slug) row exists", async () => {
    const c = fakeClient();
    c.scholar.findUnique.mockResolvedValue(scholarRow({ overview: "<p>seed</p>" }));
    c.fieldOverride.findUnique.mockImplementation(
      fieldOverrideMap({ overview: "<p>edited</p>", slug: "custom-handle" }),
    );
    const ctx = await loadEditContext(SELF, asClient(c));
    expect(ctx!.scholar.slugOverride).toBe("custom-handle");
    // overview merge still works alongside the new slug read
    expect(ctx!.scholar.overview).toBe("<p>edited</p>");
  });

  it("queries fieldOverride.findUnique with the correct composite key for slug", async () => {
    const c = fakeClient();
    c.scholar.findUnique.mockResolvedValue(scholarRow());
    await loadEditContext(SELF, asClient(c));
    const slugCall = c.fieldOverride.findUnique.mock.calls.find(
      (args) =>
        args[0].where.entityType_entityId_fieldName.fieldName === "slug",
    );
    expect(slugCall).toBeDefined();
    expect(slugCall![0].where.entityType_entityId_fieldName).toEqual({
      entityType: "scholar",
      entityId: SELF,
      fieldName: "slug",
    });
  });
});

// ---------------------------------------------------------------------------
// Phase 7 — arbitrary-cwid read (the superuser surface calls with any cwid)
// ---------------------------------------------------------------------------

describe("loadEditContext — arbitrary-cwid behavior (Phase 7 §2)", () => {
  it("called with another cwid returns that scholar's data, suppression-OFF", async () => {
    const c = fakeClient();
    c.scholar.findUnique.mockResolvedValue({
      cwid: "other7",
      slug: "other-slug",
      preferredName: "Alex Other",
      fullName: "Alex Other, MD",
      overview: "<p>other bio</p>",
      deletedAt: null,
    });
    const ctx = await loadEditContext("other7", asClient(c));
    expect(ctx).not.toBeNull();
    expect(ctx!.scholar.cwid).toBe("other7");
    expect(ctx!.scholar.preferredName).toBe("Alex Other");
    expect(c.scholar.findUnique).toHaveBeenCalledWith({
      where: { cwid: "other7" },
      select: expect.anything(),
    });
  });

  it("called with a cwid that has no scholar row returns null (page handler renders notFound())", async () => {
    const c = fakeClient();
    c.scholar.findUnique.mockResolvedValue(null);
    const ctx = await loadEditContext("missing-cwid", asClient(c));
    expect(ctx).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #160 UI follow-up — the three whole-entity attributes
// (Appointments / Education / Funding), `self-edit-launch-spec.md`.
// ---------------------------------------------------------------------------

describe("loadEditContext — entity attributes (#160 appointments / education / grants)", () => {
  const NOW = new Date("2026-06-01T12:00:00.000Z");

  /**
   * Set up a scholar with the given entities. `suppression.findMany` is
   * sequenced: call #1 = the scholar-level query (empty here), call #2 = the
   * bounded entity query (skipped by the loader when there are no entities).
   */
  function withEntities(opts: {
    appointments?: unknown[];
    educations?: unknown[];
    grants?: unknown[];
    entitySuppressions?: unknown[];
    chairedDept?: { name: string } | null;
  }) {
    const c = fakeClient();
    c.scholar.findUnique.mockResolvedValue(scholarRow());
    c.appointment.findMany.mockResolvedValue(opts.appointments ?? []);
    c.education.findMany.mockResolvedValue(opts.educations ?? []);
    c.grant.findMany.mockResolvedValue(opts.grants ?? []);
    c.department.findFirst.mockResolvedValue(opts.chairedDept ?? null);
    c.suppression.findMany
      .mockResolvedValueOnce([]) // scholar-level
      .mockResolvedValueOnce(opts.entitySuppressions ?? []); // entity-level
    return c;
  }

  const appt = (over: Record<string, unknown>) => ({
    externalId: "appt",
    title: "Professor of Medicine",
    organization: "Weill Cornell Medicine",
    startDate: new Date("2015-01-01"),
    endDate: null,
    isPrimary: false,
    ...over,
  });
  const grant = (over: Record<string, unknown>) => ({
    externalId: "grant",
    title: "R01 Something",
    role: "PI",
    funder: "Legacy Funder String",
    primeSponsor: "NCI",
    primeSponsorRaw: null,
    startDate: new Date("2024-01-01"),
    endDate: new Date("2027-01-01"),
    ...over,
  });

  it("annotates a shown appointment / education / grant when no suppression exists", async () => {
    const c = withEntities({
      appointments: [appt({ externalId: "appt-1", isPrimary: true })],
      educations: [
        { externalId: "edu-1", degree: "MD", institution: "Cornell", field: null, year: 2005 },
      ],
      grants: [grant({ externalId: "grant-1" })],
    });
    const ctx = await loadEditContext(SELF, asClient(c), NOW);
    expect(ctx!.appointments[0]).toMatchObject({
      externalId: "appt-1",
      state: "shown",
      suppressionId: null,
      isPrimary: true,
      startDate: "2015-01-01",
      endDate: null,
    });
    expect(ctx!.educations[0]).toMatchObject({ externalId: "edu-1", state: "shown", year: 2005 });
    expect(ctx!.grants[0]).toMatchObject({
      externalId: "grant-1",
      state: "shown",
      funderLabel: "NCI",
      startYear: 2024,
      endYear: 2027,
      isActive: true,
    });
  });

  it("distinguishes hidden_by_self from hidden_by_admin, carrying suppressionId for both", async () => {
    const c = withEntities({
      appointments: [
        appt({ externalId: "appt-self" }),
        appt({ externalId: "appt-adm" }),
      ],
      entitySuppressions: [
        { id: "sup-self", entityType: "appointment", entityId: "appt-self", createdBy: SELF },
        { id: "sup-adm", entityType: "appointment", entityId: "appt-adm", createdBy: "admin99" },
      ],
    });
    const ctx = await loadEditContext(SELF, asClient(c), NOW);
    const bySelf = ctx!.appointments.find((a) => a.externalId === "appt-self")!;
    const byAdmin = ctx!.appointments.find((a) => a.externalId === "appt-adm")!;
    expect(bySelf).toMatchObject({ state: "hidden_by_self", suppressionId: "sup-self" });
    // suppressionId is carried for admin hides too — the superuser surface revokes it.
    expect(byAdmin).toMatchObject({ state: "hidden_by_admin", suppressionId: "sup-adm" });
  });

  it("buckets a suppression to the right entity type (education vs grant share the query)", async () => {
    const c = withEntities({
      educations: [
        { externalId: "shared-id", degree: "PhD", institution: "X", field: null, year: 2000 },
      ],
      grants: [grant({ externalId: "shared-id" })], // same externalId, different type
      entitySuppressions: [
        { id: "sup-edu", entityType: "education", entityId: "shared-id", createdBy: SELF },
      ],
    });
    const ctx = await loadEditContext(SELF, asClient(c), NOW);
    expect(ctx!.educations[0].state).toBe("hidden_by_self");
    // The grant with the same externalId is untouched — keying is (type, id).
    expect(ctx!.grants[0].state).toBe("shown");
  });

  it("locks ONLY the chair appointment, not the chair's other appointments", async () => {
    const c = withEntities({
      appointments: [
        appt({ externalId: "appt-chair", title: "Chair of Medicine", isPrimary: true }),
        appt({ externalId: "appt-other", title: "Professor of Medicine" }),
      ],
      chairedDept: { name: "Medicine" },
    });
    const ctx = await loadEditContext(SELF, asClient(c), NOW);
    const chair = ctx!.appointments.find((a) => a.externalId === "appt-chair")!;
    const other = ctx!.appointments.find((a) => a.externalId === "appt-other")!;
    expect(chair.state).toBe("locked");
    expect(chair.suppressionId).toBeNull();
    expect(other.state).toBe("shown");
  });

  it("a chair lock overrides an (anomalous) suppression row on that appointment", async () => {
    // A chair appt can't be suppressed (409 guard), but defensively locked wins.
    const c = withEntities({
      appointments: [appt({ externalId: "appt-chair", title: "Chair of Medicine" })],
      chairedDept: { name: "Medicine" },
      entitySuppressions: [
        { id: "sup-x", entityType: "appointment", entityId: "appt-chair", createdBy: SELF },
      ],
    });
    const ctx = await loadEditContext(SELF, asClient(c), NOW);
    expect(ctx!.appointments[0].state).toBe("locked");
    expect(ctx!.appointments[0].suppressionId).toBeNull();
  });

  it("filters appointments to the active set (endDate null or in the future)", async () => {
    const c = withEntities({ appointments: [] });
    await loadEditContext(SELF, asClient(c), NOW);
    expect(c.appointment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { cwid: SELF, OR: [{ endDate: null }, { endDate: { gt: NOW } }] },
      }),
    );
  });

  it("grant isActive uses the NCE grace window — a just-expired grant is still Active", async () => {
    // endDate ~6 months before NOW, inside the 12-month NCE grace → Active.
    const c = withEntities({
      grants: [grant({ externalId: "g-nce", endDate: new Date("2025-12-01") })],
    });
    const ctx = await loadEditContext(SELF, asClient(c), NOW);
    expect(ctx!.grants[0].isActive).toBe(true);
  });

  it("grant funderLabel falls back primeSponsor → canonicalized raw → legacy funder", async () => {
    const c = withEntities({
      grants: [grant({ externalId: "g-fallback", primeSponsor: null, primeSponsorRaw: null })],
    });
    const ctx = await loadEditContext(SELF, asClient(c), NOW);
    expect(ctx!.grants[0].funderLabel).toBe("Legacy Funder String");
  });

  it("skips the entity-suppression query when the scholar has no entities", async () => {
    const c = fakeClient();
    c.scholar.findUnique.mockResolvedValue(scholarRow());
    await loadEditContext(SELF, asClient(c), NOW);
    // Only the scholar-level suppression query runs — no entity query.
    expect(c.suppression.findMany).toHaveBeenCalledTimes(1);
  });

  it("returns empty entity arrays for a scholar with no appointments / education / grants", async () => {
    const c = fakeClient();
    c.scholar.findUnique.mockResolvedValue(scholarRow());
    const ctx = await loadEditContext(SELF, asClient(c), NOW);
    expect(ctx!.appointments).toEqual([]);
    expect(ctx!.educations).toEqual([]);
    expect(ctx!.grants).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// #160 follow-up — COI disclosures (read-only) + mentees (suppressible).
// ---------------------------------------------------------------------------

describe("loadEditContext — COI disclosures (read-only)", () => {
  it("loads disclosures in the same select/order shape the profile uses", async () => {
    const c = fakeClient();
    c.scholar.findUnique.mockResolvedValue(scholarRow());
    c.coiActivity.findMany.mockResolvedValue([
      { entity: "Acme Therapeutics", activityGroup: "Ownership" },
      { entity: "Globex Pharma", activityGroup: "Leadership Roles" },
    ]);
    const ctx = await loadEditContext(SELF, asClient(c));
    expect(ctx!.coiDisclosures).toEqual([
      { entity: "Acme Therapeutics", activityGroup: "Ownership" },
      { entity: "Globex Pharma", activityGroup: "Leadership Roles" },
    ]);
    // Same query shape as lib/api/profile.ts (scoped to cwid, ordered group→entity).
    expect(c.coiActivity.findMany).toHaveBeenCalledWith({
      where: { cwid: SELF },
      select: { entity: true, activityGroup: true },
      orderBy: [{ activityGroup: "asc" }, { entity: "asc" }],
    });
  });

  it("returns an empty array when the scholar has no disclosures", async () => {
    const c = fakeClient();
    c.scholar.findUnique.mockResolvedValue(scholarRow());
    const ctx = await loadEditContext(SELF, asClient(c));
    expect(ctx!.coiDisclosures).toEqual([]);
  });
});

describe("loadEditContext — mentees (suppressible)", () => {
  const mentee = (over: Partial<{
    cwid: string;
    fullName: string;
    programName: string | null;
    programType: string | null;
  }> = {}) => ({
    cwid: over.cwid ?? "mentee9",
    fullName: over.fullName ?? "Jordan Mentee",
    programName: over.programName ?? null,
    programType: over.programType ?? null,
  });

  it("annotates a shown mentee with the {cwid}:{menteeCwid} externalId", async () => {
    const c = fakeClient();
    c.scholar.findUnique.mockResolvedValue(scholarRow());
    const ctx = await loadEditContext(SELF, asClient(c), undefined, async () => [
      mentee({ cwid: "m1", fullName: "Jordan Mentee", programName: "Immunology" }),
    ]);
    expect(ctx!.mentees).toHaveLength(1);
    expect(ctx!.mentees[0]).toMatchObject({
      externalId: "self01:m1",
      name: "Jordan Mentee",
      subtitle: "Immunology",
      state: "shown",
      suppressionId: null,
    });
  });

  it("derives the subtitle from programType when programName is absent", async () => {
    const c = fakeClient();
    c.scholar.findUnique.mockResolvedValue(scholarRow());
    const ctx = await loadEditContext(SELF, asClient(c), undefined, async () => [
      mentee({ cwid: "m2", programName: null, programType: "PhD" }),
    ]);
    // formatProgramLabel("PhD") → a non-null bucket label (the chip's fallback).
    expect(ctx!.mentees[0].subtitle).not.toBeNull();
  });

  it("distinguishes hidden_by_self from hidden_by_admin, carrying suppressionId for both", async () => {
    const c = fakeClient();
    c.scholar.findUnique.mockResolvedValue(scholarRow());
    // Two suppression.findMany calls: scholar-level then mentee-level.
    c.suppression.findMany
      .mockResolvedValueOnce([]) // scholar-level
      .mockResolvedValueOnce([
        { id: "sup-self", entityId: "self01:m-self", createdBy: SELF },
        { id: "sup-adm", entityId: "self01:m-adm", createdBy: "admin99" },
      ]);
    const ctx = await loadEditContext(SELF, asClient(c), undefined, async () => [
      mentee({ cwid: "m-self" }),
      mentee({ cwid: "m-adm" }),
    ]);
    const bySelf = ctx!.mentees.find((m) => m.externalId === "self01:m-self")!;
    const byAdmin = ctx!.mentees.find((m) => m.externalId === "self01:m-adm")!;
    expect(bySelf).toMatchObject({ state: "hidden_by_self", suppressionId: "sup-self" });
    expect(byAdmin).toMatchObject({ state: "hidden_by_admin", suppressionId: "sup-adm" });
  });

  it("queries mentee suppressions with the right entityType + entityId set", async () => {
    const c = fakeClient();
    c.scholar.findUnique.mockResolvedValue(scholarRow());
    await loadEditContext(SELF, asClient(c), undefined, async () => [
      mentee({ cwid: "m1" }),
      mentee({ cwid: "m2" }),
    ]);
    const menteeCall = c.suppression.findMany.mock.calls.find(
      (args) => args[0].where.entityType === "mentee",
    );
    expect(menteeCall).toBeDefined();
    expect(menteeCall![0].where).toMatchObject({
      entityType: "mentee",
      entityId: { in: ["self01:m1", "self01:m2"] },
      contributorCwid: null,
      revokedAt: null,
    });
  });

  it("returns an empty mentee list (never throws) when the reporting source is unavailable", async () => {
    const c = fakeClient();
    c.scholar.findUnique.mockResolvedValue(scholarRow());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = await loadEditContext(SELF, asClient(c), undefined, async () => {
      throw new Error("reporting DB unreachable");
    });
    expect(ctx).not.toBeNull();
    expect(ctx!.mentees).toEqual([]);
    // No mentee-suppression query runs when there are no mentees.
    const menteeCall = c.suppression.findMany.mock.calls.find(
      (args) => args[0].where.entityType === "mentee",
    );
    expect(menteeCall).toBeUndefined();
    warn.mockRestore();
  });

  it("returns an empty mentee list when the scholar has no mentees", async () => {
    const c = fakeClient();
    c.scholar.findUnique.mockResolvedValue(scholarRow());
    const ctx = await loadEditContext(SELF, asClient(c), undefined, async () => []);
    expect(ctx!.mentees).toEqual([]);
  });
});

describe("loadEditContext — COI-gap candidates (gate + dedup + date join)", () => {
  const GAP_ROWS = [
    {
      id: "gap-1a",
      pmid: "31508198",
      entity: "Procept BioRobotics",
      tier: "High",
      sourceSentence: "Clinical Research investigator for Procept Aquablation.",
      // Fields that must NEVER leak to the client shape (score/status/etc.):
      normalizedEntity: "procept biorobotics",
      attribution: "scholar",
      entityScore: 0.94,
      category: "personal",
      status: "new",
    },
    {
      // SAME normalized entity as gap-1a but a different (newer) paper — MUST
      // collapse into ONE relationship row that cites both, taking the highest
      // tier (High) and the newest source's raw entity as the display label.
      id: "gap-1b",
      pmid: "34963501",
      entity: "Procept Biorobotics Inc",
      tier: "High",
      sourceSentence: "Stock options in Procept Biorobotics.",
      normalizedEntity: "procept biorobotics",
      attribution: "scholar",
      entityScore: 0.8,
      category: "personal",
      status: "new",
    },
    {
      // A second distinct relationship. (All rows here are `High`: the loader now
      // queries `tier: "High"` only — `Medium` is never fetched, see the where
      // assertion below — so the fixture mirrors that High-only result set.)
      id: "gap-2",
      pmid: "30000001",
      entity: "Neotract",
      tier: "High",
      sourceSentence: "Consultant for Neotract Urolift.",
      normalizedEntity: "neotract",
      attribution: "scholar",
      entityScore: 0.9,
      category: "personal",
      status: "new",
    },
  ];
  const PUB_ROWS = [
    { pmid: "31508198", year: 2019, dateAddedToEntrez: new Date("2019-08-01T00:00:00Z") },
    { pmid: "34963501", year: 2022, dateAddedToEntrez: new Date("2022-01-10T00:00:00Z") },
    { pmid: "30000001", year: 2018, dateAddedToEntrez: new Date("2018-03-01T00:00:00Z") },
  ];

  it("does NOT query coi_gap_candidate and returns [] when opts is absent", async () => {
    const c = fakeClient();
    c.scholar.findUnique.mockResolvedValue(scholarRow());
    const ctx = await loadEditContext(SELF, asClient(c));
    expect(ctx!.unmatchedPubmedCoi).toEqual([]);
    expect(c.coiGapCandidate.findMany).not.toHaveBeenCalled();
  });

  it("does NOT query coi_gap_candidate and returns [] when includeCoiGap is false", async () => {
    const c = fakeClient();
    c.scholar.findUnique.mockResolvedValue(scholarRow());
    const ctx = await loadEditContext(SELF, asClient(c), undefined, async () => [], {
      includeCoiGap: false,
    });
    expect(ctx!.unmatchedPubmedCoi).toEqual([]);
    expect(c.coiGapCandidate.findMany).not.toHaveBeenCalled();
  });

  it("dedupes by entity, cites every source, joins the pub year, and orders newest+confidence", async () => {
    const c = fakeClient();
    c.scholar.findUnique.mockResolvedValue(scholarRow());
    c.coiGapCandidate.findMany.mockResolvedValue(GAP_ROWS);
    c.publication.findMany.mockResolvedValue(PUB_ROWS);
    const ctx = await loadEditContext(SELF, asClient(c), undefined, async () => [], {
      includeCoiGap: true,
    });

    // The query now widens to the three reviewable lifecycle states
    // (`resolved` excluded) and fetches ALL tiers — the active/lower/reviewed
    // partition happens in-loader, not in the `where`. (High-active drives the
    // nag; Medium-active drops to the lower expander; acted rows to Reviewed.)
    const whereArg = c.coiGapCandidate.findMany.mock.calls[0][0].where;
    expect(whereArg).toEqual({
      cwid: SELF,
      status: { in: ["new", "acknowledged", "dismissed"] },
    });
    // The date join is scoped to the gap pmids (deduped).
    const pubWhere = c.publication.findMany.mock.calls[0][0].where;
    expect(pubWhere.pmid.in.sort()).toEqual(["30000001", "31508198", "34963501"]);

    const groups = ctx!.unmatchedPubmedCoi;
    // Two distinct relationships (the two Procept rows collapsed into one).
    expect(groups).toHaveLength(2);

    // Default order = newest+confidence → the High "procept" group leads.
    const procept = groups[0];
    expect(procept.key).toBe("procept biorobotics");
    expect(procept.tier).toBe("High"); // highest tier across the two sources
    // Display label = the raw entity of the NEWEST source (2022 paper).
    expect(procept.entity).toBe("Procept Biorobotics Inc");
    // Both papers cited, newest first, each with its year.
    expect(procept.sources.map((s) => s.id)).toEqual(["gap-1b", "gap-1a"]);
    expect(procept.sources.map((s) => s.year)).toEqual([2022, 2019]);
    expect(procept.sources[0].sourceSentence).toBe("Stock options in Procept Biorobotics.");

    const neotract = groups[1];
    expect(neotract.key).toBe("neotract");
    expect(neotract.tier).toBe("High");
    expect(neotract.sources.map((s) => s.id)).toEqual(["gap-2"]);

    // Belt-and-braces: the forbidden internals never reach the client — not on a
    // group, not on a source. (The opaque `key` carries the normalized entity by
    // design; the score/status/attribution/category do not.)
    for (const g of groups) {
      for (const forbidden of ["attribution", "entityScore", "category", "status"]) {
        expect(g).not.toHaveProperty(forbidden);
      }
      for (const s of g.sources) {
        for (const forbidden of ["attribution", "entityScore", "category", "status", "tier"]) {
          expect(s).not.toHaveProperty(forbidden);
        }
      }
    }
  });

  it("narrows an unexpected tier value to the conservative Medium (→ lower bucket)", async () => {
    const c = fakeClient();
    c.scholar.findUnique.mockResolvedValue(scholarRow());
    c.coiGapCandidate.findMany.mockResolvedValue([
      { ...GAP_ROWS[2], tier: "Low" }, // anything not "High" → "Medium"
    ]);
    const ctx = await loadEditContext(SELF, asClient(c), undefined, async () => [], {
      includeCoiGap: true,
    });
    // A pure-Medium ACTIVE group never nags — it lands in the lower-confidence
    // expander, not the High active list.
    expect(ctx!.unmatchedPubmedCoi).toHaveLength(0);
    expect(ctx!.unmatchedPubmedCoiLower).toHaveLength(1);
    expect(ctx!.unmatchedPubmedCoiLower[0].tier).toBe("Medium");
  });

  it("falls back to a null year when the joined publication is missing", async () => {
    const c = fakeClient();
    c.scholar.findUnique.mockResolvedValue(scholarRow());
    c.coiGapCandidate.findMany.mockResolvedValue([GAP_ROWS[2]]);
    c.publication.findMany.mockResolvedValue([]); // no pub row for the pmid
    const ctx = await loadEditContext(SELF, asClient(c), undefined, async () => [], {
      includeCoiGap: true,
    });
    expect(ctx!.unmatchedPubmedCoi[0].sources[0].year).toBeNull();
    expect(ctx!.unmatchedPubmedCoi[0].newestTs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// COI-gap "surface hidden + reviewed" — the three-surface partition
// (active-High `unmatchedPubmedCoi` / active-Medium `unmatchedPubmedCoiLower` /
// fully-acted `unmatchedPubmedCoiReviewed`). The query widens to
// status ∈ {new, acknowledged, dismissed} (resolved excluded) and each
// normalized-entity group is partitioned in-loader by whether a `new` source
// still remains. GOVERNANCE: score/status/attribution/category never cross;
// feedbackReason + reviewedAt cross ONLY into Reviewed rows.
// ---------------------------------------------------------------------------

describe("loadEditContext — COI-gap surface hidden + reviewed (active / lower / reviewed)", () => {
  // A canonical persisted row. Every fixture carries the four forbidden internals
  // (normalizedEntity is the group key; attribution/entityScore/category/status
  // must never reach the client) so the governance assertions are meaningful.
  const row = (over: Record<string, unknown>) => ({
    id: "gap-x",
    pmid: "40000001",
    entity: "Acme Therapeutics",
    tier: "High",
    sourceSentence: "Consultant for Acme Therapeutics.",
    normalizedEntity: "acme therapeutics",
    attribution: "scholar",
    entityScore: 0.9,
    category: "personal",
    status: "new",
    feedbackReason: null,
    reviewedAt: null,
    ...over,
  });

  // One publication row per pmid the fixtures cite, so the date join resolves a
  // year + sort ts (mirrors the existing block's PUB_ROWS shape).
  const PUBS = [
    { pmid: "40000001", year: 2024, dateAddedToEntrez: new Date("2024-02-01T00:00:00Z") },
    { pmid: "40000002", year: 2023, dateAddedToEntrez: new Date("2023-02-01T00:00:00Z") },
    { pmid: "40000003", year: 2022, dateAddedToEntrez: new Date("2022-02-01T00:00:00Z") },
  ];

  function loadGap(gapRows: unknown[]) {
    const c = fakeClient();
    c.scholar.findUnique.mockResolvedValue(scholarRow());
    c.coiGapCandidate.findMany.mockResolvedValue(gapRows);
    c.publication.findMany.mockResolvedValue(PUBS);
    return loadEditContext(SELF, asClient(c), undefined, async () => [], { includeCoiGap: true });
  }

  it("(1) a pure-Medium ACTIVE relationship surfaces in the lower bucket, not the High active list", async () => {
    const ctx = await loadGap([
      row({ id: "g-med", normalizedEntity: "beta labs", entity: "Beta Labs", tier: "Medium" }),
    ]);
    expect(ctx!.unmatchedPubmedCoi).toHaveLength(0);
    expect(ctx!.unmatchedPubmedCoiLower).toHaveLength(1);
    expect(ctx!.unmatchedPubmedCoiLower[0]).toMatchObject({ key: "beta labs", tier: "Medium" });
    expect(ctx!.unmatchedPubmedCoiReviewed).toHaveLength(0);
  });

  it("(2) a mixed High+Medium NEW relationship appears once in the High active list (promoted), absent from lower", async () => {
    const ctx = await loadGap([
      // Same normalized entity, two new papers — one High, one Medium → collapses
      // to ONE active group whose tier is the highest (High).
      row({ id: "g-hi", pmid: "40000001", tier: "High" }),
      row({ id: "g-md", pmid: "40000002", tier: "Medium" }),
    ]);
    expect(ctx!.unmatchedPubmedCoi).toHaveLength(1);
    expect(ctx!.unmatchedPubmedCoi[0]).toMatchObject({ key: "acme therapeutics", tier: "High" });
    // Both new sources cited under the one promoted group.
    expect(ctx!.unmatchedPubmedCoi[0].sources.map((s) => s.id).sort()).toEqual(["g-hi", "g-md"]);
    expect(ctx!.unmatchedPubmedCoiLower).toHaveLength(0);
    expect(ctx!.unmatchedPubmedCoiReviewed).toHaveLength(0);
  });

  it("(3a) an acknowledged relationship surfaces in Reviewed with reason=will_disclose + a reviewedAt ISO date, absent from both active lists", async () => {
    const ctx = await loadGap([
      row({
        id: "g-ack",
        normalizedEntity: "globex pharma",
        entity: "Globex Pharma",
        status: "acknowledged",
        feedbackReason: "will_disclose",
        reviewedAt: new Date("2026-03-15T09:30:00Z"),
      }),
    ]);
    expect(ctx!.unmatchedPubmedCoi).toHaveLength(0);
    expect(ctx!.unmatchedPubmedCoiLower).toHaveLength(0);
    expect(ctx!.unmatchedPubmedCoiReviewed).toHaveLength(1);
    expect(ctx!.unmatchedPubmedCoiReviewed[0]).toMatchObject({
      key: "globex pharma",
      entity: "Globex Pharma",
      reason: "will_disclose",
      reviewedAt: "2026-03-15",
    });
  });

  it("(3b) infers will_disclose from an acknowledged status when feedbackReason is null (legacy row)", async () => {
    const ctx = await loadGap([
      row({
        id: "g-ack-legacy",
        normalizedEntity: "legacy co",
        entity: "Legacy Co",
        status: "acknowledged",
        feedbackReason: null, // legacy — intent recorded before the reason column
        reviewedAt: new Date("2026-04-01T00:00:00Z"),
      }),
    ]);
    expect(ctx!.unmatchedPubmedCoiReviewed[0]).toMatchObject({
      reason: "will_disclose",
      reviewedAt: "2026-04-01",
    });
  });

  it("(3c) a dismissed/historical and a dismissed/invalid relationship each surface in Reviewed with the recorded reason", async () => {
    const ctx = await loadGap([
      row({
        id: "g-hist",
        normalizedEntity: "hist org",
        entity: "Hist Org",
        status: "dismissed",
        feedbackReason: "historical",
        reviewedAt: new Date("2026-02-10T00:00:00Z"),
      }),
      row({
        id: "g-inv",
        normalizedEntity: "false pos",
        entity: "False Pos",
        status: "dismissed",
        feedbackReason: "invalid",
        reviewedAt: new Date("2026-02-20T00:00:00Z"),
      }),
    ]);
    expect(ctx!.unmatchedPubmedCoi).toHaveLength(0);
    expect(ctx!.unmatchedPubmedCoiLower).toHaveLength(0);
    const byKey = new Map(ctx!.unmatchedPubmedCoiReviewed.map((r) => [r.key, r]));
    expect(byKey.get("hist org")).toMatchObject({ reason: "historical", reviewedAt: "2026-02-10" });
    expect(byKey.get("false pos")).toMatchObject({ reason: "invalid", reviewedAt: "2026-02-20" });
  });

  it("(3d) Reviewed is ordered most-recently-reviewed first (reviewedAt desc)", async () => {
    const ctx = await loadGap([
      row({
        id: "g-old",
        normalizedEntity: "older co",
        entity: "Older Co",
        status: "dismissed",
        feedbackReason: "invalid",
        reviewedAt: new Date("2026-01-05T00:00:00Z"),
      }),
      row({
        id: "g-new",
        normalizedEntity: "newer co",
        entity: "Newer Co",
        status: "dismissed",
        feedbackReason: "historical",
        reviewedAt: new Date("2026-05-05T00:00:00Z"),
      }),
    ]);
    expect(ctx!.unmatchedPubmedCoiReviewed.map((r) => r.key)).toEqual(["newer co", "older co"]);
  });

  it("(4) a relationship with one 'new' source AND acted sources is ACTIVE only — never in Reviewed, and its acted source is not re-shown", async () => {
    const ctx = await loadGap([
      // Same normalized entity: one still-new High paper + one already-acted paper.
      row({ id: "g-still-new", pmid: "40000001", status: "new", tier: "High" }),
      row({
        id: "g-acted",
        pmid: "40000002",
        status: "dismissed",
        feedbackReason: "invalid",
        reviewedAt: new Date("2026-03-01T00:00:00Z"),
        tier: "High",
      }),
    ]);
    // ACTIVE only — appears once in the High list, never in Reviewed.
    expect(ctx!.unmatchedPubmedCoi).toHaveLength(1);
    expect(ctx!.unmatchedPubmedCoi[0].key).toBe("acme therapeutics");
    expect(ctx!.unmatchedPubmedCoiReviewed).toHaveLength(0);
    expect(ctx!.unmatchedPubmedCoiLower).toHaveLength(0);
    // The acted sibling is NOT re-shown — only the still-`new` source is cited.
    expect(ctx!.unmatchedPubmedCoi[0].sources.map((s) => s.id)).toEqual(["g-still-new"]);
  });

  it("(5) status='resolved' rows are excluded at the query — the gap closed itself, nothing to review", async () => {
    const c = fakeClient();
    c.scholar.findUnique.mockResolvedValue(scholarRow());
    // A real `resolved` row never reaches the loader: the where filters it out at
    // the DB. Mock the DB returning only the three reviewable statuses (as the
    // real query would), then assert the query's where excludes `resolved`.
    c.coiGapCandidate.findMany.mockResolvedValue([
      row({ id: "g-new", status: "new", tier: "High" }),
      row({
        id: "g-rev",
        pmid: "40000002",
        normalizedEntity: "rev co",
        entity: "Rev Co",
        status: "dismissed",
        feedbackReason: "invalid",
        reviewedAt: new Date("2026-03-01T00:00:00Z"),
      }),
    ]);
    c.publication.findMany.mockResolvedValue(PUBS);
    const ctx = await loadEditContext(SELF, asClient(c), undefined, async () => [], {
      includeCoiGap: true,
    });
    // The query asked the DB for exactly the three reviewable states; `resolved`
    // is never fetched (so a closed gap can't reappear in any surface).
    const whereArg = c.coiGapCandidate.findMany.mock.calls[0][0].where;
    expect(whereArg.status.in.sort()).toEqual(["acknowledged", "dismissed", "new"]);
    expect(whereArg.status.in).not.toContain("resolved");
    // Sanity: the fetched rows still partition correctly (active-High + reviewed).
    expect(ctx!.unmatchedPubmedCoi).toHaveLength(1);
    expect(ctx!.unmatchedPubmedCoiReviewed).toHaveLength(1);
  });

  it("(6) GOVERNANCE: no list exposes entityScore/status/attribution/category/normalizedEntity; reviewed exposes reason+reviewedAt only", async () => {
    const ctx = await loadGap([
      // One active-High, one active-Medium, one reviewed — every list populated.
      row({ id: "g-active-hi", normalizedEntity: "high co", entity: "High Co", tier: "High" }),
      row({
        id: "g-active-md",
        pmid: "40000002",
        normalizedEntity: "med co",
        entity: "Med Co",
        tier: "Medium",
      }),
      row({
        id: "g-reviewed",
        pmid: "40000003",
        normalizedEntity: "rev co",
        entity: "Rev Co",
        status: "dismissed",
        feedbackReason: "historical",
        reviewedAt: new Date("2026-03-01T00:00:00Z"),
      }),
    ]);
    const FORBIDDEN = ["entityScore", "status", "attribution", "category", "normalizedEntity"];
    const SOURCE_FORBIDDEN = [...FORBIDDEN, "tier", "feedbackReason", "reviewedAt"];

    // Active (High + lower) rows carry NONE of the forbidden internals, and no
    // reason/reviewedAt (those are Reviewed-only).
    for (const g of [...ctx!.unmatchedPubmedCoi, ...ctx!.unmatchedPubmedCoiLower]) {
      for (const f of [...FORBIDDEN, "reason", "reviewedAt", "feedbackReason"]) {
        expect(g).not.toHaveProperty(f);
      }
      // The only entity-derived field that crosses is the opaque `key`.
      expect(g.key).toBe(g.key.toLowerCase());
      for (const s of g.sources) {
        for (const f of SOURCE_FORBIDDEN) expect(s).not.toHaveProperty(f);
        // Source carries exactly the four rendered fields.
        expect(Object.keys(s).sort()).toEqual(["id", "pmid", "sourceSentence", "year"]);
      }
    }

    // Reviewed rows expose reason + reviewedAt (governance-allowed: the scholar's
    // own action), but still NONE of the four forbidden internals.
    const rev = ctx!.unmatchedPubmedCoiReviewed[0];
    expect(rev).toMatchObject({ reason: "historical", reviewedAt: "2026-03-01" });
    for (const f of FORBIDDEN) expect(rev).not.toHaveProperty(f);
    for (const s of rev.sources) {
      for (const f of SOURCE_FORBIDDEN) expect(s).not.toHaveProperty(f);
    }
  });
});

// ---------------------------------------------------------------------------
// #1112 — the FLAT mention projection (`unmatchedPubmedCoiMentions`): one paper ×
// one matched org, both `current` and `set_aside`, with the (pmid, subjectId)
// decision-unit grouping, low-confidence (Medium) marking, and governance
// starvation. Derives from the SAME `groups` the grouped arrays use.
// ---------------------------------------------------------------------------

describe("loadEditContext — COI-gap flat mention projection (#1112)", () => {
  const mrow = (over: Record<string, unknown>) => ({
    id: "m-x",
    pmid: "40000001",
    entity: "Acme Therapeutics",
    normalizedEntity: "acme therapeutics",
    tier: "High",
    sourceSentence: "Dr Self is a consultant for Acme Therapeutics and serves on its advisory board.",
    status: "new",
    feedbackReason: null,
    reviewedAt: null,
    subjectType: "self",
    subjectMention: "Dr Self",
    ...over,
  });

  const PUBS = [
    { pmid: "40000001", year: 2024, dateAddedToEntrez: new Date("2024-02-01T00:00:00Z") },
    { pmid: "40000002", year: 2023, dateAddedToEntrez: new Date("2023-02-01T00:00:00Z") },
  ];

  function loadM(gapRows: unknown[], statements: Array<{ pmid: string; statementText: string }> = []) {
    const c = fakeClient();
    c.scholar.findUnique.mockResolvedValue(scholarRow());
    c.coiGapCandidate.findMany.mockResolvedValue(gapRows);
    c.publication.findMany.mockResolvedValue(PUBS);
    c.publicationConflictStatement.findMany.mockResolvedValue(statements);
    return loadEditContext(SELF, asClient(c), undefined, async () => [], { includeCoiGap: true });
  }

  it("self mention → subjectId 'self', status 'current', confidence 'high'", async () => {
    const ctx = await loadM([mrow({})]);
    expect(ctx!.unmatchedPubmedCoiMentions).toHaveLength(1);
    const m = ctx!.unmatchedPubmedCoiMentions[0];
    expect(m).toMatchObject({
      candidateId: "m-x",
      pmid: "40000001",
      organization: "acme therapeutics",
      organizationRaw: "Acme Therapeutics",
      subjectType: "self",
      subjectId: "self",
      status: "current",
      confidence: "high",
    });
    // relationshipKinds re-derived from the clause (consulting + advisory board).
    expect(m.relationshipKinds).toEqual(expect.arrayContaining(["consulting", "advisory_board"]));
  });

  it("two orgs named by the SAME self subject in one paper share (pmid, subjectId='self')", async () => {
    const ctx = await loadM([
      mrow({ id: "m-a", normalizedEntity: "acme therapeutics", entity: "Acme Therapeutics" }),
      mrow({ id: "m-b", normalizedEntity: "globex", entity: "Globex" }),
    ]);
    const ms = ctx!.unmatchedPubmedCoiMentions;
    expect(ms).toHaveLength(2);
    // Both resolve to the same decision unit, so a single action clears both.
    expect(new Set(ms.map((m) => `${m.pmid}::${m.subjectId}`))).toEqual(new Set(["40000001::self"]));
  });

  it("a co-author mention is EXCLUDED from the projection (scholar's own relationships only)", async () => {
    const ctx = await loadM([
      mrow({
        id: "m-co",
        normalizedEntity: "astrazeneca",
        entity: "AstraZeneca",
        subjectType: "coauthor",
        subjectMention: "A Saxena",
      }),
    ]);
    // A co-author's disclosure that merely rode along in a shared paper is not the
    // scholar's to act on — it never crosses to the client.
    expect(ctx!.unmatchedPubmedCoiMentions).toHaveLength(0);
  });

  it("a co-author mention alongside a self mention: only the self crosses to the client", async () => {
    const ctx = await loadM([
      mrow({ id: "m-self", normalizedEntity: "acme", entity: "Acme", subjectType: "self", subjectMention: "Dr Self" }),
      mrow({
        id: "m-co",
        normalizedEntity: "globex",
        entity: "Globex",
        subjectType: "coauthor",
        subjectMention: "A Saxena",
      }),
    ]);
    const ms = ctx!.unmatchedPubmedCoiMentions;
    expect(ms).toHaveLength(1);
    expect(ms[0].candidateId).toBe("m-self");
  });

  it("two distinct UNKNOWN subjects in one paper get separate, stable subjectIds (never merged, never 'self')", async () => {
    const ctx = await loadM([
      mrow({ id: "m-u1", normalizedEntity: "org one", entity: "Org One", subjectType: null, subjectMention: null }),
      mrow({ id: "m-u2", normalizedEntity: "org two", entity: "Org Two", subjectType: null, subjectMention: null }),
    ]);
    const ms = ctx!.unmatchedPubmedCoiMentions;
    expect(ms.every((m) => m.subjectType === "unknown")).toBe(true);
    const ids = new Set(ms.map((m) => m.subjectId));
    expect(ids.size).toBe(2); // not merged
    for (const id of ids) expect(id).toMatch(/^unknown:#\d+$/); // never "self"
  });

  it("a NULL subject_type row (pre-#1112) degrades to 'unknown' with a null token — never guessed 'self'", async () => {
    const ctx = await loadM([mrow({ subjectType: null, subjectMention: "Stale Token" })]);
    const m = ctx!.unmatchedPubmedCoiMentions[0];
    expect(m.subjectType).toBe("unknown");
    expect(m.subjectMention).toBeNull();
  });

  it("Medium tier → confidence 'low' (excluded from the primary counter by the UI)", async () => {
    const ctx = await loadM([mrow({ tier: "Medium" })]);
    expect(ctx!.unmatchedPubmedCoiMentions[0].confidence).toBe("low");
  });

  it("an acted (dismissed) mention is 'set_aside' with reason + reviewedAt; a 'new' one is 'current' with null reason", async () => {
    const ctx = await loadM([
      mrow({ id: "m-new", normalizedEntity: "new co", entity: "New Co", status: "new" }),
      mrow({
        id: "m-set",
        pmid: "40000002",
        normalizedEntity: "set co",
        entity: "Set Co",
        status: "dismissed",
        feedbackReason: "invalid",
        reviewedAt: new Date("2026-03-01T00:00:00Z"),
      }),
    ]);
    const byId = new Map(ctx!.unmatchedPubmedCoiMentions.map((m) => [m.candidateId, m]));
    expect(byId.get("m-new")).toMatchObject({ status: "current", reason: null, reviewedAt: null });
    expect(byId.get("m-set")).toMatchObject({ status: "set_aside", reason: "invalid", reviewedAt: "2026-03-01" });
  });

  it("Paper view fullText = the verbatim statement when present, else the clause", async () => {
    const FULL = "Competing interests: Dr Self is a consultant for Acme Therapeutics. Dr Other reports grants from Globex.";
    const ctx = await loadM([mrow({})], [{ pmid: "40000001", statementText: FULL }]);
    expect(ctx!.unmatchedPubmedCoiMentions[0].fullText).toBe(FULL);
    // No statement row → fall back to the stored clause.
    const ctx2 = await loadM([mrow({ pmid: "40000002" })]);
    expect(ctx2!.unmatchedPubmedCoiMentions[0].fullText).toBe(ctx2!.unmatchedPubmedCoiMentions[0].clause);
  });

  it("GOVERNANCE: a mention never exposes entityScore/attribution/category/status-internals/normalizedEntity-as-score", async () => {
    const ctx = await loadM([mrow({})]);
    const m = ctx!.unmatchedPubmedCoiMentions[0];
    for (const f of ["entityScore", "attribution", "category", "tier"]) {
      expect(m).not.toHaveProperty(f);
    }
    // `confidence` is the only confidence signal, and it is qualitative.
    expect(["high", "low"]).toContain(m.confidence);
  });
});

// ---------------------------------------------------------------------------
// #836 — manual-Highlights editor context (opt-in gate)
// ---------------------------------------------------------------------------

describe("loadEditContext — highlights (#836)", () => {
  // A fixed "now" two years on so the test pubs (dated ~2 years back) sit in the
  // selected_highlights peak (18mo–10yr, weight 1.0) — ranking by impact alone.
  const NOW = new Date("2026-01-01T00:00:00Z");
  const TWO_YEARS_AGO = new Date("2024-01-01T00:00:00Z");

  /** A first-author, confirmed, Academic Article authorship with a given impact. */
  function authorship(pmid: string, impact: number, title = `T-${pmid}`) {
    return {
      isFirst: true,
      isLast: false,
      isPenultimate: false,
      isConfirmed: true,
      publication: {
        pmid,
        title,
        journal: "J",
        year: 2024,
        publicationType: "Academic Article",
        dateAddedToEntrez: TWO_YEARS_AGO,
        impactScore: impact, // Prisma Decimal stringifies; a number has .toString()
        publicationScores: [],
      },
    };
  }

  function highlightsClient(overrideValue: string | null, authorshipRows: unknown[]) {
    const c = fakeClient();
    c.scholar.findUnique.mockResolvedValue(scholarRow());
    // The override read (selectedHighlightPmids) + the overview/slug reads all go
    // through fieldOverride.findUnique; key on the requested fieldName.
    c.fieldOverride.findUnique.mockImplementation((args: {
      where: { entityType_entityId_fieldName: { fieldName: string } };
    }) => {
      const field = args.where.entityType_entityId_fieldName.fieldName;
      if (field === "selectedHighlightPmids") {
        return Promise.resolve(overrideValue === null ? null : { value: overrideValue });
      }
      return Promise.resolve(null);
    });
    c.publicationAuthor.findMany
      .mockResolvedValueOnce(authorshipRows) // authorships for the scholar
      .mockResolvedValueOnce(
        (authorshipRows as Array<{ publication: { pmid: string } }>).map((a) => ({
          pmid: a.publication.pmid,
          cwid: SELF,
        })),
      ); // confirmed displayed authors
    // scholar-level suppression [], then pub-level suppression [].
    c.suppression.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    return c;
  }

  it("is null when includeHighlights is not requested (the dark default)", async () => {
    const c = highlightsClient(null, [authorship("100", 9)]);
    const ctx = await loadEditContext(SELF, asClient(c), NOW);
    expect(ctx!.highlights).toBeNull();
  });

  it("computes the AI default (top-N by impact) and an empty manual set when no override", async () => {
    const rows = [authorship("100", 5), authorship("200", 9), authorship("300", 7), authorship("400", 1)];
    const c = highlightsClient(null, rows);
    const ctx = await loadEditContext(SELF, asClient(c), NOW, undefined, { includeHighlights: true });
    expect(ctx!.highlights).not.toBeNull();
    expect(ctx!.highlights!.manualEnabled).toBe(false);
    expect(ctx!.highlights!.manualPmids).toEqual([]);
    // top 3 by impact: 200 (9), 300 (7), 100 (5).
    expect(ctx!.highlights!.aiPmids).toEqual(["200", "300", "100"]);
    // pickable = all shown pubs.
    expect(ctx!.highlights!.pickable.map((p) => p.pmid).sort()).toEqual(["100", "200", "300", "400"]);
  });

  it("surfaces the stored manual override (opted in) alongside the AI default", async () => {
    const rows = [authorship("100", 5), authorship("200", 9), authorship("300", 7)];
    const c = highlightsClient('["300","100"]', rows);
    const ctx = await loadEditContext(SELF, asClient(c), NOW, undefined, { includeHighlights: true });
    expect(ctx!.highlights!.manualEnabled).toBe(true);
    expect(ctx!.highlights!.manualPmids).toEqual(["300", "100"]);
    expect(ctx!.highlights!.aiPmids).toEqual(["200", "300", "100"]);
  });

  it("excludes a suppressed pub from both the pickable pool and the AI default", async () => {
    const rows = [authorship("100", 5), authorship("200", 9), authorship("300", 7)];
    const c = fakeClient();
    c.scholar.findUnique.mockResolvedValue(scholarRow());
    c.fieldOverride.findUnique.mockResolvedValue(null);
    c.publicationAuthor.findMany
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce(rows.map((a) => ({ pmid: a.publication.pmid, cwid: SELF })));
    // pmid 200 (the top-impact pub) is hidden by the scholar → drops out.
    c.suppression.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "s1", entityId: "200", contributorCwid: SELF }]);
    const ctx = await loadEditContext(SELF, asClient(c), NOW, undefined, { includeHighlights: true });
    expect(ctx!.highlights!.pickable.map((p) => p.pmid).sort()).toEqual(["100", "300"]);
    // 200 is gone, so the AI default is 300 (7), 100 (5).
    expect(ctx!.highlights!.aiPmids).toEqual(["300", "100"]);
  });
});
