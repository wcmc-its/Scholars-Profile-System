/**
 * ProxyEditorCard — the scholar-assigned proxy management panel (#779 /
 * scholar-proxy-spec.md § API and UI). Lists the scholar's `scholar_proxy`
 * grants and lets the scholar (self mode) or a superuser (admin mode) add or
 * remove a proxy editor. POSTs `/api/edit/proxy`
 * (`{ scholarCwid, proxyCwid, action }`).
 *
 * A proxy is by design NOT a Scholar (they hold no other role — D3), so the
 * server context supplies only the CWID; the card re-resolves names client-side
 * via `/api/directory/people?cwids=…` (mirrors `UnitAccessCard`). A proxy can
 * never reach this panel — it is rendered only in self / superuser mode (CD-2).
 *
 * Visual polish is shared with the rest of the Apollo console; this is the
 * functional v1 (the spec's UI-SPEC deliverable refines layout/copy).
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

export type ProxyRow = {
  proxyCwid: string;
  grantedBy: string | null;
  grantedAt: Date;
};

export type ProxyEditorCardProps = {
  /** The scholar whose proxy list this is. */
  scholarCwid: string;
  /** The scholar's preferred name — for the panel copy. */
  scholarName: string;
  /** Whether the acting viewer is the scholar themselves (self mode) or a
   *  superuser (admin mode) — only the copy differs; both POST the same route. */
  mode: "self" | "superuser";
  /** Current grants. `null` ⇒ render nothing (defensive; the rail only mounts
   *  this in self/superuser mode). */
  proxies: ReadonlyArray<ProxyRow> | null;
};

export function ProxyEditorCard({ scholarCwid, scholarName, mode, proxies }: ProxyEditorCardProps) {
  const [rows, setRows] = React.useState<ProxyRow[]>(proxies ? [...proxies] : []);
  const [names, setNames] = React.useState<Map<string, { name: string; title: string | null }>>(
    new Map(),
  );
  const [addValue, setAddValue] = React.useState<DirectoryValue | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = React.useState<ProxyRow | null>(null);

  // Hydrate display names — a proxy has no Scholar row, so the server only knows
  // the CWID. Best-effort: a directory hiccup leaves the table showing CWIDs.
  const toResolve = rows.map((r) => r.proxyCwid).filter((c) => !names.has(c));
  const toResolveKey = toResolve.join(",");
  React.useEffect(() => {
    if (toResolveKey.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/directory/people?cwids=${encodeURIComponent(toResolveKey)}`);
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
        /* degraded — keep showing CWIDs */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [toResolveKey]);

  if (proxies === null) return null;

  function shownFor(cwid: string): { name: string; title: string | null } {
    return names.get(cwid) ?? { name: cwid, title: null };
  }

  async function grant() {
    if (!addValue || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/edit/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scholarCwid, proxyCwid: addValue.cwid, action: "grant" }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || data.ok !== true) {
        setError(mapErrorToMessage(data.error ?? ""));
        return;
      }
      const picked = addValue;
      setNames((prev) => new Map(prev).set(picked.cwid, { name: picked.name, title: picked.title }));
      setRows((prev) => [
        ...prev.filter((r) => r.proxyCwid !== picked.cwid),
        { proxyCwid: picked.cwid, grantedBy: null, grantedAt: new Date(0) },
      ]);
      setAddValue(null);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(row: ProxyRow) {
    setError(null);
    const res = await fetch("/api/edit/proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scholarCwid, proxyCwid: row.proxyCwid, action: "revoke" }),
    });
    const data = (await res.json()) as { ok: boolean; error?: string };
    if (!res.ok || data.ok !== true) {
      setError(mapErrorToMessage(data.error ?? ""));
      throw new Error("revoke_failed");
    }
    setRows((prev) => prev.filter((r) => r.proxyCwid !== row.proxyCwid));
    setRevokeTarget(null);
  }

  const description =
    mode === "self"
      ? "People you authorize to edit your profile overview and hide misattributed publications on your behalf. They can't change anything else, and you can remove them at any time."
      : `People authorized to edit ${scholarName}'s profile overview and hide misattributed publications on their behalf.`;

  return (
    <EditPanel slot="proxy-editor-card" heading="Proxy editors" description={description}>
      <div className="flex flex-col gap-4">
        {rows.length === 0 ? (
          <p className="text-muted-foreground text-sm" data-testid="proxy-editor-empty">
            No proxy editors yet.
          </p>
        ) : (
          <table className="w-full text-sm" data-testid="proxy-editor-table">
            <thead>
              <tr className="text-muted-foreground border-apollo-border border-b text-left">
                <th className="py-2 font-medium">Person</th>
                <th className="py-2 font-medium">Added on</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const shown = shownFor(row.proxyCwid);
                return (
                  <tr
                    key={row.proxyCwid}
                    className="border-apollo-border border-b"
                    data-testid={`proxy-editor-row-${row.proxyCwid}`}
                  >
                    <td className="py-2">
                      <span className="font-medium">{shown.name}</span>
                      {shown.title && <span className="text-muted-foreground"> · {shown.title}</span>}
                    </td>
                    <td className="py-2 tabular-nums">{formatGrantedAt(row.grantedAt)}</td>
                    <td className="py-2 text-right">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => setRevokeTarget(row)}
                        data-testid={`proxy-editor-remove-${row.proxyCwid}`}
                      >
                        Remove
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <div
          className="border-apollo-border flex flex-col gap-3 rounded-md border p-4"
          data-slot="proxy-editor-add"
        >
          <p className="text-sm font-medium">Add a proxy editor</p>
          <p className="text-muted-foreground text-sm">
            Search the WCM directory by name. The person you choose must not already be a scholar,
            an org-unit administrator, or a Scholars administrator.
          </p>
          <DirectoryPeopleTypeahead idPrefix="proxy" value={addValue} onChange={setAddValue} />
          <div>
            <Button
              type="button"
              variant="apollo"
              onClick={grant}
              disabled={!addValue || busy}
              data-testid="proxy-editor-grant"
            >
              {busy ? "Adding…" : "Add proxy editor"}
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
        title="Remove this proxy editor?"
        description="They will no longer be able to edit this profile. You can add them again later."
        reasonMode="none"
        confirmLabel="Remove"
        confirmVariant="destructive"
        onConfirm={() => (revokeTarget ? revoke(revokeTarget) : Promise.resolve())}
      />
    </EditPanel>
  );
}

function formatGrantedAt(d: Date): string {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime()) || date.getTime() === 0) return "—";
  return date.toISOString().slice(0, 10);
}

function mapErrorToMessage(code: string): string {
  switch (code) {
    case "proxy_ineligible":
      return "That person already has a role in the system (scholar, org-unit admin, or administrator), so they can't be a proxy editor.";
    case "cannot_proxy_self":
      return "A scholar can't be their own proxy editor.";
    case "proxy_limit_reached":
      return "This profile already has the maximum number of proxy editors.";
    case "scholar_not_found":
      return "This profile isn't available.";
    case "not_self":
      return "You don't have permission to manage proxy editors here.";
    case "impersonation_block":
      return "You can't manage proxy editors while viewing as another user.";
    case "invalid_cwid":
      return "That person couldn't be found. Try a different search.";
    default:
      return "Something went wrong — please try again.";
  }
}
