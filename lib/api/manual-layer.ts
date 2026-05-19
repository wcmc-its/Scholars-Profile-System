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
import { sanitizeOverviewHtml } from "@/lib/edit/validators";
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
