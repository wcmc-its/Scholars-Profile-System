/**
 * Pure parts of the patent-citations EXTRACT (extract.ts): id parsing, the
 * parent/child pairing of the related-document tables, invention families, a
 * Python-compatible delimited-text reader, and the document rows. No I/O, so
 * it is unit-tested directly (tests/unit/patent-citations-extract.test.ts).
 *
 * This is a port of the laptop pipeline the 2026-11-26 load was built with;
 * where its rules look odd they are kept so a rebuild reproduces that file.
 */
import type { DocRow } from "./shape";

export type DocKind = "pregrant" | "grant" | "reissue" | "design" | "sir" | "plant" | "other";

/**
 * Dataset id -> kind and PatentsView key. Pre-grant ids are ten digits in the
 * dataset (yyyy + six-digit serial); PatentsView's pgpub_id is eleven, so a
 * zero goes back after the year.
 */
export function docKey(pat: string): { kind: DocKind; key: string | null } {
  const m = /^us-(\D*)(\d+)-([a-z]\d?)$/.exec(pat);
  if (!m) return { kind: "other", key: null };
  const [, pre, num, k] = m;
  const bare = String(Number(num));
  if (pre === "" && num.length === 10) return { kind: "pregrant", key: `${num.slice(0, 4)}0${num.slice(4)}` };
  if (pre === "" && num.length === 11) return { kind: "pregrant", key: num };
  if (pre === "" && ["b1", "b2", "a"].includes(k)) return { kind: "grant", key: bare };
  if (pre === "re") return { kind: "reissue", key: `RE${bare}` };
  if (pre === "d") return { kind: "design", key: `D${bare}` };
  if (pre === "h") return { kind: "sir", key: `H${bare}` };
  if (pre === "pp") return { kind: "plant", key: `PP${bare}` };
  return { kind: "other", key: null };
}

const isDigits = (s: string) => /^\d+$/.test(s);

/** Application number -> node key. US serials become 8 digits; PCT numbers an upper-case alnum string. */
export function appNorm(s: string): string {
  const t = s.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  if (isDigits(t)) return t.length <= 8 ? t.padStart(8, "0") : t;
  if (t.startsWith("US") && isDigits(t.slice(2))) return t.slice(2).padStart(8, "0");
  return t;
}

/** PatentsView pads letter-prefixed numbers ("H002055"); the dataset does not. */
export const unpad = (pid: string) => pid.replace(/^([A-Z]+)0+/, "$1");
/** Python's `clean`: tabs and line breaks to spaces, then trimmed. */
export const clean = (s: string) => s.replace(/[\t\n\r]/g, " ").trim();

/**
 * Rows of a delimited file, read as Python's csv module reads a file opened in
 * text mode: quotes only open a field at its start, "" inside quotes is a
 * quote, and \r\n or a lone \r ends a line like \n. Feed it decoded text in
 * any chunking; `end()` flushes the last row. Rows of the wrong width are the
 * caller's to skip.
 */
export class DelimitedReader {
  private buf = "";
  private cr = false;
  constructor(private readonly delim: string) {}

  push(chunk: string, out: (row: string[]) => void): void {
    // universal newlines; a \r at a chunk's end may be the first half of \r\n
    let s = chunk;
    if (this.cr && s.startsWith("\n")) s = s.slice(1);
    this.cr = s.endsWith("\r");
    this.buf += s.replace(/\r\n?/g, "\n");
    this.drain(out, false);
  }

  end(out: (row: string[]) => void): void {
    if (this.buf !== "" && !this.buf.endsWith("\n")) this.buf += "\n";
    this.drain(out, true);
  }

  private drain(out: (row: string[]) => void, final: boolean): void {
    const b = this.buf;
    let pos = 0;
    while (pos < b.length) {
      const nl = b.indexOf("\n", pos);
      if (nl < 0) break;
      const line = b.slice(pos, nl);
      if (!line.includes('"')) {
        out(line === "" ? [] : line.split(this.delim));
        pos = nl + 1;
        continue;
      }
      const r = this.quoted(b, pos);
      if (!r) {
        if (!final) break;
        // ponytail: an unclosed quote at end of file keeps what was read, as
        // Python's non-strict reader does; never seen in these files.
        out(b.slice(pos).replace(/\n$/, "").split(this.delim));
        pos = b.length;
        break;
      }
      out(r.row);
      pos = r.next;
    }
    this.buf = b.slice(pos);
  }

  /** One record from `pos` by the state machine; null when it runs past the buffer. */
  private quoted(b: string, pos: number): { row: string[]; next: number } | null {
    const row: string[] = [];
    let f = "";
    let st: "start" | "field" | "q" | "qq" = "start";
    for (let i = pos; i < b.length; i++) {
      const c = b[i];
      if (st === "q") {
        if (c === '"') st = "qq";
        else f += c;
      } else if (st === "qq") {
        if (c === '"') {
          f += c;
          st = "q";
        } else if (c === this.delim) {
          row.push(f);
          f = "";
          st = "start";
        } else if (c === "\n") {
          row.push(f);
          return { row, next: i + 1 };
        } else {
          f += c;
          st = "field";
        }
      } else if (c === this.delim) {
        row.push(f);
        f = "";
        st = "start";
      } else if (c === "\n") {
        row.push(f);
        return { row, next: i + 1 };
      } else if (st === "start" && c === '"') st = "q";
      else {
        f += c;
        st = "field";
      }
    }
    return null;
  }
}

// ---- related-document pairing --------------------------------------------

export const REL_TYPES: Record<string, string> = {
  continuation: "con",
  division: "div",
  reissue: "rei",
  "continuing-reissue": "rei",
  substitution: "sub",
  "us-reexamination-reissue-merger": "rei",
  "continuation-in-part": "cip",
};
export const REL_KINDS: Record<string, string> = {
  "parent-doc": "P",
  "child-doc": "C",
  "parent-pct-document": "W",
  "parent-grant-document": "G",
};

/** One related-document row: sequence, relation type code, row kind code, normalised number. */
export type RelRow = { seq: string; type: string; kind: string; num: string; line: string };

/** The number a related-document row points at, normalised as the edges use it. */
export function relNumber(kind: string, raw: string): string {
  return kind === "G" ? raw.replace(/ /g, "").replace(/\./g, "").toUpperCase() : appNorm(raw);
}

/**
 * Rows of one record in the order the laptop pipeline paired them: `sort -k2,2n`
 * on the sequence, then (sort's last resort) the whole line, byte order.
 */
export function sortRecord(rows: RelRow[]): RelRow[] {
  const n = (s: string) => parseInt(s, 10) || 0;
  return [...rows].sort((a, b) => n(a.seq) - n(b.seq) || (a.line < b.line ? -1 : a.line > b.line ? 1 : 0));
}

type Edge = [parent: string, child: string, type: string];
const numKey = (s: string): [number, number, string] => (isDigits(s) ? [1, Number(s), ""] : [0, 0, s]);
function cmpNum(a: string, b: string): number {
  const x = numKey(a);
  const y = numKey(b);
  return x[0] - y[0] || x[1] - y[1] || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0);
}

/**
 * Parent/child edges between application numbers from one record's rows,
 * already in `sortRecord` order. Sequence order is a reliable pairing only in
 * granted records from about 2005 on (parent, grant, pct, child): there it is
 * used when it pairs cleanly. Early granted records list child before parent
 * and repeat every row, and the pre-grant table's sequence is the rows sorted
 * by number, so those pair without relying on order: within one relation
 * type, the i-th lowest parent goes with the i-th lowest child (PCT numbers
 * sort first). A PCT row after a parent makes a `pct` edge.
 */
export function pairRecord(granted: boolean, all: RelRow[]): Edge[] {
  const rs = all.filter((r) => r.num !== "");
  const mult = new Map<string, { type: string; kind: string; num: string; n: number }>();
  for (const r of rs) {
    if (r.kind !== "P" && r.kind !== "C") continue;
    const k = `${r.type}\t${r.kind}\t${r.num}`;
    const m = mult.get(k);
    if (m) m.n++;
    else mult.set(k, { type: r.type, kind: r.kind, num: r.num, n: 1 });
  }
  if (mult.size && [...mult.values()].every((m) => m.n % 2 === 0)) for (const m of mult.values()) m.n /= 2;
  const edges = new Map<string, Edge>();
  const add = (e: Edge) => edges.set(e.join("\t"), e);
  for (const t of new Set([...mult.values()].map((m) => m.type))) {
    const side = (kind: string) =>
      [...mult.values()].filter((m) => m.type === t && m.kind === kind).flatMap((m) => Array<string>(m.n).fill(m.num)).sort(cmpNum);
    const P = side("P");
    const C = side("C");
    const pairs: Array<[string | null, string]> =
      P.length === C.length
        ? P.map((p, i) => [p, C[i]])
        : C.map((c) => {
            let best: string | null = null;
            for (const p of P) if (cmpNum(p, c) < 0 && (best === null || cmpNum(p, best) > 0)) best = p;
            return [best, c];
          });
    for (const [p, c] of pairs) if (p !== null && p !== c) add([p, c, t]);
  }
  let result = edges;
  if (granted && rs.length) {
    const ordered = new Map<string, Edge>();
    let parent: { num: string; type: string } | null = null;
    let ok = true;
    for (const r of rs) {
      if (r.kind === "P") parent = { num: r.num, type: r.type };
      else if (r.kind === "C") {
        if (parent && parent.type === r.type && parent.num !== r.num) {
          const e: Edge = [parent.num, r.num, r.type];
          ordered.set(e.join("\t"), e);
          parent = null;
        } else ok = false;
      }
    }
    if (ok) result = ordered;
  }
  let parent: string | null = null;
  for (const r of rs) {
    if (r.kind === "P") parent = r.num;
    else if (r.kind === "W" && parent && parent !== r.num) {
      const e: Edge = [parent, r.num, "pct"];
      result.set(e.join("\t"), e);
    }
  }
  return [...result.values()];
}

// ---- families -------------------------------------------------------------

/**
 * Connected components over application numbers. Every edge's ends are
 * nodes; continuation-in-part edges add their nodes but join nothing. A family
 * key is the lowest US application number in the component.
 */
export class Families {
  private id = new Map<string, number>();
  private parent: number[] = [];
  private us: number[] = []; // the US application number, or Infinity for a PCT number
  private done: { root: Int32Array; min: Float64Array; size: Int32Array } | null = null;

  /** Node key: a US number (up to 11 digits) by its value, so "0123" and "123" are one node. */
  private static key(s: string): string {
    return isDigits(s) && s.length <= 11 ? `n${Number(s)}` : `s${s}`;
  }
  private node(s: string): number {
    const k = Families.key(s);
    let i = this.id.get(k);
    if (i === undefined) {
      i = this.parent.length;
      this.id.set(k, i);
      this.parent.push(i);
      this.us.push(isDigits(s) && s.length <= 11 ? Number(s) : Infinity);
    }
    return i;
  }
  private find(x: number): number {
    const p = this.parent;
    while (p[x] !== x) {
      p[x] = p[p[x]];
      x = p[x];
    }
    return x;
  }

  addEdge(parent: string, child: string, type: string): void {
    const a = this.node(parent);
    const b = this.node(child);
    if (type === "cip") return;
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }

  get nodes(): number {
    return this.parent.length;
  }

  private settle() {
    if (this.done) return this.done;
    const n = this.parent.length;
    const root = new Int32Array(n);
    const min = new Float64Array(n).fill(Infinity);
    const size = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const r = this.find(i);
      root[i] = r;
      size[r]++;
      if (this.us[i] < min[r]) min[r] = this.us[i];
    }
    return (this.done = { root, min, size });
  }

  /**
   * A document's family key and size from its application number `x`. No
   * number: none. A number in no edge keeps itself; a component with no US
   * number is keyed `app:<x>`.
   */
  family(x: string): { key: string; size: number } | null {
    if (!x) return null;
    if (!isDigits(x)) return { key: `app:${x}`, size: 1 };
    const i = this.id.get(Families.key(x));
    if (i === undefined) return { key: x, size: 1 };
    const { root, min, size } = this.settle();
    const m = min[root[i]];
    return { key: Number.isFinite(m) ? String(m).padStart(8, "0") : `app:${x}`, size: size[root[i]] };
  }
}

// ---- document rows ----------------------------------------------------------

export type GrantFacts = { date: string; title: string };
export type PgpubFacts = { title: string; published: string; filing: string };

/** What the patent tables gave for the cited documents, keyed as the emit step keyed them. */
export type PatentTables = {
  grant: Map<string, GrantFacts>; // unpadded patent_id
  grantFiling: Map<string, string>; // unpadded patent_id -> filing date
  pgpub: Map<string, PgpubFacts>; // pgpub_id
  /** "g"+raw patent_id or "p"+pgpub_id -> application number */
  app: Map<string, string>;
  assignees: Map<string, Array<[number, string]>>; // unpadded key
  inventors: Map<string, Array<[number, string, string]>>;
};

const date = (s: string | undefined) => (s && /^\d{4}-\d\d-\d\d$/.test(s) && !s.startsWith("0000") ? s : null);
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The extract's `doc` row for one dataset id. */
export function docRow(pat: string, t: PatentTables, fam: Families): DocRow & { noMetadata?: true } {
  const { kind, key } = docKey(pat);
  const d: DocRow & { noMetadata?: true } = { id: pat };
  if (!key) return d;
  const g = kind !== "pregrant" ? t.grant.get(key) : undefined;
  const p = kind === "pregrant" ? t.pgpub.get(key) : undefined;
  if (p) Object.assign(d, { title: p.title, publicationDate: date(p.published), filingDate: date(p.filing) });
  else if (g) Object.assign(d, { title: g.title, grantDate: date(g.date), filingDate: t.grantFiling.has(key) ? date(t.grantFiling.get(key)) : null });
  else d.noMetadata = true;
  const x = t.app.get((kind === "pregrant" ? "p" : "g") + key) ?? "";
  if (x) d.applicationId = x;
  const f = fam.family(x);
  if (f) Object.assign(d, { familyKey: f.key, familySize: f.size });
  d.assignees = [...(t.assignees.get(key) ?? [])].sort((a, b) => a[0] - b[0] || cmpStr(a[1], b[1])).map(([, n]) => n);
  d.inventors = [...(t.inventors.get(key) ?? [])]
    .sort((a, b) => a[0] - b[0] || cmpStr(a[1], b[1]) || cmpStr(a[2], b[2]))
    .map(([, first, last]) => ({ first, last }));
  return d;
}
