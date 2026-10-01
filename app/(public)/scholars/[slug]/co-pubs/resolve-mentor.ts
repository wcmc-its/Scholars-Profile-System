import { cache } from "react";
import { prisma } from "@/lib/db";
import { isPubliclyDisplayed, publicRoleWhere } from "@/lib/eligibility";

/**
 * #2268 — the co-pubs routes publish the mentor's NAME in `<title>`, the meta
 * description and the `<h1>`, so they carry the same two-layer #536 carve as
 * the parent profile route (`lib/url-resolver.ts`): `publicRoleWhere()` in the
 * where-clause, then a fail-closed `isPubliclyDisplayed` on the RAW column,
 * because Prisma cannot express the `doctoral_student*` prefix. Without it
 * `/scholars/{hidden-slug}` 404s while these routes still serve the name.
 *
 * #2963 — shared by the co-pubs layout (the existence gate that runs outside
 * the loading.tsx Suspense boundary) and both pages; React `cache()` keeps it
 * to one query per request/regeneration.
 */
export const resolveMentor = cache(async (slug: string) => {
  const mentor = await prisma.scholar.findFirst({
    where: { slug, deletedAt: null, status: "active", ...publicRoleWhere() },
    select: {
      cwid: true,
      slug: true,
      preferredName: true,
      postnominal: true,
      roleCategory: true,
    },
  });
  return mentor && isPubliclyDisplayed(mentor.roleCategory) ? mentor : null;
});
