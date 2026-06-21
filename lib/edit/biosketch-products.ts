/**
 * Products selector for the NIH biosketch (#917 v6, handoff §4). The Common Form's real gap
 * is not inline citations but a PRODUCTS list: up to 5 products most closely related to the
 * proposed project + up to 5 other significant products, mapped across the contributions.
 *
 * Design: DETERMINISTIC selection + MODEL mapping. The pmids are chosen in code from the
 * scholar's already-scored publications (grounded identity, zero hallucinated products); the
 * model only assigns each selected product to a contribution and writes a one-line "why".
 * Every returned pmid is verified against the selected set; anything else is dropped.
 *
 * This module is PURE (no Bedrock) — selection + the mapping prompt + the tolerant parser.
 * The single gateway call lives in `biosketch-generator.ts`, which assembles the final
 * `BiosketchProducts`.
 */
import type { OverviewFacts } from "@/lib/edit/overview-facts";
import type { BiosketchParams } from "@/lib/edit/biosketch-params";

/** Up to this many products per bucket (NIH "5 + 5"). */
export const BIOSKETCH_PRODUCTS_PER_BUCKET = 5;

/** One product line in the biosketch Products list. */
export type BiosketchProduct = {
  pmid: string;
  title: string;
  venue: string | null;
  year: number | null;
  /** The 1-based contribution this product is mapped to (the model's call). `null` when the
   *  mapping call failed or did not place it. */
  contributionIndex: number | null;
  /** One-line, grounded rationale for the product / its mapping (the model's call). */
  why: string;
};

/** The two product buckets returned alongside the contributions. */
export type BiosketchProducts = {
  /** Up to 5 products most related to the proposed project (by aims/topic overlap), or the
   *  5 most significant overall when no project aims were given. */
  related: BiosketchProduct[];
  /** Up to 5 other significant products (top blended impact), excluding the related set. */
  otherSignificant: BiosketchProduct[];
  /** Whether `related` was computed from project aims (true) or fell back to "most
   *  significant overall" (false) — the UI labels the bucket accordingly. */
  relatedFromAims: boolean;
};

type CandidatePub = OverviewFacts["representativePublications"][number];

/** A blended impact score: the ReciterAI impact score (recency-robust) plus a log-scaled
 *  citation bonus (rewards established work without letting raw counts dominate recent,
 *  not-yet-cited work). Either signal absent contributes 0. */
function blendedImpactScore(p: CandidatePub): number {
  const impact = typeof p.impact === "number" ? p.impact : 0;
  const cites = typeof p.citationCount === "number" ? p.citationCount : 0;
  return impact + Math.log10(1 + Math.max(0, cites)) * 5;
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "for", "on", "with", "by", "from", "as",
  "at", "is", "are", "we", "our", "this", "that", "these", "those", "study", "studies",
  "research", "project", "aim", "aims", "specific", "using", "use", "novel", "approach",
  "role", "based", "via", "into", "their", "its", "will", "be", "which", "between",
]);

function tokenize(s: string | null | undefined): string[] {
  if (!s) return [];
  return s
    .toLowerCase()
    .replace(/<[^>]+>/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t));
}

/** Overlap count of a publication's text (title + synopsis + topicRationale) against the
 *  aims token set. Deterministic; no model call. */
function aimsOverlapScore(p: CandidatePub, aimsTokens: Set<string>): number {
  if (aimsTokens.size === 0) return 0;
  const pubTokens = new Set([
    ...tokenize(p.title),
    ...tokenize(p.synopsis),
    ...tokenize(p.topicRationale),
  ]);
  let n = 0;
  for (const t of pubTokens) if (aimsTokens.has(t)) n++;
  return n;
}

function toProduct(p: CandidatePub): BiosketchProduct {
  return { pmid: p.pmid, title: p.title.replace(/<[^>]+>/g, ""), venue: p.venue, year: p.year, contributionIndex: null, why: "" };
}

/**
 * Select the related + other-significant product pmids in code. `related` uses aims/topic
 * overlap when the (optional) project aims are present, else falls back to "most significant
 * overall"; `otherSignificant` is the top blended-impact set excluding the related set.
 */
export function selectBiosketchProducts(
  facts: OverviewFacts,
  params: BiosketchParams,
): BiosketchProducts {
  const pubs = facts.representativePublications;
  if (pubs.length === 0) {
    return { related: [], otherSignificant: [], relatedFromAims: false };
  }

  const aimsTokens = new Set([
    ...tokenize(params.projectTitle),
    ...tokenize(params.aims),
  ]);
  const hasAims = aimsTokens.size > 0 && params.mode === "contributions";

  const bySignificance = [...pubs].sort((a, b) => blendedImpactScore(b) - blendedImpactScore(a));

  let related: CandidatePub[];
  let relatedFromAims: boolean;
  if (hasAims) {
    // Rank by aims overlap (desc), breaking ties by blended impact; keep only pubs that
    // actually overlap the aims so "related" is never padded with unrelated work.
    const scored = pubs
      .map((p) => ({ p, overlap: aimsOverlapScore(p, aimsTokens) }))
      .filter((x) => x.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap || blendedImpactScore(b.p) - blendedImpactScore(a.p));
    related = scored.slice(0, BIOSKETCH_PRODUCTS_PER_BUCKET).map((x) => x.p);
    relatedFromAims = related.length > 0;
    // If aims overlapped nothing, fall back to most-significant for the related bucket.
    if (related.length === 0) {
      related = bySignificance.slice(0, BIOSKETCH_PRODUCTS_PER_BUCKET);
    }
  } else {
    related = bySignificance.slice(0, BIOSKETCH_PRODUCTS_PER_BUCKET);
    relatedFromAims = false;
  }

  const relatedPmids = new Set(related.map((p) => p.pmid));
  const otherSignificant = bySignificance
    .filter((p) => !relatedPmids.has(p.pmid))
    .slice(0, BIOSKETCH_PRODUCTS_PER_BUCKET);

  return {
    related: related.map(toProduct),
    otherSignificant: otherSignificant.map(toProduct),
    relatedFromAims,
  };
}

/** Flatten the two buckets to the unique pmids that need mapping. */
export function productPmids(products: BiosketchProducts): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...products.related, ...products.otherSignificant]) {
    if (!seen.has(p.pmid)) {
      seen.add(p.pmid);
      out.push(p.pmid);
    }
  }
  return out;
}

/** System prompt for the product→contribution mapping — a tiny, strict JSON task. */
export const PRODUCT_MAPPING_SYSTEM_PROMPT = [
  "You map each scientific PRODUCT (a publication) to the CONTRIBUTION to Science it best",
  "supports, for an NIH biosketch. You are given the numbered contributions (already written)",
  "and a list of products (pmid + title). For EACH product, choose the single contribution",
  "number (1-based) it most directly belongs to, and write a SHORT one-line reason (<= 140",
  "characters) grounded ONLY in the product title and the contribution text — do not invent",
  "findings, numbers, or relationships. Choose only from the contribution numbers given. Return",
  "STRICT JSON only, no prose: {\"mappings\":[{\"pmid\":\"...\",\"contributionIndex\":N,\"why\":\"...\"}]}.",
  "Include every product pmid exactly once. Do not output any pmid not in the input.",
].join("\n");

/** Build the user turn for the mapping call. */
export function buildProductMappingPrompt(
  entries: string[],
  products: BiosketchProduct[],
): string {
  const lines: string[] = [];
  lines.push("CONTRIBUTIONS (numbered):");
  entries.forEach((e, i) => {
    lines.push(`${i + 1}. ${e}`);
    lines.push("");
  });
  lines.push("PRODUCTS to map (choose a contribution number 1.." + String(entries.length) + " for each):");
  for (const p of products) {
    lines.push(`- pmid ${p.pmid}: ${p.title}${p.year ? ` (${p.year})` : ""}`);
  }
  return lines.join("\n");
}

/**
 * Tolerantly parse the mapping JSON and fold it into the buckets: set `contributionIndex`
 * (clamped to [1, maxContribution]) + `why` on a product whose pmid the model returned;
 * leave the rest at their defaults (index null, why ""). Never throws — a malformed mapping
 * degrades to "products listed, unmapped" rather than crashing the generate.
 */
export function applyProductMapping(
  products: BiosketchProducts,
  mappingJson: string,
  maxContribution: number,
): BiosketchProducts {
  const allowed = new Set(productPmids(products));
  const byPmid = new Map<string, { contributionIndex: number | null; why: string }>();
  try {
    const start = mappingJson.indexOf("{");
    const end = mappingJson.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const parsed = JSON.parse(mappingJson.slice(start, end + 1)) as { mappings?: unknown };
      if (Array.isArray(parsed.mappings)) {
        for (const m of parsed.mappings) {
          const mm = m as { pmid?: unknown; contributionIndex?: unknown; why?: unknown };
          if (typeof mm.pmid !== "string" || !allowed.has(mm.pmid)) continue;
          const idxRaw = Math.floor(Number(mm.contributionIndex));
          const contributionIndex =
            Number.isFinite(idxRaw) && idxRaw >= 1 && idxRaw <= maxContribution ? idxRaw : null;
          const why = typeof mm.why === "string" ? mm.why.trim().slice(0, 200) : "";
          byPmid.set(mm.pmid, { contributionIndex, why });
        }
      }
    }
  } catch {
    // fall through — degrade to unmapped
  }
  const apply = (p: BiosketchProduct): BiosketchProduct => {
    const m = byPmid.get(p.pmid);
    return m ? { ...p, contributionIndex: m.contributionIndex, why: m.why } : p;
  };
  return {
    related: products.related.map(apply),
    otherSignificant: products.otherSignificant.map(apply),
    relatedFromAims: products.relatedFromAims,
  };
}
