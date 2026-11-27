/** Citation links (etl:citation-links): the pure filtering and dedupe, the
 *  spot-check selection, and the loader against an in-memory table. PMIDs are
 *  invented. */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** `publication_citation`, held in memory. */
const h = vi.hoisted(() => {
  type Row = { citedPmid: string; citingPmid: string };
  const t = { link: [] as Row[] };
  const write = {
    publicationCitation: {
      count: vi.fn(async () => t.link.length),
      createMany: vi.fn(async ({ data, skipDuplicates }: { data: Row[]; skipDuplicates?: boolean }) => {
        if (!skipDuplicates) throw new Error("expected skipDuplicates");
        const taken = new Set(t.link.map((l) => `${l.citedPmid}|${l.citingPmid}`));
        const fresh = data.filter((l) => !taken.has(`${l.citedPmid}|${l.citingPmid}`));
        t.link.push(...fresh.map((l) => ({ ...l })));
        return { count: fresh.length };
      }),
    },
    reset: () => {
      t.link.length = 0;
    },
  };
  return { t, write };
});
vi.mock("@/lib/db", () => ({ db: { write: h.write } }));

import { loadCitationLinks } from "@/etl/citation-links/load";
import { citedToRead, keepLinks, PairBuffer, pubmedPmids } from "@/etl/citation-links/shape";
import { EtlGuardError } from "@/lib/etl-guard";

const SCHOLARS = new Set([101, 102, 103, 104]);

function sources(links: Array<[number, number]>) {
  return { readLinks: vi.fn(async (cited: number[]) => links.filter(([c]) => cited.includes(c))) };
}
const run = (cited: number[], src: ReturnType<typeof sources>, partial = false, scholars = SCHOLARS) =>
  loadCitationLinks(cited, scholars, { partial }, src);
const stored = () => h.t.link.map((l) => `${l.citedPmid}<${l.citingPmid}`).sort();

beforeEach(() => {
  h.write.reset();
  h.write.publicationCitation.createMany.mockClear();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("which links are kept", () => {
  it("keeps a link only when both papers are Scholars publications", () => {
    expect(
      keepLinks(
        [
          [101, 102],
          [101, 900], // citing paper not in Scholars
          [900, 101], // cited paper not in Scholars
        ],
        SCHOLARS,
      ),
    ).toEqual([[101, 102]]);
  });

  it("drops a paper citing itself", () => {
    expect(keepLinks([[101, 101], [101, 103]], SCHOLARS)).toEqual([[101, 103]]);
  });

  it("collapses a pair the source holds twice", () => {
    expect(keepLinks([[101, 102], [101, 102], [102, 101]], SCHOLARS)).toEqual([
      [101, 102],
      [102, 101],
    ]);
  });

  it("takes only PubMed-keyed publications, which a PubMed citation can name", () => {
    expect(pubmedPmids(["101", "ext-77", "", "1234567890", "102"])).toEqual([101, 102]);
  });
});

describe("the packed buffer", () => {
  it("returns every pair, as strings, across growth", () => {
    const b = new PairBuffer();
    for (let i = 0; i < 200_000; i++) b.push(i + 1, 999_999_999 - i);
    expect(b.length).toBe(200_000);
    expect(b.rows(0, 2)).toEqual([
      { citedPmid: "1", citingPmid: "999999999" },
      { citedPmid: "2", citingPmid: "999999998" },
    ]);
    expect(b.rows(199_999, 300_000)).toEqual([{ citedPmid: "200000", citingPmid: "999800000" }]);
  });
});

describe("--pmids and --limit", () => {
  const all = [104, 101, 103, 102];

  it("reads every Scholars paper, in order, by default", () => {
    expect(citedToRead(all, {})).toEqual([101, 102, 103, 104]);
  });

  it("--pmids reads only the given papers that are in Scholars", () => {
    expect(citedToRead(all, { only: ["103", "900"] })).toEqual([103]);
  });

  it("--limit reads the first n", () => {
    expect(citedToRead(all, { limit: 2 })).toEqual([101, 102]);
  });

  it("a spot check still finds citing papers outside the papers it reads", async () => {
    const out = await run(citedToRead(all, { only: ["101"] }), sources([[101, 104], [102, 103]]), true);
    expect(stored()).toEqual(["101<104"]);
    expect(out).toEqual({ publications: 1, read: 1, kept: 1, added: 1 });
  });

  it("a spot check of a paper nothing cites is an answer, and writes nothing", async () => {
    await expect(run([103], sources([]), true)).resolves.toEqual({ publications: 1, read: 0, kept: 0, added: 0 });
    expect(h.write.publicationCitation.createMany).not.toHaveBeenCalled();
  });
});

describe("the load", () => {
  const links: Array<[number, number]> = [
    [101, 102],
    [101, 102],
    [101, 101],
    [101, 900],
    [102, 103],
    [103, 101],
  ];

  it("writes the kept links and counts what it read, kept and added", async () => {
    const out = await run([101, 102, 103, 104], sources(links));
    expect(stored()).toEqual(["101<102", "102<103", "103<101"]);
    expect(out).toEqual({ publications: 4, read: 6, kept: 3, added: 3 });
  });

  it("only adds: a second run adds nothing, and a link the source drops stays", async () => {
    await run([101, 102, 103, 104], sources(links));
    const out = await run([101, 102, 103, 104], sources(links.filter(([c]) => c !== 103)));
    expect(out).toMatchObject({ kept: 2, added: 0 });
    expect(stored()).toEqual(["101<102", "102<103", "103<101"]);
  });

  it("reads in batches of cited papers and writes in batches", async () => {
    const many = Array.from({ length: 1200 }, (_, i) => 1 + i);
    const scholars = new Set(many);
    const src = sources(many.slice(1).map((p): [number, number] => [p, 1]));
    const out = await run(many, src, false, scholars);
    expect(src.readLinks).toHaveBeenCalledTimes(3);
    expect(src.readLinks.mock.calls.map(([c]) => c.length)).toEqual([500, 500, 200]);
    expect(out).toMatchObject({ kept: 1199, added: 1199 });
  });
});

describe("a bad reciterdb read", () => {
  const seed = async () => {
    await run(
      [101],
      sources([101, 102, 103, 104].flatMap((g) => (g === 101 ? [] : [[101, g] as [number, number]]))),
      false,
    );
    await run([102], sources([[102, 101], [102, 103], [102, 104]]), true);
    h.write.publicationCitation.createMany.mockClear();
  };
  const untouched = () => {
    expect(h.t.link).toHaveLength(6);
    expect(h.write.publicationCitation.createMany).not.toHaveBeenCalled();
  };

  it("an empty read over the whole corpus throws before any write", async () => {
    await seed();
    await expect(run([101, 102], sources([]))).rejects.toThrow("analysis_nih_cites returned no citation links");
    untouched();
  });

  it("a failed read throws before any write, even after earlier batches read fine", async () => {
    await seed();
    const many = Array.from({ length: 1000 }, (_, i) => 101 + i);
    const src = sources(many.map((p): [number, number] => [p, p + 1]));
    src.readLinks.mockImplementationOnce(async () => [[101, 102]]).mockRejectedValueOnce(new Error("connect ETIMEDOUT"));
    await expect(run(many, src, false, new Set(many))).rejects.toThrow("ETIMEDOUT");
    untouched();
  });

  it("a first full load that reads links but keeps none throws before any write", async () => {
    // Nothing is stored yet, so the volume guard has nothing to compare with.
    await expect(run([101, 102], sources([[101, 901], [102, 902]]), false, new Set([101, 102]))).rejects.toThrow(
      "the pmid match is broken",
    );
    expect(h.write.publicationCitation.createMany).not.toHaveBeenCalled();
  });

  it("a read that keeps under half the stored links is refused", async () => {
    await seed();
    await expect(run([101, 102], sources([[101, 102], [102, 103]]))).rejects.toThrow(EtlGuardError);
    untouched();
  });

  it("a read at half or more of the stored links passes", async () => {
    await seed();
    await expect(run([101, 102], sources([[101, 102], [101, 103], [102, 103]]))).resolves.toMatchObject({
      kept: 3,
      added: 0,
    });
  });

  it("a spot check is not held to the whole corpus's volume", async () => {
    await seed();
    await expect(run([101], sources([[101, 102]]), true)).resolves.toMatchObject({ kept: 1, added: 0 });
  });
});
