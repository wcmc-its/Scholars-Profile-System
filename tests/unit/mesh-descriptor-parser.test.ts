/**
 * Issue #273 — the MeSH descriptor stream parser must capture the canonical
 * descriptor name from `DescriptorRecord > DescriptorName > String` only,
 * never from a nested `DescriptorName` (e.g. under
 * `PharmacologicalActionList > PharmacologicalAction > DescriptorReferredTo`
 * or `SeeRelatedList > SeeRelatedDescriptor > DescriptorReferredTo`).
 *
 * Pre-fix bug: `inDescriptorName` was set on every `<DescriptorName>` open
 * regardless of depth, so the last-seen nested DescriptorName's `<String>`
 * overwrote the canonical name. Effect: the catalog stored e.g. D009369
 * with `name = "Neoplasm Metastasis"` (a referenced descriptor) instead of
 * `"Neoplasms"`, breaking every downstream MeSH-name lookup.
 */
import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import { parseMeshXmlStream, type ParsedDescriptor } from "@/etl/mesh-descriptors/parser";

async function parseAll(xml: string): Promise<ParsedDescriptor[]> {
  const out: ParsedDescriptor[] = [];
  const stream = Readable.from([xml]);
  for await (const d of parseMeshXmlStream(stream)) out.push(d);
  return out;
}

const XML_HEAD = `<?xml version="1.0"?><DescriptorRecordSet>`;
const XML_TAIL = `</DescriptorRecordSet>`;

describe("parseMeshXmlStream — canonical DescriptorName extraction (#273)", () => {
  it("captures the canonical name when nested DescriptorReferredTo > DescriptorName follows it", async () => {
    // Mirrors the real shape of records like D009369 (Neoplasms), whose
    // PharmacologicalActionList contains a DescriptorReferredTo with a
    // nested DescriptorName pointing at another descriptor.
    const xml =
      XML_HEAD +
      `<DescriptorRecord>
        <DescriptorUI>D009369</DescriptorUI>
        <DescriptorName><String>Neoplasms</String></DescriptorName>
        <ConceptList>
          <Concept PreferredConceptYN="Y">
            <TermList>
              <Term><String>Neoplasms</String></Term>
              <Term><String>Cancer</String></Term>
            </TermList>
          </Concept>
        </ConceptList>
        <PharmacologicalActionList>
          <PharmacologicalAction>
            <DescriptorReferredTo>
              <DescriptorUI>D009362</DescriptorUI>
              <DescriptorName><String>Neoplasm Metastasis</String></DescriptorName>
            </DescriptorReferredTo>
          </PharmacologicalAction>
        </PharmacologicalActionList>
      </DescriptorRecord>` +
      XML_TAIL;

    const results = await parseAll(xml);
    expect(results).toHaveLength(1);
    expect(results[0].descriptorUi).toBe("D009369");
    // Pre-fix this would have been "Neoplasm Metastasis".
    expect(results[0].name).toBe("Neoplasms");
    // The nested descriptor's name must NOT leak into entryTerms either:
    // entryTerms only collects Term/String, not DescriptorReferredTo strings.
    expect(results[0].entryTerms).toContain("Cancer");
    expect(results[0].entryTerms).not.toContain("Neoplasm Metastasis");
  });

  it("captures the canonical name when SeeRelatedList > DescriptorReferredTo > DescriptorName follows it", async () => {
    const xml =
      XML_HEAD +
      `<DescriptorRecord>
        <DescriptorUI>D000001</DescriptorUI>
        <DescriptorName><String>Calcimycin</String></DescriptorName>
        <ConceptList>
          <Concept PreferredConceptYN="Y">
            <TermList>
              <Term><String>Calcimycin</String></Term>
            </TermList>
          </Concept>
        </ConceptList>
        <SeeRelatedList>
          <SeeRelatedDescriptor>
            <DescriptorReferredTo>
              <DescriptorUI>D000002</DescriptorUI>
              <DescriptorName><String>Some Other Descriptor</String></DescriptorName>
            </DescriptorReferredTo>
          </SeeRelatedDescriptor>
        </SeeRelatedList>
      </DescriptorRecord>` +
      XML_TAIL;

    const results = await parseAll(xml);
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("Calcimycin");
  });

  it("captures the canonical name when the canonical DescriptorName is the only one in the record", async () => {
    const xml =
      XML_HEAD +
      `<DescriptorRecord>
        <DescriptorUI>D000003</DescriptorUI>
        <DescriptorName><String>Plain Descriptor</String></DescriptorName>
      </DescriptorRecord>` +
      XML_TAIL;

    const results = await parseAll(xml);
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("Plain Descriptor");
  });

  it("handles multiple records in one stream without cross-contamination", async () => {
    const xml =
      XML_HEAD +
      `<DescriptorRecord>
        <DescriptorUI>D000010</DescriptorUI>
        <DescriptorName><String>First</String></DescriptorName>
        <PharmacologicalActionList>
          <PharmacologicalAction>
            <DescriptorReferredTo>
              <DescriptorUI>Dxxx</DescriptorUI>
              <DescriptorName><String>Referenced From First</String></DescriptorName>
            </DescriptorReferredTo>
          </PharmacologicalAction>
        </PharmacologicalActionList>
      </DescriptorRecord>
      <DescriptorRecord>
        <DescriptorUI>D000011</DescriptorUI>
        <DescriptorName><String>Second</String></DescriptorName>
      </DescriptorRecord>` +
      XML_TAIL;

    const results = await parseAll(xml);
    expect(results.map((r) => [r.descriptorUi, r.name])).toEqual([
      ["D000010", "First"],
      ["D000011", "Second"],
    ]);
  });
});
