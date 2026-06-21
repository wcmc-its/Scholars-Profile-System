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
import { biosketchCharCap, type BiosketchMode } from "@/lib/edit/biosketch-params";
import type { BiosketchProduct, BiosketchProducts } from "@/lib/edit/biosketch-products";
import { cn } from "@/lib/utils";

/** The success payload the `POST /api/edit/biosketch/generate` route returns. */
export type BiosketchGenerateResult = {
  mode: BiosketchMode;
  entries: string[];
  model: string;
  overflow: { index: number; chars: number }[];
  removedCount: number;
  /** #917 v6 — the Products list (Contributions mode), or null. */
  products: BiosketchProducts | null;
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

  function downloadAll() {
    // Number the contributions in the export; the single Personal Statement is
    // emitted bare. Blank line between entries, trailing newline at the end.
    const entriesBody = isContributions
      ? result.entries.map((e, i) => `${i + 1}. ${e}`).join("\n\n")
      : result.entries.join("\n\n");
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
            <BiosketchEntry
              key={index}
              index={index}
              entry={entry}
              cap={cap}
              over={over}
              showNumber={isContributions}
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

function BiosketchEntry({
  index,
  entry,
  cap,
  over,
  showNumber,
}: {
  index: number;
  entry: string;
  cap: number;
  over: boolean;
  showNumber: boolean;
}) {
  const [copied, setCopied] = React.useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(entry);
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
            {entry.length.toLocaleString()}/{cap.toLocaleString()} characters
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
      <p
        className="text-foreground text-sm whitespace-pre-wrap"
        data-testid={`biosketch-entry-text-${index}`}
      >
        {entry}
      </p>
    </li>
  );
}
