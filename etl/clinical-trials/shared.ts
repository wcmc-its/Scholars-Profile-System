/**
 * Clinical-trials ETL — shared types + transform, used by all three entrypoints:
 *   - index.ts  (direct: reciterdb + Sps DB in one process; works once #443 lands)
 *   - export.ts (bridge half 1: reciterdb → S3 NDJSON, runs where reciterdb is reachable)
 *   - import.ts (bridge half 2: S3 NDJSON → Sps DB, runs in-VPC)
 *
 * Keeping the join/role/build/replace logic here means the direct path and the
 * bridge can't drift — they produce identical rows from identical source data.
 */
import { db } from "../../lib/db";
import { withReciterConnection } from "@/lib/sources/reciterdb";

export const INSERT_BATCH = 1000;

export function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Raw `reciterdb.clinical_trials` row (the institutional spine). */
export type InstitutionalRow = {
  cwid: string | null;
  nctNumber: string | null;
  protocolNumber: string | null;
  piName: string | null;
  title: string | null;
  protocolType: string | null;
  firstOTADate: string | null;
  firstCTADate: string | null;
  statusDate: string | null;
  principalSponsor: string | null;
  overallCurrentStatus: string | null;
};

/** Raw `reciterdb.clinical_trials_enriched` row (ClinicalTrials.gov pull). */
export type EnrichedRow = {
  nctNumber: string | null;
  officialTitle: string | null;
  briefTitle: string | null;
  briefSummary: string | null;
  studyType: string | null;
  phases: string | null;
  conditions: string | null;
  meshTerms: string | null;
  enrollment: number | string | null;
};

/** Parse the institutional varchar dates (typically "M/D/YY", sometimes
 *  "M/D/YYYY" or an ISO-ish string) into a Date, or null when unparseable.
 *  Two-digit years pivot at 50 (49→2049, 50→1950) — clinical-trial dates are
 *  contemporary, so this only matters for very old protocols. */
export function parseLooseDate(raw: string | null): Date | null {
  if (!raw) return null;
  const str = String(raw).trim();
  if (!str) return null;
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const mo = parseInt(m[1], 10);
    const d = parseInt(m[2], 10);
    let year = parseInt(m[3], 10);
    if (year < 100) year += year < 50 ? 2000 : 1900;
    const dt = new Date(Date.UTC(year, mo - 1, d));
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  const dt = new Date(str);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

export function cleanInt(raw: number | string | null): number | null {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === "number" ? raw : parseInt(String(raw).replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

export function nonEmpty(s: string | null | undefined): string | null {
  const t = (s ?? "").trim();
  return t.length > 0 ? t : null;
}

/** Normalize an NCT id to canonical uppercase "NCT########", or null. The
 *  institutional export uses the placeholder "NA" for ~1000 protocols with no
 *  registration; anything that isn't a real NCT id (NA, N/A, blanks, junk) maps
 *  to null so it never stores a bogus id, builds a broken ClinicalTrials.gov
 *  link, or collides on the enrichment join. */
export function cleanNct(raw: string | null): string | null {
  const t = nonEmpty(raw);
  if (!t) return null;
  const up = t.toUpperCase();
  return /^NCT\d+$/.test(up) ? up : null;
}

/** Lowercase, strip accents/punctuation, collapse whitespace → token list.
 *  Commas (used by "Last, First" forms) become spaces so order/format of the
 *  name doesn't matter to the match below. */
export function nameTokens(s: string | null): string[] {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z,\s]/g, "")
    .replace(/,/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Heuristic PI test: the scholar's two longest name tokens (≈ first + last,
 *  order-independent, initials dropped) both appear in the trial's piName.
 *  Conservative — favours "Investigator" over a wrong "Principal Investigator". */
export function isLikelyPi(scholarName: string | null, piName: string | null): boolean {
  if (!piName) return false;
  const pi = new Set(nameTokens(piName));
  if (pi.size === 0) return false;
  const stoks = nameTokens(scholarName).filter((t) => t.length > 1);
  if (stoks.length < 2) return false;
  const [t1, t2] = [...stoks].sort((a, b) => b.length - a.length);
  return pi.has(t1) && pi.has(t2);
}

export type TrialBuild = {
  protocolNumber: string;
  nctNumber: string | null;
  title: string;
  status: string | null;
  statusDate: Date | null;
  protocolType: string | null;
  studyType: string | null;
  phase: string | null;
  principalSponsor: string | null;
  conditions: string | null;
  meshTerms: string | null;
  briefSummary: string | null;
  enrollment: number | null;
  firstOtaDate: Date | null;
  firstCtaDate: Date | null;
  enrichmentSource: string | null;
  enrichedAt: Date | null;
  source: string;
  lastRefreshedAt: Date;
};

export type LinkBuild = {
  cwid: string;
  protocolNumber: string;
  role: string;
  piNameRaw: string | null;
  lastRefreshedAt: Date;
};

export type BuildStats = {
  trials: number;
  links: number;
  enrichedHits: number;
  skippedNoProtocol: number;
  skippedUnknownCwid: number;
};

/** Read the two reciterdb source tables. Used by the direct ETL and the export
 *  half — the only step that needs reciterdb reachability. */
export async function readReciterdbTables(): Promise<{
  institutional: InstitutionalRow[];
  enriched: EnrichedRow[];
}> {
  let institutional: InstitutionalRow[] = [];
  let enriched: EnrichedRow[] = [];
  await withReciterConnection(async (conn) => {
    institutional = (await conn.query(`
      SELECT cwid, nctNumber, protocolNumber, piName, title, protocolType,
             firstOTADate, firstCTADate, statusDate, principalSponsor,
             overallCurrentStatus
      FROM clinical_trials
    `)) as InstitutionalRow[];
    enriched = (await conn.query(`
      SELECT nctNumber, officialTitle, briefTitle, briefSummary, studyType,
             phases, conditions, meshTerms, enrollment
      FROM clinical_trials_enriched
    `)) as EnrichedRow[];
  });
  return { institutional, enriched };
}

/** lowercased cwid → { canonical cwid, display name }, for FK validity (only
 *  existing scholars get links) and the role heuristic. Keyed lowercase because
 *  the institutional `clinical_trials.cwid` is UPPERCASE (e.g. "BMW2002") while
 *  `scholar.cwid` is lowercase; the scholar column collation is case-insensitive,
 *  but this in-memory match is not, so we normalize. The value carries the
 *  canonical `scholar.cwid` so the link FK is stored in the scholar's own case.
 *  Used by the direct ETL and the import half. */
export async function loadScholars(): Promise<Map<string, { cwid: string; name: string }>> {
  const scholars = await db.write.scholar.findMany({
    select: { cwid: true, preferredName: true, fullName: true },
  });
  const m = new Map<string, { cwid: string; name: string }>();
  for (const s of scholars) {
    m.set(s.cwid.toLowerCase(), { cwid: s.cwid, name: s.fullName || s.preferredName || "" });
  }
  return m;
}

/** Join institutional + enriched, dedup to one trial per protocol, derive the
 *  per-(cwid, protocol) investigator link + role. Pure function — identical
 *  output for the direct path and the bridge. */
export function buildTrialsAndLinks(
  institutional: InstitutionalRow[],
  enriched: EnrichedRow[],
  scholars: Map<string, { cwid: string; name: string }>,
  now: Date,
): { trials: TrialBuild[]; links: LinkBuild[]; stats: BuildStats } {
  const enrichedByNct = new Map<string, EnrichedRow>();
  for (const e of enriched) {
    const key = cleanNct(e.nctNumber);
    if (key) enrichedByNct.set(key, e);
  }

  const trials = new Map<string, TrialBuild>();
  const links = new Map<string, LinkBuild>(); // dedupe by "cwid|protocol"
  let skippedNoProtocol = 0;
  let skippedUnknownCwid = 0;
  let enrichedHits = 0;

  for (const r of institutional) {
    const protocol = nonEmpty(r.protocolNumber);
    if (!protocol) {
      skippedNoProtocol++;
      continue;
    }
    const cwidRaw = nonEmpty(r.cwid);
    const scholar = cwidRaw ? scholars.get(cwidRaw.toLowerCase()) : undefined;
    if (!scholar) {
      skippedUnknownCwid++;
      continue;
    }
    const cwid = scholar.cwid; // canonical scholar.cwid (matches the FK case)

    const nct = cleanNct(r.nctNumber);
    const enrichedRow = nct ? enrichedByNct.get(nct) : undefined;
    if (enrichedRow) enrichedHits++;

    // Build the trial once (first institutional row for a protocol wins for the
    // trial-level fields; later rows only add investigator links).
    if (!trials.has(protocol)) {
      const title =
        nonEmpty(enrichedRow?.officialTitle) ||
        nonEmpty(enrichedRow?.briefTitle) ||
        nonEmpty(r.title) ||
        `Protocol ${protocol}`;
      trials.set(protocol, {
        protocolNumber: protocol,
        nctNumber: nct,
        title,
        status: nonEmpty(r.overallCurrentStatus),
        statusDate: parseLooseDate(r.statusDate),
        protocolType: nonEmpty(r.protocolType),
        studyType: nonEmpty(enrichedRow?.studyType),
        phase: nonEmpty(enrichedRow?.phases),
        principalSponsor: nonEmpty(r.principalSponsor),
        conditions: nonEmpty(enrichedRow?.conditions),
        meshTerms: nonEmpty(enrichedRow?.meshTerms),
        briefSummary: nonEmpty(enrichedRow?.briefSummary),
        enrollment: cleanInt(enrichedRow?.enrollment ?? null),
        firstOtaDate: parseLooseDate(r.firstOTADate),
        firstCtaDate: parseLooseDate(r.firstCTADate),
        enrichmentSource: enrichedRow ? "ClinicalTrials.gov" : null,
        enrichedAt: enrichedRow ? now : null,
        source: "reciterdb.clinical_trials",
        lastRefreshedAt: now,
      });
    }

    const linkKey = `${cwid}|${protocol}`;
    if (!links.has(linkKey)) {
      links.set(linkKey, {
        cwid,
        protocolNumber: protocol,
        role: isLikelyPi(scholar.name, r.piName) ? "Principal Investigator" : "Investigator",
        piNameRaw: nonEmpty(r.piName),
        lastRefreshedAt: now,
      });
    }
  }

  return {
    trials: [...trials.values()],
    links: [...links.values()],
    stats: {
      trials: trials.size,
      links: links.size,
      enrichedHits,
      skippedNoProtocol,
      skippedUnknownCwid,
    },
  };
}

/** Full-replace the two tables (children first on delete, parents first on
 *  insert per FK). The institutional export is a static snapshot, so rebuild
 *  from whatever we were given. Caller MUST guard against an empty build before
 *  calling this — delete-all + insert-nothing would wipe good data. */
export async function replaceAll(
  trials: TrialBuild[],
  links: LinkBuild[],
): Promise<{ insTrials: number; insLinks: number; delLinks: number; delTrials: number }> {
  // Delete + insert both tables in ONE transaction so a mid-write kill can't
  // leave a half-rebuilt set (children-first delete, parents-first insert
  // preserves FK order inside the tx). Interactive-tx timeout raised above the
  // 5 s default for the batched createMany.
  let insTrials = 0;
  let insLinks = 0;
  let delLinks = 0;
  let delTrials = 0;
  await db.write.$transaction(
    async (tx) => {
      delLinks = (await tx.personClinicalTrial.deleteMany({})).count;
      delTrials = (await tx.clinicalTrial.deleteMany({})).count;
      for (const batch of chunks(trials, INSERT_BATCH)) {
        await tx.clinicalTrial.createMany({ data: batch });
        insTrials += batch.length;
      }
      for (const batch of chunks(links, INSERT_BATCH)) {
        await tx.personClinicalTrial.createMany({ data: batch });
        insLinks += batch.length;
      }
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
  return { insTrials, insLinks, delLinks, delTrials };
}
