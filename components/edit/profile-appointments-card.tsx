/**
 * ProfileAppointmentsCard — the self-service editor for `profile_appointment`
 * rows (#1568), shown under the Appointments attribute tab beneath the
 * read-only (ETL-fed) Appointments + revealed Past Appointments cards.
 *
 * The scholar (or a curator on their behalf) adds appointments the authoritative
 * feeds don't carry: internal WCM roles the ED feed omits (Program Director,
 * Head of Section) and current/historical positions at OTHER institutions. Each
 * mutation is an immediate POST to `/api/edit/appointment` (no batched save):
 *   - add    → `{ action: "create", cwid, <fields> }`
 *   - edit   → `{ action: "update", id, <fields> }` (full replace of the fields)
 *   - remove → `{ action: "delete", id }`
 *
 * The list (all rows, hidden included, so the editor can toggle `showOnProfile`)
 * is fetched on mount from `GET /api/edit/appointment?cwid=…`. Authz is enforced
 * server-side (`authorizeOverviewWrite`); this card is only rendered for an
 * actor the page already resolved as an authorized editor. These rows render
 * ONLY on the owner's public profile — never on a center / department /
 * division / search surface — so scholars have wide input latitude here.
 *
 * Visual design is intentionally minimal (native controls, no bespoke chrome) —
 * it needs a staging design pass.
 */
"use client";

import * as React from "react";

import { EditPanel } from "@/components/edit/edit-panel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

type Category = "WCM_LEADERSHIP" | "EXTERNAL";

/** One stored row, as the route's `serialize()` returns it. */
type Row = {
  id: string;
  category: Category;
  title: string;
  organization: string;
  unit: string | null;
  location: string | null;
  startDate: string | null;
  endDate: string | null;
  sortOrder: number;
  showOnProfile: boolean;
  source: string;
  enteredByCwid: string;
  createdAt: string;
  updatedAt: string;
};

/** The editable draft the add / edit form works on (strings, blank = unset). */
type Draft = {
  category: Category;
  title: string;
  organization: string;
  unit: string;
  location: string;
  startDate: string;
  endDate: string;
  showOnProfile: boolean;
};

/** Human labels for the two controlled categories (the select options). */
const CATEGORY_OPTIONS: ReadonlyArray<{ value: Category; label: string }> = [
  { value: "WCM_LEADERSHIP", label: "WCM role or leadership (not in the directory feed)" },
  { value: "EXTERNAL", label: "Appointment at another institution" },
];

/** Short label for a listed row's category chip. */
const CATEGORY_CHIP: Record<Category, string> = {
  WCM_LEADERSHIP: "WCM role",
  EXTERNAL: "Other institution",
};

const EMPTY_DRAFT: Draft = {
  category: "WCM_LEADERSHIP",
  title: "",
  organization: "",
  unit: "",
  location: "",
  startDate: "",
  endDate: "",
  showOnProfile: true,
};

export type ProfileAppointmentsCardProps = {
  cwid: string;
  mode: "self" | "superuser";
  scholarName: string;
};

export function ProfileAppointmentsCard({ cwid, mode, scholarName }: ProfileAppointmentsCardProps) {
  const possessive = mode === "superuser" ? `${scholarName}'s` : "your";

  const [rows, setRows] = React.useState<Row[] | null>(null);
  const [loadError, setLoadError] = React.useState(false);
  const [adding, setAdding] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    fetch(`/api/edit/appointment?cwid=${encodeURIComponent(cwid)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: { appointments?: Row[] }) => {
        if (active) {
          setRows(data.appointments ?? []);
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

  async function post(
    payload: Record<string, unknown>,
  ): Promise<{ ok: boolean; appointment?: Row }> {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/edit/appointment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwid, ...payload }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string; appointment?: Row };
      if (!res.ok || data.ok !== true) {
        setError(mapErrorToMessage(data.error ?? ""));
        return { ok: false };
      }
      return { ok: true, appointment: data.appointment };
    } catch {
      setError(mapErrorToMessage(""));
      return { ok: false };
    } finally {
      setBusy(false);
    }
  }

  async function createRow(draft: Draft) {
    const { ok, appointment } = await post({ action: "create", ...draftToPayload(draft) });
    if (ok && appointment) {
      setRows((prev) => [...(prev ?? []), appointment]);
      setAdding(false);
    }
  }

  async function updateRow(id: string, draft: Draft) {
    const { ok, appointment } = await post({ action: "update", id, ...draftToPayload(draft) });
    if (ok && appointment) {
      setRows((prev) => (prev ?? []).map((r) => (r.id === id ? appointment : r)));
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
      slot="profile-appointments-card"
      heading="Additional appointments"
      owned
      subsection
      description={`Add roles and appointments the WCM directory feeds don't carry — internal WCM leadership and positions at other institutions. These appear only on ${possessive} public profile, never on center, department, division, or search pages.`}
    >
      {loadError ? (
        <Alert variant="destructive">
          <AlertDescription>
            We couldn&rsquo;t load these appointments. Refresh the page and try again.
          </AlertDescription>
        </Alert>
      ) : null}

      {rows === null ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">No additional appointments added yet.</p>
      ) : (
        <ul className="flex flex-col gap-3" data-testid="profile-appointment-list">
          {rows.map((row) =>
            editingId === row.id ? (
              <li key={row.id}>
                <AppointmentForm
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
                data-testid={`profile-appointment-${row.id}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-[14px] font-normal">{row.title}</span>
                    <span className="text-muted-foreground text-xs">{CATEGORY_CHIP[row.category]}</span>
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
                    data-testid={`profile-appointment-edit-${row.id}`}
                  >
                    Edit
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => removeRow(row.id)}
                    data-testid={`profile-appointment-remove-${row.id}`}
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
        <AppointmentForm
          idPrefix="add"
          initial={EMPTY_DRAFT}
          submitLabel="Add appointment"
          busy={busy}
          onSubmit={createRow}
          onCancel={() => {
            setAdding(false);
            setError(null);
          }}
        />
      ) : rows !== null ? (
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
            data-testid="profile-appointment-add"
          >
            Add an appointment
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
function AppointmentForm({
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

  const titleOk = draft.title.trim().length > 0;
  const orgOk = draft.organization.trim().length > 0;
  // Client mirror of the route's date-range rule (start ≤ end when both present);
  // the server re-validates regardless.
  const rangeOk = !draft.startDate || !draft.endDate || draft.startDate <= draft.endDate;
  const canSubmit = titleOk && orgOk && rangeOk && !busy;

  return (
    <div
      className="border-apollo-border flex flex-col gap-3 rounded-md border p-4"
      data-testid={`profile-appointment-form-${idPrefix}`}
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
          data-testid={`profile-appointment-category-${idPrefix}`}
        >
          {CATEGORY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Title</span>
        <Input
          value={draft.title}
          onChange={(e) => set("title", e.target.value)}
          placeholder="e.g. Program Director"
          data-testid={`profile-appointment-title-${idPrefix}`}
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Organization</span>
        <Input
          value={draft.organization}
          onChange={(e) => set("organization", e.target.value)}
          placeholder="e.g. Weill Cornell Medicine"
          data-testid={`profile-appointment-organization-${idPrefix}`}
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">
          Unit <span className="text-muted-foreground font-normal">(optional)</span>
        </span>
        <Input
          value={draft.unit}
          onChange={(e) => set("unit", e.target.value)}
          placeholder="Section, division, program, or department"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">
          Location <span className="text-muted-foreground font-normal">(optional)</span>
        </span>
        <Input
          value={draft.location}
          onChange={(e) => set("location", e.target.value)}
          placeholder="City, state or country"
        />
      </label>

      <div className="flex flex-wrap gap-3">
        <label className="flex flex-1 flex-col gap-1 text-sm">
          <span className="font-medium">
            Start date <span className="text-muted-foreground font-normal">(optional)</span>
          </span>
          <Input
            type="date"
            value={draft.startDate}
            onChange={(e) => set("startDate", e.target.value)}
            data-testid={`profile-appointment-start-${idPrefix}`}
          />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-sm">
          <span className="font-medium">
            End date{" "}
            <span className="text-muted-foreground font-normal">(leave blank if current)</span>
          </span>
          <Input
            type="date"
            value={draft.endDate}
            onChange={(e) => set("endDate", e.target.value)}
            data-testid={`profile-appointment-end-${idPrefix}`}
          />
        </label>
      </div>

      {!rangeOk ? (
        <p className="text-destructive text-xs">The end date can&rsquo;t be before the start date.</p>
      ) : null}

      <label className="flex items-center gap-2 text-sm">
        <Switch
          checked={draft.showOnProfile}
          onCheckedChange={(c) => set("showOnProfile", c === true)}
          data-testid={`profile-appointment-show-${idPrefix}`}
        />
        <span className="font-medium">Show on profile</span>
      </label>

      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="apollo"
          disabled={!canSubmit}
          onClick={() => onSubmit(draft)}
          data-testid={`profile-appointment-submit-${idPrefix}`}
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

/** A listed row's muted meta line: organization / unit / location · year range. */
function metaLine(row: Row): string {
  const parts = [row.organization, row.unit, row.location].filter(Boolean) as string[];
  const range = yearRange(row.startDate, row.endDate);
  if (range) parts.push(range);
  return parts.join(" · ");
}

function yearRange(startDate: string | null, endDate: string | null): string {
  const start = startDate ? startDate.slice(0, 4) : null;
  const end = endDate ? endDate.slice(0, 4) : null;
  if (start && end) return `${start}–${end}`;
  if (start) return `${start}–`;
  if (end) return `–${end}`;
  return "";
}

/** Blank optional strings → null; empty dates → null (the route rejects ""). */
function draftToPayload(d: Draft): Record<string, unknown> {
  return {
    category: d.category,
    title: d.title,
    organization: d.organization,
    unit: d.unit.trim() ? d.unit.trim() : null,
    location: d.location.trim() ? d.location.trim() : null,
    startDate: d.startDate || null,
    endDate: d.endDate || null,
    showOnProfile: d.showOnProfile,
  };
}

function rowToDraft(row: Row): Draft {
  return {
    category: row.category,
    title: row.title,
    organization: row.organization,
    unit: row.unit ?? "",
    location: row.location ?? "",
    startDate: row.startDate ?? "",
    endDate: row.endDate ?? "",
    showOnProfile: row.showOnProfile,
  };
}

function mapErrorToMessage(code: string): string {
  switch (code) {
    case "required":
      return "Title and organization are required.";
    case "too_long":
      return "One of the fields is too long — please shorten it.";
    case "invalid_category":
      return "Please choose a valid appointment type.";
    case "invalid_date":
      return "Please enter valid dates.";
    case "invalid_date_range":
      return "The end date can’t be before the start date.";
    case "appointment_not_found":
      return "That appointment no longer exists. Refresh the page and try again.";
    case "not_authorized":
    case "forbidden":
      return "You no longer have access to edit this profile. Refresh the page and try again.";
    default:
      return "Something went wrong — your changes weren’t saved. Please try again.";
  }
}
