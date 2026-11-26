"use client";

/**
 * The review half of the Method services editor section: under each saved
 * service, the line "120 collaborations and 68 supported on the method page ·
 * 231 on the supported list, 167 of them on the page · Review publications",
 * and the "Review publications" panel it opens. The panel lists the
 * publications the method page counts for the service, each saying whether it
 * is a collaboration or support and why, with "Not ours" (which moves the PMID
 * to the service's excluded list), and the excluded ones, each with "Undo".
 *
 * The numbers come from `GET /api/edit/method-service?id=` (`loadServiceReview`),
 * which applies the public page's own rule. Until they arrive, or if they
 * cannot be read, the row keeps the plain supported-list count it had before.
 *
 * Imports only TYPES from `lib/api/method-service-review` (no `@/lib/db`).
 */
import * as React from "react";

import { Button } from "@/components/ui/button";
import type { ServiceReview, ServiceReviewPublication } from "@/lib/api/method-service-review";
import type { CollaborationReason } from "@/lib/method-services/collaboration";
import type { MethodServicePublicationsView } from "@/lib/method-services/validation";

/** Everything the review half reads of a service: never its affiliation
 *  phrases or author names, so a unit editor's reduced view fits too. */
type MethodServiceView = MethodServicePublicationsView;

const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** `undefined` while loading, `null` when it could not be read. */
export type ServiceReviewState = ServiceReview | null | undefined;

async function fetchReview(id: number): Promise<ServiceReview | null> {
  try {
    const res = await fetch(`/api/edit/method-service?id=${id}`, { cache: "no-store" });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; review?: ServiceReview };
    return res.ok && data.ok === true && data.review ? data.review : null;
  } catch {
    return null;
  }
}

/**
 * Each listed service's review, keyed by service id. Loaded when a service
 * first appears and again whenever the service object changes (a save hands
 * the section a new one), so the numbers follow every edit.
 */
export function useServiceReviews(services: ReadonlyArray<MethodServiceView>): {
  reviews: ReadonlyMap<number, ServiceReviewState>;
  reload: (id: number) => Promise<void>;
} {
  const [reviews, setReviews] = React.useState<Map<number, ServiceReviewState>>(new Map());
  const loadedFor = React.useRef(new Map<number, MethodServiceView>());
  const latest = React.useRef(new Map<number, number>());

  const reload = React.useCallback(async (id: number) => {
    const ticket = (latest.current.get(id) ?? 0) + 1;
    latest.current.set(id, ticket);
    const review = await fetchReview(id);
    // A slower, older answer must not overwrite a newer one.
    if (latest.current.get(id) !== ticket) return;
    setReviews((prev) => new Map(prev).set(id, review));
  }, []);

  React.useEffect(() => {
    const ids = new Set(services.map((s) => s.id));
    for (const id of [...loadedFor.current.keys()]) {
      if (!ids.has(id)) loadedFor.current.delete(id);
    }
    for (const s of services) {
      if (loadedFor.current.get(s.id) === s) continue;
      loadedFor.current.set(s.id, s);
      void reload(s.id);
    }
  }, [services, reload]);

  return { reviews, reload };
}

/** The line under a saved service, with the "Review publications" control. */
export function ServiceReviewSummary({
  service,
  review,
  open,
  onToggle,
  panelId,
  toggleRef,
}: {
  service: MethodServiceView;
  review: ServiceReviewState;
  open: boolean;
  onToggle: () => void;
  panelId: string;
  toggleRef?: (node: HTMLButtonElement | null) => void;
}) {
  if (!review) {
    // Loading, or unreadable: the count the row has always shown.
    if (service.supportedPmids.length === 0) return null;
    return (
      <span
        className="text-muted-foreground mt-1 text-[13px]"
        data-testid={`method-service-supported-${service.id}`}
      >
        {plural(service.supportedPmids.length, "publication", "publications")} on the supported
        list
      </span>
    );
  }
  const pages = service.families.length > 1 ? "method pages" : "method page";
  // Stays while its panel is open, so the panel can always be closed.
  const reviewable = open || review.marked.length > 0 || review.excluded.length > 0;
  return (
    <p
      className="text-muted-foreground mt-1 text-[13px]"
      data-testid={`method-service-review-line-${service.id}`}
    >
      {plural(review.collaborations, "collaboration", "collaborations")} and{" "}
      {review.support.toLocaleString("en-US")} supported on the {pages}
      {review.supportedListed > 0 && (
        <>
          {" · "}
          {review.supportedListed.toLocaleString("en-US")} on the supported list,{" "}
          {review.supportedOnPage.toLocaleString("en-US")} of them on the{" "}
          {service.families.length > 1 ? "pages" : "page"}
        </>
      )}
      {reviewable && (
        <>
          {" · "}
          <button
            type="button"
            ref={toggleRef}
            aria-expanded={open}
            aria-controls={panelId}
            aria-label={`Review publications for ${service.name}`}
            onClick={onToggle}
            className="text-apollo-slate focus-visible:outline-apollo-maroon rounded-sm underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 max-sm:inline-block max-sm:py-2"
          >
            Review publications
          </button>
        </>
      )}
    </p>
  );
}

/** What a counted row says: which it is, and why. */
const REASON_TEXT: Record<CollaborationReason, string> = {
  staff: "Collaboration: unit member in Scholars",
  affiliation: "Collaboration: affiliation in PubMed",
  author_name: "Collaboration: named author in PubMed",
  supported: "Support: supported list",
  confirmed: "Support: confirmed core publication",
};

function PublicationLine({ pub, multi }: { pub: ServiceReviewPublication; multi: boolean }) {
  const meta = [pub.journal, pub.year ? String(pub.year) : null, `PMID ${pub.pmid}`].filter(Boolean);
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-sm leading-snug font-medium break-words">
        {pub.title ?? `PMID ${pub.pmid} (not in Scholars)`}
      </span>
      <span className="text-muted-foreground text-[12.5px]">{meta.join(" · ")}</span>
      <span className="text-muted-foreground text-[12.5px]">
        {pub.reason
          ? REASON_TEXT[pub.reason]
          : pub.methods.length === 0
            ? "Not on the method page"
            : null}
        {multi && pub.methods.length > 0 && (
          <>
            {pub.reason ? " · " : ""}
            {pub.methods.join(", ")}
          </>
        )}
        {pub.reason && !pub.inDefaultView && " · Shown only under all publication types"}
      </span>
    </div>
  );
}

/** The opened "Review publications" panel of one service. */
export function ServiceReviewPanel({
  service,
  review,
  panelId,
  busy,
  onExclude,
  onRestore,
}: {
  service: MethodServiceView;
  review: ServiceReview;
  panelId: string;
  busy: boolean;
  onExclude: (pmid: string) => void;
  onRestore: (pmid: string) => void;
}) {
  const multi = service.families.length > 1;
  const titleOf = (p: ServiceReviewPublication) => p.title ?? `PMID ${p.pmid}`;
  return (
    <div
      id={panelId}
      role="region"
      aria-label={`Publications for ${service.name}`}
      className="border-apollo-border bg-apollo-page mt-1 flex flex-col gap-3 rounded-md border px-3 py-3"
      data-testid={`method-service-review-${service.id}`}
    >
      {review.perMethod.length > 0 && (
        <ul className="text-muted-foreground text-[12.5px]">
          {review.perMethod.map((m) => (
            <li key={m.familyLabel}>
              {m.familyLabel}: {plural(m.collaborations, "collaboration", "collaborations")} and{" "}
              {m.support.toLocaleString("en-US")} supported
              {review.supportedListed > 0 &&
                `, ${m.supportedOnPage.toLocaleString("en-US")} of the supported list on the page`}
            </li>
          ))}
        </ul>
      )}

      <div>
        <h4 className="text-[13px] font-semibold">
          Counted as collaboration or support ({review.marked.length.toLocaleString("en-US")})
        </h4>
        {review.marked.length === 0 ? (
          <p className="text-muted-foreground mt-1 text-[13px]">No publications are counted.</p>
        ) : (
          <ul
            className="divide-apollo-border mt-1 max-h-96 divide-y overflow-y-auto"
            data-testid={`method-service-marked-${service.id}`}
          >
            {review.marked.map((p) => (
              <li
                key={p.pmid}
                className="flex flex-col gap-1.5 py-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
              >
                <PublicationLine pub={p} multi={multi} />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  aria-label={`Not ours: ${titleOf(p)}`}
                  data-review-action={`exclude-${service.id}-${p.pmid}`}
                  onClick={() => onExclude(p.pmid)}
                  className="shrink-0 self-start max-sm:min-h-11"
                >
                  Not ours
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {review.excluded.length > 0 && (
        <div>
          <h4 className="text-[13px] font-semibold">
            Removed from the count ({review.excluded.length.toLocaleString("en-US")})
          </h4>
          <ul
            className="divide-apollo-border mt-1 max-h-72 divide-y overflow-y-auto"
            data-testid={`method-service-excluded-${service.id}`}
          >
            {review.excluded.map((p) => (
              <li
                key={p.pmid}
                className="flex flex-col gap-1.5 py-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
              >
                <PublicationLine pub={p} multi={multi} />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  aria-label={`Undo, count it again: ${titleOf(p)}`}
                  data-review-action={`restore-${service.id}-${p.pmid}`}
                  onClick={() => onRestore(p.pmid)}
                  className="shrink-0 self-start max-sm:min-h-11"
                >
                  Undo
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
