/**
 * Cancer-relevance MeSH-subtree matching (v2 collaboration-recommendations
 * plan). Ported from the unmerged `feat/cancer-center-disease-taxonomy`
 * branch's `scripts/cancer-center-disease-assignments.ts` — narrowly: just
 * `parseCsv` + `buildCodeByUi`, not that script's per-code attribution,
 * confidence tiers, or specialty corroboration (that whole ranking layer is
 * #2033, open/unfixed, and explicitly not reused here).
 *
 *   docs/cancer-center-disease-taxonomy.csv   18 disease codes -> NLM descriptors
 */

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
