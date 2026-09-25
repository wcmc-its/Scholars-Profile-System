/**
 * The `/edit/activity` body (2026-09 redesign): four KPI tiles, an
 * edits-per-day bar chart, Top editors / Most-edited entities bar lists, and
 * a Recent activity feed grouped by day. Clicking a day's bar, an editor, a
 * category chip or "Hide system edits" narrows the feed client-side.
 *
 * Everything here is a view over the one server read
 * (`loadEditActivitySummary`): the feed filters act on the most recent
 * {@link EDIT_ACTIVITY_RECENT_LIMIT} edits that read loaded, and the footer
 * says so. The page stays superuser-gated server-side; this component never
 * fetches.
 *
 * Client-safe: imports only pure helpers (`edit-activity.ts` and
 * `scholar-audit.ts` carry type-only Prisma imports).
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { X } from "lucide-react";

import {
  EDIT_ACTIVITY_RECENT_LIMIT,
  EDIT_ACTIVITY_TZ,
  type EditActivitySummary,
  type FieldChange,
  type RecentEdit,
  isSystemActor,
} from "@/lib/api/edit-activity";
import { labelForAction } from "@/lib/api/scholar-audit";
import { cn } from "@/lib/utils";

/** Above this length a changed value collapses behind "more". */
const VALUE_COLLAPSE_AT = 90;
/** Rows a bar list shows before "Show all". */
const LIST_TOP = 10;

/** Counts in one fixed locale, so the server render and the browser agree. */
const fmt = (n: number) => n.toLocaleString("en-US");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** An ISO instant's WCM-local (Eastern) calendar day, "YYYY-MM-DD". */
export function easternDayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: EDIT_ACTIVITY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

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
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= n) return m * pow;
  return 10 * pow;
}

/** The feed's category chips. An action outside every list shows under All only. */
const CATEGORIES: ReadonlyArray<{ key: string; label: string; actions?: ReadonlySet<string> }> = [
  { key: "all", label: "All" },
  {
    key: "profile",
    label: "Profile updates",
    actions: new Set([
      "field_override",
      "field_override_clear",
      "orcid_set",
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
    ]),
  },
  {
    key: "roster",
    label: "Roster & roles",
    actions: new Set([
      "unit_create",
      "roster_change",
      "grant_change",
      "role_vocabulary_create",
      "role_vocabulary_update",
      "role_vocabulary_delete",
      "disease_assignment_decision",
      "core_claim",
      "core_client_add",
      "core_client_remove",
    ]),
  },
  { key: "news", label: "News mentions", actions: new Set(["news_mention_update"]) },
  {
    key: "access",
    label: "Access",
    actions: new Set([
      "proxy_grant",
      "proxy_revoke",
      "report_access_grant",
      "report_access_revoke",
      "impersonation_start",
      "impersonation_end",
    ]),
  },
];

/** The small type tag for an audited entity type. */
function typeLabel(entityType: string): string {
  switch (entityType) {
    case "news_mention":
      return "news mention";
    case "report_access":
      return "report access";
    case "org_unit_role":
      return "role";
    default:
      return entityType.replace(/_/g, " ");
  }
}

/** The per-entity history page, when one exists (scholar + center only). */
function historyHref(entityType: string, entityId: string): string | null {
  const id = encodeURIComponent(entityId);
  if (entityType === "scholar") return `/edit/scholar/${id}/history`;
  if (entityType === "center") return `/edit/center/${id}/history`;
  return null;
}

/** A grouped feed row: consecutive identical edits in the same minute. */
type FeedGroup = { key: string; day: string; time: string; head: RecentEdit; members: RecentEdit[] };

function sameChanges(a: RecentEdit, b: RecentEdit): boolean {
  return JSON.stringify(a.changes) === JSON.stringify(b.changes) && a.detail === b.detail;
}

/** Group consecutive edits that share minute, editor, action, entity (any
 *  news mention counts as the same entity) and the same change set. */
export function groupFeed(edits: ReadonlyArray<RecentEdit>): FeedGroup[] {
  const out: FeedGroup[] = [];
  for (const e of edits) {
    const day = easternDayKey(e.ts);
    const time = easternTime(e.ts);
    const last = out[out.length - 1];
    if (
      last &&
      last.day === day &&
      last.time === time &&
      last.head.actorCwid === e.actorCwid &&
      last.head.impersonatedCwid === e.impersonatedCwid &&
      last.head.action === e.action &&
      last.head.entityType === e.entityType &&
      (e.entityType === "news_mention" || last.head.entityId === e.entityId) &&
      sameChanges(last.head, e)
    ) {
      last.members.push(e);
    } else {
      out.push({ key: e.id, day, time, head: e, members: [e] });
    }
  }
  return out;
}

const CARD = "bg-apollo-surface border-apollo-border-strong rounded-[13px] border";
const SMALL_CAPS = "text-muted-foreground text-xs font-medium tracking-[0.08em] uppercase";

export function EditActivityDashboard({ summary }: { summary: EditActivitySummary }) {
  const { people, entityNames } = summary;

  const [hover, setHover] = React.useState<string | null>(null);
  const [day, setDay] = React.useState<string | null>(null);
  const [editor, setEditor] = React.useState<string | null>(null);
  const [category, setCategory] = React.useState("all");
  const [hideSystem, setHideSystem] = React.useState(false);
  const [allEditors, setAllEditors] = React.useState(false);
  const [allEntities, setAllEntities] = React.useState(false);
  const [openGroups, setOpenGroups] = React.useState<ReadonlySet<string>>(() => new Set());
  const [shownValues, setShownValues] = React.useState<ReadonlySet<string>>(() => new Set());

  const toggleIn = (set: ReadonlySet<string>, k: string) => {
    const next = new Set(set);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    return next;
  };

  // ── Day axis + KPIs ────────────────────────────────────────────────────────
  const perDay = new Map(summary.perDay.map((r) => [r.day, r.edits]));
  const axis = dayAxis(easternDayKey(summary.generatedAt), summary.windowDays);
  const activeDays = summary.perDay.filter((r) => r.edits > 0).length;
  const busiest = summary.perDay.reduce<{ day: string; edits: number } | null>(
    (best, r) => (!best || r.edits > best.edits ? r : best),
    null,
  );
  const total = summary.totalEdits;
  const { editors, automatedEditors, automatedEdits } = summary.editorStats;
  const humanEdits = Math.max(0, total - automatedEdits);
  const kpis = [
    { label: "Edits", value: fmt(total), sub: `on ${activeDays} of ${summary.windowDays} days` },
    {
      label: "Editors",
      value: fmt(editors),
      sub: `${fmt(editors - automatedEditors)} ${editors - automatedEditors === 1 ? "person" : "people"}, ${fmt(automatedEditors)} automated`,
    },
    {
      label: "By people",
      value: total > 0 ? `${Math.round((humanEdits / total) * 100)}%` : "—",
      sub: `${fmt(humanEdits)} edits; the rest automated`,
    },
    {
      label: "Busiest day",
      value: busiest ? fmt(busiest.edits) : "—",
      sub: busiest ? dayLabel(busiest.day) : "No edits",
    },
  ];

  const maxEdits = Math.max(0, ...axis.map((k) => perDay.get(k) ?? 0));
  const yMax = niceMax(maxEdits);
  const ticks = Number.isInteger(yMax / 2) ? [0, yMax / 2, yMax] : [0, yMax];
  const hoverLabel = hover
    ? `${dayLabel(hover)}: ${fmt(perDay.get(hover) ?? 0)} edits · click to filter the activity feed`
    : day
      ? `Filtered to ${dayLabel(day)} · click again to clear`
      : "Hover a bar for the count; click to filter the feed";

  // ── People / entity labels ─────────────────────────────────────────────────
  const personName = (cwid: string) => people[cwid]?.name ?? null;

  function entityText(type: string, id: string): { text: string; raw: boolean } {
    if (type === "scholar") {
      const n = personName(id);
      return n ? { text: n, raw: false } : { text: id, raw: true };
    }
    const n = entityNames[`${type}:${id}`];
    return n ? { text: n, raw: false } : { text: id, raw: true };
  }

  // ── Bar lists ──────────────────────────────────────────────────────────────
  const topEditorN = summary.topEditors[0]?.edits ?? 1;
  const topEntityN = summary.topEntities[0]?.edits ?? 1;
  const editorRows = allEditors ? summary.topEditors : summary.topEditors.slice(0, LIST_TOP);
  const entityRows = allEntities ? summary.topEntities : summary.topEntities.slice(0, LIST_TOP);

  // ── Feed ───────────────────────────────────────────────────────────────────
  const cat = CATEGORIES.find((c) => c.key === category);
  const filtered = summary.recent.filter(
    (e) =>
      (!cat?.actions || cat.actions.has(e.action)) &&
      (!hideSystem || !isSystemActor(e.actorCwid)) &&
      (!editor || e.actorCwid === editor) &&
      (!day || easternDayKey(e.ts) === day),
  );
  const groups = groupFeed(filtered);
  const byDay: { day: string; groups: FeedGroup[] }[] = [];
  for (const g of groups) {
    const last = byDay[byDay.length - 1];
    if (last && last.day === g.day) last.groups.push(g);
    else byDay.push({ day: g.day, groups: [g] });
  }
  const isFiltered = Boolean(day || editor || category !== "all" || hideSystem);

  function valueNode(v: string | null, key: string, before: boolean) {
    if (v === null) return <span className="text-muted-foreground italic">empty</span>;
    const long = v.length > VALUE_COLLAPSE_AT;
    const shown = shownValues.has(key);
    return (
      <>
        <span
          className={cn(
            "min-w-0 [overflow-wrap:anywhere]",
            before && "text-muted-foreground line-through",
          )}
        >
          {long && !shown ? `${v.slice(0, VALUE_COLLAPSE_AT - 2)}…` : v}
        </span>
        {long && (
          <button
            type="button"
            onClick={() => setShownValues((s) => toggleIn(s, key))}
            className="text-apollo-slate text-[12.5px] hover:underline"
          >
            {shown ? "less" : "more"}
          </button>
        )}
      </>
    );
  }

  function changeLine(c: FieldChange, key: string) {
    return (
      <div key={key} className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-1">
        <span className="font-medium">{c.field}</span>
        {valueNode(c.before, `${key}:b`, true)}
        <span className="text-muted-foreground" aria-label="changed to">
          →
        </span>
        {valueNode(c.after, `${key}:a`, false)}
      </div>
    );
  }

  function editorName(cwid: string) {
    const n = personName(cwid);
    return n ? (
      <span>{n}</span>
    ) : (
      <span className="font-mono">{cwid}</span>
    );
  }

  return (
    <div className="flex flex-col gap-7" data-slot="edit-activity">
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex min-w-0 flex-1 basis-[300px] flex-col gap-1.5">
          <h1 className="m-0 text-[30px] leading-tight font-semibold tracking-[-0.01em]">
            Edit activity
          </h1>
          <p className="text-muted-foreground m-0 text-[14.5px] leading-normal">
            Edits across all profile entities, {dayLabel(axis[0]!)} – {dayLabel(axis[axis.length - 1]!)}.
            Read-only. Scholars and centers link to their full history.
          </p>
        </div>
        <span className="text-muted-foreground border-apollo-border-strong bg-apollo-surface rounded-lg border px-3 py-[7px] text-[13px] whitespace-nowrap">
          Last {summary.windowDays} days
        </span>
      </div>

      <div
        className="grid grid-cols-2 gap-3.5 md:grid-cols-[repeat(auto-fit,minmax(200px,1fr))]"
        data-testid="edit-activity-kpis"
      >
        {kpis.map((k) => (
          <div key={k.label} className={cn(CARD, "flex flex-col gap-1 px-[18px] py-4")}>
            <span className="text-muted-foreground text-xs font-medium tracking-[0.1em] uppercase">
              {k.label}
            </span>
            <span className="text-[30px] leading-tight font-semibold tracking-[-0.01em] tabular-nums">
              {k.value}
            </span>
            <span className="text-muted-foreground text-[13px]">{k.sub}</span>
          </div>
        ))}
      </div>

      <section className={cn(CARD, "flex flex-col gap-3.5 px-4 pt-5 pb-4 md:px-[22px]")}>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="m-0 text-[17px] font-semibold">Edits per day</h2>
          <span className="text-muted-foreground text-[13px]" aria-live="polite">
            {hoverLabel}
          </span>
        </div>
        <div className="grid grid-cols-[32px_minmax(0,1fr)] gap-2 md:grid-cols-[40px_minmax(0,1fr)]">
          <div className="text-muted-foreground relative h-[180px] text-[11.5px] tabular-nums" aria-hidden>
            {ticks.map((t) => (
              <span
                key={t}
                className="absolute right-0 translate-y-1/2"
                style={{ bottom: `${(t / yMax) * 100}%` }}
              >
                {fmt(t)}
              </span>
            ))}
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="relative h-[180px]">
              {ticks.map((t) => (
                <div
                  key={t}
                  aria-hidden
                  className={cn(
                    "absolute inset-x-0 border-t",
                    t === 0 ? "border-apollo-border-strong" : "border-apollo-border",
                  )}
                  style={{ bottom: `${(t / yMax) * 100}%` }}
                />
              ))}
              <div
                className="absolute inset-0 flex items-end gap-[2px] md:gap-1"
                role="group"
                aria-label="Edits per day; select a day to filter the activity feed"
              >
                {axis.map((k) => {
                  const n = perDay.get(k) ?? 0;
                  const active = day === k || hover === k;
                  return (
                    <button
                      key={k}
                      type="button"
                      aria-pressed={day === k}
                      aria-label={`${dayLabel(k)}: ${fmt(n)} edits`}
                      title={`${dayLabel(k)}: ${fmt(n)}`}
                      onMouseEnter={() => setHover(k)}
                      onMouseLeave={() => setHover(null)}
                      onFocus={() => setHover(k)}
                      onBlur={() => setHover(null)}
                      onClick={() => setDay((d) => (d === k ? null : k))}
                      className="focus-visible:ring-ring/50 flex h-full min-w-0 flex-1 cursor-pointer items-end rounded-sm outline-none focus-visible:ring-2"
                      data-testid={`edit-activity-bar-${k}`}
                    >
                      <span
                        className={cn(
                          "block w-full rounded-t-[3px]",
                          active
                            ? "bg-apollo-bar"
                            : isWeekend(k)
                              ? "bg-apollo-slate/45"
                              : "bg-apollo-slate",
                        )}
                        style={{ height: `${(n / yMax) * 100}%`, minHeight: n > 0 ? 2 : 0 }}
                      />
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="text-muted-foreground flex gap-[2px] text-[11.5px] md:gap-1" aria-hidden>
              {axis.map((k, i) => (
                <span key={k} className="relative min-w-0 flex-1 text-center whitespace-nowrap">
                  {i % 7 === 0 ? (
                    <span className="md:hidden">{dayLabel(k)}</span>
                  ) : null}
                  {i % 4 === 0 ? (
                    <span className="hidden md:inline">{dayLabel(k)}</span>
                  ) : null}
                </span>
              ))}
            </div>
          </div>
        </div>
        <p className="text-muted-foreground m-0 text-xs">Lighter bars are weekends. Days are Eastern time.</p>
      </section>

      <div className="grid items-start gap-5 lg:grid-cols-2">
        <section className={cn(CARD, "overflow-hidden")} data-testid="edit-activity-top-editors">
          <div className="flex items-center justify-between px-5 pt-4 pb-2.5">
            <h2 className="m-0 text-[17px] font-semibold">Top editors</h2>
            <span className={SMALL_CAPS}>Edits</span>
          </div>
          {editorRows.length === 0 ? (
            <p className="text-muted-foreground border-apollo-border m-0 border-t px-5 py-3 text-sm">
              None in the last {summary.windowDays} days.
            </p>
          ) : (
            editorRows.map((r) => {
              const person = people[r.actorCwid];
              const system = isSystemActor(r.actorCwid);
              const picked = editor === r.actorCwid;
              return (
                <button
                  key={r.actorCwid}
                  type="button"
                  aria-pressed={picked}
                  onClick={() => setEditor(picked ? null : r.actorCwid)}
                  title={picked ? "Clear the editor filter" : "Show only this editor's edits"}
                  className={cn(
                    "border-apollo-border hover:bg-apollo-page grid w-full grid-cols-[minmax(0,1fr)_48px] items-center gap-2.5 border-t px-5 py-[7px] text-left",
                    picked && "bg-apollo-slate-tint hover:bg-apollo-slate-tint",
                  )}
                  data-testid={`edit-activity-editor-${r.actorCwid}`}
                >
                  <span className="relative min-w-0 overflow-hidden rounded-[5px] px-2 py-1">
                    <span
                      aria-hidden
                      className="bg-apollo-slate-tint absolute inset-y-0 left-0 rounded-[5px]"
                      style={{ width: `${(r.edits / topEditorN) * 100}%` }}
                    />
                    <span className="relative flex min-w-0 flex-col">
                      <span className="flex min-w-0 items-center gap-2">
                        <span
                          className={cn(
                            "truncate text-sm",
                            person ? "font-medium" : "font-mono",
                          )}
                        >
                          {person?.name ?? r.actorCwid}
                        </span>
                        {system && (
                          <span className="bg-apollo-surface-2 text-muted-foreground rounded px-[7px] py-px text-[11px] whitespace-nowrap">
                            System
                          </span>
                        )}
                      </span>
                      {person && (
                        <span className="text-muted-foreground truncate text-[12.5px]">
                          {person.title ? `${person.title} · ` : ""}
                          {r.actorCwid}
                        </span>
                      )}
                    </span>
                  </span>
                  <span className="text-right text-sm font-medium tabular-nums">{fmt(r.edits)}</span>
                </button>
              );
            })
          )}
          {summary.topEditors.length > LIST_TOP && (
            <button
              type="button"
              onClick={() => setAllEditors((v) => !v)}
              className="border-apollo-border bg-apollo-page text-apollo-slate w-full border-t p-2.5 text-[13px] hover:underline"
            >
              {allEditors ? `Show top ${LIST_TOP}` : `Show top ${summary.topEditors.length}`}
            </button>
          )}
        </section>

        <section className={cn(CARD, "overflow-hidden")} data-testid="edit-activity-top-entities">
          <div className="flex items-center justify-between px-5 pt-4 pb-2.5">
            <h2 className="m-0 text-[17px] font-semibold">Most-edited entities</h2>
            <span className={SMALL_CAPS}>Edits</span>
          </div>
          {entityRows.length === 0 ? (
            <p className="text-muted-foreground border-apollo-border m-0 border-t px-5 py-3 text-sm">
              None in the last {summary.windowDays} days.
            </p>
          ) : (
            entityRows.map((r) => {
              const { text, raw } = entityText(r.entityType, r.entityId);
              const href = historyHref(r.entityType, r.entityId);
              return (
                <div
                  key={`${r.entityType}:${r.entityId}`}
                  className="border-apollo-border grid grid-cols-[minmax(0,1fr)_48px] items-center gap-2.5 border-t px-5 py-[7px]"
                >
                  <span className="relative min-w-0 overflow-hidden rounded-[5px] px-2 py-1">
                    <span
                      aria-hidden
                      className="bg-apollo-slate-tint absolute inset-y-0 left-0 rounded-[5px]"
                      style={{ width: `${(r.edits / topEntityN) * 100}%` }}
                    />
                    <span className="relative flex min-w-0 items-center gap-2">
                      <span className="bg-apollo-surface border-apollo-border-strong text-muted-foreground flex-none rounded border px-[7px] py-px text-[11px] whitespace-nowrap">
                        {typeLabel(r.entityType)}
                      </span>
                      {href ? (
                        <Link
                          href={href}
                          title={raw ? undefined : r.entityId}
                          className={cn(
                            "text-apollo-slate truncate text-sm hover:underline",
                            raw && "font-mono",
                          )}
                        >
                          {text}
                        </Link>
                      ) : (
                        <span
                          title={raw ? undefined : r.entityId}
                          className={cn("truncate text-sm", raw && "font-mono")}
                        >
                          {text}
                        </span>
                      )}
                    </span>
                  </span>
                  <span className="text-right text-sm font-medium tabular-nums">{fmt(r.edits)}</span>
                </div>
              );
            })
          )}
          {summary.topEntities.length > LIST_TOP && (
            <button
              type="button"
              onClick={() => setAllEntities((v) => !v)}
              className="border-apollo-border bg-apollo-page text-apollo-slate w-full border-t p-2.5 text-[13px] hover:underline"
            >
              {allEntities ? `Show top ${LIST_TOP}` : `Show top ${summary.topEntities.length}`}
            </button>
          )}
        </section>
      </div>

      <section className="flex flex-col gap-3" data-testid="edit-activity-recent">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="m-0 text-[17px] font-semibold">Recent activity</h2>
          {day && (
            <span className="bg-apollo-slate-tint border-apollo-slate-tint-border text-apollo-slate inline-flex items-center gap-1.5 rounded-full border py-[3px] pr-1.5 pl-2.5 text-[13px]">
              {dayLabel(day)}
              <button
                type="button"
                aria-label="Clear the day filter"
                onClick={() => setDay(null)}
                className="hover:bg-apollo-slate/10 rounded-full p-0.5"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </span>
          )}
          {editor && (
            <span
              className="bg-apollo-slate-tint border-apollo-slate-tint-border text-apollo-slate inline-flex items-center gap-1.5 rounded-full border py-[3px] pr-1.5 pl-2.5 text-[13px]"
              data-testid="edit-activity-editor-chip"
            >
              {personName(editor) ?? editor}
              <button
                type="button"
                aria-label="Clear the editor filter"
                onClick={() => setEditor(null)}
                className="hover:bg-apollo-slate/10 rounded-full p-0.5"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </span>
          )}
          <div className="flex flex-wrap items-center gap-1.5 md:ml-auto">
            {CATEGORIES.map((c) => {
              const on = category === c.key;
              return (
                <button
                  key={c.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setCategory(c.key)}
                  className={cn(
                    "rounded-full border px-[11px] py-1 text-[12.5px] whitespace-nowrap",
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
            <label className="text-muted-foreground ml-2 flex cursor-pointer items-center gap-2 text-[13px] whitespace-nowrap">
              <input
                type="checkbox"
                checked={hideSystem}
                onChange={() => setHideSystem((v) => !v)}
                className="accent-apollo-maroon m-0 size-4 flex-none cursor-pointer"
                data-testid="edit-activity-hide-system"
              />
              Hide system edits
            </label>
          </div>
        </div>

        <div className={cn(CARD, "overflow-hidden")}>
          {byDay.map((d) => (
            <div key={d.day} data-testid={`edit-activity-day-${d.day}`}>
              <div className="bg-apollo-surface-2 border-apollo-border-strong sticky top-0 z-[1] flex justify-between gap-3 border-b px-5 py-[9px] text-[12.5px] font-semibold tracking-[0.04em]">
                <span>{dayHeading(d.day)}</span>
                <span className="text-muted-foreground font-normal">
                  {fmt(perDay.get(d.day) ?? 0)} edits that day
                </span>
              </div>
              {d.groups.map((g) => {
                const e = g.head;
                const n = g.members.length;
                const isGroup = n > 1;
                const news = e.entityType === "news_mention";
                const open = isGroup && news && openGroups.has(g.key);
                const person = people[e.actorCwid];
                const { text, raw } = entityText(e.entityType, e.entityId);
                const href = isGroup && news ? null : historyHref(e.entityType, e.entityId);
                const entityLabel = isGroup && news ? `${n} news mentions` : text;
                return (
                  <div
                    key={g.key}
                    className="border-apollo-border border-b"
                    data-action={e.action}
                    data-testid={`edit-activity-row-${g.key}`}
                  >
                    <div className="grid grid-cols-[52px_minmax(0,1fr)] gap-x-3 gap-y-2 px-5 py-[11px] md:grid-cols-[64px_minmax(120px,1fr)_minmax(160px,1.3fr)_minmax(0,2fr)] md:items-start md:gap-x-3.5">
                      <span className="text-muted-foreground pt-px text-[13px] tabular-nums">{g.time}</span>
                      <div className="flex min-w-0 flex-col gap-px">
                        <span
                          className="truncate text-[13.5px] font-medium"
                          title={person?.title ? `${person.title} · ${e.actorCwid}` : e.actorCwid}
                        >
                          {editorName(e.actorCwid)}
                          {e.impersonatedCwid && (
                            <span className="text-muted-foreground font-normal">
                              {" "}
                              (as {personName(e.impersonatedCwid) ?? e.impersonatedCwid})
                            </span>
                          )}
                        </span>
                        <span className="text-muted-foreground text-[12.5px]">
                          {labelForAction(e.action)}
                          {isGroup ? ` ×${n}` : ""}
                        </span>
                      </div>
                      <div className="col-start-2 flex min-w-0 flex-col gap-[3px] md:col-start-auto">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="bg-apollo-page border-apollo-border-strong text-muted-foreground flex-none rounded border px-[7px] py-px text-[11px] whitespace-nowrap">
                            {typeLabel(e.entityType)}
                          </span>
                          {href ? (
                            <Link
                              href={href}
                              title={raw ? undefined : e.entityId}
                              className={cn(
                                "text-apollo-slate truncate text-[13.5px] hover:underline",
                                raw && "font-mono",
                              )}
                            >
                              {entityLabel}
                            </Link>
                          ) : (
                            <span
                              title={raw ? undefined : e.entityId}
                              className={cn(
                                "truncate text-[13.5px]",
                                raw && !(isGroup && news) && "font-mono",
                              )}
                            >
                              {entityLabel}
                            </span>
                          )}
                        </div>
                        {isGroup &&
                          (news ? (
                            <button
                              type="button"
                              aria-expanded={open}
                              onClick={() => setOpenGroups((s) => toggleIn(s, g.key))}
                              className="text-apollo-slate w-fit text-[12.5px] hover:underline"
                            >
                              {open ? "Hide IDs" : "Show IDs"}
                            </button>
                          ) : (
                            <span className="text-muted-foreground text-[12.5px]">
                              {n} changes in the same minute
                            </span>
                          ))}
                      </div>
                      <div className="col-start-2 flex min-w-0 flex-col gap-1 text-[13.5px] leading-[1.45] md:col-start-auto">
                        {e.changes.length > 0 ? (
                          e.changes.map((c, i) => changeLine(c, `${g.key}:${i}`))
                        ) : e.detail ? (
                          <span className="text-muted-foreground">{e.detail}</span>
                        ) : (
                          <span className="text-muted-foreground text-[13px]">
                            No field-level details recorded
                          </span>
                        )}
                      </div>
                    </div>
                    {open && (
                      <div className="flex flex-col gap-0.5 px-5 pb-2.5 pl-[84px] md:pl-[98px]">
                        {g.members.map((m) => (
                          <span key={m.id} className="text-muted-foreground font-mono text-[12.5px]">
                            {m.entityId}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
          {byDay.length === 0 && (
            <p
              className="text-muted-foreground m-0 px-7 py-7 text-center text-sm"
              data-testid="edit-activity-feed-empty"
            >
              {summary.recent.length === 0
                ? `No edits recorded in the last ${summary.windowDays} days.`
                : "No edits match these filters."}
            </p>
          )}
          <div
            className="bg-apollo-page text-muted-foreground px-5 py-3 text-[13px]"
            data-testid="edit-activity-feed-footer"
          >
            Showing {fmt(filtered.length)} of {fmt(total)} edits{isFiltered ? " (filtered)" : ""}.
            {total > summary.recent.length
              ? ` The feed holds the latest ${fmt(Math.min(summary.recent.length, EDIT_ACTIVITY_RECENT_LIMIT))}; filters apply to those.`
              : ""}{" "}
            Repeated edits in the same minute are grouped.
          </div>
        </div>
      </section>
    </div>
  );
}
