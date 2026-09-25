/**
 * The Administrators page's "Functional roles" tab: access that isn't tied to
 * an org unit (External communications, Development, Reporting), one row per
 * `functional_role_grant` row. Superuser-only (the page only mounts it for a
 * superuser; `POST /api/edit/functional-roles` re-checks).
 *
 * Manual rows ("Granted here") get Edit scope + Revoke; imported rows (report
 * grants, the break-glass allowlists) render "Read-only" with a lock, like
 * ED-sourced unit grants. "Import from sources" re-runs the reconcile.
 *
 * Registry only: the copy says so, because a row made here does not yet open
 * anything (access still comes from the ED groups and report grants).
 */
"use client";

import * as React from "react";
import { Lock } from "lucide-react";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";

import { ConfirmDialog } from "@/components/edit/confirm-dialog";
import {
  DirectoryPeopleTypeahead,
  type DirectoryValue,
} from "@/components/edit/directory-people-typeahead";
import { ViewAsButton } from "@/components/edit/view-as-button";
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
  ALL_SCOPE,
  FUNCTIONAL_ROLE_DESCRIPTION,
  FUNCTIONAL_ROLE_LABEL,
  FUNCTIONAL_ROLES,
  isImportedSource,
  scopeLabel,
  type FunctionalRole,
  type FunctionalRoleRow,
  type FunctionalRoleScopeOptions,
} from "@/lib/edit/functional-roles";
import { cn } from "@/lib/utils";

/** The note every "not yet a gate" surface carries. */
export const FUNCTIONAL_ROLES_TRACKING_NOTE =
  "Recorded here for tracking. Access itself still comes from the Web Directory groups and each report's own access list.";

const SEGMENT_ITEM =
  "cursor-pointer rounded-md px-[11px] py-1 text-[13px] whitespace-nowrap transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=checked]:bg-apollo-surface data-[state=checked]:font-medium data-[state=checked]:text-foreground data-[state=checked]:shadow-[0_1px_2px_rgba(34,30,28,.12)] data-[state=unchecked]:text-muted-foreground data-[state=unchecked]:hover:text-foreground";

const ROW_COLS = "md:grid-cols-[minmax(130px,1.2fr)_minmax(120px,1fr)_minmax(150px,1.4fr)_104px]";
const ROW_GRID = cn("grid grid-cols-1 gap-2 md:items-center md:gap-3.5", ROW_COLS);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function monthYear(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

/** A row's stable key (the table's primary key). */
export function functionalRowKey(r: Pick<FunctionalRoleRow, "role" | "cwid" | "source">): string {
  return `${r.role}:${r.cwid}:${r.source}`;
}

const IMPORTED_NOTE: Record<string, string> = {
  report_access:
    "Imported from report access. Change it from the report's “Who can run this report” control.",
  allowlist: "Imported from the break-glass allowlist in the app's deploy settings.",
};

type FilterGroup = "role" | "scope" | "src";
type SortMode = "person" | "role";

/** Rows answered by `POST /api/edit/functional-roles`. */
type RouteResponse = {
  ok: boolean;
  error?: string;
  rows?: FunctionalRoleRow[];
  added?: number;
  updated?: number;
  removed?: number;
};

async function postFunctionalRoles(body: Record<string, unknown>): Promise<RouteResponse> {
  const res = await fetch("/api/edit/functional-roles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({ ok: false }))) as RouteResponse;
  return res.ok ? data : { ...data, ok: false };
}

function mapError(code: string | undefined): string {
  switch (code) {
    case "not_superuser":
      return "Only superusers can manage functional roles.";
    case "invalid_cwid":
      return "That person couldn't be found. Try a different search.";
    case "invalid_scopes":
      return "Pick at least one scope.";
    case "not_found":
      return "That assignment no longer exists. Reload the page.";
    default:
      return "Something went wrong — please try again.";
  }
}

/** Toggle one scope key in a draft: "*" is exclusive of every other key. */
export function toggleScope(draft: ReadonlyArray<string>, key: string): string[] {
  if (draft.includes(key)) return draft.filter((k) => k !== key);
  if (key === ALL_SCOPE) return [ALL_SCOPE];
  return [...draft.filter((k) => k !== ALL_SCOPE), key];
}

/** The checkbox list both dialogs use to pick scopes for one role. */
function ScopePicker({
  role,
  options,
  value,
  onChange,
  idPrefix,
}: {
  role: FunctionalRole;
  options: FunctionalRoleScopeOptions;
  value: ReadonlyArray<string>;
  onChange: (next: string[]) => void;
  idPrefix: string;
}) {
  return (
    <fieldset className="m-0 flex flex-col gap-1 border-0 p-0" data-testid={`${idPrefix}-scopes`}>
      <legend className="mb-1 p-0 text-sm font-medium">Scope</legend>
      <div className="flex max-h-60 flex-col gap-0.5 overflow-y-auto">
        {options[role].map((o) => (
          <label key={o.key} className="flex cursor-pointer items-center gap-2.5 py-1 text-sm">
            <input
              type="checkbox"
              checked={value.includes(o.key)}
              onChange={() => onChange(toggleScope(value, o.key))}
              className="accent-apollo-maroon m-0 size-4 flex-none cursor-pointer"
              data-testid={`${idPrefix}-scope-${o.key}`}
            />
            <span>{o.key === ALL_SCOPE ? scopeLabel(options, role, o.key) : o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

// ─── Assign dialog (the header button on this tab) ───────────────────────────

export function AssignFunctionalRoleDialog({
  scopeOptions,
  onAssigned,
}: {
  scopeOptions: FunctionalRoleScopeOptions;
  onAssigned: (rows: FunctionalRoleRow[]) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [grantee, setGrantee] = React.useState<DirectoryValue | null>(null);
  const [role, setRole] = React.useState<FunctionalRole>("reporting");
  const [scopes, setScopes] = React.useState<string[]>([ALL_SCOPE]);
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setGrantee(null);
      setRole("reporting");
      setScopes([ALL_SCOPE]);
      setSending(false);
      setError(null);
    }
  }, [open]);

  const canSubmit = grantee !== null && scopes.length > 0 && !sending;

  async function submit() {
    if (!grantee || !canSubmit) return;
    setSending(true);
    setError(null);
    try {
      const data = await postFunctionalRoles({
        op: "grant",
        role,
        cwid: grantee.cwid,
        scopes,
        name: grantee.name,
      });
      if (!data.ok || !data.rows) {
        setError(mapError(data.error));
        return;
      }
      onAssigned(data.rows);
      setOpen(false);
    } catch {
      setError(mapError(undefined));
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="apollo"
        onClick={() => setOpen(true)}
        data-testid="functional-roles-assign-trigger"
      >
        Assign role
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-testid="functional-roles-assign-dialog">
          <DialogHeader className="gap-1 text-left">
            <DialogTitle>Assign a functional role</DialogTitle>
            <DialogDescription>{FUNCTIONAL_ROLES_TRACKING_NOTE}</DialogDescription>
          </DialogHeader>
          {error && (
            <Alert variant="destructive" data-testid="functional-roles-assign-error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Person</span>
              <DirectoryPeopleTypeahead
                idPrefix="functional-roles-assign"
                value={grantee}
                onChange={setGrantee}
              />
            </div>
            <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
              <legend className="mb-1 p-0 text-sm font-medium">Role</legend>
              {FUNCTIONAL_ROLES.map((r) => (
                <label key={r} className="flex cursor-pointer items-start gap-2.5 py-1 text-sm">
                  <input
                    type="radio"
                    name="functional-role"
                    checked={role === r}
                    onChange={() => {
                      setRole(r);
                      setScopes([ALL_SCOPE]);
                    }}
                    className="accent-apollo-maroon m-0 mt-0.5 size-4 flex-none cursor-pointer"
                    data-testid={`functional-roles-assign-role-${r}`}
                  />
                  <span className="flex flex-col">
                    <span>{FUNCTIONAL_ROLE_LABEL[r]}</span>
                    <span className="text-muted-foreground text-[12.5px]">
                      {FUNCTIONAL_ROLE_DESCRIPTION[r]}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
            {scopeOptions[role].length > 1 && (
              <ScopePicker
                role={role}
                options={scopeOptions}
                value={scopes}
                onChange={setScopes}
                idPrefix="functional-roles-assign"
              />
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="apollo"
              onClick={submit}
              disabled={!canSubmit}
              data-testid="functional-roles-assign-submit"
            >
              {sending ? "Assigning…" : "Assign role"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─── The tab body ────────────────────────────────────────────────────────────

export type FunctionalRolesPanelProps = {
  rows: ReadonlyArray<FunctionalRoleRow>;
  onRowsChange: (rows: FunctionalRoleRow[]) => void;
  scopeOptions: FunctionalRoleScopeOptions;
  actorCwid: string;
  canImpersonate?: boolean;
};

export function FunctionalRolesPanel({
  rows,
  onRowsChange,
  scopeOptions,
  actorCwid,
  canImpersonate = false,
}: FunctionalRolesPanelProps) {
  const [query, setQuery] = React.useState("");
  const [filters, setFilters] = React.useState<ReadonlySet<string>>(() => new Set());
  const [sortMode, setSortMode] = React.useState<SortMode>("person");
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [importing, setImporting] = React.useState(false);
  const [revokeTarget, setRevokeTarget] = React.useState<FunctionalRoleRow | null>(null);
  const [scopeTarget, setScopeTarget] = React.useState<FunctionalRoleRow | null>(null);
  const [scopeDraft, setScopeDraft] = React.useState<string[]>([]);
  const [savingScope, setSavingScope] = React.useState(false);

  const scopeKind = (r: FunctionalRoleRow) => (r.scopes.includes(ALL_SCOPE) ? "all" : "some");
  const matches = (group: FilterGroup, value: string, r: FunctionalRoleRow) =>
    group === "role"
      ? r.role === value
      : group === "scope"
        ? scopeKind(r) === value
        : (value === "imported") === isImportedSource(r.source);
  const valuesOf = (group: FilterGroup) =>
    [...filters].filter((k) => k.startsWith(`${group}:`)).map((k) => k.slice(group.length + 1));
  const q = query.trim().toLowerCase();
  const shown = rows
    .filter((r) =>
      (["role", "scope", "src"] as const).every((g) => {
        const vs = valuesOf(g);
        return vs.length === 0 || vs.some((v) => matches(g, v, r));
      }),
    )
    .filter(
      (r) =>
        !q ||
        [
          r.name,
          r.cwid,
          FUNCTIONAL_ROLE_LABEL[r.role],
          ...r.scopes.map((s) => scopeLabel(scopeOptions, r.role, s)),
        ]
          .join(" ")
          .toLowerCase()
          .includes(q),
    )
    .sort(
      (a, b) =>
        (sortMode === "role"
          ? FUNCTIONAL_ROLES.indexOf(a.role) - FUNCTIONAL_ROLES.indexOf(b.role)
          : 0) ||
        a.name.localeCompare(b.name) ||
        a.cwid.localeCompare(b.cwid),
    );

  const people = new Set(rows.map((r) => r.cwid)).size;
  const imported = rows.filter((r) => isImportedSource(r.source)).length;
  const count = (group: FilterGroup, value: string) =>
    rows.filter((r) => matches(group, value, r)).length;
  const railGroups: ReadonlyArray<{
    group: FilterGroup;
    label: string;
    items: Array<[string, string]>;
  }> = [
    {
      group: "role",
      label: "Role",
      items: FUNCTIONAL_ROLES.map((r) => [r, FUNCTIONAL_ROLE_LABEL[r]]),
    },
    {
      group: "scope",
      label: "Scope",
      items: [
        ["all", "Institution-wide"],
        ["some", "Specific areas"],
      ],
    },
    {
      group: "src",
      label: "Source",
      items: [
        ["imported", "Imported"],
        ["manual", "Granted here"],
      ],
    },
  ];
  const anyFilter = filters.size > 0 || query.length > 0;

  function toggleFilter(key: string) {
    setFilters((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function runImport() {
    if (importing) return;
    setImporting(true);
    setError(null);
    setNotice(null);
    try {
      const data = await postFunctionalRoles({ op: "import" });
      if (!data.ok || !data.rows) {
        setError(mapError(data.error));
        return;
      }
      onRowsChange(data.rows);
      setNotice(
        `Import finished: ${data.added ?? 0} added, ${data.updated ?? 0} updated, ${data.removed ?? 0} removed.`,
      );
    } catch {
      setError(mapError(undefined));
    } finally {
      setImporting(false);
    }
  }

  async function revoke(row: FunctionalRoleRow) {
    setError(null);
    const data = await postFunctionalRoles({ op: "revoke", role: row.role, cwid: row.cwid });
    if (!data.ok || !data.rows) {
      setError(mapError(data.error));
      throw new Error("revoke_failed");
    }
    onRowsChange(data.rows);
    setRevokeTarget(null);
  }

  async function saveScope() {
    if (!scopeTarget || savingScope || scopeDraft.length === 0) return;
    setSavingScope(true);
    setError(null);
    try {
      const data = await postFunctionalRoles({
        op: "set_scopes",
        role: scopeTarget.role,
        cwid: scopeTarget.cwid,
        scopes: scopeDraft,
      });
      if (!data.ok || !data.rows) {
        setError(mapError(data.error));
        return;
      }
      onRowsChange(data.rows);
      setScopeTarget(null);
    } catch {
      setError(mapError(undefined));
    } finally {
      setSavingScope(false);
    }
  }

  function sourceLine(r: FunctionalRoleRow): string {
    const who = r.grantedBy === actorCwid ? "you" : (r.grantedByName ?? r.grantedBy);
    const when = monthYear(r.grantedAt);
    if (r.source === "manual") return `Added by ${who}${when ? ` · ${when}` : ""}`;
    if (r.source === "report_access")
      return `Report access · added by ${who}${when ? ` · ${when}` : ""}`;
    if (r.source === "allowlist") return "Break-glass allowlist";
    return r.source;
  }

  const headerCell = "text-muted-foreground text-xs font-medium tracking-[0.08em] uppercase";

  return (
    <div
      className="grid items-start gap-5 md:grid-cols-[200px_minmax(0,1fr)]"
      data-testid="functional-roles-panel"
    >
      <aside
        aria-label="Filters"
        className="bg-apollo-rail border-apollo-border-strong flex flex-col gap-5 rounded-[13px] border px-5 pt-[18px] pb-5 md:sticky md:top-5 md:gap-[22px]"
        data-testid="functional-roles-rail"
      >
        <div className="flex items-baseline justify-between">
          <span className="text-muted-foreground text-xs font-medium tracking-[0.12em] uppercase">
            Filters
          </span>
          <button
            type="button"
            onClick={() => {
              setFilters(new Set());
              setQuery("");
            }}
            disabled={!anyFilter}
            className="text-apollo-slate disabled:text-muted-foreground text-[13px] hover:underline disabled:cursor-default disabled:no-underline"
            data-testid="functional-roles-filters-clear"
          >
            Clear
          </button>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-5 md:flex md:flex-col md:gap-[22px]">
          {railGroups.map(({ group, label, items }) => (
            <fieldset key={group} className="m-0 flex min-w-0 flex-col gap-0.5 border-0 p-0">
              <legend className="text-muted-foreground mb-1.5 p-0 text-xs font-medium tracking-[0.12em] whitespace-nowrap uppercase">
                {label}
              </legend>
              {items.map(([value, itemLabel]) => {
                const key = `${group}:${value}`;
                return (
                  <label
                    key={key}
                    className="flex cursor-pointer items-center gap-2.5 py-1 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={filters.has(key)}
                      onChange={() => toggleFilter(key)}
                      className="accent-apollo-maroon m-0 size-4 flex-none cursor-pointer"
                      data-testid={`functional-roles-filter-${group}-${value}`}
                    />
                    <span className="min-w-0 flex-1 leading-[1.35]">{itemLabel}</span>
                    <span className="text-muted-foreground text-[13px] tabular-nums">
                      {count(group, value)}
                    </span>
                  </label>
                );
              })}
            </fieldset>
          ))}
        </div>
      </aside>

      <section className="flex min-w-0 flex-col gap-3.5" aria-label="Functional roles">
        <Input
          type="text"
          value={query}
          placeholder="Filter by name, role, scope, or CWID…"
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter functional roles"
          className="bg-apollo-surface h-10"
          data-testid="functional-roles-filter-input"
        />
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <span
            className="text-muted-foreground flex flex-wrap gap-x-6 gap-y-1 text-[15px]"
            data-testid="functional-roles-stats"
          >
            <span className="whitespace-nowrap">
              <span className="text-foreground font-semibold tabular-nums">{people}</span>{" "}
              {people === 1 ? "person" : "people"}
            </span>
            <span className="whitespace-nowrap">
              <span className="text-foreground font-semibold tabular-nums">{imported}</span>{" "}
              imported
            </span>
            <span className="whitespace-nowrap">
              <span className="text-foreground font-semibold tabular-nums">
                {rows.length - imported}
              </span>{" "}
              granted here
            </span>
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground text-[13px]" id="functional-roles-sort-label">
              Sort
            </span>
            <RadioGroupPrimitive.Root
              value={sortMode}
              onValueChange={(v) => setSortMode(v as SortMode)}
              aria-labelledby="functional-roles-sort-label"
              orientation="horizontal"
              className="bg-apollo-surface-2 border-apollo-border flex rounded-lg border p-[3px]"
              data-testid="functional-roles-sort"
            >
              {(
                [
                  ["person", "Person"],
                  ["role", "Role"],
                ] as const
              ).map(([value, label]) => (
                <RadioGroupPrimitive.Item
                  key={value}
                  value={value}
                  className={SEGMENT_ITEM}
                  data-testid={`functional-roles-sort-${value}`}
                >
                  {label}
                </RadioGroupPrimitive.Item>
              ))}
            </RadioGroupPrimitive.Root>
            <button
              type="button"
              onClick={runImport}
              disabled={importing}
              className="text-apollo-slate disabled:text-muted-foreground text-[13px] whitespace-nowrap hover:underline"
              title="Bring in report access grants and the break-glass allowlists. Web Directory group members can't be listed, so they aren't imported."
              data-testid="functional-roles-import"
            >
              {importing ? "Importing…" : "Import from sources"}
            </button>
          </div>
        </div>

        {notice && (
          <p
            className="text-muted-foreground m-0 text-sm"
            role="status"
            data-testid="functional-roles-notice"
          >
            {notice}
          </p>
        )}
        {error && (
          <Alert variant="destructive" data-testid="functional-roles-error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="bg-apollo-surface border-apollo-border-strong overflow-hidden rounded-[13px] border">
          <div
            className={cn(
              "bg-apollo-surface-2 border-apollo-border-strong hidden gap-3.5 border-b px-5 py-3 md:grid",
              ROW_COLS,
            )}
            aria-hidden
          >
            <span className={headerCell}>Person</span>
            <span className={headerCell}>Role</span>
            <span className={headerCell}>Scope · source</span>
            <span />
          </div>
          {shown.length === 0 ? (
            <p
              className="text-muted-foreground m-0 px-8 py-8 text-center text-sm"
              data-testid="functional-roles-empty"
            >
              {rows.length === 0
                ? "No functional roles recorded yet. Import from sources, or assign a role."
                : "No one matches these filters."}
            </p>
          ) : (
            <div data-testid="functional-roles-table">
              {shown.map((r, i) => {
                const key = functionalRowKey(r);
                const locked = isImportedSource(r.source);
                const editableScope = !locked && scopeOptions[r.role].length > 1;
                return (
                  <div
                    key={key}
                    className={cn(
                      ROW_GRID,
                      "border-apollo-border border-b px-5 py-3.5",
                      i % 2 === 1 ? "bg-apollo-page" : "bg-apollo-surface",
                    )}
                    data-testid={`functional-role-${key}`}
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <div
                        aria-hidden
                        className="bg-apollo-surface-2 ring-apollo-border-strong text-apollo-bar flex size-9 flex-none items-center justify-center rounded-full text-[12.5px] font-semibold ring-1"
                      >
                        {initials(r.name)}
                      </div>
                      <div className="flex min-w-0 flex-col gap-px">
                        <span className="truncate text-[14.5px] font-[550]">{r.name}</span>
                        {r.title && (
                          <span className="text-muted-foreground truncate text-[13px]">
                            {r.title}
                          </span>
                        )}
                        <span className="text-muted-foreground font-mono text-xs">{r.cwid}</span>
                      </div>
                    </div>
                    <div className="flex min-w-0 flex-col gap-0.5 pl-12 md:pl-0">
                      <span className="text-sm font-medium">{FUNCTIONAL_ROLE_LABEL[r.role]}</span>
                      <span className="text-muted-foreground text-[12.5px] leading-[1.4]">
                        {FUNCTIONAL_ROLE_DESCRIPTION[r.role]}
                      </span>
                    </div>
                    <div className="flex min-w-0 flex-col gap-1.5 pl-12 md:pl-0">
                      <div
                        className="flex flex-wrap gap-1.5"
                        data-testid={`functional-role-scopes-${key}`}
                      >
                        {r.scopes.map((s) => (
                          <span
                            key={s}
                            className={cn(
                              "rounded-full border px-2.5 py-0.5 text-[12.5px] font-medium whitespace-nowrap",
                              s === ALL_SCOPE
                                ? "bg-apollo-slate-tint text-apollo-slate border-apollo-slate-tint-border"
                                : "bg-apollo-surface-2 text-foreground border-apollo-border-strong",
                            )}
                          >
                            {scopeLabel(scopeOptions, r.role, s)}
                          </span>
                        ))}
                      </div>
                      <span className="flex min-w-0 items-center gap-1.5 text-[12.5px]">
                        {locked && (
                          <span
                            title={IMPORTED_NOTE[r.source]}
                            className="bg-apollo-lock-bg inline-flex size-[18px] flex-none items-center justify-center rounded"
                          >
                            <Lock className="size-[11px]" aria-hidden />
                          </span>
                        )}
                        <span className="text-muted-foreground min-w-0 truncate">
                          {sourceLine(r)}
                        </span>
                      </span>
                    </div>
                    <div className="flex flex-col items-start gap-0.5 pl-12 md:pl-0">
                      {canImpersonate && r.cwid !== actorCwid && (
                        <ViewAsButton targetCwid={r.cwid} targetName={r.name} variant="ghost" />
                      )}
                      {locked ? (
                        <span
                          title={IMPORTED_NOTE[r.source]}
                          className="text-muted-foreground text-[12.5px] whitespace-nowrap"
                          data-testid={`functional-role-locked-${key}`}
                        >
                          Read-only
                          <span className="sr-only"> — {IMPORTED_NOTE[r.source]}</span>
                        </span>
                      ) : (
                        <>
                          {editableScope && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setScopeTarget(r);
                                setScopeDraft([...r.scopes]);
                              }}
                              className="text-apollo-slate -ml-2 h-7 px-2 text-[13px] font-normal"
                              data-testid={`functional-role-edit-scope-${key}`}
                            >
                              Edit scope
                            </Button>
                          )}
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setRevokeTarget(r)}
                            className="text-destructive hover:text-destructive -ml-2 h-7 px-2 text-[13px] font-normal"
                            data-testid={`functional-role-revoke-${key}`}
                          >
                            Revoke
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <div
            className="bg-apollo-page text-muted-foreground px-5 py-3 text-[13px]"
            data-testid="functional-roles-footer"
          >
            Showing {shown.length} of {rows.length}{" "}
            {rows.length === 1 ? "assignment" : "assignments"}. {FUNCTIONAL_ROLES_TRACKING_NOTE}
          </div>
        </div>
      </section>

      <Dialog open={scopeTarget !== null} onOpenChange={(o) => !o && setScopeTarget(null)}>
        <DialogContent data-testid="functional-roles-scope-dialog">
          <DialogHeader className="gap-1 text-left">
            <DialogTitle>Edit scope</DialogTitle>
            <DialogDescription>
              {scopeTarget
                ? `${scopeTarget.name} · ${FUNCTIONAL_ROLE_LABEL[scopeTarget.role]}`
                : ""}
            </DialogDescription>
          </DialogHeader>
          {scopeTarget && (
            <ScopePicker
              role={scopeTarget.role}
              options={scopeOptions}
              value={scopeDraft}
              onChange={setScopeDraft}
              idPrefix="functional-roles-scope"
            />
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setScopeTarget(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="apollo"
              onClick={saveScope}
              disabled={savingScope || scopeDraft.length === 0}
              data-testid="functional-roles-scope-save"
            >
              {savingScope ? "Saving…" : "Save scope"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(o) => !o && setRevokeTarget(null)}
        title="Revoke this role?"
        description="This removes the assignment from the registry. You can assign it again later."
        reasonMode="none"
        confirmLabel="Revoke"
        confirmVariant="destructive"
        onConfirm={() => (revokeTarget ? revoke(revokeTarget) : Promise.resolve())}
      />
    </div>
  );
}
