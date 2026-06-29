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
 * when the nightly ETL adds or removes scholars. A failed (or timed-out)
 * refresh degrades to empty sets (the classifier then detects no
 * name/department shapes, yielding less precise telemetry but never breaking
 * search) and is NOT cached, so the next request retries. Cache shape mirrors
 * `lib/api/mentoring-pmids.ts`.
 */
import { prisma } from "@/lib/db";
import { PEOPLE_INDEX, searchClient } from "@/lib/search";

const TTL_MS = 24 * 60 * 60 * 1000; // daily — SPEC §6.1.1

/**
 * Issue #610 — hard ceiling on a single refresh. The People search awaits this
 * cache before every query (it picks the §6.1 ranking template), so a refresh
 * that never settles wedges the whole tab: because the in-progress refresh is
 * memoized as `inflight`, *every* subsequent People search returns that same
 * never-settling promise until the process restarts. The local repro that
 * filed #610 was exactly this — People search hung >12s while a bare
 * OpenSearch round-trip was 22ms — and a wedged Prisma pool / unresponsive
 * OpenSearch connection would reproduce it in prod too.
 *
 * The underlying work is tiny (surname terms-agg ~20ms, the cwid/department
 * `findMany` ~7ms), so 2s is ~100x headroom: a refresh that blows past it is
 * wedged, not slow. On timeout we throw, which the existing catch turns into
 * uncached EMPTY_SETS — identical to an errored refresh — so People search
 * falls back to the restructured-msm body and the next request retries.
 */
const REFRESH_TIMEOUT_MS = 2000;

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
  /**
   * #1347 — lowercased `Division.name` → its `deptDivKey`(s) (`${deptCode}--${code}`).
   * Clinical divisions are NEVER a `primaryDepartment`, so the classifier can't route
   * a bare division-name query to the department template (it falls to topic_template);
   * this set is the missing vocabulary AND the roster-filter lookup. A name can map to
   * >1 division (same name across departments), hence an array. Only consumed when
   * SEARCH_PEOPLE_DIVISION_SHAPE is on.
   */
  divisions: ReadonlyMap<string, string[]>;
}

const EMPTY_SETS: PeopleClassifierSets = {
  surnames: new Set(),
  cwids: new Set(),
  departments: new Set(),
  divisions: new Map(),
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

/**
 * #1347 — lowercased `Division.name` → `deptDivKey`(s). Clinical divisions are
 * Divisions OF a department (never a `primaryDepartment`), so they need their own
 * vocabulary for the classifier + a name→roster lookup for the search filter.
 */
async function loadDivisions(): Promise<Map<string, string[]>> {
  const rows = await prisma.division.findMany({
    select: { name: true, code: true, deptCode: true },
  });
  const divisions = new Map<string, string[]>();
  for (const row of rows) {
    const key = row.name.toLowerCase();
    const deptDivKey = `${row.deptCode}--${row.code}`;
    const existing = divisions.get(key);
    if (existing) existing.push(deptDivKey);
    else divisions.set(key, [deptDivKey]);
  }
  return divisions;
}

async function refresh(): Promise<PeopleClassifierSets> {
  const [surnames, cwidsAndDepartments, divisions] = await Promise.all([
    loadSurnames(),
    loadCwidsAndDepartments(),
    loadDivisions(),
  ]);
  return { surnames, ...cwidsAndDepartments, divisions };
}

/**
 * Issue #610 — `refresh()` raced against {@link REFRESH_TIMEOUT_MS}. The
 * underlying DB / OpenSearch calls cannot be cancelled, so a wedged one keeps
 * running in the background after the timeout; we simply stop awaiting it and
 * let the caller's catch degrade to EMPTY_SETS. The timer is always cleared so
 * a fast refresh never leaves a dangling handle, and `unref`'d so it cannot by
 * itself keep a Node process alive.
 */
async function refreshWithTimeout(): Promise<PeopleClassifierSets> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `classifier-set refresh exceeded ${REFRESH_TIMEOUT_MS}ms`,
          ),
        ),
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

/**
 * The classifier lookup sets, cached for {@link TTL_MS}. A failed or timed-out
 * (#610, {@link REFRESH_TIMEOUT_MS}) refresh returns {@link EMPTY_SETS} uncached
 * so the next call retries — a sets-load failure never blocks or breaks the
 * People search (the classifier degrades to no name/department shapes).
 */
export async function getPeopleClassifierSets(): Promise<PeopleClassifierSets> {
  const now = Date.now();
  if (cache && now - cache.ts < TTL_MS) return cache.sets;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const sets = await refreshWithTimeout();
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
