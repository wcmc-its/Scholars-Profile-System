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
    "A repository hosted in a jurisdiction on the DOJ Bulk Data Rule countries-of-concern list — " +
    "China (including Hong Kong and Macau), Russia, Iran, North Korea, Cuba, and Venezuela. " +
    "Classification is by the repository's HOST jurisdiction, not by any author's nationality or affiliation.",
  "Foreign-hosted":
    "A repository operated outside the US, e.g. EMBL-EBI or CERN infrastructure. " +
    "Descriptive, not itself a violation.",
  // Deliberately broader than "Country of concern": the Concerning column/flag
  // counts the union of the three highest-severity tiers, and a hover that led
  // with only the country-of-concern definition overstated severity for rows
  // whose deposits are merely foreign-hosted (review finding, v3 pass).
  Concerning:
    "A deposit in a repository hosted in a country of concern, OR in any foreign-hosted " +
    "repository — the union of the three highest-severity tiers, counted per deposit " +
    "instance, not per distinct dataset.",
  "Open access": "Bulk download without an access-review step.",
  "Controlled access":
    "Access requires an application or data-use agreement, e.g. dbGaP or EGA — " +
    "the compliant path for sensitive data.",
  Registry:
    "Trial-registration metadata such as ClinicalTrials.gov — not bulk microdata; " +
    "excluded from every deposit rate (share rate, PMC rate, access split, funding lens) " +
    "and shown in its own registry buckets.",
  "Strict floor": "Confirmed deposits only; a floor, not a census of all sharing.",
  "Deposit instance":
    "One (person, dataset) link row — a dataset with three depositing faculty counts three instances.",
  PMC:
    "PubMed Central, NIH's full-text archive; the full-text scan can only inspect papers " +
    "whose full text is deposited there.",
  "Share rate":
    "n/N of confirmed first/last-authored eligible publications with at least one detected deposit.",
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
        `Academic Article or Preprint published in ${floor} or later: ${num(denominator)} publications. ` +
        `The ${floor} floor is a coverage window, not an editorial choice — the deposit-detection pipeline never ` +
        `scanned earlier publications, so counting them would manufacture "no detected deposit" for papers that ` +
        `were simply never checked. Other publication types are excluded for the same reason: the pipeline never ` +
        `scans them, so they would inflate the denominator with publications that have zero chance of contributing ` +
        `to the numerator. One asymmetry remains open: the numerator's extraction pipeline covers full-time ` +
        `faculty only, and SPS has no bridged full-time-status field to apply the same filter on the ` +
        `denominator side.`,
    },
    {
      heading: "Extraction and attribution",
      body:
        `Deposits come from two arms: PubMed's structured DataBankList field, and a scan of Data Availability ` +
        `statements in PubMed Central full text. Author attribution uses ReCiter's identity disambiguation, so a ` +
        `deposit is credited to a specific person rather than a name string. Each detected mention is classified ` +
        `as a genuine deposit versus reuse of someone else's dataset, and reuse is not counted. Everything on the ` +
        `dashboard is the strict band — confirmed deposits only, no generous or estimated ceiling, because only ` +
        `high-confidence rows are persisted at all. Deposits are deduplicated on the (person, repository, ` +
        `accession) triple: the same dataset cited from several of one author's papers counts once per person, ` +
        `while a dataset with three depositing faculty legitimately counts three deposit instances.`,
    },
    {
      heading: "PMC coverage",
      body:
        `${num(o.pmcCoveredPubs)} of the ${num(denominator)} corpus publications (${pct(o.pmcCoveredPubs, denominator)}%) ` +
        `have full text in PubMed Central. The full-text arm of the deposit scan can only inspect those — a data ` +
        `availability statement in a paywalled journal is invisible to it. The DataBankList arm covers every ` +
        `PubMed record regardless of full-text availability, so detection is not zero outside PMC, but ` +
        `full-text-derived detection is bounded by PMC coverage. The PMC-covered subset is therefore the fairest ` +
        `denominator for full-text-detected deposits, and the coverage percentage is itself a compliance figure ` +
        `stakeholders asked for, since PMC deposit is how NIH public-access obligations are met. Roughly 2% of ` +
        `PMC full text is unscannable (image-only or malformed markup), so even within PMC the scan is a floor.`,
    },
    {
      heading: "Access model and risk tier",
      body:
        `Every repository is assigned a tier from the 36-repository catalog: host jurisdiction crossed with ` +
        `access model. The six tiers, most to least severe, are country-of-concern hosted, foreign-hosted open, ` +
        `foreign-hosted controlled, US-hosted open, US-hosted controlled, and registry. "Concerning" on this ` +
        `dashboard is tier-derived ONLY — a deposit in a country-of-concern-hosted or foreign-hosted repository. ` +
        `It does NOT include sensitive-data-type detection (an open deposit of a sensitive data category), which ` +
        `requires raw MeSH terms per citing publication and is not yet built — do not read the concerning counts ` +
        `as that fuller three-way definition. Zero rows are printed deliberately: "Country of concern — 0" is a ` +
        `statement that we checked and found none, not an absence of data.`,
    },
    {
      heading: "Registry separation",
      body:
        `ClinicalTrials.gov and similar registries hold trial-registration metadata, not bulk microdata — ` +
        `registering a trial is not sharing a dataset. Counting registrations as data sharing would roughly ` +
        `double every number on this dashboard, so registry rows never count toward any publication-grain ` +
        `deposit figure: the share-rate numerator, the PMC-covered deposit rate, the open/controlled access ` +
        `split, and the funding-lens population all exclude them. Registry deposits are shown in their own ` +
        `explicitly labeled buckets (the registry tier and the department table's Registry column), and they ` +
        `DO remain inside the headline distinct-dataset, distinct-faculty, and link totals — those totals ` +
        `describe everything the pipeline detected, with the registry buckets keeping the registration share ` +
        `visible rather than hidden inside an undifferentiated count. If a future consumer wants registrations ` +
        `included in the rates, that must ship as a new, clearly labeled figure — never as a silent widening ` +
        `of the deposit counts reported here.`,
    },
    {
      heading: "Funding lens",
      body:
        `"NIH-funded" means the publication has at least one linked grant carrying a non-null NIH ` +
        `institute/center code — a field populated only for NIH awards. "Not NIH-funded" is therefore the precise ` +
        `claim, and it is NOT the same as "non-federal": funding from other federal agencies (CDC, NSF, and the ` +
        `like) is indistinguishable from genuinely non-federal support with this field, and all of it lands in ` +
        `the not-NIH-funded bucket. The split is computed over the same non-registry deposited-publication ` +
        `population as the access-model split, so the two lenses describe the same set of publications and can ` +
        `be read side by side without a denominator mismatch.`,
    },
    {
      heading: "Known gaps",
      body:
        `Four known gaps. Coverage skew: the full-text arm only sees PMC full text, so units publishing in ` +
        `low-PMC-coverage venues undercount relative to their true sharing. No per-item discovery timestamp: ` +
        `every row is stamped with the same sync time on each weekly refresh, so a deposit found this week and ` +
        `one found months ago are indistinguishable — "recent activity" means deposit year, not detection date. ` +
        `The country-of-concern coauthor pull is not yet ingested, so "concerning" remains tier-only. And the ` +
        `denominator has no full-time-faculty filter while the numerator pipeline is full-time-only, so ` +
        `per-person rates for non-full-time scholars read low by construction rather than as a finding about ` +
        `their sharing behavior.`,
    },
    {
      heading: "Glossary",
      body: Object.entries(DATA_SHARING_TERMS)
        .map(([term, definition]) => `${term} — ${definition}`)
        .join("\n"),
    },
  ];

  // Reporting paragraph — seven sentences, 215 whitespace-delimited words by
  // construction (each interpolated number is one token; see module header).
  // States the denominator explicitly and keeps the strict-floor framing. Two
  // wording decisions here are review findings, not style (2026-08-16 v3):
  // "scholars", NOT "full-time faculty" — the denominator has no FTE filter
  // (see "Corpus and denominator" / "Known gaps"); and the registry exclusion
  // is scoped to the rates and the access split, because the distinct-record/
  // repository/faculty totals in the same sentence DO include registry rows
  // (flagged inline as "trial registrations included").
  const paragraph =
    `Between ${floor} and the present, Weill Cornell Medicine scholars serving as first or last ` +
    `author published ${num(denominator)} academic articles and preprints. The denominator counts every ` +
    `confirmed, disambiguated first- or last-authored publication of those two types; types the ` +
    `pipeline never scans are excluded so the rate is not diluted by papers that could never register ` +
    `a deposit. The year floor exists because the extraction pipeline never scanned earlier publications, not ` +
    `as an editorial cutoff. Of these, ${num(o.shareRateNumerator)} (${pct(o.shareRateNumerator, denominator)}%) ` +
    `carried at least one confirmed dataset deposit; in total the pipeline detected ${num(o.datasets)} ` +
    `distinct records, trial registrations included, across ${num(report.byRepository.length)} repositories ` +
    `from ${num(o.faculty)} faculty spanning ${num(report.byDepartment.length)} departments. ` +
    `${num(o.pmcCoveredPubs)} of the corpus publications (${pct(o.pmcCoveredPubs, denominator)}%) have full ` +
    `text in PubMed Central, the only corpus the full-text arm of the scan can inspect; among those ` +
    `PMC-covered publications, the detected-deposit rate is ${num(o.pmcDepositedPubs)}/${num(o.pmcCoveredPubs)} ` +
    `(${pct(o.pmcDepositedPubs, o.pmcCoveredPubs)}%). Publications with a detected deposit split ` +
    `${num(o.openPubs)} open-access versus ${num(o.controlledPubs)} controlled-access; trial registrations ` +
    `such as ClinicalTrials.gov are excluded from the share rate, the PMC rate, and this access split, and ` +
    `reported separately in their own registry buckets. All figures ` +
    `are a strict floor rather than a census: only confirmed deposits are counted, roughly 2% of PMC full ` +
    `text is not machine-readable for scanning, and a statement that data are available on request is not ` +
    `counted as a deposit.`;

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
