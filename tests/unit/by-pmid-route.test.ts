/**
 * app/(public)/scholars/by-pmid/[pmid]/page.tsx — target of every legacy VIVO
 * `/display/pubid<PMID>` redirect. A publication with a live WCM author goes to
 * that author's profile (permanent); one without goes to PubMed (temporary);
 * a malformed id 404s. Slugs and PMIDs are synthetic.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockNotFound, mockPermanentRedirect, mockRedirect, mockResolve } = vi.hoisted(() => ({
  mockNotFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  mockPermanentRedirect: vi.fn((url: string) => {
    throw new Error(`NEXT_PERMANENT:${url}`);
  }),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  mockResolve: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: mockNotFound,
  permanentRedirect: mockPermanentRedirect,
  redirect: mockRedirect,
}));
vi.mock("@/lib/url-resolver", () => ({ resolvePubAuthorSlug: mockResolve }));

import ByPmidPage from "@/app/(public)/scholars/by-pmid/[pmid]/page";
import { canonicalProfilePath } from "@/lib/profile-url";

const call = (pmid: string) => ByPmidPage({ params: Promise.resolve({ pmid }) });

beforeEach(() => {
  mockNotFound.mockClear();
  mockPermanentRedirect.mockClear();
  mockRedirect.mockClear();
  mockResolve.mockReset();
});

describe("/scholars/by-pmid/[pmid]", () => {
  it("permanently redirects to the owning author's profile", async () => {
    mockResolve.mockResolvedValue("test-person-1");
    await expect(call("12345")).rejects.toThrow(
      `NEXT_PERMANENT:${canonicalProfilePath("test-person-1")}`,
    );
    expect(mockResolve).toHaveBeenCalledWith("12345");
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("sends a publication with no WCM author to PubMed, temporarily", async () => {
    mockResolve.mockResolvedValue(null);
    await expect(call("12345")).rejects.toThrow("NEXT_REDIRECT:https://pubmed.ncbi.nlm.nih.gov/12345/");
    expect(mockPermanentRedirect).not.toHaveBeenCalled();
  });

  it.each(["abc", "123abc", "1234567890", ""])("404s a malformed id %j without a lookup", async (pmid) => {
    await expect(call(pmid)).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockResolve).not.toHaveBeenCalled();
  });
});
