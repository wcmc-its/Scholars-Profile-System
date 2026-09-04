/**
 * #2208 — internal HR appointment-workflow annotations must be stripped from
 * ED-sourced titles at the LDAP projection boundary, so `(Pending Appointment
 * at Rank)` can never reach `Scholar.primaryTitle` / `Appointment.title` and
 * from there the profile `<title>`, meta description, sidebar subtitle and
 * Appointments card.
 *
 * The counter-tests matter more than the positive ones: the enumeration over
 * the indexed corpus (2026-08-05) found that every OTHER parenthetical in an ED
 * title is a legitimate public credential — a rank modifier (`(Voluntary)`,
 * `(Courtesy)`) or a sub-specialty qualifier — so a blanket "strip the trailing
 * parenthetical" rule would delete ~2,100 real credentials to remove ~58
 * annotations.
 */
import { describe, expect, it } from "vitest";

import { projectEntries, stripInternalHrAnnotation, stripUnitQualifier } from "@/lib/sources/ldap";

describe("stripInternalHrAnnotation — removes internal HR workflow state", () => {
  it("strips the trailing (Pending Appointment at Rank) annotation", () => {
    expect(
      stripInternalHrAnnotation("Associate Professor of Medicine (Pending Appointment at Rank)"),
    ).toBe("Associate Professor of Medicine");
  });

  it("leaves no trailing whitespace behind", () => {
    expect(stripInternalHrAnnotation("Professor of Pediatrics (Pending Appointment at Rank)")).toBe(
      "Professor of Pediatrics",
    );
  });

  it("strips a mid-string annotation and collapses the gap", () => {
    expect(
      stripInternalHrAnnotation("Professor of Surgery (Pending Appointment at Rank) (Voluntary)"),
    ).toBe("Professor of Surgery (Voluntary)");
  });

  it("is case- and spacing-tolerant", () => {
    expect(stripInternalHrAnnotation("Professor of Medicine ( pending appointment )")).toBe(
      "Professor of Medicine",
    );
  });

  it("covers other (Pending …) workflow variants HR may emit", () => {
    expect(stripInternalHrAnnotation("Instructor in Medicine (Pending)")).toBe(
      "Instructor in Medicine",
    );
  });
});

describe("stripInternalHrAnnotation — preserves legitimate parentheticals", () => {
  it.each([
    "Clinical Assistant Professor of Pediatrics (Voluntary)",
    "Professor of Clinical Medicine (Courtesy)",
    "Assistant Professor of Surgery (Plastic Surgery)",
    "Clinical Professor of Surgery (Dentistry, Oral and Maxillofacial Surgery)",
    "Associate Professor of Surgery (Transplantation)",
    "Assistant Professor of Surgery (Vascular Surgery)",
    "Professor of Surgery (Pediatric Surgery)",
  ])("leaves %s untouched", (title) => {
    expect(stripInternalHrAnnotation(title)).toBe(title);
  });

  it("does not strip a credential that merely contains the word pending", () => {
    const title = "Professor of Medicine (Appeals Pending Review)";
    expect(stripInternalHrAnnotation(title)).toBe(title);
  });

  it("leaves an un-parenthesised title alone", () => {
    expect(stripInternalHrAnnotation("Professor of Neurology")).toBe("Professor of Neurology");
  });
});

describe("stripInternalHrAnnotation — degenerate input", () => {
  it("passes null through", () => {
    expect(stripInternalHrAnnotation(null)).toBeNull();
  });

  it("keeps the raw value when stripping would empty the title", () => {
    expect(stripInternalHrAnnotation("(Pending Appointment at Rank)")).toBe(
      "(Pending Appointment at Rank)",
    );
  });

  it("is idempotent", () => {
    const once = stripInternalHrAnnotation("Professor of Medicine (Pending Appointment at Rank)");
    expect(stripInternalHrAnnotation(once)).toBe(once);
  });
});

/**
 * #2600 — the sibling defect on the NAME rather than the title. ED appends a
 * unit disambiguation tail to `displayName` ("<Name> - Infectious Diseases"),
 * and `displayName` is both the published name and the slug basis, so the tail
 * reached the h1, the `<title>`, the OG card, the JSON-LD and the URL.
 *
 * The counter-tests are again the load-bearing ones. The rule is anchored on a
 * strict prefix of an ED-constructed name, so it can only ever truncate to a
 * name ED itself authored. Prod measurement 2026-09-04: 45 records are prefix
 * extensions and ALL 45 tails are " - <Unit>" (none parenthetical); 412 records
 * differ the other way (richer constructed form) and must survive; 15 of 16
 * parenthetical names are mid-name nicknames; and two records put the surname
 * AFTER a " - ", which is why the unconditional cut in
 * lib/name-sort.ts:stripUnitDisambiguation is not reused here.
 *
 * Names below are invented — this repo is public.
 */
describe("stripUnitQualifier — removes ED unit disambiguation tails", () => {
  it("strips a ' - <Unit>' tail back to the constructed name", () => {
    expect(stripUnitQualifier("Alice Fenwick - Infectious Diseases", ["Alice Fenwick"])).toBe(
      "Alice Fenwick",
    );
  });

  it("strips the ' - M.D.' tail (the one degree-shaped case in prod)", () => {
    expect(stripUnitQualifier("Bruno Halloway - M.D.", ["Bruno Halloway"])).toBe("Bruno Halloway");
  });

  it("prefers the LONGER anchor, so a genuine middle name is preserved", () => {
    expect(
      stripUnitQualifier("Alice Renner Fenwick - Infectious Diseases", [
        "Alice Renner Fenwick",
        "Alice Fenwick",
      ]),
    ).toBe("Alice Renner Fenwick");
  });

  it("falls through to the shorter anchor when the middle name is absent from displayName", () => {
    // The non-monotonicity guard: a single middle-name anchor would miss this
    // record entirely, and would START missing it the day ED backfills a middle
    // name for one of the 45 — re-attaching the qualifier to a live slug.
    expect(
      stripUnitQualifier("Alice Fenwick - Infectious Diseases", [
        "Alice Renner Fenwick",
        "Alice Fenwick",
      ]),
    ).toBe("Alice Fenwick");
  });

  it("skips an empty anchor and tries the next candidate", () => {
    expect(stripUnitQualifier("Alice Fenwick - Infectious Diseases", ["", "Alice Fenwick"])).toBe(
      "Alice Fenwick",
    );
  });

  it("is idempotent", () => {
    const once = stripUnitQualifier("Alice Fenwick - Infectious Diseases", ["Alice Fenwick"]);
    expect(stripUnitQualifier(once, ["Alice Fenwick"])).toBe(once);
  });
});

describe("stripUnitQualifier — leaves every non-qualifier name alone", () => {
  it("keeps a mid-name parenthetical nickname", () => {
    // Not a prefix extension: the tail is inside the name, not after it.
    expect(stripUnitQualifier("Jonathan (Jack) Marbury", ["Jonathan Marbury"])).toBe(
      "Jonathan (Jack) Marbury",
    );
  });

  it("keeps a name whose surname follows the ' - ' (constructed == displayName)", () => {
    // The two prod records that a blind cut-at-the-first-separator rule renames.
    // They are safe because the tail is empty, which fails the delimiter test.
    expect(stripUnitQualifier("Rosalind Ayer - Duplantier", ["Rosalind Ayer - Duplantier"])).toBe(
      "Rosalind Ayer - Duplantier",
    );
  });

  it("keeps displayName when the constructed form is richer (the 412-record case)", () => {
    expect(stripUnitQualifier("K. Theodore Winslow", ["Karl Theodore Winslow"])).toBe(
      "K. Theodore Winslow",
    );
  });

  it("keeps a longer real name when the tail carries no delimiter", () => {
    // Zero no-delimiter prefix extensions exist in prod, so the delimiter guard
    // is free — and it is what protects this case.
    expect(stripUnitQualifier("Mary Jane Smith", ["Mary Jane"])).toBe("Mary Jane Smith");
  });

  it("keeps a hyphenated surname that merely extends the given name", () => {
    // The hyphen is ATTACHED to the anchor, so the tail has no leading space.
    expect(stripUnitQualifier("Ana Ruiz-Delgado", ["Ana Ruiz"])).toBe("Ana Ruiz-Delgado");
  });
});

describe("stripUnitQualifier — the delimiter vocabulary is pinned to ' - '", () => {
  // These pin the vocabulary rather than describe a wish: widening the rule to
  // en/em dashes, or to a hyphen with no trailing space, previously survived
  // every test in this file. Any future widening must now edit this block, so
  // it is a deliberate, reviewable act rather than a silent one.
  it("leaves an EN-DASH qualifier untouched", () => {
    expect(stripUnitQualifier("Alice Fenwick – Infectious Diseases", ["Alice Fenwick"])).toBe(
      "Alice Fenwick – Infectious Diseases",
    );
  });

  it("leaves an EM-DASH qualifier untouched", () => {
    expect(stripUnitQualifier("Alice Fenwick — Infectious Diseases", ["Alice Fenwick"])).toBe(
      "Alice Fenwick — Infectious Diseases",
    );
  });

  it("leaves a hyphen with no trailing whitespace untouched", () => {
    expect(stripUnitQualifier("Alice Fenwick -Infectious Diseases", ["Alice Fenwick"])).toBe(
      "Alice Fenwick -Infectious Diseases",
    );
  });

  it("leaves a trailing PARENTHETICAL untouched — the '(' branch is omitted on purpose", () => {
    // ED spends parentheses on nicknames (15 of the 16 in prod), and nothing
    // tells "(Bob)" apart from "(Radiology)". Zero of the 45 measured tails are
    // parenthetical, so accepting "(" would buy nothing and rename people.
    expect(stripUnitQualifier("Robert Smith (Bob)", ["Robert Smith"])).toBe("Robert Smith (Bob)");
    expect(stripUnitQualifier("Priya Vantour (Radiology)", ["Priya Vantour"])).toBe(
      "Priya Vantour (Radiology)",
    );
  });

  it("leaves a comma-degree before the tail untouched (documented no-op miss)", () => {
    // stripTrailingDegree's regex is `$`-anchored and declines a non-terminal
    // degree, so the anchor is not a prefix. A miss, never a rename.
    expect(stripUnitQualifier("Alice Fenwick, MD - Infectious Diseases", ["Alice Fenwick"])).toBe(
      "Alice Fenwick, MD - Infectious Diseases",
    );
  });
});

describe("stripUnitQualifier — degenerate input", () => {
  it("passes an empty displayName through so the caller can fall back", () => {
    expect(stripUnitQualifier("", ["Marcus Ebbing"])).toBe("");
  });

  it("never invents a name when every anchor is empty", () => {
    expect(stripUnitQualifier("Marcus Ebbing - Cardiology", ["", ""])).toBe(
      "Marcus Ebbing - Cardiology",
    );
  });

  it("returns displayName when no anchors are supplied at all", () => {
    expect(stripUnitQualifier("Marcus Ebbing - Cardiology", [])).toBe("Marcus Ebbing - Cardiology");
  });

  it("leaves an exact match untouched (no tail to strip)", () => {
    expect(stripUnitQualifier("Marcus Ebbing", ["Marcus Ebbing"])).toBe("Marcus Ebbing");
  });
});

/**
 * #2600 — the WIRING, not the helper. `projectEntries` is the single call site,
 * and its own callers (fetchActiveFaculty / fetchDoctoralStudents) are stubbed
 * wholesale by tests/unit/etl-ed-slug-pin.test.ts, so a helper verified only in
 * isolation is not verified at all: reverting the projection line to
 * `displayName || constructed` left the entire suite green. These cases fail
 * if that line is reverted.
 *
 * They also pin the two derivations #2600 must NOT disturb — `fullName` still
 * carries the rich constructed form, and an empty displayName still falls back
 * to given+surname.
 */
describe("projectEntries — the #2600 strip is actually wired into preferredName", () => {
  const project = (e: Record<string, unknown>) => projectEntries([e], "people")[0];

  it("publishes the stripped name while fullName keeps the constructed form", () => {
    const r = project({
      weillCornellEduCWID: "abc1001",
      givenName: "Alice",
      sn: "Fenwick",
      displayName: "Alice Fenwick - Infectious Diseases",
    });
    expect(r.preferredName).toBe("Alice Fenwick");
    expect(r.fullName).toBe("Alice Fenwick");
  });

  it("strips via the shorter anchor when ED has a middle name displayName omits", () => {
    // The non-monotonicity case, end to end: fullName still carries the middle
    // name for search recall, preferredName is clean.
    const r = project({
      weillCornellEduCWID: "abc1002",
      givenName: "Alice",
      weillCornellEduMiddleName: "Renner",
      sn: "Fenwick",
      displayName: "Alice Fenwick - Infectious Diseases",
    });
    expect(r.preferredName).toBe("Alice Fenwick");
    expect(r.fullName).toBe("Alice Renner Fenwick");
  });

  it("leaves an unqualified curated displayName exactly as ED wrote it", () => {
    const r = project({
      weillCornellEduCWID: "abc1003",
      givenName: "Jonathan",
      sn: "Marbury",
      displayName: "Jonathan (Jack) Marbury",
    });
    expect(r.preferredName).toBe("Jonathan (Jack) Marbury");
    expect(r.fullName).toBe("Jonathan Marbury");
  });

  it("still falls back to given+surname when displayName is empty", () => {
    const r = project({
      weillCornellEduCWID: "abc1004",
      givenName: "Priya",
      sn: "Vantour",
      displayName: "",
    });
    expect(r.preferredName).toBe("Priya Vantour");
    expect(r.fullName).toBe("Priya Vantour");
  });
});
