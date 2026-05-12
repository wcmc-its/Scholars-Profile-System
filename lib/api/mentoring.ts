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
  journal: string | null;
  year: number | null;
};

/** Per-pmid author row from `analysis_summary_author_list`. Carries the
 *  CWID for any WCM-affiliated author so callers can bold / link them. */
export type CoPublicationAuthor = {
  rank: number;
  lastName: string;
  firstName: string | null;
  personIdentifier: string | null;
};

/** Full publication record for the dedicated co-pubs page (#184). Richer
 *  than `CoPublication` (which is what the chip popover needs) — adds
 *  journal / doi / pmcid + structured author list for the page and
 *  exports. */
export type CoPublicationFull = {
  pmid: number;
  title: string;
  journal: string | null;
  year: number | null;
  doi: string | null;
  pmcid: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  citationCount: number;
  authors: CoPublicationAuthor[];
};

export type MenteeChip = {
  cwid: string;
  fullName: string;
  programType: string | null;
  graduationYear: number | null;
  /** Total number of publications co-authored by the mentor and this mentee.
   *  Drives the "N co-pubs" badge. Sourced from ReCiterDB's
   *  `analysis_summary_author` so the count includes pubs attributed to
   *  alumni mentees not present in the local Scholar table. */
  copublicationCount: number;
  /** Preview rows shown when the inline chip is expanded (#185). Top 3 by
   *  year desc, pmid desc. Includes journal so the inline list can render
   *  "Journal · Year" without an extra fetch. Empty when count is 0. The
   *  dedicated co-pubs page (#184) holds the full list; the chip surface
   *  only ships the preview. */
  copublicationPreview: CoPublication[];
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
  // Scholar; ~75% of co-pub-bearing mentees are unlinked alumni with no
  // local Scholar row (see GH #181 investigation), so querying ReCiter
  // directly is load-bearing.
  //
  // Two outputs per mentee: a total count for the badge, and a top-3
  // preview for the inline chip expansion (#185). The full list lives on
  // the dedicated /co-pubs/<menteeCwid> page (#184).
  const copubCountByCwid = new Map<string, number>();
  const copubPreviewByCwid = new Map<string, CoPublication[]>();
  await withReciterConnection(async (conn) => {
    const rows = (await conn.query(
      `SELECT DISTINCT a2.personIdentifier AS mentee_cwid,
              a1.pmid AS pmid,
              art.articleTitle AS title,
              art.journalTitleVerbose AS journal,
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
    )) as {
      mentee_cwid: string;
      pmid: number | bigint;
      title: string;
      journal: string | null;
      year: number | null;
    }[];
    for (const r of rows) {
      copubCountByCwid.set(
        r.mentee_cwid,
        (copubCountByCwid.get(r.mentee_cwid) ?? 0) + 1,
      );
      const preview = copubPreviewByCwid.get(r.mentee_cwid) ?? [];
      if (preview.length < 3) {
        preview.push({
          pmid: typeof r.pmid === "bigint" ? Number(r.pmid) : r.pmid,
          title: r.title,
          journal: r.journal,
          year: r.year,
        });
        copubPreviewByCwid.set(r.mentee_cwid, preview);
      }
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
      copublicationCount: copubCountByCwid.get(c.cwid) ?? 0,
      copublicationPreview: copubPreviewByCwid.get(c.cwid) ?? [],
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

/**
 * Returns the full set of publications co-authored by `mentorCwid` and
 * `menteeCwid`, ordered newest first. Sources from ReCiterDB's
 * `analysis_summary_article` for citation fields and
 * `analysis_summary_author_list` for the structured author list (so we
 * can render and bold WCM-affiliated authors).
 *
 * Returns an empty array when no co-authored publications exist — drift
 * is possible between this query and the badge count (e.g. an alumnus
 * mentee is in the count query but not in the author-list table for a
 * given pmid); the page surfaces that case via its empty state.
 */
export async function getCoPublications(
  mentorCwid: string,
  menteeCwid: string,
): Promise<CoPublicationFull[]> {
  if (!mentorCwid || !menteeCwid || mentorCwid === menteeCwid) return [];

  return await withReciterConnection(async (conn) => {
    // Step 1: intersection of pmids the mentor + mentee both authored.
    // Newest first; pmid desc as tiebreaker so order is stable across
    // requests when several pubs share a year.
    type ArticleRow = {
      pmid: number | bigint;
      title: string | null;
      journal: string | null;
      year: number | null;
      doi: string | null;
      pmcid: string | null;
      volume: string | null;
      issue: string | null;
      pages: string | null;
      citationCount: number | null;
    };
    const articleRows = (await conn.query(
      `SELECT art.pmid          AS pmid,
              art.articleTitle  AS title,
              art.journalTitleVerbose AS journal,
              art.articleYear   AS year,
              art.doi           AS doi,
              art.pmcid         AS pmcid,
              art.volume        AS volume,
              art.issue         AS issue,
              art.pages         AS pages,
              art.citationCountScopus AS citationCount
         FROM analysis_summary_author a1
         JOIN analysis_summary_author a2
           ON a1.pmid = a2.pmid
         JOIN analysis_summary_article art
           ON art.pmid = a1.pmid
        WHERE a1.personIdentifier = ?
          AND a2.personIdentifier = ?
        ORDER BY art.articleYear DESC, art.pmid DESC`,
      [mentorCwid, menteeCwid],
    )) as ArticleRow[];

    if (articleRows.length === 0) return [];

    const pmids = articleRows.map((r) =>
      typeof r.pmid === "bigint" ? Number(r.pmid) : r.pmid,
    );

    // Step 2: full author list per pmid (one round-trip, batched).
    type AuthorRow = {
      pmid: number | bigint;
      rank: number;
      authorLastName: string | null;
      authorFirstName: string | null;
      personIdentifier: string | null;
    };
    const authorRows = (await conn.query(
      `SELECT pmid, rank, authorLastName, authorFirstName, personIdentifier
         FROM analysis_summary_author_list
        WHERE pmid IN (${pmids.map(() => "?").join(",")})
        ORDER BY pmid, rank`,
      pmids,
    )) as AuthorRow[];

    const authorsByPmid = new Map<number, CoPublicationAuthor[]>();
    for (const r of authorRows) {
      const pmid = typeof r.pmid === "bigint" ? Number(r.pmid) : r.pmid;
      const list = authorsByPmid.get(pmid) ?? [];
      list.push({
        rank: r.rank,
        lastName: r.authorLastName ?? "",
        firstName: r.authorFirstName,
        personIdentifier: r.personIdentifier,
      });
      authorsByPmid.set(pmid, list);
    }

    return articleRows.map<CoPublicationFull>((r) => {
      const pmid = typeof r.pmid === "bigint" ? Number(r.pmid) : r.pmid;
      return {
        pmid,
        title: r.title ?? "",
        journal: r.journal,
        year: r.year,
        doi: r.doi,
        pmcid: r.pmcid,
        volume: r.volume,
        issue: r.issue,
        pages: r.pages,
        citationCount: r.citationCount ?? 0,
        authors: authorsByPmid.get(pmid) ?? [],
      };
    });
  });
}

/**
 * Validates that `menteeCwid` is actually one of `mentorCwid`'s recorded
 * mentees and returns mentor + mentee display names. Used by the co-pubs
 * page (#184) to 404 on stray URLs. Returns `null` when the relationship
 * doesn't exist in `reporting_students_mentors`.
 */
export async function getMentorMenteePair(
  mentorCwid: string,
  menteeCwid: string,
): Promise<{ mentorName: string; menteeName: string } | null> {
  if (!mentorCwid || !menteeCwid) return null;

  type Row = {
    studentFirstName: string | null;
    studentLastName: string | null;
  };
  const rows = await withReciterConnection(async (conn) => {
    return (await conn.query(
      `SELECT studentFirstName, studentLastName
         FROM reporting_students_mentors
        WHERE mentorCWID = ? AND studentCWID = ?
        LIMIT 1`,
      [mentorCwid, menteeCwid],
    )) as Row[];
  });
  if (rows.length === 0) return null;

  const r = rows[0]!;
  const menteeName = [r.studentFirstName, r.studentLastName]
    .filter(Boolean)
    .join(" ")
    .trim() || menteeCwid;

  // Mentor display name comes from the local Scholar table; the mentor
  // is on a scholar profile page so they're always present there.
  const mentor = await prisma.scholar.findUnique({
    where: { cwid: mentorCwid },
    select: { preferredName: true, postnominal: true },
  });
  const mentorName = mentor
    ? mentor.postnominal
      ? `${mentor.preferredName}, ${mentor.postnominal}`
      : mentor.preferredName
    : mentorCwid;

  return { mentorName, menteeName };
}
