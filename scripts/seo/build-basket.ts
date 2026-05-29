/**
 * Build the Google-rank query basket from the live corpus.
 *
 *   npm run seo:basket                 # default: all topics (both variants) + 30 branded
 *   npm run seo:basket -- --scholars 50 --topic-variant both
 *   npm run seo:basket -- --topic-variant plain --scholars 0   # topical-only
 *
 * Output: data/seo/rank-basket.json (committed — see .gitignore allowlist).
 *
 * The basket has two flavors of query, and the topical ones are the point:
 *  - TOPICAL  — drawn from the ReciterAI `topic` taxonomy (e.g. "Cancer
 *    Genomics"). These are competitive, non-branded queries; movement here is
 *    the real SEO story because it reflects whether WCM scholars surface for
 *    the research areas ReciterAI says they work in.
 *      · "plain"  variant: the bare topic label ("cancer genomics")
 *      · "brand"  variant: topic label + brand suffix ("cancer genomics weill cornell")
 *  - BRANDED  — "<scholar name> weill cornell" for the most-published
 *    scholars. These rank #1 almost regardless of platform, so they're a
 *    control / sanity set, not the headline.
 *
 * Read-only against the DB. Run it at baseline-capture time and again if the
 * taxonomy or roster shifts materially; otherwise the committed basket is the
 * fixed instrument that makes before/after comparable.
 */
import "dotenv/config";
import { promises as fs } from "node:fs";
import path from "node:path";

import { prisma } from "@/lib/db";
import type { Basket, BasketQuery, BasketTarget } from "@/lib/seo/rank-basket";

const DEFAULT_OUT = path.resolve(process.cwd(), "data", "seo", "rank-basket.json");

/**
 * Tracking targets. VIVO answered to two host aliases over its life; both are
 * listed so a "before" snapshot on the legacy site counts a hit on either.
 * Confirm `vivo.weill.cornell.edu` is the canonical legacy host for your
 * baseline window before relying on the VIVO column.
 */
const TARGETS: BasketTarget[] = [
  {
    key: "new",
    label: "Scholars (new)",
    hosts: ["scholars.weill.cornell.edu"],
  },
  {
    key: "vivo",
    label: "VIVO (legacy)",
    hosts: ["vivo.weill.cornell.edu", "vivo.med.cornell.edu"],
  },
];

type TopicVariant = "plain" | "brand" | "both";

interface Args {
  scholars: number;
  topicVariant: TopicVariant;
  brandSuffix: string;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const variant = (get("--topic-variant") ?? "both") as TopicVariant;
  if (!["plain", "brand", "both"].includes(variant)) {
    throw new Error(`--topic-variant must be plain|brand|both, got ${variant}`);
  }
  return {
    scholars: Number(get("--scholars") ?? 30),
    topicVariant: variant,
    brandSuffix: get("--brand-suffix") ?? "weill cornell",
    out: get("--out") ?? DEFAULT_OUT,
  };
}

async function topicQueries(variant: TopicVariant, brandSuffix: string): Promise<BasketQuery[]> {
  const topics = await prisma.topic.findMany({
    select: { id: true, label: true },
    orderBy: { id: "asc" }, // deterministic → clean committed diff
  });
  const queries: BasketQuery[] = [];
  for (const t of topics) {
    const label = t.label.trim();
    if (variant === "plain" || variant === "both") {
      queries.push({
        id: `topic:${t.id}:plain`,
        query: label.toLowerCase(),
        type: "topical",
        topicId: t.id,
        label: t.label,
      });
    }
    if (variant === "brand" || variant === "both") {
      queries.push({
        id: `topic:${t.id}:brand`,
        query: `${label.toLowerCase()} ${brandSuffix}`,
        type: "topical",
        topicId: t.id,
        label: `${t.label} (${brandSuffix})`,
      });
    }
  }
  return queries;
}

async function scholarQueries(limit: number, brandSuffix: string): Promise<BasketQuery[]> {
  if (limit <= 0) return [];
  // Prominence = publication count. Restrict to live, public scholars and rank
  // by their publication_topic row count (validated as a good output proxy).
  const rows = await prisma.$queryRaw<
    Array<{ cwid: string; full_name: string; slug: string; c: bigint }>
  >`
    SELECT s.cwid, s.full_name, s.slug, COUNT(*) AS c
    FROM publication_topic pt
    JOIN scholar s ON s.cwid = pt.cwid
    WHERE s.deleted_at IS NULL AND s.status = 'active'
    GROUP BY s.cwid, s.full_name, s.slug
    ORDER BY c DESC, s.cwid ASC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({
    id: `scholar:${r.cwid}`,
    query: `${r.full_name} ${brandSuffix}`,
    type: "branded" as const,
    cwid: r.cwid,
    slug: r.slug,
    label: r.full_name,
  }));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const [topical, branded] = await Promise.all([
    topicQueries(args.topicVariant, args.brandSuffix),
    scholarQueries(args.scholars, args.brandSuffix),
  ]);
  const queries = [...topical, ...branded];

  const basket: Basket = {
    // NB: a real wall-clock timestamp is fine here (this is an ordinary tsx
    // script, not a Workflow script). It records when the instrument was cut.
    generatedAt: new Date().toISOString(),
    source: `reciterai topic taxonomy (${topical.length} topical) + top-${args.scholars} scholars by publication count (${branded.length} branded)`,
    targets: TARGETS,
    searchDefaults: {
      country: "us",
      language: "en",
      googleDomain: "google.com",
      num: 20,
    },
    queries,
  };

  await fs.mkdir(path.dirname(args.out), { recursive: true });
  await fs.writeFile(args.out, JSON.stringify(basket, null, 2) + "\n", "utf8");

  console.log(
    `[seo:basket] wrote ${queries.length} queries (${topical.length} topical, ${branded.length} branded) to ${args.out}`,
  );
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
