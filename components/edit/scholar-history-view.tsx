/**
 * ScholarHistoryView — the read-only scholar profile audit table (#955 finding
 * #11), the sibling of `CenterHistoryView`. Renders the last 90 days of
 * profile-entity edits for one scholar: timestamp / actor / action / details.
 * No interactivity, no mutation — the audit log is append-only and this surface
 * only reads it (`lib/api/scholar-audit.ts`).
 *
 * Server component (no state, no client hooks). The page-level authz gate
 * (`/edit/scholar/[cwid]/history`) is what permits this to render at all; by the
 * time we get here the actor may edit THIS scholar (self / proxy / unit-admin /
 * superuser / comms_steward — history visibility == edit access).
 */
import Link from "next/link";

import type { ScholarAuditEntry } from "@/lib/api/scholar-audit";

export type ScholarHistoryViewProps = {
  /** the scholar @id `cwid` — drives the back-link to the editor. */
  cwid: string;
  /** the scholar display name, for the heading + back-link. */
  scholarName: string;
  /** the windowed, newest-first history rows. */
  entries: ReadonlyArray<ScholarAuditEntry>;
  /** how many days the window spans (for the empty-state copy). */
  windowDays: number;
  /** the audit read failed (e.g. the read role lacks SELECT on the audit table):
   *  render an honest "unavailable" notice instead of an empty/"no edits" state,
   *  so the page degrades gracefully rather than 500ing. */
  unavailable?: boolean;
};

/**
 * Format a stored UTC instant as WCM-local Eastern time. `America/New_York` is
 * DST-aware, so the zone abbreviation renders EST in winter and EDT in summer.
 * Rendered server-side (this is a server component), so no client TZ drift.
 */
function formatTs(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  // YYYY-MM-DD HH:MM EST/EDT
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ${get("timeZoneName")}`;
}

/** Render one row's detail: the changed fields, or a compact extra, else a dash. */
function DetailSummary({ entry }: { entry: ScholarAuditEntry }) {
  if (entry.fields.length > 0) {
    return <span>{entry.fields.join(", ")}</span>;
  }
  if (entry.detail) {
    return <span className="text-muted-foreground">{entry.detail}</span>;
  }
  return <span className="text-muted-foreground">—</span>;
}

export function ScholarHistoryView({
  cwid,
  scholarName,
  entries,
  windowDays,
  unavailable = false,
}: ScholarHistoryViewProps) {
  return (
    <main
      className="mx-auto w-full max-w-[var(--max-content)] px-6 py-10"
      data-slot="scholar-history-view"
      data-cwid={cwid}
    >
      <p className="mb-4">
        <Link
          href={`/edit/scholar/${encodeURIComponent(cwid)}`}
          className="text-apollo-slate hover:underline"
        >
          &larr; Back to {scholarName}
        </Link>
      </p>

      <h1 className="page-title">Profile change history</h1>
      <p className="text-muted-foreground mt-2">
        {scholarName} — edits to this profile in the last {windowDays} days. Read-only. Publication
        and grant suppressions are recorded on their own surfaces.
      </p>

      {unavailable ? (
        <p className="text-muted-foreground mt-8" data-testid="scholar-history-unavailable">
          Change history is temporarily unavailable. Please try again later or contact ITS Support
          if this persists.
        </p>
      ) : entries.length === 0 ? (
        <p className="text-muted-foreground mt-8" data-testid="scholar-history-empty">
          No profile edits recorded in the last {windowDays} days.
        </p>
      ) : (
        <div className="mt-8 overflow-x-auto">
          <table className="w-full text-sm" data-testid="scholar-history-table">
            <thead className="bg-apollo-surface-2 text-muted-foreground text-left">
              <tr className="border-apollo-border border-b">
                <th className="px-3 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">Actor</th>
                <th className="px-3 py-2 font-medium">Action</th>
                <th className="px-3 py-2 font-medium">Details</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr
                  key={e.id}
                  className="border-apollo-border border-b align-top"
                  data-testid={`scholar-history-row-${e.id}`}
                  data-action={e.action}
                >
                  <td className="px-3 py-2 whitespace-nowrap">{formatTs(e.ts)}</td>
                  <td className="px-3 py-2">
                    {e.actorCwid}
                    {e.impersonatedCwid && (
                      <span className="text-muted-foreground"> (as {e.impersonatedCwid})</span>
                    )}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">{e.actionLabel}</td>
                  <td className="px-3 py-2">
                    <DetailSummary entry={e} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
