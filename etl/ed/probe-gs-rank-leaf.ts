/**
 * Gate probe for #1034 (Jenzabar GS title normalization, Rule B).
 *
 * Rule B sets a Grad-School faculty member's professorial rank from the
 * ASMS-authoritative person-type code rather than the Jenzabar `INSTRUCTOR
 * TYPE` string. The hypothesized rank leaves live in the multi-valued
 * `weillCornellEduPersonTypeCode` attribute:
 *
 *     academic-faculty-assistant     -> Assistant Professor
 *     academic-faculty-associate     -> Associate Professor
 *     academic-faculty-fullprofessor -> Professor
 *
 * BUT `etl/ed/index.ts:deriveRoleCategory` does not reference these leaves
 * today, so we do not actually know (a) whether they are emitted at all, or
 * (b) their exact spelling. This probe answers both against live LDAP before
 * any Rule B code is written. It does not assume the spellings — it tallies
 * every `academic-faculty-*` leaf that is actually present.
 *
 * Two modes:
 *   - Discovery (no args): paged scan of ou=people for the faculty population,
 *     tallying every distinct `weillCornellEduPersonTypeCode` value, then
 *     flagging the rank-shaped leaves and reporting whether the three names
 *     above are present and with what counts.
 *   - Per-CWID (args): dump the full person-type array + primary title for each
 *     named CWID (e.g. a known full professor like `fslee`) to confirm the
 *     leaf-to-rank mapping on real records.
 *
 * Read-only. Must run on the WCM network / in-VPC where LDAP is reachable
 * (the bind times out elsewhere — see #443). Run:
 *   npx tsx etl/ed/probe-gs-rank-leaf.ts                 # discovery tally
 *   npx tsx etl/ed/probe-gs-rank-leaf.ts fslee abc1234   # per-CWID dump
 */
import "dotenv/config";
import { openLdap, DEFAULT_SEARCH_BASE } from "@/lib/sources/ldap";

/** Faculty population: entries carrying the `academic-faculty` umbrella leaf
 *  (same value the superuser memberURL rule matches, probe-superuser-check.ts). */
const FACULTY_FILTER = "(weillCornellEduPersonTypeCode=academic-faculty)";

/** The leaf names Rule B hypothesizes. We report presence/counts for these by
 *  exact match, but the tally below surfaces the real taxonomy regardless. */
const HYPOTHESIZED_RANK_LEAVES = [
  "academic-faculty-assistant",
  "academic-faculty-associate",
  "academic-faculty-fullprofessor",
];

/** Tokens that make a leaf look rank-bearing, used only to highlight candidates
 *  in the discovery tally. Intentionally broad so we don't miss an unexpected
 *  spelling (e.g. "-professor", "-full", "-asst"). */
const RANK_SHAPED = /-(assistant|associate|full|professor|asst|assoc|prof)/i;

/** ldapts returns a multi-valued attribute as string | string[] | undefined. */
function toArray(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map((x) => String(x));
  return [String(v)];
}

async function discover(): Promise<void> {
  const client = await openLdap();
  try {
    console.log(`Scanning ${DEFAULT_SEARCH_BASE} for ${FACULTY_FILTER} ...`);
    const { searchEntries } = await client.search(DEFAULT_SEARCH_BASE, {
      scope: "sub",
      filter: FACULTY_FILTER,
      attributes: ["weillCornellEduPersonTypeCode"],
      paged: { pageSize: 500 },
    });

    const tally = new Map<string, number>();
    for (const e of searchEntries) {
      const codes = toArray(
        (e as unknown as Record<string, unknown>).weillCornellEduPersonTypeCode,
      );
      for (const c of codes) tally.set(c, (tally.get(c) ?? 0) + 1);
    }

    const sorted = [...tally.entries()].sort((a, b) => b[1] - a[1]);
    console.log(`\nFaculty entries scanned: ${searchEntries.length}`);
    console.log(`Distinct weillCornellEduPersonTypeCode values: ${sorted.length}\n`);
    console.log("  count   value");
    console.log("  -----   -----");
    for (const [value, count] of sorted) {
      const flag = RANK_SHAPED.test(value) ? "  <- rank-shaped" : "";
      console.log(`  ${String(count).padStart(5)}   ${value}${flag}`);
    }

    console.log("\nRule B gate — hypothesized rank leaves:");
    let allPresent = true;
    for (const leaf of HYPOTHESIZED_RANK_LEAVES) {
      const count = tally.get(leaf) ?? 0;
      if (count === 0) allPresent = false;
      console.log(`  ${count > 0 ? "PRESENT" : "ABSENT "}  ${leaf}  (${count})`);
    }
    console.log(
      allPresent
        ? "\nVERDICT: all three leaves present — Rule B can derive rank from person-type code."
        : "\nVERDICT: at least one leaf ABSENT — inspect the rank-shaped values above for the real\n" +
            "spelling, or confirm the authoritative rank lives elsewhere (direct ASMS query). Rule B\n" +
            "is blocked until the rank source is confirmed (#1034 open Q2).",
    );
  } finally {
    await client.unbind();
  }
}

async function dumpCwids(cwids: string[]): Promise<void> {
  const client = await openLdap();
  try {
    for (const cwid of cwids) {
      const userDn = `uid=${cwid},${DEFAULT_SEARCH_BASE}`;
      console.log(`\n${cwid}  (${userDn})`);
      try {
        const { searchEntries } = await client.search(userDn, {
          scope: "base",
          filter: "(objectClass=*)",
          attributes: [
            "weillCornellEduPersonTypeCode",
            "weillCornellEduPrimaryPersonTypeCode",
            "weillCornellEduPrimaryTitle",
            "title",
          ],
        });
        if (searchEntries.length === 0) {
          console.log("  (no person entry)");
          continue;
        }
        const e = searchEntries[0] as unknown as Record<string, unknown>;
        const codes = toArray(e.weillCornellEduPersonTypeCode);
        const rankLeaves = codes.filter((c) => RANK_SHAPED.test(c));
        console.log(`  primaryTitle        : ${JSON.stringify(e.weillCornellEduPrimaryTitle ?? e.title ?? null)}`);
        console.log(`  primaryPersonType   : ${JSON.stringify(e.weillCornellEduPrimaryPersonTypeCode ?? null)}`);
        console.log(`  personTypeCode[]    : ${JSON.stringify(codes)}`);
        console.log(`  rank-shaped leaves  : ${JSON.stringify(rankLeaves)}`);
      } catch (err) {
        console.log(`  (lookup failed: ${err instanceof Error ? err.message : String(err)})`);
      }
    }
  } finally {
    await client.unbind();
  }
}

async function main(): Promise<void> {
  const cwids = process.argv.slice(2);
  if (cwids.length > 0) await dumpCwids(cwids);
  else await discover();
}

main().catch((e) => {
  console.error("probe failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
