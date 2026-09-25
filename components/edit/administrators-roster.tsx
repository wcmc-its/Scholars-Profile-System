/**
 * AdministratorsRoster — the Administrators-tab body (#728 Phase B + C,
 * `ed-admin-org-unit-roles-spec.md` § 4.2/§ 4.3/§ 4.4), redesigned 2026-09 as
 * ONE roster table with a filter rail: one row per person (org unit, role ·
 * source, actions), multi-grant people collapsed to a summary that expands to
 * one row per grant. Per-grant write controls (update-role + Revoke) and the
 * page-level Add dialog all route through the existing `POST /api/edit/grant`.
 *
 * ED-sourced rows (`source` LIKE 'ED:%') are owned by the nightly Enterprise
 * Directory import and are read-only for EVERYONE (the route's `ed_locked`
 * gate): they render a role pill and "Read-only" instead of controls, so the
 * affordance matches the gate (no click-then-403). § 4.4.
 *
 * Client component: on mount it batch-fetches the Enterprise Directory once via
 * `GET /api/directory/people?cwids=…` to enrich each person with first/last name,
 * primary title, and email — mirroring how `unit-access-card.tsx` hydrates
 * grantee names. LDAP is unreachable in deployed envs until #443, so this fetch
 * is the ONLY directory access and it must never throw: a 503 / network failure
 * just falls back to the server-provided Scholar name + the #443 note.
 *
 * Sort, search and the rail filters are client-only UI state over the roster
 * the server already scoped — the loader's `scope`, never this UI, is the
 * authorization boundary.
 */
"use client";

import * as React from "react";
import { ChevronRight, Lock } from "lucide-react";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";

import {
  AddAdministratorDialog,
  type AddAdminUnit,
} from "@/components/edit/add-administrator-dialog";
import { ConfirmDialog } from "@/components/edit/confirm-dialog";
import {
  AssignFunctionalRoleDialog,
  FunctionalRolesPanel,
} from "@/components/edit/functional-roles-panel";
import type { DirectoryValue } from "@/components/edit/directory-people-typeahead";
import { ViewAsButton } from "@/components/edit/view-as-button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AdminRosterEntry, AdminRosterGrant } from "@/lib/api/administrators-roster";
import type {
  FunctionalRoleRow,
  FunctionalRoleScopeOptions,
  GateHolder,
} from "@/lib/edit/functional-roles";
import type { DirectoryPerson } from "@/lib/sources/ldap";
import { cn } from "@/lib/utils";
import { INSTITUTIONS } from "@/lib/institutions";

/** Two-letter initials for the roster avatar, e.g. "Alex Example" → "AE". */
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
  institution: "Institution",
};

/** Rail + summary order for unit kinds. */
const KIND_ORDER: ReadonlyArray<AdminRosterGrant["entityType"]> = [
  "department",
  "division",
  "center",
  "core",
  "institution",
];

/** One segment of a white-on-surface-2 segmented control (the role toggle and
 *  the Sort control). Styles a raw `RadioGroupPrimitive.Item` — the app's
 *  shared `RadioGroupItem` hardcodes its own dot-indicator child and can't
 *  render a text label inside the control, which the segmented look needs. */
const SEGMENT_ITEM =
  "cursor-pointer rounded-[5px] whitespace-nowrap transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-apollo-surface data-[state=checked]:font-medium data-[state=checked]:text-foreground data-[state=checked]:shadow-[0_1px_2px_rgba(34,30,28,.12)] data-[state=unchecked]:text-muted-foreground data-[state=unchecked]:hover:text-foreground";
const ROLE_SEGMENT_BASE = cn(SEGMENT_ITEM, "px-2.5 py-[3px] text-[12.5px]");

/** The four columns every roster row shares (person · org unit · role/source ·
 *  actions), so rows line up with the header; phones stack the cells. */
const ROW_COLS = "md:grid-cols-[minmax(130px,1.2fr)_minmax(150px,1.5fr)_minmax(150px,1.2fr)_104px]";
const ROW_GRID = cn("grid grid-cols-1 gap-2 md:items-center md:gap-3.5", ROW_COLS);

/** Owner reads slate (the higher-trust grant); Curator reads neutral. */
function rolePillClass(role: "owner" | "curator"): string {
  return cn(
    "inline-flex w-fit items-center rounded-full border px-2.5 py-0.5 text-[12.5px] font-medium whitespace-nowrap",
    role === "owner"
      ? "bg-apollo-slate-tint text-apollo-slate border-apollo-slate-tint-border"
      : "bg-apollo-surface-2 text-foreground border-apollo-border-strong",
  );
}

const ROLE_LABEL = { owner: "Owner", curator: "Curator" } as const;

/** The rail's Grants buckets: "1 grant" / "2–5 grants" / "6 or more". */
type GrantBucket = "1" | "2-5" | "6+";
function grantBucket(n: number): GrantBucket {
  return n <= 1 ? "1" : n <= 5 ? "2-5" : "6+";
}

/** Rail filter group ids; a filter key is `${group}:${value}`. */
type FilterGroup = "role" | "src" | "kind" | "n";

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Mar 2026" from an ISO timestamp (UTC, so the server render and client agree). */
function monthYear(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** The caveat on ED-locked grants (§ 4.4). */
const ED_LOCKED_NOTE =
  "Managed through the Web Directory. This grant is read-only here; the role is set at the source and restored on the next sync.";

const WEB_DIRECTORY_URL = "https://directory.weill.cornell.edu/";

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
  /** The page title block (h1 + description), laid out beside the Add button. */
  header?: React.ReactNode;
  /** The Functional roles tab's data. Superuser-only: when absent (a unit
   *  Owner), the tab strip is not rendered and the page is org-unit grants only. */
  functionalRoles?: {
    rows: ReadonlyArray<FunctionalRoleRow>;
    scopeOptions: FunctionalRoleScopeOptions;
    /** `FUNCTIONAL_ROLES_AUTHZ`: whether rows also grant access. */
    authzEnabled?: boolean;
    /** Current holders by the existing gates, for the parity line. */
    gateHolders?: ReadonlyArray<GateHolder>;
  };
};

type RosterTab = "units" | "roles";

/** A person's enriched display fields, in the resolved precedence order. */
type ResolvedPerson = {
  /** Display name; equals the bare CWID when nothing resolved it. */
  name: string;
  title: string | null;
  email: string | null;
  /** True when neither the directory nor the Scholar table supplied a name. */
  isBareCwid: boolean;
};

/** "Person" (A–Z), "Most grants" (grant count, then A–Z) — both one row per
 *  person — or "Org unit", which regroups by unit: one band per unit with its
 *  administrators underneath (the grouping changes, not just the order). */
type SortMode = "person" | "grants" | "orgUnit";

const SORT_OPTIONS: ReadonlyArray<{ value: SortMode; label: string }> = [
  { value: "person", label: "Person" },
  { value: "grants", label: "Most grants" },
  { value: "orgUnit", label: "Org unit" },
];

/** One admin's grant on a specific unit, carrying both sides so the org-unit
 *  grouped view can render a person-focused row. */
type UnitAdmin = {
  entry: AdminRosterEntry;
  person: ResolvedPerson;
  grant: AdminRosterGrant;
};

/** A single org unit and everyone who administers it — the group for "by org
 *  unit" mode. Built by flattening every person's grants and bucketing by
 *  `entityType:entityId`, so a unit with N admins renders its band ONCE with N
 *  rows underneath, instead of repeating the unit once per person. */
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
  header,
  functionalRoles,
}: AdministratorsRosterProps) {
  const [tab, setTab] = React.useState<RosterTab>("units");
  const [functionalRows, setFunctionalRows] = React.useState<FunctionalRoleRow[]>(() => [
    ...(functionalRoles?.rows ?? []),
  ]);
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

  // Sort + search + rail filters — client-only UI state, no persistence.
  const [sortMode, setSortMode] = React.useState<SortMode>("person");
  const [filterQuery, setFilterQuery] = React.useState("");
  // Rail filters: OR within a group, AND across groups, matched per person (a
  // person passes a group when ANY of their grants satisfies one of its values).
  const [filters, setFilters] = React.useState<ReadonlySet<string>>(() => new Set());
  // Multi-grant people whose grant rows are expanded, by CWID.
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(() => new Set());

  // Per-row write state.
  const [busyKey, setBusyKey] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  // The grant the user is confirming a revoke for, or null.
  const [revokeTarget, setRevokeTarget] = React.useState<{
    cwid: string;
    grant: AdminRosterGrant;
  } | null>(null);

  const cwidKey = React.useMemo(() => [...new Set(roster.map((e) => e.cwid))].join(","), [roster]);

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

  // A person whose last grant was revoked drops off the roster.
  const resolved = roster
    .filter((e) => e.grants.length > 0)
    .map((e) => ({ entry: e, person: resolve(e) }));
  const filterQueryTrimmed = filterQuery.trim().toLowerCase();

  function filterValues(group: FilterGroup): string[] {
    const prefix = `${group}:`;
    return [...filters].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
  }
  function grantMatches(group: FilterGroup, value: string, g: AdminRosterGrant): boolean {
    switch (group) {
      case "role":
        return g.role === value;
      case "src":
        return value === "ed" ? isEdSourced(g.source) : !isEdSourced(g.source);
      case "kind":
        return g.entityType === value;
      case "n":
        return false;
    }
  }
  function personMatchesValue(group: FilterGroup, value: string, entry: AdminRosterEntry): boolean {
    if (group === "n") return grantBucket(entry.grants.length) === value;
    return entry.grants.some((g) => grantMatches(group, value, g));
  }
  function passesRail(entry: AdminRosterEntry): boolean {
    return (["role", "src", "kind", "n"] as const).every((group) => {
      const values = filterValues(group);
      return values.length === 0 || values.some((v) => personMatchesValue(group, v, entry));
    });
  }
  const railPassing = resolved.filter(({ entry }) => passesRail(entry));

  // Person rows: keep ALL of a person's grants when ANY of name / CWID / any
  // grant's unitName matches (substring, case-insensitive) — grants within a
  // kept person are never individually filtered out.
  const personGroups = railPassing
    .filter(
      ({ entry, person }) =>
        filterQueryTrimmed.length === 0 ||
        person.name.toLowerCase().includes(filterQueryTrimmed) ||
        entry.cwid.toLowerCase().includes(filterQueryTrimmed) ||
        entry.grants.some((g) => g.unitName.toLowerCase().includes(filterQueryTrimmed)),
    )
    .sort(
      (a, b) =>
        (sortMode === "grants" ? b.entry.grants.length - a.entry.grants.length : 0) ||
        a.person.name.localeCompare(b.person.name) ||
        a.entry.cwid.localeCompare(b.entry.cwid),
    );

  // "Org unit" grouping: flatten every (rail-passing) person's grants and
  // bucket by unit — the mirror of personGroups above, keeping ALL of a
  // matching unit's admins when ANY of the unit name / an admin's name / an
  // admin's CWID matches.
  const unitGroupsByKey = new Map<string, UnitGroup>();
  for (const { entry, person } of railPassing) {
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

  const allGrants = resolved.flatMap((r) => r.entry.grants);
  const totalGrants = allGrants.length;
  const grantedHere = allGrants.filter((g) => !isEdSourced(g.source)).length;
  const shownGrants = personGroups.reduce((sum, r) => sum + r.entry.grants.length, 0);

  // Rail options, counted in PEOPLE over the whole (unfiltered) roster.
  const countPeople = (group: FilterGroup, value: string) =>
    resolved.filter(({ entry }) => personMatchesValue(group, value, entry)).length;
  const railGroups: ReadonlyArray<{
    group: FilterGroup;
    label: string;
    items: ReadonlyArray<{ value: string; label: string; count: number }>;
  }> = [
    {
      group: "role",
      label: "Role",
      items: (["owner", "curator"] as const).map((r) => ({
        value: r,
        label: ROLE_LABEL[r],
        count: countPeople("role", r),
      })),
    },
    {
      group: "src",
      label: "Source",
      items: [
        { value: "ed", label: "Web Directory", count: countPeople("src", "ed") },
        { value: "manual", label: "Granted here", count: countPeople("src", "manual") },
      ],
    },
    {
      group: "kind",
      label: "Unit kind",
      items: KIND_ORDER.map((k) => ({
        value: k,
        label: KIND_LABEL[k],
        count: countPeople("kind", k),
      }))
        // Core / Institution appear only when someone holds one (or it's ticked).
        .filter(
          (o) =>
            o.count > 0 ||
            filters.has(`kind:${o.value}`) ||
            ["department", "division", "center"].includes(o.value),
        ),
    },
    {
      group: "n",
      label: "Grants",
      items: [
        { value: "1", label: "1 grant", count: countPeople("n", "1") },
        { value: "2-5", label: "2–5 grants", count: countPeople("n", "2-5") },
        { value: "6+", label: "6 or more", count: countPeople("n", "6+") },
      ],
    },
  ];

  function toggleFilter(key: string) {
    setFilters((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  const anyFilter = filters.size > 0 || filterQuery.length > 0;

  const multiShown = personGroups.filter((r) => r.entry.grants.length > 1).map((r) => r.entry.cwid);
  const allExpanded = multiShown.length > 0 && multiShown.every((c) => expanded.has(c));
  function toggleExpanded(cwid: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(cwid)) next.delete(cwid);
      else next.add(cwid);
      return next;
    });
  }

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
   * grant on an existing person, or adds a new person row whose name the
   * directory effect then enriches.
   */
  function handleGranted(grantee: DirectoryValue, granted: AdminRosterGrant) {
    setError(null);
    // The dialog's grant is always a manual one made by the viewer, just now.
    const grant: AdminRosterGrant = {
      grantedBy: actorCwid,
      grantedAt: new Date().toISOString(),
      ...granted,
    };
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

  // ── Cell renderers ─────────────────────────────────────────────────────────

  /** "Added by <name> · Mar 2026" for a grant made in Scholars Console. */
  function addedByLine(g: AdminRosterGrant): string {
    if (!g.grantedBy) return "Granted in Scholars Console";
    const who = g.grantedBy === actorCwid ? "you" : (g.grantedByName ?? g.grantedBy);
    const when = monthYear(g.grantedAt);
    return `Added by ${who}${when ? ` · ${when}` : ""}`;
  }

  /** One grant's source, as its own line: "Web Directory · IAMDELA" / "Added by …". */
  function grantSourceText(g: AdminRosterGrant): string {
    return isEdSourced(g.source)
      ? `Web Directory · ${provenanceBadge(g.source).label}`
      : addedByLine(g);
  }

  /** The small lock tile ED-sourced rows carry; links to the Web Directory. */
  function lockTile() {
    return (
      <a
        href={WEB_DIRECTORY_URL}
        target="_blank"
        rel="noopener noreferrer"
        title={ED_LOCKED_NOTE}
        className="bg-apollo-lock-bg text-foreground hover:text-apollo-slate inline-flex size-[18px] flex-none items-center justify-center rounded"
      >
        <Lock className="size-[11px]" aria-hidden />
        <span className="sr-only">Managed through the Web Directory — {ED_LOCKED_NOTE}</span>
      </a>
    );
  }

  /** The role control for one grant: a Curator/Owner segmented toggle for a
   *  grant made here, a read-only role pill for an ED-sourced one. */
  function roleControl(entry: AdminRosterEntry, grant: AdminRosterGrant) {
    const rowKey = `${grant.entityType}:${grant.entityId}`;
    if (isEdSourced(grant.source)) {
      return (
        <span
          className={rolePillClass(grant.role)}
          data-testid={`administrators-role-${entry.cwid}-${grant.entityType}-${grant.entityId}`}
        >
          {ROLE_LABEL[grant.role]}
        </span>
      );
    }
    const busy = busyKey === `${entry.cwid}:${rowKey}`;
    return (
      <RadioGroupPrimitive.Root
        value={grant.role}
        onValueChange={(v) => updateRole(entry.cwid, grant, v as "owner" | "curator")}
        disabled={busy}
        aria-label={`Role on ${grant.unitName}`}
        className="bg-apollo-surface-2 border-apollo-border-strong inline-flex w-fit flex-none rounded-[7px] border p-0.5"
        data-testid={`administrators-role-${entry.cwid}-${grant.entityType}-${grant.entityId}`}
      >
        <RadioGroupPrimitive.Item
          value="curator"
          className={ROLE_SEGMENT_BASE}
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
    );
  }

  /** Revoke for a grant made here; "Read-only" for an ED-sourced one. */
  function grantAction(entry: AdminRosterEntry, grant: AdminRosterGrant) {
    if (isEdSourced(grant.source)) {
      return (
        <span
          title={ED_LOCKED_NOTE}
          className="text-muted-foreground text-[12.5px] whitespace-nowrap"
          data-testid={`administrators-ed-locked-note-${entry.cwid}-${grant.entityType}-${grant.entityId}`}
        >
          Read-only
          <span className="sr-only"> — {ED_LOCKED_NOTE}</span>
        </span>
      );
    }
    const isSelf = entry.cwid === actorCwid;
    const busy = busyKey === `${entry.cwid}:${grant.entityType}:${grant.entityId}`;
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={isSelf || busy}
        title={isSelf ? "You can't remove your own access." : undefined}
        onClick={() => setRevokeTarget({ cwid: entry.cwid, grant })}
        className="text-destructive hover:text-destructive -ml-2 h-7 px-2 text-[13px] font-normal"
        data-testid={`administrators-revoke-${entry.cwid}-${grant.entityType}-${grant.entityId}`}
      >
        Revoke
      </Button>
    );
  }

  function personCell(entry: AdminRosterEntry, person: ResolvedPerson) {
    return (
      <div className="flex min-w-0 items-center gap-3">
        <div
          aria-hidden
          className="bg-apollo-surface-2 ring-apollo-border-strong text-apollo-bar flex size-9 flex-none items-center justify-center rounded-full text-[12.5px] font-semibold ring-1"
        >
          {initials(person.name)}
        </div>
        <div className="flex min-w-0 flex-col gap-px">
          <span className="truncate text-[14.5px] font-[550]">{person.name}</span>
          {person.title && (
            <span className="text-muted-foreground truncate text-[13px]">{person.title}</span>
          )}
          <span className="text-muted-foreground flex min-w-0 flex-wrap gap-x-2 text-xs">
            <span className="font-mono">{entry.cwid}</span>
            {person.email && (
              <a
                href={`mailto:${person.email}`}
                onClick={(e) => e.stopPropagation()}
                className="hover:text-apollo-slate truncate hover:underline"
                data-testid={`administrators-email-${entry.cwid}`}
              >
                {person.email}
              </a>
            )}
          </span>
        </div>
      </div>
    );
  }

  function viewAs(entry: AdminRosterEntry, person: ResolvedPerson) {
    if (!canImpersonate || entry.cwid === actorCwid) return null;
    return <ViewAsButton targetCwid={entry.cwid} targetName={person.name} variant="ghost" />;
  }

  /** One person's row: the collapsed summary, plus the per-grant rows when a
   *  multi-grant person is expanded. */
  function personRow(entry: AdminRosterEntry, person: ResolvedPerson, index: number) {
    const grants = entry.grants;
    const g0 = grants[0]!;
    const multi = grants.length > 1;
    const isOpen = multi && expanded.has(entry.cwid);
    const stripe = index % 2 === 1 ? "bg-apollo-page" : "bg-apollo-surface";
    const allEd = grants.every((g) => isEdSourced(g.source));
    const noneEd = grants.every((g) => !isEdSourced(g.source));

    // Org unit column.
    const kindCounts = new Map<AdminRosterGrant["entityType"], number>();
    for (const g of grants) kindCounts.set(g.entityType, (kindCounts.get(g.entityType) ?? 0) + 1);
    const kindSummary = KIND_ORDER.filter((k) => kindCounts.has(k))
      .map((k) => plural(kindCounts.get(k)!, KIND_LABEL[k].toLowerCase()))
      .join(" · ");
    const unitSub =
      grants
        .slice(0, 3)
        .map((g) => g.unitName)
        .join(", ") + (grants.length > 3 ? `, +${grants.length - 3} more` : "");

    // Role column: per-role counts for a multi-grant person.
    const roleCounts = (["owner", "curator"] as const)
      .map((r) => ({ role: r, n: grants.filter((g) => g.role === r).length }))
      .filter((r) => r.n > 0);

    // Source line.
    let sourceLine: string;
    if (!multi) sourceLine = grantSourceText(g0);
    else if (allEd) {
      const labels = [...new Set(grants.map((g) => provenanceBadge(g.source).label))];
      sourceLine = `Web Directory · ${labels.length === 1 ? labels[0] : "several roles"}`;
    } else if (noneEd) {
      const lines = [...new Set(grants.map(addedByLine))];
      sourceLine = lines.length === 1 ? lines[0]! : "Granted in Scholars Console";
    } else sourceLine = "Mixed sources";

    return (
      <div
        key={entry.cwid}
        className={cn("border-apollo-border border-b", stripe)}
        data-testid={`administrators-person-${entry.cwid}`}
      >
        <div
          className={cn(
            ROW_GRID,
            "px-5 py-3.5",
            multi && "hover:bg-apollo-surface-2 cursor-pointer",
          )}
          onClick={multi ? () => toggleExpanded(entry.cwid) : undefined}
          data-testid={
            multi ? undefined : `administrators-grant-${entry.cwid}-${g0.entityType}-${g0.entityId}`
          }
        >
          {personCell(entry, person)}
          <div className="flex min-w-0 flex-col gap-0.5 pl-12 md:pl-0">
            {multi ? (
              <>
                <span className="truncate text-sm">{kindSummary}</span>
                <span className="text-muted-foreground truncate text-[12.5px]">{unitSub}</span>
              </>
            ) : (
              <>
                <span className="truncate text-sm">{g0.unitName}</span>
                <span className="text-muted-foreground text-[12.5px]">
                  {KIND_LABEL[g0.entityType]}
                </span>
              </>
            )}
          </div>
          <div className="flex min-w-0 flex-col gap-1.5 pl-12 md:pl-0">
            <div className="flex flex-wrap gap-1.5">
              {multi
                ? roleCounts.map(({ role, n }) => (
                    <span key={role} className={rolePillClass(role)}>
                      {roleCounts.length === 1
                        ? `${ROLE_LABEL[role]} · ${n}`
                        : `${ROLE_LABEL[role]} ${n}`}
                    </span>
                  ))
                : roleControl(entry, g0)}
            </div>
            <span className="flex min-w-0 items-center gap-1.5 text-[12.5px]">
              {allEd && lockTile()}
              <span className="text-muted-foreground min-w-0 truncate">{sourceLine}</span>
            </span>
          </div>
          <div className="flex items-center justify-between gap-2 pl-12 md:pl-0">
            <div className="flex flex-col items-start gap-0.5" onClick={(e) => e.stopPropagation()}>
              {viewAs(entry, person)}
              {!multi && grantAction(entry, g0)}
            </div>
            {multi && (
              <button
                type="button"
                aria-expanded={isOpen}
                aria-label={`${isOpen ? "Hide" : "Show"} ${grants.length} grants for ${person.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleExpanded(entry.cwid);
                }}
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 -mr-1 inline-flex size-7 flex-none items-center justify-center rounded-md outline-none focus-visible:ring-[3px]"
                data-testid={`administrators-expand-${entry.cwid}`}
              >
                <ChevronRight
                  className={cn("size-4 transition-transform", isOpen && "rotate-90")}
                  aria-hidden
                />
              </button>
            )}
          </div>
        </div>
        {isOpen && (
          <div className="border-apollo-border border-t border-dashed pt-1 pb-2">
            {grants.map((grant) => (
              <div
                key={`${grant.entityType}:${grant.entityId}`}
                className={cn(ROW_GRID, "px-5 py-2")}
                data-testid={`administrators-grant-${entry.cwid}-${grant.entityType}-${grant.entityId}`}
              >
                <span className="hidden md:block" />
                <div className="flex min-w-0 flex-col pl-12 md:pl-0">
                  <span className="truncate text-sm">{grant.unitName}</span>
                  <span className="text-muted-foreground text-xs">
                    {KIND_LABEL[grant.entityType]}
                  </span>
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pl-12 md:pl-0">
                  {roleControl(entry, grant)}
                  <span className="text-muted-foreground min-w-0 truncate text-[12.5px]">
                    {grantSourceText(grant)}
                  </span>
                </div>
                <div className="pl-12 md:pl-0">{grantAction(entry, grant)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  const headerCell = "text-muted-foreground text-xs font-medium tracking-[0.08em] uppercase";

  return (
    <div className="flex flex-col gap-6" data-slot="administrators-roster">
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex min-w-0 flex-1 basis-[300px] flex-col gap-1.5">{header}</div>
        {tab === "roles" && functionalRoles ? (
          <AssignFunctionalRoleDialog
            scopeOptions={functionalRoles.scopeOptions}
            onAssigned={setFunctionalRows}
            authzEnabled={functionalRoles.authzEnabled}
          />
        ) : (
          <AddAdministratorDialog units={unitOptions(roster, allCores)} onGranted={handleGranted} />
        )}
      </div>

      {functionalRoles && (
        <div
          role="tablist"
          aria-label="Administrator kinds"
          className="border-apollo-border-strong flex flex-wrap items-end gap-7 border-b"
          data-testid="administrators-tabs"
        >
          {(
            [
              ["units", "Org unit grants", resolved.length],
              ["roles", "Functional roles", functionalRows.length],
            ] as const
          ).map(([value, label, n]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
              className={cn(
                "flex items-center gap-2 px-0.5 pt-2.5 pb-3 text-[15px] whitespace-nowrap",
                tab === value
                  ? "text-foreground font-medium shadow-[inset_0_-2px_0_var(--apollo-maroon)]"
                  : "text-muted-foreground hover:text-foreground",
              )}
              data-testid={`administrators-tab-${value}`}
            >
              {label}
              <span
                className={cn(
                  "text-foreground rounded-full px-[7px] py-px text-xs font-normal",
                  tab === value ? "bg-apollo-rail" : "bg-apollo-surface-2",
                )}
              >
                {n}
              </span>
            </button>
          ))}
        </div>
      )}

      {tab === "roles" && functionalRoles ? (
        <>
          <p
            className="text-muted-foreground -mt-2 text-[13px]"
            data-testid="functional-roles-caption"
          >
            Access that isn’t tied to an org unit.
          </p>
          <FunctionalRolesPanel
            rows={functionalRows}
            onRowsChange={setFunctionalRows}
            scopeOptions={functionalRoles.scopeOptions}
            actorCwid={actorCwid}
            canImpersonate={canImpersonate}
            authzEnabled={functionalRoles.authzEnabled}
            gateHolders={functionalRoles.gateHolders}
          />
        </>
      ) : (
        <>
          <p className="text-muted-foreground -mt-2 text-[13px]">
            <span data-testid="administrators-scope-caption">{scopeCaption}</span> Unit owners and
            curators also get Reports for their units.
          </p>

          {showDegradedNote && (
            <p
              className="text-muted-foreground text-sm"
              data-testid="administrators-name-degraded-note"
            >
              Some names resolve from the Web Directory and are unavailable until directory routing
              (#443) lands; unit scope, role, and provenance below are accurate.
            </p>
          )}

          {error && (
            <Alert variant="destructive" data-testid="administrators-error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {resolved.length === 0 ? (
            <p className="text-muted-foreground text-sm" data-testid="administrators-empty">
              {isSuperuser ? "No administrators yet." : "No administrators within your units."}
            </p>
          ) : (
            <div className="grid items-start gap-5 md:grid-cols-[200px_minmax(0,1fr)]">
              <aside
                aria-label="Filters"
                className="bg-apollo-rail border-apollo-border-strong flex flex-col gap-5 rounded-[13px] border px-5 pt-[18px] pb-5 md:sticky md:top-5 md:gap-[22px]"
                data-testid="administrators-rail"
              >
                <div className="flex items-baseline justify-between">
                  <span className="text-muted-foreground text-xs font-medium tracking-[0.12em] uppercase">
                    Filters
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setFilters(new Set());
                      setFilterQuery("");
                    }}
                    disabled={!anyFilter}
                    className="text-apollo-slate disabled:text-muted-foreground text-[13px] hover:underline disabled:cursor-default disabled:no-underline"
                    data-testid="administrators-filters-clear"
                  >
                    Clear
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-x-6 gap-y-5 md:flex md:flex-col md:gap-[22px]">
                  {railGroups.map(({ group, label, items }) => (
                    <fieldset
                      key={group}
                      className="m-0 flex min-w-0 flex-col gap-0.5 border-0 p-0"
                    >
                      <legend className="text-muted-foreground mb-1.5 p-0 text-xs font-medium tracking-[0.12em] whitespace-nowrap uppercase">
                        {label}
                      </legend>
                      {items.map((item) => {
                        const key = `${group}:${item.value}`;
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
                              data-testid={`administrators-filter-${group}-${item.value}`}
                            />
                            <span className="min-w-0 flex-1 leading-[1.35]">{item.label}</span>
                            <span className="text-muted-foreground text-[13px] tabular-nums">
                              {item.count}
                            </span>
                          </label>
                        );
                      })}
                    </fieldset>
                  ))}
                </div>
              </aside>

              <section className="flex min-w-0 flex-col gap-3.5" aria-label="Administrators">
                <Input
                  type="text"
                  value={filterQuery}
                  placeholder="Filter by name, org unit, or CWID…"
                  onChange={(e) => setFilterQuery(e.target.value)}
                  aria-label="Filter administrators"
                  className="bg-apollo-surface h-10"
                  data-testid="administrators-filter-input"
                />
                <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                  <span
                    className="text-muted-foreground flex flex-wrap gap-x-6 gap-y-1 text-[15px]"
                    data-testid="administrators-stats"
                  >
                    <span className="whitespace-nowrap">
                      <span className="text-foreground font-semibold tabular-nums">
                        {resolved.length}
                      </span>{" "}
                      {resolved.length === 1 ? "person" : "people"}
                    </span>
                    <span className="whitespace-nowrap">
                      <span className="text-foreground font-semibold tabular-nums">
                        {totalGrants}
                      </span>{" "}
                      {totalGrants === 1 ? "grant" : "grants"}
                    </span>
                    <span className="whitespace-nowrap">
                      <span className="text-foreground font-semibold tabular-nums">
                        {grantedHere}
                      </span>{" "}
                      granted here
                    </span>
                  </span>
                  <div className="ml-auto flex flex-wrap items-center gap-2">
                    <span
                      className="text-muted-foreground text-[13px]"
                      id="administrators-sort-label"
                    >
                      Sort
                    </span>
                    <RadioGroupPrimitive.Root
                      value={sortMode}
                      onValueChange={(v) => setSortMode(v as SortMode)}
                      aria-labelledby="administrators-sort-label"
                      orientation="horizontal"
                      className="bg-apollo-surface-2 border-apollo-border flex rounded-lg border p-[3px]"
                      data-testid="administrators-sort"
                    >
                      {SORT_OPTIONS.map((o) => (
                        <RadioGroupPrimitive.Item
                          key={o.value}
                          value={o.value}
                          className={cn(SEGMENT_ITEM, "rounded-md px-[11px] py-1 text-[13px]")}
                          data-testid={`administrators-sort-${o.value}`}
                        >
                          {o.label}
                        </RadioGroupPrimitive.Item>
                      ))}
                    </RadioGroupPrimitive.Root>
                    {sortMode !== "orgUnit" && multiShown.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setExpanded(allExpanded ? new Set() : new Set(multiShown))}
                        className="text-apollo-slate text-[13px] whitespace-nowrap hover:underline"
                        data-testid="administrators-expand-all"
                      >
                        {allExpanded ? "Collapse all" : "Expand all"}
                      </button>
                    )}
                  </div>
                </div>

                <div className="bg-apollo-surface border-apollo-border-strong overflow-hidden rounded-[13px] border">
                  <div
                    className={cn(
                      "bg-apollo-surface-2 border-apollo-border-strong hidden gap-3.5 border-b px-5 py-3 md:grid",
                      ROW_COLS,
                    )}
                    aria-hidden
                  >
                    {sortMode === "orgUnit" ? (
                      <>
                        <span className={headerCell}>Person</span>
                        <span className={headerCell}>Role</span>
                        <span className={headerCell}>Source</span>
                        <span />
                      </>
                    ) : (
                      <>
                        <span className={headerCell}>Person</span>
                        <span className={headerCell}>Org unit</span>
                        <span className={headerCell}>Role · source</span>
                        <span />
                      </>
                    )}
                  </div>

                  {displayedCount === 0 ? (
                    <p
                      className="text-muted-foreground m-0 px-8 py-8 text-center text-sm"
                      data-testid="administrators-no-matches"
                    >
                      No administrators match these filters.
                    </p>
                  ) : (
                    <div data-testid="administrators-table">
                      {sortMode === "orgUnit"
                        ? unitGroups.map((group) => (
                            <div key={group.key} data-testid={`administrators-unit-${group.key}`}>
                              <div className="bg-apollo-page border-apollo-border flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b px-5 py-2.5">
                                <span className="text-sm font-semibold">{group.unitName}</span>
                                <span className="text-muted-foreground text-[12.5px]">
                                  {KIND_LABEL[group.entityType]}
                                </span>
                                <span className="text-muted-foreground ml-auto text-xs whitespace-nowrap">
                                  {plural(group.admins.length, "administrator")}
                                </span>
                              </div>
                              {group.admins.map(({ entry, person, grant }) => (
                                <div
                                  key={entry.cwid}
                                  className={cn(
                                    ROW_GRID,
                                    "border-apollo-border border-b px-5 py-3",
                                  )}
                                  data-testid={`administrators-admin-${group.key}-${entry.cwid}`}
                                >
                                  {personCell(entry, person)}
                                  <div className="pl-12 md:pl-0">{roleControl(entry, grant)}</div>
                                  <span className="flex min-w-0 items-center gap-1.5 pl-12 text-[12.5px] md:pl-0">
                                    {isEdSourced(grant.source) && lockTile()}
                                    <span className="text-muted-foreground min-w-0 truncate">
                                      {grantSourceText(grant)}
                                    </span>
                                  </span>
                                  <div className="flex flex-col items-start gap-0.5 pl-12 md:pl-0">
                                    {viewAs(entry, person)}
                                    {grantAction(entry, grant)}
                                  </div>
                                </div>
                              ))}
                            </div>
                          ))
                        : personGroups.map(({ entry, person }, i) => personRow(entry, person, i))}
                    </div>
                  )}

                  <div
                    className="bg-apollo-page text-muted-foreground px-5 py-3 text-[13px]"
                    data-testid="administrators-footer"
                  >
                    {sortMode === "orgUnit"
                      ? `Showing ${plural(unitGroups.length, "org unit")}.`
                      : `Showing ${personGroups.length} of ${resolved.length} ${resolved.length === 1 ? "person" : "people"} · ${plural(shownGrants, "grant")}.`}
                  </div>
                </div>
              </section>
            </div>
          )}
        </>
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
  // Institutions (lib/institutions.ts) are a static catalog, seeded like cores.
  for (const [code, name] of Object.entries(INSTITUTIONS)) {
    const value = `institution:${code}`;
    seen.set(value, {
      value,
      entityType: "institution",
      entityId: code,
      unitName: name,
      label: `${name} · Institution`,
    });
  }
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
