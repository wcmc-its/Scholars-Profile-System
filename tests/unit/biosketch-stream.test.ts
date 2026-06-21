/**
 * #917 follow-up A — `readBiosketchStream` (`lib/edit/biosketch-stream.ts`), the client reader for
 * the biosketch generate NDJSON stream. Forwards each `progress` line to the callback and returns
 * the terminal `result` line; tolerant of blank heartbeat lines, junk fragments, and a trailing
 * result line with no final newline.
 */
import { describe, expect, it } from "vitest";

import { readBiosketchStream, type BiosketchProgressState } from "@/lib/edit/biosketch-stream";

function streamRes(lines: string[]): Response {
  return new Response(lines.join("\n") + "\n", { status: 200 });
}

/** A Response whose body delivers each string as a SEPARATE read chunk — the real TCP path where
 *  a JSON line can split across packet boundaries (a single-string Response yields one chunk). */
function chunkedRes(chunks: string[]): Response {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch));
        c.close();
      },
    }),
    { status: 200 },
  );
}

describe("readBiosketchStream", () => {
  it("forwards progress events (skipping heartbeats) and returns the result line", async () => {
    const progress: BiosketchProgressState[] = [];
    const res = streamRes([
      JSON.stringify({ type: "progress", phase: "drafting" }),
      "", // blank heartbeat line — ignored
      JSON.stringify({ type: "progress", phase: "faithfulness", done: 1, total: 2 }),
      JSON.stringify({ type: "result", ok: true, mode: "contributions", entries: [] }),
    ]);
    const result = await readBiosketchStream(res, (p) => progress.push(p));
    expect(progress).toEqual([
      { phase: "drafting", done: 0, total: 0 },
      { phase: "faithfulness", done: 1, total: 2 },
    ]);
    expect(result).toMatchObject({ ok: true, mode: "contributions" });
  });

  it("returns an in-body ok:false result line (gateway failure on the 200 stream)", async () => {
    const res = streamRes([
      JSON.stringify({ type: "result", ok: false, error: "generation_failed" }),
    ]);
    expect(await readBiosketchStream(res, () => {})).toMatchObject({
      ok: false,
      error: "generation_failed",
    });
  });

  it("tolerates junk lines + a trailing result line with no terminating newline", async () => {
    const seen: BiosketchProgressState[] = [];
    const res = new Response(
      "not json\n" +
        JSON.stringify({ type: "progress", phase: "products" }) +
        "\n" +
        JSON.stringify({ type: "result", ok: true, entries: [] }),
      { status: 200 },
    );
    const result = await readBiosketchStream(res, (p) => seen.push(p));
    expect(seen).toEqual([{ phase: "products", done: 0, total: 0 }]);
    expect(result).toMatchObject({ ok: true });
  });

  it("returns null when the stream ends without a result line", async () => {
    const res = streamRes([JSON.stringify({ type: "progress", phase: "drafting" })]);
    expect(await readBiosketchStream(res, () => {})).toBeNull();
  });

  it("reassembles a result line split across two read chunks", async () => {
    const res = chunkedRes(['{"type":"res', 'ult","ok":true,"mode":"contributions"}\n']);
    expect(await readBiosketchStream(res, () => {})).toMatchObject({
      ok: true,
      mode: "contributions",
    });
  });

  it("reassembles a progress line split mid-object across chunks, then the result", async () => {
    const seen: BiosketchProgressState[] = [];
    const res = chunkedRes([
      '{"type":"progress","ph',
      'ase":"faithfulness","done":2,"total":3}\n{"type":"result","ok":true,"entries":[]}\n',
    ]);
    const result = await readBiosketchStream(res, (p) => seen.push(p));
    expect(seen).toEqual([{ phase: "faithfulness", done: 2, total: 3 }]);
    expect(result).toMatchObject({ ok: true });
  });
});
