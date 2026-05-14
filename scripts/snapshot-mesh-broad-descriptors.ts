/**
 * Generates `docs/spec-snapshots/mesh-broad-descriptors-2026-05.json` — the
 * frozen list of MeSH descriptors with > 50 tree-walk descendants as of
 * spec-commit. Referenced by SPEC-issue-259-mesh-defaults-rebalance §4
 * Option C deferral criterion. Mirrors the runtime algorithm the §5.4.2
 * resolver precompute will use, so the snapshot and the runtime stay
 * structurally aligned.
 *
 * Run: `tsx scripts/snapshot-mesh-broad-descriptors.ts`
 */
import { prisma } from "@/lib/db";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DESCENDANT_CAP = 200; // mirrors §5.6 DESCENDANT_HARD_CAP
const BROAD_THRESHOLD = 50; // §4 Option C: descendants > 50 → "broad"

type Row = {
  descriptorUi: string;
  name: string;
  treeNumbers: unknown; // JSON column
};

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

async function main() {
  const rows = (await prisma.meshDescriptor.findMany({
    select: { descriptorUi: true, name: true, treeNumbers: true },
  })) as Row[];

  // Build (tree_number → descriptorUi) sorted index for prefix lookups.
  type Pair = { tn: string; ui: string };
  const flat: Pair[] = [];
  for (const r of rows) {
    const tns = asStringArray(r.treeNumbers);
    for (const tn of tns) flat.push({ tn, ui: r.descriptorUi });
  }
  flat.sort((a, b) => (a.tn < b.tn ? -1 : a.tn > b.tn ? 1 : 0));

  // Binary search the first entry where flat[i].tn >= prefix.
  function lowerBound(prefix: string): number {
    let lo = 0;
    let hi = flat.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (flat[mid].tn < prefix) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // Two passes: the capped set mirrors the runtime resolver precompute
  // (§5.4.2, bounded by DESCENDANT_CAP) — this is the value Option C's gate
  // reads. The uncapped count is informational only: lets the post-flip retro
  // bucket "barely broad" (51) vs "extremely broad" (4000+) descriptors when
  // diagnosing eval-corpus regressions. Gate semantics are unchanged.
  function descendantsOf(
    treeNumbers: string[],
    cap: number,
  ): Set<string> {
    const out = new Set<string>();
    for (const parentTn of treeNumbers) {
      const prefix = `${parentTn}.`;
      let i = lowerBound(prefix);
      while (i < flat.length && flat[i].tn.startsWith(prefix)) {
        out.add(flat[i].ui);
        if (out.size >= cap) return out;
        i++;
      }
    }
    return out;
  }

  type BroadEntry = {
    descriptorUi: string;
    name: string;
    descendantCount: number;
    descendantCountTrue: number;
    treeNumbers: string[];
  };
  const broad: BroadEntry[] = [];
  const UNCAPPED = Number.POSITIVE_INFINITY;
  for (const r of rows) {
    const tns = asStringArray(r.treeNumbers);
    const trueSet = descendantsOf(tns, UNCAPPED);
    trueSet.delete(r.descriptorUi); // descendants exclude self
    if (trueSet.size <= BROAD_THRESHOLD) continue;
    const cappedSet = descendantsOf(tns, DESCENDANT_CAP);
    cappedSet.delete(r.descriptorUi);
    broad.push({
      descriptorUi: r.descriptorUi,
      name: r.name,
      descendantCount: cappedSet.size,
      descendantCountTrue: trueSet.size,
      treeNumbers: tns,
    });
  }
  broad.sort(
    (a, b) =>
      b.descendantCountTrue - a.descendantCountTrue ||
      a.descriptorUi.localeCompare(b.descriptorUi),
  );

  const out = {
    spec: "SPEC-issue-259-mesh-defaults-rebalance",
    purpose:
      "Frozen list of broad MeSH descriptors (descendantCount > 50) referenced by §4 Option C deferral criterion. Snapshot is committed alongside the SPEC; subsequent corpus shifts do not move the gate. Refresh only on deliberate SPEC amendment.",
    generatedAt: new Date().toISOString(),
    algorithm: {
      descendantsOf:
        "Set of distinct descriptorUis whose tree_number is prefix-subsumed (LIKE 'parent.%') by any of the parent's tree_numbers. Self is excluded.",
      cap: DESCENDANT_CAP,
      threshold: BROAD_THRESHOLD,
      fields: {
        descendantCount:
          "Capped at cap. Mirrors §5.4.2 runtime precompute and feeds §4 Option C's gate (the load-bearing value).",
        descendantCountTrue:
          "Uncapped. Informational only — lets the post-flip retro bucket descriptors by true breadth ('barely broad' vs 'extremely broad'). Does NOT affect Option C gate membership.",
      },
    },
    counts: {
      totalDescriptors: rows.length,
      broadDescriptors: broad.length,
    },
    descriptors: broad,
  };

  const path =
    "docs/spec-snapshots/mesh-broad-descriptors-2026-05.json";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
  console.log(
    `Wrote ${path} — ${broad.length} broad descriptors out of ${rows.length} total.`,
  );
  console.log(`Top 5 by true descendant count:`);
  for (const b of broad.slice(0, 5)) {
    console.log(
      `  ${b.descriptorUi}  ${b.name.padEnd(50)}  true=${b.descendantCountTrue}  capped=${b.descendantCount}`,
    );
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
