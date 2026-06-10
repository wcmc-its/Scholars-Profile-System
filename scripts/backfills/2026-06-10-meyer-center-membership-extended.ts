/**
 * #552 Phase 5 — Meyer Cancer Center membership type+program backfill (one-shot).
 *
 * The #552 schema extension added `membershipType` / `programCode` / `startDate`
 * / `endDate` to `CenterMembership`, but legacy Meyer rows (loaded by #540 as a
 * bare `(centerCode, cwid, source)` roster) carry none of them. The Meyer Cancer
 * Center is the one center whose source export classifies each member with a
 * `membershipType` (`RESEARCH` / `CLINICAL`) and a `program` code
 * (`CB` / `CGE` / `CPC` / `CT` / `ZY`) — see `center-management-spec.md` § 1 + § 7.
 * This script reads that export and back-fills the two classification columns
 * (plus an optional `startDate`) onto the existing membership rows, UPSERTing
 * keyed on `(centerCode='meyer_cancer_center', cwid)`.
 *
 * SOURCE FILE — `data/center-members/meyer-cancer-center.txt` (operator-supplied;
 * obtain from Andria — `center-management-spec.md` Open Question 6). One member
 * per line; blank lines and `#` comments ignored. Each line is whitespace- or
 * comma-separated and tolerant of the export's `"Meyer Cancer Center: CT"`
 * program formatting:
 *
 *     cwid                         (cwid only — no classification; row left as-is)
 *     cwid  RESEARCH  CT           (type + program)
 *     cwid  CLINICAL  ZY  2024-07-01   (type + program + startDate)
 *     cwid, RESEARCH, CT           (comma-separated — same fields)
 *     cwid  type:program           (compact "type:program" form)
 *     cwid  Meyer Cancer Center: CT   (the raw export "program" field — type omitted)
 *
 * Type tokens are case-insensitive (`RESEARCH` → `research`). Program codes are
 * validated against the canonical Meyer set; an unknown code, an out-of-range
 * date, or a malformed line is COUNTED and SKIPPED (never guessed) — the operator
 * reconciles the skip list against the export.
 *
 * IDEMPOTENT: every write is an UPSERT that sets the parsed classification
 * columns to a fixed value derived from the file, so a repeat run reproduces the
 * same state (no drift). Re-running after the operator corrects a skipped line
 * only touches that row. WHERE-guarded by the membership composite key.
 *
 * Flags (see scripts/backfills/README.md):
 *   --dry-run            report the parse + the writes it WOULD make; write nothing.
 *   --limit=<n>          cap the number of membership rows written (sampling).
 *   --file=<path>        override the source-file path (default the path above).
 *
 * Run: npx tsx scripts/backfills/2026-06-10-meyer-center-membership-extended.ts \
 *        [--dry-run] [--limit=N] [--file=path]
 *
 * This is a launch one-shot. It is checked in for the audit trail and is not a
 * recurring job.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The center this backfill targets — the Center.code @id (NOT the slug). */
export const MEYER_CENTER_CODE = "meyer_cancer_center";

/** Default source-file path, relative to the repo root. */
export const DEFAULT_SOURCE_FILE = "data/center-members/meyer-cancer-center.txt";

/**
 * The canonical Meyer program taxonomy (`center-management-spec.md` § 7 step 3;
 * mirrored in `prisma/seed-centers.ts`). A `programCode` not in this set is a
 * skip, not a guess. Kept inline so the script has no cross-module coupling to
 * the (non-exported) seed constant.
 */
export const MEYER_PROGRAM_CODES = ["CB", "CGE", "CPC", "CT", "ZY"] as const;
export type MeyerProgramCode = (typeof MEYER_PROGRAM_CODES)[number];

export type MembershipType = "research" | "clinical";

/** The narrow Prisma surface this backfill touches — declared structurally so
 *  the unit tests can supply a mock without a live DB. */
export type MeyerBackfillDb = {
  centerMembership: {
    findUnique(args: {
      where: { centerCode_cwid: { centerCode: string; cwid: string } };
      select: Record<string, boolean>;
    }): Promise<{ cwid: string } | null>;
    upsert(args: unknown): Promise<unknown>;
  };
};

export type MeyerBackfillOptions = {
  dryRun: boolean;
  limit: number | null;
  file: string;
};

/** One successfully-parsed member from the source export. */
export type ParsedMember = {
  cwid: string;
  membershipType: MembershipType | null;
  programCode: MeyerProgramCode | null;
  startDate: string | null;
};

/** A line that could not be parsed cleanly — reported, never written. */
export type SkippedLine = {
  lineNumber: number;
  raw: string;
  reason: string;
};

export type ParseResult = {
  members: ParsedMember[];
  skipped: SkippedLine[];
};

export type MeyerBackfillResult = {
  parsed: number;
  skipped: number;
  matched: number;
  unmatched: number;
  written: number;
};

const log = (msg: string) => console.log(msg);

const CWID_PATTERN = /^[a-z]{3}[0-9]{4}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function parseArgs(argv: string[]): MeyerBackfillOptions {
  const dryRun = argv.includes("--dry-run");

  const limitArg = argv.find((a) => a.startsWith("--limit="));
  let limit: number | null = null;
  if (limitArg) {
    const n = Number.parseInt(limitArg.slice("--limit=".length), 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`--limit must be a positive integer, got "${limitArg}"`);
    }
    limit = n;
  }

  const fileArg = argv.find((a) => a.startsWith("--file="));
  const file = fileArg ? fileArg.slice("--file=".length) : DEFAULT_SOURCE_FILE;

  return { dryRun, limit, file };
}

/** Normalize a type token (case-insensitive) → the schema enum, or null. */
export function normalizeType(token: string): MembershipType | null {
  const t = token.trim().toLowerCase();
  if (t === "research") return "research";
  if (t === "clinical") return "clinical";
  return null;
}

/** Recognize a Meyer program code (uppercased), else null. */
export function normalizeProgram(token: string): MeyerProgramCode | null {
  const t = token.trim().toUpperCase();
  return (MEYER_PROGRAM_CODES as readonly string[]).includes(t) ? (t as MeyerProgramCode) : null;
}

/**
 * Parse one source line into a member, or describe why it was skipped.
 *
 * Tolerant of the export's `"Meyer Cancer Center: CT"` program field, the
 * compact `type:program` form, and plain whitespace/comma-separated tokens. The
 * first token is always the cwid; remaining tokens are classified by shape (a
 * type word, a program code, an ISO date) rather than by position, so column
 * order in the export does not matter.
 */
export function parseLine(raw: string, lineNumber: number): ParsedMember | SkippedLine | null {
  // Strip a trailing comment and surrounding whitespace.
  const noComment = raw.replace(/#.*$/, "");
  const trimmed = noComment.trim();
  if (trimmed.length === 0) return null; // blank / comment-only — silently ignored.

  // Drop the export's "Meyer Cancer Center:" prefix wherever it appears, leaving
  // the bare program code (and any other tokens) behind.
  const cleaned = trimmed.replace(/Meyer Cancer Center\s*:/gi, " ");

  // Split on commas OR whitespace; expand a compact "type:program" token.
  const tokens = cleaned
    .split(/[\s,]+/)
    .flatMap((t) => (t.includes(":") ? t.split(":") : [t]))
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  if (tokens.length === 0) return null;

  const cwid = tokens[0].toLowerCase();
  if (!CWID_PATTERN.test(cwid)) {
    return { lineNumber, raw: trimmed, reason: `first token "${tokens[0]}" is not a CWID` };
  }

  let membershipType: MembershipType | null = null;
  let programCode: MeyerProgramCode | null = null;
  let startDate: string | null = null;
  const unrecognized: string[] = [];

  for (const tok of tokens.slice(1)) {
    const asType = normalizeType(tok);
    if (asType) {
      if (membershipType && membershipType !== asType) {
        return {
          lineNumber,
          raw: trimmed,
          reason: `conflicting types ("${membershipType}" vs "${asType}")`,
        };
      }
      membershipType = asType;
      continue;
    }
    const asProgram = normalizeProgram(tok);
    if (asProgram) {
      if (programCode && programCode !== asProgram) {
        return {
          lineNumber,
          raw: trimmed,
          reason: `conflicting programs ("${programCode}" vs "${asProgram}")`,
        };
      }
      programCode = asProgram;
      continue;
    }
    if (DATE_PATTERN.test(tok)) {
      const d = new Date(`${tok}T00:00:00Z`);
      if (Number.isNaN(d.getTime())) {
        return { lineNumber, raw: trimmed, reason: `invalid date "${tok}"` };
      }
      startDate = tok;
      continue;
    }
    unrecognized.push(tok);
  }

  if (unrecognized.length > 0) {
    return {
      lineNumber,
      raw: trimmed,
      reason: `unrecognized token(s): ${unrecognized.join(", ")} (not a type, Meyer program code, or YYYY-MM-DD date)`,
    };
  }

  return { cwid, membershipType, programCode, startDate };
}

/** Discriminator — a parse result that is a skip, not a member. */
function isSkip(v: ParsedMember | SkippedLine): v is SkippedLine {
  return "reason" in v;
}

/** Parse the whole source file into members + skips. Duplicate cwids: last wins
 *  (a corrected later line supersedes), which keeps the run idempotent. */
export function parseSource(text: string): ParseResult {
  const members = new Map<string, ParsedMember>();
  const skipped: SkippedLine[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const result = parseLine(lines[i], i + 1);
    if (result === null) continue;
    if (isSkip(result)) {
      skipped.push(result);
    } else {
      members.set(result.cwid, result);
    }
  }
  return { members: [...members.values()], skipped };
}

/**
 * Apply the parsed members to `CenterMembership`, UPSERTing the classification
 * columns keyed on `(MEYER_CENTER_CODE, cwid)`.
 *
 *   - A member already on the roster → UPDATE the three classification columns
 *     (matched).
 *   - A member NOT yet on the roster → the export carries someone the #540 roster
 *     doesn't (unmatched). The upsert's `create` adds the row with
 *     `source='manual'`, so the export is the source of truth for the launch
 *     backfill — but a member with NO classification at all is left untouched
 *     (nothing to back-fill), so a cwid-only line never silently creates a row.
 *
 * `--dry-run` prints the intended writes and changes nothing. `--limit` caps the
 * number of rows written (sampling), counting matched/unmatched before the cap.
 */
export async function applyBackfill(
  db: MeyerBackfillDb,
  members: ReadonlyArray<ParsedMember>,
  opts: MeyerBackfillOptions,
): Promise<{ matched: number; unmatched: number; written: number }> {
  let matched = 0;
  let unmatched = 0;
  let written = 0;

  for (const m of members) {
    const existing = await db.centerMembership.findUnique({
      where: { centerCode_cwid: { centerCode: MEYER_CENTER_CODE, cwid: m.cwid } },
      select: { cwid: true },
    });
    if (existing) matched += 1;
    else unmatched += 1;

    // A line with no classification (cwid only) for a cwid not on the roster has
    // nothing to back-fill — skip it rather than create a bare row.
    const hasClassification =
      m.membershipType !== null || m.programCode !== null || m.startDate !== null;
    if (!existing && !hasClassification) {
      log(`  skip ${m.cwid}: not on roster and no classification to apply.`);
      continue;
    }

    if (opts.limit != null && written >= opts.limit) {
      log(`  [limit=${opts.limit}] reached — stopping writes (remaining rows not applied).`);
      break;
    }

    const data = {
      membershipType: m.membershipType,
      programCode: m.programCode,
      startDate: m.startDate ? new Date(`${m.startDate}T00:00:00Z`) : null,
    };

    if (opts.dryRun) {
      log(
        `  [dry-run] ${existing ? "update" : "create"} ${m.cwid}: ` +
          `type=${m.membershipType ?? "—"} program=${m.programCode ?? "—"} start=${m.startDate ?? "—"}`,
      );
      written += 1;
      continue;
    }

    await db.centerMembership.upsert({
      where: { centerCode_cwid: { centerCode: MEYER_CENTER_CODE, cwid: m.cwid } },
      create: { centerCode: MEYER_CENTER_CODE, cwid: m.cwid, source: "manual", ...data },
      update: data,
    });
    written += 1;
    log(`  ${existing ? "updated" : "created"} ${m.cwid}.`);
  }

  return { matched, unmatched, written };
}

const main = async () => {
  const opts = parseArgs(process.argv.slice(2));
  log(
    `#552 Phase 5 Meyer membership backfill${opts.dryRun ? " [DRY RUN — no writes]" : ""}` +
      `${opts.limit != null ? ` [limit=${opts.limit}]` : ""}\n  source: ${opts.file}`,
  );

  const absPath = path.isAbsolute(opts.file) ? opts.file : path.resolve(process.cwd(), opts.file);
  const text = readFileSync(absPath, "utf8");
  const { members, skipped } = parseSource(text);

  log(`Parsed ${members.length} member(s); ${skipped.length} line(s) skipped.`);
  for (const s of skipped) {
    log(`  SKIP line ${s.lineNumber}: ${s.reason} — "${s.raw}"`);
  }

  // Imported lazily so the structural MeyerBackfillDb type stays the contract and
  // the unit tests never load the real client.
  const { db } = await import("../../lib/db");
  const { matched, unmatched, written } = await applyBackfill(
    db.write as unknown as MeyerBackfillDb,
    members,
    opts,
  );

  const result: MeyerBackfillResult = {
    parsed: members.length,
    skipped: skipped.length,
    matched,
    unmatched,
    written,
  };
  log(
    `\nDone${opts.dryRun ? " (dry run)" : ""}. ` +
      `parsed=${result.parsed}, skipped=${result.skipped}, ` +
      `matched=${result.matched}, unmatched=${result.unmatched}, written=${result.written}.`,
  );

  await db.write.$disconnect();
};

// Run only when invoked directly (not when imported by the unit test).
const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
