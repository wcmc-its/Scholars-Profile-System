/**
 * The Highlights card (#836, `SELF_EDIT_MANUAL_HIGHLIGHTS`) — the scholar's
 * opt-in manual override of the AI-chosen profile Highlights.
 *
 * Two states over one `field_override(selectedHighlightPmids)` row:
 *
 *   ┌──────────────┬──────────────────────────────────────────────────────────┐
 *   │ override      │ Controls                                                  │
 *   ├──────────────┼──────────────────────────────────────────────────────────┤
 *   │ absent (AI)   │ "Choose my highlights manually" → reveals the picker,     │
 *   │               │ seeded with the current AI highlights.                    │
 *   │ present       │ ordered picker + Save; "Use AI-selected highlights"       │
 *   │ (manual)      │ clears the override (revert to AI).                       │
 *   └──────────────┴──────────────────────────────────────────────────────────┘
 *
 * The manual set is FROZEN: once saved it does not change when the AI re-ranks.
 * The picker offers only the scholar's own (non-suppressed) publications, capped
 * at {@link MAX} — the same count the public Highlights section shows. Selection
 * is ordered (click order is display order); the order badges make that visible.
 *
 * Endpoints (existing self-edit machinery — no new endpoint):
 *   POST /api/edit/field        { fieldName: "selectedHighlightPmids", value: [] }
 *   POST /api/edit/clear-field  { fieldName: "selectedHighlightPmids" }
 *
 * Editable by the scholar (self) OR a superuser on their behalf — the loader
 * populates `ctx.highlights` only for an allowed actor behind the flag (self on
 * `/edit`; self or superuser on `/edit/scholar/[cwid]`; never a proxy / unit
 * admin), and the write route re-authorizes self OR superuser. A superuser sees
 * the same controls with the copy reframed to the scholar's name (`mode`).
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { EditPanel } from "@/components/edit/edit-panel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { EditContextHighlights } from "@/lib/api/edit-context";
import { MAX_SELECTED_HIGHLIGHTS as MAX } from "@/lib/edit/validators";

export type HighlightsCardProps = {
  cwid: string;
  /** `superuser` reframes the first-person copy to the scholar's name — a
   *  superuser curating another scholar's Highlights on their behalf. */
  mode: "self" | "superuser";
  scholarName: string;
  highlights: EditContextHighlights;
};

const GENERIC_ERROR =
  "Something went wrong — the highlights weren't saved. Please try again.";

export function HighlightsCard({ cwid, mode, scholarName, highlights }: HighlightsCardProps) {
  const router = useRouter();
  // Copy reframes for a superuser editing on the scholar's behalf (mirrors the
  // sibling Mentees / Funding cards): "your" → "{Name}'s", "yourself" → "on
  // their behalf". `Possessive` is sentence-initial (capitalized); `possessive`
  // is mid-sentence.
  const su = mode === "superuser";
  const possessive = su ? `${scholarName}’s` : "your";
  const Possessive = su ? `${scholarName}’s` : "Your";
  // The scholar opted in iff a manual override exists. The picker is editable
  // whenever opted in; the opt-in toggle reveals it (seeded with the AI set).
  const [optedIn, setOptedIn] = React.useState(highlights.manualEnabled);
  // The committed (server) selection, the dirty baseline for the Save button.
  const [saved, setSaved] = React.useState<string[]>([...highlights.manualPmids]);
  // The working selection, ordered (click order == display order).
  const [selection, setSelection] = React.useState<string[]>(() =>
    highlights.manualEnabled ? [...highlights.manualPmids] : [...highlights.aiPmids],
  );
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [justSaved, setJustSaved] = React.useState(false);

  const titleByPmid = React.useMemo(
    () => new Map(highlights.pickable.map((p) => [p.pmid, p.title])),
    [highlights.pickable],
  );

  const dirty =
    optedIn &&
    (selection.length !== saved.length || selection.some((p, i) => p !== saved[i]));
  const canSave = optedIn && dirty && selection.length > 0 && !busy;

  function toggle(pmid: string) {
    setError(null);
    setJustSaved(false);
    setSelection((cur) => {
      if (cur.includes(pmid)) return cur.filter((p) => p !== pmid);
      if (cur.length >= MAX) return cur; // cap reached — ignore further picks
      return [...cur, pmid];
    });
  }

  function startManual() {
    setError(null);
    setJustSaved(false);
    setOptedIn(true);
    // Seed the manual set from the current AI highlights so the scholar edits a
    // populated list rather than starting empty.
    setSelection([...highlights.aiPmids]);
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
      setJustSaved(true);
      router.refresh();
    } catch {
      setError(GENERIC_ERROR);
    } finally {
      setBusy(false);
    }
  }

  async function revertToAi() {
    setBusy(true);
    setError(null);
    setJustSaved(false);
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
      setOptedIn(false);
      setSaved([]);
      setSelection([...highlights.aiPmids]);
      router.refresh();
    } catch {
      setError(GENERIC_ERROR);
    } finally {
      setBusy(false);
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
      ) : !optedIn ? (
        <div className="flex flex-col gap-3">
          <p className="text-muted-foreground text-sm">
            {Possessive} highlights are currently selected automatically.
          </p>
          <Button
            type="button"
            variant="outline"
            className="w-fit"
            data-testid="highlights-opt-in"
            onClick={startManual}
            disabled={busy}
          >
            {su ? "Choose highlights manually" : "Choose my highlights manually"}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-sm">
            Select up to {MAX} publications. The order you pick them is the order they appear.
            {selection.length >= MAX && (
              <span className="text-muted-foreground"> (maximum reached)</span>
            )}
          </p>
          <ul className="flex flex-col gap-1.5" data-testid="highlights-picker">
            {highlights.pickable.map((pub) => {
              const idx = selection.indexOf(pub.pmid);
              const picked = idx >= 0;
              const atCap = !picked && selection.length >= MAX;
              return (
                <li key={pub.pmid}>
                  <button
                    type="button"
                    aria-pressed={picked}
                    disabled={atCap || busy}
                    onClick={() => toggle(pub.pmid)}
                    className="border-apollo-border hover:bg-apollo-surface-2 flex w-full items-start gap-3 rounded-md border px-3 py-2 text-left text-sm aria-pressed:border-[var(--color-accent-slate)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span
                      aria-hidden="true"
                      className="bg-apollo-maroon/10 text-apollo-maroon mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
                    >
                      {picked ? idx + 1 : ""}
                    </span>
                    <span className="flex flex-col">
                      <span className="font-medium">{pub.title}</span>
                      <span className="text-muted-foreground text-xs">
                        {[pub.journal, pub.year].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          {selection.length === 0 && (
            <Alert variant="info">
              <AlertDescription>
                Select at least one publication, or switch back to automatic highlights below.
              </AlertDescription>
            </Alert>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="apollo"
              data-testid="highlights-save"
              onClick={save}
              disabled={!canSave}
            >
              {busy ? "Saving…" : "Save highlights"}
            </Button>
            <Button
              type="button"
              variant="outline"
              data-testid="highlights-revert"
              onClick={revertToAi}
              disabled={busy}
            >
              Use AI-selected highlights
            </Button>
            {justSaved && !dirty && (
              <span className="text-sm text-[var(--color-accent-slate)]" data-testid="highlights-saved">
                Saved.
              </span>
            )}
          </div>
        </div>
      )}
    </EditPanel>
  );
}
