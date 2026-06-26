import { describe, it, expect } from "vitest";
import { buildPopsPreviewGroups } from "@/components/edit/cv-tool";
import type { PopsEnrichment } from "@/lib/edit/cv-export";

const base: PopsEnrichment = {
  npi: null,
  boardCertifications: [],
  training: [],
  degrees: [],
  appointments: [],
  honors: [],
  specialties: [],
  practices: [],
  expertise: [],
  castleConnolly: false,
};

describe("buildPopsPreviewGroups (§6b POPS transparency preview)", () => {
  it("groups populated POPS fields, each tagged with its CV section", () => {
    const groups = buildPopsPreviewGroups({
      ...base,
      npi: "1720138498",
      boardCertifications: [
        { board: "American Board of Ophthalmology", specialty: "Ophthalmology" },
      ],
      training: [{ type: "Residency", institution: "Scheie Eye Institute" }],
      appointments: [{ title: "Attending", institution: "NYP", start: "2020-01-01", end: null }],
    });
    const byLabel = Object.fromEntries(groups.map((g) => [g.label, g]));
    expect(byLabel["Board certifications"]!.items).toEqual([
      "American Board of Ophthalmology (Ophthalmology)",
    ]);
    expect(byLabel["Board certifications"]!.section).toBe("Board Certification");
    expect(byLabel["Residency & fellowship training"]!.items).toEqual([
      "Residency — Scheie Eye Institute",
    ]);
    expect(byLabel["Hospital appointments"]!.items).toEqual(["Attending, NYP (2020–Present)"]);
    expect(byLabel["NPI"]!.items).toEqual(["1720138498"]);
  });

  it("drops empty groups (non-clinical scholar ⇒ no preview rendered)", () => {
    expect(buildPopsPreviewGroups(base)).toEqual([]);
  });

  it("never fabricates a date when POPS gives none", () => {
    const groups = buildPopsPreviewGroups({
      ...base,
      appointments: [{ title: "Attending", institution: "NYP", start: null, end: null }],
    });
    expect(groups[0]!.items).toEqual(["Attending, NYP"]);
  });

  it("board cert without a specialty shows just the board name", () => {
    const groups = buildPopsPreviewGroups({
      ...base,
      boardCertifications: [{ board: "ABIM", specialty: null }],
    });
    expect(groups[0]!.items).toEqual(["ABIM"]);
  });

  it("groups clinical practices, expertise, and the Castle Connolly honor", () => {
    const groups = buildPopsPreviewGroups({
      ...base,
      practices: [{ name: "Heart Failure Program", type: "Service" }],
      expertise: ["Heart failure", "Cardiac transplantation"],
      castleConnolly: true,
    });
    const byLabel = Object.fromEntries(groups.map((g) => [g.label, g]));
    expect(byLabel["Clinical practices"]!.items).toEqual(["Heart Failure Program (Service)"]);
    expect(byLabel["Clinical practices"]!.section).toBe("Clinical Activities");
    expect(byLabel["Areas of expertise"]!.items).toEqual(["Heart failure, Cardiac transplantation"]);
    expect(byLabel["Honors & awards"]!.items).toEqual(["Castle Connolly Top Doctor"]);
  });
});
