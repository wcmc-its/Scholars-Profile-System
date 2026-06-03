/**
 * AdministratorsRoster — the Administrators-tab body (#728 Phase B + C,
 * `ed-admin-org-unit-roles-spec.md` § 4.2/§ 4.3/§ 4.4). One card per person,
 * each listing the org units they manage (name + kind badge), the role, the
 * grant provenance (`UnitAdmin.source`), and — Phase C — per-row write controls
 * (update-role + Revoke) plus a per-card Add-admin form, all routed through the
 * existing `POST /api/edit/grant`.
 *
 * ED-locked rows (`source` LIKE 'ED:%') are owned by the nightly Enterprise
 * Directory import: for a non-superuser the role/Revoke controls render DISABLED
 * with an inline caveat note (the affordance matches the route's `ed_locked`
 * gate — a disabled control, not a click-then-403). A superuser sees the
 * controls ENABLED but with the same caveat (their override is re-asserted on
 * the next ETL run). § 4.4.
 *
 * Client component: on mount it batch-fetches the Enterprise Directory once via
 * `GET /api/directory/people?cwids=…` to enrich each person with first/last name,
 * primary title, and email — mirroring how `unit-access-card.tsx` hydrates
 * grantee names. LDAP is unreachable in deployed envs until #443, so this fetch
 * is the ONLY directory access and it must never throw: a 503 / network failure
 * just falls back to the server-provided Scholar name + the #443 note.
 */
"use client";

import * as React from "react";
import { Lock } from "lucide-react";

import {
  AddAdministratorDialog,
  type AddAdminUnit,
} from "@/components/edit/add-administrator-dialog";
import { ConfirmDialog } from "@/components/edit/confirm-dialog";
import type { DirectoryValue } from "@/components/edit/directory-people-typeahead";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { AdminRosterEntry, AdminRosterGrant } from "@/lib/api/administrators-roster";
import type { DirectoryPerson } from "@/lib/sources/ldap";

/** The provenance badge color treatment, keyed on `UnitAdmin.source`. The label
 *  is the human-readable string; `className` is the per-source palette. */
function provenanceBadge(source: string): { label: string; className: string } {
  switch (source) {
    case "manual":
      return { label: "Manual", className: "bg-slate-100 text-slate-700 ring-slate-200" };
    case "ED:DA":
      return {
        label: "Department Administrator",
        className: "bg-blue-50 text-blue-800 ring-blue-200",
      };
    case "ED:DivA":
      return {
        label: "Division Administrator",
        className: "bg-teal-50 text-teal-700 ring-teal-200",
      };
    case "ED:IAMDELA":
      return { label: "IAMDELA", className: "bg-amber-50 text-amber-800 ring-amber-200" };
    case "ED:DivA-IAMDELA":
      return {
        label: "DivA-IAMDELA",
        className: "bg-violet-50 text-violet-700 ring-violet-200",
      };
    default:
      // Unknown future source: show it verbatim in a neutral badge rather than
      // swallow it.
      return { label: source, className: "bg-slate-100 text-slate-700 ring-slate-200" };
  }
}

/** True ⇒ the row is owned by the Enterprise Directory import (§ 4.4). */
function isEdSourced(source: string): boolean {
  return source.startsWith("ED:");
}

const KIND_LABEL: Record<AdminRosterGrant["entityType"], string> = {
  department: "Department",
  division: "Division",
  center: "Center",
};

const PROVENANCE_BADGE_BASE =
  "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1";

/** The caveat shown beside ED-locked controls (§ 4.4). */
const ED_LOCKED_NOTE =
  "Managed through the Web Directory. This grant is read-only here; the role is set at the source and restored on the next sync.";

export type AdministratorsRosterProps = {
  entries: ReadonlyArray<AdminRosterEntry>;
  /** True ⇒ "Showing all administrators" (superuser); false ⇒ Owner-scoped. */
  isSuperuser: boolean;
  /** The acting (effective) CWID — drives the self-revoke disable + grantedBy attribution. */
  actorCwid: string;
  /**
   * Server-side hint that at least one grantee was unresolved by the Scholar
   * lookup. After client-side directory enrichment we RECOMPUTE the note from
   * the resolved state, so this only seeds the initial render before the
   * directory fetch settles.
   */
  nameResolutionDegraded: boolean;
};

/** A person's enriched display fields, in the resolved precedence order. */
type ResolvedPerson = {
  /** Display name; equals the bare CWID when nothing resolved it. */
  name: string;
  title: string | null;
  email: string | null;
  /** True when neither the directory nor the Scholar table supplied a name. */
  isBareCwid: boolean;
};

export function AdministratorsRoster({
  entries,
  isSuperuser,
  actorCwid,
  nameResolutionDegraded,
}: AdministratorsRosterProps) {
  // Directory rows keyed by CWID; empty until (and unless) the fetch succeeds.
  const [directory, setDirectory] = React.useState<Map<string, DirectoryPerson>>(new Map());
  // null = not yet attempted; true/false = the fetch settled with this outcome.
  // A failed/unreachable fetch (`fetchOk === false`) means we trust the
  // server-provided `nameResolutionDegraded` seed instead of the recomputed one.
  const [fetchOk, setFetchOk] = React.useState<boolean | null>(null);

  // Mutable roster: Phase-C writes (grant / update-role / revoke) update this
  // optimistically. Keyed by `${cwid}` → that person's grant rows.
  const [roster, setRoster] = React.useState<AdminRosterEntry[]>(() =>
    entries.map((e) => ({ ...e, grants: [...e.grants] })),
  );

  // Per-card write state.
  const [busyKey, setBusyKey] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  // The grant the user is confirming a revoke for, or null.
  const [revokeTarget, setRevokeTarget] = React.useState<{
    cwid: string;
    grant: AdminRosterGrant;
  } | null>(null);

  const cwidKey = React.useMemo(
    () => [...new Set(roster.map((e) => e.cwid))].join(","),
    [roster],
  );

  React.useEffect(() => {
    if (cwidKey.length === 0) return;
    const controller = new AbortController();
    (async () => {
      const cwids = cwidKey.split(",");
      // The directory API caps each request at 50 CWIDs (route MAX_CWIDS), so a
      // roster of N people must be fetched in chunks and merged.
      const CHUNK = 50;
      const batches: string[][] = [];
      for (let i = 0; i < cwids.length; i += CHUNK) batches.push(cwids.slice(i, i + CHUNK));
      try {
        const perBatch = await Promise.all(
          batches.map(async (batch) => {
            const res = await fetch(
              `/api/directory/people?cwids=${encodeURIComponent(batch.join(","))}`,
              { signal: controller.signal },
            );
            const data = (await res.json()) as
              | { ok: true; people: DirectoryPerson[] }
              | { ok: false };
            if (!res.ok || data.ok !== true) throw new Error("directory_fetch_failed");
            return data.people;
          }),
        );
        const next = new Map<string, DirectoryPerson>();
        for (const people of perBatch) for (const p of people) next.set(p.cwid, p);
        setDirectory(next);
        setFetchOk(true);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        // Degraded: keep the server names; the note falls back to the seed.
        setFetchOk(false);
      }
    })();
    return () => controller.abort();
  }, [cwidKey]);

  function resolve(entry: AdminRosterEntry): ResolvedPerson {
    const dir = directory.get(entry.cwid);
    // Name: directory "First Last" (or directory display name) → server name → CWID.
    const dirName =
      dir &&
      (dir.firstName || dir.lastName
        ? [dir.firstName, dir.lastName].filter(Boolean).join(" ").trim()
        : dir.name && dir.name !== entry.cwid
          ? dir.name
          : null);
    const serverName = entry.name && entry.name !== entry.cwid ? entry.name : null;
    const name = dirName || serverName || entry.cwid;
    // Title: directory → server → nothing.
    const title = dir?.title ?? entry.title ?? null;
    // Email: directory → nothing.
    const email = dir?.email ?? null;
    return { name, title, email, isBareCwid: name === entry.cwid };
  }

  const resolved = roster.map((e) => ({ entry: e, person: resolve(e) }));

  // Recompute the #443 note from the post-enrichment state. If the directory
  // fetch failed entirely, trust the server's seed instead of the (un-enriched)
  // recomputed value so a transient 503 doesn't hide the note prematurely.
  const anyBareCwid = resolved.some((r) => r.person.isBareCwid);
  const showDegradedNote = fetchOk === false ? nameResolutionDegraded : anyBareCwid;

  const scopeCaption = isSuperuser
    ? "Showing all administrators."
    : "Showing administrators within the units you own.";

  // ── Phase C writes (all POST /api/edit/grant) ──────────────────────────────

  /** Re-grant a row's `(unit, cwid)` with a new role (idempotent upsert). */
  async function updateRole(cwid: string, grant: AdminRosterGrant, nextRole: "owner" | "curator") {
    if (busyKey) return;
    const key = `${cwid}:${grant.entityType}:${grant.entityId}`;
    setBusyKey(key);
    setError(null);
    try {
      const res = await fetch("/api/edit/grant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entityType: grant.entityType,
          entityId: grant.entityId,
          cwid,
          role: nextRole,
          action: "grant",
        }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || data.ok !== true) {
        setError(mapErrorToMessage(data.error ?? ""));
        return;
      }
      setRoster((prev) =>
        prev.map((e) =>
          e.cwid === cwid
            ? {
                ...e,
                grants: e.grants.map((g) =>
                  g.entityType === grant.entityType && g.entityId === grant.entityId
                    ? { ...g, role: nextRole }
                    : g,
                ),
              }
            : e,
        ),
      );
    } finally {
      setBusyKey(null);
    }
  }

  /** Hard-delete a grant row, then drop it from the optimistic roster. */
  async function revoke(cwid: string, grant: AdminRosterGrant) {
    setError(null);
    const res = await fetch("/api/edit/grant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entityType: grant.entityType,
        entityId: grant.entityId,
        cwid,
        role: grant.role,
        action: "revoke",
      }),
    });
    const data = (await res.json()) as { ok: boolean; error?: string };
    if (!res.ok || data.ok !== true) {
      setError(mapErrorToMessage(data.error ?? ""));
      throw new Error("revoke_failed");
    }
    setRoster((prev) =>
      prev.map((e) =>
        e.cwid === cwid
          ? {
              ...e,
              grants: e.grants.filter(
                (g) => !(g.entityType === grant.entityType && g.entityId === grant.entityId),
              ),
            }
          : e,
      ),
    );
    setRevokeTarget(null);
  }

  /**
   * Upsert a just-granted admin into the roster (called by the page-level Add
   * dialog after a successful `POST /api/edit/grant`). Updates the matching unit
   * grant on an existing person, or adds a new person card whose name the
   * directory effect then enriches.
   */
  function handleGranted(grantee: DirectoryValue, grant: AdminRosterGrant) {
    setError(null);
    setRoster((prev) => {
      if (prev.some((e) => e.cwid === grantee.cwid)) {
        return prev.map((e) =>
          e.cwid === grantee.cwid
            ? {
                ...e,
                grants: [
                  ...e.grants.filter(
                    (g) => !(g.entityType === grant.entityType && g.entityId === grant.entityId),
                  ),
                  grant,
                ],
              }
            : e,
        );
      }
      const hasName = Boolean(grantee.name && grantee.name !== grantee.cwid);
      return [
        ...prev,
        {
          cwid: grantee.cwid,
          name: hasName ? grantee.name : grantee.cwid,
          title: grantee.title ?? null,
          nameResolved: hasName,
          grants: [grant],
        },
      ];
    });
  }

  return (
    <div className="flex flex-col gap-4" data-slot="administrators-roster">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm" data-testid="administrators-scope-caption">
          {scopeCaption}
        </p>
        <AddAdministratorDialog units={unitOptions(roster)} onGranted={handleGranted} />
      </div>

      {showDegradedNote && (
        <p className="text-muted-foreground text-sm" data-testid="administrators-name-degraded-note">
          Some names resolve from the Web Directory and are unavailable until directory routing
          (#443) lands; unit scope, role, and provenance below are accurate.
        </p>
      )}

      {error && (
        <Alert variant="destructive" data-testid="administrators-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {roster.length === 0 ? (
        <p className="text-muted-foreground text-sm" data-testid="administrators-empty">
          {isSuperuser ? "No administrators yet." : "No administrators within your units."}
        </p>
      ) : (
        resolved.map(({ entry, person }) => {
          const isSelf = entry.cwid === actorCwid;
          return (
            <Card
              key={entry.cwid}
              className="border-l-2 border-apollo-maroon/60"
              data-testid={`administrators-card-${entry.cwid}`}
            >
              <CardHeader>
                <CardTitle className="text-base">
                  <span className="font-medium">{person.name}</span>
                  {person.title && (
                    <span className="text-muted-foreground font-normal"> · {person.title}</span>
                  )}
                  <span className="text-muted-foreground ml-2 text-xs font-normal tabular-nums">
                    {entry.cwid}
                  </span>
                </CardTitle>
                {person.email && (
                  <a
                    href={`mailto:${person.email}`}
                    className="text-muted-foreground text-xs hover:underline"
                    data-testid={`administrators-email-${entry.cwid}`}
                  >
                    {person.email}
                  </a>
                )}
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <table
                  className="w-full text-sm"
                  data-testid={`administrators-grants-${entry.cwid}`}
                >
                  <thead>
                    <tr className="text-muted-foreground border-border border-b text-left">
                      <th className="py-2 font-medium">Org unit</th>
                      <th className="py-2 pl-6 font-medium whitespace-nowrap">Role</th>
                      <th className="py-2 pl-6 font-medium whitespace-nowrap">Source</th>
                      <th className="py-2 pl-6 text-right font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entry.grants.map((grant) => {
                      const prov = provenanceBadge(grant.source);
                      const edLocked = isEdSourced(grant.source);
                      // ED-sourced rows are read-only for EVERYONE (matches the
                      // route's `ed_locked` gate) — they're managed in the Web
                      // Directory, so a local change would just be re-synced.
                      const controlsDisabled = edLocked;
                      const rowKey = `${grant.entityType}:${grant.entityId}`;
                      const busy = busyKey === `${entry.cwid}:${rowKey}`;
                      const revokeDisabled = controlsDisabled || isSelf || busy;
                      return (
                        <tr
                          key={rowKey}
                          className="border-border border-b align-top"
                          data-testid={`administrators-grant-${entry.cwid}-${grant.entityType}-${grant.entityId}`}
                        >
                          <td className="py-2">
                            <span className="font-medium">{grant.unitName}</span>
                            <Badge variant="secondary" className="ml-2">
                              {KIND_LABEL[grant.entityType]}
                            </Badge>
                          </td>
                          <td className="py-2 pl-6">
                            <RadioGroup
                              value={grant.role}
                              onValueChange={(v) =>
                                updateRole(entry.cwid, grant, v as "owner" | "curator")
                              }
                              disabled={controlsDisabled || busy}
                              className="flex gap-3"
                              data-testid={`administrators-role-${entry.cwid}-${grant.entityType}-${grant.entityId}`}
                            >
                              <label className="flex items-center gap-1.5 text-xs">
                                <RadioGroupItem
                                  value="curator"
                                  data-testid={`administrators-role-curator-${entry.cwid}-${rowKey}`}
                                />{" "}
                                Curator
                              </label>
                              <label className="flex items-center gap-1.5 text-xs">
                                <RadioGroupItem
                                  value="owner"
                                  data-testid={`administrators-role-owner-${entry.cwid}-${rowKey}`}
                                />{" "}
                                Owner
                              </label>
                            </RadioGroup>
                          </td>
                          <td className="py-2 pl-6 whitespace-nowrap">
                            <span className={`${PROVENANCE_BADGE_BASE} ${prov.className}`}>
                              {prov.label}
                            </span>
                          </td>
                          <td className="py-2 pl-6 text-right">
                            <div className="flex flex-col items-end gap-1">
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                disabled={revokeDisabled}
                                title={
                                  isSelf
                                    ? "You can't remove your own access."
                                    : controlsDisabled
                                      ? ED_LOCKED_NOTE
                                      : undefined
                                }
                                onClick={() => setRevokeTarget({ cwid: entry.cwid, grant })}
                                data-testid={`administrators-revoke-${entry.cwid}-${grant.entityType}-${grant.entityId}`}
                              >
                                Revoke
                              </Button>
                              {edLocked && (
                                <a
                                  href="https://directory.weill.cornell.edu/"
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-muted-foreground hover:text-[var(--apollo-maroon)] inline-flex items-center gap-1 text-xs whitespace-nowrap hover:underline"
                                  title={ED_LOCKED_NOTE}
                                  data-testid={`administrators-ed-locked-note-${entry.cwid}-${grant.entityType}-${grant.entityId}`}
                                >
                                  <Lock className="size-3" aria-hidden />
                                  Managed through Web Directory
                                  <span className="sr-only"> — {ED_LOCKED_NOTE}</span>
                                </a>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          );
        })
      )}

      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => !open && setRevokeTarget(null)}
        title="Revoke this grant?"
        description="They will no longer be able to edit this unit. You can grant access again later."
        reasonMode="none"
        confirmLabel="Revoke"
        confirmVariant="destructive"
        onConfirm={() =>
          revokeTarget ? revoke(revokeTarget.cwid, revokeTarget.grant) : Promise.resolve()
        }
      />
    </div>
  );
}

/** Distinct units across the roster's grants, as Add-dialog options. */
function unitOptions(roster: ReadonlyArray<AdminRosterEntry>): AddAdminUnit[] {
  const seen = new Map<string, AddAdminUnit>();
  for (const e of roster) {
    for (const g of e.grants) {
      const value = `${g.entityType}:${g.entityId}`;
      if (!seen.has(value)) {
        seen.set(value, {
          value,
          entityType: g.entityType,
          entityId: g.entityId,
          unitName: g.unitName,
          label: `${g.unitName} · ${KIND_LABEL[g.entityType]}`,
        });
      }
    }
  }
  return [...seen.values()];
}

function mapErrorToMessage(code: string): string {
  switch (code) {
    case "ed_locked":
      return "This grant is managed through the Web Directory and can't be changed here.";
    case "scope_violation":
    case "authority_violation":
    case "not_unit_owner":
      return "You don't have permission to manage access for this unit.";
    case "cannot_revoke_self":
      return "You can't remove your own access.";
    case "invalid_cwid":
      return "That person couldn't be found. Try a different search.";
    default:
      return "Something went wrong — please try again.";
  }
}
