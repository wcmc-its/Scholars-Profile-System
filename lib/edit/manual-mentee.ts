/**
 * Validation for the `manualMentees` scholar field-override (#2011) — mentees no
 * source system recorded (visiting students, cross-institution trainees,
 * pre-digital alumni), entered by the mentor on `/edit`.
 *
 * Stored as a JSON array in `field_override(scholar, cwid, 'manualMentees')`,
 * NOT its own table. The #836 `selectedHighlightPmids` precedent: the list is
 * small and bounded, so a JSON blob costs no migration, no Prisma model, and —
 * critically — no `manual_edit_audit` ENUM registration, whose SQL half is
 * invisible to unit tests and 500s every write when missed. #2011 also decided
 * against a review queue, which removed the one argument for a real table
 * (per-row approval status). Do NOT add a `status` field "for later".
 *
 * `cwid` is OPTIONAL and deliberately so. When present, every downstream surface
 * lights up through code that already exists — the co-pub badge and
 * `/co-pubs/{cwid}` page resolve off `analysis_summary_author.personIdentifier`,
 * the headshot and profile link resolve off the `Scholar` row, and
 * `getMenteesForMentor`'s per-CWID collapse merges the entry into the sourced
 * chip if the mentee later lands in Jenzabar. When absent the entry still
 * renders, just as an unlinked plain-name chip with no co-pubs. Requiring it
 * would exclude exactly the population this feature exists for.
 *
 * Format is checked (`isCwid`); EXISTENCE is not. Alumni legitimately hold a
 * CWID with no local `Scholar` row — that is the common case here, not the edge
 * case — so an existence check would reject valid input. The read path degrades on its
 * own when nothing resolves.
 */
import { isCwid } from "@/lib/cwid";

/** Upper bound on the stored array. Generous — this is a runaway-payload guard,
 *  not a product limit. A mentor with more manual trainees than this has a data
 *  problem that belongs in a source system, not in a field override. */
export const MAX_MANUAL_MENTEES = 25;

/** Free-text field cap. Matches the tightest mentee-name column upstream
 *  (`aoc_mentee.first_name`/`last_name` are VarChar(255) each, so a combined
 *  128 is comfortably inside anything the chip renders). */
const MAX_TEXT = 128;

/** Earliest plausible mentorship year. Guards typos (`19` , `202`) without
 *  policing history — WCM predates this, but no mentee record does. */
const MIN_YEAR = 1950;

/**
 * Prefix for the synthetic `MenteeChip.cwid` a CWID-less manual entry gets, so
 * the read path can tell "an id I minted" from "an id a source system gave me".
 * `:` is not in `CWID_PATTERN`, so these can never collide with a real CWID.
 *
 * Test the prefix, never `isCwid`, when deciding what to exclude from a
 * co-pub/headshot lookup: source ids come from Jenzabar / ED / ReciterDB and are
 * not ours to validate, so an `isCwid` allowlist silently drops the nonconforming
 * ones.
 */
export const MANUAL_MENTEE_ID_PREFIX = "manual:";

/** Whether a `MenteeChip.cwid` is a synthetic id minted for a CWID-less manual
 *  entry (as opposed to any id a source system supplied). */
export function isManualMenteeId(cwid: string): boolean {
  return cwid.startsWith(MANUAL_MENTEE_ID_PREFIX);
}

export type ManualMentee = {
  /** WCM CWID when the mentor knows it — see the module note on why optional. */
  cwid?: string;
  /** Display name. The only required field. */
  name: string;
  /** Free-text program/role ("Visiting student", "Rotation student",
   *  "Immunology & Microbial Pathogenesis") → `MenteeChip.programName`. No
   *  controlled vocabulary: the long tail is the point. */
  programLabel?: string;
  /** Graduation / completion year → `MenteeChip.graduationYear`. */
  year?: number;
};

/**
 * #2011 — the (mentorCwid, menteeCwid) pairs a set of stored `manualMentees`
 * field-override rows contributes to the co-pub bridge export
 * (`etl/mentoring/export-copubs.ts`).
 *
 * Lives here rather than in the ETL script because that script calls `main()` at
 * import time and so cannot be unit-tested; this module is side-effect-free and
 * already shared by the read path, the route, and the export.
 *
 * Entries WITHOUT a `cwid` yield no pair — there is no identifier to join
 * `analysis_summary_author` on, so they can never have co-publications. An
 * unparseable stored value is skipped rather than thrown: one corrupt row must
 * not abort a whole-corpus export. Self-pairs are dropped, matching the
 * export's own `add()` guard.
 */
export function manualMenteePairs(
  rows: ReadonlyArray<{ entityId: string; value: string }>,
): Array<{ mentorCwid: string; menteeCwid: string }> {
  const pairs: Array<{ mentorCwid: string; menteeCwid: string }> = [];
  for (const row of rows) {
    const parsed = validateManualMentees(row.value);
    if (!parsed.ok) continue;
    for (const m of parsed.value) {
      if (!m.cwid || m.cwid === row.entityId) continue;
      pairs.push({ mentorCwid: row.entityId, menteeCwid: m.cwid });
    }
  }
  return pairs;
}

export type ManualMenteesResult =
  | { ok: true; value: ManualMentee[] }
  | {
      ok: false;
      error:
        | "invalid_value"
        | "too_many"
        | "invalid_name"
        | "invalid_cwid"
        | "invalid_year"
        | "duplicate";
    };

/**
 * Validate + normalize a `manualMentees` payload. Accepts an already-parsed
 * array (what the route hands over) or a JSON string.
 *
 * Rules, in order:
 *   - a JSON array of objects, else `invalid_value`; `[]` is valid and means
 *     "I removed them all" (equivalent to no override row);
 *   - at most {@link MAX_MANUAL_MENTEES} entries (`too_many`);
 *   - `name` a non-blank string ≤ {@link MAX_TEXT} after trim (`invalid_name`);
 *   - `cwid`, when present and non-blank, matching `isCwid` (`invalid_cwid`);
 *   - `programLabel`, when present, ≤ {@link MAX_TEXT} after trim — a blank one
 *     normalizes away rather than erroring (an empty optional input is a
 *     no-op, not a mistake);
 *   - `year`, when present, an integer in [{@link MIN_YEAR}, next calendar
 *     year] (`invalid_year`);
 *   - no two entries sharing a `cwid` (`duplicate`). Entries WITHOUT a cwid are
 *     never duplicate-checked — two trainees can genuinely share a name, and
 *     nothing downstream keys on it.
 *
 * Optional keys are omitted (not set to `undefined`) on the returned objects so
 * `JSON.stringify` produces a stable, minimal stored value.
 */
export function validateManualMentees(input: unknown): ManualMenteesResult {
  let parsed: unknown = input;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input);
    } catch {
      return { ok: false, error: "invalid_value" };
    }
  }
  if (!Array.isArray(parsed)) return { ok: false, error: "invalid_value" };
  if (parsed.length > MAX_MANUAL_MENTEES) return { ok: false, error: "too_many" };

  const maxYear = new Date().getUTCFullYear() + 1;
  const seenCwids = new Set<string>();
  const value: ManualMentee[] = [];

  for (const raw of parsed) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { ok: false, error: "invalid_value" };
    }
    const entry = raw as Record<string, unknown>;

    if (typeof entry.name !== "string") return { ok: false, error: "invalid_name" };
    const name = entry.name.trim();
    if (name === "" || name.length > MAX_TEXT) return { ok: false, error: "invalid_name" };

    const out: ManualMentee = { name };

    if (entry.cwid !== undefined && entry.cwid !== null) {
      if (typeof entry.cwid !== "string") return { ok: false, error: "invalid_cwid" };
      const cwid = entry.cwid.trim().toLowerCase();
      if (cwid !== "") {
        if (!isCwid(cwid)) return { ok: false, error: "invalid_cwid" };
        if (seenCwids.has(cwid)) return { ok: false, error: "duplicate" };
        seenCwids.add(cwid);
        out.cwid = cwid;
      }
    }

    if (entry.programLabel !== undefined && entry.programLabel !== null) {
      if (typeof entry.programLabel !== "string") return { ok: false, error: "invalid_value" };
      const programLabel = entry.programLabel.trim();
      if (programLabel.length > MAX_TEXT) return { ok: false, error: "invalid_value" };
      if (programLabel !== "") out.programLabel = programLabel;
    }

    if (entry.year !== undefined && entry.year !== null) {
      if (
        typeof entry.year !== "number" ||
        !Number.isInteger(entry.year) ||
        entry.year < MIN_YEAR ||
        entry.year > maxYear
      ) {
        return { ok: false, error: "invalid_year" };
      }
      out.year = entry.year;
    }

    value.push(out);
  }

  return { ok: true, value };
}
