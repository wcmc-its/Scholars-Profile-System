/**
 * Thin OpenAlex client + pure parsers for the matched-researcher eminence
 * covariates (h-index + scholarly age) used by the rival benchmark.
 *
 * Why OpenAlex, and why ONE source for everyone: a fair platform-vs-platform
 * head-to-head must control for researcher eminence, and that control is only
 * meaningful if WCM and every rival are measured on the SAME ruler. OpenAlex is
 * free, covers all institutions uniformly, returns `summary_stats.h_index`
 * directly, and exposes earliest-work year for academic age. We deliberately do
 * NOT mix in our own PubMed/reciter citation counts (a different citation
 * universe) for the cross-institution comparison.
 *
 * No API key. Set OPENALEX_MAILTO to join OpenAlex's faster "polite pool".
 * Everything except the `*fetch*`/`resolve*` functions is pure and network-free.
 */

const API = "https://api.openalex.org";

/** The slice of an OpenAlex author object we consume. */
export interface OpenAlexAuthor {
  id: string;
  display_name: string;
  works_count?: number;
  cited_by_count?: number;
  orcid?: string | null;
  summary_stats?: {
    h_index?: number;
    i10_index?: number;
    "2yr_mean_citedness"?: number;
  };
  last_known_institutions?: Array<{ id: string; display_name: string }>;
  affiliations?: Array<{ institution: { id: string; display_name: string } }>;
}

export interface EminenceResult {
  openalexId: string | null;
  matchedName: string | null;
  hIndex: number | null;
  academicAge: number | null;
  source: "openalex";
}

/** h-index straight from OpenAlex summary stats (null when missing). */
export function parseHIndex(author: OpenAlexAuthor | null | undefined): number | null {
  const h = author?.summary_stats?.h_index;
  return typeof h === "number" ? h : null;
}

/** All institution display names attached to an author (last-known + affiliations). */
export function institutionNamesOf(author: OpenAlexAuthor): string[] {
  const names = [
    ...(author.last_known_institutions ?? []).map((i) => i.display_name),
    ...(author.affiliations ?? []).map((a) => a.institution?.display_name),
  ].filter((n): n is string => Boolean(n));
  return [...new Set(names.map((n) => n.toLowerCase()))];
}

/**
 * Pick the best author candidate. Prefer one whose institutions include the
 * expected institution (case-insensitive substring, either direction), then the
 * most prolific (works_count). Returns null on an empty list.
 */
export function pickBestAuthor(
  authors: OpenAlexAuthor[],
  opts: { institution?: string } = {},
): OpenAlexAuthor | null {
  if (authors.length === 0) return null;
  const inst = opts.institution?.trim().toLowerCase();
  const byWorks = (a: OpenAlexAuthor, b: OpenAlexAuthor) =>
    (b.works_count ?? 0) - (a.works_count ?? 0);
  if (inst) {
    const matches = authors.filter((a) =>
      institutionNamesOf(a).some((n) => n.includes(inst) || inst.includes(n)),
    );
    if (matches.length) return [...matches].sort(byWorks)[0];
  }
  return [...authors].sort(byWorks)[0];
}

/** Earliest publication year across a list of works (null if none/unknown). */
export function earliestYearFromWorks(
  works: Array<{ publication_year?: number }>,
): number | null {
  const years = works.map((w) => w.publication_year).filter((y): y is number => typeof y === "number");
  return years.length ? Math.min(...years) : null;
}

/** Academic age = years since first publication (null if firstYear unknown). */
export function academicAge(
  firstPublicationYear: number | null,
  referenceYear: number,
): number | null {
  if (firstPublicationYear === null) return null;
  return Math.max(0, referenceYear - firstPublicationYear);
}

/** Strip the OpenAlex id down to its bare key (`A5023888391`) for filters. */
export function openAlexKey(id: string): string {
  return id.replace(/^https?:\/\/openalex\.org\//, "");
}

// ── network ───────────────────────────────────────────────────────────────

function withMailto(url: string, mailto: string | undefined): string {
  if (!mailto) return url;
  return url + (url.includes("?") ? "&" : "?") + `mailto=${encodeURIComponent(mailto)}`;
}

async function getJson<T>(url: string, mailto: string | undefined): Promise<T> {
  const res = await fetch(withMailto(url, mailto), { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`OpenAlex HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  return (await res.json()) as T;
}

function mailtoFromEnv(env: Record<string, string | undefined> = process.env): string | undefined {
  return env.OPENALEX_MAILTO?.trim() || undefined;
}

/** Look up an author by ORCID (bare `0000-...` or full URL). Null if not found. */
export async function authorByOrcid(
  orcid: string,
  mailto = mailtoFromEnv(),
): Promise<OpenAlexAuthor | null> {
  const bare = orcid.replace(/^https?:\/\/orcid\.org\//, "");
  const url = `${API}/authors?filter=orcid:${encodeURIComponent(bare)}&per-page=1`;
  const body = await getJson<{ results?: OpenAlexAuthor[] }>(url, mailto);
  return body.results?.[0] ?? null;
}

/** Search authors by display name (relevance-ordered). */
export async function searchAuthorsByName(
  name: string,
  mailto = mailtoFromEnv(),
  perPage = 10,
): Promise<OpenAlexAuthor[]> {
  const url = `${API}/authors?search=${encodeURIComponent(name)}&per-page=${perPage}`;
  const body = await getJson<{ results?: OpenAlexAuthor[] }>(url, mailto);
  return body.results ?? [];
}

/** Earliest publication year for an OpenAlex author id. */
export async function earliestWorkYear(
  authorId: string,
  mailto = mailtoFromEnv(),
): Promise<number | null> {
  const key = openAlexKey(authorId);
  const url = `${API}/works?filter=author.id:${key}&sort=publication_year:asc&per-page=1`;
  const body = await getJson<{ results?: Array<{ publication_year?: number }> }>(url, mailto);
  return earliestYearFromWorks(body.results ?? []);
}

/**
 * Resolve h-index + academic age for one researcher. Prefers ORCID (reliable);
 * falls back to name + institution search. `referenceYear` is passed in so the
 * caller controls "now" (and tests stay deterministic).
 */
export async function resolveEminence(
  who: { orcid?: string | null; name: string; institution?: string },
  referenceYear: number,
  mailto = mailtoFromEnv(),
): Promise<EminenceResult> {
  let author: OpenAlexAuthor | null = null;
  if (who.orcid) author = await authorByOrcid(who.orcid, mailto);
  if (!author) {
    const candidates = await searchAuthorsByName(who.name, mailto);
    author = pickBestAuthor(candidates, { institution: who.institution });
  }
  if (!author) {
    return { openalexId: null, matchedName: null, hIndex: null, academicAge: null, source: "openalex" };
  }
  const firstYear = await earliestWorkYear(author.id, mailto);
  return {
    openalexId: author.id,
    matchedName: author.display_name,
    hIndex: parseHIndex(author),
    academicAge: academicAge(firstYear, referenceYear),
    source: "openalex",
  };
}
