/**
 * MethodFamiliesRoster — the body of `/edit/methods`
 * (`comms-steward-methods-visibility-spec.md` §8).
 *
 * A SINGLE master table (no detail panel for v1): one row per distinct
 * `(supercategory, family_label)`, with the family label, its supercategory, a
 * segmented Tier control (Public / Suppressed / Sensitive → `POST
 * /api/edit/methods/families/tier`), the surfacing Flag (reason when matched), a
 * "New" badge, scholar/pub counts, and a "Reviewed" affordance (`POST
 * /api/edit/methods/families/review`). All writes are optimistic with the
 * zero-latency-confirm pattern (#841): the UI reflects the new state immediately
 * and only rolls back on a failed response.
 *
 * Visual language (Apollo console): the Tier control tints only the SELECTED
 * segment, semantically — Public green, Suppressed slate/neutral, Sensitive red —
 * reusing the AA-tested apollo tokens. A one-line legend above the table teaches
 * the color system. Flagged-but-unreviewed rows carry a small amber dot; reviewed
 * rows dim back. The flag reads quietly (a tag glyph + the matched cause), with
 * `Term:` matches italicized amber to distinguish them from `Category:` matches.
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
import { AlertTriangle, Check, Loader2, Tag } from "lucide-react";

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

/** Active-segment tint per tier — semantic, low-saturation, reusing the existing
 *  AA-tested apollo tokens (green = visible, slate = hidden/neutral, red =
 *  sensitive). Only the SELECTED segment is tinted; the rim is an inset ring. */
const TIER_ACTIVE: Record<FamilyTier, string> = {
  public:
    "bg-apollo-green-tint text-apollo-green-foreground ring-1 ring-inset ring-apollo-green-tint-border",
  suppressed:
    "bg-apollo-slate-tint text-apollo-slate ring-1 ring-inset ring-apollo-slate-tint-border",
  sensitive:
    "bg-apollo-red-tint text-apollo-maroon ring-1 ring-inset ring-apollo-red-tint-border",
};

/** One-line legend teaching the tier colors (swatch token + plain meaning). */
const TIER_LEGEND: ReadonlyArray<{ swatch: string; label: string }> = [
  { swatch: "bg-apollo-green-foreground", label: "Public — shown on profiles" },
  { swatch: "bg-apollo-slate", label: "Suppressed — hidden" },
  { swatch: "bg-apollo-maroon", label: "Sensitive — internal only" },
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

  // Counts for every filter tab (not just the review queue).
  const counts = React.useMemo<Record<FamilyRosterFilter, number>>(
    () => ({
      flagged: roster.filter((r) => r.reason !== null).length,
      new: roster.filter((r) => r.isNew).length,
      all: roster.length,
      public: roster.filter((r) => r.tier === "public").length,
      suppressed: roster.filter((r) => r.tier === "suppressed").length,
      sensitive: roster.filter((r) => r.tier === "sensitive").length,
    }),
    [roster],
  );

  return (
    <div className="flex flex-col gap-4" data-slot="method-families-roster">
      {/* §2/§3 — the live sensitivity-gate banner, shown prominently. Gate ON is a
          calm informational note (amber left-rule); gate OFF is the warning. */}
      <Alert
        variant="info"
        className={cn(
          "mb-1",
          sensitivityGateOn
            ? "border-apollo-border border-l-apollo-amber bg-apollo-page border-l-[3px]"
            : "text-apollo-amber bg-apollo-amber-tint border-apollo-amber-tint-border",
        )}
        data-slot="sensitivity-gate-banner"
        data-gate-on={sensitivityGateOn ? "true" : "false"}
      >
        <AlertTriangle className="text-apollo-amber size-4" />
        <AlertTitle>Sensitivity gate is {sensitivityGateOn ? "on" : "off"}</AlertTitle>
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

      {/* Legend — teaches the tier color system in one line. */}
      <div
        className="text-muted-foreground flex flex-wrap items-center gap-x-5 gap-y-1.5 px-0.5 text-xs"
        data-slot="tier-legend"
      >
        <span className="text-foreground font-medium">Tier</span>
        {TIER_LEGEND.map((l) => (
          <span key={l.label} className="inline-flex items-center gap-1.5">
            <span className={cn("size-2.5 rounded-[3px]", l.swatch)} aria-hidden />
            {l.label}
          </span>
        ))}
      </div>

      {/* Filter bar + counts + CSV download. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter families">
          {FILTERS.map((f) => {
            const active = filter === f.value;
            const count = counts[f.value];
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
                <span
                  className={cn(
                    "inline-flex min-w-4 items-center justify-center rounded-full px-1 text-[0.65rem] tabular-nums",
                    active
                      ? "bg-white/25 text-white"
                      : f.value === "flagged" && count > 0
                        ? "bg-apollo-red-tint text-apollo-maroon"
                        : "bg-apollo-maroon/10 text-apollo-maroon",
                  )}
                >
                  {count}
                </span>
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
                const isTermFlag = row.reason?.startsWith("term:") ?? false;
                return (
                  <tr
                    key={key}
                    className={cn(
                      "border-apollo-border border-b align-top last:border-b-0",
                      reviewed && "opacity-60",
                    )}
                    data-testid={`methods-family-row-${row.supercategory}-${row.familyLabel}`}
                  >
                    {/* Family label + supercategory eyebrow + New badge. The amber
                        dot marks a flagged family that hasn't been reviewed yet. */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {flagged && !reviewed && (
                          <span
                            className="bg-apollo-amber size-1.5 shrink-0 rounded-full"
                            aria-hidden
                            data-testid={`methods-unreviewed-dot-${key}`}
                          />
                        )}
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
                      <div className="text-muted-foreground mt-0.5 font-mono text-xs">
                        {row.supercategory}
                      </div>
                    </td>

                    {/* Tier — a segmented control; only the active segment is tinted. */}
                    <td className="px-4 py-3">
                      <div
                        className="border-border inline-flex overflow-hidden rounded-md border"
                        role="group"
                        aria-label="Visibility tier"
                        data-testid={`methods-tier-${key}`}
                      >
                        {TIERS.map((t) => {
                          const selected = row.tier === t.value;
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
                                  ? TIER_ACTIVE[t.value]
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

                    {/* Flag — the surfacing reason, read quietly. `Term:` matches
                        are italic amber to set them apart from `Category:` matches. */}
                    <td className="px-4 py-3">
                      {flagged ? (
                        <span
                          className={cn(
                            "inline-flex items-center gap-1.5 text-xs",
                            isTermFlag ? "text-apollo-amber italic" : "text-muted-foreground",
                          )}
                          data-testid={`methods-flag-${key}`}
                        >
                          <Tag className="size-3 shrink-0 opacity-70" aria-hidden />
                          <span className="truncate">{reasonLabel(row.reason!)}</span>
                        </span>
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
                          className="text-apollo-green-foreground inline-flex items-center gap-1 text-xs"
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
