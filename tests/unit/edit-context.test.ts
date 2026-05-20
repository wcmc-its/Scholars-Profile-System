/**
 * `lib/api/edit-context.ts` — the suppression-OFF read for the `/edit` self
 * surface (Phase 6 C1, D6.1).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

import { loadEditContext } from "@/lib/api/edit-context";

type AnyMock = ReturnType<typeof vi.fn>;
type FakeClient = {
  scholar: { findUnique: AnyMock };
  suppression: { findMany: AnyMock };
  publicationAuthor: { findMany: AnyMock };
  fieldOverride: { findUnique: AnyMock };
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
