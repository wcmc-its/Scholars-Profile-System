/**
 * Golden dump of the three report workbooks (reports 7, 8 and 9): every
 * sheet's name and order, frozen panes, column widths / alignment / number
 * format, and every row's values and font, read back with exceljs. Pins the
 * shared `lib/edit/report-xlsx.ts` helpers to the output the hand-rolled
 * builders produced, including report 9's People sheet withheld above
 * `SCHOLAR_EXPORT_CAP` and both list-cap notes. Fixture people are invented.
 */
import ExcelJS from "exceljs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} }, prisma: {} }));

import { SCHOLAR_EXPORT_CAP } from "@/lib/api/export-scholars";
import {
  buildArticleCountWorkbook,
  parseArticleCountParams,
} from "@/lib/edit/article-count-report";
import {
  buildHighImpactWorkbook,
  HIGH_IMPACT_LIST_CAP,
  parseHighImpactParams,
  type HighImpactRow,
} from "@/lib/edit/high-impact-pubs-report";
import type { MentoredPublicationsReport } from "@/lib/edit/mentored-publications-report";
import { buildMentoredPublicationsWorkbook } from "@/lib/edit/mentored-publications-xlsx";

const AT = new Date("2026-09-24T00:00:00Z");

async function dump(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  return wb.worksheets.map((ws) => ({
    name: ws.name,
    views: ws.views,
    columns: Array.from({ length: ws.columnCount }, (_, i) => {
      const c = ws.getColumn(i + 1);
      return { width: c.width, alignment: c.alignment, numFmt: c.numFmt };
    }),
    rows: Array.from({ length: ws.rowCount }, (_, i) => {
      const r = ws.getRow(i + 1);
      return { values: (r.values as unknown[]).slice(1), font: r.font };
    }),
  }));
}

function highImpactRow(pmid: string, cwids: string[]): HighImpactRow {
  return {
    pmid,
    title: `Title ${pmid}`,
    journal: "N Engl J Med",
    year: 2026,
    articleType: "Academic Article",
    jif: 96.2,
    dateAdded: "2026-03-05",
    citations: 4,
    doi: `10.1/${pmid}`,
    cite: "2026;1(1):1-2.",
    id: { label: "PMID", value: pmid, href: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` },
    byline: [],
    authors: cwids.map((c, i) => `${c.toUpperCase()} (${i === 0 ? "first" : "last"} author)`),
    people: cwids.map((c, i) => ({
      cwid: c,
      name: c.toUpperCase(),
      department: "Medicine",
      personType: "Full-time faculty",
      position: i === 0 ? ("first" as const) : ("last" as const),
    })),
  };
}

describe("report workbooks (golden)", () => {
  const labels = new Map([["dept:MED", "Medicine"]]);

  it("report 9: all three sheets within the caps", async () => {
    const p = parseHighImpactParams(new URLSearchParams("unit=dept:MED"));
    const list = [highImpactRow("1", ["aaa0001", "bbb0002"]), highImpactRow("2", ["bbb0002"])];
    expect(await dump(await buildHighImpactWorkbook(p, 2, list, AT, labels))).toMatchSnapshot();
  });

  it("report 9: above SCHOLAR_EXPORT_CAP the People sheet is withheld", async () => {
    const p = parseHighImpactParams(new URLSearchParams());
    const cwids = Array.from(
      { length: SCHOLAR_EXPORT_CAP + 1 },
      (_, i) => `ppp${String(i).padStart(4, "0")}`,
    );
    const list = [highImpactRow("1", cwids)];
    const sheets = await dump(await buildHighImpactWorkbook(p, 1, list, AT));
    expect(sheets.map((s) => s.name)).toEqual(["People", "Publications", "Criteria"]);
    expect(sheets[0].rows).toHaveLength(1);
    expect(sheets).toMatchSnapshot();
  });

  it("report 9: above the list cap People and Publications are one-line notes", async () => {
    const p = parseHighImpactParams(new URLSearchParams());
    expect(
      await dump(await buildHighImpactWorkbook(p, HIGH_IMPACT_LIST_CAP + 1, null, AT)),
    ).toMatchSnapshot();
  });

  it("report 8: Counts, Criteria and Articles", async () => {
    const p = parseArticleCountParams(
      new URLSearchParams("basis=fy&jif=5&pos=first&from=2024&to=2025&unit=dept:MED"),
    );
    const article = {
      pmid: "100",
      citation: "Smith JA. A title. J Test. 2024.",
      journal: "J Test",
      year: 2024,
      articleType: "Review",
      jif: 12.5,
      dateAdded: "2024-03-05",
      doi: "10.1/x",
      scholars: ["Jane Smith (jas2001), Postdoc, Medicine, first author"],
      title: "A title.",
      authors: ["Smith JA"],
      matches: [{ cwid: "jas2001", name: "Jane Smith", rank: 1 }],
      source: "2024",
      id: { label: "PMID", value: "100", href: "https://pubmed.ncbi.nlm.nih.gov/100/" },
    };
    const rows = [
      { year: 2024, count: 3 },
      { year: 2025, count: 4 },
    ];
    expect(
      await dump(await buildArticleCountWorkbook(p, rows, 7, AT, [article], labels)),
    ).toMatchSnapshot();
  });

  it("report 8: over the list cap the Articles sheet is a note", async () => {
    const p = parseArticleCountParams(new URLSearchParams("from=2024&to=2025"));
    expect(
      await dump(await buildArticleCountWorkbook(p, [{ year: 2024, count: 6000 }], 6000, AT, null)),
    ).toMatchSnapshot();
  });

  it("report 7: Summary, Raw Data and Query & Assumptions", async () => {
    const mentor = {
      cwid: "men0001",
      name: "Zed Mentor",
      department: "Medicine",
      institution: "WCM",
      mentorship: { program: "md", source: "roster", tier: "confirmed" } as const,
    };
    const report: MentoredPublicationsReport = {
      generatedAt: AT,
      filters: { scopes: ["md"], types: ["aoc"], gradYears: [2025], tail: 1, pubs: "mentored" },
      allPubsLoaded: null,
      droppedUnresolved: 0,
      droppedNoCwid: 0,
      droppedNoCwidMentees: [],
      publications: [],
      summary: [
        {
          gradYear: 2025,
          entryYear: 2021,
          entryYearSource: "fallback",
          cwid: "stu0001",
          firstName: "Ada",
          lastName: "Learner",
          program: "MD",
          mentors: [mentor],
          pubsInWindow: 1,
          withMentorInWindow: 1,
          pubsAllTime: 1,
          highImpactInWindow: 0,
          firstAuthorInWindow: 1,
        },
      ],
      detail: [
        {
          gradYear: 2025,
          entryYear: 2021,
          program: "MD",
          learnerCwid: "stu0001",
          learnerFirstName: "Ada",
          learnerLastName: "Learner",
          mentorCwid: "men0001",
          mentorName: "Zed Mentor",
          mentorDepartment: "Medicine",
          mentorInstitution: "WCM",
          mentorship: "MD",
          paperMentors: [mentor],
          withMentor: true,
          pmid: "7",
          title: "A title",
          journal: "J Test",
          jif: 3.1,
          year: 2023,
          dateAdded: new Date("2023-05-01T00:00:00Z"),
          citations: 2,
          learnerAuthorPosition: 1,
          authorCount: 3,
          inWindow: true,
        },
      ],
    };
    expect(await dump(await buildMentoredPublicationsWorkbook(report))).toMatchSnapshot();
  });
});
