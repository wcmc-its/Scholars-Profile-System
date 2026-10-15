/**
 * app/(public)/scholars/by-cwid/[cwid]/page.tsx — the target of every legacy
 * VIVO `/display/cwid-{cwid}` redirect (#1940 dropped the proxy's set gate, so
 * this page alone decides whether a legacy CWID lands on a profile or a 404).
 *
 * The contract: a resolvable CWID gets ONE permanent redirect to the canonical
 * profile path; anything else is a real `notFound()` (a 404 status, never a
 * soft 404 or a redirect back into the legacy layer). CWIDs are synthetic.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockNotFound, mockPermanentRedirect, mockResolve } = vi.hoisted(() => ({
  mockNotFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  mockPermanentRedirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  mockResolve: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: mockNotFound,
  permanentRedirect: mockPermanentRedirect,
}));
vi.mock("@/lib/url-resolver", () => ({ resolveByCwidOrAlias: mockResolve }));

import ByCwidPage from "@/app/(public)/scholars/by-cwid/[cwid]/page";
import { canonicalProfilePath } from "@/lib/profile-url";

function call(cwid: string) {
  return ByCwidPage({ params: Promise.resolve({ cwid }) });
}

beforeEach(() => {
  mockNotFound.mockClear();
  mockPermanentRedirect.mockClear();
  mockResolve.mockReset();
});

describe("/scholars/by-cwid/[cwid]", () => {
  it("permanently redirects a resolvable CWID to the canonical profile path", async () => {
    mockResolve.mockResolvedValue({ type: "redirect", targetSlug: "jane-doe" });
    await expect(call("zzz9001")).rejects.toThrow(
      `NEXT_REDIRECT:${canonicalProfilePath("jane-doe")}`,
    );
    expect(mockResolve).toHaveBeenCalledWith("zzz9001");
    expect(mockNotFound).not.toHaveBeenCalled();
    // The target never points back into the legacy or by-cwid layer (no loop).
    const target = mockPermanentRedirect.mock.calls[0]![0];
    expect(target).not.toMatch(/by-cwid|\/display\//);
  });

  it("404s an unknown CWID without redirecting", async () => {
    mockResolve.mockResolvedValue({ type: "not-found" });
    await expect(call("zzz9999notincorpus")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockPermanentRedirect).not.toHaveBeenCalled();
  });
});
