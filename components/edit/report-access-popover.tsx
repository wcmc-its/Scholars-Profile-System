/**
 * "Who can open this report" — the access badge in every `/edit/reports`
 * report's header (`ReportHeader`'s `access`): a pill naming the default
 * audience plus "+ N others" for the per-person grant rows, opening a
 * read-only list. It never edits: a manager's "Manage access" opens the
 * "Edit details" sheet (`report-details-sheet.tsx`) through
 * {@link openReportDetails}, where Add / Remove live
 * ({@link useReportAccessRows}); a unit report links to
 * `/edit/administrators`, since its access IS the unit's Owner / Curator
 * grants. The badge reads its rows straight from props, so a
 * `router.refresh()` after the sheet changes a grant re-renders it with the
 * new list. Its words come from `accessSummary`
 * (`lib/edit/report-access-summary.ts`), which the reports index row prints as
 * plain text — one string source for both.
 *
 * The index-row icon popover (`variant="icon"`, with its own Add / Remove
 * table) was removed on 2026-09-25, when the index went to plain-text access.
 *
 * Three modes, a discriminated union on `mode`:
 *
 *   - `"unit"` — reports 1–6, gated by a unit Owner / Curator grant
 *     (`loadReportsContext`). Read-only by design: a per-person grant would
 *     bypass the unit scope the report is opened for.
 *   - `"admin"` — report 8's rule: any unit administrator.
 *   - `"person"` — a row-gated report (`report_access`): the grant rows.
 *
 * Why the grant carries `name`: the people picker returns the directory name
 * at grant time; the runtime cannot reach LDAP (#443) and the Medical
 * Education staff this table is for hold no Scholar row, so a render-time
 * lookup would show a bare CWID forever. The route stores it as
 * `grantee_name` and the list resolves `Scholar.preferredName ?? granteeName
 * ?? cwid` (the administrators-roster chain), which is the `name` each row
 * carries here.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { accessSummary } from "@/lib/edit/report-access-summary";

export {
  accessSummary,
  ADMIN_AUDIENCE,
  PERSON_AUDIENCE,
  UNIT_AUDIENCE,
} from "@/lib/edit/report-access-summary";

/** One grant row as the server hands it across the boundary — the
 *  `ReportAccessRow` shape with `grantedAt` as an ISO string. */
export type ReportAccessPopoverRow = {
  reportKey: string;
  scopeKey: string;
  cwid: string;
  /** The directory name captured at grant time; null on pre-column rows. */
  granteeName: string | null;
  /** Resolved display name: `preferredName ?? granteeName ?? cwid`. */
  name: string;
  grantedBy: string;
  /** ISO string — plain-serializable across the server/client boundary. */
  grantedAt: string;
};

/** Unit-gated report: static rule + a link to the administrators page. */
export type ReportAccessPopoverUnitProps = { mode: "unit" };

/** Row-gated report: the grant list, and the manage controls when the
 *  viewer may change it. */
export type ReportAccessPopoverPersonProps = {
  mode: "person";
  reportKey: string;
  initialRows: ReadonlyArray<ReportAccessPopoverRow>;
  /** `[scopeKey, label]` pairs the sheet's add form offers, `"*"` included;
   *  the badge labels each row's program from them. */
  scopeOptions: ReadonlyArray<readonly [string, string]>;
  /** `canManageReportAccess(session)` — the badge's "Manage access" (and the
   *  sheet's Add / Remove) render only when true. The route enforces the same
   *  gate; this only hides controls that would 403. */
  canManage: boolean;
  /** Who else can always run it — defaults to superusers and comms stewards. */
  note?: string;
  /** The badge's default-audience label ("All unit administrators" for
   *  report 8); defaults to {@link PERSON_AUDIENCE}. */
  audience?: string;
};

/** Administrator-gated report (report 8): static rule, any unit administrator. */
export type ReportAccessPopoverAdminProps = { mode: "admin" };

export type ReportAccessPopoverProps =
  | ReportAccessPopoverUnitProps
  | ReportAccessPopoverPersonProps
  | ReportAccessPopoverAdminProps;

/** The window event the badge's "Manage access" fires and the "Edit details"
 *  sheet listens for — the two are separate islands in the server header. */
export const REPORT_DETAILS_OPEN_EVENT = "report-details-open";
export function openReportDetails(): void {
  window.dispatchEvent(new Event(REPORT_DETAILS_OPEN_EVENT));
}

const GENERIC_ERROR = "That didn't save. Try again.";

export function errorMessage(code: string | undefined): string {
  switch (code) {
    case "invalid_cwid":
      return "Pick a person from the directory.";
    case "invalid_scope_key":
      return "Pick a program.";
    case "not_comms_steward":
      return "Only a superuser or comms steward can change who can run this report.";
    default:
      return GENERIC_ERROR;
  }
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/**
 * A row-granted report's grant list plus its Add / Remove round-trip — POST
 * `/api/edit/report-access`, then the rows the route answers with (server
 * truth, no optimistic overlay). Used by the "Edit details" sheet; `onChange`
 * runs after each successful write (the sheet refreshes the page so the header
 * badge re-reads the list).
 */
export function useReportAccessRows(
  reportKey: string,
  initialRows: ReadonlyArray<ReportAccessPopoverRow>,
  onChange?: () => void,
) {
  const [rows, setRows] = React.useState<ReadonlyArray<ReportAccessPopoverRow>>(initialRows);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function post(
    op: "grant" | "revoke",
    scopeKey: string,
    target: { cwid: string; name?: string },
  ): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/edit/report-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op, reportKey, scopeKey, cwid: target.cwid, name: target.name }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        rows?: ReportAccessPopoverRow[];
      };
      if (!res.ok || data.ok !== true || !Array.isArray(data.rows)) {
        setError(errorMessage(data.error));
        return false;
      }
      setRows(data.rows);
      onChange?.();
      return true;
    } catch {
      setError(GENERIC_ERROR);
      return false;
    } finally {
      setBusy(false);
    }
  }

  return { rows, busy, error, post };
}

/** Two initials for a grantee's avatar: first + last word of the name, or the
 *  first two letters when the name is one word (a bare CWID). */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0]}${words[words.length - 1]![0]}`.toUpperCase();
}

/** The report header's access pill: the default audience, "+ N others" for the
 *  grant rows, and a read-only list (the mockup's "Who can open this report").
 *  "Manage access" (a manager only) opens the "Edit details" sheet; a unit
 *  report links to the administrators page instead, since its access IS the
 *  unit's Owner / Curator grants. */
export function ReportAccessPopover(props: ReportAccessPopoverProps) {
  const { audience, rule, rows, others, othersLabel } = accessSummary(props);
  const labelFor = new Map(props.mode === "person" && props.scopeOptions.length > 1 ? props.scopeOptions : []);
  const canManage = props.mode === "person" && props.canManage;
  const [open, setOpen] = React.useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Who can run this report: ${audience}${others > 0 ? ` and ${others} other${others === 1 ? "" : "s"}` : ""}`}
          data-testid="report-access-trigger"
          className="text-apollo-slate bg-apollo-slate-tint border-apollo-slate-tint-border hover:border-apollo-slate inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[13px] whitespace-nowrap"
        >
          <Users size={14} aria-hidden />
          <span>{audience}</span>
          {othersLabel && <span className="font-semibold">{othersLabel}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)] p-0 text-sm" data-testid="report-access-popover">
        <div className="px-4 pt-3.5 pb-2.5 font-semibold">Who can open this report</div>
        <ul className="border-apollo-border border-t">
          <li className="border-apollo-border flex items-center gap-2.5 border-b px-4 py-2.5 last:border-b-0">
            <span className="bg-apollo-slate-tint text-apollo-slate grid size-[30px] shrink-0 place-items-center rounded-full">
              <Users size={15} aria-hidden />
            </span>
            <span className="min-w-0">
              <span className="block">{audience}</span>
              <span className="text-muted-foreground block text-xs">{rule}</span>
            </span>
          </li>
          {rows.map((r) => {
            const program = labelFor.get(r.scopeKey);
            return (
              <li
                key={`${r.scopeKey}:${r.cwid}`}
                className="border-apollo-border flex items-center gap-2.5 border-b px-4 py-2.5 last:border-b-0"
                data-testid={`report-access-row-${r.scopeKey}-${r.cwid}`}
              >
                <span
                  aria-hidden
                  className="bg-apollo-surface-2 border-apollo-border-strong grid size-[30px] shrink-0 place-items-center rounded-full border text-xs font-semibold"
                >
                  {initials(r.name)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block">{r.name}</span>
                  <span className="text-muted-foreground block text-xs">
                    {program ? `${program} · ` : ""}added {formatDate(r.grantedAt)}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
        {(canManage || props.mode === "unit") && (
          <div className="border-apollo-border bg-apollo-surface-2 border-t px-4 py-2.5">
            {canManage ? (
              <Button
                type="button"
                variant="link"
                size="xs"
                className="px-0"
                onClick={() => {
                  setOpen(false);
                  openReportDetails();
                }}
              >
                Manage access
              </Button>
            ) : (
              <Link href="/edit/administrators" className="text-apollo-maroon text-xs underline-offset-2 hover:underline">
                Manage unit administrators
              </Link>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
