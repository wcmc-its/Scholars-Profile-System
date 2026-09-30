/**
 * Methods documentation builder for `/edit/data-sharing` — the narrative
 * companion to `lib/api/data-sharing-report.ts`'s numbers: a glossary, eight
 * prose sections, and the "one paragraph for reporting" block, all built from
 * an already-loaded report. Consumed two ways: the Methods dialog
 * (`components/edit/data-sharing-methods.tsx`, a client island) and the
 * `?section=methods` markdown download (`app/edit/data-sharing/export/
 * route.ts`, via `methodsMarkdown`).
 *
 * PURE MODULE — no prisma/db imports, no side effects, importable from a
 * client component. The report parameter is typed structurally
 * (`MethodsDocReport`, a Pick of what this file actually reads) and the one
 * `DataSharingReport` import is type-only (erased at compile time), so this
 * file can never drag `@/lib/db` or the mariadb driver into the client
 * bundle — the exact `manageable-units` trap CLAUDE.md documents.
 *
 * Content ground rules (don't drift these when editing prose):
 * - The tier-only "concerning" caveat (SPEC "Amended 08-13") must never be
 *   softened — see the "Access model and risk tier" section.
 * - Registry separation is load-bearing: counting ClinicalTrials.gov as data
 *   sharing would roughly double every number. State the boundary PRECISELY:
 *   the rates exclude registry (`depositedPmidSet` skips those rows since the
 *   2026-08-16 v3 review finding) while the headline dataset/faculty/link
 *   totals include it — a blanket "excluded everywhere" claim was that
 *   finding, don't reintroduce one.
 * - Every figure is the strict floor (confirmed deposits only) and the prose
 *   says so.
 * - The reporting paragraph's word count is asserted at 180–220 in
 *   `tests/unit/data-sharing-methods-doc.test.ts`; every interpolated number
 *   is exactly one whitespace-delimited token (`en-US` grouping has no
 *   spaces), so the count is deterministic regardless of the numbers'
 *   magnitude. Rewording the paragraph means re-balancing that count.
 */
import type { DataSharingReport } from "@/lib/api/data-sharing-report";

/** Glossary for the Methods dialog + markdown export — term → definition.
 *  Rendered by the "Glossary" section as "Term — definition" lines. Keep
 *  definitions self-contained (each may be read alone in a tooltip some day)
 *  and keep the Country-of-concern entry's host-jurisdiction-not-nationality
 *  clause: conflating the two is the misreading this glossary exists to
 *  prevent. */
export const DATA_SHARING_TERMS: Record<string, string> = {
  "Country of concern":
    "A repository hosted in a jurisdiction on the DOJ Bulk Data Rule countries-of-concern list: " +
    "China (including Hong Kong and Macau), Russia, Iran, North Korea, Cuba, and Venezuela. " +
    "Classification is by the repository's HOST jurisdiction, not by any author's nationality or affiliation.",
  // Split into two entries (2026-08-16 review finding), not one shared
  // "Foreign-hosted" definition for both tiers — a hover that reads
  // identically for the open and controlled tiers implies a distinction
  // that carries no information; each entry now states its own access model.
  "Foreign-hosted, open":
    "A repository operated outside the US, e.g. EMBL-EBI or CERN infrastructure, whose access " +
    "model is open (bulk download, no review step). Descriptive, not itself a violation.",
  "Foreign-hosted, controlled":
    "A repository operated outside the US, e.g. EGA, whose access model is controlled (requires " +
    "an application or data-use agreement). Descriptive, not itself a violation.",
  // Neutral, access-model-agnostic entry — for the ONE place this page sums
  // both foreign-hosted tiers together (the faculty table's combined
  // "Foreign-hosted" column, NamedFacultyRow.foreignHostedDeposits): using
  // either access-specific entry above for that summed column would falsely
  // claim the whole column shares one access model (2026-08-16
  // adversarial-review finding).
  "Foreign-hosted":
    "A repository operated outside the US — open- and controlled-access foreign-hosted " +
    "repositories combined. Descriptive, not itself a violation.",
  // Deliberately broader than "Country of concern": the Concerning column/flag
  // counts the union of the three highest-severity tiers, and a hover that led
  // with only the country-of-concern definition overstated severity for rows
  // whose deposits are merely foreign-hosted (review finding, v3 pass).
  Concerning:
    "A deposit in a repository hosted in a country of concern, OR in any foreign-hosted " +
    "repository: the union of the three highest-severity tiers, counted per deposit " +
    "instance, not per distinct dataset.",
  "Open access": "Bulk download without an access-review step.",
  "Controlled access":
    "Access requires an application or data-use agreement, e.g. dbGaP or EGA, " +
    "the compliant path for sensitive data.",
  Registry:
    "Trial-registration metadata such as ClinicalTrials.gov, not bulk microdata; " +
    "excluded from every deposit rate (share rate, access split, funding lens) " +
    "and shown in its own registry buckets.",
  "Strict floor": "Confirmed deposits only; a floor, not a census of all sharing.",
  "Deposit instance":
    "One (person, dataset) link row: a dataset with three depositing faculty counts three instances.",
  PMC:
    "PubMed Central, NIH's full-text archive; the full-text scan can only inspect papers " +
    "whose full text is deposited there. As of 2026-08-16 the PMC-identifier field this " +
    "dashboard reads is a known data-quality gap, see the Methods dialog's PMC section.",
  "Share rate":
    "n/N of confirmed first/last-authored, full-time-faculty eligible publications with at " +
    "least one detected deposit.",
};

/** The slice of `DataSharingReport` this builder actually reads — structural
 *  on purpose so tests can pass a hand-built literal and so this stays a
 *  compile-time-only coupling to the report lib (see the module header).
 *  `byRepository`/`byDepartment` are only read for `.length`. */
export type MethodsDocReport = {
  overall: Pick<
    DataSharingReport["overall"],
    | "datasets"
    | "faculty"
    | "shareRateDenominator"
    | "shareRateNumerator"
    | "pmcCoveredPubs"
    | "pmcDepositedPubs"
    | "openPubs"
    | "controlledPubs"
  >;
  byRepository: readonly unknown[];
  byDepartment: readonly unknown[];
};

export type MethodsDoc = {
  sections: { heading: string; body: string }[];
  /** The ~200-word reporting paragraph — states the denominator explicitly,
   *  keeps the strict-floor framing. Word count asserted 180–220 in tests. */
  paragraph: string;
};

/** `en-US` pinned so grouping is always a comma (never a locale-dependent
 *  space, which would split one number into two words and break the
 *  paragraph's asserted word count). */
function num(n: number): string {
  return n.toLocaleString("en-US");
}

/** Whole-number percent as a string; a zero denominator reads "0" rather than
 *  "NaN" (same degrade-to-zero spirit as the report's backward-compat
 *  defaults — this doc must render sanely on an empty report too). */
function pct(numerator: number, denominator: number): string {
  if (denominator === 0) return "0";
  return String(Math.round((numerator / denominator) * 100));
}

/** Build the Methods document from an already-loaded report. `opts
 *  .shareRateYearFloor` is threaded in (rather than imported from the report
 *  lib) to keep this module's only report-lib coupling type-only — pass
 *  `SHARE_RATE_YEAR_FLOOR`. */
export function buildMethodsDoc(
  report: MethodsDocReport,
  opts: { shareRateYearFloor: number },
): MethodsDoc {
  const o = report.overall;
  const floor = opts.shareRateYearFloor;
  const denominator = o.shareRateDenominator;

  const sections: { heading: string; body: string }[] = [
    {
      heading: "Corpus and denominator",
      body:
        `The denominator is every confirmed first- or last-authored Weill Cornell Medicine publication of type ` +
        `Academic Article or Preprint, published in ${floor} or later, by full-time faculty: ` +
        `${num(denominator)} publications. The ${floor} floor is a coverage window, not an editorial choice. ` +
        `The deposit-detection pipeline never scanned earlier publications, so counting them would manufacture ` +
        `"no detected deposit" for papers that were simply never checked. Other publication types are excluded ` +
        `for the same reason: the pipeline never scans them, so they would inflate the denominator with ` +
        `publications that have zero chance of contributing to the numerator. The full-time-faculty scope ` +
        `matches the numerator's own extraction pipeline ("fullTimeFaculty='yes'"), closing an asymmetry a ` +
        `prior version of this denominator left open.`,
    },
    {
      heading: "Extraction and attribution",
      body:
        `Deposits come from two arms: PubMed's structured DataBankList field, and a scan of Data Availability ` +
        `statements in PubMed Central full text. Author attribution uses ReCiter's identity disambiguation, so a ` +
        `deposit is credited to a specific person rather than a name string. Each detected mention is classified ` +
        `as a genuine deposit versus reuse of someone else's dataset, and reuse is not counted. Everything on ` +
        `the dashboard is the strict band: confirmed deposits only, no generous or estimated ceiling, because ` +
        `only high-confidence rows are persisted at all. Deposits are deduplicated on the (person, repository, ` +
        `accession) triple: the same dataset cited from several of one author's papers counts once per person, ` +
        `while a dataset with three depositing faculty legitimately counts three deposit instances.`,
    },
    {
      heading: "PMC coverage (known data-quality gap)",
      body:
        `${num(o.pmcCoveredPubs)} of the ${num(denominator)} corpus publications (${pct(o.pmcCoveredPubs, denominator)}%) ` +
        `carry a PubMed Central identifier in SPS today. A 2026-08-16 spot-check found that same field reads ` +
        `roughly 100% across the ENTIRE SPS publication table, not just this corpus, which is not plausible as ` +
        `genuine full-text-in-PMC coverage across pre-2008 papers, non-NIH-funded work, and non-biomedical ` +
        `journals — whatever percentage the corpus figure above shows, treat it against that finding, not at ` +
        `face value. The identifier field is sourced from a separate upstream system this dashboard does not ` +
        `control, and it is not currently a trustworthy signal of full-text availability. This dashboard reports ` +
        `the raw count without treating it as a bounding denominator for full-text-detected deposits until that ` +
        `upstream field is verified; see "Known gaps."`,
    },
    {
      heading: "Access model and risk tier",
      body:
        `Every repository is assigned a tier from the 36-repository catalog: host jurisdiction crossed with ` +
        `access model. The six tiers, most to least severe, are country-of-concern hosted, foreign-hosted open, ` +
        `foreign-hosted controlled, US-hosted open, US-hosted controlled, and registry. "Concerning" on this ` +
        `dashboard is tier-derived ONLY: a deposit in a country-of-concern-hosted or foreign-hosted repository. ` +
        `It does NOT include sensitive-data-type detection (an open deposit of a sensitive data category), which ` +
        `requires raw MeSH terms per citing publication and is not yet built; do not read the concerning counts ` +
        `as that fuller three-way definition. Zero rows are printed deliberately, so a line reading "Country of ` +
        `concern: 0" is a statement that we checked and found none, not an absence of data. A tier is the ` +
        `catalog's platform-level classification, not a per-deposit fact, so a specific repository's actually ` +
        `observed access model (the Access column) can disagree with what its tier name implies.`,
    },
    {
      heading: "Registry separation",
      body:
        `ClinicalTrials.gov and similar registries hold trial-registration metadata, not bulk microdata. ` +
        `Registering a trial is not sharing a dataset. Counting registrations as data sharing would roughly ` +
        `double every number on this dashboard, so registry rows never count toward any publication-grain ` +
        `deposit figure: the share-rate numerator, the open/controlled access split, and the funding-lens ` +
        `population all exclude them (as does the PMC-deposited count feeding the PMC section's raw figures, ` +
        `for the same reason — but see that section's own known-gap caveat before leaning on it). Registry ` +
        `deposits are shown in their own ` +
        `explicitly labeled buckets (the registry tier and the department table's Registry column), and they ` +
        `DO remain inside the headline distinct-dataset, distinct-faculty, and link totals. Those totals ` +
        `describe everything the pipeline detected, with the registry buckets keeping the registration share ` +
        `visible rather than hidden inside an undifferentiated count. If a future consumer wants registrations ` +
        `included in the rates, that must ship as a new, clearly labeled figure, never as a silent widening ` +
        `of the deposit counts reported here.`,
    },
    {
      heading: "Funding lens",
      body:
        `"NIH-funded" means the publication has at least one linked grant carrying a non-null NIH ` +
        `institute/center code, a field populated only for NIH awards. "Not NIH-funded" is therefore the precise ` +
        `claim, and it is NOT the same as "non-federal": funding from other federal agencies (CDC, NSF, and the ` +
        `like) is indistinguishable from genuinely non-federal support with this field, and all of it lands in ` +
        `the not-NIH-funded bucket. The split is computed over the same non-registry deposited-publication ` +
        `population as the access-model split, so the two lenses describe the same set of publications and can ` +
        `be read side by side without a denominator mismatch; the dashboard states that shared total explicitly ` +
        `next to the split so it is never left as an implied subtraction from the headline corpus.`,
    },
    {
      heading: "Known gaps",
      body:
        `Four known gaps. The PMC-identifier field this dashboard reads for "in PMC" coverage is non-null for ` +
        `99.7% of every publication in SPS, not just this corpus, which is not a credible full-text-availability ` +
        `rate; treat the PMC figures here as an open data-quality question pending investigation of that ` +
        `upstream field, not a working denominator. No per-item discovery timestamp: every row is stamped with ` +
        `the same sync time on each weekly refresh, so a deposit found this week and one found months ago are ` +
        `indistinguishable. "Recent activity" means deposit year, not detection date. The country-of-concern ` +
        `coauthor pull is not yet ingested, so "concerning" remains tier-only. And a repository's tier is a ` +
        `platform-level classification from the shared risk catalog, not a per-deposit fact, so it can disagree ` +
        `with an individual repository's actually observed access model.`,
    },
    {
      heading: "Glossary",
      body: Object.entries(DATA_SHARING_TERMS)
        .map(([term, definition]) => `${term} — ${definition}`)
        .join("\n"),
    },
  ];

  // Reporting paragraph — whitespace-delimited word count asserted 180-220 in
  // tests/unit/data-sharing-methods-doc.test.ts (each interpolated number is
  // one token; see module header). States the denominator explicitly and
  // keeps the strict-floor framing. Two wording decisions here are review
  // findings, not style: "full-time faculty," NOT "scholars" (2026-08-16 —
  // the denominator IS now full-time-faculty-scoped, see "Corpus and
  // denominator"; the paragraph previously said "scholars" specifically
  // because that filter didn't exist yet); and the registry exclusion is
  // scoped to the rates and the access split, because the distinct-record/
  // repository/faculty totals in the same sentence DO include registry rows
  // (flagged inline as "trial registrations included"). The PMC-coverage
  // sentence a prior version of this paragraph asserted as fact was dropped
  // 2026-08-16 (known data-quality gap — see "PMC coverage"): a citation-
  // ready summary must not restate a figure this dashboard itself now flags
  // as untrustworthy.
  const paragraph =
    `Between ${floor} and the present, Weill Cornell Medicine full-time faculty serving as first or last ` +
    `author published ${num(denominator)} academic articles and preprints. The denominator counts every ` +
    `confirmed, disambiguated first- or last-authored publication of those two types; types the ` +
    `pipeline never scans are excluded so the rate is not diluted by papers that could never register ` +
    `a deposit. The year floor exists because the extraction pipeline never scanned earlier publications, not ` +
    `as an editorial cutoff. Of these, ${num(o.shareRateNumerator)} (${pct(o.shareRateNumerator, denominator)}%) ` +
    `carried at least one confirmed dataset deposit; in total the pipeline detected ${num(o.datasets)} ` +
    `distinct records, trial registrations included, across ${num(report.byRepository.length)} repositories ` +
    `from ${num(o.faculty)} faculty spanning ${num(report.byDepartment.length)} departments. ` +
    `Publications with a detected deposit split ${num(o.openPubs)} open-access versus ${num(o.controlledPubs)} ` +
    `controlled-access; trial registrations such as ClinicalTrials.gov are excluded from the share rate and ` +
    `this access split, and reported separately in their own registry buckets. PubMed Central coverage of the ` +
    `corpus is not yet a reliable figure pending review of an upstream data field, so it is omitted from this ` +
    `summary rather than restated uncritically. All figures are a strict floor rather than a census: only ` +
    `confirmed deposits are counted, and a statement that data are available on request is not counted as a ` +
    `deposit.`;

  return { sections, paragraph };
}

/** Render a `MethodsDoc` as the `?section=methods` markdown download. Title,
 *  a data-as-of line (`dataAsOf` is the weekly bridge sync timestamp — see
 *  `DataSharingReport.dataAsOf`), then one `##` per section. No horizontal
 *  rules — sections are separated by headings only. */
export function methodsMarkdown(doc: MethodsDoc, dataAsOf: Date | null): string {
  const asOf = dataAsOf === null ? "unknown" : dataAsOf.toISOString().slice(0, 10);
  const parts: string[] = ["# Data sharing — methods", "", `Data as of ${asOf}.`, ""];
  for (const section of doc.sections) {
    parts.push(`## ${section.heading}`, "", section.body, "");
  }
  return parts.join("\n");
}
