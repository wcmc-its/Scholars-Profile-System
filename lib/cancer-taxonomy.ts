/**
 * Cancer-relevance topic lookup, backed by the precomputed
 * `CancerTaxonomyDescriptor` table (the two-axis `cancer_relevant`/`topics`
 * generator, `etl/cancer-taxonomy/index.ts`) rather than the retired
 * hand-picked 18-code CSV taxonomy this replaces
 * (`lib/cancer-center-mesh-taxonomy.ts`).
 *
 * `loadCancerTaxonomy` is the ONE place that reads `CancerTaxonomyDescriptor`
 * — the weekly ETL step and every read-time caller (the "How cancer-relevance
 * is determined" modal, the per-paper "why" CSV export) call this instead of
 * each keeping its own copy, so "cancer-related" can't quietly mean two
 * different things depending on who asks. Unlike the old CSV taxonomy, this
 * one does NOT do live MeSH-subtree matching at read time — the closure over
 * MeSH's tree is precomputed by the generator ETL step, so this module only
 * ever reads a small, already-resolved table.
 */
export type TaxonomyLookup = {
  /** descriptorUi -> topics (possibly an empty array — [] means "cancer-relevant
   *  but unassigned to any topic bucket", not a data gap). */
  topicsByUi: Map<string, string[]>;
  /** descriptorUi -> MeshDescriptor.name, for display. */
  nameByUi: Map<string, string>;
};

export type CancerTaxonomyDescriptorReader = {
  findMany: (args: {
    where: { cancerRelevant: true };
    select: { descriptorUi: true; topics: true };
  }) => Promise<Array<{ descriptorUi: string; topics: unknown }>>;
};

export type MeshDescriptorNameReader = {
  findMany: (args: {
    where: { descriptorUi: { in: string[] } };
    select: { descriptorUi: true; name: true };
  }) => Promise<Array<{ descriptorUi: string; name: string }>>;
};

let cached: TaxonomyLookup | null = null;

/**
 * Reads the `CancerTaxonomyDescriptor` table (filtered to `cancerRelevant:
 * true`, forward-compat with a future non-relevant row shape) once per
 * process and builds `topicsByUi`, then resolves display names for exactly
 * that UI set against `MeshDescriptor` — NOT the whole table, unlike the old
 * CSV taxonomy's `loadTaxonomy`, which had to load every descriptor to do its
 * own live subtree walk. That walk is now precomputed, so this only ever
 * needs the descriptors that actually matched.
 */
export async function loadCancerTaxonomy(
  taxonomyDb: CancerTaxonomyDescriptorReader,
  meshDb: MeshDescriptorNameReader,
): Promise<TaxonomyLookup> {
  if (cached) return cached;

  const rows = await taxonomyDb.findMany({
    where: { cancerRelevant: true },
    select: { descriptorUi: true, topics: true },
  });
  const topicsByUi = new Map<string, string[]>(
    rows.map((r) => [
      r.descriptorUi,
      // `topics` is JSON, so unknown-typed at the type level — never trust the
      // blob's shape blindly, same defensive narrowing the old taxonomy used
      // for `treeNumbers`.
      Array.isArray(r.topics) ? r.topics.filter((x): x is string => typeof x === "string") : [],
    ]),
  );

  const uis = [...topicsByUi.keys()];
  const nameByUi = new Map<string, string>();
  if (uis.length > 0) {
    const names = await meshDb.findMany({ where: { descriptorUi: { in: uis } }, select: { descriptorUi: true, name: true } });
    for (const n of names) nameByUi.set(n.descriptorUi, n.name);
  }

  cached = { topicsByUi, nameByUi };
  return cached;
}

/** A publication's own MeSH UIs hit the cancer taxonomy at all. */
export function isCancerRelated(meshUis: string[], lookup: TaxonomyLookup): boolean {
  return meshUis.some((ui) => lookup.topicsByUi.has(ui));
}

/** Which of the paper's own MeSH UIs actually fell in the taxonomy — the
 *  term-level detail `matchedTopics` rolls up into topic buckets. */
export function matchedUis(meshUis: string[], lookup: TaxonomyLookup): string[] {
  return meshUis.filter((ui) => lookup.topicsByUi.has(ui));
}

/**
 * Which topic(s) a paper's own MeSH UIs actually matched, rolled up and
 * deduped. A single matched descriptor can contribute MORE THAN ONE topic —
 * `topics` is a multi-valued facet (a descriptor may sit under both a
 * disease-site bucket and a cross-cutting `cc-*` bucket), so this is
 * intentional, not a bug. A matched descriptor with an empty `topics` array
 * contributes the literal string `"unassigned"` instead of nothing, so a
 * cancer-relevant-but-untagged match still shows up somewhere.
 */
export function matchedTopics(meshUis: string[], lookup: TaxonomyLookup): string[] {
  const out = new Set<string>();
  for (const ui of meshUis) {
    const topics = lookup.topicsByUi.get(ui);
    if (!topics) continue;
    if (topics.length === 0) out.add("unassigned");
    else for (const t of topics) out.add(t);
  }
  return [...out].sort();
}

export type TopicDetail = {
  topic: string;
  descriptorCount: number;
  exampleDescriptors: string[];
};

const EXAMPLE_CAP = 8;

/**
 * Groups the taxonomy by topic for display: how many descriptors carry each
 * topic, and a capped sample of their display names. A descriptor with no
 * topics groups under the literal `"unassigned"` bucket, same convention as
 * `matchedTopics`. The direct replacement for the old CSV taxonomy's
 * `buildTaxonomyDetail`/`CodeDetail` — same purpose (feeds the "How
 * cancer-relevance is determined" modal), new shape (topic-keyed instead of
 * disease-code-keyed). The old anchor/tree-number provenance detail is
 * deliberately NOT carried over here — the per-paper CSV export is the audit
 * surface for that level of detail, not this modal.
 */
export function buildTopicDetail(lookup: TaxonomyLookup): TopicDetail[] {
  const namesByTopic = new Map<string, string[]>();
  for (const [ui, topics] of lookup.topicsByUi) {
    const name = lookup.nameByUi.get(ui) ?? ui;
    const bucket = topics.length === 0 ? ["unassigned"] : topics;
    for (const topic of bucket) {
      const names = namesByTopic.get(topic) ?? [];
      names.push(name);
      namesByTopic.set(topic, names);
    }
  }

  return [...namesByTopic.entries()]
    .map(([topic, names]) => {
      const sorted = [...names].sort();
      return { topic, descriptorCount: sorted.length, exampleDescriptors: sorted.slice(0, EXAMPLE_CAP) };
    })
    .sort((a, b) => a.topic.localeCompare(b.topic));
}
