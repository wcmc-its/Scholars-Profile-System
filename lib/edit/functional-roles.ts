/**
 * Functional roles: access that is not tied to an org unit (the
 * Administrators page's second tab). The vocabulary, labels, sources and scope
 * helpers live here so the client roster and the server loader/route share one
 * definition. Pure: no `@/lib/db`, no Node-only imports, safe in a
 * `"use client"` component. The DB side is `functional-roles.server.ts`; the
 * gate-side reads are `lib/auth/functional-role-authz.ts`.
 *
 * Two roles:
 *   - External Affairs (`external_affairs`): ONE operational unit. Its
 *     functions, Communications and Development, are recorded on the grant
 *     as its scopes (`communications`, `development`). A person who works in
 *     both holds one grant with both functions. Communications corresponds to
 *     the existing `comms_steward` role, Development to the `development` role.
 *   - Reporting (`reporting`): report access, scoped per report.
 *
 * Authorization: while `FUNCTIONAL_ROLES_AUTHZ` is not "on" (the default in
 * every env), no gate reads `functional_role_grant` and the table is a
 * registry only. When it is "on", a manual grant ADDS access: External Affairs with
 * Communications admits `isCommsSteward`, with Development admits
 * `isDeveloper`, and a Reporting grant admits the report gate per scope. The
 * existing sources (ED groups, allowlists, `report_access`) keep working
 * either way. Imported rows (`report_access`, `allowlist`) never admit: they
 * only mirror a source that already does, and would outlive a revoke there.
 */

export const FUNCTIONAL_ROLES = ["external_affairs", "reporting"] as const;
export type FunctionalRole = (typeof FUNCTIONAL_ROLES)[number];

export function isFunctionalRole(value: unknown): value is FunctionalRole {
  return typeof value === "string" && (FUNCTIONAL_ROLES as readonly string[]).includes(value);
}

export const FUNCTIONAL_ROLE_LABEL: Record<FunctionalRole, string> = {
  external_affairs: "External Affairs",
  reporting: "Reporting",
};

/** One line under the role name: what the role is for. */
export const FUNCTIONAL_ROLE_DESCRIPTION: Record<FunctionalRole, string> = {
  external_affairs:
    "Communications edits overviews, headshots and Spotlight; Development gets prospect-research tools",
  reporting: "Reports and Insights for the scopes shown",
};

/** What a role's scope keys are called in the UI: External Affairs records
 *  functions, Reporting records report scopes. */
export const FUNCTIONAL_ROLE_SCOPE_NOUN: Record<FunctionalRole, string> = {
  external_affairs: "Functions",
  reporting: "Scope",
};

/** External Affairs functions: the scope keys an `external_affairs` grant
 *  carries. */
export const EXTERNAL_AFFAIRS_FUNCTIONS = ["communications", "development"] as const;
export type ExternalAffairsFunction = (typeof EXTERNAL_AFFAIRS_FUNCTIONS)[number];

export const EXTERNAL_AFFAIRS_FUNCTION_LABEL: Record<ExternalAffairsFunction, string> = {
  communications: "Communications",
  development: "Development",
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

/** The wildcard scope: everything the role covers (Reporting only). */
export const ALL_SCOPE = "*";

/** A scope choice: the stored key and its label. */
export type FunctionalRoleScopeOption = { key: string; label: string };

/** Scope options per role. External Affairs' options are its functions;
 *  Reporting's are built server-side from the person-granted report catalog
 *  (`reportingScopeOptions`). */
export type FunctionalRoleScopeOptions = Record<
  FunctionalRole,
  ReadonlyArray<FunctionalRoleScopeOption>
>;

/** External Affairs has no wildcard: each function is chosen explicitly. */
export const EXTERNAL_AFFAIRS_SCOPE_OPTIONS: ReadonlyArray<FunctionalRoleScopeOption> =
  EXTERNAL_AFFAIRS_FUNCTIONS.map((f) => ({ key: f, label: EXTERNAL_AFFAIRS_FUNCTION_LABEL[f] }));

/** The scopes a new assignment starts with in the Assign dialog: the wildcard
 *  when the role offers one (Reporting), else nothing (External Affairs: the
 *  functions are picked explicitly). */
export function defaultScopes(options: ReadonlyArray<FunctionalRoleScopeOption>): string[] {
  return options.some((o) => o.key === ALL_SCOPE) ? [ALL_SCOPE] : [];
}

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
  if (key === ALL_SCOPE) return role === "reporting" ? "All reports" : "All functions";
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

// ─── Authorization mapping (pure: shared by the gates and the parity check) ──

/** Whether a set of External Affairs grant scopes carries `fn`. */
export function scopesCarryFunction(
  scopes: ReadonlyArray<string>,
  fn: ExternalAffairsFunction,
): boolean {
  return scopes.includes(fn);
}

/**
 * The `report_access`-shaped scope keys a Reporting grant's scopes admit on
 * `reportKey`: `"*"` (the whole report) for the wildcard or the bare report
 * key, plus the `scope` of each `reportKey:scope` sub-scope. Empty when the
 * grant says nothing about this report.
 */
export function reportScopesFromRegistry(
  scopes: ReadonlyArray<string>,
  reportKey: string,
): Set<string> {
  const out = new Set<string>();
  for (const s of scopes) {
    if (s === ALL_SCOPE || s === reportKey) out.add(ALL_SCOPE);
    else if (s.startsWith(`${reportKey}:`)) out.add(s.slice(reportKey.length + 1));
  }
  return out;
}

/** Someone who holds access through an EXISTING, enumerable gate, as the
 *  parity check sees them: External Affairs by allowlist, Reporting by
 *  `report_access`. (ED group members cannot be listed; see the server lib.) */
export type GateHolder =
  | {
      role: "external_affairs";
      cwid: string;
      name: string | null;
      /** The function the gate confers. */
      scope: ExternalAffairsFunction;
      via: "comms_steward_allowlist" | "development_allowlist";
    }
  | {
      role: "reporting";
      cwid: string;
      name: string | null;
      reportKey: string;
      /** The `report_access.scope_key` (`"*"` = whole report). */
      scope: string;
      via: "report_access";
    };

/** What a registry row must carry to cover a holder, in words. */
export function gateHolderNeed(h: GateHolder): string {
  if (h.role === "external_affairs") return EXTERNAL_AFFAIRS_FUNCTION_LABEL[h.scope];
  return h.scope === ALL_SCOPE ? h.reportKey : `${h.reportKey}:${h.scope}`;
}

/**
 * The parity check: every current holder by an existing gate whose access the
 * registry would NOT reproduce, i.e. no row (from any source) for that role
 * and person that carries the function or admits the report scope. Pure; the
 * Functional roles tab and `scripts/functional-roles-parity.ts` both call it,
 * with the same mapping the gates use, so `FUNCTIONAL_ROLES_AUTHZ` can be
 * checked before the registry is ever relied on alone.
 */
export function parityGaps(
  holders: ReadonlyArray<GateHolder>,
  rows: ReadonlyArray<Pick<FunctionalRoleRow, "role" | "cwid" | "scopes">>,
): GateHolder[] {
  const byKey = new Map<string, string[][]>();
  for (const r of rows) {
    const k = `${r.role}:${r.cwid.toLowerCase()}`;
    const list = byKey.get(k) ?? [];
    list.push(r.scopes);
    byKey.set(k, list);
  }
  return holders.filter((h) => {
    const held = byKey.get(`${h.role}:${h.cwid.toLowerCase()}`) ?? [];
    if (h.role === "external_affairs") {
      return !held.some((s) => scopesCarryFunction(s, h.scope));
    }
    return !held.some((s) => {
      const admitted = reportScopesFromRegistry(s, h.reportKey);
      return admitted.has(ALL_SCOPE) || admitted.has(h.scope);
    });
  });
}
