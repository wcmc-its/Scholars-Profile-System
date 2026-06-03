/**
 * Phase-0 discovery probe for the ED admin-role org-unit-managers feature
 * (docs/ed-admin-org-unit-roles-spec.md). RESOLVED FINDINGS (read-only):
 *
 *  - Populations are LDAP option-tagged subtypes of weillCornellEduCWID on the
 *    org-unit group entries under ou=orgunits,ou=Groups (objectClass
 *    weillCornellEduOrgUnit). cn = canonical N-code (= Department/Division.code).
 *    Tags: ;da (Dept Admin), ;iamdela, ;diva-iamdela  (also ;dd — EXCLUDED).
 *  - ldapts cannot filter on `attr;tag` (Invalid expression); fetch entries and
 *    read the tagged keys instead.
 *
 * This pass ENUMERATES the whole org-unit tree to size each population, list the
 * complete set of weillCornellEduCWID;* tag spellings actually present, and break
 * the admin-bearing units down by type (department/division/center) + level — so
 * the SPEC's population->entityType->role mapping is grounded in real data.
 *
 * Minimal-attribute discipline: requests unit cn/displayName/type/level + the
 * weillCornellEduCWID family only.
 *
 *   npx tsx etl/ed-admins/probe.ts
 */
import "dotenv/config";
import { openLdap } from "@/lib/sources/ldap";

const ROOT = "dc=weill,dc=cornell,dc=edu";
const ORGUNITS_BASE = `ou=orgunits,ou=Groups,${ROOT}`;
const IMPORT_TAGS = ["da", "iamdela", "diva-iamdela"]; // the three populations we import
const CWID = "weillcornelleducwid";

const arr = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)];
const first = (v: unknown): string | null => arr(v)[0] ?? null;

/** key -> tag ("" for the bare attr) for any weillCornellEduCWID[;tag] key. */
function cwidTag(key: string): string | null {
  const k = key.toLowerCase();
  if (k === CWID) return "";
  if (k.startsWith(CWID + ";")) return k.slice(CWID.length + 1);
  return null;
}

async function main(): Promise<void> {
  console.log(`base=${ORGUNITS_BASE}`);
  const client = await openLdap();
  try {
    const { searchEntries } = await client.search(ORGUNITS_BASE, {
      scope: "sub",
      filter: "(objectClass=weillCornellEduOrgUnit)",
      // Bare weillCornellEduCWID returns the attr AND all its tagged subtypes.
      attributes: [
        "cn",
        "displayName",
        "weillCornellEduType",
        "weillCornellEduOrgUnitLevel",
        "weillCornellEduCWID",
      ],
      paged: { pageSize: 500 },
      sizeLimit: 20000,
    });
    const entries = searchEntries as unknown as Record<string, unknown>[];
    console.log(`total org-unit entries: ${entries.length}\n`);

    // 1. Complete set of tag spellings present + how many units carry each.
    const tagUnitCount = new Map<string, number>();
    const tagCwids = new Map<string, Set<string>>();
    const typeLevel = new Map<string, number>(); // "type/level" -> unit count (admin-bearing)
    let adminBearing = 0;

    for (const e of entries) {
      const tagsHere = new Set<string>();
      for (const key of Object.keys(e)) {
        const tag = cwidTag(key);
        if (tag === null || tag === "") continue;
        tagsHere.add(tag);
        tagUnitCount.set(tag, (tagUnitCount.get(tag) ?? 0) + 1);
        const set = tagCwids.get(tag) ?? new Set<string>();
        for (const c of arr(e[key])) set.add(c.toLowerCase());
        tagCwids.set(tag, set);
      }
      const importHere = IMPORT_TAGS.some((t) => tagsHere.has(t));
      if (importHere) {
        adminBearing++;
        const t = first(e.weillCornellEduType) ?? "?";
        const lvl = first(e.weillCornellEduOrgUnitLevel) ?? "?";
        const key = `${t}/level${lvl}`;
        typeLevel.set(key, (typeLevel.get(key) ?? 0) + 1);
      }
    }

    console.log("=== all weillCornellEduCWID;<tag> spellings present ===");
    for (const [tag, units] of [...tagUnitCount.entries()].sort((a, b) => b[1] - a[1])) {
      const people = tagCwids.get(tag)?.size ?? 0;
      const imp = IMPORT_TAGS.includes(tag) ? "  <-- IMPORT" : "";
      console.log(`  ;${tag}: on ${units} units, ${people} distinct cwids${imp}`);
    }

    console.log(`\n=== admin-bearing units (any of ${IMPORT_TAGS.join("/")}) : ${adminBearing} ===`);
    for (const [k, n] of [...typeLevel.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${k}: ${n}`);
    }

    // 2. A few division (level2) examples carrying diva-iamdela, to confirm the
    //    "DivA = division" relationship empirically.
    console.log(`\n=== sample units per import tag (cn / type / level / displayName) ===`);
    for (const tag of IMPORT_TAGS) {
      const samples = entries
        .filter((e) => Object.keys(e).some((k) => cwidTag(k) === tag))
        .slice(0, 6);
      console.log(`\n  ;${tag}:`);
      for (const e of samples) {
        const key = Object.keys(e).find((k) => cwidTag(k) === tag)!;
        console.log(
          `    cn=${first(e.cn)}  type=${first(e.weillCornellEduType)}  level=${first(e.weillCornellEduOrgUnitLevel)}  "${first(e.displayName)}"  -> ${arr(e[key]).join(",")}`,
        );
      }
    }
  } finally {
    await client.unbind();
  }
}

main().catch((e) => {
  console.error("probe failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
