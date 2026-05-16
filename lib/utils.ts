import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Strip VIVO serializer artifacts from an HTML string before rendering.
 *
 * VIVO's Turtle exporter double-escapes Windows line endings, storing \\r\\n
 * in the .nq file. A bug in the vivo-overview ETL decoder processes \r/\n
 * escapes before \\, leaving orphaned backslashes (0x5C) in the database.
 * This function removes both the legacy dirty data and any literal \\r\\n
 * sequences that a corrected re-import would produce.
 */
export function sanitizeVIVOHtml(html: string): string {
  return html
    .replace(/\\(?=[\r\n])/g, "")     // legacy: orphaned \ before actual CR/LF
    .replace(/\\r\\n|\\r|\\n/g, "\n"); // literal \r\n text from double-escaping
}

/**
 * Convert an HTML string (potentially from VIVO or PubMed) to plain text
 * suitable for excerpts, search snippets, and CSV cells. Strips tags,
 * collapses whitespace, decodes the handful of HTML entities that appear
 * in VIVO data.
 *
 * PubMed inline whitelist tags (`<i>`, `<em>`, `<b>`, `<strong>`,
 * `<sup>`, `<sub>`) are stripped with NO replacement so chemical
 * formulas like `H<sub>2</sub>O` stay readable as `H2O` rather than
 * breaking into `H 2 O`. All other tags collapse to a single space so
 * adjacent block content doesn't run together.
 *
 * Pass `Number.POSITIVE_INFINITY` as `maxLength` to disable the
 * 200-char excerpt truncation (CSV exports want the full string).
 */
export function htmlToPlainText(html: string, maxLength = 200): string {
  const decoded = sanitizeVIVOHtml(html)
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&[a-z]+;/g, " "); // catch remaining named entities
  const plain = decoded
    // Inline scientific markup → no replacement (preserve `H2O`).
    .replace(/<\/?(?:i|em|b|strong|sup|sub)\b[^>]*>/gi, "")
    // Everything else (block tags, unknown markup) → single space.
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= maxLength) return plain;
  return plain.slice(0, maxLength).replace(/\s+\S*$/, "") + "…";
}

/**
 * Whitelist-strip PubMed-style inline HTML for safe rendering. Use for any
 * user-visible PubMed string — title, journal, abstract.
 *
 * PubMed strings commonly carry inline markup for italicized Latin/foreign
 * terms (`<i>Primum Non Nocere:</i>`), gene/protein names (`<i>BRCA1</i>`),
 * and chemical formulae (`H<sub>2</sub>O`, `CO<sup>2</sup>`). Honor those
 * but strip anything else — no attributes, no scripts, no other tags. The
 * tag set is intentionally narrow because PubMed never emits anything else.
 *
 * Whitelisted tags are normalized to their bare form so attributes never
 * leak through (`<i class="foo">x</i>` → `<i>x</i>`). Any tag outside the
 * whitelist — including the orphaned closer of an attributed tag — is
 * removed entirely.
 */
export function sanitizePubmedHtml(input: string): string {
  return input.replace(/<(\/?)([a-z][a-z0-9]*)\b[^>]*>/gi, (_, slash, raw) => {
    const name = (raw as string).toLowerCase();
    if (/^(?:i|em|b|strong|sup|sub)$/.test(name)) {
      return slash ? `</${name}>` : `<${name}>`;
    }
    return "";
  });
}

/** @deprecated Renamed to {@link sanitizePubmedHtml} — kept for back-compat. */
export const sanitizePubTitle = sanitizePubmedHtml;

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}
