/**
 * `readOverviewStream` (`lib/edit/overview-stream.ts`), the client reader for the overview generate
 * NDJSON stream (parity with `readBiosketchStream`). Forwards each `progress` line's phase to the
 * callback and returns the terminal `result` line; tolerant of blank heartbeat lines, junk
 * fragments, a trailing result line with no final newline, and chunk-split lines.
 */
import { describe, expect, it } from "vitest";

import { readOverviewStream, type OverviewProgressState } from "@/lib/edit/overview-stream";

function streamRes(lines: string[]): Response {
  return new Response(lines.join("\n") + "\n", { status: 200 });
}

/** A Response whose body delivers each string as a SEPARATE read chunk — the real TCP path where
 *  a JSON line can split across packet boundaries. */
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

describe("readOverviewStream", () => {
  it("forwards progress phases (skipping heartbeats) and returns the result line", async () => {
    const progress: OverviewProgressState[] = [];
    const res = streamRes([
      JSON.stringify({ type: "progress", phase: "drafting" }),
      "", // blank heartbeat line — ignored
      JSON.stringify({ type: "progress", phase: "faithfulness" }),
      JSON.stringify({ type: "result", ok: true, draft: "<p>D.</p>", generationId: "g1" }),
    ]);
    const result = await readOverviewStream(res, (p) => progress.push(p));
    expect(progress).toEqual([{ phase: "drafting" }, { phase: "faithfulness" }]);
    expect(result).toMatchObject({ ok: true, draft: "<p>D.</p>", generationId: "g1" });
  });

  it("returns an in-body ok:false result line (gateway failure on the 200 stream)", async () => {
    const res = streamRes([
      JSON.stringify({ type: "result", ok: false, error: "generation_failed" }),
    ]);
    expect(await readOverviewStream(res, () => {})).toMatchObject({
      ok: false,
      error: "generation_failed",
    });
  });

  it("tolerates junk lines + a trailing result line with no terminating newline", async () => {
    const seen: OverviewProgressState[] = [];
    const res = new Response(
      "not json\n" +
        JSON.stringify({ type: "progress", phase: "drafting" }) +
        "\n" +
        JSON.stringify({ type: "result", ok: true, draft: "<p>D.</p>" }),
      { status: 200 },
    );
    const result = await readOverviewStream(res, (p) => seen.push(p));
    expect(seen).toEqual([{ phase: "drafting" }]);
    expect(result).toMatchObject({ ok: true });
  });

  it("returns null when the stream ends without a result line", async () => {
    const res = streamRes([JSON.stringify({ type: "progress", phase: "drafting" })]);
    expect(await readOverviewStream(res, () => {})).toBeNull();
  });

  it("reassembles a result line split across two read chunks", async () => {
    const res = chunkedRes(['{"type":"res', 'ult","ok":true,"draft":"<p>D.</p>"}\n']);
    expect(await readOverviewStream(res, () => {})).toMatchObject({
      ok: true,
      draft: "<p>D.</p>",
    });
  });
});
