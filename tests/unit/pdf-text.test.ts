// @vitest-environment node
import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { pdfToText } from "@/lib/sources/pdf-text";

// Minimal one-page PDF whose content stream is FlateDecode-compressed — the shape
// InfoEd stores, where the text is invisible to a plain substring search.
function compressedPdf(line: string): Uint8Array {
  const content = deflateSync(Buffer.from(`BT /F1 12 Tf 72 720 Td (${line}) Tj ET`));
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let len = 0;
  const push = (b: Buffer) => { parts.push(b); len += b.length; };
  const obj = (n: number, body: Buffer) => { offsets[n] = len; push(Buffer.concat([Buffer.from(`${n} 0 obj\n`), body, Buffer.from("\nendobj\n")])); };
  push(Buffer.from("%PDF-1.4\n"));
  obj(1, Buffer.from("<</Type/Catalog/Pages 2 0 R>>"));
  obj(2, Buffer.from("<</Type/Pages/Kids[3 0 R]/Count 1>>"));
  obj(3, Buffer.from("<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>"));
  obj(4, Buffer.concat([Buffer.from(`<</Length ${content.length}/Filter/FlateDecode>>stream\n`), content, Buffer.from("\nendstream")]));
  obj(5, Buffer.from("<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>"));
  const xref = len;
  push(Buffer.from(`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<</Size 6/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(parts));
}

describe("pdfToText", () => {
  it("decodes text from a compressed content stream", async () => {
    const bytes = compressedPdf("BIOGRAPHICAL SKETCH A. Personal Statement");
    expect(Buffer.from(bytes).includes("Personal Statement")).toBe(false);
    const { pages, text } = await pdfToText(bytes);
    expect(pages).toBe(1);
    expect(text).toContain("BIOGRAPHICAL SKETCH A. Personal Statement");
  });
});
