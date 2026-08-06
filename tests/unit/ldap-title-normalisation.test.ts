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

import { stripInternalHrAnnotation } from "@/lib/sources/ldap";

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
