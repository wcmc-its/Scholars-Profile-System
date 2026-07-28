/**
 * ManualMenteesCard — the "Added by you" editor for mentees no source system
 * recorded (#2011), shown above the derived, hide-only Mentees panel.
 *
 * Mirrors `profile-appointments-card.tsx` (inline add/edit form, Edit/Remove per
 * row) with one deliberate simplification: the whole list is ONE
 * `field_override` JSON array, not a table of rows, so there is no per-row id,
 * no dedicated GET route, and no fetch on mount. The server-rendered
 * `EditContext.manualMentees` seeds local state and every mutation POSTs the
 * ENTIRE array to `/api/edit/field` — the same contract `highlights-card.tsx`
 * uses for `selectedHighlightPmids`.
 *
 * ponytail: full-array writes mean two editors racing on one profile clobber
 * each other last-write-wins. Same exposure `selectedHighlightPmids` already
 * carries, and the realistic concurrency is one mentor editing their own list.
 * Move to a table with per-row ids if concurrent curation ever becomes real.
 *
 * Visual design follows the appointments card (native controls, no bespoke
 * chrome); like that card it wants a staging design pass.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { EditPanel } from "@/components/edit/edit-panel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isCwid } from "@/lib/cwid";
import { MAX_MANUAL_MENTEES, type ManualMentee } from "@/lib/edit/manual-mentee";

/** The editable draft the add / edit form works on (strings, blank = unset). */
type Draft = {
  name: string;
  cwid: string;
  programLabel: string;
  year: string;
};

const EMPTY_DRAFT: Draft = { name: "", cwid: "", programLabel: "", year: "" };

const GENERIC_ERROR = "Something went wrong — your changes weren’t saved. Please try again.";

export type ManualMenteesCardProps = {
  cwid: string;
  mode: "self" | "superuser";
  scholarName: string;
  initial: ReadonlyArray<ManualMentee>;
};

export function ManualMenteesCard({ cwid, mode, scholarName, initial }: ManualMenteesCardProps) {
  const router = useRouter();
  const possessive = mode === "superuser" ? `${scholarName}'s` : "your";

  const [rows, setRows] = React.useState<ManualMentee[]>([...initial]);
  const [adding, setAdding] = React.useState(false);
  const [editingIndex, setEditingIndex] = React.useState<number | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  /** Persist `next` as the whole array; only commit to local state on success so
   *  a rejected write leaves the card showing what is actually stored. */
  async function save(next: ManualMentee[]): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/edit/field", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entityType: "scholar",
          entityId: cwid,
          fieldName: "manualMentees",
          value: next,
        }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || data.ok !== true) {
        setError(mapErrorToMessage(data.error ?? ""));
        return false;
      }
      setRows(next);
      router.refresh();
      return true;
    } catch {
      setError(GENERIC_ERROR);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function addRow(draft: Draft) {
    if (await save([...rows, draftToEntry(draft)])) setAdding(false);
  }

  async function updateRow(index: number, draft: Draft) {
    const next = rows.map((r, i) => (i === index ? draftToEntry(draft) : r));
    if (await save(next)) setEditingIndex(null);
  }

  async function removeRow(index: number) {
    const next = rows.filter((_, i) => i !== index);
    if (await save(next)) setEditingIndex(null);
  }

  const atCap = rows.length >= MAX_MANUAL_MENTEES;

  return (
    <EditPanel
      slot="manual-mentees-card"
      heading="Added by you"
      owned
      subsection
      description={`Add mentees the training records don't carry — visiting students, trainees from another institution, or anyone who predates the systems we read. These appear on ${possessive} public profile alongside the mentees we already know about.`}
    >
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">No mentees added yet.</p>
      ) : (
        <ul className="flex flex-col gap-3" data-testid="manual-mentee-list">
          {rows.map((row, index) =>
            editingIndex === index ? (
              <li key={index}>
                <MenteeForm
                  idPrefix={`edit-${index}`}
                  initial={entryToDraft(row)}
                  submitLabel="Save"
                  busy={busy}
                  onSubmit={(d) => updateRow(index, d)}
                  onCancel={() => {
                    setEditingIndex(null);
                    setError(null);
                  }}
                />
              </li>
            ) : (
              <li
                key={index}
                className="border-apollo-border flex items-start gap-3 rounded-md border p-3"
                data-testid={`manual-mentee-${index}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-[14px] font-normal">{row.name}</span>
                    {row.cwid ? (
                      <span className="text-muted-foreground text-xs">{row.cwid}</span>
                    ) : null}
                  </div>
                  {metaLine(row) ? (
                    <div className="text-muted-foreground mt-0.5 text-sm">{metaLine(row)}</div>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setEditingIndex(index);
                      setAdding(false);
                      setError(null);
                    }}
                    data-testid={`manual-mentee-edit-${index}`}
                  >
                    Edit
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => removeRow(index)}
                    data-testid={`manual-mentee-remove-${index}`}
                  >
                    Remove
                  </Button>
                </div>
              </li>
            ),
          )}
        </ul>
      )}

      {adding ? (
        <MenteeForm
          idPrefix="add"
          initial={EMPTY_DRAFT}
          submitLabel="Add mentee"
          busy={busy}
          onSubmit={addRow}
          onCancel={() => {
            setAdding(false);
            setError(null);
          }}
        />
      ) : atCap ? (
        <p className="text-muted-foreground text-sm">
          You&rsquo;ve added the maximum of {MAX_MANUAL_MENTEES} mentees. Remove one to add another.
        </p>
      ) : (
        <div>
          <Button
            type="button"
            variant="default"
            className="bg-[var(--color-facet-topic-count)] text-white hover:bg-[var(--color-facet-topic-count)] hover:brightness-95 focus-visible:ring-[var(--color-facet-topic-count)]"
            disabled={busy}
            onClick={() => {
              setAdding(true);
              setEditingIndex(null);
              setError(null);
            }}
            data-testid="manual-mentee-add"
          >
            Add a mentee
          </Button>
        </div>
      )}

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </EditPanel>
  );
}

/**
 * The add / edit form. CWID comes FIRST and states what it buys — a mentee
 * entered with one gets their photo, a link to their profile, and the
 * publications they co-authored with the mentor, all of which key on CWID. It
 * stays optional on purpose: the trainees this card exists for are the ones
 * least likely to have a CWID the mentor can produce.
 */
function MenteeForm({
  idPrefix,
  initial,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: {
  idPrefix: string;
  initial: Draft;
  submitLabel: string;
  busy: boolean;
  onSubmit: (draft: Draft) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = React.useState<Draft>(initial);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  const nameOk = draft.name.trim().length > 0;
  // Client mirrors of the server rules (`lib/edit/manual-mentee.ts`); the server
  // re-validates regardless. Blank is valid for both — they're optional.
  const cwidOk = draft.cwid.trim() === "" || isCwid(draft.cwid.trim().toLowerCase());
  const yearOk =
    draft.year.trim() === "" ||
    (/^\d{4}$/.test(draft.year.trim()) &&
      Number(draft.year) >= 1950 &&
      Number(draft.year) <= new Date().getUTCFullYear() + 1);
  const canSubmit = nameOk && cwidOk && yearOk && !busy;

  return (
    <div
      className="border-apollo-border flex flex-col gap-3 rounded-md border p-4"
      data-testid={`manual-mentee-form-${idPrefix}`}
    >
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">WCM CWID (optional)</span>
        <Input
          value={draft.cwid}
          onChange={(e) => set("cwid", e.target.value)}
          placeholder="e.g. abc2001"
          aria-describedby={`manual-mentee-cwid-help-${idPrefix}`}
          data-testid={`manual-mentee-cwid-${idPrefix}`}
        />
        <span id={`manual-mentee-cwid-help-${idPrefix}`} className="text-muted-foreground text-xs">
          If you know it, entering it links their profile, shows their photo, and surfaces the
          publications you co-authored. Without it we&rsquo;ll still list them, just as a plain name.
        </span>
      </label>
      {!cwidOk ? (
        <p className="text-destructive text-xs">
          That doesn&rsquo;t look like a CWID. Leave it blank if you&rsquo;re not sure.
        </p>
      ) : null}

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Name</span>
        <Input
          value={draft.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="e.g. Rowan Ellis"
          data-testid={`manual-mentee-name-${idPrefix}`}
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Program or role (optional)</span>
        <Input
          value={draft.programLabel}
          onChange={(e) => set("programLabel", e.target.value)}
          placeholder="e.g. Visiting student"
          data-testid={`manual-mentee-program-${idPrefix}`}
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Year completed (optional)</span>
        <Input
          value={draft.year}
          onChange={(e) => set("year", e.target.value)}
          inputMode="numeric"
          placeholder="e.g. 2019"
          className="max-w-32"
          data-testid={`manual-mentee-year-${idPrefix}`}
        />
      </label>
      {!yearOk ? <p className="text-destructive text-xs">Please enter a four-digit year.</p> : null}

      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="apollo"
          disabled={!canSubmit}
          onClick={() => onSubmit(draft)}
          data-testid={`manual-mentee-submit-${idPrefix}`}
        >
          {busy ? "Saving…" : submitLabel}
        </Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** A listed row's muted meta line: program · year. */
function metaLine(row: ManualMentee): string {
  return [row.programLabel, row.year ? String(row.year) : null].filter(Boolean).join(" · ");
}

/** Blank optional strings drop out entirely — the validator stores no empty keys. */
function draftToEntry(d: Draft): ManualMentee {
  const entry: ManualMentee = { name: d.name.trim() };
  const cwid = d.cwid.trim().toLowerCase();
  if (cwid) entry.cwid = cwid;
  const programLabel = d.programLabel.trim();
  if (programLabel) entry.programLabel = programLabel;
  const year = d.year.trim();
  if (year) entry.year = Number(year);
  return entry;
}

function entryToDraft(row: ManualMentee): Draft {
  return {
    name: row.name,
    cwid: row.cwid ?? "",
    programLabel: row.programLabel ?? "",
    year: row.year ? String(row.year) : "",
  };
}

function mapErrorToMessage(code: string): string {
  switch (code) {
    case "invalid_name":
      return "A name is required.";
    case "invalid_cwid":
      return "That doesn’t look like a CWID. Leave it blank if you’re not sure.";
    case "invalid_year":
      return "Please enter a four-digit year.";
    case "duplicate":
      return "You’ve already added a mentee with that CWID.";
    case "too_many":
      return `You can add up to ${MAX_MANUAL_MENTEES} mentees.`;
    case "not_self":
    case "not_authorized":
    case "forbidden":
      return "You no longer have access to edit this profile. Refresh the page and try again.";
    default:
      return GENERIC_ERROR;
  }
}
