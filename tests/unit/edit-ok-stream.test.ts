/**
 * #917 follow-up A — `editOkStream` (`lib/edit/request.ts`), the NDJSON streaming helper whose
 * response-body contract this follow-up reshaped. Drives it directly (the route test only exercises
 * it transitively with a synchronous producer): the progress-then-result line protocol, the
 * streaming headers, the thrown-producer in-body error line, and that the blank-line heartbeat does
 * not corrupt the parse.
 */
import { describe, expect, it } from "vitest";

import { HEARTBEAT_LINE, editOkStream } from "@/lib/edit/request";

async function lines(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("editOkStream — NDJSON contract", () => {
  it("writes progress lines then exactly one result line, with streaming headers", async () => {
    const res = editOkStream(
      async (emit) => {
        emit({ phase: "a" });
        emit({ phase: "b", done: 1, total: 2 });
        return { value: 42 };
      },
      () => ({ error: "unused" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    expect(res.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    expect(await lines(res)).toEqual([
      { type: "progress", phase: "a" },
      { type: "progress", phase: "b", done: 1, total: 2 },
      { type: "result", ok: true, value: 42 },
    ]);
  });

  it("maps a thrown producer to a single ok:false result line (status stays 200)", async () => {
    const res = editOkStream(
      async () => {
        throw new Error("boom");
      },
      (err) => ({ error: err instanceof Error ? "mapped" : "other" }),
    );
    expect(res.status).toBe(200);
    expect(await lines(res)).toEqual([{ type: "result", ok: false, error: "mapped" }]);
  });

  // #2036: a one-byte heartbeat never reached CloudFront — some hop between Fargate and the CDN
  // withheld it, so the 30s origin-read timeout fired and the viewer's HTTP/2 stream was reset.
  // Both properties matter: the line must be BIG enough to push past a proxy write buffer, and it
  // must still trim to empty so every reader skips it.
  it("pads the heartbeat past a proxy write buffer while staying a skippable blank line", () => {
    expect(HEARTBEAT_LINE.length).toBeGreaterThanOrEqual(8192);
    expect(HEARTBEAT_LINE.endsWith("\n")).toBe(true);
    expect(HEARTBEAT_LINE.trim()).toBe("");
  });

  it("interleaves blank-line heartbeats that the line parser skips", async () => {
    const res = editOkStream(
      async (emit) => {
        await new Promise((r) => setTimeout(r, 10));
        emit({ phase: "mid" });
        await new Promise((r) => setTimeout(r, 10));
        return { done2: true };
      },
      () => ({ error: "unused" }),
      { heartbeatMs: 1 },
    );
    const text = await res.text();
    // The raw body carries padded blank heartbeat lines during the awaits...
    expect(text).toContain(HEARTBEAT_LINE);
    // ...but parsing the non-blank lines yields exactly the progress event + the result.
    const msgs = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(msgs.filter((m) => m.type === "progress")).toEqual([{ type: "progress", phase: "mid" }]);
    expect(msgs.at(-1)).toMatchObject({ type: "result", ok: true, done2: true });
  });
});
