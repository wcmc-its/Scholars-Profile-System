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
 *
 * The curator verifies a MATCH, so every card shows both sides of it: the name
 * the source roster printed ("matched against") and the scholar's published name
 * (exactly as the profile will render it once approved). Approved/Rejected are
 * read-only history — the "we should see accepted honors somewhere" ask.
 *
 * Full-time faculty matter most, so Pending opens filtered to them and sorted by
 * match-confidence then recency; the filter widens to Affiliated / Other / All on
 * one click and hides nothing permanently.
 */
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { HonorQueueGroup, HonorQueueRow } from "@/lib/edit/honor-queue";
import { isFullTimeFaculty, yearPlausibilityNote } from "@/lib/edit/honor-queue";

type Props = {
  pending: HonorQueueGroup[];
  approved: HonorQueueGroup[];
  rejected: HonorQueueGroup[];
};

type Tab = "pending" | "approved" | "rejected";
type PersonFilter = "faculty" | "affiliated" | "other" | "all";

/** Which filter bucket a scholar's roleCategory falls in. */
function personBucket(roleCategory: string | null): Exclude<PersonFilter, "all"> {
  if (isFullTimeFaculty(roleCategory)) return "faculty";
  if (roleCategory === "affiliated_faculty") return "affiliated";
  return "other";
}

/** A group passes a person filter when ANY of its candidates matches — a
 *  contested line whose candidates span types must stay visible under the
 *  narrower filter, or the curator can't pick the one who qualifies. */
function groupMatchesFilter(group: HonorQueueGroup, filter: PersonFilter): boolean {
  if (filter === "all") return true;
  return group.rows.some((r) => personBucket(r.roleCategory) === filter);
}

function honorLine(row: HonorQueueRow): string {
  const parts = [row.name, row.organization];
  if (row.year !== null) parts.push(String(row.year));
  return parts.join(" · ");
}

export function HonorsQueue({ pending, approved, rejected }: Props) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("pending");
  // Full-time faculty first — the curator's stated priority. Widen from there.
  const [filter, setFilter] = useState<PersonFilter>("faculty");
  const [groups, setGroups] = useState(pending);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const counts = useMemo(() => {
    const c = { faculty: 0, affiliated: 0, other: 0, all: 0 };
    for (const g of groups)
      for (const r of g.rows) {
        c.all += 1;
        c[personBucket(r.roleCategory)] += 1;
      }
    return c;
  }, [groups]);

  const visibleGroups = useMemo(
    () => groups.filter((g) => groupMatchesFilter(g, filter)),
    [groups, filter],
  );

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
        setError(
          json.error === "not_pending"
            ? "Someone already decided that one. Refresh to see the current queue."
            : "That didn't save. Nothing was changed.",
        );
        return;
      }
      // Approving a contested group resolves the WHOLE group (siblings rejected
      // server-side), so drop the group. Rejecting one candidate only removes
      // that row — the rest are still live.
      setGroups((gs) =>
        gs
          .map((g) => {
            if (g.key !== groupKey) return g;
            if (decision === "approve") return null;
            const rows = g.rows.filter((r) => r.id !== row.id);
            return rows.length
              ? { ...g, rows, contested: new Set(rows.map((r) => r.cwid)).size > 1 }
              : null;
          })
          .filter((g): g is HonorQueueGroup => g !== null),
      );
      // Reconcile the Approved/Rejected tabs (and the subnav pending pill) with
      // the server — the optimistic edit above only touches Pending. Mirrors
      // slug-request-queue.
      router.refresh();
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

  return (
    <div className="flex flex-col gap-6" data-slot="honors-queue">
      {/* Status tabs — Pending is the working queue; the others are history. */}
      <div className="flex gap-1 border-b" role="tablist">
        <TabButton active={tab === "pending"} onClick={() => setTab("pending")} label="Pending" count={counts.all} />
        <TabButton
          active={tab === "approved"}
          onClick={() => setTab("approved")}
          label="Approved"
          count={approved.reduce((n, g) => n + g.rows.length, 0)}
        />
        <TabButton
          active={tab === "rejected"}
          onClick={() => setTab("rejected")}
          label="Rejected"
          count={rejected.reduce((n, g) => n + g.rows.length, 0)}
        />
      </div>

      {error ? (
        <p className="rounded-sm border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
          {error}
        </p>
      ) : null}

      {tab === "pending" ? (
        <>
          {/* Person-type filter — full-time faculty first, by the curator's ask. */}
          <div className="flex flex-wrap gap-2" data-slot="honors-person-filter">
            <FilterChip active={filter === "faculty"} onClick={() => setFilter("faculty")} label="Full-time faculty" count={counts.faculty} />
            <FilterChip active={filter === "affiliated"} onClick={() => setFilter("affiliated")} label="Affiliated faculty" count={counts.affiliated} />
            <FilterChip active={filter === "other"} onClick={() => setFilter("other")} label="Trainees & other" count={counts.other} />
            <FilterChip active={filter === "all"} onClick={() => setFilter("all")} label="All" count={counts.all} />
          </div>

          {visibleGroups.length === 0 ? (
            <p className="text-muted-foreground text-sm" data-slot="honors-queue-empty">
              {groups.length === 0
                ? "Nothing pending. Every honor has been decided."
                : "None in this group. Try a wider filter."}
            </p>
          ) : (
            visibleGroups.map((group) => (
              <PendingGroup key={group.key} group={group} busy={busy} onDecide={decide} onRejectAll={rejectAll} />
            ))
          )}
        </>
      ) : (
        <DecidedList groups={tab === "approved" ? approved : rejected} kind={tab} />
      )}
    </div>
  );
}

function TabButton({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={
        active
          ? "border-apollo-maroon -mb-px border-b-2 px-3 py-2 text-sm font-semibold"
          : "text-muted-foreground hover:text-foreground -mb-px border-b-2 border-transparent px-3 py-2 text-sm"
      }
    >
      {label} <span className="text-muted-foreground">({count})</span>
    </button>
  );
}

function FilterChip({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        active
          ? "bg-apollo-maroon rounded-full px-3 py-1 text-xs font-medium text-white"
          : "text-muted-foreground hover:bg-muted rounded-full border px-3 py-1 text-xs"
      }
    >
      {label} ({count})
    </button>
  );
}

function PendingGroup({
  group,
  busy,
  onDecide,
  onRejectAll,
}: {
  group: HonorQueueGroup;
  busy: string | null;
  onDecide: (row: HonorQueueRow, decision: "approve" | "reject", groupKey: string) => void;
  onRejectAll: (group: HonorQueueGroup) => void;
}) {
  const head = group.rows[0];
  return (
    <div
      data-slot={group.contested ? "honor-group-contested" : "honor-group"}
      className={group.contested ? "rounded-md border-2 border-amber-400 bg-amber-50/40 p-4" : "rounded-md border p-4"}
    >
      <div className="mb-3">
        {group.contested ? (
          <Badge variant="secondary" className="mb-2">
            {group.rows.length} people match this one award
          </Badge>
        ) : null}
        <p className="text-sm">
          <span className="font-semibold">{head.name}</span>
          <span className="text-muted-foreground"> · {head.organization}</span>
          {head.year === null ? null : <span className="text-muted-foreground"> · {head.year}</span>}
        </p>
        {group.rosterMatchedName ? (
          <p className="text-muted-foreground mt-1 text-xs" data-slot="honor-roster-name">
            Matched against the roster listing “<span className="font-medium">{group.rosterMatchedName}</span>”
          </p>
        ) : null}
        {group.contested ? (
          <p className="text-muted-foreground mt-1 text-xs">
            The roster gives a name, not a person. At most one of these is the winner — picking one rejects the others.
          </p>
        ) : null}
      </div>

      <ul className="flex flex-col gap-3">
        {group.rows.map((row) => {
          const note = yearPlausibilityNote(row);
          return (
            <li key={row.id} className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="leading-snug">
                  <span className="font-semibold">{row.scholarName}</span>
                  {row.roleLabel ? <span className="text-muted-foreground text-sm"> · {row.roleLabel}</span> : null}
                  {row.title ? <span className="text-muted-foreground text-sm"> · {row.title}</span> : null}
                </p>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  {row.slug ? (
                    <a
                      href={`/scholars/${row.slug}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline underline-offset-2"
                    >
                      profile ↗
                    </a>
                  ) : (
                    <span className="italic">no public profile</span>
                  )}
                </p>
                {note ? (
                  <p className="mt-1 text-xs text-amber-800" data-slot="honor-year-warning">
                    ⚠ {note}
                  </p>
                ) : null}
              </div>

              <div className="flex shrink-0 gap-2">
                <Button size="sm" disabled={busy !== null} onClick={() => onDecide(row, "approve", group.key)}>
                  {group.contested ? "This is the one" : "Approve"}
                </Button>
                {group.contested ? null : (
                  <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => onDecide(row, "reject", group.key)}>
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
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => onRejectAll(group)}>
            None of these
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function DecidedList({ groups, kind }: { groups: HonorQueueGroup[]; kind: "approved" | "rejected" }) {
  const rows = groups.flatMap((g) => g.rows);
  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground text-sm" data-slot={`honors-${kind}-empty`}>
        {kind === "approved" ? "No honors approved yet." : "No honors rejected yet."}
      </p>
    );
  }
  // Most-recently decided first — this is a history log, read backwards.
  const ordered = [...rows].sort((a, b) => b.decidedAt.localeCompare(a.decidedAt));
  return (
    <ul className="flex flex-col divide-y" data-slot={`honors-${kind}-list`}>
      {ordered.map((row) => (
        <li key={row.id} className="flex items-baseline justify-between gap-4 py-2">
          <div className="min-w-0">
            <span className="font-medium">{row.scholarName}</span>
            {row.roleLabel ? <span className="text-muted-foreground text-sm"> · {row.roleLabel}</span> : null}
            <span className="text-muted-foreground text-sm"> — {honorLine(row)}</span>
          </div>
          <span className="text-muted-foreground shrink-0 text-xs">{row.decidedAt.slice(0, 10)}</span>
        </li>
      ))}
    </ul>
  );
}
