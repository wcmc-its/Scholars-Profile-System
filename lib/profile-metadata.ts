import type { Metadata } from "next";
import { getScholarFullProfileBySlug } from "@/lib/api/profile";
import { canonicalProfilePath } from "@/lib/profile-url";

/**
 * Shared `generateMetadata` body for the profile routes (#671). Both the
 * canonical route and the legacy/redirecting route delegate here so the
 * `rel=canonical` + OpenGraph url track `PROFILE_CANONICAL` from a single
 * place. The OG *image* endpoint (`/og/scholars/{slug}`) is an asset route, not
 * a profile URL, so it is left on its stable path.
 */
export async function buildProfileMetadata(slug: string): Promise<Metadata> {
  const profile = await getScholarFullProfileBySlug(slug);
  if (!profile) return { title: "Scholar not found" };

  const titleParts = [profile.publishedName];
  if (profile.primaryTitle) titleParts.push(profile.primaryTitle);
  const description = [profile.primaryTitle, profile.primaryDepartment].filter(Boolean).join(" — ");

  const nameParts = profile.preferredName.split(" ");
  const firstName = nameParts[0] ?? profile.preferredName;
  const lastName = nameParts.slice(1).join(" ") || "";

  const canonical = canonicalProfilePath(profile.slug);

  return {
    title: titleParts.join(" — "),
    description: description || `Scholar profile for ${profile.publishedName}`,
    // `types` adds <link rel="alternate" type="application/ld+json"> so
    // crawlers/linked-data clients can discover the machine-readable Person
    // doc. Always the root `/{slug}/jsonld` form — that's where the route
    // handler lives, independent of `PROFILE_CANONICAL`.
    alternates: {
      canonical,
      types: { "application/ld+json": `/${profile.slug}/jsonld` },
    },
    openGraph: {
      type: "profile",
      firstName,
      lastName,
      title: profile.publishedName,
      description: description || `Scholar profile for ${profile.publishedName}`,
      url: canonical,
      images: [
        {
          url: `/og/scholars/${profile.slug}`,
          width: 1200,
          height: 630,
          alt: `${profile.publishedName}${profile.primaryTitle ? ` — ${profile.primaryTitle}` : ""} at Weill Cornell Medicine`,
        },
      ],
    },
    twitter: { card: "summary_large_image" },
  };
}
