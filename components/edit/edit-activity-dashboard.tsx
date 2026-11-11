/**
 * The `/edit/activity` body (2026-11 redesign): who-made-the-edits tiles
 * (all / faculty on their own profile / staff on someone's behalf /
 * automated), a "profiles that gained content" row, an edits-per-day chart
 * stacked by editor kind, Top editors (tagged Self / Staff / Automated) beside
 * Most-edited fields, and a paged Recent activity feed.
 *
 * The tiles, chart and panels are a view over the one server read
 * (`loadEditActivitySummary`, incl. its window-wide `analytics`). The feed
 * starts with the most recent `EDIT_ACTIVITY_RECENT_LIMIT` edits; paging past
 * them pulls the next page from `GET /api/edit/activity/recent` (a `(ts, id)`
 * cursor, same gate). Grouping and every filter re-run over the whole loaded
 * list, so a run that straddles a page boundary merges.
 *
 * Feed rows: with "Group repeated saves" on, one editor's consecutive saves to
 * one entity (gaps under {@link SESSION_GAP_MS}) collapse into one row showing
 * the NET change per field; one automated actor's consecutive same-action
 * edits collapse into one run; a View-as start/end pair becomes one audit row.
 *
 * Client-safe: imports only pure helpers (`edit-activity.ts` and
 * `scholar-audit.ts` carry type-only Prisma imports).
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { Search, X } from "lucide-react";

import { LockedBadge } from "@/components/edit/locked-badge";
import { Button } from "@/components/ui/button";
import {
  AUDIT_ACTIONS,
  EDIT_ACTIVITY_RANGES,
  type EditActivityRange,
  EDIT_ACTIVITY_TZ,
  type EditActivityPage,
  type EditActivitySummary,
  type EditorKind,
  type RecentEdit,
  easternDayKey,
  editorKind,
  fieldId,
  fieldIdLabel,
  isEmptyValue,
  isSystemActor,
} from "@/lib/api/edit-activity";
import { humanizeField, labelForAction } from "@/lib/api/scholar-audit";
import { cn } from "@/lib/utils";

export { easternDayKey };

/** Feed rows per page. */
const PAGE_ROWS = 25;
/** Rows a ranked list shows before "Show all". */
const LIST_TOP = 8;
/** One editor's saves closer together than this are one working session. */
export const SESSION_GAP_MS = 30 * 60_000;
/** Above this length a text value is excerpted / word-diffed. */
const LONG_TEXT = 90;
/** Fields whose value normally comes from a system of record; an edit here is
 *  an override of source data, so the feed flags it with the lock pill. */
const SOURCE_MANAGED: ReadonlySet<string> = new Set(["primaryTitle"]);
/** List items (mentees, PMIDs, run members) shown before "Show". */
const ITEMS_SHOWN = 5;

/** Counts in one fixed locale, so the server render and the browser agree. */
const fmt = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, word: string) => `${fmt(n)} ${word}${n === 1 ? "" : "s"}`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** An ISO instant's Eastern wall-clock time, "HH:mm". */
function easternTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: EDIT_ACTIVITY_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);
}

/** "YYYY-MM-DD" → a UTC-noon Date (calendar math with no tz drift). */
function keyDate(key: string): Date {
  return new Date(`${key}T12:00:00Z`);
}
/** "Sep 24". */
function dayLabel(key: string): string {
  const d = keyDate(key);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
/** "Wed, Sep 24". */
function dayHeading(key: string): string {
  return `${WEEKDAYS[keyDate(key).getUTCDay()]}, ${dayLabel(key)}`;
}
function isWeekend(key: string): boolean {
  const dow = keyDate(key).getUTCDay();
  return dow === 0 || dow === 6;
}

/** The Monday that starts `key`'s week. */
export function mondayOf(key: string): string {
  const d = keyDate(key);
  return new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
}

/** Past this many days the chart draws one bar per week. */
export const WEEKLY_AFTER_DAYS = 92;

/** The `days` calendar keys ending on `lastKey`, oldest first. */
export function dayAxis(lastKey: string, days: number): string[] {
  const end = keyDate(lastKey).getTime();
  return Array.from({ length: days }, (_, i) =>
    new Date(end - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10),
  );
}

/** A round axis maximum at or above `n` (1 / 2 / 2.5 / 5 × 10^k). */
export function niceMax(n: number): number {
  if (n <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(n));
  // Even-friendly steps so the midline usually lands on a whole number.
  for (const m of [1, 2, 3, 4, 5, 6, 8, 10]) if (m * pow >= n) return m * pow;
  return 10 * pow;
}

// ── Categories ─────────────────────────────────────────────────────────────

const PROFILE_ACTIONS = new Set([
  "field_override",
  "field_override_clear",
  "orcid_set",
  "orcid_librarian_confirm",
  "request_change",
  "suppression_create",
  "suppression_revoke",
  "publication_reject",
  "appointment_visibility_set",
  "profile_appointment_create",
  "profile_appointment_update",
  "profile_appointment_delete",
  "honor_create",
  "honor_update",
  "honor_delete",
  "slug_request",
  "slug_request_approved",
  "slug_request_rejected",
  "slug_request_withdrawn",
  "biosketch_generation_delete",
]);
const ROSTER_ACTIONS = new Set([
  "unit_create",
  "roster_change",
  "grant_change",
  "role_vocabulary_create",
  "role_vocabulary_update",
  "role_vocabulary_delete",
  "disease_assignment_decision",
  "disease_auto_publish_set",
  "core_claim",
  "core_client_add",
  "core_client_remove",
  "core_staff_add",
  "core_staff_remove",
]);
const NEWS_ACTIONS = new Set(["news_mention_update"]);
const ACCESS_ACTIONS = new Set([
  "proxy_grant",
  "proxy_revoke",
  "report_access_grant",
  "report_access_revoke",
  "functional_role_grant",
  "functional_role_revoke",
]);
const NAMED = [PROFILE_ACTIONS, ROSTER_ACTIONS, NEWS_ACTIONS, ACCESS_ACTIONS];

/** The feed's category chips. "All" leaves out View-as sessions; they (and any
 *  action no other chip claims) live under "Audit & operations". */
export const CATEGORIES: ReadonlyArray<{ key: string; label: string; test: (action: string) => boolean }> = [
  { key: "all", label: "All", test: (a) => !AUDIT_ACTIONS.has(a) },
  { key: "profile", label: "Profile content", test: (a) => PROFILE_ACTIONS.has(a) },
  { key: "roster", label: "Roster & roles", test: (a) => ROSTER_ACTIONS.has(a) },
  { key: "news", label: "News mentions", test: (a) => NEWS_ACTIONS.has(a) },
  { key: "access", label: "Access", test: (a) => ACCESS_ACTIONS.has(a) },
  {
    key: "audit",
    label: "Audit & operations",
    test: (a) => AUDIT_ACTIONS.has(a) || !NAMED.some((s) => s.has(a)),
  },
];

// ── Kind styling ───────────────────────────────────────────────────────────

const KIND: Record<EditorKind, { tag: string; legend: string; bar: string; chip: string }> = {
  self: {
    tag: "Self",
    legend: "Faculty, own profile",
    bar: "bg-apollo-slate",
    chip: "bg-apollo-slate-tint border-apollo-slate-tint-border text-apollo-slate",
  },
  staff: {
    tag: "Staff",
    legend: "Staff, on behalf",
    bar: "bg-[#8fa6bf]",
    chip: "bg-apollo-surface-2 border-apollo-border-strong text-foreground",
  },
  automated: {
    tag: "Automated",
    legend: "Automated",
    bar: "bg-[#a39486]",
    chip: "bg-apollo-lock-bg border-apollo-border-strong text-foreground",
  },
};
const KIND_ORDER: EditorKind[] = ["self", "staff", "automated"];

/** "system-autolock" → "autolock"; "ETL" stays. */
function automatedLabel(cwid: string): string {
  return cwid.replace(/^system-/, "");
}

// ── Value helpers ──────────────────────────────────────────────────────────

/** Parse a stored value that may itself be JSON-encoded (arrays, link maps). */
function parseValue(v: string | null): unknown {
  if (v === null) return null;
  const t = v.trim();
  if (t.startsWith("[") || t.startsWith("{")) {
    try {
      return JSON.parse(t);
    } catch {
      return v;
    }
  }
  return v;
}

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };

/** Overview and other rich text are stored as HTML; show words, not tags. */
export function plainText(v: string): string {
  return v
    .replace(/<[^>]+>/g, " ")
    // One pass, so "&amp;lt;" decodes to "&lt;" and never on to "<".
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, (_m, e: string) => ENTITIES[e]!)
    .replace(/\s+/g, " ")
    .trim();
}

/** Same value once formatting is ignored (ORCID URL vs bare iD, whitespace, tags). */
export function sameIgnoringFormat(a: string | null, b: string | null): boolean {
  const norm = (v: string | null) =>
    v === null ? "" : plainText(v).toLowerCase().replace(/https?:\/\/(www\.)?orcid\.org\//, "").replace(/[^a-z0-9]/g, "");
  return norm(a) === norm(b);
}

/** One list item's display label. */
function itemLabel(
  fieldKey: string,
  item: unknown,
  titles: Record<string, string> = {},
): { id: string; label: string; note: string | null } {
  if (typeof item === "string" || typeof item === "number") {
    const s = String(item);
    if (fieldKey !== "selectedHighlightPmids") return { id: s, label: s, note: null };
    const title = titles[s];
    return title ? { id: s, label: plainText(title), note: `PMID ${s}` } : { id: s, label: `PMID ${s}`, note: null };
  }
  if (item && typeof item === "object") {
    const o = item as Record<string, unknown>;
    const name = [o.name, o.title, o.label].find((x) => typeof x === "string") as string | undefined;
    const note = [o.programLabel, o.year].filter((x) => x !== undefined && x !== null && x !== "").join(" · ");
    return { id: JSON.stringify(o), label: name ?? JSON.stringify(o), note: note || null };
  }
  return { id: String(item), label: String(item), note: null };
}

export type WordDiffPart = { kind: "same" | "del" | "ins"; text: string };

/**
 * Word-level diff (LCS). Inputs are capped so a pathological pair stays
 * cheap; past the cap the tail is reported as one replaced chunk.
 */
export function wordDiff(before: string, after: string, cap = 1500): WordDiffPart[] {
  const a = before.split(/\s+/).filter(Boolean);
  const b = after.split(/\s+/).filter(Boolean);
  const A = a.slice(0, cap);
  const B = b.slice(0, cap);
  const n = A.length;
  const m = B.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i]![j] = A[i] === B[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: WordDiffPart[] = [];
  const push = (kind: WordDiffPart["kind"], w: string) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += ` ${w}`;
    else out.push({ kind, text: w });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      push("same", A[i]!);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) push("del", A[i++]!);
    else push("ins", B[j++]!);
  }
  while (i < n) push("del", A[i++]!);
  while (j < m) push("ins", B[j++]!);
  if (a.length > cap) push("del", a.slice(cap).join(" "));
  if (b.length > cap) push("ins", b.slice(cap).join(" "));
  return out;
}

/** Keep only the changed words plus a few words of context either side. */
function changedOnly(parts: WordDiffPart[], context = 6): WordDiffPart[] {
  return parts.map((p, i) => {
    if (p.kind !== "same") return p;
    const words = p.text.split(" ");
    const first = i === 0;
    const last = i === parts.length - 1;
    if (words.length <= context * 2 && !first && !last) return p;
    const head = first ? [] : words.slice(0, context);
    const tail = last ? [] : words.slice(-context);
    if (head.length + tail.length >= words.length) return p;
    return { kind: "same", text: [head.join(" "), "…", tail.join(" ")].filter(Boolean).join(" ") };
  });
}

// ── Feed rows ──────────────────────────────────────────────────────────────

/** One field's net change across a row's saves. */
export type NetChange = { key: string; field: string; before: string | null; after: string | null; saves: number };

export type FeedRow = {
  key: string;
  day: string;
  kind: EditorKind | "audit";
  /**
   * How the edits were folded: `session` = one editor, one entity;
   * `bulk` = one editor making the identical change on several entities;
   * `contested` = more than one person editing the same field of one entity;
   * `run` = one automated actor's same-action batch; `audit` = View-as.
   */
  mode: "session" | "bulk" | "contested" | "run" | "audit";
  /** Newest first. */
  edits: RecentEdit[];
};

function rowKindOf(e: RecentEdit): FeedRow["kind"] {
  return AUDIT_ACTIONS.has(e.action) ? "audit" : editorKind(e);
}

/** What an edit did, independent of whom it did it to. */
function changeSignature(e: RecentEdit): string | null {
  if (e.changes.length === 0) return null;
  return JSON.stringify([e.action, e.changes.map((c) => [c.key, c.after])]);
}

const sameEntity = (a: RecentEdit, b: RecentEdit) =>
  a.entityType === b.entityType && a.entityId === b.entityId;

/**
 * Edits (newest first) → feed rows. With `group`, an edit on the same day,
 * within {@link SESSION_GAP_MS} of the row's last edit, joins that row when:
 *  - audit: the same actor's View-as start/end on the same scholar;
 *  - automated: the same actor and action (a run, any entity);
 *  - session: the same actor and View-as identity on the same entity;
 *  - contested: ANOTHER person on the same entity, touching a field the row
 *    already touched (a back-and-forth worth flagging);
 *  - bulk: the same actor making the identical change on another entity.
 */
export function buildRows(edits: ReadonlyArray<RecentEdit>, group: boolean): FeedRow[] {
  const out: FeedRow[] = [];
  for (const e of edits) {
    const day = easternDayKey(e.ts);
    const kind = rowKindOf(e);
    let target: FeedRow | null = null;
    let mode: FeedRow["mode"] | null = null;
    // Look back past interleaved rows (someone else's edit in between) to any
    // row from the same day whose latest edit is within the gap.
    // ponytail: linear lookback, bounded by the gap; fine for 100-edit pages.
    for (let k = out.length - 1; group && k >= 0 && !mode; k--) {
      const last = out[k]!;
      const prev = last.edits[last.edits.length - 1]!;
      if (last.day !== day) break;
      if (new Date(prev.ts).getTime() - new Date(e.ts).getTime() > SESSION_GAP_MS) break;
      mode = joinMode(last, prev, e, kind);
      if (mode) target = last;
    }
    if (target && mode) {
      target.edits.push(e);
      target.mode = mode;
    } else {
      out.push({
        key: e.id,
        day,
        kind,
        mode: kind === "audit" ? "audit" : kind === "automated" ? "run" : "session",
        edits: [e],
      });
    }
  }
  return out;
}

/** How `e` joins `row` (whose newest-joined edit is `prev`), or null. */
function joinMode(row: FeedRow, prev: RecentEdit, e: RecentEdit, kind: FeedRow["kind"]): FeedRow["mode"] | null {
  if (kind === "audit" || row.mode === "audit") {
    return kind === "audit" && row.mode === "audit" && prev.actorCwid === e.actorCwid && sameEntity(prev, e)
      ? "audit"
      : null;
  }
  if (kind === "automated" || row.mode === "run") {
    return kind === "automated" && row.mode === "run" && prev.actorCwid === e.actorCwid && prev.action === e.action
      ? "run"
      : null;
  }
  const sameActor = prev.actorCwid === e.actorCwid && prev.impersonatedCwid === e.impersonatedCwid;
  if (row.mode !== "bulk" && sameEntity(prev, e)) {
    if (row.mode === "session" && sameActor) return "session";
    const rowKeys = new Set(row.edits.flatMap((x) => x.changes.map((c) => c.key)));
    if (e.changes.some((c) => rowKeys.has(c.key))) return "contested";
    return null;
  }
  const sig = changeSignature(e);
  if (
    (row.mode === "bulk" || row.mode === "session") &&
    sameActor &&
    sig !== null &&
    row.edits.every((x) => changeSignature(x) === sig)
  )
    return "bulk";
  return null;
}

/** A row's field changes, folded to first-before → last-after per field. */
export function netChanges(edits: ReadonlyArray<RecentEdit>): NetChange[] {
  const byKey = new Map<string, NetChange>();
  // edits are newest first: walk oldest → newest.
  for (let i = edits.length - 1; i >= 0; i--) {
    for (const c of edits[i]!.changes) {
      const k = c.key ?? c.field;
      const cur = byKey.get(k);
      if (cur) {
        cur.after = c.after;
        cur.saves += 1;
      } else {
        byKey.set(k, { key: k, field: c.field, before: c.before, after: c.after, saves: 1 });
      }
    }
  }
  return [...byKey.values()];
}

/** True when an edit took `key` from empty to filled. */
function gainedIn(e: RecentEdit, key: string): boolean {
  return e.changes.some((c) => c.key === key && isEmptyValue(c.before) && !isEmptyValue(c.after));
}

/** Append `older` to `loaded`, dropping any id already present (a retried or
 *  double-clicked page must never duplicate rows). */
export function appendOlder(
  loaded: ReadonlyArray<RecentEdit>,
  older: ReadonlyArray<RecentEdit>,
): RecentEdit[] {
  const seen = new Set(loaded.map((e) => e.id));
  const fresh = older.filter((e) => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
  return [...loaded, ...fresh];
}

/** The per-entity history page, when one exists (scholar + center only). */
function historyHref(entityType: string, entityId: string): string | null {
  const id = encodeURIComponent(entityId);
  if (entityType === "scholar") return `/edit/scholar/${id}/history`;
  if (entityType === "center") return `/edit/center/${id}/history`;
  return null;
}


const CARD = "bg-apollo-surface border-apollo-border rounded-xl border";
const SMALL_CAPS = "text-muted-foreground text-xs font-medium tracking-[0.06em] uppercase";
const PILL = "rounded border px-1.5 text-xs whitespace-nowrap";
const LINKISH = "text-apollo-slate text-[13px] hover:underline";

/** Older feed pages loaded on demand, with the names they brought. */
type Older = {
  rows: RecentEdit[];
  publicationTitles: EditActivityPage["publicationTitles"];
  people: EditActivityPage["people"];
  entityNames: EditActivityPage["entityNames"];
};

export function EditActivityDashboard({ summary }: { summary: EditActivitySummary }) {
  const [older, setOlder] = React.useState<Older>({ rows: [], people: {}, entityNames: {}, publicationTitles: {} });
  const [cursor, setCursor] = React.useState<string | null>(summary.nextCursor);
  const [loadingOlder, setLoadingOlder] = React.useState(false);
  const [olderError, setOlderError] = React.useState(false);
  // A new summary starts a new feed (React's "adjust state on prop change"
  // pattern); the generation ref drops a page still in flight for the old one.
  const [feedAsOf, setFeedAsOf] = React.useState(summary.generatedAt);
  const feedGeneration = React.useRef(summary.generatedAt);
  if (feedAsOf !== summary.generatedAt) {
    setFeedAsOf(summary.generatedAt);
    setOlder({ rows: [], people: {}, entityNames: {}, publicationTitles: {} });
    setCursor(summary.nextCursor);
    setLoadingOlder(false);
    setOlderError(false);
  }
  React.useEffect(() => {
    feedGeneration.current = summary.generatedAt;
  }, [summary.generatedAt]);
  const people = { ...older.people, ...summary.people };
  const entityNames = { ...older.entityNames, ...summary.entityNames };
  const pubTitles = { ...older.publicationTitles, ...summary.publicationTitles };
  const recent = React.useMemo(
    () => appendOlder(summary.recent, older.rows),
    [summary.recent, older.rows],
  );

  /** Fetch the next older page; resolves true when rows were added. */
  async function loadOlder(): Promise<boolean> {
    if (!cursor || loadingOlder) return false;
    const asOf = summary.generatedAt;
    const stale = () => feedGeneration.current !== asOf;
    setLoadingOlder(true);
    setOlderError(false);
    try {
      const res = await fetch(
        `/api/edit/activity/recent?cursor=${encodeURIComponent(cursor)}&asOf=${encodeURIComponent(asOf)}${summary.range === "30d" ? "" : `&range=${summary.range}`}`,
        { cache: "no-store" },
      );
      const body = (await res.json().catch(() => null)) as
        | ({ ok: true } & EditActivityPage)
        | { ok: false }
        | null;
      if (stale()) return false;
      if (!res.ok || !body || !body.ok) throw new Error(`load older failed: ${res.status}`);
      setOlder((o) => ({
        rows: appendOlder(o.rows, body.recent),
        people: { ...o.people, ...body.people },
        entityNames: { ...o.entityNames, ...body.entityNames },
        publicationTitles: { ...o.publicationTitles, ...body.publicationTitles },
      }));
      setCursor(body.nextCursor);
      return body.recent.length > 0;
    } catch {
      if (!stale()) setOlderError(true);
      return false;
    } finally {
      if (!stale()) setLoadingOlder(false);
    }
  }

  // ── Filter state ───────────────────────────────────────────────────────────
  const [hover, setHover] = React.useState<string | null>(null);
  const [day, setDay] = React.useState<string | null>(null);
  const [editor, setEditor] = React.useState<string>("");
  const [field, setField] = React.useState<string>("");
  const [gainedOnly, setGainedOnly] = React.useState(false);
  const [category, setCategory] = React.useState("all");
  const [hideAutomated, setHideAutomated] = React.useState(false);
  const [group, setGroup] = React.useState(true);
  const [query, setQuery] = React.useState("");
  const [allEditors, setAllEditors] = React.useState(false);
  const [open, setOpen] = React.useState<ReadonlySet<string>>(() => new Set());
  const [page, setPage] = React.useState(0);

  const filterKey = [day, editor, field, gainedOnly, category, hideAutomated, group, query].join("|");
  const [pageFilterKey, setPageFilterKey] = React.useState(filterKey);
  if (pageFilterKey !== filterKey) {
    setPageFilterKey(filterKey);
    setPage(0);
  }

  const toggle = (k: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  // ── Names ──────────────────────────────────────────────────────────────────
  const personName = (cwid: string) => people[cwid]?.name ?? null;
  const actorName = (cwid: string) =>
    isSystemActor(cwid) ? cwid : (personName(cwid) ?? cwid);
  function entityText(type: string, id: string): string {
    if (type === "scholar") return personName(id) ?? id;
    return entityNames[`${type}:${id}`] ?? id;
  }

  // ── Tiles ──────────────────────────────────────────────────────────────────
  const a = summary.analytics;
  const total = summary.totalEdits;
  // Per-day counts come from the analytics fold (true Eastern days, DST-safe).
  const perDayTotal = new Map(a.perDay.map((d) => [d.day, d.self + d.staff + d.automated]));
  const days = dayAxis(easternDayKey(summary.generatedAt), summary.windowDays);
  const weekly = summary.windowDays > WEEKLY_AFTER_DAYS;
  const bucketOf = (dayKey: string) => (weekly ? mondayOf(dayKey) : dayKey);
  const axis = [...new Set(days.map(bucketOf))];
  const bucketLabel = (k: string) => (weekly ? `Week of ${dayLabel(k)}` : dayLabel(k));
  // Chart buckets: a day, or a Mon–Sun week; the busiest day's top editor stands in for the week's.
  const buckets = new Map<string, { self: number; staff: number; automated: number; topActor: string | null; top: number }>();
  for (const d of a.perDay) {
    const k = bucketOf(d.day);
    const b = buckets.get(k) ?? { self: 0, staff: 0, automated: 0, topActor: null, top: 0 };
    b.self += d.self;
    b.staff += d.staff;
    b.automated += d.automated;
    const n = d.self + d.staff + d.automated;
    if (n > b.top) [b.top, b.topActor] = [n, d.topActor];
    buckets.set(k, b);
  }
  const activeDays = a.perDay.filter((d) => d.self + d.staff + d.automated > 0).length;
  // "Nov 12, 2025": a long range needs the year to read unambiguously.
  const rangeDate = (k: string) => (weekly ? `${dayLabel(k)}, ${k.slice(0, 4)}` : dayLabel(k));
  const rangeInfo = EDIT_ACTIVITY_RANGES[summary.range];
  const inRange = summary.range === "all" ? "since tracking began" : `in the ${rangeInfo.label.toLowerCase()}`;
  const tiles: { label: string; value: string; sub: string; accent: string }[] = [
    { label: "All edits", value: fmt(total), sub: `On ${fmt(activeDays)} of ${fmt(summary.windowDays)} days`, accent: "border-t-apollo-bar" },
    {
      label: "Faculty, own profile",
      value: fmt(a.kinds.self),
      sub: `${fmt(a.selfEditors)} ${a.selfEditors === 1 ? "scholar" : "scholars"} edited their own profile`,
      accent: "border-t-apollo-slate",
    },
    {
      label: "Staff, on someone's behalf",
      value: fmt(a.kinds.staff),
      sub: a.topStaff
        ? `Largest: ${actorName(a.topStaff.actorCwid)} with ${fmt(a.topStaff.edits)} edits`
        : "None this period",
      accent: "border-t-[#8fa6bf]",
    },
    {
      label: "Automated",
      value: fmt(a.kinds.automated),
      sub:
        a.automatedByActor.length > 0
          ? a.automatedByActor.map((x) => `${automatedLabel(x.actorCwid)} ${fmt(x.edits)}`).join(" · ")
          : "None this period",
      accent: "border-t-[#a39486]",
    },
  ];

  // ── Chart ──────────────────────────────────────────────────────────────────
  const dayTotal = (k: string) => {
    const b = buckets.get(k);
    return b ? b.self + b.staff + b.automated : 0;
  };
  const dayCount = (dayKey: string) => perDayTotal.get(dayKey) ?? 0;
  const maxEdits = Math.max(0, ...axis.map(dayTotal));
  const yMax = niceMax(maxEdits);
  const ticks = [0, yMax / 2, yMax];
  const spike = axis.reduce<string | null>((best, k) => (dayTotal(k) > (best ? dayTotal(best) : 0) ? k : best), null);
  const spikeTop = spike ? buckets.get(spike)?.topActor : null;
  const hoverLabel = hover
    ? (() => {
        const s = buckets.get(hover);
        const parts = s
          ? KIND_ORDER.filter((k) => s[k] > 0).map((k) => `${fmt(s[k])} ${KIND[k].tag.toLowerCase()}`)
          : [];
        return `${bucketLabel(hover)}: ${fmt(dayTotal(hover))} edits${parts.length ? ` (${parts.join(", ")})` : ""}`;
      })()
    : day
      ? `Filtered to ${bucketLabel(day)} · click again to clear`
      : "Each bar counts individual saves; the feed below combines repeated saves. Click a bar to filter. Eastern time.";

  // ── Feed ───────────────────────────────────────────────────────────────────
  const cat = CATEGORIES.find((c) => c.key === category) ?? CATEGORIES[0]!;
  const q = query.trim().toLowerCase();
  const matchesQuery = (e: RecentEdit) =>
    !q ||
    [
      e.actorCwid,
      actorName(e.actorCwid),
      e.entityId,
      entityText(e.entityType, e.entityId),
      labelForAction(e.action),
      e.detail ?? "",
      ...e.changes.flatMap((c) => [c.field, c.before ?? "", c.after ?? ""]),
    ].some((s) => s.toLowerCase().includes(q));
  const filtered = recent.filter(
    (e) =>
      cat.test(e.action) &&
      (!hideAutomated || !isSystemActor(e.actorCwid)) &&
      (!editor || e.actorCwid === editor) &&
      (!field || e.changes.some((c) => fieldId(e.entityType, c.key) === field)) &&
      (!gainedOnly || !field || gainedIn(e, field)) &&
      (!day || bucketOf(easternDayKey(e.ts)) === day) &&
      matchesQuery(e),
  );
  const rows = buildRows(filtered, group);
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_ROWS));
  const pageRows = rows.slice(page * PAGE_ROWS, (page + 1) * PAGE_ROWS);
  const rowsPerDay = new Map<string, number>();
  for (const r of rows) rowsPerDay.set(r.day, (rowsPerDay.get(r.day) ?? 0) + 1);
  const byDay: { day: string; rows: FeedRow[] }[] = [];
  for (const r of pageRows) {
    const last = byDay[byDay.length - 1];
    if (last && last.day === r.day) last.rows.push(r);
    else byDay.push({ day: r.day, rows: [r] });
  }
  const pageEdits = pageRows.reduce((n, r) => n + r.edits.length, 0);
  const firstEdit = rows.slice(0, page * PAGE_ROWS).reduce((n, r) => n + r.edits.length, 0) + 1;
  const hasNext = page + 1 < pageCount || Boolean(cursor);

  // Next on the last loaded page fetches older edits first; it only turns the
  // page once they overflow this one (a short page just fills up).
  const [advance, setAdvance] = React.useState(false);
  if (advance && !loadingOlder) {
    setAdvance(false);
    if (rows.length > (page + 1) * PAGE_ROWS) setPage(page + 1);
  }
  function nextPage() {
    if (page + 1 < pageCount) {
      setPage(page + 1);
      return;
    }
    setAdvance(true);
    void loadOlder();
  }



  // ── Renderers ──────────────────────────────────────────────────────────────

  function firstLabel(key: string): string {
    if (key === "overview") return "First written";
    if (key === "selectedHighlightPmids") return "First picked";
    return "First set";
  }

  function badge(children: React.ReactNode) {
    return (
      <span className="bg-apollo-amber-tint border-apollo-amber-tint-border text-apollo-amber rounded border px-1.5 text-xs whitespace-nowrap">
        {children}
      </span>
    );
  }

  function listChange(c: NetChange, rowKey: string) {
    const b = parseValue(c.before);
    const af = parseValue(c.after);
    const before = Array.isArray(b) ? b.map((x) => itemLabel(c.key, x, pubTitles)) : [];
    const after = Array.isArray(af) ? af.map((x) => itemLabel(c.key, x, pubTitles)) : [];
    const had = new Set(before.map((x) => x.id));
    const has = new Set(after.map((x) => x.id));
    const items = [
      ...after.filter((x) => !had.has(x.id)).map((x) => ({ ...x, sign: "+" })),
      ...before.filter((x) => !has.has(x.id)).map((x) => ({ ...x, sign: "−" })),
    ];
    const k = `${rowKey}:${c.key}:items`;
    const shown = open.has(k) ? items : items.slice(0, ITEMS_SHOWN);
    if (items.length === 0) return <span className="text-muted-foreground">Reordered</span>;
    return (
      <span className="flex flex-col gap-0.5">
        {shown.map((x) => (
          <span key={`${x.sign}${x.id}`}>
            <span className={cn("font-semibold", x.sign === "+" ? "text-apollo-slate" : "text-apollo-maroon")}>
              {x.sign}
            </span>{" "}
            <span className={x.sign === "−" ? "text-muted-foreground line-through" : undefined}>{x.label}</span>
            {x.note && <span className="text-muted-foreground"> · {x.note}</span>}
          </span>
        ))}
        {items.length > ITEMS_SHOWN && (
          <button type="button" className={cn(LINKISH, "w-fit")} onClick={() => toggle(k)}>
            {open.has(k) ? "Show fewer" : `+ ${items.length - ITEMS_SHOWN} more`}
          </button>
        )}
      </span>
    );
  }

  function mapChange(c: NetChange) {
    const rec = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
    const b = rec(parseValue(c.before));
    const af = rec(parseValue(c.after));
    const keys = [...new Set([...Object.keys(b), ...Object.keys(af)])];
    const parts = keys.flatMap((k) => {
      const label = k.length <= 2 ? k.toUpperCase() : k === "linkedin" ? "LinkedIn" : humanizeField(k);
      if (!(k in b) && k in af) return [{ sign: "+", label }];
      if (k in b && !(k in af)) return [{ sign: "−", label }];
      return JSON.stringify(b[k]) === JSON.stringify(af[k]) ? [] : [{ sign: "~", label }];
    });
    return (
      <span>
        {parts.map((p, i) => (
          <React.Fragment key={p.label}>
            {i > 0 && " · "}
            <span className={cn("font-semibold", p.sign === "−" ? "text-apollo-maroon" : "text-apollo-slate")}>
              {p.sign}
            </span>{" "}
            {p.label}
          </React.Fragment>
        ))}
      </span>
    );
  }

  function textChange(c: NetChange, rowKey: string) {
    const k = `${rowKey}:${c.key}:text`;
    const full = open.has(k);
    const before = c.before === null ? null : plainText(c.before);
    const after = c.after === null ? null : plainText(c.after);
    if (!before && after) {
      const long = after.length > LONG_TEXT * 2;
      return (
        <p className="m-0">
          {long && !full ? `${after.slice(0, LONG_TEXT * 2 - 2)}…` : after}{" "}
          {long && (
            <button type="button" className={LINKISH} onClick={() => toggle(k)}>
              {full ? "Show less" : "Read all"}
            </button>
          )}
        </p>
      );
    }
    if (before && !after) {
      return <span className="text-muted-foreground line-through">{before.length > LONG_TEXT ? `${before.slice(0, LONG_TEXT)}…` : before}</span>;
    }
    if ((before ?? "").length <= LONG_TEXT && (after ?? "").length <= LONG_TEXT) {
      return (
        <span>
          <span className="text-muted-foreground line-through">{before}</span>{" "}
          <span className="text-muted-foreground" aria-label="changed to">→</span> {after}
        </span>
      );
    }
    const diff = wordDiff(before ?? "", after ?? "");
    const parts = full ? diff : changedOnly(diff);
    return (
      <p className="m-0">
        {parts.map((p, i) =>
          p.kind === "same" ? (
            <span key={i}>{p.text} </span>
          ) : p.kind === "del" ? (
            <del key={i} className="bg-apollo-red-tint text-apollo-maroon decoration-apollo-maroon/60 mr-1 rounded-sm px-0.5">
              {p.text}
            </del>
          ) : (
            <ins key={i} className="bg-apollo-slate-tint text-apollo-slate mr-1 rounded-sm px-0.5 no-underline">
              {p.text}
            </ins>
          ),
        )}
        <button type="button" className={LINKISH} onClick={() => toggle(k)}>
          {full ? "Changed words only" : "Full comparison"}
        </button>
      </p>
    );
  }

  function changeBlock(c: NetChange, rowKey: string) {
    const parsed = parseValue(c.after) ?? parseValue(c.before);
    const isList = Array.isArray(parsed);
    const isMap = !isList && parsed !== null && typeof parsed === "object";
    const first = isEmptyValue(c.before) && !isEmptyValue(c.after);
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium">{c.field}</span>
          {SOURCE_MANAGED.has(c.key) && <LockedBadge label="Managed at its source" />}
          {first && badge(firstLabel(c.key))}
          {isEmptyValue(c.after) && !isEmptyValue(c.before) && (
            <span className={cn(PILL, "bg-apollo-surface-2 border-apollo-border-strong text-muted-foreground")}>Cleared</span>
          )}
          {c.saves > 1 && <span className="text-muted-foreground text-[13px]">· {c.saves} saves combined</span>}
        </div>
        <div className="min-w-0 [overflow-wrap:anywhere]">
          {isList ? listChange(c, rowKey) : isMap ? mapChange(c) : textChange(c, rowKey)}
        </div>
      </div>
    );
  }

  /** "A", "A and B", "A, B and C". */
  function andList(xs: string[]): string {
    return xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
  }

  /** Entity names with a Show all toggle (runs and bulk rows). */
  function entityList(r: FeedRow) {
    const k = `${r.key}:ents`;
    const names = [...new Set(r.edits.map((x) => entityText(x.entityType, x.entityId)))];
    const shown = open.has(k) ? names : names.slice(0, ITEMS_SHOWN);
    return (
      <span className="text-muted-foreground [overflow-wrap:anywhere]">
        {shown.join(", ")}
        {names.length > ITEMS_SHOWN && (
          <>
            {open.has(k) ? " " : ` and ${fmt(names.length - ITEMS_SHOWN)} more `}
            <button type="button" className={LINKISH} onClick={() => toggle(k)}>
              {open.has(k) ? "Show fewer" : "Show all"}
            </button>
          </>
        )}
      </span>
    );
  }

  /** "12 min" / "3 min" / "under a minute" between a row's first and last edit. */
  function spanText(r: FeedRow): string {
    const ms = new Date(r.edits[0]!.ts).getTime() - new Date(r.edits[r.edits.length - 1]!.ts).getTime();
    const mins = Math.round(ms / 60_000);
    return mins < 1 ? "under a minute" : `${mins} min`;
  }

  function editorCell(r: FeedRow) {
    const e = r.edits[0]!;
    if (r.mode === "contested") {
      const actors = [...new Set(r.edits.map((x) => x.actorCwid))].reverse();
      return (
        <div className="flex min-w-0 flex-col items-start gap-1">
          <span className="text-[14px] font-medium">{andList(actors.map(actorName))}</span>
          <span className={cn(PILL, "bg-apollo-amber-tint border-apollo-amber-tint-border text-apollo-amber")}>
            Back-and-forth on {entityText(e.entityType, e.entityId)}
          </span>
        </div>
      );
    }
    const person = people[e.actorCwid];
    const forHref = historyHref(e.entityType, e.entityId);
    const forText = entityText(e.entityType, e.entityId);
    const profiles = new Set(r.edits.map((x) => `${x.entityType}:${x.entityId}`)).size;
    let tag: React.ReactNode;
    if (r.mode === "bulk") tag = `Staff, for ${fmt(profiles)} profiles`;
    else if (r.kind === "self") tag = "Own profile";
    else if (r.kind === "automated") tag = "Automated";
    else if (r.kind === "audit") tag = "Audit";
    else
      tag = (
        <>
          Staff, for{" "}
          {forHref ? (
            <Link href={forHref} className="hover:underline">
              {forText}
            </Link>
          ) : (
            forText
          )}
        </>
      );
    const selfHref = r.kind === "self" && r.mode === "session" ? forHref : null;
    return (
      <div className="flex min-w-0 flex-col items-start gap-1">
        <span className="text-[14px] font-medium" title={person?.title ?? undefined}>
          {selfHref ? (
            <Link href={selfHref} className="hover:underline">
              {actorName(e.actorCwid)}
            </Link>
          ) : (
            actorName(e.actorCwid)
          )}
          {r.kind !== "self" && person && (
            <span className="text-muted-foreground ml-1.5 font-normal">{e.actorCwid}</span>
          )}
        </span>
        <span
          className={cn(
            PILL,
            r.kind === "self"
              ? KIND.self.chip
              : r.kind === "staff"
                ? KIND.staff.chip
                : "bg-apollo-lock-bg border-apollo-border-strong text-foreground",
          )}
        >
          {tag}
        </span>
      </div>
    );
  }

  function rowBody(r: FeedRow) {
    const e = r.edits[0]!;
    const n = r.edits.length;
    if (r.kind === "audit") {
      const start = r.edits.find((x) => x.action === "impersonation_start");
      const end = r.edits.find((x) => x.action === "impersonation_end");
      const who = (
        <>
          {entityText(e.entityType, e.entityId)} <span className="text-muted-foreground">({e.entityId})</span>
        </>
      );
      if (start && end) {
        const mins = Math.max(1, Math.round((new Date(end.ts).getTime() - new Date(start.ts).getTime()) / 60_000));
        return <span>Viewed the console as {who} for {mins} min</span>;
      }
      return <span>{start ? "Started" : "Ended"} viewing the console as {who}</span>;
    }
    if (r.mode === "run") {
      // A generic "Updated profile" says nothing; name the fields instead.
      const fields = [...new Set(r.edits.flatMap((x) => x.changes.map((c) => c.field)))];
      const label =
        e.action === "field_override" && fields.length > 0
          ? `${andList(fields)} updated`
          : labelForAction(e.action);
      return (
        <div className="flex min-w-0 flex-col gap-1">
          <span>
            <span className="font-medium">{label}</span>
            {n > 1 && <span className="text-muted-foreground"> · {fmt(n)} in one run</span>}
          </span>
          {entityList(r)}
        </div>
      );
    }
    if (r.mode === "bulk") {
      const c = e.changes[0]!;
      const profiles = new Set(r.edits.map((x) => `${x.entityType}:${x.entityId}`)).size;
      const to = c.after === null ? null : plainText(c.after);
      return (
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>
              Changed <span className="font-medium">{andList(e.changes.map((x) => x.field))}</span>
              {e.changes.length === 1 && to && to.length <= LONG_TEXT ? <> to &ldquo;{to}&rdquo;</> : null} on{" "}
              {fmt(profiles)} profiles <span className="text-muted-foreground">({fmt(n)} edits)</span>
            </span>
            {e.changes.some((x) => SOURCE_MANAGED.has(x.key)) && <LockedBadge label="Managed at its source" />}
          </span>
          {entityList(r)}
        </div>
      );
    }
    if (r.mode === "contested") {
      const actors = [...new Set(r.edits.map((x) => x.actorCwid))].reverse();
      const fields = [...new Set(r.edits.flatMap((x) => x.changes.map((c) => c.field)))];
      return (
        <div className="flex min-w-0 flex-col gap-1.5">
          <span>
            <span className="font-medium">{andList(fields)}</span>
            <span className="text-muted-foreground">
              {" "}
              · edited by {andList(actors.map(actorName))}, {fmt(n)} times in {spanText(r)}
            </span>
          </span>
          {/* Each save's own change, oldest first: the sequence IS the signal. */}
          <ol className="m-0 flex list-none flex-col gap-0.5 p-0">
            {[...r.edits].reverse().map((x) => (
              <li key={x.id} className="flex flex-wrap gap-x-2">
                <span className="text-muted-foreground tabular-nums">{easternTime(x.ts)}</span>
                <span className="font-medium">{actorName(x.actorCwid)}</span>
                {x.changes.map((c) => (
                  <span key={c.key} className="[overflow-wrap:anywhere]">
                    <span className="text-muted-foreground line-through">{c.before === null ? "empty" : plainText(c.before)}</span>{" "}
                    <span className="text-muted-foreground" aria-label="changed to">
                      →
                    </span>{" "}
                    {c.after === null ? <span className="text-muted-foreground italic">empty</span> : plainText(c.after)}
                  </span>
                ))}
              </li>
            ))}
          </ol>
        </div>
      );
    }
    const changes = netChanges(r.edits);
    const visible = changes.filter((c) => !sameIgnoringFormat(c.before, c.after));
    const other = new Map<string, { label: string; detail: string | null; n: number }>();
    for (const x of r.edits) {
      if (x.changes.length > 0) continue;
      const cur = other.get(x.action);
      if (cur) cur.n += 1;
      else other.set(x.action, { label: labelForAction(x.action), detail: x.detail, n: 1 });
    }
    if (changes.length > 0 && visible.length === 0 && other.size === 0) {
      const k = `${r.key}:raw`;
      return (
        <span className="text-muted-foreground">
          {changes.map((c) => c.field).join(", ")} re-saved with no visible change (format only).{" "}
          <button type="button" className={LINKISH} onClick={() => toggle(k)}>
            {open.has(k) ? "Hide raw" : "Show raw"}
          </button>
          {open.has(k) &&
            changes.map((c) => (
              <span key={c.key} className="mt-1 block font-mono text-xs [overflow-wrap:anywhere]">
                {c.field}: {c.before ?? "empty"} → {c.after ?? "empty"}
              </span>
            ))}
        </span>
      );
    }
    return (
      <div className="flex min-w-0 flex-col gap-2.5">
        {visible.map((c) => (
          <React.Fragment key={c.key}>{changeBlock(c, r.key)}</React.Fragment>
        ))}
        {[...other.values()].map((o) => (
          <span key={o.label}>
            <span className="font-medium">{o.label}</span>
            {o.n > 1 && <span className="text-muted-foreground"> ×{o.n}</span>}
            {o.detail && <span className="text-muted-foreground"> · {o.detail}</span>}
          </span>
        ))}
      </div>
    );
  }

  function chip(label: string, onClear: () => void) {
    return (
      <span className="bg-apollo-slate-tint border-apollo-slate-tint-border text-apollo-slate inline-flex items-center gap-1.5 rounded-full border py-[3px] pr-1.5 pl-2.5 text-[13px]">
        {label}
        <button type="button" aria-label={`Clear ${label}`} onClick={onClear} className="hover:bg-apollo-slate/10 rounded-full p-0.5">
          <X className="size-3.5" aria-hidden />
        </button>
      </span>
    );
  }

  const editorOptions = summary.topEditors.map((t) => t.actorCwid);
  const fieldOptions = [...new Map([...a.fields, ...a.gained].map((f) => [f.key, fieldIdLabel(f.key)]))];
  const topEditorN = summary.topEditors[0]?.edits ?? 1;
  const editorRows = allEditors ? summary.topEditors : summary.topEditors.slice(0, LIST_TOP);

  return (
    <div className="flex flex-col gap-6" data-slot="edit-activity">
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex min-w-0 flex-1 basis-[300px] flex-col gap-1.5">
          <h1 className="m-0 text-[30px] leading-tight font-semibold tracking-[-0.02em]">Edit activity</h1>
          <p className="text-muted-foreground m-0 text-[14.5px] leading-normal">
            Who changed which profiles, {rangeDate(days[0]!)} to {rangeDate(days[days.length - 1]!)}. Read-only. Each
            scholar and center links to its full history.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <nav
            aria-label="Date range"
            className="border-apollo-border-strong bg-apollo-surface inline-flex h-8 overflow-hidden rounded-md border text-sm"
            data-testid="edit-activity-range"
          >
            {(Object.keys(EDIT_ACTIVITY_RANGES) as EditActivityRange[]).map((k) => (
              <Link
                key={k}
                href={k === "30d" ? "?" : `?range=${k}`}
                aria-current={summary.range === k ? "page" : undefined}
                className={cn(
                  "border-apollo-border-strong flex items-center border-l px-3 first:border-l-0",
                  summary.range === k ? "bg-apollo-slate-tint text-apollo-slate font-medium" : "hover:bg-apollo-surface-2",
                )}
              >
                {EDIT_ACTIVITY_RANGES[k].label}
              </Link>
            ))}
          </nav>
          <Button variant="outline" size="sm" asChild>
            <a
              href={`/api/edit/activity/export?range=${summary.range}&asOf=${encodeURIComponent(summary.generatedAt)}`}
              title="Every edit in this range, as CSV (who, what, which fields; not the values)"
              data-testid="edit-activity-export"
            >
              Export CSV
            </a>
          </Button>
        </div>
      </div>

      <section
        aria-label="Who made the edits"
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
        data-testid="edit-activity-kpis"
      >
        {tiles.map((t) => (
          <div key={t.label} className={cn(CARD, "flex flex-col gap-1 border-t-[3px] px-5 py-4", t.accent)}>
            <span className={SMALL_CAPS}>{t.label}</span>
            <span className="text-[30px] leading-tight font-semibold tabular-nums">{t.value}</span>
            <span className="text-muted-foreground text-xs">{t.sub}</span>
          </div>
        ))}
      </section>

      <section aria-labelledby="outcomes-h" className={cn(CARD, "flex flex-col gap-3.5 p-5")} data-testid="edit-activity-gained">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 id="outcomes-h" className="m-0 text-base font-semibold">
            Profiles that gained content this period
          </h2>
          <span className="text-muted-foreground text-[13px]">
            Field went from empty to filled. Click a number to filter the feed.
          </span>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {a.gained.map((g) => {
            const on = gainedOnly && field === g.key;
            return (
              <button
                key={g.key}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  setField(on ? "" : g.key);
                  setGainedOnly(!on);
                }}
                className={cn(
                  "flex flex-col items-start gap-0.5 rounded-lg border px-4 py-3 text-left",
                  on ? "bg-apollo-slate-tint border-apollo-slate" : "bg-apollo-page border-apollo-border hover:border-apollo-border-strong",
                )}
                data-testid={`edit-activity-gained-${g.key}`}
              >
                <span className="text-apollo-slate text-2xl font-semibold tabular-nums">{fmt(g.profiles)}</span>
                <span className="text-[13px]">{g.label}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="chart-h" className={cn(CARD, "flex flex-col gap-3 p-5")}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 id="chart-h" className="m-0 text-base font-semibold">
              Edits per {weekly ? "week" : "day"}
            </h2>
            <span className="text-muted-foreground text-[13px]" aria-live="polite">
              {hoverLabel}
            </span>
          </div>
          <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {KIND_ORDER.map((k) => (
              <span key={k} className="inline-flex items-center gap-1.5">
                <span aria-hidden className={cn("inline-block size-2.5 rounded-sm", KIND[k].bar)} />
                {KIND[k].legend}
              </span>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-[32px_minmax(0,1fr)] gap-2 md:grid-cols-[40px_minmax(0,1fr)]">
          <div className="text-muted-foreground relative mt-7 h-[180px] text-[11.5px] tabular-nums" aria-hidden>
            {ticks.map((t) => (
              <span key={t} className="absolute right-0 translate-y-1/2" style={{ bottom: `${(t / yMax) * 100}%` }}>
                {Number.isInteger(t) ? fmt(t) : ""}
              </span>
            ))}
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="relative h-7">
              {spike && dayTotal(spike) > 0 && (
                <span
                  className="bg-apollo-surface-2 border-apollo-border-strong absolute bottom-1 rounded-md border px-2 py-0.5 text-xs whitespace-nowrap"
                  // Centered over the spike's bar; pinned to an edge near either end.
                  style={(() => {
                    const i = axis.indexOf(spike);
                    const pct = ((i + 0.5) / axis.length) * 100;
                    if (i < 4) return { left: 0 };
                    if (i > axis.length - 5) return { right: 0 };
                    return { left: `${pct}%`, transform: "translateX(-50%)" };
                  })()}
                  data-testid="edit-activity-spike"
                >
                  {bucketLabel(spike)} · {fmt(dayTotal(spike))}
                  {spikeTop ? ` · top editor ${actorName(spikeTop)}` : ""}
                </span>
              )}
            </div>
            <div className="relative h-[180px]">
              {ticks.map((t) => (
                <div
                  key={t}
                  aria-hidden
                  className={cn("absolute inset-x-0 border-t", t === 0 ? "border-apollo-border-strong" : "border-apollo-border")}
                  style={{ bottom: `${(t / yMax) * 100}%` }}
                />
              ))}
              <div
                className="absolute inset-0 flex items-end gap-[2px] md:gap-1"
                role="group"
                aria-label={`Edits per ${weekly ? "week" : "day"}; select a bar to filter the activity feed`}
              >
                {axis.map((k) => {
                  const n = dayTotal(k);
                  const s = buckets.get(k);
                  const active = day === k || hover === k;
                  return (
                    <button
                      key={k}
                      type="button"
                      aria-pressed={day === k}
                      aria-label={`${bucketLabel(k)}: ${fmt(n)} edits`}
                      onMouseEnter={() => setHover(k)}
                      onMouseLeave={() => setHover(null)}
                      onFocus={() => setHover(k)}
                      onBlur={() => setHover(null)}
                      onClick={() => setDay((d) => (d === k ? null : k))}
                      className={cn(
                        "focus-visible:ring-ring/50 flex h-full min-w-0 flex-1 cursor-pointer flex-col-reverse rounded-sm outline-none focus-visible:ring-2",
                        !weekly && isWeekend(k) && !active && "opacity-45",
                        active && "ring-apollo-bar/40 ring-1",
                      )}
                      data-testid={`edit-activity-bar-${k}`}
                    >
                      {KIND_ORDER.map((kind) => {
                        const v = s?.[kind] ?? 0;
                        return v > 0 ? (
                          <span
                            key={kind}
                            className={cn("block w-full first:rounded-none last:rounded-t-[3px]", KIND[kind].bar)}
                            style={{ height: `${(v / yMax) * 100}%`, minHeight: 2 }}
                          />
                        ) : null;
                      })}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="text-muted-foreground flex gap-[2px] text-[11.5px] md:gap-1" aria-hidden>
              {axis.map((k, i) => (
                <span key={k} className="relative min-w-0 flex-1 text-center whitespace-nowrap">
                  {i % Math.max(1, Math.ceil(axis.length / 4)) === 0 ? (
                    <span className="md:hidden">{dayLabel(k)}</span>
                  ) : null}
                  {i % Math.max(1, Math.ceil(axis.length / 8)) === 0 ? (
                    <span className="hidden md:inline">{dayLabel(k)}</span>
                  ) : null}
                </span>
              ))}
            </div>
          </div>
        </div>
        <span className="text-muted-foreground text-xs">
          {weekly ? "Each bar is one week, Monday to Sunday." : "Faded bars are weekends."}
        </span>
      </section>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <section aria-labelledby="ed-h" className={cn(CARD, "overflow-hidden")} data-testid="edit-activity-top-editors">
          <div className="flex items-center justify-between px-5 pt-4 pb-2.5">
            <h2 id="ed-h" className="m-0 text-base font-semibold">
              Top editors
            </h2>
            <span className={SMALL_CAPS}>Edits</span>
          </div>
          {editorRows.length === 0 ? (
            <p className="text-muted-foreground border-apollo-border m-0 border-t px-5 py-3 text-sm">
              None {inRange}.
            </p>
          ) : (
            editorRows.map((r) => {
              const person = people[r.actorCwid];
              const info = a.editors[r.actorCwid];
              const kind: EditorKind = info?.kind ?? (isSystemActor(r.actorCwid) ? "automated" : "staff");
              const picked = editor === r.actorCwid;
              const meta =
                kind === "automated"
                  ? "Scheduled job"
                  : [
                      person?.title,
                      kind === "staff" && info ? `edited ${fmt(info.profiles)} ${info.profiles === 1 ? "profile" : "profiles"}` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ");
              return (
                <button
                  key={r.actorCwid}
                  type="button"
                  aria-pressed={picked}
                  onClick={() => setEditor(picked ? "" : r.actorCwid)}
                  title={picked ? "Clear the editor filter" : "Show only this editor's edits"}
                  className={cn(
                    "border-apollo-border hover:bg-apollo-page grid w-full grid-cols-[minmax(0,1fr)_56px] items-center gap-3 border-t px-5 py-2.5 text-left",
                    picked && "bg-apollo-slate-tint hover:bg-apollo-slate-tint",
                  )}
                  data-testid={`edit-activity-editor-${r.actorCwid}`}
                >
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-medium">
                        {actorName(r.actorCwid)}
                        {person && <span className="text-muted-foreground font-normal"> · {r.actorCwid}</span>}
                      </span>
                      <span className={cn(PILL, "text-[11px]", KIND[kind].chip)}>{KIND[kind].tag}</span>
                    </span>
                    {meta && <span className="text-muted-foreground truncate text-xs">{meta}</span>}
                    <span aria-hidden className="bg-apollo-surface-2 block h-1 w-full overflow-hidden rounded-full">
                      <span
                        className={cn("block h-full rounded-full", KIND[kind].bar)}
                        style={{ width: `${Math.max(2, (r.edits / topEditorN) * 100)}%` }}
                      />
                    </span>
                  </span>
                  <span className="text-right text-sm font-medium tabular-nums">{fmt(r.edits)}</span>
                </button>
              );
            })
          )}
          {summary.topEditors.length > LIST_TOP && (
            <div className="border-apollo-border border-t px-3 py-1.5">
              <Button variant="ghost" size="sm" onClick={() => setAllEditors((v) => !v)}>
                {allEditors ? `Show top ${LIST_TOP}` : `Show top ${summary.topEditors.length}`}
              </Button>
            </div>
          )}
        </section>

        <section aria-labelledby="fd-h" className={cn(CARD, "overflow-hidden")} data-testid="edit-activity-top-fields">
          <div className="flex items-center justify-between px-5 pt-4 pb-2.5">
            <h2 id="fd-h" className="m-0 text-base font-semibold">
              Most-edited fields
            </h2>
            <span className={SMALL_CAPS}>Profiles · Edits</span>
          </div>
          {a.fields.length === 0 ? (
            <p className="text-muted-foreground border-apollo-border m-0 border-t px-5 py-3 text-sm">
              No field edits {inRange}.
            </p>
          ) : (
            a.fields.map((f) => {
              const on = field === f.key && !gainedOnly;
              return (
                <button
                  key={f.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => {
                    setGainedOnly(false);
                    setField(on ? "" : f.key);
                  }}
                  className={cn(
                    "border-apollo-border hover:bg-apollo-page flex w-full items-center justify-between gap-3 border-t px-5 py-2.5 text-left text-sm",
                    on && "bg-apollo-slate-tint hover:bg-apollo-slate-tint",
                  )}
                >
                  <span className="truncate font-medium">{f.label}</span>
                  <span className="text-muted-foreground tabular-nums whitespace-nowrap">
                    {fmt(f.profiles)} · {fmt(f.edits)}
                  </span>
                </button>
              );
            })
          )}
          <p className="text-muted-foreground border-apollo-border m-0 border-t px-5 py-3 text-xs">
            &ldquo;Profiles&rdquo; counts distinct profiles, so one person saving 15 times counts once.
          </p>
        </section>
      </div>

      <section aria-labelledby="feed-h" className="flex flex-col gap-3" data-testid="edit-activity-recent">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="feed-h" className="m-0 text-lg font-semibold">
            Recent activity
          </h2>
          <div className="flex flex-wrap gap-4 text-[13px]">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={group}
                onChange={() => setGroup((v) => !v)}
                className="accent-apollo-maroon m-0 size-4"
                data-testid="edit-activity-group"
              />
              Group repeated saves
            </label>
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={hideAutomated}
                onChange={() => setHideAutomated((v) => !v)}
                className="accent-apollo-maroon m-0 size-4"
                data-testid="edit-activity-hide-system"
              />
              Hide automated
            </label>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="border-apollo-border-strong bg-apollo-surface flex h-8 min-w-[320px] flex-1 items-center gap-2 rounded-md border px-2.5 sm:flex-none">
            <Search className="text-muted-foreground size-4" aria-hidden />
            <span className="sr-only">Search activity</span>
            <input
              type="search"
              value={query}
              onChange={(ev) => setQuery(ev.target.value)}
              placeholder="Search a person, entity or field"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none"
              data-testid="edit-activity-search"
            />
          </label>
          {CATEGORIES.map((c) => {
            const on = category === c.key;
            return (
              <button
                key={c.key}
                type="button"
                aria-pressed={on}
                onClick={() => setCategory(c.key)}
                className={cn(
                  "rounded-full border px-3 py-1.5 text-[13px] whitespace-nowrap",
                  on
                    ? "bg-apollo-slate-tint text-apollo-slate border-apollo-slate"
                    : "bg-apollo-surface text-foreground border-apollo-border-strong hover:bg-apollo-surface-2",
                )}
                data-testid={`edit-activity-category-${c.key}`}
              >
                {c.label}
              </button>
            );
          })}
          <span className="flex-1" />
          <select
            aria-label="Editor"
            value={editor}
            onChange={(ev) => setEditor(ev.target.value)}
            className="border-apollo-border-strong bg-apollo-surface h-8 rounded-md border px-2 text-[13px]"
            data-testid="edit-activity-editor-select"
          >
            <option value="">Editor: any</option>
            {editorOptions.map((c) => (
              <option key={c} value={c}>
                {actorName(c)}
              </option>
            ))}
          </select>
          <select
            aria-label="Field"
            value={field}
            onChange={(ev) => {
              setGainedOnly(false);
              setField(ev.target.value);
            }}
            className="border-apollo-border-strong bg-apollo-surface h-8 rounded-md border px-2 text-[13px]"
            data-testid="edit-activity-field-select"
          >
            <option value="">Field: any</option>
            {fieldOptions.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </div>

        {(day || (gainedOnly && field)) && (
          <div className="flex flex-wrap gap-2">
            {day && chip(bucketLabel(day), () => setDay(null))}
            {gainedOnly && field && (
              chip(a.gained.find((g) => g.key === field)?.label ?? humanizeField(field), () => {
                  setGainedOnly(false);
                  setField("");
                })
            )}
          </div>
        )}

        <div className={cn(CARD, "overflow-hidden")}>
          {byDay.map((d) => (
            <div key={d.day} data-testid={`edit-activity-day-${d.day}`}>
              <div className="bg-apollo-surface-2 border-apollo-border flex justify-between gap-3 border-b px-5 py-2 text-[13px] font-semibold">
                <span>{dayHeading(d.day)}</span>
                <span className="text-muted-foreground font-normal">
                  {plural(dayCount(d.day), "edit")} · {plural(rowsPerDay.get(d.day) ?? 0, "row")}
                </span>
              </div>
              {d.rows.map((r) => {
                const first = r.edits[r.edits.length - 1]!;
                const t0 = easternTime(first.ts);
                const t1 = easternTime(r.edits[0]!.ts);
                return (
                  <div
                    key={r.key}
                    className="border-apollo-border grid grid-cols-[88px_minmax(0,1fr)] gap-x-4 gap-y-2 border-b px-5 py-3.5 text-sm md:grid-cols-[96px_minmax(180px,240px)_minmax(0,1fr)]"
                    data-kind={r.kind}
                    data-testid={`edit-activity-row-${r.key}`}
                  >
                    <span className="text-muted-foreground pt-px text-[13px] tabular-nums">
                      {t0 === t1 ? t0 : `${t0}–${t1}`}
                    </span>
                    {editorCell(r)}
                    <div className="col-start-2 min-w-0 leading-[1.5] md:col-start-auto">
                      {rowBody(r)}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
          {byDay.length === 0 && (
            <p className="text-muted-foreground m-0 px-7 py-7 text-center text-sm" data-testid="edit-activity-feed-empty">
              {recent.length === 0
                ? `No edits recorded ${inRange}.`
                : cursor
                  ? "No loaded edits match these filters. Page forward to look further back."
                  : "No edits match these filters."}
            </p>
          )}
          <div className="bg-apollo-page text-muted-foreground flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 py-3 text-[13px]">
            <span data-testid="edit-activity-feed-footer">
              {pageRows.length > 0
                ? `Rows ${fmt(page * PAGE_ROWS + 1)}–${fmt(page * PAGE_ROWS + pageRows.length)} · edits ${fmt(firstEdit)}–${fmt(firstEdit + pageEdits - 1)} of ${fmt(total)}`
                : `${fmt(total)} edits ${inRange}`}
            </span>
            <span className="flex items-center gap-2">
              {olderError && (
                <span role="alert" data-testid="edit-activity-load-older-error">
                  Couldn&rsquo;t load older edits.
                </span>
              )}
              <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!hasNext || loadingOlder}
                aria-busy={loadingOlder}
                onClick={nextPage}
                data-testid="edit-activity-next"
              >
                {loadingOlder ? "Loading…" : "Next"}
              </Button>
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}
