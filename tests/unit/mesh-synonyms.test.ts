import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import {
  buildSynonyms,
  type DescriptorSynonymInput,
} from "@/etl/mesh-descriptors/synonyms";
import { parseMeshXmlStream } from "@/etl/mesh-descriptors/parser";

describe("buildSynonyms — collision filter (spec §1.3 step 4)", () => {
  it("drops an entry term shared across two descriptors from BOTH emissions", () => {
    const descriptors: DescriptorSynonymInput[] = [
      {
        descriptorUi: "D008580",
        name: "Multiple Sclerosis",
        entryTerms: ["MS", "Disseminated Sclerosis"],
      },
      {
        descriptorUi: "D013058",
        name: "Mass Spectrometry",
        entryTerms: ["MS", "Spectrometry, Mass"],
      },
    ];
    const result = buildSynonyms(descriptors);
    expect(result.lines).toEqual([
      "Multiple Sclerosis, Disseminated Sclerosis",
      "Mass Spectrometry, Spectrometry, Mass",
    ]);
    expect(result.droppedSurfaceForms).toContain("ms");
    expect(result.descriptorsWithoutSynonyms).toBe(0);
  });

  it("collides case-insensitively and against whitespace differences", () => {
    const descriptors: DescriptorSynonymInput[] = [
      { descriptorUi: "D1", name: "Alpha", entryTerms: [" pcr ", "alphabet"] },
      { descriptorUi: "D2", name: "Beta", entryTerms: ["PCR"] },
    ];
    const result = buildSynonyms(descriptors);
    expect(result.lines).toEqual(["Alpha, alphabet"]);
    expect(result.descriptorsWithoutSynonyms).toBe(1); // D2 collapses to name-only
    expect(result.droppedSurfaceForms).toContain("pcr");
  });

  it("keeps descriptor name even when name collides with another's entry term", () => {
    // Descriptor X's preferred name appears as Descriptor Y's entry term.
    // Y's entry term gets dropped; X's name stays on X's line as the canonical.
    const descriptors: DescriptorSynonymInput[] = [
      {
        descriptorUi: "D-X",
        name: "Electronic Health Records",
        entryTerms: ["EHR", "Health Records, Electronic"],
      },
      {
        descriptorUi: "D-Y",
        name: "Medical Records",
        entryTerms: ["Electronic Health Records", "Patient Records"],
      },
    ];
    const result = buildSynonyms(descriptors);
    expect(result.lines).toEqual([
      "Electronic Health Records, EHR, Health Records, Electronic",
      "Medical Records, Patient Records",
    ]);
    expect(result.droppedSurfaceForms).toContain("electronic health records");
  });

  it("omits descriptors with no surviving entry terms entirely", () => {
    const descriptors: DescriptorSynonymInput[] = [
      { descriptorUi: "D1", name: "Solo Descriptor", entryTerms: [] },
      { descriptorUi: "D2", name: "Collide", entryTerms: ["shared"] },
      { descriptorUi: "D3", name: "Also Collide", entryTerms: ["shared"] },
    ];
    const result = buildSynonyms(descriptors);
    expect(result.lines).toEqual([]);
    expect(result.descriptorsWithoutSynonyms).toBe(3);
    expect(result.droppedSurfaceForms).toEqual(["shared"]);
  });

  it("dedupes within a descriptor (entry term equal to its own name is silently skipped)", () => {
    const descriptors: DescriptorSynonymInput[] = [
      {
        descriptorUi: "D1",
        name: "Calcimycin",
        entryTerms: ["Calcimycin", "A 23187", "calcimycin"],
      },
    ];
    const result = buildSynonyms(descriptors);
    expect(result.lines).toEqual(["Calcimycin, A 23187"]);
    expect(result.descriptorsWithoutSynonyms).toBe(0);
  });
});

describe("parseMeshXmlStream — DescriptorRecord extraction", () => {
  // Minimal MeSH XML covering: tree numbers, preferred + non-preferred
  // concept terms, scope note (preferred only), date revised, and the
  // descriptor-name vs entry-term split.
  const sampleXml = `<?xml version="1.0"?>
<DescriptorRecordSet>
  <DescriptorRecord>
    <DescriptorUI>D000001</DescriptorUI>
    <DescriptorName><String>Calcimycin</String></DescriptorName>
    <DateRevised><Year>2024</Year><Month>3</Month><Day>15</Day></DateRevised>
    <TreeNumberList>
      <TreeNumber>D03.633.100.221.173</TreeNumber>
    </TreeNumberList>
    <ConceptList>
      <Concept PreferredConceptYN="Y">
        <ScopeNote>An ionophore that...</ScopeNote>
        <TermList>
          <Term><String>Calcimycin</String></Term>
          <Term><String>A 23187</String></Term>
        </TermList>
      </Concept>
      <Concept PreferredConceptYN="N">
        <ScopeNote>NOT the descriptor-level note</ScopeNote>
        <TermList>
          <Term><String>Antibiotic A23187</String></Term>
        </TermList>
      </Concept>
    </ConceptList>
  </DescriptorRecord>
  <DescriptorRecord>
    <DescriptorUI>D000002</DescriptorUI>
    <DescriptorName><String>Nameless</String></DescriptorName>
    <ConceptList>
      <Concept PreferredConceptYN="Y">
        <TermList>
          <Term><String>Nameless</String></Term>
        </TermList>
      </Concept>
    </ConceptList>
  </DescriptorRecord>
</DescriptorRecordSet>`;

  it("parses two records with correct field separation", async () => {
    const stream = Readable.from([sampleXml]);
    const out = [];
    for await (const d of parseMeshXmlStream(stream)) out.push(d);

    expect(out).toHaveLength(2);

    expect(out[0]).toEqual({
      descriptorUi: "D000001",
      name: "Calcimycin",
      entryTerms: ["A 23187", "Antibiotic A23187"],
      treeNumbers: ["D03.633.100.221.173"],
      scopeNote: "An ionophore that...",
      dateRevised: "2024-03-15",
    });

    // Empty entryTerms + null scopeNote + null dateRevised, no tree numbers.
    expect(out[1]).toEqual({
      descriptorUi: "D000002",
      name: "Nameless",
      entryTerms: [],
      treeNumbers: [],
      scopeNote: null,
      dateRevised: null,
    });
  });

  it("ignores descriptor-name string match when reading entry terms (no duplicate)", async () => {
    // Regression guard for the dedupe path in parser.ts buildDescriptor():
    // the preferred concept's preferred term equals descriptorName, but must
    // not appear in entryTerms.
    const stream = Readable.from([sampleXml]);
    const out = [];
    for await (const d of parseMeshXmlStream(stream)) out.push(d);
    expect(out[0].entryTerms).not.toContain("Calcimycin");
  });
});
