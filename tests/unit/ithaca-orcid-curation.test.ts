/**
 * Ithaca ORCID plan, step 2: Cornell Ithaca rows in ORCID curation. Seeds land on
 * Ithaca rows only, Affiliation Manager pairs band strong only when the name
 * agrees, nothing Ithaca is auto-confirmed, the queue and coverage filter by
 * campus, and an iD another row holds is refused.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import { evidencePageUrls, mergeForScholars, toCandidates, webPageDetail } from "@/etl/orcid-candidates/index";
import { orcidEvidenceLine } from "@/lib/edit/orcid";
import { affiliationManagerBand, planAutoConfirm } from "@/etl/orcid-evidence/index";
import { orcidCoverageQuery, orcidVerdict, parseOrcidCoverageParams } from "@/lib/edit/orcid-coverage";
import { orcidQueueFilterKey, parseOrcidQueueFilter } from "@/lib/edit/orcid-queue";
import { assertOrcidFree, OrcidQueueRefused } from "@/lib/edit/orcid-queue.server";

const ID = "0000-0002-1825-0097";

describe("Affiliation Manager seeds", () => {
  it("land on Cornell Ithaca rows only, never on a WCM row with the same string", () => {
    const { rows } = toCandidates([], [], [
      { personIdentifier: "AB123", orcid: ID, updated_at: null },
      { personIdentifier: "cd456", orcid: "not-an-id", updated_at: null },
    ]);
    expect(rows.map((r) => [r.cwid, r.source])).toEqual([["ab123", "cornell_affiliation_manager"]]);
    expect(mergeForScholars(rows, new Set(["ab123"])).keep).toEqual([]);
    expect(mergeForScholars(rows, new Set(), new Set(["ab123"])).keep).toHaveLength(1);
  });
});

describe("web-page ORCID inferences", () => {
  it("say which kinds of page the voting papers were listed on", () => {
    const ev = JSON.stringify([
      { doi: "10.1/a", pages: [{ url: "https://x.cornell.edu/people/qz" }, { url: "https://qzlab.example.org/pubs" }] },
      { doi: "10.1/b", pages: [{ url: "https://qz.example.org/cv.pdf" }, { url: "https://unknown.example.org" }] },
    ]);
    const kind = new Map([
      ["https://x.cornell.edu/people/qz", "profile"],
      ["https://qzlab.example.org/pubs", "pubs"],
      ["https://qz.example.org/cv.pdf", "cv"],
    ]);
    const { rows } = toCandidates([], [], [], [{ netid: "qz11", orcid: ID, votes: 2, inferred_at: null, evidence_json: ev }], kind);
    expect(rows[0].sourceDetail).toBe("Cornell profile, lab or personal site and CV");
    expect(evidencePageUrls("not json")).toEqual([]);
    expect(webPageDetail(["profile"])).toBe("Cornell profile");
    expect(webPageDetail(["lab", "lab", "cv"])).toBe("lab site and CV");
    expect(webPageDetail([null, "weird"])).toBeNull();
    const line = (detail: string | null) =>
      orcidEvidenceLine({ source: "web_page_seed", accepted: 3, rejected: 0, detail }, "Quinn");
    expect(line("Cornell profile and lab site")).toBe("Recorded on 3 papers listed on Quinn's Cornell profile and lab site");
    expect(line(null)).toBe("Recorded on 3 papers listed on Quinn's web pages");
  });
  it("land on Cornell Ithaca rows only, with the votes as accepted", () => {
    const { rows, invalid } = toCandidates([], [], [], [
      { netid: "QZ11", orcid: ID, votes: 4, inferred_at: "2026-11-21T00:00:00Z" },
      { netid: "ov22", orcid: "0000-0002-1825-009", votes: 3, inferred_at: null },
    ]);
    expect(invalid).toBe(1);
    expect(rows.map((r) => [r.cwid, r.source, r.articlesAccepted])).toEqual([["qz11", "web_page_seed", 4]]);
    expect(mergeForScholars(rows, new Set(["qz11"])).keep).toEqual([]);
    expect(mergeForScholars(rows, new Set(), new Set(["qz11"])).keep).toHaveLength(1);
  });
  it("band strong like an Affiliation Manager pair, and count as strong coverage", () => {
    const ok = { competitor: false, nameAgrees: true };
    expect(affiliationManagerBand("moderate", ok, ["web_page_seed"])).toBe("strong");
    expect(affiliationManagerBand("moderate", { ...ok, nameAgrees: false }, ["web_page_seed"])).toBe("moderate");    expect(
      orcidVerdict([{ cwid: "qz11", orcid: ID, source: "web_page_seed", articlesAccepted: 3, articlesRejected: 0 }]).tier,
    ).toBe("strong");
  });
});

describe("affiliationManagerBand", () => {
  const am = ["cornell_affiliation_manager"];
  const ok = { competitor: false, nameAgrees: true };
  it("lifts an uncontested, name-agreeing Affiliation Manager pair to strong", () => {
    expect(affiliationManagerBand("moderate", ok, am)).toBe("strong");
    expect(affiliationManagerBand("weak", ok, ["identity", ...am])).toBe("strong");
    expect(affiliationManagerBand("email_verified", ok, am)).toBe("email_verified");
  });
  it("leaves a contested, name-mismatched or non-AM pair in its band", () => {
    expect(affiliationManagerBand("moderate", { ...ok, competitor: true }, am)).toBe("moderate");
    expect(affiliationManagerBand("moderate", { ...ok, nameAgrees: false }, am)).toBe("moderate");
    expect(affiliationManagerBand("moderate", ok, ["identity"])).toBe("moderate");
  });
});

describe("auto-confirm", () => {
  it("never plans a Cornell Ithaca row, even an email-verified one", () => {
    const plan = planAutoConfirm(
      [
        { cwid: "ab123", orcid: ID, band: "email_verified" },
        { cwid: "abc2001", orcid: "0000-0001-5109-3700", band: "email_verified" },
      ],
      new Map([
        ["ab123", null],
        ["abc2001", null],
      ]),
      new Set(),
      new Set(["abc2001"]),
    );
    expect(plan).toEqual([{ cwid: "abc2001", orcid: "0000-0001-5109-3700" }]);
  });
});

describe("campus filters", () => {
  it("queue: parses, keys and drops unknown campuses", () => {
    const f = parseOrcidQueueFilter({ campus: ["ithaca", "mars"] });
    expect(f.campuses).toEqual(["ithaca"]);
    expect(orcidQueueFilterKey(f)).toBe("campus=ithaca");
  });
  it("coverage: WCM by default (today's URLs unchanged), Ithaca opts in", () => {
    const wcm = parseOrcidCoverageParams({});
    expect(wcm.campus ?? "wcm").toBe("wcm");
    expect(orcidCoverageQuery(wcm)).not.toContain("campus");
    const ith = parseOrcidCoverageParams({ campus: "ithaca" });
    expect(ith.types).toEqual([]); // not the bare-visit full-time-faculty default
    expect(orcidCoverageQuery(ith)).toContain("campus=ithaca");
  });
  it("coverage: an Affiliation Manager iD alone grades strong", () => {
    expect(
      orcidVerdict([
        { cwid: "ab123", orcid: ID, source: "cornell_affiliation_manager", articlesAccepted: 0, articlesRejected: 0 },
      ]).tier,
    ).toBe("strong");
  });
});

describe("assertOrcidFree", () => {
  const tx = (holders: string[], linked: number) =>
    ({
      scholar: { findMany: vi.fn().mockResolvedValue(holders.map((cwid) => ({ cwid }))) },
      scholarIdentityLink: { count: vi.fn().mockResolvedValue(linked) },
    }) as never;
  const code = (p: Promise<void>) =>
    p.then(
      () => "ok",
      (e: unknown) => (e instanceof OrcidQueueRefused ? e.code : String(e)),
    );

  it("passes a free iD and an excepted holder", async () => {
    expect(await code(assertOrcidFree(tx([], 0), "ab123", ID))).toBe("ok");
    expect(await code(assertOrcidFree(tx(["x"], 0), "ab123", ID, "x"))).toBe("ok");
  });
  it("refuses an iD another row holds, naming a known cross-campus link", async () => {
    expect(await code(assertOrcidFree(tx(["abc2001"], 0), "ab123", ID))).toBe("held_by_other");
    expect(await code(assertOrcidFree(tx(["abc2001"], 1), "ab123", ID))).toBe("on_linked_record");
  });
});
