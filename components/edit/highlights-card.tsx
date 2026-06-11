/**
 * The Highlights card (#836 data/API, #895 redesign, `SELF_EDIT_MANUAL_HIGHLIGHTS`)
 * — the scholar's opt-in manual override of the AI-chosen profile Highlights.
 *
 * One control surface over one `field_override(selectedHighlightPmids)` row, with
 * an automatic ↔ manual toggle:
 *
 *   ┌────────────────┬────────────────────────────────────────────────────────┐
 *   │ toggle / state  │ Behaviour                                               │
 *   ├────────────────┼────────────────────────────────────────────────────────┤
 *   │ ON  (automatic) │ read-only preview of the AI top-3 (numbered) with the   │
 *   │  override absent │ rest of the pubs dimmed. Nothing to save.              │
 *   │ OFF (manual)    │ editable, searchable, sortable picker seeded from the   │
 *   │  override present │ AI set; ordered selection (click order = display      │
 *   │                  │ order), capped at MAX; Save persists, Reset reverts.   │
 *   └────────────────┴────────────────────────────────────────────────────────┘
 *
 * The manual set is FROZEN: once saved it does not change when the AI re-ranks.
 * The picker offers only the scholar's own (non-suppressed) publications; the row
 * impact + type ride the data the AI ranking already loaded (no extra query).
 *
 * Endpoints (existing self-edit machinery — no new endpoint):
 *   POST /api/edit/field        { fieldName: "selectedHighlightPmids", value: [] }
 *   POST /api/edit/clear-field  { fieldName: "selectedHighlightPmids" }
 *
 * Editable by the scholar (self) OR a superuser on their behalf — the loader
 * populates `ctx.highlights` only for an allowed actor behind the flag, and the
 * write route re-authorizes self OR superuser. A superuser sees the same controls
 * with the descriptive copy reframed to the scholar's name (`mode`).
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CheckIcon, CopyIcon } from "lucide-react";

import { EditPanel } from "@/components/edit/edit-panel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import type { EditContextHighlights } from "@/lib/api/edit-context";
import { MAX_SELECTED_HIGHLIGHTS as MAX } from "@/lib/edit/validators";
import { NEVER_DISPLAY_TYPES, displayPublicationType } from "@/lib/publication-types";
import { cn } from "@/lib/utils";

export type HighlightsCardProps = {
  cwid: string;
  /** `superuser` reframes the descriptive copy to the scholar's name — a
   *  superuser curating another scholar's Highlights on their behalf. */
  mode: "self" | "superuser";
  scholarName: string;
  highlights: EditContextHighlights;
};

type SortMode = "impact" | "recent";

const GENERIC_ERROR =
  "Something went wrong — the highlights weren't saved. Please try again.";

const SORT_OPTIONS: ReadonlyArray<{ value: SortMode; label: string }> = [
  { value: "impact", label: "Impact" },
  { value: "recent", label: "Most recent" },
];

const NEVER_DISPLAY: readonly string[] = NEVER_DISPLAY_TYPES;

export function HighlightsCard({ cwid, mode, scholarName, highlights }: HighlightsCardProps) {
  const router = useRouter();
  const su = mode === "superuser";
  const possessive = su ? `${scholarName}’s` : "your";

  // `auto` is the live view: automatic preview (true) vs manual editing (false).
  // The scholar is opted in iff a manual override exists.
  const [auto, setAuto] = React.useState(!highlights.manualEnabled);
  // The working manual selection, ordered (click order == display order).
  const [selection, setSelection] = React.useState<string[]>(() =>
    highlights.manualEnabled ? [...highlights.manualPmids] : [...highlights.aiPmids],
  );
  // The committed (server) manual selection — the dirty baseline for Save.
  const [saved, setSaved] = React.useState<string[]>([...highlights.manualPmids]);
  // Whether a manual override is currently persisted (governs revert-on-toggle).
  const [savedManual, setSavedManual] = React.useState(highlights.manualEnabled);
  const [query, setQuery] = React.useState("");
  const [sort, setSort] = React.useState<SortMode>("impact");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [justSaved, setJustSaved] = React.useState(false);
  const [copied, setCopied] = React.useState<string | null>(null);

  const dirty =
    !auto && (selection.length !== saved.length || selection.some((p, i) => p !== saved[i]));
  const canSave = !auto && dirty && selection.length > 0 && !busy;

  // The AI top-3, by rank — used for the read-only automatic preview numbering.
  const aiRank = React.useMemo(() => {
    const m = new Map<string, number>();
    highlights.aiPmids.forEach((pmid, i) => m.set(pmid, i + 1));
    return m;
  }, [highlights.aiPmids]);

  // Filter (title / journal / PMID) then sort (Impact or Most recent).
  const rows = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = highlights.pickable.filter((p) => {
      if (!q) return true;
      return (
        p.title.toLowerCase().includes(q) ||
        (p.journal ?? "").toLowerCase().includes(q) ||
        p.pmid.includes(q)
      );
    });
    const sorted = [...filtered];
    if (sort === "recent") {
      sorted.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || b.impact - a.impact);
    } else {
      sorted.sort((a, b) => b.impact - a.impact || (b.year ?? 0) - (a.year ?? 0));
    }
    return sorted;
  }, [highlights.pickable, query, sort]);

  function clearTransient() {
    setError(null);
    setJustSaved(false);
  }

  function rankOf(pmid: string): number {
    if (auto) return aiRank.get(pmid) ?? 0;
    const i = selection.indexOf(pmid);
    return i < 0 ? 0 : i + 1;
  }

  function goManual() {
    clearTransient();
    setAuto(false);
    // Seed the manual set from the current AI highlights so the scholar edits a
    // populated list rather than starting empty.
    setSelection((cur) => (cur.length === 0 ? [...highlights.aiPmids] : cur));
  }

  async function goAuto() {
    clearTransient();
    if (!savedManual) {
      // Nothing persisted yet — just flip back to the automatic preview.
      setAuto(true);
      setSelection([...highlights.aiPmids]);
      return;
    }
    // A manual override is stored; reverting to automatic clears it server-side.
    setBusy(true);
    try {
      const res = await fetch("/api/edit/clear-field", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entityType: "scholar",
          entityId: cwid,
          fieldName: "selectedHighlightPmids",
        }),
      });
      const data = (await res.json()) as { ok: boolean };
      if (!res.ok || data.ok !== true) {
        setError(GENERIC_ERROR);
        return;
      }
      setAuto(true);
      setSavedManual(false);
      setSaved([]);
      setSelection([...highlights.aiPmids]);
      router.refresh();
    } catch {
      setError(GENERIC_ERROR);
    } finally {
      setBusy(false);
    }
  }

  function onToggleAuto(checked: boolean) {
    if (busy) return;
    if (checked) void goAuto();
    else goManual();
  }

  function togglePick(pmid: string) {
    if (auto) return;
    clearTransient();
    setSelection((cur) => {
      if (cur.includes(pmid)) return cur.filter((p) => p !== pmid);
      if (cur.length >= MAX) return cur; // cap reached — ignore further picks
      return [...cur, pmid];
    });
  }

  async function save() {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/edit/field", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entityType: "scholar",
          entityId: cwid,
          fieldName: "selectedHighlightPmids",
          value: selection,
        }),
      });
      const data = (await res.json()) as { ok: boolean };
      if (!res.ok || data.ok !== true) {
        setError(GENERIC_ERROR);
        return;
      }
      setSaved([...selection]);
      setSavedManual(true);
      setJustSaved(true);
      router.refresh();
    } catch {
      setError(GENERIC_ERROR);
    } finally {
      setBusy(false);
    }
  }

  async function copyPmid(pmid: string) {
    try {
      await navigator.clipboard?.writeText(pmid);
      setCopied(pmid);
      setTimeout(() => setCopied((c) => (c === pmid ? null : c)), 1200);
    } catch {
      /* clipboard unavailable — silent no-op */
    }
  }

  const hasPickable = highlights.pickable.length > 0;

  return (
    <EditPanel
      slot="highlights-card"
      heading="Highlights"
      owned
      description={
        <>
          Highlights are the publications featured at the top of {possessive} profile. By default
          they&rsquo;re chosen{su ? "" : " for you"} by ReCiterAI from {su ? "their" : "your"}{" "}
          first- and senior-author work, weighted by impact and recency. You can instead choose up
          to {MAX} {su ? "on their behalf" : "yourself"} &mdash; a manual set stays fixed and
          won&rsquo;t change when the automatic ranking updates.
        </>
      }
    >
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {!hasPickable ? (
        <Alert variant="info">
          <AlertDescription>
            {su ? (
              <>
                {scholarName} doesn&rsquo;t have any displayed publications yet, so there&rsquo;s
                nothing to highlight. Once their publications appear on the profile you can choose
                highlights here.
              </>
            ) : (
              <>
                You don&rsquo;t have any displayed publications yet, so there&rsquo;s nothing to
                highlight. Once your publications appear on your profile you can choose your own
                highlights here.
              </>
            )}
          </AlertDescription>
        </Alert>
      ) : (
        <div className="flex flex-col gap-4">
          {/* Mode block — the focal automatic/manual control. */}
          <div
            className={cn(
              "flex items-start gap-4 rounded-lg border p-4 transition-colors",
              auto
                ? "border-apollo-border-strong bg-apollo-surface-2/40"
                : "border-apollo-maroon/30 bg-apollo-surface",
            )}
            data-testid="highlights-mode"
          >
            <div className="flex flex-col items-center gap-1.5 pt-0.5">
              <Switch
                checked={auto}
                onCheckedChange={onToggleAuto}
                disabled={busy}
                aria-label="Choose highlights automatically"
                data-testid="highlights-auto-switch"
              />
              <span className="text-muted-foreground text-[11px] font-bold tracking-wide">
                {auto ? "ON" : "OFF"}
              </span>
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">
                {auto ? "Choosing highlights automatically" : "Choosing highlights manually"}
              </p>
              <p className="text-muted-foreground mt-0.5 text-sm">
                {auto
                  ? `ReCiterAI selects the top first- and senior-author work, weighted by impact and recency, and refreshes the picks as new papers are attributed. Turn this off to choose ${
                      su ? "them on their behalf" : "your own"
                    }.`
                  : "Pick up to three publications below. They appear in the order you select them, and stay fixed until you change them — they won’t update when new papers come in."}
              </p>
            </div>
          </div>

          {/* Toolbar — filter, sort, and (manual only) the selection counter. */}
          <div className="flex flex-wrap items-center gap-3">
            <Input
              type="search"
              aria-label="Filter highlights by title, journal, or PMID"
              placeholder="Filter by title, journal, or PMID"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="border-apollo-border-strong min-w-[220px] flex-1"
              data-testid="highlights-search"
            />
            <label className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
              Sort
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as SortMode)}
                className="border-apollo-border bg-apollo-surface-2 text-foreground rounded border px-2 py-1 text-xs"
                data-testid="highlights-sort"
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <span
              className="bg-apollo-maroon/10 text-apollo-maroon rounded-full px-2.5 py-1 text-xs font-semibold whitespace-nowrap"
              data-testid="highlights-counter"
            >
              {auto ? highlights.aiPmids.length : selection.length} of {MAX} selected
            </span>
          </div>

          {/* The pickable list (read-only preview in automatic mode). */}
          {rows.length === 0 ? (
            <p className="text-muted-foreground py-6 text-center text-sm">
              No publications match &ldquo;{query}&rdquo;.
            </p>
          ) : (
            <ScrollArea className="md:h-[60vh]">
              <ul className="divide-apollo-border divide-y" data-testid="highlights-picker">
                {rows.map((p) => {
                  const rank = rankOf(p.pmid);
                  const picked = rank > 0;
                  const blocked = !auto && !picked && selection.length >= MAX;
                  const typeLabel =
                    p.publicationType && !NEVER_DISPLAY.includes(p.publicationType)
                      ? displayPublicationType(p.publicationType)
                      : "";
                  const inner = (
                    <>
                      <span
                        aria-hidden="true"
                        className={cn(
                          "mt-0.5 flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border-[1.8px] text-xs font-bold",
                          picked
                            ? "border-apollo-maroon bg-apollo-maroon text-white"
                            : blocked
                              ? "border-apollo-border-strong border-dashed text-transparent"
                              : "border-apollo-border-strong text-transparent",
                        )}
                      >
                        {picked ? rank : ""}
                      </span>
                      <span className="flex min-w-0 flex-col gap-1">
                        <span className="text-sm leading-snug font-medium">{p.title}</span>
                        <span className="text-muted-foreground text-xs">
                          {p.journal ? (
                            <>
                              <em>{p.journal}</em>
                              {p.year ? ` · ${p.year}` : ""}
                            </>
                          ) : (
                            (p.year ?? "")
                          )}
                        </span>
                        <span className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                          <span className="inline-flex items-center gap-1 tabular-nums">
                            PMID {p.pmid}
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                void copyPmid(p.pmid);
                              }}
                              className="text-muted-foreground hover:text-apollo-maroon inline-flex items-center"
                              aria-label={`Copy PMID ${p.pmid}`}
                              data-testid={`highlights-copy-${p.pmid}`}
                            >
                              {copied === p.pmid ? (
                                <CheckIcon className="text-apollo-green size-3.5" />
                              ) : (
                                <CopyIcon className="size-3.5" />
                              )}
                            </button>
                          </span>
                          {typeLabel && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="bg-apollo-surface-2 text-foreground/70 rounded px-1.5 py-0.5 text-[10px] font-medium">
                                {typeLabel}
                              </span>
                            </>
                          )}
                          {p.impact > 0 && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span>
                                Impact:{" "}
                                <span className="text-foreground font-medium tabular-nums">
                                  {Math.round(p.impact)}
                                </span>
                              </span>
                            </>
                          )}
                        </span>
                      </span>
                    </>
                  );
                  return (
                    <li key={p.pmid}>
                      {auto ? (
                        <div
                          className="flex items-start gap-3 px-1 py-3"
                          data-testid={`highlights-row-${p.pmid}`}
                        >
                          {inner}
                        </div>
                      ) : (
                        <div
                          role="button"
                          tabIndex={blocked || busy ? -1 : 0}
                          aria-pressed={picked}
                          aria-disabled={blocked || busy}
                          onClick={() => {
                            if (!blocked && !busy) togglePick(p.pmid);
                          }}
                          onKeyDown={(e) => {
                            if ((e.key === "Enter" || e.key === " ") && !blocked && !busy) {
                              e.preventDefault();
                              togglePick(p.pmid);
                            }
                          }}
                          className={cn(
                            "flex items-start gap-3 rounded-md px-1 py-3 text-left transition-colors",
                            blocked
                              ? "cursor-not-allowed"
                              : "hover:bg-apollo-surface-2 cursor-pointer",
                          )}
                          data-testid={`highlights-row-${p.pmid}`}
                        >
                          {inner}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </ScrollArea>
          )}

          {/* Footer — status, mode switch button, and Save. */}
          <div className="border-apollo-border flex flex-wrap items-center gap-3 border-t pt-4">
            <p className="text-muted-foreground flex-1 text-sm" data-testid="highlights-status">
              {auto ? (
                <>
                  <span className="text-foreground font-medium">Automatic.</span> These three stay
                  current as new work is attributed.
                </>
              ) : selection.length === 0 ? (
                "Select at least one publication to feature."
              ) : (
                <>
                  <span className="text-foreground font-medium">{selection.length}</span> selected,
                  in display order.
                </>
              )}
            </p>
            {justSaved && !dirty && !auto && (
              <span
                className="text-sm text-[var(--color-accent-slate)]"
                data-testid="highlights-saved"
              >
                Saved.
              </span>
            )}
            <Button
              type="button"
              variant="outline"
              data-testid="highlights-opt-in"
              onClick={() => {
                if (auto) goManual();
                else void goAuto();
              }}
              disabled={busy}
            >
              {auto ? "Choose manually" : "Reset to automatic"}
            </Button>
            <Button
              type="button"
              variant="apollo"
              data-testid="highlights-save"
              onClick={save}
              disabled={!canSave}
            >
              {busy ? "Saving…" : "Save highlights"}
            </Button>
          </div>
        </div>
      )}
    </EditPanel>
  );
}
