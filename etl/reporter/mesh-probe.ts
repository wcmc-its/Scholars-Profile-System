/**
 * Issue #295 — read-only sampling probe for the RePORTER-keyword → MeSH
 * resolution pass. Run this BEFORE the resolver code lands:
 *
 *   npm run etl:reporter:probe
 *
 * It reports three things the PLAN (`.planning/drafts/PLAN-issue-295-*.md`)
 * depends on:
 *
 *   1. Baseline resolution rate — the AC (a) number that goes in the PR
 *      description as the monitored baseline.
 *   2. Top-50 most-frequent RCDC terms — seeds `MESH_RESOLVE_STOPWORDS`
 *      (the curated ignore-list) for `etl/reporter/mesh.ts`.
 *   3. Normalized-form collision rate — finalizes PLAN decision D1
 *      (single-pass vs. the issue's two-pass grant-local-coverage resolver).
 *
 * Read-only: issues no writes. Prerequisites — `mesh_descriptor` populated
 * (run `npm run etl:mesh` if `SELECT COUNT(*) FROM mesh_descriptor` is ~0)
 * and `grant.keywords` populated (issue #291).
 */
import { prisma } from "../../lib/db";
import { resolveMeshDescriptor, normalizeForMatch } from "@/lib/api/search-taxonomy";

/** Mirrors MIN_QUERY_LEN in `lib/api/search-taxonomy.ts` — the resolver
 *  ignores normalized forms shorter than this. */
const MIN_FORM_LEN = 3;

/** Coerce a JSON column value to a clean string[]. */
function asStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string" && x.length > 0);
}

function pct(n: number, d: number): string {
  return d === 0 ? "0%" : `${((100 * n) / d).toFixed(1)}%`;
}

async function main() {
  // ── 1. Build form → descriptorUi[] from mesh_descriptor ──────────────────
  // This is the `byForm` index `getMeshMap()` builds privately; replicated
  // here only to measure collisions (forms that map to >1 descriptor).
  const descriptors = await prisma.meshDescriptor.findMany({
    select: { descriptorUi: true, name: true, entryTerms: true },
  });
  if (descriptors.length === 0) {
    console.error(
      "[probe] mesh_descriptor is empty — run `npm run etl:mesh` first. Aborting.",
    );
    return;
  }
  const byForm = new Map<string, Set<string>>();
  for (const d of descriptors) {
    for (const f of [d.name, ...asStringArray(d.entryTerms)]) {
      const key = normalizeForMatch(f);
      if (!key) continue;
      const s = byForm.get(key);
      if (s) s.add(d.descriptorUi);
      else byForm.set(key, new Set([d.descriptorUi]));
    }
  }
  console.log(
    `[probe] mesh_descriptor: ${descriptors.length} descriptors, ` +
      `${byForm.size} distinct normalized match forms.`,
  );

  // ── 2. Load grant keywords ───────────────────────────────────────────────
  const grants = await prisma.grant.findMany({ select: { id: true, keywords: true } });
  const withKeywords = grants.filter((g) => asStringArray(g.keywords).length > 0);
  console.log(
    `[probe] grant: ${grants.length} rows, ${withKeywords.length} with non-empty keywords.`,
  );
  if (withKeywords.length === 0) {
    console.error("[probe] no grant carries keywords — run `npm run etl:reporter` first. Aborting.");
    return;
  }

  // ── 3. Resolve every distinct normalized form (cached once per form) ─────
  const formFreq = new Map<string, number>();   // form → # of grants carrying it
  const formSample = new Map<string, string>(); // form → a raw sample for display
  const resolvedCache = new Map<string, Awaited<ReturnType<typeof resolveMeshDescriptor>>>();
  let grantsWithResolved = 0;

  for (const g of withKeywords) {
    const forms = new Set<string>();
    for (const kw of asStringArray(g.keywords)) {
      const f = normalizeForMatch(kw);
      if (f.length < MIN_FORM_LEN) continue;
      forms.add(f);
      if (!formSample.has(f)) formSample.set(f, kw);
    }
    let grantHasResolved = false;
    for (const f of forms) {
      formFreq.set(f, (formFreq.get(f) ?? 0) + 1);
      let r = resolvedCache.get(f);
      if (r === undefined) {
        r = await resolveMeshDescriptor(f);
        resolvedCache.set(f, r);
      }
      if (r) grantHasResolved = true;
    }
    if (grantHasResolved) grantsWithResolved += 1;
  }

  // ── 4. Aggregate ─────────────────────────────────────────────────────────
  const uniqueForms = [...formFreq.keys()];
  let resolvedForms = 0;
  const collisionForms: string[] = [];
  let collisionOccurrences = 0;
  let totalOccurrences = 0;
  for (const f of uniqueForms) {
    if (resolvedCache.get(f)) resolvedForms += 1;
    const freq = formFreq.get(f) ?? 0;
    totalOccurrences += freq;
    const cands = byForm.get(f);
    if (cands && cands.size > 1) {
      collisionForms.push(f);
      collisionOccurrences += freq;
    }
  }

  console.log("\n=== Baseline — issue #295 AC (a) ===");
  console.log(`Distinct normalized term forms : ${uniqueForms.length}`);
  console.log(
    `  …resolving to a descriptor    : ${resolvedForms} (${pct(resolvedForms, uniqueForms.length)})`,
  );
  console.log(
    `Grants gaining ≥1 descriptor   : ${grantsWithResolved}/${withKeywords.length} ` +
      `(${pct(grantsWithResolved, withKeywords.length)})`,
  );

  console.log("\n=== Collision rate — PLAN decision D1 ===");
  console.log(
    `Forms mapping to >1 descriptor : ${collisionForms.length}/${uniqueForms.length} ` +
      `(${pct(collisionForms.length, uniqueForms.length)})`,
  );
  console.log(
    `  …weighted by grant occurrence: ${collisionOccurrences}/${totalOccurrences} ` +
      `(${pct(collisionOccurrences, totalOccurrences)})`,
  );
  console.log(
    collisionForms.length === 0
      ? "  → zero collisions: single-pass resolution is unambiguous."
      : "  → if this is material, schedule Pass B (PLAN §7); else single-pass stands.",
  );
  if (collisionForms.length > 0) {
    const shown = collisionForms
      .sort((a, b) => (formFreq.get(b) ?? 0) - (formFreq.get(a) ?? 0))
      .slice(0, 40);
    for (const f of shown) {
      const uis = [...(byForm.get(f) ?? [])].join(", ");
      console.log(
        `    "${formSample.get(f) ?? f}" ×${formFreq.get(f)} → {${uis}}`,
      );
    }
    if (collisionForms.length > shown.length) {
      console.log(`    …and ${collisionForms.length - shown.length} more.`);
    }
  }

  console.log(
    "\n=== Top-150 most-frequent RESOLVING terms — MESH_RESOLVE_STOPWORDS seed ===",
  );
  console.log("(unresolved terms excluded — a stopword entry for them is a no-op)");
  console.log("freq  resolved descriptor                               raw term");
  const top = uniqueForms
    .filter((f) => resolvedCache.get(f))
    .map((f) => ({ f, freq: formFreq.get(f) ?? 0 }))
    .sort((a, b) => b.freq - a.freq || a.f.localeCompare(b.f))
    .slice(0, 150);
  for (const { f, freq } of top) {
    const r = resolvedCache.get(f)!;
    const desc = `${r.descriptorUi} ${r.name}`;
    const cands = byForm.get(f);
    const coll = cands && cands.size > 1 ? `  [${cands.size}-way collision]` : "";
    console.log(
      `${String(freq).padStart(4)}  ${desc.padEnd(48).slice(0, 48)}  ` +
        `${formSample.get(f) ?? f}${coll}`,
    );
  }
  console.log(
    "\nReview the list above: terms that resolve but are uninformative " +
      "(generic research vocabulary, wrong-sense hits) are MESH_RESOLVE_STOPWORDS candidates.",
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
