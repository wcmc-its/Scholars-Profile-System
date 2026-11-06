/**
 * Matcha report v4: display-only clean-ups (names, degrees, sponsors, award codes, methods).
 * All fixtures are invented.
 */
import { describe, expect, it } from "vitest";
import {
  awardCode,
  awardsLabel,
  dedupeDegrees,
  firstSentences,
  fundingSummary,
  funderTypeLabel,
  mergeMethods,
  normalizeMethodName,
  punctuateInitials,
  reportName,
  sponsorShort,
  titleWithoutRequester,
} from "@/lib/edit/matcha-report-format";

const award = (over: Partial<Parameters<typeof fundingSummary>[0][number]> = {}) => ({
  mechanism: "R01",
  funder: "NIA",
  title: "An invented award",
  endYear: 2030,
  applId: null,
  roleLabel: "PI",
  ...over,
});

describe("names", () => {
  it("dedupes degrees, keeping order and comma-joined degrees intact", () => {
    expect(dedupeDegrees("MB,BS, MD, MD")).toBe("MB,BS, MD");
    expect(dedupeDegrees("MD, PhD, M.D.")).toBe("MD, PhD");
    expect(dedupeDegrees("PhD")).toBe("PhD");
  });

  it("adds a period to a bare middle initial only", () => {
    expect(punctuateInitials("Jane Q Doe")).toBe("Jane Q. Doe");
    expect(punctuateInitials("Jane Q. Doe")).toBe("Jane Q. Doe");
    expect(punctuateInitials("J Doe")).toBe("J Doe");
    expect(punctuateInitials("Ann B C Smith")).toBe("Ann B. C. Smith");
  });

  it("applies both to a full display name", () => {
    expect(reportName("Jane Q Doe, MB,BS, MD, MD")).toBe("Jane Q. Doe, MB,BS, MD");
    expect(reportName("Jane Q Doe")).toBe("Jane Q. Doe");
  });
});

describe("sponsors and award codes", () => {
  it("prefers the NIH institute code, drops 'via …', and abbreviates full NIH names", () => {
    expect(sponsorShort({ funder: "NIH", nihIc: "NHLBI" })).toBe("NHLBI");
    expect(sponsorShort({ funder: "NCI via Invented University" })).toBe("NCI");
    expect(
      sponsorShort({ funder: "National Institute of Diabetes and Digestive and Kidney Diseases" }),
    ).toBe("NIDDK");
    expect(sponsorShort({ funder: "Invented Foundation via Elsewhere" })).toBe(
      "Invented Foundation",
    );
  });

  it("labels a code-less award by funder type", () => {
    expect(
      funderTypeLabel({ funder: "Invented Co", programType: "BioPharma Alliance Agreement" }),
    ).toBe("Industry");
    expect(funderTypeLabel({ funder: "Unknown Trust" })).toBe("Other");
    expect(funderTypeLabel({ funder: "NIA" })).toBe("NIH");
    expect(awardCode({ mechanism: "U54", funder: "NIA" })).toBe("U54");
    expect(awardCode({ mechanism: null, funder: "Unknown Trust", programType: "Grant" })).toBe(
      "Other",
    );
  });

  it("builds the one-line funding summary from the count", () => {
    expect(awardsLabel(1)).toBe("1 active award");
    expect(awardsLabel(6)).toBe("6 active awards");
    expect(
      fundingSummary([
        award(),
        award({ title: "Another" }),
        award({ mechanism: "U54", funder: "NIBIB" }),
        award({
          mechanism: null,
          funder: "Invented Co",
          programType: "BioPharma Alliance Agreement",
        }),
      ]),
    ).toBe("4 active awards: R01 (NIA), U54 (NIBIB), Industry (Invented Co)");
  });
});

describe("methods", () => {
  it("normalizes case, punctuation and whitespace", () => {
    expect(normalizeMethodName("  Gizmo-Tracking  (v2) ")).toBe("gizmo tracking v2");
  });

  it("merges exact duplicates (larger count wins) and sorts by paper count", () => {
    const m = (name: string, papers: number) => ({ name, category: null, papers });
    expect(
      mergeMethods([
        m("Widget assay", 3),
        m("Mouse models", 2),
        m("widget  assay", 9),
        m("Zeta", 2),
      ]),
    ).toEqual([m("widget  assay", 9), m("Mouse models", 2), m("Zeta", 2)]);
  });
});

describe("text", () => {
  it("takes the first n sentences", () => {
    expect(firstSentences("One. Two! Three?", 2)).toBe("One. Two!");
    expect(firstSentences("Only one", 2)).toBe("Only one");
  });

  it("drops the requester from the title", () => {
    expect(titleWithoutRequester("Quillmere Labs: widget biology", "Quillmere Labs")).toBe(
      "widget biology",
    );
    expect(titleWithoutRequester("Widget biology for Quillmere Labs", "Quillmere Labs")).toBe(
      "Widget biology",
    );
    expect(titleWithoutRequester("Widget biology", null)).toBe("Widget biology");
    expect(titleWithoutRequester("Quillmere Labs", "Quillmere Labs")).toBe("Quillmere Labs");
  });
});
