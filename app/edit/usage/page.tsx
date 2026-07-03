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
import { redirect } from "next/navigation";

import { AdminSubnav } from "@/components/edit/admin-subnav";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { type UsageSummary, loadUsageSummary } from "@/lib/api/usage-summary";
import { isMethodsTabVisible } from "@/lib/auth/comms-steward";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { isAdministratorsTabEnabled } from "@/lib/edit/administrators";
import { logEditDenial } from "@/lib/edit/authz";
import { isDataQualityTabVisible } from "@/lib/edit/data-quality";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";
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
      <div className="mt-2 overflow-x-auto">
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

/** Pageviews-by-day as a table with a proportional CSS bar (no chart lib). */
function PageviewsByDay({ summary }: { summary: UsageSummary }) {
  const max = summary.pageviewsByDay.reduce((m, r) => Math.max(m, r.views), 0) || 1;
  return (
    <section className="mt-8">
      <h2 className="text-base font-semibold">Pageviews by day</h2>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-apollo-surface-2 text-muted-foreground text-left">
            <tr className="border-apollo-border border-b">
              <th className={thClass}>Day</th>
              <th className={`${thClass} w-full`}>Views</th>
              <th className={`${thClass} text-right`}>Count</th>
            </tr>
          </thead>
          <tbody>
            {summary.pageviewsByDay.length === 0 ? (
              <tr>
                <td className={`${tdClass} text-muted-foreground`} colSpan={3}>
                  No profile pageviews recorded in the last {summary.windowDays} days.
                </td>
              </tr>
            ) : (
              summary.pageviewsByDay.map((r) => (
                <tr key={r.day} className="border-apollo-border border-b">
                  <td className={`${tdClass} whitespace-nowrap tabular-nums`}>{r.day}</td>
                  <td className={tdClass}>
                    <div
                      className="bg-apollo-maroon/70 h-3 rounded-sm"
                      style={{ width: `${Math.max(2, (r.views / max) * 100)}%` }}
                      aria-hidden
                    />
                  </td>
                  <td className={`${tdClass} text-right tabular-nums`}>{r.views.toLocaleString()}</td>
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

      <PageviewsByDay summary={summary} />
      <CountTable
        caption="Top profiles"
        headers={["Scholar (cwid)", "Views"]}
        rows={summary.topProfiles.map((r) => [r.cwid, r.views])}
        emptyLabel="No profile views in the window."
      />
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
    <div className="min-h-screen bg-[var(--background)]" data-slot="edit-usage-page">
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
