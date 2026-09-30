import { describe, expect, it } from "vitest";
import { loadTrialDocs, loadTrialEvidenceByCwid, trialStatusKey } from "@/lib/search-trial-evidence";
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
    // One UI set per MeSH-tagged trial, for the card's per-concept trial count.
    expect(out.get("a")?.trials).toEqual([["D015470", "D007938"], ["D007938"]]);
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
    expect(out.get("a")).toEqual({ meshUi: [], text: "Local protocol", trials: [] });
  });

  it("throws when labels exist but none resolve (MeSH map unavailable)", async () => {
    await expect(
      loadTrialEvidenceByCwid(client([{ cwid: "a", trial: t({ meshTerms: "Leukemia" }) }]), undefined, resolver({})),
    ).rejects.toThrow(/none of 1 MeSH labels resolved/);
  });
});

describe("loadTrialDocs", () => {
  const trial = (over: Record<string, unknown>) => ({
    protocolNumber: "P1",
    nctNumber: null,
    title: "A trial",
    status: "OPEN TO ACCRUAL",
    phase: "PHASE2",
    studyType: "INTERVENTIONAL",
    sponsorClass: "industry",
    principalSponsor: "Acme",
    conditions: null,
    meshTerms: null,
    briefSummary: null,
    ctgovStatus: null as string | null,
    startDate: null as string | null,
    startDateType: null as string | null,
    primaryCompletionDate: null as string | null,
    primaryCompletionDateType: null as string | null,
    hasResults: null as boolean | null,
    interventions: null as string | null,
    interventionTypes: null as string | null,
    firstOtaDate: null as Date | null,
    investigators: [] as Array<{
      cwid: string;
      scholar: { preferredName: string; slug: string; primaryDepartment: string | null };
    }>,
    ...over,
  });
  const pi = (cwid: string, dept: string | null = "Medicine") => ({
    cwid,
    scholar: { preferredName: `Dr ${cwid}`, slug: cwid, primaryDepartment: dept },
  });
  const clientOf = (rows: unknown[]) => ({ clinicalTrial: { findMany: async () => rows } }) as never;

  it("dedupes protocols sharing an NCT, merges PIs, maps phase/sponsor/status", async () => {
    const docs = await loadTrialDocs(
      clientOf([
        trial({ protocolNumber: "P1", nctNumber: "NCT1", meshTerms: "Leukemia", investigators: [pi("a")] }),
        trial({ protocolNumber: "P2", nctNumber: "NCT1", investigators: [pi("a"), pi("b", "Pediatrics")] }),
        trial({ protocolNumber: "P3", status: "IRB STUDY CLOSURE", phase: null, sponsorClass: null, investigators: [pi("c")] }),
      ]),
      resolver({ Leukemia: "D007938" }),
    );
    expect(docs.map((d) => d.trialId)).toEqual(["NCT1", "P3"]);
    expect(docs[0]).toMatchObject({
      piCwids: ["a", "b"],
      piNames: "Dr a; Dr b",
      meshDescriptorUi: ["D007938"],
      statusBucket: "active",
      phase: "2",
      sponsorClass: "industry",
      studyTypeKeys: ["interventional"],
      departments: ["Medicine", "Pediatrics"],
      meshLabels: ["Leukemia"],
    });
    // No NCT ⇒ the "Not on ClinicalTrials.gov" study-type option.
    expect(docs[1]).toMatchObject({
      statusBucket: "completed",
      phase: "nr",
      sponsorClass: "unknown",
      studyTypeKeys: ["interventional", "not_ctgov"],
    });
  });

  it("carries CT.gov status, dates, interventions and results; OnCore dates for a protocol without an NCT", async () => {
    const docs = await loadTrialDocs(
      clientOf([
        trial({
          protocolNumber: "P1",
          nctNumber: "NCT1",
          ctgovStatus: "TERMINATED",
          startDate: "2019-03-14",
          startDateType: "ACTUAL",
          primaryCompletionDate: "2027-06",
          primaryCompletionDateType: "ESTIMATED",
          hasResults: true,
          interventions: "Drug: A; Procedure: B",
          interventionTypes: "DRUG; PROCEDURE",
          investigators: [pi("a")],
        }),
        trial({ protocolNumber: "P2", firstOtaDate: new Date("2021-05-02T00:00:00Z"), investigators: [pi("b")] }),
      ]),
      resolver({}),
    );
    expect(docs[0]).toMatchObject({
      statusKey: "terminated",
      statusBucket: "completed",
      statusRank: 2,
      startDate: "2019-03",
      startYear: 2019,
      startEstimated: false,
      endDate: "2027-06",
      endEstimated: true,
      interventionTypes: ["DRUG", "PROCEDURE"],
      hasResults: true,
    });
    expect(docs[1]).toMatchObject({
      statusKey: "recruiting",
      statusRank: 0,
      startDate: "2021-05",
      startYear: 2021,
      endDate: null,
      interventionTypes: [],
      hasResults: false,
    });
  });

  it("drops trials the profile hides", async () => {
    const docs = await loadTrialDocs(clientOf([trial({ status: "SUSPENDED", investigators: [pi("a")] })]), resolver({}));
    expect(docs).toEqual([]);
  });
});

describe("trialStatusKey", () => {
  it("prefers CT.gov's status when it's one we show, else maps OnCore's", () => {
    expect(trialStatusKey("NOT_YET_RECRUITING", "OPEN TO ACCRUAL")).toBe("not_yet_recruiting");
    expect(trialStatusKey("UNKNOWN", "CLOSED TO ACCRUAL")).toBe("active_not_recruiting");
    expect(trialStatusKey(null, "OPEN TO ACCRUAL")).toBe("recruiting");
    expect(trialStatusKey(null, "IRB STUDY CLOSURE")).toBe("completed");
    expect(trialStatusKey("WITHDRAWN", "IRB STUDY CLOSURE")).toBe("completed");
  });
});
