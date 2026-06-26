/**
 * Issue #90 — direct NIH RePORTER /projects/search client.
 *
 * Reads `principal_investigators[].profile_id` for every project where
 * `org_names` includes WCM. The PI profile_id is the stable NIH-side key
 * that drives the outbound "View NIH portfolio on RePORTER" link on the
 * scholar profile.
 *
 * Pagination strategy: NIH RePORTER caps offset at 9,999, and WCM has
 * ~15K total projects across all years. Partitioning by fiscal_year
 * keeps each call's result set well under the cap (~660/year currently).
 *
 * Rate limit: NIH publishes 1 req/sec. The fetcher sleeps between pages
 * regardless of upstream backoff signals — no need to be more aggressive.
 */

const NIH_API = "https://api.reporter.nih.gov/v2/projects/search";
const NIH_PUBLICATIONS_API = "https://api.reporter.nih.gov/v2/publications/search";
const PAGE_LIMIT = 500;
/** core_project_nums per publications/search request. Keeps the criteria array
 *  bounded; a candidate's cores are unioned across batches by the caller. */
const CORE_NUMS_BATCH = 50;
const REQ_DELAY_MS = 1000;
const ORG_NAME = "WEILL MEDICAL COLL OF CORNELL UNIV";

/** Subset of fields we actually consume — RePORTER returns much more. */
export type ReporterPI = {
  profile_id: number;
  first_name: string | null;
  middle_name: string | null;
  last_name: string | null;
  full_name: string | null;
  is_contact_pi: boolean;
  title: string | null;
};

export type ReporterProject = {
  appl_id: number;
  core_project_num: string | null;
  project_end_date: string | null;
  principal_investigators: ReporterPI[];
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchOnePage(
  fiscalYear: number,
  offset: number,
): Promise<{ results: ReporterProject[]; total: number }> {
  const resp = await fetch(NIH_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      criteria: {
        org_names: [ORG_NAME],
        fiscal_years: [fiscalYear],
      },
      include_fields: [
        "ApplId",
        "CoreProjectNum",
        "ProjectEndDate",
        "PrincipalInvestigators",
      ],
      limit: PAGE_LIMIT,
      offset,
    }),
    cache: "no-store",
  });
  if (!resp.ok) {
    throw new Error(
      `NIH RePORTER /projects/search failed: HTTP ${resp.status} (FY ${fiscalYear}, offset ${offset})`,
    );
  }
  const data = (await resp.json()) as {
    meta?: { total?: number };
    results?: Array<{
      appl_id: number;
      core_project_num: string | null;
      project_end_date: string | null;
      principal_investigators?: ReporterPI[];
    }>;
  };
  const results: ReporterProject[] = (data.results ?? []).map((r) => ({
    appl_id: r.appl_id,
    core_project_num: r.core_project_num,
    project_end_date: r.project_end_date,
    // RePORTER occasionally returns PIs without a profile_id (legacy
    // entries, placeholder rows). Drop them at the boundary so the
    // resolver never has to think about null IDs.
    principal_investigators: (r.principal_investigators ?? []).filter(
      (pi) => typeof pi.profile_id === "number" && pi.profile_id > 0,
    ),
  }));
  return { results, total: data.meta?.total ?? 0 };
}

/**
 * Fetch every WCM-attributed project across the requested fiscal-year
 * range, oldest year last. Yields one project at a time so the caller can
 * stream into the resolver without buffering the full dataset in memory.
 */
export async function* iterateWcmProjects(opts: {
  fromFiscalYear: number;
  toFiscalYear: number;
}): AsyncGenerator<ReporterProject, void, undefined> {
  const { fromFiscalYear, toFiscalYear } = opts;
  for (let fy = toFiscalYear; fy >= fromFiscalYear; fy--) {
    let offset = 0;
    let pageNum = 0;
    let total: number | null = null;
    while (true) {
      const { results, total: t } = await fetchOnePage(fy, offset);
      if (total === null) {
        total = t;
        if (total === 0) break; // year has no WCM projects
      }
      for (const proj of results) yield proj;
      pageNum++;
      offset += results.length;
      if (results.length < PAGE_LIMIT || offset >= total) break;
      // Defensive: NIH caps offset at 9,999. If a single FY ever exceeds
      // that, we'd silently drop the tail. Loud-fail instead.
      if (offset >= 9999) {
        throw new Error(
          `FY ${fy} exceeds NIH RePORTER's 9,999-offset cap (total ${total}). ` +
            `Sub-partition (e.g. by activity_code) before backfilling further.`,
        );
      }
      await sleep(REQ_DELAY_MS);
    }
    if (total !== null && total > 0) {
      console.log(`  FY ${fy}: ${total} projects (${pageNum} page${pageNum === 1 ? "" : "s"})`);
    }
    await sleep(REQ_DELAY_MS);
  }
}

/**
 * Issue #90 (subaward path) — search RePORTER by PI name. Recovers
 * scholars who hold WCM subawards on someone else's prime grant: the
 * sub-PI doesn't appear in the prime project's `principal_investigators[]`,
 * but RePORTER's `pi_names` filter indexes them. The matched results
 * carry `principal_investigators[]` from projects where the scholar was
 * the contact PI elsewhere (previous institution, prior R01, etc.) — and
 * those entries carry the same profile_id we need.
 *
 * Caller passes one (firstName, lastName) per call. Single-page only —
 * if a scholar has more than 500 NIH projects we'd hit edge cases worth
 * investigating manually anyway.
 */
export async function searchProjectsByPiName(opts: {
  firstName: string;
  lastName: string;
}): Promise<ReporterProject[]> {
  const resp = await fetch(NIH_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      criteria: {
        pi_names: [{ first_name: opts.firstName, last_name: opts.lastName }],
      },
      include_fields: [
        "ApplId",
        "CoreProjectNum",
        "ProjectEndDate",
        "PrincipalInvestigators",
      ],
      limit: PAGE_LIMIT,
      offset: 0,
    }),
    cache: "no-store",
  });
  if (!resp.ok) {
    throw new Error(
      `NIH RePORTER pi_names search failed: HTTP ${resp.status} (${opts.firstName} ${opts.lastName})`,
    );
  }
  const data = (await resp.json()) as {
    results?: Array<{
      appl_id: number;
      core_project_num: string | null;
      project_end_date: string | null;
      principal_investigators?: ReporterPI[];
    }>;
  };
  return (data.results ?? []).map((r) => ({
    appl_id: r.appl_id,
    core_project_num: r.core_project_num,
    project_end_date: r.project_end_date,
    principal_investigators: (r.principal_investigators ?? []).filter(
      (pi) => typeof pi.profile_id === "number" && pi.profile_id > 0,
    ),
  }));
}

/**
 * Look up the projects (and thus the PI names) for a set of NIH eRA Commons
 * `profile_id`s. Used by the one-off `cleanup-misattributed` script (#766) to
 * recover the real name behind a `nih_profile_id` so a wrong-person row can be
 * told from a legitimate one — `person_nih_profile` stores only the id.
 *
 * `criteria.pi_profile_ids` matches any project where one of the listed
 * profile_ids is a PI; the returned `principal_investigators[]` carry the
 * canonical full_name for that id. Pass a bounded batch (≤ ~50) per call.
 */
export async function searchProjectsByProfileIds(
  profileIds: number[],
): Promise<ReporterProject[]> {
  if (profileIds.length === 0) return [];
  const resp = await fetch(NIH_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      criteria: { pi_profile_ids: profileIds },
      include_fields: [
        "ApplId",
        "CoreProjectNum",
        "ProjectEndDate",
        "PrincipalInvestigators",
      ],
      limit: PAGE_LIMIT,
      offset: 0,
    }),
    cache: "no-store",
  });
  if (!resp.ok) {
    throw new Error(
      `NIH RePORTER pi_profile_ids search failed: HTTP ${resp.status} (${profileIds.length} ids)`,
    );
  }
  const data = (await resp.json()) as {
    results?: Array<{
      appl_id: number;
      core_project_num: string | null;
      project_end_date: string | null;
      principal_investigators?: ReporterPI[];
    }>;
  };
  return (data.results ?? []).map((r) => ({
    appl_id: r.appl_id,
    core_project_num: r.core_project_num,
    project_end_date: r.project_end_date,
    principal_investigators: (r.principal_investigators ?? []).filter(
      (pi) => typeof pi.profile_id === "number" && pi.profile_id > 0,
    ),
  }));
}

/** Sleep helper — exposed so the orchestrator can throttle batch loops
 *  without re-importing setTimeout. */
export function sleepBetweenRequests(): Promise<void> {
  return sleep(REQ_DELAY_MS);
}

/** One RePORTER publication linkage row — a grant's `core_project_num` paired
 *  with a PubMed id (and the linking application id). The PMID is what the v2
 *  matcher intersects with a scholar's trusted PubMed set. */
export type ReporterPublication = {
  coreProjectNum: string | null;
  pmid: number;
  applId: number | null;
};

/**
 * v2 PMID-overlap matcher (spec §4.3) — fetch the publications linked to a set of
 * grant `core_project_num`s via RePORTER `POST /v2/publications/search`. Same
 * public API + 1 req/s throttle as the project fetchers above. The core-num set
 * is chunked (the criteria array is bounded) and each chunk is offset-paginated;
 * the caller unions the returned PMIDs into a candidate's `grantPmids` Set, so
 * cross-chunk duplicates are harmless. Returns one row per (core, pmid) linkage.
 */
export async function fetchPublicationsByCoreProjectNums(
  coreNums: string[],
): Promise<ReporterPublication[]> {
  const cores = coreNums.filter((c) => !!c && c.trim().length > 0);
  if (cores.length === 0) return [];
  const out: ReporterPublication[] = [];

  for (let i = 0; i < cores.length; i += CORE_NUMS_BATCH) {
    const batch = cores.slice(i, i + CORE_NUMS_BATCH);
    let offset = 0;
    let total: number | null = null;
    while (true) {
      const resp = await fetch(NIH_PUBLICATIONS_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          criteria: { core_project_nums: batch },
          limit: PAGE_LIMIT,
          offset,
        }),
        cache: "no-store",
      });
      if (!resp.ok) {
        throw new Error(
          `NIH RePORTER /publications/search failed: HTTP ${resp.status} ` +
            `(${batch.length} cores, offset ${offset})`,
        );
      }
      const data = (await resp.json()) as {
        meta?: { total?: number };
        results?: Array<{
          coreproject?: string | null;
          pmid?: number | null;
          applid?: number | null;
        }>;
      };
      const results = data.results ?? [];
      for (const r of results) {
        // Drop rows without a usable PMID — they can't discriminate a candidate.
        if (typeof r.pmid !== "number" || r.pmid <= 0) continue;
        out.push({
          coreProjectNum: r.coreproject ?? null,
          pmid: r.pmid,
          applId: typeof r.applid === "number" ? r.applid : null,
        });
      }
      if (total === null) total = data.meta?.total ?? 0;
      offset += results.length;
      if (results.length < PAGE_LIMIT || offset >= total) break;
      if (offset >= 9999) {
        throw new Error(
          `publications for cores [${batch.join(",")}] exceed the 9,999-offset ` +
            `cap (total ${total}). Sub-batch before fetching further.`,
        );
      }
      await sleep(REQ_DELAY_MS);
    }
    await sleep(REQ_DELAY_MS);
  }
  return out;
}

/** A RePORTER project row with the fiscal/financial fields the grant
 *  materialization (`etl/reporter-grants`) needs to build a `Grant` row —
 *  richer than {@link ReporterProject}, which only carries what the
 *  profile-id resolver consumes. One row = one fiscal year of one award. */
export type ReporterGrantProject = {
  appl_id: number;
  core_project_num: string | null;
  project_num: string | null;
  fiscal_year: number | null;
  project_start_date: string | null;
  project_end_date: string | null;
  award_amount: number | null;
  org_name: string | null;
  project_title: string | null;
};

/**
 * Fetch the full project history (every fiscal year of every award) for a set
 * of eRA Commons `profile_id`s, with the fiscal/financial fields the grant
 * materializer needs. Reuses the same `/projects/search` client + 1 req/s rate
 * limit as the resolver; pass one scholar's confirmed profile_id(s) per call so
 * the result is that person's union across institutions. Offset-paginated —
 * a single person's set is tiny, well under the 9,999 cap (loud-fails if not).
 */
export async function fetchGrantProjectsByProfileIds(
  profileIds: number[],
): Promise<ReporterGrantProject[]> {
  if (profileIds.length === 0) return [];
  const out: ReporterGrantProject[] = [];
  let offset = 0;
  let total: number | null = null;
  while (true) {
    const resp = await fetch(NIH_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        criteria: { pi_profile_ids: profileIds },
        include_fields: [
          "ApplId",
          "CoreProjectNum",
          "ProjectNum",
          "FiscalYear",
          "ProjectStartDate",
          "ProjectEndDate",
          "AwardAmount",
          "Organization",
          "ProjectTitle",
        ],
        limit: PAGE_LIMIT,
        offset,
      }),
      cache: "no-store",
    });
    if (!resp.ok) {
      throw new Error(
        `NIH RePORTER pi_profile_ids grant search failed: HTTP ${resp.status} ` +
          `(${profileIds.length} ids, offset ${offset})`,
      );
    }
    const data = (await resp.json()) as {
      meta?: { total?: number };
      results?: Array<{
        appl_id: number;
        core_project_num: string | null;
        project_num: string | null;
        fiscal_year: number | null;
        project_start_date: string | null;
        project_end_date: string | null;
        award_amount: number | null;
        organization?: { org_name?: string | null } | null;
        project_title: string | null;
      }>;
    };
    const results = data.results ?? [];
    for (const r of results) {
      out.push({
        appl_id: r.appl_id,
        core_project_num: r.core_project_num,
        project_num: r.project_num,
        fiscal_year: r.fiscal_year,
        project_start_date: r.project_start_date,
        project_end_date: r.project_end_date,
        award_amount: r.award_amount,
        org_name: r.organization?.org_name ?? null,
        project_title: r.project_title,
      });
    }
    if (total === null) total = data.meta?.total ?? 0;
    offset += results.length;
    if (results.length < PAGE_LIMIT || offset >= total) break;
    if (offset >= 9999) {
      throw new Error(
        `profile_ids [${profileIds.join(",")}] exceed the 9,999-offset cap ` +
          `(total ${total}). Sub-partition before fetching further.`,
      );
    }
    await sleep(REQ_DELAY_MS);
  }
  return out;
}
