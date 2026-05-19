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
 * The override value was sanitized on write (`lib/edit/validators.ts`
 * `sanitizeOverview`), so it is returned as-is — the public render's existing
 * raw `dangerouslySetInnerHTML` path needs no change (`self-edit-spec.md`
 * § The v1 editable-field set).
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
    return override.value === "" ? null : override.value;
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
