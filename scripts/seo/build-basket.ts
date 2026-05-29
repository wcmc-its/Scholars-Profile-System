/**
 * Build a Google-rank query basket from the live corpus.
 *
 * Two modes:
 *   npm run seo:basket                       # CUTOVER basket (default; unchanged)
 *   npm run seo:basket -- --scholars 50
 *   npm run seo:basket -- --topic-variant plain --scholars 0
 *   npm run seo:basket -- --mode rivals      # RIVAL-institution benchmark basket
 *   npm run seo:basket -- --mode rivals --expert-templates "{topic} researcher,{topic} expert"
 *
 *   cutover → data/seo/rank-basket.json   (VIVO → Scholars before/after)
 *   rivals  → data/seo/rival-basket.json  (WCM vs peer profiles platforms)
 *
 * CUTOVER queries (the existing instrument):
 *  - TOPICAL — ReciterAI topic labels, "plain" + "brand" (+ "weill cornell").
 *  - BRANDED — "<scholar name> weill cornell" controls.
 *
 * RIVAL queries (funder-finds-an-expert):
 *  - EXPERT  — templates over the topic taxonomy ("{topic} researcher", …).
 *  - EXPERT/flagship — curated high-value queries (data/seo/flagship-queries.json).
 *  - BRANDED/matched — one comparable researcher per institution per flagship
 *    topic (data/seo/matched-researchers.json), eminence-controlled (see
 *    seo:enrich-matched). Rival institution targets ride the SAME SERP fetch as
 *    WCM, so they cost zero extra SerpAPI credits.
 *
 * Read-only against the DB. The committed basket is the fixed instrument that
 * makes runs comparable; regenerate only when the taxonomy/roster shifts.
 */
import "dotenv/config";
import { promises as fs } from "node:fs";
import path from "node:path";

import { prisma } from "@/lib/db";
import type { Basket, BasketQuery, BasketTarget } from "@/lib/seo/rank-basket";

const DATA_DIR = path.resolve(process.cwd(), "data", "seo");
const CUTOVER_OUT = path.join(DATA_DIR, "rank-basket.json");
const RIVAL_OUT = path.join(DATA_DIR, "rival-basket.json");
const FLAGSHIP_FILE = path.join(DATA_DIR, "flagship-queries.json");
const MATCHED_FILE = path.join(DATA_DIR, "matched-researchers.json");

/**
 * CUTOVER targets. VIVO answered to two host aliases over its life; both are
 * listed so a "before" snapshot counts a hit on either.
 */
const TARGETS: BasketTarget[] = [
  { key: "new", label: "Scholars (new)", hosts: ["scholars.weill.cornell.edu"] },
  { key: "vivo", label: "VIVO (legacy)", hosts: ["vivo.weill.cornell.edu", "vivo.med.cornell.edu"] },
];

/**
 * RIVAL targets — each institution's PUBLIC research-profiles platform (hosts
 * verified May 2026). WCM gets three surfaces; `wcm-clinical` (weillcornell.org)
 * is `clinical` and is excluded from the apples-to-apples platform leaderboard.
 * Elsevier-hosted Pure instances canonicalize to `<inst>.elsevierpure.com` (the
 * URL Google indexes). Penn has no dedicated host → scoped by pathPrefix.
 */
const RIVAL_TARGETS: BasketTarget[] = [
  { key: "wcm-new", label: "WCM Scholars", hosts: ["scholars.weill.cornell.edu"], institution: "WCM", platform: "VIVO-derived", surfaceType: "research-profiles" },
  { key: "wcm-vivo", label: "WCM VIVO (legacy)", hosts: ["vivo.weill.cornell.edu", "vivo.med.cornell.edu"], institution: "WCM", platform: "VIVO", surfaceType: "research-profiles" },
  { key: "wcm-clinical", label: "WCM clinical", hosts: ["weillcornell.org"], institution: "WCM", platform: "clinical directory", surfaceType: "clinical" },
  { key: "ucsf", label: "UCSF", hosts: ["profiles.ucsf.edu"], institution: "UCSF", platform: "Profiles RNS", surfaceType: "research-profiles" },
  { key: "harvard", label: "Harvard Catalyst", hosts: ["connects.catalyst.harvard.edu"], institution: "Harvard", platform: "Profiles RNS", surfaceType: "research-profiles" },
  { key: "duke", label: "Duke", hosts: ["scholars.duke.edu"], institution: "Duke", platform: "VIVO", surfaceType: "research-profiles" },
  { key: "vanderbilt", label: "Vanderbilt", hosts: ["facultyprofiles.vanderbilt.edu"], institution: "Vanderbilt", platform: "Esploro", surfaceType: "research-profiles" },
  { key: "stanford", label: "Stanford", hosts: ["profiles.stanford.edu"], institution: "Stanford", platform: "Stanford CAP", surfaceType: "research-profiles" },
  { key: "penn", label: "Penn (PSOM)", hosts: ["med.upenn.edu"], institution: "Penn", platform: "custom", surfaceType: "research-profiles", pathPrefix: "/apps/faculty/" },
  { key: "hopkins", label: "Johns Hopkins", hosts: ["pure.johnshopkins.edu"], institution: "Johns Hopkins", platform: "Elsevier Pure", surfaceType: "research-profiles" },
  { key: "mayo", label: "Mayo Clinic", hosts: ["mayoclinic.elsevierpure.com"], institution: "Mayo Clinic", platform: "Elsevier Pure", surfaceType: "research-profiles" },
  { key: "umn", label: "Minnesota", hosts: ["experts.umn.edu"], institution: "Minnesota", platform: "Elsevier Pure", surfaceType: "research-profiles" },
  { key: "pennstate", label: "Penn State", hosts: ["pure.psu.edu"], institution: "Penn State", platform: "Elsevier Pure", surfaceType: "research-profiles" },
  { key: "northwestern", label: "Northwestern", hosts: ["scholars.northwestern.edu"], institution: "Northwestern", platform: "Elsevier Pure", surfaceType: "research-profiles" },
  { key: "indiana", label: "Indiana SOM", hosts: ["indiana.elsevierpure.com"], institution: "Indiana", platform: "Elsevier Pure", surfaceType: "research-profiles" },
  { key: "cwru", label: "Case Western", hosts: ["cwru.elsevierpure.com"], institution: "Case Western", platform: "Elsevier Pure", surfaceType: "research-profiles" },
  { key: "miami", label: "Miami", hosts: ["miami.elsevierpure.com"], institution: "Miami", platform: "Elsevier Pure", surfaceType: "research-profiles" },
  { key: "ohsu", label: "OHSU", hosts: ["ohsu.elsevierpure.com"], institution: "OHSU", platform: "Elsevier Pure", surfaceType: "research-profiles" },
  { key: "einstein", label: "Einstein", hosts: ["einstein.elsevierpure.com"], institution: "Einstein", platform: "Elsevier Pure", surfaceType: "research-profiles" },
];

const DEFAULT_EXPERT_TEMPLATES = ["{topic} researcher", "{topic} expert", "leading {topic} researcher"];

type Mode = "cutover" | "rivals";
type TopicVariant = "plain" | "brand" | "both";

interface Args {
  mode: Mode;
  scholars: number;
  topicVariant: TopicVariant;
  brandSuffix: string;
  expertTemplates: string[];
  out: string;
}

function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** A short key for a template, e.g. "leading {topic} researcher" → "leading-researcher". */
function templateKey(tpl: string): string {
  return slugify(tpl.replace(/\{topic\}/g, " ")) || "expert";
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const mode = (get("--mode") ?? "cutover") as Mode;
  if (!["cutover", "rivals"].includes(mode)) {
    throw new Error(`--mode must be cutover|rivals, got ${mode}`);
  }
  const variant = (get("--topic-variant") ?? "both") as TopicVariant;
  if (!["plain", "brand", "both"].includes(variant)) {
    throw new Error(`--topic-variant must be plain|brand|both, got ${variant}`);
  }
  const tplRaw = get("--expert-templates");
  const expertTemplates = tplRaw
    ? tplRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : DEFAULT_EXPERT_TEMPLATES;
  return {
    mode,
    scholars: Number(get("--scholars") ?? 30),
    topicVariant: variant,
    brandSuffix: get("--brand-suffix") ?? "weill cornell",
    expertTemplates,
    out: get("--out") ?? (mode === "rivals" ? RIVAL_OUT : CUTOVER_OUT),
  };
}

async function fetchTopics(): Promise<Array<{ id: string; label: string }>> {
  return prisma.topic.findMany({
    select: { id: true, label: true },
    orderBy: { id: "asc" }, // deterministic → clean committed diff
  });
}

// ── cutover-mode queries (unchanged behavior) ─────────────────────────────

function topicQueries(
  topics: Array<{ id: string; label: string }>,
  variant: TopicVariant,
  brandSuffix: string,
): BasketQuery[] {
  const queries: BasketQuery[] = [];
  for (const t of topics) {
    const label = t.label.trim();
    if (variant === "plain" || variant === "both") {
      queries.push({ id: `topic:${t.id}:plain`, query: label.toLowerCase(), type: "topical", topicId: t.id, label: t.label });
    }
    if (variant === "brand" || variant === "both") {
      queries.push({ id: `topic:${t.id}:brand`, query: `${label.toLowerCase()} ${brandSuffix}`, type: "topical", topicId: t.id, label: `${t.label} (${brandSuffix})` });
    }
  }
  return queries;
}

async function scholarQueries(limit: number, brandSuffix: string): Promise<BasketQuery[]> {
  if (limit <= 0) return [];
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

// ── rivals-mode queries ───────────────────────────────────────────────────

function expertQueries(topics: Array<{ id: string; label: string }>, templates: string[]): BasketQuery[] {
  const queries: BasketQuery[] = [];
  for (const t of topics) {
    const label = t.label.trim().toLowerCase();
    for (const tpl of templates) {
      queries.push({
        id: `expert:${t.id}:${templateKey(tpl)}`,
        query: tpl.replace(/\{topic\}/g, label),
        type: "expert",
        topicId: t.id,
        label: `${t.label} — ${templateKey(tpl).replace(/-/g, " ")}`,
      });
    }
  }
  return queries;
}

interface FlagshipInput {
  query: string;
  label?: string;
  topicId?: string;
}

interface MatchedInput {
  matchGroup: string;
  institution: string;
  name: string;
  orcid?: string;
  openalexId?: string;
  hIndex?: number;
  academicAge?: number;
  eminenceSource?: string;
}

async function readJsonIfExists<T>(file: string, label: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.warn(`[seo:basket] ${label} not found at ${file} — skipping (run the scaffolder or add it).`);
      return null;
    }
    throw err;
  }
}

function flagshipQueries(input: FlagshipInput[] | null): BasketQuery[] {
  if (!input) return [];
  return input.map((f) => ({
    id: `flagship:${slugify(f.query)}`,
    query: f.query,
    type: "expert" as const,
    flagship: true,
    topicId: f.topicId,
    label: f.label ?? f.query,
  }));
}

function matchedQueries(input: MatchedInput[] | null): BasketQuery[] {
  if (!input) return [];
  return input.map((m) => ({
    id: `matched:${slugify(m.matchGroup)}:${slugify(m.institution)}`,
    query: m.name,
    type: "branded" as const,
    matchGroup: m.matchGroup,
    label: `${m.name} (${m.institution})`,
    hIndex: m.hIndex,
    academicAge: m.academicAge,
    eminenceSource: m.eminenceSource,
  }));
}

const SEARCH_DEFAULTS = { country: "us", language: "en", googleDomain: "google.com", num: 20 };

async function buildCutover(args: Args): Promise<Basket> {
  const topics = await fetchTopics();
  const topical = topicQueries(topics, args.topicVariant, args.brandSuffix);
  const branded = await scholarQueries(args.scholars, args.brandSuffix);
  return {
    generatedAt: new Date().toISOString(),
    source: `reciterai topic taxonomy (${topical.length} topical) + top-${args.scholars} scholars by publication count (${branded.length} branded)`,
    targets: TARGETS,
    searchDefaults: SEARCH_DEFAULTS,
    queries: [...topical, ...branded],
  };
}

async function buildRivals(args: Args): Promise<Basket> {
  const topics = await fetchTopics();
  const expert = expertQueries(topics, args.expertTemplates);
  const flagship = flagshipQueries(await readJsonIfExists<FlagshipInput[]>(FLAGSHIP_FILE, "flagship-queries.json"));
  const matched = matchedQueries(await readJsonIfExists<MatchedInput[]>(MATCHED_FILE, "matched-researchers.json"));
  return {
    generatedAt: new Date().toISOString(),
    source:
      `rival benchmark — expert sweep (${expert.length} = ${topics.length} topics × ${args.expertTemplates.length} templates) ` +
      `+ ${flagship.length} flagship + ${matched.length} matched; ${RIVAL_TARGETS.length} targets across ` +
      `${new Set(RIVAL_TARGETS.map((t) => t.institution ?? t.key)).size} institutions`,
    targets: RIVAL_TARGETS,
    searchDefaults: SEARCH_DEFAULTS,
    queries: [...expert, ...flagship, ...matched],
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const basket = args.mode === "rivals" ? await buildRivals(args) : await buildCutover(args);

  await fs.mkdir(path.dirname(args.out), { recursive: true });
  await fs.writeFile(args.out, JSON.stringify(basket, null, 2) + "\n", "utf8");

  const byType = basket.queries.reduce<Record<string, number>>((acc, q) => {
    acc[q.type] = (acc[q.type] ?? 0) + 1;
    return acc;
  }, {});
  const typeSummary = Object.entries(byType).map(([t, n]) => `${n} ${t}`).join(", ");
  console.log(`[seo:basket] mode=${args.mode}: wrote ${basket.queries.length} queries (${typeSummary}) to ${args.out}`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
