/**
 * `/edit/usage` — the in-app Usage dashboard. Site-wide CloudFront usage over the
 * last 30 days (pageviews trend, top profiles, search terms, referrers, geo,
 * device), read from the `daily_usage` Athena rollup via a daily-cached loader.
 * The viewer-friendly companion to the Athena console + the `sps-usage-*` saved
 * queries: aggregates only (no PII), no per-URL performance (those read raw logs
 * and stay operator-restricted).
 *
 * Also carries a "Service health" section (uptime tiles + a monthly trend
 * since launch), read from CloudWatch via lib/api/service-health.ts —
 * independent of the Athena data above, with its own fail-soft.
 *
 * Audience: a **superuser** or **any unit administrator** (owner/curator) —
 * `canViewUsage`. Global view for everyone (no per-unit scoping). Re-checked on
 * every GET; the DATA is cached (daily / 12h) but the AUTH is not. Fails soft
 * to an "unavailable" notice per section if its own data source errors
 * (mirrors the /edit/activity pattern).
 */
import Link from "next/link";
import { redirect } from "next/navigation";

import { ConsoleShell } from "@/components/edit/console-shell";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import {
  type MonthlyAvailability,
  type ServiceHealthSummary,
  loadServiceHealth,
} from "@/lib/api/service-health";
import {
  type DayViews,
  type ProfileViews,
  type UsageSummary,
  loadUsageSummary,
} from "@/lib/api/usage-summary";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { logEditDenial } from "@/lib/edit/authz";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";
import { canViewUsage } from "@/lib/edit/usage-access";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Usage — Scholars Profile Console",
  robots: { index: false, follow: false },
};

const thClass = "px-3 py-2 font-medium";
const tdClass = "px-3 py-2";

/** A generic 2-column count table (label, count). */
function CountTable({
  caption,
  headers,
  rows,
  emptyLabel,
}: {
  caption: string;
  headers: [string, string];
  rows: ReadonlyArray<[string, number]>;
  emptyLabel: string;
}) {
  return (
    <section className="mt-8">
      <h2 className="text-base font-semibold">{caption}</h2>
      <div className="border-apollo-border bg-apollo-surface mt-2 overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-apollo-surface-2 text-muted-foreground text-left">
            <tr className="border-apollo-border border-b">
              <th className={thClass}>{headers[0]}</th>
              <th className={`${thClass} text-right`}>{headers[1]}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className={`${tdClass} text-muted-foreground`} colSpan={2}>
                  {emptyLabel}
                </td>
              </tr>
            ) : (
              rows.map(([label, count], i) => (
                <tr key={`${label}-${i}`} className="border-apollo-border border-b">
                  <td className={`${tdClass} break-words`}>{label || "—"}</td>
                  <td className={`${tdClass} text-right tabular-nums`}>{count.toLocaleString()}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Pageviews-by-day as a server-rendered SVG bar graph (no chart lib). Bars
 *  carry a <title> for hover tooltips; y-gridlines + sparse x date labels give
 *  scale. `currentColor` (set via text-muted-foreground on the svg) draws the
 *  axes; the bars fill with the brand maroon CSS var. */
function PageviewsChart({ data, windowDays }: { data: DayViews[]; windowDays: number }) {
  if (data.length === 0) {
    return (
      <p className="text-muted-foreground mt-2" data-testid="usage-pageviews-empty">
        No profile pageviews recorded in the last {windowDays} days.
      </p>
    );
  }
  const W = 900;
  const H = 240;
  const padL = 48;
  const padR = 8;
  const padT = 12;
  const padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const max = Math.max(...data.map((d) => d.views), 1);
  const slot = plotW / data.length;
  const barW = Math.max(1, slot * 0.72);
  const labelEvery = Math.ceil(data.length / 8);

  return (
    <div className="mt-3 overflow-x-auto">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="text-muted-foreground h-60 w-full min-w-[560px]"
        role="img"
        aria-label={`Profile pageviews per day over the last ${windowDays} days`}
      >
        {[0, 0.5, 1].map((f) => {
          const y = padT + plotH * (1 - f);
          return (
            <g key={f}>
              <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="currentColor" strokeOpacity={0.15} />
              <text x={padL - 6} y={y + 3} textAnchor="end" fontSize={10} fill="currentColor" fillOpacity={0.7}>
                {Math.round(max * f).toLocaleString()}
              </text>
            </g>
          );
        })}
        {data.map((d, i) => {
          const h = (d.views / max) * plotH;
          const x = padL + i * slot + (slot - barW) / 2;
          return (
            <rect
              key={d.day}
              x={x}
              y={padT + plotH - h}
              width={barW}
              height={h}
              rx={1}
              style={{ fill: "var(--apollo-maroon)" }}
            >
              <title>
                {d.day}: {d.views.toLocaleString()} views
              </title>
            </rect>
          );
        })}
        {data.map((d, i) =>
          i % labelEvery === 0 || i === data.length - 1 ? (
            <text
              key={d.day}
              x={padL + i * slot + slot / 2}
              y={H - 8}
              textAnchor="middle"
              fontSize={9}
              fill="currentColor"
              fillOpacity={0.7}
            >
              {d.day.slice(5)}
            </text>
          ) : null,
        )}
      </svg>
    </div>
  );
}

/** Top profiles by pageview — the vanity slug links to the live profile page. */
function TopProfilesTable({ profiles }: { profiles: ProfileViews[] }) {
  return (
    <section className="mt-8">
      <h2 className="text-base font-semibold">Top profiles</h2>
      <div className="border-apollo-border bg-apollo-surface mt-2 overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-apollo-surface-2 text-muted-foreground text-left">
            <tr className="border-apollo-border border-b">
              <th className={thClass}>Profile</th>
              <th className={`${thClass} text-right`}>Views</th>
            </tr>
          </thead>
          <tbody>
            {profiles.length === 0 ? (
              <tr>
                <td className={`${tdClass} text-muted-foreground`} colSpan={2}>
                  No profile views in the window.
                </td>
              </tr>
            ) : (
              profiles.map((p, i) => (
                <tr key={`${p.slug}-${i}`} className="border-apollo-border border-b">
                  <td className={tdClass}>
                    <Link
                      href={`/${encodeURIComponent(p.slug)}`}
                      className="text-apollo-slate hover:underline"
                    >
                      /{p.slug}
                    </Link>
                  </td>
                  <td className={`${tdClass} text-right tabular-nums`}>
                    {p.views.toLocaleString()}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Two stat tiles: 30-day uptime % and availability-alarm firings in the same
 *  window. Reuses CountTable's bordered-box chrome (border-apollo-border /
 *  bg-apollo-surface) but for one prominent number rather than a table --
 *  the shortest idiom for this shape of data. */
function ServiceHealthTiles({ summary }: { summary: ServiceHealthSummary }) {
  return (
    <div className="mt-3 grid gap-4 sm:grid-cols-2">
      <div className="border-apollo-border bg-apollo-surface rounded-md border p-4">
        <div className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          Uptime (last {summary.windowDays} days)
        </div>
        <div className="mt-1 text-3xl font-bold tabular-nums" data-testid="service-health-uptime">
          {summary.uptimePercent.toFixed(2)}%
        </div>
      </div>
      <div className="border-apollo-border bg-apollo-surface rounded-md border p-4">
        <div className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          Availability-alarm firings (last {summary.windowDays} days)
        </div>
        <div
          className="mt-1 text-3xl font-bold tabular-nums"
          data-testid="service-health-alarm-firings"
        >
          {summary.alarmFirings.toLocaleString()}
        </div>
      </div>
    </div>
  );
}

/** Monthly availability since launch, cloned from PageviewsChart's
 *  server-rendered SVG-bar approach (no chart lib). The y-axis is pinned to a
 *  narrow band -- 100% down to whichever is lower of 99% or the worst month,
 *  rounded down -- rather than 0-100%, so a fractional-percent 5xx blip stays
 *  visible; the band is spelled out in the caption below so the compression
 *  can't read as misleading. A month under the 1,000-request low-traffic
 *  floor renders as a lighter bar (its number alone can't be trusted as a
 *  real signal) and says so in its hover title + request count. */
function ServiceHealthTrendChart({ monthly }: { monthly: MonthlyAvailability[] }) {
  if (monthly.length === 0) {
    return (
      <p className="text-muted-foreground mt-2" data-testid="service-health-trend-empty">
        No availability history yet.
      </p>
    );
  }
  const W = 900;
  const H = 220;
  const padL = 48;
  const padR = 8;
  const padT = 12;
  const padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const worst = Math.min(...monthly.map((m) => m.availabilityPercent));
  const yMin = Math.min(99, Math.floor(worst * 10) / 10);
  const yMax = 100;
  const band = yMax - yMin || 1;
  const slot = plotW / monthly.length;
  const barW = Math.max(1, slot * 0.6);

  return (
    <div className="mt-3 overflow-x-auto">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="text-muted-foreground h-56 w-full min-w-[480px]"
        role="img"
        aria-label={`Monthly availability since July 2026; y-axis ${yMin}% to ${yMax}%`}
      >
        {[0, 0.5, 1].map((f) => {
          const y = padT + plotH * (1 - f);
          const val = yMin + band * f;
          return (
            <g key={f}>
              <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="currentColor" strokeOpacity={0.15} />
              <text x={padL - 6} y={y + 3} textAnchor="end" fontSize={10} fill="currentColor" fillOpacity={0.7}>
                {val.toFixed(1)}%
              </text>
            </g>
          );
        })}
        {monthly.map((m, i) => {
          const clamped = Math.max(yMin, Math.min(yMax, m.availabilityPercent));
          const h = ((clamped - yMin) / band) * plotH;
          const x = padL + i * slot + (slot - barW) / 2;
          return (
            <rect
              key={m.month}
              x={x}
              y={padT + plotH - h}
              width={barW}
              height={h}
              rx={1}
              fillOpacity={m.lowTraffic ? 0.35 : 1}
              style={{ fill: m.lowTraffic ? "currentColor" : "var(--apollo-maroon)" }}
            >
              <title>
                {m.month}: {m.availabilityPercent.toFixed(3)}% availability,{" "}
                {m.totalRequests.toLocaleString()} requests
                {m.lowTraffic ? " (low traffic -- under 1,000 requests)" : ""}
              </title>
            </rect>
          );
        })}
        {monthly.map((m, i) => (
          <text
            key={m.month}
            x={padL + i * slot + slot / 2}
            y={H - 8}
            textAnchor="middle"
            fontSize={9}
            fill="currentColor"
            fillOpacity={0.7}
          >
            {m.month}
          </text>
        ))}
      </svg>
      <p className="text-muted-foreground mt-1 text-xs">
        Y-axis spans {yMin}%–{yMax}% (not 0–100%) so small dips stay visible. Lighter bars mark a
        month under 1,000 requests — too little traffic for the percentage to be a reliable signal.
      </p>
    </div>
  );
}

/** The whole Service health section: two tiles + the monthly trend. `summary`
 *  is `null` only when loadServiceHealth threw (CloudWatch error) -- that
 *  failure is scoped to this section alone; the rest of the page (or the
 *  Usage dashboard above it) renders normally regardless. */
function ServiceHealthSection({ summary }: { summary: ServiceHealthSummary | null }) {
  return (
    <section className="mt-8">
      <h2 className="text-base font-semibold">Service health</h2>
      {summary === null ? (
        <p className="text-muted-foreground mt-2" data-testid="service-health-unavailable">
          Service health stats unavailable.
        </p>
      ) : (
        <>
          <ServiceHealthTiles summary={summary} />
          <h3 className="mt-6 text-sm font-semibold">Uptime since launch (July 2026)</h3>
          <ServiceHealthTrendChart monthly={summary.monthly} />
        </>
      )}
    </section>
  );
}

function UsageBody({ summary }: { summary: UsageSummary }) {
  return (
    <>
      <p className="text-muted-foreground mt-2">
        Site-wide usage over the last {summary.windowDays} days —{" "}
        <strong>{summary.totalPageviews.toLocaleString()}</strong> profile pageviews. From the
        nightly CloudFront rollup; refreshes about once a day.
      </p>

      <section className="mt-8">
        <h2 className="text-base font-semibold">Pageviews by day</h2>
        <PageviewsChart data={summary.pageviewsByDay} windowDays={summary.windowDays} />
      </section>
      <TopProfilesTable profiles={summary.topProfiles} />
      <CountTable
        caption="Top search terms"
        headers={["Term", "Searches"]}
        rows={summary.searchTerms.map((r) => [r.term, r.searches])}
        emptyLabel="No searches in the window."
      />
      <div className="grid gap-x-8 md:grid-cols-3">
        <CountTable
          caption="Referrers"
          headers={["Source", "Hits"]}
          rows={summary.referrers.map((r) => [r.label, r.hits])}
          emptyLabel="No referrer data."
        />
        <CountTable
          caption="Geography"
          headers={["Region", "Hits"]}
          rows={summary.geo.map((r) => [r.label, r.hits])}
          emptyLabel="No geo data."
        />
        <CountTable
          caption="Device"
          headers={["Class", "Hits"]}
          rows={summary.device.map((r) => [r.label, r.hits])}
          emptyLabel="No device data."
        />
      </div>
    </>
  );
}

export default async function EditUsagePage() {
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

  let summary: UsageSummary | null = null;
  let unavailable = false;
  try {
    summary = await loadUsageSummary();
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
  // its own fail-soft: a CloudWatch error only blanks the Service health
  // section, never the rest of the page.
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
      <h1 className="mb-1 text-xl font-bold">Usage</h1>
      {unavailable ? (
        <p className="text-muted-foreground mt-8" data-testid="edit-usage-unavailable">
          Usage data is temporarily unavailable. Please try again later or contact ITS Support if
          this persists.
        </p>
      ) : (
        <UsageBody summary={summary!} />
      )}
      <ServiceHealthSection summary={serviceHealth} />
    </ConsoleShell>
  );
}
