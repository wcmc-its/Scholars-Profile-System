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
 *
 * Round 4 (#1762): the person-type filter and a group-by control (none / person /
 * award) apply to ALL tabs, not just Possible. Group-by is ORTHOGONAL to the
 * contested-pair mechanic — a contested line stays one pick-one unit under every
 * group-by mode (under "person" it lands in a "multiple candidates" bucket, since
 * it spans people by construction). The sort control stays on Possible, the
 * working queue; the read-only tabs are a history log ordered newest-decision-first.
 *
 * Round 5 (#1762): Known leads the tab strip (the confirmed record is what the
 * office reaches for first, so it is also the default). Self-asserted honors
 * (`source='SELF'`) get their own "User asserted" tab and are kept OUT of Known,
 * so the curated record never blurs with what scholars claimed about themselves.
 */
import { useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { HonorQueueGroup, HonorQueueRow } from "@/lib/edit/honor-queue";
import { isFullTimeFaculty, yearPlausibilityNote } from "@/lib/edit/honor-queue";

type Props = {
  pending: HonorQueueGroup[];
  approved: HonorQueueGroup[];
  rejected: HonorQueueGroup[];
  /** Round 5: honors a scholar entered about themselves (`source='SELF'`), shown
   *  in their own read-only "User asserted" tab and kept out of Known. */
  userAsserted: HonorQueueGroup[];
};

type Tab = "pending" | "approved" | "rejected" | "self";
type PersonFilter = "faculty" | "affiliated" | "other" | "all";
type SortKey = "prestige" | "recent" | "confident";
export type GroupBy = "none" | "person" | "award";

/** Contested lines span people, so they can't sit under any one person heading —
 *  they bucket together here under group-by "person". The double-underscore
 *  sentinel can't collide with a real cwid (alphanumeric, no underscores). */
const CONTESTED_BUCKET = "__contested__";

/** All rows on one group share a roster line ⇒ one honor ⇒ one prestige/year, so
 *  the group's sort key is `rows[0]`'s. Comparators return standard <0/0/>0. */
function compareGroups(a: HonorQueueGroup, b: HonorQueueGroup, key: SortKey): number {
  const ay = a.rows[0].year;
  const by = b.rows[0].year;
  const recent = () => (ay === by ? 0 : ay === null ? 1 : by === null ? -1 : by - ay);
  const prestige = () => b.rows[0].prestige - a.rows[0].prestige;
  const confident = () => Number(a.contested) - Number(b.contested); // singles first
  if (key === "prestige") return prestige() || recent();
  if (key === "recent") return recent() || prestige();
  return confident() || prestige() || recent();
}

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

type Section = { key: string; heading: string | null; groups: HonorQueueGroup[] };

/** The bucket a group falls in for a given group-by mode. A contested group
 *  (>1 distinct cwid) never keys on a person — it goes to the shared contested
 *  bucket so the pick-one unit is never split. */
function bucketKey(group: HonorQueueGroup, mode: GroupBy): string {
  if (mode === "award") return group.rows[0].organization;
  if (mode === "person") return group.contested ? CONTESTED_BUCKET : group.rows[0].cwid;
  return ""; // "none" — one bucket, one flat list
}

function sectionHeading(mode: GroupBy, key: string, sample: HonorQueueGroup): string | null {
  if (mode === "none") return null;
  if (mode === "award") return sample.rows[0].organization;
  if (key === CONTESTED_BUCKET) return "Multiple candidates for one award";
  return sample.rows[0].scholarName; // person
}

/**
 * Bucket already-filtered groups into sections by the group-by mode. Pure and
 * unsorted — each view (Possible vs decided) applies its own ordering. Exported
 * for the grouping test. Insertion order preserves the caller's group order.
 */
export function buildSections(groups: HonorQueueGroup[], mode: GroupBy): Section[] {
  const buckets = new Map<string, HonorQueueGroup[]>();
  for (const g of groups) {
    const k = bucketKey(g, mode);
    const bucket = buckets.get(k);
    if (bucket) bucket.push(g);
    else buckets.set(k, [g]);
  }
  return [...buckets].map(([key, gs]) => ({ key, heading: sectionHeading(mode, key, gs[0]), groups: gs }));
}

function emptyMessage(tab: Tab, sourceEmpty: boolean): string {
  if (!sourceEmpty) return "None in this group. Try a wider filter.";
  if (tab === "pending") return "Nothing pending. Every honor has been decided.";
  if (tab === "approved") return "No honors approved yet.";
  if (tab === "rejected") return "No honors rejected yet.";
  return "No self-asserted honors yet.";
}

export function HonorsQueue({ pending, approved, rejected, userAsserted }: Props) {
  const router = useRouter();
  // Known first — round 5: the office lands on the confirmed record, not the queue.
  const [tab, setTab] = useState<Tab>("approved");
  // Full-time faculty first — the curator's stated priority. Widen from there.
  const [filter, setFilter] = useState<PersonFilter>("faculty");
  // Prestige first — the round-3 ask: work the biggest honors before the rest.
  const [sortKey, setSortKey] = useState<SortKey>("prestige");
  // No extra grouping by default — the flat, roster-line view of rounds 1–3.
  const [groupBy, setGroupBy] = useState<GroupBy>("none");
  const [groups, setGroups] = useState(pending);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The active tab's groups. Pending is the mutable working queue; the other
  // tabs are props reconciled by `router.refresh()` after a decision.
  const source =
    tab === "pending" ? groups : tab === "approved" ? approved : tab === "rejected" ? rejected : userAsserted;

  // Tab-label totals are per-tab and independent of the active tab — the count on
  // "Possible" must not change when the curator opens "Known".
  const tabTotals = useMemo(
    () => ({
      pending: groups.reduce((n, g) => n + g.rows.length, 0),
      approved: approved.reduce((n, g) => n + g.rows.length, 0),
      rejected: rejected.reduce((n, g) => n + g.rows.length, 0),
      self: userAsserted.reduce((n, g) => n + g.rows.length, 0),
    }),
    [groups, approved, rejected, userAsserted],
  );

  // Filter-chip counts reflect the ACTIVE tab's rows (round 4: the filter is on
  // every tab, so its counts follow the tab).
  const counts = useMemo(() => {
    const c = { faculty: 0, affiliated: 0, other: 0, all: 0 };
    for (const g of source)
      for (const r of g.rows) {
        c.all += 1;
        c[personBucket(r.roleCategory)] += 1;
      }
    return c;
  }, [source]);

  const filtered = useMemo(() => source.filter((g) => groupMatchesFilter(g, filter)), [source, filter]);
  const sections = useMemo(() => buildSections(filtered, groupBy), [filtered, groupBy]);

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
      {/* Status tabs. "Possible" = matched but unconfirmed; "Known" = confirmed and
          rendering on profiles. Labels are the curator's (round 3); the internal
          keys stay pending/approved/rejected. */}
      <div className="flex gap-1 border-b" role="tablist">
        <TabButton active={tab === "approved"} onClick={() => setTab("approved")} label="Known" count={tabTotals.approved} />
        <TabButton active={tab === "pending"} onClick={() => setTab("pending")} label="Possible" count={tabTotals.pending} />
        <TabButton active={tab === "rejected"} onClick={() => setTab("rejected")} label="Rejected" count={tabTotals.rejected} />
        <TabButton active={tab === "self"} onClick={() => setTab("self")} label="User asserted" count={tabTotals.self} />
      </div>

      {error ? (
        <p className="rounded-sm border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
          {error}
        </p>
      ) : null}

      {/* Round 4: filter + group-by ride every tab; sort stays on the working queue. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2" data-slot="honors-person-filter">
          <FilterChip active={filter === "faculty"} onClick={() => setFilter("faculty")} label="Full-time faculty" count={counts.faculty} />
          <FilterChip active={filter === "affiliated"} onClick={() => setFilter("affiliated")} label="Affiliated faculty" count={counts.affiliated} />
          <FilterChip active={filter === "other"} onClick={() => setFilter("other")} label="Trainees & other" count={counts.other} />
          <FilterChip active={filter === "all"} onClick={() => setFilter("all")} label="All" count={counts.all} />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-muted-foreground flex items-center gap-2 text-xs" data-slot="honors-group-by">
            Group
            <select
              value={groupBy}
              onChange={(e) => setGroupBy(e.target.value as GroupBy)}
              className="rounded-sm border px-2 py-1 text-xs"
            >
              <option value="none">No grouping</option>
              <option value="person">By person</option>
              <option value="award">By award</option>
            </select>
          </label>
          {tab === "pending" ? (
            <label className="text-muted-foreground flex items-center gap-2 text-xs" data-slot="honors-sort">
              Sort
              <select
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value as SortKey)}
                className="rounded-sm border px-2 py-1 text-xs"
              >
                <option value="prestige">Most prestigious</option>
                <option value="recent">Most recent</option>
                <option value="confident">Most confident match</option>
              </select>
            </label>
          ) : null}
        </div>
      </div>

      {filtered.length === 0 ? (
        <p
          className="text-muted-foreground text-sm"
          data-slot={tab === "pending" ? "honors-queue-empty" : `honors-${tab}-empty`}
        >
          {emptyMessage(tab, source.length === 0)}
        </p>
      ) : tab === "pending" ? (
        <PendingSections sections={sections} sortKey={sortKey} busy={busy} onDecide={decide} onRejectAll={rejectAll} />
      ) : (
        <DecidedSections sections={sections} kind={tab} />
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

/** A heading (only when grouped) over its rows/cards. Under group-by "none" the
 *  heading is null and this is a plain flat block. */
function SectionShell({ heading, count, children }: { heading: string | null; count: number; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4" data-slot={heading ? "honor-section" : "honor-section-flat"}>
      {heading ? (
        <h3 className="text-foreground/80 border-b pb-1 text-sm font-semibold" data-slot="honor-section-heading">
          {heading} <span className="text-muted-foreground font-normal">({count})</span>
        </h3>
      ) : null}
      {children}
    </section>
  );
}

/** Possible tab: each section's groups sorted by the active sort key, sections
 *  ordered by their top group. Renders the interactive contested-aware cards. */
function PendingSections({
  sections,
  sortKey,
  busy,
  onDecide,
  onRejectAll,
}: {
  sections: Section[];
  sortKey: SortKey;
  busy: string | null;
  onDecide: (row: HonorQueueRow, decision: "approve" | "reject", groupKey: string) => void;
  onRejectAll: (group: HonorQueueGroup) => void;
}) {
  const ordered = sections
    .map((s) => ({ ...s, groups: [...s.groups].sort((a, b) => compareGroups(a, b, sortKey)) }))
    .sort((a, b) => compareGroups(a.groups[0], b.groups[0], sortKey));
  return (
    <div className="flex flex-col gap-6">
      {ordered.map((section) => (
        <SectionShell key={section.key} heading={section.heading} count={section.groups.reduce((n, g) => n + g.rows.length, 0)}>
          {section.groups.map((group) => (
            <PendingGroup key={group.key} group={group} busy={busy} onDecide={onDecide} onRejectAll={onRejectAll} />
          ))}
        </SectionShell>
      ))}
    </div>
  );
}

/** Known/Rejected tabs: read-only history. Rows within a section, and the
 *  sections themselves, are ordered newest-decision-first. */
function DecidedSections({ sections, kind }: { sections: Section[]; kind: "approved" | "rejected" | "self" }) {
  const ordered = sections
    .map((s) => ({
      key: s.key,
      heading: s.heading,
      rows: s.groups.flatMap((g) => g.rows).sort((a, b) => b.decidedAt.localeCompare(a.decidedAt)),
    }))
    .sort((a, b) => b.rows[0].decidedAt.localeCompare(a.rows[0].decidedAt));
  return (
    <div className="flex flex-col gap-6">
      {ordered.map((section) => (
        <SectionShell key={section.key} heading={section.heading} count={section.rows.length}>
          <ul className="flex flex-col divide-y" data-slot={`honors-${kind}-list`}>
            {section.rows.map((row) => (
              <DecidedRow key={row.id} row={row} />
            ))}
          </ul>
        </SectionShell>
      ))}
    </div>
  );
}

function DecidedRow({ row }: { row: HonorQueueRow }) {
  return (
    <li className="flex items-baseline justify-between gap-4 py-2">
      <div className="min-w-0">
        <span className="font-medium">{row.scholarName}</span>
        {row.roleLabel ? <span className="text-muted-foreground text-sm"> · {row.roleLabel}</span> : null}
        <span className="text-muted-foreground text-sm"> — {honorLine(row)}</span>
      </div>
      <span className="text-muted-foreground shrink-0 text-xs">{row.decidedAt.slice(0, 10)}</span>
    </li>
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
