"use client";

/**
 * Issue #1762 — the honors approval queue.
 *
 * Two shapes of decision, and conflating them is the whole risk:
 *
 *  - An ORDINARY row is one assertion: approve or reject.
 *  - A CONTESTED group is several scholars matched to ONE roster line by name.
 *    At most one of them won it. So the card makes the curator PICK one
 *    candidate (a radio) before its single Approve enables — approving it
 *    rejects the rest server-side, in one transaction — plus a "None of these"
 *    that rejects them all. There is deliberately NO per-candidate approve: two
 *    approvals would credit two people with one award, and misses are cheap
 *    where mismatches are not.
 *
 * The curator verifies a MATCH, so every card shows both sides of it: the name
 * the source roster printed ("Listed as …") and the scholar's published name
 * (exactly as the profile will render it once approved). Known / Rejected /
 * User asserted are read-only history — the "we should see accepted honors
 * somewhere" ask.
 *
 * 2026-09 redesign (`Honors Approval.dc.html`): Possible leads the tab strip and
 * is the default (it is the only tab with work in it); tab counts are pills,
 * with Possible's amber while anything is waiting; a one-line note under the
 * tabs says what the open tab holds. Possible renders one white card per roster
 * line with the candidates in a bordered list; a decided card stays in place
 * with its outcome pill rather than jumping out from under the cursor. The
 * read-only tabs are a table grouped by scholar (default), by award, or not at
 * all, with a search box.
 *
 * Decisions are undoable: a dark toast names the last decision with an Undo, and
 * every decided card keeps an Undo link. Undo POSTs `decision: "undo"` per row
 * the decision wrote (the approved row, or each rejected candidate); the server
 * restores the siblings an approval auto-rejected. A reject may carry a reason
 * from the select beside the button (optional, so one click still rejects).
 * Sources lists the honor rosters the queue's rows came from and the recorded
 * load runs — read-only, with no Run now (nothing in the console can start one).
 *
 * Kept from the shipped queue although the mockup omits them on Possible: the
 * person-type filter (and its "All" chip, on every tab), the Possible sort, and
 * the Possible group-by. Group-by is ORTHOGONAL to the contested-pair mechanic —
 * a contested line stays one pick-one unit under every mode.
 */
import { useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import type {
  HonorQueueGroup,
  HonorQueueRow,
  HonorSourceRun,
  HonorSourcesSummary,
} from "@/lib/edit/honor-queue";
import { isFullTimeFaculty, REJECTION_REASONS, yearPlausibilityNote } from "@/lib/edit/honor-queue";
import { cn } from "@/lib/utils";

type Props = {
  pending: HonorQueueGroup[];
  approved: HonorQueueGroup[];
  rejected: HonorQueueGroup[];
  /** Round 5: honors a scholar entered about themselves (`source='SELF'`), shown
   *  in their own read-only "User asserted" tab and kept out of Known. */
  userAsserted: HonorQueueGroup[];
  /** The Sources tab: honor rosters and recorded load runs. */
  sources: HonorSourcesSummary;
};

type Tab = "pending" | "approved" | "rejected" | "self" | "sources";
type PersonFilter = "faculty" | "affiliated" | "other" | "all";
type SortKey = "prestige" | "recent" | "confident";
/** Possible's group-by (the shipped control). */
export type GroupBy = "none" | "person" | "award";
/** The read-only tabs' group-by (the redesign's segmented control). */
export type ListGroupBy = "scholar" | "award" | "none";

/** A card's outcome this session. The card stays put, showing it. `rowIds` are
 *  the rows the decision wrote directly — what an undo reverts. */
type Decided =
  | { kind: "approved"; scholarName: string; rowIds: string[] }
  | { kind: "rejected"; rowIds: string[] };

/** Contested lines span people, so they can't sit under any one person heading —
 *  they bucket together here under group-by "person". The double-underscore
 *  sentinel can't collide with a real cwid (alphanumeric, no underscores). */
const CONTESTED_BUCKET = "__contested__";

/** Sources has no honor groups; a stable empty array keeps the memos below steady. */
const NO_GROUPS: HonorQueueGroup[] = [];

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
  // #2211 — `emeritus` used to arrive spelled `affiliated_faculty`; keep it in
  // the same curator filter so splitting the ED bucket doesn't drop emeritus
  // honor candidates out of the "Affiliated" view into "Other".
  if (roleCategory === "affiliated_faculty" || roleCategory === "emeritus") return "affiliated";
  return "other";
}

/** A group passes a person filter when ANY of its candidates matches — a
 *  contested line whose candidates span types must stay visible under the
 *  narrower filter, or the curator can't pick the one who qualifies. */
function groupMatchesFilter(group: HonorQueueGroup, filter: PersonFilter): boolean {
  if (filter === "all") return true;
  return group.rows.some((r) => personBucket(r.roleCategory) === filter);
}

function rowMatchesQuery(row: HonorQueueRow, q: string): boolean {
  if (!q) return true;
  return `${row.scholarName} ${row.name} ${row.organization}`.toLowerCase().includes(q);
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
 * unsorted — Possible applies its own ordering. Exported for the grouping test.
 * Insertion order preserves the caller's group order.
 */
export function buildSections(groups: HonorQueueGroup[], mode: GroupBy): Section[] {
  const buckets = new Map<string, HonorQueueGroup[]>();
  for (const g of groups) {
    const k = bucketKey(g, mode);
    const bucket = buckets.get(k);
    if (bucket) bucket.push(g);
    else buckets.set(k, [g]);
  }
  return [...buckets].map(([key, gs]) => ({
    key,
    heading: sectionHeading(mode, key, gs[0]),
    groups: gs,
  }));
}

/** The surname a scholar sorts under: the last word of the published name, with
 *  any postnominal ("…, MD") dropped first. */
function surnameKey(scholarName: string): string {
  const bare = scholarName.split(",")[0].trim();
  const words = bare.split(/\s+/);
  return (words[words.length - 1] ?? bare).toLowerCase();
}

export type ListSection = {
  key: string;
  label: string | null;
  sub: string | null;
  rows: HonorQueueRow[];
};

/**
 * The read-only tabs' sections (Known / Rejected / User asserted). Exported for
 * the grouping test.
 *  - scholar: one section per scholar (cwid), sections A–Z by surname, rows
 *    newest-decision first.
 *  - award: one section per honor + conferring body, biggest section first,
 *    rows A–Z by surname.
 *  - none: one flat, unheaded section, newest-decision first.
 */
export function buildListSections(rows: HonorQueueRow[], mode: ListGroupBy): ListSection[] {
  const newestFirst = (a: HonorQueueRow, b: HonorQueueRow) =>
    b.decidedAt.localeCompare(a.decidedAt);
  if (mode === "none") {
    return rows.length
      ? [{ key: "", label: null, sub: null, rows: [...rows].sort(newestFirst) }]
      : [];
  }
  const buckets = new Map<string, HonorQueueRow[]>();
  for (const r of rows) {
    const k = mode === "scholar" ? r.cwid : `${r.name}\u0000${r.organization}`;
    const bucket = buckets.get(k);
    if (bucket) bucket.push(r);
    else buckets.set(k, [r]);
  }
  const sections = [...buckets].map(([key, rs]) => ({ key, rows: rs }));
  if (mode === "scholar") {
    return sections
      .sort(
        (a, b) =>
          surnameKey(a.rows[0].scholarName).localeCompare(surnameKey(b.rows[0].scholarName)) ||
          a.rows[0].scholarName.localeCompare(b.rows[0].scholarName),
      )
      .map(({ key, rows: rs }) => ({
        key,
        label: rs[0].scholarName,
        sub: `${rs.length} honor${rs.length === 1 ? "" : "s"}`,
        rows: [...rs].sort(newestFirst),
      }));
  }
  return sections
    .sort((a, b) => b.rows.length - a.rows.length || a.rows[0].name.localeCompare(b.rows[0].name))
    .map(({ key, rows: rs }) => ({
      key,
      label: rs[0].name,
      sub: `${rs[0].organization} · ${rs.length} scholar${rs.length === 1 ? "" : "s"}`,
      rows: [...rs].sort((a, b) =>
        surnameKey(a.scholarName).localeCompare(surnameKey(b.scholarName)),
      ),
    }));
}

/** The roster URL behind a seeded row, when its `sourceRef` carries one
 *  (`<roster>|<printed-name>|<year>`, see `rosterMatchedName`). Only an http(s)
 *  roster segment becomes a link; an opaque roster id renders nothing. */
export function rosterSourceUrl(sourceRef: string | null): string | null {
  if (!sourceRef) return null;
  const roster = sourceRef.split("|")[0].trim();
  return /^https?:\/\//i.test(roster) ? roster : null;
}

/** "Sep 15, 2026" — the decision date on the read-only tabs. UTC so a
 *  late-evening decision does not render as the next/previous day. */
function formatDecided(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Two-letter initials for the candidate avatar: first and last word. */
function initials(scholarName: string): string {
  const words = scholarName.split(",")[0].trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  const first = words[0][0] ?? "";
  const last = words.length > 1 ? (words[words.length - 1][0] ?? "") : "";
  return (first + last).toUpperCase();
}

/** "Approve for Ada Lovelace" — first + last word of the published name. */
function shortName(scholarName: string): string {
  const words = scholarName.split(",")[0].trim().split(/\s+/).filter(Boolean);
  return words.length > 1 ? `${words[0]} ${words[words.length - 1]}` : (words[0] ?? scholarName);
}

function emptyMessage(tab: Tab, sourceEmpty: boolean): string {
  if (!sourceEmpty) return "No honors match. Try a wider filter.";
  if (tab === "pending") return "Nothing pending. Every honor has been decided.";
  if (tab === "approved") return "No honors approved yet.";
  if (tab === "rejected") return "No honors rejected yet.";
  if (tab === "sources") return "No honor lists loaded yet.";
  return "No self-asserted honors yet.";
}

const TAB_LABEL: Record<Tab, string> = {
  pending: "Possible",
  approved: "Known",
  rejected: "Rejected",
  self: "User asserted",
  sources: "Sources",
};

export function HonorsQueue({ pending, approved, rejected, userAsserted, sources }: Props) {
  const router = useRouter();
  // Possible first — the redesign: land on the working queue.
  const [tab, setTab] = useState<Tab>("pending");
  // Full-time faculty first — the curator's stated priority. Widen from there.
  const [filter, setFilter] = useState<PersonFilter>("faculty");
  // Prestige first — the round-3 ask: work the biggest honors before the rest.
  const [sortKey, setSortKey] = useState<SortKey>("prestige");
  // Possible: no extra grouping by default — the flat, roster-line view.
  const [groupBy, setGroupBy] = useState<GroupBy>("none");
  // Read-only tabs: grouped by scholar by default (the redesign).
  const [listGroupBy, setListGroupBy] = useState<ListGroupBy>("scholar");
  const [query, setQuery] = useState("");
  const [groups, setGroups] = useState(pending);
  /** Contested line key → the candidate row id the curator picked. */
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [decided, setDecided] = useState<Record<string, Decided>>({});
  /** Line key → the rejection reason picked beside its Reject (optional). */
  const [reasons, setReasons] = useState<Record<string, string>>({});
  /** The last decision, offered for undo in the toast. */
  const [toast, setToast] = useState<{ groupKey: string; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const q = query.trim().toLowerCase();

  // The active tab's groups. Pending is the mutable working queue; the other
  // tabs are props reconciled by `router.refresh()` after a decision.
  const source =
    tab === "pending"
      ? groups
      : tab === "approved"
        ? approved
        : tab === "rejected"
          ? rejected
          : tab === "self"
            ? userAsserted
            : NO_GROUPS;

  const undecided = useMemo(() => groups.filter((g) => !decided[g.key]), [groups, decided]);

  // Tab-label totals are per-tab and independent of the active tab — the count on
  // "Possible" must not change when the curator opens "Known".
  const tabTotals = useMemo(
    () => ({
      pending: undecided.reduce((n, g) => n + g.rows.length, 0),
      approved: approved.reduce((n, g) => n + g.rows.length, 0),
      rejected: rejected.reduce((n, g) => n + g.rows.length, 0),
      self: userAsserted.reduce((n, g) => n + g.rows.length, 0),
      sources: sources.sources.length,
    }),
    [undecided, approved, rejected, userAsserted, sources],
  );
  const contestedOpen = undecided.filter((g) => g.contested).length;

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

  const filtered = useMemo(
    () =>
      source.filter(
        (g) => groupMatchesFilter(g, filter) && g.rows.some((r) => rowMatchesQuery(r, q)),
      ),
    [source, filter, q],
  );
  const sections = useMemo(() => buildSections(filtered, groupBy), [filtered, groupBy]);

  // Read-only tabs filter per ROW (no contested units there).
  const filterTotal = counts[filter];
  const listRows = useMemo(
    () =>
      source
        .flatMap((g) => g.rows)
        .filter(
          (r) =>
            (filter === "all" || personBucket(r.roleCategory) === filter) && rowMatchesQuery(r, q),
        ),
    [source, filter, q],
  );
  const listSections = useMemo(
    () => buildListSections(listRows, listGroupBy),
    [listRows, listGroupBy],
  );

  const tabNote =
    tab === "pending"
      ? tabTotals.pending === 0
        ? "Nothing awaiting a decision."
        : `${tabTotals.pending} honor${tabTotals.pending === 1 ? "" : "s"} awaiting a decision${
            contestedOpen > 0
              ? `, including ${contestedOpen} where more than one person matches the same award`
              : ""
          }.`
      : tab === "approved"
        ? "Approved honors. These show on profiles."
        : tab === "rejected"
          ? "Matches that were ruled out. They won’t be suggested again."
          : tab === "sources"
            ? "Honor lists the matches come from, and when a list was last loaded."
            : "Honors scholars added to their own profiles. Shown as self-reported.";

  function switchTab(next: Tab) {
    setTab(next);
    setQuery("");
  }

  /** POST one decision. Returns whether it saved; sets the error line if not. */
  async function post(
    rowId: string,
    decision: "approve" | "reject" | "undo",
    reason?: string,
  ): Promise<boolean> {
    try {
      const res = await fetch("/api/edit/honor/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reason ? { id: rowId, decision, reason } : { id: rowId, decision }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setError(
          json.error === "not_pending"
            ? "Someone already decided that one. Refresh to see the current queue."
            : json.error === "not_undoable" || json.error === "superseded"
              ? "That decision can't be undone any more. Refresh to see the current queue."
              : "That didn't save. Nothing was changed.",
        );
        return false;
      }
      return true;
    } catch {
      setError("That didn't save. Nothing was changed.");
      return false;
    }
  }

  async function approve(group: HonorQueueGroup) {
    const row = group.contested ? group.rows.find((r) => r.id === picks[group.key]) : group.rows[0];
    if (!row) return; // a contested line with no pick — the button is disabled
    setBusy(group.key);
    setError(null);
    // Approving resolves the WHOLE line (siblings rejected server-side).
    if (await post(row.id, "approve")) {
      setDecided((d) => ({
        ...d,
        [group.key]: { kind: "approved", scholarName: row.scholarName, rowIds: [row.id] },
      }));
      setToast({
        groupKey: group.key,
        text: `Approved ${row.name}, ${row.organization} for ${shortName(row.scholarName)}.`,
      });
      // Reconcile Known/Rejected (and the subnav pending pill) with the server.
      router.refresh();
    }
    setBusy(null);
  }

  async function rejectAll(group: HonorQueueGroup) {
    setBusy(group.key);
    setError(null);
    const done: string[] = [];
    const reason = reasons[group.key] || undefined;
    for (const row of group.rows) {
      // Sequential on purpose: each is its own transaction + audit row, and a
      // parallel burst would race the pending re-check for no benefit at this size.
      if (!(await post(row.id, "reject", reason))) break;
      done.push(row.id);
    }
    if (done.length === group.rows.length) {
      setDecided((d) => ({ ...d, [group.key]: { kind: "rejected", rowIds: done } }));
      const head = group.rows[0];
      setToast({ groupKey: group.key, text: `Rejected ${head.name}, ${head.organization}.` });
    } else if (done.length > 0) {
      // A partial "None of these": drop the candidates that did reject; the rest
      // are still live.
      setGroups((gs) =>
        gs.map((g) => {
          if (g.key !== group.key) return g;
          const rows = g.rows.filter((r) => !done.includes(r.id));
          return { ...g, rows, contested: new Set(rows.map((r) => r.cwid)).size > 1 };
        }),
      );
    }
    if (done.length > 0) router.refresh();
    setBusy(null);
  }

  /** Revert a decision made on this page. The server restores any siblings an
   *  approval auto-rejected, so one undo per written row brings the line back. */
  async function undo(groupKey: string) {
    const d = decided[groupKey];
    if (!d) return;
    setBusy(groupKey);
    setError(null);
    let all = true;
    for (const id of d.rowIds) {
      if (!(await post(id, "undo"))) {
        all = false;
        break;
      }
    }
    if (all) {
      setDecided((cur) => {
        const next = { ...cur };
        delete next[groupKey];
        return next;
      });
      setToast((t) => (t?.groupKey === groupKey ? null : t));
    }
    router.refresh();
    setBusy(null);
  }

  const isList = tab !== "pending" && tab !== "sources";

  return (
    <div className="flex flex-col gap-[22px]" data-slot="honors-queue">
      <div className="flex flex-col gap-3">
        {/* Status tabs. "Possible" = matched but unconfirmed; "Known" = confirmed
            and rendering on profiles. The internal keys stay pending/approved/…. */}
        <div
          className="border-apollo-border-strong flex flex-wrap items-end gap-x-7 border-b"
          role="tablist"
        >
          {(["pending", "approved", "rejected", "self", "sources"] as const).map((t) => (
            <TabButton
              key={t}
              active={tab === t}
              onClick={() => switchTab(t)}
              label={TAB_LABEL[t]}
              count={tabTotals[t]}
              actionable={t === "pending"}
            />
          ))}
        </div>
        <p className="text-muted-foreground text-[13.5px]" data-slot="honors-tab-note">
          {tabNote}
        </p>
      </div>

      {error ? (
        <p
          className="border-apollo-red-tint-border bg-apollo-red-tint text-destructive rounded-md border px-3 py-2 text-sm"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {tab === "sources" ? null : (
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex flex-wrap gap-1.5" data-slot="honors-person-filter">
            <FilterChip
              active={filter === "faculty"}
              onClick={() => setFilter("faculty")}
              label="Full-time faculty"
              count={counts.faculty}
            />
            <FilterChip
              active={filter === "affiliated"}
              onClick={() => setFilter("affiliated")}
              label="Affiliated faculty"
              count={counts.affiliated}
            />
            <FilterChip
              active={filter === "other"}
              onClick={() => setFilter("other")}
              label="Trainees & other"
              count={counts.other}
            />
            <FilterChip
              active={filter === "all"}
              onClick={() => setFilter("all")}
              label="All"
              count={counts.all}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2.5 sm:ml-auto">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Scholar, honor or org…"
              aria-label="Search honors"
              className="border-apollo-border-strong bg-apollo-surface h-[34px] w-full rounded-lg border px-2.5 text-[13.5px] outline-none sm:w-[200px]"
              data-slot="honors-search"
            />
            {isList ? (
              <div className="flex items-center gap-2.5" data-slot="honors-list-group-by">
                <span className="text-muted-foreground text-[13px]">Group</span>
                <Segmented
                  label="Group"
                  value={listGroupBy}
                  onChange={setListGroupBy}
                  options={[
                    ["scholar", "Scholar"],
                    ["award", "Award"],
                    ["none", "None"],
                  ]}
                />
              </div>
            ) : (
              <>
                <label
                  className="text-muted-foreground flex items-center gap-2 text-[13px]"
                  data-slot="honors-group-by"
                >
                  Group
                  <select
                    value={groupBy}
                    onChange={(e) => setGroupBy(e.target.value as GroupBy)}
                    className="border-apollo-border-strong bg-apollo-surface text-foreground h-[34px] rounded-lg border px-2 text-[13px]"
                  >
                    <option value="none">No grouping</option>
                    <option value="person">By person</option>
                    <option value="award">By award</option>
                  </select>
                </label>
                <label
                  className="text-muted-foreground flex items-center gap-2 text-[13px]"
                  data-slot="honors-sort"
                >
                  Sort
                  <select
                    value={sortKey}
                    onChange={(e) => setSortKey(e.target.value as SortKey)}
                    className="border-apollo-border-strong bg-apollo-surface text-foreground h-[34px] rounded-lg border px-2 text-[13px]"
                  >
                    <option value="prestige">Most prestigious</option>
                    <option value="recent">Most recent</option>
                    <option value="confident">Most confident match</option>
                  </select>
                </label>
              </>
            )}
          </div>
        </div>
      )}

      {tab === "pending" && toast ? (
        <div
          className="bg-apollo-bar flex items-center gap-3 rounded-[10px] px-3.5 py-2.5 text-[13.5px] text-white"
          role="status"
          data-slot="honors-toast"
        >
          <span className="flex-1">{toast.text}</span>
          <button
            type="button"
            onClick={() => undo(toast.groupKey)}
            disabled={busy !== null}
            className="rounded-md border border-white/35 px-2.5 py-[3px] text-[13px]"
          >
            Undo
          </button>
        </div>
      ) : null}

      {tab === "sources" ? (
        <SourcesPanel summary={sources} empty={emptyMessage("sources", true)} />
      ) : tab === "pending" ? (
        filtered.length === 0 ? (
          <EmptyCard slot="honors-queue-empty">{emptyMessage(tab, source.length === 0)}</EmptyCard>
        ) : (
          <PendingSections
            sections={sections}
            sortKey={sortKey}
            busy={busy}
            picks={picks}
            decided={decided}
            reasons={reasons}
            onPick={(groupKey, rowId) => setPicks((p) => ({ ...p, [groupKey]: rowId }))}
            onReason={(groupKey, reason) => setReasons((r) => ({ ...r, [groupKey]: reason }))}
            onApprove={approve}
            onRejectAll={rejectAll}
            onUndo={undo}
          />
        )
      ) : (
        <DecidedTable
          kind={tab}
          sections={listSections}
          mode={listGroupBy}
          shown={listRows.length}
          total={filterTotal}
          empty={emptyMessage(tab, source.length === 0)}
        />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  count,
  actionable,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  /** Possible: the pill turns amber while anything is waiting. */
  actionable: boolean;
}) {
  const waiting = actionable && count > 0;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "-mb-px flex items-center gap-2 border-b-2 px-0.5 pt-2.5 pb-3 text-[15px] whitespace-nowrap",
        active
          ? "border-apollo-maroon text-foreground font-medium"
          : "text-muted-foreground hover:text-foreground border-transparent",
      )}
    >
      {label}
      <span
        className={cn(
          "rounded-full px-[7px] py-px text-xs tabular-nums",
          waiting
            ? "bg-apollo-amber-tint text-apollo-amber font-semibold"
            : active
              ? "bg-apollo-rail text-foreground"
              : "bg-apollo-surface-2 text-foreground",
        )}
        data-slot="honors-tab-count"
      >
        {count}
      </span>
    </button>
  );
}

function FilterChip({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-full border px-3 py-[5px] text-[13px] whitespace-nowrap",
        active
          ? "border-apollo-slate bg-apollo-slate-tint text-apollo-slate"
          : "border-apollo-border-strong bg-apollo-surface text-foreground hover:bg-apollo-surface-2",
      )}
    >
      {label} <span className="text-muted-foreground tabular-nums">{count}</span>
    </button>
  );
}

function Segmented<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: ReadonlyArray<readonly [T, string]>;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="bg-apollo-surface-2 border-apollo-border flex gap-0.5 rounded-lg border p-[3px]"
    >
      {options.map(([k, text]) => {
        const on = value === k;
        return (
          <button
            key={k}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(k)}
            className={cn(
              "rounded-md px-[11px] py-1 text-[13px] whitespace-nowrap",
              on
                ? "bg-apollo-surface text-foreground shadow-[var(--apollo-shadow-card)]"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {text}
          </button>
        );
      })}
    </div>
  );
}

function EmptyCard({ slot, children }: { slot: string; children: ReactNode }) {
  return (
    <div
      className="bg-apollo-surface border-apollo-border-strong text-muted-foreground rounded-[var(--apollo-radius-card)] border p-8 text-center text-sm"
      data-slot={slot}
    >
      {children}
    </div>
  );
}

/** Possible tab: each section's groups sorted by the active sort key, sections
 *  ordered by their top group. Renders the interactive contested-aware cards. */
function PendingSections({
  sections,
  sortKey,
  busy,
  picks,
  decided,
  reasons,
  onPick,
  onReason,
  onApprove,
  onRejectAll,
  onUndo,
}: {
  sections: Section[];
  sortKey: SortKey;
  busy: string | null;
  picks: Record<string, string>;
  decided: Record<string, Decided>;
  reasons: Record<string, string>;
  onPick: (groupKey: string, rowId: string) => void;
  onReason: (groupKey: string, reason: string) => void;
  onApprove: (group: HonorQueueGroup) => void;
  onRejectAll: (group: HonorQueueGroup) => void;
  onUndo: (groupKey: string) => void;
}) {
  const ordered = sections
    .map((s) => ({ ...s, groups: [...s.groups].sort((a, b) => compareGroups(a, b, sortKey)) }))
    .sort((a, b) => compareGroups(a.groups[0], b.groups[0], sortKey));
  return (
    <div className="flex flex-col gap-6">
      {ordered.map((section) => (
        <section
          key={section.key}
          className="flex flex-col gap-3"
          data-slot={section.heading ? "honor-section" : "honor-section-flat"}
        >
          {section.heading ? (
            <h3
              className="flex items-baseline gap-2.5 text-[14.5px] font-semibold"
              data-slot="honor-section-heading"
            >
              {section.heading}
              <span className="text-muted-foreground text-[12.5px] font-normal">
                {section.groups.length} honor{section.groups.length === 1 ? "" : "s"}
              </span>
            </h3>
          ) : null}
          {section.groups.map((group) => (
            <PendingGroup
              key={group.key}
              group={group}
              busy={busy}
              pick={picks[group.key] ?? null}
              decided={decided[group.key] ?? null}
              reason={reasons[group.key] ?? ""}
              onPick={onPick}
              onReason={onReason}
              onApprove={onApprove}
              onRejectAll={onRejectAll}
              onUndo={onUndo}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

function PendingGroup({
  group,
  busy,
  pick,
  decided,
  reason,
  onPick,
  onReason,
  onApprove,
  onRejectAll,
  onUndo,
}: {
  group: HonorQueueGroup;
  busy: string | null;
  pick: string | null;
  decided: Decided | null;
  reason: string;
  onPick: (groupKey: string, rowId: string) => void;
  onReason: (groupKey: string, reason: string) => void;
  onApprove: (group: HonorQueueGroup) => void;
  onRejectAll: (group: HonorQueueGroup) => void;
  onUndo: (groupKey: string) => void;
}) {
  const head = group.rows[0];
  const choosing = group.contested && !decided;
  const chosen = group.contested ? (group.rows.find((r) => r.id === pick) ?? null) : head;
  const blocked = chosen === null;
  const sourceUrl = rosterSourceUrl(head.sourceRef);
  return (
    <article
      data-slot={group.contested ? "honor-group-contested" : "honor-group"}
      className="bg-apollo-surface border-apollo-border-strong flex flex-col gap-3 rounded-[var(--apollo-radius-card)] border px-4 py-4 sm:px-5"
    >
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-muted-foreground text-[12.5px]">
            <span className="text-foreground font-semibold">{head.organization}</span>
            {head.year === null ? null : ` · ${head.year}`}
          </span>
          <span className="text-[16.5px] leading-snug font-semibold">{head.name}</span>
          {group.rosterMatchedName || sourceUrl ? (
            <span className="text-muted-foreground text-[13px]" data-slot="honor-roster-name">
              {group.rosterMatchedName ? <>Listed as “{group.rosterMatchedName}”</> : null}
              {group.rosterMatchedName && sourceUrl ? " · " : null}
              {sourceUrl ? (
                <a
                  href={sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-apollo-slate hover:underline"
                >
                  source list ↗
                </a>
              ) : null}
            </span>
          ) : null}
        </div>
        {decided ? (
          <span
            className={cn(
              "rounded-full px-2.5 py-[3px] text-[12.5px] whitespace-nowrap",
              decided.kind === "approved"
                ? "bg-apollo-slate-tint text-apollo-slate"
                : "bg-apollo-red-tint text-destructive",
            )}
            data-slot="honor-decided"
          >
            {decided.kind === "approved" ? `Approved for ${decided.scholarName}` : "Rejected"}
          </span>
        ) : null}
      </div>

      {choosing ? (
        <span
          className="text-apollo-amber text-[12.5px] font-semibold"
          data-slot="honor-contested-label"
        >
          {group.rows.length} scholars match this name. Pick the right one. Approving one rejects
          the others.
        </span>
      ) : null}

      <div
        className="border-apollo-border flex flex-col overflow-hidden rounded-[10px] border"
        role={choosing ? "radiogroup" : undefined}
        aria-label={choosing ? `Who won ${head.name}, ${head.organization}?` : undefined}
      >
        {group.rows.map((row, i) => (
          <CandidateRow
            key={row.id}
            row={row}
            first={i === 0}
            groupKey={group.key}
            choosing={choosing}
            picked={pick === row.id}
            disabled={busy !== null}
            onPick={onPick}
          />
        ))}
      </div>

      {decided ? (
        <button
          type="button"
          onClick={() => onUndo(group.key)}
          disabled={busy !== null}
          className="text-muted-foreground hover:text-foreground self-start text-[12.5px]"
          data-slot="honor-undo"
        >
          Undo
        </button>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={busy !== null || blocked}
            title={blocked ? "Pick which scholar first" : undefined}
            onClick={() => onApprove(group)}
            className={cn(
              "text-[13px] text-white",
              blocked ? "bg-apollo-border-strong" : "bg-apollo-slate hover:bg-apollo-slate/90",
            )}
          >
            {blocked ? "Pick a scholar to approve" : `Approve for ${shortName(chosen.scholarName)}`}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => onRejectAll(group)}
            className="text-destructive hover:bg-apollo-red-tint hover:text-destructive text-[13px] font-normal"
          >
            {group.contested ? "None of these" : "Reject"}
          </Button>
          <select
            value={reason}
            onChange={(e) => onReason(group.key, e.target.value)}
            disabled={busy !== null}
            aria-label="Rejection reason (optional)"
            className="border-apollo-border bg-apollo-surface text-muted-foreground h-8 rounded-md border px-2 text-[12.5px]"
            data-slot="honor-reject-reason"
          >
            <option value="">Reason (optional)</option>
            {REJECTION_REASONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
      )}
    </article>
  );
}

function CandidateRow({
  row,
  first,
  groupKey,
  choosing,
  picked,
  disabled,
  onPick,
}: {
  row: HonorQueueRow;
  first: boolean;
  groupKey: string;
  choosing: boolean;
  picked: boolean;
  disabled: boolean;
  onPick: (groupKey: string, rowId: string) => void;
}) {
  const note = yearPlausibilityNote(row);
  const role = [row.title, row.department].filter(Boolean).join(" · ") || row.roleLabel;
  const body = (
    <>
      {choosing ? (
        <input
          type="radio"
          name={`honor-pick-${groupKey}`}
          checked={picked}
          disabled={disabled}
          onChange={() => onPick(groupKey, row.id)}
          className="m-0 accent-[var(--color-primary-cornell-red)]"
          aria-label={row.scholarName}
        />
      ) : null}
      <div className="flex min-w-0 items-center gap-2.5">
        <div
          aria-hidden
          className="bg-apollo-surface-2 text-apollo-bar ring-apollo-border-strong flex size-8 flex-none items-center justify-center rounded-full text-[11.5px] font-semibold ring-1"
        >
          {initials(row.scholarName)}
        </div>
        <div className="flex min-w-0 flex-col gap-px">
          <span className="text-sm font-semibold">
            {row.scholarName}{" "}
            <span className="text-muted-foreground font-mono text-xs font-normal">{row.cwid}</span>
          </span>
          {role ? (
            <span className="text-muted-foreground truncate text-[12.5px]">{role}</span>
          ) : null}
          {note ? (
            <span className="text-apollo-amber text-xs" data-slot="honor-year-warning">
              ⚠ {note}
            </span>
          ) : null}
        </div>
      </div>
      <span
        className={cn(
          "text-muted-foreground text-xs sm:text-right",
          choosing && "col-start-2 sm:col-start-auto",
        )}
      >
        {row.roleLabel && role !== row.roleLabel ? `${row.roleLabel} · ` : null}
        {row.slug ? (
          <a
            href={`/scholars/${row.slug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-apollo-slate hover:underline"
          >
            profile ↗
          </a>
        ) : (
          <span className="italic">no public profile</span>
        )}
      </span>
    </>
  );
  const className = cn(
    "grid items-center gap-x-3 gap-y-1 px-3.5 py-2.5",
    choosing
      ? "grid-cols-[18px_minmax(0,1fr)] sm:grid-cols-[18px_minmax(0,1fr)_auto]"
      : "grid-cols-[minmax(0,1fr)] sm:grid-cols-[minmax(0,1fr)_auto]",
    !first && "border-apollo-border border-t",
    choosing && picked ? "bg-apollo-slate-tint" : "bg-apollo-surface",
  );
  return choosing ? (
    <label className={cn(className, "cursor-pointer")} data-slot="honor-candidate">
      {body}
    </label>
  ) : (
    <div className={className} data-slot="honor-candidate">
      {body}
    </div>
  );
}

/** Known / Rejected / User asserted: a read-only table, grouped per the segmented
 *  control. Columns follow the grouping: the section label carries the scholar
 *  (or the award), so the row doesn't repeat it. */
function DecidedTable({
  kind,
  sections,
  mode,
  shown,
  total,
  empty,
}: {
  kind: "approved" | "rejected" | "self";
  sections: ListSection[];
  mode: ListGroupBy;
  shown: number;
  total: number;
  empty: string;
}) {
  // Rejected: the mockup's Reason column, with the date and curator under it.
  const dateHead = kind === "rejected" ? "Reason" : "Added";
  const heads: string[] =
    mode === "scholar"
      ? ["Honor", "Organization", "Year", dateHead]
      : mode === "award"
        ? ["Scholar", "Scholar type", "Year", dateHead]
        : ["Scholar", "Honor", "Organization", "Year", dateHead];
  const cols =
    mode === "none"
      ? "sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1.2fr)_minmax(0,1.6fr)_56px_150px]"
      : mode === "scholar"
        ? "sm:grid-cols-[minmax(0,1.4fr)_minmax(0,2fr)_56px_150px]"
        : "sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1.4fr)_56px_150px]";
  const addedBy = (row: HonorQueueRow) =>
    kind === "self"
      ? `${formatDecided(row.decidedAt)} by the scholar`
      : row.decidedByName
        ? `${formatDecided(row.decidedAt)} by ${row.decidedByName}`
        : formatDecided(row.decidedAt);
  const cells = (
    row: HonorQueueRow,
  ): Array<{
    v: string;
    sub?: string;
    strong?: boolean;
    muted?: boolean;
    right?: boolean;
    year?: boolean;
  }> => {
    const year = { v: row.year === null ? "—" : String(row.year), right: true, year: true };
    const date =
      kind === "rejected"
        ? { v: row.rejectionReason ?? "—", sub: addedBy(row), right: true, muted: true }
        : { v: addedBy(row), right: true, muted: true };
    if (mode === "scholar")
      return [{ v: row.name, strong: true }, { v: row.organization, muted: true }, year, date];
    if (mode === "award")
      return [
        { v: row.scholarName, strong: true },
        { v: row.roleLabel ?? "—", muted: true },
        year,
        date,
      ];
    return [
      { v: row.scholarName, strong: true },
      { v: row.name },
      { v: row.organization, muted: true },
      year,
      date,
    ];
  };
  return (
    <div
      className="bg-apollo-surface border-apollo-border-strong overflow-hidden rounded-[var(--apollo-radius-card)] border"
      data-slot={`honors-${kind}-table`}
    >
      <div
        className={cn(
          "bg-apollo-surface-2 border-apollo-border-strong text-muted-foreground hidden gap-3.5 border-b px-5 py-2.5 text-xs font-medium tracking-[0.08em] uppercase sm:grid",
          cols,
        )}
        aria-hidden
      >
        {heads.map((h, i) => (
          <span key={h} className={i >= heads.length - 2 ? "text-right" : undefined}>
            {h}
          </span>
        ))}
      </div>
      {sections.length === 0 ? (
        <div
          className="text-muted-foreground p-8 text-center text-sm"
          data-slot={`honors-${kind}-empty`}
        >
          {empty}
        </div>
      ) : (
        sections.map((section, si) => (
          <div
            key={section.key}
            data-slot={section.label ? "honor-list-section" : "honor-list-flat"}
          >
            {section.label ? (
              <div
                className={cn(
                  "bg-apollo-page flex flex-wrap items-baseline gap-x-2.5 px-5 pt-2.5 pb-2",
                  si > 0 && "border-apollo-border-strong border-t",
                )}
              >
                <span className="text-[14.5px] font-semibold" data-slot="honor-list-heading">
                  {section.label}
                </span>
                <span className="text-muted-foreground text-[12.5px]">{section.sub}</span>
              </div>
            ) : null}
            <ul data-slot={`honors-${kind}-list`}>
              {section.rows.map((row, i) => (
                <li
                  key={row.id}
                  className={cn(
                    "hover:bg-apollo-page flex flex-wrap gap-x-3.5 gap-y-0.5 py-2.5 pr-5 text-sm sm:grid sm:items-center",
                    section.label ? "pl-8" : "pl-5",
                    cols,
                    (i > 0 || (!section.label && si > 0)) && "border-apollo-border border-t",
                  )}
                >
                  {cells(row).map((c, ci) => (
                    <span
                      key={ci}
                      title={c.sub ? `${c.v} · ${c.sub}` : c.v}
                      className={cn(
                        "min-w-0 leading-snug [overflow-wrap:anywhere] tabular-nums",
                        c.strong && "font-medium",
                        c.muted && "text-muted-foreground",
                        c.right && "sm:text-right",
                        c.year && c.v === "—" && "text-apollo-border-strong",
                        // Phones: the lead cell takes its own line; the rest flow under it.
                        ci === 0 && "basis-full sm:basis-auto",
                        ci > 0 && (c.muted && c.right ? "text-[13px]" : "text-[13px] sm:text-sm"),
                      )}
                    >
                      {c.v}
                      {c.sub ? (
                        <span
                          className="text-muted-foreground block text-xs"
                          data-slot="honor-decided-by"
                        >
                          {c.sub}
                        </span>
                      ) : null}
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
      <div
        className="bg-apollo-page border-apollo-border text-muted-foreground border-t px-5 py-3 text-[13px]"
        data-slot="honors-list-footer"
      >
        Showing {shown} of {total} honors.
      </div>
    </div>
  );
}

/** "Sep 1, 2026, 3:04 PM UTC" — when a load ran. */
function formatRunTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
}

function runStatus(run: HonorSourceRun): { label: string; dot: string; ink: string } {
  if (run.status === "success")
    return { label: "Succeeded", dot: "bg-apollo-slate", ink: "text-muted-foreground" };
  if (run.status === "failed")
    return { label: "Failed", dot: "bg-destructive", ink: "text-destructive" };
  return { label: "Running", dot: "bg-apollo-amber", ink: "text-apollo-amber" };
}

const SOURCE_COLS = "sm:grid-cols-[minmax(0,2.2fr)_90px_80px_80px_80px]";

/**
 * Sources: the honor rosters the queue's rows came from, with how many lines
 * each matched and where they stand, and the recorded load runs. Read-only.
 * There is no Run now: loads are operator-run jobs with no console trigger, so
 * every list's schedule is "Manual" and one load covers every list.
 */
function SourcesPanel({ summary, empty }: { summary: HonorSourcesSummary; empty: string }) {
  const { sources, runs } = summary;
  const last = runs[0] ?? null;
  const lastStatus = last ? runStatus(last) : null;
  const waiting = sources.reduce((n, s) => n + s.pendingLines, 0);
  return (
    <div className="flex flex-col gap-4" data-slot="honors-sources">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-[15px]">
        <span className="text-muted-foreground whitespace-nowrap">
          <span className="text-foreground font-semibold tabular-nums">{sources.length}</span> honor
          list{sources.length === 1 ? "" : "s"}
        </span>
        <span className="text-muted-foreground whitespace-nowrap">
          <span className="text-apollo-amber font-semibold tabular-nums">{waiting}</span> waiting
        </span>
        <span
          className="text-muted-foreground inline-flex flex-wrap items-center gap-1.5 text-[13.5px]"
          data-slot="honors-sources-last-run"
        >
          {last && lastStatus ? (
            <>
              <span className={cn("size-2 flex-none rounded-full", lastStatus.dot)} aria-hidden />
              Last load {formatRunTime(last.startedAt)} ·{" "}
              <span className={lastStatus.ink}>{lastStatus.label}</span> ·{" "}
              {last.rowsProcessed.toLocaleString("en-US")} rows
            </>
          ) : (
            "No load recorded yet"
          )}
        </span>
      </div>

      {last?.status === "failed" && last.errorMessage ? (
        <div
          className="border-apollo-red-tint-border bg-apollo-red-tint text-destructive rounded-md border px-2.5 py-1.5 font-mono text-[12.5px] [overflow-wrap:anywhere]"
          data-slot="honors-sources-error"
        >
          {last.errorMessage}
        </div>
      ) : null}

      <div
        className="bg-apollo-surface border-apollo-border-strong overflow-hidden rounded-[var(--apollo-radius-card)] border"
        data-slot="honors-sources-table"
      >
        <div
          className={cn(
            "bg-apollo-surface-2 border-apollo-border-strong text-muted-foreground hidden gap-3.5 border-b px-5 py-2.5 text-xs font-medium tracking-[0.08em] uppercase sm:grid",
            SOURCE_COLS,
          )}
          aria-hidden
        >
          <span>Honor list</span>
          <span>Schedule</span>
          <span className="text-right">Matched</span>
          <span className="text-right">Waiting</span>
          <span className="text-right">Approved</span>
        </div>
        {sources.length === 0 ? (
          <div className="text-muted-foreground p-8 text-center text-sm">{empty}</div>
        ) : (
          <ul>
            {sources.map((s, i) => (
              <li
                key={s.key}
                className={cn(
                  "flex flex-wrap gap-x-3.5 gap-y-0.5 px-5 py-2.5 text-sm sm:grid sm:items-center",
                  SOURCE_COLS,
                  i > 0 && "border-apollo-border border-t",
                )}
                data-slot="honors-source"
              >
                <span className="flex min-w-0 basis-full flex-col gap-0.5 sm:basis-auto">
                  <span className="truncate font-medium">{s.name}</span>
                  <span className="text-muted-foreground truncate text-[12.5px]">
                    {s.organization}
                    {s.url && s.host ? (
                      <>
                        {" · "}
                        <a
                          href={s.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-apollo-slate font-mono text-xs hover:underline"
                        >
                          {s.host}
                        </a>
                      </>
                    ) : null}
                  </span>
                </span>
                <span className="text-muted-foreground text-[13px]">Manual</span>
                <span className="text-[13px] tabular-nums sm:text-right sm:text-sm">
                  {s.lines}
                  <span className="text-muted-foreground sm:hidden"> matched</span>
                </span>
                <span
                  className={cn(
                    "text-[13px] tabular-nums sm:text-right sm:text-sm",
                    s.pendingLines > 0 && "text-apollo-amber font-medium",
                  )}
                >
                  {s.pendingLines}
                  <span className="text-muted-foreground font-normal sm:hidden"> waiting</span>
                </span>
                <span className="text-[13px] font-medium tabular-nums sm:text-right sm:text-sm">
                  {s.approved}
                  <span className="text-muted-foreground font-normal sm:hidden"> approved</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="bg-apollo-page border-apollo-border text-muted-foreground border-t px-5 py-3 text-[13px]">
          New matches from each load land in Possible. &ldquo;Matched&rdquo; counts list entries
          matched to at least one Weill Cornell scholar. Lists are loaded by an operator, so there
          is no automatic schedule yet.
        </div>
      </div>

      {runs.length > 1 ? (
        <details className="text-[13px]" data-slot="honors-sources-runs">
          <summary className="text-muted-foreground cursor-pointer">Earlier loads</summary>
          <ul className="mt-2 flex flex-col gap-1">
            {runs.slice(1).map((r) => {
              const st = runStatus(r);
              return (
                <li
                  key={`${r.source}-${r.startedAt}`}
                  className="text-muted-foreground flex flex-wrap items-center gap-1.5"
                >
                  <span className={cn("size-2 flex-none rounded-full", st.dot)} aria-hidden />
                  {formatRunTime(r.startedAt)} · <span className={st.ink}>{st.label}</span> ·{" "}
                  {r.rowsProcessed.toLocaleString("en-US")} rows
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
