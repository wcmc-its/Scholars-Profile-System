import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration coverage for the profile-loader email gate (table A of
 * docs/email-visibility-spec.md). Verifies that `getScholarFullProfileBySlug`
 * threads the `internalViewer` argument and reads `PROFILE_EMAIL_RELEASE_GATE`
 * through `isEmailReleaseGateEnabled()` (which reads `process.env` directly, so
 * the env var drives the flag here — no module mock needed).
 *
 * The same mocking shape as profile-suppression.test.ts: `@/lib/db` is mocked so
 * the loader runs against an in-memory scholar row carrying `emailVisibility`.
 */
const {
  mockScholarFindFirst,
  mockFieldOverrideFindUnique,
  mockPublicationAuthorFindMany,
  mockSuppressionFindMany,
  mockPersonNihProfileFindFirst,
} = vi.hoisted(() => ({
  mockScholarFindFirst: vi.fn(),
  mockFieldOverrideFindUnique: vi.fn(),
  mockPublicationAuthorFindMany: vi.fn(),
  mockSuppressionFindMany: vi.fn(),
  mockPersonNihProfileFindFirst: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    scholar: { findFirst: mockScholarFindFirst, findUnique: vi.fn() },
    fieldOverride: { findUnique: mockFieldOverrideFindUnique },
    publicationAuthor: { findMany: mockPublicationAuthorFindMany },
    suppression: { findMany: mockSuppressionFindMany },
    personNihProfile: { findFirst: mockPersonNihProfileFindFirst },
    $queryRawUnsafe: vi.fn(async () => []),
  },
}));

import { getScholarFullProfileBySlug } from "@/lib/api/profile";

const EMAIL = "person@med.cornell.edu";

function scholarRow(emailVisibility: string | null) {
  return {
    cwid: "p001",
    slug: "person-one",
    preferredName: "Person One",
    fullName: "Person Q. One",
    postnominal: null,
    primaryTitle: "Professor",
    primaryDepartment: "Medicine",
    email: EMAIL,
    emailVisibility,
    headshotUrl: null,
    overview: null,
    orcid: null,
    hasClinicalProfile: false,
    clinicalProfileUrl: null,
    deletedAt: null,
    status: "active",
    appointments: [],
    educations: [],
    grants: [],
    coiActivities: [],
    division: null,
    department: null,
    postdoctoralMentor: null,
  };
}

const ORIGINAL_FLAG = process.env.PROFILE_EMAIL_RELEASE_GATE;

beforeEach(() => {
  mockScholarFindFirst.mockReset();
  mockFieldOverrideFindUnique.mockReset().mockResolvedValue(null);
  mockPublicationAuthorFindMany.mockReset().mockResolvedValue([]);
  mockSuppressionFindMany.mockReset().mockResolvedValue([]);
  mockPersonNihProfileFindFirst.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.PROFILE_EMAIL_RELEASE_GATE;
  else process.env.PROFILE_EMAIL_RELEASE_GATE = ORIGINAL_FLAG;
});

describe("getScholarFullProfileBySlug — email gate (table A)", () => {
  describe("PROFILE_EMAIL_RELEASE_GATE off (row 13 — legacy)", () => {
    beforeEach(() => {
      delete process.env.PROFILE_EMAIL_RELEASE_GATE;
    });

    it("shows the email to an external viewer regardless of release code", async () => {
      mockScholarFindFirst.mockResolvedValue(scholarRow("institution"));
      const payload = await getScholarFullProfileBySlug("person-one", new Date(), false);
      expect(payload?.email).toBe(EMAIL);
    });

    it("shows the email even when visibility is null/none", async () => {
      mockScholarFindFirst.mockResolvedValue(scholarRow(null));
      const payload = await getScholarFullProfileBySlug("person-one", new Date(), false);
      expect(payload?.email).toBe(EMAIL);
    });
  });

  describe("PROFILE_EMAIL_RELEASE_GATE on (table A applies)", () => {
    beforeEach(() => {
      process.env.PROFILE_EMAIL_RELEASE_GATE = "on";
    });

    it("row 1/6: public → shown to an external viewer", async () => {
      mockScholarFindFirst.mockResolvedValue(scholarRow("public"));
      const payload = await getScholarFullProfileBySlug("person-one", new Date(), false);
      expect(payload?.email).toBe(EMAIL);
    });

    it("row 2: institution → hidden (null) from an external viewer", async () => {
      mockScholarFindFirst.mockResolvedValue(scholarRow("institution"));
      const payload = await getScholarFullProfileBySlug("person-one", new Date(), false);
      expect(payload?.email).toBeNull();
    });

    it("row 3/4: institution → shown to an internal viewer", async () => {
      mockScholarFindFirst.mockResolvedValue(scholarRow("institution"));
      const payload = await getScholarFullProfileBySlug("person-one", new Date(), true);
      expect(payload?.email).toBe(EMAIL);
    });

    it("row 5: null visibility → hidden even from an internal viewer (fail-closed)", async () => {
      mockScholarFindFirst.mockResolvedValue(scholarRow(null));
      const payload = await getScholarFullProfileBySlug("person-one", new Date(), true);
      expect(payload?.email).toBeNull();
    });

    it("row 7: unrecognized value → hidden even from an internal viewer (fail-closed)", async () => {
      mockScholarFindFirst.mockResolvedValue(scholarRow("private"));
      const payload = await getScholarFullProfileBySlug("person-one", new Date(), true);
      expect(payload?.email).toBeNull();
    });

    it("defaults to external (fail-closed) when no viewer signal is supplied", async () => {
      mockScholarFindFirst.mockResolvedValue(scholarRow("institution"));
      // No third arg → internalViewer defaults to false → institution hidden.
      const payload = await getScholarFullProfileBySlug("person-one");
      expect(payload?.email).toBeNull();
    });
  });
});
