/**
 * Pure helpers for the comms_steward display-name bridge
 * (comms-steward-profile-editing-spec.md §5). Kept free of LDAP/S3/DB so they
 * can be unit-tested directly; the export (`export-steward-names.ts`) and import
 * (`import-steward-names.ts`) scripts share them.
 */

/** One bridge row: a CWID and its ED display name. */
export type StewardNameRow = { cwid: string; displayName: string };

/**
 * Build a display name from the LDAP first/last components. Returns "" when
 * neither is usable, so the export can skip a CWID rather than write a blank.
 */
export function buildStewardDisplayName(name: {
  firstName: string | null;
  lastName: string | null;
}): string {
  return [name.firstName, name.lastName]
    .filter((p): p is string => !!p && p.trim() !== "")
    .join(" ")
    .trim();
}

/**
 * Parse the bridge NDJSON → validated rows (last value wins per CWID, lower-
 * cased to match `_ci` collation) + a skipped-line count. A line that is blank,
 * unparseable, or missing cwid/displayName is skipped + counted — never a blank
 * name over good data.
 */
export function parseStewardNameRows(text: string): { rows: StewardNameRow[]; skipped: number } {
  const byCwid = new Map<string, string>();
  let skipped = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const o = JSON.parse(trimmed) as Partial<StewardNameRow>;
      const cwid = o.cwid != null ? String(o.cwid).trim().toLowerCase() : "";
      const displayName = o.displayName != null ? String(o.displayName).trim() : "";
      if (cwid === "" || displayName === "") {
        skipped++;
        continue;
      }
      byCwid.set(cwid, displayName);
    } catch {
      skipped++;
    }
  }
  return {
    rows: Array.from(byCwid, ([cwid, displayName]) => ({ cwid, displayName })),
    skipped,
  };
}
