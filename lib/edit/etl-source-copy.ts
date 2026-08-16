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
export type EtlSourceOrigin = "external" | "internal";

export type EtlSourceCopy = {
  /** What this import gives a reader, in their words. */
  readonly label: string;
  /** One sentence on what breaks on a profile when it stops. */
  readonly description: string;
  /**
   * `"external"` — this import's DATA comes from a system nobody on this repo
   * operates (NIH, NSF, Gates, PubMed, the WCM Enterprise Directory, ASMS,
   * Jenzabar, POPS, ReCiterDB, ReCiterAI's S3/DynamoDB artifacts, ...). A
   * failure here is frequently "wait for them" or "tell that team," not
   * "restart our container."
   * `"internal"` — this import only reads and recomputes data already sitting
   * in this app's own Aurora tables (a health check, a stats rollup, an
   * index/cache rebuild, a cross-reference between two tables we already
   * populated). A failure here is ours to fix.
   *
   * Deliberately NOT the `external` flag in `cdk/lib/etl-stack.ts` — that one
   * means "needs a Secrets Manager credential wired," a build/deploy concern
   * that disagrees with this in both directions: NSF/NIH RePORTER are public,
   * no-credential APIs (cdk marks some `external:false`) despite plainly being
   * outside data sources, and Headshot hits directory.weill.cornell.edu the
   * same way. This field is graded from what each entrypoint actually reads
   * at runtime (etl/<name>/index.ts and its one-hop imports), not from how
   * its ECS task is wired.
   */
  readonly origin: EtlSourceOrigin;
};

export const SOURCE_COPY: Readonly<Record<string, EtlSourceCopy>> = {
  ED: {
    label: "People & Appointments",
    description: "Who has a profile, plus name, title, rank, department and division.",
    origin: "external", // WCM Enterprise Directory (LDAP)
  },
  "ED-Admins": {
    label: "Department Editor Access",
    description: "Sets which staff may edit the profiles in their department, division or center.",
    origin: "external", // WCM Enterprise Directory (LDAP)
  },
  ReCiter: {
    label: "Publications",
    description: "Journal articles on each profile, with authors, journal, year and DOI.",
    origin: "external", // sibling ReCiterDB
  },
  "ReCiter-COI-Statements": {
    label: "Competing Interest Statements",
    description: "The competing-interests note on each paper; feeds Conflict-of-Interest Gaps.",
    origin: "external", // sibling ReCiterDB
  },
  ASMS: {
    label: "Education & Training",
    description: "Degrees, schools and training years in the Education panel.",
    origin: "external", // ASMS (MSSQL)
  },
  InfoEd: {
    label: "Grants & Funding",
    description: "Grant awards and funding history: sponsor, title, role and dates.",
    origin: "external", // InfoEd (MSSQL)
  },
  COI: {
    label: "Conflict-of-Interest Disclosures",
    description: "Outside organization ties in the profile's External relationships section.",
    origin: "external", // WCM COI system (MySQL)
  },
  "COI-Gap": {
    label: "Conflict-of-Interest Gaps",
    description: "Companies named in a scholar's papers that their disclosures don't list.",
    origin: "internal", // cross-references two tables this app already populated
  },
  Jenzabar: {
    label: "PhD Thesis Advisors",
    description: "PhD and MD-PhD thesis advisor and student pairs in the Mentoring list.",
    origin: "external", // Jenzabar (MSSQL)
  },
  "ReCiterAI-projection": {
    label: "Research Topics & Scores",
    description: "Research topic pages, their ranked scholars, and per-paper impact scores.",
    origin: "external", // ReCiterAI-published DynamoDB records
  },
  "Identity-orcid": {
    label: "ORCID Researcher IDs",
    description: "Each scholar's ORCID iD, used by search engines and shown in the editor.",
    origin: "external", // WCM Identity DynamoDB table
  },
  Tools: {
    label: "Methods & Tools",
    description: "Fills the Methods & tools list of techniques and models on profiles.",
    origin: "external", // ReCiterAI-published S3 artifacts
  },
  FamilySensitivity: {
    label: "Sensitive Method Gating",
    description: "Hides animal-model methods from public profiles; owners and admins see them.",
    origin: "internal", // curated CSV checked into this repo, no live outside read
  },
  FamilySuppression: {
    label: "Hidden Generic Methods",
    description: "Hides generic methods, like common statistical tests, from all profiles.",
    origin: "internal", // curated CSV checked into this repo, no live outside read
  },
  MeshCoverage: {
    label: "Search Topic Weighting",
    description: "Measures how common each subject heading is in WCM papers, to rank search.",
    origin: "internal", // recomputed from this app's own publication/mesh tables
  },
  MeshAnchor: {
    label: "Research Area Links",
    description: "Links paper subject headings to the research areas people browse by.",
    origin: "internal", // curated CSV + this app's own tables
  },
  MeshAlias: {
    label: "Search Term Synonyms",
    description: "Maps WCM specialty names, like Cardiothoracic Surgery, to subject headings.",
    origin: "internal", // curated CSV checked into this repo, no live outside read
  },
  PubMedRetractions: {
    label: "Retracted Paper Removal",
    description: "Removes papers PubMed has retracted from profiles and search results.",
    origin: "external", // PubMed E-utilities
  },
  SearchIndex: {
    label: "Site Search Refresh",
    description: "Refreshes search for people, publications, grants and funding opportunities.",
    origin: "internal", // rebuilds this app's own OpenSearch index from Aurora
  },
  Revalidate: {
    label: "Public Page Refresh",
    description: "Refreshes the home, topic, department and browse pages with new data.",
    origin: "internal", // this app's own /api/revalidate
  },
  Integrity: {
    label: "Nightly Data Health Check",
    description: "Checks each night's updates produced sensible data, and alerts if not.",
    origin: "internal", // checks this app's own OpenSearch count against its own Aurora rows
  },
  Completeness: {
    label: "Profile Completeness Stats",
    description: "Weekly tally of profiles that have an overview and a confirmed publication.",
    origin: "internal", // stats rollup over this app's own Aurora tables
  },
  Headshot: {
    label: "Profile Photo Check",
    description: "Checks which scholars are missing a photo in the campus directory.",
    origin: "external", // directory.weill.cornell.edu
  },
  CancerCenterCollabReport: {
    label: "Cancer Center Collaboration Report",
    description: "Weekly collaboration and cancer-relevance numbers behind a Cancer Center's Reports tab.",
    origin: "internal", // Aurora-only rollup
  },
  Reporter: {
    label: "NIH Award Details",
    description: "Adds NIH award summaries and the papers each award funded.",
    origin: "external", // NIH RePORTER + sibling ReCiterDB
  },
  NSF: {
    label: "NSF Award Summaries",
    description: "Adds project summaries to National Science Foundation awards.",
    origin: "external", // NSF Awards API
  },
  Gates: {
    label: "Gates Foundation Summaries",
    description: "Adds project summaries to Gates Foundation awards.",
    origin: "external", // Gates Foundation public CSV
  },
  NihProfile: {
    label: "NIH Researcher Match",
    description: "Matches scholars to their NIH researcher ID for the NIH portfolio link.",
    origin: "external", // NIH RePORTER
  },
  POPS: {
    label: "Clinical Specialties",
    description: "Adds board certifications and specialties so clinicians turn up in search.",
    origin: "external", // WCM POPS physician directory
  },
  ReporterGrants: {
    label: "NIH Awards From Elsewhere",
    description: "Adds NIH awards from prior institutions to a scholar's funding list.",
    origin: "external", // NIH RePORTER
  },
  ClinicalTrials: {
    label: "Clinical Trials",
    description: "Adds the clinical trials each scholar leads or takes part in.",
    origin: "external", // sibling ReCiterDB
  },
  DataSharing: {
    label: "Dataset Deposits",
    description: "Adds a scholar's shared research datasets to their profile's Datasets section.",
    origin: "external", // sibling ReCiterDB
  },
  Technology: {
    label: "Available Technologies",
    description: "Adds a scholar's licensable inventions from the WCM technology portfolio.",
    origin: "external", // innovation.weill.cornell.edu
  },
  News: {
    label: "News Mentions",
    description: "Adds WCM Newsroom stories that mention a scholar to their profile.",
    origin: "external", // news.weill.cornell.edu
  },
  Spotlight: {
    label: "Homepage Spotlight",
    description: "Refreshes the Spotlight research cards on the home page.",
    origin: "external", // ReCiterAI-published S3 artifacts
  },
  Hierarchy: {
    label: "Research Subareas",
    description: "Refreshes the subarea names listed under each research area.",
    origin: "external", // ReCiterAI-published S3 artifacts
  },
  SearchReconcile: {
    label: "Search Update Safety Net",
    description: "Retries a hide or suppression that didn't reach search results the first time.",
    origin: "internal", // reconciles this app's own OpenSearch state against Aurora
  },
  CdnReconcile: {
    label: "Cached Page Refresh Retries",
    description: "Retries clearing a page's cached copy after an edit, so visitors stop seeing the old version.",
    origin: "internal", // this app's own CloudFront invalidation
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

/** @see EtlSourceCopy.origin. Null for a source this map hasn't caught up with. */
export function sourceOrigin(source: string): EtlSourceOrigin | null {
  return SOURCE_COPY[source]?.origin ?? null;
}
