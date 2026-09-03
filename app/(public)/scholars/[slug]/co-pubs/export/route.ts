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
import { isPubliclyDisplayed, publicRoleWhere } from "@/lib/eligibility";
import {
  copubId,
  menteeProgramLabel,
  getAllMentorCoPublications,
  type CoPublicationAuthor,
  type CoPublicationFull,
  type MenteeCoPubGroup,
} from "@/lib/api/mentoring";
import { citationIdentifier, formatVolIssuePages } from "@/lib/citation";
import { toCsv } from "@/lib/csv";
import { htmlToPlainText } from "@/lib/utils";
import { buildPubmedRuns } from "@/lib/pubmed-runs";
import { formatPublishedName } from "@/lib/postnominal";

export const dynamic = "force-dynamic";
// `maxDuration` is inert under `output: "standalone"`; the real budget this route is
// bound by in prod is CloudFront's 30s origin-read timeout
// (`/scholars/*/co-pubs/export` behavior).

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

  // #2268 — same two-layer #536 carve as the page this exports: the download
  // publishes the mentor's name in every citation row.
  const mentor = await prisma.scholar.findFirst({
    where: { slug, deletedAt: null, status: "active", ...publicRoleWhere() },
    select: { cwid: true, preferredName: true, postnominal: true, roleCategory: true },
  });
  if (!mentor || !isPubliclyDisplayed(mentor.roleCategory)) {
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
        // PubMed titles carry inline HTML (`<i>`, `<sup>`); strip for CSV
        // so spreadsheets don't show literal `<sup>+</sup>` (#331).
        htmlToPlainText(e.publication.title, Number.POSITIVE_INFINITY),
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
        // Issue #1019 — keep the degree visible when programName is the
        // source ("… (PhD)"); falls back to the degree-bucket label otherwise.
        const subProgramLabel =
          menteeProgramLabel(e.mentee.programName, e.mentee.programType) ??
          "Other mentee";
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
    new TextRun({ text: `${index}. ` }),
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
    spacing: { after: 60 },
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
