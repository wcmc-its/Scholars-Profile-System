/**
 * CenterHistoryView — the read-only center roster audit table (#552 Phase 7;
 * `center-management-spec.md` § 6.3). Renders the last 90 days of
 * `roster_change` activity for one center: timestamp / actor / change kind /
 * target / diff summary. No interactivity, no mutation — the audit log is
 * append-only and this surface only reads it (`lib/api/center-audit.ts`).
 *
 * Server component (no state, no client hooks). The page-level authz gate
 * (`loadUnitEditContext` on the route) is what permits this to render at all;
 * by the time we get here the actor is an Owner / Curator / Superuser of THIS
 * center.
 */
import Link from "next/link";

import type { CenterAuditEntry, RosterFieldChange } from "@/lib/api/center-audit";

export type CenterHistoryViewProps = {
  /** the center @id `code` — drives the back-link to the editor. */
  centerCode: string;
  /** the center display name, for the heading. */
  centerName: string;
  /** the windowed, newest-first history rows. */
  entries: ReadonlyArray<CenterAuditEntry>;
  /** how many days the window spans (for the empty-state copy). */
  windowDays: number;
  /** the audit read failed (e.g. the read role lacks SELECT on the audit table):
   *  render an honest "unavailable" notice instead of an empty/"no changes" state. */
  unavailable?: boolean;
};

const CHANGE_LABEL: Record<CenterAuditEntry["changeKind"], string> = {
  add: "Added",
  remove: "Removed",
  modify: "Modified",
};

const FIELD_LABEL: Record<RosterFieldChange["field"], string> = {
  type: "Type",
  program: "Program",
  start: "Start",
  end: "End",
};

/** Format a stored ISO-8601 instant as a compact UTC wall-clock string. */
function formatTs(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // YYYY-MM-DD HH:MM UTC — unambiguous, locale-independent, no client drift.
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Render one row's diff: a dash for add/remove, "Field: a → b" lines for modify. */
function DiffSummary({ entry }: { entry: CenterAuditEntry }) {
  if (entry.changeKind !== "modify" || entry.fieldChanges.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <ul className="space-y-0.5">
      {entry.fieldChanges.map((c) => (
        <li key={c.field}>
          <span className="font-medium">{FIELD_LABEL[c.field]}:</span>{" "}
          <span className="text-muted-foreground">{c.from ?? "—"}</span>
          {" → "}
          <span>{c.to ?? "—"}</span>
        </li>
      ))}
    </ul>
  );
}

export function CenterHistoryView({
  centerCode,
  centerName,
  entries,
  windowDays,
  unavailable = false,
}: CenterHistoryViewProps) {
  return (
    <main
      className="mx-auto w-full max-w-[var(--max-content)] px-6 py-10"
      data-slot="center-history-view"
      data-center-code={centerCode}
    >
      <p className="mb-4">
        <Link
          href={`/edit/center/${encodeURIComponent(centerCode)}`}
          className="text-apollo-slate hover:underline"
        >
          &larr; Back to {centerName}
        </Link>
      </p>

      <h1 className="page-title">Roster change history</h1>
      <p className="text-muted-foreground mt-2">
        {centerName} — roster changes in the last {windowDays} days. Read-only.
      </p>

      {unavailable ? (
        <p className="text-muted-foreground mt-8" data-testid="center-history-unavailable">
          Change history is temporarily unavailable. Please try again later or contact ITS Support
          if this persists.
        </p>
      ) : entries.length === 0 ? (
        <p className="text-muted-foreground mt-8" data-testid="center-history-empty">
          No roster changes recorded in the last {windowDays} days.
        </p>
      ) : (
        <div className="mt-8 overflow-x-auto">
          <table className="w-full text-sm" data-testid="center-history-table">
            <thead className="bg-apollo-surface-2 text-muted-foreground text-left">
              <tr className="border-apollo-border border-b">
                <th className="px-3 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">Actor</th>
                <th className="px-3 py-2 font-medium">Change</th>
                <th className="px-3 py-2 font-medium">Member</th>
                <th className="px-3 py-2 font-medium">Details</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr
                  key={e.id}
                  className="border-apollo-border border-b align-top"
                  data-testid={`center-history-row-${e.id}`}
                  data-change-kind={e.changeKind}
                >
                  <td className="px-3 py-2 whitespace-nowrap">{formatTs(e.ts)}</td>
                  <td className="px-3 py-2">
                    {e.actorCwid}
                    {e.impersonatedCwid && (
                      <span className="text-muted-foreground"> (as {e.impersonatedCwid})</span>
                    )}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">{CHANGE_LABEL[e.changeKind]}</td>
                  <td className="px-3 py-2 font-medium whitespace-nowrap">{e.targetCwid}</td>
                  <td className="px-3 py-2">
                    <DiffSummary entry={e} />
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
