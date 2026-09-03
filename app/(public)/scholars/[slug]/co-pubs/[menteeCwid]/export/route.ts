/**
 * GET /scholars/<slug>/co-pubs/<menteeCwid>/export?format=csv|docx
 *
 * Returns the same publications as the co-pubs page (#184) as a
 * downloadable file. Two formats:
 *  - csv  : RFC-4180 CSV with pmid, year, journal, title, authors.
 *  - docx : Vancouver-style bibliography rendered with `docx`, mentor +
 *           mentee surnames bolded throughout.
 *
 * The route is publicly reachable (the page is too — `(public)` segment).
 * No auth gating in v1; mirrors `/api/export/publications/*`.
 */
import { NextResponse, type NextRequest } from "next/server";
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
import { isPubliclyDisplayed, publicRoleWhere } from "@/lib/eligibility";
import {
  getCoPublications,
  getMentorMenteePair,
  type CoPublicationAuthor,
  type CoPublicationFull,
} from "@/lib/api/mentoring";
import { citationIdentifier, formatVolIssuePages } from "@/lib/citation";
import { toCsv } from "@/lib/csv";
import { htmlToPlainText } from "@/lib/utils";
import { buildPubmedRuns } from "@/lib/pubmed-runs";

export const dynamic = "force-dynamic";
// `maxDuration` is inert under `output: "standalone"`; the real budget this route is
// bound by in prod is CloudFront's 30s origin-read timeout
// (`/scholars/*/co-pubs/*/export` behavior).

const FORMAT_ALLOWLIST = new Set(["csv", "docx"]);

type Params = { slug: string; menteeCwid: string };

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<Params> },
) {
  const { slug, menteeCwid } = await ctx.params;
  const format = new URL(request.url).searchParams.get("format") ?? "csv";
  if (!FORMAT_ALLOWLIST.has(format)) {
    return NextResponse.json({ error: "invalid format" }, { status: 400 });
  }

  // #2268 — same two-layer #536 carve as the page this exports: the download
  // publishes the mentor's name in every citation row.
  const mentor = await prisma.scholar.findFirst({
    where: { slug, deletedAt: null, status: "active", ...publicRoleWhere() },
    select: { cwid: true, preferredName: true, postnominal: true, roleCategory: true },
  });
  if (!mentor || !isPubliclyDisplayed(mentor.roleCategory)) {
    return NextResponse.json({ error: "mentor not found" }, { status: 404 });
  }

  const pair = await getMentorMenteePair(mentor.cwid, menteeCwid);
  if (!pair) {
    return NextResponse.json({ error: "mentee not found" }, { status: 404 });
  }

  // #2011 follow-up — same provenance routing as the page it exports.
  const pubs = await getCoPublications(mentor.cwid, menteeCwid, {
    manualOnly: pair.manualOnly,
  });

  const filename = `co-pubs_${mentor.cwid}_${menteeCwid}.${format}`;

  if (format === "csv") {
    const csv = renderCsv(pubs);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  }

  const buffer = await renderDocx({
    pubs,
    mentorCwid: mentor.cwid,
    menteeCwid,
    mentorName: pair.mentorName,
    menteeName: pair.menteeName,
  });
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

const CSV_HEADERS = ["pmid", "year", "journal", "title", "authors"] as const;

function renderCsv(pubs: CoPublicationFull[]): string {
  const rows = pubs.map((p) => [
    String(p.pmid),
    p.year,
    p.journal ?? "",
    // PubMed titles carry inline HTML (`<i>`, `<sup>`); strip for CSV so
    // spreadsheets don't show literal `<sup>+</sup>` (#331).
    htmlToPlainText(p.title, Number.POSITIVE_INFINITY),
    p.authors.map(authorToVancouverToken).join("; "),
  ]);
  return toCsv([...CSV_HEADERS], rows);
}

/** Vancouver token: "Lastname Initials" (e.g. "Smith JA"). Initials are
 *  the first letter of each whitespace-separated first/middle name with
 *  no periods. Empty firstName → just the lastname. */
function authorToVancouverToken(a: CoPublicationAuthor): string {
  const initials = (a.firstName ?? "")
    .split(/\s+/)
    .map((p) => p.charAt(0).toUpperCase())
    .filter(Boolean)
    .join("");
  return initials ? `${a.lastName} ${initials}` : a.lastName;
}

const HANGING_INDENT_TWIPS = 360;

async function renderDocx(opts: {
  pubs: CoPublicationFull[];
  mentorCwid: string;
  menteeCwid: string;
  mentorName: string;
  menteeName: string;
}): Promise<Buffer> {
  const { pubs, mentorCwid, menteeCwid, mentorName, menteeName } = opts;
  const boldCwids = new Set<string>([mentorCwid, menteeCwid]);

  const headerParagraphs: Paragraph[] = [
    new Paragraph({
      children: [
        new TextRun({
          text: "Co-authored publications",
          bold: true,
          size: 28, // 14pt
        }),
      ],
      spacing: { after: 120 },
    }),
    new Paragraph({
      children: [
        new TextRun({
          text: `${mentorName} and ${menteeName} · ${pubs.length} publication${pubs.length === 1 ? "" : "s"}`,
          italics: true,
          color: "555555",
        }),
      ],
      spacing: { after: 360 },
    }),
  ];

  const citationParagraphs = pubs.map((p, i) =>
    buildCitationParagraph(i, p, boldCwids),
  );

  const doc = new Document({
    creator: "Scholars @ Weill Cornell Medicine",
    title: `Co-authored publications — ${mentorName} and ${menteeName}`,
    styles: {
      default: { document: { run: { font: "Arial", size: 22 } } },
    },
    sections: [
      {
        properties: {},
        children:
          pubs.length === 0
            ? [
                ...headerParagraphs,
                new Paragraph({
                  children: [
                    new TextRun({
                      text: "No co-authored publications found.",
                      italics: true,
                      color: "555555",
                    }),
                  ],
                }),
              ]
            : [...headerParagraphs, ...citationParagraphs],
        footers: { default: pageNumberFooter() },
      },
    ],
  });

  return await Packer.toBuffer(doc);
}

function buildCitationParagraph(
  index: number,
  pub: CoPublicationFull,
  boldCwids: ReadonlySet<string>,
): Paragraph {
  const authorRuns: TextRun[] = [];
  pub.authors.forEach((a, i) => {
    if (i > 0) authorRuns.push(new TextRun({ text: ", " }));
    const token = authorToVancouverToken(a);
    const bold = a.personIdentifier !== null && boldCwids.has(a.personIdentifier);
    authorRuns.push(new TextRun({ text: token, bold }));
  });

  const titleClean = (pub.title ?? "").replace(/\.+$/, "");
  // Honor inline PubMed markup (`<i>`, `<sup>`, `<sub>`) so titles like
  // `H<sub>2</sub>O` render with real subscript runs (#331).
  const titleRuns = buildPubmedRuns(titleClean);
  const journal = pub.journal ?? "";
  // #2580 — the shared formatter treats a literal "NULL" volume/issue/pages as
  // absent; the local copy printed `2024;NULL(NULL):NULL.` into the .docx.
  const volIssuePages = formatVolIssuePages(pub.volume, pub.issue, pub.pages);

  // #2580 — `CoPublicationFull.pmid` is a number, but ReciterDB assigns external
  // (non-PubMed) records a synthetic NEGATIVE pmid, which this used to label
  // `PMID:` and link as `pubmed.ncbi.nlm.nih.gov/-3/` — dead in the reader's
  // Word document. The shared helper labels such a row "Source: External" and
  // returns no href.
  const id = citationIdentifier(pub.pmid);
  const idRuns: (TextRun | ExternalHyperlink)[] = [
    new TextRun({ text: `${id.label}: ` }),
    id.href
      ? new ExternalHyperlink({
          link: id.href,
          children: [new TextRun({ text: id.value, style: "Hyperlink" })],
        })
      : new TextRun({ text: id.value }),
  ];
  if (pub.pmcid) {
    idRuns.push(new TextRun({ text: "; PMCID: " }));
    idRuns.push(
      new ExternalHyperlink({
        link: `https://www.ncbi.nlm.nih.gov/pmc/articles/${pub.pmcid}/`,
        children: [new TextRun({ text: pub.pmcid, style: "Hyperlink" })],
      }),
    );
  }
  idRuns.push(new TextRun({ text: "." }));

  const children: (TextRun | ExternalHyperlink)[] = [
    new TextRun({ text: `${index + 1}. ` }),
    ...authorRuns,
    new TextRun({ text: ". " }),
    ...titleRuns,
    new TextRun({ text: ". " }),
    ...(journal ? [new TextRun({ text: `${journal}. ` })] : []),
    ...(pub.year !== null
      ? [new TextRun({ text: volIssuePages ? `${pub.year};${volIssuePages}. ` : `${pub.year}. ` })]
      : []),
    ...(pub.doi
      ? [
          new TextRun({ text: "doi: " }),
          new ExternalHyperlink({
            link: `https://doi.org/${pub.doi}`,
            children: [new TextRun({ text: pub.doi, style: "Hyperlink" })],
          }),
          new TextRun({ text: ". " }),
        ]
      : []),
    ...idRuns,
  ];

  return new Paragraph({
    children,
    indent: { left: HANGING_INDENT_TWIPS, hanging: HANGING_INDENT_TWIPS },
    spacing: { after: 120 },
  });
}

function pageNumberFooter(): Footer {
  return new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ children: ["Page ", PageNumber.CURRENT] })],
      }),
    ],
  });
}
