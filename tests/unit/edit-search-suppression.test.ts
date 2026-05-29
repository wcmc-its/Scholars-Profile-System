import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 4b C5 — `reflectSearchSuppression` (the OpenSearch suppression
 * fast-path) unit tests. Mocks `@/lib/db` (Prisma reader) and `@/lib/search`
 * (the OpenSearch client) at the module boundary; asserts the `bulk` body
 * per the asymmetric D4b.1 fan-out:
 *
 *   - scholar suppress (findFirst → null per PEOPLE_INDEX_WHERE) →
 *       single delete on PEOPLE_INDEX.
 *   - publication per-author hide → re-index pub doc + re-index the
 *       contributor's people doc (bulk body has BOTH ops).
 *   - publication takedown going derived-dark → DELETE pub doc + re-index
 *       every confirmed WCM co-author's people doc.
 *   - bulk throws → `edit_search_reflect_failed` logged, no throw.
 */

const hoisted = vi.hoisted(() => ({
  mockScholarFindFirst: vi.fn(),
  mockCenterMembershipFindMany: vi.fn(),
  mockDivisionMembershipFindMany: vi.fn(),
  mockPublicationFindFirst: vi.fn(),
  mockPublicationAuthorFindMany: vi.fn(),
  mockSuppressionFindMany: vi.fn(),
  mockSuppressionUpdate: vi.fn(),
  mockDepartmentFindMany: vi.fn(),
  mockDivisionFindMany: vi.fn(),
  mockBulk: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    read: {
      scholar: { findFirst: hoisted.mockScholarFindFirst },
      centerMembership: { findMany: hoisted.mockCenterMembershipFindMany },
      // #540 Phase 8 — `buildPeopleDoc` issues a `divisionMembership` sidecar
      // for the manual-roster division facet keys. This suite doesn't seed
      // manual rosters; the default empty result is the LDAP-only baseline.
      divisionMembership: { findMany: hoisted.mockDivisionMembershipFindMany },
      publication: { findFirst: hoisted.mockPublicationFindFirst },
      publicationAuthor: { findMany: hoisted.mockPublicationAuthorFindMany },
      suppression: { findMany: hoisted.mockSuppressionFindMany },
      // Issue #532 — leadership sidecar queries; this suite doesn't exercise
      // leadership content, so both default to empty.
      department: { findMany: hoisted.mockDepartmentFindMany },
      division: { findMany: hoisted.mockDivisionFindMany },
    },
    // #393 — the reconciler sentinel stamp on a successful reflect.
    write: { suppression: { update: hoisted.mockSuppressionUpdate } },
  },
}));

vi.mock("@/lib/search", () => ({
  PEOPLE_INDEX: "scholars-people",
  PUBLICATIONS_INDEX: "scholars-publications",
  searchClient: () => ({ bulk: hoisted.mockBulk }),
}));

import { reflectSearchSuppression } from "@/lib/edit/search-suppression";

const OK_BULK_RESPONSE = { body: { errors: false, items: [] } };

function activeScholarRow(cwid: string) {
  return {
    cwid,
    slug: cwid,
    preferredName: cwid,
    fullName: cwid,
    postnominal: null,
    primaryTitle: null,
    primaryDepartment: null,
    overview: null,
    roleCategory: "faculty",
    deptCode: null,
    divCode: null,
    department: null,
    division: null,
    topicAssignments: [],
    grants: [],
    authorships: [],
  };
}

function publicationRow(
  pmid: string,
  authors: ReadonlyArray<{ cwid: string; isFirst?: boolean }>,
) {
  return {
    pmid,
    title: `Title ${pmid}`,
    journal: "J",
    year: 2024,
    publicationType: "Journal Article",
    citationCount: 0,
    dateAddedToEntrez: null,
    doi: null,
    pmcid: null,
    pubmedUrl: null,
    abstract: null,
    impactScore: null,
    impactJustification: null,
    meshTerms: [],
    authors: authors.map((a, i) => ({
      pmid,
      cwid: a.cwid,
      externalName: null,
      isConfirmed: true,
      isFirst: a.isFirst ?? false,
      isLast: false,
      isPenultimate: false,
      position: i + 1,
      totalAuthors: authors.length,
      scholar: {
        cwid: a.cwid,
        slug: a.cwid,
        preferredName: a.cwid,
        deletedAt: null,
        status: "active",
      },
    })),
    publicationTopics: [],
  };
}

beforeEach(() => {
  for (const m of Object.values(hoisted)) m.mockReset();
  // Default: bulk succeeds with no errors.
  hoisted.mockBulk.mockResolvedValue(OK_BULK_RESPONSE);
  // Default: the sentinel stamp succeeds.
  hoisted.mockSuppressionUpdate.mockResolvedValue({});
  // Default: no suppression rows, no publication-author rows, no center memberships.
  hoisted.mockSuppressionFindMany.mockResolvedValue([]);
  hoisted.mockPublicationAuthorFindMany.mockResolvedValue([]);
  hoisted.mockCenterMembershipFindMany.mockResolvedValue([]);
  hoisted.mockDivisionMembershipFindMany.mockResolvedValue([]);
  hoisted.mockDepartmentFindMany.mockResolvedValue([]);
  hoisted.mockDivisionFindMany.mockResolvedValue([]);
});

describe("reflectSearchSuppression — scholar suppress", () => {
  it("emits a single people-doc delete (scholar fails PEOPLE_INDEX_WHERE)", async () => {
    // Suppressed scholar (status !== 'active') → findFirst returns null.
    hoisted.mockScholarFindFirst.mockResolvedValue(null);

    const result = await reflectSearchSuppression({
      suppressionId: "sup-scholar",
      entityType: "scholar",
      entityId: "ann1234",
      contributorCwid: null,
      affectedCwids: ["ann1234"],
    });

    expect(result).toEqual({ ok: true });
    expect(hoisted.mockBulk).toHaveBeenCalledTimes(1);
    expect(hoisted.mockBulk).toHaveBeenCalledWith({
      refresh: true,
      body: [{ delete: { _index: "scholars-people", _id: "ann1234" } }],
    });
    // #393 — full success stamps the reconciler sentinel on the row.
    expect(hoisted.mockSuppressionUpdate).toHaveBeenCalledTimes(1);
    const stamp = hoisted.mockSuppressionUpdate.mock.calls[0][0];
    expect(stamp.where).toEqual({ id: "sup-scholar" });
    expect(stamp.data.searchReflectedAt).toBeInstanceOf(Date);
  });
});

describe("reflectSearchSuppression — publication per-author hide", () => {
  it("re-indexes the pub doc PLUS re-indexes the contributor's people doc", async () => {
    // The pub stays displayed (co-author 'bob' remains).
    hoisted.mockPublicationFindFirst.mockResolvedValue(
      publicationRow("12345", [
        { cwid: "ann", isFirst: true },
        { cwid: "bob" },
      ]),
    );
    // loadPublicationSuppressions returns the per-author hide row.
    hoisted.mockSuppressionFindMany.mockResolvedValueOnce([
      { entityId: "12345", contributorCwid: "ann" },
    ]);
    // The contributor's people doc is re-indexed via buildScholarOps.
    hoisted.mockScholarFindFirst.mockResolvedValue(activeScholarRow("ann"));

    await reflectSearchSuppression({
      suppressionId: "sup-perauthor",
      entityType: "publication",
      entityId: "12345",
      contributorCwid: "ann",
      affectedCwids: ["ann"],
    });

    expect(hoisted.mockBulk).toHaveBeenCalledTimes(1);
    const body = hoisted.mockBulk.mock.calls[0][0].body as Array<
      Record<string, unknown>
    >;
    // Body: [pub index action, pub doc, scholar index action, scholar doc].
    expect(body[0]).toEqual({
      index: { _index: "scholars-publications", _id: "12345" },
    });
    expect((body[1] as { wcmAuthorCwids: string[] }).wcmAuthorCwids).toEqual(["bob"]);
    expect(body[2]).toEqual({
      index: { _index: "scholars-people", _id: "ann" },
    });
    expect((body[3] as { cwid: string }).cwid).toBe("ann");
  });
});

describe("reflectSearchSuppression — publication whole-pub takedown", () => {
  it("DELETES the pub doc and re-indexes every confirmed WCM co-author's people doc", async () => {
    // Affected cwid set comes from the caller (plan §3 tightening C7) — the
    // endpoint passes it from the same resolveAffectedProfiles query used by
    // the ISR/CloudFront reflection.
    hoisted.mockPublicationFindFirst.mockResolvedValue(
      publicationRow("12345", [
        { cwid: "ann", isFirst: true },
        { cwid: "bob" },
      ]),
    );
    // loadPublicationSuppressions for the pub returns the explicit takedown.
    hoisted.mockSuppressionFindMany.mockResolvedValueOnce([
      { entityId: "12345", contributorCwid: null },
    ]);
    // Each co-author's people doc re-index reads the scholar row.
    hoisted.mockScholarFindFirst
      .mockResolvedValueOnce(activeScholarRow("ann"))
      .mockResolvedValueOnce(activeScholarRow("bob"));

    await reflectSearchSuppression({
      suppressionId: "sup-takedown",
      entityType: "publication",
      entityId: "12345",
      contributorCwid: null,
      affectedCwids: ["ann", "bob"],
    });

    expect(hoisted.mockBulk).toHaveBeenCalledTimes(1);
    const body = hoisted.mockBulk.mock.calls[0][0].body as Array<
      Record<string, unknown>
    >;
    // First op: delete the pub doc (the pub is dark).
    expect(body[0]).toEqual({
      delete: { _index: "scholars-publications", _id: "12345" },
    });
    // Followed by two people-doc index ops, one per affected co-author.
    const peopleActions = body.filter(
      (b) => "index" in b && (b.index as { _index: string })._index === "scholars-people",
    );
    expect(peopleActions).toHaveLength(2);
    const peopleIds = peopleActions.map(
      (b) => (b.index as { _id: string })._id,
    );
    expect(peopleIds).toEqual(expect.arrayContaining(["ann", "bob"]));
  });
});

describe("reflectSearchSuppression — failure handling (D4b.4 best-effort)", () => {
  it("logs edit_search_reflect_failed and does NOT throw when bulk rejects", async () => {
    hoisted.mockScholarFindFirst.mockResolvedValue(null);
    hoisted.mockBulk.mockRejectedValue(new Error("OpenSearch unreachable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await reflectSearchSuppression({
      suppressionId: "sup-throw",
      entityType: "scholar",
      entityId: "ann1234",
      contributorCwid: null,
      affectedCwids: ["ann1234"],
    });

    // Returns a failure result rather than throwing (best-effort contract).
    expect(result.ok).toBe(false);
    // A failed reflect must NOT stamp — the row stays NULL for the reconciler.
    expect(hoisted.mockSuppressionUpdate).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(consoleError.mock.calls[0][0] as string);
    expect(logged.event).toBe("edit_search_reflect_failed");
    expect(logged.suppressionId).toBe("sup-throw");
    expect(logged.entityType).toBe("scholar");
    expect(logged.entityId).toBe("ann1234");
    expect(logged.contributorCwid).toBeNull();
    expect(typeof logged.error).toBe("string");

    consoleError.mockRestore();
  });

  it("logs per-item bulk errors (non-404) without throwing", async () => {
    hoisted.mockScholarFindFirst.mockResolvedValue(null);
    hoisted.mockBulk.mockResolvedValue({
      body: {
        errors: true,
        items: [
          { delete: { error: { type: "version_conflict" }, status: 409 } },
        ],
      },
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await reflectSearchSuppression({
      suppressionId: "sup-409",
      entityType: "scholar",
      entityId: "ann1234",
      contributorCwid: null,
      affectedCwids: ["ann1234"],
    });

    expect(consoleError).toHaveBeenCalled();
    expect(result.ok).toBe(false);
    // A per-item error is a failure — no sentinel stamp.
    expect(hoisted.mockSuppressionUpdate).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("does NOT log when bulk returns only 404-on-delete (idempotent missing doc)", async () => {
    hoisted.mockScholarFindFirst.mockResolvedValue(null);
    hoisted.mockBulk.mockResolvedValue({
      body: {
        errors: true,
        items: [
          { delete: { error: { type: "not_found" }, status: 404 } },
        ],
      },
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await reflectSearchSuppression({
      suppressionId: "sup-404",
      entityType: "scholar",
      entityId: "ann1234",
      contributorCwid: null,
      affectedCwids: ["ann1234"],
    });

    expect(consoleError).not.toHaveBeenCalled();
    // 404-on-delete is treated as success (idempotent missing doc) — stamped.
    expect(result).toEqual({ ok: true });
    expect(hoisted.mockSuppressionUpdate).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});

describe("reflectSearchSuppression — unknown entity type", () => {
  it("is a no-op (no bulk call) — out-of-v1-scope types (grant, education, appointment)", async () => {
    const result = await reflectSearchSuppression({
      suppressionId: "sup-grant",
      entityType: "grant",
      entityId: "g1",
      contributorCwid: null,
      affectedCwids: [],
    });
    expect(hoisted.mockBulk).not.toHaveBeenCalled();
    // No ops → ok, but no stamp (the reconciler excludes these by entity type).
    expect(result).toEqual({ ok: true });
    expect(hoisted.mockSuppressionUpdate).not.toHaveBeenCalled();
  });
});
