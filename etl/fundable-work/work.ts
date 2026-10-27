/**
 * Pure pieces of the fundable-work ETL: OpenAlex work parsing, author → faculty
 * matching, and the scoring prompt + schema. No DB, no network.
 */
import { z } from "zod";

import { matchEntry, splitDisplayName, type ScholarIndex } from "../honors/lists/match";

/** Weill Cornell Medicine + Weill Cornell Medical Center. NOT WCM-Qatar (I4210152471). */
export const WCM_OPENALEX_IDS = ["I4387153466", "I4405272987"];
export const WORK_TYPES = ["conference-abstract", "preprint"] as const;

export type OpenAlexWork = {
  id: string;
  doi: string | null;
  title: string | null;
  type: string;
  publication_date: string;
  primary_location: { source: { display_name: string } | null } | null;
  abstract_inverted_index: Record<string, number[]> | null;
  authorships: Array<{
    author_position: string;
    author: { display_name: string };
    institutions: Array<{ id: string }>;
  }>;
};

/** OpenAlex ships abstracts as word → positions; put the words back in order. */
export function reconstructAbstract(index: Record<string, number[]> | null): string {
  if (!index) return "";
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) for (const p of positions) words[p] = word;
  return words.filter((w) => w !== undefined).join(" ").trim();
}

/**
 * The work's WCM authors that resolve to exactly ONE indexed scholar.
 * Ambiguous names (2+ candidates) are dropped: this links a person to a pitch,
 * and a wrong link sends outreach to the wrong faculty member.
 */
export function matchFacultyAuthors(
  work: OpenAlexWork,
  index: ScholarIndex,
): Array<{ cwid: string; position: string }> {
  const out = new Map<string, string>();
  for (const a of work.authorships) {
    if (!a.institutions.some((i) => WCM_OPENALEX_IDS.includes(i.id.split("/").pop() ?? ""))) continue;
    const split = splitDisplayName(a.author.display_name);
    if (!split) continue;
    const hits = matchEntry(
      {
        printedName: a.author.display_name,
        given: split.given,
        family: split.family,
        affiliation: "Weill Cornell Medicine",
        year: null,
      },
      index,
    );
    if (hits.length === 1 && !out.has(hits[0].cwid)) out.set(hits[0].cwid, a.author_position);
  }
  return [...out].map(([cwid, position]) => ({ cwid, position }));
}

export const ScoreSchema = z.object({
  score: z.number().int().min(1).max(5),
  stage: z.enum(["discovery", "preclinical", "clinical", "population", "methods"]),
  modality: z
    .string()
    .nullable()
    .describe('The fundable asset type, e.g. "small molecule", "biomarker", "device", "cell therapy"; null if none'),
  rationale: z.string().describe("One or two sentences justifying the score"),
  pitch: z.string().describe("Three to five sentences a development officer could use with a funder"),
  funders: z
    .array(
      z.object({
        name: z.string(),
        kind: z.enum(["pharma", "biotech", "device", "diagnostics", "foundation", "other"]),
        why: z.string(),
      }),
    )
    .max(5),
});
export type Score = z.infer<typeof ScoreSchema>;

export const SYSTEM_PROMPT = `You assess research for a medical school's corporate and foundation relations team. Each item is a conference abstract or preprint by a Weill Cornell faculty member. Judge its potential to attract PRIVATE funding: industry (pharma, biotech, device, diagnostics) sponsored research or partnerships, and disease foundations or philanthropy. NIH fit does not count.

Score 1-5:
5 - A concrete, actionable asset or target in an area of active industry investment, with data strong enough to start a conversation now (e.g. in vivo efficacy, a biomarker validated in a patient cohort, an early clinical signal).
4 - A clear translational hook and an obvious type of partner, but earlier or thinner data.
3 - Plausible private interest, most likely a disease foundation or a sponsor needing more maturity before it would engage.
2 - Mostly mechanistic or descriptive; private relevance is indirect.
1 - Little private-funding fit (e.g. a case report, a health-services or educational study with no sponsor angle).
Most items score 2 or 3. Reserve 5 for the few that a business-development lead would want to see this week.

stage: discovery (basic mechanism), preclinical (models, tool compounds, assay development), clinical (patient data or trials), population (epidemiology, outcomes, health services), methods (tools, software, techniques).

funders: up to five specific organizations, each with one line on why. Name a company only when you know it has a program, product or stated interest in this target, indication or modality; otherwise name a foundation or leave it out. Fewer, well-grounded names beat a long list. When the faculty already work with industry sponsors on clinical trials (listed in the item), prefer those where they fit.

Base everything on the text given. Do not invent results the abstract does not report.`;

export function scoringPrompt(
  work: { type: string; title: string; venue: string | null; date: string; abstract: string },
  existingSponsors: string[],
): string {
  return [
    `Type: ${work.type}`,
    `Venue: ${work.venue ?? "unknown"} (${work.date})`,
    `Title: ${work.title}`,
    existingSponsors.length > 0
      ? `Industry sponsors of these faculty members' clinical trials: ${existingSponsors.join("; ")}`
      : null,
    "",
    work.abstract,
  ]
    .filter((l) => l !== null)
    .join("\n");
}
