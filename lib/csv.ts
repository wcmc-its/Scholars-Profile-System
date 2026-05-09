/**
 * Minimal RFC 4180 CSV writer.
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
 */

export type CsvCell = string | number | null | undefined;

const NEEDS_QUOTING = /[",\r\n]/;

function csvEscape(value: CsvCell): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "number" ? String(value) : value;
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
