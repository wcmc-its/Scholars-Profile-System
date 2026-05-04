/**
 * Schema.org Person JSON-LD builder for profile pages (Phase 5 / SEO-03 / D-26).
 *
 * Used by app/(public)/scholars/[slug]/page.tsx — rendered as a
 * <script type="application/ld+json"> tag in the page JSX (NOT in
 * generateMetadata; Next.js metadata API has no JSON-LD field).
 *
 * Per D-26: omit jobTitle when primaryTitle is null. Omit sameAs entirely
 * because the only candidate (Scholars URL) duplicates `url` (ORCID is
 * deferred to v2).
 */
export type PersonJsonLdInput = {
  slug: string;
  preferredName: string;
  primaryTitle: string | null;
};

export function buildPersonJsonLd(
  profile: PersonJsonLdInput,
): Record<string, unknown> {
  const baseUrl =
    process.env.NEXT_PUBLIC_SITE_URL ?? "https://scholars.weill.cornell.edu";
  const out: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Person",
    name: profile.preferredName,
    affiliation: {
      "@type": "Organization",
      name: "Weill Cornell Medicine",
      url: "https://weill.cornell.edu",
    },
    url: `${baseUrl}/scholars/${profile.slug}`,
  };
  if (profile.primaryTitle) {
    out.jobTitle = profile.primaryTitle;
  }
  // sameAs intentionally omitted (D-26): would only contain `url` itself.
  return out;
}
