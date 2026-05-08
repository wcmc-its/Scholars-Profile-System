/**
 * Resolve a raw InfoEd sponsor string to a canonical short name from
 * `lib/sponsor-lookup`. Used by the InfoEd ETL when populating
 * `Grant.primeSponsor` / `Grant.directSponsor`.
 *
 * The match strategy is deliberately conservative:
 *   1. Exact match against the canonical short or alias keys (case-
 *      insensitive, trimmed).
 *   2. Match against full names from the lookup (case-insensitive, trimmed).
 *   3. Match against a *normalized* form that strips legal suffixes
 *      ("Inc.", "PLC", "LLC", "Ltd.", "Co.", "Company", "GmbH", "AG",
 *      "S.A.", "S.A.S.") and a leading "The".
 *
 * If none of these match, returns null. Callers (the ETL) store the raw
 * string in the `*_Raw` column so the UI still has something to render and
 * the canonical lookup can be expanded later without re-ingest.
 */

import { getSponsor, listSponsors, type Sponsor } from "@/lib/sponsor-lookup";

/** Normalize for fuzzy matching: lowercase, strip leading "the", drop
 *  trailing legal suffixes and punctuation. */
function normalize(s: string): string {
  let n = s.trim().toLowerCase();
  // Remove leading "the "
  n = n.replace(/^the\s+/i, "");
  // Strip a trailing legal suffix (one or more, e.g. "AstraZeneca PLC, Inc.")
  // Run the strip a few times since some sources stack suffixes.
  for (let i = 0; i < 3; i++) {
    const before = n;
    n = n
      .replace(/[\s,.]+(inc|incorporated|corp|corporation|llc|ltd|limited|plc|gmbh|ag|sa|s\.?a\.?(s\.?)?|sarl|nv|kk|pty|co|company)\.?$/i, "")
      .replace(/[\s,.]+$/g, "")
      .trim();
    if (n === before) break;
  }
  // Collapse internal whitespace
  n = n.replace(/\s+/g, " ");
  return n;
}

/** Build a Map<normalizedKey, Sponsor> covering short names, full names,
 *  and aliases — all normalized — for one O(1) lookup pass. Built lazily
 *  on first call; the lookup is read-only at runtime. */
let NORMALIZED_INDEX: Map<string, Sponsor> | null = null;
function getNormalizedIndex(): Map<string, Sponsor> {
  if (NORMALIZED_INDEX) return NORMALIZED_INDEX;
  const m = new Map<string, Sponsor>();
  for (const s of listSponsors()) {
    m.set(normalize(s.short), s);
    m.set(normalize(s.full), s);
    if (s.aliases) for (const a of s.aliases) m.set(normalize(a), s);
  }
  NORMALIZED_INDEX = m;
  return m;
}

/** Returns the canonical short name (e.g. "NCI", "AstraZeneca") for a raw
 *  sponsor string, or null when the raw value isn't in the canonical
 *  lookup. */
export function canonicalizeSponsor(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // Step 1: exact short / alias match (fast path).
  const direct = getSponsor(trimmed);
  if (direct) return direct.short;

  // Steps 2 + 3: normalized full-name + alias match.
  const norm = normalize(trimmed);
  const idx = getNormalizedIndex();
  const hit = idx.get(norm);
  return hit ? hit.short : null;
}
