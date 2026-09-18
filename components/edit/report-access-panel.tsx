/**
 * "Viewers" — the per-report access panel on `/edit/reports/7`, rendered ONLY
 * for a superuser / comms_steward (the page gates it with
 * `canManageReportAccess`; this component renders what it is handed). Lists
 * the report's `report_access` rows with a Remove button each, plus an add
 * form (CWID + scope). Every write is a POST to `/api/edit/report-access`,
 * which answers with the updated row list — the panel re-renders from that
 * server truth (the `mentee-suggestions-card.tsx` fetch idiom, minus the
 * optimistic overlay: a grant list is short and a round-trip is instant).
 */
"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";

export type ReportAccessPanelRow = {
  reportKey: string;
  scopeKey: string;
  cwid: string;
  grantedBy: string;
  /** ISO string — plain-serializable across the server/client boundary. */
  grantedAt: string;
};

export type ReportAccessPanelProps = {
  reportKey: string;
  initialRows: ReadonlyArray<ReportAccessPanelRow>;
  /** `[scopeKey, label]` pairs the add form offers, `"*"` included. */
  scopeOptions: ReadonlyArray<readonly [string, string]>;
};

const GENERIC_ERROR = "That didn't save. Try again.";

function errorMessage(code: string | undefined): string {
  switch (code) {
    case "invalid_cwid":
      return "Enter a CWID (letters and digits, e.g. abc1234).";
    case "invalid_scope_key":
      return "Pick a program.";
    case "not_comms_steward":
      return "Only a superuser or comms steward can change viewers.";
    default:
      return GENERIC_ERROR;
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function ReportAccessPanel({ reportKey, initialRows, scopeOptions }: ReportAccessPanelProps) {
  const [rows, setRows] = React.useState<ReadonlyArray<ReportAccessPanelRow>>(initialRows);
  const [cwid, setCwid] = React.useState("");
  const [scope, setScope] = React.useState(scopeOptions[0]?.[0] ?? "*");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const labelFor = React.useMemo(() => new Map(scopeOptions), [scopeOptions]);

  async function post(op: "grant" | "revoke", scopeKey: string, target: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/edit/report-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op, reportKey, scopeKey, cwid: target }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        rows?: ReportAccessPanelRow[];
      };
      if (!res.ok || data.ok !== true || !Array.isArray(data.rows)) {
        setError(errorMessage(data.error));
        return;
      }
      setRows(data.rows);
      if (op === "grant") setCwid("");
    } catch {
      setError(GENERIC_ERROR);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="apollo-card mt-8" data-testid="report-access-panel">
      <h2 className="text-base font-semibold">Viewers</h2>
      <p className="text-muted-foreground mt-1 text-sm">
        Who can open this report besides superusers and comms stewards, and which program each
        may see. Changes take effect on the viewer&rsquo;s next page load.
      </p>
      {rows.length === 0 ? (
        <p className="text-muted-foreground mt-3 text-sm" data-testid="report-access-empty">
          No viewers yet.
        </p>
      ) : (
        <table className="mt-3 w-full text-left text-sm">
          <thead>
            <tr className="text-muted-foreground text-xs uppercase tracking-wide">
              <th className="py-1 pr-3 font-semibold">CWID</th>
              <th className="py-1 pr-3 font-semibold">Program</th>
              <th className="py-1 pr-3 font-semibold">Granted by</th>
              <th className="py-1 pr-3 font-semibold">Date</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={`${r.scopeKey}:${r.cwid}`}
                className="border-apollo-border border-t"
                data-testid={`report-access-row-${r.scopeKey}-${r.cwid}`}
              >
                <td className="py-1.5 pr-3 font-mono">{r.cwid}</td>
                <td className="py-1.5 pr-3">{labelFor.get(r.scopeKey) ?? r.scopeKey}</td>
                <td className="py-1.5 pr-3 font-mono">{r.grantedBy}</td>
                <td className="py-1.5 pr-3">{formatDate(r.grantedAt)}</td>
                <td className="py-1.5 text-right">
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={busy}
                    onClick={() => void post("revoke", r.scopeKey, r.cwid)}
                  >
                    Remove
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form
        className="mt-4 flex flex-wrap items-end gap-3 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          void post("grant", scope, cwid.trim().toLowerCase());
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs">CWID</span>
          <input
            type="text"
            value={cwid}
            onChange={(e) => setCwid(e.target.value)}
            placeholder="abc1234"
            autoComplete="off"
            spellCheck={false}
            className="border-apollo-border w-32 rounded border px-2 py-1 font-mono"
            data-testid="report-access-cwid"
          />
        </label>
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
        <Button type="submit" variant="apollo" size="sm" disabled={busy || cwid.trim() === ""}>
          Add viewer
        </Button>
        {error && (
          <p role="alert" className="text-destructive basis-full text-xs" data-testid="report-access-error">
            {error}
          </p>
        )}
      </form>
    </section>
  );
}
