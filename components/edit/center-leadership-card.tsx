/**
 * CenterLeadershipCard — the vocabulary-driven center leadership editor
 * (#2542 Phase C, plan section D3), laid out per the Edit Center mockup
 * (2026-09-25): ONE list of every current holder, in role order, and ONE
 * "Add [person] as [role] [Interim] Add" row beneath it — replacing the
 * earlier one-box-per-role stack, which spent a full card on every empty role.
 * A muted "Not filled: …" line under the add row keeps the empty roles visible.
 *
 * Each mutation is still an immediate POST to `/api/edit/center-leadership`
 * (no batched save), and the semantics are unchanged:
 *   - roles come from the server, already filtered to `isRoleAllowedAtUnit`
 *     and ordered by `sortOrder` (`lib/api/unit-edit-context.ts`);
 *   - a `singleHolder` role that already has a holder swaps via "Replace"
 *     (`replace: true`) — the add button relabels itself when such a role is
 *     picked in the role select;
 *   - the add-time "Interim" checkbox defaults unchecked and is omitted from
 *     the POST unless ticked; each row keeps its own Interim toggle
 *     (`set_interim`);
 *   - Remove goes through `ConfirmDialog`;
 *   - every rendered holder is what the route's response says was written.
 *
 * Departments and divisions keep `UnitLeaderCard` — their leadership is
 * ETL-owned and single-role.
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

type Holder = {
  cwid: string;
  name: string | null;
  title: string | null;
  interim: boolean;
};

type Role = CenterLeadershipCardProps["roles"][number];

export type CenterLeadershipCardProps = {
  centerCode: string;
  roles: ReadonlyArray<{
    key: string;
    label: string;
    singleHolder: boolean;
    sortOrder: number;
    holders: ReadonlyArray<Holder>;
  }>;
  /** Heading id — the single-scroll editor renders several sections. */
  headingId?: string;
};

export function CenterLeadershipCard({
  centerCode,
  roles,
  headingId = "center-leadership-heading",
}: CenterLeadershipCardProps) {
  const [holders, setHolders] = React.useState<Record<string, Holder[]>>(() =>
    Object.fromEntries(roles.map((r) => [r.key, [...r.holders]])),
  );
  const [adding, setAdding] = React.useState<DirectoryValue | null>(null);
  const [addRole, setAddRole] = React.useState<string>(() => defaultAddRole(roles));
  const [addInterim, setAddInterim] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<{ roleKey: string; cwid: string } | null>(null);

  const roleByKey = new Map(roles.map((r) => [r.key, r]));
  const rows = roles.flatMap((r) => (holders[r.key] ?? []).map((h) => ({ role: r, holder: h })));
  const emptyRoles = roles.filter((r) => (holders[r.key] ?? []).length === 0);
  const selectedRole = roleByKey.get(addRole);
  const replacing = Boolean(selectedRole?.singleHolder && (holders[addRole] ?? []).length > 0);

  async function post(
    roleKey: string,
    action: "add" | "remove" | "set_interim",
    payload: Record<string, unknown>,
  ): Promise<{ ok: boolean; replacedCwid?: string | null; holder?: Holder }> {
    setError(null);
    try {
      const res = await fetch("/api/edit/center-leadership", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ centerCode, roleKey, action, ...payload }),
      });
      const data = (await res.json()) as {
        ok: boolean;
        error?: string;
        replacedCwid?: string | null;
        holder?: Holder;
      };
      if (!res.ok || data.ok !== true) {
        setError(mapErrorToMessage(data.error ?? ""));
        return { ok: false };
      }
      return { ok: true, replacedCwid: data.replacedCwid ?? null, holder: data.holder };
    } catch {
      setError(mapErrorToMessage(""));
      return { ok: false };
    }
  }

  async function addOrReplace() {
    if (!adding || !selectedRole || busy) return;
    const roleKey = selectedRole.key;
    if ((holders[roleKey] ?? []).some((h) => h.cwid === adding.cwid)) {
      setError("That person already holds this role.");
      return;
    }
    setBusy(true);
    const result = await post(roleKey, "add", {
      cwid: adding.cwid,
      ...(replacing ? { replace: true } : {}),
      ...(addInterim ? { interim: true } : {}),
    });
    if (result.ok) {
      // Render exactly what the route wrote back — never assume `interim`.
      const holder: Holder = result.holder ?? {
        cwid: adding.cwid,
        name: adding.name,
        title: adding.title,
        interim: false,
      };
      setHolders((prev) => {
        const current = prev[roleKey] ?? [];
        const withoutReplaced = result.replacedCwid
          ? current.filter((h) => h.cwid !== result.replacedCwid)
          : current;
        return {
          ...prev,
          [roleKey]: [...withoutReplaced.filter((h) => h.cwid !== holder.cwid), holder],
        };
      });
      setAdding(null);
      setAddInterim(false);
    }
    setBusy(false);
  }

  async function removeHolder(roleKey: string, cwid: string) {
    if (busy) return;
    setBusy(true);
    const result = await post(roleKey, "remove", { cwid });
    if (result.ok) {
      setHolders((prev) => ({
        ...prev,
        [roleKey]: (prev[roleKey] ?? []).filter((h) => h.cwid !== cwid),
      }));
    }
    setBusy(false);
    setConfirm(null);
  }

  async function toggleInterim(roleKey: string, cwid: string, interim: boolean) {
    if (busy) return;
    setBusy(true);
    const result = await post(roleKey, "set_interim", { cwid, interim });
    if (result.ok) {
      const holder = result.holder;
      setHolders((prev) => ({
        ...prev,
        [roleKey]: (prev[roleKey] ?? []).map((h) =>
          h.cwid === cwid ? (holder ?? { ...h, interim }) : h,
        ),
      }));
    }
    setBusy(false);
  }

  const confirmRole = confirm ? roleByKey.get(confirm.roleKey) : undefined;
  const confirmTarget =
    confirm && confirmRole
      ? ((holders[confirm.roleKey] ?? []).find((h) => h.cwid === confirm.cwid) ?? null)
      : null;

  return (
    <EditPanel
      slot="center-leadership-card"
      headingId={headingId}
      heading="Leadership"
      description="Appears on the center’s public page, in this order."
    >
      {roles.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          This center has no assignable leadership roles.
        </p>
      ) : (
        <div className="flex flex-col gap-3.5" data-testid="center-leadership-list">
          {rows.length === 0 ? (
            <p
              className="border-apollo-border text-muted-foreground rounded-[10px] border px-3.5 py-3 text-sm"
              data-testid="center-leadership-empty"
            >
              No one holds a leadership role yet.
            </p>
          ) : (
            <ul
              className="border-apollo-border divide-apollo-border divide-y overflow-hidden rounded-[10px] border"
              data-testid="center-leadership-holders"
            >
              {rows.map(({ role, holder: h }) => (
                <li
                  key={`${role.key}-${h.cwid}`}
                  className="grid grid-cols-[34px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-3.5 py-2.5 sm:grid-cols-[34px_minmax(0,1fr)_minmax(0,190px)_auto]"
                  data-testid={`role-holder-${role.key}-${h.cwid}`}
                >
                  <HeadshotAvatar
                    cwid={h.cwid}
                    preferredName={h.name ?? h.cwid}
                    size="roster"
                    className="border-apollo-border-strong size-[34px] border"
                  />
                  <div className="flex min-w-0 flex-col">
                    <ScholarHoverCard cwid={h.cwid}>
                      <span className="w-fit max-w-full truncate text-sm font-[550]">
                        {h.name ?? h.cwid}
                      </span>
                    </ScholarHoverCard>
                    {h.title && (
                      <span className="text-muted-foreground truncate text-[12.5px]">{h.title}</span>
                    )}
                  </div>
                  <div className="col-start-2 row-start-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] sm:col-start-3 sm:row-start-1">
                    <span data-testid={`role-holder-label-${role.key}-${h.cwid}`}>
                      {role.label}
                      {h.interim && <span className="text-apollo-amber"> · interim</span>}
                    </span>
                    <label className="text-muted-foreground flex items-center gap-1.5 text-xs">
                      <Checkbox
                        checked={h.interim}
                        disabled={busy}
                        onCheckedChange={(c) => toggleInterim(role.key, h.cwid, c === true)}
                        aria-label={`Interim ${role.label}`}
                        data-testid={`role-interim-${role.key}-${h.cwid}`}
                      />
                      Interim
                    </label>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => setConfirm({ roleKey: role.key, cwid: h.cwid })}
                    className="text-destructive hover:text-destructive col-start-3 row-start-1 sm:col-start-4"
                    data-testid={`role-remove-${role.key}-${h.cwid}`}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <div
            className="bg-apollo-page border-apollo-border-strong flex flex-wrap items-center gap-2 rounded-[10px] border border-dashed px-3 py-2.5"
            data-testid="center-leadership-add"
          >
            <span className="text-[13px] font-medium">Add</span>
            <div className="min-w-[180px] flex-1">
              <DirectoryPeopleTypeahead
                idPrefix="leadership-add"
                value={adding}
                placeholder="Search people…"
                onChange={(v) => {
                  setAdding(v);
                  if (error) setError(null);
                }}
              />
            </div>
            <label className="text-muted-foreground flex min-w-0 items-center gap-2 text-[13px]">
              as
              <select
                value={addRole}
                onChange={(e) => {
                  setAddRole(e.target.value);
                  if (error) setError(null);
                }}
                disabled={busy}
                aria-label="Leadership role"
                className="border-apollo-border-strong text-foreground h-8 max-w-[16rem] min-w-0 rounded-md border bg-white px-1.5 text-[13.5px]"
                data-testid="leadership-add-role"
              >
                {roles.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-[13px]">
              <Checkbox
                checked={addInterim}
                disabled={busy}
                onCheckedChange={(c) => setAddInterim(c === true)}
                data-testid="leadership-add-interim"
              />
              Interim
            </label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || !adding}
              onClick={addOrReplace}
              className="border-apollo-slate text-apollo-slate"
              data-testid="leadership-add"
            >
              {busy ? "Saving…" : replacing ? "Replace" : "Add"}
            </Button>
          </div>

          <p className="text-muted-foreground text-[12.5px]" data-testid="center-leadership-unfilled">
            {emptyRoles.length > 0
              ? `Not filled: ${emptyRoles.map((r) => r.label).join(", ")}.`
              : "All roles filled."}
          </p>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmTarget !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={`Remove this ${confirmRole?.label.toLowerCase() ?? "leader"}?`}
        description={`This removes ${confirmTarget?.name ?? confirmTarget?.cwid ?? "this person"} from ${confirmRole?.label ?? "this role"} for this center.`}
        reasonMode="none"
        confirmLabel="Remove"
        confirmVariant="destructive"
        onConfirm={() => {
          if (confirm && confirmTarget) return removeHolder(confirm.roleKey, confirmTarget.cwid);
        }}
      />
    </EditPanel>
  );
}

/** The add row's initial role: the first role nobody holds yet, else the first
 *  multi-holder role (a plain "Add"), else the first role. */
function defaultAddRole(roles: ReadonlyArray<Role>): string {
  return (
    roles.find((r) => r.holders.length === 0)?.key ??
    roles.find((r) => !r.singleHolder)?.key ??
    roles[0]?.key ??
    ""
  );
}

function mapErrorToMessage(code: string): string {
  switch (code) {
    case "not_curator":
    case "not_superuser":
    case "not_unit_owner":
      return "You no longer have access to this center. Refresh the page and try again.";
    case "invalid_cwid":
      return "That person couldn't be saved. Please try a different selection.";
    case "holder_not_found":
      return "That person no longer holds this role. Refresh the page and try again.";
    case "role_single_holder_conflict":
      return "Someone else was just assigned this role. Refresh the page and try again.";
    case "role_not_allowed_at_unit":
      return "This role isn't assignable at this center.";
    default:
      return "Something went wrong — your changes weren't saved. Please try again.";
  }
}
