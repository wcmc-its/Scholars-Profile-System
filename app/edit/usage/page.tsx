/**
 * `/edit/usage` — the in-app Usage dashboard. Site-wide CloudFront usage over the
 * last 30 days (pageviews trend, top profiles, search terms, referrers, geo,
 * device), read from the `daily_usage` Athena rollup via a daily-cached loader.
 * The viewer-friendly companion to the Athena console + the `sps-usage-*` saved
 * queries: aggregates only (no PII), no per-URL performance (those read raw logs
 * and stay operator-restricted).
 *
 * Audience: a **superuser** or **any unit administrator** (owner/curator) —
 * `canViewUsage`. Global view for everyone (no per-unit scoping). Re-checked on
 * every GET; the DATA is cached (daily) but the AUTH is not. Fails soft to an
 * "unavailable" notice if Athena errors (mirrors the /edit/activity pattern).
 */
import Link from "next/link";
import { redirect } from "next/navigation";

import { AdminSubnav } from "@/components/edit/admin-subnav";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import {
  type DayViews,
  type ProfileViews,
  type UsageSummary,
  loadUsageSummary,
} from "@/lib/api/usage-summary";
import { isMethodsTabVisible } from "@/lib/auth/comms-steward";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { isAdministratorsTabEnabled } from "@/lib/edit/administrators";
import { logEditDenial } from "@/lib/edit/authz";
import { isDataQualityTabVisible } from "@/lib/edit/data-quality";
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
    return <ForbiddenEditPage />;
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

  return (
    <div className="min-h-screen bg-apollo-page" data-slot="edit-usage-page">
      <header className="bg-apollo-bar text-white">
        <div className="mx-auto flex h-14 max-w-[var(--max-content)] items-center gap-3 px-6">
          <span
            className="bg-apollo-maroon flex size-7 items-center justify-center rounded-sm text-xs font-bold"
            aria-hidden
          >
            WCM
          </span>
          <span className="font-semibold">Scholars Profile Console</span>
        </div>
      </header>

      <AdminSubnav
        active="usage"
        superuserSurfaces={session.isSuperuser}
        unitsTab
        usageTab
        pendingSlugRequests={pendingSlugRequests}
        pendingHonors={pendingHonors}
        administratorsTab={isAdministratorsTabEnabled() ? 0 : null}
        methodsTab={isMethodsTabVisible(session) ? 0 : null}
        dataQualityTab={isDataQualityTabVisible(session) ? 0 : null}
      />

      <main className="mx-auto max-w-[var(--max-content)] px-6 py-8" data-slot="edit-usage">
        <h1 className="mb-1 text-xl font-semibold">Usage</h1>
        {unavailable ? (
          <p className="text-muted-foreground mt-8" data-testid="edit-usage-unavailable">
            Usage data is temporarily unavailable. Please try again later or contact ITS Support if
            this persists.
          </p>
        ) : (
          <UsageBody summary={summary!} />
        )}
      </main>
    </div>
  );
}
