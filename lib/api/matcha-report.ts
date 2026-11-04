/**
 * Matcha Phase 4: the printable scouting report (`/edit/matcha/report`), v2 coverage layout.
 *
 * Server-only. Everything here is read from the SAVED search, the paste's `MatchaBrief` rows and
 * live records; the client names a submission and PIs, nothing else. A cwid absent from the stored
 * result is ignored (the brief POST refuses it; a read-only page just drops it), and at most
 * `MATCHA_REPORT_CAP` PIs are rendered.
 *
 * External-safe by construction: this module never SELECTS what the report must not show — no
 * brief note, no researcher email, no score or ask weight, no researcher-type label, no InfoEd
 * routing field, no award amount, no `removedCount`, and not the raw paste. The view can only
 * render what this returns. Contribution ranks reach the view only as coverage marks.
 */
import { db } from "@/lib/db";
import type { EditSession } from "@/lib/auth/superuser";
import {
  loadBriefRecords,
  loadStoredResult,
  matchaSubmissionScope,
  withLiveSources,
  type BriefEdited,
  type BriefGenerated,
  type BriefRecords,
  type BriefTopic,
} from "@/lib/api/matcha-brief";
import { fitTier, type MatchaCandidate, type MatchaFitTier } from "@/lib/api/matcha-contract";
import { loadReportThemes } from "@/lib/api/matcha-report-themes";
import { briefTopics, briefWhy, firstSentence } from "@/lib/edit/matcha-brief-types";
import {
  computeCoverage,
  signalChips,
  type Coverage,
  type ReportTheme,
} from "@/lib/edit/matcha-report-coverage";
import { headshotUrl } from "@/lib/headshot";
import { profilePath } from "@/lib/profile-url";
import { siteBaseUrl } from "@/lib/site-url";
import { fetchDirectoryPeopleByCwid } from "@/lib/sources/ldap";
import { SCHOLAR_EXPORT_CAP } from "@/lib/api/export-scholars";

/** The report's selection cap: the same policy cap as every other scholar list leaving SPS. */
export const MATCHA_REPORT_CAP = SCHOLAR_EXPORT_CAP;
/** Key papers per PI. */
export const REPORT_MAX_PAPERS = 3;
/** The officer's directory lookup must never hold the page for long. */
const OFFICER_LOOKUP_TIMEOUT_MS = 3_000;
/** Parallel key-paper reads for PIs whose brief cites too few papers. */
const PAPER_READ_CONCURRENCY = 4;

export type ReportPaper = { pmid: string; title: string; year: number | null };

export type ReportPi = {
  cwid: string;
  rank: number;
  /** Display name, with postnominals. */
  name: string;
  /** Preferred name without postnominals: initials, the gaps prose. */
  shortName: string;
  /** Directory headshot URL; "" when the scholar is known to have none (initials only). */
  photoUrl: string;
  title: string | null;
  department: string | null;
  profileUrl: string;
  secondaryAppointments: BriefRecords["secondaryAppointments"];
  centers: string[];
  funding: BriefRecords["funding"];
  translation: BriefRecords["translation"];
  fit: MatchaFitTier;
  /** Up to two record-derived shortlist chips (`signalChips`). */
  signals: string[];
  /** The shortlist's line: the first sentence of Why (edited text wins). Null with no brief. */
  oneLine: string | null;
  keyPapers: ReportPaper[];
  /** Edited text when present, else generated. Null = no brief drafted for this PI. */
  brief: { why: string; topics: BriefTopic[]; draftedAt: Date } | null;
};

export type MatchaReport = {
  title: string;
  generatedAt: Date;
  officer: { name: string; email: string | null; dept: string | null };
  pis: ReportPi[];
  /** Every concept member, in stored order, de-duplicated: the footer's full search terms. */
  searchTerms: string[];
  /** Null when grouping failed: the coverage table, gaps callout and gaps card are hidden. */
  themes: ReportTheme[] | null;
  /** Rows align with `pis`; columns with `themes`. Null exactly when `themes` is. */
  coverage: Coverage | null;
  /** "Prepared for": the officer's requester correction, else the model's. Null ⇒ no column. */
  requester: string | null;
};

/** `a,b,c` → distinct, trimmed, plausible cwids in the order given. Uncapped: the cap applies
 *  AFTER validation, so a padded list of unknown cwids cannot push real ones off the end. */
export function parseReportCwids(raw: string | null | undefined): string[] {
  const out: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const c = part.trim();
    if (c.length === 0 || c.length > 32 || out.includes(c)) continue;
    out.push(c);
    if (out.length >= 500) break; // a query string is not a bulk channel
  }
  return out;
}

/**
 * The officer named in the header: the session's own directory entry (name + mail), else their
 * Scholar row, else the bare cwid. Never throws; a slow directory falls through.
 */
export async function loadOfficerContact(
  cwid: string,
): Promise<{ name: string; email: string | null; dept: string | null }> {
  try {
    const lookup = fetchDirectoryPeopleByCwid([cwid]);
    lookup.catch(() => {});
    const people = await Promise.race([
      lookup,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), OFFICER_LOOKUP_TIMEOUT_MS)),
    ]);
    const p = people?.find((x) => x.cwid.toLowerCase() === cwid.toLowerCase());
    if (p) {
      const name = [p.firstName, p.lastName].filter(Boolean).join(" ").trim() || p.name?.trim();
      if (name) return { name, email: p.email ?? null, dept: p.dept?.trim() || null };
    }
  } catch {
    /* fall through to the Scholar row */
  }
  try {
    const s = await db.read.scholar.findUnique({
      where: { cwid },
      select: { preferredName: true, email: true },
    });
    if (s) return { name: s.preferredName, email: s.email ?? null, dept: null };
  } catch {
    /* fall through to the cwid */
  }
  return { name: cwid, email: null, dept: null };
}

/** Top impact-scored confirmed papers for one PI: the records-only fallback for key papers. */
async function topPapers(cwid: string, take: number): Promise<ReportPaper[]> {
  const rows = await db.read.publication.findMany({
    where: { impactScore: { not: null }, authors: { some: { cwid, isConfirmed: true } } },
    orderBy: [{ impactScore: { sort: "desc", nulls: "last" } }, { year: "desc" }],
    take,
    select: { pmid: true, title: true, year: true },
  });
  return rows.map((r) => ({ pmid: r.pmid, title: r.title, year: r.year }));
}

/** Key papers: the brief's own cited papers first (they are the ones about THIS ask), then the
 *  engine's evidence papers, then the PI's top impact-scored papers. */
function papersFrom(topics: readonly BriefTopic[], candidate: MatchaCandidate): ReportPaper[] {
  const out: ReportPaper[] = [];
  const add = (p: ReportPaper) => {
    if (out.length < REPORT_MAX_PAPERS && !out.some((q) => q.pmid === p.pmid)) out.push(p);
  };
  for (const t of topics) {
    for (const s of t.sources)
      if (s.kind === "pub") add({ pmid: s.pmid, title: s.title, year: s.year });
  }
  for (const p of candidate.evidence?.papers ?? [])
    add({ pmid: p.pmid, title: p.title, year: p.year });
  return out;
}

/**
 * The report, or null when the submission is not in the caller's scope (or has no stored
 * answer to check the selection against). Caller enforces the flag and the read gate.
 */
export async function loadMatchaReport(
  session: Pick<EditSession, "cwid" | "isSuperuser" | "isDeveloper">,
  submissionId: string,
  requested: readonly string[],
): Promise<MatchaReport | null> {
  const sub = await db.read.sponsorMatchSubmission.findUnique({
    where: { id: submissionId, ...matchaSubmissionScope(session) },
    // NEVER `description`: the raw paste is not part of the report.
    select: { descriptionHash: true, title: true, titleOverride: true, requesterOverride: true },
  });
  if (!sub) return null;
  const stored = await loadStoredResult(sub.descriptionHash, requested);
  if (!stored) return null;

  const byCwid = new Map(stored.candidates.map((c) => [c.cwid, c]));
  const cwids = requested.filter((c) => byCwid.has(c)).slice(0, MATCHA_REPORT_CAP);
  const topScore = stored.candidates.reduce((m, c) => Math.max(m, c.fusedScore), 0);

  const [briefRows, records, scholars, officer, themes] = await Promise.all([
    cwids.length
      ? db.read.matchaBrief.findMany({
          where: { descriptionHash: sub.descriptionHash, cwid: { in: cwids } },
          // NEVER `note`: the report is the external copy.
          select: { cwid: true, generated: true, edited: true, createdAt: true },
        })
      : Promise.resolve([]),
    loadBriefRecords(cwids),
    cwids.length
      ? db.read.scholar.findMany({
          where: { cwid: { in: cwids } },
          // NEVER `email`: the officer's is the only one on the page.
          select: {
            cwid: true,
            preferredName: true,
            postnominal: true,
            primaryTitle: true,
            primaryDepartment: true,
            slug: true,
            hasHeadshot: true,
          },
        })
      : Promise.resolve([]),
    loadOfficerContact(session.cwid),
    // Never throws: null hides the coverage section for this view.
    cwids.length ? loadReportThemes(sub.descriptionHash, stored.concepts ?? []) : Promise.resolve(null),
  ]);
  const briefBy = new Map(briefRows.map((b) => [b.cwid, b]));
  const scholarBy = new Map(scholars.map((s) => [s.cwid, s]));

  const pis: ReportPi[] = cwids.map((cwid, i) => {
    const c = byCwid.get(cwid)!;
    const s = scholarBy.get(cwid);
    const rec = records.get(cwid) ?? {
      funding: [],
      translation: [],
      secondaryAppointments: [],
      centers: [],
    };
    const row = briefBy.get(cwid);
    const wire = row
      ? {
          generated: row.generated as BriefGenerated,
          edited: (row.edited ?? null) as BriefEdited | null,
        }
      : null;
    const brief = wire
      ? {
          why: briefWhy(wire),
          // A grant suppressed (or hideFunding set) since drafting must not ride along as a source.
          topics: withLiveSources(briefTopics(wire), rec),
          draftedAt: row!.createdAt,
        }
      : null;
    const name = s
      ? s.postnominal
        ? `${s.preferredName}, ${s.postnominal}`
        : s.preferredName
      : c.name;
    return {
      cwid,
      rank: i + 1,
      name,
      shortName: s?.preferredName ?? c.name,
      photoUrl: headshotUrl(cwid, s?.hasHeadshot),
      title: s?.primaryTitle ?? c.title,
      department: s?.primaryDepartment ?? c.department,
      profileUrl: new URL(profilePath(s?.slug ?? c.profileSlug), siteBaseUrl()).toString(),
      secondaryAppointments: rec.secondaryAppointments,
      centers: rec.centers,
      funding: rec.funding,
      translation: rec.translation,
      fit: fitTier(c.fusedScore, topScore),
      signals: signalChips(rec.funding, c.technologyCount ?? 0),
      oneLine: brief && brief.why.trim() ? firstSentence(brief.why) : null,
      keyPapers: papersFrom(brief?.topics ?? [], c),
      brief,
    };
  });

  // Top up short paper lists from the PI's own record, a few reads at a time.
  const short = pis.filter((p) => p.keyPapers.length < 2);
  for (let i = 0; i < short.length; i += PAPER_READ_CONCURRENCY) {
    await Promise.all(
      short.slice(i, i + PAPER_READ_CONCURRENCY).map(async (p) => {
        try {
          for (const paper of await topPapers(p.cwid, REPORT_MAX_PAPERS)) {
            if (p.keyPapers.length >= REPORT_MAX_PAPERS) break;
            if (!p.keyPapers.some((q) => q.pmid === paper.pmid)) p.keyPapers.push(paper);
          }
        } catch {
          /* papers are a supplement; the section says "Not evident" without them */
        }
      }),
    );
  }

  const searchTerms: string[] = [];
  for (const concept of stored.concepts ?? []) {
    for (const m of concept.members?.length ? concept.members : [concept.term]) {
      const t = m.trim();
      if (t && !searchTerms.some((x) => x.toLowerCase() === t.toLowerCase())) searchTerms.push(t);
    }
  }
  const coverage = themes
    ? computeCoverage(
        cwids.map((cwid) => ({ cwid, contributions: byCwid.get(cwid)!.contributions ?? [] })),
        themes,
      )
    : null;

  return {
    title: sub.titleOverride ?? sub.title ?? "Untitled search",
    generatedAt: new Date(),
    officer,
    pis,
    searchTerms,
    themes: coverage ? themes : null,
    coverage,
    requester: sub.requesterOverride?.trim() || stored.requester?.trim() || null,
  };
}
