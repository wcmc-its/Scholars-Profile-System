/**
 * "Mentees › Suggested mentees › From your Faculty Review" — mentees the
 * scholar listed in the annual Faculty Review Tool (`frt_mentee`). Rendered
 * inside `MenteeSuggestionsCard`, same gate and same accept path (append to
 * `manualMentees`).
 *
 * FRT names mentees in free text. A CWID (name match, or linked here through
 * the directory picker) is what makes the mentee's co-publications show on the
 * profile and counts the pair in the Mentored publications report, so a
 * name-only row says so and offers the picker first.
 */
"use client";

import * as React from "react";

import {
  DirectoryPeopleTypeahead,
  type DirectoryValue,
} from "@/components/edit/directory-people-typeahead";
import { EditPanel } from "@/components/edit/edit-panel";
import { MenteeForm, draftToEntry, type Draft } from "@/components/edit/manual-mentees-card";
import { Button } from "@/components/ui/button";
import type { EditContextFrtMentee } from "@/lib/api/edit-context";
import type { ManualMentee } from "@/lib/edit/manual-mentee";

const GENERIC_ERROR = "We couldn’t update this just now. Please try again.";

function years(r: EditContextFrtMentee): string {
  return r.firstReviewYear === r.lastReviewYear
    ? String(r.lastReviewYear)
    : `${r.firstReviewYear}–${r.lastReviewYear}`;
}

export function FrtMenteeSuggestions({
  rows,
  su,
  scholarName,
  addMentee,
}: {
  rows: ReadonlyArray<EditContextFrtMentee>;
  su: boolean;
  scholarName: string;
  /** Appends to manualMentees; resolves to an error message, or null on success. */
  addMentee: (entry: ManualMentee) => Promise<string | null>;
}) {
  // Local overlays on the server rows; `router.refresh()` (in addMentee)
  // re-renders from the server after an add.
  const [patch, setPatch] = React.useState<Map<number, Partial<EditContextFrtMentee>>>(new Map());
  const [added, setAdded] = React.useState<Set<number>>(new Set());
  const [errors, setErrors] = React.useState<Map<number, string>>(new Map());
  const [busy, setBusy] = React.useState<Set<number>>(new Set());

  const view = rows.filter((r) => !added.has(r.id)).map((r) => ({ ...r, ...patch.get(r.id) }));
  const active = view.filter((r) => r.dismissedAt === null);
  const gone = view.filter((r) => r.dismissedAt !== null);

  function setErr(id: number, msg: string | null) {
    setErrors((m) => {
      const next = new Map(m);
      if (msg === null) next.delete(id);
      else next.set(id, msg);
      return next;
    });
  }

  /** POST one op; applies `local` on success. */
  async function act(
    r: EditContextFrtMentee,
    body: Record<string, unknown>,
    local: Partial<EditContextFrtMentee>,
  ) {
    setErr(r.id, null);
    setBusy((b) => new Set(b).add(r.id));
    try {
      const res = await fetch(`/api/edit/frt-mentees/${r.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
      if (!res.ok || data.ok !== true) throw new Error("write_failed");
      setPatch((m) => new Map(m).set(r.id, { ...m.get(r.id), ...local }));
    } catch {
      setErr(r.id, GENERIC_ERROR);
    } finally {
      setBusy((b) => {
        const next = new Set(b);
        next.delete(r.id);
        return next;
      });
    }
  }

  async function onAdd(r: EditContextFrtMentee, draft: Draft): Promise<boolean> {
    setErr(r.id, null);
    const err = await addMentee(draftToEntry(draft));
    if (err) {
      setErr(r.id, err);
      return false;
    }
    setAdded((a) => new Set(a).add(r.id));
    return true;
  }

  return (
    <EditPanel
      slot="frt-mentee-suggestions-panel"
      heading="From your Faculty Review"
      description={
        su
          ? `Mentees ${scholarName} listed in the annual Faculty Review Tool. Nothing here is public until it is added. Link each one to a WCM person so their co-publications show on the profile and count in mentoring reports.`
          : "Mentees you listed in the annual Faculty Review Tool. Nothing here is public until you add it. Link each one to a WCM person so their co-publications show on your profile and count in mentoring reports."
      }
    >
      {active.length === 0 ? (
        <p className="text-muted-foreground text-sm" data-testid="frt-mentees-empty">
          Nothing left to review from your Faculty Review.
        </p>
      ) : (
        <ul
          className="border-apollo-border divide-apollo-border divide-y rounded-md border"
          data-testid="frt-mentees-list"
        >
          {active.map((r) => (
            <FrtRow
              key={r.id}
              r={r}
              su={su}
              scholarName={scholarName}
              busy={busy.has(r.id)}
              error={errors.get(r.id) ?? null}
              onAssign={(v) =>
                act(
                  r,
                  { op: "assign", cwid: v?.cwid ?? null },
                  {
                    menteeCwid: v?.cwid ?? null,
                    menteeCwidName: v?.name ?? null,
                    cwidAssigned: true,
                  },
                )
              }
              onDismiss={() => act(r, { op: "dismiss" }, { dismissedAt: new Date().toISOString() })}
              onAdd={(d) => onAdd(r, d)}
            />
          ))}
        </ul>
      )}

      {gone.length > 0 && (
        <details data-testid="frt-mentees-dismissed">
          <summary className="text-apollo-slate cursor-pointer text-sm font-medium">
            {gone.length} dismissed
          </summary>
          <ul className="mt-2 flex flex-col gap-2">
            {gone.map((r) => (
              <li
                key={r.id}
                className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 text-sm"
                data-testid={`frt-mentee-dismissed-${r.id}`}
              >
                <span>
                  <span className="text-foreground">{r.menteeName}</span> · {years(r)}
                  {errors.get(r.id) ? (
                    <span className="text-destructive"> · {errors.get(r.id)}</span>
                  ) : null}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy.has(r.id)}
                  onClick={() => act(r, { op: "restore" }, { dismissedAt: null })}
                  data-testid={`frt-mentee-restore-${r.id}`}
                >
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </EditPanel>
  );
}

function FrtRow({
  r,
  su,
  scholarName,
  busy,
  error,
  onAssign,
  onDismiss,
  onAdd,
}: {
  r: EditContextFrtMentee;
  su: boolean;
  scholarName: string;
  busy: boolean;
  error: string | null;
  onAssign: (v: DirectoryValue | null) => Promise<void>;
  onDismiss: () => void;
  onAdd: (d: Draft) => Promise<boolean>;
}) {
  const [panel, setPanel] = React.useState<"add" | "link" | null>(null);
  const [pick, setPick] = React.useState<DirectoryValue | null>(null);

  return (
    <li className="flex flex-col gap-2 p-4" data-testid={`frt-mentee-${r.id}`}>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-[15px] font-medium">{r.menteeName}</span>
        {r.mentoringType && (
          <span className="border-apollo-slate-tint-border bg-apollo-slate-tint text-apollo-slate rounded-full border px-2 py-0.5 text-[11px] font-medium">
            {r.mentoringType}
          </span>
        )}
        {r.external && <span className="text-muted-foreground text-xs">Outside WCM</span>}
      </div>
      <p className="text-muted-foreground text-sm">Reported in Faculty Review {years(r)}</p>

      <p className="text-sm" data-testid={`frt-mentee-match-${r.id}`}>
        {r.menteeCwid ? (
          <>
            WCM person: <span className="font-medium">{r.menteeCwidName ?? r.menteeCwid}</span>{" "}
            <span className="text-muted-foreground text-xs">
              {r.menteeCwid}
              {r.cwidAssigned ? "" : " · matched by name"}
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">
            Not linked to a WCM person — co-publications won’t show and it won’t count in mentoring
            reports until it is.
          </span>
        )}
      </p>

      {panel === "link" ? (
        <div className="flex flex-col gap-2" data-testid={`frt-mentee-link-form-${r.id}`}>
          <DirectoryPeopleTypeahead
            value={pick}
            onChange={setPick}
            idPrefix={`frt-${r.id}`}
            placeholder={`Search the WCM directory for ${r.menteeName}…`}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => setPanel(null)}
            >
              Cancel
            </Button>
            {r.menteeCwid && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void onAssign(null).then(() => setPanel(null))}
                data-testid={`frt-mentee-unlink-${r.id}`}
              >
                Not a WCM person
              </Button>
            )}
            <Button
              type="button"
              variant="apollo"
              size="sm"
              disabled={busy || pick === null}
              onClick={() => void onAssign(pick).then(() => setPanel(null))}
              data-testid={`frt-mentee-link-save-${r.id}`}
            >
              Save
            </Button>
          </div>
        </div>
      ) : panel === "add" ? (
        <div data-testid={`frt-mentee-add-form-${r.id}`}>
          <p className="mb-2 text-sm font-medium">
            Add {r.menteeName} as a mentee{su ? ` of ${scholarName}` : ""}
          </p>
          <MenteeForm
            idPrefix={`frt-add-${r.id}`}
            initial={{
              cwid: r.menteeCwid ?? "",
              name: r.menteeCwidName ?? r.menteeName,
              programLabel: r.mentoringType ?? "",
              year: "",
            }}
            submitLabel="Save"
            busy={busy}
            onSubmit={(d) => void onAdd(d)}
            onCancel={() => setPanel(null)}
          />
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => setPanel("link")}
            data-testid={`frt-mentee-link-${r.id}`}
          >
            {r.menteeCwid ? "Change person" : "Link to a WCM person"}
          </Button>
          <Button
            type="button"
            variant="apollo"
            size="sm"
            disabled={busy}
            onClick={() => setPanel("add")}
            data-testid={`frt-mentee-add-${r.id}`}
          >
            {su ? `Add for ${scholarName}` : "Add as mentee"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={onDismiss}
            data-testid={`frt-mentee-not-${r.id}`}
          >
            Not a mentee
          </Button>
        </div>
      )}

      {error && (
        <p className="text-destructive text-sm" data-testid={`frt-mentee-error-${r.id}`}>
          {error}
        </p>
      )}
    </li>
  );
}
