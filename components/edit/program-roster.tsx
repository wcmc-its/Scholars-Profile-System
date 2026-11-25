/**
 * The internal program roster (`/edit/program-roster`): one tab per open
 * program, its people with year, mentors and research program, and the dialogs
 * that add, edit and remove them. Every write is one POST to
 * `/api/edit/program-roster`; the saved row comes back and replaces the local
 * one, so nothing is re-read from a replica that may lag.
 *
 * People are picked from the directory, never typed, so a name always belongs
 * to its CWID. `canEdit` false (a superuser's "View as") shows it read-only.
 */
"use client";

import * as React from "react";

import { ConfirmDialog } from "@/components/edit/confirm-dialog";
import { DirectoryPeopleTypeahead, type DirectoryValue } from "@/components/edit/directory-people-typeahead";
import { ScholarHoverCard } from "@/components/edit/scholar-hover-card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  DESCRIPTION_MAX,
  MAX_MENTORS,
  PROGRAM_NAME_MAX,
  RESEARCH_PROGRAM_MAX,
  SHORT_LABEL_MAX,
  type RosterEntryView,
  type RosterPerson,
  type RosterProgramView,
} from "@/lib/edit/program-roster";
import { cn } from "@/lib/utils";

const ERROR_TEXT: Record<string, string> = {
  already_listed: "That person is already listed in this program for that year.",
  label_taken: "Another program already uses that short name.",
  not_in_directory: "One of these people is no longer in the directory. Nothing was saved.",
  program_not_empty: "This program still has people in it. Retire it instead.",
  program_retired: "This program is retired. Reopen it before adding people.",
  program_not_found: "That program no longer exists. Reload the page.",
  entry_not_found: "That entry was already removed. Reload the page.",
  invalid_year: "Enter a four-digit year, no later than next year.",
  mentor_required: "Add at least one mentor.",
  mentor_is_mentee: "A person cannot be their own mentor.",
  too_many_mentors: `A person can have up to ${MAX_MENTORS} mentors.`,
  invalid_name: "Enter a program name.",
  invalid_short_label: "Enter a short name, up to 32 characters.",
};
const errorText = (code: string) => ERROR_TEXT[code] ?? "It could not be saved. Try again.";

type Reply = {
  ok: boolean;
  error?: string;
  program?: RosterProgramView;
  entry?: RosterEntryView;
  deletedId?: string;
};

async function post(body: Record<string, unknown>): Promise<Reply> {
  try {
    const res = await fetch("/api/edit/program-roster", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as Reply;
    return res.ok && data.ok === true ? data : { ok: false, error: data.error ?? "" };
  } catch {
    return { ok: false, error: "" };
  }
}

const byLabel = (a: RosterProgramView, b: RosterProgramView) => a.shortLabel.localeCompare(b.shortLabel);
const byYearThenName = (a: RosterEntryView, b: RosterEntryView) =>
  b.year - a.year || a.mentee.name.localeCompare(b.mentee.name);

function PersonName({ p, strong = false }: { p: RosterPerson; strong?: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
      <ScholarHoverCard cwid={p.cwid}>
        <span className={cn("hover:underline", strong && "font-semibold")}>{p.name}</span>
      </ScholarHoverCard>
      <span className="text-muted-foreground font-mono text-xs">{p.cwid}</span>
    </span>
  );
}

function Mentors({ e }: { e: RosterEntryView }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {e.mentors.map((m) => (
        <li key={m.cwid}>
          <PersonName p={m} />
        </li>
      ))}
    </ul>
  );
}

const TH = "text-muted-foreground px-3.5 py-2.5 text-left text-xs font-semibold tracking-[0.06em] uppercase";
const TD = "px-3.5 py-3 align-top";

export function ProgramRoster({
  programs: initialPrograms,
  entries: initialEntries,
  canEdit,
}: {
  programs: RosterProgramView[];
  entries: RosterEntryView[];
  canEdit: boolean;
}) {
  const [programs, setPrograms] = React.useState(initialPrograms);
  const [entries, setEntries] = React.useState(initialEntries);
  const [selectedId, setSelectedId] = React.useState(
    () => (initialPrograms.find((p) => !p.retiredAt) ?? initialPrograms[0])?.id ?? null,
  );
  const [query, setQuery] = React.useState("");
  const [year, setYear] = React.useState("");
  const [editing, setEditing] = React.useState<RosterEntryView | "new" | null>(null);
  const [managing, setManaging] = React.useState(false);

  const selected = programs.find((p) => p.id === selectedId) ?? null;
  // A retired program's tab shows only while it is the one being viewed.
  const tabs = programs.filter((p) => !p.retiredAt || p.id === selectedId);
  const inProgram = entries.filter((e) => e.programId === selectedId);
  const years = [...new Set(inProgram.map((e) => e.year))].sort((a, b) => b - a);
  const q = query.trim().toLowerCase();
  const shown = inProgram
    .filter((e) => !year || e.year === Number(year))
    .filter(
      (e) =>
        !q ||
        [e.mentee, ...e.mentors].some((p) => p.name.toLowerCase().includes(q) || p.cwid.toLowerCase().includes(q)),
    )
    .sort(byYearThenName);
  const countOf = (id: string) => entries.filter((e) => e.programId === id).length;

  function select(id: string) {
    setSelectedId(id);
    setYear("");
    setQuery("");
  }

  return (
    <div data-testid="program-roster">
      <div className="border-apollo-border-strong mb-4 flex flex-wrap items-center gap-1 border-b">
        {tabs.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-pressed={p.id === selectedId}
            title={p.name}
            onClick={() => select(p.id)}
            className={cn(
              "px-3.5 py-2.5",
              p.id === selectedId
                ? "border-apollo-maroon -mb-px border-b-2 font-semibold"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {p.shortLabel} <span className="text-muted-foreground font-normal">{countOf(p.id)}</span>
            {p.retiredAt && <span className="text-muted-foreground font-normal"> (retired)</span>}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setManaging(true)}
          className="text-apollo-slate ml-auto px-3.5 py-2.5 hover:underline"
        >
          {canEdit ? "Manage programs" : "All programs"}
        </button>
      </div>

      {selected === null ? (
        <p className="border-apollo-border bg-apollo-surface rounded-[10px] border px-4 py-6">
          No programs yet.{canEdit && " Use Manage programs to create one."}
        </p>
      ) : (
        <>
          {selected.description && <p className="text-muted-foreground mb-3 max-w-[80ch]">{selected.description}</p>}
          <div className="flex flex-wrap items-center gap-2.5">
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a person or mentor"
              aria-label="Find a person or mentor"
              className="bg-apollo-surface w-full sm:w-64"
            />
            <select
              value={year}
              onChange={(e) => setYear(e.target.value)}
              aria-label="Year"
              className="border-apollo-border-strong bg-apollo-surface h-9 rounded-md border px-2.5 text-sm"
            >
              <option value="">All years</option>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
            {canEdit && !selected.retiredAt && (
              <Button type="button" variant="apollo" className="ml-auto" onClick={() => setEditing("new")}>
                Add person
              </Button>
            )}
          </div>

          <div className="border-apollo-border bg-apollo-surface mt-3.5 overflow-hidden rounded-[10px] border">
            <table className="w-full border-collapse text-sm">
              <thead className="bg-apollo-surface-2">
                <tr>
                  <th className={TH}>Person</th>
                  <th className={TH}>Year</th>
                  <th className={cn(TH, "hidden md:table-cell")}>Mentors</th>
                  <th className={cn(TH, "hidden md:table-cell")}>Research program</th>
                  {canEdit && (
                    <th className={TH}>
                      <span className="sr-only">Edit</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-apollo-border divide-y">
                {shown.map((e) => (
                  <tr key={e.id} data-testid={`roster-entry-${e.id}`}>
                    <td className={TD}>
                      <PersonName p={e.mentee} strong />
                      {/* Below md the other columns stack here. */}
                      <div className="mt-1.5 md:hidden">
                        <Mentors e={e} />
                        {e.researchProgram && <div className="text-muted-foreground mt-1">{e.researchProgram}</div>}
                      </div>
                    </td>
                    <td className={cn(TD, "tabular-nums")}>{e.year}</td>
                    <td className={cn(TD, "hidden md:table-cell")}>
                      <Mentors e={e} />
                    </td>
                    <td className={cn(TD, "hidden md:table-cell")}>
                      {e.researchProgram ?? <span className="text-muted-foreground">None</span>}
                    </td>
                    {canEdit && (
                      <td className={cn(TD, "text-right")}>
                        <button
                          type="button"
                          className="text-apollo-slate hover:underline"
                          aria-label={`Edit ${e.mentee.name}, ${e.year}`}
                          onClick={() => setEditing(e)}
                        >
                          Edit
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
                {shown.length === 0 && (
                  <tr>
                    <td className={cn(TD, "text-muted-foreground")} colSpan={5}>
                      {inProgram.length === 0 ? "Nobody is listed yet." : "Nobody matches."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="text-muted-foreground mt-3 text-[13px]" aria-live="polite">
            Showing {shown.length} of {inProgram.length}.
          </p>
        </>
      )}

      {editing !== null && selected !== null && (
        <EntryDialog
          key={editing === "new" ? "new" : editing.id}
          program={selected}
          entry={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setEntries((prev) => [...prev.filter((e) => e.id !== saved.id), saved]);
            setEditing(null);
          }}
          onDeleted={(id) => {
            setEntries((prev) => prev.filter((e) => e.id !== id));
            setEditing(null);
          }}
        />
      )}
      {managing && (
        <ProgramsDialog
          programs={programs}
          countOf={countOf}
          canEdit={canEdit}
          onClose={() => setManaging(false)}
          onView={(id) => {
            select(id);
            setManaging(false);
          }}
          onSaved={(saved) => {
            setPrograms((prev) => [...prev.filter((p) => p.id !== saved.id), saved].sort(byLabel));
            setSelectedId((cur) => cur ?? saved.id);
          }}
          onDeleted={(id) => {
            const left = programs.filter((p) => p.id !== id);
            setPrograms(left);
            if (selectedId === id) setSelectedId((left.find((p) => !p.retiredAt) ?? left[0])?.id ?? null);
          }}
        />
      )}
    </div>
  );
}

const LABEL = "mb-1 block text-sm font-medium";

function EntryDialog({
  program,
  entry,
  onClose,
  onSaved,
  onDeleted,
}: {
  program: RosterProgramView;
  entry: RosterEntryView | null;
  onClose: () => void;
  onSaved: (e: RosterEntryView) => void;
  onDeleted: (id: string) => void;
}) {
  const [person, setPerson] = React.useState<DirectoryValue | null>(null);
  const [mentors, setMentors] = React.useState<RosterPerson[]>(entry?.mentors ?? []);
  const [year, setYear] = React.useState(String(entry?.year ?? new Date().getFullYear()));
  const [researchProgram, setResearchProgram] = React.useState(entry?.researchProgram ?? "");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [removing, setRemoving] = React.useState(false);

  const ready = (entry !== null || person !== null) && mentors.length > 0 && /^\d{4}$/.test(year.trim());

  async function save() {
    setBusy(true);
    setError(null);
    const fields = {
      year: Number(year.trim()),
      researchProgram,
      mentorCwids: mentors.map((m) => m.cwid),
    };
    const r = await post(
      entry
        ? { action: "entry_update", id: entry.id, ...fields }
        : { action: "entry_create", programId: program.id, menteeCwid: person!.cwid, ...fields },
    );
    setBusy(false);
    if (r.ok && r.entry) onSaved(r.entry);
    else setError(errorText(r.error ?? ""));
  }

  async function remove() {
    setError(null);
    const r = await post({ action: "entry_delete", id: entry!.id });
    setRemoving(false);
    if (r.ok) onDeleted(entry!.id);
    else setError(errorText(r.error ?? ""));
  }

  if (removing && entry) {
    return (
      <ConfirmDialog
        open
        onOpenChange={(open) => !open && setRemoving(false)}
        title="Remove this entry?"
        description={`${entry.mentee.name} will no longer be listed in ${program.shortLabel} for ${entry.year}.`}
        reasonMode="none"
        confirmLabel="Remove"
        confirmVariant="destructive"
        onConfirm={remove}
      />
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{entry ? `Edit ${entry.mentee.name}` : `Add a person to ${program.shortLabel}`}</DialogTitle>
          <DialogDescription>
            {entry ? "To change the person, remove this entry and add them again." : "Search by name or CWID."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready && !busy) void save();
          }}
        >
          {entry ? (
            <PersonName p={entry.mentee} strong />
          ) : (
            <div>
              <span className={LABEL}>Person</span>
              <DirectoryPeopleTypeahead
                idPrefix="roster-person"
                value={person}
                onChange={setPerson}
                placeholder="Name or CWID"
                disabled={busy}
                showCwid
              />
            </div>
          )}
          <div>
            <span className={LABEL}>
              Mentors <span className="text-muted-foreground font-normal">At least one</span>
            </span>
            {mentors.map((m) => (
              <div
                key={m.cwid}
                className="border-apollo-border bg-apollo-surface-2 mb-1.5 flex items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-sm"
              >
                <span>
                  {m.name} <span className="text-muted-foreground ml-1 font-mono text-xs">{m.cwid}</span>
                </span>
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`Remove ${m.name}`}
                  className="text-apollo-slate hover:underline"
                  onClick={() => setMentors((prev) => prev.filter((x) => x.cwid !== m.cwid))}
                >
                  Remove
                </button>
              </div>
            ))}
            {mentors.length < MAX_MENTORS && (
              // Remounted per pick, so the search box clears.
              <DirectoryPeopleTypeahead
                key={mentors.length}
                idPrefix="roster-mentor"
                value={null}
                onChange={(v) =>
                  v &&
                  setMentors((prev) =>
                    prev.some((x) => x.cwid === v.cwid) ? prev : [...prev, { cwid: v.cwid, name: v.name }],
                  )
                }
                placeholder={mentors.length > 0 ? "Add another mentor" : "Name or CWID"}
                disabled={busy}
                showCwid
              />
            )}
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
            <label>
              <span className={LABEL}>
                Research program <span className="text-muted-foreground font-normal">Optional</span>
              </span>
              <Input
                value={researchProgram}
                maxLength={RESEARCH_PROGRAM_MAX}
                disabled={busy}
                onChange={(e) => setResearchProgram(e.target.value)}
              />
            </label>
            <label>
              <span className={LABEL}>Year</span>
              <Input
                value={year}
                inputMode="numeric"
                maxLength={4}
                disabled={busy}
                onChange={(e) => setYear(e.target.value)}
              />
            </label>
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            {entry && (
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                className="text-destructive hover:text-destructive sm:mr-auto"
                onClick={() => setRemoving(true)}
              >
                Remove
              </Button>
            )}
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="apollo" disabled={busy || !ready}>
              {busy ? "Saving…" : entry ? "Save" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ProgramsDialog({
  programs,
  countOf,
  canEdit,
  onClose,
  onView,
  onSaved,
  onDeleted,
}: {
  programs: RosterProgramView[];
  countOf: (id: string) => number;
  canEdit: boolean;
  onClose: () => void;
  onView: (id: string) => void;
  onSaved: (p: RosterProgramView) => void;
  onDeleted: (id: string) => void;
}) {
  const [form, setForm] = React.useState<{ id: string | null; name: string; shortLabel: string; description: string } | null>(
    null,
  );
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function send(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const r = await post(body);
    setBusy(false);
    if (!r.ok) {
      setError(errorText(r.error ?? ""));
      return;
    }
    if (r.program) onSaved(r.program);
    if (r.deletedId) onDeleted(r.deletedId);
    setForm(null);
  }

  const ACTION = "text-apollo-slate hover:underline disabled:opacity-50";
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Programs</DialogTitle>
          <DialogDescription>Only roster editors and superusers see this list.</DialogDescription>
        </DialogHeader>
        {programs.length > 0 && (
          <ul className="border-apollo-border divide-apollo-border m-0 list-none divide-y rounded-[10px] border p-0">
            {programs.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3.5 py-2.5 text-sm">
                <div className="min-w-0 basis-full sm:flex-1 sm:basis-0">
                  <div className={cn("font-semibold", p.retiredAt && "text-muted-foreground")}>{p.shortLabel}</div>
                  <div className="text-muted-foreground text-[13px]">
                    {p.name}
                    {p.retiredAt && ` · Retired ${p.retiredAt.slice(0, 4)}`}
                  </div>
                </div>
                <span className="tabular-nums">
                  {countOf(p.id)} {countOf(p.id) === 1 ? "entry" : "entries"}
                </span>
                <span className="flex gap-3">
                  <button type="button" className={ACTION} onClick={() => onView(p.id)} aria-label={`View ${p.shortLabel}`}>
                    View
                  </button>
                  {canEdit && (
                    <>
                      <button
                        type="button"
                        className={ACTION}
                        disabled={busy}
                        aria-label={`Edit ${p.shortLabel}`}
                        onClick={() =>
                          setForm({ id: p.id, name: p.name, shortLabel: p.shortLabel, description: p.description ?? "" })
                        }
                      >
                        Edit
                      </button>
                      {countOf(p.id) === 0 ? (
                        <button
                          type="button"
                          className={ACTION}
                          disabled={busy}
                          aria-label={`Delete ${p.shortLabel}`}
                          onClick={() => void send({ action: "program_delete", id: p.id })}
                        >
                          Delete
                        </button>
                      ) : (
                        <button
                          type="button"
                          className={ACTION}
                          disabled={busy}
                          aria-label={`${p.retiredAt ? "Reopen" : "Retire"} ${p.shortLabel}`}
                          onClick={() =>
                            void send({ action: p.retiredAt ? "program_reopen" : "program_retire", id: p.id })
                          }
                        >
                          {p.retiredAt ? "Reopen" : "Retire"}
                        </button>
                      )}
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        {form && (
          <form
            className="bg-apollo-page border-apollo-border-strong flex flex-col gap-3 rounded-[10px] border border-dashed p-3.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (busy) return;
              void send({ ...form, action: form.id ? "program_update" : "program_create" });
            }}
          >
            <div className="grid gap-3 sm:grid-cols-[9rem_minmax(0,1fr)]">
              <label>
                <span className={LABEL}>Short name</span>
                <Input
                  value={form.shortLabel}
                  maxLength={SHORT_LABEL_MAX}
                  disabled={busy}
                  className="bg-apollo-surface"
                  onChange={(e) => setForm({ ...form, shortLabel: e.target.value })}
                />
              </label>
              <label>
                <span className={LABEL}>Full name</span>
                <Input
                  value={form.name}
                  maxLength={PROGRAM_NAME_MAX}
                  disabled={busy}
                  className="bg-apollo-surface"
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </label>
            </div>
            <label>
              <span className={LABEL}>
                Description <span className="text-muted-foreground font-normal">Optional</span>
              </span>
              <Input
                value={form.description}
                maxLength={DESCRIPTION_MAX}
                disabled={busy}
                className="bg-apollo-surface"
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </label>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setForm(null)}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="apollo"
                size="sm"
                disabled={busy || !form.name.trim() || !form.shortLabel.trim()}
              >
                {busy ? "Saving…" : "Save program"}
              </Button>
            </div>
          </form>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            Close
          </Button>
          {canEdit && !form && (
            <Button
              type="button"
              variant="apollo"
              disabled={busy}
              onClick={() => {
                setError(null);
                setForm({ id: null, name: "", shortLabel: "", description: "" });
              }}
            >
              New program
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
