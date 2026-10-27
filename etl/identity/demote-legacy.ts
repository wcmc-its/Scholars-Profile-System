/**
 * One-off: demote the unconfirmed iDs WCM Identity's old import wrote into
 * `scholar.orcid` (Roadmap/orcid-scholars-authority-plan.md, decision 2).
 *
 * Every Scholars writer stamps `orcid_confirmed_at` (the /edit route, a librarian,
 * the email auto-confirm), so a non-deleted scholar with `orcid` set and
 * `orcid_confirmed_at` NULL holds a value `etl/identity` copied in before
 * Scholars became the authority. For each one:
 *   - Identity holds the same iD → `scholar.orcid` is set to NULL and the iD is
 *     written as an `identity` candidate in the same transaction, so it is in the
 *     queue at once. Identity keeps it (decision 3), so ReCiter is unaffected.
 *   - Identity holds a different iD, or none → left alone and listed: demoting
 *     would drop an iD nobody else holds. A librarian decides these by hand.
 *
 * Side effect: the public profile and /edit stop showing a demoted iD until it is
 * confirmed. Run the dry run (the default) on prod first and look at the counts.
 *
 * Usage: `npx tsx etl/identity/demote-legacy.ts`          (dry run)
 *        `npx tsx etl/identity/demote-legacy.ts --apply`
 * Needs the same env as `etl:identity` (Identity read, the SPS writer).
 */
import { db } from "../../lib/db";
import {
  cwidFromIdentityItem,
  IDENTITY_SOURCE,
  orcidFromIdentityItem,
  scanIdentityOrcids,
  type IdentityRow,
} from "./index";

export type LegacyRow = { cwid: string; orcid: string };

/** Pure: split the unconfirmed rows by what Identity holds for the same cwid. */
export function planDemotion(
  legacy: readonly LegacyRow[],
  identity: readonly IdentityRow[],
): { demote: LegacyRow[]; keep: Array<LegacyRow & { identityOrcid: string | null }> } {
  const held = new Map<string, string>();
  for (const r of identity) {
    const cwid = cwidFromIdentityItem(r);
    const orcid = orcidFromIdentityItem(r);
    if (cwid && orcid) held.set(cwid, orcid);
  }
  const demote: LegacyRow[] = [];
  const keep: Array<LegacyRow & { identityOrcid: string | null }> = [];
  for (const r of legacy) {
    const id = held.get(r.cwid.toLowerCase()) ?? null;
    if (id === r.orcid) demote.push(r);
    else keep.push({ ...r, identityOrcid: id });
  }
  return { demote, keep };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const legacy = (await db.write.scholar.findMany({
    where: { deletedAt: null, orcid: { not: null }, orcidConfirmedAt: null },
    select: { cwid: true, orcid: true },
    orderBy: { cwid: "asc" },
  })) as LegacyRow[];
  const { demote, keep } = planDemotion(legacy, await scanIdentityOrcids());
  console.log(
    `${legacy.length} unconfirmed scholar.orcid value(s): ${demote.length} to demote (Identity holds the same iD), ${keep.length} left alone (Identity differs or has none).`,
  );
  for (const k of keep)
    console.log(`  keep ${k.cwid}: Identity ${k.identityOrcid ? "differs" : "has none"}`);
  if (!apply) {
    console.log("Dry run: nothing written. Re-run with --apply.");
    return;
  }
  const now = new Date();
  let demoted = 0;
  for (const r of demote) {
    await db.write.$transaction(async (tx) => {
      // Optimistic: only if the row is still the same unconfirmed value.
      const { count } = await tx.scholar.updateMany({
        where: { cwid: r.cwid, orcid: r.orcid, orcidConfirmedAt: null },
        data: { orcid: null, orcidConfirmMethod: null, orcidConfirmedBy: null },
      });
      if (count !== 1) return;
      await tx.orcidCandidate.upsert({
        where: { cwid_orcid_source: { cwid: r.cwid, orcid: r.orcid, source: IDENTITY_SOURCE } },
        create: { cwid: r.cwid, orcid: r.orcid, source: IDENTITY_SOURCE, syncedAt: now },
        update: { syncedAt: now },
      });
      demoted += 1;
    });
  }
  console.log(`Demoted ${demoted} of ${demote.length}.`);
}

const isDirectInvocation =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => db.write.$disconnect());
}
