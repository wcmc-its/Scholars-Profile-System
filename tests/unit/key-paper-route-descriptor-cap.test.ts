/**
 * The key-paper route capped `descriptorUis` at 50 while the card sends the
 * concept's full descendant list (bounded upstream at DESCENDANT_HARD_CAP = 200).
 * Any concept with >50 descendants had its tail dropped — Vaccines (95) lost
 * COVID-19 Vaccines at index 65, so "expand" showed no records. The route must
 * forward the whole list up to the shared cap.
 */
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { DESCENDANT_HARD_CAP } from "@/lib/api/search-taxonomy";

const { fetchKeyPaper } = vi.hoisted(() => ({ fetchKeyPaper: vi.fn(async () => []) }));
vi.mock("@/lib/api/search", () => ({ fetchKeyPaper }));
vi.mock("@/lib/api/search-flags", () => ({ resolvePeopleReasonFromDoc: () => true }));

describe("GET /api/search/key-paper descriptorUis cap", () => {
  it("forwards a 95-descendant subtree intact and still bounds at DESCENDANT_HARD_CAP", async () => {
    const { GET } = await import("@/app/api/search/key-paper/route");
    const uis = Array.from({ length: DESCENDANT_HARD_CAP + 10 }, (_, i) => `D${i}`);
    await GET(new NextRequest(`http://x/api/search/key-paper?cwid=a&descriptorUis=${uis.join(",")}`));
    const sent = (fetchKeyPaper.mock.calls[0] as unknown[])[0] as { descriptorUis: string[] };
    expect(sent.descriptorUis).toHaveLength(DESCENDANT_HARD_CAP);
    // index 65 (COVID-19 Vaccines under Vaccines) survives — it did not at 50
    expect(sent.descriptorUis[65]).toBe("D65");
    expect(sent.descriptorUis[94]).toBe("D94");
  });

  it("forwards the two-concept `secondaryUis` param under the same cap", async () => {
    const { GET } = await import("@/app/api/search/key-paper/route");
    fetchKeyPaper.mockClear();
    await GET(new NextRequest("http://x/api/search/key-paper?cwid=a&descriptorUis=D1,D2&secondaryUis=D7,%20D8,"));
    const sent = (fetchKeyPaper.mock.calls[0] as unknown[])[0] as { secondaryDescriptorUis: string[] };
    expect(sent.secondaryDescriptorUis).toEqual(["D7", "D8"]);
  });
});
