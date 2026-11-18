/**
 * UnitLeadershipCard — a department's Vice Chairs on `/edit/department/[code]`.
 *
 * One list of current holders (tier order) with Edit and Remove, and one add
 * form beneath it, the same shape as `CenterLeadershipCard`. Every mutation is
 * an immediate POST to `/api/edit/unit-leadership`; a saved row is live at
 * once (there is no review step).
 *
 * The title is stored exactly as typed, with any modifier the department uses
 * ("Executive", "Deputy", "Interim" …); the modifier is read from the title and
 * only orders the list. Areas and site are suggested from the title
 * (`parseLeadershipTitle`) until the steward changes one by hand.
 *
 * A holder who is not full-time faculty takes one more step: the route answers
 * `note_required`, and the card asks for the reason in a confirm dialog before
 * resubmitting.
 */
"use client";

import * as React from "react";

import { ConfirmDialog } from "@/components/edit/confirm-dialog";
import {
  DirectoryPeopleTypeahead,
  type DirectoryValue,
} from "@/components/edit/directory-people-typeahead";
import { EditPanel } from "@/components/edit/edit-panel";
import { ScholarHoverCard } from "@/components/edit/scholar-hover-card";
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  LEADERSHIP_FUNCTIONS,
  LEADERSHIP_FUNCTION_LABELS,
  LEADERSHIP_SITES,
  LEADERSHIP_SITE_LABELS,
  leadershipTierLabel,
  parseLeadershipTitle,
  sortLeadershipRoles,
  type LeadershipFunction,
  type LeadershipSite,
  type UnitLeadershipRoleView,
} from "@/lib/unit-leadership";

export type UnitLeadershipCardProps = {
  departmentCode: string;
  /** Stripped from a title before areas are suggested ("Vice Chair of Surgery"). */
  departmentName: string;
  roles: ReadonlyArray<UnitLeadershipRoleView>;
  headingId?: string;
};

type Draft = {
  displayTitle: string;
  functions: LeadershipFunction[];
  areaText: string;
  site: LeadershipSite | "";
  startDate: string;
  note: string;
  /** True once the steward sets areas / site by hand: stop suggesting. */
  touched: boolean;
};

const EMPTY_DRAFT: Draft = {
  displayTitle: "",
  functions: [],
  areaText: "",
  site: "",
  startDate: "",
  note: "",
  touched: false,
};

const draftOf = (r: UnitLeadershipRoleView): Draft => ({
  displayTitle: r.displayTitle,
  functions: [...r.functions],
  areaText: r.areaText ?? "",
  site: r.site ?? "",
  startDate: r.startDate ?? "",
  note: r.note ?? "",
  touched: true,
});

const SELECT_CLASS =
  "border-apollo-border-strong text-foreground h-8 min-w-0 rounded-md border bg-white px-1.5 text-[13.5px]";

/** "Vice Chair · Research, Education · NewYork-Presbyterian Queens". */
function describeRole(r: UnitLeadershipRoleView): string {
  const areas = r.functions
    .map((f) => (f === "clinical_area" && r.areaText ? r.areaText : LEADERSHIP_FUNCTION_LABELS[f]))
    .join(", ");
  return [leadershipTierLabel(r.tier), areas, r.site ? LEADERSHIP_SITE_LABELS[r.site] : ""]
    .filter(Boolean)
    .join(" · ");
}

export function UnitLeadershipCard({
  departmentCode,
  departmentName,
  roles: initialRoles,
  headingId = "vice-chairs-heading",
}: UnitLeadershipCardProps) {
  const [roles, setRoles] = React.useState<UnitLeadershipRoleView[]>(() => [...initialRoles]);
  const [adding, setAdding] = React.useState<DirectoryValue | null>(null);
  const [addDraft, setAddDraft] = React.useState<Draft>(EMPTY_DRAFT);
  const [editing, setEditing] = React.useState<{ id: string; draft: Draft } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [removing, setRemoving] = React.useState<UnitLeadershipRoleView | null>(null);
  /** A save waiting on the not-full-time-faculty reason. */
  const [needsReason, setNeedsReason] = React.useState<{ name: string; payload: Record<string, unknown> } | null>(
    null,
  );

  async function post(payload: Record<string, unknown>): Promise<{
    ok: boolean;
    error?: string;
    role?: UnitLeadershipRoleView;
  }> {
    try {
      const res = await fetch("/api/edit/unit-leadership", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ departmentCode, ...payload }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string; role?: UnitLeadershipRoleView };
      return res.ok && data.ok === true ? { ok: true, role: data.role } : { ok: false, error: data.error ?? "" };
    } catch {
      return { ok: false, error: "" };
    }
  }

  const fieldsOf = (d: Draft) => ({
    displayTitle: d.displayTitle,
    functions: d.functions,
    areaText: d.functions.includes("clinical_area") ? d.areaText : null,
    site: d.site || null,
    startDate: d.startDate || null,
    note: d.note || null,
  });

  /** Add or update. Returns true when the row was saved. */
  async function save(payload: Record<string, unknown>, holderName: string): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError(null);
    const result = await post(payload);
    setBusy(false);
    if (result.ok && result.role) {
      const saved = result.role;
      setRoles((prev) => sortLeadershipRoles([...prev.filter((r) => r.id !== saved.id), saved]));
      setAdding(null);
      setAddDraft(EMPTY_DRAFT);
      setEditing(null);
      return true;
    }
    if (result.error === "note_required") {
      setNeedsReason({ name: holderName, payload });
      return false;
    }
    setError(mapErrorToMessage(result.error ?? ""));
    return false;
  }

  async function remove(role: UnitLeadershipRoleView) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await post({ action: "remove", id: role.id });
    if (result.ok) setRoles((prev) => prev.filter((r) => r.id !== role.id));
    else setError(mapErrorToMessage(result.error ?? ""));
    setBusy(false);
    setRemoving(null);
  }

  return (
    <EditPanel
      slot="unit-leadership-card"
      headingId={headingId}
      heading="Vice Chairs"
      description="Shown on the department’s public page and on each person’s profile, with the title exactly as written here."
    >
      <div className="flex flex-col gap-3.5" data-testid="unit-leadership-list">
        {roles.length === 0 ? (
          <p
            className="border-apollo-border text-muted-foreground rounded-[10px] border px-3.5 py-3 text-sm"
            data-testid="unit-leadership-empty"
          >
            No Vice Chairs listed yet.
          </p>
        ) : (
          <ul
            className="border-apollo-border divide-apollo-border divide-y overflow-hidden rounded-[10px] border"
            data-testid="unit-leadership-holders"
          >
            {roles.map((r) => (
              <li key={r.id} className="px-3.5 py-2.5" data-testid={`vice-chair-${r.id}`}>
                <div className="grid grid-cols-[34px_minmax(0,1fr)] items-start gap-x-3 gap-y-1 sm:grid-cols-[34px_minmax(0,1fr)_auto]">
                  <HeadshotAvatar
                    cwid={r.cwid}
                    preferredName={r.name ?? r.cwid}
                    size="roster"
                    className="border-apollo-border-strong size-[34px] border"
                  />
                  <div className="flex min-w-0 flex-col">
                    <ScholarHoverCard cwid={r.cwid}>
                      <span className="w-fit max-w-full truncate text-sm font-[550]">{r.name ?? r.cwid}</span>
                    </ScholarHoverCard>
                    <span className="text-sm">{r.displayTitle}</span>
                    <span className="text-muted-foreground text-[12.5px]">
                      {describeRole(r)}
                      {r.source === "audit_seed" && r.sourceUrl && (
                        <>
                          {" · "}
                          <a href={r.sourceUrl} target="_blank" rel="noreferrer" className="underline">
                            source
                          </a>
                        </>
                      )}
                    </span>
                    {!r.fullTimeFaculty && (
                      <span className="text-apollo-amber text-[12.5px]" data-testid={`vice-chair-not-ft-${r.id}`}>
                        Not full-time faculty
                      </span>
                    )}
                    {r.note && <span className="text-muted-foreground text-[12.5px]">Note: {r.note}</span>}
                  </div>
                  <div className="col-start-2 flex items-center gap-1 sm:col-start-3">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        setError(null);
                        setEditing(editing?.id === r.id ? null : { id: r.id, draft: draftOf(r) });
                      }}
                      data-testid={`vice-chair-edit-${r.id}`}
                    >
                      {editing?.id === r.id ? "Cancel" : "Edit"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => setRemoving(r)}
                      className="text-destructive hover:text-destructive"
                      data-testid={`vice-chair-remove-${r.id}`}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
                {editing?.id === r.id && (
                  <div className="mt-2.5">
                    <RoleFields
                      idPrefix={`vc-edit-${r.id}`}
                      departmentName={departmentName}
                      draft={editing.draft}
                      onChange={(draft) => setEditing({ id: r.id, draft })}
                      disabled={busy}
                    />
                    <div className="mt-2 flex justify-end">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy || !editing.draft.displayTitle.trim()}
                        onClick={() =>
                          save({ action: "update", id: r.id, ...fieldsOf(editing.draft) }, r.name ?? r.cwid)
                        }
                        className="border-apollo-slate text-apollo-slate"
                        data-testid={`vice-chair-save-${r.id}`}
                      >
                        {busy ? "Saving…" : "Save"}
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        <div
          className="bg-apollo-page border-apollo-border-strong flex flex-col gap-2.5 rounded-[10px] border border-dashed px-3 py-2.5"
          data-testid="unit-leadership-add"
        >
          <span className="text-[13px] font-medium">Add a Vice Chair</span>
          <DirectoryPeopleTypeahead
            idPrefix="vice-chair-add"
            value={adding}
            placeholder="Search people…"
            onChange={(v) => {
              setAdding(v);
              if (error) setError(null);
            }}
          />
          <RoleFields
            idPrefix="vc-add"
            departmentName={departmentName}
            draft={addDraft}
            onChange={setAddDraft}
            disabled={busy}
          />
          <div className="flex justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || !adding || !addDraft.displayTitle.trim()}
              onClick={() =>
                adding && save({ action: "add", cwid: adding.cwid, ...fieldsOf(addDraft) }, adding.name)
              }
              className="border-apollo-slate text-apollo-slate"
              data-testid="vice-chair-add"
            >
              {busy ? "Saving…" : "Add"}
            </Button>
          </div>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title="Remove this Vice Chair?"
        description={
          removing
            ? `${removing.name ?? removing.cwid} will no longer be listed as “${removing.displayTitle}”.`
            : ""
        }
        reasonMode="none"
        confirmLabel="Remove"
        confirmVariant="destructive"
        onConfirm={async () => {
          if (removing) await remove(removing);
        }}
      />

      <ConfirmDialog
        open={needsReason !== null}
        onOpenChange={(open) => {
          if (!open) setNeedsReason(null);
        }}
        title="Not full-time faculty"
        description={
          needsReason
            ? `${needsReason.name} is not full-time faculty, and Vice Chairs usually are. This role will not be removed automatically: remove it here when it is no longer valid. Why is this correct?`
            : ""
        }
        reasonMode="required-text"
        reasonPlaceholder="Required — why this person holds the role"
        confirmLabel="Save anyway"
        confirmVariant="default"
        onConfirm={async (reason) => {
          if (!needsReason) return;
          const { name, payload } = needsReason;
          setNeedsReason(null);
          await save({ ...payload, note: reason }, name);
        }}
      />
    </EditPanel>
  );
}

/** Title, areas, site and start date — shared by add and edit. */
function RoleFields({
  idPrefix,
  departmentName,
  draft,
  onChange,
  disabled,
}: {
  idPrefix: string;
  departmentName: string;
  draft: Draft;
  onChange: (draft: Draft) => void;
  disabled: boolean;
}) {

  function setTitle(displayTitle: string) {
    const s = parseLeadershipTitle(displayTitle, departmentName)[0];
    onChange(
      draft.touched || !s
        ? { ...draft, displayTitle }
        : {
            ...draft,
            displayTitle,
            functions: s.functions,
            areaText: s.areaText ?? "",
            site: s.site ?? "",
          },
    );
  }

  return (
    <div className="flex flex-col gap-2.5 text-[13px]">
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">Title, exactly as the department publishes it</span>
        <Input
          id={`${idPrefix}-title`}
          value={draft.displayTitle}
          maxLength={255}
          disabled={disabled}
          placeholder="Vice Chair for Education"
          onChange={(e) => setTitle(e.target.value)}
          data-testid={`${idPrefix}-title`}
        />
      </label>

      <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Hospital site (if site-based)</span>
          <select
            value={draft.site}
            disabled={disabled}
            onChange={(e) => onChange({ ...draft, site: e.target.value as LeadershipSite | "", touched: true })}
            className={SELECT_CLASS}
            data-testid={`${idPrefix}-site`}
          >
            <option value="">None</option>
            {LEADERSHIP_SITES.map((s) => (
              <option key={s} value={s}>
                {LEADERSHIP_SITE_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Start date (optional)</span>
          <Input
            type="date"
            value={draft.startDate}
            disabled={disabled}
            onChange={(e) => onChange({ ...draft, startDate: e.target.value })}
            className="h-8 w-[10.5rem]"
            data-testid={`${idPrefix}-start`}
          />
        </label>
      </div>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-muted-foreground mb-1">
          Areas (for reports; leave empty for a general Vice Chair)
        </legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {LEADERSHIP_FUNCTIONS.map((f) => (
            <label key={f} className="flex items-center gap-1.5">
              <Checkbox
                checked={draft.functions.includes(f)}
                disabled={disabled}
                onCheckedChange={(c) =>
                  onChange({
                    ...draft,
                    touched: true,
                    functions: LEADERSHIP_FUNCTIONS.filter((x) =>
                      x === f ? c === true : draft.functions.includes(x),
                    ),
                  })
                }
                data-testid={`${idPrefix}-fn-${f}`}
              />
              {LEADERSHIP_FUNCTION_LABELS[f]}
            </label>
          ))}
        </div>
      </fieldset>
      {draft.functions.includes("clinical_area") && (
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Clinical area</span>
          <Input
            value={draft.areaText}
            maxLength={255}
            disabled={disabled}
            placeholder="Hematopathology"
            onChange={(e) => onChange({ ...draft, areaText: e.target.value, touched: true })}
            data-testid={`${idPrefix}-area`}
          />
        </label>
      )}
    </div>
  );
}

function mapErrorToMessage(code: string): string {
  switch (code) {
    case "not_curator":
    case "not_authorized":
      return "You no longer have access to this department. Refresh the page and try again.";
    case "scholar_not_found":
    case "invalid_cwid":
      return "That person can’t be added. Vice Chairs must have an active Scholars profile.";
    case "duplicate_role":
      return "That person already holds this role with these areas.";
    case "area_text_required":
      return "Enter the clinical area this title names.";
    case "area_unmapped":
      return "This title names an area. Tick at least one area, or Clinical area.";
    case "role_not_found":
      return "That role no longer exists. Refresh the page and try again.";
    default:
      return "Something went wrong — your changes weren’t saved. Please try again.";
  }
}
