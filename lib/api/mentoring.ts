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
import {
  getManualMentees,
  isAuthorHidden,
  loadPublicationSuppressions,
  resolveDarkPmids,
} from "@/lib/api/manual-layer";
import { MANUAL_MENTEE_ID_PREFIX, isManualMenteeId } from "@/lib/edit/manual-mentee";
import { hiddenMenteeCwids } from "@/lib/mentee-suppression";

/**
 * #160 follow-up — the /edit "hide mentee" suppression (`entityType="mentee"`,
 * `entityId` = `"{mentorCwid}:{menteeCwid}"`) must gate EVERY public mentoring
 * surface, not just the profile Mentoring section: the co-pubs rollup page,
 * both per-mentee pages, and their CSV/DOCX exports previously kept publishing
 * a hidden mentee's name/program/year. ADR-005 immediacy: read per-request,
 * never cached. A read failure throws (fail closed at the page/route level)
 * rather than silently rendering the unfiltered list.
 */
async function loadHiddenMenteeSet(mentorCwid: string): Promise<Set<string>> {
  const rows = await prisma.suppression.findMany({
    where: {
      entityType: "mentee",
      entityId: { startsWith: `${mentorCwid}:` },
      contributorCwid: null,
      revokedAt: null,
    },
    select: { entityId: true },
  });
  return hiddenMenteeCwids(mentorCwid, rows);
}

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
  /** Issue #288 PR-A — plain-text abstract from ReciterDB.reporting_abstracts.
   *  Drives the inline "Abstract" disclosure in the meta row of the co-pubs
   *  rollup pages. Null when the publication has no abstract (older papers,
   *  many non-research types). */
  abstract: string | null;
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
  /**
   * #2011 — `true` when NO ETL source contributed this mentee: it is on the
   * profile only because the mentor entered it by hand.
   *
   * NOT the same as "has a synthetic `manual:N` cwid". A mentor can hand-enter a
   * mentee WITH a real CWID who is in no source system — that chip carries a
   * real cwid and is otherwise indistinguishable from a sourced one, which is
   * exactly the case that made the /edit Mentees tab list the same person twice:
   * once as editable, once under "Source: Jenzabar or Employee Central" with a
   * "Request a change" link pointing at a record that does not exist there.
   *
   * `false` when any source contributed, INCLUDING a hand-entered CWID that also
   * turns up in Jenzabar/ED later — at that point the source record is real and
   * authoritative, and the sourced panel should own it.
   */
  manualOnly: boolean;
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
export { formatProgramLabel, menteeProgramLabel } from "@/lib/mentoring-labels";
import { formatProgramLabel } from "@/lib/mentoring-labels";
import { formatPublishedName } from "@/lib/postnominal";

/** Issue #201 (Slice B2) — sort selector states exposed at N ≥ 12.
 *  `"copubs"` is the default everywhere; `"class-year"` is the
 *  alternative the user picks from the section's sort selector and
 *  serializes to `?mentees-sort=class-year`. The grouped tier itself
 *  (N=8..11) also passes `"class-year"` here because the within-bucket
 *  order in that tier follows the same comparator, even though no
 *  selector is rendered. */
export type MenteeSort = "copubs" | "class-year";

/** Return shape for {@link getMenteesForMentor}. Issue #843 — the per-mentee
 *  `copublicationCount` is derived from a LIVE ReciterDB query (WCM-side, and
 *  the SPS→WCM path can be down). When that query fails, EVERY mentee's count
 *  silently falls back to 0, which is indistinguishable from a genuine zero
 *  unless callers know the source was unavailable. `copubSourceAvailable` is
 *  `true` only when the co-pub query completed without throwing; callers use it
 *  to suppress the misleading "no co-pubs" affordances (the rollup link, the
 *  per-chip badges) on an outage rather than presenting an outage as fact. */
export type MenteesResult = {
  mentees: MenteeChip[];
  /** `false` when the ReciterDB co-pub query threw — the `copublicationCount`
   *  on every mentee is then a fallback zero, NOT a real count. */
  copubSourceAvailable: boolean;
};

/**
 * Issue #928 — AOC mentee rows for one mentor. Two sources behind the SAME
 * `MENTORING_COPUB_BRIDGE` flag as the co-pub count/list bridges. LIVE: the
 * WCM `reporting_students_mentors` query (load-bearing where the SPS VPC can
 * reach ReciterDB). BRIDGE: the pre-computed `aoc_mentee` table, populated
 * from S3 (etl:mentoring:import-aoc) for envs that can't reach ReciterDB.
 *
 * Either way the helper returns `[]` on any failure — matching the live
 * path's historical `.catch(() => [])` — so a missing accessor or an Aurora
 * hiccup degrades to "no AOC chips", exactly the in-VPC behavior the bridge
 * replaces (no regression).
 */
async function loadAocRows(mentorCwid: string): Promise<AocRow[]> {
  try {
    if (process.env.MENTORING_COPUB_BRIDGE === "on") {
      try {
        const rows = await prisma.aocMentee.findMany({
          where: { mentorCwid },
          select: {
            menteeCwid: true,
            firstName: true,
            lastName: true,
            graduationYear: true,
            programType: true,
          },
        });
        return rows.map<AocRow>((r) => ({
          studentCWID: r.menteeCwid,
          studentFirstName: r.firstName,
          studentLastName: r.lastName,
          studentGraduationYear: r.graduationYear,
          programType: r.programType,
        }));
      } catch (err) {
        console.error(
          `[mentoring] aoc bridge read failed for mentor ${mentorCwid}`,
          err,
        );
        return [];
      }
    }
    return (await withReciterConnection(async (conn) => {
      return (await conn.query(
        `SELECT studentCWID, studentFirstName, studentLastName, studentGraduationYear, programType
         FROM reporting_students_mentors
         WHERE mentorCWID = ? AND studentCWID IS NOT NULL AND studentCWID != ''`,
        [mentorCwid],
      )) as AocRow[];
    })) as AocRow[];
  } catch {
    return [];
  }
}

/** Local `publication.pmid` is a VarChar and carries source-prefixed ids for
 *  non-PubMed records (e.g. "SCOPUS:105037533819"); `CoPublicationFull.pmid` is
 *  a number. Drop anything that isn't a plain PubMed id rather than emit NaN. */
function parsePmid(pmid: string): number | null {
  if (!/^\d{1,16}$/.test(pmid)) return null;
  const n = Number(pmid);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * ponytail: the local corpus has no per-pmid author TABLE. `publication_author`
 * holds WCM CWIDs only (the reciter ETL skips every author outside the ingestion
 * set), so it cannot produce the full byline a citation needs. `fullAuthorsString`
 * IS that byline — rank-ordered and already in "Lastname II" Vancouver form, so
 * each token is the rendered author verbatim.
 *
 * `personIdentifier` is left null throughout, which costs the co-author profile
 * links on the page and the bold mentor/mentee runs in the DOCX. Recovering it
 * means joining a token index back to `publication_author.position`, and the ETL's
 * `composeAuthorString` DROPS surname-less rows — so the two sequences can shift
 * apart silently and bold the wrong person. A missing link degrades; a wrong one
 * misattributes. Attach CWIDs by rank if linked co-authors are ever asked for,
 * and verify the shift case first.
 */
function localAuthors(fullAuthorsString: string | null): CoPublicationAuthor[] {
  if (!fullAuthorsString) return [];
  return fullAuthorsString
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .map((lastName, i) => ({
      rank: i + 1,
      lastName,
      firstName: null,
      personIdentifier: null,
    }));
}

/**
 * #2011 follow-up — co-publications for MANUAL-ONLY mentees, computed from the
 * env's OWN Aurora at request time. RAW (pre-suppression), exactly like
 * {@link fetchCoPublicationsRaw}; the caller applies suppression.
 *
 * These mentees are in no ETL relationship table, so the co-pub bridge has no
 * rows for them and never will — the bridge export is deliberately NOT a fourth
 * pair source (see `etl/mentoring/export-copubs.ts`). The bridge exists because
 * co-pubs across ~1000 mentors are expensive and most SOURCED mentees are
 * unlinked alumni absent from local tables. Neither applies here: a manual
 * mentee worth showing co-pubs for is one the mentor gave a CWID, and a CWID
 * resolving to a WCM profile is by definition in local `Scholar` /
 * `publication_author`. So this is a set intersection on two indexed columns
 * (`@@index([cwid, isConfirmed])`), for a handful of people, per request — and
 * no ETL run is ever required for a manual mentee to light up.
 *
 * Accepted limitation: a manual mentee whose CWID has no local authorship rows
 * (the unlinked-alumnus case) gets zero. They get zero today too, so this is
 * strictly better than the status quo, just short of what ReciterDB would return.
 *
 * Fail-soft to an empty map with a logged error, matching the bridge/live path's
 * historical `.catch(() => [])` — a co-pub read must not take down a profile.
 */
async function localCoPublications(
  mentorCwid: string,
  menteeCwids: string[],
): Promise<Map<string, CoPublicationFull[]>> {
  const out = new Map<string, CoPublicationFull[]>();
  const targets = [...new Set(menteeCwids)].filter(
    (c) => c && c.toLowerCase() !== mentorCwid.toLowerCase(),
  );
  if (!mentorCwid || targets.length === 0) return out;

  try {
    // One indexed read covers the mentor and every mentee; intersect in memory.
    // `publication_author` has no unique key on (pmid, cwid), so collect into a
    // Set rather than trusting row counts.
    const rows = await prisma.publicationAuthor.findMany({
      where: { cwid: { in: [mentorCwid, ...targets] }, isConfirmed: true },
      select: { cwid: true, pmid: true },
    });
    // Key the grouping case-INSENSITIVELY. The `IN (...)` filter matches under
    // MySQL's utf8mb4_unicode_ci collation but returns the STORED spelling, so a
    // Map keyed on the row's cwid and read with the caller's string silently
    // misses whenever they differ in case — and they can: `getMentorMenteePair`
    // admits a mixed-case URL segment (nothing normalizes it on the way in), so
    // /co-pubs/ABC1001 would resolve its heading and then render zero rows.
    // `out` and `sharedByCwid` stay keyed on the CALLER's string, because
    // `getMenteesForMentor` looks results up by its own chip cwid.
    const pmidsByCwid = new Map<string, Set<string>>();
    for (const r of rows) {
      if (!r.cwid) continue;
      const key = r.cwid.toLowerCase();
      let set = pmidsByCwid.get(key);
      if (!set) pmidsByCwid.set(key, (set = new Set<string>()));
      set.add(r.pmid);
    }
    const mentorPmids = pmidsByCwid.get(mentorCwid.toLowerCase());
    if (!mentorPmids || mentorPmids.size === 0) return out;

    const sharedByCwid = new Map<string, string[]>();
    const allShared = new Set<string>();
    for (const cwid of targets) {
      const shared = [...(pmidsByCwid.get(cwid.toLowerCase()) ?? [])].filter((p) =>
        mentorPmids.has(p),
      );
      if (shared.length === 0) continue;
      sharedByCwid.set(cwid, shared);
      for (const p of shared) allShared.add(p);
    }
    if (allShared.size === 0) return out;

    const pubs = await prisma.publication.findMany({
      where: { pmid: { in: [...allShared] } },
      select: {
        pmid: true,
        title: true,
        journal: true,
        year: true,
        doi: true,
        pmcid: true,
        volume: true,
        issue: true,
        pages: true,
        citationCount: true,
        abstract: true,
        fullAuthorsString: true,
      },
    });
    const byPmid = new Map<string, CoPublicationFull>();
    for (const p of pubs) {
      const pmid = parsePmid(p.pmid);
      if (pmid === null) continue;
      byPmid.set(p.pmid, {
        pmid,
        title: p.title,
        journal: p.journal,
        year: p.year,
        doi: p.doi,
        pmcid: p.pmcid,
        volume: p.volume,
        issue: p.issue,
        pages: p.pages,
        citationCount: p.citationCount,
        abstract: p.abstract,
        authors: localAuthors(p.fullAuthorsString),
      });
    }

    for (const [cwid, shared] of sharedByCwid) {
      // Newest first, pmid desc as tiebreaker — the same order both ReciterDB
      // paths use, so the preview and the page agree row for row.
      const list = shared
        .map((p) => byPmid.get(p))
        .filter((p): p is CoPublicationFull => p !== undefined)
        .sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || b.pmid - a.pmid);
      if (list.length > 0) out.set(cwid, list);
    }
    return out;
  } catch (err) {
    console.error(
      `[mentoring] local co-pub computation failed for mentor ${mentorCwid}`,
      err,
    );
    return out;
  }
}

/**
 * Returns all known mentees for the given mentor CWID. Multiple AOC project
 * rows for the same student are collapsed to a single chip.
 *
 * Sort order (issue #201):
 *  - `"copubs"` (default) — co-publication count desc, then terminal-year
 *    desc, then name. Surfaces the most productive collaborations first
 *    — the answer the chip badges implicitly ask the reader to look for.
 *    Used by the flat tier (N<8) and by the controlled tier's
 *    "Co-publications" selector option.
 *  - `"class-year"` — terminal-year desc, then name. Used by the
 *    grouped tier (8≤N<12) for within-bucket order, and by the
 *    controlled tier's "Class year" selector option.
 *
 * Terminal year is `graduationYear` for AOC/PhD mentees; for postdocs
 * (issue #183) it's the appointment endYear, with active postdocs
 * (endYear=null) pinned to the top via MAX_SAFE_INTEGER. Mixing across
 * types is intentional — a profile with both current postdocs and
 * recent graduates surfaces both together.
 *
 * Returns an empty `mentees` array if the mentor has no recorded
 * relationships. Issue #843 — also reports `copubSourceAvailable`: `false`
 * when the live ReciterDB co-pub query threw (so every mentee's
 * `copublicationCount` is a fallback zero, not a real count). The early-return
 * paths (no mentor cwid / no recorded mentees) never reach the co-pub query,
 * so they report `copubSourceAvailable: true`.
 *
 * `options.includeCopubs` (default `true`) — pass `false` to skip the co-pub
 * source entirely (both the bridge and the live path). Callers that render only
 * mentee identity + program (the `/edit` Mentees panel, #955 finding #5) use
 * this to avoid the per-mentee count/preview work on every load; every
 * `copublicationCount` is then 0 and `copubSourceAvailable` is false.
 */
export async function getMenteesForMentor(
  mentorCwid: string,
  options?: { sort?: MenteeSort; includeCopubs?: boolean },
): Promise<MenteesResult> {
  if (!mentorCwid) return { mentees: [], copubSourceAvailable: true };

  const [aocRows, jenzabarRows, postdocRows, manualRows] = await Promise.all([
    // #928 — AOC source switches on MENTORING_COPUB_BRIDGE inside the helper.
    loadAocRows(mentorCwid),
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
    // #2011 — mentees no source system recorded, entered by the mentor on
    // /edit. Additive to the three ETL sources. Best-effort: a read failure
    // must not take down a Mentoring section the ETL sources can still fill.
    getManualMentees(mentorCwid, prisma).catch((err) => {
      console.error(`[mentoring] manual mentee read failed for mentor ${mentorCwid}`, err);
      return [];
    }),
  ]);

  if (
    aocRows.length === 0 &&
    jenzabarRows.length === 0 &&
    postdocRows.length === 0 &&
    manualRows.length === 0
  )
    return { mentees: [], copubSourceAvailable: true };

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
  // #2011 — every cwid an ETL SOURCE contributed, so a hand-entered mentee that
  // no source knows can be told apart from one that a source also carries. The
  // three loops below fill it; the manual loop deliberately does not.
  const sourcedCwids = new Set<string>();
  for (const r of aocRows) sourcedCwids.add(r.studentCWID);
  for (const r of jenzabarRows) sourcedCwids.add(r.menteeCwid);
  for (const r of postdocRows) sourcedCwids.add(r.menteeCwid);

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
  // #2011 — manual entries LAST so a sourced record wins the display name on a
  // cwid collision (`upsert` keeps the first writer's `fullName`): if the mentee
  // has since landed in Jenzabar/ED, that record is authoritative and the
  // mentor's hand-typed entry silently merges into it rather than duplicating.
  //
  // ponytail: a CWID-less entry keys on its array index, so deleting one
  // reindexes the rest. Nothing durable references these ids — manual mentees
  // have no co-pubs page (no CWID ⇒ no author rows) and are deleted rather than
  // suppressed — so the churn is invisible. Store a minted id per entry if a
  // durable reference ever appears.
  manualRows.forEach((m, i) => {
    upsert(m.cwid ?? `${MANUAL_MENTEE_ID_PREFIX}${i}`, m.name, null, m.year ?? null);
  });

  const cwids = [...byCwid.keys()];
  // Split the roster by PROVENANCE — the same predicate `MenteeChip.manualOnly`
  // reports. An ETL-sourced mentee goes to the co-pub bridge/live source; a
  // manual-only one goes to the local computation below, because the bridge has
  // no rows for it and never will (it is deliberately not a pair source in
  // `etl/mentoring/export-copubs.ts`). Asking the bridge anyway would return a
  // zero indistinguishable from a real one.
  //
  // Filter on PROVENANCE, never on `isCwid`: source ids come from Jenzabar / ED
  // / ReciterDB and are not ours to validate. An `isCwid` allowlist here
  // silently drops any source id that doesn't match the pattern (caught by
  // mentoring-copub-source.test.ts, whose `m1` fixture is below the 3-char
  // minimum) — a co-pub count regression wearing a tidier predicate.
  const sourceCwids = cwids.filter((c) => sourcedCwids.has(c));
  // #2011 — a synthetic `manual:N` id has no identifier to join on, so it can
  // never have co-publications; drop it from the local ask too.
  const manualOnlyCwids = cwids.filter((c) => !sourcedCwids.has(c) && !isManualMenteeId(c));

  // Issue #195 — Resolve program names. Precedence: ED `student_phd_program`
  // beats Jenzabar `phd_mentor_relationship.major_desc` (ED is the
  // authoritative curated source; Jenzabar fills the gap for pre-LDAP
  // alumni and off-cycle students).
  const programNameByCwid = new Map<string, string>();
  // #2011 — seed manual labels FIRST (lowest precedence). A mentor's hand-typed
  // program is the fallback for a mentee no source knows; where a real source
  // does know them, that source wins.
  manualRows.forEach((m, i) => {
    if (m.programLabel)
      programNameByCwid.set(m.cwid ?? `${MANUAL_MENTEE_ID_PREFIX}${i}`, m.programLabel);
  });
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
  // Issue #843 — track whether the co-pub query actually ran. Set true only
  // after the query completes without throwing; a thrown error leaves it false
  // so callers can tell "ReciterDB was down" apart from "this mentor genuinely
  // has zero co-pubs" and stop silently dropping the rollup link / badges.
  // #955 finding #5 — callers that don't render the per-mentee co-pub count (the
  // `/edit` Mentees panel) pass `includeCopubs: false` to skip the co-pub source
  // entirely; counts stay 0 and `copubSourceAvailable` stays false.
  const includeCopubs = options?.includeCopubs ?? true;
  let copubSourceAvailable = false;

  // Issue #443 — two co-pub sources. LIVE: the WCM ReciterDB query (load-bearing
  // where the SPS VPC can reach ReciterDB). BRIDGE: the pre-computed
  // `mentee_copublication` table, populated from S3 (etl:mentoring:import-copubs)
  // for envs that can't reach ReciterDB. `MENTORING_COPUB_BRIDGE` selects the
  // source; it's flipped only after the import runs (import-then-flip).
  if (!includeCopubs) {
    // Skip both co-pub sources — the caller doesn't render counts (#955 #5). The
    // dark-pmid suppression below no-ops on the empty preview map.
  } else if (sourceCwids.length === 0) {
    // #2011 — no ETL source contributed a mentee, so there is nothing to ask
    // either co-pub source. Zero co-pubs is a FACT here, not an outage, so mark
    // the source available: `false` would make callers suppress the badges as
    // though ReciterDB were down — including the badges the local computation
    // below is about to fill. This also guards the live path, whose
    // `IN (${...join(",")})` is malformed SQL on an empty list.
    copubSourceAvailable = true;
  } else if (process.env.MENTORING_COPUB_BRIDGE === "on") {
    try {
      const rows = await prisma.menteeCopublication.findMany({
        where: { mentorCwid, menteeCwid: { in: sourceCwids } },
        select: { menteeCwid: true, count: true, preview: true },
      });
      for (const r of rows) {
        copubCountByCwid.set(r.menteeCwid, r.count);
        copubPreviewByCwid.set(r.menteeCwid, (r.preview as CoPublication[]) ?? []);
      }
      // Rows for this mentor ⇒ unambiguously covered. NO rows is ambiguous:
      // "bridge not yet imported" (table globally empty ⇒ degrade honestly to
      // unavailable, exactly like a live-query outage) vs "this mentor genuinely
      // has zero co-pubs" (table has data ⇒ available, all counts legitimately
      // zero). One cheap existence probe — only when this mentor had no rows —
      // distinguishes them, so a flag flipped before the import never shows
      // fake zeros.
      copubSourceAvailable =
        rows.length > 0 ||
        (await prisma.menteeCopublication.findFirst({
          select: { mentorCwid: true },
        })) !== null;
    } catch (err) {
      console.error(
        `[mentoring] copub bridge read failed for mentor ${mentorCwid}`,
        err,
      );
    }
  } else {
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
            AND a2.personIdentifier IN (${sourceCwids.map(() => "?").join(",")})
          ORDER BY a2.personIdentifier, art.articleYear DESC, a1.pmid DESC`,
        [mentorCwid, ...sourceCwids],
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
      copubSourceAvailable = true;
    }).catch((err) => {
      // Issue #843 — DE-SILENCE: this was a silent `.catch(() => {})`, which
      // gave operators zero visibility when ReciterDB was unreachable and left
      // every mentee's co-pub count a misleading zero. Log with the mentor cwid
      // and that this is the co-pub source so the cause is diagnosable;
      // `copubSourceAvailable` stays false so the UI degrades honestly.
      console.error(
        `[mentoring] reciterdb co-pub count query failed for mentor ${mentorCwid}`,
        err,
      );
    });
  }

  // #2011 follow-up — MANUAL-ONLY mentees reach neither co-pub source above, so
  // compute theirs from the env's own Aurora. Written into the SAME two maps,
  // and deliberately BEFORE the dark-pmid pass below, so they inherit publication
  // suppression for free; computing after that pass would publish suppressed
  // pmids into the preview.
  //
  // `copubSourceAvailable` is left alone here on purpose. Where no ETL source
  // contributed anyone, the branch above has already set it true. Where sourced
  // mentees DO exist and their bridge/live read failed, the flag is reporting a
  // real outage for those chips — one flag covers the whole result, so forcing it
  // true would dress an outage up as a set of honest zeros.
  if (includeCopubs && manualOnlyCwids.length > 0) {
    const local = await localCoPublications(mentorCwid, manualOnlyCwids);
    for (const [cwid, pubs] of local) {
      copubCountByCwid.set(cwid, pubs.length);
      // Top 3, same order the bridge preview uses (#185). One source for both the
      // badge and the page: the count IS this list's length, so the two cannot
      // drift apart the way a separately-exported count can.
      copubPreviewByCwid.set(
        cwid,
        pubs.slice(0, 3).map(({ pmid, title, journal, year }) => ({
          pmid,
          title,
          journal,
          year,
        })),
      );
    }
  }

  // Issue #443/#185 — dark-pmid suppression of the badge count + chip preview.
  // Neither co-pub source (#356) applies publication suppression: the bridge
  // snapshots count+preview at export time, and the live query joins ReciterDB
  // (which doesn't know SPS take-downs). So a publication taken down AFTER the
  // last export (whole-pub #356, or derived-dark = every confirmed WCM author
  // hidden) would still leak its title/journal/year into the popover preview and
  // inflate the badge until the next re-import. Re-apply local suppression at
  // request time over the preview pmids: drop dark pmids from each preview and
  // decrement that mentee's count by the number dropped. This fully closes the
  // title/journal/year LEAK (the security-sensitive part); a dark pmid that sits
  // OUTSIDE the ≤3-most-recent preview can still inflate a bridge-sourced count
  // by one until re-import (the full pmid list isn't carried on this lightweight
  // path — getCoPublications, which has it, suppresses exactly).
  const previewPmids = [
    ...new Set(
      [...copubPreviewByCwid.values()].flat().map((p) => String(p.pmid)),
    ),
  ];
  if (previewPmids.length > 0) {
    const suppressions = await loadPublicationSuppressions(previewPmids, prisma);
    const darkPmids = await resolveDarkPmids(previewPmids, suppressions, prisma);
    if (darkPmids.size > 0) {
      for (const [menteeCwid, preview] of copubPreviewByCwid) {
        const kept = preview.filter((p) => !darkPmids.has(String(p.pmid)));
        const dropped = preview.length - kept.length;
        if (dropped === 0) continue;
        copubPreviewByCwid.set(menteeCwid, kept);
        const count = copubCountByCwid.get(menteeCwid) ?? 0;
        copubCountByCwid.set(menteeCwid, Math.max(0, count - dropped));
      }
    }
  }

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
      // #2011 — a synthetic `manual:N` id would build a headshot URL that can
      // only 404. The avatar contract accepts an empty string (see the field's
      // JSDoc) and falls back to initials, so skip the pointless request. A
      // SOURCED id keeps its endpoint even if oddly shaped — that request is
      // the pre-existing behaviour and not ours to second-guess.
      identityImageEndpoint: isManualMenteeId(c.cwid) ? "" : identityImageEndpoint(c.cwid),
      manualOnly: !sourcedCwids.has(c.cwid),
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

  // Issue #201 — comparator switches on the optional `sort` arg.
  // `"copubs"` (default) leads with collaboration count; `"class-year"`
  // skips that step and goes straight to terminal year. Both end with a
  // name tiebreaker for determinism. See JSDoc for terminal-year semantics.
  const sort: MenteeSort = options?.sort ?? "copubs";
  const terminalYear = (c: MenteeChip): number => {
    if (c.graduationYear) return c.graduationYear;
    if (c.appointmentRange) {
      return c.appointmentRange.endYear ?? Number.MAX_SAFE_INTEGER;
    }
    return 0;
  };
  chips.sort((a, b) => {
    if (sort === "copubs") {
      const byCopubs = b.copublicationCount - a.copublicationCount;
      if (byCopubs !== 0) return byCopubs;
    }
    const byYear = terminalYear(b) - terminalYear(a);
    if (byYear !== 0) return byYear;
    return a.fullName.localeCompare(b.fullName);
  });

  return { mentees: chips, copubSourceAvailable };
}

/**
 * #356 / #928 — re-apply local publication suppression to a fully-built
 * `CoPublicationFull[]`. Pulled out of {@link getCoPublications} so BOTH the
 * live (ReciterDB) and bridge (`mentee_copublication_pub`) source paths run
 * the same suppression pass: the bridge stores PRE-suppression rows because
 * the suppression table is env-specific and changes independently of the S3
 * artifact, so suppression must be a read-time step, not baked into export.
 *
 * Drops any dark pmid (taken-down or derived-dark) and any per-author-hidden
 * co-author chip, exactly as the inline pass used to. `[]` in ⇒ `[]` out.
 */
async function applyCoPubSuppression(
  pubs: CoPublicationFull[],
): Promise<CoPublicationFull[]> {
  if (pubs.length === 0) return [];

  const pmidStrings = pubs.map((p) => String(p.pmid));
  const suppressions = await loadPublicationSuppressions(pmidStrings, prisma);
  const darkPmids = await resolveDarkPmids(pmidStrings, suppressions, prisma);

  return pubs
    .filter((p) => !darkPmids.has(String(p.pmid)))
    .map<CoPublicationFull>((p) => ({
      ...p,
      // #356 — drop the chip of a co-author who hid this publication.
      authors: p.authors.filter(
        (a) =>
          a.personIdentifier === null ||
          !isAuthorHidden(suppressions, String(p.pmid), a.personIdentifier),
      ),
    }));
}

/**
 * #928 — RAW (pre-suppression) co-pub list for one mentor↔mentee pair, full
 * author list included. Two sources behind the SAME `MENTORING_COPUB_BRIDGE`
 * flag as the AOC and count bridges. LIVE: the WCM ReciterDB query
 * (`analysis_summary_article` for citation fields + `analysis_summary_author_list`
 * for the structured author list). BRIDGE: the pre-computed
 * `mentee_copublication_pub` table, populated from S3 (etl:mentoring:import-copub-list)
 * for envs that can't reach ReciterDB; the `pub` JSON column holds the
 * `CoPublicationFull` as exported. Suppression is NOT applied here — the
 * caller re-applies it via {@link applyCoPubSuppression}. Both paths degrade
 * to `[]` on failure (preserving the live path's historical `.catch(() => [])`).
 */
async function fetchCoPublicationsRaw(
  mentorCwid: string,
  menteeCwid: string,
): Promise<CoPublicationFull[]> {
  if (process.env.MENTORING_COPUB_BRIDGE === "on") {
    try {
      const rows = await prisma.menteeCopublicationPub.findMany({
        where: { mentorCwid, menteeCwid },
        orderBy: [{ pubYear: "desc" }, { pmid: "desc" }],
        select: { pub: true },
      });
      return rows.map((r) => r.pub as unknown as CoPublicationFull);
    } catch (err) {
      console.error(
        `[mentoring] copub-list bridge read failed for mentor ${mentorCwid}`,
        err,
      );
      return [];
    }
  }

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
      abstract: string | null;
    };
    // Issue #288 PR-A — LEFT JOIN reporting_abstracts so the row carries the
    // raw PubMed abstract for the inline disclosure on co-pubs pages. Same
    // source the nightly ETL uses (see etl/reciter/backfill-abstracts.ts).
    // LEFT JOIN keeps the row when the upstream lacks an abstract (common
    // for older papers and many non-research types).
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
              art.citationCountScopus AS citationCount,
              ra.abstractVarchar AS abstract
         FROM analysis_summary_author a1
         JOIN analysis_summary_author a2
           ON a1.pmid = a2.pmid
         JOIN analysis_summary_article art
           ON art.pmid = a1.pmid
         LEFT JOIN reporting_abstracts ra
           ON ra.pmid = art.pmid
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

    // RAW CoPublicationFull[] — full author list, no suppression. The caller
    // applies suppression via applyCoPubSuppression so the bridge and live
    // paths share one pass.
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
        abstract: r.abstract ?? null,
        authors: authorsByPmid.get(pmid) ?? [],
      };
    });
  }).catch(() => []);
}

/**
 * Returns the full set of publications co-authored by `mentorCwid` and
 * `menteeCwid`, ordered newest first.
 *
 * #928 — dual source behind `MENTORING_COPUB_BRIDGE`: LIVE reads ReciterDB's
 * `analysis_summary_article` (citation fields) + `analysis_summary_author_list`
 * (structured author list, so we can render and bold WCM-affiliated authors);
 * BRIDGE reads the pre-computed `mentee_copublication_pub` table. Local
 * publication suppression (#356) is re-applied on BOTH paths via
 * {@link applyCoPubSuppression}, since the bridge stores pre-suppression rows.
 *
 * #2011 follow-up — `options.manualOnly` routes a MANUAL-ONLY mentee to
 * {@link localCoPublications} instead, computed from the env's own Aurora. The
 * discriminator is free: `MenteeChip.manualOnly` and `getMentorMenteePair` both
 * already report it, and every caller has one of the two in hand. It defaults
 * false, so a sourced mentee's path is bit-for-bit unchanged.
 *
 * Returns an empty array when no co-authored publications exist — drift
 * is possible between this query and the badge count (e.g. an alumnus
 * mentee is in the count query but not in the author-list table for a
 * given pmid); the page surfaces that case via its empty state.
 */
export async function getCoPublications(
  mentorCwid: string,
  menteeCwid: string,
  options?: { manualOnly?: boolean },
): Promise<CoPublicationFull[]> {
  if (!mentorCwid || !menteeCwid || mentorCwid === menteeCwid) return [];

  const raw = options?.manualOnly
    ? (await localCoPublications(mentorCwid, [menteeCwid])).get(menteeCwid) ?? []
    : await fetchCoPublicationsRaw(mentorCwid, menteeCwid);
  try {
    return await applyCoPubSuppression(raw);
  } catch (err) {
    // Fail CLOSED: a suppression-table read failure must never fall through to
    // the raw, unsuppressed list (that would leak a taken-down pub / per-author
    // hide). Degrade to [] — matching the prior behavior, when suppression ran
    // inside the live path's `.catch(() => [])`.
    console.error(
      `[mentoring] co-pub suppression pass failed for mentor ${mentorCwid} / mentee ${menteeCwid}`,
      err,
    );
    return [];
  }
}

/**
 * Validates that `menteeCwid` is actually one of `mentorCwid`'s recorded
 * mentees and returns mentor + mentee display names. Used by the co-pubs
 * page (#184) to 404 on stray URLs. Returns `null` when the relationship
 * doesn't exist in `reporting_students_mentors`.
 *
 * #2011 follow-up — a HAND-ENTERED mentee is a recorded mentee too, so the
 * `manualMentees` field-override is a fourth thing consulted here; without it a
 * manual mentee's chip would advertise co-pubs and link to a hard 404. The
 * returned `manualOnly` is the discriminator `getCoPublications` needs, computed
 * from reads this function already had to do.
 */
export async function getMentorMenteePair(
  mentorCwid: string,
  menteeCwid: string,
): Promise<{ mentorName: string; menteeName: string; manualOnly: boolean } | null> {
  if (!mentorCwid || !menteeCwid) return null;

  // Look in all three sources — AOC (ReCiterDB), Jenzabar PhD, and postdoc
  // (local Prisma). First hit wins for the mentee display name.
  type AocPairRow = { studentFirstName: string | null; studentLastName: string | null };
  // #928 — AOC pair lookup mirrors getMenteesForMentor: bridge reads the
  // pre-computed `aoc_mentee` table, live reads `reporting_students_mentors`.
  // Same MENTORING_COPUB_BRIDGE flag; both degrade to `[]` on failure.
  const loadAocPairRows = async (): Promise<AocPairRow[]> => {
    try {
      if (process.env.MENTORING_COPUB_BRIDGE === "on") {
        try {
          const row = await prisma.aocMentee.findFirst({
            where: { mentorCwid, menteeCwid },
            select: { firstName: true, lastName: true },
          });
          return row
            ? [{ studentFirstName: row.firstName, studentLastName: row.lastName }]
            : [];
        } catch (err) {
          console.error(
            `[mentoring] aoc bridge read failed for mentor ${mentorCwid}`,
            err,
          );
          return [];
        }
      }
      return (await withReciterConnection(async (conn) => {
        return (await conn.query(
          `SELECT studentFirstName, studentLastName
             FROM reporting_students_mentors
            WHERE mentorCWID = ? AND studentCWID = ?
            LIMIT 1`,
          [mentorCwid, menteeCwid],
        )) as AocPairRow[];
      })) as AocPairRow[];
    } catch {
      return [];
    }
  };
  const [aocRows, jenzabarRow, postdocRow, manualRows, hiddenMentees] = await Promise.all([
    loadAocPairRows(),
    prisma.phdMentorRelationship.findFirst({
      where: { mentorCwid, menteeCwid },
      select: { menteeFirstName: true, menteeLastName: true },
    }),
    prisma.postdocMentorRelationship.findFirst({
      where: { mentorCwid, menteeCwid },
      select: { menteeFirstName: true, menteeLastName: true },
    }),
    // #2011 — best-effort, matching `getMenteesForMentor`: a field-override read
    // failure must not 404 a page the three ETL sources can still back.
    getManualMentees(mentorCwid, prisma).catch((err) => {
      console.error(`[mentoring] manual mentee read failed for mentor ${mentorCwid}`, err);
      return [];
    }),
    loadHiddenMenteeSet(mentorCwid),
  ]);
  // Stored cwids are lowercased on write; the URL segment is not normalized
  // anywhere on the way in, so compare case-insensitively — the three sourced
  // lookups above get that from MySQL's collation for free.
  const wanted = menteeCwid.toLowerCase();
  const manualRow = manualRows.find((m) => m.cwid?.toLowerCase() === wanted) ?? null;
  if (aocRows.length === 0 && !jenzabarRow && !postdocRow && !manualRow) return null;
  // #160 follow-up — this validator is the shared 404 gate for the per-mentee
  // co-pubs page and its export route; a mentor-hidden mentee must 404 there
  // exactly like a stray URL, mirroring the profile Mentoring section.
  if (hiddenMentees.has(menteeCwid)) return null;
  // Same rule the chip uses: manual-only means NO ETL source contributed, not
  // "has a hand-entered record". A mentee both hand-entered and sourced is
  // sourced, and keeps the bridge/live co-pub path.
  const manualOnly = aocRows.length === 0 && !jenzabarRow && !postdocRow;

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
  // A sourced record wins the display name; `ManualMentee` carries one
  // undivided `name`, so it is the fallback rather than a first/last part.
  const menteeName =
    [first, last].filter(Boolean).join(" ").trim() || manualRow?.name || menteeCwid;

  // Mentor display name comes from the local Scholar table; the mentor
  // is on a scholar profile page so they're always present there.
  const mentor = await prisma.scholar.findUnique({
    where: { cwid: mentorCwid },
    select: { preferredName: true, postnominal: true },
  });
  const mentorName = mentor
    ? formatPublishedName(mentor.preferredName, mentor.postnominal)
    : mentorCwid;

  return { mentorName, menteeName, manualOnly };
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
    /** Finer-grained program name (ED/Jenzabar) when available; drives the
     *  meta-line label via `menteeProgramLabel`, with `programType` carrying
     *  the degree suffix (issue #1019). Null falls back to `formatProgramLabel`. */
    programName: string | null;
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
  const { mentees: allMentees } = await getMenteesForMentor(mentorCwid);
  // #160 follow-up — drop mentor-hidden mentees BEFORE building the rollup so
  // this page and its CSV/DOCX exports honor the same /edit choice the profile
  // Mentoring section applies. Skip the read when there are no mentees.
  const hiddenMentees =
    allMentees.length > 0 ? await loadHiddenMenteeSet(mentorCwid) : new Set<string>();
  const menteesWithCopubs = allMentees.filter(
    (m) => m.copublicationCount > 0 && !hiddenMentees.has(m.cwid),
  );

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
      // #2011 follow-up — carry the chip's own provenance through, so the rollup
      // reads the same source that produced its badge count. Passing it is what
      // keeps the three surfaces from disagreeing.
      const pubs = await getCoPublications(mentorCwid, m.cwid, { manualOnly: m.manualOnly });
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
          programName: m.programName,
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

  // Distinct counts — derived from the POST-suppression entries, NOT the
  // pre-suppression copublicationCount. #991 — a mentee whose every co-pub is
  // dark contributes 0 entries (the bridge count can outrun the suppressed list
  // by the documented ≤1), so `menteesWithCopubs.length` would overstate the
  // "N publications across M mentees" subtitle. Count mentees actually rendered.
  const distinctCopubIds = new Set<string>();
  const distinctMenteeCwids = new Set<string>();
  for (const g of groups) {
    for (const e of g.entries) {
      distinctCopubIds.add(copubId(e.publication));
      distinctMenteeCwids.add(e.mentee.cwid);
    }
  }

  return {
    groups,
    publicationCount: distinctCopubIds.size,
    menteeCount: distinctMenteeCwids.size,
  };
}
