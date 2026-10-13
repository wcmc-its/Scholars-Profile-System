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
 * every decided card keeps an Undo link. Undo POSTs ONE `decision: "undo"` for
 * every row the decision wrote (the approved row, or each rejected candidate as
 * `ids`), which the server reverts all-or-nothing and which restores the siblings
 * an approval auto-rejected — so a failed undo leaves the card exactly as it was. A reject may carry a reason
 * from the select beside the button (optional, so one click still rejects).
 * Sources lists every honor list: the ones the weekly scrape reads, each with
 * its last run and (behind HONORS_RUN_NOW) a Run now, and the seed-only rosters
 * the queue's other rows came from. Candidates carry the scrape's evidence line.
 *
 * Kept from the shipped queue although the mockup omits them on Possible: the
 * person-type filter (and its "All" chip, on every tab), the Possible sort, and
 * the Possible group-by. Group-by is ORTHOGONAL to the contested-pair mechanic —
 * a contested line stays one pick-one unit under every mode.
 *
 * 2026-10-13 iteration ("Honors Iteration - 2026-10-13"): every tab opens on All
 * scholars and says when a filter hides rows; Possible gains a Source filter and
 * a reject needs a reason. Known / Rejected / User asserted are flat tables with
 * a Scholar column (optional "By scholar"), each row with its action: Known's
 * "Move to Possible" and Rejected's "Restore" are the decision route's undo,
 * User asserted's Verify is `/api/edit/honor/verify`. Sources links its counts
 * into Possible.
 */
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import {
  Kbd,
  ReasonSelect,
  EvidenceQuote,
  rosterSourceUrl,
  ReviewList,
  ReviewPane,
  shortName,
  type Decided,
} from "@/components/edit/honors-review";
export { rosterSourceUrl } from "@/components/edit/honors-review";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import type {
  DoctoralDegree,
  HonorQueueGroup,
  HonorListRunView,
  HonorListStatus,
  HonorQueueRow,
  HonorSourceRun,
  HonorSourcesSummary,
} from "@/lib/edit/honor-queue";
import { groupMatchLevel, MATCH_LEVEL_RANK, type MatchLevel } from "@/lib/edit/honor-match";
import {
  isFullTimeFaculty,
  predatesDegreeNote,
  REJECTION_REASONS,
  rosterKey,
  rosterMatchedName,
} from "@/lib/edit/honor-queue";
import { parseEvidence } from "@/lib/edit/honor-match";
import { NEWSROOM_ROSTER_URL } from "@/lib/honors/lists";
import { HONOR_TIER_LABELS, HONOR_TIERS, ruleTier, type HonorTier } from "@/lib/honors/tiers";
import { cn } from "@/lib/utils";
import { Caret, SUMMARY_NO_MARKER } from "@/components/ui/caret";

type Props = {
  pending: HonorQueueGroup[];
  approved: HonorQueueGroup[];
  rejected: HonorQueueGroup[];
  /** Round 5: honors a scholar entered about themselves (`source='SELF'`), shown
   *  in their own read-only "User asserted" tab and kept out of Known. */
  userAsserted: HonorQueueGroup[];
  /** The Sources tab: honor rosters and recorded load runs. */
  sources: HonorSourcesSummary;
  /** cwid → earliest doctoral degree, for Rejected's "predates the degree" note. */
  degrees?: Record<string, DoctoralDegree>;
  /** HONORS_RUN_NOW: offer Run now on each scraped list. */
  runNowEnabled?: boolean;
  /** An observer's view: the queue renders, the decision controls do not. */
  readOnly?: boolean;
};

type Tab = "pending" | "approved" | "rejected" | "self" | "sources";
type PersonFilter = "faculty" | "affiliated" | "other" | "all";
type SortKey = "tier" | "recent" | "confident";
type TierFilter = HonorTier | "all";
type MatchFilter = "strong" | "review" | "all";
/** Possible's group-by (the shipped control). */
export type GroupBy = "none" | "person" | "award";
/** The record tabs' group-by. */
export type ListGroupBy = "scholar" | "none";

/** Contested lines span people, so they can't sit under any one person heading —
 *  they bucket together here under group-by "person". The double-underscore
 *  sentinel can't collide with a real cwid (alphanumeric, no underscores). */
const CONTESTED_BUCKET = "__contested__";

/** Sources has no honor groups; a stable empty array keeps the memos below steady. */
const NO_GROUPS: HonorQueueGroup[] = [];

/** All rows on one group share a roster line ⇒ one honor ⇒ one tier/year, so
 *  the group's sort key is `rows[0]`'s. Comparators return standard <0/0/>0. */
function compareGroups(
  a: HonorQueueGroup,
  b: HonorQueueGroup,
  key: SortKey,
  levels: ReadonlyMap<string, MatchLevel>,
): number {
  const ay = a.rows[0].year;
  const by = b.rows[0].year;
  const recent = () => (ay === by ? 0 : ay === null ? 1 : by === null ? -1 : by - ay);
  const tier = () => a.rows[0].tier - b.rows[0].tier; // tier 1 first
  const rank = (g: HonorQueueGroup) => MATCH_LEVEL_RANK[levels.get(g.key) ?? "weak"];
  if (key === "tier") return tier() || recent();
  if (key === "recent") return recent() || tier();
  return rank(a) - rank(b) || tier() || recent(); // strongest match first
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

/** The roster a line came from (`rosterKey`), or null for a hand-entered row. */
function lineSource(row: HonorQueueRow): string | null {
  return row.sourceRef ? rosterKey(row.sourceRef) : null;
}

/** A source's short label for the Source filter. */
function sourceLabel(key: string, summary: HonorSourcesSummary): string {
  if (key === NEWSROOM_ROSTER_URL) return "WCM Newsroom";
  const list = summary.lists.find((l) => l.rosterUrl === key);
  if (list) return list.organization;
  return summary.sources.find((x) => x.key === key)?.organization ?? key;
}

/** "the WCM Newsroom", "the Burroughs Wellcome Fund Career Award list". */
function sourcePhrase(key: string, summary: HonorSourcesSummary): string {
  if (key === NEWSROOM_ROSTER_URL) return "the WCM Newsroom";
  const list = summary.lists.find((l) => l.rosterUrl === key);
  if (list) return `the ${list.organization} ${list.honorName} list`;
  const src = summary.sources.find((x) => x.key === key);
  return src ? `the ${src.organization} ${src.name} list` : "a seed import";
}

const PERSON_LABEL: Record<PersonFilter, string> = {
  faculty: "Full-time faculty",
  affiliated: "Affiliated faculty",
  other: "Trainees & other",
  all: "All scholars",
};

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
 * The record tabs' sections (Known / Rejected / User asserted). Exported for
 * the grouping test.
 *  - scholar: one section per scholar (cwid), sections A–Z by surname, rows
 *    newest-decision first.
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
    const bucket = buckets.get(r.cwid);
    if (bucket) bucket.push(r);
    else buckets.set(r.cwid, [r]);
  }
  return [...buckets]
    .sort(
      ([, a], [, b]) =>
        surnameKey(a[0].scholarName).localeCompare(surnameKey(b[0].scholarName)) ||
        a[0].scholarName.localeCompare(b[0].scholarName),
    )
    .map(([key, rs]) => ({
      key,
      label: rs[0].scholarName,
      sub: `${rs.length} honor${rs.length === 1 ? "" : "s"}`,
      rows: [...rs].sort(newestFirst),
    }));
}

/** "Sep 15, 2026" — the decision date on the read-only tabs. UTC so a
 *  late-evening decision does not render as the next/previous day. */
function formatDecided(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  if (d.toDateString() === now.toDateString()) return "Today";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
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

export function HonorsQueue({
  pending,
  approved,
  rejected,
  userAsserted,
  sources,
  degrees = {},
  runNowEnabled = false,
  readOnly = false,
}: Props) {
  const router = useRouter();
  // Possible first — the redesign: land on the working queue.
  const [tab, setTab] = useState<Tab>("pending");
  // All scholars by default (2026-10-13 iteration); the row count says when a
  // narrower filter is hiding rows.
  const [filter, setFilter] = useState<PersonFilter>("all");
  /** Possible's Source filter: a roster key (`rosterKey`) or "all". */
  const [sourceFilter, setSourceFilter] = useState("all");
  // Highest tier first — the round-3 ask: work the biggest honors before the rest.
  const [sortKey, setSortKey] = useState<SortKey>("tier");
  // Tier facet: every tier by default; a curator narrows to one (e.g. tier 1, so
  // no pinnacle prize is missed).
  const [tierFilter, setTierFilter] = useState<TierFilter>("all");
  // Possible opens on strong matches: the rows faculty will want on their
  // profiles, clearable fastest (2026-10-13). Widen from there.
  const [matchFilter, setMatchFilter] = useState<MatchFilter>("strong");
  // Possible: no extra grouping by default — the flat, roster-line view.
  const [groupBy, setGroupBy] = useState<GroupBy>("none");
  // Record tabs: flat by default, with a Scholar column.
  const [listGroupBy, setListGroupBy] = useState<ListGroupBy>("none");
  /** Record rows whose evidence is expanded (Known's "View evidence"). */
  const [evOpen, setEvOpen] = useState<Record<string, true>>({});
  const [query, setQuery] = useState("");
  const [groups, setGroups] = useState(pending);
  /** Contested line key → the candidate row id the curator picked. */
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [decided, setDecided] = useState<Record<string, Decided>>({});
  /** The line whose reject-reason choices are open (Reject pressed). */
  const [asking, setAsking] = useState<string | null>(null);
  /** Decisions made on this page, newest last: what U / the toast's Undo reverts. */
  const [history, setHistory] = useState<string[][]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, true>>({});
  const [focus, setFocus] = useState<string | null>(null);
  const [hideDecided, setHideDecided] = useState(false);
  const [bulkReason, setBulkReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const q = query.trim().toLowerCase();

  // A refresh (after a decision, Move to Possible or Restore) brings new pending
  // lines in. Merge rather than replace: a line decided on this page stays in
  // place with its outcome, which a plain replace would drop.
  const decidedRef = useRef(decided);
  decidedRef.current = decided;
  useEffect(() => {
    setGroups((prev) => {
      const fresh = new Map(pending.map((g) => [g.key, g]));
      const seen = new Set(prev.map((g) => g.key));
      return [
        ...prev
          .filter((g) => decidedRef.current[g.key] || fresh.has(g.key))
          .map((g) => (decidedRef.current[g.key] ? g : (fresh.get(g.key) ?? g))),
        ...pending.filter((g) => !seen.has(g.key)),
      ];
    });
  }, [pending]);

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
  const published = useMemo(() => approved.flatMap((g) => g.rows), [approved]);

  // Tab-label totals are per-tab and independent of the active tab — the count on
  // "Possible" must not change when the curator opens "Known".
  const tabTotals = useMemo(
    () => ({
      pending: undecided.reduce((n, g) => n + g.rows.length, 0),
      approved: approved.reduce((n, g) => n + g.rows.length, 0),
      rejected: rejected.reduce((n, g) => n + g.rows.length, 0),
      self: userAsserted.reduce((n, g) => n + g.rows.length, 0),
      sources:
        sources.lists.length +
        sources.sources.filter((x) => !sources.lists.some((l) => l.rosterUrl === x.key)).length,
    }),
    [undecided, approved, rejected, userAsserted, sources],
  );

  // Option counts follow the ACTIVE tab (round 4: the filters are on every tab).
  const counts = useMemo(() => {
    const c = { faculty: 0, affiliated: 0, other: 0, all: 0 };
    for (const g of source)
      for (const r of g.rows) {
        c.all += 1;
        c[personBucket(r.roleCategory)] += 1;
      }
    return c;
  }, [source]);
  const tierCounts = useMemo(() => {
    const c: Record<TierFilter, number> = { all: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
    for (const g of source)
      for (const r of g.rows)
        if (filter === "all" || personBucket(r.roleCategory) === filter) {
          c.all += 1;
          c[r.tier] += 1;
        }
    return c;
  }, [source, filter]);
  const sourceCounts = useMemo(() => {
    const c = new Map<string, number>();
    for (const g of undecided) {
      const k = lineSource(g.rows[0]);
      if (k) c.set(k, (c.get(k) ?? 0) + 1);
    }
    return c;
  }, [undecided]);
  const levels = useMemo(() => new Map(groups.map((g) => [g.key, groupMatchLevel(g)])), [groups]);
  const matchCounts = useMemo(() => {
    let strong = 0;
    for (const g of undecided) if (levels.get(g.key) === "strong") strong += 1;
    return { strong, review: undecided.length - strong, all: undecided.length };
  }, [undecided, levels]);

  const filtered = useMemo(
    () =>
      source.filter(
        (g) =>
          groupMatchesFilter(g, filter) &&
          (tierFilter === "all" || g.rows[0].tier === tierFilter) &&
          (tab !== "pending" || sourceFilter === "all" || lineSource(g.rows[0]) === sourceFilter) &&
          (tab !== "pending" ||
            matchFilter === "all" ||
            (matchFilter === "strong") === (levels.get(g.key) === "strong")) &&
          !(tab === "pending" && hideDecided && decided[g.key]) &&
          g.rows.some((r) => rowMatchesQuery(r, q)),
      ),
    [source, filter, tierFilter, sourceFilter, tab, matchFilter, levels, hideDecided, decided, q],
  );
  const sections = useMemo(
    () =>
      buildSections(filtered, groupBy)
        .map((s) => ({
          ...s,
          groups: [...s.groups].sort((a, b) => compareGroups(a, b, sortKey, levels)),
        }))
        .sort((a, b) => compareGroups(a.groups[0], b.groups[0], sortKey, levels)),
    [filtered, groupBy, sortKey, levels],
  );
  const flat = useMemo(() => sections.flatMap((s) => s.groups), [sections]);
  const focusKey = flat.some((g) => g.key === focus) ? focus : (flat[0]?.key ?? null);
  const focused = flat.find((g) => g.key === focusKey) ?? null;
  const open = flat.filter((g) => !decided[g.key]);
  const selKeys = Object.keys(selected);
  const approvable = selKeys.filter((k) => {
    const g = groups.find((x) => x.key === k);
    return g && (!g.contested || picks[k]);
  }).length;

  // Record tabs filter per ROW (no contested units there).
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

  // Possible needs no note: the shown-count line under the filters says it.
  const tabNote =
    tab === "pending"
      ? ""
      : tab === "approved"
        ? "Approved honors. These show on profiles."
        : tab === "rejected"
          ? "Matches that were ruled out. They won’t be suggested again."
          : tab === "sources"
            ? "Honor lists we scrape, and when each last ran."
            : "Honors scholars added to their own profiles. Shown as self-reported until verified.";

  function switchTab(next: Tab) {
    setTab(next);
    setQuery("");
    setSelected({});
    setAsking(null);
    setToast(null);
  }

  /** Sources → Possible, optionally narrowed to one source and nothing else. */
  function openPossible(sourceKey: string | null) {
    switchTab("pending");
    setSourceFilter(sourceKey ?? "all");
    if (sourceKey) {
      setFilter("all");
      setTierFilter("all");
      setMatchFilter("all");
    }
  }

  /** "Full-time faculty only · WCM Newsroom only": what is narrowing Possible. */
  const narrowing = [
    filter !== "all" ? `${PERSON_LABEL[filter]} only` : null,
    tierFilter !== "all" ? `Tier ${tierFilter} only` : null,
    matchFilter === "strong"
      ? "Strong matches only"
      : matchFilter === "review"
        ? "Closer-look matches only"
        : null,
    sourceFilter !== "all" ? `${sourceLabel(sourceFilter, sources)} only` : null,
    q ? `Matching “${query.trim()}”` : null,
  ].filter(Boolean);

  async function send(payload: Record<string, unknown>): Promise<boolean> {
    try {
      const res = await fetch("/api/edit/honor/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setError(
          json.error === "not_pending"
            ? "Someone already decided that one. Refresh to see the current queue."
            : json.error === "not_undoable" || json.error === "superseded"
              ? "That decision can't be undone any more. Refresh to see the current queue."
              : json.error === "line_already_awarded"
                ? "Another candidate for that award has since been approved. Undo that approval first."
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

  /** Move the focus `d` lines, optionally past decided ones. */
  function move(d: 1 | -1, skipDecided = false, decidedNow: Record<string, Decided> = decided) {
    let i = flat.findIndex((g) => g.key === focusKey);
    for (let k = 0; k < flat.length; k++) {
      i += d;
      if (i < 0 || i >= flat.length) return;
      if (!skipDecided || !decidedNow[flat[i].key]) {
        setFocus(flat[i].key);
        scrollRowIntoView(flat[i].key);
        return;
      }
    }
  }

  /**
   * Decide lines in order: approve (a contested line needs its pick; approving
   * resolves the WHOLE line, siblings rejected server-side) or reject (every
   * candidate on the line, with a required reason). Sequential on purpose: each
   * is its own transaction and audit row, and a parallel burst would race the
   * pending re-check.
   */
  async function decide(keys: string[], kind: "approve" | "reject", reason = "") {
    if (kind === "reject" && !reason) return;
    setBusy(true);
    setAsking(null);
    setError(null);
    const next = { ...decided };
    const done: string[] = [];
    let lastText = "";
    for (const key of keys) {
      const group = groups.find((g) => g.key === key);
      if (!group || next[key]) continue;
      if (kind === "approve") {
        const row = group.contested ? group.rows.find((r) => r.id === picks[key]) : group.rows[0];
        if (!row) continue;
        if (!(await send({ id: row.id, decision: "approve" }))) break;
        next[key] = { kind: "approved", scholarName: row.scholarName, rowIds: [row.id] };
        lastText = `Approved ${row.name}, ${row.organization} for ${shortName(row.scholarName)}.`;
      } else {
        const ok: string[] = [];
        for (const row of group.rows) {
          if (!(await send({ id: row.id, decision: "reject", reason }))) break;
          ok.push(row.id);
        }
        if (ok.length < group.rows.length) {
          // A partial "None of these": drop the candidates that did reject; the
          // rest are still live.
          if (ok.length > 0)
            setGroups((gs) =>
              gs.map((g) => {
                if (g.key !== key) return g;
                const rows = g.rows.filter((r) => !ok.includes(r.id));
                return { ...g, rows, contested: new Set(rows.map((r) => r.cwid)).size > 1 };
              }),
            );
          break;
        }
        next[key] = { kind: "rejected", reason, rowIds: ok };
        lastText = `Rejected ${group.rows[0].name}, ${group.rows[0].organization}.`;
      }
      done.push(key);
    }
    if (done.length > 0) {
      setDecided(next);
      setHistory((h) => [...h, done]);
      setSelected((s) => {
        const n = { ...s };
        for (const k of done) delete n[k];
        return n;
      });
      setToast(
        done.length === 1
          ? lastText
          : `${kind === "approve" ? "Approved" : "Rejected"} ${done.length} honors.`,
      );
      // Reconcile Known/Rejected (and the subnav pending pill) with the server.
      router.refresh();
      if (keys.length === 1 && keys[0] === focusKey) move(1, true, next);
    }
    setBusy(false);
  }

  function approveOne(key: string) {
    const g = groups.find((x) => x.key === key);
    if (g?.contested && !picks[key]) {
      setFocus(key);
      setToast("Pick which scholar first.");
      return;
    }
    void decide([key], "approve");
  }

  /** Reject needs a reason: open the choices on the line (1–5 or a click). */
  function askReject(key: string) {
    setFocus(key);
    setAsking(key);
  }

  /** Known's "Move to Possible" / Rejected's "Restore": the decision route's
   *  undo on one record row. A line decided on this page is undone as a whole. */
  async function reopen(row: HonorQueueRow) {
    const local = Object.entries(decided).find(([, d]) => d.rowIds.includes(row.id))?.[0];
    if (local) {
      if (!(await undo([local]))) return;
      setToast(`Moved ${row.name} (${shortName(row.scholarName)}) back to Possible.`);
      return;
    }
    setBusy(true);
    setError(null);
    if (await send({ id: row.id, decision: "undo" })) {
      setToast(`Moved ${row.name} (${shortName(row.scholarName)}) back to Possible.`);
      router.refresh();
    }
    setBusy(false);
  }

  /** User asserted: mark a self-asserted honor verified, or back to self-reported. */
  async function setVerified(row: HonorQueueRow, verified: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/edit/honor/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: row.id, verified }),
      });
      const json = (await res.json()) as { ok?: boolean };
      if (!res.ok || !json.ok) throw new Error("verify not saved");
      router.refresh();
    } catch {
      setError("That didn't save. Nothing was changed.");
    }
    setBusy(false);
  }

  /** Revert decisions made on this page (default: the latest). Each line is ONE
   *  request: the server reverts every written row (and any siblings an approval
   *  auto-rejected) all-or-nothing, so a failed line stays decided. */
  async function undo(keys?: string[]): Promise<boolean> {
    const target = keys ?? history[history.length - 1];
    if (!target) return false;
    setBusy(true);
    setError(null);
    const reverted: string[] = [];
    for (const key of target) {
      const d = decided[key];
      if (!d) continue;
      const ok = await send(
        d.rowIds.length === 1
          ? { id: d.rowIds[0], decision: "undo" }
          : { ids: d.rowIds, decision: "undo" },
      );
      if (ok) reverted.push(key);
    }
    if (reverted.length > 0) {
      setDecided((cur) => {
        const n = { ...cur };
        for (const k of reverted) delete n[k];
        return n;
      });
      setHistory((h) =>
        h.map((e) => e.filter((k) => !reverted.includes(k))).filter((e) => e.length > 0),
      );
      setToast(null);
      if (reverted.length === 1) setFocus(reverted[0]);
    }
    router.refresh();
    setBusy(false);
    return reverted.length === target.length;
  }

  function toggleSelected(key: string) {
    if (decided[key]) return;
    setSelected((s) => {
      const n = { ...s };
      if (n[key]) delete n[key];
      else n[key] = true;
      return n;
    });
  }

  /** Set (or, with null, clear) the curator tier on every row of one line. */
  async function setTier(group: HonorQueueGroup, tier: HonorTier | null) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/edit/honor/tier", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: group.rows.map((r) => r.id), tier }),
      });
      const json = (await res.json()) as { ok?: boolean };
      if (!res.ok || !json.ok) throw new Error("tier not saved");
      setGroups((gs) =>
        gs.map((g) =>
          g.key !== group.key
            ? g
            : {
                ...g,
                rows: g.rows.map((r) => ({
                  ...r,
                  tier: tier ?? ruleTier(r.organization, r.name),
                  tierOverridden: tier !== null,
                })),
              },
        ),
      );
    } catch {
      setError("That tier didn't save. Nothing was changed.");
    }
    setBusy(false);
  }

  // Keyboard review on Possible. The handler is re-bound each render through a
  // ref, so the listener always sees current state.
  const onKey = useRef<(e: KeyboardEvent) => void>(() => {});
  onKey.current = (e: KeyboardEvent) => {
    if (tab !== "pending" || busy) return;
    const t = e.target as HTMLElement | null;
    if (
      t &&
      ((t.tagName === "INPUT" &&
        (t as HTMLInputElement).type !== "checkbox" &&
        (t as HTMLInputElement).type !== "radio") ||
        t.tagName === "SELECT" ||
        t.tagName === "TEXTAREA" ||
        t.isContentEditable)
    )
      return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    // The reason choices own the keyboard while open on the focused line: 1–5
    // picks, Esc cancels. (Open on a line the curator has moved off, they are
    // hidden and inert.)
    if (asking && asking === focusKey) {
      if (k === "escape") setAsking(null);
      const n = Number(k);
      if (Number.isInteger(n) && n >= 1 && n <= REJECTION_REASONS.length) {
        e.preventDefault();
        void decide([asking], "reject", REJECTION_REASONS[n - 1]);
      }
      return;
    }
    if (k === "j" || k === "arrowdown") {
      e.preventDefault();
      move(1);
      return;
    }
    if (k === "k" || k === "arrowup") {
      e.preventDefault();
      move(-1);
      return;
    }
    if (readOnly || !focusKey) return;
    if (k === "x") {
      e.preventDefault();
      toggleSelected(focusKey);
    } else if (k === "a") {
      e.preventDefault();
      if (e.shiftKey && selKeys.length) void decide(selKeys, "approve");
      else approveOne(focusKey);
    } else if (k === "r") {
      e.preventDefault();
      if (e.shiftKey && selKeys.length) {
        if (bulkReason) void decide(selKeys, "reject", bulkReason);
        else setToast("Pick a reason in the selection bar first.");
      } else if (!decided[focusKey]) askReject(focusKey);
    } else if (k === "u" || k === "z") {
      e.preventDefault();
      void undo();
    } else if (k === "escape") {
      setSelected({});
    } else if (/^[1-9]$/.test(k) && focused?.contested && !decided[focusKey]) {
      const row = focused.rows[Number(k) - 1];
      if (row) setPicks((p) => ({ ...p, [focusKey]: row.id }));
    }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => onKey.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const isList = tab !== "pending" && tab !== "sources";
  const strongOpen = open.filter((g) => levels.get(g.key) === "strong");
  const allSelected = open.length > 0 && open.every((g) => selected[g.key]);

  return (
    <div className="flex flex-col gap-[18px]" data-slot="honors-queue">
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
        {tabNote ? (
          <p className="text-muted-foreground text-[13.5px]" data-slot="honors-tab-note">
            {tabNote}
          </p>
        ) : null}
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
        <div className="flex flex-wrap items-center gap-2.5" data-slot="honors-filters">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Scholar, honor or org…"
            aria-label="Search honors"
            className="border-apollo-border-strong bg-apollo-surface h-[34px] w-full rounded-lg border px-2.5 text-[13.5px] outline-none sm:w-[220px]"
            data-slot="honors-search"
          />
          <ToolbarSelect
            label="Scholars"
            slot="honors-person-filter"
            value={filter}
            onChange={(v) => setFilter(v as PersonFilter)}
            options={(["all", "faculty", "affiliated", "other"] as const).map(
              (k) => [k, `${PERSON_LABEL[k]} (${counts[k]})`] as const,
            )}
          />
          {tab === "pending" ? (
            <>
              <ToolbarSelect
                label="Tier"
                slot="honors-tier-filter"
                value={String(tierFilter)}
                onChange={(v) => setTierFilter(v === "all" ? "all" : (Number(v) as HonorTier))}
                options={[
                  ["all", `All tiers (${tierCounts.all})`],
                  ...HONOR_TIERS.map(
                    (t) =>
                      [String(t), `${t} · ${HONOR_TIER_LABELS[t]} (${tierCounts[t]})`] as const,
                  ),
                ]}
              />
              <ToolbarSelect
                label="Match"
                slot="honors-match-filter"
                value={matchFilter}
                onChange={(v) => setMatchFilter(v as MatchFilter)}
                options={[
                  ["strong", `Strong only (${matchCounts.strong})`],
                  ["review", `Needs a closer look (${matchCounts.review})`],
                  ["all", `All matches (${matchCounts.all})`],
                ]}
              />
              <ToolbarSelect
                label="Source"
                slot="honors-source-filter"
                value={sourceFilter}
                onChange={setSourceFilter}
                options={[
                  ["all", "All sources"],
                  // The active source stays listed even with nothing pending (opened
                  // from Sources), so the select never misreports the filter.
                  ...[
                    ...sourceCounts,
                    ...(sourceFilter !== "all" && !sourceCounts.has(sourceFilter)
                      ? [[sourceFilter, 0] as const]
                      : []),
                  ]
                    .map(([k, n]) => [k, `${sourceLabel(k, sources)} (${n})`] as const)
                    .sort((a, b) => a[1].localeCompare(b[1])),
                ]}
              />
            </>
          ) : filter !== "all" || q ? (
            <button
              type="button"
              onClick={() => {
                setFilter("all");
                setQuery("");
              }}
              className="text-apollo-slate text-[13px]"
              data-slot="honors-show-all"
            >
              Show all
            </button>
          ) : null}
          <div className="flex flex-wrap items-center gap-2.5 sm:ml-auto">
            {isList ? (
              <ToolbarSelect
                label="Group"
                slot="honors-list-group-by"
                value={listGroupBy}
                onChange={(v) => setListGroupBy(v as ListGroupBy)}
                options={[
                  ["none", "No grouping"],
                  ["scholar", "By scholar"],
                ]}
              />
            ) : (
              <>
                <ToolbarSelect
                  label="Group"
                  slot="honors-group-by"
                  value={groupBy}
                  onChange={(v) => setGroupBy(v as GroupBy)}
                  options={[
                    ["none", "No grouping"],
                    ["person", "By scholar"],
                    ["award", "By award"],
                  ]}
                />
                <ToolbarSelect
                  label="Sort"
                  slot="honors-sort"
                  value={sortKey}
                  onChange={(v) => setSortKey(v as SortKey)}
                  options={[
                    ["tier", "Highest tier first"],
                    ["recent", "Most recent"],
                    ["confident", "Strongest match first"],
                  ]}
                />
              </>
            )}
          </div>
        </div>
      )}

      {tab === "pending" ? (
        <div
          className="text-muted-foreground flex flex-wrap items-center gap-3.5 text-[13px]"
          data-slot="honors-review-bar"
        >
          {readOnly ? null : (
            <>
              <label className="flex cursor-pointer items-center gap-2">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={(v) =>
                    setSelected(
                      v ? Object.fromEntries(open.map((g) => [g.key, true as const])) : {},
                    )
                  }
                  aria-label="Select all shown"
                />
                <span>Select all shown ({open.length})</span>
              </label>
              <button
                type="button"
                onClick={() =>
                  setSelected(Object.fromEntries(strongOpen.map((g) => [g.key, true as const])))
                }
                className="text-apollo-slate text-[13px]"
              >
                Select {strongOpen.length} strong matches
              </button>
            </>
          )}
          <label className="flex cursor-pointer items-center gap-2">
            <Switch
              checked={hideDecided}
              onCheckedChange={(v) => setHideDecided(Boolean(v))}
              aria-label="Hide decided"
            />
            Hide decided
          </label>
          <span data-slot="honors-shown">
            Showing {flat.length.toLocaleString("en-US")} of {groups.length.toLocaleString("en-US")}{" "}
            · {open.length.toLocaleString("en-US")} open
            {narrowing.map((n) => ` · ${n}`).join("")}
          </span>
          <div className="ml-auto hidden flex-wrap items-center gap-2.5 text-xs md:flex">
            <span className="flex items-center gap-1">
              <Kbd>J</Kbd>
              <Kbd>K</Kbd> move
            </span>
            {readOnly ? null : (
              <>
                <span className="flex items-center gap-1">
                  <Kbd>X</Kbd> select
                </span>
                <span className="flex items-center gap-1">
                  <Kbd>A</Kbd> approve
                </span>
                <span className="flex items-center gap-1">
                  <Kbd>R</Kbd> reject
                </span>
                <span className="flex items-center gap-1">
                  <Kbd>1</Kbd>
                  <Kbd>2</Kbd> pick
                </span>
                <span className="flex items-center gap-1">
                  <Kbd>U</Kbd> undo
                </span>
              </>
            )}
          </div>
        </div>
      ) : null}

      {tab === "sources" ? (
        <SourcesPanel
          summary={sources}
          empty={emptyMessage("sources", true)}
          runNowEnabled={runNowEnabled}
          pendingTotal={tabTotals.pending}
          onOpenPossible={openPossible}
        />
      ) : tab === "pending" ? (
        flat.length === 0 || !focused ? (
          <EmptyCard slot="honors-queue-empty">{emptyMessage(tab, source.length === 0)}</EmptyCard>
        ) : (
          <div className="grid items-start gap-4 lg:grid-cols-[minmax(300px,400px)_minmax(0,1fr)]">
            <ReviewList
              sections={sections}
              focusKey={focusKey}
              decided={decided}
              selected={selected}
              readOnly={readOnly}
              onFocus={setFocus}
              onToggle={toggleSelected}
            />
            <ReviewPane
              group={focused}
              position={`${flat.indexOf(focused) + 1} of ${flat.length}`}
              pick={picks[focused.key] ?? null}
              decided={decided[focused.key] ?? null}
              asking={asking === focused.key}
              busy={busy}
              readOnly={readOnly}
              published={published}
              pending={groups}
              decidedMap={decided}
              onPick={(rowId) => setPicks((p) => ({ ...p, [focused.key]: rowId }))}
              onRejectWith={(r) => void decide([focused.key], "reject", r)}
              onCancelAsk={() => setAsking(null)}
              onApprove={() => approveOne(focused.key)}
              onReject={() => askReject(focused.key)}
              onUndo={() => void undo([focused.key])}
              onSkip={() => move(1, true)}
              onTier={(t) => void setTier(focused, t)}
              onFocus={(key) => {
                setFocus(key);
                scrollRowIntoView(key);
              }}
            />
          </div>
        )
      ) : (
        <RecordTable
          kind={tab}
          sections={listSections}
          shown={listRows.length}
          total={counts.all}
          narrowing={filter !== "all" ? `${PERSON_LABEL[filter]} only` : null}
          empty={emptyMessage(tab, source.length === 0)}
          readOnly={readOnly}
          busy={busy}
          degrees={degrees}
          summary={sources}
          evOpen={evOpen}
          onToggleEvidence={(id) =>
            setEvOpen((o) => {
              const n = { ...o };
              if (n[id]) delete n[id];
              else n[id] = true;
              return n;
            })
          }
          onReopen={(row) => void reopen(row)}
          onVerify={(row, v) => void setVerified(row, v)}
        />
      )}

      {toast || (tab === "pending" && !readOnly && selKeys.length > 0) ? (
        <div className="fixed bottom-5 left-1/2 z-20 flex w-max max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col items-center gap-2">
          {toast ? (
            <div
              className="bg-apollo-bar flex items-center gap-3 rounded-[10px] py-[9px] pr-2.5 pl-3.5 text-[13.5px] text-white shadow-[0_6px_20px_rgba(0,0,0,.18)]"
              role="status"
              data-slot="honors-toast"
            >
              <span>{toast}</span>
              {tab === "pending" && history.length > 0 ? (
                <button
                  type="button"
                  onClick={() => void undo()}
                  disabled={busy}
                  className="rounded-md border border-white/35 px-2.5 py-[3px] text-[13px]"
                >
                  Undo
                </button>
              ) : null}
            </div>
          ) : null}
          {tab === "pending" && !readOnly && selKeys.length > 0 ? (
            <div
              className="bg-apollo-surface border-apollo-border-strong flex flex-wrap items-center gap-2.5 rounded-xl border py-2 pr-2.5 pl-4 text-[13.5px] shadow-[0_10px_30px_rgba(34,30,28,.14)]"
              data-slot="honors-bulk-bar"
            >
              <b className="font-semibold">{selKeys.length} selected</b>
              {selKeys.length > approvable ? (
                <span className="text-apollo-amber text-[12.5px]">
                  {selKeys.length - approvable} need a pick, skipped on approve
                </span>
              ) : null}
              <Button
                size="sm"
                disabled={busy || approvable === 0}
                onClick={() => void decide(selKeys, "approve")}
                className="bg-apollo-slate hover:bg-apollo-slate/90 text-[13px] text-white"
              >
                Approve {approvable}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || !bulkReason}
                title={bulkReason ? undefined : "Pick a reason first"}
                onClick={() => void decide(selKeys, "reject", bulkReason)}
                className="text-destructive hover:bg-apollo-red-tint hover:text-destructive text-[13px] font-normal"
              >
                Reject {selKeys.length}
              </Button>
              <ReasonSelect value={bulkReason} onChange={setBulkReason} disabled={busy} small />
              <button
                type="button"
                onClick={() => setSelected({})}
                className="text-muted-foreground flex items-center gap-1.5 text-[13px]"
              >
                Clear
                <span aria-hidden className="hidden md:inline">
                  <Kbd>Esc</Kbd>
                </span>
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Keep a keyboard-moved row visible inside the list's own scroll box. */
function scrollRowIntoView(key: string) {
  // Matched by attribute value, not a selector: a line key is a URL and may carry
  // characters a selector would need escaped.
  const el = [...document.querySelectorAll<HTMLElement>("[data-row]")].find(
    (r) => r.dataset.row === key,
  );
  el?.scrollIntoView?.({ block: "nearest" });
}

function ToolbarSelect({
  label,
  slot,
  value,
  onChange,
  options,
}: {
  label: string;
  slot: string;
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<readonly [string, string]>;
}) {
  return (
    <label className="text-muted-foreground flex items-center gap-1.5 text-[13px]" data-slot={slot}>
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="border-apollo-border-strong bg-apollo-surface text-foreground h-[34px] max-w-[240px] rounded-lg border px-2 text-[13px]"
      >
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </label>
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

const RECORD_COLS: Record<"approved" | "rejected" | "self", string> = {
  approved: "sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1.3fr)_minmax(0,1.3fr)_100px_110px_220px]",
  rejected: "sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1.4fr)_minmax(0,1.2fr)_70px_150px_110px_90px]",
  self: "sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1.2fr)_minmax(0,1.2fr)_70px_110px_120px_90px]",
};

const RECORD_HEADS: Record<"approved" | "rejected" | "self", string[]> = {
  approved: ["Scholar", "Honor", "Organization", "Year", "Added", ""],
  rejected: ["Scholar", "Honor", "Organization", "Year", "Reason", "Rejected on", ""],
  self: ["Scholar", "Honor", "Organization", "Year", "Added", "Status", ""],
};

/** Known (approve-side) rows a curator may send back to Possible: anything the
 *  queue decided or a feed seeded. Hand-entered rows never came through it. */
function reopenable(row: HonorQueueRow): boolean {
  return !row.superseded && row.source !== "CURATOR" && row.source !== "SELF";
}

const rowAction =
  "text-apollo-slate hover:bg-apollo-surface-2 rounded-md px-2 py-1 text-[13px] whitespace-nowrap disabled:opacity-60";

/** Known / Rejected / User asserted: one row per honor with a Scholar column,
 *  flat or under scholar headings, each row with its action. */
function RecordTable({
  kind,
  sections,
  shown,
  total,
  narrowing,
  empty,
  readOnly,
  busy,
  degrees,
  summary,
  evOpen,
  onToggleEvidence,
  onReopen,
  onVerify,
}: {
  kind: "approved" | "rejected" | "self";
  sections: ListSection[];
  shown: number;
  total: number;
  narrowing: string | null;
  empty: string;
  readOnly: boolean;
  busy: boolean;
  degrees: Record<string, DoctoralDegree>;
  summary: HonorSourcesSummary;
  evOpen: Record<string, true>;
  onToggleEvidence: (id: string) => void;
  onReopen: (row: HonorQueueRow) => void;
  onVerify: (row: HonorQueueRow, verified: boolean) => void;
}) {
  const cols = RECORD_COLS[kind];
  const heads = RECORD_HEADS[kind];
  const rows = sections.flatMap((x) => x.rows);
  const predates =
    kind === "rejected"
      ? rows.filter((r) => predatesDegreeNote(r.year, degrees[r.cwid])).length
      : 0;

  const year = (row: HonorQueueRow) =>
    row.year === null ? (
      <span className="bg-apollo-amber-tint text-apollo-amber rounded-full px-2 py-0.5 text-xs whitespace-nowrap">
        Year unknown
      </span>
    ) : (
      row.year
    );

  const cells = (row: HonorQueueRow): ReactNode[] => {
    const lead = [
      <span key="s" className="min-w-0 basis-full font-medium sm:basis-auto">
        {row.scholarName}
      </span>,
      kind === "rejected" ? (
        <span key="h" className="flex min-w-0 flex-col gap-0.5">
          <span>{row.name}</span>
          {predatesDegreeNote(row.year, degrees[row.cwid]) ? (
            <span className="text-apollo-amber text-xs" data-slot="honor-predates-degree">
              {predatesDegreeNote(row.year, degrees[row.cwid])}
            </span>
          ) : null}
        </span>
      ) : (
        <span key="h" className="min-w-0">
          {row.name}
        </span>
      ),
      <span key="o" className="text-muted-foreground min-w-0">
        {row.organization}
      </span>,
      <span key="y" className="tabular-nums">
        {year(row)}
      </span>,
    ];
    if (kind === "approved")
      return [
        ...lead,
        <span key="a" className="text-muted-foreground">
          {formatDecided(row.decidedAt)}
        </span>,
        <span key="x" className="flex gap-0.5 sm:justify-end">
          <button type="button" onClick={() => onToggleEvidence(row.id)} className={rowAction}>
            {evOpen[row.id] ? "Hide evidence" : "View evidence"}
          </button>
          {readOnly || !reopenable(row) ? null : (
            <button
              type="button"
              disabled={busy}
              onClick={() => onReopen(row)}
              className={cn(rowAction, "text-muted-foreground")}
              data-slot="honor-move-to-possible"
            >
              Move to Possible
            </button>
          )}
        </span>,
      ];
    if (kind === "rejected")
      return [
        ...lead,
        <span key="r">
          {row.rejectionReason ?? <span className="text-muted-foreground">Not recorded</span>}
        </span>,
        <span key="d" className="text-muted-foreground">
          {formatDecided(row.decidedAt)}
        </span>,
        <span key="x" className="flex sm:justify-end">
          {readOnly || !reopenable(row) ? null : (
            <button
              type="button"
              disabled={busy}
              onClick={() => onReopen(row)}
              className={rowAction}
              data-slot="honor-restore"
            >
              Restore
            </button>
          )}
        </span>,
      ];
    return [
      ...lead,
      <span key="a" className="text-muted-foreground">
        {formatDecided(row.createdAt)}
      </span>,
      <span key="st">
        {row.verified ? (
          <span className="bg-apollo-slate-tint text-apollo-slate rounded-full px-[9px] py-0.5 text-xs whitespace-nowrap">
            Verified
          </span>
        ) : (
          <span className="bg-apollo-surface-2 rounded-full px-[9px] py-0.5 text-xs whitespace-nowrap text-[#3a3532]">
            Self-reported
          </span>
        )}
      </span>,
      <span key="x" className="flex sm:justify-end">
        {readOnly ? null : (
          <button
            type="button"
            disabled={busy}
            onClick={() => onVerify(row, !row.verified)}
            className={rowAction}
            data-slot="honor-verify"
          >
            {row.verified ? "Unverify" : "Verify"}
          </button>
        )}
      </span>,
    ];
  };

  return (
    <div className="flex flex-col gap-3">
      {predates > 0 ? (
        <div
          className="bg-apollo-amber-tint border-apollo-amber-tint-border rounded-lg border px-3 py-[9px] text-[13px] text-[#3a3532]"
          data-slot="honors-predates-note"
        >
          {predates} of these {predates === 1 ? "was" : "were"} awarded before the scholar’s degree.
        </div>
      ) : null}
      <div
        className="bg-apollo-surface border-apollo-border-strong overflow-hidden rounded-[var(--apollo-radius-card)] border"
        data-slot={`honors-${kind}-table`}
      >
        <div
          className={cn(
            "bg-apollo-surface-2 border-apollo-border-strong text-muted-foreground hidden gap-4 border-b px-5 py-3 text-[11.5px] font-semibold tracking-[0.08em] uppercase sm:grid",
            cols,
          )}
          aria-hidden
        >
          {heads.map((h, i) => (
            <span key={i}>{h}</span>
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
          sections.map((section) => (
            <div
              key={section.key}
              data-slot={section.label ? "honor-list-section" : "honor-list-flat"}
            >
              {section.label ? (
                <div className="bg-apollo-page border-apollo-border flex items-baseline gap-2 border-b px-5 py-[9px] text-sm font-medium">
                  <span data-slot="honor-list-heading">{section.label}</span>
                  <span className="text-muted-foreground text-[12.5px] font-normal">
                    {section.sub}
                  </span>
                </div>
              ) : null}
              <ul data-slot={`honors-${kind}-list`}>
                {section.rows.map((row) => (
                  <li key={row.id} className="border-apollo-border border-b">
                    <div
                      className={cn(
                        "flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-[11px] text-[13.5px] sm:grid",
                        cols,
                      )}
                    >
                      {cells(row).map((c, i) => (
                        <Fragment key={i}>{c}</Fragment>
                      ))}
                    </div>
                    {kind === "approved" && evOpen[row.id] ? (
                      <RecordEvidence row={row} summary={summary} />
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
        <div
          className="text-muted-foreground px-5 py-[11px] text-[13px]"
          data-slot="honors-list-footer"
        >
          Showing {shown.toLocaleString("en-US")} of {total.toLocaleString("en-US")}
          {narrowing ? ` · ${narrowing}` : ""}
        </div>
      </div>
    </div>
  );
}

/** Known's expanded evidence: the quote the match rested on, and its source. */
function RecordEvidence({ row, summary }: { row: HonorQueueRow; summary: HonorSourcesSummary }) {
  const { quote, note } = parseEvidence(row.evidence);
  const key = row.sourceRef ? rosterKey(row.sourceRef) : null;
  const url = rosterSourceUrl(row.sourceRef);
  return (
    <div
      className="flex max-w-[820px] flex-col gap-2 px-5 pb-3.5"
      data-slot="honor-record-evidence"
    >
      {quote !== null ? (
        <EvidenceQuote
          quote={quote}
          group={{
            key: row.id,
            rows: [row],
            rosterMatchedName: rosterMatchedName(row.sourceRef),
            contested: false,
          }}
          small
        />
      ) : note !== null ? (
        <p className="text-muted-foreground m-0 text-[13.5px]">{note}</p>
      ) : null}
      <span className="text-muted-foreground text-[12.5px]">
        {key ? `Matched from ${sourcePhrase(key, summary)}` : "Added by hand, no source list"}
        {url ? (
          <>
            {" · "}
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-apollo-slate hover:underline"
            >
              source list ↗
            </a>
          </>
        ) : null}
      </span>
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

const SOURCE_COLS = "sm:grid-cols-[minmax(0,2.2fr)_80px_150px_76px_110px_92px]";

/** A list's WCM match count, as a link into Possible filtered to that list. */
function WcmCount({
  n,
  title,
  onClick,
}: {
  n: number | null | undefined;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="text-apollo-slate font-semibold whitespace-nowrap tabular-nums"
      data-slot="honors-source-wcm"
    >
      {count(n)} →<span className="font-normal sm:hidden"> WCM</span>
    </button>
  );
}

/** "Sep 1, 2026" — a list run's date. */
function formatRunDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function listRunStatus(run: HonorListRunView | null): { label: string; dot: string; ink: string } {
  switch (run?.status) {
    case "success":
      return { label: "Succeeded", dot: "bg-apollo-slate", ink: "text-muted-foreground" };
    case "partial":
      return { label: "Partial", dot: "bg-apollo-amber", ink: "text-apollo-amber" };
    case "failed":
      return { label: "Failed", dot: "bg-destructive", ink: "text-destructive" };
    case "stalled":
      return { label: "Did not finish", dot: "bg-destructive", ink: "text-destructive" };
    case "queued":
      return { label: "Queued", dot: "bg-apollo-slate", ink: "text-apollo-slate" };
    case "running":
      return { label: "Running now…", dot: "bg-apollo-slate", ink: "text-apollo-slate" };
    default:
      return { label: "Not run yet", dot: "bg-apollo-border-strong", ink: "text-muted-foreground" };
  }
}

/** The error line shown under a list: the latest run's, when it did not succeed. */
function listRunError(run: HonorListRunView | null): string | null {
  if (!run) return null;
  if (run.status === "stalled")
    return "The run did not finish. Run it again, or check the ETL logs.";
  if (run.status === "failed" || run.status === "partial") return run.errorMessage;
  return null;
}

const count = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString("en-US"));

/** How often a queued/running list re-reads its status. */
const RUN_POLL_MS = 20_000;

/**
 * Sources: every honor list the queue's matches come from.
 *
 *  - SCRAPED lists (`lib/honors/lists.ts`) run weekly on the deployed honors
 *    scrape. Each shows its latest run (date, status, on-list size, WCM matches)
 *    and, when HONORS_RUN_NOW is on, a Run now that queues one scrape of that
 *    list. A queued or running list polls until it finishes.
 *  - Every other roster the queue's rows came from was loaded by the
 *    operator-run seed import: Schedule "Manual", no Run now.
 */
function SourcesPanel({
  summary,
  empty,
  runNowEnabled,
  pendingTotal,
  onOpenPossible,
}: {
  summary: HonorSourcesSummary;
  empty: string;
  runNowEnabled: boolean;
  /** Possible's count: the header's "N pending review →". */
  pendingTotal: number;
  /** Open Possible, narrowed to one source (a roster key) or not at all. */
  onOpenPossible: (sourceKey: string | null) => void;
}) {
  const router = useRouter();
  const { sources, runs, lists } = summary;
  const last = runs[0] ?? null;
  const lastStatus = last ? runStatus(last) : null;
  const scrapedUrls = new Set(lists.map((l) => l.rosterUrl));
  const manual = sources.filter((s) => !scrapedUrls.has(s.key));
  const rollupByUrl = new Map(sources.map((s) => [s.key, s]));
  const partial = lists.filter((l) => l.latest?.status === "partial").length;
  const failed = lists.filter(
    (l) => l.latest?.status === "failed" || l.latest?.status === "stalled",
  ).length;
  const total = lists.length + manual.length;

  /** List id -> when this page asked for a run, until the server shows it. */
  const [requested, setRequested] = useState<Record<string, number>>({});
  const [runBusy, setRunBusy] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const isPending = (l: HonorListStatus) => {
    if (l.active) return true;
    const at = requested[l.id];
    if (at === undefined) return false;
    // Settled once the server shows a run created since the request (a minute
    // of clock-skew slack) that is no longer active.
    return !(l.latest && Date.parse(l.latest.createdAt) >= at - 60_000);
  };
  const anyActive = lists.some(isPending);

  // While anything is queued or running, re-read the page so the row flips to
  // its result without a manual reload.
  useEffect(() => {
    if (!anyActive) return;
    const t = setInterval(() => router.refresh(), RUN_POLL_MS);
    return () => clearInterval(t);
  }, [anyActive, router]);

  async function runNow(listId: string) {
    setRunBusy(listId);
    setRunError(null);
    try {
      const res = await fetch("/api/edit/honor/sources/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ list: listId }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && json.ok) {
        setRequested((r) => ({ ...r, [listId]: Date.now() }));
        router.refresh();
      } else if (json.error === "already_running") {
        setRequested((r) => ({ ...r, [listId]: Date.now() }));
        setRunError("That list is already queued or running.");
        router.refresh();
      } else {
        setRunError("The run could not be started. Try again, or ask an administrator.");
      }
    } catch {
      setRunError("The run could not be started. Check your connection and try again.");
    } finally {
      setRunBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-4" data-slot="honors-sources">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-[15px]">
        <span className="text-muted-foreground whitespace-nowrap">
          <span className="text-foreground font-semibold tabular-nums">{total}</span> honor list
          {total === 1 ? "" : "s"}
        </span>
        <span className="text-muted-foreground whitespace-nowrap">
          <span className="text-apollo-amber font-semibold tabular-nums">{partial}</span> partial
        </span>
        <span className="text-muted-foreground whitespace-nowrap">
          <span className="text-destructive font-semibold tabular-nums">{failed}</span> failed
        </span>
        <button
          type="button"
          onClick={() => onOpenPossible(null)}
          className="text-apollo-slate whitespace-nowrap"
          data-slot="honors-sources-pending"
        >
          <span className="font-semibold tabular-nums">{pendingTotal.toLocaleString("en-US")}</span>{" "}
          pending review →
        </button>
      </div>

      {runError ? (
        <p className="text-destructive m-0 text-[13px]" role="alert" data-slot="honors-run-error">
          {runError}
        </p>
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
          <span>Last run</span>
          <span className="text-right">On list</span>
          <span className="text-right">WCM matches</span>
          <span />
        </div>
        {total === 0 ? (
          <div className="text-muted-foreground p-8 text-center text-sm">{empty}</div>
        ) : (
          <ul>
            {lists.map((l, i) => {
              const shownRun = l.latest;
              const st = listRunStatus(shownRun);
              const counts = l.lastFinished?.status === "failed" ? null : l.lastFinished;
              const pending = isPending(l);
              const err = listRunError(shownRun);
              const rollup = rollupByUrl.get(l.rosterUrl);
              return (
                <li
                  key={l.id}
                  className={cn(i > 0 && "border-apollo-border border-t")}
                  data-slot="honors-list"
                  data-list={l.id}
                >
                  <div
                    className={cn(
                      "flex flex-wrap items-center gap-x-3.5 gap-y-1 px-5 py-2.5 text-sm sm:grid",
                      SOURCE_COLS,
                    )}
                  >
                    <span className="flex min-w-0 basis-full flex-col gap-0.5 sm:basis-auto">
                      <span className="truncate font-medium">{l.honorName}</span>
                      <span className="text-muted-foreground truncate text-[12.5px]">
                        {l.organization}
                        {" · "}
                        <a
                          href={l.rosterUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-apollo-slate font-mono text-xs hover:underline"
                        >
                          {l.host}
                        </a>
                      </span>
                    </span>
                    <span className="text-muted-foreground text-[13px]">{l.schedule}</span>
                    <span className="flex flex-col gap-0.5" data-slot="honors-list-last-run">
                      <span className="inline-flex items-center gap-1.5 text-[13px]">
                        <span className={cn("size-2 flex-none rounded-full", st.dot)} aria-hidden />
                        {shownRun ? formatRunDate(shownRun.finishedAt ?? shownRun.createdAt) : "—"}
                      </span>
                      <span className={cn("text-xs", st.ink)}>{st.label}</span>
                    </span>
                    <span className="text-[13px] tabular-nums sm:text-right sm:text-sm">
                      {count(counts?.onListTotal)}
                      <span className="text-muted-foreground sm:hidden"> on list</span>
                    </span>
                    <span className="text-[13px] tabular-nums sm:text-right sm:text-sm">
                      <WcmCount
                        n={counts?.matched}
                        title={
                          rollup
                            ? `${rollup.pendingLines} waiting · ${rollup.approved} approved. Open matches in Possible`
                            : "Open matches in Possible"
                        }
                        onClick={() => onOpenPossible(l.rosterUrl)}
                      />
                    </span>
                    <span className="flex sm:justify-end">
                      {runNowEnabled ? (
                        <button
                          type="button"
                          onClick={() => runNow(l.id)}
                          disabled={pending || runBusy !== null}
                          className="border-apollo-border-strong bg-apollo-surface hover:bg-apollo-surface-2 h-7 rounded-md border px-2.5 text-[12.5px] whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-60"
                          data-slot="honors-run-now"
                        >
                          {runBusy === l.id
                            ? "Starting…"
                            : pending
                              ? l.latest?.status === "running"
                                ? "Running…"
                                : "Queued"
                              : "Run now"}
                        </button>
                      ) : null}
                    </span>
                  </div>
                  {err ? (
                    <div
                      className="border-apollo-red-tint-border bg-apollo-red-tint text-destructive mx-5 mb-2.5 rounded-md border px-2.5 py-1.5 font-mono text-[12.5px] [overflow-wrap:anywhere]"
                      data-slot="honors-list-error"
                    >
                      {err}
                    </div>
                  ) : null}
                </li>
              );
            })}
            {manual.map((s, i) => (
              <li
                key={s.key}
                className={cn(
                  "flex flex-wrap items-center gap-x-3.5 gap-y-1 px-5 py-2.5 text-sm sm:grid",
                  SOURCE_COLS,
                  (i > 0 || lists.length > 0) && "border-apollo-border border-t",
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
                <span className="text-muted-foreground text-[13px]">Seed import</span>
                <span className="text-muted-foreground text-[13px] sm:text-right sm:text-sm">
                  —
                </span>
                <span className="text-[13px] tabular-nums sm:text-right sm:text-sm">
                  <WcmCount
                    n={s.lines}
                    title="Open matches in Possible"
                    onClick={() => onOpenPossible(s.key)}
                  />
                </span>
                <span />
              </li>
            ))}
          </ul>
        )}
        <div className="bg-apollo-page border-apollo-border text-muted-foreground border-t px-5 py-3 text-[13px]">
          New matches from each run land in Possible, and nothing is approved automatically.
          &ldquo;On list&rdquo; counts the entries read from the list; &ldquo;WCM matches&rdquo;
          counts those matched to a Weill Cornell scholar. &ldquo;Manual&rdquo; lists come from the
          operator-run seed import. Click a WCM count to review that list&rsquo;s matches.
        </div>
      </div>

      <div
        className="text-muted-foreground inline-flex flex-wrap items-center gap-1.5 text-[13px]"
        data-slot="honors-sources-last-run"
      >
        {last && lastStatus ? (
          <>
            <span className={cn("size-2 flex-none rounded-full", lastStatus.dot)} aria-hidden />
            Last full load {formatRunTime(last.startedAt)} ·{" "}
            <span className={lastStatus.ink}>{lastStatus.label}</span> ·{" "}
            {last.rowsProcessed.toLocaleString("en-US")} rows
          </>
        ) : (
          "No full load recorded yet"
        )}
      </div>

      {last?.status === "failed" && last.errorMessage ? (
        <div
          className="border-apollo-red-tint-border bg-apollo-red-tint text-destructive rounded-md border px-2.5 py-1.5 font-mono text-[12.5px] [overflow-wrap:anywhere]"
          data-slot="honors-sources-error"
        >
          {last.errorMessage}
        </div>
      ) : null}

      {runs.length > 1 ? (
        <details className="text-[13px]" data-slot="honors-sources-runs">
          <summary
            className={`text-muted-foreground flex w-fit cursor-pointer items-center gap-1 ${SUMMARY_NO_MARKER}`}
          >
            <Caret />
            Earlier loads
          </summary>
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
