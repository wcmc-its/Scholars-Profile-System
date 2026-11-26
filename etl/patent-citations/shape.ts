/**
 * Pure shaping for the patent-citations import: no I/O, so it is unit-tested
 * directly (tests/unit/patent-citations.test.ts). The extract file's row types
 * live here too; the format itself is described in import.ts.
 */
import type { CitingDoc } from "../policy-citations/shape";

export type PatentKind = "grant" | "application" | "reissue" | "design" | "other";

/** What the patent tables say about a citing patent document. */
export type PatentDetails = {
  kind: PatentKind;
  /** "YYYY-MM-DD". A pre-grant publication has no grant date, a grant no publication date. */
  grantDate: string | null;
  publicationDate: string | null;
  filingDate: string | null;
  /** The invention this document belongs to; also the row's `dedup_key`. */
  familyKey: string;
  /** Applications in the whole family, cited or not. */
  familySize: number;
  /** Names as printed, in the patent's order. Often empty for a pre-grant publication. */
  assignees: string[];
  inventors: Array<{ first: string; last: string }>;
  /** Release date of the patent tables the fields came from. */
  metadataRelease: string;
  /** Set when the tables had no row for the document; the title is then its number. */
  metadataMissing?: true;
};

/** What the dataset says about one paper-and-patent link. */
export type PatentEvidence = {
  /** The dataset's confidence in the match, 4 to 10. */
  score: number;
  where: "front" | "body" | "both";
  /** The dataset release the link came from. */
  release: string;
  /** Set when the paper won an OpenAlex id it shared with another paper on year or DOI. */
  sharedId?: true;
};

export const MIN_SCORE = 4;
const MAX_ASSIGNEES = 5;
const MAX_INVENTORS = 20;

export type ExtractHeader = {
  t: "header";
  format: 1;
  /** Dataset release, "zenodo:<record id>". */
  release: string;
  metadataRelease: string;
  /** "YYYY-MM-DD": when the paper mapping was checked. */
  mappedAt: string;
  counts: { considered: number; map: number; tie: number; doc: number; link: number };
};
export type MapRow = { pmid: string; openalexId: string; source: "api" | "crosswalk-2023" };
export type DocRow = {
  id: string;
  title?: string | null;
  grantDate?: string | null;
  publicationDate?: string | null;
  filingDate?: string | null;
  applicationId?: string | null;
  familyKey?: string | null;
  familySize?: number | null;
  assignees?: string[];
  inventors?: Array<{ first: string; last: string }>;
};
export type LinkRow = { pmid: string; doc: string; score: number; where: string; sharedId?: boolean };

export type PatentId = {
  kind: PatentKind;
  /** The patent tables' key: "90000001", "RE90001", "D900001", "H9001", or an eleven-digit publication number. */
  number: string;
  /** "US90000001B2": the number as public patent pages write it. */
  display: string;
};

/**
 * Read a dataset id ("us-90000001-b2"). Null for anything that is not a US
 * patent document number we can key on; the caller skips and logs those.
 *
 * The dataset writes a pre-grant publication with ten digits (year, then a
 * six-digit serial) where USPTO's number has eleven: a zero goes back after
 * the year. Two dataset ids can be one patent (a reissue under kinds `e` and
 * `e1`), and statutory invention registrations turn up zero-padded, so
 * `number` drops the kind code and any padding.
 */
export function parsePatentId(id: string): PatentId | null {
  const m = /^us-(\D*)(\d+)-([a-z]\d?)$/.exec(id);
  if (!m) return null;
  const [, prefix, digits, code] = m;
  const bare = String(Number(digits));
  const shown = (n: string) => `US${prefix.toUpperCase()}${n}${code.toUpperCase()}`;
  if (prefix === "") {
    if (digits.length === 10) {
      const number = `${digits.slice(0, 4)}0${digits.slice(4)}`;
      return { kind: "application", number, display: shown(number) };
    }
    if (digits.length === 11) return { kind: "application", number: digits, display: shown(digits) };
    if (["a", "b1", "b2"].includes(code)) return { kind: "grant", number: bare, display: shown(digits) };
    return null;
  }
  const kind = ({ re: "reissue", d: "design", h: "other", pp: "other" } as const)[prefix];
  return kind ? { kind, number: `${prefix.toUpperCase()}${bare}`, display: shown(digits) } : null;
}

/**
 * The invention a document counts toward. The extract's family key is the
 * lowest US application number among the applications joined to this one by a
 * continuation, division, reissue, substitution or PCT national-stage link.
 * A document with no such link is keyed by its own application, so a
 * pre-grant publication and its grant still count once. A document with no
 * application number at all is its own invention, keyed by patent number.
 */
export function familyKey(row: Pick<DocRow, "familyKey" | "applicationId">, id: PatentId): string {
  return row.familyKey || row.applicationId || `doc:${id.number}`;
}

/** One extract row as a citing document, or null when its id cannot be read. */
export function patentDoc(row: DocRow, metadataRelease: string): (CitingDoc & { details: PatentDetails }) | null {
  const id = parsePatentId(row.id);
  if (!id) return null;
  const title = row.title?.trim();
  const dated = id.kind === "application" ? row.publicationDate : row.grantDate;
  const key = familyKey(row, id);
  return {
    source: "ros",
    externalId: row.id,
    title: title || id.display,
    year: dated ? Number(dated.slice(0, 4)) : null,
    url: `https://patents.google.com/patent/${id.display}/en`,
    level: "patent",
    issuingBody: null,
    dedupKey: key,
    authors: null,
    journal: null,
    journalAbbrev: null,
    volume: null,
    issue: null,
    pages: null,
    doi: null,
    publisher: null,
    details: {
      kind: id.kind,
      grantDate: row.grantDate || null,
      publicationDate: row.publicationDate || null,
      filingDate: row.filingDate || null,
      familyKey: key,
      familySize: row.familySize || 1,
      assignees: (row.assignees ?? []).slice(0, MAX_ASSIGNEES),
      inventors: (row.inventors ?? []).slice(0, MAX_INVENTORS).map(({ first, last }) => ({ first, last })),
      metadataRelease,
      ...(title ? {} : { metadataMissing: true as const }),
    },
  };
}

/** A link's evidence, or null for a link below the confidence floor or with an unreadable row. */
export function linkEvidence(row: LinkRow, release: string): PatentEvidence | null {
  if (!Number.isInteger(row.score) || row.score < MIN_SCORE || row.score > 10) return null;
  if (row.where !== "front" && row.where !== "body" && row.where !== "both") return null;
  return { score: row.score, where: row.where, release, ...(row.sharedId ? { sharedId: true as const } : {}) };
}

/** The facts the tie-break needs about an OpenAlex id that two of our papers claim. */
export type SharedIdFacts = {
  /** The OpenAlex work's own year and DOI, as the API gives them now. */
  workYear: number | null;
  workDoi: string | null;
  /** The paper the API attaches the id to, with its year and DOI in Scholars. */
  api: { pmid: string; year: number | null; doi: string | null };
  /** The paper the 2023 crosswalk attaches it to. */
  crosswalk: { pmid: string; year: number | null; doi: string | null };
  /** The crosswalk's paper now resolves, through the API, to a different work. */
  crosswalkHasOwnWork: boolean;
};
export type SharedIdRule = "own-work" | "year" | "doi" | "unresolved";

/**
 * Which paper keeps an OpenAlex id that two of ours claim.
 *   1. The crosswalk's paper now has its own work: the crosswalk row is stale, the API's paper keeps the id.
 *   2. Else the paper published within a year of the work wins; failing that, the one whose DOI is the work's.
 *   3. Else neither: the links are not loaded, and the pair is logged.
 * The extract applies this; the importer runs it again on the facts in the
 * file and refuses a file whose stated winners disagree.
 */
export function decideSharedId(f: SharedIdFacts): { rule: SharedIdRule; winner: string | null } {
  if (f.crosswalkHasOwnWork) return { rule: "own-work", winner: f.api.pmid };
  const near = (y: number | null) => f.workYear !== null && y !== null && Math.abs(y - f.workYear) <= 1;
  if (near(f.api.year) !== near(f.crosswalk.year)) {
    return { rule: "year", winner: near(f.api.year) ? f.api.pmid : f.crosswalk.pmid };
  }
  const doi = (d: string | null) => (d ?? "").trim().toLowerCase();
  const same = (d: string | null) => doi(f.workDoi) !== "" && doi(d) === doi(f.workDoi);
  if (same(f.api.doi) !== same(f.crosswalk.doi)) {
    return { rule: "doi", winner: same(f.api.doi) ? f.api.pmid : f.crosswalk.pmid };
  }
  return { rule: "unresolved", winner: null };
}
export type TieRow = SharedIdFacts & { openalexId: string; rule: SharedIdRule; winner: string | null };

/** JSON text with object keys sorted at every depth: MySQL's JSON type does not keep key order. */
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}
