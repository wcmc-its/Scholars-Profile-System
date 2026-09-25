/**
 * Who can open a report, as words — the ONE string source for the report
 * header's access badge (`components/edit/report-access-popover.tsx`) and the
 * reports index row's meta line (`app/edit/reports/page.tsx` →
 * `components/edit/reports-index.tsx`), so the two never disagree.
 *
 * Plain data in its own module, not in the "use client" popover: the index
 * page is a server component and computes each row's text here, so the grant
 * rows behind a "+ N others" count never cross into the client payload (a
 * function exported from a "use client" module can't be called on the
 * server). The popover re-exports everything below.
 */

/** The badge's default-audience labels. */
export const UNIT_AUDIENCE = "Unit owners and curators";
export const ADMIN_AUDIENCE = "All unit administrators";
export const PERSON_AUDIENCE = "Superusers and comms stewards";
export const UNIT_RULE =
  "Owners and Curators of the unit this report is opened for can run it, plus superusers and comms stewards.";
export const ADMIN_RULE =
  "Every unit administrator — an Owner or Curator of any unit — can run it, plus superusers and comms stewards.";
/** The badge list's line under the default audience for a person-gated report
 *  with no note of its own: the audience name is the row's title already. */
export const PERSON_RULE_SHORT = "Always have access.";

/** The fields of the popover's props that the summary reads. */
export type AccessSummaryInput<R> =
  | { mode: "unit" }
  | { mode: "admin" }
  | { mode: "person"; audience?: string; note?: string; initialRows: ReadonlyArray<R> };

/** The default audience, its one-line rule, the per-person grant rows, and
 *  "+ N others" for those rows (null when there are none). `text` is the
 *  one-line form: "All unit administrators + 2 others". */
export function accessSummary<R>(props: AccessSummaryInput<R>): {
  audience: string;
  rule: string;
  rows: ReadonlyArray<R>;
  others: number;
  othersLabel: string | null;
  text: string;
} {
  const [audience, rule, rows]: [string, string, ReadonlyArray<R>] =
    props.mode === "person"
      ? [props.audience ?? PERSON_AUDIENCE, props.note ?? PERSON_RULE_SHORT, props.initialRows]
      : props.mode === "admin"
        ? [ADMIN_AUDIENCE, ADMIN_RULE, []]
        : [UNIT_AUDIENCE, UNIT_RULE, []];
  const others = rows.length;
  const othersLabel = others > 0 ? `+ ${others} other${others === 1 ? "" : "s"}` : null;
  return { audience, rule, rows, others, othersLabel, text: othersLabel ? `${audience} ${othersLabel}` : audience };
}
