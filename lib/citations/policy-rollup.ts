/**
 * Guideline and policy citation rollup for one publication, as the public row
 * shows it. Built from the three `publication` columns the weekly
 * `etl:policy-citations` step maintains.
 */
export type PolicyRollup = {
  /** Distinct documents per health authority, most documents first. */
  authority: Array<{ body: string; count: number }>;
  guidelines: number;
  reviews: number;
};

/**
 * The ranked citing-document levels, highest first. `citing_document` also
 * holds rows at other levels (a ClinicalTrials.gov study is `trial`); those are
 * a different kind of uptake, so every reader of the ranked levels names these
 * four and never sees them.
 */
export const POLICY_LEVELS = ["authority", "guideline", "consensus", "review"] as const;

/** Server-side gate for the public badges and the modal section. */
export function policyCitationBadgesOn(): boolean {
  return process.env.POLICY_CITATION_BADGES === "on";
}

/** The rollup, or null when nothing cites the paper (the row then adds nothing). */
export function toPolicyRollup(row: {
  authorityBodies: unknown;
  guidelineCount: number;
  reviewCount: number;
}): PolicyRollup | null {
  const authority = Array.isArray(row.authorityBodies)
    ? row.authorityBodies.flatMap((b) =>
        b && typeof b.body === "string" && typeof b.count === "number" && b.count > 0
          ? [{ body: b.body as string, count: b.count as number }]
          : [],
      )
    : [];
  if (authority.length === 0 && row.guidelineCount === 0 && row.reviewCount === 0) return null;
  return { authority, guidelines: row.guidelineCount, reviews: row.reviewCount };
}

/** What each authority's documents are called on a badge. */
const NOUN: Readonly<Record<string, string>> = { WHO: "guideline", NICE: "guideline" };

/** "Cited in 4 WHO guidelines", or "National Academies report" for a single one. */
export function authorityBadgeLabel(body: string, count: number): string {
  const noun = NOUN[body] ?? "report";
  return count === 1 ? `${body} ${noun}` : `Cited in ${count} ${body} ${noun}s`;
}

export function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** "Ghany MG, Morgan TR, et al. Hepatology. 2020;71(2):686-721." */
export function policyDocCitation(d: {
  publisher: string | null;
  authors: string | null;
  journal: string | null;
  year: number | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
}): string {
  if (d.publisher) return d.publisher;
  const locator = [d.volume, d.issue ? `(${d.issue})` : "", d.pages ? `:${d.pages}` : ""].join("");
  const dated = [d.year, locator].filter(Boolean).join(";");
  return [d.authors, d.journal, dated]
    .filter(Boolean)
    .map((part) => `${String(part).replace(/\.$/, "")}.`)
    .join(" ");
}

/**
 * A link's stored `locations` (JSON, or JSON text from a raw query), tidied for
 * display: NCBI links only, one entry per label, and no bare chapter link when
 * a section of the same page is already listed.
 */
export function parseLocations(raw: unknown): { url: string; label: string }[] {
  let locations = raw;
  if (typeof locations === "string") {
    try {
      locations = JSON.parse(locations);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(locations)) return [];
  const all = (locations as { url?: unknown; label?: unknown }[]).flatMap((x) =>
    typeof x?.url === "string" && x.url.startsWith("https://www.ncbi.nlm.nih.gov/") && typeof x.label === "string"
      ? [{ url: x.url, label: x.label }]
      : [],
  );
  const anchoredPages = new Set(all.filter((x) => x.url.includes("#")).map((x) => x.url.split("#")[0]));
  const labels = new Set<string>();
  return all.filter((x) => {
    if (!x.url.includes("#") && anchoredPages.has(x.url)) return false;
    const key = x.label.toLowerCase();
    return !labels.has(key) && labels.add(key);
  });
}
