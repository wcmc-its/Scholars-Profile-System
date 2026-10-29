import { describe, expect, it } from "vitest";
import { foldScholar, isFlagged, parseNihBiosketchParams, type NihBiosketchRow } from "@/lib/edit/nih-biosketch-report";

const row = (o: Partial<NihBiosketchRow>): NihBiosketchRow => ({
  docVersionId: "d1",
  propNo: "0000001",
  uploadedAt: "2026-05-01T00:00:00.000Z",
  format: "common",
  attributedBy: "email",
  orcid: null,
  myncbiUrl: null,
  personalStatement: null,
  contributions: null,
  honors: null,
  ...o,
});
const s = (orcid: string | null = null) => ({ cwid: "abc1001", preferredName: "Ada Lovelace", primaryDepartment: null, orcid });

describe("foldScholar", () => {
  it("one iD everywhere, matching the file → not flagged", () => {
    const f = foldScholar(s("0000-0002-1825-0097"), [row({ orcid: "0000-0002-1825-0097" }), row({ docVersionId: "d2" })]);
    expect(f.orcids).toEqual(["0000-0002-1825-0097"]);
    expect(isFlagged(f)).toBe(false);
  });

  it("two different iDs → conflict", () => {
    const f = foldScholar(s(), [row({ orcid: "0000-0002-1825-0097" }), row({ docVersionId: "d2", orcid: "0000-0002-1694-233X" })]);
    expect(f.orcidConflict).toBe(true);
    expect(f.orcidDiffers).toBe(false);
  });

  it("iD on file that no biosketch lists → differs; no biosketch iD at all → not flagged", () => {
    expect(foldScholar(s("0000-0002-1694-233X"), [row({ orcid: "0000-0002-1825-0097" })]).orcidDiffers).toBe(true);
    expect(isFlagged(foldScholar(s("0000-0002-1694-233X"), [row({})]))).toBe(false);
  });

  it("dedupes MyNCBI URLs", () => {
    const u = "https://www.ncbi.nlm.nih.gov/myncbi/ada.lovelace.1/bibliography/public/";
    expect(foldScholar(s(), [row({ myncbiUrl: u }), row({ docVersionId: "d2", myncbiUrl: u })]).myncbiUrls).toEqual([u]);
  });
});

describe("parseNihBiosketchParams", () => {
  it("defaults, trims, and rejects an unknown show", () => {
    expect(parseNihBiosketchParams({ q: "  ada ", show: "bogus", type: "full_time_faculty" })).toMatchObject({
      q: "ada",
      show: "all",
      types: ["full_time_faculty"],
    });
    expect(parseNihBiosketchParams({ show: "flagged" }).show).toBe("flagged");
  });
});
