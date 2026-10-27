import { describe, expect, it } from "vitest";
import { orcidChecksumOk, parseBiosketches, type Person } from "@/etl/infoed-biosketch/parse";

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

const profile = (first: string, last: string, email: string) =>
  `PROFILE - Senior/Key Person Prefix: Dr. First Name*: ${first} Middle Name Last Name*: ${last} Suffix: ` +
  `Position/Title*: Professor Organization Name*: Joan and Sanford I Weill Medical College E-Mail*: ${email} `;

const personnel: Person[] = [
  { cwid: "abc1001", first: "Ada", last: "Lovelace" },
  { cwid: "xyz2002", first: "Charles", last: "Babbage" },
];

describe("orcidChecksumOk", () => {
  it("accepts valid iDs and rejects a one-digit change", () => {
    expect(orcidChecksumOk("0000-0002-1825-0097")).toBe(true);
    expect(orcidChecksumOk("0000-0002-1694-233X")).toBe(true);
    expect(orcidChecksumOk("0000-0002-1825-0098")).toBe(false);
  });
});

describe("parseBiosketches", () => {
  it("common form: ORCID + supplement sections, attributed by the profile email", () => {
    const text =
      profile("Ada", "Lovelace", "abc1001@med.cornell.edu") +
      "NIH BIOGRAPHICAL SKETCH COMMON FORM Name: Lovelace, Ada Persistent Identifier (PID) of the Senior/Key Person: " +
      "https://orcid.org/0000-0002-1825-0097 Position Title: Professor PROFESSIONAL PREPARATION ... " +
      `NIH BIOGRAPHICAL SKETCH SUPPLEMENT Personal Statement I study engines. ${words(60)} ` +
      `Honors 2020 Some Prize ${words(50)} Contributions to Science 1. Analytical engines. ${words(60)} Research Support ` +
      // Another person's document later in the package — its link is not Ada's.
      "Complete list: https://www.ncbi.nlm.nih.gov/myncbi/charles.babbage.1/bibliography/public/";
    const [b, ...rest] = parseBiosketches(text, personnel);
    expect(rest).toHaveLength(0);
    expect(b).toMatchObject({ cwid: "abc1001", format: "common", attributedBy: "email", orcid: "0000-0002-1825-0097", myncbiUrl: null });
    expect(b.personalStatement).toMatch(/^I study engines/);
    expect(b.personalStatement).not.toMatch(/Honors/);
    expect(b.contributions).toMatch(/^1\. Analytical engines/);
    expect(b.honors).toMatch(/^2020 Some Prize/);
  });

  it("legacy form: no ORCID, MyNCBI link, name fallback; external collaborator dropped", () => {
    const sketch = (last: string, first: string) =>
      `BIOGRAPHICAL SKETCH NAME: ${last}, ${first} eRA COMMONS USER NAME (credential): ABC POSITION TITLE: Professor ` +
      `A. Personal Statement I build machines. ${words(60)} B. Positions, Scientific Appointments and Honors 2001 Fellow ${words(50)} ` +
      `C. Contributions to Science 1. Difference engine. ${words(60)} Complete List of Published Work in MyBibliography: ` +
      `https://www.ncbi.nlm.nih.gov/myncbi/charles.babbage.1/bibliography/public/ D. Additional`;
    const out = parseBiosketches(sketch("Babbage", "Charles") + sketch("Stranger", "Someone"), personnel);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      cwid: "xyz2002",
      format: "legacy",
      attributedBy: "name",
      orcid: null,
      myncbiUrl: "https://www.ncbi.nlm.nih.gov/myncbi/charles.babbage.1/bibliography/public/",
    });
    expect(out[0].personalStatement).toMatch(/^I build machines/);
    expect(out[0].contributions).toMatch(/^1\. Difference engine/);
  });

  it("drops an iD that fails the checksum and an ambiguous name match", () => {
    const text =
      "NIH BIOGRAPHICAL SKETCH COMMON FORM Name: Lovelace, Ada Persistent Identifier (PID): https://orcid.org/0000-0002-1825-0098 Position";
    const twins: Person[] = [...personnel, { cwid: "abc1009", first: "Augusta", last: "Lovelace" }];
    expect(parseBiosketches(text, personnel)[0].orcid).toBeNull();
    expect(parseBiosketches(text, twins)).toHaveLength(0);
  });
});
