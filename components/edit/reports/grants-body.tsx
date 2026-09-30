/**
 * Report 4 — "Grants active as of a date". Server-rendered only — the date
 * picker is a native `<input type="date">` inside a plain `method="GET"` form,
 * so choosing a date is a normal navigation to `?asOf=YYYY-MM-DD&center=<code>`
 * (the form posts back to the page's own URL), no client component.
 *
 * Data comes from `loadCenterActiveGrants` (`lib/edit/cancer-center-grants-
 * report.ts`) — one row per `Grant` row held by a center member, active on
 * the chosen date (`isFundingActiveAsOf`, `lib/funding-active.ts`).
 *
 * The body of what was `app/edit/reports/4/page.tsx`, moved verbatim into the
 * registry shape (`lib/edit/report-registry.ts`): the session / gate / shell /
 * header frame is the dynamic page's; this owns only the report. Unit-gated,
 * center-only (`REPORT_NUMBERS_BY_KIND`). The static subtitle `<p>` is
 * returned as `subtitle` (the header's children).
 */
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { db } from "@/lib/db";
import {
  type CenterActiveGrant,
  loadCenterActiveGrants,
} from "@/lib/edit/cancer-center-grants-report";
import type { ReportRender, UnitReportProps } from "@/lib/edit/report-registry";
import { fundingRoleLabel } from "@/lib/funding-roles";
import { ScholarHoverCard } from "@/components/edit/scholar-hover-card";

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

/** Report 4's body: the date form and the members' grants active on that date. */
export async function renderGrantsReport({ code, searchParams }: UnitReportProps): Promise<ReportRender> {
  const asOf = typeof searchParams.asOf === "string" ? searchParams.asOf : undefined;
  const { date: asOfDate, iso: asOfIso } = resolveAsOf(asOf);
  const grants: CenterActiveGrant[] = await loadCenterActiveGrants(code, asOfDate, db.read);

  return {
    subtitle: (
      <p className="text-muted-foreground mb-4 text-sm">
        This center’s members’ grants active as of the chosen date.
      </p>
    ),
    main: (
      <>
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
                    <td className="py-1.5 pr-2">
                      <ScholarHoverCard cwid={g.cwid}>
                        <span className="hover:underline">{g.piName}</span>
                      </ScholarHoverCard>
                    </td>
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
      </>
    ),
  };
}
