/**
 * Cornell Ithaca roster → `scholar` rows (`campus = 'ithaca'`, `status = 'external'`,
 * hidden `ithaca_*` roles), so their ORCID iDs can be curated in SPS. Ithaca ORCID
 * plan, step 1. Nightly, after Ed.
 *
 *   reciterdb identity_cornell_current   (spreadsheet + HR feed)
 *             identity_cornell_hr        (academic rank and track)
 *             identity_cornell_directory (names the roster lacks)
 *        └──▶ plan.ts ──▶ scholar
 *
 * Never writes a WCM row, live or departed (ED owns those); new Ithaca rows have no
 * child rows. Writes only when ITHACA_ROSTER is "on"; otherwise logs what it would do.
 *
 * Usage: `npm run etl:ithaca-roster`
 */
import { db } from "@/lib/db";
import { assertPruneVolume, assertSourceVolume } from "@/lib/etl-guard";
import { withEtlRun } from "@/lib/etl-run";
import { closeReciterPool, withReciterConnection } from "@/lib/sources/reciterdb";
import { planRoster, toPeople, type IthacaPerson, type RosterRow } from "./plan";

const fields = (p: IthacaPerson) => ({
  preferredName: p.preferredName,
  fullName: p.fullName,
  roleCategory: p.roleCategory,
  primaryDepartment: p.primaryDepartment,
  primaryTitle: p.primaryTitle,
  email: p.email,
});

async function main(): Promise<number> {
  const rows = (await withReciterConnection((conn) =>
    conn.query(
      `SELECT c.netid, c.name, c.name_first, c.name_last, c.email,
              c.primary_department, c.primary_job_title, c.affiliations_all,
              c.is_active_employee, c.is_faculty, c.is_rte_faculty, c.is_postdoc,
              c.is_student_grad_all,
              h.primary_title AS hr_title, h.track_group AS hr_track,
              d.display_name, d.given_name, d.surname
         FROM identity_cornell_current c
         LEFT JOIN identity_cornell_hr h ON h.netid = c.netid
         LEFT JOIN identity_cornell_directory d ON d.netid = c.netid
        WHERE c.netid REGEXP '^[A-Za-z]+[0-9]+$'`,
    ),
  )) as RosterRow[];
  // 33,711 NetID-keyed people on 2026-11-14.
  assertSourceVolume("ithaca-roster-source", { incoming: rows.length, floor: 25_000 });

  const { people, nameless } = toPeople(rows);
  // 9,307 in scope on 2026-11-14.
  assertSourceVolume("ithaca-roster-people", { incoming: people.length, floor: 7_000 });

  const existing = await db.write.scholar.findMany({
    select: {
      cwid: true,
      campus: true,
      deletedAt: true,
      slug: true,
      preferredName: true,
      fullName: true,
      roleCategory: true,
      primaryDepartment: true,
      primaryTitle: true,
      email: true,
    },
  });
  const plan = planRoster(people, existing);
  // Unchanged rows are not rewritten (keeps updatedAt meaningful).
  const before = new Map(existing.map((e) => [e.cwid, e]));
  const changed = plan.update.filter(({ person, revive }) => {
    const e = before.get(person.cwid);
    return revive || !e || Object.entries(fields(person)).some(([k, v]) => e[k as keyof typeof e] !== v);
  });
  const live = existing.filter((e) => e.campus === "ithaca" && !e.deletedAt).length;
  // Grads finish in batches; a monthly file can move hundreds. More than this is a broken read.
  assertPruneVolume("ithaca-roster-prune", { pruning: plan.prune.length, of: live, maxPct: 10 });

  const byRole = new Map<string, number>();
  for (const p of people) byRole.set(p.roleCategory, (byRole.get(p.roleCategory) ?? 0) + 1);
  const summary =
    `${people.length} in scope (${[...byRole].map(([r, n]) => `${r} ${n}`).join(", ")}); ` +
    `create ${plan.create.length}, update ${changed.length} of ${plan.update.length} ` +
    `(revive ${plan.update.filter((u) => u.revive).length}), prune ${plan.prune.length}, ` +
    `skipped ${plan.wcmOwned} held by WCM rows, ${nameless} without a name`;

  if (process.env.ITHACA_ROSTER !== "on") {
    console.log(`ithaca-roster: DRY RUN (ITHACA_ROSTER is not "on"): ${summary}`);
    return 0;
  }

  const slugs = new Set(existing.map((e) => e.slug));
  for (let i = 0; i < plan.create.length; i += 500) {
    await db.write.scholar.createMany({
      data: plan.create.slice(i, i + 500).map((p) => {
        // Never routable, never squats a name slug.
        let slug = `ithaca-${p.cwid}`;
        for (let n = 2; slugs.has(slug); n++) slug = `ithaca-${p.cwid}-${n}`;
        slugs.add(slug);
        return { cwid: p.cwid, slug, campus: "ithaca", status: "external", ...fields(p) };
      }),
      skipDuplicates: true,
    });
  }
  for (const { person, revive } of changed) {
    await db.write.scholar.update({
      where: { cwid: person.cwid },
      data: {
        ...fields(person),
        ...(revive ? { campus: "ithaca", status: "external", deletedAt: null } : {}),
      },
    });
  }
  if (plan.prune.length) {
    await db.write.scholar.updateMany({
      where: { cwid: { in: plan.prune }, campus: "ithaca" },
      data: { deletedAt: new Date() },
    });
  }
  console.log(`ithaca-roster: ${summary}`);
  return plan.create.length + changed.length + plan.prune.length;
}

if (!process.env.VITEST) {
  withEtlRun("Ithaca-Roster", main)
    .catch((err) => {
      console.error(err);
      process.exit(1);
    })
    .finally(async () => {
      await closeReciterPool();
      await db.write.$disconnect();
    });
}
