/**
 * Small, dependency-free HTML helpers for the honors-list scrapers.
 *
 * The rosters are server-rendered tables and lists, so a handful of regexes over
 * the markup is enough, the same call `etl/news/scrape.ts` made. A parser that
 * finds nothing returns [] rather than throwing; the list module decides whether
 * an empty roster is an error (it always is: every list has entries).
 */

export type Fetcher = (url: string) => Promise<string>;

/** Thrown for a non-2xx response, so the run record names the status and URL. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`HTTP ${status} on ${url}`);
  }
}

/**
 * GET with retries for transient failures (network errors and 5xx). A 4xx is
 * final: a 403 is a bot block and a 404 a moved page, and neither improves on
 * retry. Throws `HttpError` or the last network error.
 */
export const defaultFetch: Fetcher = async (url) => {
  let last: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": "WCM-Scholars-ETL/1.0 (honors lists)" },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) return await res.text();
      last = new HttpError(res.status, url);
      if (res.status < 500) throw last;
    } catch (err) {
      if (err instanceof HttpError && err.status < 500) throw err;
      last = err;
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
  throw last instanceof Error ? last : new Error(`fetch failed: ${url}`);
};

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  ndash: "–",
  mdash: "—",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
    }
    return NAMED[body.toLowerCase()] ?? m;
  });
}

/** Tag-free, entity-decoded, whitespace-collapsed text. Drops hidden spans and SVG. */
export function textOf(html: string): string {
  return decodeEntities(
    html
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<span[^>]*display:\s*none[^>]*>[\s\S]*?<\/span>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Inner HTML of every `<tr>` in `html`. */
export function tableRows(html: string): string[] {
  return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]);
}

/** Every `<td>` of one row: its attributes and inner HTML. */
export function tableCells(rowHtml: string): Array<{ attrs: string; html: string }> {
  return [...rowHtml.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)].map((m) => ({
    attrs: m[1],
    html: m[2],
  }));
}

/** A four-digit year in a plausible range, else null. */
export function parseYear(s: string | null | undefined): number | null {
  const m = /\b(1[89]\d\d|20\d\d)\b/.exec(s ?? "");
  return m ? Number(m[1]) : null;
}
