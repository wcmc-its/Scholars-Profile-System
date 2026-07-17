"use client";

/**
 * Issue #1762 — the honors approval queue.
 *
 * Two shapes of decision, and conflating them is the whole risk:
 *
 *  - An ORDINARY row is one assertion: approve or reject.
 *  - A CONTESTED group is several scholars matched to ONE roster line by name.
 *    At most one of them won it. So the group offers "this is the one" per
 *    candidate — approving it rejects the rest server-side, in one transaction —
 *    plus a single "none of these" that rejects them all. There is deliberately
 *    NO plain per-row approve inside a contested group: two approvals would
 *    credit two people with one award, and misses are cheap where mismatches
 *    are not.
 */
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { HonorQueueGroup, HonorQueueRow } from "@/lib/edit/honor-queue";
import { yearPlausibilityNote } from "@/lib/edit/honor-queue";

type Props = { initialGroups: HonorQueueGroup[] };

export function HonorsQueue({ initialGroups }: Props) {
  const [groups, setGroups] = useState(initialGroups);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(row: HonorQueueRow, decision: "approve" | "reject", groupKey: string) {
    setBusy(row.id);
    setError(null);
    try {
      const res = await fetch("/api/edit/honor/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: row.id, decision }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        // Surface the real reason. "not_pending" means someone else decided it
        // first — a refresh is the honest fix, not a retry.
        setError(
          json.error === "not_pending"
            ? "Someone already decided that one. Refresh to see the current queue."
            : "That didn't save. Nothing was changed.",
        );
        return;
      }
      // Approving a contested group resolves the WHOLE group (siblings were
      // rejected server-side), so drop the group. Rejecting one candidate only
      // removes that row — the rest are still live.
      setGroups((gs) =>
        gs
          .map((g) => {
            if (g.key !== groupKey) return g;
            if (decision === "approve") return null;
            const rows = g.rows.filter((r) => r.id !== row.id);
            return rows.length ? { ...g, rows, contested: new Set(rows.map((r) => r.cwid)).size > 1 } : null;
          })
          .filter((g): g is HonorQueueGroup => g !== null),
      );
    } catch {
      setError("That didn't save. Nothing was changed.");
    } finally {
      setBusy(null);
    }
  }

  async function rejectAll(group: HonorQueueGroup) {
    for (const row of group.rows) {
      // Sequential on purpose: each is its own transaction + audit row, and a
      // parallel burst would race the pending re-check for no benefit at this size.
      await decide(row, "reject", group.key);
    }
  }

  if (groups.length === 0) {
    return (
      <p className="text-muted-foreground text-sm" data-slot="honors-queue-empty">
        Nothing pending. Every honor has been decided.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-6" data-slot="honors-queue">
      {error ? (
        <p className="rounded-sm border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
          {error}
        </p>
      ) : null}

      {groups.map((group) => (
        <div
          key={group.key}
          data-slot={group.contested ? "honor-group-contested" : "honor-group"}
          className={
            group.contested
              ? "rounded-md border-2 border-amber-400 bg-amber-50/40 p-4"
              : "rounded-md border p-4"
          }
        >
          {group.contested ? (
            <div className="mb-3">
              <Badge variant="secondary" className="mb-2">
                {group.rows.length} people match this one award
              </Badge>
              <p className="text-sm">
                <span className="font-semibold">{group.rows[0].name}</span>
                <span className="text-muted-foreground"> · {group.rows[0].organization}</span>
                {group.rows[0].year === null ? null : (
                  <span className="text-muted-foreground"> · {group.rows[0].year}</span>
                )}
              </p>
              <p className="text-muted-foreground mt-1 text-xs">
                The roster gives a name, not a person. At most one of these is the winner —
                picking one rejects the others.
              </p>
            </div>
          ) : null}

          <ul className="flex flex-col gap-3">
            {group.rows.map((row) => {
              const note = yearPlausibilityNote(row);
              return (
                <li key={row.id} className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="leading-snug">
                      <span className="font-semibold">{row.scholarName}</span>
                      {row.title ? (
                        <span className="text-muted-foreground text-sm"> · {row.title}</span>
                      ) : null}
                    </p>
                    {group.contested ? null : (
                      <p className="text-sm leading-snug">
                        {row.name}
                        <span className="text-muted-foreground"> · {row.organization}</span>
                        {row.year === null ? null : (
                          <span className="text-muted-foreground"> · {row.year}</span>
                        )}
                      </p>
                    )}
                    <p className="text-muted-foreground mt-0.5 text-xs">
                      {row.source}
                      {row.slug ? (
                        <>
                          {" · "}
                          <a
                            href={`/scholars/${row.slug}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline underline-offset-2"
                          >
                            profile ↗
                          </a>
                        </>
                      ) : null}
                    </p>
                    {note ? (
                      <p className="mt-1 text-xs text-amber-800" data-slot="honor-year-warning">
                        ⚠ {note}
                      </p>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 gap-2">
                    <Button
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => decide(row, "approve", group.key)}
                    >
                      {group.contested ? "This is the one" : "Approve"}
                    </Button>
                    {group.contested ? null : (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy !== null}
                        onClick={() => decide(row, "reject", group.key)}
                      >
                        Reject
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          {group.contested ? (
            <div className="mt-3 border-t pt-3">
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => rejectAll(group)}>
                None of these
              </Button>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
