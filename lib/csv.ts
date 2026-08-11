/**
 * Minimal RFC 4180 CSV writer + reader.
 *
 * Why not ExcelJS: PM uses ExcelJS because it also emits .xlsx workbooks.
 * Scholars exports plain CSV only, and ExcelJS pulls in ~1MB of zip /
 * stream code we don't need. Twenty lines of escape-aware concatenation
 * gets us everything CSV requires (quoting commas / quotes / newlines,
 * doubling embedded quotes, CRLF row separators).
 *
 * Excel and Google Sheets both happily ingest UTF-8 CSV without a BOM
 * when the file has any non-ASCII content; we omit the BOM intentionally
 * so the file opens cleanly in `cat`, `less`, `head`, and downstream
 * pipelines that don't strip it.
 *
 * `parseCsv` (the reader half) moved here from the retired
 * `lib/cancer-center-mesh-taxonomy.ts` once its last consumer became the
 * cancer-taxonomy generator — this repo's one CSV dialect now has its
 * write and read halves in the same file instead of one hanging off an
 * unrelated module.
 */

export type CsvCell = string | number | null | undefined;

const NEEDS_QUOTING = /[",\r\n]/;

// CSV formula / DDE injection (OWASP "CSV Injection"): a spreadsheet may
// evaluate a cell that starts with one of these as a formula (`=cmd`, `+1-2`,
// `@SUM`, a leading TAB/CR). Prefix such a cell with a single quote so Excel /
// Sheets render it as literal text. Applied to STRING cells only — a value that
// is itself a plain number (e.g. "-5", "+3.2") is a number, not a formula, so
// it is left untouched (as are `number`-typed cells), which keeps legitimate
// negative numbers / signed values in existing exports intact.
const FORMULA_LEAD = /^[=+\-@\t\r]/;

function guardFormula(s: string): string {
  if (!FORMULA_LEAD.test(s)) return s;
  if (s.trim() !== "" && !Number.isNaN(Number(s))) return s; // a numeric string
  return `'${s}`;
}

function csvEscape(value: CsvCell): string {
  if (value === null || value === undefined) return "";
  // Numbers are never a formula-injection vector (a leading sign is not a
  // formula); string cells run through the formula guard first.
  const s = typeof value === "number" ? String(value) : guardFormula(value);
  if (!NEEDS_QUOTING.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Serialize a header + body to a CSV string. Headers and rows must be
 * the same width; missing cells emit as empty strings, extras are
 * silently truncated to the header width.
 */
export function toCsv(
  headers: readonly string[],
  rows: readonly (readonly CsvCell[])[],
): string {
  const out: string[] = [];
  out.push(headers.map((h) => csvEscape(h)).join(","));
  for (const row of rows) {
    const cells: string[] = [];
    for (let i = 0; i < headers.length; i++) {
      cells.push(csvEscape(row[i]));
    }
    out.push(cells.join(","));
  }
  // CRLF terminator per spec; also keeps Excel-on-Windows happy.
  return out.join("\r\n") + "\r\n";
}

export type Row = Record<string, string>;

/** Minimal RFC4180 reader: quoted fields, doubled quotes, `#` comment lines. */
export function parseCsv(text: string): Row[] {
  const lines: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); lines.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length) { row.push(field); lines.push(row); }
  const body = lines.filter((r) => r.length > 1 && !r[0].startsWith("#"));
  const header = body.shift();
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}
