import { prisma } from "@/lib/db";
import { isPubliclyDisplayed, publicRoleWhere } from "@/lib/eligibility";

/**
 * Result of resolving a URL path component to a scholar.
 *
 * `found` — the input is the current canonical key for an active scholar; render the page.
 * `redirect` — the input is a former slug (or former CWID) for an active scholar; emit a 301 to `targetSlug`.
 * `not-found` — no live mapping exists; render 404 (or, for VIVO redirects, fall through to /search?q=name).
 *
 * #2268 — a #536 hidden identity class resolves to `not-found`, byte-identical to a
 * CWID/slug that never existed. Both resolvers feed anonymous, force-dynamic public
 * routes that call `permanentRedirect()`, so a resolved row leaves the building as a
 * `Location` header before the destination page's render-time carve can run. Slugs are
 * name-derived (`deriveSlug(preferredName)`, etl/ed/index.ts), so a 308 for a harvested
 * CWID published the hidden student's NAME plus an existence oracle. Same two-layer
 * shape as #2257: `publicRoleWhere()` in the where-clause, then a fail-closed
 * `isPubliclyDisplayed` on the RAW `role_category` column, because Prisma cannot express
 * the `doctoral_student*` prefix the predicate matches.
 */
export type ResolveResult =
  | { type: "found"; cwid: string; slug: string }
  | { type: "redirect"; targetSlug: string }
  | { type: "not-found" };

/**
 * Resolve a slug candidate (the value in `/scholars/[slug]`).
 * Lookup order: scholar.slug → slug_history → not-found.
 * Soft-deleted (deletedAt != NULL), suppressed and hidden-role scholars do not resolve.
 */
export async function resolveBySlugOrHistory(slug: string): Promise<ResolveResult> {
  if (!slug) return { type: "not-found" };

  const direct = await prisma.scholar.findFirst({
    where: { slug, deletedAt: null, status: "active", ...publicRoleWhere() },
    select: { cwid: true, slug: true, roleCategory: true },
  });
  if (direct && isPubliclyDisplayed(direct.roleCategory)) {
    return { type: "found", cwid: direct.cwid, slug: direct.slug };
  }

  // findFirst, not findUnique: the carve is a relation filter on `current`, and
  // findUnique's where accepts unique fields only. `oldSlug` is still the PK.
  const history = await prisma.slugHistory.findFirst({
    where: { oldSlug: slug, current: { ...publicRoleWhere() } },
    select: {
      current: { select: { slug: true, deletedAt: true, status: true, roleCategory: true } },
    },
  });
  if (
    history?.current &&
    !history.current.deletedAt &&
    history.current.status === "active" &&
    isPubliclyDisplayed(history.current.roleCategory)
  ) {
    return { type: "redirect", targetSlug: history.current.slug };
  }

  return { type: "not-found" };
}

/**
 * Resolve a CWID candidate (the value in `/scholars/by-cwid/[cwid]`).
 * Lookup order: scholar.cwid → cwid_aliases → not-found.
 * Soft-deleted, suppressed and hidden-role scholars do not resolve.
 */
export async function resolveByCwidOrAlias(cwid: string): Promise<ResolveResult> {
  if (!cwid) return { type: "not-found" };

  const direct = await prisma.scholar.findFirst({
    where: { cwid, deletedAt: null, status: "active", ...publicRoleWhere() },
    select: { cwid: true, slug: true, roleCategory: true },
  });
  if (direct && isPubliclyDisplayed(direct.roleCategory)) {
    return { type: "redirect", targetSlug: direct.slug };
  }

  const alias = await prisma.cwidAlias.findFirst({
    where: { oldCwid: cwid, current: { ...publicRoleWhere() } },
    select: {
      current: { select: { slug: true, deletedAt: true, status: true, roleCategory: true } },
    },
  });
  if (
    alias?.current &&
    !alias.current.deletedAt &&
    alias.current.status === "active" &&
    isPubliclyDisplayed(alias.current.roleCategory)
  ) {
    return { type: "redirect", targetSlug: alias.current.slug };
  }

  return { type: "not-found" };
}
