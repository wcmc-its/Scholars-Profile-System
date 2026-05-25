/**
 * Leadership-title predicates shared across layers.
 *
 * `isChairTitleFor` is the single source of truth for "does this appointment
 * title make its holder the chair of {dept}". The ETL uses it to populate
 * `Department.chairCwid` (etl/ed/index.ts via etl/ed/chief-detection.ts), and
 * the self-edit suppression guard reuses it to refuse hiding the appointment
 * that confers a current chair role (lib/edit/validators.ts, #160 D-leader).
 * Kept in `lib/` (not `etl/`) so the app layer can import it without crossing
 * into the ETL tree.
 */

/**
 * Standalone-phrase match for "Chair of {dept name}". Catches direct, prefix,
 * suffix, endowed ("Sanford I. Weill Chair of Medicine"), and acting ("Acting
 * Chair of Cell and Developmental Biology") forms. Excludes
 * vice/associate/deputy/assistant chairs.
 */
export function isChairTitleFor(title: string, deptName: string): boolean {
  if (/Vice[- ]Chair|Associate Chair|Deputy Chair|Assistant Chair/i.test(title)) {
    return false;
  }
  const target = `Chair of ${deptName}`;
  if (title === target) return true;
  if (title.startsWith(`${target} `) || title.startsWith(`${target},`)) return true;
  if (title.endsWith(` ${target}`)) return true;
  if (title.includes(` ${target} `) || title.includes(` ${target},`)) return true;
  return false;
}
