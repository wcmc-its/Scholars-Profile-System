import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";

import {
  collabPubMatrixQuery,
  computeCollabPubMatrix,
  matrixPct,
  parseCollabPubMatrixParams,
  type MatrixMember,
  type MatrixPub,
} from "@/lib/edit/collab-pub-matrix";
import { buildCollabPubMatrixWorkbook } from "@/lib/edit/collab-pub-matrix-xlsx";
import { externalAuthorFlags } from "@/lib/edit/pubmed-affiliations";

const PROGRAMS = [
  { code: "AA", label: "Program A" },
  { code: "BB", label: "Program B" },
  { code: "CC", label: "Program C" },
];
const member = (
  cwid: string,
  programCode: string | null,
  over: Partial<MatrixMember> = {},
): MatrixMember => ({
  cwid,
  programCode,
  startDate: null,
  endDate: null,
  membershipRoleKey: null,
  ...over,
});
const MEMBERS = [member("a1", "AA"), member("a2", "AA"), member("b1", "BB"), member("n1", null)];
const pub = (pmid: string, memberCwids: string[], over: Partial<MatrixPub> = {}): MatrixPub => ({
  pmid,
  pubDate: "2025-06-01",
  memberCwids,
  externalAuthor: false,
  impactScore1: null,
  ...over,
});
const run = (pubs: MatrixPub[], members = MEMBERS, excluded: string[] = []) =>
  computeCollabPubMatrix(pubs, members, PROGRAMS, excluded, 10);
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
      interInstitutional: 0,
      highImpact: 0,
    });
    expect(m.unique.publications).toBe(2); // deduplicated across programs
  });

  it("inter-programmatic: member authors from two or more programs", () => {
    const m = run([pub("1", ["a1", "a2"]), pub("2", ["a1", "b1"])]);
    expect(m.unique.inter).toBe(1);
    expect(row(m, "AA").inter).toBe(1);
    expect(row(m, "BB").inter).toBe(1);
  });

  it("intra-programmatic: two or more in THIS program; on the unique row, in any one", () => {
    const m = run([pub("1", ["a1", "a2", "b1"])]);
    expect(row(m, "AA").intra).toBe(1);
    expect(row(m, "BB").intra).toBe(0);
    expect(m.unique.intra).toBe(1);
  });

  it("inter + intra: both on the same row", () => {
    const m = run([pub("1", ["a1", "a2", "b1"]), pub("2", ["a1", "a2"])]);
    expect(row(m, "AA").interIntra).toBe(1);
    expect(row(m, "BB").interIntra).toBe(0); // inter, but one BB author
    expect(m.unique.interIntra).toBe(1);
  });

  it("a member with no program counts for the universe but not for any program", () => {
    const m = run([pub("1", ["n1"]), pub("2", ["n1", "a1"])]);
    expect(m.unique.publications).toBe(2);
    expect(m.unique.inter).toBe(0);
    expect(row(m, "AA").publications).toBe(1);
  });

  it("an author counts only when the pub date is inside their membership stint", () => {
    const members = [
      member("a1", "AA", { startDate: new Date("2025-07-01") }),
      member("b1", "BB", { endDate: new Date("2025-05-31") }),
      member("a2", "AA", { membershipRoleKey: "invited" }),
    ];
    const m = run(
      [pub("1", ["a1", "b1", "a2"]), pub("2", ["a1"], { pubDate: "2025-08-01" })],
      members,
    );
    expect(m.unique.publications).toBe(1); // pub 1 has no active member author
    expect(row(m, "AA").publications).toBe(1);
    expect(row(m, "BB").publications).toBe(0);
  });

  it("an excluded program loses its row and its members", () => {
    const m = run([pub("1", ["a1", "b1"]), pub("2", ["b1"])], MEMBERS, ["BB"]);
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

  it("an author listed twice counts once", () => {
    const m = run([pub("1", ["a1", "a1"])]);
    expect(row(m, "AA").intra).toBe(0);
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
  it("defaults to last year, research members, nothing excluded", () => {
    expect(parseCollabPubMatrixParams(new URLSearchParams(), now)).toEqual({
      from: 2025,
      to: 2025,
      membershipType: "research",
      excluded: [],
      confirmedOnly: false,
    });
  });
  it("round-trips through the query string and rejects junk", () => {
    const p = parseCollabPubMatrixParams(
      new URLSearchParams("from=2024&to=2023&type=bogus&exclude=BB&exclude=AA&confirmed=1"),
      now,
    );
    expect(p).toEqual({
      from: 2024,
      to: 2024,
      membershipType: "research",
      excluded: ["AA", "BB"],
      confirmedOnly: true,
    });
    expect(parseCollabPubMatrixParams(new URLSearchParams(collabPubMatrixQuery(p)), now)).toEqual(
      p,
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
  const xml = `<PubmedArticleSet>${[
    article("1", [["Weill Cornell Medicine, New York, NY"], ["Example University, Boston, MA"]]),
    article("2", [["Weill Cornell Medicine, New York, NY"], ["NewYork-Presbyterian Hospital"]]),
    article("3", [["Example Institute, Paris", "Weill Cornell Medical College"]]),
    article("4", [[], []]),
  ].join("")}</PubmedArticleSet>`;

  it("true for an author with only non-WCM affiliations, false when all are WCM, null with none", () => {
    expect(Object.fromEntries(externalAuthorFlags(xml))).toEqual({
      "1": true,
      "2": false,
      "3": false, // a dual-affiliated WCM author is WCM
      "4": null,
    });
  });
});

describe("buildCollabPubMatrixWorkbook", () => {
  it("writes EVAL's two sheets", async () => {
    const m = run([pub("1", ["a1", "b1"], { externalAuthor: true })]);
    const p = parseCollabPubMatrixParams(
      new URLSearchParams("exclude=CC"),
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
    const data = wb.getWorksheet("Publication Data")!;
    expect(data.getRow(2).getCell(1).value).toBe("Program Area Code");
    expect((data.getRow(3).values as unknown[]).slice(1)).toEqual([
      "Unique cancer-relevant publications",
      1,
      1,
      0,
      0,
      1,
      0,
      "100%",
      "0%",
      "0%",
      "100%",
      "0%",
    ]);
    expect(data.getRow(4).getCell(1).value).toBe("AA");
    const details = wb.getWorksheet("Report Details")!;
    expect(details.getRow(2).getCell(1).value).toBe("Run Date: 10/28/2026");
    expect(details.getRow(3).getCell(1).value).toBe("Report Period: 01/01/2025 through 12/31/2025");
    expect(details.getRow(4).getCell(1).value).toBe("Membership Type: RESEARCH");
    expect(details.getRow(5).getCell(1).value).toBe("Excluded Program Areas: CC");
  });
});
