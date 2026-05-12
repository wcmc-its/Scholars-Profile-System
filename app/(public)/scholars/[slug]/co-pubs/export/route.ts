/**
 * GET /scholars/<slug>/co-pubs/export?format=csv|docx
 *
 * Mentor-level rollup export (issue #189). Sibling of the per-mentee
 * export at `/scholars/<slug>/co-pubs/<menteeCwid>/export`.
 *
 * CSV: adds `mentee_name`, `mentee_program`, and `copub_id` columns. A
 *      pub tying to N mentees produces N rows sharing one `copub_id`,
 *      so consumers counting publications can `DISTINCT copub_id`.
 *
 * Word: structured per program group. Group heading as Heading 2;
 *       under each citation, a "Mentee: <Name> · <Program> · Class of YYYY"
 *       sub-bullet. Mentor + every mentee in the rollup are bolded
 *       throughout the author lists.
 *
 * Filename: co-pubs_<mentor-cwid>_all.{csv,docx}.
 */
import { NextResponse, type NextRequest } from "next/server";
import {
  AlignmentType,
  Document,
  ExternalHyperlink,
  Footer,
  HeadingLevel,
  PageNumber,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import { prisma } from "@/lib/db";
import {
  copubId,
  formatProgramLabel,
  getAllMentorCoPublications,
  type CoPublicationAuthor,
  type CoPublicationFull,
  type MenteeCoPubGroup,
} from "@/lib/api/mentoring";
import { toCsv } from "@/lib/csv";
import { formatPublishedName } from "@/lib/postnominal";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const FORMAT_ALLOWLIST = new Set(["csv", "docx"]);

type Params = { slug: string };

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<Params> },
) {
  const { slug } = await ctx.params;
  const format = new URL(request.url).searchParams.get("format") ?? "csv";
  if (!FORMAT_ALLOWLIST.has(format)) {
    return NextResponse.json({ error: "invalid format" }, { status: 400 });
  }

  const mentor = await prisma.scholar.findFirst({
    where: { slug, deletedAt: null, status: "active" },
    select: { cwid: true, preferredName: true, postnominal: true },
  });
  if (!mentor) {
    return NextResponse.json({ error: "mentor not found" }, { status: 404 });
  }

  const mentorName = formatPublishedName(mentor.preferredName, mentor.postnominal);

  const rollup = await getAllMentorCoPublications(mentor.cwid);
  const filename = `co-pubs_${mentor.cwid}_all.${format}`;

  if (format === "csv") {
    const csv = renderCsv(rollup.groups);
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
    rollup,
    mentorCwid: mentor.cwid,
    mentorName,
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

const CSV_HEADERS = [
  "pmid",
  "year",
  "journal",
  "title",
  "authors",
  "mentee_name",
  "mentee_program",
  "copub_id",
] as const;

function renderCsv(groups: MenteeCoPubGroup[]): string {
  const rows: (string | number | null)[][] = [];
  for (const g of groups) {
    for (const e of g.entries) {
      rows.push([
        String(e.publication.pmid),
        e.publication.year,
        e.publication.journal ?? "",
        e.publication.title,
        e.publication.authors.map(authorToVancouverToken).join("; "),
        e.mentee.fullName,
        g.programLabel,
        copubId(e.publication),
      ]);
    }
  }
  return toCsv([...CSV_HEADERS], rows);
}

/** Vancouver token: "Lastname Initials" (e.g. "Smith JA"). Initials are
 *  the first letter of each whitespace-separated first/middle name with
 *  no periods. */
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
  rollup: Awaited<ReturnType<typeof getAllMentorCoPublications>>;
  mentorCwid: string;
  mentorName: string;
}): Promise<Buffer> {
  const { rollup, mentorCwid, mentorName } = opts;
  const { groups, publicationCount, menteeCount } = rollup;

  // Bold every mentee that appears anywhere in the rollup (plus the
  // mentor). A pub may surface in multiple groups, but the bold-cwids
  // set is global.
  const boldCwids = new Set<string>([mentorCwid]);
  for (const g of groups) {
    for (const e of g.entries) boldCwids.add(e.mentee.cwid);
  }

  const headerParagraphs: Paragraph[] = [
    new Paragraph({
      children: [
        new TextRun({
          text: "Co-authored publications with mentees",
          bold: true,
          size: 28, // 14pt
        }),
      ],
      spacing: { after: 120 },
    }),
    new Paragraph({
      children: [
        new TextRun({
          text: `${mentorName} · ${publicationCount} publication${publicationCount === 1 ? "" : "s"} across ${menteeCount} mentee${menteeCount === 1 ? "" : "s"}`,
          italics: true,
          color: "555555",
        }),
      ],
      spacing: { after: 360 },
    }),
  ];

  const bodyChildren: Paragraph[] = [];
  if (groups.length === 0) {
    bodyChildren.push(
      new Paragraph({
        children: [
          new TextRun({
            text: "No co-authored publications with mentees yet.",
            italics: true,
            color: "555555",
          }),
        ],
      }),
    );
  } else {
    let citationIndex = 0;
    for (const g of groups) {
      bodyChildren.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun({ text: g.programLabel, bold: true, size: 24 })],
          spacing: { before: 240, after: 120 },
        }),
      );
      for (const e of g.entries) {
        citationIndex += 1;
        bodyChildren.push(
          buildCitationParagraph(citationIndex, e.publication, boldCwids),
        );
        // Mentee sub-bullet under each citation.
        const yearSeg = e.mentee.graduationYear
          ? ` · Class of ${e.mentee.graduationYear}`
          : "";
        const subProgramLabel =
          formatProgramLabel(e.mentee.programType) ?? "Other mentee";
        bodyChildren.push(
          new Paragraph({
            children: [
              new TextRun({
                text: `Mentee: ${e.mentee.fullName} · ${subProgramLabel}${yearSeg}`,
                italics: true,
                color: "555555",
              }),
            ],
            indent: { left: HANGING_INDENT_TWIPS * 2 },
            spacing: { after: 160 },
          }),
        );
      }
    }
  }

  const doc = new Document({
    creator: "Scholars @ Weill Cornell Medicine",
    title: `Co-authored publications with mentees — ${mentorName}`,
    styles: {
      default: { document: { run: { font: "Arial", size: 22 } } },
    },
    sections: [
      {
        properties: {},
        children: [...headerParagraphs, ...bodyChildren],
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
  const journal = pub.journal ?? "";
  const volIssuePages = formatVolIssuePages(pub.volume, pub.issue, pub.pages);

  const idRuns: (TextRun | ExternalHyperlink)[] = [
    new TextRun({ text: "PMID: " }),
    new ExternalHyperlink({
      link: `https://pubmed.ncbi.nlm.nih.gov/${pub.pmid}/`,
      children: [new TextRun({ text: String(pub.pmid), style: "Hyperlink" })],
    }),
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
    new TextRun({ text: `${index}. ` }),
    ...authorRuns,
    new TextRun({ text: ". " }),
    new TextRun({ text: titleClean }),
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
    spacing: { after: 60 },
  });
}

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
