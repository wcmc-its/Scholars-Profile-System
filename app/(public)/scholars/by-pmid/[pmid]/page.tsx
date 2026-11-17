import { notFound, permanentRedirect, redirect } from "next/navigation";
import { resolvePubAuthorSlug } from "@/lib/url-resolver";
import { canonicalProfilePath } from "@/lib/profile-url";

/**
 * PMID-keyed entry point for legacy VIVO publication URLs.
 *
 * `/display/pubid<PMID>` (old VIVO host and this host alike) redirects here;
 * Scholars has no per-publication page, so a publication with a live WCM
 * author goes to that author's profile (permanent, D-06/D-07), and one
 * without goes to its PubMed record (temporary: a WCM author may be
 * confirmed later). A malformed id 404s.
 */
export const dynamic = "force-dynamic";

const PMID_RE = /^\d{1,9}$/;

export default async function Page({
  params,
}: {
  params: Promise<{ pmid: string }>;
}): Promise<never> {
  const { pmid } = await params;
  if (!PMID_RE.test(pmid)) notFound();
  const slug = await resolvePubAuthorSlug(pmid);
  if (slug) permanentRedirect(canonicalProfilePath(slug));
  redirect(`https://pubmed.ncbi.nlm.nih.gov/${pmid}/`);
}
