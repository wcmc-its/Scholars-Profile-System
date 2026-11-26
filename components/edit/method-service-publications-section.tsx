"use client";

/**
 * The "Method services" section as a unit's own editors get it, and the switch
 * between it and the superuser's editor (`MethodServicesSection`).
 *
 * A Scholars administrator connects a unit to a method; the unit keeps the
 * list of publications it supported up to date. So here each service the unit
 * already has is listed with its name, link and methods as read-only text, and
 * the only controls are the "Publications this service supported" box with its
 * save button and the "Review publications" list with "Not ours" / "Undo"
 * (`method-service-review.tsx`). There is no way to add, rename, re-link or
 * remove a service, and the affiliation phrases and author names are never
 * sent to this viewer.
 *
 * Every write is a POST to `/api/edit/method-service`, which allows this
 * viewer exactly these three: an update carrying only `supportedPmids` and
 * `baseSupportedPmids`, `exclude` and `restore`.
 *
 * The box is a copy of the list as it was when this page last heard from the
 * server, and other people save the same list. So a save also sends that copy
 * (`baseSupportedPmids`) and the server applies only what was added and
 * removed here to the list as it is now. What comes back is the list as
 * stored, with anyone else's additions in it.
 *
 * Imports only types and pure validation from `lib/method-services/validation`
 * (no `@/lib/db`).
 */
import * as React from "react";
import { useRouter } from "next/navigation";

import {
  ServiceReviewPanel,
  ServiceReviewSummary,
  useServiceReviews,
} from "@/components/edit/method-service-review";
import { MethodServicesSection, pubmedWarningText } from "@/components/edit/method-services-section";
import { SectionHeader } from "@/components/edit/unit-basics-section";
import { UnsavedChangesGuard } from "@/components/edit/unsaved-changes-guard";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { withArticle } from "@/lib/method-services/collaboration";
import {
  SERVICE_PMIDS_MAX,
  methodFamilyKey,
  parsePmidBlock,
  type MethodServiceEntityType,
  type MethodServicePublicationsView,
  type MethodServicesForViewer,
} from "@/lib/method-services/validation";
import { cn } from "@/lib/utils";

/** The help text a unit's editor reads under the section heading. */
export const UNIT_EDITOR_HELP =
  "A Scholars administrator connects your unit to a method. You keep the list of publications your unit supported up to date here.";

/** Rejected tokens listed in full up to this many; the rest are counted. */
const INVALID_SHOWN = 12;
const NOTE_CLASS = "text-muted-foreground mt-1.5 text-[12.5px]";
const ERROR_CLASS = "text-destructive mt-1.5 text-[12.5px]";

const byName = (a: MethodServicePublicationsView, b: MethodServicePublicationsView) =>
  a.name.localeCompare(b.name) || a.id - b.id;

const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

const storedText = (s: MethodServicePublicationsView) => s.supportedPmids.join("\n");

/**
 * The section for whoever is looking: the whole editor for a superuser, the
 * publications half for a unit's own editor.
 */
export function MethodServicesForViewerSection({
  entityType,
  entityId,
  unitName,
  methodServices,
  headingId,
}: {
  entityType: MethodServiceEntityType;
  /** The department code, or the core id. */
  entityId: string;
  unitName: string;
  methodServices: MethodServicesForViewer;
  headingId?: string;
}) {
  return methodServices.mode === "manage" ? (
    <MethodServicesSection
      entityType={entityType}
      entityId={entityId}
      unitName={unitName}
      services={methodServices.services}
      headingId={headingId}
    />
  ) : (
    <MethodServicePublicationsSection
      unitName={unitName}
      services={methodServices.services}
      headingId={headingId}
    />
  );
}

export type MethodServicePublicationsSectionProps = {
  /** The unit's name as its edit page header shows it. */
  unitName: string;
  /** The unit's services as the server last rendered them. */
  services: ReadonlyArray<MethodServicePublicationsView>;
  headingId?: string;
};

export function MethodServicePublicationsSection({
  unitName,
  services: initialServices,
  headingId = "method-services-heading",
}: MethodServicePublicationsSectionProps) {
  const router = useRouter();
  const [services, setServices] = React.useState<MethodServicePublicationsView[]>(() =>
    [...initialServices].sort(byName),
  );
  /** What is typed in each service's box; a service with no entry is untouched. */
  const [drafts, setDrafts] = React.useState<ReadonlyMap<number, string>>(new Map());
  const [busy, setBusy] = React.useState(false);
  const [status, setStatus] = React.useState("");
  /** A saved list whose co-authors PubMed could not all be asked about. */
  const [warning, setWarning] = React.useState<string | null>(null);
  /** The last failed write, shown under the service it was for. */
  const [failure, setFailure] = React.useState<{ id: number; message: string } | null>(null);

  // "Review publications": the numbers under each service, which panel is
  // open, and where focus goes once a "Not ours" / "Undo" has been re-read.
  const { reviews } = useServiceReviews(services);
  const [reviewOpen, setReviewOpen] = React.useState<number | null>(null);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const reviewToggles = React.useRef(new Map<number, HTMLButtonElement>());
  const reviewFocus = React.useRef<{ id: number; action: string; stale: unknown } | null>(null);
  React.useEffect(() => {
    const pending = reviewFocus.current;
    if (!pending || busy || reviews.get(pending.id) === pending.stale) return;
    reviewFocus.current = null;
    const target =
      rootRef.current?.querySelector<HTMLElement>(`[data-review-action="${pending.action}"]`) ??
      reviewToggles.current.get(pending.id);
    target?.focus();
  }, [reviews, busy]);

  const textOf = (s: MethodServicePublicationsView) => drafts.get(s.id) ?? storedText(s);
  // Unsaved work in any box. A save puts the saved list back in its box, so
  // this falls back to false; the section only ever refreshes in place.
  const dirty = services.some((s) => textOf(s) !== storedText(s));
  const unit = withArticle(unitName);

  function type(id: number, text: string) {
    setDrafts((prev) => new Map(prev).set(id, text));
    if (failure?.id === id) setFailure(null);
  }

  async function post(payload: Record<string, unknown>): Promise<{
    ok: boolean;
    error?: string;
    service?: MethodServicePublicationsView;
    warning?: string;
    pubmed?: { checked: number; total: number };
  }> {
    try {
      const res = await fetch("/api/edit/method-service", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        service?: MethodServicePublicationsView;
        warning?: string;
        pubmed?: { checked: number; total: number };
      };
      return res.ok && data.ok === true
        ? { ok: true, service: data.service, warning: data.warning, pubmed: data.pubmed }
        : { ok: false, error: data.error ?? "" };
    } catch {
      return { ok: false, error: "" };
    }
  }

  /** Save one service's supported list: that field and nothing else. */
  async function save(event: React.FormEvent, service: MethodServicePublicationsView) {
    event.preventDefault();
    if (busy) return;
    const parsed = parsePmidBlock(textOf(service));
    if (parsed.pmids.length > SERVICE_PMIDS_MAX) {
      setFailure({ id: service.id, message: errorMessage("too_many_pmids") });
      return;
    }
    setBusy(true);
    setStatus("");
    setWarning(null);
    setFailure(null);
    // Sent even when unchanged: its presence is what makes the server carry on
    // with a PubMed check an earlier save could not finish. The base is the
    // list this box started from, so the server changes only what was added
    // or removed here and a stale page never replaces the stored list.
    const result = await post({
      op: "update",
      id: service.id,
      supportedPmids: parsed.pmids,
      baseSupportedPmids: service.supportedPmids,
    });
    setBusy(false);
    if (!result.ok || !result.service) {
      setFailure({ id: service.id, message: errorMessage(result.error ?? "") });
      return;
    }
    const saved = result.service;
    if (result.warning) setWarning(pubmedWarningText(result.warning, result.pubmed));
    // A new service object, so `useServiceReviews` re-reads its numbers.
    setServices((prev) => prev.map((s) => (s.id === saved.id ? saved : s)));
    setDrafts((prev) => {
      const next = new Map(prev);
      next.delete(saved.id);
      return next;
    });
    // PMIDs in the saved list that were neither typed here nor on this page
    // before: someone else's, added while the page was open.
    const known = new Set([...parsed.pmids, ...service.supportedPmids]);
    const others = saved.supportedPmids.filter((p) => !known.has(p)).length;
    setStatus(
      `Saved the publications for ${saved.name}.` +
        (others > 0
          ? ` The list also has ${plural(others, "PMID", "PMIDs")} someone else added while this page was open.`
          : ""),
    );
    router.refresh();
  }

  /** "Not ours" (exclude) or its undo (restore) for one publication. */
  async function movePmid(
    service: MethodServicePublicationsView,
    op: "exclude" | "restore",
    pmid: string,
  ) {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    setStatus("");
    const result = await post({ op, id: service.id, pmid });
    setBusy(false);
    if (!result.ok || !result.service) {
      setFailure({ id: service.id, message: errorMessage(result.error ?? "") });
      return;
    }
    const saved = result.service;
    // The button pressed is about to leave the list: once the numbers have
    // been re-read, focus its counterpart (Undo for Not ours, and back).
    reviewFocus.current = {
      id: service.id,
      action: `${op === "exclude" ? "restore" : "exclude"}-${service.id}-${pmid}`,
      stale: reviews.get(service.id),
    };
    setServices((prev) => prev.map((s) => (s.id === saved.id ? saved : s)));
    setStatus(
      op === "exclude" ? `PMID ${pmid} no longer counts for ${unit}.` : `PMID ${pmid} counts again.`,
    );
  }

  return (
    <div
      ref={rootRef}
      className="flex flex-col gap-3.5"
      data-slot="method-services-section"
      data-mode="publications"
    >
      <UnsavedChangesGuard dirty={dirty} />
      <SectionHeader id={headingId} title="Method services" description={UNIT_EDITOR_HELP} />

      <ul
        className="border-apollo-border divide-apollo-border divide-y overflow-hidden rounded-[10px] border"
        data-testid="method-services-list"
      >
        {services.map((s) => {
          const review = reviews.get(s.id);
          const panelId = `method-service-review-${s.id}`;
          const boxId = `method-service-pmids-${s.id}`;
          const text = textOf(s);
          const parsed = parsePmidBlock(text);
          const tooMany = parsed.pmids.length > SERVICE_PMIDS_MAX;
          const error = failure?.id === s.id ? failure.message : null;
          return (
            <li
              key={s.id}
              className="flex flex-col gap-3 px-3.5 py-3"
              data-testid={`method-service-${s.id}`}
            >
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-[15px] font-semibold">{s.name}</span>
                <a
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-apollo-slate text-[13px] break-all hover:underline"
                >
                  {s.url}
                </a>
                <ul className="mt-1 flex flex-wrap gap-1.5" aria-label={`Methods for ${s.name}`}>
                  {s.families.map((f) => (
                    <li
                      key={methodFamilyKey(f)}
                      className="bg-apollo-slate-tint border-apollo-slate-tint-border text-apollo-slate rounded-full border px-2.5 py-0.5 text-[12.5px]"
                    >
                      {f.familyLabel}
                    </li>
                  ))}
                </ul>
                <ServiceReviewSummary
                  service={s}
                  review={review}
                  open={reviewOpen === s.id}
                  onToggle={() => setReviewOpen((cur) => (cur === s.id ? null : s.id))}
                  panelId={panelId}
                  toggleRef={(node) => {
                    if (node) reviewToggles.current.set(s.id, node);
                    else reviewToggles.current.delete(s.id);
                  }}
                />
              </div>

              <form
                noValidate
                onSubmit={(e) => void save(e, s)}
                data-testid={`method-service-pmids-form-${s.id}`}
              >
                <label htmlFor={boxId} className="text-foreground mb-1.5 block text-sm font-medium">
                  Publications this service supported{" "}
                  <span className="text-muted-foreground font-normal">
                    (PMIDs, one per line or separated by commas)
                  </span>
                </label>
                <textarea
                  id={boxId}
                  rows={4}
                  value={text}
                  disabled={busy}
                  spellCheck={false}
                  aria-invalid={error || tooMany ? true : undefined}
                  aria-describedby={[
                    `${boxId}-hint`,
                    `${boxId}-count`,
                    error ? `${boxId}-error` : null,
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onChange={(e) => type(s.id, e.target.value)}
                  className="border-apollo-border-strong text-foreground bg-background focus-visible:ring-apollo-maroon w-full rounded-md border px-3 py-2 font-mono text-sm focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50"
                />
                <p id={`${boxId}-hint`} className={NOTE_CLASS}>
                  Add PMIDs for work you supported without authorship, or by staff who have since
                  left. Only publications already on the method page are marked.
                </p>
                <p
                  id={`${boxId}-count`}
                  aria-live="polite"
                  className={cn(NOTE_CLASS, tooMany && "text-destructive")}
                  data-testid={`method-service-pmids-count-${s.id}`}
                >
                  {text.trim().length === 0
                    ? ""
                    : `${plural(parsed.pmids.length, "PMID", "PMIDs")} recognised.` +
                      (tooMany ? ` The limit is ${SERVICE_PMIDS_MAX.toLocaleString("en-US")}.` : "") +
                      (parsed.invalid.length > 0
                        ? ` Not a PMID, left out: ${parsed.invalid.slice(0, INVALID_SHOWN).join(", ")}` +
                          (parsed.invalid.length > INVALID_SHOWN
                            ? ` and ${(parsed.invalid.length - INVALID_SHOWN).toLocaleString("en-US")} more.`
                            : ".")
                        : "")}
                </p>
                {error && (
                  <p id={`${boxId}-error`} role="alert" className={ERROR_CLASS}>
                    {error}
                  </p>
                )}
                <Button
                  type="submit"
                  variant="apollo"
                  disabled={busy}
                  aria-label={`Save publications for ${s.name}`}
                  className="mt-2.5"
                >
                  {busy ? "Saving…" : "Save publications"}
                </Button>
              </form>

              {reviewOpen === s.id && review && (
                <ServiceReviewPanel
                  service={s}
                  review={review}
                  panelId={panelId}
                  busy={busy}
                  onExclude={(pmid) => void movePmid(s, "exclude", pmid)}
                  onRestore={(pmid) => void movePmid(s, "restore", pmid)}
                />
              )}
            </li>
          );
        })}
      </ul>

      <p role="status" className={cn("text-muted-foreground text-[12.5px]", !status && "sr-only")}>
        {status}
      </p>
      {warning && (
        <Alert data-testid="method-service-warning">
          <AlertDescription>{warning}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

function errorMessage(code: string): string {
  switch (code) {
    case "invalid_pmids":
      return "Some of these are not PMIDs. Remove them and try again.";
    case "too_many_pmids":
      return `Use ${SERVICE_PMIDS_MAX.toLocaleString("en-US")} PMIDs or fewer.`;
    case "changed_elsewhere":
      return "Someone else saved this service at the same moment, so your changes weren’t saved. Save again.";
    case "not_superuser":
    case "impersonation_readonly":
      return "You can’t change this service’s publications. Refresh the page and try again.";
    default:
      return "Something went wrong — your changes weren’t saved. Please try again.";
  }
}
