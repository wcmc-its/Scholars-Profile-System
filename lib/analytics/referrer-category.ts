/**
 * Referrer source categories for the Usage dashboard's traffic sections. The
 * `daily_traffic` rollup stores referrer HOSTS (never a category), and this one
 * module turns a host into a category, both in TypeScript ({@link classifyHost})
 * and as an equivalent Athena SQL CASE ({@link toSqlCase}), so a query can
 * filter and group by category. Changing a rule here changes every read at
 * once and needs no backfill.
 *
 * The rules run in order and the first match wins. Order matters:
 *  - 'Fake' (forged search-engine hosts like www.google.edu) precede everything.
 *  - 'Old VIVO' and 'WCM-Q' precede the broader 'WCM' rule.
 *  - 'AI assistants' precede 'Search engines' (gemini.google.com).
 *
 * The patterns are plain regexes that read the same in JavaScript and in
 * Athena's (Java) `regexp_like`, and contain no single quote, so they inline
 * into SQL string literals as-is. Hosts are compared lower-cased.
 */

export const REFERRER_CATEGORIES = [
  "Fake",
  "Old VIVO",
  "WCM-Q",
  "WCM",
  "WCM clinical",
  "Cornell (Ithaca)",
  "NYP",
  "AI assistants",
  "Search engines",
  "Social",
  "Other",
] as const;

export type ReferrerCategory = (typeof REFERRER_CATEGORIES)[number];

/** Every category except the fallback, with its host pattern, in match order. */
export const REFERRER_RULES: ReadonlyArray<{
  category: Exclude<ReferrerCategory, "Other">;
  pattern: string;
}> = [
  { category: "Fake", pattern: "^www\\.(google|bing|baidu|yandex|yahoo)\\.edu$" },
  { category: "Old VIVO", pattern: "^vivo.*\\.cornell\\.edu$" },
  { category: "WCM-Q", pattern: "(^|\\.)qatar(-|\\.)weill\\.cornell\\.edu$" },
  { category: "WCM", pattern: "(^|\\.)(weill|med)\\.cornell\\.edu$" },
  { category: "WCM clinical", pattern: "(^|\\.)weillcornell\\.org$" },
  { category: "Cornell (Ithaca)", pattern: "(^|\\.)cornell\\.edu$" },
  { category: "NYP", pattern: "(^|\\.)nyp\\.org$" },
  {
    category: "AI assistants",
    pattern:
      "(^|\\.)(chatgpt\\.com|chat\\.openai\\.com|claude\\.ai|perplexity\\.ai|gemini\\.google\\.com|copilot\\.microsoft\\.com|chat\\.deepseek\\.com|grok\\.com)$",
  },
  {
    category: "Search engines",
    pattern:
      "(^|\\.)(google\\.[a-z]{2,3}(\\.[a-z]{2})?|scholar\\.google\\.com|bing\\.com|duckduckgo\\.com|search\\.brave\\.com|yahoo\\.com|baidu\\.com|yandex\\.[a-z]{2,3}|ecosia\\.org)$",
  },
  {
    category: "Social",
    pattern:
      "(^|\\.)(facebook\\.com|linkedin\\.com|lnkd\\.in|t\\.co|x\\.com|twitter\\.com|bsky\\.app|reddit\\.com|instagram\\.com|threads\\.net)$",
  },
];

const COMPILED = REFERRER_RULES.map((r) => ({ ...r, re: new RegExp(r.pattern) }));

/** The category of a referrer host ('Other' when no rule matches). */
export function classifyHost(host: string): ReferrerCategory {
  const h = host.trim().toLowerCase();
  for (const r of COMPILED) if (r.re.test(h)) return r.category;
  return "Other";
}

export function isReferrerCategory(s: string): s is ReferrerCategory {
  return (REFERRER_CATEGORIES as readonly string[]).includes(s);
}

/** A code-supplied SQL expression: identifiers, function calls, quoted literals. */
const SAFE_EXPR = /^[A-Za-z0-9_(),.'|/ ]+$/;

/**
 * The rules as an Athena SQL CASE over `hostExpr` (a SQL expression yielding
 * the lower-cased host, e.g. `split_part(dimension, '/', 1)`). `hostExpr` is
 * written by the query builders, never by a user; the guard rejects anything
 * outside a plain-expression character set as defense in depth.
 */
export function toSqlCase(hostExpr: string): string {
  if (!SAFE_EXPR.test(hostExpr) || hostExpr.includes(";") || hostExpr.includes("--")) {
    throw new Error(`invalid_host_expr: ${hostExpr}`);
  }
  const arms = REFERRER_RULES.map(
    (r) => `WHEN regexp_like(${hostExpr}, '${r.pattern}') THEN '${r.category}'`,
  );
  return `CASE ${arms.join(" ")} ELSE 'Other' END`;
}

/** The order the dashboard lists categories in (busiest kinds first, Fake last). */
export const REFERRER_CATEGORY_DISPLAY_ORDER: readonly ReferrerCategory[] = [
  "Search engines",
  "Old VIVO",
  "WCM",
  "WCM clinical",
  "WCM-Q",
  "Cornell (Ithaca)",
  "NYP",
  "AI assistants",
  "Social",
  "Other",
  "Fake",
];
