/**
 * Plain-language names and one-line descriptions for the imports listed on
 * `/edit/etl-status`.
 *
 * The keys are `etl_run.source` strings — the exact values the ETLs write, the
 * same keys `TRACKED` in `lib/etl/freshness-policy.ts` is keyed by. They read
 * like internal jargon because they ARE internal jargon (`COI-Gap`,
 * `ReCiterAI-projection`), and the audience for that page is a non-technical
 * superuser deciding whether anything on it is their problem. So the page shows
 * the label first and keeps the raw key beside it in small type, which is what
 * anyone reporting the problem onward to ITS has to quote.
 *
 * Copy only. This module imports NOTHING — same rule as freshness-policy, and
 * for the same reason: it has to stay safe to pull into any surface, including
 * one that ends up in the client bundle.
 *
 * A source with no entry here is NOT an error: `sourceLabel` falls back to the
 * raw key, so a newly tracked import renders as itself rather than as a blank
 * line on a status board. Adding the copy is a follow-up, not a prerequisite.
 */
export type EtlSourceCopy = {
  /** What this import gives a reader, in their words. */
  readonly label: string;
  /** One sentence on what breaks on a profile when it stops. */
  readonly description: string;
};

export const SOURCE_COPY: Readonly<Record<string, EtlSourceCopy>> = {
  ED: {
    label: "People & Appointments",
    description: "Who has a profile, plus name, title, rank, department and division.",
  },
  "ED-Admins": {
    label: "Department Editor Access",
    description: "Sets which staff may edit the profiles in their department, division or center.",
  },
  ReCiter: {
    label: "Publications",
    description: "Journal articles on each profile, with authors, journal, year and DOI.",
  },
  "ReCiter-COI-Statements": {
    label: "Competing Interest Statements",
    description: "The competing-interests note on each paper; feeds Conflict-of-Interest Gaps.",
  },
  ASMS: {
    label: "Education & Training",
    description: "Degrees, schools and training years in the Education panel.",
  },
  InfoEd: {
    label: "Grants & Funding",
    description: "Grant awards and funding history: sponsor, title, role and dates.",
  },
  COI: {
    label: "Conflict-of-Interest Disclosures",
    description: "Outside organization ties in the profile's External relationships section.",
  },
  "COI-Gap": {
    label: "Conflict-of-Interest Gaps",
    description: "Companies named in a scholar's papers that their disclosures don't list.",
  },
  Jenzabar: {
    label: "PhD Thesis Advisors",
    description: "PhD and MD-PhD thesis advisor and student pairs in the Mentoring list.",
  },
  "ReCiterAI-projection": {
    label: "Research Topics & Scores",
    description: "Research topic pages, their ranked scholars, and per-paper impact scores.",
  },
  "Identity-orcid": {
    label: "ORCID Researcher IDs",
    description: "Each scholar's ORCID iD, used by search engines and shown in the editor.",
  },
  Tools: {
    label: "Methods & Tools",
    description: "Fills the Methods & tools list of techniques and models on profiles.",
  },
  FamilySensitivity: {
    label: "Sensitive Method Gating",
    description: "Hides animal-model methods from public profiles; owners and admins see them.",
  },
  FamilySuppression: {
    label: "Hidden Generic Methods",
    description: "Hides generic methods, like common statistical tests, from all profiles.",
  },
  MeshCoverage: {
    label: "Search Topic Weighting",
    description: "Measures how common each subject heading is in WCM papers, to rank search.",
  },
  MeshAnchor: {
    label: "Research Area Links",
    description: "Links paper subject headings to the research areas people browse by.",
  },
  MeshAlias: {
    label: "Search Term Synonyms",
    description: "Maps WCM specialty names, like Cardiothoracic Surgery, to subject headings.",
  },
  PubMedRetractions: {
    label: "Retracted Paper Removal",
    description: "Removes papers PubMed has retracted from profiles and search results.",
  },
  SearchIndex: {
    label: "Site Search Refresh",
    description: "Refreshes search for people, publications, grants and funding opportunities.",
  },
  Revalidate: {
    label: "Public Page Refresh",
    description: "Refreshes the home, topic, department and browse pages with new data.",
  },
  Integrity: {
    label: "Nightly Data Health Check",
    description: "Checks each night's updates produced sensible data, and alerts if not.",
  },
  Completeness: {
    label: "Profile Completeness Stats",
    description: "Weekly tally of profiles that have an overview and a confirmed publication.",
  },
  Headshot: {
    label: "Profile Photo Check",
    description: "Checks which scholars are missing a photo in the campus directory.",
  },
  Reporter: {
    label: "NIH Award Details",
    description: "Adds NIH award summaries and the papers each award funded.",
  },
  NSF: {
    label: "NSF Award Summaries",
    description: "Adds project summaries to National Science Foundation awards.",
  },
  Gates: {
    label: "Gates Foundation Summaries",
    description: "Adds project summaries to Gates Foundation awards.",
  },
  NihProfile: {
    label: "NIH Researcher Match",
    description: "Matches scholars to their NIH researcher ID for the NIH portfolio link.",
  },
  POPS: {
    label: "Clinical Specialties",
    description: "Adds board certifications and specialties so clinicians turn up in search.",
  },
  ReporterGrants: {
    label: "NIH Awards From Elsewhere",
    description: "Adds NIH awards from prior institutions to a scholar's funding list.",
  },
  ClinicalTrials: {
    label: "Clinical Trials",
    description: "Adds the clinical trials each scholar leads or takes part in.",
  },
  Technology: {
    label: "Available Technologies",
    description: "Adds a scholar's licensable inventions from the WCM technology portfolio.",
  },
  News: {
    label: "News Mentions",
    description: "Adds WCM Newsroom stories that mention a scholar to their profile.",
  },
  Spotlight: {
    label: "Homepage Spotlight",
    description: "Refreshes the Spotlight research cards on the home page.",
  },
  Hierarchy: {
    label: "Research Subareas",
    description: "Refreshes the subarea names listed under each research area.",
  },
  SearchReconcile: {
    label: "Search Update Safety Net",
    description: "Retries a hide or suppression that didn't reach search results the first time.",
  },
  CdnReconcile: {
    label: "Cached Page Refresh Retries",
    description: "Retries clearing a page's cached copy after an edit, so visitors stop seeing the old version.",
  },
};

/**
 * The name to show for a source. Falls back to the raw `etl_run.source` key: a
 * source this map has not caught up with yet must render as itself, never as a
 * blank name on a row that is otherwise telling somebody something is wrong.
 */
export function sourceLabel(source: string): string {
  return SOURCE_COPY[source]?.label ?? source;
}

/** The one-line description, or null when there is none to show yet. */
export function sourceDescription(source: string): string | null {
  return SOURCE_COPY[source]?.description ?? null;
}
