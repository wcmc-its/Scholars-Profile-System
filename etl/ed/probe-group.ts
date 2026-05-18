/**
 * One-off LDAP probe (B02 #101): dump one group entry under ou=groups to learn
 * its objectClass, member attribute, and member value format — so
 * lib/auth/superuser.ts can be written against the real Enterprise Directory
 * schema rather than an AD-shaped guess.
 *
 * Run: npx tsx etl/ed/probe-group.ts '<group cn>'
 */
import "dotenv/config";
import { openLdap } from "@/lib/sources/ldap";

const GROUPS_BASE =
  process.env.SCHOLARS_LDAP_GROUPS_BASE ?? "ou=groups,dc=weill,dc=cornell,dc=edu";
const cn = process.argv[2];
if (!cn) {
  console.error("Usage: tsx etl/ed/probe-group.ts '<group cn>'");
  process.exit(1);
}

async function main(): Promise<void> {
  const client = await openLdap();
  try {
    const { searchEntries } = await client.search(GROUPS_BASE, {
      scope: "sub",
      filter: `(cn=${cn})`,
      attributes: ["*", "+"],
    });
    console.log(
      `base=${GROUPS_BASE}  filter=(cn=${cn})  ->  ${searchEntries.length} match(es)`,
    );
    for (const e of searchEntries) {
      const entry = e as unknown as Record<string, unknown>;
      console.log(`\nDN: ${String(entry.dn)}`);
      for (const k of Object.keys(entry)
        .filter((x) => x !== "dn")
        .sort()) {
        const v = entry[k];
        const s = Array.isArray(v)
          ? `[${v.length}] ${v.slice(0, 12).map(String).join("  |  ")}${v.length > 12 ? "  | ..." : ""}`
          : String(v);
        console.log(`  ${k}: ${s}`);
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
