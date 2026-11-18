/**
 * Methods text for `/edit/research-security`: the "Query & Assumptions" sheet
 * of the Section 1286 workbook (2026-10-29), adapted to the standing
 * dashboard. One source for the page's Methods section, the export's Methods
 * sheet and the markdown download, so the three cannot drift.
 *
 * PURE MODULE: no db import, safe in a client bundle.
 *
 * Do not soften when editing:
 * - "Screening results, not determinations" leads the document.
 * - Country of concern is a separate tier, never added to an entity total.
 * - Not-yet-attributed rows are never part of a confirmed count.
 * - The known limits (affiliation coverage, grant metadata, non-PubMed
 *   coverage, ReCiter attribution errors) stay listed.
 */
import {
  CONSORTIUM_AUTHORS,
  DEFAULT_DATE_FROM,
} from "@/lib/edit/research-security-dashboard";

export type ResearchSecurityMethodsDoc = {
  /** The one-line caution shown above every view. */
  notice: string;
  sections: { heading: string; body: string }[];
};

export const SCREENING_NOTICE =
  "These are screening results, not determinations. Read the exact matched affiliation " +
  "strings for a paper (By paper) before contacting a researcher.";

export function buildResearchSecurityMethodsDoc(): ResearchSecurityMethodsDoc {
  return {
    notice: SCREENING_NOTICE,
    sections: [
      {
        heading: "What this is",
        body:
          "Co-publications in which a co-author lists an entity on a research-security watch list, " +
          "for Weill Cornell Medicine and Cornell University (Ithaca) authors. It replaces the one-off " +
          "Section 1286 workbooks. Counts are screening results, not determinations: a match says that " +
          "an affiliation string on the paper fits a pattern, nothing about the collaboration itself.",
      },
      {
        heading: "Lists",
        body:
          "House Section 1286 nominations: the 134 entities in the House Select Committee on the CCP's " +
          "letter of 2026-10-01 recommending additions to the Section 1286 List (14 CAS institutes, 62 " +
          "defense and national laboratories with duplicate names merged, 58 SASTIND universities). These " +
          "are nominations, not designations.\n" +
          "Usual suspects: a short curated list of entities of concern regardless of any one letter " +
          "(the Seven Sons of National Defence, defence universities and research academies, PLA medical " +
          "universities and hospitals).\n" +
          "Country of concern: any co-author affiliation in China (including Hong Kong and Macau), Russia, " +
          "Iran, North Korea, Cuba or Venezuela. This is a far wider net than the entity lists, so it is its " +
          "own tier: it is shown only when that list is selected and is never added to an entity total.\n" +
          "Funding flags: the China Scholarship Council and named talent programs in a paper's grant metadata.",
      },
      {
        heading: "Publications screened",
        body:
          "Every article with a ReCiter-attributed Weill Cornell Medicine or Cornell University author, " +
          "PubMed and non-PubMed (Scopus, OpenAlex, Crossref), plus the not-yet-attributed tier below. " +
          `The default date range is publication date ${DEFAULT_DATE_FROM} onward, as in the workbook. ` +
          "An article with no publication date is outside every date range.",
      },
      {
        heading: "WCM and Cornell University",
        body:
          "A person whose ReCiter person type includes 'cornell-ithaca' is Cornell University; everyone " +
          "else is Weill Cornell Medicine. Former WCM people still attributed in ReCiter are included. A " +
          "paper can count for both campuses. An open review-queue row with no proposed person has no " +
          "campus: it is listed under both campuses together and under neither alone. External validation " +
          "cohorts stored in the same database (Fred Hutch, the UC campuses, USC) are excluded.",
      },
      {
        heading: "Matching method",
        body:
          "Every author affiliation string on each paper is collected nightly (the ReCiter PubMed cache, " +
          "PubMed, or OpenAlex by DOI for non-PubMed articles) and tested against a pattern per entity. A " +
          "paper is a co-publication with an entity when any author on it lists that entity. Matching is " +
          "case-insensitive and accent- and apostrophe-normalized. Affiliated hospitals and schools that " +
          "name the parent university (for example \"Peking University Third Hospital\") count as that university.",
      },
      {
        heading: "Known false-positive guards",
        body:
          "Excluded: National Tsing Hua University (Taiwan) for Tsinghua; National Sun Yat-sen University " +
          "(Taiwan) for Sun Yat-sen; Soochow University in Taipei; Xi'an Jiaotong-Liverpool University; " +
          "sister schools named \"<X> University of ...\" (for example Zhejiang University of Technology). " +
          "Southeast University must mention Nanjing; generically named CAS institutes must mention the " +
          "Chinese Academy of Sciences; laboratories must mention China. Country matching skips US place names.",
      },
      {
        heading: "Confirmed and not yet attributed",
        body:
          "Confirmed means the authorship is accepted in ReCiter. Every count on By entity, By person, " +
          "By paper and Funding flags is confirmed authorships only.\n" +
          "Not yet attributed is its own tab and is never part of a confirmed count: ReCiter suggestions " +
          "nobody has reviewed, and open authorship-review queue rows (the byline names WCM or Cornell, " +
          "no person accepted). A paper already confirmed for one of our authors is not counted as not " +
          "yet attributed; its pending rows are marked \"Already confirmed\".\n" +
          "Priority: 1 = the candidate also lists the entity (often a namesake, so a wrong suggestion: " +
          "verify); 2 = likely ours (ReCiter score of 90 or more, or an open review-queue row, including " +
          "a suggestion under 90 that also has one); 3 = score under " +
          `90; 4 = ${CONSORTIUM_AUTHORS}+ author consortium.`,
      },
      {
        heading: "Our author also lists the entity",
        body:
          "Flagged when the matched co-author has the same last name and first name as one of our people " +
          "on that paper, so the person may have listed the entity themselves (a possible dual appointment). " +
          "On By entity and By paper the person must be a confirmed author in the selected campus; a " +
          "suggestion or review-queue candidate with the co-author's name is shown only on Not yet " +
          "attributed, as priority 1. Either of a person's names counts (the directory name and the " +
          "publishing name). " +
          "Name matching is approximate: a namesake co-author sets it, and an initials-only byline never does. Verify.",
      },
      {
        heading: "Large consortia",
        body:
          `Papers with ${CONSORTIUM_AUTHORS} or more authors are flagged and can be excluded. They are usually ` +
          "multi-site consortia where our institution and the listed entity are both among dozens of sites " +
          "with no direct collaboration.",
      },
      {
        heading: "Funding flags",
        body:
          "A hit means the paper acknowledged that funder in its grant metadata. It does not identify which " +
          "author received the award. Talent programs are about individuals, not institutions, so they cannot " +
          "be detected from affiliations: they appear only when the grant metadata names them.",
      },
      {
        heading: "Known limits",
        body:
          "PubMed holds only author-supplied affiliations, and some journals record only the first author's.\n" +
          "Grant metadata is incomplete: many journals do not deposit non-NIH funding.\n" +
          "Non-PubMed coverage depends on a DOI being present and in OpenAlex; articles that cannot be " +
          "retrieved are not screened.\n" +
          "ReCiter attribution is not perfect: a small share of attributed papers belong to a namesake, and " +
          "those errors flow through.\n" +
          "The data is a nightly copy; a correction made in ReCiter today appears here after the next run.",
      },
      {
        heading: "Before acting",
        body:
          "Read the exact matched affiliation strings for the paper (By paper, or the Matched affiliations " +
          "sheet of the export) before contacting a researcher. Counts are screening results, not determinations.",
      },
    ],
  };
}

/** The Methods document as markdown. */
export function researchSecurityMethodsMarkdown(
  doc: ResearchSecurityMethodsDoc,
  dataAsOf: Date | null,
): string {
  const asOf = dataAsOf === null ? "unknown" : dataAsOf.toISOString().slice(0, 10);
  const parts = ["# Research security: methods", "", `Data as of ${asOf}.`, "", doc.notice, ""];
  for (const s of doc.sections) parts.push(`## ${s.heading}`, "", s.body, "");
  return parts.join("\n");
}
