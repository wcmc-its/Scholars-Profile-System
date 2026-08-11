/**
 * Cancer taxonomy generator — pure TS port of the admit-exclude-readmit
 * closure in `build_cancer_taxonomy.py` (source: `~/Downloads/cancer files/`,
 * see `docs/cancer-taxonomy-ruleset.csv` for the checked-in ruleset this
 * runs against). No Python, no separate XML download: `descriptors` comes
 * from the already-persisted `MeshDescriptor` table
 * (`etl/mesh-descriptors/index.ts`), same source the Python script's
 * `--mesh desc<year>.xml` argument parses directly.
 *
 * Two axes, computed together:
 *   - `cancer_relevant` — (included \ excluded) ∪ readmitted, over the whole
 *     ruleset's rel_include_*, rel_exclude_*, and rel_readmit_term rows.
 *   - `topics` — multi-valued, often empty (`[]` = "unassigned", a legitimate
 *     value, never a data gap — never sum topic counts to a total).
 *
 * Rule processing order does NOT matter: every accumulator below is a pure
 * set union with no removal until the final `relevant` computation, so
 * `admittedBy`/`reviewFlags`/`topics` end up order-independent regardless of
 * CSV row order. This is what makes the port straightforward — there is no
 * precedence to get subtly wrong in translation, only the closure math.
 *
 * `sortStr` mirrors Python's default `sorted()` — UTF-16 code-unit order —
 * NOT `String.prototype.localeCompare`, which uses locale-aware ICU
 * collation and can reorder case/accented text differently than Python's
 * plain codepoint comparison. Golden-file byte-for-byte equivalence
 * (docs/cancer-taxonomy-golden — see the .test.ts alongside this file)
 * depends on using the same ordering as the source script.
 */
import { parseCsv } from "@/lib/cancer-center-mesh-taxonomy";

const REL_RULES = new Set([
  "rel_include_subtree",
  "rel_include_term",
  "rel_exclude_subtree",
  "rel_exclude_term",
  "rel_readmit_term",
]);
const TOPIC_RULES = new Set(["topic_subtree", "topic_term"]);
const EXPERIMENTAL_TOPIC = "cc-experimental-models";

export interface RuleRow {
  rule: string;
  descriptor: string;
  topic: string;
  fallback: string;
  flag: string;
  note: string;
}

export interface DescriptorInput {
  ui: string;
  name: string;
  treeNumbers: string[];
}

export interface GeneratedRow {
  descriptorUi: string;
  cancerRelevant: true;
  topics: string[];
  admittedBy: string[];
  reviewFlags: string[];
}

export interface UnresolvedRule {
  rule: string;
  descriptor: string;
}

/** A subtree rule whose anchor resolved but whose subtree contains NO
 *  descendants this MeSH release (`subtreeUis` returned only the anchor
 *  itself) — ruleset rot distinct from `unresolved`: the name still exists,
 *  but the family it was meant to sweep in has moved or emptied out. */
export interface EmptySubtreeRule {
  rule: string;
  descriptor: string;
}

export interface GenerateResult {
  rows: GeneratedRow[];
  unresolved: UnresolvedRule[];
  emptySubtrees: EmptySubtreeRule[];
}

function sortStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Parses the ruleset CSV and drops rows with no `rule` value (mirrors
 *  Python's `[r for r in csv.DictReader(fh) if r.get("rule")]`). Throws on
 *  an unrecognized rule type, same as the Python script's `sys.exit`. */
export function parseRuleset(csvText: string): RuleRow[] {
  const rows = parseCsv(csvText);
  const bad = new Set<string>();
  const out: RuleRow[] = [];
  for (const r of rows) {
    const rule = r.rule ?? "";
    if (!rule) continue;
    if (!REL_RULES.has(rule) && !TOPIC_RULES.has(rule)) bad.add(rule);
    out.push({
      rule,
      descriptor: r.descriptor ?? "",
      topic: r.topic ?? "",
      fallback: r.fallback ?? "",
      flag: r.flag ?? "",
      note: r.note ?? "",
    });
  }
  if (bad.size > 0) {
    throw new Error(`Unknown rule types in ruleset: ${[...bad].sort(sortStr).join(", ")}`);
  }
  return out;
}

export function generateCancerTaxonomy(
  rules: RuleRow[],
  descriptors: DescriptorInput[],
): GenerateResult {
  const byUi = new Map<string, DescriptorInput>();
  const byName = new Map<string, DescriptorInput>();
  const treeIndex = new Map<string, string>();
  for (const d of descriptors) {
    byUi.set(d.ui, d);
    byName.set(d.name.toLowerCase(), d); // last-write-wins on a duplicate name, matches Python dict overwrite
    for (const t of d.treeNumbers) treeIndex.set(t, d.ui); // ditto for a duplicate tree number
  }

  const included = new Set<string>();
  const excluded = new Set<string>();
  const readmitted = new Set<string>();
  const admittedBy = new Map<string, Set<string>>();
  const reviewHits = new Map<string, Set<string>>();
  const topics = new Map<string, Set<string>>();
  const fallbackTopics = new Map<string, Set<string>>();
  const experimental = new Set<string>();

  const unresolved: UnresolvedRule[] = [];
  const emptySubtrees: EmptySubtreeRule[] = [];

  function addTo(m: Map<string, Set<string>>, ui: string, val: string): void {
    let s = m.get(ui);
    if (!s) {
      s = new Set();
      m.set(ui, s);
    }
    s.add(val);
  }

  function subtreeUis(rec: DescriptorInput): Set<string> {
    const out = new Set<string>([rec.ui]);
    if (rec.treeNumbers.length === 0) return out;
    const prefixes = rec.treeNumbers.map((t) => t + ".");
    for (const [tree, ui] of treeIndex) {
      if (prefixes.some((p) => tree.startsWith(p))) out.add(ui);
    }
    return out;
  }

  for (const r of rules) {
    const { rule, descriptor: name } = r;
    const rec = byName.get(name.trim().toLowerCase());
    if (!rec) {
      unresolved.push({ rule, descriptor: name });
      continue;
    }
    const expand = rule.endsWith("_subtree");
    const uis = expand ? subtreeUis(rec) : new Set([rec.ui]);
    if (expand && uis.size === 1) emptySubtrees.push({ rule, descriptor: name });

    if (REL_RULES.has(rule)) {
      const target =
        rule === "rel_exclude_subtree" || rule === "rel_exclude_term"
          ? excluded
          : rule === "rel_readmit_term"
            ? readmitted
            : included;
      for (const u of uis) target.add(u);
      if (rule.startsWith("rel_include") || rule === "rel_readmit_term") {
        for (const u of uis) addTo(admittedBy, u, name);
      }
    } else {
      const topic = r.topic || "";
      if (topic) {
        const bucket = r.fallback.trim() ? fallbackTopics : topics;
        for (const u of uis) addTo(bucket, u, topic);
        if (topic === EXPERIMENTAL_TOPIC) for (const u of uis) experimental.add(u);
      }
    }

    if (r.flag.trim() === "review") {
      for (const u of uis) addTo(reviewHits, u, `${rule}:${name}`);
    }
  }

  const relevant = new Set<string>();
  for (const u of included) if (!excluded.has(u)) relevant.add(u);
  for (const u of readmitted) relevant.add(u);

  const rows: GeneratedRow[] = [...relevant]
    .sort((a, b) => sortStr(byUi.get(a)!.name, byUi.get(b)!.name))
    .map((ui) => {
      let assigned = new Set(topics.get(ui) ?? []);
      if (experimental.has(ui)) {
        // Model-system records count as cancer research but must not
        // attribute to a human disease site.
        assigned = new Set([...assigned].filter((t) => t.startsWith("cc-")));
        assigned.add(EXPERIMENTAL_TOPIC);
      }
      if (assigned.size === 0) assigned = new Set(fallbackTopics.get(ui) ?? []);
      const admitted = admittedBy.get(ui);
      return {
        descriptorUi: ui,
        cancerRelevant: true as const,
        topics: [...assigned].sort(sortStr),
        admittedBy: admitted ? [...admitted].sort(sortStr) : ["(subtree)"],
        reviewFlags: [...(reviewHits.get(ui) ?? [])].sort(sortStr),
      };
    });

  return { rows, unresolved, emptySubtrees };
}
