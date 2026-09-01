/**
 * OrgUnitRoleRoster — the body of `/edit/roles` (#2542 Phase 3).
 *
 * `OrgUnitRole` is a REAL table (unlike the Method-Family roster's derived-tier
 * overlay over an ETL-owned base): every row here is a live vocabulary entry,
 * so there is no two-table dance and no bolt-on decision type to reconcile —
 * a save is one `PATCH`/`POST` to `/api/edit/roles`, full stop.
 *
 * Grouped by entity type, then by role group (leadership above membership —
 * the same order the unit page itself renders in), ordered by `sortOrder`
 * within each group (the server pre-sorts; this only partitions that order,
 * it never re-sorts).
 *
 * EDITABLE: `label` (inline text, confirm-on-save — the rename affects every
 * current holder's displayed role, so the confirmation states the live
 * `holderCount`), `sortOrder`, and `profileTitle` (both save immediately, no
 * confirm). READ-ONLY: `key`, `entityType`, `roleGroup`, `scope`,
 * `singleHolder`, `source`, `holderCount`. Delete is offered only for `manual`
 * roles with zero holders — a `seed` entry (re-minted by every write path
 * that seeds `DEFAULT_ORG_UNIT_ROLES`) or a role with a live holder disables
 * the control with an inline reason instead; see `DeleteRoleButton` below and
 * the route's DELETE docblock (`app/api/edit/roles/route.ts`) for why.
 *
 * PER-ROW busy state (a `Set` of row keys, not the single global `busyKey`
 * `MethodFamiliesRoster` uses): two different rows save fully independently,
 * and a click on row B while row A's write is in flight is never dropped.
 * All three editable fields AND the delete button on a given row share that
 * row's busy flag — a label rename and a delete on the SAME row are
 * serialized, but nothing outside that row is.
 */
"use client";

import * as React from "react";
import { Loader2, Plus } from "lucide-react";

import { ConfirmDialog } from "@/components/edit/confirm-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  DEFAULT_ORG_UNIT_ROLES,
  type OrgUnitRoleEntityType,
  type OrgUnitRoleGroup,
  type OrgUnitRoleScope,
} from "@/lib/org-unit-roles";
import type { OrgUnitRoleRosterRow } from "@/lib/api/org-unit-roles-admin";

/** Display order + label for each unit kind. Fixed (not derived from whatever
 *  order rows happen to arrive in) so the page reads the same every load.
 *  `center_program` sits directly under `center` (it is center's sub-tier),
 *  above `core`, per owner request — this list is ROSTER-ONLY: no other
 *  module imports it, and it does not need to (nor should it) agree with
 *  `buildRoleRoster`'s SQL `orderBy`, which is plain alphabetical and only
 *  decides ordering within a section, never which section renders first. */
const ENTITY_TYPE_ORDER: readonly OrgUnitRoleEntityType[] = [
  "center",
  "center_program",
  "department",
  "division",
  "core",
];

const ENTITY_TYPE_LABEL: Record<OrgUnitRoleEntityType, string> = {
  department: "Department",
  division: "Division",
  center: "Center",
  core: "Core",
  center_program: "Center program",
};

/** Leadership renders above membership, mirroring the unit page itself
 *  (`lib/org-unit-roles.ts`'s `OrgUnitRoleGroup` doc comment). */
const ROLE_GROUP_ORDER: readonly OrgUnitRoleGroup[] = ["leadership", "membership"];

const ROLE_GROUP_LABEL: Record<OrgUnitRoleGroup, string> = {
  leadership: "Leadership",
  membership: "Membership",
};

/** The known entity-type literals for the "Add role" select — sourced from
 *  the same seed table the API route validates against, not a second
 *  hardcoded list that could drift from it. */
const ENTITY_TYPE_OPTIONS = Object.keys(DEFAULT_ORG_UNIT_ROLES) as OrgUnitRoleEntityType[];

/** `"{entityType}:{key}"` — stable per-row identity; matches the PATCH/POST
 *  routes' own `(entityType, key)` composite key. */
function rowKey(r: Pick<OrgUnitRoleRosterRow, "entityType" | "key">): string {
  return `${r.entityType}:${r.key}`;
}

/** Singularize/pluralize the unit noun for a count — every entity-type noun
 *  here takes a plain "s" ("centers", "departments", "center programs"), so a
 *  count of 1 must NOT append it ("1 center", not "1 centers"). */
export function unitNoun(entityType: OrgUnitRoleEntityType, count: number): string {
  const singular = ENTITY_TYPE_LABEL[entityType].toLowerCase();
  return count === 1 ? singular : `${singular}s`;
}

/** Singularize/pluralize "holder" for a count. */
export function holderNoun(count: number): string {
  return count === 1 ? "holder" : "holders";
}

/** The confirm-on-rename dialog's blast-radius sentence. Reports BOTH grains
 *  — people (`holderCount`) and distinct units (`unitCount`) — since neither
 *  alone is truthful: "3 centers" understates that 400 people's badges
 *  change, and "400 centers" (the holder count with a unit noun) is simply
 *  false. See `lib/api/org-unit-roles-admin.ts`'s docblock for what each
 *  count means. */
export function renameBlastRadiusText(
  row: Pick<OrgUnitRoleRosterRow, "entityType" | "holderCount" | "unitCount">,
): string {
  const entityType = row.entityType as OrgUnitRoleEntityType;
  if (row.holderCount === 0) {
    return "Nothing currently holds this role — the rename has no effect on any profile.";
  }
  if (row.holderCount === row.unitCount) {
    // Every holding unit has exactly one holder — the two grains are the same
    // number, and stating both would read as a bug ("1 holder across 1
    // center"). State it once, in UNITS: this is the `singleHolder` shape, so
    // it is the `director` case, the likeliest rename of all, and "how many
    // units does this affect" is the question the confirm exists to answer.
    return `This changes the label shown for ${row.unitCount} ${unitNoun(entityType, row.unitCount)}.`;
  }
  return `This changes the label shown for ${row.holderCount} ${holderNoun(row.holderCount)} across ${row.unitCount} ${unitNoun(entityType, row.unitCount)}.`;
}

/**
 * Why the Delete control is disabled for this row, or `null` when it's
 * enabled. `source` is checked FIRST: a seeded entry can also happen to have
 * holders, but "seeded default" is the more actionable reason to surface — the
 * fix for it lives in the seed table (`DEFAULT_ORG_UNIT_ROLES`), not in
 * reassigning holders, which is the fix `holderCount > 0` implies. Mirrors the
 * route's own gate order (`app/api/edit/roles/route.ts` DELETE) so the button
 * is never enabled for a request the server would refuse anyway.
 */
export function deleteDisabledReason(
  row: Pick<OrgUnitRoleRosterRow, "source" | "holderCount">,
): string | null {
  if (row.source !== "manual") return "Seeded default — cannot be deleted here.";
  if (row.holderCount > 0) return `${row.holderCount} ${holderNoun(row.holderCount)}`;
  return null;
}

/** The delete-confirm dialog's title. Names the unit kind alongside the label
 *  — the same label can exist at two different `entityType`s (e.g. "Director"
 *  at both `center` and `department`), and a bare label would leave that
 *  ambiguous at the moment a curator is about to destroy one of them. */
export function deleteConfirmTitle(
  row: Pick<OrgUnitRoleRosterRow, "label" | "entityType">,
): string {
  const entityType = row.entityType as OrgUnitRoleEntityType;
  return `Delete role "${row.label}" (${ENTITY_TYPE_LABEL[entityType]})?`;
}

/** The delete-confirm dialog's body. States both facts up front: nothing
 *  holds the role (the precondition the Delete control already enforces, so
 *  this is reassurance, not new information) and how many `OrgUnitRoleScope`
 *  allowlist rows are removed as a side effect — so a curator is never
 *  surprised by that second deletion after confirming. */
export function deleteConfirmDescription(
  row: Pick<OrgUnitRoleRosterRow, "scopeRowCount">,
): string {
  const noun = row.scopeRowCount === 1 ? "allowlist row" : "allowlist rows";
  return `No one holds it; ${row.scopeRowCount} ${noun} will be removed too.`;
}

/** Map a DELETE-route error code to a steward-facing message. `seeded_default`
 *  and `role_has_holders` carry server-computed detail (`reason` /
 *  `holderCount`) the route sends because a static per-code string can't
 *  — the button is disabled for both cases client-side already, so reaching
 *  this branch means the row changed under the steward between page load and
 *  the confirm click. */
function mapDeleteError(data: { error?: string; reason?: string; holderCount?: number }): string {
  switch (data.error) {
    case "not_comms_steward":
      return "You don't have permission to manage the role vocabulary.";
    case "not_found":
      return "This role no longer exists — reload the page.";
    case "seeded_default":
      return data.reason ?? "This is a seeded default and cannot be deleted here.";
    case "role_has_holders":
      return `This role now has ${data.holderCount ?? 0} ${holderNoun(data.holderCount ?? 0)} — reload the page.`;
    default:
      return "Something went wrong — please try again.";
  }
}

/** Sort order matching the server's roster query: (entityType, roleGroup,
 *  sortOrder, key). Used only to insert a freshly created role into `rows`
 *  at the position a reload would place it, instead of at the array's end. */
function compareRosterRows(a: OrgUnitRoleRosterRow, b: OrgUnitRoleRosterRow): number {
  if (a.entityType !== b.entityType) return a.entityType.localeCompare(b.entityType);
  if (a.roleGroup !== b.roleGroup) return a.roleGroup.localeCompare(b.roleGroup);
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.key.localeCompare(b.key);
}

/** Map a PATCH-route error code to a steward-facing message. */
function mapPatchError(code: string): string {
  switch (code) {
    case "not_comms_steward":
      return "You don't have permission to manage the role vocabulary.";
    case "not_found":
      return "This role no longer exists — reload the page.";
    case "invalid_label":
      return "Label is required (255 characters or fewer).";
    case "invalid_sort_order":
      return "Sort order must be a whole number from 0 to 9999.";
    default:
      return "Something went wrong — please try again.";
  }
}

/** Map a POST-route (create) error code to a steward-facing message. */
function mapCreateError(code: string): string {
  switch (code) {
    case "not_comms_steward":
      return "You don't have permission to manage the role vocabulary.";
    case "invalid_entity_type":
      return "Choose a unit kind.";
    case "invalid_key":
      return "Key must be lowercase letters, numbers, and underscores, starting with a letter (32 characters or fewer).";
    case "invalid_label":
      return "Label is required (255 characters or fewer).";
    case "invalid_role_group":
      return "Choose leadership or membership.";
    case "invalid_scope":
      return "Choose unit or program scope.";
    case "invalid_sort_order":
      return "Sort order must be a whole number from 0 to 9999.";
    case "key_collision":
      return "That key is already used for this unit kind — choose a different one.";
    default:
      return "Something went wrong — please try again.";
  }
}

export type OrgUnitRoleRosterProps = {
  /** The full roster, server-ordered by (entityType, roleGroup, sortOrder, key). */
  roles: ReadonlyArray<OrgUnitRoleRosterRow>;
};

export function OrgUnitRoleRoster({ roles }: OrgUnitRoleRosterProps) {
  const [rows, setRows] = React.useState<OrgUnitRoleRosterRow[]>(() => roles.map((r) => ({ ...r })));
  // Per-row busy set — NOT a single shared key. Two different rows write
  // fully independently; see the module doc comment.
  const [busyKeys, setBusyKeys] = React.useState<ReadonlySet<string>>(() => new Set());
  // Per-row error text, so one row's failed save never clobbers another's.
  const [rowErrors, setRowErrors] = React.useState<Record<string, string | null>>({});
  // The in-progress label edit per row, keyed by rowKey — lets typing happen
  // without saving on every keystroke; committed (with confirmation) on blur.
  const [labelDrafts, setLabelDrafts] = React.useState<Record<string, string>>({});
  const [pendingRename, setPendingRename] = React.useState<{
    row: OrgUnitRoleRosterRow;
    newLabel: string;
  } | null>(null);
  const [pendingDelete, setPendingDelete] = React.useState<OrgUnitRoleRosterRow | null>(null);
  const [addOpen, setAddOpen] = React.useState(false);

  function setBusy(key: string, busy: boolean) {
    setBusyKeys((prev) => {
      const next = new Set(prev);
      if (busy) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  function setRowError(key: string, message: string | null) {
    setRowErrors((prev) => ({ ...prev, [key]: message }));
  }

  /** PATCH one field set on one row. Optimistic: applies `patch` immediately,
   *  rolls back on failure. Returns whether the write succeeded. */
  async function savePatch(
    row: OrgUnitRoleRosterRow,
    patch: Partial<Pick<OrgUnitRoleRosterRow, "label" | "sortOrder" | "profileTitle">>,
  ): Promise<boolean> {
    const key = rowKey(row);
    if (busyKeys.has(key)) return false;
    const prevValues = {
      label: row.label,
      sortOrder: row.sortOrder,
      profileTitle: row.profileTitle,
    };
    setBusy(key, true);
    setRowError(key, null);
    // Re-sorted, not just mapped: a `sortOrder` edit must move the row now,
    // and `AddRoleDialog`'s insert scans this array assuming it is sorted.
    setRows((prev) => prev.map((r) => (rowKey(r) === key ? { ...r, ...patch } : r)).sort(compareRosterRows));
    try {
      const res = await fetch("/api/edit/roles", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityType: row.entityType, key: row.key, ...patch }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || data.ok !== true) {
        setRows((prev) => prev.map((r) => (rowKey(r) === key ? { ...r, ...prevValues } : r)).sort(compareRosterRows));
        if ("label" in patch) setLabelDrafts((prev) => ({ ...prev, [key]: prevValues.label }));
        setRowError(key, mapPatchError(data.error ?? ""));
        return false;
      }
      return true;
    } catch {
      setRows((prev) => prev.map((r) => (rowKey(r) === key ? { ...r, ...prevValues } : r)).sort(compareRosterRows));
      if ("label" in patch) setLabelDrafts((prev) => ({ ...prev, [key]: prevValues.label }));
      setRowError(key, "Something went wrong — please try again.");
      return false;
    } finally {
      setBusy(key, false);
    }
  }

  /** Label input blur — opens the confirm dialog only when the trimmed draft
   *  actually differs from the saved label; a no-op edit (blank, or reverted
   *  back to the original) just snaps the draft back, no dialog, no PATCH. */
  function handleLabelBlur(row: OrgUnitRoleRosterRow) {
    const key = rowKey(row);
    const draft = (labelDrafts[key] ?? row.label).trim();
    if (draft.length === 0 || draft === row.label) {
      setLabelDrafts((prev) => ({ ...prev, [key]: row.label }));
      return;
    }
    setPendingRename({ row, newLabel: draft });
  }

  async function confirmRename() {
    if (!pendingRename) return;
    const { row, newLabel } = pendingRename;
    await savePatch(row, { label: newLabel });
    setPendingRename(null);
  }

  /** DELETE one row. Not optimistic (unlike `savePatch`) — the row is removed
   *  from `rows` only after the server confirms; a rejected delete (the row
   *  gained a holder between page load and the confirm click) must not make
   *  the row vanish and reappear. */
  async function confirmDelete() {
    if (!pendingDelete) return;
    const row = pendingDelete;
    const key = rowKey(row);
    if (busyKeys.has(key)) return;
    setBusy(key, true);
    setRowError(key, null);
    try {
      const res = await fetch("/api/edit/roles", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityType: row.entityType, key: row.key }),
      });
      const data = (await res.json()) as {
        ok: boolean;
        error?: string;
        reason?: string;
        holderCount?: number;
      };
      if (!res.ok || data.ok !== true) {
        setRowError(key, mapDeleteError(data));
        return;
      }
      setRows((prev) => prev.filter((r) => rowKey(r) !== key));
    } catch {
      setRowError(key, "Something went wrong — please try again.");
    } finally {
      setBusy(key, false);
      setPendingDelete(null);
    }
  }

  const grouped = React.useMemo(() => {
    const byEntity = new Map<OrgUnitRoleEntityType, Map<OrgUnitRoleGroup, OrgUnitRoleRosterRow[]>>();
    for (const row of rows) {
      const entityType = row.entityType as OrgUnitRoleEntityType;
      const roleGroup = row.roleGroup as OrgUnitRoleGroup;
      if (!byEntity.has(entityType)) byEntity.set(entityType, new Map());
      const byGroup = byEntity.get(entityType)!;
      if (!byGroup.has(roleGroup)) byGroup.set(roleGroup, []);
      byGroup.get(roleGroup)!.push(row);
    }
    return byEntity;
  }, [rows]);

  return (
    <div className="flex flex-col gap-6" data-slot="org-unit-role-roster">
      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">
          {rows.length} role{rows.length === 1 ? "" : "s"} across {grouped.size} unit kind
          {grouped.size === 1 ? "" : "s"}.
        </p>
        <Button
          type="button"
          variant="apollo"
          size="sm"
          onClick={() => setAddOpen(true)}
          data-testid="roles-add-trigger"
        >
          <Plus className="size-4" />
          Add role
        </Button>
      </div>

      {ENTITY_TYPE_ORDER.filter((entityType) => grouped.has(entityType)).map((entityType) => {
        const byGroup = grouped.get(entityType)!;
        return (
          <section key={entityType} data-slot="role-entity-section" data-testid={`roles-section-${entityType}`}>
            <h2 className="mb-2 text-base font-semibold">{ENTITY_TYPE_LABEL[entityType]}</h2>
            <div className="flex flex-col gap-4">
              {ROLE_GROUP_ORDER.filter((g) => byGroup.has(g)).map((roleGroup) => (
                <RoleGroupTable
                  key={roleGroup}
                  roleGroup={roleGroup}
                  rows={byGroup.get(roleGroup)!}
                  busyKeys={busyKeys}
                  rowErrors={rowErrors}
                  labelDrafts={labelDrafts}
                  onLabelChange={(row, value) =>
                    setLabelDrafts((prev) => ({ ...prev, [rowKey(row)]: value }))
                  }
                  onLabelBlur={handleLabelBlur}
                  onSortOrderCommit={(row, value) => savePatch(row, { sortOrder: value })}
                  onProfileTitleChange={(row, value) => savePatch(row, { profileTitle: value })}
                  onDeleteRequest={setPendingDelete}
                />
              ))}
            </div>
          </section>
        );
      })}

      {rows.length === 0 && (
        <p className="text-muted-foreground text-sm" data-testid="roles-empty">
          No role-vocabulary entries yet.
        </p>
      )}

      <ConfirmDialog
        open={pendingRename !== null}
        onOpenChange={(open) => {
          if (!open) {
            if (pendingRename) {
              setLabelDrafts((prev) => ({
                ...prev,
                [rowKey(pendingRename.row)]: pendingRename.row.label,
              }));
            }
            setPendingRename(null);
          }
        }}
        title={pendingRename ? `Rename "${pendingRename.row.label}" to "${pendingRename.newLabel}"?` : ""}
        description={pendingRename ? renameBlastRadiusText(pendingRename.row) : ""}
        reasonMode="none"
        confirmLabel="Rename"
        confirmVariant="default"
        onConfirm={confirmRename}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title={pendingDelete ? deleteConfirmTitle(pendingDelete) : ""}
        description={pendingDelete ? deleteConfirmDescription(pendingDelete) : ""}
        reasonMode="none"
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={confirmDelete}
      />

      <AddRoleDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        existingKeys={new Set(rows.map(rowKey))}
        onCreated={(row) =>
          setRows((prev) => {
            const idx = prev.findIndex((r) => compareRosterRows(row, r) < 0);
            return idx === -1 ? [...prev, row] : [...prev.slice(0, idx), row, ...prev.slice(idx)];
          })
        }
      />
    </div>
  );
}

function RoleGroupTable({
  roleGroup,
  rows,
  busyKeys,
  rowErrors,
  labelDrafts,
  onLabelChange,
  onLabelBlur,
  onSortOrderCommit,
  onProfileTitleChange,
  onDeleteRequest,
}: {
  roleGroup: OrgUnitRoleGroup;
  rows: OrgUnitRoleRosterRow[];
  busyKeys: ReadonlySet<string>;
  rowErrors: Record<string, string | null>;
  labelDrafts: Record<string, string>;
  onLabelChange: (row: OrgUnitRoleRosterRow, value: string) => void;
  onLabelBlur: (row: OrgUnitRoleRosterRow) => void;
  onSortOrderCommit: (row: OrgUnitRoleRosterRow, value: number) => void;
  onProfileTitleChange: (row: OrgUnitRoleRosterRow, value: boolean) => void;
  onDeleteRequest: (row: OrgUnitRoleRosterRow) => void;
}) {
  return (
    <div className="border-apollo-border bg-apollo-surface overflow-x-auto rounded-md border">
      <table className="w-full text-sm" data-testid={`roles-table-${roleGroup}`}>
        <thead>
          <tr className="text-muted-foreground border-apollo-border bg-apollo-surface-2 border-b text-left">
            <th className="px-4 py-2.5 font-medium">{ROLE_GROUP_LABEL[roleGroup]}</th>
            <th className="px-4 py-2.5 font-medium">Key</th>
            <th className="px-4 py-2.5 font-medium">Scope</th>
            <th className="px-4 py-2.5 text-center font-medium">Single holder</th>
            <th className="px-4 py-2.5 font-medium whitespace-nowrap">Sort order</th>
            <th className="px-4 py-2.5 text-center font-medium">Profile title</th>
            <th className="px-4 py-2.5 text-right font-medium">Holders</th>
            <th className="px-4 py-2.5 font-medium">Source</th>
            <th className="px-4 py-2.5 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = rowKey(row);
            const busy = busyKeys.has(key);
            const error = rowErrors[key];
            return (
              <React.Fragment key={key}>
                <tr
                  className="border-apollo-border border-b align-middle last:border-b-0"
                  data-testid={`roles-row-${key}`}
                >
                  <td className="px-4 py-2.5">
                    <Input
                      value={labelDrafts[key] ?? row.label}
                      onChange={(e) => onLabelChange(row, e.target.value)}
                      onBlur={() => onLabelBlur(row)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      }}
                      disabled={busy}
                      className="h-8 min-w-[10rem]"
                      aria-label={`Label for ${row.key}`}
                      data-testid={`roles-label-${key}`}
                    />
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="text-muted-foreground font-mono text-xs">{row.key}</span>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="text-muted-foreground text-xs">{row.scope}</span>
                  </td>
                  <td className="px-4 py-2.5 text-center">
                    <span className="text-muted-foreground text-xs">{row.singleHolder ? "Yes" : "No"}</span>
                  </td>
                  <td className="px-4 py-2.5">
                    <Input
                      type="number"
                      min={0}
                      max={9999}
                      step={1}
                      defaultValue={row.sortOrder}
                      key={`${key}-${row.sortOrder}`}
                      disabled={busy}
                      onBlur={(e) => {
                        const parsed = Number(e.target.value);
                        if (Number.isInteger(parsed) && parsed >= 0 && parsed !== row.sortOrder) {
                          onSortOrderCommit(row, parsed);
                        } else if (!Number.isInteger(parsed) || parsed < 0) {
                          e.target.value = String(row.sortOrder);
                        }
                      }}
                      className="h-8 w-20"
                      aria-label={`Sort order for ${row.key}`}
                      data-testid={`roles-sort-order-${key}`}
                    />
                  </td>
                  <td className="px-4 py-2.5 text-center">
                    <Switch
                      checked={row.profileTitle}
                      disabled={busy}
                      onCheckedChange={(checked) => onProfileTitleChange(row, checked)}
                      aria-label={`Profile title for ${row.key}`}
                      data-testid={`roles-profile-title-${key}`}
                    />
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{row.holderCount}</td>
                  <td className="px-4 py-2.5">
                    <Badge variant={row.source === "manual" ? "default" : "outline"} className="text-xs">
                      {row.source}
                    </Badge>
                  </td>
                  <td className="px-4 py-2.5">
                    <DeleteRoleButton row={row} busy={busy} onRequest={onDeleteRequest} />
                  </td>
                </tr>
                {(busy || error) && (
                  <tr className="border-apollo-border border-b last:border-b-0">
                    <td colSpan={9} className="px-4 pb-2">
                      {busy && (
                        <span
                          className="text-muted-foreground inline-flex items-center gap-1.5 text-xs"
                          data-testid={`roles-busy-${key}`}
                        >
                          <Loader2 className="size-3 animate-spin" aria-hidden />
                          Saving…
                        </span>
                      )}
                      {error && (
                        <p className="text-destructive text-xs" data-testid={`roles-row-error-${key}`}>
                          {error}
                        </p>
                      )}
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The per-row Delete control. Disabled with an inline reason
 *  ({@link deleteDisabledReason}) for a seeded default or a role with any live
 *  holder; enabled only for a `manual` role with zero holders, matching the
 *  route's own gate order exactly. The reason is both a `title` tooltip and an
 *  `aria-describedby`-linked (visually hidden) span, so it reaches a
 *  screen-reader user the same way a hover reaches a sighted one. */
function DeleteRoleButton({
  row,
  busy,
  onRequest,
}: {
  row: OrgUnitRoleRosterRow;
  busy: boolean;
  onRequest: (row: OrgUnitRoleRosterRow) => void;
}) {
  const key = rowKey(row);
  const reason = deleteDisabledReason(row);
  const reasonId = `roles-delete-reason-${key}`;
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busy || reason !== null}
        title={reason ?? undefined}
        aria-describedby={reason ? reasonId : undefined}
        onClick={() => onRequest(row)}
        data-testid={`roles-delete-${key}`}
      >
        Delete
      </Button>
      {reason && (
        <span id={reasonId} className="sr-only">
          {reason}
        </span>
      )}
    </>
  );
}

function AddRoleDialog({
  open,
  onOpenChange,
  existingKeys,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingKeys: ReadonlySet<string>;
  onCreated: (row: OrgUnitRoleRosterRow) => void;
}) {
  const [entityType, setEntityType] = React.useState<OrgUnitRoleEntityType>(ENTITY_TYPE_OPTIONS[0]);
  const [key, setKey] = React.useState("");
  const [label, setLabel] = React.useState("");
  const [roleGroup, setRoleGroup] = React.useState<OrgUnitRoleGroup>("leadership");
  const [scope, setScope] = React.useState<OrgUnitRoleScope>("unit");
  const [sortOrder, setSortOrder] = React.useState("100");
  const [singleHolder, setSingleHolder] = React.useState(false);
  const [profileTitle, setProfileTitle] = React.useState(true);
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setEntityType(ENTITY_TYPE_OPTIONS[0]);
      setKey("");
      setLabel("");
      setRoleGroup("leadership");
      setScope("unit");
      setSortOrder("100");
      setSingleHolder(false);
      setProfileTitle(true);
      setSending(false);
      setError(null);
    }
  }, [open]);

  const trimmedKey = key.trim();
  const trimmedLabel = label.trim();
  const parsedSortOrder = Number(sortOrder);
  const sortOrderValid = Number.isInteger(parsedSortOrder) && parsedSortOrder >= 0 && parsedSortOrder <= 9999;
  const wouldCollide = existingKeys.has(`${entityType}:${trimmedKey}`);
  const canSubmit =
    !sending && trimmedKey.length > 0 && trimmedLabel.length > 0 && sortOrderValid && !wouldCollide;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/edit/roles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entityType,
          key: trimmedKey,
          label: trimmedLabel,
          roleGroup,
          scope,
          sortOrder: parsedSortOrder,
          singleHolder,
          profileTitle,
        }),
      });
      const data = (await res.json()) as OrgUnitRoleRosterRow & { ok: boolean; error?: string };
      if (!res.ok || data.ok !== true) {
        setError(mapCreateError(data.error ?? ""));
        return;
      }
      onCreated({
        key: data.key,
        entityType: data.entityType,
        label: data.label,
        roleGroup: data.roleGroup,
        scope: data.scope,
        singleHolder: data.singleHolder,
        sortOrder: data.sortOrder,
        profileTitle: data.profileTitle,
        source: data.source,
        holderCount: 0,
        unitCount: 0,
        // A freshly created role never carries any pre-existing scope rows —
        // POST has no field for them.
        scopeRowCount: 0,
      });
      onOpenChange(false);
    } catch {
      setError("Something went wrong — please try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="roles-add-dialog">
        <DialogHeader className="gap-1 text-left">
          <DialogTitle>Add role</DialogTitle>
          <DialogDescription>
            Create a new leadership or membership role for a unit kind. The key cannot be changed
            after creation.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <Alert variant="destructive" data-testid="roles-add-error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="grid grid-cols-2 gap-4">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Unit kind</span>
            <select
              className="border-apollo-border-strong bg-background h-9 rounded-md border px-3 text-sm"
              value={entityType}
              onChange={(e) => setEntityType(e.target.value as OrgUnitRoleEntityType)}
              data-testid="roles-add-entity-type"
            >
              {ENTITY_TYPE_OPTIONS.map((et) => (
                <option key={et} value={et}>
                  {ENTITY_TYPE_LABEL[et]}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Key</span>
            <Input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="e.g. deputy_director"
              data-testid="roles-add-key"
            />
          </label>

          <label className="col-span-2 flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Label</span>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Deputy Director"
              data-testid="roles-add-label"
            />
          </label>

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Role group</span>
            <select
              className="border-apollo-border-strong bg-background h-9 rounded-md border px-3 text-sm"
              value={roleGroup}
              onChange={(e) => setRoleGroup(e.target.value as OrgUnitRoleGroup)}
              data-testid="roles-add-role-group"
            >
              <option value="leadership">Leadership</option>
              <option value="membership">Membership</option>
            </select>
          </label>

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Scope</span>
            <select
              className="border-apollo-border-strong bg-background h-9 rounded-md border px-3 text-sm"
              value={scope}
              onChange={(e) => setScope(e.target.value as OrgUnitRoleScope)}
              data-testid="roles-add-scope"
            >
              <option value="unit">Unit</option>
              <option value="program">Program</option>
            </select>
          </label>

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Sort order</span>
            <Input
              type="number"
              min={0}
              max={9999}
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
              data-testid="roles-add-sort-order"
            />
          </label>

          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={singleHolder}
              onCheckedChange={setSingleHolder}
              data-testid="roles-add-single-holder"
            />
            <span className={cn("font-medium")}>Single holder</span>
          </label>

          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={profileTitle}
              onCheckedChange={setProfileTitle}
              data-testid="roles-add-profile-title"
            />
            <span className="font-medium">Shows as profile title</span>
          </label>
        </div>

        {wouldCollide && (
          <p className="text-destructive text-xs" data-testid="roles-add-collision-hint">
            That key already exists for this unit kind.
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="apollo"
            onClick={handleSubmit}
            disabled={!canSubmit}
            data-testid="roles-add-submit"
          >
            {sending ? "Adding…" : "Add role"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
