/**
 * Client-side reader for the biosketch generate NDJSON stream (#917 follow-up A).
 *
 * The generate route (`editOkStream`) writes one `{"type":"progress",...}` line per phase boundary
 * as it advances, then a final `{"type":"result","ok":true|false,...}` line. This reads the body
 * incrementally, forwards each progress event to `onProgress` (driving the UI bar), and returns the
 * parsed result line — or `null` if the stream ended without one. Tolerant: blank heartbeat lines
 * and any unparseable fragment are skipped. No server deps (runs in the browser bundle).
 */

/** A phase-boundary progress event, coerced from the stream's `progress` lines. */
export type BiosketchProgressState = { phase: string; done: number; total: number };

/** The terminal result line, narrowed only on `ok`; the caller coerces the payload fields. */
export type BiosketchStreamResult =
  | ({ ok: true } & Record<string, unknown>)
  | { ok: false; error: string };

function parseLine(line: string): { type?: string; [k: string]: unknown } | null {
  try {
    const m = JSON.parse(line) as { type?: string; [k: string]: unknown };
    return m && typeof m === "object" ? m : null;
  } catch {
    return null;
  }
}

/** The last `result` line in a buffer (fallback for a non-streaming body / trailing bytes). */
function lastResultLine(text: string): BiosketchStreamResult | null {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const msg = parseLine(lines[i]);
    if (msg && msg.type === "result") return msg as BiosketchStreamResult;
  }
  return null;
}

export async function readBiosketchStream(
  res: Response,
  onProgress: (p: BiosketchProgressState) => void,
): Promise<BiosketchStreamResult | null> {
  const body = res.body;
  if (!body) {
    // No streaming reader (very old runtime) — best-effort: parse the whole buffered body.
    const text = await res.text().catch(() => "");
    return lastResultLine(text);
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let result: BiosketchStreamResult | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
      if (line.length === 0) continue; // blank heartbeat line
      const msg = parseLine(line);
      if (!msg) continue;
      if (msg.type === "progress") {
        onProgress({
          phase: typeof msg.phase === "string" ? msg.phase : "",
          done: typeof msg.done === "number" ? msg.done : 0,
          total: typeof msg.total === "number" ? msg.total : 0,
        });
      } else if (msg.type === "result") {
        result = msg as BiosketchStreamResult;
      }
    }
    if (done) break;
  }
  // A trailing result line with no terminating newline.
  if (!result && buf.trim().length > 0) result = lastResultLine(buf);
  return result;
}
