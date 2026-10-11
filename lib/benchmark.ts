/**
 * Research-area benchmark snapshots (/about/research-areas).
 *
 * Snapshots are produced by ReciterAI (`docs/benchmark/export_json.py`) and
 * copied into data/benchmark/ by scripts/import-benchmark.sh. The page renders
 * them as-is and never re-derives results. Adding a snapshot is a data-only
 * change: the template-literal import below bundles every JSON file in the
 * directory (webpack context module), and index.json lists them.
 */
import { prisma } from "@/lib/db";
import index from "@/data/benchmark/index.json";

export type Relation = "exact" | "area_broader" | "area_narrower" | "overlap";
export type Frame = "B" | "C1" | "C2";

export type BenchmarkSnapshot = {
  schema_version: number;
  snapshot_date: string;
  taxonomy_version: string;
  methods_url: string;
  crosswalk_url: string;
  outputs_url: string;
  corpus: { description: string; home_threshold: { lift: number; min_papers: number } };
  headline: {
    A: {
      areas_with_home: number;
      areas_low_volume: number;
      areas_total: number;
      departments_covered: number;
      departments_total: number;
      divisions_covered: number;
      divisions_total: number;
    };
    B: { items_matched: number; items_in_scope: number; areas_matched: number };
    C1: { ics_matched: number; ics_total: number; areas_matched: number };
    C2: {
      categories_matched: number;
      categories_total: number;
      areas_matched: number;
      areas_exact: number;
      dollars_matched_pct: number;
    };
  };
  agreement: Record<
    Frame,
    {
      positive_agree: number;
      kappa_any: number;
      kappa_relation: number;
      adjudicated: number;
      gap_review_added: number;
      mapper1_pairs: number;
      mapper2_pairs: number;
      final_pairs: number;
    }
  >;
  spot_check: {
    sample: number;
    agree: number | null;
    rate: number | null;
    method: "human" | "automated" | null;
    reviewed_by: string | null;
    reviewed_on: string | null;
    disagreements: { ref_name: string; note: string }[];
  };
  areas: {
    id: string;
    label: string;
    papers: number;
    unit_status: "home" | "low_volume" | "no_home";
    largest_dept: string;
    best: Record<Frame, Relation | "none">;
  }[];
  units: {
    id: string;
    level: "department" | "division";
    name: string;
    parent: string | null;
    status: "covered" | "low_volume" | "not_covered" | "no_papers";
  }[];
  references: {
    frame: Frame;
    id: string;
    name: string;
    in_scope: boolean;
    best: Relation | "none" | "out_of_scope";
    note?: string | null;
    detail: { pillar?: string; section?: string; fy2025_musd?: number };
  }[];
  unit_cells: { area: string; unit: string; n: number; share: number; lift: number }[];
  pairs: {
    frame: Frame;
    area: string;
    ref: string;
    relation: Relation;
    source: "agreed" | "adjudicated" | "gap_review";
    rationale: string;
  }[];
};

export type SnapshotEntry = { date: string; taxonomy_version: string; file: string; note: string };

/** Newest first. */
export const SNAPSHOTS: SnapshotEntry[] = [...index.snapshots].sort((a, b) =>
  b.date.localeCompare(a.date),
);
export const LATEST = SNAPSHOTS[0];

export async function loadSnapshot(date: string): Promise<BenchmarkSnapshot | null> {
  const entry = SNAPSHOTS.find((s) => s.date === date);
  if (!entry) return null;
  const mod = await import(`@/data/benchmark/${entry.file}`);
  return (mod.default ?? mod) as BenchmarkSnapshot;
}

/**
 * Live SPS hrefs for the ids a snapshot names. Anything missing (a retired
 * area or unit in an older snapshot) renders as plain text, not a broken link.
 */
export type BenchmarkLinks = { areas: Record<string, string>; units: Record<string, string> };

export async function loadBenchmarkLinks(): Promise<BenchmarkLinks> {
  const [topics, depts, divs] = await Promise.all([
    prisma.topic.findMany({ select: { id: true } }),
    prisma.department.findMany({ select: { code: true, slug: true } }),
    prisma.division.findMany({
      select: { code: true, slug: true, department: { select: { slug: true } } },
    }),
  ]);
  const units: Record<string, string> = {};
  for (const d of depts) units[d.code] = `/departments/${d.slug}`;
  for (const d of divs) units[d.code] = `/departments/${d.department.slug}/divisions/${d.slug}`;
  return {
    areas: Object.fromEntries(topics.map((t) => [t.id, `/topics/${t.id}`])),
    units,
  };
}
