/**
 * "Who can run this report" — the per-report access popover for the `/edit`
 * reports. Replaced the bottom-of-page "Viewers" card (the former
 * `report-access-panel.tsx`, deleted) with a `Users` icon beside a report's
 * heading (`ReportHeader`'s `access`) and beside every row of the index
 * (`reports-index.tsx`), so the answer to "who else can open this?" sits
 * next to the report instead of below its data, and so every report — not
 * only the one with a grant table — carries the same affordance.
 *
 * Two modes, a discriminated union on `mode`:
 *
 *   - `"unit"` — reports 1–6, gated by a unit Owner / Curator grant
 *     (`loadReportsContext`). READ-ONLY by design: access to a unit report IS
 *     `unit_admin` on that unit, so the popover states the rule and links to
 *     `/edit/administrators`. A per-person grant here would bypass the unit
 *     scope the report is opened for — there is no Add on purpose. Static
 *     text, no fetch.
 *
 *   - `"person"` — a row-gated report (`report_access`, report 7 today):
 *     lists the report's grant rows (Name · CWID · Program · Granted by ·
 *     Date) and, for a superuser / comms_steward (`canManage`), a Remove per
 *     row plus an add form — `DirectoryPeopleTypeahead` + program `<select>`
 *     + Add. Every write is a POST to `/api/edit/report-access`, which
 *     answers with the updated row list; the popover re-renders from that
 *     server truth (the `mentee-suggestions-card.tsx` fetch idiom, no
 *     optimistic overlay — a grant list is short and a round-trip is
 *     instant).
 *
 * Two presentations, `variant`: `"icon"` (the default — the `Users` glyph and
 * the table above; the reports index no longer renders it, 2026-09-25, it
 * shows {@link accessSummary}'s text instead) and `"badge"` (the report page header,
 * `ReportHeader`): a pill naming the default audience plus "+ N others" for
 * the grant rows, opening a read-only list. The badge never edits; its
 * "Manage access" opens the "Edit details" sheet (`report-details-sheet.tsx`)
 * through {@link openReportDetails}, where Add / Remove live. The badge reads
 * its rows straight from props, so a `router.refresh()` after the sheet
 * changes a grant re-renders it with the new list.
 *
 * Why the grant carries `name`: the popover is the only place a grantee's
 * name is ever in hand. The people picker returns the directory name at
 * grant time; the runtime cannot reach LDAP (#443) and the Medical Education
 * staff this table is for hold no Scholar row, so a render-time lookup would
 * show a bare CWID forever. The route stores it as `grantee_name` and the
 * list resolves `Scholar.preferredName ?? granteeName ?? cwid` (the
 * administrators-roster chain), which is the `name` each row carries here.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { Users } from "lucide-react";

import { DirectoryPeopleTypeahead, type DirectoryValue } from "@/components/edit/directory-people-typeahead";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

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

/** How the popover presents: the index row's icon (default) or the report
 *  header's audience pill. */
export type ReportAccessVariant = "icon" | "badge";

/** Unit-gated report: static rule + a link to the administrators page. */
export type ReportAccessPopoverUnitProps = { mode: "unit"; variant?: ReportAccessVariant };

/** Row-gated report: the grant list, and the manage controls when the
 *  viewer may change it. */
export type ReportAccessPopoverPersonProps = {
  mode: "person";
  reportKey: string;
  initialRows: ReadonlyArray<ReportAccessPopoverRow>;
  /** `[scopeKey, label]` pairs the add form offers, `"*"` included. */
  scopeOptions: ReadonlyArray<readonly [string, string]>;
  /** `canManageReportAccess(session)` — Remove / Add render only when true.
   *  The route enforces the same gate; this only hides controls that would
   *  403. */
  canManage: boolean;
  /** Who else can always run it — defaults to superusers and comms stewards. */
  note?: string;
  /** The badge's default-audience label ("All unit administrators" for
   *  report 8); defaults to {@link PERSON_AUDIENCE}. */
  audience?: string;
  variant?: ReportAccessVariant;
};

/** Administrator-gated report (report 8): static rule, any unit administrator. */
export type ReportAccessPopoverAdminProps = { mode: "admin"; variant?: ReportAccessVariant };

export type ReportAccessPopoverProps =
  | ReportAccessPopoverUnitProps
  | ReportAccessPopoverPersonProps
  | ReportAccessPopoverAdminProps;

/** The badge's default-audience labels. */
export const UNIT_AUDIENCE = "Unit owners and curators";
export const ADMIN_AUDIENCE = "All unit administrators";
export const PERSON_AUDIENCE = "Superusers and comms stewards";
const UNIT_RULE =
  "Owners and Curators of the unit this report is opened for can run it, plus superusers and comms stewards.";
const ADMIN_RULE =
  "Every unit administrator — an Owner or Curator of any unit — can run it, plus superusers and comms stewards.";
/** The badge list's line under the default audience for a person-gated report
 *  with no note of its own: the audience name is the row's title already. */
const PERSON_RULE_SHORT = "Always have access.";

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

/** The shared trigger: a `Users` glyph, labelled for AT, one testid in both
 *  modes so a page test can find it without knowing which mode rendered. */
function Trigger() {
  return (
    <PopoverTrigger asChild>
      <button
        type="button"
        aria-label="Who can run this report"
        data-testid="report-access-trigger"
        className="text-apollo-slate hover:text-apollo-maroon inline-flex items-center"
      >
        <Users size={16} aria-hidden />
      </button>
    </PopoverTrigger>
  );
}

// 34rem: five columns plus Remove fit on one line each (28rem wrapped the
// "Granted by" header and two-word names, 2026-09-20 staging eyeball).
const CONTENT_CLASS = "w-[34rem] max-w-[calc(100vw-2rem)] text-sm";

export function ReportAccessPopover(props: ReportAccessPopoverProps) {
  if (props.variant === "badge") return <AccessBadge {...props} />;
  if (props.mode === "unit" || props.mode === "admin") {
    return (
      <Popover>
        <Trigger />
        <PopoverContent align="start" className={CONTENT_CLASS} data-testid="report-access-popover">
          <p className="text-muted-foreground">
            {props.mode === "admin"
              ? "Every unit administrator — an Owner or Curator of any unit — can run it, plus superusers and comms stewards."
              : "Owners and Curators of the unit this report is opened for can run it, plus superusers and comms stewards."}
          </p>
          <p className="mt-2">
            <Link href="/edit/administrators" className="text-apollo-maroon underline-offset-2 hover:underline">
              Manage unit administrators
            </Link>
          </p>
        </PopoverContent>
      </Popover>
    );
  }
  return <PersonAccess {...props} />;
}

/**
 * A row-granted report's grant list plus its Add / Remove round-trip — POST
 * `/api/edit/report-access`, then the rows the route answers with (server
 * truth, no optimistic overlay). Shared by the index popover and the "Edit
 * details" sheet; `onChange` runs after each successful write (the sheet
 * refreshes the page so the header badge re-reads the list).
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

function PersonAccess({ reportKey, initialRows, scopeOptions, canManage, note }: ReportAccessPopoverPersonProps) {
  // A report with one scope (the wildcard) has nothing to pick or show.
  const scoped = scopeOptions.length > 1;
  const { rows, busy, error, post } = useReportAccessRows(reportKey, initialRows);
  const [person, setPerson] = React.useState<DirectoryValue | null>(null);
  const [scope, setScope] = React.useState(scopeOptions[0]?.[0] ?? "*");
  const labelFor = React.useMemo(() => new Map(scopeOptions), [scopeOptions]);

  return (
    <Popover>
      <Trigger />
      <PopoverContent align="start" className={CONTENT_CLASS} data-testid="report-access-popover">
        <p className="text-muted-foreground text-xs">
          {note ?? "Superusers and comms stewards can always run this report."}
        </p>
        {rows.length === 0 ? (
          <p className="text-muted-foreground mt-2" data-testid="report-access-empty">
            No one else yet.
          </p>
        ) : (
          <table className="mt-3 w-full text-left">
            <thead>
              <tr className="text-muted-foreground text-xs tracking-wide uppercase">
                <th className="py-1.5 pr-4 font-semibold whitespace-nowrap">Name</th>
                <th className="py-1.5 pr-4 font-semibold whitespace-nowrap">CWID</th>
                {scoped && <th className="py-1.5 pr-4 font-semibold whitespace-nowrap">Program</th>}
                <th className="py-1.5 pr-4 font-semibold whitespace-nowrap">Granted by</th>
                <th className="py-1.5 pr-4 font-semibold whitespace-nowrap">Date</th>
                {canManage && <th className="py-1" />}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={`${r.scopeKey}:${r.cwid}`}
                  className="border-apollo-border border-t"
                  data-testid={`report-access-row-${r.scopeKey}-${r.cwid}`}
                >
                  <td className="py-2 pr-4">{r.name}</td>
                  <td className="py-2 pr-4 font-mono text-xs">{r.cwid}</td>
                  {scoped && <td className="py-2 pr-4">{labelFor.get(r.scopeKey) ?? r.scopeKey}</td>}
                  <td className="py-2 pr-4 font-mono text-xs">{r.grantedBy}</td>
                  <td className="py-2 pr-4 whitespace-nowrap">{formatDate(r.grantedAt)}</td>
                  {canManage && (
                    <td className="py-2 text-right">
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        disabled={busy}
                        onClick={() => void post("revoke", r.scopeKey, { cwid: r.cwid })}
                      >
                        Remove
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {canManage && (
          <form
            className="border-apollo-border mt-4 flex flex-col gap-2 border-t pt-4"
            data-testid="report-access-add-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!person) return;
              void post("grant", scope, { cwid: person.cwid, name: person.name }).then((ok) => {
                if (ok) setPerson(null);
              });
            }}
          >
            {/* One row: the person picker takes the slack, program + Add sit
                beside it; wraps only when the popover is at phone width. */}
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[14rem] flex-1">
                <DirectoryPeopleTypeahead
                  value={person}
                  onChange={setPerson}
                  placeholder="Add a person…"
                  disabled={busy}
                  idPrefix="report-access"
                />
              </div>
              {scoped && (
                <label className="flex flex-col gap-1">
                  <span className="text-muted-foreground text-xs">Program</span>
                  <select
                    value={scope}
                    onChange={(e) => setScope(e.target.value)}
                    className="border-apollo-border rounded border px-2 py-1"
                    data-testid="report-access-scope"
                  >
                    {scopeOptions.map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <Button type="submit" variant="apollo" size="sm" disabled={busy || person === null}>
                Add
              </Button>
            </div>
            {error && (
              <p role="alert" className="text-destructive text-xs" data-testid="report-access-error">
                {error}
              </p>
            )}
          </form>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Two initials for a grantee's avatar: first + last word of the name, or the
 *  first two letters when the name is one word (a bare CWID). */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0]}${words[words.length - 1]![0]}`.toUpperCase();
}

/** Who can open a report, as words: the default audience, its one-line rule,
 *  the per-person grant rows, and "+ N others" for those rows (null when there
 *  are none). The single string source for the report header's badge and the
 *  index row's meta line (`reports-index.tsx`), so the two never disagree.
 *  `text` is the one-line form: "All unit administrators + 2 others". */
export function accessSummary(props: ReportAccessPopoverProps): {
  audience: string;
  rule: string;
  rows: ReadonlyArray<ReportAccessPopoverRow>;
  others: number;
  othersLabel: string | null;
  text: string;
} {
  const [audience, rule, rows] =
    props.mode === "person"
      ? [props.audience ?? PERSON_AUDIENCE, props.note ?? PERSON_RULE_SHORT, props.initialRows]
      : props.mode === "admin"
        ? [ADMIN_AUDIENCE, ADMIN_RULE, []]
        : [UNIT_AUDIENCE, UNIT_RULE, []];
  const others = rows.length;
  const othersLabel = others > 0 ? `+ ${others} other${others === 1 ? "" : "s"}` : null;
  return { audience, rule, rows, others, othersLabel, text: othersLabel ? `${audience} ${othersLabel}` : audience };
}

/** The report header's access pill: the default audience, "+ N others" for the
 *  grant rows, and a read-only list (the mockup's "Who can open this report").
 *  "Manage access" (a manager only) opens the "Edit details" sheet; a unit
 *  report links to the administrators page instead, since its access IS the
 *  unit's Owner / Curator grants. */
function AccessBadge(props: ReportAccessPopoverProps) {
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
