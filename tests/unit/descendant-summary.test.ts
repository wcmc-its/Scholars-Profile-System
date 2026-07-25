import { describe, expect, it } from "vitest";

import {
  DESCENDANT_SEPARATOR,
  descendantSummary,
  descendantViaSummary,
} from "@/lib/search/descendant-summary";

/**
 * Uniform fold rule — this file exists because the People card stopped being
 * `descendantSummary`'s test bed.
 *
 * Its three exact-string guards (#1355 cap-at-2, #1908 comma-safety, #1907 over-budget)
 * lived in `result-evidence-card.test.tsx` and were re-expressed against the new "via …"
 * line, which calls `descendantViaSummary` instead. `descendantSummary` itself was
 * deliberately left byte-identical — but its remaining caller
 * (`publication-result-row.tsx`) has no test that renders the parenthetical, so after
 * that move NOTHING pinned it: the cap, `BUDGET = 56`, the drop-whole-terms loop and the
 * "+N more" tail could all be changed with the whole suite green.
 */
describe("descendantSummary — the '(matched …)' parenthetical, UNCHANGED by the fold rule", () => {
  it("#1908 — joins on a middot, never a comma (MeSH headings carry their own commas)", () => {
    // The property that makes two terms countable as two: a comma join renders
    // "Leukemia, Hairy Cell" + "Leukemia, Myeloid" as four items with no recoverable
    // boundary.
    expect(DESCENDANT_SEPARATOR).toBe(" · ");
    expect(descendantSummary(["Leukemia, Hairy Cell", "Leukemia, Myeloid"])).toBe(
      "Leukemia, Hairy Cell · Leukemia, Myeloid",
    );
  });

  it("#1355 — caps at 2 and rolls the remainder into a '+N more' tail", () => {
    expect(descendantSummary(["Mycobiome", "Virome", "Metagenome"])).toBe(
      "Mycobiome · Virome · +1 more",
    );
    expect(descendantSummary(["Mycobiome", "Virome"])).toBe("Mycobiome · Virome");
    expect(descendantSummary(["Mycobiome"])).toBe("Mycobiome");
  });

  it("#1907 — drops WHOLE terms at BUDGET = 56 so the parenthetical closes instead of clipping", () => {
    // 46 + 3 + 17 = 66 > 56 ⇒ the second term goes, and the count it leaves behind grows.
    expect(
      descendantSummary([
        "Precursor Cell Lymphoblastic Leukemia-Lymphoma",
        "Leukemia, Myeloid",
        "Leukemia, B-Cell",
      ]),
    ).toBe("Precursor Cell Lymphoblastic Leukemia-Lymphoma · +2 more");
    // …and the budget really is 56, not the via-line's 72: this pair is 62 chars, so it
    // fits the wider box and NOT this one.
    expect("Leukemia, Lymphoid · Leukemia, Lymphocytic, Chronic, B-Cell".length).toBe(59);
    expect(descendantSummary(["Leukemia, Lymphoid", "Leukemia, Lymphocytic, Chronic, B-Cell"])).toBe(
      "Leukemia, Lymphoid · +1 more",
    );
  });

  it("one term ALWAYS survives, even alone over budget — the row must name its match", () => {
    // Trimming to nothing would leave the row asserting a match it declines to name.
    expect(descendantSummary(["Precursor Cell Lymphoblastic Leukemia-Lymphoma"])).toBe(
      "Precursor Cell Lymphoblastic Leukemia-Lymphoma",
    );
  });
});

describe("descendantViaSummary — the People card's own 'via …' line", () => {
  it("counts the SET in prose instead of announcing a truncation", () => {
    // "+2 more" is a truncation notice and belongs next to a truncated thing; on its own
    // line the list is not truncated, so it summarises. Singular for exactly one.
    expect(descendantViaSummary(["Mycobiome", "Virome", "Metagenome"])).toBe(
      "Mycobiome · Virome and 1 related term",
    );
    expect(descendantViaSummary(["Mycobiome", "Virome", "a", "b", "c", "d"])).toBe(
      "Mycobiome · Virome and 4 related terms",
    );
    expect(descendantViaSummary(["Mycobiome", "Virome"])).toBe("Mycobiome · Virome");
    expect(descendantViaSummary(["Mycobiome"])).toBe("Mycobiome");
  });

  it("budgets the WHOLE rendered string — the TAIL is what a clip eats first", () => {
    // The defect this pins: budgeting only the joined TERMS and appending the tail after.
    // These two join to 40 characters, comfortably inside the budget on their own — but the
    // " and 1 related term" they oblige takes the rendered line to 59, and the tail is LAST,
    // so the pixel clip takes the one phrase that says the list is partial and leaves a line
    // that looks complete. Budgeting the render drops a whole term instead, and the count it
    // leaves behind grows to say so.
    expect("Leukemia, Hairy Cell · Leukemia, Myeloid".length).toBe(40);
    expect("Leukemia, Hairy Cell · Leukemia, Myeloid and 1 related term".length).toBe(59);
    expect(
      descendantViaSummary(["Leukemia, Hairy Cell", "Leukemia, Myeloid", "Leukemia, B-Cell"]),
    ).toBe("Leukemia, Hairy Cell and 2 related terms");
    // Whenever there was a term to drop, the result really is inside the budget.
    expect("Leukemia, Hairy Cell and 2 related terms".length).toBeLessThanOrEqual(48);
  });

  it("keeps the drop-whole-terms property (#1907) — never half a descriptor", () => {
    expect(
      descendantViaSummary([
        "Precursor Cell Lymphoblastic Leukemia-Lymphoma",
        "Leukemia, Lymphocytic, Chronic, B-Cell",
        "Leukemia, Myeloid",
      ]),
    ).toBe("Precursor Cell Lymphoblastic Leukemia-Lymphoma and 2 related terms");
    // The ONE case a rendered line may still exceed the budget: a lone descriptor that
    // busts it by itself. Naming the match beats fitting the box — and dropping the tail
    // instead would hide exactly the partiality this line exists to state.
    expect("Precursor Cell Lymphoblastic Leukemia-Lymphoma and 2 related terms".length).toBe(66);
  });

  it("the two budgets are INDEPENDENT — the via line is not descendantSummary's box", () => {
    // Same three terms, two different renders: the parenthetical keeps both terms at
    // BUDGET = 56 (its "+N more" tail is 8 characters and unbudgeted, by design — it rides
    // inside a row that truncates for other reasons), while the via line's whole-string
    // budget drops one to make room for its 20-character prose tail. A single shared
    // constant cannot produce both, which is why changing one must not move the other.
    const terms = ["Leukemia, Hairy Cell", "Leukemia, Myeloid", "Leukemia, B-Cell"];
    expect(descendantSummary(terms)).toBe("Leukemia, Hairy Cell · Leukemia, Myeloid · +1 more");
    expect(descendantViaSummary(terms)).toBe("Leukemia, Hairy Cell and 2 related terms");
  });
});
