/**
 * `/edit/research-security` — the methods and tools ReciterAI inferred from
 * the text of a set of flagged papers, for the person and entity cards.
 *
 * The source is the Methods lens substrate: `scholar_family` (method families)
 * and `scholar_tool` (named tools), each a per-scholar rollup that keeps the
 * PMIDs it was observed in. A paper's methods are therefore found through the
 * rows of OUR confirmed authors on it, intersected with the paper set. Nothing
 * here says what a co-author contributed or what was shared: it is what the
 * paper's text was read as using.
 *
 * Coverage is partial by construction: PubMed papers only, and only papers
 * with an author who has a row (in practice active WCM scholars). The result
 * carries how many papers were covered so the card can say so.
 *
 * The #800 suppression overlay applies as everywhere (families too generic to
 * inform). The #801 sensitivity overlay does NOT hide anything: this page is a
 * gated internal surface, so a sensitive family is shown and marked.
 */
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { isMethodsLensEnabled } from "@/lib/profile/methods-lens-flags";

export type MethodsClient = Pick<
  PrismaClient,
  "scholarFamily" | "scholarTool" | "familySuppressionOverlay" | "familySensitivityOverlay"
>;

/** The papers to look in and the people whose rows are read for them. */
export type PaperScope = {
  /** Our confirmed authors on the papers, most papers first. */
  cwids: string[];
  /** The papers' PMIDs (a non-PubMed paper has none and cannot be covered). */
  pmids: number[];
  /** All the papers in the set, PubMed or not. */
  papers: number;
};

export type InferredMethods = {
  /** Papers in the set, how many are in PubMed, and how many had any method or tool. */
  papers: number;
  pubmedPapers: number;
  papersCovered: number;
  /** True when the set has more people than are read (see `METHODS_PEOPLE_CAP`). */
  peopleCapped: boolean;
  familyCount: number;
  toolCount: number;
  /** Method families, most papers first; at most `METHODS_SHOWN`. */
  families: Array<{
    supercategory: string;
    label: string;
    definition: string | null;
    /** On the #801 sensitivity overlay (hidden on public profiles). */
    sensitive: boolean;
    papers: number;
    people: number;
  }>;
  /** Named tools, most papers first; at most `TOOLS_SHOWN`. */
  tools: Array<{ name: string; category: string | null; papers: number; people: number }>;
};

/** Rows are read for at most this many people, the ones on the most papers. */
export const METHODS_PEOPLE_CAP = 400;
export const METHODS_SHOWN = 14;
export const TOOLS_SHOWN = 18;
const CHUNK = 200;

type FamilyRow = {
  cwid: string;
  supercategory: string;
  familyLabel: string;
  definition: string | null;
  pmids: unknown;
};
type ToolRow = { cwid: string; toolName: string; category: string | null; pmids: unknown };

const overlayKey = (supercategory: string, familyLabel: string) => `${supercategory}::${familyLabel}`;

/** The PMIDs of a row (stored as a JSON array of numbers or digit strings)
 *  that are in the paper set. */
function hits(pmids: unknown, wanted: ReadonlySet<number>): number[] {
  if (!Array.isArray(pmids)) return [];
  const out: number[] = [];
  for (const p of pmids) {
    const n = typeof p === "number" ? p : Number(p);
    if (Number.isInteger(n) && wanted.has(n)) out.push(n);
  }
  return out;
}

/** Pure: the rows of the scope's people rolled up to the paper set. */
export function rollUpMethods(
  scope: PaperScope,
  families: readonly FamilyRow[],
  tools: readonly ToolRow[],
  overlays: { suppressed: ReadonlySet<string>; sensitive: ReadonlySet<string> },
): InferredMethods {
  const wanted = new Set(scope.pmids);
  const covered = new Set<number>();
  type Tally = { papers: Set<number>; people: Set<string> };
  const add = <T extends Tally>(m: Map<string, T>, k: string, make: () => T, cwid: string, found: number[]) => {
    const t = m.get(k) ?? make();
    for (const p of found) {
      t.papers.add(p);
      covered.add(p);
    }
    t.people.add(cwid.toLowerCase());
    m.set(k, t);
  };

  const fam = new Map<string, Tally & { supercategory: string; label: string; definition: string | null }>();
  for (const r of families) {
    const k = overlayKey(r.supercategory, r.familyLabel);
    if (overlays.suppressed.has(k)) continue;
    const found = hits(r.pmids, wanted);
    if (found.length === 0) continue;
    add(
      fam,
      k,
      () => ({
        supercategory: r.supercategory,
        label: r.familyLabel,
        definition: r.definition,
        papers: new Set(),
        people: new Set(),
      }),
      r.cwid,
      found,
    );
  }
  const tool = new Map<string, Tally & { name: string; category: string | null }>();
  for (const r of tools) {
    const found = hits(r.pmids, wanted);
    if (found.length === 0) continue;
    add(
      tool,
      r.toolName.toLowerCase(),
      () => ({ name: r.toolName, category: r.category, papers: new Set(), people: new Set() }),
      r.cwid,
      found,
    );
  }
  const rank = <T extends { papers: number; people: number }>(rows: T[], name: (r: T) => string) =>
    rows.sort((a, b) => b.papers - a.papers || b.people - a.people || name(a).localeCompare(name(b)));

  return {
    papers: scope.papers,
    pubmedPapers: scope.pmids.length,
    papersCovered: covered.size,
    peopleCapped: scope.cwids.length > METHODS_PEOPLE_CAP,
    familyCount: fam.size,
    toolCount: tool.size,
    families: rank(
      [...fam.entries()].map(([k, f]) => ({
        supercategory: f.supercategory,
        label: f.label,
        definition: f.definition,
        sensitive: overlays.sensitive.has(k),
        papers: f.papers.size,
        people: f.people.size,
      })),
      (f) => f.label,
    ).slice(0, METHODS_SHOWN),
    tools: rank(
      [...tool.values()].map((t) => ({
        name: t.name,
        category: t.category,
        papers: t.papers.size,
        people: t.people.size,
      })),
      (t) => t.name,
    ).slice(0, TOOLS_SHOWN),
  };
}

/**
 * The inferred methods and tools of a paper set. Null when the Methods lens
 * substrate is off (`METHODS_LENS_ENABLED`) or the set has nothing to look in,
 * so a card shows no section instead of an empty one.
 */
export async function loadInferredMethods(
  client: MethodsClient,
  scope: PaperScope,
): Promise<InferredMethods | null> {
  if (!isMethodsLensEnabled()) return null;
  if (scope.pmids.length === 0 || scope.cwids.length === 0) return null;
  const cwids = scope.cwids.slice(0, METHODS_PEOPLE_CAP);
  const families: FamilyRow[] = [];
  const tools: ToolRow[] = [];
  for (let i = 0; i < cwids.length; i += CHUNK) {
    const chunk = cwids.slice(i, i + CHUNK);
    const [f, t] = await Promise.all([
      client.scholarFamily.findMany({
        where: { cwid: { in: chunk } },
        select: { cwid: true, supercategory: true, familyLabel: true, definition: true, pmids: true },
      }),
      client.scholarTool.findMany({
        where: { cwid: { in: chunk } },
        select: { cwid: true, toolName: true, category: true, pmids: true },
      }),
    ]);
    families.push(...f);
    tools.push(...t);
  }
  const [suppressed, sensitive] = await Promise.all([
    client.familySuppressionOverlay.findMany({ select: { supercategory: true, familyLabel: true } }),
    client.familySensitivityOverlay.findMany({ select: { supercategory: true, familyLabel: true } }),
  ]);
  const keys = (rows: Array<{ supercategory: string; familyLabel: string }>) =>
    new Set(rows.map((r) => overlayKey(r.supercategory, r.familyLabel)));
  return rollUpMethods(scope, families, tools, {
    suppressed: keys(suppressed),
    sensitive: keys(sensitive),
  });
}
