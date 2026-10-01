/**
 * #2963 — the three public routes with a loading.tsx wrap their page in a
 * Suspense boundary, so a page-level `notFound()` fires after the fallback has
 * streamed with a 200 (a soft 404). Each now has a segment layout, which renders
 * OUTSIDE that boundary, that 404s a missing entity before anything streams.
 *
 * Synthetic slugs only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockNotFound } = vi.hoisted(() => ({
  mockNotFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("next/navigation", () => ({ notFound: mockNotFound }));

const { scholarFindFirst, getMentorMenteePair, getTopic, getFamily, methodPagesEnabled } =
  vi.hoisted(() => ({
    scholarFindFirst: vi.fn(),
    getMentorMenteePair: vi.fn(),
    getTopic: vi.fn(),
    getFamily: vi.fn(),
    methodPagesEnabled: vi.fn(() => true),
  }));
vi.mock("@/lib/db", () => ({ prisma: { scholar: { findFirst: scholarFindFirst } } }));
vi.mock("@/lib/api/mentoring", () => ({ getMentorMenteePair }));
vi.mock("@/lib/api/topics", () => ({ getTopic }));
vi.mock("@/lib/api/methods", () => ({ getFamily }));
vi.mock("@/lib/profile/methods-lens-flags", () => ({ isMethodPagesEnabled: methodPagesEnabled }));

import CoPubsLayout from "@/app/(public)/scholars/[slug]/co-pubs/layout";
import MenteeCoPubsLayout from "@/app/(public)/scholars/[slug]/co-pubs/[menteeCwid]/layout";
import TopicScholarsLayout from "@/app/(public)/topics/[slug]/scholars/layout";
import FamilyScholarsLayout from "@/app/(public)/methods/[supercategory]/[family]/scholars/layout";

const CHILD = "child";
const slugParams = { params: Promise.resolve({ slug: "zz-test" }), children: CHILD };
const pairParams = {
  params: Promise.resolve({ slug: "zz-test", menteeCwid: "zzz8888" }),
  children: CHILD,
};
const familyParams = {
  params: Promise.resolve({ supercategory: "zz-sc", family: "zz-fam" }),
  children: CHILD,
};

beforeEach(() => {
  mockNotFound.mockClear();
  scholarFindFirst.mockReset();
  getMentorMenteePair.mockReset();
  getTopic.mockReset();
  getFamily.mockReset();
  methodPagesEnabled.mockReturnValue(true);
});

describe("loading.tsx routes 404 from the layout, outside the Suspense boundary", () => {
  it("co-pubs: unknown mentor 404s; a public mentor renders children", async () => {
    scholarFindFirst.mockResolvedValue(null);
    await expect(CoPubsLayout(slugParams)).rejects.toThrow("NEXT_NOT_FOUND");

    scholarFindFirst.mockResolvedValue({
      cwid: "zzz9999",
      slug: "zz-test",
      preferredName: "Test Person",
      postnominal: null,
      roleCategory: "full_time_faculty",
    });
    await expect(CoPubsLayout(slugParams)).resolves.toBe(CHILD);
  });

  it("co-pubs: a hidden-role mentor 404s (the #536 carve still applies)", async () => {
    scholarFindFirst.mockResolvedValue({
      cwid: "zzz9999",
      slug: "zz-test",
      preferredName: "Test Person",
      postnominal: null,
      roleCategory: "doctoral_student_dds",
    });
    await expect(CoPubsLayout(slugParams)).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("co-pubs/[menteeCwid]: a real mentor with an unrecorded mentee 404s; a recorded pair renders children", async () => {
    scholarFindFirst.mockResolvedValue({
      cwid: "zzz9999",
      slug: "zz-test",
      preferredName: "Test Person",
      postnominal: null,
      roleCategory: "full_time_faculty",
    });
    getMentorMenteePair.mockResolvedValue(null);
    await expect(MenteeCoPubsLayout(pairParams)).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getMentorMenteePair).toHaveBeenCalledWith("zzz9999", "zzz8888");

    getMentorMenteePair.mockResolvedValue({
      mentorName: "Test Person",
      menteeName: "Test Mentee",
      manualOnly: false,
    });
    await expect(MenteeCoPubsLayout(pairParams)).resolves.toBe(CHILD);
  });

  it("co-pubs/[menteeCwid]: an unknown mentor 404s without a pair lookup", async () => {
    scholarFindFirst.mockResolvedValue(null);
    await expect(MenteeCoPubsLayout(pairParams)).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getMentorMenteePair).not.toHaveBeenCalled();
  });

  it("topic scholars: unknown topic 404s; a known topic renders children", async () => {
    getTopic.mockResolvedValue(null);
    await expect(TopicScholarsLayout(slugParams)).rejects.toThrow("NEXT_NOT_FOUND");

    getTopic.mockResolvedValue({ id: "zz-test", label: "Test" });
    await expect(TopicScholarsLayout(slugParams)).resolves.toBe(CHILD);
  });

  it("method scholars: unknown family or flag off 404s; a known family renders children", async () => {
    getFamily.mockResolvedValue(null);
    await expect(FamilyScholarsLayout(familyParams)).rejects.toThrow("NEXT_NOT_FOUND");

    getFamily.mockResolvedValue({ familyLabel: "Test" });
    await expect(FamilyScholarsLayout(familyParams)).resolves.toBe(CHILD);

    methodPagesEnabled.mockReturnValue(false);
    await expect(FamilyScholarsLayout(familyParams)).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
