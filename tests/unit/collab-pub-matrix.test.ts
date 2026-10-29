import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";

import type { AttributedPublication } from "@/lib/edit/center-pub-attribution";
import {
  collabPubMatrixQuery,
  computeCollabPubMatrix,
  matrixPct,
  matrixUniverse,
  parseCollabPubMatrixParams,
  type MatrixPub,
} from "@/lib/edit/collab-pub-matrix";
import { buildCollabPubMatrixWorkbook } from "@/lib/edit/collab-pub-matrix-xlsx";
import { externalAuthorFlags } from "@/lib/edit/pubmed-affiliations";

const PROGRAMS = [
  { code: "AA", label: "Program A" },
  { code: "BB", label: "Program B" },
  { code: "CC", label: "Program C" },
];
/** Synthetic member authors by cwid: their program on the as-of date. */
const PROGRAM_OF: Record<string, string | null> = { a1: "AA", a2: "AA", b1: "BB", n1: null };
const pub = (
  pmid: string,
  cwids: string[],
  over: Partial<MatrixPub> & { unknownTenure?: string[] } = {},
): MatrixPub => ({
  pmid,
  members: cwids.map((cwid) => ({
    cwid,
    programCode: PROGRAM_OF[cwid] ?? null,
    tenureUnknown: (over.unknownTenure ?? []).includes(cwid),
  })),
  externalAuthor: false,
  impactScore1: null,
  ...over,
});
const run = (pubs: MatrixPub[], excluded: string[] = []) =>
  computeCollabPubMatrix(pubs, PROGRAMS, excluded, 10);
const row = (m: ReturnType<typeof run>, code: string) =>
  m.programs.find((r) => r.code === code)!.counts;

describe("computeCollabPubMatrix", () => {
  it("lists every program, zero rows included, and counts a pub once per program it touches", () => {
    const m = run([pub("1", ["a1"]), pub("2", ["a1", "b1"])]);
    expect(m.programs.map((r) => r.code)).toEqual(["AA", "BB", "CC"]);
    expect(row(m, "AA").publications).toBe(2);
    expect(row(m, "BB").publications).toBe(1);
    expect(row(m, "CC")).toEqual({
      publications: 0,
      inter: 0,
      intra: 0,
      interIntra: 0,
      collaborative: 0,
      interInstitutional: 0,
      highImpact: 0,
    });
    expect(m.unique.publications).toBe(2); // deduplicated across programs
  });

  it("intra-programmatic: two or more members in THIS program; on the unique row, in any one", () => {
    const m = run([pub("1", ["a1", "a2", "b1"]), pub("2", ["a1"])]);
    expect(row(m, "AA").intra).toBe(1);
    expect(row(m, "BB").intra).toBe(0); // a single BB author is not intra
    expect(m.unique.intra).toBe(1);
  });

  it("inter-programmatic: one member in this program and one in another", () => {
    const m = run([pub("1", ["a1", "a2"]), pub("2", ["a1", "b1"]), pub("3", ["a1", "n1"])]);
    expect(row(m, "AA").inter).toBe(1); // pub 2 only: two AA authors is not inter
    expect(row(m, "BB").inter).toBe(1);
    expect(m.unique.inter).toBe(1); // a member with no program is not another program
  });

  it("inter + intra: both on the same row", () => {
    const m = run([pub("1", ["a1", "a2", "b1"]), pub("2", ["a1", "a2"])]);
    expect(row(m, "AA").interIntra).toBe(1);
    expect(row(m, "BB").interIntra).toBe(0); // inter, but one BB author
    expect(m.unique.interIntra).toBe(1);
  });

  it("collaborative: inter OR intra, each pub once (= inter + intra - both)", () => {
    const m = run([
      pub("1", ["a1", "a2", "b1"]), // AA inter+intra, BB inter
      pub("2", ["a1", "a2"]), // AA intra
      pub("3", ["a1", "b1"]), // AA inter, BB inter
      pub("4", ["a1"]), // neither
    ]);
    const aa = row(m, "AA");
    expect(aa).toMatchObject({ publications: 4, inter: 2, intra: 2, interIntra: 1 });
    expect(aa.collaborative).toBe(3);
    expect(aa.collaborative).toBe(aa.inter + aa.intra - aa.interIntra);
    expect(row(m, "BB").collaborative).toBe(2);
    expect(m.unique.collaborative).toBe(3);
    expect(m.unique.collaborative).toBe(m.unique.inter + m.unique.intra - m.unique.interIntra);
  });

  it("a member with no program counts for the universe but not for any program", () => {
    const m = run([pub("1", ["n1"]), pub("2", ["n1", "a1"])]);
    expect(m.unique.publications).toBe(2);
    expect(m.unique.inter).toBe(0);
    expect(row(m, "AA").publications).toBe(1);
  });

  it("an excluded program loses its row and its members", () => {
    const m = run([pub("1", ["a1", "b1"]), pub("2", ["b1"])], ["BB"]);
    expect(m.programs.map((r) => r.code)).toEqual(["AA", "CC"]);
    expect(m.unique.publications).toBe(1);
    expect(m.unique.inter).toBe(0);
  });

  it("inter-institutional only when externalAuthor is true; null is counted as unknown", () => {
    const m = run([
      pub("1", ["a1"], { externalAuthor: true }),
      pub("2", ["a1"], { externalAuthor: false }),
      pub("3", ["a1"], { externalAuthor: null }),
    ]);
    expect(m.unique.interInstitutional).toBe(1);
    expect(row(m, "AA").interInstitutional).toBe(1);
    expect(m.unknownAffiliation).toBe(1);
  });

  it("high impact at the threshold and above, never on a missing JIF", () => {
    const m = run([
      pub("1", ["a1"], { impactScore1: 10 }),
      pub("2", ["a1"], { impactScore1: 9.99 }),
      pub("3", ["a1"], { impactScore1: null }),
    ]);
    expect(m.unique.highImpact).toBe(1);
  });

  it("counts pubs credited only to members of unknown WCM tenure", () => {
    const m = run([
      pub("1", ["a1"], { unknownTenure: ["a1"] }),
      pub("2", ["a1", "b1"], { unknownTenure: ["a1"] }), // b1's tenure is known
      pub("3", ["a1"]),
    ]);
    expect(m.unique.publications).toBe(3); // counted anyway
    expect(m.unknownTenure).toBe(1);
  });
});

describe("matrixUniverse", () => {
  const attributed = (
    pmid: string,
    over: Partial<AttributedPublication> = {},
  ): AttributedPublication => ({
    pmid,
    title: "T",
    journal: null,
    date: "2025-06-01",
    publicationType: "Academic Article",
    isReview: false,
    relevant: true,
    relevanceSource: "llm",
    members: [{ cwid: "a1", name: "A One", programCode: "AA", tenureUnknown: false }],
    ...over,
  });
  const pubs = [
    attributed("1"),
    attributed("2", { isReview: true, publicationType: "Review" }),
    attributed("3", { relevant: false }),
    attributed("4", { relevant: null, relevanceSource: null }),
    attributed("5", { relevanceSource: "human" }),
  ];

  it("cancer-relevant non-reviews only", () => {
    expect(matrixUniverse(pubs, false).map((p) => p.pmid)).toEqual(["1", "5"]);
  });
  it("confirmed only: a reviewer's decision", () => {
    expect(matrixUniverse(pubs, true).map((p) => p.pmid)).toEqual(["5"]);
  });
});

describe("matrixPct", () => {
  it("rounds to a whole percent and is 0% on an empty row", () => {
    expect(matrixPct(65, 389)).toBe("17%");
    expect(matrixPct(278, 389)).toBe("71%");
    expect(matrixPct(0, 0)).toBe("0%");
  });
});

describe("parseCollabPubMatrixParams", () => {
  const now = new Date("2026-10-29T00:00:00Z");
  it("defaults to last year, as of today, research members, nothing excluded", () => {
    expect(parseCollabPubMatrixParams(new URLSearchParams(), now)).toEqual({
      from: 2025,
      to: 2025,
      asOf: "2026-10-29",
      membershipType: "research",
      excluded: [],
      confirmedOnly: false,
    });
  });
  it("round-trips through the query string and rejects junk", () => {
    const p = parseCollabPubMatrixParams(
      new URLSearchParams(
        "from=2024&to=2023&asOf=2025-12-31&membership=clinical&exclude=BB&exclude=AA&confirmed=1",
      ),
      now,
    );
    expect(p).toEqual({
      from: 2024,
      to: 2024,
      asOf: "2025-12-31",
      membershipType: "clinical",
      excluded: ["AA", "BB"],
      confirmedOnly: true,
    });
    expect(parseCollabPubMatrixParams(new URLSearchParams(collabPubMatrixQuery(p)), now)).toEqual(
      p,
    );
    const junk = parseCollabPubMatrixParams(
      new URLSearchParams("asOf=2025-13-45&membership=any"),
      now,
    );
    expect(junk.asOf).toBe("2026-10-29");
    expect(junk.membershipType).toBe("research");
    expect(parseCollabPubMatrixParams(new URLSearchParams("asOf=12/31/2025"), now).asOf).toBe(
      "2026-10-29",
    );
  });
});

describe("externalAuthorFlags", () => {
  const article = (pmid: string, authors: string[][]) =>
    `<PubmedArticle><MedlineCitation><PMID Version="1">${pmid}</PMID><Article><AuthorList>${authors
      .map(
        (affs) =>
          `<Author><LastName>X</LastName>${affs.map((a) => `<AffiliationInfo><Affiliation>${a}</Affiliation></AffiliationInfo>`).join("")}</Author>`,
      )
      .join(
        "",
      )}</AuthorList></Article></MedlineCitation><PubmedData><ReferenceList><Reference><ArticleIdList><ArticleId IdType="pubmed">999</ArticleId></ArticleIdList></Reference></ReferenceList></PubmedData></PubmedArticle>`;
  const WCM = "Weill Cornell Medicine, New York, NY";
  const flags = (authors: string[][]) =>
    externalAuthorFlags(`<PubmedArticleSet>${article("1", authors)}</PubmedArticleSet>`).get("1");

  it("true for an author with only non-WCM affiliations, false when all are WCM, null with none", () => {
    const xml = `<PubmedArticleSet>${[
      article("1", [[WCM], ["Example University, Boston, MA"]]),
      article("2", [[WCM], ["Weill Cornell Medical College, New York, NY"]]),
      article("3", [["Example Institute, Paris", "Weill Cornell Medical College"]]),
      article("4", [[], []]),
    ].join("")}</PubmedArticleSet>`;
    expect(Object.fromEntries(externalAuthorFlags(xml))).toEqual({
      "1": true,
      "2": false,
      "3": false, // a dual-affiliated WCM author is WCM
      "4": null,
    });
  });

  it("NYP, MSK, Rockefeller and Cornell Ithaca are outside WCM", () => {
    for (const outside of [
      "NewYork-Presbyterian Hospital, New York, NY",
      "Memorial Sloan Kettering Cancer Center, New York, NY",
      "The Rockefeller University, New York, NY",
      "Department of Molecular Biology, Cornell University, Ithaca, NY",
    ])
      expect(flags([[WCM], [outside]]), outside).toBe(true);
  });

  it("WCM-Qatar, the Graduate School and hyphenated spellings are WCM", () => {
    for (const inside of [
      "Weill Cornell Medicine-Qatar, Doha, Qatar",
      "Weill Cornell Graduate School of Medical Sciences, New York, NY",
      "Weill-Cornell Medical College, New York, NY",
      "Weill Medical College of Cornell University, New York, NY",
    ])
      expect(flags([[WCM], [inside]]), inside).toBe(false);
  });
});

describe("buildCollabPubMatrixWorkbook", () => {
  const load = async (m: ReturnType<typeof run>, query: string) => {
    const p = parseCollabPubMatrixParams(
      new URLSearchParams(query),
      new Date("2026-10-29T00:00:00Z"),
    );
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(
      (await buildCollabPubMatrixWorkbook(
        m,
        p,
        new Date("2026-10-28T12:00:00Z"),
      )) as unknown as ArrayBuffer,
    );
    return wb;
  };

  it("writes EVAL's two sheets, with the collaborative column and the as-of date", async () => {
    const wb = await load(
      run([pub("1", ["a1", "b1"], { externalAuthor: true })]),
      "exclude=CC&asOf=2025-12-31",
    );
    const data = wb.getWorksheet("Publication Data")!;
    expect(data.getRow(2).getCell(1).value).toBe("Program Area Code");
    expect(data.getRow(2).getCell(6).value).toBe("Collaborative Pubs (#)");
    expect(data.getRow(2).getCell(12).value).toBe("Collaborative Pubs (%)");
    expect((data.getRow(3).values as unknown[]).slice(1)).toEqual([
      "Unique cancer-relevant publications",
      1,
      1,
      0,
      0,
      1,
      1,
      0,
      "100%",
      "0%",
      "0%",
      "100%",
      "100%",
      "0%",
    ]);
    expect(data.getRow(4).getCell(1).value).toBe("AA");
    const details = wb.getWorksheet("Report Details")!;
    expect(details.getRow(2).getCell(1).value).toBe("Run Date: 10/28/2026");
    expect(details.getRow(3).getCell(1).value).toBe("Report Period: 01/01/2025 through 12/31/2025");
    expect(details.getRow(4).getCell(1).value).toBe("Membership and Program As Of: 12/31/2025");
    expect(details.getRow(5).getCell(1).value).toBe("Membership Type: RESEARCH");
    expect(details.getRow(6).getCell(1).value).toBe("Excluded Program Areas: CC");
    expect(details.rowCount).toBe(7); // no unknown-tenure line when there are none
  });

  it("records the unknown-tenure count when there is one", async () => {
    const wb = await load(run([pub("1", ["a1"], { unknownTenure: ["a1"] })]), "");
    expect(wb.getWorksheet("Report Details")!.getRow(8).getCell(1).value).toBe(
      "Publications Counted Without a Known WCM Tenure: 1",
    );
  });
});
