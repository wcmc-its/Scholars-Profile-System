/**
 * Bill & Melinda Gates Foundation grants fetcher (issue #92).
 *
 * Source: the public CSV the foundation publishes from its
 * "Committed Grants" page. Single GET, ~16-20MB, refreshed every few
 * weeks per the file's `Updated <date>` first row.
 *
 * The CSV uses RFC 4180 quoting:
 *   - Fields enclosed in double quotes when they contain commas, quotes,
 *     or newlines.
 *   - Embedded `"` doubled to `""`.
 *   - First non-blank, non-prologue line is the header row.
 *
 * Schema as of 2026-05:
 *   GRANT ID, GRANTEE, PURPOSE, DIVISION, DATE COMMITTED,
 *   DURATION (MONTHS), AMOUNT COMMITTED, GRANTEE WEBSITE,
 *   GRANTEE CITY, GRANTEE STATE, GRANTEE COUNTRY, REGION SERVED, TOPIC
 *
 * `PURPOSE` is the 1–2 sentence description that the issue's UX
 * surfaces as the abstract. It's not always present; rows with empty
 * PURPOSE are dropped at parse time.
 */

const GATES_CSV_URL =
  "https://www.gatesfoundation.org/-/media/files/bmgf-grants.csv";

export type GatesGrantRow = {
  grantId: string;
  grantee: string;
  purpose: string;
  division: string | null;
};

/** Minimal RFC 4180 parser. Returns one record per line as a flat array
 *  of fields. Skips empty lines. The Gates CSV contains a single
 *  prologue line ("Updated <date>") before the header — the caller
 *  decides what to do with the first row. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  // Strip BOM if present.
  if (text.charCodeAt(0) === 0xfeff) i = 1;

  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      cur.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r") {
      // Skip CR; the LF case below handles row termination.
      i++;
      continue;
    }
    if (c === "\n") {
      cur.push(field);
      field = "";
      // Drop blank lines.
      if (!(cur.length === 1 && cur[0] === "")) rows.push(cur);
      cur = [];
      i++;
      continue;
    }
    field += c;
    i++;
  }
  // Flush trailing record (no terminating newline).
  if (field !== "" || cur.length > 0) {
    cur.push(field);
    if (!(cur.length === 1 && cur[0] === "")) rows.push(cur);
  }
  return rows;
}

/** Locate column indices in the CSV header. Throws when the schema
 *  drifts (column rename / removal) so an unattended ETL run loud-fails
 *  instead of silently writing nulls. */
function indexHeaderRow(header: string[]): {
  grantId: number;
  grantee: number;
  purpose: number;
  division: number;
} {
  const map = new Map(header.map((h, i) => [h.trim().toUpperCase(), i]));
  const get = (name: string): number => {
    const i = map.get(name);
    if (typeof i !== "number") {
      throw new Error(`Gates CSV header missing column: ${name}. Got: ${header.join("|")}`);
    }
    return i;
  };
  return {
    grantId: get("GRANT ID"),
    grantee: get("GRANTEE"),
    purpose: get("PURPOSE"),
    division: get("DIVISION"),
  };
}

/**
 * Fetch + parse the Gates grants CSV. Returns one row per published
 * grant with a non-empty PURPOSE. Rows without a purpose are dropped
 * because there's nothing to surface as an abstract.
 */
export async function fetchGatesGrants(): Promise<GatesGrantRow[]> {
  const resp = await fetch(GATES_CSV_URL, {
    headers: {
      Accept: "text/csv",
      // Identify the bot per general scraping hygiene; Gates serves the
      // CSV anonymously so this is a courtesy, not auth.
      "User-Agent": "ScholarsProfileBot/1.0 (+https://scholars.weill.cornell.edu)",
    },
    cache: "no-store",
    redirect: "follow",
  });
  if (!resp.ok) {
    throw new Error(`Gates CSV fetch failed: HTTP ${resp.status}`);
  }
  const text = await resp.text();
  const rows = parseCsv(text);

  // Header detection: the first line is a prologue ("Updated <date>"),
  // the next is the header. Be defensive about either ordering.
  let headerIdx = 0;
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    if (rows[i].length > 5 && /grant\s*id/i.test(rows[i][0])) {
      headerIdx = i;
      break;
    }
  }
  const header = rows[headerIdx];
  if (!header) throw new Error("Gates CSV: no header row found");
  const idx = indexHeaderRow(header);

  const out: GatesGrantRow[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length <= idx.purpose) continue;
    const grantId = (row[idx.grantId] ?? "").trim();
    const purpose = (row[idx.purpose] ?? "").trim();
    if (!grantId || !purpose) continue;
    out.push({
      grantId,
      grantee: (row[idx.grantee] ?? "").trim(),
      purpose,
      division: (row[idx.division] ?? "").trim() || null,
    });
  }
  return out;
}
