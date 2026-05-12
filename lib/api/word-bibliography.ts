/**
 * Word (.docx) bibliography export — Vancouver style (#89 Phase 2.5).
 *
 * Renders the same {q, filters, sort} payload as the CSV exports into a
 * numbered Vancouver-style bibliography:
 *
 *   1. Smith JA, **Wolf M**, Jones BC, et al. Klotho and Clinical Outcomes
 *      in CKD. Am J Kidney Dis. 2024. doi:10.1053/j.ajkd.2023.10.015.
 *      PMID: 38670054. PMCID: PMC11098699.
 *
 * Vancouver vs the spec's AMA: journal name is NOT italicized; authors
 * past the 6th collapse to "..., et al." Everything else (sentence-case
 * title, hyperlinked PMID/PMCID/DOI, WCM-author bolding) carries over.
 *
 * Bolding rule: only authors *selected* via the `wcmAuthor` filter on
 * the search page are bold. The reciter ETL marks every WCM-affiliated
 * author in `authorsString` with `((...))` brackets (PM convention),
 * which we strip for display; bolding then narrows that set to the
 * scholars whose CWIDs the user picked. With no selection, no token is
 * bold — the bibliography just shows the WCM-marker brackets stripped.
 * This matches the biosketch/grant workflow ("export this person's
 * publications, bold them throughout") more directly than bolding every
 * WCM coauthor.
 *
 * Volume / issue / pages aren't currently in the Scholars data layer
 * (#89 spec §6.1 calls them out); the citation renders Year only after
 * the journal until those fields are plumbed through.
 */
import {
  AlignmentType,
  Document,
  ExternalHyperlink,
  Footer,
  PageNumber,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import { prisma } from "@/lib/db";
import {
  PUBLICATION_FIELD_BOOSTS,
  PUBLICATIONS_INDEX,
  searchClient,
} from "@/lib/search";
import type { PublicationsFilters, PublicationsSort } from "@/lib/api/search";
import { displayPublicationType } from "@/lib/publication-types";

/** Word's per-export ceiling — lower than CSV's 5,000 because each docx
 *  citation costs more to render and a 5,000-citation bibliography is
 *  rarely useful as a document. Spec §7.1 hard cap is 5,000. */
export const WORD_MAX_LIMIT = 1000;

const HANGING_INDENT_TWIPS = 360; // 0.25"

export type WordExportRequest = {
  q: string;
  filters?: PublicationsFilters;
  sort?: PublicationsSort;
  limit?: number;
};

async function fetchPmidsForBibliography(
  req: WordExportRequest,
): Promise<string[]> {
  const trimmed = req.q.trim();
  const filters = req.filters ?? {};
  const sort = req.sort ?? "relevance";
  const size = Math.min(req.limit ?? WORD_MAX_LIMIT, WORD_MAX_LIMIT);

  const must: Record<string, unknown>[] = [];
  if (trimmed.length > 0) {
    must.push({
      multi_match: {
        query: trimmed,
        fields: [...PUBLICATION_FIELD_BOOSTS],
        type: "best_fields",
      },
    });
  } else {
    must.push({ match_all: {} });
  }

  const filter: Record<string, unknown>[] = [];
  if (filters.yearMin !== undefined || filters.yearMax !== undefined) {
    const range: Record<string, number> = {};
    if (filters.yearMin !== undefined) range.gte = filters.yearMin;
    if (filters.yearMax !== undefined) range.lte = filters.yearMax;
    filter.push({ range: { year: range } });
  }
  if (filters.publicationType) filter.push({ term: { publicationType: filters.publicationType } });
  if (filters.journal && filters.journal.length > 0) {
    filter.push({ terms: { "journal.keyword": filters.journal } });
  }
  if (filters.wcmAuthorRole && filters.wcmAuthorRole.length > 0) {
    filter.push({ terms: { wcmAuthorPositions: filters.wcmAuthorRole } });
  }
  if (filters.wcmAuthor && filters.wcmAuthor.length > 0) {
    filter.push({ terms: { wcmAuthorCwids: filters.wcmAuthor } });
  }

  const sortClause: Record<string, "asc" | "desc">[] = [];
  if (sort === "year") sortClause.push({ year: "desc" });
  else if (sort === "citations") sortClause.push({ citationCount: "desc" });

  const resp = await searchClient().search({
    index: PUBLICATIONS_INDEX,
    body: {
      from: 0,
      size,
      track_total_hits: false,
      query: { bool: { must, filter } },
      ...(sortClause.length > 0 ? { sort: sortClause } : {}),
      _source: ["pmid"],
    } as object,
  });
  type Hit = { _source: { pmid: string } };
  const r = resp.body as unknown as { hits: { hits: Hit[] } };
  return r.hits.hits.map((h) => h._source.pmid);
}

// Strip the legacy `((...))` WCM marker from a token (only present in
// the truncated `authorsString` fallback path; `fullAuthorsString` from
// the issue #89 ETL has no markers).
const WCM_MARKER_TOKEN_RE = /^\(\((.+)\)\)$/;

function unwrapMarker(token: string): string {
  const m = WCM_MARKER_TOKEN_RE.exec(token);
  return m ? m[1]! : token;
}

/** Render an author list as comma-separated runs. Bold the tokens whose
 *  surname matches one of the selected scholars' last names. Works for
 *  both the new `fullAuthorsString` (no markers) and the legacy
 *  `authorsString` (with `((...))` markers around WCM authors, which we
 *  strip before display). */
function buildAuthorRuns(
  authorsString: string | null,
  selectedLastNames: ReadonlySet<string>,
): TextRun[] {
  if (!authorsString) return [new TextRun({ text: "" })];
  const tokens = authorsString
    .split(/,\s*/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) return [new TextRun({ text: authorsString })];

  const runs: TextRun[] = [];
  tokens.forEach((rawToken, idx) => {
    if (idx > 0) runs.push(new TextRun({ text: ", " }));
    const display = unwrapMarker(rawToken);
    // PubMed token format is "Lastname Initials" — surname is the first
    // whitespace-separated word. Strip residual punctuation so brackets
    // or stray dots don't break the lookup.
    const surname = (display.split(/\s+/)[0] ?? "")
      .replace(/[^\p{L}'-]/gu, "")
      .toLowerCase();
    runs.push(
      new TextRun({ text: display, bold: selectedLastNames.has(surname) }),
    );
  });
  return runs;
}

/** Drop ", MD"-style postnominals, take final whitespace token, lower-
 *  cased — same heuristic the AuthorFacet sort key uses. */
function lastNameKey(displayName: string): string {
  const noPostnom = displayName.split(/,\s*/)[0] ?? displayName;
  const tokens = noPostnom.trim().split(/\s+/);
  return (tokens[tokens.length - 1] ?? "").toLowerCase();
}

function hyperlinkRun(text: string, href: string): ExternalHyperlink {
  return new ExternalHyperlink({
    link: href,
    children: [new TextRun({ text, style: "Hyperlink" })],
  });
}

type PubForCitation = {
  pmid: string;
  title: string;
  authorsString: string | null;
  fullAuthorsString: string | null;
  journal: string | null;
  journalAbbrev: string | null;
  year: number | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  doi: string | null;
  pmcid: string | null;
};

/** Replace smart quotes / dashes with their straight ASCII equivalents
 *  for citation consistency. PubMed records inherit publisher-supplied
 *  punctuation; bibliographies look uneven when half the titles have
 *  curly quotes and half don't. */
function normalizeCitationPunctuation(s: string): string {
  return s
    .replace(/[‘’‚‛]/g, "'") // curly singles → '
    .replace(/[“”„‟]/g, '"') // curly doubles → "
    .replace(/–/g, "-") // en dash → hyphen (page ranges)
    .replace(/—/g, "--"); // em dash
}

/** Parse PubMed-style inline tags (`<i>`, `<sup>`, `<sub>`, case-
 *  insensitive) in an article title and emit appropriate runs. Anything
 *  outside a recognized tag is plain text. Smart quotes are normalized
 *  in the same pass. Unknown tags are stripped (rare; PubMed publishes
 *  a small fixed set). */
function buildTitleRuns(title: string): TextRun[] {
  const runs: TextRun[] = [];
  // Tag tokens we recognize. `<sub>` / `<sup>` map to baseline shifts;
  // `<i>` to italic. We don't render `<b>`/`<u>` in titles — Vancouver
  // titles are sentence case, plain.
  const tokenRe = /<\/?(i|sup|sub|b|u)>/gi;
  let lastIndex = 0;
  const stack: Array<"i" | "sup" | "sub"> = [];
  const flush = (text: string) => {
    if (!text) return;
    const cleanText = normalizeCitationPunctuation(text);
    runs.push(
      new TextRun({
        text: cleanText,
        ...(stack.includes("i") ? { italics: true } : {}),
        ...(stack.includes("sup") ? { superScript: true } : {}),
        ...(stack.includes("sub") ? { subScript: true } : {}),
      }),
    );
  };
  for (const m of title.matchAll(tokenRe)) {
    const start = m.index ?? 0;
    if (start > lastIndex) flush(title.slice(lastIndex, start));
    const tag = (m[1] ?? "").toLowerCase();
    const isClose = m[0]!.startsWith("</");
    if (tag === "i" || tag === "sup" || tag === "sub") {
      if (isClose) {
        const idx = stack.lastIndexOf(tag);
        if (idx >= 0) stack.splice(idx, 1);
      } else {
        stack.push(tag);
      }
    }
    // <b>/<u> tokens are silently dropped per Vancouver title styling.
    lastIndex = start + m[0]!.length;
  }
  if (lastIndex < title.length) flush(title.slice(lastIndex));
  if (runs.length === 0) flush(title);
  return runs;
}

/** Build the volume/issue/pages segment in NLM punctuation. Output:
 *  ";Vol(Issue):Pages." with each piece omitted gracefully when null.
 *  Returns "" when all three are null so the citation skips the block. */
function formatVolIssuePages(
  volume: string | null,
  issue: string | null,
  pages: string | null,
): string {
  if (!volume && !issue && !pages) return "";
  let s = "";
  if (volume) s += volume;
  if (issue) s += `(${issue})`;
  if (pages) s += `:${pages}`;
  return s;
}

function buildCitationParagraph(
  index: number,
  pub: PubForCitation,
  selectedLastNames: ReadonlySet<string>,
): Paragraph {
  // Prefer the un-truncated `fullAuthorsString` (issue #89 ETL); fall
  // back to the legacy `authorsString` for any pub the new ETL hasn't
  // backfilled yet.
  const authorsForCitation = pub.fullAuthorsString ?? pub.authorsString;
  const authorRuns = buildAuthorRuns(authorsForCitation, selectedLastNames);

  // Vancouver journal/date block: `Abbrev. Year;Vol(Issue):Pages.`
  // Falls back to the verbose journal title when the abbreviation is
  // missing — happens for ~5% of pubs the ETL didn't hit.
  const journalForCitation = pub.journalAbbrev ?? pub.journal ?? "";
  const volIssuePages = formatVolIssuePages(pub.volume, pub.issue, pub.pages);
  // Title strips a single trailing period (PubMed inconsistency); we
  // always re-emit one after the title so spacing is uniform.
  const titleClean = pub.title.replace(/\.+$/, "");
  const titleRuns = buildTitleRuns(titleClean);

  // PMID/PMCID assemble as one block joined by ; (NLM convention) with
  // a single trailing period after the whole block.
  const idRuns: (TextRun | ExternalHyperlink)[] = [
    new TextRun({ text: "PMID: " }),
    hyperlinkRun(pub.pmid, `https://pubmed.ncbi.nlm.nih.gov/${pub.pmid}/`),
  ];
  if (pub.pmcid) {
    idRuns.push(new TextRun({ text: "; PMCID: " }));
    idRuns.push(
      hyperlinkRun(
        pub.pmcid,
        `https://www.ncbi.nlm.nih.gov/pmc/articles/${pub.pmcid}/`,
      ),
    );
  }
  idRuns.push(new TextRun({ text: "." }));

  const children: (TextRun | ExternalHyperlink)[] = [
    new TextRun({ text: `${index + 1}. ` }),
    ...authorRuns,
    new TextRun({ text: ". " }),
    ...titleRuns,
    new TextRun({ text: ". " }),
    ...(journalForCitation
      ? [new TextRun({ text: journalForCitation + ". " })]
      : []),
    ...(pub.year !== null
      ? [
          new TextRun({
            text: volIssuePages
              ? `${pub.year};${volIssuePages}. `
              : `${pub.year}. `,
          }),
        ]
      : []),
    ...(pub.doi
      ? [
          new TextRun({ text: "doi: " }),
          hyperlinkRun(pub.doi, `https://doi.org/${pub.doi}`),
          new TextRun({ text: ". " }),
        ]
      : []),
    ...idRuns,
  ];

  return new Paragraph({
    children,
    indent: { left: HANGING_INDENT_TWIPS, hanging: HANGING_INDENT_TWIPS },
    spacing: { after: 120 }, // 6pt — single-spaced citations with breathing room
  });
}

/** Render a one-line filter summary for the document header so the file
 *  is self-describing when re-opened months later. */
function buildFilterSummary(req: WordExportRequest, count: number): string {
  const bits: string[] = [];
  if (req.q.trim()) bits.push(`Search: ${req.q.trim()}`);
  const f = req.filters ?? {};
  if (f.yearMin !== undefined || f.yearMax !== undefined) {
    if (f.yearMin !== undefined && f.yearMax !== undefined) {
      bits.push(f.yearMin === f.yearMax ? `${f.yearMin}` : `${f.yearMin}–${f.yearMax}`);
    } else if (f.yearMin !== undefined) {
      bits.push(`${f.yearMin}–present`);
    } else {
      bits.push(`through ${f.yearMax}`);
    }
  }
  if (f.publicationType) bits.push(displayPublicationType(f.publicationType));
  if (f.wcmAuthorRole && f.wcmAuthorRole.length > 0) {
    bits.push(f.wcmAuthorRole.map((r) => `${r} author`).join(" / "));
  }
  if (f.journal && f.journal.length > 0) {
    bits.push(`${f.journal.length} journal${f.journal.length === 1 ? "" : "s"}`);
  }
  if (f.wcmAuthor && f.wcmAuthor.length > 0) {
    bits.push(`${f.wcmAuthor.length} author${f.wcmAuthor.length === 1 ? "" : "s"}`);
  }
  bits.push(`${count.toLocaleString()} publication${count === 1 ? "" : "s"}`);
  return bits.join(" · ");
}

export async function generateWordBibliography(
  req: WordExportRequest,
): Promise<{ buffer: Buffer; rowCount: number }> {
  const pmids = await fetchPmidsForBibliography(req);
  if (pmids.length === 0) {
    // Render an empty document with just the header so the user still
    // gets a file rather than a 0-byte download confusing the browser.
    const doc = emptyDoc(req);
    const buffer = await Packer.toBuffer(doc);
    return { buffer, rowCount: 0 };
  }

  const pubs = await prisma.publication.findMany({
    where: { pmid: { in: pmids } },
    select: {
      pmid: true,
      title: true,
      authorsString: true,
      fullAuthorsString: true,
      journal: true,
      journalAbbrev: true,
      year: true,
      volume: true,
      issue: true,
      pages: true,
      doi: true,
      pmcid: true,
    },
  });
  const byPmid = new Map(pubs.map((p) => [p.pmid, p]));
  const ordered = pmids.map((p) => byPmid.get(p)).filter(Boolean) as PubForCitation[];

  // Resolve the selected wcmAuthor CWIDs to last-name keys for bolding.
  // No selection → empty set → nothing bold (intentional per spec for
  // the biosketch workflow).
  const selectedCwids = req.filters?.wcmAuthor ?? [];
  const selectedScholars = selectedCwids.length === 0
    ? []
    : await prisma.scholar.findMany({
        where: { cwid: { in: selectedCwids } },
        select: { preferredName: true },
      });
  const selectedLastNames = new Set<string>(
    selectedScholars.map((s) => lastNameKey(s.preferredName)),
  );

  const citationParagraphs = ordered.map((pub, i) =>
    buildCitationParagraph(i, pub, selectedLastNames),
  );

  const headerParagraphs: Paragraph[] = [
    new Paragraph({
      children: [
        new TextRun({
          text: "Bibliography — Scholars @ Weill Cornell Medicine",
          bold: true,
          size: 28, // 14pt half-points
        }),
      ],
      spacing: { after: 120 },
    }),
    new Paragraph({
      children: [
        new TextRun({
          text: buildFilterSummary(req, ordered.length),
          italics: true,
          color: "555555",
        }),
      ],
      spacing: { after: 360 },
    }),
  ];

  const doc = new Document({
    creator: "Scholars @ Weill Cornell Medicine",
    title: "Bibliography",
    styles: {
      default: {
        document: {
          run: { font: "Arial", size: 22 }, // 11pt
        },
      },
    },
    sections: [
      {
        properties: {},
        children: [...headerParagraphs, ...citationParagraphs],
        footers: { default: pageNumberFooter() },
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  return { buffer, rowCount: ordered.length };
}

function pageNumberFooter(): Footer {
  return new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({ children: ["Page ", PageNumber.CURRENT] }),
        ],
      }),
    ],
  });
}

function emptyDoc(req: WordExportRequest): Document {
  return new Document({
    creator: "Scholars @ Weill Cornell Medicine",
    title: "Bibliography",
    sections: [
      {
        properties: {},
        children: [
          new Paragraph({
            children: [
              new TextRun({
                text: "Bibliography — Scholars @ Weill Cornell Medicine",
                bold: true,
                size: 28,
              }),
            ],
          }),
          new Paragraph({
            children: [
              new TextRun({
                text: buildFilterSummary(req, 0) + ". No publications match.",
                italics: true,
                color: "555555",
              }),
            ],
          }),
        ],
        footers: { default: pageNumberFooter() },
      },
    ],
  });
}
