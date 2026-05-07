/**
 * One-off LDAP probe: dump every attribute returned for a single CWID across
 * BOTH the people branch (`ou=people`) and the faculty SOR
 * (`ou=faculty,ou=sors`). The faculty SOR is where per-appointment division
 * data lives — the people branch returns coarser dept-only metadata.
 *
 * Run: SCHOLARS_LDAP_URL=... SCHOLARS_LDAP_BIND_PASSWORD=... \
 *      npx tsx etl/ed/probe-cwid.ts ccole
 *
 * Pipe the output back so we can wire division extraction against the
 * actual attribute names returned by the SOR.
 */
import "dotenv/config";
import { openLdap } from "@/lib/sources/ldap";

const cwid = process.argv[2];
if (!cwid) {
  console.error("Usage: tsx etl/ed/probe-cwid.ts <cwid>");
  process.exit(1);
}

const PEOPLE_BASE =
  process.env.SCHOLARS_LDAP_SEARCH_BASE ??
  "ou=people,dc=weill,dc=cornell,dc=edu";
const FACULTY_SOR_BASE =
  process.env.SCHOLARS_LDAP_FACULTY_SOR_BASE ??
  "ou=faculty,ou=sors,dc=weill,dc=cornell,dc=edu";

async function probe(client: Awaited<ReturnType<typeof openLdap>>, base: string, label: string, filter: string) {
  console.log(`\n========== ${label}  (base: ${base}) ==========`);
  console.log(`filter: ${filter}`);
  let entries;
  try {
    const res = await client.search(base, {
      scope: "sub",
      filter,
      // Request all user-mod and operational attributes.
      attributes: ["*", "+"],
    });
    entries = res.searchEntries;
  } catch (e) {
    console.log(`  search failed: ${(e as Error).message}`);
    return;
  }
  if (entries.length === 0) {
    console.log("  no matches");
    return;
  }
  for (const entry of entries) {
    console.log(`\n--- DN: ${entry.dn}`);
    const keys = Object.keys(entry).filter((k) => k !== "dn").sort();
    for (const k of keys) {
      const v = (entry as Record<string, unknown>)[k];
      const display = Array.isArray(v)
        ? `[${v.length}] ${v.slice(0, 5).map(String).join(" | ")}${v.length > 5 ? " | …" : ""}`
        : typeof v === "object" && v !== null
          ? JSON.stringify(v)
          : String(v);
      console.log(`  ${k}: ${display}`);
    }
  }
}

async function main() {
  const client = await openLdap();
  try {
    await probe(client, PEOPLE_BASE, "PEOPLE BRANCH", `(uid=${cwid})`);
    await probe(
      client,
      FACULTY_SOR_BASE,
      "FACULTY SOR",
      `(weillCornellEduCWID=${cwid})`,
    );
  } finally {
    await client.unbind();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
