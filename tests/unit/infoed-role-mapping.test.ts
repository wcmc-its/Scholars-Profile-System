import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The InfoEd ETL's role CASE lives in a SQL string that runs on MSSQL, so it
 * can't be exercised in-process (and importing the module would run `main()`).
 * These read the shipped source text instead — enough to catch the two ways
 * this mapping has actually broken.
 */
const SRC = readFileSync(
  join(process.cwd(), "etl/infoed/index.ts"),
  "utf8",
);

/** The outer CASE that produces the `Role` column. */
function outerRoleCase(): string {
  const m = SRC.match(/\n  CASE\n([\s\S]*?)\n  END AS Role\n/);
  if (!m) throw new Error("outer Role CASE not found — did the query change?");
  return m[1];
}

describe("InfoEd role mapping", () => {
  it("emits only literals ROLE_MAP knows", () => {
    const emitted = [...outerRoleCase().matchAll(/'([A-Za-z]+Role)'/g)].map(
      (m) => m[1],
    );
    expect(emitted.length).toBeGreaterThan(0);

    const mapped = [
      ...SRC.matchAll(/^ {2}([A-Za-z]+Role): "/gm),
    ].map((m) => m[1]);

    // An unmapped literal hits `ROLE_MAP[r.Role] ?? "Key Personnel"` and is
    // published as Key Personnel with no error — invisible until someone
    // notices their PI role is gone.
    expect(new Set(mapped)).toEqual(new Set(emitted));
  });

  it("classifies a non-contact PD/PI as Co-PI on direct awards, not just subawards", () => {
    const branch = outerRoleCase()
      .split("\n")
      .find((l) => l.includes("'CoPrincipalInvestigatorRole'"));
    expect(branch).toBeDefined();

    // Regression guard: this branch used to carry `Sponsor <> Orig_Sponsor`,
    // which restricted it to subawards. An NIH multiple-PI on a direct award
    // then missed every branch and fell through to ELSE -> Key Personnel.
    expect(branch).not.toMatch(/Sponsor\s*<>\s*z\.Orig_Sponsor/);
    expect(branch).toMatch(/Role_Category LIKE '%PI'/);
  });

  it("keeps the Co-I branch reachable after the Co-PI branch", () => {
    const lines = outerRoleCase().split("\n");
    const coPi = lines.findIndex((l) =>
      l.includes("'CoPrincipalInvestigatorRole'"),
    );
    const coI = lines.findIndex((l) => l.includes("'CoInvestigatorRole'"));
    expect(coPi).toBeGreaterThanOrEqual(0);
    expect(coI).toBeGreaterThan(coPi);

    // The Co-PI branch matches `LIKE '%PI'`, which the Co-I branch's own
    // category ('Co-Investigator') must not satisfy, or widening the Co-PI
    // branch would have swallowed every co-investigator.
    expect("Co-Investigator".endsWith("PI")).toBe(false);
  });
});
