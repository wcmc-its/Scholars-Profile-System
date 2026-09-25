/**
 * `/edit/usage` — the in-app Usage dashboard. Site-wide CloudFront usage over a
 * chosen range (the header's Range dropdown: last 7 / 30 / 90 days, since
 * launch, or custom; default last 30) — pageviews trend, top profiles, search
 * terms, referrers, geo, device — read from the durable `daily_usage` Athena
 * rollup via a daily-cached loader keyed per range.
 * The viewer-friendly companion to the Athena console + the `sps-usage-*` saved
 * queries: aggregates only (no PII), no per-URL performance (those read raw logs
 * and stay operator-restricted).
 *
 * Also carries service health (uptime + alarm-firing KPI tiles and a monthly
 * "Uptime since launch" card), read from CloudWatch via
 * lib/api/service-health.ts — independent of the Athena data above, with its
 * own fail-soft.
 *
 * Layout (2026-09 page revision): header, a four-tile KPI row, the pageviews
 * chart card, Top profiles + Top search terms side by side, three Traffic
 * sources cards, then the uptime card. The interactive bits (chart hover, Show
 * all, client-side CSV, the uptime ⓘ) are client islands in ./usage-widgets.
 *
 * Audience: a **superuser** or **any unit administrator** (owner/curator) —
 * `canViewUsage`. Global view for everyone (no per-unit scoping). Re-checked on
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
} from "@/lib/api/service-health";
import { addDays, resolveUsageRange } from "@/lib/api/usage-range";
import { type NamedCount, type UsageSummary, loadUsageSummary } from "@/lib/api/usage-summary";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { logEditDenial } from "@/lib/edit/authz";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";
import { canViewUsage } from "@/lib/edit/usage-access";
import { cn } from "@/lib/utils";

import { fillDayGaps, monthLabel, pctLabel, shortDay } from "./usage-format";
import {
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

/** Headline row: pageviews + busiest day (Athena rollup), uptime + alarm
 *  firings (CloudWatch). Each pair fails soft on its own source. */
function KpiRow({
  summary,
  health,
}: {
  summary: UsageSummary | null;
  health: ServiceHealthSummary | null;
}) {
  const days = summary?.pageviewsByDay ?? [];
  const peak = days.reduce<(typeof days)[number] | null>(
    (a, b) => (a === null || b.views > a.views ? b : a),
    null,
  );
  const perDay = summary ? Math.round(summary.totalPageviews / Math.max(1, days.length)) : 0;
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3.5">
      {summary ? (
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
      {health ? (
        <>
          <KpiTile
            label="Uptime"
            value={`${health.uptimePercent.toFixed(2)}%`}
            sub={`last ${health.windowDays} days`}
            testId="service-health-uptime"
          />
          <KpiTile
            label="Availability alarms"
            value={health.alarmFirings.toLocaleString()}
            sub={`fired in last ${health.windowDays} days`}
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
        <SplitCard title="Referrers" rows={summary.referrers} emptyLabel="No referrer data." />
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
}: {
  summary: UsageSummary;
  names: Map<string, { cwid: string; name: string }>;
}) {
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
  const termRows: RankRow[] = summary.searchTerms.map((t) => ({
    label: t.term,
    count: t.searches,
  }));

  return (
    <>
      {summary.pageviewsByDay.length === 0 ? (
        <section className={cn(cardClass, "px-[22px] py-5")}>
          <h2 className="text-[17px] font-semibold">Profile pageviews by day</h2>
          <p className="text-muted-foreground mt-2 text-sm" data-testid="usage-pageviews-empty">
            No profile pageviews recorded in this range.
          </p>
        </section>
      ) : (
        <PageviewsChart data={fillDayGaps(summary.pageviewsByDay, summary.since, summary.until)} />
      )}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(380px,100%),1fr))] items-start gap-5">
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
        <RankTable
          testId="usage-top-search-terms"
          title="Top search terms"
          unit="Searches"
          labelHeader="Term"
          csvName="usage-top-search-terms"
          rows={termRows}
          emptyLabel="No searches in the window."
        />
      </div>

      <TrafficSources summary={summary} />
    </>
  );
}

export default async function EditUsagePage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
} = {}) {
  const session = await getEffectiveEditSession();
  if (!session) {
    redirect("/api/auth/saml/login?return=/edit/usage");
  }
  if (!(await canViewUsage(session, db.read))) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: "usage",
      path: "/edit/usage",
      reason: "not_superuser_or_unit_admin",
    });
    return (
      <ConsoleShell active="usage" session={session} pendingSlugRequests={null} pendingHonors={null}>
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
  const pendingHonors = isHonorsQueueTabVisible(session)
    ? await countPendingHonors(db.read)
    : null;

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

  // Independent data source (CloudWatch, not the Athena rollup above) with
  // its own fail-soft: a CloudWatch error only blanks the service-health
  // tiles + uptime card, never the rest of the page.
  let serviceHealth: ServiceHealthSummary | null = null;
  try {
    serviceHealth = await loadServiceHealth();
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "service_health_read_failed",
        path: "/edit/usage",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  const names = summary
    ? await resolveProfileNames(summary.topProfiles.map((p) => p.slug))
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
            <h1 className="text-[30px] leading-tight font-semibold tracking-[-.01em]">Usage</h1>
            <p className="text-muted-foreground text-[14.5px] leading-normal">
              Site-wide usage, {rangeSpan}. From the nightly CloudFront rollup; refreshes about once
              a day.
            </p>
          </div>
          <UsageRangePicker
            current={range.key}
            since={range.since}
            until={range.until}
            maxDate={addDays(today, -1)}
          />
        </div>

        <KpiRow summary={summary} health={serviceHealth} />

        {unavailable ? (
          <p className="text-muted-foreground" data-testid="edit-usage-unavailable">
            Usage data is temporarily unavailable. Please try again later or contact ITS Support if
            this persists.
          </p>
        ) : (
          <UsageBody summary={summary!} names={names} />
        )}

        {serviceHealth ? <UptimeCard monthly={serviceHealth.monthly} /> : null}
      </div>
    </ConsoleShell>
  );
}
