/**
 * Mentoring data — unions three sources of mentor↔mentee relationships:
 *
 *   1. `reciterdb.reporting_students_mentors` — MD-program scholarly-project
 *      mentors (AOC, AOC-2025, ECR, and a 2017 MDPHD snapshot). Live-queried.
 *
 *   2. Local `phd_mentor_relationship` — PhD thesis advisors from Jenzabar's
 *      `WCN_IDM_GS_ADVISOR_ADVISEE_View` (ADVISOR_TYPE='MAJSP'), populated by
 *      etl/jenzabar/index.ts. Materialized locally because Jenzabar is VPN-
 *      only and not designed for runtime traffic. programType is "PhD" or
 *      "MD-PhD", resolved at ETL time against Scholar.roleCategory.
 *
 *   3. Local `postdoc_mentor_relationship` — Postdoc supervisor relationships
 *      from ED's `weillCornellEduSORRoleRecord` under `ou=employees,ou=sors`
 *      filtered to postdoc role-code 06. Includes both active and expired
 *      records, so alumni postdocs appear alongside current ones (issue #183).
 *      programType is always "POSTDOC".
 *
 * Sources cover disjoint populations (MD vs PhD vs postdoc) so mentee
 * deduplication is per-CWID across all three — a CWID appearing in multiple
 * sources collapses to one chip with the most-specific programType preserved.
 *
 * All three feed `lib/publication_author` for co-authored publication counts.
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
  /** Degree-bucket label sourced from `reporting_students_mentors.programType`
   *  (AOC/MDPHD/ECR), `phd_mentor_relationship.programType` (PhD/MD-PhD), or
   *  `postdoc_mentor_relationship.programType` (POSTDOC). Used as the fallback
   *  subtitle when a finer-grained `programName` is not available. */
  programType: string | null;
  /** Issue #195 — human-readable program name (e.g. "Immunology & Microbial
   *  Pathogenesis"). Sourced from ED's `student_phd_program.program` first,
   *  Jenzabar's `phd_mentor_relationship.major_desc` second. Null when
   *  neither source has a record — UI then falls back to `programType`.
   *  Postdocs do not have program names. */
  programName: string | null;
  /** Year the mentee graduated — populated for AOC and Jenzabar PhD sources.
   *  Always null for postdocs (postdocs don't graduate; see appointmentRange). */
  graduationYear: number | null;
  /** Issue #183 — appointment window for postdoc mentees. Null for AOC and
   *  Jenzabar PhD mentees (which use `graduationYear` instead). `endYear=null`
   *  signals a currently-active postdoc; the chip subtitle renders "since
   *  {startYear}" in that case and "{startYear}–{endYear}" otherwise. */
  appointmentRange: {
    startYear: number;
    endYear: number | null;
  } | null;
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

/** Re-exported from the client-safe label module so server callers can
 *  pull everything they need from `@/lib/api/mentoring`. */
export { formatProgramLabel } from "@/lib/mentoring-labels";
import { formatProgramLabel } from "@/lib/mentoring-labels";
import { formatPublishedName } from "@/lib/postnominal";

/**
 * Returns all known mentees for the given mentor CWID. Multiple AOC project
 * rows for the same student are collapsed to a single chip.
 *
 * Sort order (issue #201): co-publication count desc, then terminal year
 * desc (graduation year for students; appointment end year for postdocs,
 * with active postdocs pinned to the top), then name. Surfaces the most
 * productive collaborations first — the answer the chip badges are
 * implicitly asking the reader to look for — while still landing recent
 * trainees above older ones within each co-pub tier.
 *
 * Slice B (#201 addendum) will make the sort param-driven for the
 * sort-control affordance at N ≥ 12; for Slice A the order here is the
 * single default rendered on every profile.
 *
 * Returns an empty array if the mentor has no recorded relationships.
 */
export async function getMenteesForMentor(mentorCwid: string): Promise<MenteeChip[]> {
  if (!mentorCwid) return [];

  const [aocRows, jenzabarRows, postdocRows] = await Promise.all([
    withReciterConnection(async (conn) => {
      return (await conn.query(
        `SELECT studentCWID, studentFirstName, studentLastName, studentGraduationYear, programType
         FROM reporting_students_mentors
         WHERE mentorCWID = ? AND studentCWID IS NOT NULL AND studentCWID != ''`,
        [mentorCwid],
      )) as AocRow[];
    }),
    prisma.phdMentorRelationship.findMany({
      where: { mentorCwid },
      select: {
        menteeCwid: true,
        menteeFirstName: true,
        menteeLastName: true,
        conferralYear: true,
        programType: true,
        majorDesc: true,
      },
    }),
    prisma.postdocMentorRelationship.findMany({
      where: { mentorCwid },
      select: {
        menteeCwid: true,
        menteeFirstName: true,
        menteeLastName: true,
        startDate: true,
        endDate: true,
        status: true,
        programType: true,
      },
    }),
  ]);

  if (aocRows.length === 0 && jenzabarRows.length === 0 && postdocRows.length === 0)
    return [];

  // Collapse to one row per mentee CWID across all three sources. Preserve
  // the most recent graduationYear and the most specific programType seen
  // (a student can appear under both "AOC" and "AOC-2025" — longer label =
  // more specific). Postdoc rows additionally carry an `appointmentRange`
  // since postdocs don't have a graduation year (issue #183).
  type Collapsed = {
    cwid: string;
    fullName: string;
    programType: string | null;
    graduationYear: number | null;
    appointmentRange: { startYear: number; endYear: number | null } | null;
  };
  const byCwid = new Map<string, Collapsed>();
  const upsert = (
    cwid: string,
    fullName: string,
    programType: string | null,
    graduationYear: number | null,
    appointmentRange: { startYear: number; endYear: number | null } | null = null,
  ) => {
    const existing = byCwid.get(cwid);
    if (!existing) {
      byCwid.set(cwid, {
        cwid,
        fullName,
        programType,
        graduationYear,
        appointmentRange,
      });
      return;
    }
    if (graduationYear && (existing.graduationYear ?? 0) < graduationYear) {
      existing.graduationYear = graduationYear;
    }
    if (
      programType &&
      (!existing.programType || programType.length > existing.programType.length)
    ) {
      existing.programType = programType;
    }
    // Postdoc range merge: prefer a currently-active appointment (endYear=null);
    // among ended ones, the most recently ended wins.
    if (appointmentRange) {
      const cur = existing.appointmentRange;
      const incomingIsActive = appointmentRange.endYear === null;
      const curIsActive = cur?.endYear === null;
      if (!cur) {
        existing.appointmentRange = appointmentRange;
      } else if (incomingIsActive && !curIsActive) {
        existing.appointmentRange = appointmentRange;
      } else if (
        !incomingIsActive &&
        !curIsActive &&
        (appointmentRange.endYear ?? 0) > (cur.endYear ?? 0)
      ) {
        existing.appointmentRange = appointmentRange;
      }
    }
  };
  for (const r of aocRows) {
    upsert(
      r.studentCWID,
      [r.studentFirstName, r.studentLastName].filter(Boolean).join(" ").trim() || r.studentCWID,
      r.programType,
      r.studentGraduationYear,
    );
  }
  for (const r of jenzabarRows) {
    upsert(
      r.menteeCwid,
      [r.menteeFirstName, r.menteeLastName].filter(Boolean).join(" ").trim() || r.menteeCwid,
      r.programType,
      r.conferralYear,
    );
  }
  for (const r of postdocRows) {
    const startYear = r.startDate ? r.startDate.getUTCFullYear() : null;
    // status=employee:active → render as "since {startYear}" regardless of
    // whether ED returned an explicit endDate. Expired rows use endDate's
    // year (null if ED omitted it, which the subtitle then renders as
    // "since {startYear}" too — degenerate but graceful).
    const isActive = r.status === "employee:active";
    const endYear = isActive ? null : r.endDate?.getUTCFullYear() ?? null;
    const range =
      startYear !== null
        ? { startYear, endYear }
        : null;
    upsert(
      r.menteeCwid,
      [r.menteeFirstName, r.menteeLastName].filter(Boolean).join(" ").trim() || r.menteeCwid,
      r.programType,
      null,
      range,
    );
  }

  const cwids = [...byCwid.keys()];

  // Issue #195 — Resolve program names. Precedence: ED `student_phd_program`
  // beats Jenzabar `phd_mentor_relationship.major_desc` (ED is the
  // authoritative curated source; Jenzabar fills the gap for pre-LDAP
  // alumni and off-cycle students).
  const programNameByCwid = new Map<string, string>();
  // Seed with Jenzabar majorDesc (lower precedence).
  for (const r of jenzabarRows) {
    const md = r.majorDesc?.trim();
    if (md) programNameByCwid.set(r.menteeCwid, md);
  }
  // Overlay ED student_phd_program rows (higher precedence).
  if (cwids.length > 0) {
    const edPrograms = await prisma.studentPhdProgram.findMany({
      where: { cwid: { in: cwids } },
      select: { cwid: true, program: true },
    });
    for (const r of edPrograms) {
      programNameByCwid.set(r.cwid, r.program);
    }
  }

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
      programName: programNameByCwid.get(c.cwid) ?? null,
      graduationYear: c.graduationYear,
      appointmentRange: c.appointmentRange,
      copublicationCount: copubCountByCwid.get(c.cwid) ?? 0,
      copublicationPreview: copubPreviewByCwid.get(c.cwid) ?? [],
      identityImageEndpoint: identityImageEndpoint(c.cwid),
      scholar: s
        ? {
            slug: s.slug,
            publishedName: formatPublishedName(s.preferredName, s.postnominal),
            primaryDepartment: s.primaryDepartment,
            roleCategory: s.roleCategory,
          }
        : null,
    });
  }

  // Issue #201 — sort by co-pub count desc to surface productive
  // collaborations first; tiebreak on terminal year desc so within a
  // co-pub tier the most recent trainees still cluster near the top,
  // then on name for full determinism.
  //
  // Terminal year: graduationYear for AOC/PhD mentees; appointment
  // endYear for postdocs (issue #183), with active postdocs
  // (endYear=null) pinned to the top via MAX_SAFE_INTEGER. Mixing across
  // types is intentional — a profile with both current postdocs and
  // recent graduates surfaces both together rather than clustering one
  // above the other.
  const terminalYear = (c: MenteeChip): number => {
    if (c.graduationYear) return c.graduationYear;
    if (c.appointmentRange) {
      return c.appointmentRange.endYear ?? Number.MAX_SAFE_INTEGER;
    }
    return 0;
  };
  chips.sort((a, b) => {
    const byCopubs = b.copublicationCount - a.copublicationCount;
    if (byCopubs !== 0) return byCopubs;
    const byYear = terminalYear(b) - terminalYear(a);
    if (byYear !== 0) return byYear;
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

  // Look in all three sources — AOC (ReCiterDB), Jenzabar PhD, and postdoc
  // (local Prisma). First hit wins for the mentee display name.
  type AocPairRow = { studentFirstName: string | null; studentLastName: string | null };
  const [aocRows, jenzabarRow, postdocRow] = await Promise.all([
    withReciterConnection(async (conn) => {
      return (await conn.query(
        `SELECT studentFirstName, studentLastName
           FROM reporting_students_mentors
          WHERE mentorCWID = ? AND studentCWID = ?
          LIMIT 1`,
        [mentorCwid, menteeCwid],
      )) as AocPairRow[];
    }),
    prisma.phdMentorRelationship.findFirst({
      where: { mentorCwid, menteeCwid },
      select: { menteeFirstName: true, menteeLastName: true },
    }),
    prisma.postdocMentorRelationship.findFirst({
      where: { mentorCwid, menteeCwid },
      select: { menteeFirstName: true, menteeLastName: true },
    }),
  ]);
  if (aocRows.length === 0 && !jenzabarRow && !postdocRow) return null;

  const first =
    aocRows[0]?.studentFirstName ??
    jenzabarRow?.menteeFirstName ??
    postdocRow?.menteeFirstName ??
    null;
  const last =
    aocRows[0]?.studentLastName ??
    jenzabarRow?.menteeLastName ??
    postdocRow?.menteeLastName ??
    null;
  const menteeName = [first, last].filter(Boolean).join(" ").trim() || menteeCwid;

  // Mentor display name comes from the local Scholar table; the mentor
  // is on a scholar profile page so they're always present there.
  const mentor = await prisma.scholar.findUnique({
    where: { cwid: mentorCwid },
    select: { preferredName: true, postnominal: true },
  });
  const mentorName = mentor
    ? formatPublishedName(mentor.preferredName, mentor.postnominal)
    : mentorCwid;

  return { mentorName, menteeName };
}

/** One (mentee, publication) tie for the mentor-level rollup at
 *  /scholars/<slug>/co-pubs. A publication co-authored with multiple
 *  mentees yields multiple entries — see issue #189 for the rationale
 *  (RPPR-style questions are per-program). */
export type MenteeCoPubEntry = {
  mentee: {
    cwid: string;
    fullName: string;
    graduationYear: number | null;
    programType: string | null;
    /** Populated when the mentee has an active Scholar row. Drives whether
     *  the mentee name in the meta line renders as a link. */
    scholar: { slug: string; publishedName: string } | null;
  };
  publication: CoPublicationFull;
};

export type MenteeCoPubGroup = {
  /** Display label for the group heading. From `formatProgramLabel`; an
   *  "Other mentees" bucket catches mentees whose programType is null or
   *  doesn't map cleanly (drift). */
  programLabel: string;
  /** Entries within the group, sorted by publication year desc, pmid desc. */
  entries: MenteeCoPubEntry[];
};

/** Stable identifier for deduping "the same publication across export
 *  runs". PMID when available — preprints / in-press / non-indexed venues
 *  with no PMID fall back to a sha1 of `doi || normalizedTitle`.
 *
 *  Used by the CSV `copub_id` column. Determinism is the contract: a
 *  faculty member regenerating an export next quarter must get the same
 *  IDs for unchanged publications so they can diff against last quarter. */
export function copubId(p: CoPublicationFull): string {
  if (p.pmid && p.pmid > 0) return String(p.pmid);
  const doi = (p.doi ?? "").trim().toLowerCase();
  const normalizedTitle = (p.title ?? "")
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const seed = doi || normalizedTitle;
  return `nopmid_${sha1Hex(seed)}`;
}

function sha1Hex(input: string): string {
  // Node crypto is always available server-side. Async vs sync: the sync
  // API is fine here because copubId is called per-row during render /
  // export, not on a hot path.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return createHash("sha1").update(input).digest("hex");
}

/**
 * Returns every (mentee, publication) tie for `mentorCwid`, grouped by
 * `formatProgramLabel(programType)`. Powers the mentor-level rollup at
 * /scholars/<slug>/co-pubs (issue #189).
 *
 * Shape decision: a publication co-authored with two mentees in different
 * programs appears under both groups, once per mentee. This duplication
 * is intentional — RPPR-style asks ("what did you produce with MD trainees"
 * vs. "with MD-PhD trainees") are separate questions. CSV exports include
 * a `copub_id` column so downstream consumers counting unique publications
 * can `DISTINCT copub_id`.
 *
 * Within a group, entries are sorted by publication year desc, pmid desc.
 * Groups themselves are sorted alphabetically by label.
 */
export async function getAllMentorCoPublications(
  mentorCwid: string,
): Promise<{
  groups: MenteeCoPubGroup[];
  /** Distinct co-pub identifiers across the entire rollup (used for the
   *  subtitle "N publications across M mentees"). A publication that ties
   *  to multiple mentees is counted once. */
  publicationCount: number;
  /** Number of distinct mentees with at least one co-pub. */
  menteeCount: number;
}> {
  if (!mentorCwid) return { groups: [], publicationCount: 0, menteeCount: 0 };

  // Reuse getMenteesForMentor to inherit the union + dedup logic across
  // AOC + Jenzabar sources, the scholar-row hydration, and graduationYear.
  // We then drop mentees with copublicationCount=0 since they don't
  // contribute to this view.
  const allMentees = await getMenteesForMentor(mentorCwid);
  const menteesWithCopubs = allMentees.filter((m) => m.copublicationCount > 0);

  if (menteesWithCopubs.length === 0) {
    return { groups: [], publicationCount: 0, menteeCount: 0 };
  }

  // Fetch every co-pub for every mentee. N round-trips is acceptable here
  // because mentee counts are small (median ~3-5, max observed <30); each
  // call is well-indexed against analysis_summary_author. A single grand-
  // query would save round trips but cost legibility, and the page is
  // SSR-revalidated rather than per-request.
  const pubsByCwid = new Map<string, CoPublicationFull[]>();
  await Promise.all(
    menteesWithCopubs.map(async (m) => {
      const pubs = await getCoPublications(mentorCwid, m.cwid);
      pubsByCwid.set(m.cwid, pubs);
    }),
  );

  // Build per-group entry lists.
  const groupsByLabel = new Map<string, MenteeCoPubEntry[]>();
  for (const m of menteesWithCopubs) {
    const label = formatProgramLabel(m.programType) ?? "Other mentees";
    const pubs = pubsByCwid.get(m.cwid) ?? [];
    const list = groupsByLabel.get(label) ?? [];
    for (const p of pubs) {
      list.push({
        mentee: {
          cwid: m.cwid,
          fullName: m.fullName,
          graduationYear: m.graduationYear,
          programType: m.programType,
          scholar: m.scholar
            ? { slug: m.scholar.slug, publishedName: m.scholar.publishedName }
            : null,
        },
        publication: p,
      });
    }
    groupsByLabel.set(label, list);
  }

  // Sort entries within each group: year desc, pmid desc.
  for (const entries of groupsByLabel.values()) {
    entries.sort((a, b) => {
      const ay = a.publication.year ?? 0;
      const by = b.publication.year ?? 0;
      if (ay !== by) return by - ay;
      return b.publication.pmid - a.publication.pmid;
    });
  }

  // Alphabetical group order.
  const groups: MenteeCoPubGroup[] = [...groupsByLabel.entries()]
    .map(([programLabel, entries]) => ({ programLabel, entries }))
    .sort((a, b) => a.programLabel.localeCompare(b.programLabel));

  // Distinct counts.
  const distinctCopubIds = new Set<string>();
  for (const g of groups) {
    for (const e of g.entries) distinctCopubIds.add(copubId(e.publication));
  }

  return {
    groups,
    publicationCount: distinctCopubIds.size,
    menteeCount: menteesWithCopubs.length,
  };
}
