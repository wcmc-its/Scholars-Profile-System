/**
 * READ-ONLY measurement (NOT an ETL): researcher-exposure concentration in the
 * reverse grant matcher — the /edit/find-researchers admin surface. Refs #1611.
 *
 * WHAT: for every indexed opportunity, take the top-8 via the deployed
 * `rankResearchersForOpportunity` with the admin route's defaults (sort="fit",
 * stageLens off, esiOnly off), then aggregate exposure over the matcher's own
 * eligible-faculty gate: distinct slot-holders vs eligible FT faculty, appearance
 * histogram, Gini, top-1%/top-decile slot shares, professorialRank crosstab, and
 * ESI-eligible shares (via the deployed `deriveGrantSignals`).
 *
 * HOW TO RUN (SELECT/GET only — no writes to any table or index):
 *   - Against a deployed env (authoritative): run this file inside a one-off ECS
 *     run-task of that env's sps-etl-<env> task definition (it already carries the
 *     dep tree, generated Prisma client, tsx, and DATABASE_URL), with network
 *     config copied from the scholars-nightly-<env> Step Function definition and
 *     the script staged into the container at launch. On staging all of that is
 *     one command (it also forces the SELECT-only DB user):
 *       scripts/run-staging-probe.sh scripts/measure-researcher-concentration.ts
 *   - Against a local snapshot: npm run metrics:researcher-concentration
 *     (needs DATABASE_URL pointed at a populated db).
 *   Matcher flags are read from the environment (GRANT_MATCHER_SUBTOPIC_GRAIN,
 *   GRANT_MATCHER_DENSE_REL, GRANT_MATCHER_REL_BOOST). The ETL task def does NOT
 *   carry the app's flag set — replicate the target env's app task-def values into
 *   the run environment, or the measurement answers a different question. The
 *   START line prints what the ranking code actually saw.
 *
 * OUTPUT: one ROW line per opportunity (id, status, hasDsl, ranking path, top-8
 * CWIDs) so aggregates can be recomputed offline, then per scope (ALL / OPEN /
 * PATH_SUBTOPIC / PATH_TOPICVECTOR) one AGG JSON line — coverage, Gini
 * (zeros-included and holders-only), top-1%/top-decile slot shares, appearance
 * histogram, rank crosstab, ESI shares — plus a TOP40 holder list. ROW and TOP40
 * lines contain CWIDs: treat run output as internal-only and never commit it to
 * this (public) repo.
 *
 * BASELINE (staging, 2026-07-09; GRANT_MATCHER_SUBTOPIC_GRAIN=on, dense-rel on,
 * rel-boost 2; 1,151 opportunities): coverage 575/2,390 eligible FT faculty =
 * 24.1%; Gini 0.923 (zeros incl.); top 1% of faculty hold 29.5% of slots and the
 * top decile 90.6%; Professors hold 61.7% of slots vs 15.8% of faculty; ESI 5.7%
 * of slots vs 21.5% of faculty. (That run predates #1606's removal of the
 * translational-IP boost, which was at its default — off — when measured.)
 */
import { rankResearchersForOpportunity, deriveGrantSignals } from "@/lib/api/match-researchers";
import { db, disconnect } from "@/lib/db";
import { TOP_SCHOLARS_ELIGIBLE_ROLES } from "@/lib/eligibility";

const TOP_N = 8; // measurement window (the UI default shows more rows; ordering is the same)
const CONC = 3; // ranking-call concurrency
const OPEN = new Set(["open", "forecasted", "continuous"]);

type Row = { id: string; status: string; hasDsl: boolean; path: string; cwids: string[] };

function gini(values: number[]): number | null {
  const xs = [...values].sort((a, b) => a - b);
  const n = xs.length;
  const sum = xs.reduce((a, b) => a + b, 0);
  if (n === 0 || sum === 0) return null;
  let cum = 0;
  for (let i = 0; i < n; i++) cum += (i + 1) * xs[i];
  return (2 * cum) / (n * sum) - (n + 1) / n;
}

async function main() {
  const now = new Date();
  console.log(
    "START",
    now.toISOString(),
    "subtopicGrainFlag=",
    process.env.GRANT_MATCHER_SUBTOPIC_GRAIN ?? "(unset)",
    "denseRelEnv=",
    process.env.GRANT_MATCHER_DENSE_REL ?? "(unset->on)",
    "relBoostEnv=",
    process.env.GRANT_MATCHER_REL_BOOST ?? "(unset->2)",
  );

  const opps = await db.read.opportunity.findMany({
    select: { opportunityId: true, status: true, matchDsl: true },
    orderBy: { opportunityId: "asc" },
  });
  console.log("OPPS_TOTAL", opps.length);

  const rows: Row[] = [];
  let done = 0;
  const queue = opps.slice();
  async function worker() {
    for (;;) {
      const o = queue.shift();
      if (!o) return;
      const d = o.matchDsl as { require?: unknown } | null;
      const hasDsl = !!(
        d &&
        typeof d === "object" &&
        !Array.isArray(d) &&
        Array.isArray(d.require) &&
        d.require.length > 0
      );
      let row: Row;
      try {
        const ranked = await Promise.race([
          rankResearchersForOpportunity(o.opportunityId, { limit: TOP_N }),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout180s")), 180000)),
        ]);
        const path =
          ranked.length === 0
            ? "none"
            : ranked[0].topicContributions.some((c) => c.topicId === "__grant_subtopic__")
              ? "subtopic"
              : "topicVector";
        row = {
          id: o.opportunityId,
          status: o.status,
          hasDsl,
          path,
          cwids: ranked.map((r) => r.cwid),
        };
      } catch (e) {
        row = {
          id: o.opportunityId,
          status: o.status,
          hasDsl,
          path: "ERROR:" + String((e as Error)?.message ?? e).slice(0, 60),
          cwids: [],
        };
      }
      rows.push(row);
      done++;
      if (done % 100 === 0)
        console.log("PROGRESS", done, "/", opps.length, new Date().toISOString());
    }
  }
  await Promise.all(Array.from({ length: CONC }, () => worker()));

  for (const r of rows)
    console.log(["ROW", r.id, r.status, r.hasDsl ? 1 : 0, r.path, r.cwids.join(",")].join("\t"));

  // Eligible-faculty snapshot = the matcher's own candidate gate (FT, active, not deleted).
  const faculty = await db.read.scholar.findMany({
    where: {
      deletedAt: null,
      status: "active",
      roleCategory: { in: [...TOP_SCHOLARS_ELIGIBLE_ROLES] },
    },
    select: {
      cwid: true,
      professorialRank: true,
      educations: { select: { year: true, degree: true } },
      grants: { select: { endDate: true, role: true, mechanism: true } },
    },
  });
  const rankByCwid = new Map<string, string>();
  const esiByCwid = new Map<string, boolean>();
  for (const s of faculty) {
    rankByCwid.set(s.cwid, s.professorialRank ?? "None/Unranked");
    esiByCwid.set(
      s.cwid,
      deriveGrantSignals({ grants: s.grants, educations: s.educations }, now).esiEligible,
    );
  }
  const facultyEsi = [...esiByCwid.values()].filter(Boolean).length;
  console.log("FACULTY_TOTAL", faculty.length, "FACULTY_ESI_ELIGIBLE", facultyEsi);
  const baselineRank: Record<string, number> = {};
  for (const s of faculty) {
    const k = s.professorialRank ?? "None/Unranked";
    baselineRank[k] = (baselineRank[k] ?? 0) + 1;
  }
  console.log("BASELINE_RANK", JSON.stringify(baselineRank));

  function aggregate(scope: string, sel: (r: Row) => boolean) {
    const selRows = rows.filter(sel);
    const app = new Map<string, number>();
    let slots = 0,
      withResults = 0,
      errors = 0;
    for (const r of selRows) {
      if (r.path.startsWith("ERROR")) {
        errors++;
        continue;
      }
      if (r.cwids.length > 0) withResults++;
      for (const c of r.cwids) {
        app.set(c, (app.get(c) ?? 0) + 1);
        slots++;
      }
    }
    const holders = [...app.entries()].sort((a, b) => b[1] - a[1]);
    const hist: Record<string, number> = {};
    for (const [, n] of holders) {
      const b =
        n === 1
          ? "1"
          : n === 2
            ? "2"
            : n === 3
              ? "3"
              : n === 4
                ? "4"
                : n <= 9
                  ? "5-9"
                  : n <= 19
                    ? "10-19"
                    : n <= 49
                      ? "20-49"
                      : n <= 99
                        ? "50-99"
                        : "100+";
      hist[b] = (hist[b] ?? 0) + 1;
    }
    // Population = eligible faculty (zeros included) + any holders outside the snapshot.
    const counts = faculty.map((s) => app.get(s.cwid) ?? 0);
    const outside = holders.filter(([c]) => !rankByCwid.has(c));
    for (const [, n] of outside) counts.push(n);
    const gAll = gini(counts);
    const gHold = gini(holders.map(([, n]) => n));
    const totalPop = counts.length;
    const sortedDesc = [...counts].sort((a, b) => b - a);
    const share = (frac: number) => {
      if (slots === 0) return null;
      const k = Math.max(1, Math.ceil(frac * totalPop));
      return sortedDesc.slice(0, k).reduce((a, b) => a + b, 0) / slots;
    };
    const rankTab: Record<string, { holders: number; slots: number }> = {};
    let esiHolders = 0,
      esiSlots = 0,
      holdersInSnap = 0,
      slotsInSnap = 0;
    for (const [c, n] of holders) {
      const rk = rankByCwid.get(c);
      if (rk === undefined) continue;
      holdersInSnap++;
      slotsInSnap += n;
      rankTab[rk] ??= { holders: 0, slots: 0 };
      rankTab[rk].holders++;
      rankTab[rk].slots += n;
      if (esiByCwid.get(c)) {
        esiHolders++;
        esiSlots += n;
      }
    }
    const agg = {
      scope,
      opportunities: selRows.length,
      errors,
      withResults,
      slots,
      distinctHolders: holders.length,
      holdersOutsideSnapshot: outside.length,
      eligibleFaculty: faculty.length,
      histogram: hist,
      giniInclZeros: gAll,
      giniHoldersOnly: gHold,
      top1pctShareOfSlots: share(0.01),
      top10pctShareOfSlots: share(0.1),
      maxAppearances: holders[0]?.[1] ?? 0,
      rankCrosstab: rankTab,
      holdersInSnap,
      slotsInSnap,
      esi: {
        holdersEsiEligible: esiHolders,
        holderEsiShare: holdersInSnap ? esiHolders / holdersInSnap : null,
        slotEsiShare: slotsInSnap ? esiSlots / slotsInSnap : null,
        facultyEsiShare: faculty.length ? facultyEsi / faculty.length : null,
      },
    };
    console.log("AGG", JSON.stringify(agg));
    if (scope === "ALL") {
      console.log(
        "TOP40",
        JSON.stringify(
          holders.slice(0, 40).map(([c, n]) => ({
            cwid: c,
            n,
            rank: rankByCwid.get(c) ?? "?",
            esi: esiByCwid.get(c) ?? null,
          })),
        ),
      );
    }
  }

  aggregate("ALL", () => true);
  aggregate("OPEN", (r) => OPEN.has(r.status));
  aggregate("PATH_SUBTOPIC", (r) => r.path === "subtopic");
  aggregate("PATH_TOPICVECTOR", (r) => r.path === "topicVector");

  console.log("DONE", new Date().toISOString());
  await disconnect();
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
