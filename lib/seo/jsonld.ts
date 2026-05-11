/**
 * Schema.org JSON-LD builders for public surfaces.
 *
 * The `Person` builder powers `/scholars/[slug]`. Output is rendered as a
 * <script type="application/ld+json"> tag in page JSX (NOT via the Next.js
 * metadata API — it has no JSON-LD field).
 *
 * Schema choices follow issue #171 (audit + close gaps in how WCM scholars
 * surface in AI/LLM search): Person + WCM `worksFor` Organization with a
 * ROR identifier, optional nested `department`, plus `sameAs` for ORCID and
 * the clinical-profile URL. `knowsAbout` is fed from the scholar's MeSH
 * keyword aggregation. ORCID is omitted until the data model carries it
 * (tracked in #171).
 */

/** ROR identifier for Weill Cornell Medical College. Source: ror.org. */
const WCM_ROR = "https://ror.org/05bnh6r87";

/** Cap on `knowsAbout` entries. The schema accepts unbounded arrays but
 *  downstream consumers truncate large lists; keeping ~20 strong MeSH
 *  terms is a better signal than dumping the full keyword tail. */
const KNOWS_ABOUT_CAP = 20;

/** Cap on the plaintext description derived from `overview`. Long enough
 *  to give a useful blurb, short enough that it stays a description and
 *  not a duplicate of the on-page content. */
const DESCRIPTION_CHAR_CAP = 300;

export type PersonJsonLdInput = {
  slug: string;
  /** Display name with postnominal applied (e.g. "Curtis Cole, MD"). */
  preferredName: string;
  primaryTitle: string | null;
  /** Department display name (e.g. "Otolaryngology Head and Neck Surgery").
   *  Rendered as a nested sub-organization on `worksFor` when present. */
  primaryDepartment: string | null;
  /** Raw HTML overview from the scholar payload. Plain-text-extracted and
   *  capped into `description`. Null when absent. */
  overview: string | null;
  /** Public URL to the scholar's headshot image. Always populated by the
   *  upstream payload; passed through to `image`. */
  identityImageEndpoint: string;
  /** When present, surfaced as a `sameAs` entry — the canonical
   *  weillcornell.org clinical profile URL. */
  clinicalProfileUrl: string | null;
  /** Bare 19-char ORCID iD (no protocol/host); converted to a canonical
   *  `https://orcid.org/<id>` URL and appended to `sameAs`. Strong signal
   *  for AI/LLM entity resolution. Null when not registered. */
  orcid?: string | null;
  /** Top MeSH keywords from this scholar's accepted publications, used
   *  verbatim for `knowsAbout`. Pass the aggregation already produced by
   *  `aggregateKeywords` (sorted by pubCount desc). Capped at
   *  KNOWS_ABOUT_CAP. */
  keywords?: ReadonlyArray<{ displayLabel: string }>;
};

export function buildPersonJsonLd(
  profile: PersonJsonLdInput,
): Record<string, unknown> {
  const baseUrl =
    process.env.NEXT_PUBLIC_SITE_URL ?? "https://scholars.weill.cornell.edu";

  const worksFor: Record<string, unknown> = {
    "@type": "Organization",
    name: "Weill Cornell Medicine",
    url: "https://weill.cornell.edu",
    identifier: WCM_ROR,
  };
  if (profile.primaryDepartment) {
    worksFor.department = {
      "@type": "Organization",
      name: profile.primaryDepartment,
    };
  }

  const sameAs: string[] = [];
  if (profile.orcid) sameAs.push(`https://orcid.org/${profile.orcid}`);
  if (profile.clinicalProfileUrl) sameAs.push(profile.clinicalProfileUrl);

  const out: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Person",
    name: profile.preferredName,
    url: `${baseUrl}/scholars/${profile.slug}`,
    image: profile.identityImageEndpoint,
    affiliation: {
      "@type": "Organization",
      name: "Weill Cornell Medicine",
      url: "https://weill.cornell.edu",
      identifier: WCM_ROR,
    },
    worksFor,
  };

  if (profile.primaryTitle) {
    out.jobTitle = profile.primaryTitle;
  }

  const description = overviewToDescription(profile.overview);
  if (description) out.description = description;

  if (sameAs.length > 0) out.sameAs = sameAs;

  const knowsAbout = (profile.keywords ?? [])
    .map((k) => k.displayLabel)
    .filter((s) => typeof s === "string" && s.length > 0)
    .slice(0, KNOWS_ABOUT_CAP);
  if (knowsAbout.length > 0) out.knowsAbout = knowsAbout;

  return out;
}

export type OrganizationJsonLdInput = {
  /** Path slug (e.g. "anesthesiology" for `/departments/anesthesiology`). */
  slug: string;
  /** Route base — "departments" or "centers". */
  route: "departments" | "centers";
  name: string;
  description: string | null;
};

/**
 * Organization JSON-LD for department + center pages. Both kinds roll up
 * to WCM via `parentOrganization` with the WCM ROR identifier so external
 * consumers can resolve the institutional context.
 */
export function buildOrganizationJsonLd(
  org: OrganizationJsonLdInput,
): Record<string, unknown> {
  const baseUrl =
    process.env.NEXT_PUBLIC_SITE_URL ?? "https://scholars.weill.cornell.edu";
  const out: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: org.name,
    url: `${baseUrl}/${org.route}/${org.slug}`,
    parentOrganization: {
      "@type": "Organization",
      name: "Weill Cornell Medicine",
      url: "https://weill.cornell.edu",
      identifier: WCM_ROR,
    },
  };
  if (org.description) {
    const description = overviewToDescription(org.description);
    if (description) out.description = description;
  }
  return out;
}

export type DefinedTermJsonLdInput = {
  /** Topic id used as the URL slug (e.g. "aging_geroscience"). */
  id: string;
  /** Display label. */
  label: string;
  description: string | null;
};

/**
 * DefinedTerm JSON-LD for topic pages — semantically richer than a plain
 * Organization for taxonomy entries. WCM's research-area taxonomy is the
 * implied `inDefinedTermSet`, surfaced by URL.
 */
export function buildDefinedTermJsonLd(
  topic: DefinedTermJsonLdInput,
): Record<string, unknown> {
  const baseUrl =
    process.env.NEXT_PUBLIC_SITE_URL ?? "https://scholars.weill.cornell.edu";
  const out: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "DefinedTerm",
    name: topic.label,
    url: `${baseUrl}/topics/${topic.id}`,
    inDefinedTermSet: `${baseUrl}/browse`,
  };
  if (topic.description) {
    const description = overviewToDescription(topic.description);
    if (description) out.description = description;
  }
  return out;
}

/**
 * Strip HTML tags + decode the small set of named entities WCM Profiles
 * Manager emits in overview fields (it stores HTML-escaped prose). Collapse
 * whitespace, then cap at DESCRIPTION_CHAR_CAP at a word boundary with an
 * ellipsis when truncation occurs.
 *
 * Exported for unit tests.
 */
export function overviewToDescription(overview: string | null): string | null {
  if (!overview) return null;
  // Drop tags.
  const tagless = overview.replace(/<[^>]+>/g, " ");
  // Decode the entities our editor produces. Anything else stays as-is
  // (an LLM consuming the JSON-LD will handle stray entities fine).
  const decoded = tagless
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&ndash;/g, "–")
    .replace(/&mdash;/g, "—")
    .replace(/&rsquo;/g, "’")
    .replace(/&lsquo;/g, "‘")
    .replace(/&rdquo;/g, "”")
    .replace(/&ldquo;/g, "“");
  const collapsed = decoded.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  if (collapsed.length <= DESCRIPTION_CHAR_CAP) return collapsed;
  // Cap on a word boundary so we don't slice mid-word.
  const slice = collapsed.slice(0, DESCRIPTION_CHAR_CAP);
  const lastSpace = slice.lastIndexOf(" ");
  const trimmed = lastSpace > 200 ? slice.slice(0, lastSpace) : slice;
  return `${trimmed.replace(/[\s.,;:]+$/, "")}…`;
}
