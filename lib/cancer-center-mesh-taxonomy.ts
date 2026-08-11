/**
 * Cancer-relevance MeSH-subtree matching (v2 collaboration-recommendations
 * plan). Ported from the unmerged `feat/cancer-center-disease-taxonomy`
 * branch's `scripts/cancer-center-disease-assignments.ts` — narrowly: just
 * `parseCsv` + `buildCodeByUi`, not that script's per-code attribution,
 * confidence tiers, or specialty corroboration (that whole ranking layer is
 * #2033, open/unfixed, and explicitly not reused here).
 *
 *   docs/cancer-center-disease-taxonomy.csv   18 disease codes -> NLM descriptors
 *
 * `loadTaxonomy` is the ONE place that reads the CSV + resolves it against the
 * live `MeshDescriptor` table — the weekly ETL step and every read-time
 * caller (the "How cancer-relevance is determined" modal, the per-paper
 * "why" CSV export) call this instead of each keeping its own copy, so
 * "cancer-related" can't quietly mean two different things depending on who
 * asks. Today this taxonomy is ONE shared, backend-curated list applied to
 * every Cancer Center system-wide — there's no per-center subset yet;
 * narrowing it for a specific center is a change to the CSV file, not a
 * self-service setting.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

export type Row = Record<string, string>;

/** Minimal RFC4180 reader: quoted fields, doubled quotes, `#` comment lines. */
export function parseCsv(text: string): Row[] {
  const lines: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); lines.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length) { row.push(field); lines.push(row); }
  const body = lines.filter((r) => r.length > 1 && !r[0].startsWith("#"));
  const header = body.shift();
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

export type Descriptor = { ui: string; name: string; treeNumbers: string[] };

/**
 * Map every MeSH descriptor UI to the disease code(s) whose subtree contains it.
 *
 * A descriptor can sit under two anchors when one anchor is itself a descendant
 * of the other -- `Melanoma` lives under `Neuroendocrine Tumors`, so a naive
 * walk hands every melanoma paper to the endocrine code. Keep only the MOST
 * SPECIFIC matching anchors: drop any whose tree number is a proper prefix of
 * another match.
 */
export function buildCodeByUi(
  descriptors: Descriptor[],
  taxonomy: Row[],
): { codeByUi: Map<string, Set<string>>; missing: string[] } {
  const treesByName = new Map<string, string[]>();
  for (const d of descriptors) if (!treesByName.has(d.name)) treesByName.set(d.name, d.treeNumbers);

  const anchors: Array<[string, string]> = [];
  const missing: string[] = [];
  for (const t of taxonomy) {
    const trees = treesByName.get(t.nlm_descriptor);
    if (!trees || trees.length === 0) missing.push(t.nlm_descriptor);
    else for (const tn of trees) anchors.push([tn, t.code]);
  }
  anchors.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));

  const codeByUi = new Map<string, Set<string>>();
  for (const d of descriptors) {
    const hits: Array<[string, string]> = [];
    for (const tn of d.treeNumbers) {
      for (const [atn, code] of anchors) {
        if (tn === atn || tn.startsWith(atn + ".")) hits.push([atn, code]);
      }
    }
    if (hits.length === 0) continue;
    const keep = hits.filter(([atn]) => !hits.some(([btn]) => btn !== atn && btn.startsWith(atn + ".")));
    codeByUi.set(d.ui, new Set(keep.map(([, c]) => c)));
  }
  return { codeByUi, missing };
}

/** A publication's own MeSH UIs hit the cancer taxonomy at all — the boolean
 *  this plan reuses `buildCodeByUi` for, deliberately dropping which code(s)
 *  matched (that's #2033's layer, not this one's question). */
export function isCancerRelated(meshUis: string[], codeByUi: Map<string, Set<string>>): boolean {
  return meshUis.some((ui) => codeByUi.has(ui));
}

/** Which disease code(s) a paper's own MeSH UIs actually matched — the exact
 *  reasoning `isCancerRelated` throws away for its boolean-only callers. Used
 *  by the per-paper "why" CSV export; never called from the weekly ETL step,
 *  which only needs the boolean. */
export function matchedCodes(meshUis: string[], codeByUi: Map<string, Set<string>>): string[] {
  const out = new Set<string>();
  for (const ui of meshUis) {
    const codes = codeByUi.get(ui);
    if (codes) for (const c of codes) out.add(c);
  }
  return [...out].sort();
}

/** Which of the paper's own MeSH UIs actually fell in the taxonomy — the
 *  term-level detail `matchedCodes` rolls up into disease codes. A caller
 *  wanting the human-readable term name(s) still needs a `ui -> name` map
 *  (e.g. `descriptors` from `loadTaxonomy`) to resolve these. */
export function matchedUis(meshUis: string[], codeByUi: Map<string, Set<string>>): string[] {
  return meshUis.filter((ui) => codeByUi.has(ui));
}

export type MeshDescriptorReader = {
  findMany: (args: {
    select: { descriptorUi: true; name: true; treeNumbers: true };
  }) => Promise<Array<{ descriptorUi: string; name: string; treeNumbers: unknown }>>;
};

let cached: { codeByUi: Map<string, Set<string>>; descriptors: Descriptor[]; taxonomy: Row[] } | null = null;

/** Reads the taxonomy CSV + the full `MeshDescriptor` table once per process
 *  and builds `codeByUi` — see the module doc comment for why every caller
 *  shares this instead of re-resolving its own copy. */
export async function loadTaxonomy(
  db: MeshDescriptorReader,
): Promise<{ codeByUi: Map<string, Set<string>>; descriptors: Descriptor[]; taxonomy: Row[] }> {
  if (cached) return cached;
  const csv = readFileSync(path.join(process.cwd(), "docs/cancer-center-disease-taxonomy.csv"), "utf8");
  const taxonomy = parseCsv(csv);
  const rows = await db.findMany({ select: { descriptorUi: true, name: true, treeNumbers: true } });
  const descriptors: Descriptor[] = rows.map((d) => ({
    ui: d.descriptorUi,
    name: d.name,
    treeNumbers: Array.isArray(d.treeNumbers) ? d.treeNumbers.filter((x): x is string => typeof x === "string") : [],
  }));
  const { codeByUi, missing } = buildCodeByUi(descriptors, taxonomy);
  if (missing.length) throw new Error(`unresolved NLM descriptors: ${missing.join(", ")}`);
  cached = { codeByUi, descriptors, taxonomy };
  return cached;
}

export type CodeDetail = {
  code: string;
  disease: string;
  anchors: Array<{ name: string; treeNumber: string }>;
  descendantCount: number;
  exampleDescendants: string[];
};

const EXAMPLE_CAP = 8;

/** Each disease code's display name — a code maps 1:1 to one disease across
 *  however many taxonomy rows/anchors share it. Shared so the modal and the
 *  per-paper CSV export can't independently derive two different labels for
 *  the same code. */
export function diseaseByCode(taxonomy: Row[]): Map<string, string> {
  return new Map(taxonomy.map((t) => [t.code, t.disease]));
}

/**
 * Groups the taxonomy by disease code for display: each code's own anchor
 * term(s) + real MeSH tree number(s), how many descriptors its subtree
 * actually covers, and a capped sample of their names (excluding the anchors
 * themselves, already shown separately). Built FROM `codeByUi` rather than
 * re-walking tree numbers, so the modal can never show a broader or
 * narrower subtree than what publications actually get matched against.
 */
export function buildTaxonomyDetail(
  taxonomy: Row[],
  descriptors: Descriptor[],
  codeByUi: Map<string, Set<string>>,
): CodeDetail[] {
  const nameByUi = new Map(descriptors.map((d) => [d.ui, d.name]));
  // A descriptor can carry MORE THAN ONE tree number (MeSH cross-lists some
  // concepts under multiple branches — same reason `buildCodeByUi` walks
  // every one of them as an independent match root, not just the first).
  // Show every tree number an anchor actually matches on, or a display here
  // would silently hide the exact branch that produced some of the
  // descendant terms below.
  const treesByName = new Map(descriptors.map((d) => [d.name, d.treeNumbers]));
  const anchorNames = new Set(taxonomy.map((t) => t.nlm_descriptor));

  const byCode = new Map<string, { disease: string; anchors: Array<{ name: string; treeNumber: string }> }>();
  for (const t of taxonomy) {
    const entry = byCode.get(t.code) ?? { disease: t.disease, anchors: [] };
    const trees = treesByName.get(t.nlm_descriptor) ?? [];
    for (const tn of trees.length > 0 ? trees : [""]) {
      entry.anchors.push({ name: t.nlm_descriptor, treeNumber: tn });
    }
    byCode.set(t.code, entry);
  }

  const descendantsByCode = new Map<string, string[]>();
  for (const [ui, codes] of codeByUi) {
    const name = nameByUi.get(ui);
    if (!name || anchorNames.has(name)) continue;
    for (const code of codes) {
      const arr = descendantsByCode.get(code) ?? [];
      arr.push(name);
      descendantsByCode.set(code, arr);
    }
  }

  return [...byCode.entries()].map(([code, { disease, anchors }]) => {
    const descendants = (descendantsByCode.get(code) ?? []).sort();
    return { code, disease, anchors, descendantCount: descendants.length, exampleDescendants: descendants.slice(0, EXAMPLE_CAP) };
  });
}
