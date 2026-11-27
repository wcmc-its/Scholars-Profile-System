/**
 * Registered clinical trials, US patents and clinical studies that cite one
 * publication, as the publication modal's "Trials and patents" section shows
 * them. Pure shaping: the reads are `readTrialPatentCitations` and
 * `readClinicalCitations` (lib/api/publication-detail.ts).
 *
 * Neither is a ranked level (`POLICY_LEVELS`, policy-rollup.ts), so none of
 * this reaches the "Guidelines and policy" section, report 24 or the
 * Bibliometrics tab.
 */
import { parsePatentId } from "@/etl/patent-citations/shape";

/** Server-side gates, one per group. */
export function trialCitationsModalOn(): boolean {
  return process.env.TRIAL_CITATIONS_MODAL === "on";
}
export function patentCitationsModalOn(): boolean {
  return process.env.PATENT_CITATIONS_MODAL === "on";
}
export function clinicalCitationsModalOn(): boolean {
  return process.env.CLINICAL_CITATIONS_MODAL === "on";
}

export type CitingTrial = {
  id: number;
  title: string;
  /** The ClinicalTrials.gov record; null when the stored URL is not on that host. */
  url: string | null;
  sponsor: string | null;
  /** Display values ("Phase 2/3", "Recruiting"); null when the registry gives none. */
  phase: string | null;
  status: string | null;
  startYear: number | null;
  nctId: string;
  /** One of the paper's authors is an investigator on the trial: listed, not counted. */
  ownTrial: boolean;
};

/** One invention: a patent family, shown as its representative patent. */
export type CitingInvention = {
  id: number;
  title: string;
  /** The public patent page; null when the stored URL is not on the importer's host. */
  url: string | null;
  /** The assignees, or "First Last et al." when the patent names none. */
  holder: string | null;
  /** Grant year, or the application's publication year when `granted` is false. */
  year: number | null;
  granted: boolean;
  /** "US 90000001 B2" */
  number: string;
  /** Other patents of the same invention that cite the paper. */
  related: number;
};

/** One clinical article that cites the paper (iCite's clinical citations). */
export type CitingClinicalStudy = {
  id: number;
  title: string;
  /** The PubMed record; null when the stored URL is not on that host. */
  url: string | null;
  journal: string | null;
  year: number | null;
  /** The citing article shares a confirmed author with the paper: listed, not counted. */
  ownWork: boolean;
};

/**
 * One page of the clinical studies, newest first. `count` leaves out the
 * authors' own work, as `publication.clinical_cite_count` does; `total` is
 * every study, and the list pages to it.
 */
export type ClinicalCitations = { items: CitingClinicalStudy[]; count: number; total: number };

export type TrialPatentCitations = {
  /** `count` leaves out the authors' own trials; `total` is every trial, sent or not. */
  trials?: { items: CitingTrial[]; count: number; total: number };
  inventions?: { items: CitingInvention[]; total: number };
  /** The first page; the modal loads the rest (`clinicalCitationsPath`, clinical-page.ts). */
  clinical?: ClinicalCitations;
};

// ponytail: the first 50 of each group are sent, newest first, with the true
// totals; the modal says so when a list is cut. The largest paper has about
// 1,600 inventions and one has 88 trials. Page them if anyone asks.
export const TRIAL_PATENT_CAP = 50;

const TRIAL_HOST = "https://clinicaltrials.gov/";
const PUBMED_HOST = "https://pubmed.ncbi.nlm.nih.gov/";
/** The patent page host the importer stores (`patentDoc`, etl/patent-citations/shape.ts). */
const PATENT_HOST = "https://patents.google.com/";

const allowed = (url: string, host: string) => (url.startsWith(host) ? url : null);

/** "NOT_YET_RECRUITING" → "Not yet recruiting". */
function sentence(raw: string): string {
  const s = raw.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * ClinicalTrials.gov's raw values as the modal prints them: "PHASE2/PHASE3" →
 * "Phase 2/3", "EARLY_PHASE1" → "Early phase 1", "RECRUITING" → "Recruiting".
 * A study with no phase, or the registry's "NA" (not applicable), has none.
 */
export function trialDisplay(raw: { phase?: unknown; status?: unknown }): {
  phase: string | null;
  status: string | null;
} {
  const phase = typeof raw.phase === "string" ? raw.phase.trim() : "";
  const status = typeof raw.status === "string" ? raw.status.trim() : "";
  return {
    phase:
      phase && phase !== "NA"
        ? sentence(
            phase
              .split("/")
              .map((p, i) => (i === 0 ? p.replace(/PHASE(?=\d)/, "PHASE ") : p.replace(/^PHASE/, "")))
              .join("/"),
          )
        : null,
    status: status ? (status === "UNKNOWN" ? "Unknown status" : sentence(status)) : null,
  };
}

/** A stored `details` or `evidence` value: an object, or JSON text from a raw query. */
function obj(raw: unknown): Record<string, unknown> {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return {};
    }
  }
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

const date = (v: unknown) => (typeof v === "string" && /^\d{4}/.test(v) ? v : null);

/** What the representative choice reads from one patent document of an invention. */
export type PatentDocFacts = { externalId: string; grantDate: string | null; publicationDate: string | null };

/**
 * The patent that stands for an invention: its earliest granted patent, else
 * its earliest published application. Ties go to the lower document id, so the
 * choice does not depend on row order.
 */
export function representativePatent<T extends PatentDocFacts>(docs: readonly T[]): T | undefined {
  const earliest = (rows: T[], key: (d: T) => string) =>
    [...rows].sort((a, b) => key(a).localeCompare(key(b)) || a.externalId.localeCompare(b.externalId))[0];
  const granted = docs.filter((d) => d.grantDate);
  if (granted.length > 0) return earliest(granted, (d) => d.grantDate!);
  // An application with no date sorts last.
  return earliest([...docs], (d) => d.publicationDate ?? "9999");
}

/** One link row as the read returns it. */
export type TrialPatentLink = {
  evidence: unknown;
  citingDocument: {
    id: number;
    level: string;
    externalId: string;
    title: string;
    year: number | null;
    url: string;
    dedupKey: string;
    details: unknown;
  };
};

function toTrial({ evidence, citingDocument: d }: TrialPatentLink): CitingTrial {
  const details = obj(d.details);
  return {
    id: d.id,
    title: d.title,
    url: allowed(d.url, TRIAL_HOST),
    sponsor: typeof details.sponsor === "string" && details.sponsor ? details.sponsor : null,
    ...trialDisplay(details),
    startYear: d.year,
    nctId: d.externalId,
    ownTrial: obj(evidence).ownTrial === true,
  };
}

/** One clinical link row as the read returns it. */
export type ClinicalLink = {
  evidence: unknown;
  citingDocument: {
    id: number;
    title: string;
    year: number | null;
    url: string;
    journal: string | null;
    journalAbbrev: string | null;
  };
};

/** The authors' own work, from a link's `evidence` (`OWN_WORK`, etl/clinical-citations/shape.ts). */
export const isOwnWorkEvidence = (evidence: unknown): boolean => obj(evidence).ownWork === true;

export function toClinicalStudy({ evidence, citingDocument: d }: ClinicalLink): CitingClinicalStudy {
  return {
    id: d.id,
    title: d.title,
    url: allowed(d.url, PUBMED_HOST),
    journal: d.journalAbbrev || d.journal || null,
    year: d.year,
    ownWork: isOwnWorkEvidence(evidence),
  };
}

/**
 * One page of clinical studies from its rows (already ordered and cut by the
 * read) and the `evidence` of every clinical link of the paper, or undefined
 * when the paper has none.
 */
export function shapeClinicalCitations(
  page: readonly ClinicalLink[],
  everyEvidence: readonly unknown[],
): ClinicalCitations | undefined {
  if (everyEvidence.length === 0) return undefined;
  return {
    items: page.map(toClinicalStudy),
    count: everyEvidence.filter((e) => !isOwnWorkEvidence(e)).length,
    total: everyEvidence.length,
  };
}

function toInvention(docs: TrialPatentLink["citingDocument"][]): CitingInvention {
  const facts = docs.map((d) => {
    const details = obj(d.details);
    return {
      d,
      details,
      externalId: d.externalId,
      grantDate: date(details.grantDate),
      publicationDate: date(details.publicationDate),
    };
  });
  const rep = representativePatent(facts)!;
  const assignees = Array.isArray(rep.details.assignees)
    ? rep.details.assignees.filter((a): a is string => typeof a === "string" && a.trim() !== "")
    : [];
  const inventors = Array.isArray(rep.details.inventors)
    ? (rep.details.inventors as Array<{ first?: unknown; last?: unknown }>)
    : [];
  const first = [inventors[0]?.first, inventors[0]?.last].filter((n) => typeof n === "string" && n).join(" ");
  const dated = rep.grantDate ?? rep.publicationDate;
  return {
    id: rep.d.id,
    title: rep.d.title,
    url: allowed(rep.d.url, PATENT_HOST),
    holder:
      assignees.length > 0 ? assignees.join("; ") : first ? `${first}${inventors.length > 1 ? " et al." : ""}` : null,
    year: dated ? Number(dated.slice(0, 4)) : null,
    granted: rep.grantDate !== null,
    number: (parsePatentId(rep.externalId)?.display ?? rep.externalId.toUpperCase()).replace(
      /^US(.+?)([A-Z]\d?)$/,
      "US $1 $2",
    ),
    related: docs.length - 1,
  };
}

/**
 * The section's payload from a publication's trial and patent links, or
 * undefined when there is nothing to show. A group whose flag is off is left
 * out whatever the rows hold. Both lists are newest first.
 */
export function shapeTrialPatentCitations(
  links: readonly TrialPatentLink[],
  on: { trials: boolean; patents: boolean },
): TrialPatentCitations | undefined {
  const newest = <T extends { id: number }>(year: (x: T) => number | null) => (a: T, b: T) =>
    (year(b) ?? 0) - (year(a) ?? 0) || a.id - b.id;
  const out: TrialPatentCitations = {};

  const trials = on.trials
    ? links
        .filter((l) => l.citingDocument.level === "trial")
        .map(toTrial)
        .sort(newest((t) => t.startYear))
    : [];
  if (trials.length > 0) {
    out.trials = {
      items: trials.slice(0, TRIAL_PATENT_CAP),
      count: trials.filter((t) => !t.ownTrial).length,
      total: trials.length,
    };
  }

  const families = new Map<string, TrialPatentLink["citingDocument"][]>();
  if (on.patents) {
    for (const { citingDocument: d } of links) {
      if (d.level !== "patent") continue;
      const family = families.get(d.dedupKey);
      if (family) family.push(d);
      else families.set(d.dedupKey, [d]);
    }
  }
  if (families.size > 0) {
    const inventions = [...families.values()].map(toInvention).sort(newest((i) => i.year));
    out.inventions = { items: inventions.slice(0, TRIAL_PATENT_CAP), total: inventions.length };
  }

  return out.trials || out.inventions ? out : undefined;
}

/** One invention citing some of a scholar's papers, with how many of them. */
export type ScholarInvention = CitingInvention & { papers: number };

/**
 * The inventions citing any of a scholar's papers (the Bibliometrics patents
 * card): patents grouped into inventions as the publication modal groups
 * them, most of the scholar's papers cited first, then newest. The first
 * `TRIAL_PATENT_CAP` are sent with the true total; the Excel download has all.
 */
export function shapeScholarInventions(
  links: ReadonlyArray<{ pmid: string; citingDocument: TrialPatentLink["citingDocument"] }>,
): { items: ScholarInvention[]; total: number } {
  const families = new Map<string, { docs: Map<number, TrialPatentLink["citingDocument"]>; papers: Set<string> }>();
  for (const { pmid, citingDocument: d } of links) {
    if (d.level !== "patent") continue;
    const f = families.get(d.dedupKey) ?? { docs: new Map(), papers: new Set<string>() };
    f.docs.set(d.id, d);
    f.papers.add(pmid);
    families.set(d.dedupKey, f);
  }
  const items = [...families.values()]
    .map((f) => ({ ...toInvention([...f.docs.values()]), papers: f.papers.size }))
    .sort((a, b) => b.papers - a.papers || (b.year ?? 0) - (a.year ?? 0) || a.id - b.id);
  return { items: items.slice(0, TRIAL_PATENT_CAP), total: items.length };
}
