/**
 * WCM CV template-fill engine — loads the OFFICIAL WCM faculty-CV template
 * (`lib/edit/assets/wcm-cv-template.docx`) and injects data into its own tables
 * and paragraphs, the way CViche does (`stage_6_word_template.py`:
 * `Document(template_path)` + run-level edits). This preserves the template's
 * exact headings, subsections, table columns, fonts (Arial), and prompts —
 * unlike a from-scratch reconstruction.
 *
 * Generic OOXML helpers only (no SPS data knowledge). `cv-export.ts` owns the
 * section→data mapping and calls these.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

// @xmldom returns its own DOM nodes; type them structurally to avoid coupling to
// lib.dom. Only the members we touch are declared.
type XNode = {
  nodeType: number;
  childNodes: { length: number; item(i: number): XNode | null } & ArrayLike<XNode>;
  parentNode: XNode | null;
  textContent: string | null;
  tagName?: string;
  appendChild(n: XNode): XNode;
  insertBefore(n: XNode, ref: XNode | null): XNode;
  removeChild(n: XNode): XNode;
  cloneNode(deep: boolean): XNode;
  setAttribute?(name: string, value: string): void;
};
type XDoc = XNode & {
  documentElement: XNode;
  createElement(tag: string): XNode;
  createTextNode(text: string): XNode;
};

export type Run = { text: string; bold?: boolean };

// ponytail: module-relative resolve so the standalone build can find the asset
// (next.config `outputFileTracingIncludes` ships it). cwd works in dev + tests.
const TEMPLATE_PATH = path.join(process.cwd(), "lib", "edit", "assets", "wcm-cv-template.docx");

// Cache the raw template bytes (40 KB); parse a FRESH DOM per build since we mutate it.
let templateBytes: Buffer | null = null;
async function readTemplate(): Promise<Buffer> {
  if (!templateBytes) templateBytes = await readFile(TEMPLATE_PATH);
  return templateBytes;
}

export interface LoadedTemplate {
  zip: JSZip;
  doc: XDoc;
  body: XNode;
}

export async function loadTemplate(): Promise<LoadedTemplate> {
  const zip = await JSZip.loadAsync(await readTemplate());
  const file = zip.file("word/document.xml");
  if (!file) throw new Error("wcm-cv-template.docx is missing word/document.xml");
  const xml = await file.async("string");
  const doc = new DOMParser().parseFromString(xml, "text/xml") as unknown as XDoc;
  const body = childrenByTag(doc.documentElement, "w:body")[0];
  if (!body) throw new Error("template document.xml has no <w:body>");
  return { zip, doc, body };
}

export async function serialize(t: LoadedTemplate): Promise<Buffer> {
  const xml = new XMLSerializer().serializeToString(t.doc as unknown as Node);
  t.zip.file("word/document.xml", xml);
  return t.zip.generateAsync({ type: "nodebuffer" });
}

// ── DOM helpers ─────────────────────────────────────────────────────────────

function asArray(nodes: ArrayLike<XNode>): XNode[] {
  return Array.from({ length: nodes.length }, (_, i) => nodes[i]!);
}

/** Direct element children with the given qualified tag (NOT descendants — so a
 *  `<w:tbl>`'s own rows, never a nested table's). */
export function childrenByTag(parent: XNode, tag: string): XNode[] {
  return asArray(parent.childNodes).filter((n) => n.nodeType === 1 && n.tagName === tag);
}

/** All descendant elements with the tag (document order). */
function descendants(root: XNode, tag: string): XNode[] {
  const out: XNode[] = [];
  const walk = (n: XNode) => {
    for (const c of asArray(n.childNodes)) {
      if (c.nodeType === 1) {
        if (c.tagName === tag) out.push(c);
        walk(c);
      }
    }
  };
  walk(root);
  return out;
}

export function textOf(el: XNode): string {
  return descendants(el, "w:t")
    .map((t) => t.textContent ?? "")
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function rows(tbl: XNode): XNode[] {
  return childrenByTag(tbl, "w:tr");
}
function cells(tr: XNode): XNode[] {
  return childrenByTag(tr, "w:tc");
}

export function allTables(t: LoadedTemplate): XNode[] {
  return descendants(t.body, "w:tbl");
}

/** Body-level paragraphs (skips paragraphs nested in table cells). */
function bodyParagraphs(t: LoadedTemplate): XNode[] {
  return childrenByTag(t.body, "w:p");
}

// ── builders ────────────────────────────────────────────────────────────────

/** Arial rPr matching the template body font (used when no cell template exists). */
function arialRPr(doc: XDoc): XNode {
  const rPr = doc.createElement("w:rPr");
  const f = doc.createElement("w:rFonts");
  f.setAttribute?.("w:ascii", "Arial");
  f.setAttribute?.("w:hAnsi", "Arial");
  f.setAttribute?.("w:cs", "Arial");
  rPr.appendChild(f);
  return rPr;
}

function makeRun(doc: XDoc, run: Run, rPrTemplate?: XNode): XNode {
  const r = doc.createElement("w:r");
  const rPr = rPrTemplate ? rPrTemplate.cloneNode(true) : arialRPr(doc);
  if (run.bold && childrenByTag(rPr, "w:b").length === 0) rPr.appendChild(doc.createElement("w:b"));
  r.appendChild(rPr);
  const tEl = doc.createElement("w:t");
  tEl.setAttribute?.("xml:space", "preserve");
  tEl.appendChild(doc.createTextNode(run.text));
  r.appendChild(tEl);
  return r;
}

/** Replace a cell's runs with `runs`, reusing the cell paragraph's font (rPr in
 *  its pPr) so the Arial styling is preserved. */
export function setCellRuns(doc: XDoc, tc: XNode, runs: Run[]): void {
  const p = childrenByTag(tc, "w:p")[0];
  if (!p) return;
  const pPr = childrenByTag(p, "w:pPr")[0];
  const rPrTemplate = pPr ? childrenByTag(pPr, "w:rPr")[0] : undefined;
  for (const r of childrenByTag(p, "w:r")) p.removeChild(r);
  for (const run of runs) p.appendChild(makeRun(doc, run, rPrTemplate));
}

export function setCellText(doc: XDoc, tc: XNode, text: string): void {
  setCellRuns(doc, tc, [{ text }]);
}

/** Build a clean body-level Arial `<w:p>` from runs. */
export function makeParagraph(doc: XDoc, runs: Run[]): XNode {
  const p = doc.createElement("w:p");
  for (const run of runs) p.appendChild(makeRun(doc, run));
  return p;
}

// ── locate + fill ───────────────────────────────────────────────────────────

/** First table whose header (row 0) cell texts satisfy `pred`. */
export function findTable(t: LoadedTemplate, pred: (headerCells: string[]) => boolean): XNode | undefined {
  return allTables(t).find((tbl) => {
    const r0 = rows(tbl)[0];
    return r0 ? pred(cells(r0).map(textOf)) : false;
  });
}

/** First table that appears AFTER the body paragraph whose text matches `pred`
 *  (anchors tables whose headers repeat, e.g. the three appointment tables). */
export function tableAfterParagraph(t: LoadedTemplate, pred: (text: string) => boolean): XNode | undefined {
  const kids = asArray(t.body.childNodes).filter((n) => n.nodeType === 1);
  const idx = kids.findIndex((n) => n.tagName === "w:p" && pred(textOf(n)));
  if (idx < 0) return undefined;
  for (let i = idx + 1; i < kids.length; i++) if (kids[i]!.tagName === "w:tbl") return kids[i];
  return undefined;
}

/**
 * Fill a horizontal table (header row + one empty data row) with `dataRows`,
 * cloning the empty row per entry. No-op when `dataRows` is empty (template
 * prompts stay for the user to complete).
 */
export function fillGrid(doc: XDoc, tbl: XNode | undefined, dataRows: string[][]): void {
  if (!tbl || dataRows.length === 0) return;
  const trs = rows(tbl);
  const templateRow = trs[trs.length - 1]!; // last row = the blank data row
  const parent = templateRow.parentNode!;
  for (const values of dataRows) {
    const tr = templateRow.cloneNode(true);
    const tcs = cells(tr);
    values.forEach((v, i) => {
      if (tcs[i]) setCellText(doc, tcs[i]!, v);
    });
    parent.insertBefore(tr, templateRow);
  }
  parent.removeChild(templateRow);
}

/**
 * Vertical "duplicate table below as needed" sections (funding, mentees): clone
 * the whole template table once per entry, fill each clone via `fill`, and drop
 * the blank original. An empty spacer paragraph between clones stops Word from
 * visually merging adjacent tables. No-op when `entries` is empty.
 */
export function fillTablePerEntry<T>(
  doc: XDoc,
  tbl: XNode | undefined,
  entries: T[],
  fill: (clone: XNode, entry: T) => void,
): void {
  if (!tbl || entries.length === 0) return;
  const parent = tbl.parentNode!;
  entries.forEach((entry, i) => {
    const clone = tbl.cloneNode(true);
    fill(clone, entry);
    parent.insertBefore(clone, tbl);
    if (i < entries.length - 1) parent.insertBefore(doc.createElement("w:p"), tbl);
  });
  parent.removeChild(tbl);
}

/** Set the value cell (column 1) of the row whose label cell (column 0) starts
 *  with `label`. Returns true if filled. */
export function setLabeledValue(doc: XDoc, tbl: XNode | undefined, label: string, value: string): boolean {
  if (!tbl) return false;
  for (const tr of rows(tbl)) {
    const tcs = cells(tr);
    if (tcs[0] && textOf(tcs[0]).toLowerCase().startsWith(label.toLowerCase())) {
      if (tcs[1]) setCellText(doc, tcs[1]!, value);
      return true;
    }
  }
  return false;
}

/** Append a value run to the body paragraph whose text equals `label` (e.g.
 *  "Name:" → "Name: Jane Smith, PhD"). */
export function appendToLabelParagraph(doc: XDoc, t: LoadedTemplate, label: string, value: string): boolean {
  const p = bodyParagraphs(t).find((para) => textOf(para) === label);
  if (!p) return false;
  const lastRun = childrenByTag(p, "w:r").slice(-1)[0];
  const rPr = lastRun ? childrenByTag(lastRun, "w:rPr")[0] : undefined;
  p.appendChild(makeRun(doc, { text: ` ${value}` }, rPr));
  return true;
}

/** Insert `paras` immediately after the first body paragraph matching `pred`. */
export function insertParagraphsAfter(t: LoadedTemplate, pred: (text: string) => boolean, paras: XNode[]): boolean {
  const anchor = bodyParagraphs(t).find((p) => pred(textOf(p)));
  if (!anchor) return false;
  const parent = anchor.parentNode!;
  const next = anchorNextSibling(anchor);
  for (const p of paras) parent.insertBefore(p, next);
  return true;
}

function anchorNextSibling(node: XNode): XNode | null {
  const sibs = asArray(node.parentNode!.childNodes);
  const i = sibs.indexOf(node);
  return i >= 0 && i + 1 < sibs.length ? sibs[i + 1]! : null;
}

/** Remove an element from its parent (e.g. the instruction box table). */
export function removeNode(node: XNode | undefined): void {
  if (node && node.parentNode) node.parentNode.removeChild(node);
}

/** Remove the WCM instruction box: the first table whose header text begins with
 *  "When preparing" (a 1×1 cell holding all the instructional bullets). */
export function removeInstructionBox(t: LoadedTemplate): void {
  removeNode(findTable(t, (h) => (h[0] ?? "").startsWith("When preparing")));
}
