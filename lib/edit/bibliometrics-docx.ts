/**
 * The Bibliometrics report as a Word document. Renders the same
 * `BibliometricsReport` the `/edit` tab shows, with every citing list written
 * out in full (the plan: the document errs verbose).
 */
import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";

import { citationIdentifier } from "@/lib/citation";
import { policyDocCitation } from "@/lib/citations/policy-rollup";
import { buildPubmedRuns } from "@/lib/pubmed-runs";
import { NO_STAGE_LABEL, STAGE_BUCKETS, translationalStageDisplay } from "@/lib/translational-stage";
import {
  NO_SUMMARY_NOTE,
  POLICY_LEVEL_LABELS,
  POSITION_LABEL,
  TOP_DECILE_LABEL,
  filtersNote,
  papersNote,
  percentileText,
  unratedNote,
  type BibliometricsPaper,
  type BibliometricsReport,
} from "@/lib/edit/bibliometrics";

const text = (t: string, opts: { bold?: boolean; italics?: boolean } = {}) => new TextRun({ text: t, ...opts });
const para = (t: string) => new Paragraph({ spacing: { after: 120 }, children: [text(t)] });
const heading = (t: string) =>
  new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 280, after: 120 }, children: [text(t)] });

function table(header: string[], rows: string[][]): Table {
  const row = (cells: string[], bold: boolean) =>
    new TableRow({
      children: cells.map(
        (c) => new TableCell({ children: [new Paragraph({ children: [text(c, { bold })] })] }),
      ),
    });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [row(header, true), ...rows.map((r) => row(r, false))],
  });
}

function paperParagraphs(p: BibliometricsPaper, index: number): Paragraph[] {
  const id = citationIdentifier(p.pmid);
  const out = [
    new Paragraph({
      spacing: { before: 200 },
      children: [
        text(`${index + 1}. `),
        ...p.authors.flatMap((a, i) => [text(i > 0 ? ", " : ""), text(a.name, { bold: a.bold })]),
        text(p.etAl ? ", et al. " : p.authors.length > 0 ? ". " : ""),
        ...buildPubmedRuns(p.title.replace(/[.\s]+$/, "")),
        text(". "),
        ...(p.journal ? [text(p.journal, { italics: true }), text(". ")] : []),
        text(p.dated ? `${p.dated}. ` : ""),
        text(`${id.label} ${id.value}`),
        text(p.doi ? ` · DOI ${p.doi}` : ""),
      ],
    }),
    para(
      [
        `Position: ${POSITION_LABEL[p.position]}`,
        `NIH percentile: ${percentileText(p)}`,
        `Citation ratio: ${p.relativeCitationRatio?.toFixed(1) ?? "n/a"}`,
        `Cited by: ${p.citationCount.toLocaleString("en-US")}`,
      ].join("  |  "),
    ),
  ];
  for (const [level, label] of POLICY_LEVEL_LABELS) {
    const docs = p.citing.filter((d) => d.level === level);
    if (docs.length === 0) continue;
    const total = level === "review" ? p.reviewTotal : docs.length;
    out.push(new Paragraph({ children: [text(`${label} · ${total}`, { bold: true })] }));
    for (const d of docs) {
      out.push(
        new Paragraph({
          bullet: { level: 0 },
          children: [
            text(d.level === "authority" ? `${d.issuingBody}${d.year ? ` · ${d.year}` : ""}. ` : ""),
            ...buildPubmedRuns(d.title.replace(/[.\s]+$/, "")),
            text(". "),
            text(policyDocCitation(d)),
            text(d.pmid ? ` PMID ${d.pmid}` : d.bookshelfId ? ` NCBI Bookshelf ${d.bookshelfId}` : ""),
            text(d.doi ? ` · DOI ${d.doi}` : ""),
          ],
        }),
      );
    }
    if (total > docs.length) {
      out.push(para(`The ${docs.length} most recent of ${total.toLocaleString("en-US")} are listed.`));
    }
  }
  return out;
}

/** The tab's stage table, without its paper lists. */
function stageBlocks(s: NonNullable<BibliometricsReport["stages"]>, filters: string | null): Array<Paragraph | Table> {
  const total = STAGE_BUCKETS.reduce((n, k) => n + s.counts[k], 0);
  return [
    heading("Translational stage"),
    para(`Research articles${filters ? `, filters: ${filters}` : ""}. Shares are among papers with a stage.`),
    table(
      ["Stage", "Papers", "Share"],
      [
        ...STAGE_BUCKETS.map((k) => [
          k === "none" ? NO_STAGE_LABEL : translationalStageDisplay(k),
          String(s.counts[k]),
          k === "none" ? "–" : `${s.shares[k]}%`,
        ]),
        ["All research articles", String(total), "–"],
      ],
    ),
  ];
}

export async function buildBibliometricsDocx(r: BibliometricsReport): Promise<Buffer> {
  const asOf = new Date(`${r.asOf}T00:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
  const filters = filtersNote(r.filters);
  const unrated = unratedNote(r);
  const children: Array<Paragraph | Table> = [
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [text(`Bibliometrics: ${r.scholar.name}`)] }),
    para(`Calculated from publications in Scholars on ${asOf}.`),
    // Every figure but the h-index and h5-index follows these.
    ...(filters ? [para(`Filters: ${filters}.`)] : []),

    heading("Summary"),
    para(r.summary.length > 0 ? `${r.scholar.name} ${r.summary.join(" ")}` : NO_SUMMARY_NOTE),

    heading("Citation metrics"),
    para(`h-index (all publications): ${r.metrics.hIndex}`),
    para(`h5-index (last 5 years, all publications): ${r.metrics.h5Index}`),
    ...(r.metrics.topDecilePct !== null ? [para(`${r.metrics.topDecilePct}% ${TOP_DECILE_LABEL}`)] : []),
    ...(unrated ? [para(unrated)] : []),

    heading("Output"),
    table(
      ["By author position", "Research articles"],
      [
        ["First author", String(r.output.first)],
        ["Senior author", String(r.output.senior)],
        ["Co-author", String(r.output.coAuthor)],
        ["All research articles", String(r.output.total)],
      ],
    ),
    ...(r.output.byYear.length > 0
      ? [
          para(""),
          table(
            r.output.byYear.map((y) => String(y.year)),
            [r.output.byYear.map((y) => String(y.count))],
          ),
        ]
      : []),

    heading("Most impactful papers"),
    ...r.papers.rows.flatMap(paperParagraphs),
    para(r.papers.rows.length > 0 ? papersNote(r) : "No research articles match."),

    ...(r.stages ? stageBlocks(r.stages, filters) : []),

    heading("Downstream impact"),
    table(
      ["Cited in", "Articles cited", "Citing documents"],
      [
        ...r.policy.map((l) => [
          l.bodies.length > 0
            ? `${l.label} (${l.bodies.map((b) => `${b.body} · ${b.count}`).join(", ")})`
            : l.label,
          String(l.papers),
          String(l.documents),
        ]),
        ["Clinical studies (excluding the article's own authors)", String(r.research.clinical.papers), String(r.research.clinical.documents)],
        ["Registered trials (excluding the article's own authors)", String(r.research.trial.papers), String(r.research.trial.documents)],
        [
          `Patents${r.patents.dataEnd ? ` (patent data through ${r.patents.dataEnd})` : ""}`,
          String(r.patents.papers),
          `${r.patents.inventions} inventions`,
        ],
      ],
    ),

    heading("Definitions and sources"),
    ...r.definitions.map(
      (d) =>
        new Paragraph({
          spacing: { after: 80 },
          children: [...(d.term ? [text(`${d.term}: `, { bold: true })] : []), text(d.text)],
        }),
    ),
  ];
  const doc = new Document({
    creator: "Scholars @ Weill Cornell Medicine",
    title: `Bibliometrics: ${r.scholar.name}`,
    styles: { default: { document: { run: { font: "Arial", size: 22 } } } },
    sections: [{ properties: {}, children }],
  });
  return await Packer.toBuffer(doc);
}
