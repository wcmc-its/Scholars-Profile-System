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
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";

import {
  AddAdministratorDialog,
  type AddAdminUnit,
} from "@/components/edit/add-administrator-dialog";
import { ConfirmDialog } from "@/components/edit/confirm-dialog";
import type { DirectoryValue } from "@/components/edit/directory-people-typeahead";
import { ViewAsButton } from "@/components/edit/view-as-button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AdminRosterEntry, AdminRosterGrant } from "@/lib/api/administrators-roster";
import type { DirectoryPerson } from "@/lib/sources/ldap";
import { cn } from "@/lib/utils";

/** Two-letter initials for the roster-card avatar, e.g. "Adela Vargas" → "AV". */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

/** The provenance label for a `UnitAdmin.source`. */
function provenanceBadge(source: string): { label: string } {
  switch (source) {
    case "manual":
      return { label: "Manual" };
    case "ED:DA":
      return { label: "Department Administrator" };
    case "ED:DivA":
      return { label: "Division Administrator" };
    case "ED:IAMDELA":
      return { label: "IAMDELA" };
    case "ED:DivA-IAMDELA":
      return { label: "DivA-IAMDELA" };
    default:
      // Unknown future source: show it verbatim rather than swallow it.
      return { label: source };
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
  core: "Core",
};

/** Curator/Owner segmented-toggle button (styles a raw `RadioGroupPrimitive.Item`
 *  — the app's shared `RadioGroupItem` hardcodes its own dot-indicator child and
 *  can't render a text label inside the control, which the segmented look needs). */
const ROLE_SEGMENT_BASE =
  "px-3 py-1.5 text-xs font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-apollo-maroon data-[state=checked]:text-apollo-maroon-foreground data-[state=unchecked]:bg-apollo-surface data-[state=unchecked]:text-muted-foreground data-[state=unchecked]:hover:bg-apollo-surface-2";

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
  /** Whether the viewer can launch "View as" (impersonation flag on + superuser, #729).
   *  Optional + default-off: the button is a launcher only; the route enforces all policy. */
  canImpersonate?: boolean;
  /**
   * Every catalog core, regardless of whether it already has a grant on this
   * roster (cores-as-org-units P2). Unlike department/division/center, a core
   * with zero existing grants would otherwise be unselectable in
   * `AddAdministratorDialog` — `unitOptions` merges this in so a core's
   * *subsequent* owner/curator can be granted through the UI (the *first*
   * grant is still provisioned by direct DB insert). Optional + default-empty
   * so existing callers/tests are unaffected.
   */
  allCores?: ReadonlyArray<{ id: string; name: string }>;
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

/** "By person" (group by person, one row per org unit underneath) or "by org
 *  unit" (group by org unit, one row per admin underneath) — the grouping
 *  dimension changes with the mode, not just the sort order (§ SORT). */
type SortMode = "person" | "orgUnit";

/** One admin's grant on a specific unit, carrying both sides so the org-unit
 *  grouped view can render a person-focused row. */
type UnitAdmin = {
  entry: AdminRosterEntry;
  person: ResolvedPerson;
  grant: AdminRosterGrant;
};

/** A single org unit and everyone who administers it — the group for "by org
 *  unit" mode. Built by flattening every person's grants and bucketing by
 *  `entityType:entityId`, so a unit with N admins renders its header ONCE
 *  with N rows underneath, instead of repeating the unit once per person. */
type UnitGroup = {
  key: string;
  entityType: AdminRosterGrant["entityType"];
  entityId: string;
  unitName: string;
  admins: UnitAdmin[];
};

export function AdministratorsRoster({
  entries,
  isSuperuser,
  actorCwid,
  nameResolutionDegraded,
  canImpersonate = false,
  allCores = [],
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

  // Sort + filter — client-only UI state (§ SORT / § FILTER), no persistence.
  const [sortMode, setSortMode] = React.useState<SortMode>("person");
  const [filterQuery, setFilterQuery] = React.useState("");

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
  const filterQueryTrimmed = filterQuery.trim().toLowerCase();

  // "By person" grouping: one group per person, keeping ALL of their grant
  // rows when ANY of name / CWID / any grant's unitName matches (substring,
  // case-insensitive) — rows within a kept group are never individually
  // filtered out.
  const personGroups = resolved
    .filter(
      ({ entry, person }) =>
        filterQueryTrimmed.length === 0 ||
        person.name.toLowerCase().includes(filterQueryTrimmed) ||
        entry.cwid.toLowerCase().includes(filterQueryTrimmed) ||
        entry.grants.some((g) => g.unitName.toLowerCase().includes(filterQueryTrimmed)),
    )
    .sort(
      (a, b) =>
        a.person.name.localeCompare(b.person.name) || a.entry.cwid.localeCompare(b.entry.cwid),
    );

  // "By org unit" grouping: flatten every person's grants and bucket by unit
  // — the mirror of personGroups above, keeping ALL of a matching unit's
  // admins when ANY of the unit name / an admin's name / an admin's CWID
  // matches.
  const unitGroupsByKey = new Map<string, UnitGroup>();
  for (const { entry, person } of resolved) {
    for (const grant of entry.grants) {
      const key = `${grant.entityType}:${grant.entityId}`;
      const group = unitGroupsByKey.get(key) ?? {
        key,
        entityType: grant.entityType,
        entityId: grant.entityId,
        unitName: grant.unitName,
        admins: [],
      };
      group.admins.push({ entry, person, grant });
      unitGroupsByKey.set(key, group);
    }
  }
  const unitGroups = [...unitGroupsByKey.values()]
    .filter(
      (group) =>
        filterQueryTrimmed.length === 0 ||
        group.unitName.toLowerCase().includes(filterQueryTrimmed) ||
        group.admins.some(
          ({ entry, person }) =>
            person.name.toLowerCase().includes(filterQueryTrimmed) ||
            entry.cwid.toLowerCase().includes(filterQueryTrimmed),
        ),
    )
    .sort((a, b) => a.unitName.localeCompare(b.unitName));
  for (const group of unitGroups) {
    group.admins.sort(
      (a, b) =>
        a.person.name.localeCompare(b.person.name) || a.entry.cwid.localeCompare(b.entry.cwid),
    );
  }

  const displayedCount = sortMode === "orgUnit" ? unitGroups.length : personGroups.length;

  // Recompute the #443 note from the post-enrichment state. If the directory
  // fetch failed entirely, trust the server's seed instead of the (un-enriched)
  // recomputed value so a transient 503 doesn't hide the note prematurely.
  const anyBareCwid = resolved.some((r) => r.person.isBareCwid);
  const showDegradedNote = fetchOk === false ? nameResolutionDegraded : anyBareCwid;

  const scopeCaption = isSuperuser
    ? "Showing all administrators."
    : "Showing administrators within the units you own.";

  const totalGrants = roster.reduce((sum, e) => sum + e.grants.length, 0);

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

  /** Role radios + Source badge + Actions (Revoke, ED-locked note) — the three
   *  trailing cells shared by both grouping modes; only the leading cell (org
   *  unit info in "by person" mode, person info in "by org unit" mode)
   *  differs, so it's rendered separately by each caller. */
  function renderGrantActionCells(entry: AdminRosterEntry, grant: AdminRosterGrant) {
    const isSelf = entry.cwid === actorCwid;
    const prov = provenanceBadge(grant.source);
    const edLocked = isEdSourced(grant.source);
    // ED-sourced rows are read-only for EVERYONE (matches the route's
    // `ed_locked` gate) — they're managed in the Web Directory, so a local
    // change would just be re-synced.
    const controlsDisabled = edLocked;
    const rowKey = `${grant.entityType}:${grant.entityId}`;
    const busy = busyKey === `${entry.cwid}:${rowKey}`;
    const revokeDisabled = controlsDisabled || isSelf || busy;
    return (
      <>
        <td className="py-3 pl-5">
          <RadioGroupPrimitive.Root
            value={grant.role}
            onValueChange={(v) => updateRole(entry.cwid, grant, v as "owner" | "curator")}
            disabled={controlsDisabled || busy}
            className="border-apollo-border-strong inline-flex w-fit overflow-hidden rounded-md border"
            data-testid={`administrators-role-${entry.cwid}-${grant.entityType}-${grant.entityId}`}
          >
            <RadioGroupPrimitive.Item
              value="curator"
              className={cn(ROLE_SEGMENT_BASE, "border-apollo-border-strong border-r")}
              data-testid={`administrators-role-curator-${entry.cwid}-${rowKey}`}
            >
              Curator
            </RadioGroupPrimitive.Item>
            <RadioGroupPrimitive.Item
              value="owner"
              className={ROLE_SEGMENT_BASE}
              data-testid={`administrators-role-owner-${entry.cwid}-${rowKey}`}
            >
              Owner
            </RadioGroupPrimitive.Item>
          </RadioGroupPrimitive.Root>
        </td>
        <td className="py-3 pl-5 whitespace-nowrap">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm">{prov.label}</span>
            {edLocked && (
              <a
                href="https://directory.weill.cornell.edu/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground hover:text-apollo-slate inline-flex items-center gap-1 text-xs whitespace-nowrap hover:underline"
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
        <td className="py-3 pr-5 pl-5 text-right">
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
        </td>
      </>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-slot="administrators-roster">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-muted-foreground text-sm" data-testid="administrators-scope-caption">
            {scopeCaption}
          </p>
          {/* Paired with just the (short) caption on its own row, rather than
           *  nested alongside the filter + sort controls below: that keeps
           *  this button from ever wrapping onto an orphan line by itself
           *  when the controls row runs out of width. */}
          <AddAdministratorDialog units={unitOptions(roster, allCores)} onGranted={handleGranted} />
        </div>
        {roster.length > 0 && (
          <div className="flex flex-wrap items-center gap-3">
            <Input
              type="text"
              value={filterQuery}
              placeholder="Filter by name, org unit, or CWID"
              onChange={(e) => setFilterQuery(e.target.value)}
              aria-label="Filter administrators"
              className="max-w-xs"
              data-testid="administrators-filter-input"
            />
            <label className="text-muted-foreground flex items-center gap-2 text-sm">
              Sort
              <select
                value={sortMode}
                onChange={(e) => setSortMode(e.target.value as SortMode)}
                className="border-apollo-border-strong text-foreground h-9 rounded-md border bg-apollo-surface px-2 text-sm"
                data-testid="administrators-sort-select"
              >
                <option value="person">Person</option>
                <option value="orgUnit">Org unit</option>
              </select>
            </label>
            <span className="text-muted-foreground text-sm whitespace-nowrap">
              {roster.length} {roster.length === 1 ? "person" : "people"} · {totalGrants}{" "}
              {totalGrants === 1 ? "grant" : "grants"}
            </span>
          </div>
        )}
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
      ) : displayedCount === 0 ? (
        <p className="text-muted-foreground text-sm" data-testid="administrators-no-matches">
          No administrators match your search.
        </p>
      ) : (
        // One card per group (R11). "By person" groups by person (avatar +
        // name/title/CWID/email header band, grant rows nested underneath in
        // their own small table); "by org unit" inverts it — the org unit is
        // the card header (rendered once no matter how many admins it has)
        // and each admin becomes a row underneath, with Revoke living on that
        // person's row rather than the unit's. Each card's grant list keeps
        // real `<table>` markup (native row/column semantics) — only the
        // group header moved out into its own styled band.
        <div className="flex flex-col gap-4" data-testid="administrators-table">
          {sortMode === "orgUnit"
            ? unitGroups.map((group) => (
                <div
                  key={group.key}
                  data-testid={`administrators-unit-${group.key}`}
                  className="border-apollo-border bg-apollo-surface shadow-xs overflow-hidden rounded-xl border"
                >
                  <div className="bg-apollo-surface-2 border-apollo-border flex items-center gap-3 border-b px-5 py-4">
                    <span className="font-semibold">{group.unitName}</span>
                    <Badge
                      variant="outline"
                      className="bg-apollo-slate-tint text-apollo-slate border-apollo-slate-tint-border rounded-full"
                    >
                      {KIND_LABEL[group.entityType]}
                    </Badge>
                    <span className="text-muted-foreground ml-auto text-xs whitespace-nowrap">
                      {group.admins.length}{" "}
                      {group.admins.length === 1 ? "administrator" : "administrators"}
                    </span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-muted-foreground border-apollo-border border-b text-left">
                          <th className="py-2 pl-5 text-[11px] font-semibold tracking-wider uppercase">
                            Person
                          </th>
                          <th className="py-2 pl-5 text-[11px] font-semibold tracking-wider uppercase whitespace-nowrap">
                            Role
                          </th>
                          <th className="py-2 pl-5 text-[11px] font-semibold tracking-wider uppercase whitespace-nowrap">
                            Source
                          </th>
                          <th className="py-2 pr-5 pl-5 text-right text-[11px] font-semibold tracking-wider uppercase">
                            Actions
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.admins.map(({ entry, person, grant }) => {
                          const isSelf = entry.cwid === actorCwid;
                          return (
                            <tr
                              key={entry.cwid}
                              className="border-apollo-border border-t align-middle"
                              data-testid={`administrators-admin-${group.key}-${entry.cwid}`}
                            >
                              <td className="py-3 pl-5">
                                <div className="flex items-center gap-2.5">
                                  <div className="bg-apollo-maroon/10 text-apollo-maroon flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-bold">
                                    {initials(person.name)}
                                  </div>
                                  <div className="min-w-0">
                                    <span className="font-medium">{person.name}</span>
                                    {person.title && (
                                      <span className="text-muted-foreground font-normal">
                                        {" "}
                                        · {person.title}
                                      </span>
                                    )}
                                    <span className="text-muted-foreground ml-2 text-xs font-normal tabular-nums">
                                      {entry.cwid}
                                    </span>
                                  </div>
                                  {canImpersonate && !isSelf && (
                                    <ViewAsButton
                                      targetCwid={entry.cwid}
                                      targetName={person.name}
                                    />
                                  )}
                                </div>
                              </td>
                              {renderGrantActionCells(entry, grant)}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))
            : personGroups.map(({ entry, person }) => {
                const isSelf = entry.cwid === actorCwid;
                return (
                  <div
                    key={entry.cwid}
                    data-testid={`administrators-person-${entry.cwid}`}
                    className="border-apollo-border bg-apollo-surface shadow-xs overflow-hidden rounded-xl border"
                  >
                    <div className="bg-apollo-surface-2 border-apollo-border flex items-start gap-4 border-b px-5 py-4">
                      <div className="bg-apollo-maroon/10 text-apollo-maroon flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-bold">
                        {initials(person.name)}
                      </div>
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <div className="flex flex-wrap items-baseline gap-2">
                          <span className="font-semibold">{person.name}</span>
                          {person.title && (
                            <span className="text-muted-foreground text-sm font-normal">
                              {person.title}
                            </span>
                          )}
                        </div>
                        <div className="text-muted-foreground flex flex-wrap gap-3 text-xs">
                          <span className="tabular-nums">{entry.cwid}</span>
                          {person.email && (
                            <a
                              href={`mailto:${person.email}`}
                              className="hover:underline"
                              data-testid={`administrators-email-${entry.cwid}`}
                            >
                              {person.email}
                            </a>
                          )}
                        </div>
                      </div>
                      <div className="ml-auto flex shrink-0 items-center gap-3">
                        <span className="text-muted-foreground text-xs whitespace-nowrap">
                          {entry.grants.length} {entry.grants.length === 1 ? "grant" : "grants"}
                        </span>
                        {canImpersonate && !isSelf && (
                          <ViewAsButton targetCwid={entry.cwid} targetName={person.name} />
                        )}
                      </div>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-muted-foreground border-apollo-border border-b text-left">
                            <th className="py-2 pl-5 text-[11px] font-semibold tracking-wider uppercase">
                              Org unit
                            </th>
                            <th className="py-2 pl-5 text-[11px] font-semibold tracking-wider uppercase whitespace-nowrap">
                              Role
                            </th>
                            <th className="py-2 pl-5 text-[11px] font-semibold tracking-wider uppercase whitespace-nowrap">
                              Source
                            </th>
                            <th className="py-2 pr-5 pl-5 text-right text-[11px] font-semibold tracking-wider uppercase">
                              Actions
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {entry.grants.map((grant) => (
                            <tr
                              key={`${grant.entityType}:${grant.entityId}`}
                              className="border-apollo-border border-t align-middle"
                              data-testid={`administrators-grant-${entry.cwid}-${grant.entityType}-${grant.entityId}`}
                            >
                              <td className="py-3 pl-5">
                                <span className="font-medium">{grant.unitName}</span>
                                <Badge
                                  variant="outline"
                                  className="bg-apollo-slate-tint text-apollo-slate border-apollo-slate-tint-border ml-2 rounded-full"
                                >
                                  {KIND_LABEL[grant.entityType]}
                                </Badge>
                              </td>
                              {renderGrantActionCells(entry, grant)}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })}
        </div>
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

/**
 * Distinct units across the roster's grants, as Add-dialog options. For
 * department/division/center this stays grants-only — today a unit of that
 * kind with zero existing grants can't be selected here, and fixing that
 * needs a real shared "all units" abstraction `/browse` doesn't have yet
 * (out of scope for cores-as-org-units P2). Cores are the one kind scoped
 * with a canonical list already (`getCoreList`), so `allCores` is seeded
 * first — every catalog core is always selectable, even with zero grants —
 * then the roster's own grants are layered on top so a core that DOES have a
 * grant keeps its real grant-derived data (the two de-dupe on the same map
 * key, `core:{id}`).
 */
function unitOptions(
  roster: ReadonlyArray<AdminRosterEntry>,
  allCores: ReadonlyArray<{ id: string; name: string }>,
): AddAdminUnit[] {
  const seen = new Map<string, AddAdminUnit>();
  for (const c of allCores) {
    const value = `core:${c.id}`;
    seen.set(value, {
      value,
      entityType: "core",
      entityId: c.id,
      unitName: c.name,
      label: `${c.name} · Core`,
    });
  }
  // Unconditional set (not "set if absent"): a roster grant's real data
  // should win over an `allCores` synthesized placeholder for the same core,
  // and re-setting the same unit from a second person's grant is a harmless
  // no-op (identical unitName/entityType/entityId either way).
  for (const e of roster) {
    for (const g of e.grants) {
      const value = `${g.entityType}:${g.entityId}`;
      seen.set(value, {
        value,
        entityType: g.entityType,
        entityId: g.entityId,
        unitName: g.unitName,
        label: `${g.unitName} · ${KIND_LABEL[g.entityType]}`,
      });
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
