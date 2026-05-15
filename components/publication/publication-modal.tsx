"use client";

import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import type {
  PublicationDetailPayload,
  PublicationDetailTopic,
} from "@/lib/api/publication-detail";
import { sanitizePubmedHtml, sanitizePubTitle } from "@/lib/utils";

/**
 * Publication detail modal (#288 PR-B). One modal shared across profile,
 * topic-feed, and search pub-tab surfaces. Triggered via a context
 * provider — surfaces call `usePublicationModal().open(pmid, { currentTopicSlug })`
 * on title click and the provider mounts the modal on top, fetches the
 * payload from `/api/publications/[pmid]`, and renders sections per SPEC §4.2.
 *
 * Hand-rolled focus trap + Esc + backdrop close + body scroll lock (no
 * Dialog primitive in components/ui, no react-focus-trap dep). Focus
 * restores to the trigger on close.
 *
 * The provider is mounted in app/(public)/layout.tsx so any public surface
 * can call `usePublicationModal()` without prop-drilling. Server components
 * still pass through `children` unchanged; only the trigger sites need to
 * be client components.
 */

type ModalState = {
  pmid: string;
  currentTopicSlug?: string;
};

type Ctx = {
  open: (pmid: string, opts?: { currentTopicSlug?: string }) => void;
  close: () => void;
  state: ModalState | null;
};

const PublicationModalContext = createContext<Ctx | null>(null);

export function usePublicationModal(): Ctx {
  const ctx = useContext(PublicationModalContext);
  if (!ctx) {
    throw new Error(
      "usePublicationModal must be used within <PublicationModalProvider>",
    );
  }
  return ctx;
}

export function PublicationModalProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ModalState | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  const open = useCallback(
    (pmid: string, opts?: { currentTopicSlug?: string }) => {
      // Capture the element that opened the modal so we can restore focus
      // on close per SPEC §4.4 (a11y restore-focus-to-trigger).
      triggerRef.current =
        typeof document !== "undefined"
          ? (document.activeElement as HTMLElement | null)
          : null;
      setState({ pmid, currentTopicSlug: opts?.currentTopicSlug });
    },
    [],
  );

  const close = useCallback(() => {
    setState(null);
    // Restore focus on the next tick — the modal unmount must complete before
    // the trigger can take focus back, otherwise the dialog still owns it.
    const t = triggerRef.current;
    triggerRef.current = null;
    if (t && typeof t.focus === "function") {
      window.setTimeout(() => t.focus(), 0);
    }
  }, []);

  return (
    <PublicationModalContext.Provider value={{ open, close, state }}>
      {children}
      {state && (
        <PublicationModal
          key={state.pmid}
          pmid={state.pmid}
          currentTopicSlug={state.currentTopicSlug}
          onClose={close}
        />
      )}
    </PublicationModalContext.Provider>
  );
}

function PublicationModal({
  pmid,
  currentTopicSlug,
  onClose,
}: {
  pmid: string;
  currentTopicSlug?: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<PublicationDetailPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // Fetch the detail payload when the pmid changes. AbortController-style
  // cancellation guards against fast re-opens (clicking a different title
  // before the first request resolved).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    fetch(`/api/publications/${encodeURIComponent(pmid)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j: PublicationDetailPayload) => {
        if (!cancelled) {
          setData(j);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(String(err));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [pmid]);

  // Keyboard: Esc closes; Tab / Shift+Tab cycle inside the dialog so focus
  // never leaves the modal while it's open.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute("aria-hidden"));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !root.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !root.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Initial focus + body scroll lock. Runs once on mount.
  useEffect(() => {
    const root = dialogRef.current;
    const initial = root?.querySelector<HTMLElement>(
      'button[data-modal-close="true"]',
    );
    initial?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  if (typeof document === "undefined") return null;

  const titleId = `pub-modal-title-${pmid}`;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/50 md:items-center md:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      data-testid="publication-modal-backdrop"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-background relative flex h-full w-full flex-col shadow-xl md:h-auto md:max-h-[85vh] md:w-[720px] md:rounded-lg"
      >
        {loading ? (
          <ModalHeaderLoading onClose={onClose} titleId={titleId} />
        ) : error || !data ? (
          <ModalHeaderError onClose={onClose} titleId={titleId} />
        ) : (
          <ModalContent
            payload={data}
            currentTopicSlug={currentTopicSlug}
            onClose={onClose}
            titleId={titleId}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      data-modal-close="true"
      onClick={onClose}
      aria-label="Close publication details"
      className="text-muted-foreground hover:text-foreground hover:bg-muted absolute right-3 top-3 rounded p-1.5"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M18 6 6 18" />
        <path d="m6 6 12 12" />
      </svg>
    </button>
  );
}

function ModalHeaderLoading({
  onClose,
  titleId,
}: {
  onClose: () => void;
  titleId: string;
}) {
  return (
    <>
      <header className="border-border relative border-b p-6 pr-12">
        <h2 id={titleId} className="text-base font-semibold">
          Loading…
        </h2>
        <CloseButton onClose={onClose} />
      </header>
      <div className="text-muted-foreground p-6 text-sm">
        Loading publication details…
      </div>
    </>
  );
}

function ModalHeaderError({
  onClose,
  titleId,
}: {
  onClose: () => void;
  titleId: string;
}) {
  return (
    <>
      <header className="border-border relative border-b p-6 pr-12">
        <h2 id={titleId} className="text-base font-semibold">
          Could not load publication
        </h2>
        <CloseButton onClose={onClose} />
      </header>
      <div className="text-muted-foreground p-6 text-sm">
        Try opening again, or follow the PubMed link from the row.
      </div>
    </>
  );
}

function ModalContent({
  payload,
  currentTopicSlug,
  onClose,
  titleId,
}: {
  payload: PublicationDetailPayload;
  currentTopicSlug: string | undefined;
  onClose: () => void;
  titleId: string;
}) {
  const { pub, topics, citingPubs, citingPubsTotal } = payload;
  const citationContext = formatCitationContext(pub);
  return (
    <>
      <header className="border-border relative shrink-0 border-b p-6 pr-12">
        <h2
          id={titleId}
          className="text-lg font-semibold leading-snug"
          dangerouslySetInnerHTML={{ __html: sanitizePubTitle(pub.title) }}
        />
        {citationContext ? (
          <p className="text-muted-foreground mt-1 text-sm">{citationContext}</p>
        ) : null}
        <IdentifiersLine
          pmid={pub.pmid}
          pmcid={pub.pmcid}
          doi={pub.doi}
          pubmedUrl={pub.pubmedUrl}
        />
        <AuthorsLine fullAuthors={pub.fullAuthorsString} />
        <CloseButton onClose={onClose} />
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="flex flex-col gap-6">
          <AbstractSection abstract={pub.abstract} />
          <SynopsisSection synopsis={pub.synopsis} />
          <ImpactSection
            impactScore={pub.impactScore}
            impactJustification={pub.impactJustification}
          />
          <TopicsSection topics={topics} currentTopicSlug={currentTopicSlug} />
          <MeshSection meshTerms={pub.meshTerms} />
          <CitingPubsSection
            citationCount={pub.citationCount}
            citingPubs={citingPubs}
            citingPubsTotal={citingPubsTotal}
          />
        </div>
      </div>
    </>
  );
}

function formatCitationContext(pub: PublicationDetailPayload["pub"]): string {
  const journal = pub.journal ? pub.journal : null;
  const tail: string[] = [];
  if (pub.year !== null && pub.year !== undefined) tail.push(String(pub.year));
  if (pub.volume) {
    const vi = pub.issue ? `${pub.volume}(${pub.issue})` : pub.volume;
    tail.push(vi);
  }
  if (pub.pages) tail.push(pub.pages);
  if (!journal && tail.length === 0) return "";
  if (!journal) return tail.join(" · ");
  if (tail.length === 0) return journal;
  return `${journal} · ${tail.join(" · ")}`;
}

const AUTHORS_TRUNCATE = 8;

function AuthorsLine({ fullAuthors }: { fullAuthors: string | null }) {
  // Authors flow as part of the header citation block — no section heading.
  // Long lists collapse to the first AUTHORS_TRUNCATE names with a "Show all"
  // toggle; short lists render verbatim.
  const [expanded, setExpanded] = useState(false);
  if (!fullAuthors) return null;
  const list = fullAuthors
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (list.length === 0) return null;
  const overflows = list.length > AUTHORS_TRUNCATE;
  const visible = expanded || !overflows ? list : list.slice(0, AUTHORS_TRUNCATE);
  return (
    <p className="text-foreground/80 mt-2 text-sm leading-relaxed">
      {visible.join(", ")}
      {!expanded && overflows ? <>, … </> : null}
      {overflows ? (
        <>
          {!expanded && overflows ? null : " "}
          <button
            type="button"
            onClick={() => setExpanded((s) => !s)}
            aria-expanded={expanded}
            className="text-xs text-[var(--color-accent-slate)] hover:underline"
          >
            {expanded ? "Show fewer" : `Show all ${list.length}`}
          </button>
        </>
      ) : null}
    </p>
  );
}

function ImpactSection({
  impactScore,
  impactJustification,
}: {
  impactScore: number | null;
  impactJustification: string | null;
}) {
  if (impactScore === null) return null;
  return (
    <section>
      <SectionHeading>Impact</SectionHeading>
      <p className="text-foreground/90 mt-1 text-sm">
        <span className="font-medium">{Math.round(impactScore)}</span>{" "}
        <span className="text-muted-foreground">/ 100</span>
      </p>
      {impactJustification ? (
        <p
          className="text-foreground/80 mt-1 text-sm leading-relaxed"
          dangerouslySetInnerHTML={{
            __html: sanitizePubmedHtml(impactJustification),
          }}
        />
      ) : null}
    </section>
  );
}

function AbstractSection({ abstract }: { abstract: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const paraRef = useRef<HTMLParagraphElement | null>(null);

  // Measure overflow once after the clamped paragraph mounts. scrollHeight
  // exceeds clientHeight when the text is taller than the line-clamp box;
  // when it isn't, "Show more" stays hidden so short abstracts don't carry
  // a misleading affordance. Re-runs on abstract change (next modal open).
  useEffect(() => {
    if (!paraRef.current) return;
    const el = paraRef.current;
    setOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [abstract]);

  if (!abstract) return null;
  // PubMed abstracts ship with whitelisted inline HTML for italic Latin
  // terms (<i>ACE2</i>), structured-abstract headers (<b>Rationale:</b>),
  // and sub/sup for chemical formulae. sanitizePubmedHtml strips everything
  // else and renders the survivors via dangerouslySetInnerHTML.
  const html = sanitizePubmedHtml(abstract);
  return (
    <section>
      <SectionHeading>Abstract</SectionHeading>
      <p
        ref={paraRef}
        className={`text-foreground/90 mt-1 whitespace-pre-line text-sm leading-relaxed ${
          expanded ? "" : "line-clamp-4"
        }`}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {overflows ? (
        <button
          type="button"
          onClick={() => setExpanded((s) => !s)}
          aria-expanded={expanded}
          className="mt-1 text-xs text-[var(--color-accent-slate)] hover:underline"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </section>
  );
}

function SynopsisSection({ synopsis }: { synopsis: string | null }) {
  if (!synopsis) return null;
  return (
    <section>
      <SectionHeading>Plain-language synopsis</SectionHeading>
      <p
        className="text-foreground/90 mt-1 text-sm leading-relaxed"
        dangerouslySetInnerHTML={{ __html: sanitizePubmedHtml(synopsis) }}
      />
    </section>
  );
}

function TopicsSection({
  topics,
  currentTopicSlug,
}: {
  topics: PublicationDetailTopic[];
  currentTopicSlug: string | undefined;
}) {
  if (topics.length === 0) return null;
  return (
    <section>
      <SectionHeading>Topics</SectionHeading>
      <ul className="mt-2 flex flex-col gap-3">
        {topics.map((t) => (
          <TopicListItem
            key={t.topicId}
            topic={t}
            isCurrent={t.topicSlug === currentTopicSlug}
          />
        ))}
      </ul>
    </section>
  );
}

function TopicListItem({
  topic,
  isCurrent,
}: {
  topic: PublicationDetailTopic;
  isCurrent: boolean;
}) {
  // Parent topic row: name on the left, score pinned right. Subtopics flow
  // as a single comma-separated line below; the primary subtopic shows in
  // slightly heavier weight as the only visual marker. Per-subtopic
  // confidence numbers were dropped to keep the section readable on heavy
  // multi-topic papers.
  return (
    <li>
      <div className="flex items-baseline gap-x-2">
        <Link
          href={`/topics/${topic.topicSlug}`}
          className="text-sm font-medium text-[var(--color-accent-slate)] hover:underline"
        >
          {topic.topicName}
        </Link>
        {isCurrent ? (
          <span className="text-muted-foreground text-xs">(this page)</span>
        ) : null}
        <span className="text-muted-foreground ml-auto text-xs tabular-nums">
          {topic.score.toFixed(2)}
        </span>
      </div>
      {topic.subtopics.length > 0 ? (
        <p className="text-foreground/70 mt-0.5 text-xs leading-relaxed">
          {topic.subtopics.map((s, i) => {
            const isPrimary = s.slug === topic.primarySubtopicId;
            return (
              <Fragment key={s.slug}>
                {i > 0 ? (
                  <span className="text-muted-foreground/60">, </span>
                ) : null}
                <Link
                  href={`/topics/${topic.topicSlug}?subtopic=${encodeURIComponent(
                    s.slug,
                  )}`}
                  className={`hover:underline ${
                    isPrimary ? "text-foreground/90 font-medium" : ""
                  }`}
                >
                  {s.name}
                </Link>
              </Fragment>
            );
          })}
        </p>
      ) : null}
    </li>
  );
}

function MeshSection({
  meshTerms,
}: {
  meshTerms: Array<{ ui: string | null; label: string }>;
}) {
  if (meshTerms.length === 0) return null;
  return (
    <section>
      <SectionHeading>MeSH terms</SectionHeading>
      <ul className="mt-2 flex flex-wrap gap-1.5">
        {meshTerms.map((m) => (
          <li
            key={m.ui ?? m.label}
            className="bg-muted text-foreground/80 rounded px-2 py-0.5 text-xs"
          >
            {m.label}
          </li>
        ))}
      </ul>
    </section>
  );
}

function IdentifiersLine({
  pmid,
  pmcid,
  doi,
  pubmedUrl,
}: {
  pmid: string;
  pmcid: string | null;
  doi: string | null;
  pubmedUrl: string | null;
}) {
  // Identifiers flow inside the header citation block as a small meta row.
  // PMID/PMCID/DOI are paper identity, not afterthought — they let users
  // cite the paper and link to upstream sources, so they sit near the
  // title with the rest of the citation metadata. Layout mirrors the
  // per-row meta band on the publication-feed cards so the modal reads
  // as the source-of-truth detail view for the same row.
  const blocks: ReactNode[] = [];
  blocks.push(
    <span key="pmid">
      PMID:{" "}
      <a
        href={pubmedUrl ?? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`}
        target="_blank"
        rel="noopener noreferrer"
        className="underline decoration-dotted underline-offset-2 hover:text-[var(--color-accent-slate)]"
      >
        {pmid}
      </a>
    </span>,
  );
  if (pmcid) {
    blocks.push(
      <span key="pmcid">
        PMCID:{" "}
        <a
          href={`https://www.ncbi.nlm.nih.gov/pmc/articles/${pmcid}/`}
          target="_blank"
          rel="noopener noreferrer"
          className="underline decoration-dotted underline-offset-2 hover:text-[var(--color-accent-slate)]"
        >
          {pmcid}
        </a>
      </span>,
    );
  }
  if (doi) {
    blocks.push(
      <a
        key="doi"
        href={`https://doi.org/${doi}`}
        target="_blank"
        rel="noopener noreferrer"
        className="underline decoration-dotted underline-offset-2 hover:text-[var(--color-accent-slate)]"
      >
        DOI
      </a>,
    );
  }
  const interleaved: ReactNode[] = [];
  blocks.forEach((b, i) => {
    if (i > 0) {
      interleaved.push(
        <span
          key={`sep-${i}`}
          aria-hidden="true"
          className="text-muted-foreground/60"
        >
          ·
        </span>,
      );
    }
    interleaved.push(b);
  });
  return (
    <div
      aria-label="Identifiers"
      className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs"
    >
      {interleaved}
    </div>
  );
}

function CitingPubsSection({
  citationCount,
  citingPubs,
  citingPubsTotal,
}: {
  citationCount: number;
  citingPubs: PublicationDetailPayload["citingPubs"];
  citingPubsTotal: number | null;
}) {
  // Header chip = the canonical Scopus citation count from
  // `Publication.citationCount` — what users mean when they say "this paper
  // has been cited N times". The listed window comes from `analysis_nih_cites`
  // (iCite-derived, Cornell-indexed) which is typically much smaller —
  // PMID 32432483 has 197 Scopus cites but only 19 rows in nih_cites. The
  // subhead clarifies that gap so readers don't mistake the listed N for
  // the true total.
  const hasList = citingPubs !== null && citingPubs.length > 0;
  const showCount = citationCount > 0;
  let subhead: string | null = null;
  if (hasList && citingPubsTotal !== null) {
    if (citingPubsTotal > citingPubs.length) {
      // 500-row cap kicked in inside the indexed subset.
      subhead = `Showing ${citingPubs.length.toLocaleString()} most recent of ${citingPubsTotal.toLocaleString()} indexed citers`;
    } else if (citingPubsTotal < citationCount) {
      // List exhausts our indexed subset but the Scopus total is larger —
      // be explicit so the chip number and list length don't seem to
      // contradict each other.
      subhead =
        citingPubs.length === 1
          ? `1 indexed citer · ${citationCount.toLocaleString()} total per Scopus`
          : `Showing ${citingPubs.length.toLocaleString()} indexed citers (most recent first) · ${citationCount.toLocaleString()} total per Scopus`;
    } else if (citingPubs.length > 1) {
      subhead = "Most recent first";
    }
  }
  return (
    <section>
      <div className="flex items-baseline justify-between gap-2">
        <SectionHeading>Cited by</SectionHeading>
        {showCount ? (
          <span className="text-muted-foreground text-xs tabular-nums">
            {citationCount.toLocaleString()}
          </span>
        ) : null}
      </div>
      {subhead ? (
        <p className="text-muted-foreground mt-0.5 text-xs">{subhead}</p>
      ) : null}
      {citingPubs === null ? (
        <p className="text-muted-foreground mt-2 text-sm">
          Citing publication list temporarily unavailable.
        </p>
      ) : citingPubs.length === 0 ? (
        <p className="text-muted-foreground mt-2 text-sm">
          {citationCount > 0
            ? "No citing publications in our index yet."
            : "No citing publications."}
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {citingPubs.map((c) => (
            <li
              key={c.pmid}
              className="text-foreground/90 text-sm leading-snug"
            >
              <a
                href={`https://pubmed.ncbi.nlm.nih.gov/${c.pmid}/`}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-[var(--color-accent-slate)] hover:underline"
                dangerouslySetInnerHTML={{ __html: sanitizePubTitle(c.title) }}
              />
              {c.journal || c.year ? (
                <div className="text-muted-foreground mt-0.5 text-xs">
                  {c.journal ? <em className="not-italic">{c.journal}</em> : null}
                  {c.journal && c.year ? " · " : null}
                  {c.year ?? null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
      {children}
    </h3>
  );
}
