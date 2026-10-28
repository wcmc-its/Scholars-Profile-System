/** `/edit/fundable-work` — dark unless FUNDABLE_WORK=on (cdk/lib/app-stack.ts). */
export function isFundableWorkEnabled(): boolean {
  return process.env.FUNDABLE_WORK === "on";
}

export type FundableWorkFunder = {
  name: string;
  kind: "pharma" | "biotech" | "device" | "diagnostics" | "foundation" | "other";
  why: string;
};

/**
 * The conference an abstract was presented at. OpenAlex has no conference field —
 * `venue` is the journal that carried the supplement — so this is derived:
 *  - a venue that names a meeting ("… Symposium", "… Meeting") IS the conference ("stated");
 *  - otherwise the society whose supplement that journal carries, plus the
 *    publication year ("inferred");
 *  - preprints and unmapped venues have none.
 *
 * ponytail: a lookup table over the venues that actually occur (grounded on the
 * 1,412-row staging corpus, 2026-10-28), not a parser. It cannot tell ASCO's
 * annual meeting from its GU/GI symposia — both publish in JCO — so it names the
 * society. Fix by having the ETL ask the model for the meeting, which needs a
 * column and a rescore.
 */
const CONFERENCE_BY_VENUE: Record<string, string> = {
  Blood: "ASH Annual Meeting",
  "Blood Cancer Discovery": "AACR Annual Meeting",
  "Cancer Research": "AACR Annual Meeting",
  "Clinical Cancer Research": "AACR Annual Meeting",
  "Cancer Immunology Research": "AACR Annual Meeting",
  "Cancer Epidemiology Biomarkers & Prevention": "AACR Annual Meeting",
  "Journal of Clinical Oncology": "ASCO meeting",
  "JCO Oncology Practice": "ASCO meeting",
  Circulation: "AHA Scientific Sessions",
  "Circulation Research": "AHA Scientific Sessions",
  Hypertension: "AHA Hypertension Sessions",
  Stroke: "International Stroke Conference",
  "Stroke Vascular and Interventional Neurology": "International Stroke Conference",
  "European Stroke Journal": "European Stroke Organisation Conference",
  "American Journal of Respiratory and Critical Care Medicine": "ATS International Conference",
  "Innovation in Aging": "GSA Annual Scientific Meeting",
  "Neuro-Oncology": "SNO Annual Meeting",
  "Neuro-Oncology Advances": "SNO Annual Meeting",
  "The Journal of the Acoustical Society of America": "Acoustical Society of America Meeting",
  "Human Reproduction": "ESHRE Annual Meeting",
  "Journal of Crohn s and Colitis": "ECCO Congress",
  "Journal of Burn Care & Research": "ABA Annual Meeting",
  "Annals of the Rheumatic Diseases": "EULAR Congress",
  "Open Forum Infectious Diseases": "IDWeek",
  SLEEP: "SLEEP Annual Meeting",
  "Obstetrics and Gynecology": "ACOG Annual Meeting",
  "The American Journal of Gastroenterology": "ACG Annual Meeting",
  "Research and Practice in Thrombosis and Haemostasis": "ISTH Congress",
  "Journal of the Society for Cardiovascular Angiography & Interventions": "SCAI Scientific Sessions",
  "Journal of the Pediatric Infectious Diseases Society": "IDWeek",
  "Journal of Clinical and Translational Science": "ACTS Translational Science Meeting",
};

/** A venue that is itself a meeting, so no society lookup is needed. */
const VENUE_IS_MEETING = /\b(conference|meeting|symposium|congress|workshop|sessions)\b/i;

export type FundableWorkConference = { name: string; inferred: boolean };

export function conferenceOf(work: {
  type: string;
  venue: string | null;
  date: string;
}): FundableWorkConference | null {
  if (work.type !== "conference-abstract" || !work.venue) return null;
  if (VENUE_IS_MEETING.test(work.venue)) return { name: work.venue, inferred: false };
  const society = CONFERENCE_BY_VENUE[work.venue];
  if (!society) return null;
  return { name: `${society} ${work.date.slice(0, 4)}`, inferred: true };
}
