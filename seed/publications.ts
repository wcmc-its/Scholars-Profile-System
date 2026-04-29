/**
 * Synthetic publications + authorship + topic-assignments + publication-scores.
 *
 * Covers all publication-type weights from spec line 100, a range of citation
 * counts and ages for ranking-formula coverage, multi-WCM-coauthor papers
 * (for the chip-rendering on publication results in Phase 3), and external
 * authors with cwid=null (Q2' refinement, spec line 200).
 *
 * Publication scores are the ReCiterAI minimal-projection field from Q6.
 */
import { Prisma } from "@/lib/generated/prisma/client";
import { prisma } from "@/lib/db";

type AuthorSpec =
  | { cwid: string; position: number }
  | { externalName: string; position: number };

type PubSpec = {
  pmid: string;
  title: string;
  journal: string;
  year: number;
  publicationType: string;
  citationCount: number;
  dateAddedToEntrez: Date;
  doi?: string;
  meshTerms?: string[];
  authors: AuthorSpec[];
};

const pubs: PubSpec[] = [
  {
    pmid: "38001001",
    title: "Single-cell mapping of the cardiac fibrotic transition reveals reversibility windows",
    journal: "Journal of Clinical Investigation",
    year: 2023,
    publicationType: "Academic Article",
    citationCount: 45,
    dateAddedToEntrez: new Date("2023-04-15"),
    doi: "10.1172/JCI170001",
    meshTerms: ["Heart Failure", "Fibrosis", "Single-Cell Analysis", "Cardiomyocytes"],
    authors: [
      { cwid: "jas2001", position: 1 },
      { externalName: "Patel, R.", position: 2 },
      { cwid: "jho2011", position: 3 },
      { cwid: "mao2004", position: 4 },
      { externalName: "Wilson, K.", position: 5 },
    ],
  },
  {
    pmid: "37001001",
    title: "Microglial subpopulations drive lesion progression in multiple sclerosis",
    journal: "Nature",
    year: 2022,
    publicationType: "Academic Article",
    citationCount: 88,
    dateAddedToEntrez: new Date("2022-09-22"),
    doi: "10.1038/s41586-022-05022-0",
    meshTerms: ["Multiple Sclerosis", "Microglia", "Neuroinflammation", "Single-Cell Analysis"],
    authors: [
      { cwid: "mao2004", position: 1 },
      { externalName: "Anderson, T.", position: 2 },
      { externalName: "Lee, M.", position: 3 },
      { externalName: "Mendez, J.", position: 4 },
    ],
  },
  {
    pmid: "36001001",
    title: "Therapeutic horizons in pediatric sickle cell disease: a review",
    journal: "Blood",
    year: 2022,
    publicationType: "Review",
    citationCount: 25,
    dateAddedToEntrez: new Date("2022-03-10"),
    doi: "10.1182/blood.2022015001",
    meshTerms: ["Anemia, Sickle Cell", "Pediatrics", "Hematology", "Gene Therapy"],
    authors: [
      { cwid: "dpa2010", position: 1 },
      { externalName: "Robinson, P.", position: 2 },
      { externalName: "Hayes, B.", position: 3 },
    ],
  },
  {
    pmid: "35001001",
    title: "Whole-genome characterization of hepatocellular carcinoma actionable targets",
    journal: "Cell",
    year: 2021,
    publicationType: "Academic Article",
    citationCount: 200,
    dateAddedToEntrez: new Date("2021-06-04"),
    doi: "10.1016/j.cell.2021.05.001",
    meshTerms: ["Carcinoma, Hepatocellular", "Genomics", "Precision Medicine"],
    authors: [
      { cwid: "lim2006", position: 1 },
      { externalName: "Tanaka, H.", position: 2 },
      { externalName: "Brown, A.", position: 3 },
      { externalName: "Wang, Y.", position: 4 },
    ],
  },
  {
    pmid: "34001001",
    title: "CRISPR screens for non-coding variant interpretation: state of the art",
    journal: "Nature Reviews Genetics",
    year: 2020,
    publicationType: "Review",
    citationCount: 350,
    dateAddedToEntrez: new Date("2020-08-12"),
    doi: "10.1038/s41576-020-0270-8",
    meshTerms: ["CRISPR-Cas Systems", "Genetic Variation", "Genomics", "Cardiomyopathies"],
    authors: [
      { cwid: "sjo2008", position: 1 },
      { externalName: "Khan, S.", position: 2 },
      { externalName: "Park, J.", position: 3 },
      { externalName: "O'Connell, F.", position: 4 },
    ],
  },
  {
    pmid: "33001001",
    title: "Heart failure pharmacotherapy in 2019: an evidence map",
    journal: "The Lancet",
    year: 2019,
    publicationType: "Review",
    citationCount: 425,
    dateAddedToEntrez: new Date("2019-10-15"),
    doi: "10.1016/S0140-6736(19)32500-X",
    meshTerms: ["Heart Failure", "Pharmacotherapy", "Evidence-Based Medicine"],
    authors: [
      { externalName: "Roberts, D.", position: 1 },
      { externalName: "Yamamoto, K.", position: 2 },
      { cwid: "jas2001", position: 3 },
      { externalName: "Singh, A.", position: 4 },
    ],
  },
  {
    pmid: "32001001",
    title: "Persistent splenic sequestration in a 4-year-old with sickle cell disease: case report",
    journal: "Pediatric Blood & Cancer",
    year: 2018,
    publicationType: "Case Report",
    citationCount: 5,
    dateAddedToEntrez: new Date("2018-05-20"),
    doi: "10.1002/pbc.27001",
    meshTerms: ["Anemia, Sickle Cell", "Splenic Sequestration", "Pediatrics"],
    authors: [
      { cwid: "dpa2010", position: 1 },
      { externalName: "Greenwood, M.", position: 2 },
    ],
  },
  {
    pmid: "31001001",
    title: "Inflammation biomarkers in early multiple sclerosis: a meta-analysis",
    journal: "JAMA Neurology",
    year: 2017,
    publicationType: "Academic Article",
    citationCount: 180,
    dateAddedToEntrez: new Date("2017-11-08"),
    doi: "10.1001/jamaneurol.2017.4001",
    meshTerms: ["Multiple Sclerosis", "Biomarkers", "Inflammation"],
    authors: [
      { externalName: "Nagy, P.", position: 1 },
      { externalName: "Williams, E.", position: 2 },
      { cwid: "mao2004", position: 3 },
    ],
  },
  {
    pmid: "39001001",
    title: "Quantitative T1 mapping for early detection of cardiac amyloidosis",
    journal: "bioRxiv",
    year: 2024,
    publicationType: "Preprint",
    citationCount: 0,
    dateAddedToEntrez: new Date("2024-02-20"),
    doi: "10.1101/2024.02.20.000001",
    meshTerms: ["Amyloidosis", "Cardiac Imaging", "Magnetic Resonance Imaging"],
    authors: [
      { cwid: "jas2001", position: 1 },
      { externalName: "Kovac, L.", position: 2 },
    ],
  },
  {
    pmid: "30001001",
    title: "Erratum: cardiac fibrosis transition windows revisited",
    journal: "Journal of Clinical Investigation",
    year: 2016,
    publicationType: "Erratum",
    citationCount: 0,
    dateAddedToEntrez: new Date("2016-01-10"),
    authors: [{ cwid: "jas2001", position: 1 }],
  },
  {
    pmid: "29001001",
    title: "Letter: response to recent commentary on MS lesion staging",
    journal: "JAMA Neurology",
    year: 2015,
    publicationType: "Letter",
    citationCount: 1,
    dateAddedToEntrez: new Date("2015-07-04"),
    authors: [{ cwid: "mao2004", position: 1 }],
  },
  {
    pmid: "28001001",
    title: "Editorial: the next decade of cancer genomics",
    journal: "Cell",
    year: 2014,
    publicationType: "Editorial Article",
    citationCount: 8,
    dateAddedToEntrez: new Date("2014-12-15"),
    authors: [{ cwid: "lim2006", position: 1 }],
  },
];

const topicsByCwid: Record<string, Array<{ topic: string; score: number }>> = {
  jas2001: [
    { topic: "Heart Failure", score: 0.92 },
    { topic: "Cardiac Fibrosis", score: 0.88 },
    { topic: "Cardiomyocytes", score: 0.81 },
    { topic: "Single-Cell Analysis", score: 0.75 },
    { topic: "Drug Discovery", score: 0.62 },
  ],
  mao2004: [
    { topic: "Multiple Sclerosis", score: 0.95 },
    { topic: "Neuroinflammation", score: 0.91 },
    { topic: "Microglia", score: 0.87 },
    { topic: "Single-Cell Analysis", score: 0.78 },
    { topic: "Demyelinating Diseases", score: 0.74 },
  ],
  lim2006: [
    { topic: "Hepatocellular Carcinoma", score: 0.94 },
    { topic: "Cancer Genomics", score: 0.89 },
    { topic: "Precision Oncology", score: 0.85 },
    { topic: "Whole-Genome Sequencing", score: 0.71 },
  ],
  sjo2008: [
    { topic: "CRISPR-Cas Systems", score: 0.93 },
    { topic: "Clinical Genetics", score: 0.88 },
    { topic: "Cardiomyopathies", score: 0.82 },
    { topic: "Genetic Variation", score: 0.79 },
    { topic: "Functional Genomics", score: 0.7 },
  ],
  dpa2010: [
    { topic: "Sickle Cell Disease", score: 0.94 },
    { topic: "Pediatric Hematology", score: 0.9 },
    { topic: "Erythrocyte Biology", score: 0.81 },
    { topic: "Translational Medicine", score: 0.72 },
  ],
};

export async function seedPublications() {
  for (const p of pubs) {
    await prisma.publication.create({
      data: {
        pmid: p.pmid,
        title: p.title,
        journal: p.journal,
        year: p.year,
        publicationType: p.publicationType,
        citationCount: p.citationCount,
        dateAddedToEntrez: p.dateAddedToEntrez,
        doi: p.doi ?? null,
        pubmedUrl: `https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/`,
        meshTerms: p.meshTerms ?? Prisma.JsonNull,
        authors: {
          create: p.authors.map((a) => ({
            cwid: "cwid" in a ? a.cwid : null,
            externalName: "externalName" in a ? a.externalName : null,
            position: a.position,
            totalAuthors: p.authors.length,
            isFirst: a.position === 1,
            isLast: a.position === p.authors.length,
            isPenultimate: a.position === p.authors.length - 1 && p.authors.length > 2,
            isConfirmed: true,
          })),
        },
      },
    });
  }

  // Topic assignments (Q6 minimal projection, source = ReCiterAI DynamoDB).
  for (const [cwid, topics] of Object.entries(topicsByCwid)) {
    for (const t of topics) {
      await prisma.topicAssignment.create({
        data: {
          cwid,
          topic: t.topic,
          score: t.score,
        },
      });
    }
  }

  // Publication scores (Q6 minimal projection). Score for any (scholar, pub) pair where the
  // scholar is an author. Synthetic; in production these come from ReCiterAI's weekly run.
  for (const p of pubs) {
    for (const a of p.authors) {
      if (!("cwid" in a)) continue;
      // Score scaled by authorship contribution: first/last get higher scores, middle lower.
      let score = 0.4;
      if (a.position === 1 || a.position === p.authors.length) score = 0.85;
      else if (a.position === p.authors.length - 1 && p.authors.length > 2) score = 0.6;
      await prisma.publicationScore.create({
        data: { cwid: a.cwid, pmid: p.pmid, score },
      });
    }
  }
}
