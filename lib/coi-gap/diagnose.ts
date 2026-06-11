/**
 * COI-gap DIAGNOSTIC projection (internal tooling, not scholar-facing).
 *
 * Re-runs the matcher with `includeSuppressed` so the export sees EVERY extracted
 * entity — the surfaced High/Medium gaps AND the suppressed Low ones (matched as
 * already-disclosed, attributed to a co-author, or non-personal) — each carrying
 * the full diagnostics the persisted `coi_gap_candidate` table never keeps:
 * `nearestDisclosed` (the closest WRG disclosure we compared against), the fuzzy
 * `nearestScore`, the `tierReason`, the `failureModeGuess`, and the token-level
 * diff vs the nearest disclosure.
 *
 * The numeric score is fine here — this output is INTERNAL (an analyst file on a
 * developer machine), never the scholar-facing card, so it does not carry the
 * "no numbers / tier-only" governance constraint of the rendered surface. Its
 * purpose is the opposite: surface the numbers so we can find the predictable
 * normalization gaps (corporate suffixes beyond the current strip-list, proper-
 * noun casing, word order) and tune generation + matching from real data.
 */
import {
  analyzeStatement,
  isStructured,
  looksLikePersonName,
  normalizeEntity,
  type Scholar,
} from "./pipeline";
import { canonicalizeSponsor } from "@/lib/sponsor-canonicalize";

export type DiagnosticRow = {
  cwid: string;
  pmid: string;
  /** Raw extracted relationship, verbatim. */
  entity: string;
  normalizedEntity: string;
  tier: "High" | "Medium" | "Low";
  /** tier !== "Low" — i.e. this entity would be shown to the scholar. */
  surfaced: boolean;
  attribution: string;
  attributionReason: string;
  entityScore: number;
  category: string;
  /** Closest entity in the scholar's WRG disclosed set (the "supposed match"). */
  nearestDisclosed: string;
  normalizedNearest: string;
  /** Fuzzy score 0–1 of entity vs nearestDisclosed; ≥ threshold ⇒ suppressed. */
  nearestScore: number;
  /** Tokens in the entity that are NOT in the nearest disclosure (after the
   *  existing corp-suffix strip) — e.g. ["laboratories"] reveals a strip-list gap. */
  entityExtraTokens: string;
  /** Tokens in the nearest disclosure not in the entity. */
  nearestExtraTokens: string;
  failureModeGuess: string;
  tierReason: string;
  /** The extracted entity itself looks like a PERSON's name (e.g. a co-author),
   *  not an organization — a generation-noise signal. */
  entityIsPersonName: boolean;
  /** The SOURCE STATEMENT names ≥2 distinct authors (an ASCO blob or several
   *  "Dr X / First Last … discloses" subjects). On such a shared statement an
   *  `unattributed` surfaced entity is leakage-prone — it may be another author's
   *  relationship, not the scholar's. */
  isMultiAuthor: boolean;
  /** Distinct author subjects named in the statement (best-effort). */
  authorMentions: number;
  sourceSentence: string;
};

export type DiagnoseInput = {
  cwid: string;
  scholar: Scholar;
  disclosed: ReadonlyArray<string>;
  statements: ReadonlyArray<{ pmid: string; statementText: string }>;
  /** Override the near-disclosed threshold for a what-if pass (default: pipeline). */
  nearDisclosedThreshold?: number;
};

const toks = (s: string): Set<string> =>
  new Set(normalizeEntity(s).split(" ").filter((w) => w.length > 1));

// A disclosure-statement SUBJECT immediately followed by a disclosure verb
// ("… has received / is a consultant / discloses / serves / reports"), in either
// form: an honorific + surname ("Dr. Shah discloses") OR a first + last name
// ("Scott Kasner has received"). The captured surname is group 1 or group 2.
// Best-effort: a 3-word company in "X Y Z has provided" form can be miscounted as
// an author, so the count is an upper-ish estimate — fine for SIZING multi-author
// statements (≥2 subjects), not for production attribution.
const VERB = "(?:has|have|is\\s+a|was\\s+a|holds?|reports?|disclos\\w*|receiv\\w*|serv\\w*)";
const AUTHOR_REF = new RegExp(
  `\\b(?:(?:Drs?|Prof|Mr|Ms|Mrs)\\.?\\s+([A-Z][a-z]+(?:[-‐‑][A-Z][a-z]+)?)` +
    `|[A-Z][a-z]+\\s+([A-Z][a-z]+(?:[-‐‑][A-Z][a-z]+)?))\\s+${VERB}\\b`,
  "g",
);

/** Distinct author subjects named in a statement (best-effort). 1 ⇒ effectively
 *  single-author (the lone subject is the scholar); ≥2 ⇒ a shared/multi-author
 *  disclosure block where unattributed clauses are leakage-prone. */
export function countAuthorMentions(stmt: string): number {
  const surnames = new Set<string>();
  AUTHOR_REF.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = AUTHOR_REF.exec(stmt)) !== null) surnames.add((m[1] ?? m[2]).toLowerCase());
  return surnames.size;
}

/** Every extracted entity for a scholar (surfaced + suppressed), flattened to
 *  one diagnostic row per (pmid, entity occurrence). Pure — DB-free. */
export function diagnoseScholar(input: DiagnoseInput): DiagnosticRow[] {
  const rows: DiagnosticRow[] = [];
  for (const st of input.statements) {
    const { candidates } = analyzeStatement(st.statementText, input.scholar, input.disclosed, {
      canonicalize: canonicalizeSponsor,
      includeSuppressed: true,
      nearDisclosedThreshold: input.nearDisclosedThreshold,
    });
    // Per-statement multi-author signal (stamped on every row of the statement):
    // an ASCO blob, or ≥2 distinct named author-subjects.
    const authorMentions = countAuthorMentions(st.statementText);
    const isMultiAuthor = isStructured(st.statementText) || authorMentions >= 2;
    for (const c of candidates) {
      const normalizedNearest = c.nearestDisclosed ? normalizeEntity(c.nearestDisclosed) : "";
      const eTok = toks(c.entity);
      const nTok = c.nearestDisclosed ? toks(c.nearestDisclosed) : new Set<string>();
      const extra = [...eTok].filter((t) => !nTok.has(t));
      const missing = [...nTok].filter((t) => !eTok.has(t));
      rows.push({
        cwid: input.cwid,
        pmid: st.pmid,
        entity: c.entity,
        normalizedEntity: c.normalized,
        tier: c.tier,
        surfaced: c.tier !== "Low",
        attribution: c.attribution,
        attributionReason: c.attributionReason,
        entityScore: c.entityScore,
        category: c.category,
        nearestDisclosed: c.nearestDisclosed,
        normalizedNearest,
        nearestScore: c.nearestScore,
        entityExtraTokens: extra.join(" "),
        nearestExtraTokens: missing.join(" "),
        failureModeGuess: c.failureModeGuess,
        tierReason: c.tierReason,
        entityIsPersonName: looksLikePersonName(c.entity),
        isMultiAuthor,
        authorMentions,
        sourceSentence: c.sourceSentence,
      });
    }
  }
  return rows;
}

export type DiagnoseSummary = {
  total: number;
  surfaced: number;
  byTier: Record<string, number>;
  /** Surfaced rows bucketed by the pipeline's failure-mode guess. */
  surfacedByFailureMode: Record<string, number>;
  /** Surfaced rows whose nearest disclosure was a close-but-rejected near-miss
   *  (score in [0.3, threshold)) — the prime candidates for normalization tuning. */
  nearMiss: number;
  /** Suppressed rows by reason bucket (matched vs co-author vs non-personal). */
  suppressedByReason: Record<string, number>;
  /** The precision picture for surfaced rows — what we'd actually show a scholar. */
  surfacedBreakdown: {
    /** Attributed to the scholar by name/initials — the trustworthy core. */
    scholarAttributed: number;
    /** Unattributed clause in a MULTI-author statement — leakage-prone (may be
     *  another author's relationship). The dominant precision problem. */
    leakageRiskMultiAuthor: number;
    /** Unattributed clause in a single-author statement — the lone subject is the
     *  scholar, so probably legitimately theirs. */
    unattributedSingleAuthor: number;
    /** Surfaced entity that looks like a PERSON's name (a co-author bled through). */
    personNameSurfaced: number;
  };
};

/** Roll diagnostic rows up to a console-friendly summary. */
export function summarize(rows: ReadonlyArray<DiagnosticRow>, nearThreshold = 0.6): DiagnoseSummary {
  const byTier: Record<string, number> = {};
  const surfacedByFailureMode: Record<string, number> = {};
  const suppressedByReason: Record<string, number> = {};
  let surfaced = 0;
  let nearMiss = 0;
  const surfacedBreakdown = {
    scholarAttributed: 0,
    leakageRiskMultiAuthor: 0,
    unattributedSingleAuthor: 0,
    personNameSurfaced: 0,
  };
  for (const r of rows) {
    byTier[r.tier] = (byTier[r.tier] ?? 0) + 1;
    if (r.surfaced) {
      surfaced++;
      surfacedByFailureMode[r.failureModeGuess] = (surfacedByFailureMode[r.failureModeGuess] ?? 0) + 1;
      if (r.nearestScore >= 0.3 && r.nearestScore < nearThreshold) nearMiss++;
      if (r.entityIsPersonName) surfacedBreakdown.personNameSurfaced++;
      if (r.attribution === "scholar") surfacedBreakdown.scholarAttributed++;
      else if (r.attribution === "unattributed") {
        if (r.isMultiAuthor) surfacedBreakdown.leakageRiskMultiAuthor++;
        else surfacedBreakdown.unattributedSingleAuthor++;
      }
    } else {
      // Low: classify by the dominant reason for the bucket tally.
      const reason =
        r.attribution === "other"
          ? "co-author"
          : r.nearestScore >= nearThreshold
            ? "matched-disclosed"
            : r.category !== "personal"
              ? "non-personal"
              : "weak-signal";
      suppressedByReason[reason] = (suppressedByReason[reason] ?? 0) + 1;
    }
  }
  return {
    total: rows.length,
    surfaced,
    byTier,
    surfacedByFailureMode,
    nearMiss,
    suppressedByReason,
    surfacedBreakdown,
  };
}
