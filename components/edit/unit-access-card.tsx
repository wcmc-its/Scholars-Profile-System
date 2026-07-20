/**
 * UnitAccessCard — the unit access-management panel (#540 Phase 7,
 * `unit-curation-edit-ui-spec.md` § 4). Lists the unit's `unit_admin` rows and
 * lets an Owner/Superuser grant or revoke Owner/Curator. POSTs `/api/edit/grant`
 * (`{ entityType, entityId, cwid, role, action }`).
 *
 * Grantees are often administrative staff with no Scholar profile, so the
 * server-side context can only supply the CWID for those rows. The card
 * re-resolves names client-side via `/api/directory/people?cwids=…`.
 *
 * Self-revoke guard: the row matching the acting session's CWID has a disabled
 * Remove (the Superuser is the backstop, but a self-revoke would lock the actor
 * out of this very surface — mirrors the `/api/edit/grant` T7 guard). Per the
 * SPEC there is deliberately no last-Owner guard.
 *
 * ED-locked guard (#728 § 2.2 #3 / § 5 MUST-7): a row sourced from the nightly
 * Web Directory (Enterprise Directory) import — `source` LIKE `ED:%` — is
 * read-only here for EVERYONE (superusers included); the role is changed at the
 * source, not here. The `/api/edit/grant` route enforces this server-side and
 * returns `ed_locked`; we mirror it by disabling Remove on those rows.
 */
"use client";

import * as React from "react";
import { Lock } from "lucide-react";

import { ConfirmDialog } from "@/components/edit/confirm-dialog";
import {
  DirectoryPeopleTypeahead,
  type DirectoryValue,
} from "@/components/edit/directory-people-typeahead";
import { EditPanel } from "@/components/edit/edit-panel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

type AccessRow = {
  cwid: string;
  name: string;
  title: string | null;
  role: "owner" | "curator";
  grantedBy: string | null;
  grantedAt: Date;
  /** Provenance (#728): "manual" for human grants; "ED:…" for Web Directory
   *  (Enterprise Directory) imports. ED-sourced rows are read-only here. */
  source?: string;
};

/** Whether a row is owned by the ED import and so can't be removed in this UI —
 *  mirrors the `/api/edit/grant` server gate (`source` LIKE `ED:%`). */
function isEdLocked(row: AccessRow): boolean {
  return row.source?.startsWith("ED:") ?? false;
}

const ED_LOCKED_HINT =
  "This access is managed in the Enterprise Directory and can't be removed here.";

export type UnitAccessCardProps = {
  entityType: "department" | "division" | "center";
  entityId: string;
  access: ReadonlyArray<AccessRow> | null;
  actorCwid: string;
};

const CASCADE_HINT: Record<UnitAccessCardProps["entityType"], string | null> = {
  department: "An Owner or Curator here covers this department and its divisions.",
  division: "An Owner or Curator here covers only this division.",
  center: null,
};

export function UnitAccessCard({ entityType, entityId, access, actorCwid }: UnitAccessCardProps) {
  // Defensive: the rail only mounts this panel for Owner/Superuser, where
  // `access` is non-null. A null slips through ⇒ render nothing.
  const [rows, setRows] = React.useState<AccessRow[]>(access ? [...access] : []);
  const [names, setNames] = React.useState<Map<string, { name: string; title: string | null }>>(
    new Map(),
  );
  const [addValue, setAddValue] = React.useState<DirectoryValue | null>(null);
  const [addRole, setAddRole] = React.useState<"owner" | "curator">("curator");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = React.useState<AccessRow | null>(null);

  // Hydrate display names for grantees the server couldn't resolve (a unit
  // admin with no Scholar row shows up with `name === cwid`).
  const unresolved = rows.filter((r) => r.name === r.cwid).map((r) => r.cwid);
  const unresolvedKey = unresolved.join(",");
  React.useEffect(() => {
    if (unresolvedKey.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/directory/people?cwids=${encodeURIComponent(unresolvedKey)}`);
        const data = (await res.json()) as
          | { ok: true; people: Array<{ cwid: string; name: string; title: string | null }> }
          | { ok: false };
        if (cancelled || !res.ok || data.ok !== true) return;
        setNames((prev) => {
          const next = new Map(prev);
          for (const p of data.people) next.set(p.cwid, { name: p.name, title: p.title });
          return next;
        });
      } catch {
        // Degraded: the table keeps showing CWIDs. Not an error state.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [unresolvedKey]);

  if (access === null) return null;

  function displayName(row: AccessRow): { name: string; title: string | null } {
    if (row.name !== row.cwid) return { name: row.name, title: row.title };
    return names.get(row.cwid) ?? { name: row.cwid, title: row.title };
  }

  async function grant() {
    if (!addValue || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/edit/grant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entityType,
          entityId,
          cwid: addValue.cwid,
          role: addRole,
          action: "grant",
        }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || data.ok !== true) {
        setError(mapErrorToMessage(data.error ?? ""));
        return;
      }
      setRows((prev) => {
        const without = prev.filter((r) => r.cwid !== addValue.cwid);
        return [
          ...without,
          {
            cwid: addValue.cwid,
            name: addValue.name,
            title: addValue.title,
            role: addRole,
            grantedBy: actorCwid,
            grantedAt: new Date(0), // placeholder; refreshed on next page load
          },
        ];
      });
      setAddValue(null);
      setAddRole("curator");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(row: AccessRow) {
    setError(null);
    const res = await fetch("/api/edit/grant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entityType,
        entityId,
        cwid: row.cwid,
        role: row.role,
        action: "revoke",
      }),
    });
    const data = (await res.json()) as { ok: boolean; error?: string };
    if (!res.ok || data.ok !== true) {
      setError(mapErrorToMessage(data.error ?? ""));
      throw new Error("revoke_failed");
    }
    setRows((prev) => prev.filter((r) => r.cwid !== row.cwid));
    setRevokeTarget(null);
  }

  const hint = CASCADE_HINT[entityType];

  return (
    <EditPanel
      slot="unit-access-card"
      heading="Access"
      description={`Owners and Curators can edit this ${entityType}. Only Owners can manage access.`}
    >
      <div className="flex flex-col gap-4">
        {hint && <p className="text-muted-foreground text-sm">{hint}</p>}

        {rows.length === 0 ? (
          <p className="text-muted-foreground text-sm" data-testid="unit-access-empty">
            No one has been granted access yet.
          </p>
        ) : (
          <table className="w-full text-sm" data-testid="unit-access-table">
            <thead>
              <tr className="text-muted-foreground border-apollo-border border-b text-left">
                <th className="py-2 font-medium">Person</th>
                <th className="py-2 font-medium">Role</th>
                <th className="py-2 font-medium">Granted by</th>
                <th className="py-2 font-medium">Granted on</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const isSelf = row.cwid === actorCwid;
                const edLocked = isEdLocked(row);
                const removeTitle = isSelf
                  ? "You can't remove your own access."
                  : edLocked
                    ? ED_LOCKED_HINT
                    : undefined;
                const shown = displayName(row);
                return (
                  <tr key={row.cwid} className="border-apollo-border border-b" data-testid={`unit-access-row-${row.cwid}`}>
                    <td className="py-2">
                      <span className="font-medium">{shown.name}</span>
                      {shown.title && <span className="text-muted-foreground"> · {shown.title}</span>}
                    </td>
                    <td className="py-2 capitalize">{row.role}</td>
                    <td className="py-2">{formatGrantedBy(row.grantedBy)}</td>
                    <td className="py-2 tabular-nums">{formatGrantedAt(row.grantedAt)}</td>
                    <td className="py-2 text-right">
                      {/* The Button carries `disabled:pointer-events-none`, so `title` on a
                          disabled Remove never fires and the row reads as broken rather than
                          governed. ED-locked rows say so in the open, LOCKED-style: neutral +
                          lock + text, no hue. `title` stays for the self-removal case. */}
                      <div className="flex items-center justify-end gap-2">
                        {edLocked && (
                          <span
                            className="text-muted-foreground inline-flex items-center gap-1 text-xs whitespace-nowrap"
                            data-testid={`unit-access-ed-locked-note-${row.cwid}`}
                          >
                            <Lock className="size-3" aria-hidden />
                            Managed in the Enterprise Directory
                          </span>
                        )}
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={isSelf || edLocked || busy}
                          title={removeTitle}
                          onClick={() => setRevokeTarget(row)}
                          data-testid={`unit-access-remove-${row.cwid}`}
                        >
                          Remove
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <div className="border-apollo-border flex flex-col gap-3 rounded-md border p-4" data-slot="unit-access-add">
          <p className="text-sm font-medium">Add admin</p>
          <DirectoryPeopleTypeahead idPrefix="grant" value={addValue} onChange={setAddValue} />
          <RadioGroup
            value={addRole}
            onValueChange={(v) => setAddRole(v as "owner" | "curator")}
            className="flex gap-4"
          >
            <label className="flex items-center gap-2 text-sm">
              <RadioGroupItem value="curator" data-testid="grant-role-curator" /> Curator
            </label>
            <label className="flex items-center gap-2 text-sm">
              <RadioGroupItem value="owner" data-testid="grant-role-owner" /> Owner
            </label>
          </RadioGroup>
          <div>
            <Button type="button" variant="apollo" onClick={grant} disabled={!addValue || busy} data-testid="unit-access-grant">
              {busy ? "Granting…" : "Grant access"}
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
        open={revokeTarget !== null}
        onOpenChange={(open) => !open && setRevokeTarget(null)}
        title="Remove this person's access?"
        description="They will no longer be able to edit this unit. You can grant access again later."
        reasonMode="none"
        confirmLabel="Remove"
        confirmVariant="destructive"
        onConfirm={() => (revokeTarget ? revoke(revokeTarget) : Promise.resolve())}
      />
    </EditPanel>
  );
}

/** The ED import stamps a synthetic non-CWID actor (`GRANTED_BY = "ED-ETL"`,
 *  etl/ed-admins/index.ts) — show its human name. Real CWIDs pass through. */
function formatGrantedBy(grantedBy: string | null): string {
  if (grantedBy === "ED-ETL") return "Web Directory";
  return grantedBy ?? "—";
}

function formatGrantedAt(d: Date): string {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime()) || date.getTime() === 0) return "—";
  return date.toISOString().slice(0, 10);
}

function mapErrorToMessage(code: string): string {
  switch (code) {
    case "scope_violation":
    case "authority_violation":
    case "not_unit_owner":
      return "You don't have permission to manage access for this unit.";
    case "cannot_revoke_self":
      return "You can't remove your own access.";
    case "ed_locked":
      return ED_LOCKED_HINT;
    case "invalid_cwid":
      return "That person couldn't be found. Try a different search.";
    default:
      return "Something went wrong — please try again.";
  }
}
