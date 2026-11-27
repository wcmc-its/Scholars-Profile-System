/**
 * Pure shaping for the citation-links ETL: no I/O, so it is unit-tested
 * directly (tests/unit/citation-links.test.ts).
 */

/**
 * The Scholars publications a link can join: the PubMed-keyed ones.
 * `publication.pmid` also holds source-prefixed ids for papers not in PubMed,
 * which no PubMed citation can name.
 */
export function pubmedPmids(raw: ReadonlyArray<string>): number[] {
  return raw.filter((p) => /^\d{1,9}$/.test(p)).map(Number);
}

/**
 * The cited papers a run reads, in ascending order. `only` (`--pmids`) keeps
 * those of them that are in Scholars; `limit` (`--limit`) keeps the first n.
 * The citing end of a link is always checked against all of Scholars, so a
 * spot check of one paper finds every Scholars paper that cites it.
 */
export function citedToRead(
  scholars: ReadonlyArray<number>,
  opts: { only?: ReadonlyArray<string>; limit?: number },
): number[] {
  let out = [...scholars].sort((a, b) => a - b);
  if (opts.only) {
    const want = new Set(opts.only.map(Number));
    out = out.filter((p) => want.has(p));
  }
  return opts.limit ? out.slice(0, opts.limit) : out;
}

/**
 * The links to keep from one read of `analysis_nih_cites`, as `[cited, citing]`:
 * both papers in Scholars, not a paper citing itself, each pair once (the
 * source can hold a pair twice).
 */
export function keepLinks(
  rows: ReadonlyArray<readonly [number, number]>,
  scholars: ReadonlySet<number>,
): Array<[number, number]> {
  const seen = new Set<string>();
  const out: Array<[number, number]> = [];
  for (const [cited, citing] of rows) {
    if (cited === citing || !scholars.has(cited) || !scholars.has(citing)) continue;
    const key = `${cited}|${citing}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([cited, citing]);
  }
  return out;
}

/**
 * Pairs of PMIDs packed two to a slot in one growing Uint32Array: 8 bytes a
 * pair, about 16 MB for 2 million, where as JS arrays or objects they would
 * cost several times that. Every PMID is at most 9 digits, under 2^32.
 */
export class PairBuffer {
  private data = new Uint32Array(2 * 65_536);
  private n = 0;

  get length(): number {
    return this.n;
  }

  push(cited: number, citing: number): void {
    if (2 * this.n + 2 > this.data.length) {
      const grown = new Uint32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    this.data[2 * this.n] = cited;
    this.data[2 * this.n + 1] = citing;
    this.n++;
  }

  /** Pairs `start` to `end` (exclusive) as rows for `publication_citation`. */
  rows(start: number, end: number): Array<{ citedPmid: string; citingPmid: string }> {
    const out: Array<{ citedPmid: string; citingPmid: string }> = [];
    for (let i = start; i < Math.min(end, this.n); i++) {
      out.push({ citedPmid: String(this.data[2 * i]), citingPmid: String(this.data[2 * i + 1]) });
    }
    return out;
  }
}
