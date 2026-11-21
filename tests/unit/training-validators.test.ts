import { describe, expect, it } from "vitest";
import { validateTrainingInput } from "@/lib/edit/training";

const ok = { type: "Residency", institution: " UPMC ", specialty: "", yearFrom: "2018", yearTo: 2021 };

describe("validateTrainingInput", () => {
  it("trims, nulls a blank specialty, and coerces string years", () => {
    expect(validateTrainingInput(ok)).toEqual({
      ok: true,
      value: { type: "Residency", institution: "UPMC", specialty: null, yearFrom: 2018, yearTo: 2021 },
    });
  });
  it("allows no years", () => {
    expect(validateTrainingInput({ ...ok, yearFrom: null, yearTo: "" }).ok).toBe(true);
  });
  it.each([
    [{ type: "Other" }, "type"],
    [{ institution: "  " }, "institution"],
    [{ institution: "x".repeat(256) }, "institution"],
    [{ specialty: 5 }, "specialty"],
    [{ yearFrom: "19x8" }, "yearFrom"],
    [{ yearFrom: 1800 }, "yearFrom"],
    [{ yearFrom: 2021, yearTo: 2018 }, "yearTo"],
  ])("rejects %o on %s", (patch, field) => {
    const r = validateTrainingInput({ ...ok, ...patch });
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.field).toBe(field);
  });
});
