import { describe, expect, it } from "vitest";
import type { ProfilePublication } from "@/lib/api/profile";
import {
  hydrateClientPublications,
  toClientPublicationWire,
  type ProfileClientPublication,
} from "@/lib/profile/client-publication";

type WcmAuthor = ProfilePublication["wcmAuthors"][number];

function author(
  cwid: string,
  isFirst: boolean,
  isLast: boolean,
  position: number,
  roleCategory: string | null = "full_time_faculty",
): WcmAuthor {
  return {
    name: `Name ${cwid}`,
    cwid,
    slug: `slug-${cwid}`,
    identityImageEndpoint: `https://directory.example.edu/photo/${cwid}.png`,
    isFirst,
    isLast,
    position,
    roleCategory,
  };
}

function fullPub(over: Partial<ProfilePublication> = {}): ProfilePublication {
  return {
    pmid: "1",
    title: "A <i>title</i>",
    authorsString: "Doe J, Roe R",
    journal: "J Test",
    year: 2020,
    publicationType: "Academic Article",
    citationCount: 3,
    reciteraiImpact: 42,
    dateAddedToEntrez: new Date("2020-01-01"),
    doi: "10.1/x",
    pmcid: "PMC1",
    pubmedUrl: "https://pubmed.ncbi.nlm.nih.gov/1/",
    ecommonsLink: "https://hdl.handle.net/1813/1",
    authorship: { isFirst: true, isLast: false, isPenultimate: true },
    isConfirmed: true,
    meshTerms: [
      { ui: "D1", label: "One" },
      { ui: null, label: "Unresolved" },
      { ui: "D2", label: "Two" },
      { ui: "D1", label: "One again" },
    ],
    hasAbstract: true,
    wcmAuthors: [author("own1", true, false, 1), author("col2", false, true, 4, null)],
    score: 0.5,
    ...over,
  };
}

/** The client projection the components read, derived independently from the
 *  full server shape — what a wire round trip must reproduce exactly. */
function expectedClient(p: ProfilePublication): ProfileClientPublication {
  const meshUis: string[] = [];
  for (const t of p.meshTerms) if (t.ui !== null && !meshUis.includes(t.ui)) meshUis.push(t.ui);
  return {
    pmid: p.pmid,
    title: p.title,
    authorsString: p.authorsString,
    journal: p.journal,
    year: p.year,
    publicationType: p.publicationType,
    citationCount: p.citationCount,
    doi: p.doi,
    pmcid: p.pmcid,
    ecommonsLink: p.ecommonsLink,
    authorship: { isFirst: p.authorship.isFirst, isLast: p.authorship.isLast },
    meshUis,
    hasAbstract: p.hasAbstract,
    wcmAuthors: p.wcmAuthors.map((a) => ({
      name: a.name,
      cwid: a.cwid,
      slug: a.slug,
      identityImageEndpoint: a.identityImageEndpoint,
      isFirst: a.isFirst,
      isLast: a.isLast,
      roleCategory: a.roleCategory,
    })),
  };
}

const roundTrip = (pubs: ProfilePublication[]) =>
  hydrateClientPublications(toClientPublicationWire(pubs));

describe("client publication wire (#2213)", () => {
  it("round-trips every client-read field", () => {
    const pubs = [
      fullPub(),
      fullPub({
        pmid: "2",
        authorsString: null,
        journal: null,
        year: null,
        publicationType: null,
        citationCount: 0,
        doi: null,
        pmcid: null,
        ecommonsLink: null,
        authorship: { isFirst: false, isLast: true, isPenultimate: false },
        meshTerms: [],
        hasAbstract: false,
        wcmAuthors: [],
      }),
      // year 0 is the real "undated" value and must not collapse to null.
      fullPub({ pmid: "3", year: 0, wcmAuthors: [author("col2", true, true, 1, null)] }),
      fullPub({
        pmid: "4",
        authorship: { isFirst: true, isLast: true, isPenultimate: false },
        wcmAuthors: [author("own1", true, true, 1)],
      }),
    ];
    expect(roundTrip(pubs)).toEqual(pubs.map(expectedClient));
  });

  it("keeps display order and per-row author order/flags", () => {
    const pubs = [
      fullPub({ pmid: "9", wcmAuthors: [author("b", false, false, 2), author("a", true, false, 1)] }),
      fullPub({ pmid: "8", wcmAuthors: [author("a", false, true, 3), author("b", true, false, 1)] }),
    ];
    const out = roundTrip(pubs);
    expect(out.map((p) => p.pmid)).toEqual(["9", "8"]);
    expect(out[0].wcmAuthors.map((a) => [a.cwid, a.isFirst, a.isLast])).toEqual([
      ["b", false, false],
      ["a", true, false],
    ]);
    expect(out[1].wcmAuthors.map((a) => [a.cwid, a.isFirst, a.isLast])).toEqual([
      ["a", false, true],
      ["b", true, false],
    ]);
  });

  it("interns author identities and repeated strings", () => {
    const pubs = [fullPub({ pmid: "1" }), fullPub({ pmid: "2" }), fullPub({ pmid: "3" })];
    const wire = toClientPublicationWire(pubs);
    expect(wire.people).toHaveLength(2);
    // journal, publication type, D1, D2
    expect(wire.strings).toEqual(["J Test", "Academic Article", "D1", "D2"]);
  });

  it("never interns two identities that differ in a rendered field", () => {
    const a1 = author("same", false, false, 1);
    const a2 = { ...author("same", false, false, 1), name: "Other spelling" };
    const out = roundTrip([fullPub({ wcmAuthors: [a1] }), fullPub({ pmid: "2", wcmAuthors: [a2] })]);
    expect(out[0].wcmAuthors[0].name).toBe("Name same");
    expect(out[1].wcmAuthors[0].name).toBe("Other spelling");
  });

  it("drops the server-only and unused fields from the wire", () => {
    const json = JSON.stringify(toClientPublicationWire([fullPub()]));
    for (const leaked of [
      "pubmed.ncbi.nlm.nih.gov",
      "reciteraiImpact",
      "isPenultimate",
      "Unresolved", // MeSH labels
      "One again",
      "2020-01-01", // dateAddedToEntrez
    ]) {
      expect(json).not.toContain(leaked);
    }
  });

  it("never emits undefined values (the RSC serializer would spell them out)", () => {
    const wire = toClientPublicationWire([
      fullPub({ authorsString: null, doi: null, journal: null, meshTerms: [], wcmAuthors: [] }),
    ]);
    for (const p of wire.pubs) {
      for (const v of Object.values(p)) expect(v).not.toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Payload budget. A synthetic 2,000-publication profile with realistic field
// sizes: titles ~90-180 chars, PubMed author strings of 3-25 authors with a 4%
// tail of 80-400-author consortium papers, ~15 MeSH terms each drawn from a
// 600-descriptor pool, 1-5 WCM authors (owner always on) from a 120-colleague
// pool, journals from a 250-title pool.
//
// Measured (JSON.stringify bytes) when this test was written:
//   before (ProfilePublication minus the 4 ranking fields):  4,283,182 B
//   after  (toClientPublicationWire):                        1,212,186 B  (-72%)
//   of which authorsString alone:                              552,163 B
// authorsString stays on the wire: the in-profile search box matches on the
// full author list (including non-WCM authors), so dropping it would change
// search behavior.
// ---------------------------------------------------------------------------
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function syntheticProfile(n: number): ProfilePublication[] {
  const r = rng(2213);
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const word = () => {
    const len = int(3, 11);
    let w = "";
    for (let i = 0; i < len; i++) w += String.fromCharCode(97 + int(0, 25));
    return w;
  };
  const words = (k: number) => Array.from({ length: k }, word).join(" ");
  const surname = () => {
    const w = word();
    return w[0].toUpperCase() + w.slice(1);
  };

  const meshPool = Array.from({ length: 600 }, (_, i) => ({
    ui: `D${String(100000 + i * 37).padStart(6, "0")}`,
    label: words(int(1, 4)),
  }));
  const journalPool = Array.from({ length: 250 }, () => words(int(2, 6)));
  const types = ["Academic Article", "Review", "Letter", "Editorial Article", "Case Report"];
  const owner = author("own2001", false, false, 0, "full_time_faculty");
  const colleagues = Array.from({ length: 120 }, (_, i) =>
    author(`c${String(i).padStart(4, "0")}x`, false, false, 0, i % 9 === 0 ? null : "full_time_faculty"),
  );

  return Array.from({ length: n }, (_, i) => {
    const nAuthors = r() < 0.04 ? int(80, 400) : int(3, 25);
    const authorsString = Array.from(
      { length: nAuthors },
      () => `${surname()} ${String.fromCharCode(65 + int(0, 25))}${r() < 0.5 ? String.fromCharCode(65 + int(0, 25)) : ""}`,
    ).join(", ");
    const nWcm = int(1, 5);
    const ownerFirst = r() < 0.25;
    const ownerLast = !ownerFirst && r() < 0.35;
    const wcm: WcmAuthor[] = [{ ...owner, isFirst: ownerFirst, isLast: ownerLast, position: 1 }];
    for (let k = 1; k < nWcm; k++) {
      const c = colleagues[int(0, colleagues.length - 1)];
      wcm.push({ ...c, isFirst: false, isLast: k === nWcm - 1 && !ownerLast && r() < 0.3, position: k + 1 });
    }
    const mesh = Array.from({ length: int(10, 20) }, () => meshPool[int(0, meshPool.length - 1)]);
    const pmid = String(30000000 + i * 17);
    return {
      pmid,
      title: words(int(12, 22)),
      authorsString,
      journal: journalPool[int(0, journalPool.length - 1)],
      year: 2025 - Math.floor(i / 80),
      publicationType: types[int(0, types.length - 1)],
      citationCount: int(0, 400),
      reciteraiImpact: int(0, 100),
      dateAddedToEntrez: new Date(Date.UTC(2025 - Math.floor(i / 80), 0, 1)),
      doi: r() < 0.9 ? `10.${int(1000, 9999)}/${word()}.${int(1, 99999)}` : null,
      pmcid: r() < 0.4 ? `PMC${int(1000000, 9999999)}` : null,
      pubmedUrl: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
      ecommonsLink: r() < 0.05 ? `https://hdl.handle.net/1813/${int(10000, 99999)}` : null,
      authorship: { isFirst: ownerFirst, isLast: ownerLast, isPenultimate: false },
      isConfirmed: true,
      meshTerms: mesh,
      hasAbstract: r() < 0.85,
      wcmAuthors: wcm,
      score: r(),
    };
  });
}

describe("client publication payload budget (#2213)", () => {
  const pubs = syntheticProfile(2000);
  const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), "utf8");

  it("stays under 1.4 MB for a 2,000-publication profile (was ~4.3 MB)", () => {
    // The pre-change client shape: the full row minus the 4 ranking fields.
    const legacy = bytes(
      pubs.map((p) => {
        const o: Record<string, unknown> = { ...p };
        for (const k of ["dateAddedToEntrez", "reciteraiImpact", "isConfirmed", "score"]) delete o[k];
        return o;
      }),
    );
    const wire = bytes(toClientPublicationWire(pubs));
    const authorsOnly = bytes(pubs.map((p) => p.authorsString));
    // Uncomment to re-measure:
    // console.log({ legacy, wire, authorsOnly });
    expect(wire).toBeLessThan(1_400_000);
    expect(wire).toBeLessThan(legacy * 0.35);
    // Everything except the author strings is now a small fraction of the payload.
    expect(wire - authorsOnly).toBeLessThan(750_000);
  });

  it("hydrates the synthetic profile back to the exact client projection", () => {
    expect(roundTrip(pubs)).toEqual(pubs.map(expectedClient));
  });
});
