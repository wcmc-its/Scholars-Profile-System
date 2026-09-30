/**
 * Functional roles parity check: who holds access through an EXISTING gate
 * but has no `functional_role_grant` row that would reproduce it. Run it
 * before flipping `FUNCTIONAL_ROLES_AUTHZ`, and before ever relying on the
 * registry alone. Read-only (reader connection); writes nothing.
 *
 *   npx tsx scripts/functional-roles-parity.ts          # summary + gaps
 *   npx tsx scripts/functional-roles-parity.ts --json   # machine-readable
 *
 * Exit code: 0 when every enumerable holder is covered, 1 when there are
 * gaps, 2 on error.
 *
 * Checked (the same rule the gates use, `parityGaps` in
 * `lib/edit/functional-roles.ts`, which the Functional roles tab also shows):
 *   - every `report_access` row ⇒ a Reporting row admitting that report scope;
 *   - `SCHOLARS_COMMS_STEWARD_ALLOWLIST` (while `COMMS_STEWARD_ENABLED` is
 *     "on") ⇒ an External Affairs row with Communications;
 *   - `SCHOLARS_DEVELOPMENT_ALLOWLIST` (while `DEVELOPMENT_ENABLED` is "on")
 *     ⇒ an External Affairs row with Development.
 * The allowlists are read from THIS process's env, the way the app reads
 * them. They are app task-def vars, so on the ETL task family they are unset
 * unless passed in (both are "" in every deployed env today).
 *
 * NOT checked: members of the comms-steward and development ED groups. The
 * app's bind account can only `compare` a member, not list the group, so a
 * group-only holder is invisible here. Because the cutover is additive, such a
 * holder keeps access through the group either way.
 *
 * Output names people by CWID. Do not paste it into the public repo, an issue
 * or a PR.
 */
import { db } from "@/lib/db";
import { gateHolderNeed, parityGaps } from "@/lib/edit/functional-roles";
import { listFunctionalRoles, listGateHolders } from "@/lib/edit/functional-roles.server";

async function main(): Promise<number> {
  const asJson = process.argv.includes("--json");
  const [holders, rows] = await Promise.all([
    listGateHolders(db.read),
    listFunctionalRoles(db.read),
  ]);
  const gaps = parityGaps(holders, rows);
  if (asJson) {
    console.log(
      JSON.stringify(
        {
          holders: holders.length,
          registryRows: rows.length,
          gaps: gaps.map((g) => ({
            cwid: g.cwid,
            role: g.role,
            need: gateHolderNeed(g),
            via: g.via,
          })),
          notChecked: "ED group members (comms-steward, development): not enumerable",
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`Enumerable holders by existing gates: ${holders.length}`);
    console.log(`Registry rows: ${rows.length}`);
    console.log(`Holders with no covering registry row: ${gaps.length}`);
    for (const g of gaps) {
      console.log(`  ${g.cwid}\t${g.role}\t${gateHolderNeed(g)}\tvia ${g.via}`);
    }
    console.log("Not checked: ED group members (comms-steward, development) cannot be listed.");
  }
  return gaps.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  });
