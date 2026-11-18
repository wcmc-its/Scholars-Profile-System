/**
 * Which WCM author a legacy VIVO publication URL (`/display/pubid<PMID>`)
 * belongs to. Shared by the `/scholars/by-pmid/[pmid]` redirect and the
 * nginx map generator (etl/vivo-redirect/generate-map.ts, D-06/D-07).
 */

/**
 * One confirmed, ACTIVE WCM author of a single publication. The DB query
 * filters to confirmed authorships whose scholar is active + non-deleted, so
 * every row here is already a live profile (D-07's "active" hard gate). `cwid`
 * is carried only for a deterministic final tiebreak.
 */
export type PubAuthorRow = {
  cwid: string;
  slug: string;
  isFirst: boolean;
  isLast: boolean;
  position: number; // 1-based author position
};

/**
 * D-07 author pick. Given every confirmed+active WCM author of ONE publication,
 * return the slug of the single author the pubid should redirect to, or null if
 * the list is empty (→ D-08 fall-through). Priority: first author, else senior
 * (last) author, else earliest remaining rank (lowest position). Position is
 * unique per paper, so the final cwid tiebreak is only a determinism backstop.
 */
export function pickPubAuthorSlug(rows: PubAuthorRow[]): string | null {
  if (rows.length === 0) return null;
  const first = rows.find((r) => r.isFirst);
  if (first) return first.slug;
  const last = rows.find((r) => r.isLast);
  if (last) return last.slug;
  const earliest = [...rows].sort(
    (a, b) => a.position - b.position || a.cwid.localeCompare(b.cwid),
  )[0];
  return earliest.slug;
}

