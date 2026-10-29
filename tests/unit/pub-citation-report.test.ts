/**
 * Report 18 — Publication citation report: params, the investigator line,
 * the relevance filter, the loader over the shared attribution, and EVAL's
 * workbook shape (no CWID anywhere in it). Every person here is invented.
 */
import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  attribution: vi.fn(),
  pubs: vi.fn(),
  relevance: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      publication: { findMany: h.pubs },
      centerPublicationRelevance: { findMany: h.relevance },
    },
  },
}));
vi.mock("@/lib/edit/center-pub-attribution.server", () => ({
  loadCenterPubAttribution: h.attribution,
}));

import { type AttributedPublication, UNKNOWN_AUTHOR_NAME } from "@/lib/edit/center-pub-attribution";
import {
  buildPubCitationWorkbook,
  investigatorLine,
  keepsRelevance,
  lastFirst,
  parsePubCitationParams,
  PUB_CITATION_COLUMNS,
  type PubCitationParams,
  type PubCitationRow,
} from "@/lib/edit/pub-citation-report";
import { loadPubCitationReport } from "@/lib/edit/pub-citation-report.server";

const NOW = new Date("2026-10-29T12:00:00Z");
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe("parsePubCitationParams", () => {
  it("defaults to this year to date, as of today, research members, relevant non-reviews", () => {
    expect(parsePubCitationParams(new URLSearchParams(), NOW)).toEqual({
      start: "2026-01-01",
      end: "2026-10-29",
      asOf: "2026-10-29",
      membership: "research",
      relevance: "relevant",
    });
  });

  it("reads valid values and drops bad ones", () => {
    const sp = new URLSearchParams({
      start: "2025-01-01",
      end: "2025-13-45",
      asOf: "2025-06-30",
      membership: "clinical",
      relevance: "reviews",
    });
    expect(parsePubCitationParams(sp, NOW)).toEqual({
      start: "2025-01-01",
      end: "2026-10-29",
      asOf: "2025-06-30",
      membership: "clinical",
      relevance: "reviews",
    });
    const bad = parsePubCitationParams(
      new URLSearchParams({ membership: "x", relevance: "yes", asOf: "soon" }),
      NOW,
    );
    expect(bad.membership).toBe("research");
    expect(bad.relevance).toBe("relevant");
    expect(bad.asOf).toBe("2026-10-29");
  });
});

describe("investigator line", () => {
  it("is Last, First - PROGRAM, or the bare name without a program", () => {
    expect(lastFirst("Alex B. Testperson")).toBe("Testperson, Alex B.");
    expect(lastFirst("Mononym")).toBe("Mononym");
    expect(investigatorLine("Alex B. Testperson", "CB")).toBe("Testperson, Alex B. - CB");
    expect(investigatorLine("Alex B. Testperson", null)).toBe("Testperson, Alex B.");
  });
});

describe("keepsRelevance", () => {
  const cases = [
    { relevant: true, isReview: false },
    { relevant: true, isReview: true },
    { relevant: false, isReview: false },
    { relevant: false, isReview: true },
    { relevant: null, isReview: false },
  ];
  it("relevant = cancer-relevant non-reviews; reviews = cancer-relevant reviews; all = all", () => {
    expect(cases.map((c) => keepsRelevance("relevant", c))).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(cases.map((c) => keepsRelevance("reviews", c))).toEqual([
      false,
      true,
      false,
      false,
      false,
    ]);
    expect(cases.every((c) => keepsRelevance("all", c))).toBe(true);
  });
});

const author = (cwid: string, fullName: string, position: number, extra: object = {}) => ({
  cwid,
  position,
  isFirst: false,
  isLast: false,
  totalAuthors: 9,
  scholar: { fullName },
  ...extra,
});
const attributed = (
  pmid: string,
  date: string,
  relevant: boolean | null,
  isReview: boolean,
  members: Array<[string, string | null, boolean?]>,
): AttributedPublication => ({
  pmid,
  title: `Title ${pmid}`,
  journal: "J Synthetic",
  date,
  publicationType: isReview ? "Review" : "Academic Article",
  isReview,
  relevant,
  relevanceSource: relevant === null ? null : "rule",
  members: members.map(([cwid, programCode, tenureUnknown = false]) => ({
    cwid,
    name: cwid,
    programCode,
    tenureUnknown,
  })),
});
const attribution = (publications: AttributedPublication[]) => ({
  asOf: "2026-06-30",
  from: "2025-01-01",
  to: "2025-12-31",
  publications,
  memberCount: 3,
  unknownTenureMembers: 0,
  unknownTenurePublications: 0,
});
const P: PubCitationParams = {
  start: "2025-01-01",
  end: "2025-12-31",
  asOf: "2026-06-30",
  membership: "research",
  relevance: "relevant",
};

describe("loadPubCitationReport", () => {
  beforeEach(() => {
    h.attribution.mockReset();
    h.pubs.mockReset();
    h.attribution.mockResolvedValue(
      attribution([
        attributed("100", "2025-03-10", true, false, [
          ["aaa1001", "CB"],
          ["bbb1002", "CT"],
        ]),
        attributed("200", "2025-04-01", true, true, [["aaa1001", "CB"]]),
        attributed("300", "2025-02-01", false, false, [["bbb1002", "CT"]]),
        attributed("400", "2025-05-01", true, false, [["ccc1003", null, true]]),
      ]),
    );
    h.pubs.mockResolvedValue([
      {
        pmid: "100",
        authors: [
          author("bbb1002", "Bea Second", 0),
          author("zzz9999", "Zed Nonmember", 1, { isFirst: true }),
          author("aaa1001", "Ann First", 9, { isLast: true }),
          { ...author("nnn0000", "", 3), scholar: null },
        ],
      },
      { pmid: "400", authors: [author("ccc1003", "Cy Unknown", 1)] },
    ]);
    h.relevance.mockResolvedValue([{ pmid: "100", reason: "This is cancer relevant." }]);
  });

  it("asks the shared attribution for the period, as-of date and type", async () => {
    await loadPubCitationReport("ctr", P);
    expect(h.attribution).toHaveBeenCalledTimes(1);
    expect(h.attribution).toHaveBeenCalledWith("ctr", {
      from: "2025-01-01",
      to: "2025-12-31",
      asOf: "2026-06-30",
      membershipType: "research",
    });
  });

  it("keeps cancer-relevant non-reviews, newest first, programs from the attribution", async () => {
    const { rows, unknownTenure } = await loadPubCitationReport("ctr", P);
    expect(rows.map((r) => r.pmid)).toEqual(["400", "100"]);
    expect(rows[1]).toEqual({
      pmid: "100",
      title: "Title 100",
      journal: "J Synthetic",
      date: "2025-03-10",
      relevant: true,
      reason: "This is cancer relevant.",
      // Byline order; a non-member has no code; no scholar row → left out.
      investigators: [
        { cwid: "zzz9999", line: "Nonmember, Zed" },
        { cwid: "bbb1002", line: "Second, Bea - CT" },
        { cwid: "aaa1001", line: "First, Ann - CB" },
      ],
    });
    expect(rows[0].reason).toBeNull();
    // 400 is credited only through a member of unknown tenure.
    expect(unknownTenure).toBe(1);
    expect(h.pubs.mock.calls[0][0].where.pmid.in).toEqual(["400", "100"]);
  });

  it("reviews keeps only cancer-relevant reviews; all keeps everything", async () => {
    const reviews = await loadPubCitationReport("ctr", { ...P, relevance: "reviews" });
    expect(reviews.rows.map((r) => r.pmid)).toEqual(["200"]);
    expect(reviews.unknownTenure).toBe(0);
    const all = await loadPubCitationReport("ctr", { ...P, relevance: "all" });
    expect(all.rows.map((r) => r.pmid)).toEqual(["400", "200", "100", "300"]);
  });

  it("membership all merges research and clinical credit on one row per pmid", async () => {
    h.attribution.mockImplementation(async (_c: string, o: { membershipType: string }) =>
      attribution(
        o.membershipType === "research"
          ? [attributed("100", "2025-03-10", true, false, [["aaa1001", "CB"]])]
          : [
              attributed("100", "2025-03-10", true, false, [["bbb1002", "CPC"]]),
              attributed("500", "2025-01-05", true, false, [["bbb1002", "CPC"]]),
            ],
      ),
    );
    const { rows } = await loadPubCitationReport("ctr", { ...P, membership: "all" });
    expect(h.attribution.mock.calls.map((c) => c[1].membershipType)).toEqual([
      "research",
      "clinical",
    ]);
    expect(rows.map((r) => r.pmid)).toEqual(["100", "500"]);
    expect(rows[0].investigators.map((i) => i.line)).toEqual([
      "Nonmember, Zed",
      "Second, Bea - CPC",
      "First, Ann - CB",
    ]);
  });

  it("a credited member with no scholar row puts no CWID in any export cell", async () => {
    h.attribution.mockResolvedValue(
      attribution([
        {
          ...attributed("600", "2025-06-01", true, false, [
            ["aaa1001", "CB"],
            ["mmm0001", "CT"],
          ]),
          members: [
            { cwid: "aaa1001", name: "Ann First", programCode: "CB", tenureUnknown: false },
            // The base's placeholder: no scholar row → "Unknown author", never the cwid.
            { cwid: "mmm0001", name: UNKNOWN_AUTHOR_NAME, programCode: "CT", tenureUnknown: false },
          ],
        },
      ]),
    );
    h.pubs.mockResolvedValue([
      {
        pmid: "600",
        authors: [
          author("aaa1001", "Ann First", 1, { isFirst: true }),
          { ...author("mmm0001", "", 2), scholar: null },
        ],
      },
    ]);
    const { rows } = await loadPubCitationReport("ctr", P);
    expect(rows[0].investigators.map((i) => i.line)).toEqual(["First, Ann - CB"]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildPubCitationWorkbook(rows, P, NOW)) as unknown as ExcelJS.Buffer);
    const cells: string[] = [];
    wb.eachSheet((ws) => ws.eachRow((r) => r.eachCell((c) => void cells.push(String(c.value)))));
    expect(cells.some((c) => /aaa1001|mmm0001/.test(c))).toBe(false);
  });

  it("nothing kept → no detail query, no rows", async () => {
    h.attribution.mockResolvedValue(attribution([]));
    expect(await loadPubCitationReport("ctr", P)).toEqual({ rows: [], unknownTenure: 0 });
    expect(h.pubs).not.toHaveBeenCalled();
  });
});

describe("buildPubCitationWorkbook", () => {
  const row = (pmid: string, relevant: boolean | null): PubCitationRow => ({
    pmid,
    title: `Title ${pmid}`,
    journal: "J Synthetic",
    date: "2026-07-23",
    relevant,
    reason: relevant === null ? null : `Reason ${pmid}`,
    investigators: [
      { cwid: "tst0001", line: "Testperson, Alex - CB" },
      { cwid: "tst0002", line: "Other, Sam" },
    ],
  });
  const params: PubCitationParams = {
    start: "2026-01-01",
    end: "2026-08-12",
    asOf: "2026-08-12",
    membership: "research",
    relevance: "all",
  };

  async function load(buf: Buffer) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
    return wb;
  }

  it("EVAL's sheets and columns, one investigator per line, no CWID", async () => {
    const wb = await load(
      await buildPubCitationWorkbook(
        [row("1", true), row("2", false), row("3", null)],
        params,
        NOW,
        2,
      ),
    );
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      "Cancer Relevance = No",
      "Cancer Relevance = Yes",
      "Cancer Relevance = Not scored",
      "Criteria",
    ]);
    const yes = wb.getWorksheet("Cancer Relevance = Yes")!;
    expect((yes.getRow(1).values as unknown[]).slice(1)).toEqual([...PUB_CITATION_COLUMNS]);
    expect(PUB_CITATION_COLUMNS.some((c) => /cwid/i.test(c))).toBe(false);
    const values = (yes.getRow(2).values as unknown[]).slice(1);
    expect(values).toEqual([
      "Title 1",
      "Testperson, Alex - CB\nOther, Sam",
      "J Synthetic",
      d("2026-07-23"),
      "Yes",
      "1",
      "Reason 1",
    ]);
    expect(yes.getColumn(4).numFmt).toBe("dd mmm yyyy");
    const cells: string[] = [];
    wb.eachSheet((ws) => ws.eachRow((r) => r.eachCell((c) => void cells.push(String(c.value)))));
    expect(cells.some((c) => c.includes("tst000"))).toBe(false);
    expect(yes.getRow(1).font?.bold).toBe(true);
    const criteria = new Map<string, string>();
    wb.getWorksheet("Criteria")!.eachRow((r) =>
      criteria.set(String(r.getCell(1).value), String(r.getCell(2).value)),
    );
    expect(criteria.get("Members as of")).toBe("2026-08-12");
    expect(criteria.get("Program")).toBe("Each member's current program");
    expect(criteria.get("Publications included")).toBe("All");
    expect(criteria.get("Included on unknown WCM tenure")).toBe("2");
  });

  it("a relevant-only filter with no rows still gives the Yes sheet", async () => {
    for (const relevance of ["relevant", "reviews"] as const) {
      const wb = await load(await buildPubCitationWorkbook([], { ...params, relevance }, NOW));
      expect(wb.worksheets.map((w) => w.name)).toEqual(["Cancer Relevance = Yes", "Criteria"]);
      const criteria: string[] = [];
      wb.getWorksheet("Criteria")!.eachRow((r) => void criteria.push(String(r.getCell(2).value)));
      expect(criteria).toContain(
        relevance === "relevant" ? "Cancer-relevant, excluding reviews" : "Cancer-relevant reviews",
      );
    }
  });
});
