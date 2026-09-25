/**
 * Functional roles: access that is not tied to an org unit (the
 * Administrators page's second tab). The vocabulary, labels, sources and scope
 * helpers live here so the client roster and the server loader/route share one
 * definition. Pure: no `@/lib/db`, no Node-only imports, safe in a
 * `"use client"` component. The DB side is `functional-roles.server.ts`.
 *
 * Registry only. No authorization gate reads `functional_role_grant` today;
 * access still comes from the ED groups (`comms_steward`, `development`) and
 * `report_access`. A row here records who holds the role and why.
 */

export const FUNCTIONAL_ROLES = ["external_communications", "development", "reporting"] as const;
export type FunctionalRole = (typeof FUNCTIONAL_ROLES)[number];

export function isFunctionalRole(value: unknown): value is FunctionalRole {
  return typeof value === "string" && (FUNCTIONAL_ROLES as readonly string[]).includes(value);
}

export const FUNCTIONAL_ROLE_LABEL: Record<FunctionalRole, string> = {
  external_communications: "External communications",
  development: "Development",
  reporting: "Reporting",
};

/** One line under the role name: what the role is for. */
export const FUNCTIONAL_ROLE_DESCRIPTION: Record<FunctionalRole, string> = {
  external_communications: "Edit overviews, headshots and Spotlight across all profiles",
  development: "Read-only access to profiles, funding and Reports for prospect research",
  reporting: "Reports and Insights for the scopes shown",
};

/** Where a row came from. "manual" rows are made on the Administrators page
 *  and are the only editable ones; the others mirror an existing mechanism
 *  and are reconciled by the import. */
export const FUNCTIONAL_ROLE_SOURCES = ["manual", "report_access", "allowlist"] as const;
export type FunctionalRoleSource = (typeof FUNCTIONAL_ROLE_SOURCES)[number];

/** The imported sources: read-only on the page. */
export function isImportedSource(source: string): boolean {
  return source !== "manual";
}

/** `granted_by` sentinel for an allowlist-imported row (the `"ED-ETL"`
 *  precedent on `unit_admin`). */
export const ALLOWLIST_GRANTER = "ALLOWLIST";

/** The wildcard scope: everything the role covers. */
export const ALL_SCOPE = "*";

/** A scope choice: the stored key and its label. */
export type FunctionalRoleScopeOption = { key: string; label: string };

/** Scope options per role. External communications and Development are
 *  institution-wide only; Reporting's options are built server-side from the
 *  person-granted report catalog (`reportingScopeOptions`). */
export type FunctionalRoleScopeOptions = Record<
  FunctionalRole,
  ReadonlyArray<FunctionalRoleScopeOption>
>;

export const INSTITUTION_SCOPE_OPTIONS: ReadonlyArray<FunctionalRoleScopeOption> = [
  { key: ALL_SCOPE, label: "All of WCM" },
];

/**
 * Normalize a scope list for storage: de-duplicated, sorted, and collapsed to
 * `["*"]` when the wildcard is present (a wildcard makes every other key
 * redundant). Order-stable so two equal sets compare equal as JSON.
 */
export function normalizeScopes(scopes: ReadonlyArray<string>): string[] {
  const set = new Set(scopes.map((s) => s.trim()).filter((s) => s.length > 0));
  if (set.has(ALL_SCOPE)) return [ALL_SCOPE];
  return [...set].sort();
}

/** Whether two normalized scope lists are the same set. */
export function sameScopes(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  const na = normalizeScopes(a);
  const nb = normalizeScopes(b);
  return na.length === nb.length && na.every((s, i) => s === nb[i]);
}

/** Read a stored `scopes` JSON value defensively: a string array, else []. */
export function scopesFromJson(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return normalizeScopes(value.filter((v): v is string => typeof v === "string"));
}

/** A scope key's label for one role, falling back to the raw key for a key
 *  the catalog no longer lists (so a stale key still renders, not vanishes). */
export function scopeLabel(
  options: FunctionalRoleScopeOptions,
  role: FunctionalRole,
  key: string,
): string {
  if (key === ALL_SCOPE) return role === "reporting" ? "All reports" : "All of WCM";
  return options[role].find((o) => o.key === key)?.label ?? key;
}

/** One functional-role assignment as the page renders it. */
export type FunctionalRoleRow = {
  role: FunctionalRole;
  cwid: string;
  source: string;
  scopes: string[];
  /** `Scholar.preferredName ?? granteeName ?? cwid`. */
  name: string;
  /** Scholar `primaryTitle`, when the holder has a Scholar row. */
  title: string | null;
  granteeName: string | null;
  grantedBy: string;
  /** The granter's Scholar name, when one resolves. */
  grantedByName: string | null;
  /** ISO timestamp. */
  grantedAt: string;
};
