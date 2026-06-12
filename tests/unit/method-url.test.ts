/**
 * #940 — `resolveFamilyParam` resolves a `/methods/{sc}?family=` deep-link to the
 * CURRENT `familyId` by the STABLE `(supercategory, familyLabel)` label-slug, not
 * the ephemeral `fam_NNNN` id (which re-mints on every A2 rebuild). Without this,
 * a bookmarked / CloudFront-cached link silently drifts to a different family.
 *
 * The fixture mirrors the real staging drift observed on `animal_cell_models`:
 * a link minted under a prior manifest as the "Cancer cell lines" family carried
 * `fam_0012`; after a rebuild `fam_0012` belongs to "Primary cell culture models"
 * and "Cancer cell lines" is now `fam_0007`.
 */
import { describe, expect, it } from "vitest";
import { familySegmentFor, resolveFamilyParam } from "@/lib/method-url";

const FAMILIES = [
  { familyId: "fam_0007", familyLabel: "Cancer cell lines" },
  { familyId: "fam_0012", familyLabel: "Primary cell culture models" },
];

describe("resolveFamilyParam", () => {
  it("returns null for an empty/missing param", () => {
    expect(resolveFamilyParam(null, FAMILIES)).toBeNull();
    expect(resolveFamilyParam(undefined, FAMILIES)).toBeNull();
    expect(resolveFamilyParam("", FAMILIES)).toBeNull();
  });

  it("matches an exact current id (fresh in-page link / still-current id)", () => {
    expect(resolveFamilyParam("fam_0007", FAMILIES)).toBe("fam_0007");
    expect(resolveFamilyParam("fam_0012", FAMILIES)).toBe("fam_0012");
  });

  it("matches an exact full family slug", () => {
    expect(resolveFamilyParam("cancer-cell-lines-fam_0007", FAMILIES)).toBe("fam_0007");
    expect(resolveFamilyParam(familySegmentFor("Cancer cell lines", "fam_0007"), FAMILIES)).toBe(
      "fam_0007",
    );
  });

  it("matches by stable label-slug even when the id suffix re-minted", () => {
    // Slug minted under a prior manifest: label-slug `cancer-cell-lines`, stale
    // suffix `fam_0099`. Must resolve to the CURRENT "Cancer cell lines" id.
    expect(resolveFamilyParam("cancer-cell-lines-fam_0099", FAMILIES)).toBe("fam_0007");
  });

  it("the #940 drift case: label-slug wins over a stale id suffix that now owns a different family", () => {
    // `cancer-cell-lines-fam_0012`: the suffix `fam_0012` is now "Primary cell
    // culture models", but the stable label-slug pins it to "Cancer cell lines".
    expect(resolveFamilyParam("cancer-cell-lines-fam_0012", FAMILIES)).toBe("fam_0007");
  });

  it("matches a bare label-slug carrying no id suffix", () => {
    expect(resolveFamilyParam("cancer-cell-lines", FAMILIES)).toBe("fam_0007");
    expect(resolveFamilyParam("primary-cell-culture-models", FAMILIES)).toBe("fam_0012");
  });

  it("returns null for a stale BARE id no longer in the current set (graceful fallback, not a wrong family)", () => {
    expect(resolveFamilyParam("fam_0099", FAMILIES)).toBeNull();
  });

  it("returns null when neither id nor label-slug matches", () => {
    expect(resolveFamilyParam("organoid-models-fam_0019", FAMILIES)).toBeNull();
    expect(resolveFamilyParam("not-a-real-family", FAMILIES)).toBeNull();
  });

  it("breaks a label-slug collision by the param's id suffix, else takes the first", () => {
    // Two families sharing a label-slug (an A2 within-manifest collision the full
    // slug's `fam_NNNN` suffix exists to disambiguate).
    const collide = [
      { familyId: "fam_0100", familyLabel: "In vitro models" },
      { familyId: "fam_0200", familyLabel: "In vitro models" },
    ];
    expect(resolveFamilyParam("in-vitro-models-fam_0200", collide)).toBe("fam_0200");
    expect(resolveFamilyParam("in-vitro-models-fam_0100", collide)).toBe("fam_0100");
    // No suffix → deterministic first match (families arrive sorted by label).
    expect(resolveFamilyParam("in-vitro-models", collide)).toBe("fam_0100");
    // A suffix that matches neither → still resolves by the shared label-slug.
    expect(resolveFamilyParam("in-vitro-models-fam_0999", collide)).toBe("fam_0100");
  });
});
