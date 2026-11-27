import { describe, expect, it } from "vitest";
import {
  DelimitedReader,
  Families,
  appNorm,
  docKey,
  docRow,
  pairRecord,
  sortRecord,
  unpad,
  type PatentTables,
  type RelRow,
} from "@/etl/patent-citations/extract-shape";

// Invented numbers throughout.
const row = (seq: number, type: string, kind: string, num: string): RelRow => ({ seq: String(seq), type, kind, num, line: `g1\t${seq}\t${type}\t${kind}\t${num}` });
const edges = (granted: boolean, rows: RelRow[]) => pairRecord(granted, sortRecord(rows)).map((e) => e.join(" ")).sort();

describe("docKey", () => {
  it("puts the zero back in a ten-digit pre-grant id", () => {
    expect(docKey("us-2019123456-a1")).toEqual({ kind: "pregrant", key: "20190123456" });
  });
  it("reads grants, reissues, designs and SIRs without padding", () => {
    expect(docKey("us-9000001-b2")).toEqual({ kind: "grant", key: "9000001" });
    expect(docKey("us-re09001-e")).toEqual({ kind: "reissue", key: "RE9001" });
    expect(docKey("us-d0900001-s")).toEqual({ kind: "design", key: "D900001" });
    expect(docKey("us-h0901-h")).toEqual({ kind: "sir", key: "H901" });
  });
  it("gives no key to an id it cannot read", () => {
    expect(docKey("us-dk-900000001-a1").key).toBeNull();
    expect(docKey("ep-9000001-b1").key).toBeNull();
  });
});

describe("appNorm and unpad", () => {
  it("pads US serials to eight digits and keeps PCT numbers", () => {
    expect(appNorm("09/123,456")).toBe("09123456");
    expect(appNorm("US 1234567")).toBe("01234567");
    expect(appNorm("pct/us90/01234")).toBe("PCTUS9001234");
  });
  it("drops padding after a letter prefix only", () => {
    expect(unpad("H000901")).toBe("H901");
    expect(unpad("09000001")).toBe("09000001");
  });
});

describe("pairRecord", () => {
  it("pairs a modern granted record in sequence order", () => {
    // parent, grant, pct, child, twice
    const rs = [
      row(0, "con", "P", "90000001"),
      row(1, "con", "G", "9000001"),
      row(2, "con", "C", "90000003"),
      row(3, "con", "P", "90000002"),
      row(4, "con", "C", "90000004"),
    ];
    // order-free pairing would give 01-03 and 02-04 too; sequence order is the same here
    expect(edges(true, rs)).toEqual(["90000001 90000003 con", "90000002 90000004 con"]);
  });
  it("uses sequence order where it differs from number order", () => {
    const rs = [row(0, "con", "P", "90000002"), row(1, "con", "C", "90000003"), row(2, "con", "P", "90000001"), row(3, "con", "C", "90000004")];
    expect(edges(true, rs)).toEqual(["90000001 90000004 con", "90000002 90000003 con"]);
  });
  it("halves an early granted record that lists child first and repeats every row", () => {
    const rs = [
      row(0, "div", "C", "90000005"),
      row(1, "div", "P", "90000001"),
      row(2, "div", "C", "90000005"),
      row(3, "div", "P", "90000001"),
    ];
    expect(edges(true, rs)).toEqual(["90000001 90000005 div"]);
  });
  it("pairs a pre-grant record (rows sorted by number) i-th parent to i-th child", () => {
    const rs = [row(0, "con", "C", "90000003"), row(1, "con", "C", "90000004"), row(2, "con", "P", "90000001"), row(3, "con", "P", "90000002")];
    expect(edges(false, rs)).toEqual(["90000001 90000003 con", "90000002 90000004 con"]);
  });
  it("gives each child the nearest lower parent when the counts differ", () => {
    const rs = [row(0, "con", "P", "90000001"), row(1, "con", "P", "90000005"), row(2, "con", "C", "90000003"), row(3, "con", "C", "90000007"), row(4, "con", "C", "90000009")];
    expect(edges(false, rs)).toEqual(["90000001 90000003 con", "90000005 90000007 con", "90000005 90000009 con"]);
  });
  it("adds a pct edge from the parent before a PCT row, and drops parent equal to child", () => {
    const rs = [row(0, "con", "P", "90000001"), row(1, "con", "W", "PCTUS9001234"), row(2, "con", "C", "90000001")];
    expect(edges(false, rs)).toEqual(["90000001 PCTUS9001234 pct"]);
  });
  it("orders equal sequences by the whole line, as sort did", () => {
    const rs = [row(1, "con", "P", "90000002"), row(1, "con", "C", "90000003"), row(0, "con", "P", "90000001")];
    // lines with seq 1: "...C..." sorts before "...P...": P01, C03, P02 -> 01-03 by order
    expect(sortRecord(rs).map((r) => r.num)).toEqual(["90000001", "90000003", "90000002"]);
  });
});

describe("Families", () => {
  it("joins continuations, not continuations-in-part, and keys on the lowest US number", () => {
    const f = new Families();
    f.addEdge("90000002", "90000003", "con");
    f.addEdge("90000001", "90000002", "div");
    f.addEdge("90000003", "PCTUS9001234", "pct");
    f.addEdge("90000003", "90000009", "cip");
    expect(f.family("90000003")).toEqual({ key: "90000001", size: 4 });
    expect(f.family("90000009")).toEqual({ key: "90000009", size: 1 });
    expect(f.family("90000099")).toEqual({ key: "90000099", size: 1 });
    expect(f.family("PCTUS9001234")).toEqual({ key: "app:PCTUS9001234", size: 1 });
    expect(f.family("")).toBeNull();
  });
  it("treats 0123 and 123 as one application number", () => {
    const f = new Families();
    f.addEdge("00000123", "90000001", "con");
    expect(f.family("123")).toEqual({ key: "00000123", size: 2 });
  });
});

describe("DelimitedReader", () => {
  const read = (chunks: string[], delim = "\t") => {
    const out: string[][] = [];
    const r = new DelimitedReader(delim);
    for (const c of chunks) r.push(c, (x) => out.push(x));
    r.end((x) => out.push(x));
    return out;
  };
  it("splits plain lines and handles \\r\\n across chunks", () => {
    expect(read(["a\tb\r", "\nc\td\re\tf"])).toEqual([["a", "b"], ["c", "d"], ["e", "f"]]);
  });
  it("reads quoted fields with tabs, newlines and doubled quotes, in any chunking", () => {
    const text = 'id\ttitle\n1\t"A ""B""\tC\nD"\n2\tplain "quote" inside\n';
    const want = [["id", "title"], ["1", 'A "B"\tC\nD'], ["2", 'plain "quote" inside']];
    expect(read([text])).toEqual(want);
    expect(read(text.split(""))).toEqual(want);
  });
  it("gives a blank line as an empty row", () => {
    expect(read(["a,b\n\nc,d\n"], ",")).toEqual([["a", "b"], [], ["c", "d"]]);
  });
});

describe("docRow", () => {
  const tables = (): PatentTables => ({
    grant: new Map([["9000001", { date: "2020-01-02", title: "Widget" }]]),
    grantFiling: new Map([["9000001", "2018-05-06"]]),
    pgpub: new Map([["20190123456", { title: "Gadget", published: "2019-03-04", filing: "0000-00-00" }]]),
    app: new Map([
      ["g9000001", "90000003"],
      ["p20190123456", "90000004"],
    ]),
    assignees: new Map([["9000001", [[2, "Beta Corp"], [1, "Alpha Inc"]]]]),
    inventors: new Map([["9000001", [[1, "Ann", "Example"]]]]),
  });
  const fam = new Families();
  fam.addEdge("90000001", "90000003", "con");

  it("builds a grant's row with its family and ordered names", () => {
    expect(docRow("us-9000001-b2", tables(), fam)).toEqual({
      id: "us-9000001-b2",
      title: "Widget",
      grantDate: "2020-01-02",
      filingDate: "2018-05-06",
      applicationId: "90000003",
      familyKey: "90000001",
      familySize: 2,
      assignees: ["Alpha Inc", "Beta Corp"],
      inventors: [{ first: "Ann", last: "Example" }],
    });
  });
  it("builds a pre-grant row and drops a zero date", () => {
    const d = docRow("us-2019123456-a1", tables(), fam);
    expect(d).toMatchObject({ title: "Gadget", publicationDate: "2019-03-04", filingDate: null, familyKey: "90000004", familySize: 1 });
  });
  it("marks a document the tables do not have", () => {
    expect(docRow("us-9000009-b1", tables(), fam)).toMatchObject({ id: "us-9000009-b1", noMetadata: true, assignees: [] });
    expect(docRow("us-dk-900000001-a1", tables(), fam)).toEqual({ id: "us-dk-900000001-a1" });
  });
});
