/**
 * "Who can run this report" — the per-report access popover for the `/edit`
 * reports. Relocates the bottom-of-page "Viewers" card
 * (`report-access-panel.tsx`) into a `Users` icon beside a report's heading,
 * so the answer to "who else can open this?" sits next to the report instead
 * of below its data, and so every report — not only the one with a grant
 * table — can carry the same affordance.
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
 *     server truth (the panel's fetch idiom, no optimistic overlay — a grant
 *     list is short and a round-trip is instant).
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

/** Unit-gated report: static rule + a link to the administrators page. */
export type ReportAccessPopoverUnitProps = { mode: "unit" };

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
};

export type ReportAccessPopoverProps = ReportAccessPopoverUnitProps | ReportAccessPopoverPersonProps;

const GENERIC_ERROR = "That didn't save. Try again.";

function errorMessage(code: string | undefined): string {
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

function formatDate(iso: string): string {
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

const CONTENT_CLASS = "w-[28rem] max-w-[calc(100vw-2rem)] text-sm";

export function ReportAccessPopover(props: ReportAccessPopoverProps) {
  if (props.mode === "unit") {
    return (
      <Popover>
        <Trigger />
        <PopoverContent align="start" className={CONTENT_CLASS} data-testid="report-access-popover">
          <p className="text-muted-foreground">
            Owners and Curators of the unit this report is opened for can run it, plus superusers
            and comms stewards.
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

function PersonAccess({ reportKey, initialRows, scopeOptions, canManage }: ReportAccessPopoverPersonProps) {
  const [rows, setRows] = React.useState<ReadonlyArray<ReportAccessPopoverRow>>(initialRows);
  const [person, setPerson] = React.useState<DirectoryValue | null>(null);
  const [scope, setScope] = React.useState(scopeOptions[0]?.[0] ?? "*");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const labelFor = React.useMemo(() => new Map(scopeOptions), [scopeOptions]);

  async function post(
    op: "grant" | "revoke",
    scopeKey: string,
    target: { cwid: string; name?: string },
  ): Promise<void> {
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
        return;
      }
      setRows(data.rows);
      if (op === "grant") setPerson(null);
    } catch {
      setError(GENERIC_ERROR);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Popover>
      <Trigger />
      <PopoverContent align="start" className={CONTENT_CLASS} data-testid="report-access-popover">
        <p className="text-muted-foreground text-xs">
          Superusers and comms stewards can always run this report.
        </p>
        {rows.length === 0 ? (
          <p className="text-muted-foreground mt-2" data-testid="report-access-empty">
            No one else yet.
          </p>
        ) : (
          <table className="mt-2 w-full text-left">
            <thead>
              <tr className="text-muted-foreground text-xs tracking-wide uppercase">
                <th className="py-1 pr-3 font-semibold">Name</th>
                <th className="py-1 pr-3 font-semibold">CWID</th>
                <th className="py-1 pr-3 font-semibold">Program</th>
                <th className="py-1 pr-3 font-semibold">Granted by</th>
                <th className="py-1 pr-3 font-semibold">Date</th>
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
                  <td className="py-1.5 pr-3">{r.name}</td>
                  <td className="py-1.5 pr-3 font-mono text-xs">{r.cwid}</td>
                  <td className="py-1.5 pr-3">{labelFor.get(r.scopeKey) ?? r.scopeKey}</td>
                  <td className="py-1.5 pr-3 font-mono text-xs">{r.grantedBy}</td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">{formatDate(r.grantedAt)}</td>
                  {canManage && (
                    <td className="py-1.5 text-right">
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
            className="border-apollo-border mt-3 flex flex-col gap-2 border-t pt-3"
            data-testid="report-access-add-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!person) return;
              void post("grant", scope, { cwid: person.cwid, name: person.name });
            }}
          >
            <DirectoryPeopleTypeahead
              value={person}
              onChange={setPerson}
              placeholder="Add a person…"
              disabled={busy}
              idPrefix="report-access"
            />
            <div className="flex flex-wrap items-end gap-2">
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
