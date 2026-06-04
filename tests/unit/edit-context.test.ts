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
  getMenteesForMentor: vi.fn(async () => []),
}));

import { loadEditContext } from "@/lib/api/edit-context";
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
