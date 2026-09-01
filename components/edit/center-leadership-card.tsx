/**
 * CenterLeadershipCard — the vocabulary-driven center leadership editor
 * (#2542 Phase C, plan section D3). Follows `CenterProgramCard`'s pattern
 * (`components/edit/center-program-card.tsx`): one section per vocabulary
 * entry, each an immediate POST (no batched save) to
 * `/api/edit/center-leadership`.
 *
 * One section per LEADERSHIP-group role in the center vocabulary (already
 * filtered by the server to `isRoleAllowedAtUnit`-allowed roles, ordered by
 * `sortOrder` — `lib/api/unit-edit-context.ts`'s loader). A `singleHolder`
 * role (`director`) shows at most one holder and "Replace" semantics for
 * swapping them; every other role lists 0..N holders with a plain "Add".
 * Removing a holder goes through `ConfirmDialog` (mirrors
 * `unit-leader-card.tsx`, not `CenterProgramCard`, which has no confirm on
 * its own remove).
 *
 * An "Interim" checkbox sits next to the typeahead so a curator can mark a
 * new (or replacing) holder interim AT add time — it defaults unchecked, and
 * the route defaults `interim` to `false` the same way when the flag isn't
 * sent, so a plain add/replace is never interim by accident. The per-holder
 * "Interim" checkbox on each row (below) stays for toggling it afterward.
 * Every holder rendered — including the one just added or replaced — is
 * exactly what the route's response says was written, never a hardcoded
 * `interim: false` guess.
 *
 * Renders in place of `UnitLeaderCard`'s retired center branch on
 * `/edit/center/[code]` — departments and divisions keep `UnitLeaderCard`
 * unchanged; their leadership is ETL-owned and single-role, so the generic
 * picker would fight the nightly ETL rather than help it.
 *
 * Authz is enforced server-side (Curator/Owner/Superuser of the center); this
 * card is only ever rendered for an actor who already passed that gate.
 */
"use client";

import * as React from "react";

import { ConfirmDialog } from "@/components/edit/confirm-dialog";
import {
  DirectoryPeopleTypeahead,
  type DirectoryValue,
} from "@/components/edit/directory-people-typeahead";
import { EditPanel } from "@/components/edit/edit-panel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

type Holder = {
  cwid: string;
  name: string | null;
  title: string | null;
  interim: boolean;
};

export type CenterLeadershipCardProps = {
  centerCode: string;
  roles: ReadonlyArray<{
    key: string;
    label: string;
    singleHolder: boolean;
    sortOrder: number;
    holders: ReadonlyArray<Holder>;
  }>;
};

export function CenterLeadershipCard({ centerCode, roles }: CenterLeadershipCardProps) {
  return (
    <EditPanel
      slot="center-leadership-card"
      heading="Leadership"
      description="Set each leadership role's holders. These appear on the center's public page."
    >
      {roles.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          This center has no assignable leadership roles.
        </p>
      ) : (
        <div className="flex flex-col gap-6" data-testid="center-leadership-list">
          {roles.map((r) => (
            <RoleEditor key={r.key} centerCode={centerCode} role={r} />
          ))}
        </div>
      )}
    </EditPanel>
  );
}

function RoleEditor({
  centerCode,
  role,
}: {
  centerCode: string;
  role: CenterLeadershipCardProps["roles"][number];
}) {
  const [holders, setHolders] = React.useState<Holder[]>(() => [...role.holders]);
  const [adding, setAdding] = React.useState<DirectoryValue | null>(null);
  const [addInterim, setAddInterim] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmCwid, setConfirmCwid] = React.useState<string | null>(null);

  const hasHolder = holders.length > 0;
  // A singleHolder role with an existing holder swaps via "Replace", never a
  // second plain "Add" (that would 409 server-side anyway) — the typeahead
  // stays available so a curator can pick the replacement without removing
  // the incumbent first.
  const addLabel = role.singleHolder && hasHolder ? "Replace" : "Add";

  async function post(
    action: "add" | "remove" | "set_interim",
    payload: Record<string, unknown>,
  ): Promise<{ ok: boolean; replacedCwid?: string | null; holder?: Holder }> {
    setError(null);
    try {
      const res = await fetch("/api/edit/center-leadership", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ centerCode, roleKey: role.key, action, ...payload }),
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
    if (!adding || busy) return;
    if (holders.some((h) => h.cwid === adding.cwid)) {
      setError("That person already holds this role.");
      return;
    }
    setBusy(true);
    const replace = role.singleHolder && hasHolder;
    const result = await post("add", {
      cwid: adding.cwid,
      ...(replace ? { replace: true } : {}),
      ...(addInterim ? { interim: true } : {}),
    });
    if (result.ok) {
      // Render exactly what the route wrote back — never assume `interim`
      // client-side (a replacement holder is not interim unless requested;
      // the route is the source of truth for what actually landed).
      const holder: Holder = result.holder ?? {
        cwid: adding.cwid,
        name: adding.name,
        title: adding.title,
        interim: false,
      };
      setHolders((prev) => {
        const withoutReplaced = result.replacedCwid
          ? prev.filter((h) => h.cwid !== result.replacedCwid)
          : prev;
        return [...withoutReplaced.filter((h) => h.cwid !== holder.cwid), holder];
      });
      setAdding(null);
      setAddInterim(false);
    }
    setBusy(false);
  }

  async function removeHolder(cwid: string) {
    if (busy) return;
    setBusy(true);
    const result = await post("remove", { cwid });
    if (result.ok) setHolders((prev) => prev.filter((h) => h.cwid !== cwid));
    setBusy(false);
    setConfirmCwid(null);
  }

  async function toggleInterim(cwid: string, interim: boolean) {
    if (busy) return;
    setBusy(true);
    const result = await post("set_interim", { cwid, interim });
    if (result.ok) {
      const holder = result.holder;
      setHolders((prev) =>
        prev.map((h) => (h.cwid === cwid ? (holder ?? { ...h, interim }) : h)),
      );
    }
    setBusy(false);
  }

  const confirmTarget = holders.find((h) => h.cwid === confirmCwid) ?? null;

  return (
    <section
      className="border-apollo-border flex flex-col gap-3 rounded-md border p-4"
      data-testid={`role-editor-${role.key}`}
    >
      <h3 className="text-base font-medium">{role.label}</h3>

      {!hasHolder ? (
        <p className="text-muted-foreground text-sm">No {role.label.toLowerCase()} set.</p>
      ) : (
        <ul className="flex flex-col gap-1" data-testid={`role-holders-${role.key}`}>
          {holders.map((h) => (
            <li
              key={h.cwid}
              className="bg-apollo-surface-2 flex items-center gap-2 rounded-md px-3 py-2"
              data-testid={`role-holder-${role.key}-${h.cwid}`}
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">{h.name ?? h.cwid}</span>
                {h.title && <span className="text-muted-foreground truncate text-xs">{h.title}</span>}
              </div>
              <label className="flex items-center gap-1.5 text-xs">
                <Checkbox
                  checked={h.interim}
                  disabled={busy}
                  onCheckedChange={(c) => toggleInterim(h.cwid, c === true)}
                  data-testid={`role-interim-${role.key}-${h.cwid}`}
                />
                Interim
              </label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => setConfirmCwid(h.cwid)}
                data-testid={`role-remove-${role.key}-${h.cwid}`}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-end gap-2">
        <div className="flex-1">
          <DirectoryPeopleTypeahead
            idPrefix={`role-${role.key}`}
            value={adding}
            placeholder={`Search for a ${role.label.toLowerCase()}…`}
            onChange={(v) => {
              setAdding(v);
              if (error) setError(null);
            }}
          />
        </div>
        <label className="flex items-center gap-1.5 pb-2 text-xs whitespace-nowrap">
          <Checkbox
            checked={addInterim}
            disabled={busy}
            onCheckedChange={(c) => setAddInterim(c === true)}
            data-testid={`role-add-interim-${role.key}`}
          />
          Interim
        </label>
        <Button
          type="button"
          variant="outline"
          disabled={busy || !adding}
          onClick={addOrReplace}
          data-testid={`role-add-${role.key}`}
        >
          {busy ? "Saving…" : addLabel}
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <ConfirmDialog
        open={confirmTarget !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmCwid(null);
        }}
        title={`Remove this ${role.label.toLowerCase()}?`}
        description={`This removes ${confirmTarget?.name ?? confirmTarget?.cwid ?? "this person"} from ${role.label} for this center.`}
        reasonMode="none"
        confirmLabel="Remove"
        confirmVariant="destructive"
        onConfirm={() => {
          if (confirmTarget) return removeHolder(confirmTarget.cwid);
        }}
      />
    </section>
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
