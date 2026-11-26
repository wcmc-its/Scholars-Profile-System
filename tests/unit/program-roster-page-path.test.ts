/** The roster lives under the cancer center: other centers 404, the old address redirects. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ identity: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  permanentRedirect: (to: string) => {
    throw new Error(`PERMANENT ${to}`);
  },
}));
vi.mock("@/lib/edit/request", () => ({ resolveEditIdentity: h.identity }));
vi.mock("@/lib/db", () => ({ db: { read: {} } }));

import OldPage from "@/app/edit/program-roster/page";
import Page from "@/app/edit/center/[code]/program-roster/page";

const at = (code: string) => Page({ params: Promise.resolve({ code }) });

describe("program roster path", () => {
  beforeEach(() => h.identity.mockReset());

  it("another center's path is a 404 before anyone is looked up", async () => {
    await expect(at("other_center")).rejects.toThrow("NOT_FOUND");
    expect(h.identity).not.toHaveBeenCalled();
  });

  it("the cancer center's path sends a signed-out visitor to log in and back", async () => {
    h.identity.mockResolvedValue(null);
    await expect(at("meyer_cancer_center")).rejects.toThrow(
      "REDIRECT /api/auth/saml/login?return=/edit/center/meyer_cancer_center/program-roster",
    );
  });

  it("the old address redirects for good", () => {
    expect(() => OldPage()).toThrow("PERMANENT /edit/center/meyer_cancer_center/program-roster");
  });
});
