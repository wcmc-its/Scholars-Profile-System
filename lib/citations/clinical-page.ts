/**
 * Paging of the publication modal's "Clinical studies" group. Imported by the
 * modal (client) and the route's read (server), so it imports nothing.
 *
 * Clinical studies are not cut at a cap: one paper has about 5,200, and a count
 * is only shown where the whole list can be opened. They are sent a page at a
 * time, and every page starts on a multiple of the page size.
 */
export const CLINICAL_PAGE_SIZE = 50;
/** Far past the longest list; bounds the offsets the public route accepts. */
const CLINICAL_MAX_OFFSET = 100_000;

/**
 * The offset of a page, from a route segment: a whole multiple of the page
 * size, written plainly ("0", "50", "100"). Null for anything else, so one
 * page has one URL.
 */
export function parseClinicalOffset(raw: string): number | null {
  if (!/^(0|[1-9]\d{0,5})$/.test(raw)) return null;
  const n = Number(raw);
  return n <= CLINICAL_MAX_OFFSET && n % CLINICAL_PAGE_SIZE === 0 ? n : null;
}

/** Where the modal fetches the page of clinical studies that starts at `offset`. */
export const clinicalCitationsPath = (pmid: string, offset: number): string =>
  `/api/publications/${encodeURIComponent(pmid)}/clinical-citations/${offset}`;
