import { describe, expect, it } from "vitest";
import { loadTrialEvidenceByCwid } from "@/lib/search-trial-evidence";
import type { MeshResolution } from "@/lib/api/search-taxonomy";

type Trial = { title: string; status: string | null; conditions: string | null; meshTerms: string | null };

function client(rows: Array<{ cwid: string; trial: Trial }>) {
  return {
    personClinicalTrial: {
      findMany: async ({ where }: { where: { cwid?: string } }) =>
        rows.filter((r) => !where.cwid || r.cwid === where.cwid),
    },
  } as never;
}

const resolver = (map: Record<string, string>) => async (label: string) =>
  map[label] ? ({ descriptorUi: map[label] } as MeshResolution) : null;

const t = (over: Partial<Trial>): Trial => ({
  title: "A trial",
  status: "OPEN TO ACCRUAL",
  conditions: null,
  meshTerms: null,
  ...over,
});

describe("loadTrialEvidenceByCwid", () => {
  it("resolves MeSH labels to deduped UIs and joins title/conditions/labels as text", async () => {
    const out = await loadTrialEvidenceByCwid(
      client([
        { cwid: "a", trial: t({ title: "AML study", conditions: "AML", meshTerms: "Leukemia, Myeloid, Acute; Leukemia" }) },
        { cwid: "a", trial: t({ title: "Second", meshTerms: "Leukemia; Unknown Label" }) },
      ]),
      undefined,
      resolver({ "Leukemia, Myeloid, Acute": "D015470", Leukemia: "D007938" }),
    );
    expect(out.get("a")?.meshUi).toEqual(["D015470", "D007938"]);
    expect(out.get("a")?.text).toBe("AML study AML Leukemia, Myeloid, Acute Leukemia Second Leukemia Unknown Label");
  });

  it("skips trials the profile hides and scopes to one cwid", async () => {
    const rows = [
      { cwid: "a", trial: t({ status: "Withdrawn", meshTerms: "Leukemia" }) },
      { cwid: "a", trial: t({ status: "SUSPENDED", meshTerms: "Leukemia" }) },
      { cwid: "b", trial: t({ meshTerms: "Leukemia" }) },
    ];
    const out = await loadTrialEvidenceByCwid(client(rows), "a", resolver({ Leukemia: "D007938" }));
    expect(out.size).toBe(0);
  });

  it("keeps title-only (non-NCT) trials as text evidence", async () => {
    const out = await loadTrialEvidenceByCwid(client([{ cwid: "a", trial: t({ title: "Local protocol" }) }]), undefined, resolver({}));
    expect(out.get("a")).toEqual({ meshUi: [], text: "Local protocol" });
  });

  it("throws when labels exist but none resolve (MeSH map unavailable)", async () => {
    await expect(
      loadTrialEvidenceByCwid(client([{ cwid: "a", trial: t({ meshTerms: "Leukemia" }) }]), undefined, resolver({})),
    ).rejects.toThrow(/none of 1 MeSH labels resolved/);
  });
});
