/**
 * Issue #308 / SPEC §6.1.1 — boot-cached lookup sets for the People-tab
 * query-shape classifier (`people-query-shape.ts`).
 *
 * Two sets, two sources:
 *   - departments — distinct `Scholar.primaryDepartment` from the application
 *     database (Prisma);
 *   - surnames    — distinct `lastNameSort` from the `scholars-people`
 *     OpenSearch index. `lastNameSort` is an ETL-built index field, NOT a
 *     Prisma column (the SPEC §6.1.1 "built from a Prisma query" wording is
 *     inaccurate — see #308). It is the same suffix-stripped surname token the
 *     name-shape template (SPEC PR-2) searches, so the classifier must read it
 *     from there for the two to agree.
 *
 * Cached for a day and refreshed lazily — surnames and departments change only
 * when the nightly ETL adds or removes scholars. A failed refresh degrades to
 * empty sets (the classifier then detects no name/department shapes, yielding
 * less precise telemetry but never breaking search) and is NOT cached, so the
 * next request retries. Cache shape mirrors `lib/api/mentoring-pmids.ts`.
 */
import { prisma } from "@/lib/db";
import { PEOPLE_INDEX, searchClient } from "@/lib/search";

const TTL_MS = 24 * 60 * 60 * 1000; // daily — SPEC §6.1.1

/**
 * `terms`-aggregation size cap for the surname sweep. Comfortably above the
 * distinct-surname count of the WCM scholar corpus (low thousands); switch to
 * a `composite` aggregation if the corpus ever approaches this.
 */
const SURNAME_AGG_SIZE = 20000;

export interface PeopleClassifierSets {
  /** Lowercased `lastNameSort` values from the people index. */
  surnames: ReadonlySet<string>;
  /** Lowercased `Scholar.cwid` values — for exact CWID detection. */
  cwids: ReadonlySet<string>;
  /** Lowercased distinct `Scholar.primaryDepartment` values. */
  departments: ReadonlySet<string>;
}

const EMPTY_SETS: PeopleClassifierSets = {
  surnames: new Set(),
  cwids: new Set(),
  departments: new Set(),
};

let cache: { sets: PeopleClassifierSets; ts: number } | null = null;
let inflight: Promise<PeopleClassifierSets> | null = null;

/** Distinct `lastNameSort` values from the people index, lowercased. */
async function loadSurnames(): Promise<Set<string>> {
  const resp = await searchClient().search({
    index: PEOPLE_INDEX,
    body: {
      size: 0,
      aggs: {
        surnames: { terms: { field: "lastNameSort", size: SURNAME_AGG_SIZE } },
      },
    } as object,
  });
  const r = resp.body as unknown as {
    aggregations?: { surnames?: { buckets?: { key: string }[] } };
  };
  const buckets = r.aggregations?.surnames?.buckets ?? [];
  return new Set(buckets.map((b) => b.key.toLowerCase()));
}

/**
 * `Scholar.cwid` and distinct `Scholar.primaryDepartment` for active scholars,
 * lowercased. One Prisma query yields both — `cwid` is the PK so every active
 * scholar is one row and no `distinct` is needed; the Sets dedupe departments.
 */
async function loadCwidsAndDepartments(): Promise<{
  cwids: Set<string>;
  departments: Set<string>;
}> {
  const rows = await prisma.scholar.findMany({
    where: { deletedAt: null, status: "active" },
    select: { cwid: true, primaryDepartment: true },
  });
  const cwids = new Set<string>();
  const departments = new Set<string>();
  for (const row of rows) {
    cwids.add(row.cwid.toLowerCase());
    if (row.primaryDepartment) departments.add(row.primaryDepartment.toLowerCase());
  }
  return { cwids, departments };
}

async function refresh(): Promise<PeopleClassifierSets> {
  const [surnames, cwidsAndDepartments] = await Promise.all([
    loadSurnames(),
    loadCwidsAndDepartments(),
  ]);
  return { surnames, ...cwidsAndDepartments };
}

/**
 * The classifier lookup sets, cached for {@link TTL_MS}. A failed refresh
 * returns {@link EMPTY_SETS} uncached so the next call retries — a sets-load
 * failure never blocks or breaks the People search (PR-1 is telemetry-only).
 */
export async function getPeopleClassifierSets(): Promise<PeopleClassifierSets> {
  const now = Date.now();
  if (cache && now - cache.ts < TTL_MS) return cache.sets;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const sets = await refresh();
      cache = { sets, ts: now };
      return sets;
    } catch (err) {
      console.warn(
        "[people-classifier-sets] refresh failed; classifier degrades to empty sets",
        err,
      );
      return EMPTY_SETS;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
