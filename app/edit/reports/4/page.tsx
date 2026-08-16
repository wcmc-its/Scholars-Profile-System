/**
 * `/edit/reports/4` — "Grants active as of a date". Same session/authz/
 * center-resolution flow as `/edit/reports` (see that page's doc comment).
 * Server-rendered only — the date picker is a native `<input type="date">`
 * inside a plain `method="GET"` form, so choosing a date is a normal
 * navigation to `?asOf=YYYY-MM-DD&center=<code>`, no client component.
 *
 * Data comes from `loadCenterActiveGrants` (`lib/edit/cancer-center-grants-
 * report.ts`) — one row per `Grant` row held by a center member, active on
 * the chosen date (`isFundingActiveAsOf`, `lib/funding-active.ts`).
 */
import Link from "next/link";
import { redirect } from "next/navigation";

import { Button } from "@/components/ui/button";
import { ConsoleShell } from "@/components/edit/console-shell";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { Input } from "@/components/ui/input";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import {
  type CenterActiveGrant,
  loadCenterActiveGrants,
} from "@/lib/edit/cancer-center-grants-report";
import { loadReportsContext, resolveNumberedReportCenterCode } from "@/lib/edit/cancer-center-reports";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";
import { fundingRoleLabel } from "@/lib/funding-roles";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Grants — Scholars Profile Console",
  robots: { index: false, follow: false },
};

const ASOF_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Parse `?asOf=YYYY-MM-DD` into a UTC-midnight `Date` (matching how the
 *  `@db.Date` start/end columns come back from Prisma) plus the ISO string the
 *  date input re-renders with. Missing or unparsable input falls back to
 *  today — never a 400, since a bad query string is just "show me today." */
function resolveAsOf(raw: string | undefined): { date: Date; iso: string } {
  const todayIso = new Date().toISOString().slice(0, 10);
  const iso = raw && ASOF_PATTERN.test(raw) ? raw : todayIso;
  const date = new Date(`${iso}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? { date: new Date(`${todayIso}T00:00:00.000Z`), iso: todayIso } : { date, iso };
}

/** UTC-safe date display — avoids the off-by-one a bare `toLocaleDateString()`
 *  risks on a UTC-midnight `@db.Date` value when the server's local zone is
 *  west of UTC. */
function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

export default async function EditReportsGrantsPage({
  searchParams,
}: {
  searchParams?: Promise<{ center?: string; asOf?: string }>;
}) {
  const session = await getEffectiveEditSession();
  if (!session) {
    redirect("/api/auth/saml/login?return=/edit/reports/4");
  }

  const { center, asOf } = (await searchParams) ?? {};
  const { code } = await resolveNumberedReportCenterCode(session, db.read, center);
  const ctx = await loadReportsContext(code, session, db.read);
  if (ctx === null) {
    return (
      <ConsoleShell active="reports" session={session} pendingSlugRequests={null} pendingHonors={null}>
        <ForbiddenEditPage variant="unit" targetEntity={code} />
      </ConsoleShell>
    );
  }

  const { date: asOfDate, iso: asOfIso } = resolveAsOf(asOf);
  const grants: CenterActiveGrant[] = await loadCenterActiveGrants(code, asOfDate, db.read);

  const pendingSlugRequests =
    session.isSuperuser && isSlugRequestEnabled() ? await countPendingSlugRequests(db.read) : null;
  const pendingHonors = isHonorsQueueTabVisible(session)
    ? await countPendingHonors(db.read)
    : null;

  return (
    <ConsoleShell
      active="reports"
      session={session}
      pendingSlugRequests={pendingSlugRequests}
      pendingHonors={pendingHonors}
      reportsTab
    >
      <Link
        href={`/edit/reports?center=${encodeURIComponent(code)}`}
        className="text-apollo-slate mb-4 inline-block text-sm hover:underline"
      >
        &larr; All reports
      </Link>
      <h1 className="mb-1 text-xl font-bold">4. Grants</h1>
      <p className="text-muted-foreground mb-4 text-sm">
        This center’s members’ grants active as of the chosen date.
      </p>

      <form method="GET" className="mb-4 flex items-end gap-2">
        <input type="hidden" name="center" value={code} />
        <div>
          <label htmlFor="asOf" className="text-muted-foreground mb-1 block text-xs font-medium">
            Active as of
          </label>
          <Input id="asOf" type="date" name="asOf" defaultValue={asOfIso} className="h-9 w-44" />
        </div>
        <Button type="submit" size="sm" variant="outline">
          Apply
        </Button>
      </form>

      {grants.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No active grants for this center’s members as of {formatDate(asOfDate)}.
        </p>
      ) : (
        <div className="border-apollo-border bg-apollo-surface mt-4 overflow-x-auto rounded-md border">
          <table className="w-full min-w-[900px] border-collapse text-sm">
            <thead className="bg-apollo-surface-2">
              <tr className="border-apollo-border border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-1.5 pr-2">PI</th>
                <th className="py-1.5 pr-2">Project title</th>
                <th className="py-1.5 pr-2">Sponsor</th>
                <th className="py-1.5 pr-2">Role</th>
                <th className="py-1.5 pr-2">Start date</th>
                <th className="py-1.5 pr-2">End date</th>
              </tr>
            </thead>
            <tbody>
              {grants.map((g, i) => (
                <tr key={`${g.cwid}-${i}`} className="border-apollo-border border-b align-top">
                  <td className="py-1.5 pr-2">{g.piName}</td>
                  <td className="py-1.5 pr-2">{g.title}</td>
                  <td className="py-1.5 pr-2">{g.sponsor}</td>
                  <td className="py-1.5 pr-2">{fundingRoleLabel(g.role)}</td>
                  <td className="py-1.5 pr-2">{formatDate(g.startDate)}</td>
                  <td className="py-1.5 pr-2">{formatDate(g.endDate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </ConsoleShell>
  );
}
