/**
 * One-off verification (B02 #101): for each CWID, run the candidate
 * isSuperuser() query against the live ITS:Library:Scholars/superuser-role
 * group's static `member`, and cross-check the group's dynamic memberURL rule
 * (weillCornellEduPersonTypeCode=academic-faculty) plus the person's actual
 * person-type codes.
 *
 * Run: npx tsx etl/ed/probe-superuser-check.ts paa2013 drw2004
 */
import "dotenv/config";
import { openLdap } from "@/lib/sources/ldap";

const GROUPS_BASE = "ou=Groups,dc=weill,dc=cornell,dc=edu";
const GROUP_CN = "ITS:Library:Scholars/superuser-role";
const cwids = process.argv.slice(2);
if (cwids.length === 0) {
  console.error("Usage: tsx etl/ed/probe-superuser-check.ts <cwid> [<cwid> ...]");
  process.exit(1);
}

async function main(): Promise<void> {
  const client = await openLdap();
  try {
    for (const cwid of cwids) {
      const userDn = `uid=${cwid},ou=people,dc=weill,dc=cornell,dc=edu`;

      // B02 candidate query: is the user in the group's static `member`?
      const inMember = await client.search(GROUPS_BASE, {
        scope: "sub",
        filter: `(&(cn=${GROUP_CN})(member=${userDn}))`,
        attributes: ["cn"],
      });

      let typeCodes: unknown = "(no person entry)";
      let matchesUrlRule = false;
      try {
        const person = await client.search(userDn, {
          scope: "base",
          filter: "(objectClass=*)",
          attributes: [
            "weillCornellEduPersonTypeCode",
            "weillCornellEduPrimaryPersonTypeCode",
          ],
        });
        if (person.searchEntries.length > 0) {
          const e = person.searchEntries[0] as unknown as Record<string, unknown>;
          typeCodes = {
            personTypeCode: e.weillCornellEduPersonTypeCode,
            primaryPersonTypeCode: e.weillCornellEduPrimaryPersonTypeCode,
          };
        }
        const ruleMatch = await client.search(userDn, {
          scope: "base",
          filter: "(weillCornellEduPersonTypeCode=academic-faculty)",
          attributes: ["uid"],
        });
        matchesUrlRule = ruleMatch.searchEntries.length > 0;
      } catch (e) {
        typeCodes = `(person lookup failed: ${e instanceof Error ? e.message : String(e)})`;
      }

      console.log(`\n${cwid}`);
      console.log(`  isSuperuser via static member   : ${inMember.searchEntries.length > 0}`);
      console.log(`  matches memberURL rule (faculty): ${matchesUrlRule}`);
      console.log(`  personTypeCode                  : ${JSON.stringify(typeCodes)}`);
    }
  } finally {
    await client.unbind();
  }
}

main().catch((e) => {
  console.error("check failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
