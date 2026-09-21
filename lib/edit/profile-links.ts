/**
 * Faculty-entered external profile links (#2699) — LinkedIn, X, Bluesky, Google
 * Scholar, ResearchGate. Stored as ONE JSON object in
 * `field_override(scholar, cwid, 'profileLinks')`, the `manualMentees` /
 * `selectedHighlightPmids` precedent: no migration, no Prisma model, no
 * `manual_edit_audit` ENUM registration, already in the curated-table backup.
 * Not a `Scholar` column — that table is ETL-owned (`orcid` is wiped nightly
 * by the Identity client, #155).
 *
 * Fixed slots, host-allowlisted per platform. A pasted URL (with or without a
 * scheme) or a bare handle is accepted; what is STORED is always the canonical
 * `https://` URL with nothing but the identity-bearing part kept. Free-form
 * `{label, url}` is deliberately not supported: a public `.edu` page must not
 * deep-link anywhere a faculty member types.
 *
 * Adding a platform = one entry in `PROFILE_LINK_PLATFORMS` + one `canonical`
 * case. Academia.edu was left out on purpose (for-profit host, rare in
 * biomedicine); a lab/personal-website slot needs an any-host policy and is out
 * of scope until asked for.
 */

/** Display order is object order. `hint` is the host prefix shown beside the
 *  label so the placeholder can be just the identity-bearing part. */
export const PROFILE_LINK_PLATFORMS = {
  linkedin: { label: "LinkedIn", hint: "linkedin.com/in/", placeholder: "handle" },
  x: { label: "X (Twitter)", hint: "x.com/", placeholder: "handle" },
  bluesky: { label: "Bluesky", hint: "@", placeholder: "you.bsky.social" },
  googleScholar: {
    label: "Google Scholar",
    hint: "scholar.google.com/citations?user=",
    placeholder: "user ID",
  },
  researchGate: {
    label: "ResearchGate",
    hint: "researchgate.net/profile/",
    placeholder: "Your-Name",
  },
} as const;

export type ProfileLinkPlatform = keyof typeof PROFILE_LINK_PLATFORMS;
export const PROFILE_LINK_PLATFORM_KEYS = Object.keys(
  PROFILE_LINK_PLATFORMS,
) as ProfileLinkPlatform[];

/** The part of a URL the field's host-prefix label already says. */
const HOST_PREFIX: Record<ProfileLinkPlatform, RegExp> = {
  linkedin: /^(https?:\/\/)?([a-z]{2}\.|www\.)?linkedin\.com\/in\//i,
  x: /^(https?:\/\/)?(www\.|mobile\.)?(x|twitter)\.com\/|^@/i,
  bluesky: /^(https?:\/\/)?(www\.)?bsky\.app\/profile\/|^@/i,
  googleScholar: /^(https?:\/\/)?scholar\.google\.[a-z.]+\/citations\?user=/i,
  researchGate: /^(https?:\/\/)?(www\.)?researchgate\.net\/profile\//i,
};

/**
 * What the field SHOWS: a pasted full URL (or the stored canonical one) reduced
 * to the handle the label's host prefix expects, so a paste of
 * `https://www.linkedin.com/in/oelemento` into a field labelled
 * `linkedin.com/in/` reads `oelemento`, not a double-prefixed dead link. Scheme,
 * host, prefix, query and hash go; for Google Scholar the identity IS the
 * `?user=` value, so that is what survives. Anything unrecognised is left for
 * the server to reject by name.
 */
export function profileLinkHandle(platform: ProfileLinkPlatform, raw: string): string {
  const v = raw.trim();
  if (platform === "googleScholar") {
    const m = v.match(/[?&]user=([^&#]+)/);
    if (m) return m[1];
  }
  return v
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    .replace(HOST_PREFIX[platform], "");
}

/** What the card SENDS for a handle: the label's prefix put back, so the server
 *  sees the same URL a paste would have given it (a dotted LinkedIn vanity or
 *  a Bluesky domain handle parse as URLs, not bare hosts). A value that still
 *  has a path or scheme is sent as typed. */
export function profileLinkInput(platform: ProfileLinkPlatform, handle: string): string {
  const v = handle.trim();
  return v === "" || /[/:]/.test(v) ? v : `${PROFILE_LINK_PLATFORMS[platform].hint}${v}`;
}

/** `{ platform: canonical https URL }`; an absent key is an empty slot. */
export type ProfileLinks = Partial<Record<ProfileLinkPlatform, string>>;

export type ProfileLinksResult =
  | { ok: true; value: ProfileLinks }
  | { ok: false; error: "invalid_value" | "invalid_link"; platform?: ProfileLinkPlatform };

const MAX_INPUT = 512;
const HANDLE = /^[A-Za-z0-9._-]{1,100}$/;
const SCHOLAR_ID = /^[A-Za-z0-9_-]{12}$/;

/** `SELF_EDIT_PROFILE_LINKS` — wired per-env in `cdk/lib/app-stack.ts`. Off ⇒ the
 *  card is absent, the route rejects the field, and the public read is skipped. */
export function isProfileLinksEnabled(): boolean {
  return process.env.SELF_EDIT_PROFILE_LINKS === "on";
}

function firstSegment(pathname: string): string | null {
  const seg = pathname.split("/").filter(Boolean)[0];
  return seg && HANDLE.test(seg) ? seg : null;
}

function segmentAfter(pathname: string, prefix: string): string | null {
  return pathname.startsWith(prefix) ? firstSegment(pathname.slice(prefix.length)) : null;
}

/** Parse a bare handle (`@name`, `name`) or a URL (`x.com/name`, `https://…`).
 *  A dotted token is a handle on Bluesky (`you.bsky.social`) and a bare host
 *  everywhere else. */
function parse(raw: string, platform: ProfileLinkPlatform): URL | null {
  const s = raw.trim();
  if (!s || s.length > MAX_INPUT) return null;
  const token = s.replace(/^@/, "");
  if (HANDLE.test(token) && (platform === "bluesky" || !token.includes("."))) {
    switch (platform) {
      case "linkedin":
        return new URL(`https://www.linkedin.com/in/${token}`);
      case "x":
        return new URL(`https://x.com/${token}`);
      case "bluesky":
        return new URL(
          `https://bsky.app/profile/${token.includes(".") ? token : `${token}.bsky.social`}`,
        );
      case "googleScholar":
        return SCHOLAR_ID.test(token)
          ? new URL(`https://scholar.google.com/citations?user=${token}`)
          : null;
      case "researchGate":
        return new URL(`https://www.researchgate.net/profile/${token}`);
    }
  }
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
    // `javascript:` / `data:` / … never reach the host check.
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/** The canonical stored URL for one slot, or null when the input is not a link
 *  on that platform. Never throws. */
export function canonicalProfileLink(platform: ProfileLinkPlatform, raw: string): string | null {
  const url = parse(raw, platform);
  if (!url) return null;
  const host = url.hostname.toLowerCase().replace(/^(www|m|mobile)\./, "");
  switch (platform) {
    case "linkedin": {
      // `/in/<vanity>` is the norm; `/pub/…` legacy URLs still resolve. Any
      // non-root path on the host is accepted as-is (vanity slugs may be
      // percent-encoded unicode, which `URL` already normalised). Search
      // engines hand out country hosts (`uk.linkedin.com`); they fold to www.
      if (!/^([a-z]{2}\.)?linkedin\.com$/.test(host)) return null;
      const path = url.pathname.replace(/\/+$/, "");
      return path ? `https://www.linkedin.com${path}` : null;
    }
    case "x": {
      if (host !== "x.com" && host !== "twitter.com") return null;
      const handle = firstSegment(url.pathname);
      return handle ? `https://x.com/${handle}` : null;
    }
    case "bluesky": {
      if (host !== "bsky.app") return null;
      const handle = segmentAfter(url.pathname, "/profile/");
      return handle ? `https://bsky.app/profile/${handle}` : null;
    }
    case "googleScholar": {
      // The identity lives in `?user=`; every other param (hl, oi, view_op…) is
      // noise. Regional hosts (scholar.google.co.uk) fold to .com.
      if (!/^scholar\.google\.(com|[a-z]{2,3}(\.[a-z]{2})?)$/.test(host)) return null;
      const id = url.searchParams.get("user");
      return id && SCHOLAR_ID.test(id) ? `https://scholar.google.com/citations?user=${id}` : null;
    }
    case "researchGate": {
      if (host !== "researchgate.net") return null;
      const slug = segmentAfter(url.pathname, "/profile/");
      return slug ? `https://www.researchgate.net/profile/${slug}` : null;
    }
  }
}

/**
 * Validate the whole `profileLinks` object (a parsed object or its stored JSON
 * string). Unknown keys and non-string values are `invalid_value`; an empty
 * string clears its slot; a value that is not a link on its platform is
 * `invalid_link` with the offending `platform` so the card can point at the
 * field. The returned object holds only canonical URLs, in platform order.
 */
export function validateProfileLinks(input: unknown): ProfileLinksResult {
  let parsed: unknown = input;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input);
    } catch {
      return { ok: false, error: "invalid_value" };
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "invalid_value" };
  }
  const obj = parsed as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!Object.hasOwn(PROFILE_LINK_PLATFORMS, key) || typeof obj[key] !== "string") {
      return { ok: false, error: "invalid_value" };
    }
  }
  const value: ProfileLinks = {};
  for (const platform of PROFILE_LINK_PLATFORM_KEYS) {
    const raw = obj[platform] as string | undefined;
    if (raw === undefined || raw.trim() === "") continue;
    const url = canonicalProfileLink(platform, raw);
    if (!url) return { ok: false, error: "invalid_link", platform };
    value[platform] = url;
  }
  return { ok: true, value };
}
