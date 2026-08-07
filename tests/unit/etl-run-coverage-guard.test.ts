/**
 * Guardrail — every ETL step must leave an `etl_run` row behind (#2293).
 *
 * `/edit/etl-status` drives off `TRACKED` x `etl_run`, and its subtitle says
 * "Every automatic data import". A deployed step that writes no row is not
 * merely missing from that page — it is invisible to the freshness heartbeat
 * and to every etl_run-derived metric, so the board reads all-green while an
 * unseen step is dead. That is a false completeness claim, and it is the worst
 * kind: the page is most trusted on exactly the day it is wrong.
 *
 * #2293 was filed for `search-reconcile` alone. A sweep widened it to five, and
 * a second sweep for this test found a sixth (`freshness`) that the enumerated
 * list had missed. Hence a guard rather than a checklist: the set is the thing
 * that drifts, and a step added next year with no row is green in every other
 * test in this repo.
 *
 * The exemptions below are deliberate and each states WHY. Adding a name here
 * is a decision to accept invisibility for that step; do it knowingly, and note
 * that "not deployed yet" stops being a reason the moment it is scheduled.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ETL = path.resolve(__dirname, "../../etl");

/**
 * Comments are stripped before matching, and it is not a nicety: `etl/freshness`
 * has a doc comment about steps that "were wrapped in `withEtlRun`", which reads
 * as a call site to a plain grep. That one false positive is the whole reason
 * this test found a sixth non-writer instead of five.
 */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Either sanctioned way to leave a row: the wrapper, or a direct create. */
const writesEtlRun = (src: string) => /withEtlRun|etlRun\.create/.test(stripComments(src));

const EXEMPT: Record<string, string> = {
  // The heartbeat itself — it READS etl_run to grade every other source. A row
  // of its own would be the monitor reporting on the monitor, and TRACKED would
  // then grade the grader.
  freshness: "reads etl_run to grade the others; must not grade itself",
  // No cdk reference: not deployed on any schedule, in either env. If either is
  // ever scheduled, delete its line here rather than widening the matcher — an
  // unscheduled step going silent harms nobody, a scheduled one is #2293 again.
  "clinical-mesh": "no cdk reference — not deployed",
  "vivo-redirect": "no cdk reference — not deployed",
};

const stepDirs = readdirSync(ETL, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

const sources = (dir: string): string =>
  readdirSync(path.join(ETL, dir), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => readFileSync(path.join(ETL, dir, e.name), "utf-8"))
    .join("\n");

describe("etl_run coverage guard", () => {
  it("has enough steps to be worth policing", () => {
    // A matcher or a walk that breaks silently would let every assertion below
    // pass on an empty set. Fail loudly instead.
    expect(stepDirs.length).toBeGreaterThan(30);
  });

  it("leaves an etl_run row behind for every step that is not deliberately exempt", () => {
    const silent = stepDirs.filter((d) => !writesEtlRun(sources(d)) && EXEMPT[d] === undefined);
    // If this fails on a step you just added: wrap its entrypoint in
    // `withEtlRun` from `@/lib/etl-run`. Prefer that over a hand-rolled create —
    // it records `startedAt` correctly, which the sibling guard test enforces.
    expect(silent).toEqual([]);
  });

  it("keeps the exemption list honest, so a step cannot hide behind a stale entry", () => {
    // An exemption that no longer applies is worse than none: it reads as a
    // considered decision while silently covering a step that now writes rows,
    // or one that was deleted entirely.
    for (const [dir, why] of Object.entries(EXEMPT)) {
      expect(stepDirs, `${dir} is exempted but no longer exists`).toContain(dir);
      expect(
        writesEtlRun(sources(dir)),
        `${dir} is exempted ("${why}") but now writes an etl_run row — drop the exemption`,
      ).toBe(false);
    }
  });
});
