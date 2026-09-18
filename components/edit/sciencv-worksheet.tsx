/**
 * `SciencvWorksheet` — one paste-ready page per saved biosketch generation, laid out in
 * SciENcv's own field order (#2652). Since May 2026 the NIH biosketch is assembled, certified
 * and downloaded only in SciENcv, so the remaining work for a scholar or delegate is retyping
 * and looking things up across Scholars tabs. This page collects every input in one column:
 * identity, Professional Preparation, Appointments, Products, the two narratives, Honors.
 *
 * Every Copy writes PLAIN TEXT via `navigator.clipboard.writeText` — never rich text — and the
 * character counter counts the SAME string the button copies, so what lands in SciENcv hits
 * the count SciENcv shows. The narrative blocks are editable textareas so a delegate can
 * rewrite in their own voice against the live count; those edits are SESSION-LOCAL (React
 * state) and are never persisted — a reload restores the generated draft. The "copied" tick
 * per block is likewise session-local, so a delegate can track progress down the page.
 *
 * No LLM call, no new data, no PDF: eRA refuses non-SciENcv documents, so the only output is
 * what the clipboard carries.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { Check, Copy, ExternalLink } from "lucide-react";

import { BiosketchAiWarning } from "@/components/edit/biosketch-result-card";
import { Button } from "@/components/ui/button";
import {
  BIOSKETCH_CONTRIBUTION_MAX_CHARS,
  BIOSKETCH_STATEMENT_MAX_CHARS,
  type BiosketchEntry,
} from "@/lib/edit/biosketch-params";
import type { BiosketchProduct, BiosketchProducts } from "@/lib/edit/biosketch-products";
import { cn } from "@/lib/utils";

/**
 * SciENcv accepts at most this many honors; the picker enforces it when the profile holds more.
 * Source: the NIH Supplement limits table in the Galter SciENcv guide, updated 2026-05-28 — the
 * same source as the 3,500 / 2,000 character caps. Not yet confirmed against the SciENcv form
 * itself; when it is, record the date here (the Phase 2 spec's `verifiedOn` for this limit).
 */
export const SCIENCV_HONORS_MAX = 15;

export type WorksheetEducation = {
  degree: string;
  institution: string;
  field: string | null;
  year: number | null;
};
export type WorksheetAppointment = {
  title: string;
  organization: string;
  /** ISO `YYYY-MM-DD` or null. */
  startDate: string | null;
  /** ISO `YYYY-MM-DD`; null = current. */
  endDate: string | null;
};
export type WorksheetHonor = { name: string; organization: string; year: number | null };

export type SciencvWorksheetProps = {
  cwid: string;
  /** Where "Back to the biosketch tool" goes (self vs delegated editor). */
  backHref: string;
  scholar: {
    preferredName: string;
    fullName: string;
    orcid: string | null;
    primaryTitle: string | null;
  };
  educations: ReadonlyArray<WorksheetEducation>;
  /** Already in the order to render (reverse chronological). */
  appointments: ReadonlyArray<WorksheetAppointment>;
  /** Already in the order to render (newest first). */
  honors: ReadonlyArray<WorksheetHonor>;
  generation: {
    id: string;
    mode: string;
    entries: BiosketchEntry[];
    products: BiosketchProducts | null;
    /** ISO timestamp. */
    createdAt: string;
  };
  /** The scholar's newest draft of the OTHER mode, when one exists: it fills the narrative block
   *  this generation can't, so one worksheet carries both narratives. `createdAt` is an ISO
   *  timestamp; the block is labelled with its date so the reader knows which draft it is. */
  otherDraft?: { entries: BiosketchEntry[]; createdAt: string } | null;
};

// ---------------------------------------------------------------------------
// Plain-text formatters — exported so the test pins the exact strings that get copied.
// ---------------------------------------------------------------------------

export function educationLine(e: WorksheetEducation): string {
  const degree = e.field ? `${e.degree}, ${e.field}` : e.degree;
  return `${e.institution} — ${degree}${e.year != null ? ` (${e.year})` : ""}`;
}

function year(iso: string | null): string | null {
  return iso ? iso.slice(0, 4) : null;
}

export function appointmentLine(a: WorksheetAppointment): string {
  const span = `${year(a.startDate) ?? "?"}–${year(a.endDate) ?? "present"}`;
  return `${span}  ${a.title}, ${a.organization}`;
}

export function honorLine(h: WorksheetHonor): string {
  return `${h.year != null ? `${h.year}  ` : ""}${h.name}, ${h.organization}`;
}

/** "Title. Venue. Year. PMID: N" — every absent piece dropped. */
export function productCitation(p: BiosketchProduct): string {
  const cite = [p.title, p.venue, p.year != null ? String(p.year) : null]
    .filter((s): s is string => Boolean(s))
    .map((s) => s.replace(/\.$/, ""))
    .join(". ");
  return p.pmid ? `${cite}. PMID: ${p.pmid}` : `${cite}.`;
}

/** The narrative text a contribution copies: heading + body when the draft carries a heading
 *  (v7), else the bare body. The counter counts THIS string — SciENcv's contribution box holds
 *  the heading and the prose together, so the result card's body-only badge undercounts here. */
export function contributionText(e: BiosketchEntry): string {
  return e.title ? `${e.title}\n\n${e.body}` : e.body;
}

/** A PubMed search over exactly these PMIDs (`[pmid]`-tagged, so a bare number can't be read
 *  as free text). From the result list the user sends them to My Bibliography. */
export function pubmedSearchUrl(pmids: ReadonlyArray<string>): string {
  return `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(
    pmids.map((p) => `${p}[pmid]`).join(" OR "),
  )}`;
}

// ---------------------------------------------------------------------------
// Copy plumbing — one context so every Copy on the page shares the tick set + the beacon.
// ---------------------------------------------------------------------------

type CopyCtx = { copied: ReadonlySet<string>; copy: (id: string, text: string) => void };
const CopyContext = React.createContext<CopyCtx>({ copied: new Set(), copy: () => {} });

function beacon(surface: string, cwid: string): void {
  if (typeof navigator === "undefined" || !navigator.sendBeacon) return;
  try {
    navigator.sendBeacon(
      "/api/analytics",
      new Blob(
        [JSON.stringify({ event: "biosketch_worksheet_copy", surface, cwid, ts: Date.now() })],
        {
          type: "application/json",
        },
      ),
    );
  } catch {
    // Telemetry never blocks a copy.
  }
}

function CopyButton({ id, text, label = "Copy" }: { id: string; text: string; label?: string }) {
  const { copied, copy } = React.useContext(CopyContext);
  const done = copied.has(id);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => copy(id, text)}
      disabled={text.length === 0}
      data-testid={`ws-copy-${id}`}
      aria-label={done ? `${label} — copied` : label}
    >
      {done ? <Check className="size-4" /> : <Copy className="size-4" />}
      {done ? "Copied" : label}
    </Button>
  );
}

/** A single value with its own Copy — SciENcv takes these as separate fields. */
function CopyField({ id, label, value }: { id: string; label: string; value: string | null }) {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-2"
      data-testid={`ws-field-${id}`}
    >
      <div className="flex flex-col">
        <span className="text-muted-foreground text-xs">{label}</span>
        <span className="text-foreground text-sm">{value ?? "—"}</span>
      </div>
      <CopyButton id={id} text={value ?? ""} />
    </div>
  );
}

function CharCount({ n, cap, id }: { n: number; cap: number; id: string }) {
  const over = n > cap;
  return (
    <span
      className={cn("text-xs tabular-nums", over ? "text-destructive" : "text-muted-foreground")}
      data-testid={`ws-count-${id}`}
    >
      {n.toLocaleString()}/{cap.toLocaleString()} characters
      {over && " — over the NIH limit"}
    </span>
  );
}

function Block({
  id,
  title,
  hint,
  action,
  children,
}: {
  id: string;
  title: string;
  hint?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      className="border-apollo-border bg-apollo-surface flex flex-col gap-3 rounded-lg border p-4"
      data-testid={`ws-block-${id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-foreground text-base font-semibold">{title}</h2>
          {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground text-sm">{children}</p>;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/** One narrative box: editable (session-local), counted, copied as-is. */
function Narrative({
  id,
  initial,
  cap,
  heading,
}: {
  id: string;
  initial: string;
  cap: number;
  heading?: string;
}) {
  const [text, setText] = React.useState(initial);
  return (
    <div
      className="border-apollo-border bg-apollo-surface-2 flex flex-col gap-2 rounded-md border p-3"
      data-testid={`ws-narrative-${id}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {heading && <span className="text-foreground text-sm font-semibold">{heading}</span>}
          <CharCount n={text.length} cap={cap} id={id} />
        </div>
        <CopyButton id={id} text={text} />
      </div>
      <textarea
        className="border-apollo-border bg-apollo-surface text-foreground min-h-48 w-full rounded-md border p-2 text-sm"
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label={heading ?? "Narrative"}
        data-testid={`ws-text-${id}`}
      />
    </div>
  );
}

/** "Open in PubMed" — omitted (not disabled) when there is nothing to search. */
function PubmedLink({ pmids, label }: { pmids: ReadonlyArray<string>; label: string }) {
  if (pmids.length === 0) return null;
  return (
    <Button asChild variant="outline" size="sm">
      <a href={pubmedSearchUrl(pmids)} target="_blank" rel="noreferrer">
        <ExternalLink className="size-4" />
        {label}
      </a>
    </Button>
  );
}

function ProductList({
  id,
  title,
  items,
}: {
  id: string;
  title: string;
  items: ReadonlyArray<BiosketchProduct>;
}) {
  const pmids = items.map((p) => p.pmid).filter(Boolean);
  const text = items.map(productCitation).join("\n");
  return (
    <div className="flex flex-col gap-2" data-testid={`ws-products-${id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-foreground text-sm font-semibold">{title}</h3>
        <div className="flex flex-wrap gap-2">
          <CopyButton id={`products.${id}`} text={text} label="Copy citations" />
          <CopyButton id={`products.${id}.pmids`} text={pmids.join(", ")} label="Copy PMIDs" />
          <PubmedLink pmids={pmids} label="Open in PubMed" />
        </div>
      </div>
      {items.length === 0 ? (
        <Empty>None in this draft.</Empty>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {items.map((p, i) => (
            <li key={p.pmid || i} className="text-sm" data-testid={`ws-product-${id}-${i}`}>
              <span className="text-foreground">{productCitation(p)}</span>
              {!p.pmid && (
                <span
                  className="text-destructive block text-xs"
                  data-testid={`ws-product-nopmid-${id}-${i}`}
                >
                  No PMID — add this one to My Bibliography by hand.
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function HonorsBlock({ honors }: { honors: ReadonlyArray<WorksheetHonor> }) {
  const needsPick = honors.length > SCIENCV_HONORS_MAX;
  // Default pick: the newest 15 (the incoming order). Session-local.
  const [picked, setPicked] = React.useState<Set<number>>(
    () => new Set(honors.slice(0, SCIENCV_HONORS_MAX).map((_, i) => i)),
  );
  const chosen = honors.filter((_, i) => picked.has(i));
  const text = chosen.map(honorLine).join("\n");
  const full = picked.size >= SCIENCV_HONORS_MAX;
  return (
    <Block
      id="honors"
      title="Honors"
      hint={
        needsPick
          ? `SciENcv takes up to ${SCIENCV_HONORS_MAX}. ${picked.size} of ${SCIENCV_HONORS_MAX} selected.`
          : "From your Scholars profile, newest first."
      }
      action={<CopyButton id="honors" text={text} label="Copy selected" />}
    >
      {honors.length === 0 ? (
        <Empty>No honors on file in Scholars.</Empty>
      ) : (
        <ul className="flex flex-col gap-1">
          {honors.map((h, i) => (
            <li key={i} className="flex items-center gap-2 text-sm" data-testid={`ws-honor-${i}`}>
              {needsPick && (
                <input
                  type="checkbox"
                  checked={picked.has(i)}
                  disabled={!picked.has(i) && full}
                  onChange={(e) =>
                    setPicked((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(i);
                      else next.delete(i);
                      return next;
                    })
                  }
                  aria-label={`Include ${h.name}`}
                />
              )}
              <span className="text-foreground">{honorLine(h)}</span>
            </li>
          ))}
        </ul>
      )}
    </Block>
  );
}

export function SciencvWorksheet({
  cwid,
  backHref,
  scholar,
  educations,
  appointments,
  honors,
  generation,
  otherDraft = null,
}: SciencvWorksheetProps) {
  const [copied, setCopied] = React.useState<Set<string>>(() => new Set());
  const copy = React.useCallback(
    (id: string, text: string) => {
      navigator.clipboard
        .writeText(text)
        .then(() => {
          setCopied((prev) => new Set(prev).add(id));
          beacon(id, cwid);
        })
        .catch(() => {
          // Clipboard can reject (permissions / insecure context). Leave the tick off rather
          // than assert a copy that didn't happen.
        });
    },
    [cwid],
  );
  const ctx = React.useMemo<CopyCtx>(() => ({ copied, copy }), [copied, copy]);

  const isStatement = generation.mode === "personal_statement";
  // The other narrative block is filled from `otherDraft` when there is one; a block with no
  // draft behind it keeps its "generate one" note.
  const statement = isStatement
    ? (generation.entries[0]?.body ?? "")
    : (otherDraft?.entries[0]?.body ?? null);
  const contributions = isStatement ? (otherDraft?.entries ?? []) : generation.entries;
  const products = isStatement ? null : generation.products;
  // Combined handoff: every PMID across both lists, de-duplicated, blanks dropped.
  const allPmids = products
    ? Array.from(
        new Set(
          [...products.related, ...products.otherSignificant].map((p) => p.pmid).filter(Boolean),
        ),
      )
    : [];
  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  const generatedOn = fmtDate(generation.createdAt);
  // Labelled only when it actually fills the block (a stored draft is never empty, but the
  // note and the label must not both show).
  const otherDraftOn =
    otherDraft && otherDraft.entries.length > 0 ? fmtDate(otherDraft.createdAt) : null;

  return (
    <CopyContext.Provider value={ctx}>
      <div className="flex flex-col gap-6" data-testid="sciencv-worksheet" data-cwid={cwid}>
        <div>
          <p className="mb-4">
            <Link href={backHref} className="text-apollo-slate hover:underline">
              &larr; Back to the NIH biosketch tool
            </Link>
          </p>
          <h1 className="page-title font-bold">SciENcv worksheet</h1>
          <p className="text-muted-foreground mt-2">
            {scholar.preferredName} — from the{" "}
            {isStatement ? "Personal Statement" : "Contributions"} draft generated {generatedOn}.
            Blocks follow SciENcv&rsquo;s field order; each Copy puts plain text on the clipboard,
            and the character counts match what you paste. Nothing on this page is saved.
          </p>
        </div>

        <Block id="identity" title="Name, ORCID iD and position title">
          <CopyField id="identity.name" label="Name" value={scholar.fullName} />
          <CopyField id="identity.orcid" label="ORCID iD" value={scholar.orcid} />
          {!scholar.orcid && (
            <p className="text-destructive text-xs" data-testid="ws-orcid-missing">
              No ORCID iD on file. NIH requires an ORCID iD linked to eRA Commons for a SciENcv
              biosketch — add one before you start.
            </p>
          )}
          <CopyField id="identity.title" label="Position title" value={scholar.primaryTitle} />
        </Block>

        <Block
          id="education"
          title="Professional Preparation"
          hint="One SciENcv entry per row: organization, degree or training, field, year."
          action={
            <CopyButton
              id="education"
              text={educations.map(educationLine).join("\n")}
              label="Copy all"
            />
          }
        >
          {educations.length === 0 ? (
            <Empty>No education on file in Scholars.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="ws-education-table">
                <thead className="text-muted-foreground text-left text-xs">
                  <tr>
                    <th className="pr-3 pb-1 font-medium">Organization</th>
                    <th className="pr-3 pb-1 font-medium">Degree / training</th>
                    <th className="pr-3 pb-1 font-medium">Field</th>
                    <th className="pr-3 pb-1 font-medium">Year</th>
                    <th className="pb-1" />
                  </tr>
                </thead>
                <tbody>
                  {educations.map((e, i) => (
                    <tr
                      key={i}
                      className="border-apollo-border border-t align-top"
                      data-testid={`ws-education-${i}`}
                    >
                      <td className="py-1.5 pr-3">{e.institution}</td>
                      <td className="py-1.5 pr-3">{e.degree}</td>
                      <td className="py-1.5 pr-3">{e.field ?? "—"}</td>
                      <td className="py-1.5 pr-3 tabular-nums">{e.year ?? "—"}</td>
                      <td className="py-1.5 text-right">
                        <CopyButton id={`education.${i}`} text={educationLine(e)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Block>

        <Block
          id="appointments"
          title="Appointments and Positions"
          hint="Most recent first. SciENcv also asks about outside professional roles; check your COI disclosures before you submit."
          action={
            <CopyButton
              id="appointments"
              text={appointments.map(appointmentLine).join("\n")}
              label="Copy all"
            />
          }
        >
          {appointments.length === 0 ? (
            <Empty>No appointments on file in Scholars.</Empty>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {appointments.map((a, i) => (
                <li
                  key={i}
                  className="flex flex-wrap items-center justify-between gap-2 text-sm"
                  data-testid={`ws-appointment-${i}`}
                >
                  <span className="text-foreground">{appointmentLine(a)}</span>
                  <CopyButton id={`appointments.${i}`} text={appointmentLine(a)} />
                </li>
              ))}
            </ul>
          )}
        </Block>

        <Block
          id="products"
          title="Products"
          hint="Copy the PMIDs into My Bibliography, or open them in PubMed and send them from there. Up to five per list."
        >
          {products ? (
            <>
              <ProductList
                id="related"
                title={
                  products.relatedFromAims
                    ? "Most related to the proposed project"
                    : "Most significant"
                }
                items={products.related}
              />
              <ProductList
                id="other"
                title="Other significant products"
                items={products.otherSignificant}
              />
              <div className="border-apollo-border flex flex-wrap gap-2 border-t pt-3">
                <CopyButton
                  id="products.all.pmids"
                  text={allPmids.join(", ")}
                  label="Copy all PMIDs"
                />
                <PubmedLink pmids={allPmids} label="Open all in PubMed" />
              </div>
            </>
          ) : (
            <Empty>
              This draft carries no Products list — a Contributions draft does.{" "}
              <Link href={backHref} className="underline">
                Open the tool
              </Link>
              .
            </Empty>
          )}
        </Block>

        <Block
          id="statement"
          title="Personal Statement"
          hint={
            !isStatement && otherDraftOn
              ? `From your Personal Statement draft of ${otherDraftOn}.`
              : undefined
          }
        >
          <BiosketchAiWarning />
          {statement != null ? (
            <Narrative id="statement" initial={statement} cap={BIOSKETCH_STATEMENT_MAX_CHARS} />
          ) : (
            <Empty>
              This is a Contributions draft; generate a Personal Statement draft for this block.{" "}
              <Link href={backHref} className="underline">
                Open the tool
              </Link>
              .
            </Empty>
          )}
        </Block>

        <Block
          id="contributions"
          title="Contributions to Science"
          hint={
            isStatement && otherDraftOn
              ? `From your Contributions draft of ${otherDraftOn}.`
              : undefined
          }
        >
          <BiosketchAiWarning />
          {contributions.length === 0 ? (
            <Empty>
              This is a Personal Statement draft; generate a Contributions draft for this block.{" "}
              <Link href={backHref} className="underline">
                Open the tool
              </Link>
              .
            </Empty>
          ) : (
            contributions.map((e, i) => (
              <Narrative
                key={i}
                id={`contribution.${i + 1}`}
                heading={`${i + 1}.`}
                initial={contributionText(e)}
                cap={BIOSKETCH_CONTRIBUTION_MAX_CHARS}
              />
            ))
          )}
        </Block>

        <HonorsBlock honors={honors} />
      </div>
    </CopyContext.Provider>
  );
}
