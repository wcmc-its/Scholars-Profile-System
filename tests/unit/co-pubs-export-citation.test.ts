/**
 * #2580 — the two `/scholars/<slug>/co-pubs[/<menteeCwid>]/export?format=docx`
 * routes shared the same two citation defects as the CV and the search
 * bibliography, each with its own copy of the logic.
 *
 * The identifier defect reaches these routes by a different door than it reaches
 * the CV. `CoPublicationFull.pmid` is a NUMBER, so a `SCOPUS:` string can never
 * land here — but ReciterDB assigns an external (non-PubMed) record a synthetic
 * NEGATIVE pmid (`analysis_summary_article.pmid`, re-keyed to the stable
 * `article_id` only by the SPS reciter ETL, not by these live co-pub queries).
 * The routes labelled that `PMID:` and linked it as
 * `pubmed.ncbi.nlm.nih.gov/-3/` — dead in the reader's Word document.
 *
 * Synthetic CWIDs/slugs/pmids only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import JSZip from "jszip";
import type { CoPublicationFull } from "@/lib/api/mentoring";

const { scholarFindFirst } = vi.hoisted(() => ({ scholarFindFirst: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: { scholar: { findFirst: scholarFindFirst, findMany: vi.fn(async () => []) } },
}));

function copub(over: Partial<CoPublicationFull>): CoPublicationFull {
  return {
    pmid: 38670054,
    title: "Klotho and clinical outcomes in chronic kidney disease",
    journal: "Am J Kidney Dis",
    year: 2024,
    doi: "10.1053/j.ajkd.2023.10.015",
    pmcid: null,
    volume: "83",
    issue: "4",
    pages: "500-510",
    citationCount: 0,
    abstract: null,
    authors: [{ rank: 1, lastName: "Smith", firstName: "Jane", personIdentifier: "abc1001" }],
    ...over,
  };
}

/** One PubMed row with real values, one external row carrying BOTH defects. */
const COPUBS: CoPublicationFull[] = [
  copub({}),
  copub({
    pmid: -3, // ReciterDB's synthetic negative id for a non-PubMed record
    title: "A paper indexed only outside PubMed",
    journal: "Journal of Test Results",
    doi: "10.9999/test.2024.1",
    volume: "NULL",
    issue: "NULL",
    pages: "NULL",
  }),
];

vi.mock("@/lib/api/mentoring", () => ({
  menteeProgramLabel: () => "Other mentee",
  copubId: (p: { pmid: number }) => String(p.pmid),
  getCoPublications: vi.fn(async () => COPUBS),
  getMentorMenteePair: vi.fn(async () => ({
    mentorName: "Test Person",
    menteeName: "Test Mentee",
    manualOnly: false,
  })),
  getAllMentorCoPublications: vi.fn(async () => ({
    groups: [
      {
        programLabel: "PhD",
        entries: COPUBS.map((publication) => ({
          publication,
          mentee: {
            cwid: "zzz8888",
            fullName: "Test Mentee",
            programName: "Test Program",
            programType: "PhD",
            graduationYear: 2022,
          },
        })),
      },
    ],
    publicationCount: COPUBS.length,
    menteeCount: 1,
  })),
}));

import { GET as menteeExport } from "@/app/(public)/scholars/[slug]/co-pubs/[menteeCwid]/export/route";
import { GET as rollupExport } from "@/app/(public)/scholars/[slug]/co-pubs/export/route";

const SLUG = "test-person";
const MENTOR = {
  cwid: "zzz9999",
  slug: SLUG,
  preferredName: "Test Person",
  postnominal: null,
  roleCategory: "full_time_faculty",
};

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

async function renderDocx(
  route: typeof menteeExport | typeof rollupExport,
  params: Record<string, string>,
): Promise<{ text: string; linkTargets: string[] }> {
  const req = new Request(
    `http://localhost/scholars/${SLUG}/co-pubs/export?format=docx`,
  ) as unknown as NextRequest;
  const res = await (route as (r: NextRequest, c: unknown) => Promise<Response>)(req, {
    params: Promise.resolve(params),
  });
  expect(res.status).toBe(200);
  const zip = await JSZip.loadAsync(await res.arrayBuffer());
  const doc = await zip.file("word/document.xml")!.async("string");
  const rels = await zip.file("word/_rels/document.xml.rels")!.async("string");
  const tRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
  let m: RegExpExecArray | null;
  let text = "";
  while ((m = tRe.exec(doc))) text += decodeXml(m[1]!);
  const targets: string[] = [];
  const relRe = /Target="([^"]+)"/g;
  while ((m = relRe.exec(rels))) targets.push(decodeXml(m[1]!));
  return { text, linkTargets: targets };
}

beforeEach(() => {
  scholarFindFirst.mockReset();
  scholarFindFirst.mockResolvedValue(MENTOR);
});

describe.each([
  ["per-mentee export", menteeExport, { slug: SLUG, menteeCwid: "zzz8888" }],
  ["rollup export", rollupExport, { slug: SLUG }],
] as const)("co-pubs %s — citation defects (#2580)", (_label, route, params) => {
  it("keeps PMID: <n> hyperlinked for a real PubMed id", async () => {
    const { text, linkTargets } = await renderDocx(route, params);
    expect(text).toContain("PMID: 38670054");
    expect(linkTargets).toContain("https://pubmed.ncbi.nlm.nih.gov/38670054/");
  });

  it("never builds a pubmed link for the synthetic negative pmid", async () => {
    const { text, linkTargets } = await renderDocx(route, params);
    expect(text).toContain("Source: External");
    expect(text).not.toContain("PMID: -3");
    expect(linkTargets).not.toContain("https://pubmed.ncbi.nlm.nih.gov/-3/");
    // The DOI is still the resolvable link on that citation line.
    expect(linkTargets).toContain("https://doi.org/10.9999/test.2024.1");
  });

  it("never prints a literal 'NULL' volume/issue/pages", async () => {
    const { text } = await renderDocx(route, params);
    expect(text).not.toContain("NULL");
    expect(text).toContain("Journal of Test Results. 2024. ");
    expect(text).toContain("Am J Kidney Dis. 2024;83(4):500-510. ");
  });
});
