/**
 * `/edit/usage` — the in-app Usage dashboard. Site-wide CloudFront usage over a
 * chosen range (the header's Range dropdown: last 7 / 30 / 90 days, since
 * launch, or custom; default last 30) — pageviews trend, top profiles, typed
 * and suggested search terms (+ a searches tile), geo, device — read from the durable `daily_usage` Athena
 * rollup via a daily-cached loader keyed per range. The traffic sections (hits,
 * pageviews, visitors, where visits come from, referring sites and pages, top
 * and landing pages, AI) read the `daily_traffic` rollup (lib/api/usage-traffic)
 * with their own fail-soft; their client island is ./traffic-widgets.
 * The viewer-friendly companion to the Athena console + the `sps-usage-*` saved
 * queries: aggregates only (no PII), no per-URL performance (those read raw logs
 * and stay operator-restricted).
 *
 * Also carries service health (uptime + alarm-firing KPI tiles and a monthly
 * "Uptime since launch" card), read from CloudWatch via
 * lib/api/service-health.ts — independent of the Athena data above, with its
 * own fail-soft. The hourly card's profile-edits line reads the audit log
 * (lib/api/usage-edits.ts) and fails soft on its own too: a DB error drops the
 * line and says so, leaving the traffic bars.
 *
 * Layout (2026-09 page revision): header, a four-tile KPI row, the pageviews
 * chart card, the "Traffic by hour" card (served / bot or challenged / error,
 * Eastern time, plus a profile-edits line),
 * Top profiles + Top typed search terms side by side (Suggested
 * searches wraps below), the traffic sections (./traffic-widgets), the
 * Geography and Device cards, then the uptime card. The interactive bits (chart hover, Show
 * all, client-side CSV, the uptime ⓘ) are client islands in ./usage-widgets.
 *
 * Audience: a **superuser** or **any unit administrator** (owner/curator) —
 * `canViewUsage`. A department / division / center admin sees the profile
 * sections (pageviews tile and chart, busiest day, top profiles, top pages,
 * the edits line) for their own people, and every other section unchanged
 * under a "Site-wide" heading; everyone else sees the whole page site-wide
 * (`loadDashboardScope`, decision 2026-11-17). The scope comes from the
 * session; the unit's numbers are small Athena reads over its own slugs,
 * cached per slug set, apart from the site-wide entries. Re-checked on
 * every GET; the DATA is cached (daily / 12h) but the AUTH is not. Fails soft
 * to an "unavailable" notice per section if its own data source errors
 * (mirrors the /edit/activity pattern).
 */
import { redirect } from "next/navigation";

import { ConsoleShell } from "@/components/edit/console-shell";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import {
  type MonthlyAvailability,
  type ServiceHealthSummary,
  loadServiceHealth,
  summarizeServiceHealth,
} from "@/lib/api/service-health";
import { SEARCH_STATS_START } from "@/lib/analytics/usage-queries";
import { loadEditsByHour, loadEditsByHourUncached } from "@/lib/api/usage-edits";
import type { EditHour } from "@/lib/api/usage-hourly";
import { type UsageRange, addDays, resolveUsageRange } from "@/lib/api/usage-range";
import type { TrafficOverview } from "@/lib/analytics/traffic-view";
import { loadTrafficOverview } from "@/lib/api/usage-traffic";
import {
  type NamedCount,
  type SearchVolume,
  type UsageSummary,
  loadScopedProfileViews,
  loadUsageSummary,
  scopeUsageSummary,
} from "@/lib/api/usage-summary";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import {
  activityScopeSql,
  canViewDashboard,
  loadDashboardScope,
  loadScopeSlugs,
} from "@/lib/edit/dashboard-access";
import { db } from "@/lib/db";
import { logEditDenial } from "@/lib/edit/authz";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";
import { cn } from "@/lib/utils";

import { TopPages, TrafficSection } from "./traffic-widgets";
import { fillDayGaps, monthLabel, pctLabel, shortDay } from "./usage-format";
import {
  HourlyTrafficChart,
  PageviewsChart,
  RankTable,
  UptimeInfoButton,
  UsageRangePicker,
  type RankRow,
} from "./usage-widgets";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Usage — Scholars Console",
  robots: { index: false, follow: false },
};

const cardClass = "border-apollo-border-strong bg-apollo-surface rounded-[13px] border";

/** One headline number: uppercase label, big value, muted sub-line. */
function KpiTile({
  label,
  value,
  sub,
  testId,
}: {
  label: string;
  value: string;
  sub: string;
  testId?: string;
}) {
  return (
    <div className={cn(cardClass, "flex flex-col gap-1 px-[18px] py-4")}>
      <span className="text-muted-foreground text-xs font-medium tracking-[.1em] uppercase">
        {label}
      </span>
      <span className="text-3xl font-semibold tracking-[-.01em] tabular-nums" data-testid={testId}>
        {value}
      </span>
      <span className="text-muted-foreground text-[13px]">{sub}</span>
    </div>
  );
}

/** The selected range as a tile sub-line phrase: "last 7 days", "since
 *  launch", or a custom range's "Oct 1 – Oct 15". */
function rangePhrase(range: UsageRange): string {
  if (range.key === "launch") return "since launch";
  if (range.key === "custom") return `${shortDay(range.since)} – ${shortDay(range.until)}`;
  return `last ${range.days} days`;
}

/** The alarm tile's sub-line. CloudWatch keeps only 30 days of alarm history,
 *  so a longer or older range says what the count actually covers. */
function alarmSub(health: ServiceHealthSummary, range: UsageRange): string {
  if (health.alarmCoverage === "none") return "CloudWatch keeps only 30 days of alarm history";
  if (health.alarmCoverage === "partial") {
    return `fired since ${shortDay(health.alarmSince)} (CloudWatch keeps 30 days)`;
  }
  return range.key === "launch" || range.key === "custom"
    ? `fired ${rangePhrase(range)}`
    : `fired in ${rangePhrase(range)}`;
}

/** Search counts start at SEARCH_STATS_START; say so wherever they show. */
const SEARCH_START_NOTE = `Counted from ${shortDay(SEARCH_STATS_START)}: earlier days were inflated by link prefetching and can't be corrected.`;

/** The searches tile's sub-line: typed vs suggestion clicks. */
function searchSplitSub({ typed, suggested }: SearchVolume): string {
  return typed + suggested === 0
    ? "no searches recorded"
    : `${typed.toLocaleString()} typed · ${suggested.toLocaleString()} from suggestions`;
}

/** Headline row: pageviews + busiest day + searches (Athena rollup), uptime + alarm
 *  firings (CloudWatch). Every tile follows the header's Range. Each pair
 *  fails soft on its own source. A unit-scoped page draws the row twice:
 *  `part="unit"` is the two profile tiles (the viewer's people), `part="site"`
 *  the rest. */
function KpiRow({
  summary,
  health,
  range,
  part,
}: {
  summary: UsageSummary | null;
  health: ServiceHealthSummary | null;
  range: UsageRange;
  part?: "unit" | "site";
}) {
  const days = summary?.pageviewsByDay ?? [];
  const peak = days.reduce<(typeof days)[number] | null>(
    (a, b) => (a === null || b.views > a.views ? b : a),
    null,
  );
  const perDay = summary ? Math.round(summary.totalPageviews / Math.max(1, days.length)) : 0;
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3.5">
      {summary && part !== "site" ? (
        <>
          <KpiTile
            label="Profile pageviews"
            value={summary.totalPageviews.toLocaleString()}
            sub={`about ${perDay.toLocaleString()} a day`}
            testId="usage-total-pageviews"
          />
          <KpiTile
            label="Busiest day"
            value={peak ? peak.views.toLocaleString() : "—"}
            sub={peak ? shortDay(peak.day) : "no pageviews recorded"}
            testId="usage-busiest-day"
          />
        </>
      ) : null}
      {summary && part !== "unit" ? (
        <KpiTile
          label="Searches"
          value={(summary.searchVolume.typed + summary.searchVolume.suggested).toLocaleString()}
          sub={searchSplitSub(summary.searchVolume)}
          testId="usage-searches"
        />
      ) : null}
      {part === "unit" ? null : health ? (
        <>
          <KpiTile
            label="Uptime"
            value={health.uptimePercent === null ? "—" : `${health.uptimePercent.toFixed(2)}%`}
            sub={
              health.uptimePercent === null
                ? `no load balancer data ${rangePhrase(range)}`
                : rangePhrase(range)
            }
            testId="service-health-uptime"
          />
          <KpiTile
            label="Availability alarms"
            value={health.alarmFirings === null ? "—" : health.alarmFirings.toLocaleString()}
            sub={alarmSub(health, range)}
            testId="service-health-alarm-firings"
          />
        </>
      ) : (
        <div
          className={cn(
            cardClass,
            "text-muted-foreground flex items-center px-[18px] py-4 text-sm",
          )}
          data-testid="service-health-unavailable"
        >
          Service health stats unavailable.
        </div>
      )}
    </div>
  );
}

/** Slate ramp for the stacked traffic-source bars — one hue, stepped lighter
 *  by rank; the long tail shares the neutral border tone. */
const SPLIT_COLORS = [
  "bg-apollo-slate",
  "bg-apollo-slate/70",
  "bg-apollo-slate/45",
  "bg-apollo-slate/25",
  "bg-apollo-border-strong",
];

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** One traffic-source card: a stacked share bar over a label / hits / % list. */
function SplitCard({
  title,
  rows,
  emptyLabel,
}: {
  title: string;
  rows: NamedCount[];
  emptyLabel: string;
}) {
  const sum = rows.reduce((a, r) => a + r.hits, 0);
  const color = (i: number) => SPLIT_COLORS[Math.min(i, SPLIT_COLORS.length - 1)];
  return (
    <div className={cn(cardClass, "flex min-w-0 flex-col gap-3 px-[18px] py-4")}>
      <h3 className="text-muted-foreground text-xs font-medium tracking-[.1em] uppercase">
        {title}
      </h3>
      {rows.length === 0 || sum === 0 ? (
        <p className="text-muted-foreground text-sm">{emptyLabel}</p>
      ) : (
        <>
          <div
            className="bg-apollo-surface-2 flex h-2 gap-0.5 overflow-hidden rounded-full"
            aria-hidden="true"
          >
            {rows.map((r, i) => (
              <div
                key={`${r.label}-${i}`}
                className={color(i)}
                style={{ width: `${(r.hits / sum) * 100}%` }}
              />
            ))}
          </div>
          <ul className="flex flex-col">
            {rows.map((r, i) => (
              <li
                key={`${r.label}-${i}`}
                className="border-apollo-border grid grid-cols-[10px_minmax(0,1fr)_auto_48px] items-center gap-2.5 border-t py-1.5 text-[13.5px]"
              >
                <span className={cn("size-2 rounded-[2px]", color(i))} aria-hidden="true" />
                <span className="truncate" title={r.label}>
                  {r.label || "—"}
                </span>
                <span className="tabular-nums">{r.hits.toLocaleString()}</span>
                <span className="text-muted-foreground text-right text-[12.5px] tabular-nums">
                  {pctLabel(r.hits / sum)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function TrafficSources({ summary }: { summary: UsageSummary }) {
  // Every request carries a device class, so the device split's total is the
  // all-requests total (geo covers the same population, as a fallback).
  const totalHits =
    summary.device.reduce((a, r) => a + r.hits, 0) || summary.geo.reduce((a, r) => a + r.hits, 0);
  return (
    <section className="flex flex-col gap-3" data-testid="usage-traffic-sources">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-[17px] font-semibold">Traffic sources</h2>
        <span className="text-muted-foreground text-[13px]">
          All requests ({totalHits.toLocaleString()} hits), not just profile pageviews.
        </span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] items-start gap-5">
        <SplitCard title="Geography" rows={summary.geo} emptyLabel="No geo data." />
        <SplitCard
          title="Device"
          rows={summary.device.map((r) => ({ ...r, label: capitalize(r.label) }))}
          emptyLabel="No device data."
        />
      </div>
    </section>
  );
}

/** Monthly availability since launch as horizontal bars. The scale is pinned
 *  to a narrow band -- 100% down to whichever is lower of 99% or the worst
 *  month, rounded down -- rather than 0-100%, so a fractional-percent 5xx
 *  blip stays visible; the caption spells the band out. A month under the
 *  1,000-request low-traffic floor renders lighter (its number alone can't be
 *  trusted as a real signal) and says so in its hover title. */
function UptimeCard({ monthly }: { monthly: MonthlyAvailability[] }) {
  const worst = Math.min(...monthly.map((m) => m.availabilityPercent), 100);
  const yMin = Math.min(99, Math.floor(worst * 10) / 10);
  const band = 100 - yMin || 1;
  return (
    <section
      className={cn(cardClass, "flex flex-col gap-3.5 px-4 py-[18px] sm:px-[22px]")}
      data-testid="service-health-trend"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-[17px] font-semibold">Uptime since launch</h2>
        <UptimeInfoButton />
        <span className="text-muted-foreground text-[13px]">July 2026 onward</span>
      </div>
      {monthly.length === 0 ? (
        <p className="text-muted-foreground text-sm" data-testid="service-health-trend-empty">
          No availability history yet.
        </p>
      ) : (
        <>
          <ul className="flex flex-col gap-2.5">
            {monthly.map((m) => {
              const clamped = Math.max(yMin, Math.min(100, m.availabilityPercent));
              return (
                <li
                  key={m.month}
                  className="grid grid-cols-[72px_minmax(0,1fr)_64px] items-center gap-3.5 text-[13.5px]"
                  title={`${monthLabel(m.month)}: ${m.availabilityPercent.toFixed(3)}% availability, ${m.totalRequests.toLocaleString()} requests${m.lowTraffic ? " (low traffic, under 1,000 requests)" : ""}`}
                >
                  <span className="text-muted-foreground">{monthLabel(m.month)}</span>
                  <div className="bg-apollo-surface-2 h-2.5 overflow-hidden rounded-full">
                    <div
                      className={cn(
                        "h-full rounded-full",
                        m.lowTraffic ? "bg-apollo-slate/35" : "bg-apollo-slate",
                      )}
                      style={{ width: `${((clamped - yMin) / band) * 100}%` }}
                      data-low-traffic={m.lowTraffic ? "true" : undefined}
                    />
                  </div>
                  <span className="text-right font-medium tabular-nums">
                    {m.availabilityPercent.toFixed(2)}%
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="text-muted-foreground text-[12.5px] leading-normal">
            Bars span {yMin}%–100%, not 0–100%, so small dips stay visible. A lighter bar marks a
            month under 1,000 requests, too little traffic for the percentage to be reliable.
          </p>
        </>
      )}
    </section>
  );
}

/** Slug -> { cwid, name } for the top-profiles list, so rows read as names
 *  (with the shared hover card) instead of raw slugs. Fail-soft: a lookup
 *  error leaves every row on its slug. */
async function resolveProfileNames(
  slugs: string[],
): Promise<Map<string, { cwid: string; name: string }>> {
  const out = new Map<string, { cwid: string; name: string }>();
  if (slugs.length === 0) return out;
  try {
    const rows = await db.read.scholar.findMany({
      where: { slug: { in: slugs }, deletedAt: null },
      select: { slug: true, cwid: true, preferredName: true },
    });
    for (const r of rows) out.set(r.slug, { cwid: r.cwid, name: r.preferredName });
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "usage_profile_names_failed",
        path: "/edit/usage",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
  return out;
}

function UsageBody({
  summary,
  names,
  edits,
  part,
}: {
  summary: UsageSummary;
  names: Map<string, { cwid: string; name: string }>;
  /** Profile edits by hour; null when the audit-log read failed. */
  edits: EditHour[] | null;
  /** A unit-scoped page draws the body twice: `"unit"` is the pageviews chart
   *  and Top profiles (the viewer's people), `"site"` the rest. */
  part?: "unit" | "site";
}) {
  const unit = part !== "site";
  const site = part !== "unit";
  const profileRows: RankRow[] = summary.topProfiles.map((p) => {
    const hit = names.get(p.slug);
    return {
      label: hit?.name ?? `/${p.slug}`,
      count: p.views,
      href: `/${encodeURIComponent(p.slug)}`,
      cwid: hit?.cwid,
      tip: `/${p.slug}`,
      csvExtra: p.slug,
    };
  });
  const toTermRows = (terms: UsageSummary["searchTerms"]): RankRow[] =>
    terms.map((t) => ({ label: t.term, count: t.searches }));

  return (
    <>
      {!unit ? null : summary.pageviewsByDay.length === 0 ? (
        <section className={cn(cardClass, "px-[22px] py-5")}>
          <h2 className="text-[17px] font-semibold">Profile pageviews by day</h2>
          <p className="text-muted-foreground mt-2 text-sm" data-testid="usage-pageviews-empty">
            No profile pageviews recorded in this range.
          </p>
        </section>
      ) : (
        <PageviewsChart data={fillDayGaps(summary.pageviewsByDay, summary.since, summary.until)} />
      )}

      {!site ? null : summary.hourly.buckets.length === 0 ? (
        <section className={cn(cardClass, "px-[22px] py-5")}>
          <h2 className="text-[17px] font-semibold">Traffic by hour</h2>
          <p className="text-muted-foreground mt-2 text-sm" data-testid="usage-hourly-empty">
            No hourly data in this range yet. Hourly traffic (served, bot or challenged, and error
            requests by hour) is recorded from the first nightly rollup after it shipped in November
            2026; earlier days have none.
          </p>
        </section>
      ) : (
        <HourlyTrafficChart
          traffic={summary.hourly}
          since={summary.since}
          edits={edits}
          editsLabel={part === "site" ? "Profile edits, your units" : undefined}
        />
      )}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(380px,100%),1fr))] items-start gap-5">
        {unit ? (
          <RankTable
            testId="usage-top-profiles"
            title="Top profiles"
            unit="Views"
            labelHeader="Profile"
            extraHeader="Slug"
            csvName="usage-top-profiles"
            rows={profileRows}
            emptyLabel="No profile views in the window."
          />
        ) : null}
        {site ? (
          <>
            <RankTable
              testId="usage-top-search-terms"
              title="Top typed search terms"
              unit="Searches"
              labelHeader="Term"
              csvName="usage-top-search-terms"
              rows={toTermRows(summary.searchTerms)}
              emptyLabel="No searches in the window."
              note={`Searches typed into the search box, including paging and filtering. Untagged searches for exactly a Try chip term are left out as automated. Can still include automated traffic that passed the firewall. ${SEARCH_START_NOTE}`}
            />
            <RankTable
              testId="usage-suggested-search-terms"
              title="Suggested searches"
              unit="Clicks"
              labelHeader="Term"
              csvName="usage-suggested-search-terms"
              rows={toTermRows(summary.suggestedSearchTerms)}
              emptyLabel="No suggestion clicks in the window."
              note={`Home-page Try chips and concepts picked from the search box suggestions. ${SEARCH_START_NOTE}`}
            />
          </>
        ) : null}
      </div>
    </>
  );
}

export default async function EditUsagePage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getEffectiveEditSession();
  if (!session) {
    redirect("/api/auth/saml/login?return=/edit/usage");
  }
  if (!(await canViewDashboard(session, "usage"))) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: "usage",
      path: "/edit/usage",
      reason: "not_superuser_or_unit_admin",
    });
    return (
      <ConsoleShell
        active="usage"
        session={session}
        pendingSlugRequests={null}
        pendingHonors={null}
      >
        <ForbiddenEditPage session={session} />
      </ConsoleShell>
    );
  }

  // Superuser subnav props mirror the administrators page; a non-superuser unit
  // admin still reaches here, so the superuser-only tabs stay hidden via
  // superuserSurfaces while the Usage + Org-units tabs remain visible.
  const pendingSlugRequests =
    session.isSuperuser && isSlugRequestEnabled() ? await countPendingSlugRequests(db.read) : null;
  // #1762 — drives the "Honors" tab + its pending badge. `null` hides the tab:
  // flag off, or this viewer is neither superuser nor honors_curator.
  const pendingHonors = isHonorsQueueTabVisible(session) ? await countPendingHonors(db.read) : null;

  // The header's Range dropdown (`?range=`, `?from=`/`?to=`); a bad or missing
  // param falls back to the last 30 days.
  const today = new Date().toISOString().slice(0, 10);
  const range = resolveUsageRange((await searchParams) ?? {}, today);

  let summary: UsageSummary | null = null;
  let unavailable = false;
  try {
    summary = await loadUsageSummary(range);
  } catch (err) {
    unavailable = true;
    console.error(
      JSON.stringify({
        event: "usage_dashboard_read_failed",
        path: "/edit/usage",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  // A department / division / center admin sees the profile sections for
  // their own people; everyone else, the whole page site-wide. Resolved from
  // the session, never from the request.
  const scope = await loadDashboardScope(session, "usage");
  // The viewer's own profile numbers: Athena reads over their people's slugs
  // (from our DB, never the request), cached per slug set. Their own reads,
  // so their own fail-soft.
  let unitSummary: UsageSummary | null = null;
  if (!scope.all && summary) {
    try {
      const slugs = await loadScopeSlugs(scope.memberCwids);
      unitSummary = scopeUsageSummary(
        summary,
        await loadScopedProfileViews(range, slugs.keys()),
        slugs,
      );
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "usage_unit_scope_read_failed",
          path: "/edit/usage",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  // Independent data source (CloudWatch, not the Athena rollup above) with
  // its own fail-soft: a CloudWatch error only blanks the service-health
  // tiles + uptime card, never the rest of the page.
  let serviceHealth: ServiceHealthSummary | null = null;
  try {
    // One cached read for every range, windowed to the selected one here.
    serviceHealth = summarizeServiceHealth(await loadServiceHealth(), range);
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "service_health_read_failed",
        path: "/edit/usage",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  // The traffic sections read their own rollup (daily_traffic) and fail soft
  // on their own: an error there blanks only those sections.
  let traffic: TrafficOverview | null = null;
  try {
    traffic = await loadTrafficOverview({ since: range.since, until: range.until });
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "usage_traffic_read_failed",
        path: "/edit/usage",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
  const rangeQuery =
    range.key === "custom"
      ? `range=custom&from=${range.since}&to=${range.until}`
      : `range=${range.key}`;
  // Profile edits by hour for the hourly card, from the audit log: its own
  // source, so its own fail-soft (a DB error drops the line, never the card).
  // Read only when the card will draw.
  let edits: EditHour[] | null = [];
  if (summary && summary.hourly.buckets.length > 0) {
    try {
      // A scoped viewer's line counts edits to their own people and units: a
      // per-viewer read, so it skips the shared cache.
      edits = scope.all
        ? await loadEditsByHour(db.read, range)
        : await loadEditsByHourUncached(db.read, range.since, range.until, activityScopeSql(scope));
    } catch (err) {
      edits = null;
      console.error(
        JSON.stringify({
          event: "usage_edits_by_hour_failed",
          path: "/edit/usage",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  const profiles = scope.all ? summary : unitSummary;
  const names = profiles
    ? await resolveProfileNames(profiles.topProfiles.map((p) => p.slug))
    : new Map<string, { cwid: string; name: string }>();
  const days = summary?.pageviewsByDay ?? [];
  // The span the data actually covers; the requested window when it's empty.
  const rangeSpan =
    days.length > 0
      ? `${shortDay(days[0].day)} – ${shortDay(days[days.length - 1].day)}`
      : `${shortDay(range.since)} – ${shortDay(range.until)}`;

  return (
    <ConsoleShell
      active="usage"
      session={session}
      pendingSlugRequests={pendingSlugRequests}
      pendingHonors={pendingHonors}
      // No `unitsTab`/`usageTab` override needed — reaching this page at all
      // already requires `canViewUsage` (superuser or any UnitAdmin grant
      // holder), which implies `ConsoleShell`'s own `loadConsoleTabs`
      // derivation is already true for both.
    >
      <div className="flex flex-col gap-7">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-1.5">
            <h1 className="text-[30px] leading-tight font-semibold tracking-[-.01em]">
              {scope.all ? "Usage" : `Usage: ${scope.unitNames.join(", ")}`}
            </h1>
            <p className="text-muted-foreground text-[14.5px] leading-normal">
              {scope.all ? "Site-wide usage" : "Profile usage for your units, then site-wide usage"}
              , {rangeSpan}. From the nightly CloudFront rollup; refreshes about once a day.
            </p>
          </div>
          <UsageRangePicker
            current={range.key}
            since={range.since}
            until={range.until}
            maxDate={addDays(today, -1)}
          />
        </div>

        {scope.all ? (
          <KpiRow summary={summary} health={serviceHealth} range={range} />
        ) : (
          <>
            {unitSummary ? (
              <>
                <KpiRow summary={unitSummary} health={null} range={range} part="unit" />
                <UsageBody summary={unitSummary} names={names} edits={edits} part="unit" />
              </>
            ) : (
              <p className="text-muted-foreground" data-testid="usage-unit-unavailable">
                Usage for your units is temporarily unavailable. Please try again later or contact
                ITS Support if this persists.
              </p>
            )}
            {traffic && traffic.firstDt !== null && traffic.firstDt <= range.until ? (
              <TopPages
                rangeQuery={rangeQuery}
                exportHref={`/api/edit/usage/traffic/export?${rangeQuery}&grain=week`}
                scoped
              />
            ) : null}
            <div
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1"
              data-testid="usage-site-wide"
            >
              <h2 className="text-[17px] font-semibold">Site-wide</h2>
              <span className="text-muted-foreground text-[13px]">
                The sections below cover all of Scholars, except the profile edits line, which
                counts your units.
              </span>
            </div>
            <KpiRow summary={summary} health={serviceHealth} range={range} part="site" />
          </>
        )}

        {unavailable ? (
          <p className="text-muted-foreground" data-testid="edit-usage-unavailable">
            Usage data is temporarily unavailable. Please try again later or contact ITS Support if
            this persists.
          </p>
        ) : (
          <UsageBody
            summary={summary!}
            names={names}
            edits={edits}
            part={scope.all ? undefined : "site"}
          />
        )}

        {traffic ? (
          <TrafficSection overview={traffic} rangeQuery={rangeQuery} scoped={!scope.all} />
        ) : (
          <p className="text-muted-foreground" data-testid="usage-traffic-unavailable">
            Traffic and referrer detail is temporarily unavailable.
          </p>
        )}

        {summary ? <TrafficSources summary={summary} /> : null}

        {serviceHealth ? <UptimeCard monthly={serviceHealth.monthly} /> : null}
      </div>
    </ConsoleShell>
  );
}
