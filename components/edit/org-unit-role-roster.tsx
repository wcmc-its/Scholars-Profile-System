/**
 * OrgUnitRoleRoster — the body of `/edit/roles` (#2542 Phase 3), laid out to
 * `Role Vocabulary.dc.html` (2026-09-25): one tab per unit kind (with its
 * role count), then a Leadership and a Membership table for that kind.
 *
 * `OrgUnitRole` is a REAL table (unlike the Method-Family roster's derived-tier
 * overlay over an ETL-owned base): every row here is a live vocabulary entry,
 * so there is no two-table dance and no bolt-on decision type to reconcile —
 * a save is one `PATCH`/`POST` to `/api/edit/roles`, full stop.
 *
 * Within a kind, leadership renders above membership (the same order the unit
 * page itself renders in), ordered by `sortOrder` within each group (the
 * server pre-sorts; this only partitions that order, it never re-sorts).
 *
 * EDITABLE: `label` (click to rename in place; while editing, the live blast
 * radius — `renameBlastRadiusText` — is stated under the input before Save),
 * `sortOrder` (▲ / ▼ within the group, see `moveWrites`), and `profileTitle`
 * (saves immediately). READ-ONLY: `key`, `entityType`, `roleGroup`, `scope`,
 * `singleHolder`, `source`, `holderCount`. Delete is offered only for
 * `manual` roles with zero holders — a `seed` entry (re-minted by every write
 * path that seeds `DEFAULT_ORG_UNIT_ROLES`) or a role with a live holder
 * shows a lock with the reason instead; see `DeleteRoleButton` below and the
 * route's DELETE docblock (`app/api/edit/roles/route.ts`) for why.
 *
 * PER-ROW busy state (a `Set` of row keys, not the single global `busyKey`
 * `MethodFamiliesRoster` uses): two different rows save fully independently,
 * and a click on row B while row A's write is in flight is never dropped.
 * All editable fields AND the delete button on a given row share that row's
 * busy flag — a label rename and a delete on the SAME row are serialized, but
 * nothing outside that row is. The ▲ / ▼ buttons wait for their whole group,
 * since a move writes two (or more) rows of it.
 */
"use client";

import * as React from "react";
import { Loader2, Lock, Plus } from "lucide-react";

import { ConfirmDialog } from "@/components/edit/confirm-dialog";
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
 * Why the Delete control is withheld (a lock instead) for this row, or `null` when it's
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
  if (row.source !== "manual") return "Seeded defaults can’t be deleted";
  if (row.holderCount > 0)
    return `Has ${row.holderCount.toLocaleString()} current ${holderNoun(row.holderCount)}`;
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
export function deleteConfirmDescription(row: Pick<OrgUnitRoleRosterRow, "scopeRowCount">): string {
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
  /** The page's title + intro, laid out beside the "Add role" button. */
  intro?: React.ReactNode;
};

/** Each role group's heading sub-line. */
const ROLE_GROUP_SUB: Record<OrgUnitRoleGroup, string> = {
  leadership: "Shown in the unit’s leadership list",
  membership: "Roster roles",
};

/**
 * The `sortOrder` writes that move `peers[i]` one step (`dir` = -1 up, +1
 * down) within its group. Swaps the two values when the group's values are
 * all distinct (two PATCHes); otherwise renumbers the whole group 10, 20, 30…
 * in the new order, because swapping two EQUAL values would move nothing.
 * Only rows whose value actually changes are returned.
 */
export function moveWrites(
  peers: ReadonlyArray<OrgUnitRoleRosterRow>,
  i: number,
  dir: -1 | 1,
): { row: OrgUnitRoleRosterRow; sortOrder: number }[] {
  const j = i + dir;
  if (i < 0 || j < 0 || j >= peers.length) return [];
  const a = peers[i]!;
  const b = peers[j]!;
  const distinct = new Set(peers.map((p) => p.sortOrder)).size === peers.length;
  if (distinct) {
    return [
      { row: a, sortOrder: b.sortOrder },
      { row: b, sortOrder: a.sortOrder },
    ];
  }
  const order = [...peers];
  order[i] = b;
  order[j] = a;
  return order
    .map((row, k) => ({ row, sortOrder: (k + 1) * 10 }))
    .filter(({ row, sortOrder }) => row.sortOrder !== sortOrder);
}

export function OrgUnitRoleRoster({ roles, intro }: OrgUnitRoleRosterProps) {
  const [rows, setRows] = React.useState<OrgUnitRoleRosterRow[]>(() =>
    roles.map((r) => ({ ...r })),
  );
  // Per-row busy set — NOT a single shared key. Two different rows write
  // fully independently; see the module doc comment.
  const [busyKeys, setBusyKeys] = React.useState<ReadonlySet<string>>(() => new Set());
  // Per-row error text, so one row's failed save never clobbers another's.
  const [rowErrors, setRowErrors] = React.useState<Record<string, string | null>>({});
  const [kind, setKind] = React.useState<OrgUnitRoleEntityType>(
    () =>
      ENTITY_TYPE_ORDER.find((et) => roles.some((r) => r.entityType === et)) ??
      ENTITY_TYPE_ORDER[0]!,
  );
  // The one label being renamed in place, and its draft.
  const [editing, setEditing] = React.useState<{ key: string; draft: string } | null>(null);
  const [toast, setToast] = React.useState<string | null>(null);
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
    setRows((prev) =>
      prev.map((r) => (rowKey(r) === key ? { ...r, ...patch } : r)).sort(compareRosterRows),
    );
    try {
      const res = await fetch("/api/edit/roles", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityType: row.entityType, key: row.key, ...patch }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || data.ok !== true) {
        setRows((prev) =>
          prev
            .map((r) => (rowKey(r) === key ? { ...r, ...prevValues } : r))
            .sort(compareRosterRows),
        );
        setRowError(key, mapPatchError(data.error ?? ""));
        return false;
      }
      return true;
    } catch {
      setRows((prev) =>
        prev.map((r) => (rowKey(r) === key ? { ...r, ...prevValues } : r)).sort(compareRosterRows),
      );
      setRowError(key, "Something went wrong — please try again.");
      return false;
    } finally {
      setBusy(key, false);
    }
  }

  /** Save the in-place rename. A blank or unchanged draft just closes the
   *  editor — no PATCH. The blast radius was stated inline while editing, so
   *  there is no second confirm. */
  async function saveRename(row: OrgUnitRoleRosterRow) {
    const draft = (editing?.draft ?? "").trim();
    setEditing(null);
    if (draft.length === 0 || draft === row.label) return;
    if (await savePatch(row, { label: draft })) {
      setToast(
        row.holderCount > 0
          ? `Renamed to “${draft}”. ${row.holderCount.toLocaleString()} ${holderNoun(row.holderCount)} now show this label.`
          : `Renamed to “${draft}”.`,
      );
    }
  }

  /** ▲ / ▼ — one step within the row's own group, via `sortOrder` PATCHes. */
  async function move(peers: ReadonlyArray<OrgUnitRoleRosterRow>, i: number, dir: -1 | 1) {
    for (const w of moveWrites(peers, i, dir)) {
      if (!(await savePatch(w.row, { sortOrder: w.sortOrder }))) return;
    }
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
      setToast(`Deleted “${row.label}”.`);
    } catch {
      setRowError(key, "Something went wrong — please try again.");
    } finally {
      setBusy(key, false);
      setPendingDelete(null);
    }
  }

  const byGroup = React.useMemo(() => {
    const m = new Map<OrgUnitRoleGroup, OrgUnitRoleRosterRow[]>();
    for (const row of rows) {
      if (row.entityType !== kind) continue;
      const g = row.roleGroup as OrgUnitRoleGroup;
      if (!m.has(g)) m.set(g, []);
      m.get(g)!.push(row);
    }
    return m;
  }, [rows, kind]);

  return (
    <div className="flex flex-col gap-[22px]" data-slot="org-unit-role-roster">
      <div className="flex flex-wrap items-end gap-4">
        <div className="min-w-0 flex-1 basis-[300px]">{intro}</div>
        <Button
          type="button"
          variant="apollo"
          onClick={() => setAddOpen(true)}
          data-testid="roles-add-trigger"
        >
          <Plus className="size-4" />
          Add role
        </Button>
      </div>

      <div
        className="border-apollo-border-strong flex flex-wrap items-end gap-x-[26px] border-b"
        role="tablist"
        aria-label="Unit kind"
      >
        {ENTITY_TYPE_ORDER.map((et) => {
          const count = rows.filter((r) => r.entityType === et).length;
          const active = kind === et;
          return (
            <button
              key={et}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => {
                setKind(et);
                setEditing(null);
              }}
              className={cn(
                "flex items-center gap-2 border-b-2 px-0.5 pt-2.5 pb-3 text-[15px] whitespace-nowrap",
                active
                  ? "border-apollo-maroon text-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground border-transparent",
              )}
              data-testid={`roles-tab-${et}`}
            >
              {ENTITY_TYPE_LABEL[et]}
              <span
                className={cn(
                  "text-foreground rounded-full px-[7px] py-px text-xs font-normal tabular-nums",
                  active ? "bg-apollo-rail" : "bg-apollo-surface-2",
                )}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {toast && (
        <div
          role="status"
          className="bg-apollo-bar flex items-center gap-3 rounded-[10px] px-3.5 py-2.5 text-[13.5px] text-white"
          data-testid="roles-toast"
        >
          <span className="flex-1">{toast}</span>
          <button
            type="button"
            onClick={() => setToast(null)}
            className="rounded-md border border-white/35 px-2.5 py-0.5 text-[13px] text-white"
          >
            OK
          </button>
        </div>
      )}

      <div role="tabpanel" className="flex flex-col gap-[22px]" data-testid={`roles-panel-${kind}`}>
        {ROLE_GROUP_ORDER.filter((g) => byGroup.has(g)).map((roleGroup) => (
          <section
            key={roleGroup}
            className="flex flex-col gap-2"
            data-testid={`roles-section-${roleGroup}`}
          >
            <div className="flex flex-wrap items-baseline gap-x-2.5">
              <h2 className="m-0 text-[17px] font-semibold">{ROLE_GROUP_LABEL[roleGroup]}</h2>
              <span className="text-muted-foreground text-[13px]">{ROLE_GROUP_SUB[roleGroup]}</span>
            </div>
            <RoleGroupTable
              roleGroup={roleGroup}
              rows={byGroup.get(roleGroup)!}
              busyKeys={busyKeys}
              rowErrors={rowErrors}
              editing={editing}
              onEdit={(row) => setEditing({ key: rowKey(row), draft: row.label })}
              onDraft={(draft) => setEditing((prev) => (prev ? { ...prev, draft } : prev))}
              onCancel={() => setEditing(null)}
              onSave={saveRename}
              onMove={move}
              onProfileTitleChange={(row, value) => savePatch(row, { profileTitle: value })}
              onDeleteRequest={setPendingDelete}
            />
          </section>
        ))}
        {byGroup.size === 0 && (
          <p className="text-muted-foreground text-sm" data-testid="roles-empty">
            No roles for this unit kind yet.
          </p>
        )}
      </div>

      <p className="text-muted-foreground max-w-[100ch] text-[12.5px] leading-normal">
        Delete is available only for roles added here that have no current holders. Seeded defaults,
        and roles with live holders, stay available even if you stop using them going forward.
      </p>

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
        defaultEntityType={kind}
        existingKeys={new Set(rows.map(rowKey))}
        onCreated={(row) => {
          setRows((prev) => {
            const idx = prev.findIndex((r) => compareRosterRows(row, r) < 0);
            return idx === -1 ? [...prev, row] : [...prev.slice(0, idx), row, ...prev.slice(idx)];
          });
          setKind(row.entityType as OrgUnitRoleEntityType);
          setToast(`Added “${row.label}”.`);
        }}
      />
    </div>
  );
}

/** Order · Label · Single · Profile title · Holders · Source · (delete). */
const COLUMN_WIDTHS = [
  "w-[68px]",
  "",
  "w-[100px]",
  "w-[104px]",
  "w-[88px]",
  "w-[126px]",
  "w-[80px]",
];

function RoleGroupTable({
  roleGroup,
  rows,
  busyKeys,
  rowErrors,
  editing,
  onEdit,
  onDraft,
  onCancel,
  onSave,
  onMove,
  onProfileTitleChange,
  onDeleteRequest,
}: {
  roleGroup: OrgUnitRoleGroup;
  rows: OrgUnitRoleRosterRow[];
  busyKeys: ReadonlySet<string>;
  rowErrors: Record<string, string | null>;
  editing: { key: string; draft: string } | null;
  onEdit: (row: OrgUnitRoleRosterRow) => void;
  onDraft: (draft: string) => void;
  onCancel: () => void;
  onSave: (row: OrgUnitRoleRosterRow) => void;
  onMove: (peers: ReadonlyArray<OrgUnitRoleRosterRow>, i: number, dir: -1 | 1) => void;
  onProfileTitleChange: (row: OrgUnitRoleRosterRow, value: boolean) => void;
  onDeleteRequest: (row: OrgUnitRoleRosterRow) => void;
}) {
  const anyBusy = rows.some((r) => busyKeys.has(rowKey(r)));
  const th = "px-4 py-[9px] text-left text-[11.5px] font-medium tracking-[0.06em] uppercase";
  const td = "px-4 py-[9px]";
  return (
    <div className="border-apollo-border-strong bg-apollo-surface overflow-x-auto rounded-[13px] border">
      <table
        className="w-full min-w-[640px] table-fixed text-sm"
        data-testid={`roles-table-${roleGroup}`}
      >
        <colgroup>
          {COLUMN_WIDTHS.map((w, i) => (
            <col key={i} className={w} />
          ))}
        </colgroup>
        <thead>
          <tr className="text-muted-foreground bg-apollo-surface-2 border-apollo-border-strong border-b">
            <th className={th}>Order</th>
            <th className={th}>Label</th>
            <th className={th} title="Only one person can hold it at a time">
              Single
            </th>
            <th className={th} title="Show as a title on the holder’s profile">
              Profile title
            </th>
            <th className={cn(th, "text-right")}>Holders</th>
            <th className={th}>Source</th>
            <th className={th}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const key = rowKey(row);
            const busy = busyKeys.has(key);
            const error = rowErrors[key];
            const isEditing = editing?.key === key;
            return (
              <React.Fragment key={key}>
                <tr
                  className="border-apollo-border hover:bg-apollo-page border-t align-middle first:border-t-0"
                  data-testid={`roles-row-${key}`}
                >
                  <td className={cn(td, "pr-0")}>
                    <div className="flex items-center gap-0.5">
                      <button
                        type="button"
                        disabled={i === 0 || anyBusy}
                        onClick={() => onMove(rows, i, -1)}
                        aria-label={`Move ${row.label} up`}
                        className="text-muted-foreground hover:bg-apollo-surface-2 disabled:text-apollo-border size-[22px] rounded-[5px] text-xs disabled:hover:bg-transparent"
                        data-testid={`roles-move-up-${key}`}
                      >
                        ▲
                      </button>
                      <button
                        type="button"
                        disabled={i === rows.length - 1 || anyBusy}
                        onClick={() => onMove(rows, i, 1)}
                        aria-label={`Move ${row.label} down`}
                        className="text-muted-foreground hover:bg-apollo-surface-2 disabled:text-apollo-border size-[22px] rounded-[5px] text-xs disabled:hover:bg-transparent"
                        data-testid={`roles-move-down-${key}`}
                      >
                        ▼
                      </button>
                    </div>
                  </td>
                  <td className={td}>
                    {isEditing ? (
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Input
                            autoFocus
                            value={editing.draft}
                            onChange={(e) => onDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") onSave(row);
                              if (e.key === "Escape") onCancel();
                            }}
                            className="border-apollo-slate ring-apollo-slate-tint h-[30px] min-w-[160px] flex-1 ring-[3px]"
                            aria-label={`Label for ${row.key}`}
                            data-testid={`roles-label-${key}`}
                          />
                          <Button
                            type="button"
                            size="sm"
                            className="bg-apollo-slate hover:bg-apollo-bar h-[30px] text-white"
                            onClick={() => onSave(row)}
                            data-testid={`roles-label-save-${key}`}
                          >
                            Save
                          </Button>
                          <button
                            type="button"
                            onClick={onCancel}
                            className="text-muted-foreground hover:text-foreground text-[12.5px]"
                          >
                            Cancel
                          </button>
                        </div>
                        {row.holderCount > 0 && (
                          <span
                            className="text-apollo-amber text-xs"
                            data-testid={`roles-rename-impact-${key}`}
                          >
                            {renameBlastRadiusText(row)}
                          </span>
                        )}
                      </div>
                    ) : (
                      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => onEdit(row)}
                          title="Click to rename"
                          aria-label={`Rename ${row.label}`}
                          className="hover:border-apollo-border-strong cursor-text border-b border-dashed border-transparent text-left font-medium"
                          data-testid={`roles-label-view-${key}`}
                        >
                          {row.label}
                        </button>
                        <span className="text-muted-foreground font-mono text-xs">{row.key}</span>
                        {row.scope === "program" && (
                          <span className="bg-apollo-surface-2 text-muted-foreground rounded px-[7px] py-px text-[11px]">
                            program scope
                          </span>
                        )}
                      </div>
                    )}
                  </td>
                  <td
                    className={cn(
                      td,
                      "text-[13px]",
                      row.singleHolder ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {row.singleHolder ? "One holder" : "Many"}
                  </td>
                  <td className={td}>
                    <Switch
                      checked={row.profileTitle}
                      disabled={busy}
                      onCheckedChange={(checked) => onProfileTitleChange(row, checked)}
                      aria-label={`Profile title for ${row.key}`}
                      data-testid={`roles-profile-title-${key}`}
                    />
                  </td>
                  <td
                    className={cn(
                      td,
                      "text-right tabular-nums",
                      row.holderCount > 0
                        ? "text-foreground font-medium"
                        : "text-apollo-border-strong",
                    )}
                  >
                    {row.holderCount.toLocaleString()}
                  </td>
                  <td className={cn(td, "text-muted-foreground text-[12.5px]")}>
                    {row.source === "manual" ? "Added here" : "Seeded default"}
                  </td>
                  <td className={cn(td, "text-right")}>
                    <DeleteRoleButton row={row} busy={busy} onRequest={onDeleteRequest} />
                  </td>
                </tr>
                {(busy || error) && (
                  <tr>
                    <td colSpan={7} className="px-4 pb-2">
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
                        <p
                          className="text-destructive text-xs"
                          data-testid={`roles-row-error-${key}`}
                        >
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

/** The per-row Delete control. Offered only for a `manual` role with zero
 *  holders, matching the route's own gate order exactly; any other row shows a
 *  lock whose reason ({@link deleteDisabledReason}) is both a `title` tooltip
 *  and its accessible name. */
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
  if (reason) {
    return (
      <span
        role="img"
        title={reason}
        aria-label={`Can’t delete: ${reason}`}
        className="bg-apollo-lock-bg text-muted-foreground inline-flex size-[22px] cursor-help items-center justify-center rounded-[5px]"
        data-testid={`roles-delete-locked-${key}`}
      >
        <Lock className="size-3" aria-hidden />
      </span>
    );
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={busy}
      onClick={() => onRequest(row)}
      className="text-destructive hover:bg-apollo-red-tint hover:text-destructive h-7 px-2.5"
      data-testid={`roles-delete-${key}`}
    >
      Delete
    </Button>
  );
}

function AddRoleDialog({
  open,
  onOpenChange,
  defaultEntityType,
  existingKeys,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The unit-kind tab the steward is on — the dialog opens on that kind. */
  defaultEntityType: OrgUnitRoleEntityType;
  existingKeys: ReadonlySet<string>;
  onCreated: (row: OrgUnitRoleRosterRow) => void;
}) {
  const [entityType, setEntityType] = React.useState<OrgUnitRoleEntityType>(defaultEntityType);
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
      setEntityType(defaultEntityType);
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
  }, [open, defaultEntityType]);

  const trimmedKey = key.trim();
  const trimmedLabel = label.trim();
  const parsedSortOrder = Number(sortOrder);
  const sortOrderValid =
    Number.isInteger(parsedSortOrder) && parsedSortOrder >= 0 && parsedSortOrder <= 9999;
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
