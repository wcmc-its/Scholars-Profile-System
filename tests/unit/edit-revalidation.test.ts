import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockScholarFindUnique, mockPublicationAuthorFindMany, mockRevalidatePath } = vi.hoisted(
  () => ({
    mockScholarFindUnique: vi.fn(),
    mockPublicationAuthorFindMany: vi.fn(),
    mockRevalidatePath: vi.fn(),
  }),
);

vi.mock("@/lib/db", () => ({
  db: {
    read: {
      scholar: { findUnique: mockScholarFindUnique },
      publicationAuthor: { findMany: mockPublicationAuthorFindMany },
    },
    write: {},
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));

import {
  reflectOverviewEdit,
  reflectVisibilityChange,
  resolveAffectedProfiles,
} from "@/lib/edit/revalidation";

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.SCHOLARS_CLOUDFRONT_DISTRIBUTION_ID;
});

describe("resolveAffectedProfiles", () => {
  it("resolves a scholar target to that scholar's slug + cwid", async () => {
    mockScholarFindUnique.mockResolvedValue({ slug: "jane-smith", cwid: "cwid1" });
    expect(await resolveAffectedProfiles("scholar", "cwid1", null)).toEqual([
      { slug: "jane-smith", cwid: "cwid1" },
    ]);
  });

  it("returns nothing for a scholar with no row", async () => {
    mockScholarFindUnique.mockResolvedValue(null);
    expect(await resolveAffectedProfiles("scholar", "cwid1", null)).toEqual([]);
  });

  it("resolves a per-author publication suppression to the contributor's slug + cwid", async () => {
    mockScholarFindUnique.mockResolvedValue({ slug: "bob-jones", cwid: "cwid2" });
    expect(await resolveAffectedProfiles("publication", "999", "cwid2")).toEqual([
      { slug: "bob-jones", cwid: "cwid2" },
    ]);
  });

  it("resolves a whole-publication takedown to every confirmed WCM author's slug + cwid", async () => {
    mockPublicationAuthorFindMany.mockResolvedValue([
      { cwid: "a", scholar: { slug: "a-one" } },
      { cwid: "b", scholar: { slug: "b-two" } },
      { cwid: "c", scholar: null },
    ]);
    expect(await resolveAffectedProfiles("publication", "999", null)).toEqual([
      { slug: "a-one", cwid: "a" },
      { slug: "b-two", cwid: "b" },
    ]);
  });
});

describe("reflectOverviewEdit", () => {
  it("revalidates only the profile page", () => {
    reflectOverviewEdit("jane-smith");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/scholars/jane-smith");
    expect(mockRevalidatePath).toHaveBeenCalledTimes(1);
  });
});

describe("reflectVisibilityChange", () => {
  it("revalidates /browse and each affected profile page", async () => {
    await reflectVisibilityChange(["jane-smith", "bob-jones"]);
    expect(mockRevalidatePath).toHaveBeenCalledWith("/browse");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/scholars/jane-smith");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/scholars/bob-jones");
  });

  it("skips a path that is not on the shared allow-list", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await reflectVisibilityChange(["bad slug"]);
    expect(mockRevalidatePath).not.toHaveBeenCalledWith("/scholars/bad slug");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/browse");
    warn.mockRestore();
  });
});
