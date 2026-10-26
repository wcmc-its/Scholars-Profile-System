/**
 * ORCID librarian queue (`/edit/orcid-queue`, docs/orcid-librarian-queue-spec.md):
 * the flag, the viewer predicate, the band/tab vocabulary, the row types, and
 * the pure rules the page and the three routes share.
 *
 * 🔴 CLIENT-BUNDLED. `components/edit/orcid-queue.tsx` imports this module at
 * runtime, so it must never import `@/lib/db` or anything that builds a Prisma
 * client at module scope. The loaders and writers live in
 * `orcid-queue.server.ts` and take the client as a parameter.
 *
 * WHO. Librarians are superusers; there is no new role. The page, every route
 * and the subnav tab read `isSuperuser` — never a comms_steward, observer or
 * content editor, and never an impersonated decision (the routes refuse View
 * as, so `orcid_confirmed_by` is always the real librarian).
 */

/** `ORCID_LIBRARIAN_QUEUE`: exactly "on" shows the page, the tab and the routes. */
export function isOrcidLibrarianQueueEnabled(): boolean {
  return process.env.ORCID_LIBRARIAN_QUEUE === "on";
}

/** The tab predicate AND the page gate: the same function (I2 parity). */
export function isOrcidQueueTabVisible(session: { isSuperuser: boolean }): boolean {
  return isOrcidLibrarianQueueEnabled() && session.isSuperuser;
}

/** etl/orcid-evidence's bands, strongest first. */
export const ORCID_QUEUE_BANDS = [
  "email_verified",
  "strong",
  "shared_only",
  "moderate",
  "weak",
] as const;
export type OrcidQueueBand = (typeof ORCID_QUEUE_BANDS)[number];

/** The bands plus Conflicts (the scholar holds a DIFFERENT iD on file). */
export const ORCID_QUEUE_TABS = [...ORCID_QUEUE_BANDS, "conflicts"] as const;
export type OrcidQueueTab = (typeof ORCID_QUEUE_TABS)[number];
export const DEFAULT_ORCID_QUEUE_TAB: OrcidQueueTab = "strong";

export const ORCID_QUEUE_TAB_LABEL: Record<OrcidQueueTab, string> = {
  email_verified: "Email verified",
  strong: "Strong",
  shared_only: "Shared papers",
  moderate: "Moderate",
  weak: "Weak",
  conflicts: "Conflicts",
};

export function isOrcidQueueTab(v: unknown): v is OrcidQueueTab {
  return typeof v === "string" && (ORCID_QUEUE_TABS as readonly string[]).includes(v);
}

/** Only these bands are bulk-confirmable, and only after a passed sample. */
export const ORCID_SAMPLE_BANDS = ["strong", "shared_only"] as const;
export type OrcidSampleBand = (typeof ORCID_SAMPLE_BANDS)[number];
export const ORCID_QUEUE_SAMPLE_SIZE = 50;

export function isOrcidSampleBand(v: unknown): v is OrcidSampleBand {
  return typeof v === "string" && (ORCID_SAMPLE_BANDS as readonly string[]).includes(v);
}

/** The iD on file for a scholar as the rest of the app reads it
 *  (`/api/edit/orcid`, the coverage fold): `scholar.orcid`, else an undismissed
 *  `rpm_admin` candidate iD. WCM usually leaves `scholar.orcid` NULL and the
 *  /edit card shows the RPM mirror row. `orcid` is the pair being placed, so a
 *  scholar with two `rpm_admin` iDs reads the pair's own as on file. Pure. */
export function heldFor(
  orcid: string,
  scholarOrcid: string | null,
  adminIds: readonly string[],
): string | null {
  if (scholarOrcid !== null) return scholarOrcid;
  if (adminIds.includes(orcid)) return orcid;
  return adminIds[0] ?? null;
}

/** Where a candidate pair stands against what is on file. Pure. */
export type PairState = "queue" | "on_file" | "dismissed" | "conflict";
export function pairState(orcid: string, held: string | null, dismissed: boolean): PairState {
  if (held === orcid) return "on_file";
  if (dismissed) return "dismissed";
  if (held !== null) return "conflict";
  return "queue";
}

/** open = undecided rows and no dismissal; passed = all decided, none
 *  dismissed; locked = any dismissal (bulk stays off for the band). Pure. */
export type SampleStatus = "open" | "passed" | "locked";
export function sampleStatus(rows: ReadonlyArray<{ decision: string | null }>): SampleStatus {
  if (rows.some((r) => r.decision === "dismissed")) return "locked";
  if (rows.length > 0 && rows.every((r) => r.decision !== null)) return "passed";
  return "open";
}

export type OrcidQueueSampleState = {
  id: string;
  band: OrcidSampleBand;
  startedAt: string;
  /** `orcidQueueFilterKey` of the filter the sample was drawn under; it
   *  authorizes bulk confirm for that filter only. */
  filterKey: string;
  total: number;
  decided: number;
  dismissed: number;
  status: SampleStatus;
  /** A passed sample whose band was re-scored by a later ETL run: it no longer
   *  authorizes bulk confirm, and a new sample is needed. */
  stale?: boolean;
};

export type OrcidQueueWork = {
  title: string | null;
  year: number | null;
  doi: string | null;
  pmid: string | null;
  source: string | null;
  /** The ORCID work's own link (v2; absent on rows a v1 run wrote). */
  url?: string | null;
};

/** `orcid_candidate.source` values, in the order the filter lists them. */
export const ORCID_CANDIDATE_SOURCES = [
  "rpm_inferred",
  "rpm_admin",
  "orcid_email",
  "orcid_works",
  "orcid_crossref",
  "orcid_name",
  "infoed_biosketch",
] as const;
export type OrcidCandidateSource = (typeof ORCID_CANDIDATE_SOURCES)[number];

export const ORCID_SOURCE_LABEL: Record<OrcidCandidateSource, string> = {
  rpm_inferred: "Publication Manager inference",
  rpm_admin: "Publication Manager admin",
  orcid_email: "ORCID email",
  orcid_works: "ORCID shared works",
  orcid_crossref: "Crossref deposit",
  orcid_name: "ORCID name only",
  infoed_biosketch: "NIH biosketch",
};

export function isOrcidCandidateSource(v: unknown): v is OrcidCandidateSource {
  return typeof v === "string" && (ORCID_CANDIDATE_SOURCES as readonly string[]).includes(v);
}

/** Which surname rule made the names agree (etl/orcid-evidence `surnameRule`):
 *  the same surname; the same once accents are folded; a shared token of a
 *  compound surname; the same once spaces and hyphens are removed. */
export type OrcidSurnameRule = "same" | "folded" | "compound_token" | "joined";

export const ORCID_SURNAME_RULE_LABEL: Record<OrcidSurnameRule, string> = {
  same: "same surname",
  folded: "same surname once accents are folded",
  compound_token: "a compound surname shares a part",
  joined: "same surname once spaces and hyphens are removed",
};

/** One institution fact: an ORCID affiliation and what it matched on our side
 *  (`wcm` = the inst_match rule; the rest are the scholar's own history). */
export type OrcidInstitutionPair = {
  orcid: {
    name: string;
    kind: "employment" | "education";
    start: number | null;
    end: number | null;
  };
  ours: { name: string; source: "wcm" | "education" | "appointment" | "identity" };
};

export type OrcidSharedPaper = {
  pmid: string;
  doi: string | null;
  title: string | null;
  year: number | null;
  journal: string | null;
};

/** `orcid_candidate_evidence.evidence_detail`: the facts behind each chip,
 *  written by etl/orcid-evidence so the page never re-fetches ORCID. */
export type OrcidEvidenceDetail = {
  names: {
    orcid: { credit: string | null; given: string | null; family: string | null; other: string[] };
    givenAgrees: boolean;
    surnameRule: OrcidSurnameRule | null;
  };
  /** inst_match (`wcm`) and history_match pairs. */
  institutions: OrcidInstitutionPair[];
  /** A cornell.edu address on the record (an inst_match fact on its own). */
  institutionEmail: string | null;
  /** The scholar's email the record lists as verified. */
  email: string | null;
  /** The shared papers (capped; `shared` is the full count). */
  shared: OrcidSharedPaper[];
  competitors: {
    cwids: Array<{ cwid: string; shared: number; reason: "same_surname" | "same_id" }>;
    orcids: Array<{ orcid: string; shared: number | null }>;
  };
  /** `orcid_candidate.source` values for the pair at scoring time. */
  sources: string[];
  /** Works the non-publication filter dropped or collapsed. */
  worksDropped: number;
};

/** A work's link: PubMed when it has a PMID, else doi.org, else its own URL
 *  (https only: it comes from someone else's ORCID record). Null when it has
 *  none. Pure. */
export function workHref(w: {
  pmid?: string | null;
  doi?: string | null;
  url?: string | null;
}): string | null {
  if (w.pmid && /^\d+$/.test(w.pmid.trim()))
    return `https://pubmed.ncbi.nlm.nih.gov/${w.pmid.trim()}/`;
  if (w.doi?.trim()) return `https://doi.org/${w.doi.trim()}`;
  const url = w.url?.trim();
  if (url && /^https:\/\//i.test(url)) {
    try {
      if (new URL(url).protocol === "https:") return url;
    } catch {
      // Not a URL: no link.
    }
  }
  return null;
}

/** The queue's filter (v2 item 6/7): person type (`role_category`), unit
 *  (`dept:` / `div:` / `inst:` values, the `lib/edit/person-filter.ts`
 *  vocabulary) and candidate source. Empty = no filter on that facet. */
export type OrcidQueueFilter = {
  types: string[];
  units: string[];
  sources: OrcidCandidateSource[];
};

export const EMPTY_ORCID_QUEUE_FILTER: OrcidQueueFilter = { types: [], units: [], sources: [] };

/** Unit kinds the queue offers (no centers). */
const QUEUE_UNIT = /^(dept|div|inst):[^\s]{1,64}$/;
const MAX_FILTER_VALUES = 50;
/** `orcid_queue_sample.filter_key` is VARCHAR(1024): a filter whose canonical
 *  key is longer is refused (routes) or trimmed (page), never truncated. */
export const MAX_FILTER_KEY_LENGTH = 1024;

const cleanList = (v: unknown, ok: (s: string) => boolean): string[] | null => {
  if (v === undefined || v === null) return [];
  const xs = Array.isArray(v) ? v : [v];
  if (xs.length > MAX_FILTER_VALUES) return null;
  const out: string[] = [];
  for (const x of xs) {
    if (typeof x !== "string") return null;
    const t = x.trim();
    if (!t) continue;
    if (t.length > 72 || !ok(t)) return null;
    if (!out.includes(t)) out.push(t);
  }
  return out.sort();
};

/** A filter from a request body or URL values; null when malformed (the
 *  routes 400). Values sorted and de-duplicated, so two spellings of one
 *  selection compare equal. Pure. */
export function sanitizeOrcidQueueFilter(raw: unknown): OrcidQueueFilter | null {
  if (raw === undefined || raw === null) return { types: [], units: [], sources: [] };
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const types = cleanList(r.types, () => true);
  const units = cleanList(r.units, (u) => QUEUE_UNIT.test(u));
  const sources = cleanList(r.sources, isOrcidCandidateSource);
  if (!types || !units || !sources) return null;
  const f = { types, units, sources: sources as OrcidCandidateSource[] };
  return orcidQueueFilterKey(f).length > MAX_FILTER_KEY_LENGTH ? null : f;
}

/** The canonical key a sample stores (`orcid_queue_sample.filter_key`): ""
 *  for no filter, so every v1 sample reads as unfiltered. Pure. */
export function orcidQueueFilterKey(f: OrcidQueueFilter): string {
  const q = new URLSearchParams();
  for (const t of [...f.types].sort()) q.append("type", t);
  for (const u of [...f.units].sort()) q.append("unit", u);
  for (const s of [...f.sources].sort()) q.append("source", s);
  return q.toString();
}

export function isEmptyOrcidQueueFilter(f: OrcidQueueFilter): boolean {
  return f.types.length === 0 && f.units.length === 0 && f.sources.length === 0;
}

/** `?tab=…&type=…&unit=…&source=…` for the page's links. Pure. */
export function orcidQueueHref(basePath: string, tab: string, f: OrcidQueueFilter): string {
  const key = orcidQueueFilterKey(f);
  return `${basePath}?tab=${encodeURIComponent(tab)}${key ? `&${key}` : ""}`;
}

/** One candidate iD on a scholar's card. */
export type OrcidQueueRow = {
  cwid: string;
  orcid: string;
  band: OrcidQueueBand;
  /** queue = nothing on file; conflict = a DIFFERENT iD is on file (Replace);
   *  auto_confirmed = the iD the ETL email-confirmed (Undo); on_file = a
   *  sampled pair that went on file since (shown decided). */
  state: "queue" | "conflict" | "auto_confirmed" | "on_file";
  instMatch: boolean;
  historyMatch: boolean;
  emailVerified: boolean;
  nameAgrees: boolean;
  shared: number;
  competitor: boolean;
  competitors: Array<{ cwid: string; name: string; shared: number | null; reason: string | null }>;
  competitorOrcids: Array<{ orcid: string; shared: number | null }>;
  worksTotal: number;
  newWorks: number;
  newWorksSample: OrcidQueueWork[];
  /** `orcid_candidate.source` values for the pair, read live. */
  sources: OrcidCandidateSource[];
  /** The ETL's facts behind the chips; null on a row a v1 run wrote. */
  detail: OrcidEvidenceDetail | null;
  /** Conflicts / email verified: the iD on file. */
  onFileOrcid: string | null;
  /** Email verified: already confirmed by the ETL (shows Undo). */
  autoConfirmed: boolean;
  /** This row's decision in the band's current sample; undefined = not sampled. */
  sampleDecision?: "confirmed" | "dismissed" | null;
};

/** One scholar and every candidate iD for them, best first (v2 item 5). */
export type OrcidQueueCard = {
  cwid: string;
  slug: string | null;
  name: string;
  /** The names the ETL compared (fullName, preferredName), distinct. */
  scholarNames: string[];
  title: string | null;
  department: string | null;
  /** The tab the card sits in: its best candidate's band, or conflicts /
   *  email verified (`cardTabOf`). */
  tab: OrcidQueueTab;
  candidates: OrcidQueueRow[];
};

/** What the page hands the client: one tab's cards and every tab's count
 *  (scholars, not pairs), under one filter. */
export type OrcidQueueData = {
  tab: OrcidQueueTab;
  cards: OrcidQueueCard[];
  counts: Record<OrcidQueueTab, number>;
  filter: OrcidQueueFilter;
  /** The band's latest sample (Strong / Shared papers only). */
  sample: OrcidQueueSampleState | null;
  /** Rows a passed sample's "Confirm remaining N" would confirm now. */
  remaining: number | null;
};

/** Band strength: 0 = strongest. Pure. */
export function bandRank(band: string): number {
  const i = (ORCID_QUEUE_BANDS as readonly string[]).indexOf(band);
  return i < 0 ? ORCID_QUEUE_BANDS.length : i;
}

/** The tab a scholar's card sits in: email verified when the ETL confirmed one
 *  of their iDs, Conflicts when another iD is on file, else the best band among
 *  their open candidates. Pure. */
export function cardTabOf(
  candidates: ReadonlyArray<Pick<OrcidQueueRow, "band" | "state">>,
): OrcidQueueTab {
  if (candidates.some((c) => c.state === "auto_confirmed")) return "email_verified";
  if (candidates.some((c) => c.state === "conflict")) return "conflicts";
  const best = [...candidates].sort((a, b) => bandRank(a.band) - bandRank(b.band))[0];
  return best ? best.band : "weak";
}

/** Best candidate first: band, then shared papers, then name agreement. Pure. */
export function compareCandidates(
  a: Pick<OrcidQueueRow, "band" | "shared" | "nameAgrees" | "orcid">,
  b: Pick<OrcidQueueRow, "band" | "shared" | "nameAgrees" | "orcid">,
): number {
  return (
    bandRank(a.band) - bandRank(b.band) ||
    b.shared - a.shared ||
    Number(b.nameAgrees) - Number(a.nameAgrees) ||
    a.orcid.localeCompare(b.orcid)
  );
}

/** The filter from page search params, lenient: unknown values are dropped,
 *  not refused (a mangled link narrows less, never errors). Pure. */
export function parseOrcidQueueFilter(
  raw: Record<string, string | string[] | undefined>,
): OrcidQueueFilter {
  const list = (k: string) => {
    const v = raw[k];
    return (Array.isArray(v) ? v : v === undefined ? [] : [v]).map((x) => x.trim()).filter(Boolean);
  };
  const uniq = <T extends string>(xs: T[]) => [...new Set(xs)].sort() as T[];
  const f: OrcidQueueFilter = {
    types: uniq(list("type").filter((t) => t.length <= 72)).slice(0, MAX_FILTER_VALUES),
    units: uniq(list("unit").filter((u) => QUEUE_UNIT.test(u))).slice(0, MAX_FILTER_VALUES),
    sources: uniq(list("source").filter(isOrcidCandidateSource)),
  };
  // Too long to store as a sample's key: drop the last values until it fits.
  while (orcidQueueFilterKey(f).length > MAX_FILTER_KEY_LENGTH) {
    if (f.units.length > 0) f.units.pop();
    else if (f.types.length > 0) f.types.pop();
    else f.sources.pop();
  }
  return f;
}
