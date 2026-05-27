/**
 * Root-alias routing (#497 §5.3).
 *
 * A bare single-segment path — `scholars.weill.cornell.edu/<slug>` — 301s
 * (permanent) to the canonical `/scholars/<slug>`. Next resolves explicit
 * segments first (the `(public)/*` group — about, browse, centers, departments,
 * scholars, search, topics — plus api, edit, healthz, og, readiness, robots,
 * sitemap, llms, not-found), so only *unknown* single segments fall through to
 * this catch-all.
 *
 * Resolution order (§5.3):
 *   1. reserved route word -> notFound() (never treat a route word as a
 *      scholar; belt-and-suspenders behind Next's static-route precedence).
 *   2. doesn't look like a slug -> notFound() (cheap reject, skips the DB hit;
 *      also turns away uppercase / non-slug input since slugs are lowercase).
 *   3. resolveBySlugOrHistory direct/history hit -> permanentRedirect to the
 *      canonical /scholars/<currentSlug> (308; the resolver is the single
 *      source of slug + slug_history truth, shared with /scholars/[slug]).
 *   4. else notFound().
 *
 * No UI — this component never renders; it always redirects or 404s.
 *
 * Edge note: root single-segment paths are not yet in the EdgeStack
 * uncacheable list; the redirect must be cacheable and must not collide with
 * the cookie / query-string stripping (see the edge memo). The CloudFront
 * behavior addition is a separate PR-2 deploy task, not part of this route.
 */
import { notFound, permanentRedirect } from "next/navigation";

import { looksLikeSlug, RESERVED_SLUGS } from "@/lib/slug";
import { resolveBySlugOrHistory } from "@/lib/url-resolver";

export default async function RootSlugAlias({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<never> {
  const { slug } = await params;

  // 1. A reserved route word is never a scholar slug.
  if (RESERVED_SLUGS.has(slug)) notFound();

  // 2. Cheap structural reject before any DB work.
  if (!looksLikeSlug(slug)) notFound();

  // 3. Resolve against live slugs + slug_history.
  const resolved = await resolveBySlugOrHistory(slug);
  if (resolved.type === "found") permanentRedirect(`/scholars/${resolved.slug}`);
  if (resolved.type === "redirect") permanentRedirect(`/scholars/${resolved.targetSlug}`);

  // 4. No live mapping.
  notFound();
}
