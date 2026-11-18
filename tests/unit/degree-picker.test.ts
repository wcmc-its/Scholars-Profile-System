import { describe, expect, it } from "vitest";
import {
  degreeOptions,
  normalizeDegree,
  resolveDegreeOverride,
  validateDegreePick,
} from "@/lib/degree-picker";

const row = (degree: string, year: number | null = 2000) => ({ degree, year });

describe("degreeOptions", () => {
  it("adds the master's ED drops and puts MD before PhD regardless of year", () => {
    // ED renders this scholar "PhD, MD": directory-sync keeps terminal degrees only, by year.
    const rows = [row("B.S.", 2004), row("M.P.H.", 2009), row("Ph.D.", 2016), row("M.D.", 2018)];
    expect(degreeOptions(rows)).toEqual(["MD", "PhD", "MPH"]);
  });

  it("drops bachelor's, associate degrees and ASMS placeholders", () => {
    const rows = [
      "B.A.",
      "B.Sc.",
      "A.B.",
      "Sc.B.",
      "A.A.",
      "A.A.S.",
      "L.L.B.",
      "Other",
      "Degree Info Pending",
      "Laurea",
    ];
    expect(degreeOptions(rows.map((d) => row(d)))).toEqual([]);
  });

  it("keeps bachelor-named first-professional degrees", () => {
    expect(degreeOptions([row("B.M.")])).toEqual(["BM"]);
    expect(degreeOptions([row("M.B.,B.S.")])).toEqual(["MB,BS"]);
    expect(degreeOptions([row("B.M.,B.Ch.")])).toEqual(["BM,BCh"]);
    expect(degreeOptions([row("B.D.S.")])).toEqual(["BDS"]);
    expect(degreeOptions([row("B.V.Sc.")])).toEqual(["BVSc"]);
  });

  it("splits multi-degree titles on comma + space only", () => {
    expect(degreeOptions([row("M.D., Ph.D.")])).toEqual(["MD", "PhD"]);
    expect(degreeOptions([row("B.S., M.S.")])).toEqual(["MS"]);
    expect(degreeOptions([row("B.A., M.D.")])).toEqual(["MD"]);
    expect(degreeOptions([row("M.B.,B.Ch., B.A.O.")])).toEqual(["MB,BCh", "BAO"]);
  });

  it("ranks medicine, PhD, other doctorates, master's; year breaks ties", () => {
    const rows = [
      row("M.B.A.", 2001),
      row("D.D.S.", 2005),
      row("Ph.D.", 2003),
      row("M.S.", 1999),
      row("D.O.", 2010),
    ];
    expect(degreeOptions(rows)).toEqual(["DO", "PhD", "DDS", "MS", "MBA"]);
  });

  it("dedupes repeated degrees", () => {
    expect(degreeOptions([row("M.S.", 2001), row("M.S.", 2005), row("M.D., M.S.", 2010)])).toEqual([
      "MD",
      "MS",
    ]);
  });
});

describe("validateDegreePick", () => {
  const options = ["MD", "PhD", "MPH"];

  it("returns the pick in display order, not client order", () => {
    expect(validateDegreePick(["MPH", "MD"], options)).toEqual(["MD", "MPH"]);
  });

  it("rejects empty, non-array, and anything not on offer", () => {
    expect(validateDegreePick([], options)).toBeNull();
    expect(validateDegreePick("MD", options)).toBeNull();
    expect(validateDegreePick(["MD", "FACS"], options)).toBeNull();
    expect(validateDegreePick(["MD", 1], options)).toBeNull();
  });
});

describe("resolveDegreeOverride", () => {
  it("renders a valid stored pick", () => {
    expect(resolveDegreeOverride('["MPH","PhD","MD"]', ["MD", "PhD", "MPH"])).toBe("MD, PhD, MPH");
  });

  it("returns null when ASMS no longer holds a picked degree, or the value is junk", () => {
    expect(resolveDegreeOverride('["MD","MPH"]', ["MD", "PhD"])).toBeNull();
    expect(resolveDegreeOverride("not json", ["MD"])).toBeNull();
  });
});

describe("normalizeDegree", () => {
  it("strips periods like directory-sync does", () => {
    expect(normalizeDegree("M.P.H.")).toBe("MPH");
    expect(normalizeDegree("Dr. rer. nat.")).toBe("Dr rer nat");
  });
});

describe("review fixes", () => {
  it("ranks bare MB and Dr. Med. as medicine", () => {
    expect(degreeOptions([row("Ph.D.", 1990), row("M.B.", 2000)])).toEqual(["MB", "PhD"]);
    expect(degreeOptions([row("Ph.D.", 1990), row("Dr. Med.", 2000)])).toEqual(["Dr Med", "PhD"]);
  });

  it("keeps a professional compound after a bachelor's in the same title", () => {
    expect(degreeOptions([row("B.Sc., M.B.,B.S.")])).toEqual(["MB,BS"]);
  });

  it("rejects a pick longer than the postnominal column", () => {
    const opts = [
      "MD",
      "PhD",
      "MPH",
      "MS",
      "MBA",
      "MSc",
      "MA",
      "MPhil",
      "MEd",
      "MHS",
      "MSW",
      "MSN",
      "MPA",
      "MPP",
    ];
    expect(opts.join(", ").length).toBeGreaterThan(64);
    expect(validateDegreePick(opts, opts)).toBeNull();
  });
});
