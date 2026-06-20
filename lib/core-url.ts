/**
 * Canonical path to a public per-core page. `Core` has no slug, so the route is
 * keyed on the dictionary core id (e.g. "2"), exactly like the owner queue at
 * `/edit/core/[coreId]`. Centralized so the modal link, the page's own canonical,
 * and any future inbound links all agree.
 */
export function corePath(coreId: string): string {
  return `/cores/${encodeURIComponent(coreId)}`;
}
