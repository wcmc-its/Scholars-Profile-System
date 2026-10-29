/**
 * Report 18 — Publication citation report: params, the investigator line,
 * program-as-of-the-publication-date, the loader's scope, and EVAL's
 * workbook shape (no CWID anywhere in it). Every person here is invented.
 */
import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  members: vi.fn(),
  pubs: vi.fn(),
  relevance: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      centerMembership: { findMany: h.members },
      publication: { findMany: h.pubs },
      centerPublicationRelevance: { findMany: h.relevance },
    },
  },
}));

import {
  buildPubCitationWorkbook,
  investigatorLine,
  lastFirst,
  parsePubCitationParams,
  programAsOf,
  PUB_CITATION_COLUMNS,
  type PubCitationRow,
} from "@/lib/edit/pub-citation-report";
import { loadPubCitationReport } from "@/lib/edit/pub-citation-report.server";

const NOW = new Date("2026-10-29T12:00:00Z");
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe("parsePubCitationParams", () => {
  it("defaults to this year to date, research members, relevant only", () => {
    expect(parsePubCitationParams(new URLSearchParams(), NOW)).toEqual({
      start: "2026-01-01",
      end: "2026-10-29",
      membership: "research",
      relevance: "yes",
    });
  });

  it("reads valid values and drops bad ones", () => {
    const sp = new URLSearchParams({
      start: "2025-01-01",
      end: "2025-13-45",
      membership: "clinical",
      relevance: "all",
    });
    expect(parsePubCitationParams(sp, NOW)).toEqual({
      start: "2025-01-01",
      end: "2026-10-29",
      membership: "clinical",
      relevance: "all",
    });
    expect(parsePubCitationParams(new URLSearchParams({ membership: "x" }), NOW).membership).toBe(
      "research",
    );
  });
});

describe("investigator line", () => {
  it("is Last, First - PROGRAM, or the bare name without a program", () => {
    expect(lastFirst("Alex B. Testperson")).toBe("Testperson, Alex B.");
    expect(lastFirst("Mononym")).toBe("Mononym");
    expect(investigatorLine("Alex B. Testperson", "CB")).toBe("Testperson, Alex B. - CB");
    expect(investigatorLine("Alex B. Testperson", null)).toBe("Testperson, Alex B.");
  });

  it("carries the program only while the stint covers the date", () => {
    const stint = {
      programCode: "CT",
      startDate: d("2025-03-01"),
      endDate: d("2025-12-31"),
      membershipRoleKey: null,
    };
    expect(programAsOf(stint, "2025-03-01")).toBe("CT");
    expect(programAsOf(stint, "2025-12-31")).toBe("CT");
    expect(programAsOf(stint, "2025-02-28")).toBeNull();
    expect(programAsOf(stint, "2026-01-01")).toBeNull();
    expect(programAsOf({ ...stint, startDate: null, endDate: null }, "2001-01-01")).toBe("CT");
    expect(programAsOf({ ...stint, membershipRoleKey: "invited" }, "2025-06-01")).toBeNull();
    expect(programAsOf(undefined, "2025-06-01")).toBeNull();
  });
});

const member = (
  cwid: string,
  type: "research" | "clinical",
  programCode: string,
  start: string | null,
  end: string | null,
) => ({
  cwid,
  membershipType: type,
  programCode,
  startDate: start ? d(start) : null,
  endDate: end ? d(end) : null,
  membershipRoleKey: null,
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

describe("loadPubCitationReport", () => {
  beforeEach(() => {
    h.members.mockResolvedValue([
      member("aaa1001", "research", "CB", "2025-01-01", null),
      member("bbb1002", "research", "CT", "2025-06-01", null),
      member("ccc1003", "clinical", "CPC", null, null),
    ]);
    h.pubs.mockResolvedValue([
      {
        pmid: "100",
        title: "Tumor paper",
        journal: "J Synthetic Onc",
        dateAddedToEntrez: d("2025-03-10"),
        authors: [
          author("bbb1002", "Bea Second", 0),
          author("zzz9999", "Zed Nonmember", 1, { isFirst: true }),
          author("aaa1001", "Ann First", 9, { isLast: true }),
          { ...author("nnn0000", "", 3), scholar: null },
        ],
      },
      {
        pmid: "200",
        title: "Review paper",
        journal: "Rev Synthetic",
        dateAddedToEntrez: d("2025-04-01"),
        authors: [author("aaa1001", "Ann First", 1)],
      },
      {
        // Only author is a research member whose stint starts after the date.
        pmid: "300",
        title: "Before stint",
        journal: null,
        dateAddedToEntrez: d("2025-02-01"),
        authors: [author("bbb1002", "Bea Second", 1)],
      },
    ]);
    h.relevance.mockResolvedValue([
      { pmid: "100", relevant: true, reason: "This is cancer relevant." },
      { pmid: "200", relevant: false, reason: "This is a review." },
      { pmid: "300", relevant: true, reason: "x" },
    ]);
  });

  it("keeps relevant pubs whose research author was in stint, programs as of the date", async () => {
    const rows = await loadPubCitationReport("ctr", {
      start: "2025-01-01",
      end: "2025-12-31",
      membership: "research",
      relevance: "yes",
    });
    expect(rows).toEqual([
      {
        pmid: "100",
        title: "Tumor paper",
        journal: "J Synthetic Onc",
        date: "2025-03-10",
        relevant: true,
        reason: "This is cancer relevant.",
        // Byline order; Bea is out of stint on 03-10 so carries no code; no scholar row → left out.
        investigators: [
          { cwid: "zzz9999", line: "Nonmember, Zed" },
          { cwid: "bbb1002", line: "Second, Bea" },
          { cwid: "aaa1001", line: "First, Ann - CB" },
        ],
      },
    ]);
    const where = h.pubs.mock.calls[0][0].where;
    expect(where.authors.some.cwid.in).toEqual(["aaa1001", "bbb1002"]);
    expect(where.dateAddedToEntrez).toEqual({ gte: d("2025-01-01"), lte: d("2025-12-31") });
  });

  it("relevance all keeps the No rows too", async () => {
    const rows = await loadPubCitationReport("ctr", {
      start: "2025-01-01",
      end: "2025-12-31",
      membership: "research",
      relevance: "all",
    });
    expect(rows.map((r) => r.pmid)).toEqual(["100", "200"]);
  });

  it("no member of the type → no query, no rows", async () => {
    h.members.mockResolvedValue([member("ccc1003", "clinical", "CPC", null, null)]);
    const rows = await loadPubCitationReport("ctr", {
      start: "2025-01-01",
      end: "2025-12-31",
      membership: "research",
      relevance: "yes",
    });
    expect(rows).toEqual([]);
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
  const params = {
    start: "2026-01-01",
    end: "2026-08-12",
    membership: "research",
    relevance: "all",
  } as const;

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
  });

  it("relevance yes with no rows still gives the Yes sheet", async () => {
    const wb = await load(await buildPubCitationWorkbook([], { ...params, relevance: "yes" }, NOW));
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Cancer Relevance = Yes", "Criteria"]);
  });
});
