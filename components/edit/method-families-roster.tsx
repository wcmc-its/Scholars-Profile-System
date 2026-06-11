/**
 * MethodFamiliesRoster — the body of `/edit/methods`
 * (`comms-steward-methods-visibility-spec.md` §8).
 *
 * A SINGLE master table (no detail panel for v1): one row per distinct
 * `(supercategory, family_label)`, with the family label, its supercategory, a
 * segmented Tier control (Public / Suppressed / Sensitive → `POST
 * /api/edit/methods/families/tier`), the surfacing Flag chip (reason when
 * matched), a "New" badge, scholar/pub counts, and a "Reviewed" affordance
 * (`POST /api/edit/methods/families/review`). All writes are optimistic with the
 * zero-latency-confirm pattern (#841): the UI reflects the new state immediately
 * and only rolls back on a failed response.
 *
 * Default view = the review queue (`filter=flagged`): the server pre-orders the
 * roster by the §6 priority (new∧flagged > flagged∧unreviewed > flagged∧reviewed
 * > unflagged), so simply filtering to flagged surfaces the mouse-model families
 * first. A filter bar switches to all / new / by-tier; each filter is applied
 * CLIENT-SIDE over the full roster the server already sent, so there is no extra
 * round-trip and an optimistic tier change re-buckets live.
 *
 * §2 inert-sensitive caveat: the Sensitive tier hides a family publicly ONLY
 * when `METHODS_LENS_SENSITIVE_GATE=on`. The live gate state is shown
 * prominently at the top; when the gate is OFF, choosing/holding Sensitive shows
 * an inline amber warning that the family still renders publicly. The steward is
 * never misled into thinking a flagged family is hidden when it isn't.
 *
 * Client component: it holds the mutable roster, the active filter, and the
 * per-row busy/error state. The "Download for review (CSV)" button is a plain
 * link to `GET /api/export/methods/families?filter=…`, reflecting exactly what
 * the steward is viewing.
 */
"use client";

import * as React from "react";
import { AlertTriangle, Check, Loader2 } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  FamilyRosterFilter,
  FamilyRosterRow,
  FamilyTier,
} from "@/lib/api/methods-families";

const TIERS: ReadonlyArray<{ value: FamilyTier; label: string }> = [
  { value: "public", label: "Public" },
  { value: "suppressed", label: "Suppressed" },
  { value: "sensitive", label: "Sensitive" },
];

/** The filter-bar options (§8). `flagged` is the default (the review queue). */
const FILTERS: ReadonlyArray<{ value: FamilyRosterFilter; label: string }> = [
  { value: "flagged", label: "Needs review" },
  { value: "new", label: "New" },
  { value: "all", label: "All" },
  { value: "public", label: "Public" },
  { value: "suppressed", label: "Suppressed" },
  { value: "sensitive", label: "Sensitive" },
];

/** A stable per-row key on the immutable `(supercategory, family_label)` identity. */
function rowKey(r: Pick<FamilyRosterRow, "supercategory" | "familyLabel">): string {
  return `${r.supercategory} ${r.familyLabel}`;
}

/** Apply a filter client-side over the (server-pre-ordered) full roster. Mirrors
 *  `applyRosterFilter` server-side so the bar re-buckets without a round-trip and
 *  an optimistic tier change updates the by-tier views live. */
function filterRows(rows: FamilyRosterRow[], filter: FamilyRosterFilter): FamilyRosterRow[] {
  switch (filter) {
    case "all":
      return rows;
    case "flagged":
      return rows.filter((r) => r.reason !== null);
    case "new":
      return rows.filter((r) => r.isNew);
    case "public":
    case "suppressed":
    case "sensitive":
      return rows.filter((r) => r.tier === filter);
  }
}

/** Human-readable flag reason. The ETL stores machine reasons (`supercategory:…`
 *  / `term:…`); show the steward the matched cause without the prefix noise. */
function reasonLabel(reason: string): string {
  if (reason.startsWith("term:")) return `Term: ${reason.slice("term:".length)}`;
  if (reason.startsWith("supercategory:")) {
    return `Category: ${reason.slice("supercategory:".length).replace(/_/g, " ")}`;
  }
  return reason;
}

export type MethodFamiliesRosterProps = {
  /** The full roster (server-pre-ordered by the §6 review-queue priority). */
  families: ReadonlyArray<FamilyRosterRow>;
  /** Live `METHODS_LENS_SENSITIVE_GATE` state — drives the §2 inert warning. */
  sensitivityGateOn: boolean;
};

export function MethodFamiliesRoster({ families, sensitivityGateOn }: MethodFamiliesRosterProps) {
  // The mutable roster: optimistic tier/review writes update this in place.
  const [roster, setRoster] = React.useState<FamilyRosterRow[]>(() => families.map((r) => ({ ...r })));
  // Default view = the review queue (§8).
  const [filter, setFilter] = React.useState<FamilyRosterFilter>("flagged");
  // The row currently writing, keyed by `rowKey`, or null.
  const [busyKey, setBusyKey] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const visible = React.useMemo(() => filterRows(roster, filter), [roster, filter]);

  /** Set a family's tier. Optimistic: flip the local row first, POST, roll back
   *  on failure. (`public` clears both overlays server-side.) */
  async function setTier(row: FamilyRosterRow, nextTier: FamilyTier) {
    if (nextTier === row.tier) return;
    const key = rowKey(row);
    if (busyKey) return;
    const prevTier = row.tier;
    setBusyKey(key);
    setError(null);
    setRoster((prev) =>
      prev.map((r) => (rowKey(r) === key ? { ...r, tier: nextTier } : r)),
    );
    try {
      const res = await fetch("/api/edit/methods/families/tier", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          supercategory: row.supercategory,
          familyLabel: row.familyLabel,
          tier: nextTier,
        }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || data.ok !== true) {
        // Roll the optimistic change back.
        setRoster((prev) =>
          prev.map((r) => (rowKey(r) === key ? { ...r, tier: prevTier } : r)),
        );
        setError(mapError(data.error ?? ""));
      }
    } catch {
      setRoster((prev) =>
        prev.map((r) => (rowKey(r) === key ? { ...r, tier: prevTier } : r)),
      );
      setError("Something went wrong — please try again.");
    } finally {
      setBusyKey(null);
    }
  }

  /** Clear the review nag (does NOT change the tier). Optimistic. */
  async function markReviewed(row: FamilyRosterRow) {
    const key = rowKey(row);
    if (busyKey) return;
    setBusyKey(key);
    setError(null);
    const reviewedAt = new Date().toISOString();
    setRoster((prev) =>
      prev.map((r) => (rowKey(r) === key ? { ...r, reviewedAt, isNew: false } : r)),
    );
    try {
      const res = await fetch("/api/edit/methods/families/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          supercategory: row.supercategory,
          familyLabel: row.familyLabel,
        }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || data.ok !== true) {
        setRoster((prev) =>
          prev.map((r) => (rowKey(r) === key ? { ...r, reviewedAt: row.reviewedAt, isNew: row.isNew } : r)),
        );
        setError(mapError(data.error ?? ""));
      }
    } catch {
      setRoster((prev) =>
        prev.map((r) => (rowKey(r) === key ? { ...r, reviewedAt: row.reviewedAt, isNew: row.isNew } : r)),
      );
      setError("Something went wrong — please try again.");
    } finally {
      setBusyKey(null);
    }
  }

  const flaggedCount = roster.filter((r) => r.reason !== null).length;
  const newCount = roster.filter((r) => r.isNew).length;

  return (
    <div className="flex flex-col gap-4" data-slot="method-families-roster">
      {/* §2/§3 — the live sensitivity-gate banner, shown prominently. */}
      <Alert
        variant="info"
        className={cn(
          "mb-1",
          sensitivityGateOn
            ? "border-apollo-maroon/30 bg-apollo-surface-2"
            : "text-apollo-amber bg-apollo-amber-tint border-apollo-amber-tint-border",
        )}
        data-slot="sensitivity-gate-banner"
        data-gate-on={sensitivityGateOn ? "true" : "false"}
      >
        <AlertTriangle className={cn("size-4", sensitivityGateOn ? "text-apollo-maroon" : "text-apollo-amber")} />
        <AlertTitle>
          Sensitivity gate is {sensitivityGateOn ? "ON" : "OFF"}
        </AlertTitle>
        <AlertDescription>
          {sensitivityGateOn ? (
            <p>
              Families set to <strong>Sensitive</strong> are hidden from public profiles and shown
              only to internal viewers.
            </p>
          ) : (
            <p>
              Setting a family to <strong>Sensitive</strong> records the tier but does{" "}
              <strong>not</strong> hide it — with the sensitivity gate off, a Sensitive family still
              renders publicly. Use <strong>Suppressed</strong> to hide a family from everyone now.
            </p>
          )}
        </AlertDescription>
      </Alert>

      {/* Filter bar + counts + CSV download. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter families">
          {FILTERS.map((f) => {
            const active = filter === f.value;
            const count =
              f.value === "flagged" ? flaggedCount : f.value === "new" ? newCount : null;
            return (
              <button
                key={f.value}
                type="button"
                onClick={() => setFilter(f.value)}
                aria-pressed={active}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                  active
                    ? "border-apollo-maroon bg-apollo-maroon text-white"
                    : "border-border text-muted-foreground hover:text-foreground hover:border-apollo-maroon/40",
                )}
                data-testid={`methods-filter-${f.value}`}
              >
                {f.label}
                {count !== null && count > 0 && (
                  <span
                    className={cn(
                      "inline-flex min-w-4 items-center justify-center rounded-full px-1 text-[0.65rem] tabular-nums",
                      active ? "bg-white/25 text-white" : "bg-apollo-maroon/10 text-apollo-maroon",
                    )}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <Button variant="outline" size="sm" asChild>
          <a
            href={`/api/export/methods/families?filter=${encodeURIComponent(filter)}`}
            data-testid="methods-export-csv"
          >
            Download for review (CSV)
          </a>
        </Button>
      </div>

      {error && (
        <Alert variant="destructive" data-testid="methods-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="border-apollo-border overflow-x-auto rounded-md border">
        <table className="w-full text-sm" data-testid="methods-families-table">
          <thead>
            <tr className="text-muted-foreground border-apollo-border bg-apollo-surface-2 border-b text-left">
              <th className="px-4 py-2.5 font-medium">Family</th>
              <th className="px-4 py-2.5 font-medium">Tier</th>
              <th className="px-4 py-2.5 font-medium">Flag</th>
              <th className="px-4 py-2.5 text-right font-medium whitespace-nowrap">
                Scholars / Pubs
              </th>
              <th className="px-4 py-2.5 text-right font-medium">Review</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="text-muted-foreground px-4 py-8 text-center"
                  data-testid="methods-families-empty"
                >
                  {filter === "flagged"
                    ? "No families need review."
                    : "No families match this filter."}
                </td>
              </tr>
            ) : (
              visible.map((row) => {
                const key = rowKey(row);
                const busy = busyKey === key;
                const flagged = row.reason !== null;
                const reviewed = row.reviewedAt !== null;
                return (
                  <tr
                    key={key}
                    className="border-apollo-border border-b align-top last:border-b-0"
                    data-testid={`methods-family-row-${row.supercategory}-${row.familyLabel}`}
                  >
                    {/* Family label + supercategory eyebrow + New badge. */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{row.familyLabel}</span>
                        {row.isNew && (
                          <Badge
                            className="bg-apollo-maroon text-white"
                            data-testid={`methods-new-${key}`}
                          >
                            New
                          </Badge>
                        )}
                      </div>
                      <div className="text-muted-foreground text-xs">{row.supercategory}</div>
                    </td>

                    {/* Tier — a segmented control. */}
                    <td className="px-4 py-3">
                      <div
                        className="border-border inline-flex overflow-hidden rounded-md border"
                        role="group"
                        aria-label="Visibility tier"
                        data-testid={`methods-tier-${key}`}
                      >
                        {TIERS.map((t) => {
                          const selected = row.tier === t.value;
                          const danger = t.value === "sensitive" && selected && !sensitivityGateOn;
                          return (
                            <button
                              key={t.value}
                              type="button"
                              disabled={busy}
                              aria-pressed={selected}
                              onClick={() => setTier(row, t.value)}
                              title={
                                t.value === "sensitive" && !sensitivityGateOn
                                  ? "Sensitivity gate is OFF — a Sensitive family still renders publicly."
                                  : undefined
                              }
                              className={cn(
                                "border-border border-r px-2.5 py-1 text-xs font-medium transition-colors last:border-r-0 disabled:opacity-60",
                                selected
                                  ? danger
                                    ? "text-apollo-amber bg-apollo-amber-tint"
                                    : "bg-apollo-maroon text-white"
                                  : "text-muted-foreground hover:bg-accent",
                              )}
                              data-testid={`methods-tier-${t.value}-${key}`}
                            >
                              {t.label}
                            </button>
                          );
                        })}
                      </div>
                      {/* §2 inline inert-sensitive warning — only when this row is
                          Sensitive AND the gate is off. */}
                      {row.tier === "sensitive" && !sensitivityGateOn && (
                        <p
                          className="text-apollo-amber mt-1.5 flex items-start gap-1 text-xs"
                          data-testid={`methods-inert-warning-${key}`}
                        >
                          <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
                          Still public — the sensitivity gate is off.
                        </p>
                      )}
                    </td>

                    {/* Flag — the surfacing reason chip. */}
                    <td className="px-4 py-3">
                      {flagged ? (
                        <Badge
                          variant="outline"
                          className="text-apollo-amber bg-apollo-amber-tint border-apollo-amber-tint-border"
                          data-testid={`methods-flag-${key}`}
                        >
                          {reasonLabel(row.reason!)}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </td>

                    {/* Counts. */}
                    <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">
                      <span className="font-medium">{row.scholarCount}</span>
                      <span className="text-muted-foreground"> / {row.pmidCount}</span>
                    </td>

                    {/* Review affordance — clears the nag, never changes the tier. */}
                    <td className="px-4 py-3 text-right">
                      {!flagged ? (
                        <span className="text-muted-foreground text-xs">—</span>
                      ) : reviewed ? (
                        <span
                          className="text-muted-foreground inline-flex items-center gap-1 text-xs"
                          data-testid={`methods-reviewed-${key}`}
                        >
                          <Check className="size-3.5" aria-hidden />
                          Reviewed
                        </span>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          disabled={busy}
                          onClick={() => markReviewed(row)}
                          data-testid={`methods-review-${key}`}
                        >
                          {busy ? (
                            <Loader2 className="size-3 animate-spin" aria-hidden />
                          ) : null}
                          Mark reviewed
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Map an API error code to a steward-facing message. */
function mapError(code: string): string {
  switch (code) {
    case "not_comms_steward":
      return "You don't have permission to manage method families.";
    case "invalid_supercategory":
    case "invalid_family_label":
    case "invalid_tier":
      return "That family couldn't be updated — please reload and try again.";
    default:
      return "Something went wrong — please try again.";
  }
}
