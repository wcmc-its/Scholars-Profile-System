/**
 * HonorsCard — the curation editor for `honor` rows (#1760), rendered on its OWN
 * `Honors & Distinctions` attribute tab (a sibling of Appointments, not a card
 * inside it — an honor is not an appointment and has its own profile section).
 *
 * Honors are the distinctions no WCM feed carries: academy memberships, named
 * investigatorships, and prizes. **Deliberately NOT endowed chairs** — ED already
 * ingests endowed titles into `Appointment.title` / `Scholar.primaryTitle` nightly
 * and `lib/leadership.ts` parses them, so a chair recorded here would render twice
 * on the profile. `HonorCategory` carries no `NAMED_CHAIR` member; `OTHER` absorbs
 * the oddballs. Do not reintroduce it in the copy below.
 *
 * Each mutation is an immediate POST to `/api/edit/honor` (no batched save):
 *   - add    → `{ action: "create", cwid, <fields> }`
 *   - edit   → `{ action: "update", id, <fields> }` (full replace of the fields)
 *   - remove → `{ action: "delete", id }`
 *
 * The list (ALL rows — hidden and non-`published` included, so a curator can see
 * what a Phase 3 feed proposed and toggle `showOnProfile`) is fetched on mount
 * from `GET /api/edit/honor?cwid=…`. Authz is enforced server-side; this card is
 * only rendered for an actor the page already resolved as an authorized editor.
 *
 * `status` is NOT editable here — it is displayed read-only as a row marker
 * because the curator list deliberately includes pending / rejected rows, which
 * would otherwise be indistinguishable from published ones.
 *
 * Chrome deliberately mirrors `profile-appointments-card.tsx` field-for-field
 * (native controls, no bespoke chrome, no new colours) — the two are siblings in
 * the rail and must not read as two different products.
 */
"use client";

import * as React from "react";

import { EditPanel } from "@/components/edit/edit-panel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  CONFERRING_BODIES,
  HONOR_CATEGORIES,
  HONOR_CATEGORY_LABELS,
  HONOR_YEAR_MIN,
  honorYearMax,
} from "@/lib/edit/honor";
import { cn } from "@/lib/utils";

/** Derived from the shared contract array so the card can never drift from it. */
type Category = (typeof HONOR_CATEGORIES)[number];
type Status = "published" | "pending" | "rejected";

/** One stored row, as the route's `serialize()` returns it. */
type Row = {
  id: string;
  category: Category;
  name: string;
  organization: string;
  year: number | null;
  status: Status;
  showOnProfile: boolean;
  source: string;
  sourceRef: string | null;
  enteredByCwid: string;
  createdAt: string;
  updatedAt: string;
};

/** The editable draft the add / edit form works on (strings, blank = unset). */
type Draft = {
  category: Category;
  name: string;
  organization: string;
  year: string;
  showOnProfile: boolean;
};

/** Read-only marker for a row a feed proposed but no curator has published. */
const STATUS_MARKER: Record<Status, string | null> = {
  published: null,
  pending: "Pending review",
  rejected: "Rejected",
};

const EMPTY_DRAFT: Draft = {
  category: HONOR_CATEGORIES[0],
  name: "",
  organization: "",
  year: "",
  showOnProfile: true,
};

export type HonorsCardProps = {
  cwid: string;
  mode: "self" | "superuser";
  scholarName: string;
};

export function HonorsCard({ cwid, mode, scholarName }: HonorsCardProps) {
  const possessive = mode === "superuser" ? `${scholarName}'s` : "your";

  const [rows, setRows] = React.useState<Row[] | null>(null);
  const [loadError, setLoadError] = React.useState(false);
  const [adding, setAdding] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    fetch(`/api/edit/honor?cwid=${encodeURIComponent(cwid)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: { honors?: Row[] }) => {
        if (active) {
          setRows(data.honors ?? []);
          setLoadError(false);
        }
      })
      .catch(() => {
        if (active) {
          setRows([]);
          setLoadError(true);
        }
      });
    return () => {
      active = false;
    };
  }, [cwid]);

  async function post(payload: Record<string, unknown>): Promise<{ ok: boolean; honor?: Row }> {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/edit/honor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwid, ...payload }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string; honor?: Row };
      if (!res.ok || data.ok !== true) {
        setError(mapErrorToMessage(data.error ?? ""));
        return { ok: false };
      }
      return { ok: true, honor: data.honor };
    } catch {
      setError(mapErrorToMessage(""));
      return { ok: false };
    } finally {
      setBusy(false);
    }
  }

  async function createRow(draft: Draft) {
    const { ok, honor } = await post({ action: "create", ...draftToPayload(draft) });
    if (ok && honor) {
      setRows((prev) => [...(prev ?? []), honor]);
      setAdding(false);
    }
  }

  async function updateRow(id: string, draft: Draft) {
    const { ok, honor } = await post({ action: "update", id, ...draftToPayload(draft) });
    if (ok && honor) {
      setRows((prev) => (prev ?? []).map((r) => (r.id === id ? honor : r)));
      setEditingId(null);
    }
  }

  async function removeRow(id: string) {
    const { ok } = await post({ action: "delete", id });
    if (ok) {
      setRows((prev) => (prev ?? []).filter((r) => r.id !== id));
      if (editingId === id) setEditingId(null);
    }
  }

  return (
    <EditPanel
      slot="honors-card"
      heading="Honors and distinctions"
      owned
      subsection
      description={`Add the honors no WCM feed carries — academy memberships, investigatorships, and prizes. These appear only on ${possessive} public profile.`}
    >
      {loadError ? (
        <Alert variant="destructive">
          <AlertDescription>
            We couldn&rsquo;t load these honors. Refresh the page and try again.
          </AlertDescription>
        </Alert>
      ) : null}

      {rows === null ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : rows.length === 0 && !loadError ? (
        // Only claim the list is empty when we actually read it. The catch above
        // sets rows to [] as well as loadError, so without this gate a failed
        // fetch asserts "none exist" directly beneath the alert saying we
        // couldn't load them.
        <p className="text-muted-foreground text-sm">No honors added yet.</p>
      ) : rows.length === 0 ? null : (
        <ul className="flex flex-col gap-3" data-testid="honor-list">
          {rows.map((row) =>
            editingId === row.id ? (
              <li key={row.id}>
                <HonorForm
                  idPrefix={`edit-${row.id}`}
                  initial={rowToDraft(row)}
                  submitLabel="Save"
                  busy={busy}
                  onSubmit={(d) => updateRow(row.id, d)}
                  onCancel={() => {
                    setEditingId(null);
                    setError(null);
                  }}
                />
              </li>
            ) : (
              <li
                key={row.id}
                className="border-apollo-border flex items-start gap-3 rounded-md border p-3"
                data-testid={`honor-${row.id}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-[14px] font-normal">{row.name}</span>
                    <span className="text-muted-foreground text-xs">
                      {HONOR_CATEGORY_LABELS[row.category]}
                    </span>
                    {STATUS_MARKER[row.status] ? (
                      <span className="text-muted-foreground text-xs">
                        · {STATUS_MARKER[row.status]}
                      </span>
                    ) : null}
                    {!row.showOnProfile ? (
                      <span className="text-muted-foreground text-xs">· Hidden</span>
                    ) : null}
                  </div>
                  <div className="text-muted-foreground mt-0.5 text-sm">{metaLine(row)}</div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setEditingId(row.id);
                      setAdding(false);
                      setError(null);
                    }}
                    data-testid={`honor-edit-${row.id}`}
                  >
                    Edit
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => removeRow(row.id)}
                    data-testid={`honor-remove-${row.id}`}
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
        <HonorForm
          idPrefix="add"
          initial={EMPTY_DRAFT}
          submitLabel="Add honor"
          busy={busy}
          onSubmit={createRow}
          onCancel={() => {
            setAdding(false);
            setError(null);
          }}
        />
      ) : rows !== null && !loadError ? (
        // Adding against a failed read invites a duplicate: the honour may
        // already be there, we just couldn't fetch it.
        <div>
          <Button
            type="button"
            variant="default"
            className="bg-[var(--color-facet-topic-count)] text-white hover:bg-[var(--color-facet-topic-count)] hover:brightness-95 focus-visible:ring-[var(--color-facet-topic-count)]"
            disabled={busy}
            onClick={() => {
              setAdding(true);
              setEditingId(null);
              setError(null);
            }}
            data-testid="honor-add"
          >
            Add an honor
          </Button>
        </div>
      ) : null}

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </EditPanel>
  );
}

/** The add / edit form. Holds its own draft; the parent owns the POST + list. */
function HonorForm({
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
  const orgOk = draft.organization.trim().length > 0;
  // Structural client mirror of the route's year rule (a whole year in a
  // plausible range when present); the server re-validates regardless.
  const yearOk = draft.year.trim() === "" || isPlausibleYear(draft.year);
  const canSubmit = nameOk && orgOk && yearOk && !busy;
  const bodiesListId = `honor-organization-options-${idPrefix}`;

  return (
    <div
      className="border-apollo-border flex flex-col gap-3 rounded-md border p-4"
      data-testid={`honor-form-${idPrefix}`}
    >
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Type</span>
        <select
          value={draft.category}
          onChange={(e) => set("category", e.target.value as Category)}
          className={cn(
            "border-input bg-background h-9 rounded-md border px-3 text-sm",
            "focus-visible:border-ring focus-visible:ring-ring/50 outline-none focus-visible:ring-[3px]",
          )}
          data-testid={`honor-category-${idPrefix}`}
        >
          {HONOR_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {HONOR_CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Honor</span>
        <Input
          value={draft.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="e.g. Member, Fellow, or the award's name"
          data-testid={`honor-name-${idPrefix}`}
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Conferring organization</span>
        <Input
          value={draft.organization}
          onChange={(e) => set("organization", e.target.value)}
          list={bodiesListId}
          placeholder="Choose a listed body or type another"
          data-testid={`honor-organization-${idPrefix}`}
        />
        {/* Native datalist: the listed bodies are suggestions, NOT a closed set —
            free entry stays permitted (the column is free text). */}
        <datalist id={bodiesListId} data-testid={`honor-organization-options-${idPrefix}`}>
          {CONFERRING_BODIES.map((body) => (
            <option key={body} value={body} />
          ))}
        </datalist>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">
          Year <span className="text-muted-foreground font-normal">(optional)</span>
        </span>
        <Input
          type="number"
          inputMode="numeric"
          min={HONOR_YEAR_MIN}
          max={honorYearMax()}
          step={1}
          value={draft.year}
          onChange={(e) => set("year", e.target.value)}
          placeholder="Year elected or awarded"
          data-testid={`honor-year-${idPrefix}`}
        />
      </label>

      {!yearOk ? (
        <p className="text-destructive text-xs">
          Please enter a four-digit year between {HONOR_YEAR_MIN} and {honorYearMax()}.
        </p>
      ) : null}

      <label className="flex items-center gap-2 text-sm">
        <Switch
          checked={draft.showOnProfile}
          onCheckedChange={(c) => set("showOnProfile", c === true)}
          data-testid={`honor-show-${idPrefix}`}
        />
        <span className="font-medium">Show on profile</span>
      </label>

      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="apollo"
          disabled={!canSubmit}
          onClick={() => onSubmit(draft)}
          data-testid={`honor-submit-${idPrefix}`}
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

/** A listed row's muted meta line: organization · year. */
function metaLine(row: Row): string {
  const parts = [row.organization];
  if (row.year !== null) parts.push(String(row.year));
  return parts.filter(Boolean).join(" · ");
}

function isPlausibleYear(value: string): boolean {
  const n = Number(value);
  return Number.isInteger(n) && n >= HONOR_YEAR_MIN && n <= honorYearMax();
}

/** Blank year → null (the route rejects ""); required text posts as typed. */
function draftToPayload(d: Draft): Record<string, unknown> {
  return {
    category: d.category,
    name: d.name,
    organization: d.organization,
    year: d.year.trim() ? Number(d.year) : null,
    showOnProfile: d.showOnProfile,
  };
}

function rowToDraft(row: Row): Draft {
  return {
    category: row.category,
    name: row.name,
    organization: row.organization,
    year: row.year === null ? "" : String(row.year),
    showOnProfile: row.showOnProfile,
  };
}

function mapErrorToMessage(code: string): string {
  switch (code) {
    case "required":
      return "The honor and the conferring organization are required.";
    case "too_long":
      return "One of the fields is too long — please shorten it.";
    case "invalid_category":
      return "Please choose a valid honor type.";
    case "invalid_year":
      return "Please enter a valid year.";
    case "honor_not_found":
      return "That honor no longer exists. Refresh the page and try again.";
    case "not_authorized":
    case "forbidden":
      return "You no longer have access to edit this profile. Refresh the page and try again.";
    default:
      return "Something went wrong — your changes weren’t saved. Please try again.";
  }
}
