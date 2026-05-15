"use client";

import {
  createContext,
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
import { sanitizePubTitle } from "@/lib/utils";

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
        <CloseButton onClose={onClose} />
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="flex flex-col gap-6">
          <AuthorsSection fullAuthors={pub.fullAuthorsString} />
          <ImpactSection
            impactScore={pub.impactScore}
            impactJustification={pub.impactJustification}
          />
          <AbstractSection abstract={pub.abstract} />
          <SynopsisSection synopsis={pub.synopsis} />
          <TopicsSection topics={topics} currentTopicSlug={currentTopicSlug} />
          <MeshSection meshTerms={pub.meshTerms} />
          <IdentifiersSection
            pmid={pub.pmid}
            pmcid={pub.pmcid}
            doi={pub.doi}
            pubmedUrl={pub.pubmedUrl}
          />
          <CitingPubsSection
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

function AuthorsSection({ fullAuthors }: { fullAuthors: string | null }) {
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
    <section>
      <SectionHeading>Authors</SectionHeading>
      <p className="text-foreground/90 mt-1 text-sm leading-relaxed">
        {visible.join(", ")}
        {!expanded && overflows ? <>, …</> : null}
      </p>
      {overflows ? (
        <button
          type="button"
          onClick={() => setExpanded((s) => !s)}
          aria-expanded={expanded}
          className="mt-1 text-xs text-[var(--color-accent-slate)] hover:underline"
        >
          {expanded
            ? "Show fewer"
            : `Show all ${list.length} authors`}
        </button>
      ) : null}
    </section>
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
        <p className="text-foreground/80 mt-1 text-sm leading-relaxed">
          {impactJustification}
        </p>
      ) : null}
    </section>
  );
}

function AbstractSection({ abstract }: { abstract: string | null }) {
  if (!abstract) return null;
  return (
    <section>
      <SectionHeading>Abstract</SectionHeading>
      <p className="text-foreground/90 mt-1 whitespace-pre-line text-sm leading-relaxed">
        {abstract}
      </p>
    </section>
  );
}

function SynopsisSection({ synopsis }: { synopsis: string | null }) {
  if (!synopsis) return null;
  return (
    <section>
      <SectionHeading>Plain-language synopsis</SectionHeading>
      <p className="text-foreground/90 mt-1 text-sm leading-relaxed">
        {synopsis}
      </p>
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
      <p className="text-muted-foreground mt-0.5 text-xs">
        Scores from ReCiterAI per-paper assignments. Higher score = stronger
        fit.
      </p>
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
  return (
    <li>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <Link
          href={`/topics/${topic.topicSlug}`}
          className="text-sm font-medium text-[var(--color-accent-slate)] hover:underline"
        >
          {topic.topicName}
        </Link>
        {isCurrent ? (
          <span className="text-muted-foreground text-xs">(this page)</span>
        ) : null}
        <span className="text-muted-foreground text-xs tabular-nums">
          {topic.score.toFixed(2)}
        </span>
      </div>
      {topic.subtopics.length > 0 ? (
        <ul className="mt-1 flex flex-col gap-0.5 pl-3 text-xs">
          {topic.subtopics.map((s) => {
            const isPrimary = s.slug === topic.primarySubtopicId;
            return (
              <li
                key={s.slug}
                className="text-foreground/80 flex flex-wrap items-baseline gap-x-2"
              >
                <Link
                  href={`/topics/${topic.topicSlug}?subtopic=${encodeURIComponent(
                    s.slug,
                  )}`}
                  className="hover:underline"
                >
                  {s.name}
                </Link>
                {isPrimary ? (
                  <span className="text-muted-foreground/80">primary</span>
                ) : null}
                {s.confidence !== null ? (
                  <span className="text-muted-foreground/80 tabular-nums">
                    {s.confidence.toFixed(2)}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
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

function IdentifiersSection({
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
  return (
    <section>
      <SectionHeading>Identifiers</SectionHeading>
      <dl className="text-foreground/90 mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">PMID</dt>
        <dd>
          <a
            href={pubmedUrl ?? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`}
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-dotted underline-offset-2 hover:text-[var(--color-accent-slate)]"
          >
            {pmid}
          </a>
        </dd>
        {pmcid ? (
          <>
            <dt className="text-muted-foreground">PMCID</dt>
            <dd>
              <a
                href={`https://www.ncbi.nlm.nih.gov/pmc/articles/${pmcid}/`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline decoration-dotted underline-offset-2 hover:text-[var(--color-accent-slate)]"
              >
                {pmcid}
              </a>
            </dd>
          </>
        ) : null}
        {doi ? (
          <>
            <dt className="text-muted-foreground">DOI</dt>
            <dd>
              <a
                href={`https://doi.org/${doi}`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline decoration-dotted underline-offset-2 hover:text-[var(--color-accent-slate)]"
              >
                {doi}
              </a>
            </dd>
          </>
        ) : null}
      </dl>
    </section>
  );
}

function CitingPubsSection({
  citingPubs,
  citingPubsTotal,
}: {
  citingPubs: PublicationDetailPayload["citingPubs"];
  citingPubsTotal: number | null;
}) {
  return (
    <section>
      <SectionHeading>Citing publications</SectionHeading>
      {citingPubs === null ? (
        <p className="text-muted-foreground mt-1 text-sm">
          Citation list temporarily unavailable.
        </p>
      ) : citingPubs.length === 0 ? (
        <p className="text-muted-foreground mt-1 text-sm">
          No citing publications.
        </p>
      ) : (
        <>
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
          {citingPubsTotal !== null && citingPubsTotal > citingPubs.length ? (
            <p className="text-muted-foreground mt-2 text-xs">
              Showing {citingPubs.length.toLocaleString()} most recent of{" "}
              {citingPubsTotal.toLocaleString()} total.
            </p>
          ) : null}
        </>
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
