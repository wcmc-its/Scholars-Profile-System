/**
 * #2634 Phase 0 — precision / coverage of the co-authorship mentor rules
 * against ground truth. READ-ONLY; prints counts only, never names.
 *
 * Ground truth: SPS `postdoc_mentor_relationship` rows with status
 * 'employee:active' (mentorCwid = the ED manager). For each such mentee, rank
 * faculty co-authors with the SAME windowed, true-last-author query the
 * builder uses (`queryPairStats`) and score each rule's top pick:
 *
 *   precision = top pick is one of the mentee's ED mentors / mentees with a pick
 *   coverage  = mentees with a pick / ground-truth mentees
 *
 * The "same dept" variant restricts candidates to faculty whose
 * `person.primaryOrganizationalUnit` equals the mentee's.
 *
 * Run: npm run etl:reciter:probe-mentee-suggestions
 */
import { db, disconnect } from "@/lib/db";
import { closeReciterPool, withReciterConnection } from "@/lib/sources/reciterdb";
import {
  byMentorStrength,
  isStrong,
  queryPairStats,
  WINDOW_YEARS,
  type PairStats,
} from "./mentee-suggestions";

type Rule = [label: string, test: (top: PairStats, runnerUp: PairStats | undefined) => boolean];
const RULES: Rule[] = [
  ["nLast>=1", (top) => top.nMentorLastAuthor >= 1],
  ["nLast>=2", (top) => top.nMentorLastAuthor >= 2],
  ["nLast>=2 & >=2x runner-up", isStrong],
];

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  const minYear = new Date().getFullYear() - WINDOW_YEARS;
  const gt = await db.write.postdocMentorRelationship.findMany({
    where: { status: "employee:active" },
    select: { mentorCwid: true, menteeCwid: true },
  });
  const truth = new Map<string, Set<string>>();
  for (const r of gt) {
    const set = truth.get(r.menteeCwid) ?? new Set<string>();
    set.add(r.mentorCwid);
    truth.set(r.menteeCwid, set);
  }
  const mentees = Array.from(truth.keys());
  console.log(
    `ground truth: ${gt.length} active postdoc rows, ${mentees.length} distinct mentees; window articleYear >= ${minYear}`,
  );

  const t0 = Date.now();
  const pairs = await withReciterConnection((conn) =>
    queryPairStats(conn, { minYear, menteeCwids: mentees }),
  );
  console.log(`${pairs.length} faculty co-author pairs for those mentees in ${Date.now() - t0}ms`);

  const dept = new Map<string, string | null>();
  const cwids = Array.from(new Set([...mentees, ...pairs.map((p) => p.mentorCwid)]));
  for (const batch of chunks(cwids, 500)) {
    await withReciterConnection(async (conn) => {
      const rows = (await conn.query(
        `SELECT personIdentifier, primaryOrganizationalUnit FROM person WHERE personIdentifier IN (?)`,
        [batch],
      )) as Array<{ personIdentifier: string; primaryOrganizationalUnit: string | null }>;
      for (const r of rows) dept.set(r.personIdentifier, r.primaryOrganizationalUnit || null);
    });
  }

  const byMentee = new Map<string, PairStats[]>();
  for (const p of pairs) {
    const list = byMentee.get(p.menteeCwid) ?? [];
    list.push(p);
    byMentee.set(p.menteeCwid, list);
  }
  for (const list of byMentee.values()) list.sort(byMentorStrength);
  const withAny = mentees.filter((m) => (byMentee.get(m)?.length ?? 0) > 0).length;
  const truthIsCoauthor = mentees.filter((m) =>
    (byMentee.get(m) ?? []).some((p) => truth.get(m)!.has(p.mentorCwid)),
  ).length;
  console.log(
    `mentees with >=1 faculty co-author pair: ${withAny}; with the ED mentor among them: ${truthIsCoauthor}`,
  );

  console.log(
    "\nrule                          | same dept | picks | correct | precision | coverage",
  );
  console.log("------------------------------+-----------+-------+---------+-----------+---------");
  for (const sameDept of [false, true]) {
    for (const [label, test] of RULES) {
      let picks = 0;
      let correct = 0;
      for (const m of mentees) {
        let cands = byMentee.get(m) ?? [];
        if (sameDept) {
          const d = dept.get(m);
          cands = d ? cands.filter((c) => dept.get(c.mentorCwid) === d) : [];
        }
        const top = cands[0];
        if (!top || !test(top, cands[1])) continue;
        picks++;
        if (truth.get(m)!.has(top.mentorCwid)) correct++;
      }
      const pct = (n: number, d: number) => (d ? ((100 * n) / d).toFixed(1) + "%" : "n/a");
      console.log(
        `${label.padEnd(30)}| ${String(sameDept ? "yes" : "no").padEnd(10)}| ${String(picks).padStart(5)} | ${String(correct).padStart(7)} | ${pct(correct, picks).padStart(9)} | ${pct(picks, mentees.length).padStart(8)}`,
      );
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnect();
    await closeReciterPool();
  });
