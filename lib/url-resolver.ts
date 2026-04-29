import { prisma } from "@/lib/db";

/**
 * Result of resolving a URL path component to a scholar.
 *
 * `found` — the input is the current canonical key for an active scholar; render the page.
 * `redirect` — the input is a former slug (or former CWID) for an active scholar; emit a 301 to `targetSlug`.
 * `not-found` — no live mapping exists; render 404 (or, for VIVO redirects, fall through to /search?q=name).
 */
export type ResolveResult =
  | { type: "found"; cwid: string; slug: string }
  | { type: "redirect"; targetSlug: string }
  | { type: "not-found" };

/**
 * Resolve a slug candidate (the value in `/scholars/[slug]`).
 * Lookup order: scholar.slug → slug_history → not-found.
 * Soft-deleted (deletedAt != NULL) and suppressed scholars do not resolve.
 */
export async function resolveBySlugOrHistory(slug: string): Promise<ResolveResult> {
  if (!slug) return { type: "not-found" };

  const direct = await prisma.scholar.findFirst({
    where: { slug, deletedAt: null, status: "active" },
    select: { cwid: true, slug: true },
  });
  if (direct) return { type: "found", cwid: direct.cwid, slug: direct.slug };

  const history = await prisma.slugHistory.findUnique({
    where: { oldSlug: slug },
    select: { current: { select: { slug: true, deletedAt: true, status: true } } },
  });
  if (history?.current && !history.current.deletedAt && history.current.status === "active") {
    return { type: "redirect", targetSlug: history.current.slug };
  }

  return { type: "not-found" };
}

/**
 * Resolve a CWID candidate (the value in `/scholars/by-cwid/[cwid]`).
 * Lookup order: scholar.cwid → cwid_aliases → not-found.
 * Soft-deleted and suppressed scholars do not resolve.
 */
export async function resolveByCwidOrAlias(cwid: string): Promise<ResolveResult> {
  if (!cwid) return { type: "not-found" };

  const direct = await prisma.scholar.findFirst({
    where: { cwid, deletedAt: null, status: "active" },
    select: { cwid: true, slug: true },
  });
  if (direct) return { type: "redirect", targetSlug: direct.slug };

  const alias = await prisma.cwidAlias.findUnique({
    where: { oldCwid: cwid },
    select: { current: { select: { slug: true, deletedAt: true, status: true } } },
  });
  if (alias?.current && !alias.current.deletedAt && alias.current.status === "active") {
    return { type: "redirect", targetSlug: alias.current.slug };
  }

  return { type: "not-found" };
}
