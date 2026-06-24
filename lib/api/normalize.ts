/**
 * Query/term normalization shared by the taxonomy resolver (#259) and the
 * generic-term demotion path (#692). Extracted to a dependency-free leaf module
 * so consumers like `deprioritized-terms.ts` can match tokens against the SAME
 * normalization the MeSH resolver uses, without importing the resolver's Prisma
 * graph. `search-taxonomy.ts` re-exports this, so existing
 * `import { normalizeForMatch } from "@/lib/api/search-taxonomy"` call sites are
 * unaffected.
 *
 * Lowercase + strip non-alphanumeric. Handles "Cardio-oncology" ↔
 * "cardio oncology" ↔ "cardiooncology" without stemming.
 *
 * The standalone connector word "and" is dropped first (issue #690 / #642
 * Bucket A) so it collapses the same way the ampersand already does — "&"
 * strips to nothing as a non-alphanumeric char, but the literal word "and"
 * survived and blocked the match. Dropping it lets a department-style query
 * like "Pathology and Laboratory Medicine" substring-match the curated topic
 * "Pathology & Laboratory Medicine". Whole word only (`\band\b`), so
 * "Andrology", "island", "command", "Anderson" are untouched; an audit over
 * all 67 topics + 267k MeSH surface forms found this introduces no topic-label
 * or MeSH-descriptor key collisions.
 */
export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/\band\b/g, " ")
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * #1255 — normalize a label AND record where each token starts in the
 * space-stripped result, so a matcher can require a query to align to a TOKEN
 * BOUNDARY rather than land anywhere inside the string. `matchKey` is
 * byte-identical to {@link normalizeForMatch} (same tokenization, joined); the
 * boundaries are simply lost once the tokens are concatenated, so we capture
 * them here. `tokenStarts` holds each token's start offset in `matchKey`
 * (the first is always 0 when non-empty); empty input → `[]`.
 */
export function normalizeWithTokenStarts(s: string): {
  matchKey: string;
  tokenStarts: number[];
} {
  const tokens = s
    .toLowerCase()
    .replace(/\band\b/g, " ")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const tokenStarts: number[] = [];
  let offset = 0;
  for (const t of tokens) {
    tokenStarts.push(offset);
    offset += t.length;
  }
  return { matchKey: tokens.join(""), tokenStarts };
}

/**
 * #1255 — does the already-normalized `normalized` query match `matchKey`
 * starting at a token boundary? Prefixes of a token count ("cardio" →
 * "Cardio-oncology"), whole tokens count ("cancer" → "Breast Cancer"), and
 * contiguous runs of tokens count ("gastroenterology hepatology" →
 * "Gastroenterology, Hepatology & …") — but a match that begins mid-token does
 * NOT ("aging" must not match inside "Medical Imaging"). Empty query never
 * matches. `tokenStarts` comes from {@link normalizeWithTokenStarts}.
 */
export function matchesAtTokenBoundary(
  matchKey: string,
  tokenStarts: readonly number[],
  normalized: string,
): boolean {
  if (!normalized) return false;
  return tokenStarts.some((i) => matchKey.startsWith(normalized, i));
}

/**
 * Normalized contiguous word-windows (n-grams) of a query, for whole-word
 * synonym/alias matching. Tokenizes on the SAME rules as {@link normalizeForMatch}
 * (lowercase, drop standalone "and", split on non-alphanumerics), then joins every
 * contiguous run of 1..`maxTokens` tokens into a key. Whole-token by construction,
 * so a short key like "ml" matches the query "ML" / "machine ML" but NOT "html"
 * (a single token "html" never yields the window "ml") — avoiding the raw-substring
 * false positives that make a naive alias matcher map "Seahorse" → "Smegmamorpha".
 *
 * Keys shorter than `minLen` are skipped. Returns a Set for O(1) membership.
 */
export function normalizedWindows(
  s: string,
  { maxTokens = 8, minLen = 2 }: { maxTokens?: number; minLen?: number } = {},
): Set<string> {
  const tokens = s
    .toLowerCase()
    .replace(/\band\b/g, " ")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const out = new Set<string>();
  const span = Math.min(maxTokens, tokens.length);
  for (let size = 1; size <= span; size++) {
    for (let i = 0; i + size <= tokens.length; i++) {
      const w = tokens.slice(i, i + size).join("");
      if (w.length >= minLen) out.add(w);
    }
  }
  return out;
}
