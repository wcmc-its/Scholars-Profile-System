/**
 * `docs/title-hierarchy.md` restates the display-title ladder for readers who
 * do not read code. This pins its rank table to `TITLE_RANK` /
 * `TITLE_RANK_LABEL` (lib/scholar-title.ts) so the doc fails CI the moment
 * it drifts: one row per rank, same number, same label, in rank order.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TITLE_RANK, TITLE_RANK_LABEL } from "@/lib/scholar-title";

const DOC = readFileSync(join(__dirname, "../../docs/title-hierarchy.md"), "utf8");

/** Body rows of the table under "## The rank table", as [rank, label] pairs. */
function docRankRows(): Array<[string, string]> {
  const section = DOC.split(/^## /m).find((s) => s.startsWith("The rank table"));
  if (!section) throw new Error('docs/title-hierarchy.md has no "## The rank table" section');
  const rows = section
    .split("\n")
    .filter((l) => l.trim().startsWith("|"))
    .map((l) =>
      l
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) => c.trim()),
    );
  // Drop the header and the |---| separator.
  return rows.slice(2).map((cells) => [cells[0], cells[1]]);
}

describe("docs/title-hierarchy.md rank table", () => {
  it("has exactly one row per TITLE_RANK entry, same rank and label, in rank order", () => {
    const expected = (Object.keys(TITLE_RANK) as Array<keyof typeof TITLE_RANK>)
      .sort((a, b) => TITLE_RANK[a] - TITLE_RANK[b])
      .map((k) => [String(TITLE_RANK[k]), TITLE_RANK_LABEL[k]]);
    expect(docRankRows()).toEqual(expected);
  });

  it("has no horizontal rules (headings only)", () => {
    expect(DOC).not.toMatch(/^(?:-{3,}|\*{3,})\s*$/m);
  });
});
