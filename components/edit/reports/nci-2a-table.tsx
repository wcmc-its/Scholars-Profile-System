"use client";

/**
 * Report 2 — NCI Table 2a, the client half (reports redesign, 2026-09-25):
 * the review table and the CSV button. The body
 * (`nci-table-2a-body.tsx`) filters and sorts on the server from the URL and
 * hands over the rows; this pages them ("Show 25 more") and owns the one
 * write, the Cancer-relevant % (`PATCH /api/edit/center/[code]/nci-2a/[id]`,
 * which sets `source: "human"` and writes the `cancer_funding_override` audit
 * row):
 *   - Enter or leaving the field saves; Esc undoes the draft; an empty or
 *     out-of-range draft reverts, never saves (an empty input must not
 *     commit a 0% onto a row nobody inferred).
 *   - "Accept" on an AI-suggested row PATCHes the SAME value, confirming it.
 *   - "Accept N shown suggestions" (over the AI-suggested rows currently on
 *     screen, at most `NCI2A_ACCEPT_CAP`) asks to confirm, then POSTs their ids
 *     to `/api/edit/center/[code]/nci-2a/accept` — one transaction; rows a
 *     human already reviewed are skipped server-side and reported here.
 * After a save the page re-renders from the server (`router.refresh()`), so
 * the stats, counts and progress move with it; paging keeps its place
 * (`useShowMore`'s `resetKey` is the filter query, not the row array). The
 * refresh reads the read replica, which can lag the write, so the table also
 * shows each saved value itself (`applyNci2aWrite`) until the server row has
 * it — a stale row must never bring back an Accept bound to the old AI value.
 *
 * Notes: a free-text reviewer note per row (`reviewerNote`, same PATCH). A
 * link under the status pill opens an editor row under the award; leaving the
 * field saves, Esc undoes. MCC uses it to say why an award is under 100%
 * cancer-relevant; it is the CSV's Notes column.
 *
 * Trainee slots: a training award (`isTrainingAward`) gets a number field
 * under its title (`traineeSlots`, same PATCH; blank clears). It feeds the
 * CSV's "T" section; MCC takes the number from the Graduate School or the
 * Postdoc Office.
 *
 * Program is read-only here: the PI's center membership, edited in the
 * center roster. Nothing here reaches `@/lib/db`.
 */
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Download, Pencil } from "lucide-react";

import { useShowMore } from "@/components/edit/reports/report-show-more";
import { ScholarHoverCard } from "@/components/edit/scholar-hover-card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  applyNci2aWrite,
  bulkAcceptTargets,
  isTrainingAward,
  money,
  NCI2A_NOTE_MAX,
  NCI2A_TRAINEE_SLOTS_MAX,
  nci2aCsv,
  nci2aStatus,
  nci2aWriteLanded,
  statusPillLabel,
  type Nci2aAcceptResult,
  type Nci2aAward,
  type Nci2aSortKey,
  type Nci2aStatus,
} from "@/lib/edit/nci-2a-report";
import { nihReporterProjectUrl } from "@/lib/nih-reporter";
import { cn } from "@/lib/utils";

const AMBER = "text-apollo-amber bg-apollo-amber-tint border-apollo-amber-tint-border";
const SLATE = "text-apollo-slate bg-apollo-slate-tint border-apollo-slate-tint-border";
const PILL_CLASS: Record<Nci2aStatus, string> = {
  ai: AMBER,
  "not-inferred": AMBER,
  rule: SLATE,
  confirmed: SLATE,
  corrected: SLATE,
};

export function StatusPill({ award }: { award: Nci2aAward }) {
  return (
    <span
      className={cn(
        "inline-block rounded border px-1.5 py-px text-[11px] font-semibold tracking-[0.02em] whitespace-nowrap",
        PILL_CLASS[nci2aStatus(award)],
      )}
      data-testid="nci-2a-status"
    >
      {statusPillLabel(award)}
    </span>
  );
}

/** The CSV of exactly the rows the page's filters select (not just the page shown). */
export function Nci2aDownloadButton({
  filename,
  rows,
}: {
  /** `nci2aCsvFilename`: marks a filtered file. */
  filename: string;
  rows: ReadonlyArray<Nci2aAward>;
}) {
  const download = () => {
    const blob = new Blob([nci2aCsv(rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Button
      variant="apollo"
      onClick={download}
      disabled={rows.length === 0}
      data-testid="nci-2a-download"
    >
      <Download className="size-4" aria-hidden />
      Download CSV
    </Button>
  );
}

type Save = (awardId: string, value: number) => Promise<boolean>;
type SaveNote = (awardId: string, note: string | null) => Promise<boolean>;
type SaveSlots = (awardId: string, slots: number | null) => Promise<boolean>;

/** A training award's trainee slots. Leaving the field saves; Esc undoes; a
 *  value that isn't a whole number in range reverts, never saves. */
function TraineeSlotsField({ award, save }: { award: Nci2aAward; save: SaveSlots }) {
  const [draft, setDraft] = React.useState<string | undefined>(undefined);
  // The value this row saved, shown until the (possibly lagging) replica has it.
  const [saved, setSaved] = React.useState<number | null | undefined>(undefined);
  const [busy, setBusy] = React.useState(false);
  const cancelled = React.useRef(false);
  if (saved !== undefined && saved === award.traineeSlots) setSaved(undefined);
  const current = saved !== undefined ? saved : award.traineeSlots;

  async function commit() {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    if (draft === undefined) return;
    const next = draft.trim() === "" ? null : Number(draft);
    if (next !== null && (!Number.isInteger(next) || next < 0 || next > NCI2A_TRAINEE_SLOTS_MAX)) {
      setDraft(undefined);
      return;
    }
    if (next === current) {
      setDraft(undefined);
      return;
    }
    setBusy(true);
    const ok = await save(award.id, next);
    setBusy(false);
    if (ok) setSaved(next);
    setDraft(undefined);
  }

  return (
    <label className="text-muted-foreground mt-1.5 flex items-center gap-1.5 text-xs">
      Trainee slots
      <input
        type="number"
        min={0}
        max={NCI2A_TRAINEE_SLOTS_MAX}
        step={1}
        value={draft ?? (current == null ? "" : String(current))}
        disabled={busy}
        aria-label={`Trainee slots, ${award.projectNumber}`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          else if (e.key === "Escape") {
            cancelled.current = true;
            setDraft(undefined);
            e.currentTarget.blur();
          }
        }}
        className="bg-apollo-surface border-apollo-border-strong h-[26px] w-[52px] rounded-md border px-1.5 text-right text-[13px] text-foreground tabular-nums"
        data-testid="nci-2a-trainee-slots"
      />
    </label>
  );
}

const value0 = (a: Nci2aAward) =>
  a.cancerRelevantPercent == null ? "" : String(a.cancerRelevantPercent);

function PercentCell({
  award,
  save,
  children,
}: {
  award: Nci2aAward;
  save: Save;
  /** Under the status pill: the note link. */
  children?: React.ReactNode;
}) {
  const status = nci2aStatus(award);
  const [draft, setDraft] = React.useState<string | undefined>(undefined);
  const [busy, setBusy] = React.useState(false);
  const cancelled = React.useRef(false);
  // A fresh server value (after a save lands, or someone else's) drops the draft.
  React.useEffect(() => {
    setDraft(undefined);
  }, [award.cancerRelevantPercent, award.cancerRelevantPercentSource]);

  async function run(value: number) {
    setBusy(true);
    const ok = await save(award.id, value);
    setBusy(false);
    if (!ok) setDraft(undefined);
  }

  function commit() {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    if (draft === undefined) return;
    // Explicit: Number("") is 0, and an empty input must never save a 0%.
    // Two decimals, the column's scale (Decimal(5,2)), so "37.5" stays 37.5.
    const n = draft.trim() === "" ? NaN : Math.round(Number(draft) * 100) / 100;
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      setDraft(undefined);
      return;
    }
    if (n === award.cancerRelevantPercent && award.cancerRelevantPercentSource === "human") {
      setDraft(undefined);
      return;
    }
    void run(n);
  }

  const value = draft ?? value0(award);
  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1">
          <input
            type="number"
            min={0}
            max={100}
            step={5}
            value={value}
            disabled={busy}
            aria-label={`Cancer-relevant percent, ${award.projectNumber}`}
            title={award.cancerRelevantRationale ?? undefined}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              else if (e.key === "Escape") {
                cancelled.current = true;
                setDraft(undefined);
                e.currentTarget.blur();
              }
            }}
            className={cn(
              "bg-apollo-surface h-[30px] w-[58px] rounded-md border px-1.5 text-right text-sm tabular-nums",
              draft !== undefined
                ? "border-apollo-slate"
                : award.cancerRelevantPercentSource !== "llm"
                  ? "border-apollo-border-strong"
                  : "border-apollo-amber-tint-border",
            )}
          />
          <span className="text-muted-foreground text-[13px]">%</span>
        </span>
        {/* No Accept beside an unsaved edit: it would save the AI value over it. */}
        {status === "ai" && (draft === undefined || draft === value0(award)) && (
          <Button
            variant="outline"
            size="xs"
            disabled={busy}
            onClick={() => void run(award.cancerRelevantPercent as number)}
            aria-label={`Accept ${award.cancerRelevantPercent}% for ${award.projectNumber}`}
          >
            Accept
          </Button>
        )}
      </div>
      <div className="mt-1.5">
        <StatusPill award={award} />
      </div>
      {children}
    </div>
  );
}

/**
 * The row's note, per the "NCI Table Notes" mockup (1a): a link under the
 * status pill ("Add note", or the note itself, clamped) opens an editor row
 * under the award. Leaving the field saves; Done closes; Esc undoes and closes.
 */
function useNote(award: Nci2aAward, save: SaveNote) {
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<string | undefined>(undefined);
  // The note this row saved, shown until the (possibly lagging) replica has it.
  const [saved, setSaved] = React.useState<string | null | undefined>(undefined);
  const [busy, setBusy] = React.useState(false);
  const cancelled = React.useRef(false);
  const server = award.reviewerNote ?? null;
  if (saved !== undefined && saved === server) setSaved(undefined);
  const current = saved !== undefined ? saved : server;

  async function commit() {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    if (draft === undefined) return;
    const next = draft.trim() || null;
    if (next === current) {
      setDraft(undefined);
      return;
    }
    setBusy(true);
    const ok = await save(award.id, next);
    setBusy(false);
    if (ok) setSaved(next);
    setDraft(undefined);
  }

  function cancel() {
    cancelled.current = true;
    setDraft(undefined);
    setOpen(false);
  }

  return { open, setOpen, draft, setDraft, busy, current, commit, cancel };
}

type NoteState = ReturnType<typeof useNote>;

function NoteLink({ award, note }: { award: Nci2aAward; note: NoteState }) {
  if (note.open) return null;
  return (
    <button
      type="button"
      onClick={() => note.setOpen(true)}
      className="text-apollo-slate mt-1.5 flex cursor-pointer items-start gap-[5px] text-left text-xs hover:underline"
      aria-label={note.current ? `Edit note, ${award.projectNumber}` : `Add note, ${award.projectNumber}`}
      data-testid="nci-2a-note-link"
    >
      <Pencil className="mt-px size-[13px] shrink-0" aria-hidden />
      <span className="line-clamp-2 max-w-[180px] leading-[1.4]">{note.current ?? "Add note"}</span>
    </button>
  );
}

function NoteEditor({ award, note }: { award: Nci2aAward; note: NoteState }) {
  const under100 = award.cancerRelevantPercent != null && award.cancerRelevantPercent < 100;
  return (
    <div className="bg-apollo-surface-2 flex items-start gap-3 rounded-lg p-3">
      <Textarea
        rows={2}
        autoFocus
        maxLength={NCI2A_NOTE_MAX}
        value={note.draft ?? note.current ?? ""}
        disabled={note.busy}
        placeholder={under100 ? "Why under 100%?" : "Add a note"}
        aria-label={`Note, ${award.projectNumber}`}
        onChange={(e) => note.setDraft(e.target.value)}
        onBlur={() => void note.commit()}
        onKeyDown={(e) => {
          if (e.key === "Escape") note.cancel();
        }}
        className="min-h-0 flex-1 bg-white"
        data-testid="nci-2a-note"
      />
      {/* The field's blur (which saves) fires before this click. */}
      <Button variant="outline" size="sm" disabled={note.busy} onClick={() => note.setOpen(false)}>
        Done
      </Button>
    </div>
  );
}

function ProgramCell({ award, rosterHref }: { award: Nci2aAward; rosterHref: string }) {
  const coded = award.allocations.filter((al) => al.programCode);
  const title =
    award.programFrom === "membership"
      ? "Program comes from this person's center membership. Change it in the center roster."
      : "This PI has no program in the center roster; this is the program recorded at import.";
  if (coded.length === 0) {
    return (
      <span className="text-muted-foreground text-[13px]" title={title}>
        Unassigned
      </span>
    );
  }
  return (
    <ul className="flex flex-col gap-1" title={title}>
      {coded.map((al) => (
        <li key={al.id} className="flex items-start gap-2">
          <span className="bg-apollo-lock-bg border-apollo-border-strong rounded border px-1.5 py-px font-mono text-xs font-semibold whitespace-nowrap">
            {al.programCode}
          </span>
          <span className="text-[13px] leading-snug">
            {al.programLabel}
            {coded.length > 1 && ` (${al.programPercent}%)`}
          </span>
        </li>
      ))}
      {award.programFrom === "stored" && (
        <li className="text-muted-foreground text-xs">
          Recorded at import · <Link href={rosterHref}>roster</Link>
        </li>
      )}
    </ul>
  );
}

function Nci2aRow({
  award: a,
  save,
  saveNote,
  saveSlots,
  rosterHref,
}: {
  award: Nci2aAward;
  save: Save;
  saveNote: SaveNote;
  saveSlots: SaveSlots;
  rosterHref: string;
}) {
  const note = useNote(a, saveNote);
  return (
    <>
      <tr
        className={cn("border-apollo-border align-top", !note.open && "border-b")}
        data-testid="nci-2a-row"
      >
        <td className="py-3 pr-3 pl-5">
          <div className="leading-snug font-semibold">
            {a.grantCwid ? (
              <ScholarHoverCard cwid={a.grantCwid}>
                <span>{a.pi}</span>
              </ScholarHoverCard>
            ) : (
              a.pi
            )}
          </div>
          {a.grantCwid && (
            <div className="text-muted-foreground mt-0.5 font-mono text-xs">
              {a.grantCwid}
            </div>
          )}
        </td>
        <td className="p-3 leading-snug">{a.specificFundingSource}</td>
        <td className="p-3">
          {a.applId != null ? (
            <a
              href={nihReporterProjectUrl(a.applId)}
              target="_blank"
              rel="noopener noreferrer"
              title="View on NIH RePORTER"
              className="font-mono text-[13px] font-semibold underline-offset-2 hover:underline"
            >
              {a.projectNumber}
            </a>
          ) : (
            <div className="font-mono text-[13px] font-semibold">{a.projectNumber}</div>
          )}
          <div
            className="mt-0.5 text-[13px] leading-snug"
            title={a.projectTitle}
          >
            {a.projectTitle}
          </div>
          {isTrainingAward(a) && <TraineeSlotsField award={a} save={saveSlots} />}
        </td>
        <td className="p-3 text-right">{money(a.annualProjectDirectCosts)}</td>
        <td className={cn("p-3", !a.isPeerReviewed && "text-muted-foreground")}>
          {a.isPeerReviewed ? "Yes" : "No"}
        </td>
        <td className="px-3 py-2.5">
          <PercentCell award={a} save={save}>
            <NoteLink award={a} note={note} />
          </PercentCell>
        </td>
        <td className="p-3 text-right font-semibold">
          {money(a.cancerRelevantAnnualProjectDc)}
        </td>
        <td className="py-3 pr-5 pl-3">
          <ProgramCell award={a} rosterHref={rosterHref} />
        </td>
      </tr>
      {note.open && (
        <tr className="border-apollo-border border-b" data-testid="nci-2a-note-row">
          <td />
          <td colSpan={7} className="pr-5 pb-4">
            <NoteEditor award={a} note={note} />
          </td>
        </tr>
      )}
    </>
  );
}

const TH =
  "text-muted-foreground px-3 py-2.5 align-bottom text-xs font-semibold tracking-[0.08em] uppercase";

export function Nci2aTable({
  centerCode,
  rows,
  resetKey,
  sort,
  dir,
  sortHrefs,
  emptyMessage,
}: {
  centerCode: string;
  rows: ReadonlyArray<Nci2aAward>;
  /** The filter query string; paging resets when it changes. */
  resetKey: string;
  sort: Nci2aSortKey;
  dir: "asc" | "desc";
  sortHrefs: Record<Nci2aSortKey, string>;
  emptyMessage: string;
}) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  // Percents this table has saved, by award id, shown until the server row
  // catches up: the refresh reads the read replica, which can lag the write.
  const [written, setWritten] = React.useState<Record<string, number>>({});
  React.useEffect(() => {
    setWritten((w) => {
      const landed = rows.filter((a) => a.id in w && nci2aWriteLanded(a, w[a.id]));
      if (landed.length === 0) return w;
      const next = { ...w };
      for (const a of landed) delete next[a.id];
      return next;
    });
  }, [rows]);
  const shown = React.useMemo(
    () => rows.map((a) => (a.id in written ? applyNci2aWrite(a, written[a.id]) : a)),
    [rows, written],
  );
  const { visible, hasMore, showMore, rangeLabel } = useShowMore(shown, 25, resetKey);
  const rosterHref = `/edit/center/${encodeURIComponent(centerCode)}`;
  const aiShown = visible.filter((a) => nci2aStatus(a) === "ai").length;
  const targets = bulkAcceptTargets(visible);
  const [confirming, setConfirming] = React.useState(false);
  const [bulkBusy, setBulkBusy] = React.useState(false);
  const [bulkNote, setBulkNote] = React.useState<string | null>(null);
  // A filter or sort change (a Link, so this component keeps its state) swaps
  // the row set: drop a result note or an open confirm that was about the old one.
  const [noteKey, setNoteKey] = React.useState(resetKey);
  if (noteKey !== resetKey) {
    setNoteKey(resetKey);
    setBulkNote(null);
    setConfirming(false);
  }

  const acceptShown = async () => {
    const ids = bulkAcceptTargets(visible).map((a) => a.id);
    setError(null);
    setBulkNote(null);
    if (ids.length === 0) {
      setConfirming(false);
      return;
    }
    setBulkBusy(true);
    let result: Nci2aAcceptResult;
    try {
      const res = await fetch(`/api/edit/center/${encodeURIComponent(centerCode)}/nci-2a/accept`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ awardIds: ids }),
      });
      if (!res.ok) {
        setError(`Accept failed (${res.status}). Nothing was changed.`);
        return;
      }
      result = (await res.json()) as Nci2aAcceptResult;
    } catch {
      // No response: the POST may still have committed. Say so, and refresh so
      // the rows show whatever was actually saved.
      setError("Accept may not have finished. Reloading the rows to show what was saved.");
      React.startTransition(() => router.refresh());
      return;
    } finally {
      setBulkBusy(false);
      setConfirming(false);
    }
    // The written values, shown until the (possibly lagging) replica has them.
    setWritten((w) => {
      const next = { ...w };
      for (const a of result.accepted) next[a.awardId] = a.cancerRelevantPercent;
      return next;
    });
    const n = result.accepted.length;
    const skipped = result.skipped.length;
    setBulkNote(
      `Accepted ${n} ${n === 1 ? "suggestion" : "suggestions"}.` +
        (skipped ? ` Skipped ${skipped}: already reviewed or no percentage to accept.` : ""),
    );
    React.startTransition(() => router.refresh());
  };

  const save: Save = async (awardId, value) => {
    setError(null);
    try {
      const res = await fetch(
        `/api/edit/center/${encodeURIComponent(centerCode)}/nci-2a/${encodeURIComponent(awardId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cancerRelevantPercent: value }),
        },
      );
      if (!res.ok) {
        setError(`Save failed (${res.status}). The value was not changed.`);
        return false;
      }
    } catch {
      setError("Save failed. The value was not changed.");
      return false;
    }
    setWritten((w) => ({ ...w, [awardId]: value }));
    React.startTransition(() => router.refresh());
    return true;
  };

  /** A note or trainee-slots PATCH: no local copy beyond the field's own. */
  const patchField = async (awardId: string, body: object, what: string) => {
    setError(null);
    try {
      const res = await fetch(
        `/api/edit/center/${encodeURIComponent(centerCode)}/nci-2a/${encodeURIComponent(awardId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        setError(`Save failed (${res.status}). The ${what} was not changed.`);
        return false;
      }
    } catch {
      setError(`Save failed. The ${what} was not changed.`);
      return false;
    }
    React.startTransition(() => router.refresh());
    return true;
  };
  const saveNote: SaveNote = (awardId, note) => patchField(awardId, { reviewerNote: note }, "note");
  const saveSlots: SaveSlots = (awardId, slots) =>
    patchField(awardId, { traineeSlots: slots }, "trainee-slots value");

  const sortHeader = (k: Nci2aSortKey, label: string) => (
    <Link
      href={sortHrefs[k]}
      scroll={false}
      className="hover:text-foreground text-inherit no-underline"
      aria-label={`Sort by ${label}`}
    >
      {label}
      {sort === k && <span aria-hidden> {dir === "asc" ? "↑" : "↓"}</span>}
    </Link>
  );
  const ariaSort = (k: Nci2aSortKey) =>
    sort === k ? (dir === "asc" ? "ascending" : "descending") : undefined;

  return (
    <div data-testid="nci-2a-table">
      {(aiShown > 1 || bulkNote) && (
        <div
          className="flex flex-wrap items-center justify-end gap-3 px-5 pt-3"
          data-testid="nci-2a-bulk"
        >
          {bulkNote && (
            <p role="status" className="text-muted-foreground mr-auto text-[13px]">
              {bulkNote}
            </p>
          )}
          {aiShown > 1 &&
            (confirming ? (
              <div className="flex flex-wrap items-center gap-2" data-testid="nci-2a-bulk-confirm">
                <span className="text-[13px]">
                  Accept the AI percentage on {targets.length}{" "}
                  {targets.length === 1 ? "project" : "projects"} as is?
                </span>
                <Button size="sm" disabled={bulkBusy} onClick={() => void acceptShown()}>
                  Accept {targets.length}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={bulkBusy}
                  onClick={() => setConfirming(false)}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
                {aiShown > targets.length
                  ? `Accept the first ${targets.length} shown suggestions`
                  : `Accept ${targets.length} shown suggestions`}
              </Button>
            ))}
        </div>
      )}
      {error && (
        <p role="alert" className="text-destructive px-5 pt-3 text-sm">
          {error}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="text-muted-foreground px-5 py-8 text-sm" data-testid="nci-2a-empty">
          {emptyMessage}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1080px] border-collapse text-sm tabular-nums">
            <thead>
              <tr className="bg-apollo-surface-2 text-left">
                <th className={cn(TH, "w-[170px] pl-5")} aria-sort={ariaSort("pi")}>
                  {sortHeader("pi", "PI")}
                </th>
                <th className={cn(TH, "w-[170px]")}>Funding source</th>
                <th className={TH}>Project</th>
                <th className={cn(TH, "w-[100px] text-right")} aria-sort={ariaSort("dc")}>
                  {sortHeader("dc", "Direct costs")}
                </th>
                <th className={cn(TH, "w-[60px]")}>Peer-rev.</th>
                <th className={cn(TH, "w-[190px]")} aria-sort={ariaSort("pct")}>
                  {sortHeader("pct", "Cancer-relevant %")}
                </th>
                <th className={cn(TH, "w-[100px] text-right")} aria-sort={ariaSort("rel")}>
                  {sortHeader("rel", "Relevant DC")}
                </th>
                <th className={cn(TH, "w-[170px] pr-5")}>
                  Program
                  <div className="text-xs font-normal tracking-normal normal-case">
                    from membership
                  </div>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((a) => (
                <Nci2aRow
                  key={a.id}
                  award={a}
                  save={save}
                  saveNote={saveNote}
                  saveSlots={saveSlots}
                  rosterHref={rosterHref}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
        <span className="text-muted-foreground text-[13px]" data-testid="nci-2a-range">
          {rows.length ? `${rangeLabel} projects` : ""}
        </span>
        {hasMore && (
          <Button variant="outline" size="sm" onClick={showMore}>
            Show 25 more
          </Button>
        )}
      </div>
    </div>
  );
}
