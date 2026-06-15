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
 *   - postdoc  — Postdoc mentees from ED's `weillCornellEduSORRoleRecord`
 *                under `ou=employees,ou=sors` (issue #183). Includes both
 *                active and expired role records so alumni postdocs surface.
 *   - ecr      — ECR mentees (definition pending — see issue #183 thread;
 *                NOT the postdoc bucket, despite the misreading the prior
 *                comment promoted)
 *
 * Three underlying sources are unioned:
 *   1. `reciterdb.reporting_students_mentors` — MD-program scholarly-project
 *      mentors. Joined to ReCiter co-author graph in a single SQL query.
 *   2. Local `phd_mentor_relationship` (from Jenzabar MAJSP) — PhD thesis
 *      advisors. Pairs are loaded locally, then sent as a tuple-IN clause
 *      against `analysis_summary_author` to derive co-pub pmids.
 *   3. Local `postdoc_mentor_relationship` (from ED postdoc role records) —
 *      Postdoc supervisors. Same tuple-IN pattern as the Jenzabar source.
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
// A failed / timed-out refresh (ReciterDB unreachable) caches the EMPTY result
// for this short window instead of not caching at all -- so a persistent outage
// costs at most one slow refresh per NEGATIVE_TTL_MS, not one per /search render.
const NEGATIVE_TTL_MS = 30 * 1000;
// #610-style cap (mirrors people-classifier-sets.ts): a refresh past this is
// wedged (an unreachable ReciterDB burning the mariadb ~10s acquireTimeout),
// not slow. On timeout we degrade to empty buckets, same as an errored refresh.
const REFRESH_TIMEOUT_MS = 2000;
const PAIR_BATCH = 500;

export type MentoringProgramKey = "md" | "mdphd" | "phd" | "postdoc" | "ecr";
export type MentoringPmidBuckets = {
  all: string[];
  byProgram: Record<MentoringProgramKey, string[]>;
};

/** The empty/degraded shape served when ReciterDB is unreachable. Exported so
 *  the search count-only path can use it without taking a ReciterDB dependency. */
export const EMPTY_MENTORING_BUCKETS: MentoringPmidBuckets = {
  all: [],
  byProgram: { md: [], mdphd: [], phd: [], postdoc: [], ecr: [] },
};

let cache: { buckets: MentoringPmidBuckets; ts: number; ok: boolean } | null = null;
let inflight: Promise<MentoringPmidBuckets> | null = null;

function bucketProgramType(programType: string | null): MentoringProgramKey | null {
  if (!programType) return null;
  if (programType === "MDPHD" || programType === "MD-PhD") return "mdphd";
  if (programType === "PhD") return "phd";
  if (programType === "POSTDOC") return "postdoc";
  if (programType === "ECR") return "ecr";
  if (programType === "AOC" || programType.startsWith("AOC-")) return "md";
  return null;
}

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * #928 P2 — dispatch the bucket computation. In-VPC the live ReciterDB join is
 * unreachable, so when `MENTORING_COPUB_BRIDGE=on` we DERIVE the same buckets
 * from already-bridged LOCAL tables (no ReciterDB). Off ⇒ the live join.
 */
async function refresh(): Promise<MentoringPmidBuckets> {
  if (process.env.MENTORING_COPUB_BRIDGE === "on") return refreshFromBridge();
  return refreshFromReciter();
}

/**
 * #928 P2 — derive the buckets from local tables the #930 bridge already
 * populates, with NO ReciterDB dependency:
 *   - `mentee_copublication_pub` holds every (mentor, mentee, pmid) co-authorship
 *     the export computed across ALL three pair sources (AOC + PhD + postdoc), so
 *     the union of its pmids is the "all" set.
 *   - The program type per (mentor, mentee) pair lives in `aoc_mentee`
 *     (AOC/AOC-2025/MDPHD/ECR), `phd_mentor_relationship` (PhD/MD-PhD), and
 *     `postdoc_mentor_relationship` (always POSTDOC).
 *
 * A pair can carry several program types (e.g. AOC + AOC-2025, or appearing
 * under both the AOC and PhD sources), so each co-pub pmid is added to EVERY
 * applicable bucket — mirroring the live path, where each source independently
 * adds the pmid to its own bucket.
 *
 * Parity note vs the live join: the bridge only stores pmids that also have an
 * `analysis_summary_article` row (the export joins it), so a co-authored pmid
 * lacking article metadata is absent here. That is harmless — and arguably more
 * correct — for a Publications-browse facet, whose targets must have article
 * data to be browsable. Coverage is otherwise identical.
 *
 * Like the live path, an empty bridge table (not yet imported) yields empty
 * buckets, which equals the current in-VPC behavior (honest degradation).
 */
async function refreshFromBridge(): Promise<MentoringPmidBuckets> {
  const allSet = new Set<string>();
  const bySet: Record<MentoringProgramKey, Set<string>> = {
    md: new Set(),
    mdphd: new Set(),
    phd: new Set(),
    postdoc: new Set(),
    ecr: new Set(),
  };

  // Program type(s) per "mentor::mentee" pair, unioned across the three
  // relationship sources (a pair may appear in more than one).
  const pairPrograms = new Map<string, Set<string>>();
  const addProgram = (mentor: string, mentee: string, programType: string | null) => {
    if (!programType) return;
    const key = `${mentor}::${mentee}`;
    let set = pairPrograms.get(key);
    if (!set) {
      set = new Set<string>();
      pairPrograms.set(key, set);
    }
    set.add(programType);
  };

  const [aoc, phd, postdoc] = await Promise.all([
    prisma.aocMentee.findMany({
      select: { mentorCwid: true, menteeCwid: true, programType: true },
    }),
    prisma.phdMentorRelationship.findMany({
      select: { mentorCwid: true, menteeCwid: true, programType: true },
    }),
    prisma.postdocMentorRelationship.findMany({
      select: { mentorCwid: true, menteeCwid: true },
    }),
  ]);
  for (const r of aoc) addProgram(r.mentorCwid, r.menteeCwid, r.programType);
  for (const r of phd) addProgram(r.mentorCwid, r.menteeCwid, r.programType);
  for (const r of postdoc) addProgram(r.mentorCwid, r.menteeCwid, "POSTDOC");

  // Every (mentor, mentee, pmid) co-authorship the bridge holds.
  const copubs = await prisma.menteeCopublicationPub.findMany({
    select: { mentorCwid: true, menteeCwid: true, pmid: true },
  });
  for (const r of copubs) {
    const pmid = String(r.pmid);
    allSet.add(pmid);
    const programs = pairPrograms.get(`${r.mentorCwid}::${r.menteeCwid}`);
    if (programs) {
      for (const programType of programs) {
        const bucket = bucketProgramType(programType);
        if (bucket) bySet[bucket].add(pmid);
      }
    }
  }

  return {
    all: [...allSet],
    byProgram: {
      md: [...bySet.md],
      mdphd: [...bySet.mdphd],
      phd: [...bySet.phd],
      postdoc: [...bySet.postdoc],
      ecr: [...bySet.ecr],
    },
  };
}

async function refreshFromReciter(): Promise<MentoringPmidBuckets> {
  const allSet = new Set<string>();
  const bySet: Record<MentoringProgramKey, Set<string>> = {
    md: new Set(),
    mdphd: new Set(),
    phd: new Set(),
    postdoc: new Set(),
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

  // Source 3: postdoc_mentor_relationship (ED postdoc role records). Same
  // tuple-IN pattern as Jenzabar — pairs are local, the co-author graph
  // lives in ReCiter. All pairs map to the `postdoc` bucket (programType
  // is always POSTDOC, no per-pair variance).
  const postdocPairs = await prisma.postdocMentorRelationship.findMany({
    select: { mentorCwid: true, menteeCwid: true },
  });
  if (postdocPairs.length > 0) {
    await withReciterConnection(async (conn) => {
      for (const batch of chunks(postdocPairs, PAIR_BATCH)) {
        const placeholders = batch.map(() => "(?, ?)").join(",");
        const params: string[] = [];
        for (const p of batch) {
          params.push(p.mentorCwid, p.menteeCwid);
        }
        const rows = (await conn.query(
          `SELECT DISTINCT a1.pmid AS pmid
           FROM analysis_summary_author a1
           JOIN analysis_summary_author a2
             ON a1.pmid = a2.pmid AND a2.personIdentifier != a1.personIdentifier
           WHERE a1.pmid IS NOT NULL
             AND (a1.personIdentifier, a2.personIdentifier) IN (${placeholders})`,
          params,
        )) as { pmid: number | bigint }[];
        for (const r of rows) {
          const pmid = String(typeof r.pmid === "bigint" ? Number(r.pmid) : r.pmid);
          allSet.add(pmid);
          bySet.postdoc.add(pmid);
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
      postdoc: [...bySet.postdoc],
      ecr: [...bySet.ecr],
    },
  };
}

/**
 * Issue #610-style guard (mirrors people-classifier-sets.ts `refreshWithTimeout`):
 * race `refresh()` against {@link REFRESH_TIMEOUT_MS}. The underlying ReciterDB /
 * Prisma calls can't be cancelled, so a wedged one keeps running in the
 * background after the timeout; we stop awaiting it and let the caller degrade
 * to empty buckets. The timer is always cleared and `unref`'d so it cannot by
 * itself keep the process alive.
 */
async function refreshWithTimeout(): Promise<MentoringPmidBuckets> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(new Error(`mentoring-pmids refresh exceeded ${REFRESH_TIMEOUT_MS}ms`)),
      REFRESH_TIMEOUT_MS,
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([refresh(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function getMentoringPmidBuckets(): Promise<MentoringPmidBuckets> {
  const now = Date.now();
  // A successful load is cached for TTL_MS; a degraded (empty) result only for
  // NEGATIVE_TTL_MS, so we retry ReciterDB soon after it recovers.
  if (cache && now - cache.ts < (cache.ok ? TTL_MS : NEGATIVE_TTL_MS)) {
    return cache.buckets;
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const buckets = await refreshWithTimeout();
      cache = { buckets, ts: now, ok: true };
      return buckets;
    } catch (err) {
      // ReciterDB unavailable / refresh wedged -> degrade to empty buckets
      // rather than throwing up into the render (the mentoring surfaces simply
      // show nothing). Negative-cache the empty result for NEGATIVE_TTL_MS so a
      // persistent outage costs at most one slow refresh per window, not one per
      // /search render (the ~10s acquireTimeout stall this fixes).
      console.warn("[mentoring-pmids] refresh failed; serving empty buckets", err);
      cache = { buckets: EMPTY_MENTORING_BUCKETS, ts: now, ok: false };
      return EMPTY_MENTORING_BUCKETS;
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
