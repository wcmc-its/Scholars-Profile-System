/**
 * PositionsCard — the "Positions & appointments" tab (design pass 2026-09-22).
 * One list, two sections, one selection model:
 *
 *   - **Current** — the scholar's active directory appointments, hide-to-
 *     suppress via POST /api/edit/suppress and POST /api/edit/revoke with the
 *     same row states as `EntityPanel` (shown | hidden_by_self |
 *     hidden_by_admin | locked). A chair appointment is `locked` and a primary
 *     appointment is always shown — neither gets a checkbox.
 *   - **Earlier ranks** (#1323) — the "ED-HISTORICAL" records grouped by rank
 *     title (one row per rank, every department the rank was held in). Hide /
 *     show flips `Appointment.showOnProfile` via POST
 *     /api/edit/appointment-visibility once per record. A group is hidden iff
 *     ALL its records are, "partially hidden" when only some are.
 *
 * Checked rows collect into the shared fixed `SelectionBar` whose "Hide from
 * profile" hides every selected row — directly for the scholar, behind one
 * required-reason `ConfirmDialog` for a superuser. Hiding is display-only: the
 * record stays in WCM systems and on internal reports (a hidden CURRENT
 * appointment also leaves the CV export — `lib/api/profile.ts` filters
 * suppressed rows first).
 *
 * Local state is authoritative after each write; nothing else on /edit reads
 * these rows, so there is no `router.refresh()`.
 *
 * Replaced the flat `AppointmentsCard` (an `EntityPanel` config) +
 * `HistoricalAppointmentsCard` pair; Education / Funding / Mentees still share
 * `EntityPanel`, which takes the same `SelectionBar`. The self-service
 * `ProfileAppointmentsCard` sits under this.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { EyeOff } from "lucide-react";

import { ConfirmDialog } from "@/components/edit/confirm-dialog";
import { EDIT_PANEL_HEADING_ID } from "@/components/edit/edit-panel";
import { LockedBadge } from "@/components/edit/locked-badge";
import { RequestAChangeDialog } from "@/components/edit/request-a-change-dialog";
import {
  BULK_CONFIRM_THRESHOLD,
  SelectionBar,
  SelectionBarSpacer,
  mapChunked,
  plural,
  useRowSelection,
} from "@/components/edit/selection-bar";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type {
  EditContextAppointment,
  EditContextHistoricalAppointment,
} from "@/lib/api/edit-context";
import { fieldSource } from "@/lib/edit/field-sources";
import { cn } from "@/lib/utils";

export type PositionsCardProps = {
  cwid: string;
  mode: "self" | "superuser";
  scholarName: string;
  appointments: ReadonlyArray<EditContextAppointment>;
  /** Empty for a viewer who may not edit positions — `edit-page.tsx` gates it. */
  historicalAppointments: ReadonlyArray<EditContextHistoricalAppointment>;
};

type Dated = { startDate: string | null; endDate: string | null };

/** One rendered row: a current appointment, or one earlier rank (its records). */
type Row = {
  id: string;
  title: string;
  sub: string;
  years: string;
  hidden: boolean;
  /** An earlier-rank group with only SOME records hidden. */
  partial: boolean;
  /** Gets a checkbox: shown, and neither primary nor locked. */
  selectable: boolean;
} & (
  | { kind: "current"; appointment: EditContextAppointment }
  | { kind: "earlier"; records: EditContextHistoricalAppointment[] }
);

/** Newest first; undated rows last. */
const byStartDesc = (a: Dated, b: Dated) => (b.startDate ?? "").localeCompare(a.startDate ?? "");

/** "2019–2025", "2009–present" — the span across every record given. Same
 *  #2225 rule as the profile: an undated record shows no range. */
function yearSpan(recs: ReadonlyArray<Dated>): string {
  let start: string | null = null;
  let end: string | null = null;
  let present = false;
  for (const r of recs) {
    if (r.startDate && (!start || r.startDate < start)) start = r.startDate;
    if (r.endDate === null) present = true;
    else if (!end || r.endDate > end) end = r.endDate;
  }
  const endYear = present ? "present" : (end?.slice(0, 4) ?? null);
  if (!start) return endYear && endYear !== "present" ? endYear : "";
  return `${start.slice(0, 4)}–${endYear}`;
}

const NUMBER_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
];
/** "Nine" — spelled out through twelve, digits beyond. */
function countInWords(n: number): string {
  const w = NUMBER_WORDS[n] ?? String(n);
  return w[0].toUpperCase() + w.slice(1);
}

async function post(url: string, body: unknown): Promise<{ ok: boolean; suppressionId?: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { ok?: boolean; suppressionId?: string };
    return { ok: res.ok && data.ok !== false, suppressionId: data.suppressionId };
  } catch {
    return { ok: false };
  }
}

export function PositionsCard({
  cwid,
  mode,
  scholarName,
  appointments,
  historicalAppointments,
}: PositionsCardProps) {
  const isSuperuser = mode === "superuser";
  // Local copies, committed on each successful write — authoritative from then
  // on; no router.refresh().
  const [current, setCurrent] = React.useState<EditContextAppointment[]>([...appointments]);
  const [history, setHistory] = React.useState<EditContextHistoricalAppointment[]>([
    ...historicalAppointments,
  ]);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [hideOpen, setHideOpen] = React.useState(false);
  const [overrideTarget, setOverrideTarget] = React.useState<EditContextAppointment | null>(null);

  const currentRows: Row[] = [...current].sort(byStartDesc).map((a) => ({
    kind: "current",
    id: a.externalId,
    appointment: a,
    title: a.title,
    sub: a.organization,
    years: yearSpan([a]),
    hidden: a.state === "hidden_by_self" || a.state === "hidden_by_admin",
    partial: false,
    // A legacy hidden primary reads as any hidden row (Show), but is never
    // selectable — it can't be re-hidden here.
    selectable: a.state === "shown" && !a.isPrimary,
  }));

  // Group by rank title; records are newest-first, so groups come out newest-first too.
  const groups = new Map<string, EditContextHistoricalAppointment[]>();
  for (const r of [...history].sort(byStartDesc))
    groups.set(r.title, [...(groups.get(r.title) ?? []), r]);
  const earlierRows: Row[] = [...groups.values()].map((records) => {
    const hidden = records.every((r) => !r.showOnProfile);
    return {
      kind: "earlier",
      id: records[0].externalId,
      records,
      title: records[0].title,
      sub: [...new Set(records.map((r) => r.organization))].join(" · "),
      years: yearSpan(records),
      hidden,
      partial: !hidden && records.some((r) => !r.showOnProfile),
      selectable: !hidden,
    };
  });
  const rows = [...currentRows, ...earlierRows];

  const { selected, toggle, clear, older, selectAlsoOlder, settle } = useRowSelection(rows);

  /** Flip every record of a group; commits the ones that succeeded. */
  async function setVisibility(
    records: EditContextHistoricalAppointment[],
    showOnProfile: boolean,
    reason: string | null = null,
  ) {
    const done = await mapChunked(records, async (r) =>
      (
        await post("/api/edit/appointment-visibility", {
          appointmentExternalId: r.externalId,
          showOnProfile,
          ...(reason ? { reason } : {}),
        })
      ).ok
        ? r.externalId
        : null,
    );
    setHistory((prev) =>
      prev.map((r) => (done.includes(r.externalId) ? { ...r, showOnProfile } : r)),
    );
    return !done.includes(null);
  }

  async function suppress(a: EditContextAppointment, reason: string | null) {
    const res = await post("/api/edit/suppress", {
      entityType: "appointment",
      entityId: a.externalId,
      ...(reason ? { reason } : {}),
    });
    if (res.ok) {
      const state = isSuperuser ? "hidden_by_admin" : "hidden_by_self";
      setCurrent((prev) =>
        prev.map((x) =>
          x.externalId === a.externalId
            ? { ...x, state, suppressionId: res.suppressionId ?? null }
            : x,
        ),
      );
    }
    return res.ok;
  }

  async function hideSelected(reason: string | null) {
    setError(null);
    setBusy(true);
    try {
      const targets = rows.filter((r) => selected.has(r.id));
      const results = await mapChunked(targets, async (r) =>
        r.kind === "current"
          ? suppress(r.appointment, reason)
          : setVisibility(r.records, false, reason),
      );
      const failed = targets.filter((_, i) => !results[i]);
      settle(
        targets.map((r) => r.id),
        failed.map((r) => r.id),
      );
      if (failed.length > 0) {
        setError(
          `We couldn't hide ${failed.length} of the selected appointments. Please try again.`,
        );
      }
    } finally {
      setBusy(false);
    }
  }

  async function revoke(a: EditContextAppointment) {
    setError(null);
    setBusy(true);
    try {
      const res = await post("/api/edit/revoke", { suppressionId: a.suppressionId });
      if (!res.ok) {
        setError("We couldn't show this appointment again. Please try again.");
        return;
      }
      setCurrent((prev) =>
        prev.map((x) =>
          x.externalId === a.externalId ? { ...x, state: "shown", suppressionId: null } : x,
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  async function showGroup(records: EditContextHistoricalAppointment[]) {
    setError(null);
    setBusy(true);
    try {
      if (!(await setVisibility(records, true))) {
        setError("We couldn't show this appointment again. Please try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  function onShow(row: Row) {
    if (row.kind === "earlier") return void showGroup(row.records);
    // A superuser un-hiding a row the SCHOLAR hid overrides their choice → confirm.
    if (isSuperuser && row.appointment.state === "hidden_by_self")
      setOverrideTarget(row.appointment);
    else void revoke(row.appointment);
  }

  function hiddenLabel(row: Row): string {
    if (row.kind === "earlier") return row.partial ? "Partially hidden" : "Hidden";
    if (row.appointment.state === "hidden_by_admin") return "Hidden by an administrator";
    return isSuperuser ? "Hidden by the scholar" : "Hidden";
  }

  function canShow(row: Row): boolean {
    if (row.kind === "earlier") return row.hidden || row.partial;
    return row.hidden && (row.appointment.state === "hidden_by_self" || isSuperuser);
  }

  const renderRow = (row: Row) => (
    <li
      key={row.id}
      data-testid={
        row.kind === "current"
          ? `appointment-row-${row.id}`
          : `historical-appointment-row-${row.id}`
      }
      className="border-apollo-border flex items-start gap-3.5 border-t px-1 py-[13px]"
    >
      {row.selectable ? (
        <label className="hover:bg-apollo-surface-2 -mt-1 -ml-1.5 flex size-[30px] shrink-0 items-center justify-center rounded-[7px]">
          <Checkbox
            className="border-apollo-border-strong size-[18px] border-2"
            checked={selected.has(row.id)}
            disabled={busy}
            onCheckedChange={(c) => toggle(row.id, c === true)}
            aria-label={`Select ${row.title}, ${row.sub}${row.years ? `, ${row.years}` : ""}`}
          />
        </label>
      ) : (
        <span className="w-6 shrink-0" aria-hidden />
      )}
      <span className="text-muted-foreground w-[104px] shrink-0 pt-0.5 text-[12.5px] tabular-nums">
        {row.years}
      </span>
      <div className={cn("min-w-0 flex-1", row.hidden && "opacity-50")}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[14px] font-[600] tracking-[-0.01em]">{row.title}</span>
          {row.kind === "current" &&
            (row.appointment.state === "locked" ||
              (row.appointment.isPrimary && row.appointment.state === "shown")) && (
              <span className="bg-apollo-slate-tint border-apollo-slate-tint-border text-apollo-notice-text rounded-full border px-2 py-0.5 text-[11px] font-[600] tracking-[0.03em] uppercase">
                {row.appointment.state === "locked"
                  ? "Chair · Always shown"
                  : "Primary · Always shown"}
              </span>
            )}
          {(row.hidden || row.partial) && (
            <span className="bg-apollo-surface-2 border-apollo-border-strong text-muted-foreground inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium">
              <EyeOff className="size-[11px]" aria-hidden />
              {hiddenLabel(row)}
            </span>
          )}
        </div>
        <p className="text-muted-foreground text-[12.5px]">{row.sub}</p>
      </div>
      {canShow(row) && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => onShow(row)}
          data-testid={`${row.kind === "current" ? "appointment" : "historical-appointment"}-row-${row.id}-show`}
        >
          Show
        </Button>
      )}
      {row.kind === "current" && (
        <RequestAChangeDialog
          attribute="appointments"
          cwid={cwid}
          scholarName={scholarName}
          itemLabel={row.title}
          trigger={(open) => (
            <Button type="button" variant="ghost" size="sm" onClick={open}>
              Request a change
            </Button>
          )}
        />
      )}
    </li>
  );

  const recordCount = history.length;

  return (
    <section data-slot="appointments-panel">
      <header>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 id={EDIT_PANEL_HEADING_ID} className="text-[17px] font-[600] tracking-[-0.015em]">
            Positions &amp; appointments
          </h2>
          <LockedBadge label="Managed at its source" />
        </div>
        <p className="text-muted-foreground mt-[9px] text-[13px] leading-normal">
          From{" "}
          <Link href="/about#provenance" className="text-apollo-slate underline underline-offset-2">
            {fieldSource("appointments")}
          </Link>
          . Hiding controls what shows on the public profile only — the record itself stays in WCM
          systems and on internal reports. A department chair role can&rsquo;t be hidden.
        </p>
      </header>

      {error && (
        <Alert variant="destructive" className="mt-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="mt-[26px] flex items-baseline justify-between gap-3">
        <h3 className="text-[14px] font-[600] tracking-[-0.01em]">Current</h3>
        <span className="text-muted-foreground text-xs">
          {plural(currentRows.length, "appointment", "appointments")}
        </span>
      </div>
      {currentRows.length === 0 ? (
        <p className="text-muted-foreground mt-2 text-sm">
          {isSuperuser
            ? "This scholar has no academic appointments on file."
            : "You have no academic appointments on file."}
        </p>
      ) : (
        <ul className="mt-2">{currentRows.map(renderRow)}</ul>
      )}

      {earlierRows.length > 0 && (
        <>
          <div className="mt-[34px] flex items-baseline justify-between gap-3">
            <h3 className="text-[14px] font-[600] tracking-[-0.01em]">Earlier ranks</h3>
            <span className="text-muted-foreground text-xs">
              {plural(earlierRows.length, "role", "roles")} · {yearSpan(history)}
            </span>
          </div>
          <p className="text-muted-foreground mt-[9px] text-[13px]">
            {countInWords(recordCount)} directory {recordCount === 1 ? "record" : "records"},
            grouped by rank.
            {recordCount !== earlierRows.length &&
              " Each row covers every department the rank was held in."}
          </p>
          <ul className="mt-2">{earlierRows.map(renderRow)}</ul>
        </>
      )}

      <SelectionBar
        count={selected.size}
        noun="appointment"
        nounPlural="appointments"
        extendCount={older.length}
        onExtend={selectAlsoOlder}
        onHide={() =>
          isSuperuser || selected.size > BULK_CONFIRM_THRESHOLD
            ? setHideOpen(true)
            : void hideSelected(null)
        }
        onClear={clear}
        busy={busy}
      />
      <SelectionBarSpacer count={selected.size} />

      <ConfirmDialog
        open={hideOpen}
        onOpenChange={(o) => !o && setHideOpen(false)}
        title={`Hide ${plural(selected.size, "appointment", "appointments")}?`}
        description={
          isSuperuser
            ? `This removes ${selected.size === 1 ? "it" : "them"} from ${scholarName}'s public profile.`
            : `This hides ${selected.size === 1 ? "it" : "them"} from your public profile. The records stay as-is in WCM systems and on internal reports, and you can show them again any time.`
        }
        reasonMode={isSuperuser ? "required-text" : "none"}
        confirmLabel="Hide"
        confirmVariant="destructive"
        onConfirm={async (reason) => {
          setHideOpen(false);
          await hideSelected(reason);
        }}
      />
      <ConfirmDialog
        open={overrideTarget !== null}
        onOpenChange={(o) => !o && setOverrideTarget(null)}
        title="Show this appointment again?"
        description={`${scholarName} hid this themselves. Showing it again will override their choice.`}
        reasonMode="none"
        confirmLabel="Show it"
        confirmVariant="default"
        onConfirm={async () => {
          const t = overrideTarget;
          setOverrideTarget(null);
          if (t) await revoke(t);
        }}
      />
    </section>
  );
}
