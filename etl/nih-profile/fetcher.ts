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
const PAGE_LIMIT = 500;
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
