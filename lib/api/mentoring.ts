/**
 * Mentoring data: AOC mentor↔mentee relationships from
 * `reciterdb.reporting_students_mentors`, joined with the local Scholar table
 * for profile linkage and with `publication_author` for co-authored publication
 * counts.
 *
 * v1 source: AOC only. Jenzabar source (broader mentor relationships including
 * non-AOC PhD thesis advisors and MD program mentors) is pending access — when
 * available, add a second source here under the same shape.
 *
 * Spec: .planning/drafts/issue-trainee-profiles-mentoring.md (v2b — Mentoring
 * section on researcher profiles).
 */
import { prisma } from "@/lib/db";
import { identityImageEndpoint } from "@/lib/headshot";
import { withReciterConnection } from "@/lib/sources/reciterdb";

export type CoPublication = {
  pmid: number;
  title: string;
  year: number | null;
};

export type MenteeChip = {
  cwid: string;
  fullName: string;
  programType: string | null;
  graduationYear: number | null;
  /** Publications co-authored by the mentor and this mentee, newest first.
   *  Sourced from ReCiterDB's `analysis_summary_author`, so includes
   *  publications attributed to alumni mentees not present in the local
   *  Scholar table. Empty when there are no co-pubs. */
  copublications: CoPublication[];
  /** Same shape the avatar pipeline expects (string, possibly empty). The
   *  headshot avatar component falls back to initials when the endpoint
   *  returns 404, so passing the constructed URL here is safe even for
   *  mentees who do not appear in our Scholar table. */
  identityImageEndpoint: string;
  /** Populated when the mentee exists in our local Scholar table. Drives whether
   *  the chip is rendered as a link to a profile page. Per spec, alumni do not
   *  get profiles — those entries render as unlinked. */
  scholar: {
    slug: string;
    publishedName: string;
    primaryDepartment: string | null;
    roleCategory: string | null;
  } | null;
};

type AocRow = {
  studentCWID: string;
  studentFirstName: string | null;
  studentLastName: string | null;
  studentGraduationYear: number | null;
  programType: string | null;
};

/**
 * Returns all known mentees for the given mentor CWID, sorted by graduation
 * year descending (most recent first), then by name. Multiple AOC project
 * rows for the same student are collapsed to a single chip.
 *
 * Returns an empty array if the mentor has no recorded relationships.
 */
export async function getMenteesForMentor(mentorCwid: string): Promise<MenteeChip[]> {
  if (!mentorCwid) return [];

  const aocRows = await withReciterConnection(async (conn) => {
    return (await conn.query(
      `SELECT studentCWID, studentFirstName, studentLastName, studentGraduationYear, programType
       FROM reporting_students_mentors
       WHERE mentorCWID = ? AND studentCWID IS NOT NULL AND studentCWID != ''`,
      [mentorCwid],
    )) as AocRow[];
  });

  if (aocRows.length === 0) return [];

  // Collapse to one row per studentCWID. Preserve the most recent
  // graduationYear and any programType we saw (a student can appear under
  // both "AOC" and "AOC-2025" — keep the more specific one if present).
  type Collapsed = {
    cwid: string;
    fullName: string;
    programType: string | null;
    graduationYear: number | null;
  };
  const byCwid = new Map<string, Collapsed>();
  for (const r of aocRows) {
    const cwid = r.studentCWID;
    const fullName = [r.studentFirstName, r.studentLastName].filter(Boolean).join(" ").trim() || cwid;
    const existing = byCwid.get(cwid);
    if (!existing) {
      byCwid.set(cwid, {
        cwid,
        fullName,
        programType: r.programType,
        graduationYear: r.studentGraduationYear,
      });
    } else {
      // Keep the higher graduation year; prefer a more specific programType
      // string (longer = more specific, e.g. "AOC-2025" over "AOC").
      if (r.studentGraduationYear && (existing.graduationYear ?? 0) < r.studentGraduationYear) {
        existing.graduationYear = r.studentGraduationYear;
      }
      if (
        r.programType &&
        (!existing.programType || r.programType.length > existing.programType.length)
      ) {
        existing.programType = r.programType;
      }
    }
  }

  const cwids = [...byCwid.keys()];

  // Co-publications per mentee — sourced from ReCiterDB's authoritative
  // attribution (`analysis_summary_author`), not the local publication_author
  // table. Local attribution only carries CWIDs we've explicitly pulled into
  // Scholar; ~75% of co-pub-bearing mentees are unlinked alumni with no local
  // Scholar row (see GH #181 investigation), so querying ReCiter directly is
  // load-bearing. Returns full rows (pmid, title, year) — the popover renders
  // them inline and derives the count from the array length.
  const copubByCwid = new Map<string, CoPublication[]>();
  await withReciterConnection(async (conn) => {
    const rows = (await conn.query(
      `SELECT DISTINCT a2.personIdentifier AS mentee_cwid,
              a1.pmid AS pmid,
              art.articleTitle AS title,
              art.articleYear AS year
         FROM analysis_summary_author a1
         JOIN analysis_summary_author a2
           ON a1.pmid = a2.pmid AND a2.personIdentifier != a1.personIdentifier
         JOIN analysis_summary_article art
           ON art.pmid = a1.pmid
        WHERE a1.personIdentifier = ?
          AND a2.personIdentifier IN (${cwids.map(() => "?").join(",")})
        ORDER BY a2.personIdentifier, art.articleYear DESC, a1.pmid DESC`,
      [mentorCwid, ...cwids],
    )) as { mentee_cwid: string; pmid: number | bigint; title: string; year: number | null }[];
    for (const r of rows) {
      const list = copubByCwid.get(r.mentee_cwid) ?? [];
      list.push({
        pmid: typeof r.pmid === "bigint" ? Number(r.pmid) : r.pmid,
        title: r.title,
        year: r.year,
      });
      copubByCwid.set(r.mentee_cwid, list);
    }
  });

  // Scholar-table presence — drives linkability. Non-deleted, active rows only.
  // Only `status='active'` rows can be linked. Suppressed scholars (alumni
  // mentees ingested for pub attribution but with no public profile per spec)
  // are intentionally excluded here so they render as unlinked chips.
  const scholars = await prisma.scholar.findMany({
    where: { cwid: { in: cwids }, deletedAt: null, status: "active" },
    select: {
      cwid: true,
      slug: true,
      preferredName: true,
      postnominal: true,
      primaryDepartment: true,
      roleCategory: true,
    },
  });
  const scholarByCwid = new Map(scholars.map((s) => [s.cwid, s]));

  const chips: MenteeChip[] = [];
  for (const c of byCwid.values()) {
    const s = scholarByCwid.get(c.cwid);
    chips.push({
      cwid: c.cwid,
      fullName: c.fullName,
      programType: c.programType,
      graduationYear: c.graduationYear,
      copublications: copubByCwid.get(c.cwid) ?? [],
      identityImageEndpoint: identityImageEndpoint(c.cwid),
      scholar: s
        ? {
            slug: s.slug,
            publishedName: s.postnominal
              ? `${s.preferredName}, ${s.postnominal}`
              : s.preferredName,
            primaryDepartment: s.primaryDepartment,
            roleCategory: s.roleCategory,
          }
        : null,
    });
  }

  chips.sort((a, b) => {
    const ay = a.graduationYear ?? 0;
    const by = b.graduationYear ?? 0;
    if (ay !== by) return by - ay;
    return a.fullName.localeCompare(b.fullName);
  });

  return chips;
}
