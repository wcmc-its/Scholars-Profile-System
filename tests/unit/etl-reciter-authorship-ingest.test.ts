/**
 * #1052 — doctoral-student co-author authorships flow into PublicationAuthor.
 *
 * Pure-logic test of the two seams the reciter ETL keys off `ourCwidSet`:
 *   1. INGESTION_SCHOLAR_WHERE — the scholar-selection `where`. Must keep the
 *      existing active set AND add every doctoral student (roleCategory prefix),
 *      including soft-deleted ones, with NO `status` gate on that branch (the
 *      `status` column is corrupt for many students — gating on it is the #1050
 *      bug).
 *   2. buildAuthorshipRows — the row builder. A co-author in the ingestion set
 *      yields a publication_author row; one outside it is dropped (gate
 *      unchanged). Together: a soft-deleted doctoral student is in the set via
 *      INGESTION_SCHOLAR_WHERE, so their authorship survives.
 *
 * The ETL's `main()` is guarded by `!process.env.VITEST`, so importing the
 * module here runs no ReciterDB sync.
 */
import { describe, expect, it } from "vitest";

import { Prisma } from "@/lib/generated/prisma/client";
import { INGESTION_SCHOLAR_WHERE, buildAuthorshipRows } from "@/etl/reciter/index";

describe("INGESTION_SCHOLAR_WHERE (#1052)", () => {
  const branches = INGESTION_SCHOLAR_WHERE.OR as Prisma.ScholarWhereInput[];

  it("is an OR of exactly two branches", () => {
    expect(branches).toHaveLength(2);
  });

  it("keeps the existing active, non-deleted scholar set", () => {
    expect(branches).toContainEqual({ deletedAt: null, status: "active" });
  });

  it("adds every doctoral student by roleCategory prefix (incl. soft-deleted)", () => {
    expect(branches).toContainEqual({
      roleCategory: { startsWith: "doctoral_student" },
    });
  });

  it("does NOT gate the doctoral-student branch on status or deletedAt (#1050 regression guard)", () => {
    const studentBranch = branches.find((b) => "roleCategory" in b);
    expect(studentBranch).toBeDefined();
    expect(studentBranch).not.toHaveProperty("status");
    expect(studentBranch).not.toHaveProperty("deletedAt");
  });
});

describe("buildAuthorshipRows (#1052)", () => {
  const PMID = 39843675; // spot-check PMID from the handoff
  const STUDENT = "bjg4001"; // Benjamin Grant — a doctoral-student co-author
  const MENTOR = "men1001";

  /** Two ReciterDB authorship rows for one paper: student first, mentor last. */
  const authorRows = [
    { personIdentifier: STUDENT, pmid: PMID, authorPosition: "first", authors: "Grant B, Mentor A" },
    { personIdentifier: MENTOR, pmid: PMID, authorPosition: "last", authors: "Grant B, Mentor A" },
  ];

  it("emits a publication_author row for a doctoral-student co-author in the ingestion set", () => {
    // A soft-deleted doctoral student lands in ourCwidSet via INGESTION_SCHOLAR_WHERE.
    const ourCwidSet = new Set([STUDENT, MENTOR]);
    const rows = buildAuthorshipRows(authorRows, ourCwidSet, new Map(), new Map());

    const studentRow = rows.find((r) => r.cwid === STUDENT);
    expect(studentRow).toBeDefined();
    expect(studentRow!.pmid).toBe(String(PMID));
    expect(studentRow!.isConfirmed).toBe(true);
  });

  it("drops authorships whose CWID is not in the ingestion set (gate unchanged)", () => {
    const ourCwidSet = new Set([MENTOR]); // student excluded
    const rows = buildAuthorshipRows(authorRows, ourCwidSet, new Map(), new Map());
    expect(rows.map((r) => r.cwid)).toEqual([MENTOR]);
  });

  it("preserves the #132 analysis_summary_author_list rank for position/flags", () => {
    const ourCwidSet = new Set([STUDENT, MENTOR]);
    const rankByPmidCwid = new Map([[`${PMID}|${MENTOR}`, 2]]);
    const totalAuthorsByPmidFromList = new Map([[PMID, 2]]);

    const rows = buildAuthorshipRows(
      authorRows,
      ourCwidSet,
      rankByPmidCwid,
      totalAuthorsByPmidFromList,
    );
    const mentorRow = rows.find((r) => r.cwid === MENTOR)!;
    expect(mentorRow.position).toBe(2);
    expect(mentorRow.isLast).toBe(true);
    expect(mentorRow.totalAuthors).toBe(2);
  });

  it("keeps ReCiter's co-first and co-last positions when the rank is known", () => {
    const rows = buildAuthorshipRows(
      [
        { personIdentifier: "aaa0001", pmid: PMID, authorPosition: "first", authors: "" },
        { personIdentifier: "aaa0002", pmid: PMID, authorPosition: "first", authors: "" },
        { personIdentifier: "aaa0003", pmid: PMID, authorPosition: null, authors: "" },
        { personIdentifier: "aaa0004", pmid: PMID, authorPosition: "last", authors: "" },
        { personIdentifier: "aaa0005", pmid: PMID, authorPosition: "last", authors: "" },
      ],
      new Set(["aaa0001", "aaa0002", "aaa0003", "aaa0004", "aaa0005"]),
      new Map([1, 2, 3, 4, 5].map((n) => [`${PMID}|aaa000${n}`, n])),
      new Map([[PMID, 5]]),
    );
    expect(rows.map((r) => [r.position, r.isFirst, r.isLast])).toEqual([
      [1, true, false],
      [2, true, false],
      [3, false, false],
      [4, false, true],
      [5, false, true],
    ]);
  });

  it("#101 — re-keys an external synthetic pmid to its stable article_id; PubMed passes through", () => {
    const EXT_PMID = -3; // reciterdb synthetic NEGATIVE pmid for an external pub
    const ARTICLE_ID = "SCOPUS:105037533819";
    const extRows = [
      { personIdentifier: MENTOR, pmid: EXT_PMID, authorPosition: "first", authors: "" },
      { personIdentifier: STUDENT, pmid: PMID, authorPosition: "last", authors: "Grant B" },
    ];
    const keyForPmid = (pmid: number) => (pmid === EXT_PMID ? ARTICLE_ID : String(pmid));

    const rows = buildAuthorshipRows(
      extRows,
      new Set([MENTOR, STUDENT]),
      new Map(),
      new Map(),
      keyForPmid,
    );
    // External authorship keyed on the stable article_id so it matches Publication.pmid.
    expect(rows.find((r) => r.cwid === MENTOR)!.pmid).toBe(ARTICLE_ID);
    // Real PubMed pmid unchanged.
    expect(rows.find((r) => r.cwid === STUDENT)!.pmid).toBe(String(PMID));
  });
});
