/**
 * Self-edit v1 — the read-merge layer (#356; ADR-005 § read-merge).
 *
 * Two manual-override mechanisms are read here:
 *
 *  - `field_override` — human-entered data that survives every ETL rebuild; at
 *    read time it takes precedence over the ETL-managed column it shadows. v1
 *    runtime-merges exactly one field, `overview` (`getEffectiveOverview`) —
 *    hence a single function, not the generic `Merged<T>` machinery ADR-005
 *    anticipates; that generalization earns its ceremony only once a second
 *    field is runtime-merged. (`slug` is override-able too, but a slug override
 *    is consumed by `etl/ed`, not merged at runtime.)
 *
 *  - `suppression` — whole-publication takedowns and per-author hides, applied
 *    as a query-time predicate (`loadPublicationSuppressions` + `isAuthorHidden`
 *    + `isPublicationDark`). `Suppression` has no FK / Prisma relation to
 *    `Publication` or `PublicationAuthor` (ADR-005 § Keying — a suppression row
 *    must be able to outlive a hard-deleted target), so it cannot be a nested
 *    Prisma `where`; it is loaded per request, scoped to the pmids in hand, and
 *    applied in code.
 */
import { sanitizeOverviewHtml, validateSelectedHighlightPmids } from "@/lib/edit/validators";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { sanitizeVIVOHtml } from "@/lib/utils";

/** The Prisma surface `getEffectiveOverview` needs — a client or a tx satisfies it. */
type OverrideReadClient = Pick<PrismaClient, "fieldOverride">;

/**
 * The effective `overview` for a scholar.
 *
 * If a `field_override(scholar, cwid, 'overview')` row exists it is
 * **authoritative** — including an empty value, which is the scholar
 * deliberately clearing their bio; the ETL seed is not shown in that case.
 * The override was sanitized on write (`lib/edit/validators.ts`
 * `sanitizeOverview`); it is **re-sanitized here on read** (`sanitizeOverviewHtml`)
 * as defense-in-depth — the public profile renders this value through a raw
 * `dangerouslySetInnerHTML`, so a value that ever reached the column
 * unsanitized (a second writer, a migration, direct SQL) must not pass through.
 *
 * With no override, the ETL-managed `Scholar.overview` column is used, cleaned
 * of legacy VIVO serializer artifacts.
 *
 * Returns `null` for "no overview" — an absent column, or an override whose
 * sanitized value is the empty string.
 */
export async function getEffectiveOverview(
  cwid: string,
  etlOverview: string | null,
  client: OverrideReadClient,
): Promise<string | null> {
  const override = await client.fieldOverride.findUnique({
    where: {
      entityType_entityId_fieldName: {
        entityType: "scholar",
        entityId: cwid,
        fieldName: "overview",
      },
    },
    select: { value: true },
  });
  if (override) {
    // Empty value — the scholar deliberately cleared their bio.
    if (override.value === "") return null;
    // Re-sanitize on read (defense-in-depth) — see the function doc above.
    const clean = sanitizeOverviewHtml(override.value);
    return clean === "" ? null : clean;
  }
  return etlOverview ? sanitizeVIVOHtml(etlOverview) : null;
}

// ---------------------------------------------------------------------------
// selectedHighlightPmids — #836 opt-in manual Highlights override (read side)
// ---------------------------------------------------------------------------

/**
 * The scholar's hand-picked Highlights PMIDs, in display order, or `null` when
 * no manual override exists (the AI selection then stands).
 *
 * Reads the `field_override(scholar, cwid, 'selectedHighlightPmids')` row and
 * parses its stored JSON array via {@link validateSelectedHighlightPmids}. A
 * malformed stored value (should never happen — the write path validates) is
 * treated as "no override" rather than throwing, so a corrupt row can never
 * 500 a public profile; it just falls back to the AI selection.
 *
 * Membership-in-the-scholar's-pubs is NOT enforced here — that needs the
 * scholar's visible publication set, which the caller already has. Apply
 * {@link pickManualHighlights} over the parsed PMIDs and the visible set to get
 * the final, suppression-respecting Highlights list.
 */
export async function getSelectedHighlightPmids(
  cwid: string,
  client: OverrideReadClient,
): Promise<readonly string[] | null> {
  const override = await client.fieldOverride.findUnique({
    where: {
      entityType_entityId_fieldName: {
        entityType: "scholar",
        entityId: cwid,
        fieldName: "selectedHighlightPmids",
      },
    },
    select: { value: true },
  });
  if (!override) return null;
  const parsed = validateSelectedHighlightPmids(override.value);
  if (!parsed.ok) return null;
  return parsed.value;
}

/**
 * Resolve the effective Highlights for a profile (#836), pure and DB-free so it
 * is unit-testable in isolation.
 *
 * `visible` is the scholar's already-suppression-filtered, rankable publication
 * pool (every confirmed, non-hidden authorship — `lib/api/profile.ts`
 * `rankablePubs`). `aiHighlights` is the AI-ranked top-N slice computed from
 * that same pool. `manualPmids` is the stored override (or `null`).
 *
 * Precedence:
 *   - no override (`null`) → the AI selection, unchanged (default behavior);
 *   - an override → the publications named by `manualPmids`, IN THAT ORDER,
 *     looked up in `visible`. Any PMID not in `visible` (suppressed since the
 *     pick, or never the scholar's) is silently dropped — so a manual set can
 *     never resurface a suppressed publication, and a stale pick degrades
 *     gracefully. If every manual PMID drops out (e.g. all suppressed), the
 *     result is the AI selection again, never an empty Highlights surface from a
 *     stale override.
 *
 * Returns publications drawn from `visible` (full `T`), so the caller's render
 * shape is identical whether the highlights are AI- or manually-chosen.
 */
export function pickManualHighlights<T extends { pmid: string }>(
  visible: readonly T[],
  aiHighlights: readonly T[],
  manualPmids: readonly string[] | null,
): T[] {
  if (manualPmids === null || manualPmids.length === 0) return [...aiHighlights];
  const byPmid = new Map(visible.map((p) => [p.pmid, p]));
  const picked: T[] = [];
  for (const pmid of manualPmids) {
    const pub = byPmid.get(pmid);
    if (pub) picked.push(pub);
  }
  // Every manual pick dropped out (all suppressed / out-of-set) → fall back to
  // the AI selection rather than render an empty Highlights section.
  return picked.length > 0 ? picked : [...aiHighlights];
}

// ---------------------------------------------------------------------------
// Publication suppression — the query-time read predicate
// (ADR-005 § "Publication suppression"; self-edit-spec.md § Hide a publication).
// ---------------------------------------------------------------------------

/** The Prisma surface the publication-suppression loader needs — a client or a
 *  tx satisfies it. */
type SuppressionReadClient = Pick<PrismaClient, "suppression">;

/**
 * The active publication suppressions covering a bounded set of pmids.
 *
 * Two kinds, per ADR-005: a whole-publication takedown (`contributorCwid` null)
 * darkens the publication outright; a per-author hide (`contributorCwid` set)
 * removes one WCM author from it.
 */
export type PublicationSuppressions = {
  /** pmids carrying an active whole-publication takedown. */
  readonly darkPmids: ReadonlySet<string>;
  /** Per-author hides — pmid → the set of cwids hidden on that publication. */
  readonly hiddenAuthorsByPmid: ReadonlyMap<string, ReadonlySet<string>>;
};

/** Shared empty result — the no-suppression path allocates nothing. */
const NO_PUBLICATION_SUPPRESSIONS: PublicationSuppressions = {
  darkPmids: new Set(),
  hiddenAuthorsByPmid: new Map(),
};

/**
 * Load every active publication suppression covering `pmids`, in one query.
 *
 * Per-request and pmid-scoped by design. ADR-005 makes the Aurora suppression
 * merge query-time and immediate — reversible with no rebuild — so the result
 * is never cached across requests; a TTL cache would reintroduce exactly the
 * staleness window suppression exists to close. The `@@index([entityType,
 * entityId])` on `suppression` serves the `entityId IN (...)` lookup.
 */
export async function loadPublicationSuppressions(
  pmids: readonly string[],
  client: SuppressionReadClient,
): Promise<PublicationSuppressions> {
  if (pmids.length === 0) return NO_PUBLICATION_SUPPRESSIONS;
  const rows = await client.suppression.findMany({
    where: {
      entityType: "publication",
      entityId: { in: [...new Set(pmids)] },
      revokedAt: null,
    },
    select: { entityId: true, contributorCwid: true },
  });
  if (rows.length === 0) return NO_PUBLICATION_SUPPRESSIONS;
  const darkPmids = new Set<string>();
  const hiddenAuthorsByPmid = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.contributorCwid === null) {
      darkPmids.add(row.entityId);
    } else {
      const hidden = hiddenAuthorsByPmid.get(row.entityId) ?? new Set<string>();
      hidden.add(row.contributorCwid);
      hiddenAuthorsByPmid.set(row.entityId, hidden);
    }
  }
  return { darkPmids, hiddenAuthorsByPmid };
}

/**
 * Load every active publication suppression in the table — **for the batch ETL
 * build only.**
 *
 * `etl/search-index` processes the whole corpus in one batch and has no
 * per-request staleness concern, so reading the whole `suppression` table in a
 * single round trip is correct and cheap (the active set is small).
 *
 * The per-request query path **must not** use this loader. ADR-005 makes the
 * Aurora suppression merge query-time and immediate — reversible with no
 * rebuild — and a process- or request-scope cache of the whole table would
 * reintroduce exactly the staleness window suppression exists to close.
 * Per-request reads must call the pmid-scoped {@link loadPublicationSuppressions}.
 */
export async function loadAllPublicationSuppressions(
  client: SuppressionReadClient,
): Promise<PublicationSuppressions> {
  const rows = await client.suppression.findMany({
    where: { entityType: "publication", revokedAt: null },
    select: { entityId: true, contributorCwid: true },
  });
  if (rows.length === 0) return NO_PUBLICATION_SUPPRESSIONS;
  const darkPmids = new Set<string>();
  const hiddenAuthorsByPmid = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.contributorCwid === null) {
      darkPmids.add(row.entityId);
    } else {
      const hidden = hiddenAuthorsByPmid.get(row.entityId) ?? new Set<string>();
      hidden.add(row.contributorCwid);
      hiddenAuthorsByPmid.set(row.entityId, hidden);
    }
  }
  return { darkPmids, hiddenAuthorsByPmid };
}

// ---------------------------------------------------------------------------
// Whole-entity suppression (grant / education / appointment) — #160.
//
// These entities are suppressed whole, keyed on the stable `externalId` (#352);
// they carry no contributor dimension (a Grant row is already per-investigator,
// so hiding one investigator's role is just suppressing that row — ADR-005
// keying / #160 D1). So a plain set of suppressed `externalId`s is the whole
// read predicate, simpler than the publication contributor map above.
// ---------------------------------------------------------------------------

/** The entity types suppressed whole by stable `externalId` (#160). */
export type WholeEntityType = "grant" | "education" | "appointment";

/**
 * The active (`revokedAt IS NULL`) suppressed `externalId`s of one whole-entity
 * type, scoped to the ids in hand. Per-request and never cached — the same
 * ADR-005 immediacy rule as {@link loadPublicationSuppressions}; a TTL cache
 * would reintroduce the staleness window suppression exists to close. The
 * `@@index([entityType, entityId])` on `suppression` serves the lookup.
 */
export async function loadEntitySuppressions(
  entityType: WholeEntityType,
  externalIds: readonly string[],
  client: SuppressionReadClient,
): Promise<ReadonlySet<string>> {
  if (externalIds.length === 0) return new Set();
  const rows = await client.suppression.findMany({
    where: {
      entityType,
      entityId: { in: [...new Set(externalIds)] },
      revokedAt: null,
    },
    select: { entityId: true },
  });
  return new Set(rows.map((r) => r.entityId));
}

/**
 * Every active suppressed grant `externalId` in the table — **batch only**
 * (the funding search index build, #160 PR-B). One round trip over the small
 * active grant-suppression set, mirroring {@link loadAllPublicationSuppressions}.
 * The per-request path must use the id-scoped {@link loadEntitySuppressions}
 * instead (ADR-005 immediacy — no whole-table cache on a request).
 */
export async function loadAllGrantSuppressions(
  client: SuppressionReadClient,
): Promise<ReadonlySet<string>> {
  const rows = await client.suppression.findMany({
    where: { entityType: "grant", revokedAt: null },
    select: { entityId: true },
  });
  return new Set(rows.map((r) => r.entityId));
}

/**
 * Resolve #160 grant suppression for a set of active grant rows.
 *
 * A grant row is per-investigator and keyed on its stable `externalId` (#352);
 * a suppression on that `externalId` hides exactly that row (ADR-005 keying /
 * #160 D1). This is the shared predicate for the aggregate grant surfaces —
 * department / division / center listings and their active-grant counts — so
 * the Grants-tab list, its badge, and the hero stat all drop the same rows and
 * stay in agreement (#481(b): suppressed grants must neither list nor inflate a
 * count). Mirrors the row-drop the funding search-index build applies before
 * grouping (`etl/search-index/index.ts`).
 *
 * Returns the active suppressed `externalId` set (for filtering rows before
 * grouping) and the distinct unsuppressed key count (`externalId`, or `id` when
 * `externalId` is null — a null id can carry no suppression). Per-request and
 * id-scoped via {@link loadEntitySuppressions}, never the whole-table batch
 * load, per the ADR-005 immediacy rule.
 */
export async function resolveActiveGrantSuppression(
  rows: ReadonlyArray<{ externalId: string | null; id: string }>,
  client: SuppressionReadClient,
): Promise<{ suppressed: ReadonlySet<string>; unsuppressedKeyCount: number }> {
  const externalIds = rows
    .map((r) => r.externalId)
    .filter((x): x is string => x !== null);
  const suppressed = await loadEntitySuppressions("grant", externalIds, client);
  const keys = new Set<string>();
  for (const r of rows) {
    if (r.externalId !== null && suppressed.has(r.externalId)) continue;
    keys.add(r.externalId ?? r.id);
  }
  return { suppressed, unsuppressedKeyCount: keys.size };
}

/**
 * True when this `(pmid, cwid)` WCM authorship is hidden by an active per-author
 * suppression — the scholar must then be omitted from that publication's
 * rendered author chips, profile links, and author-derived counts
 * (`self-edit-spec.md` § Hide a publication).
 */
export function isAuthorHidden(
  suppressions: PublicationSuppressions,
  pmid: string,
  cwid: string,
): boolean {
  return suppressions.hiddenAuthorsByPmid.get(pmid)?.has(cwid) ?? false;
}

/**
 * True when a publication must not be shown anywhere — either an explicit
 * whole-publication takedown, or the derived rule: every confirmed, site-visible
 * WCM author has a per-author hide, so zero displayed authors remain
 * (`self-edit-spec.md` audit query B; ADR-005 § "Publication suppression").
 *
 * `confirmedWcmAuthorCwids` is the pmid's confirmed WCM authors whose scholar is
 * site-visible (`status='active' AND deletedAt IS NULL`) — the set every read
 * surface already resolves from its existing author include. An empty set is
 * **not** derived-dark: a publication with no confirmed WCM authorship has no
 * displayed-author signal to derive from, and is dark only by explicit takedown.
 */
export function isPublicationDark(
  suppressions: PublicationSuppressions,
  pmid: string,
  confirmedWcmAuthorCwids: readonly string[],
): boolean {
  if (suppressions.darkPmids.has(pmid)) return true;
  if (confirmedWcmAuthorCwids.length === 0) return false;
  return confirmedWcmAuthorCwids.every((cwid) =>
    isAuthorHidden(suppressions, pmid, cwid),
  );
}

/**
 * The subset of `pmids` that are dark — a whole-publication takedown, or every
 * confirmed site-visible WCM author per-author-hidden (`isPublicationDark`).
 *
 * The derived-dark branch needs each candidate's confirmed WCM author set; that
 * is queried only for pmids that actually carry a per-author hide — typically
 * none — so this adds at most one bounded query. For the member-scoped listing
 * surfaces (center / department / division), whose pool query yields pmids
 * without author sets, this resolves pool darkness before pagination.
 */
export async function resolveDarkPmids(
  pmids: readonly string[],
  suppressions: PublicationSuppressions,
  client: Pick<PrismaClient, "publicationAuthor">,
): Promise<Set<string>> {
  const dark = new Set<string>();
  for (const pmid of pmids) {
    if (suppressions.darkPmids.has(pmid)) dark.add(pmid);
  }
  // Only a pmid carrying a per-author hide can be derived-dark. `suppressions`
  // was loaded for `pmids`, so these keys are already a subset of `pmids`.
  const candidates = [...suppressions.hiddenAuthorsByPmid.keys()].filter(
    (pmid) => !dark.has(pmid),
  );
  if (candidates.length === 0) return dark;
  const rows = await client.publicationAuthor.findMany({
    where: {
      pmid: { in: candidates },
      isConfirmed: true,
      cwid: { not: null },
      scholar: { deletedAt: null, status: "active" },
    },
    select: { pmid: true, cwid: true },
  });
  const authorCwidsByPmid = new Map<string, string[]>();
  for (const row of rows) {
    if (row.cwid === null) continue;
    const arr = authorCwidsByPmid.get(row.pmid) ?? [];
    arr.push(row.cwid);
    authorCwidsByPmid.set(row.pmid, arr);
  }
  for (const pmid of candidates) {
    if (isPublicationDark(suppressions, pmid, authorCwidsByPmid.get(pmid) ?? [])) {
      dark.add(pmid);
    }
  }
  return dark;
}

// ---------------------------------------------------------------------------
// Unit curation — field overrides + whole-unit suppression
// (#540 / ADR-005 Amendment 1 § A1.1.)
//
// Two read shapes for organizational units:
//
//  1. `field_override` rows on Department / Division — `description`, `url`,
//     `slug`, `leaderCwid`, `leaderInterim`. Merged at read time by the unit page.
//     **Centers do not use `field_override`** — a center row is manually-owned
//     (no ETL writes the `center` table), so its fields are edited in-row
//     and the in-row values are authoritative.
//
//  2. Whole-unit suppression — a `suppression` row keyed on the unit `code`,
//     with `contributorCwid` always NULL. A suppressed unit's public page
//     returns 404; the search index drops its facet on the nightly rebuild.
//
// Unit reads are page-scoped (one unit per request), so the helpers below are
// keyed on a single `(entityType, code)` pair, not the batch IN-list shape
// the publication / grant suppressions use.
// ---------------------------------------------------------------------------

/** The three unit `EntityType` values manual-layer reads cover. */
export type UnitEntityType = "department" | "division" | "center";

/**
 * The full set of unit `field_override` field names. Dept / div use all five;
 * a `field_override` row for a center is rejected at write time
 * (centers edit in-row), so a center read never observes one — but the type
 * is shared because the merged-shape consumers do not branch on unit kind.
 *
 * - `description` — plain-text prose blurb (≤ 4,000 chars).
 * - `url` — outbound website URL (#1021); https-only, ≤ 512 chars.
 * - `slug` — URL segment; ETL consults it before re-deriving on `etl/ed`.
 * - `leaderCwid` — Chair / Chief / Director CWID, or `""` for "no leader".
 * - `leaderInterim` — `"true"` / `"false"`; renders the interim qualifier.
 *
 * Values are typed as the raw `field_override.value` (`string`) — boolean
 * coercion is the merge helper's job, not this loader's.
 */
export type UnitFieldOverrideName =
  | "description"
  | "url"
  | "slug"
  | "leaderCwid"
  | "leaderInterim";

/** A bag of `field_override` values keyed by `fieldName`, for one unit. */
export type UnitFieldOverrides = Partial<Record<UnitFieldOverrideName, string>>;

const UNIT_FIELD_OVERRIDE_NAMES: readonly UnitFieldOverrideName[] = [
  "description",
  "url",
  "slug",
  "leaderCwid",
  "leaderInterim",
];

/**
 * Load every active `field_override` row for one unit, returned as a bag
 * keyed on `fieldName`. The empty result allocates nothing.
 *
 * One query, `@@unique([entityType, entityId, fieldName])` index serves it.
 * The Aurora suppression-style immediacy rule (ADR-005 § Write-path failure
 * model) applies: per-request, never cached — a TTL cache would reintroduce
 * the staleness window the manual layer exists to close.
 *
 * Centers are accepted but always return `{}` — the write path rejects
 * `field_override` writes for centers (they edit in-row), so the loader
 * short-circuits before issuing a query.
 */
export async function loadUnitFieldOverrides(
  entityType: UnitEntityType,
  code: string,
  client: OverrideReadClient,
): Promise<UnitFieldOverrides> {
  if (entityType === "center") return {};
  const rows = await client.fieldOverride.findMany({
    where: {
      entityType,
      entityId: code,
      fieldName: { in: [...UNIT_FIELD_OVERRIDE_NAMES] },
    },
    select: { fieldName: true, value: true },
  });
  if (rows.length === 0) return {};
  const out: UnitFieldOverrides = {};
  for (const row of rows) {
    // The write path validates `fieldName ∈ UNIT_FIELD_OVERRIDE_NAMES` per
    // entity type, so the cast is safe. Unknown values are dropped rather
    // than thrown — a forward-compatible read after a future field is added.
    if ((UNIT_FIELD_OVERRIDE_NAMES as readonly string[]).includes(row.fieldName)) {
      out[row.fieldName as UnitFieldOverrideName] = row.value;
    }
  }
  return out;
}

/**
 * The per-field merge over a Department / Division row.
 *
 * Field-level precedence (ADR-005 § read-merge):
 *
 * | Field           | Override wins on               | Read fallback             |
 * |-----------------|--------------------------------|---------------------------|
 * | `description`   | a non-undefined override row   | the column                |
 * | `url`           | a non-undefined override row   | the column                |
 * | `slug`          | (consumed by `etl/ed` write)   | the column (do not merge) |
 * | `leaderCwid`    | a non-undefined override row,  | the column                |
 * |                 | including `""` = no leader     |                           |
 * | `leaderInterim` | a non-undefined override row   | `false` (no column)       |
 *
 * `slug` is **NOT runtime-merged**: the ETL consults the override before
 * writing the column, so by the time a read happens the column already
 * carries the override's value. Including it here would invite double-write
 * lag. The function therefore takes the override bag and the row and emits
 * the three columns that *are* runtime-merged.
 *
 * Returns the column when the override is `undefined`; passes `""` through
 * for `leaderCwid` as "explicitly cleared" — the caller decides whether to
 * render "No chair" / "Director vacant" or fall back to ADR-002 auto-detection.
 *
 * Boolean coercion for `leaderInterim`: `"true"` -> true, `"false"` -> false,
 * any other override value -> the row's stored value (defensive; the write
 * path validates).
 */
export type UnitRowFieldsForMerge = {
  description: string | null;
  /** #1021 — outbound website URL; same override-or-column precedence as description. */
  url?: string | null;
  leaderCwid: string | null;
  /** For Center this is the in-row `leader_interim`; for dept/div there is no column. */
  leaderInterim?: boolean;
};

export type MergedUnitFields = {
  description: string | null;
  /** #1021 — outbound website URL; `""`/`null` both mean "render nothing". */
  url: string | null;
  /** `""` = explicitly cleared by curator (different from `null` = no row / no override). */
  leaderCwid: string | null;
  leaderInterim: boolean;
};

export function mergeUnitFields(
  row: UnitRowFieldsForMerge,
  overrides: UnitFieldOverrides,
): MergedUnitFields {
  const description = overrides.description !== undefined ? overrides.description : row.description;
  const url = overrides.url !== undefined ? overrides.url : (row.url ?? null);
  const leaderCwid = overrides.leaderCwid !== undefined ? overrides.leaderCwid : row.leaderCwid;
  let leaderInterim: boolean;
  if (overrides.leaderInterim === "true") leaderInterim = true;
  else if (overrides.leaderInterim === "false") leaderInterim = false;
  else leaderInterim = row.leaderInterim ?? false;
  return { description, url, leaderCwid, leaderInterim };
}

/**
 * Is this unit suppressed?
 *
 * A whole-unit retire is a `suppression` row with `contributorCwid = NULL`
 * targeting the unit `code`. One row is enough — the same target can be
 * re-suppressed after a revoke, so the predicate is "any active row exists",
 * not "exactly one".
 *
 * Returns `true` iff at least one matching `revokedAt IS NULL` row exists.
 * Page-scoped helper (one unit per request); never cached — same ADR-005
 * immediacy rule as the publication suppression loader.
 */
export async function isUnitSuppressed(
  entityType: UnitEntityType,
  code: string,
  client: SuppressionReadClient,
): Promise<boolean> {
  const row = await client.suppression.findFirst({
    where: { entityType, entityId: code, revokedAt: null },
    select: { id: true },
  });
  return row !== null;
}

/**
 * Per-cwid count of active per-author publication hides — for adjusting a
 * scholar's publication-count badge. Each active per-author `suppression` row
 * is one confirmed authorship the scholar removed from public view, so a
 * count aggregated over `publication_author` overcounts by this much
 * (`self-edit-spec.md` § Hide a publication — counts update site-wide).
 *
 * A whole-publication takedown also lowers a scholar's count, but rarely
 * (superuser-only) and accounting for it needs an author join — deferred with
 * the other `publicationTopic`-keyed secondary counts (D5.1).
 */
export async function loadHiddenAuthorshipCounts(
  cwids: readonly string[],
  client: SuppressionReadClient,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (cwids.length === 0) return counts;
  const rows = await client.suppression.findMany({
    where: {
      entityType: "publication",
      contributorCwid: { in: [...new Set(cwids)] },
      revokedAt: null,
    },
    select: { contributorCwid: true },
  });
  for (const row of rows) {
    if (row.contributorCwid === null) continue;
    counts.set(row.contributorCwid, (counts.get(row.contributorCwid) ?? 0) + 1);
  }
  return counts;
}
