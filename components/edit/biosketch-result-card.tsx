/**
 * `BiosketchResultCard` — renders the result of one NIH-biosketch generation
 * (#917 v5). The entries are a COPY/EXPORT grant-application artifact, NOT a
 * saved profile field: there is per-entry Copy + a Download-all action, and
 * deliberately NO accept/save-to-profile button (cf. the overview review card,
 * which lands a draft into the editor).
 *
 * The entries are PLAIN TEXT — never HTML. They render through a
 * `whitespace-pre-wrap` block (NOT `dangerouslySetInnerHTML`) so the model's
 * paragraphs survive while any stray markup is shown literally, not executed.
 *
 * Each entry shows its character count against the mode's ceiling
 * (`biosketchCharCap`) and an over-cap badge when the server's `overflow` flags
 * it (the ceiling is never hard-trimmed server-side — trimming grounded prose
 * mid-sentence would corrupt it — so the card surfaces the overage instead).
 * `removedCount` (spans the faithfulness pass stripped) is shown when > 0.
 */
"use client";

import * as React from "react";
import { Check, Copy, Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  biosketchCharCap,
  type BiosketchEntry,
  type BiosketchMode,
} from "@/lib/edit/biosketch-params";
import type { BiosketchProduct, BiosketchProducts } from "@/lib/edit/biosketch-products";
import type { BiosketchContributionSources } from "@/lib/edit/biosketch-sources";
import { cn } from "@/lib/utils";

/** PubMed URL for a pmid (the Sources line links each cited paper). */
function pubmedUrl(pmid: string): string {
  return `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(pmid)}/`;
}

/** The success payload the `POST /api/edit/biosketch/generate` route returns. */
export type BiosketchGenerateResult = {
  mode: BiosketchMode;
  /** Parsed entries as `{ title, body }` (#917 v7). `title` is the per-contribution heading
   *  (v7 only; `""` for v5 / v6 + Personal Statement); `body` is the narrative prose. */
  entries: BiosketchEntry[];
  model: string;
  overflow: { index: number; chars: number }[];
  removedCount: number;
  /** #917 v6 — the Products list (Contributions mode), or null. */
  products: BiosketchProducts | null;
  /** #917 v6 follow-up — per-contribution source PMIDs, or null. */
  sources: BiosketchContributionSources[] | null;
  generationId: string | null;
};

/** Format a product as a single export/display line: "title · venue · year". */
function productLine(p: BiosketchProduct): string {
  return [p.title, p.venue, p.year != null ? String(p.year) : null].filter(Boolean).join(" · ");
}

export function BiosketchResultCard({ result }: { result: BiosketchGenerateResult }) {
  const cap = biosketchCharCap(result.mode);
  const overflowIndexes = React.useMemo(
    () => new Set(result.overflow.map((o) => o.index)),
    [result.overflow],
  );
  const isContributions = result.mode === "contributions";
  // pmids each contribution (1-based) draws from, for the Sources line + export.
  const sourcesByContribution = React.useMemo(() => {
    const m = new Map<number, string[]>();
    for (const s of result.sources ?? []) m.set(s.contributionIndex, s.pmids);
    return m;
  }, [result.sources]);

  function downloadAll() {
    // Number the contributions in the export; the single Personal Statement is
    // emitted bare. Blank line between entries, trailing newline at the end. Each
    // contribution's Sources line (the pmids it draws from) rides under it.
    const entriesBody = isContributions
      ? result.entries
          .map((e, i) => {
            const pmids = sourcesByContribution.get(i + 1);
            const srcLine = pmids && pmids.length > 0 ? `\nSources: PMID ${pmids.join(", ")}` : "";
            // v7 carries a per-contribution heading; emit "N. <title>" then the body when present,
            // else the bare "N. <body>" (v5 / v6).
            const head = e.title ? `${i + 1}. ${e.title}\n\n${e.body}` : `${i + 1}. ${e.body}`;
            return `${head}${srcLine}`;
          })
          .join("\n\n")
      : result.entries.map((e) => e.body).join("\n\n");
    const productsBody = result.products ? `\n\n${productsToText(result.products)}` : "";
    const body = `${entriesBody}${productsBody}`;
    const blob = new Blob([`${body}\n`], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = isContributions
      ? "nih-contributions-to-science.txt"
      : "nih-personal-statement.txt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div
      className="border-apollo-border bg-apollo-surface flex flex-col gap-4 rounded-lg border p-4"
      data-slot="biosketch-result-card"
      data-testid="biosketch-result"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-foreground text-base font-semibold">
            {isContributions ? "Contributions to Science" : "Personal Statement"}
          </h2>
          <p className="text-muted-foreground text-xs">
            Copy these into your grant application. Nothing here is saved to your profile.
          </p>
        </div>
        {result.entries.length > 0 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={downloadAll}
            data-testid="biosketch-download-all"
          >
            <Download className="size-4" />
            Download all (.txt)
          </Button>
        )}
      </div>

      {result.removedCount > 0 && (
        <p className="text-muted-foreground text-xs" data-testid="biosketch-removed-count">
          Trimmed {result.removedCount}{" "}
          {result.removedCount === 1 ? "unverifiable detail" : "unverifiable details"} that could
          not be grounded in your indexed work.
        </p>
      )}

      <ol className="flex flex-col gap-4">
        {result.entries.map((entry, index) => {
          const over = overflowIndexes.has(index);
          return (
            <BiosketchEntryItem
              key={index}
              index={index}
              entry={entry}
              cap={cap}
              over={over}
              showNumber={isContributions}
              sourcePmids={isContributions ? (sourcesByContribution.get(index + 1) ?? []) : []}
            />
          );
        })}
      </ol>

      {isContributions && result.products && (
        <BiosketchProductsSection products={result.products} />
      )}
    </div>
  );
}

/** Group products by their mapped contribution (null last), preserving bucket order. */
function groupByContribution(
  products: BiosketchProduct[],
): { contributionIndex: number | null; items: BiosketchProduct[] }[] {
  const order: (number | null)[] = [];
  const map = new Map<number | null, BiosketchProduct[]>();
  for (const p of products) {
    const key = p.contributionIndex;
    if (!map.has(key)) {
      map.set(key, []);
      order.push(key);
    }
    map.get(key)!.push(p);
  }
  // Numbered contributions ascending, then the "unmapped" (null) group last.
  order.sort((a, b) => {
    if (a === null) return 1;
    if (b === null) return -1;
    return a - b;
  });
  return order.map((k) => ({ contributionIndex: k, items: map.get(k)! }));
}

/** Plain-text rendering of the Products list for the .txt export. */
function productsToText(products: BiosketchProducts): string {
  const lines: string[] = [];
  const bucket = (title: string, items: BiosketchProduct[]) => {
    if (items.length === 0) return;
    lines.push(title);
    for (const g of groupByContribution(items)) {
      const head =
        g.contributionIndex != null
          ? `  Contribution ${g.contributionIndex}:`
          : "  Not mapped to a contribution:";
      lines.push(head);
      for (const p of g.items) {
        lines.push(`    - ${productLine(p)}`);
        if (p.why) lines.push(`        ${p.why}`);
      }
    }
    lines.push("");
  };
  bucket(
    products.relatedFromAims
      ? "PRODUCTS — most related to the proposed project"
      : "PRODUCTS — most significant",
    products.related,
  );
  bucket("PRODUCTS — other significant", products.otherSignificant);
  return lines.join("\n").trimEnd();
}

function ProductBucket({ title, items }: { title: string; items: BiosketchProduct[] }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="biosketch-product-bucket">
      <h4 className="text-foreground text-sm font-semibold">{title}</h4>
      {groupByContribution(items).map((g) => (
        <div key={g.contributionIndex ?? "none"} className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs font-medium">
            {g.contributionIndex != null
              ? `Contribution ${g.contributionIndex}`
              : "Not mapped to a contribution"}
          </span>
          <ul className="flex flex-col gap-1.5">
            {g.items.map((p) => (
              <li key={p.pmid} className="text-sm" data-testid={`biosketch-product-${p.pmid}`}>
                <span className="text-foreground">{productLine(p)}</span>
                {p.why && <span className="text-muted-foreground block text-xs">{p.why}</span>}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** #917 v6 — the Products list: up to 5 related + 5 other significant publications, grouped
 *  by the contribution each was mapped to. A copy/export aid for the Common Form Products
 *  section; the pmids are grounded (deterministically selected), the mapping is the model's. */
function BiosketchProductsSection({ products }: { products: BiosketchProducts }) {
  const hasAny = products.related.length > 0 || products.otherSignificant.length > 0;
  if (!hasAny) return null;
  return (
    <div
      className="border-apollo-border bg-apollo-surface-2 flex flex-col gap-4 rounded-md border p-3"
      data-slot="biosketch-products"
      data-testid="biosketch-products"
    >
      <div className="flex flex-col gap-0.5">
        <h3 className="text-foreground text-sm font-semibold">Products</h3>
        <p className="text-muted-foreground text-xs">
          Suggested products for the Common Form, mapped to your contributions. Review and place
          them yourself; up to four peer-reviewed products per contribution is the NIH norm.
        </p>
      </div>
      <ProductBucket
        title={
          products.relatedFromAims
            ? "Most related to the proposed project"
            : "Most significant"
        }
        items={products.related}
      />
      <ProductBucket title="Other significant products" items={products.otherSignificant} />
    </div>
  );
}

function BiosketchEntryItem({
  index,
  entry,
  cap,
  over,
  showNumber,
  sourcePmids,
}: {
  index: number;
  entry: BiosketchEntry;
  cap: number;
  over: boolean;
  showNumber: boolean;
  sourcePmids: string[];
}) {
  const [copied, setCopied] = React.useState(false);
  // Copy the heading with the body so a v7 contribution lands in the grant form with its title;
  // a title-less (v5 / v6 / statement) entry copies just the prose.
  const copyText = entry.title ? `${entry.title}\n\n${entry.body}` : entry.body;

  async function copy() {
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can reject (permissions / insecure context). Leave the button
      // in its default state rather than asserting a copy that didn't happen.
    }
  }

  return (
    <li
      className="border-apollo-border bg-apollo-surface-2 flex flex-col gap-2 rounded-md border p-3"
      data-testid={`biosketch-entry-${index}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {showNumber && (
            <span className="text-foreground text-sm font-semibold tabular-nums">{index + 1}.</span>
          )}
          <span
            className={cn(
              "text-xs tabular-nums",
              over ? "text-destructive" : "text-muted-foreground",
            )}
            data-testid={`biosketch-entry-count-${index}`}
          >
            {entry.body.length.toLocaleString()}/{cap.toLocaleString()} characters
          </span>
          {over && (
            <span
              className="bg-destructive/10 text-destructive rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase"
              data-testid={`biosketch-entry-overflow-${index}`}
            >
              Over cap
            </span>
          )}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={copy}
          data-testid={`biosketch-entry-copy-${index}`}
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      {/* v7 per-contribution heading (the NIH "Contributions to Science" heading); absent for
          v5 / v6 + Personal Statement, which carry an empty title. */}
      {entry.title && (
        <h3
          className="text-foreground text-sm font-semibold"
          data-testid={`biosketch-entry-title-${index}`}
        >
          {entry.title}
        </h3>
      )}
      <p
        className="text-foreground text-sm whitespace-pre-wrap"
        data-testid={`biosketch-entry-text-${index}`}
      >
        {entry.body}
      </p>
      {sourcePmids.length > 0 && (
        <p
          className="text-muted-foreground text-xs"
          data-testid={`biosketch-entry-sources-${index}`}
        >
          <span className="font-medium">Sources:</span>{" "}
          {sourcePmids.map((pmid, i) => (
            <React.Fragment key={pmid}>
              {i > 0 && ", "}
              <a
                href={pubmedUrl(pmid)}
                target="_blank"
                rel="noreferrer"
                className="text-apollo-maroon hover:underline"
              >
                PMID {pmid}
              </a>
            </React.Fragment>
          ))}
        </p>
      )}
    </li>
  );
}
