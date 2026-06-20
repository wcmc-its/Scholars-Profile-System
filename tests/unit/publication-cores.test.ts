/**
 * Pure builder for the publication-modal "Core facilities" section
 * (lib/api/publication-detail buildPublicationCores). The DB read is thin; this
 * exercises the effective-confirmed CoreClaim merge, the /cores link gating, and
 * the ordering.
 */
import { describe, expect, it } from "vitest";
import { buildPublicationCores } from "@/lib/api/publication-detail";

type Row = Parameters<typeof buildPublicationCores>[0][number];

const row = (over: Partial<Row> = {}): Row => ({
  coreId: "2",
  status: "confirmed",
  name: "Biomedical Imaging",
  facility: "CBIC",
  ...over,
});

describe("buildPublicationCores", () => {
  it("keeps engine-confirmed and human-claimed, drops open candidates and rejected", () => {
    const out = buildPublicationCores(
      [
        row({ coreId: "2", status: "confirmed", name: "Biomedical Imaging" }),
        row({ coreId: "5", status: "candidate", name: "Flow Cytometry" }), // claimed → in
        row({ coreId: "7", status: "candidate", name: "Genomics" }), // open candidate → out
        row({ coreId: "9", status: "confirmed", name: "Antibody" }), // rejected → out
      ],
      (coreId) => (coreId === "5" ? "claimed" : coreId === "9" ? "rejected" : null),
      false,
    );
    expect(out.map((c) => c.name)).toEqual(["Biomedical Imaging", "Flow Cytometry"]);
  });

  it("attaches /cores links only when linkable, sorted by core name", () => {
    const out = buildPublicationCores(
      [row({ coreId: "5", name: "Zeta core" }), row({ coreId: "2", name: "Alpha core" })],
      () => null,
      true,
    );
    expect(out.map((c) => [c.name, c.href])).toEqual([
      ["Alpha core", "/cores/2"],
      ["Zeta core", "/cores/5"],
    ]);
  });

  it("href is null when the public core pages are off", () => {
    const out = buildPublicationCores([row()], () => null, false);
    expect(out[0]?.href).toBeNull();
  });
});
