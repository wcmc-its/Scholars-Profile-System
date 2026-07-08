import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration coverage for the profile-loader email baking (table A +
 * Cache-safety of docs/email-visibility-spec.md). The profile page is CloudFront
 * PATH-cached, so `getScholarFullProfileBySlug` must produce a VIEWER-INDEPENDENT
 * payload: when PROFILE_EMAIL_RELEASE_GATE is on it bakes ONLY `public` emails and
 * withholds `institution`/`none`/null, flagging the latter `contactEmailRevealable`
 * so the Contact card reveals them to internal viewers out-of-band (covered by
 * contact-email-route.test.ts). Flag off → legacy passthrough.
 *
 * `isEmailReleaseGateEnabled()` reads `process.env` directly, so the env var
 * drives the flag here. `@/lib/db` is mocked (as in profile-suppression.test.ts)
 * so the loader runs against an in-memory scholar row carrying `emailVisibility`.
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
    fieldOverride: { findUnique: mockFieldOverrideFindUnique, findMany: vi.fn(async () => []) },
    publicationAuthor: { findMany: mockPublicationAuthorFindMany },
    suppression: { findMany: mockSuppressionFindMany },
    personNihProfile: { findFirst: mockPersonNihProfileFindFirst },
    // #1266 — leadership reader lookups; default empty (no leadership roles).
    department: { findMany: vi.fn(async () => []) },
    division: { findMany: vi.fn(async () => []) },
    center: { findMany: vi.fn(async () => []) },
    centerProgramLeader: { findMany: vi.fn(async () => []) },
    $queryRawUnsafe: vi.fn(async () => []),
  },
}));

import { getScholarFullProfileBySlug } from "@/lib/api/profile";

const EMAIL = "person@med.cornell.edu";

function scholarRow(emailVisibility: string | null, email: string | null = EMAIL) {
  return {
    cwid: "p001",
    slug: "person-one",
    preferredName: "Person One",
    fullName: "Person Q. One",
    postnominal: null,
    primaryTitle: "Professor",
    primaryDepartment: "Medicine",
    email,
    emailVisibility,
    headshotUrl: null,
    overview: null,
    orcid: null,
    hasClinicalProfile: false,
    clinicalProfileUrl: null,
    deletedAt: null,
    status: "active",
    appointments: [],
    profileAppointments: [],
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

describe("getScholarFullProfileBySlug — cache-safe email baking + reveal flag", () => {
  describe("PROFILE_EMAIL_RELEASE_GATE off (legacy — row 13)", () => {
    beforeEach(() => {
      delete process.env.PROFILE_EMAIL_RELEASE_GATE;
    });

    it("bakes the email for everyone regardless of release code; not revealable", async () => {
      mockScholarFindFirst.mockResolvedValue(scholarRow("institution"));
      const p = await getScholarFullProfileBySlug("person-one");
      expect(p?.email).toBe(EMAIL);
      expect(p?.contactEmailRevealable).toBe(false);
    });

    it("bakes the email even when visibility is null", async () => {
      mockScholarFindFirst.mockResolvedValue(scholarRow(null));
      const p = await getScholarFullProfileBySlug("person-one");
      expect(p?.email).toBe(EMAIL);
      expect(p?.contactEmailRevealable).toBe(false);
    });
  });

  describe("PROFILE_EMAIL_RELEASE_GATE on — payload is viewer-independent (public-only)", () => {
    beforeEach(() => {
      process.env.PROFILE_EMAIL_RELEASE_GATE = "on";
    });

    it("public → baked into the cache-safe payload; not revealable", async () => {
      mockScholarFindFirst.mockResolvedValue(scholarRow("public"));
      const p = await getScholarFullProfileBySlug("person-one");
      expect(p?.email).toBe(EMAIL);
      expect(p?.contactEmailRevealable).toBe(false);
    });

    it("institution → withheld from the cached payload, flagged revealable", async () => {
      mockScholarFindFirst.mockResolvedValue(scholarRow("institution"));
      const p = await getScholarFullProfileBySlug("person-one");
      expect(p?.email).toBeNull();
      expect(p?.contactEmailRevealable).toBe(true);
    });

    it("none/null → withheld; still flagged revealable so external & none are indistinguishable", async () => {
      mockScholarFindFirst.mockResolvedValue(scholarRow(null));
      const p = await getScholarFullProfileBySlug("person-one");
      expect(p?.email).toBeNull();
      expect(p?.contactEmailRevealable).toBe(true);
    });

    it("unrecognized value ('private') → withheld (fail-closed), flagged revealable", async () => {
      mockScholarFindFirst.mockResolvedValue(scholarRow("private"));
      const p = await getScholarFullProfileBySlug("person-one");
      expect(p?.email).toBeNull();
      expect(p?.contactEmailRevealable).toBe(true);
    });

    it("no email on file → nothing to bake or reveal", async () => {
      mockScholarFindFirst.mockResolvedValue(scholarRow("institution", null));
      const p = await getScholarFullProfileBySlug("person-one");
      expect(p?.email).toBeNull();
      expect(p?.contactEmailRevealable).toBe(false);
    });
  });
});
