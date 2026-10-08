const BASE =
  process.env.SCHOLARS_HEADSHOT_BASE ??
  "https://directory.weill.cornell.edu/api/v1/person/profile";

export function identityImageEndpoint(cwid: string): string {
  return `${BASE}/${cwid}.png?returnGenericOn404=false`;
}

/**
 * The avatar URL to emit for a scholar, gated on the persisted presence verdict
 * (`Scholar.has_headshot`, probed by etl/headshot). `false` → `""`, which
 * HeadshotAvatar reads as "force the initials fallback", so the page never asks
 * the directory for a photo we already know is missing (~46% of cwids 404).
 * `true`, `null` (never probed / indeterminate) and `undefined` (a source that
 * does not carry the field yet, e.g. an older search-index doc) keep the live
 * URL, so an existing photo still loads — and changes — in real time.
 */
export function headshotUrl(cwid: string, hasHeadshot: boolean | null | undefined): string {
  return hasHeadshot === false ? "" : identityImageEndpoint(cwid);
}
