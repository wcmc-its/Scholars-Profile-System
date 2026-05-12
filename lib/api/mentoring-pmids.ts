/**
 * Cached pmid sets for the "Mentoring activity" facet on the Publications
 * browse. A pmid is included in the "all" set when at least one of its WCM
 * authors is a known mentor and another is one of their known mentees. Per-
 * program-type sets break the "all" set down by the mentee's program at time
 * of mentorship:
 *
 *   - md       — AOC and AOC-2025 mentees (Areas of Concentration is the
 *                MD scholarly concentration program)
 *   - mdphd    — MDPHD mentees from the AOC reporting OR Jenzabar's MD-PhD
 *                thesis-advisor relationships
 *   - phd      — PhD mentees from Jenzabar's MAJSP (Major Sponsor) thesis-
 *                advisor relationships
 *   - ecr      — ECR mentees (Early Career Researcher / postdoc-stage)
 *
 * Two underlying sources are unioned:
 *   1. `reciterdb.reporting_students_mentors` — MD-program scholarly-project
 *      mentors. Joined to ReCiter co-author graph in a single SQL query.
 *   2. Local `phd_mentor_relationship` (from Jenzabar MAJSP) — PhD thesis
 *      advisors. Pairs are loaded locally, then sent as a tuple-IN clause
 *      against `analysis_summary_author` to derive co-pub pmids.
 *
 * Source-side classification is preferred over Scholar.role_category because
 * a mentee's role today (e.g. now-faculty) doesn't reflect what they were at
 * time of mentorship.
 *
 * Cached for 10 minutes. Refreshing is fine on a stale cache because the ID
 * sets are small and the underlying mentor-mentee table changes rarely.
 */
import { prisma } from "@/lib/db";
import { withReciterConnection } from "@/lib/sources/reciterdb";

const TTL_MS = 10 * 60 * 1000;
const PAIR_BATCH = 500;

export type MentoringProgramKey = "md" | "mdphd" | "phd" | "ecr";
export type MentoringPmidBuckets = {
  all: string[];
  byProgram: Record<MentoringProgramKey, string[]>;
};

let cache: { buckets: MentoringPmidBuckets; ts: number } | null = null;
let inflight: Promise<MentoringPmidBuckets> | null = null;

function bucketProgramType(programType: string | null): MentoringProgramKey | null {
  if (!programType) return null;
  if (programType === "MDPHD" || programType === "MD-PhD") return "mdphd";
  if (programType === "PhD") return "phd";
  if (programType === "ECR") return "ecr";
  if (programType === "AOC" || programType.startsWith("AOC-")) return "md";
  return null;
}

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function refresh(): Promise<MentoringPmidBuckets> {
  const allSet = new Set<string>();
  const bySet: Record<MentoringProgramKey, Set<string>> = {
    md: new Set(),
    mdphd: new Set(),
    phd: new Set(),
    ecr: new Set(),
  };

  // Source 1: reporting_students_mentors (AOC / AOC-2025 / MDPHD / ECR).
  await withReciterConnection(async (conn) => {
    const rows = (await conn.query(
      `SELECT DISTINCT a1.pmid AS pmid, m.programType AS programType
       FROM analysis_summary_author a1
       JOIN analysis_summary_author a2
         ON a1.pmid = a2.pmid AND a2.personIdentifier != a1.personIdentifier
       JOIN reporting_students_mentors m
         ON m.mentorCWID = a1.personIdentifier
        AND m.studentCWID = a2.personIdentifier
       WHERE a1.pmid IS NOT NULL`,
    )) as { pmid: number | bigint; programType: string | null }[];
    for (const r of rows) {
      const pmid = String(typeof r.pmid === "bigint" ? Number(r.pmid) : r.pmid);
      allSet.add(pmid);
      const bucket = bucketProgramType(r.programType);
      if (bucket) bySet[bucket].add(pmid);
    }
  });

  // Source 2: phd_mentor_relationship (Jenzabar MAJSP, programType PhD / MD-PhD).
  // Cross-DB join isn't possible (local Prisma vs ReCiter MariaDB), so we
  // load pairs locally and ship them as tuple-IN parameters to ReCiter.
  const pairs = await prisma.phdMentorRelationship.findMany({
    select: { mentorCwid: true, menteeCwid: true, programType: true },
  });
  if (pairs.length > 0) {
    const programByPair = new Map<string, string>();
    for (const p of pairs) programByPair.set(`${p.mentorCwid}::${p.menteeCwid}`, p.programType);

    await withReciterConnection(async (conn) => {
      for (const batch of chunks(pairs, PAIR_BATCH)) {
        const placeholders = batch.map(() => "(?, ?)").join(",");
        const params: string[] = [];
        for (const p of batch) {
          params.push(p.mentorCwid, p.menteeCwid);
        }
        const rows = (await conn.query(
          `SELECT DISTINCT a1.pmid AS pmid, a1.personIdentifier AS mentor, a2.personIdentifier AS mentee
           FROM analysis_summary_author a1
           JOIN analysis_summary_author a2
             ON a1.pmid = a2.pmid AND a2.personIdentifier != a1.personIdentifier
           WHERE a1.pmid IS NOT NULL
             AND (a1.personIdentifier, a2.personIdentifier) IN (${placeholders})`,
          params,
        )) as { pmid: number | bigint; mentor: string; mentee: string }[];
        for (const r of rows) {
          const pmid = String(typeof r.pmid === "bigint" ? Number(r.pmid) : r.pmid);
          allSet.add(pmid);
          const programType = programByPair.get(`${r.mentor}::${r.mentee}`) ?? null;
          const bucket = bucketProgramType(programType);
          if (bucket) bySet[bucket].add(pmid);
        }
      }
    });
  }

  return {
    all: [...allSet],
    byProgram: {
      md: [...bySet.md],
      mdphd: [...bySet.mdphd],
      phd: [...bySet.phd],
      ecr: [...bySet.ecr],
    },
  };
}

export async function getMentoringPmidBuckets(): Promise<MentoringPmidBuckets> {
  const now = Date.now();
  if (cache && now - cache.ts < TTL_MS) return cache.buckets;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const buckets = await refresh();
      cache = { buckets, ts: now };
      return buckets;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Backwards-compatible "all mentees" pmid getter — kept so callers that
 *  don't care about the program-type breakdown stay working. */
export async function getMentoringPmids(): Promise<string[]> {
  return (await getMentoringPmidBuckets()).all;
}
