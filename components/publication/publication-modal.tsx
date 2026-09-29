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
import { ArrowUpRight, Download, HelpCircle } from "lucide-react";
import { CopyButton } from "@/components/publication/copy-button";
import { PubJournal, pubTitleProps } from "@/components/publication/pub-html";
import { HoverTooltip } from "@/components/ui/hover-tooltip";
import { highlightSnippet } from "@/components/method/highlight-snippet";
import { methodologyHref } from "@/lib/methodology-anchors";
import type {
  PublicationDetailCore,
  PublicationDetailMethodFamily,
  PublicationDetailMethodTool,
  PublicationDetailPayload,
  PublicationDetailTopic,
} from "@/lib/api/publication-detail";
import { sanitizePubmedHtml, sanitizePubTitle } from "@/lib/utils";
import { pubSource } from "@/lib/publication-source";
import { isPubliclyDisplayed } from "@/lib/eligibility";
import { profilePath } from "@/lib/profile-url";

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
    throw new Error("usePublicationModal must be used within <PublicationModalProvider>");
  }
  return ctx;
}

export function PublicationModalProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ModalState | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  const open = useCallback((pmid: string, opts?: { currentTopicSlug?: string }) => {
    // Capture the element that opened the modal so we can restore focus
    // on close per SPEC §4.4 (a11y restore-focus-to-trigger).
    triggerRef.current =
      typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
    setState({ pmid, currentTopicSlug: opts?.currentTopicSlug });
  }, []);

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
    const initial = root?.querySelector<HTMLElement>('button[data-modal-close="true"]');
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
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-[rgba(30,26,24,0.55)] md:items-start md:px-6 md:py-12"
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
        className="bg-background relative flex h-full w-full flex-col overflow-hidden shadow-[0_24px_64px_rgba(20,16,14,0.28)] md:h-auto md:max-h-[calc(100vh-96px)] md:max-w-[780px] md:rounded-[14px]"
      >
        {loading ? (
          <ModalStatus
            onClose={onClose}
            titleId={titleId}
            title="Loading…"
            body="Loading publication details…"
          />
        ) : error || !data ? (
          <ModalStatus
            onClose={onClose}
            titleId={titleId}
            title="Could not load publication"
            body="Try opening again, or follow the PubMed link from the row."
          />
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

const ACCENT_LINK = "text-[var(--color-accent-slate)]";
const HOVER_ACCENT = "hover:text-[var(--color-accent-slate)]";

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      data-modal-close="true"
      onClick={onClose}
      aria-label="Close publication details"
      className="text-foreground hover:bg-apollo-surface-2 -mt-1 -mr-2 flex size-9 shrink-0 items-center justify-center rounded-lg"
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

/** Loading / error shell: same header geometry as the loaded modal so the
 *  close button doesn't jump when the payload lands. */
function ModalStatus({
  onClose,
  titleId,
  title,
  body,
}: {
  onClose: () => void;
  titleId: string;
  title: string;
  body: string;
}) {
  return (
    <>
      <header className="border-apollo-border flex shrink-0 items-start gap-4 border-b px-5 pt-5 pb-4 md:px-7 md:pt-6">
        <h2
          id={titleId}
          className="min-w-0 flex-1 font-serif text-[22px] leading-[1.25] font-normal md:text-[25px]"
        >
          {title}
        </h2>
        <CloseButton onClose={onClose} />
      </header>
      <div className="text-muted-foreground px-5 py-6 text-sm md:px-7">{body}</div>
    </>
  );
}

type SectionKey = "summary" | "areas" | "terms" | "cited";

type SectionTab = { key: SectionKey; label: string; count: string | null };

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
  const { pub, topics, citingPubs } = payload;
  // Defensive: the modal is opened from many surfaces; tolerate a payload that
  // predates the `cores` field (older mocks / cached responses).
  const cores = payload.cores ?? [];
  const methodFamilies = payload.methodFamilies ?? [];
  const { journal: citationJournal, tail: citationTail } = formatCitationContext(pub);

  // Tabs only for sections this pub actually has. Cited by always renders (its
  // empty / unavailable states carry meaning), so it always gets a tab.
  const tabs: SectionTab[] = [];
  if (pub.synopsis || pub.impactScore !== null || pub.abstract) {
    tabs.push({ key: "summary", label: "Summary", count: null });
  }
  if (topics.length > 0) {
    tabs.push({ key: "areas", label: "Research areas", count: String(topics.length) });
  }
  if (methodFamilies.length > 0 || cores.length > 0 || pub.meshTerms.length > 0) {
    tabs.push({ key: "terms", label: "Methods & MeSH", count: null });
  }
  tabs.push({
    key: "cited",
    label: "Cited by",
    count: pub.citationCount > 0 ? pub.citationCount.toLocaleString() : null,
  });

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const navRef = useRef<HTMLElement | null>(null);
  const [active, setActive] = useState<SectionKey>(tabs[0].key);
  // While a tab click's scroll is in flight, scroll-spy would flicker the
  // active tab through every section it passes — hold it until the scroll
  // actually lands (reaches its clamped target, or `scrollend` fires), not
  // after a fixed delay. Once landed, the resting position stays "pinned" to
  // the clicked tab so the bottom-of-body rule can't steal it when a short
  // last section leaves the clicked one unable to reach the top.
  const lockTargetRef = useRef<number | null>(null);
  const pinnedTopRef = useRef<number | null>(null);
  const lockTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    const body = bodyRef.current;
    const onScrollEnd = () => {
      if (lockTargetRef.current === null || !body) return;
      lockTargetRef.current = null;
      pinnedTopRef.current = body.scrollTop;
    };
    body?.addEventListener("scrollend", onScrollEnd);
    return () => {
      body?.removeEventListener("scrollend", onScrollEnd);
      window.clearTimeout(lockTimerRef.current);
    };
  }, []);

  const goTo = (key: SectionKey) => {
    setActive(key);
    const body = bodyRef.current;
    const target = body?.querySelector<HTMLElement>(`[data-sec="${key}"]`);
    if (!body || !target) return;
    const maxTop = Math.max(0, body.scrollHeight - body.clientHeight);
    const top = Math.min(maxTop, Math.max(0, target.offsetTop - 4));
    lockTargetRef.current = top;
    pinnedTopRef.current = null;
    // Safety net only (interrupted scroll on a browser without `scrollend`).
    window.clearTimeout(lockTimerRef.current);
    lockTimerRef.current = window.setTimeout(() => {
      if (lockTargetRef.current === null) return;
      lockTargetRef.current = null;
      pinnedTopRef.current = body.scrollTop;
    }, 2000);
    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (typeof body.scrollTo === "function") {
      body.scrollTo({ top, behavior: reduceMotion ? "auto" : "smooth" });
    } else {
      body.scrollTop = top;
    }
  };

  const onBodyScroll = () => {
    const body = bodyRef.current;
    if (!body) return;
    if (lockTargetRef.current !== null) {
      if (Math.abs(body.scrollTop - lockTargetRef.current) <= 2) {
        lockTargetRef.current = null;
        pinnedTopRef.current = body.scrollTop;
      }
      return;
    }
    if (pinnedTopRef.current !== null) {
      if (Math.abs(body.scrollTop - pinnedTopRef.current) <= 2) return;
      pinnedTopRef.current = null;
    }
    let current: SectionKey = tabs[0].key;
    if (body.scrollTop + body.clientHeight >= body.scrollHeight - 4) {
      current = tabs[tabs.length - 1].key;
    } else {
      for (const t of tabs) {
        const el = body.querySelector<HTMLElement>(`[data-sec="${t.key}"]`);
        if (el && el.offsetTop - 40 <= body.scrollTop) current = t.key;
      }
    }
    if (current !== active) setActive(current);
  };

  const showTabs = tabs.length > 1;

  // Tab strip overflow (4 tabs at 390px ≈ 480px): the scrollbar is hidden, so
  // fade the right edge while more tabs sit off-screen, and keep the active
  // tab (which scroll-spy can change) scrolled into view. scrollLeft math
  // rather than scrollIntoView, which would also scroll overflow-hidden
  // ancestors (the dialog) vertically.
  const [navFadeRight, setNavFadeRight] = useState(false);
  const updateNavFade = () => {
    const nav = navRef.current;
    if (!nav) return;
    setNavFadeRight(nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 1);
  };
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    updateNavFade();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(updateNavFade);
    ro.observe(nav);
    return () => ro.disconnect();
  }, [showTabs]);
  useEffect(() => {
    const nav = navRef.current;
    const btn = nav?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!nav || !btn) return;
    const pad = 20;
    const left = btn.offsetLeft;
    const right = left + btn.offsetWidth;
    if (left - pad < nav.scrollLeft) {
      nav.scrollLeft = Math.max(0, left - pad);
    } else if (right + pad > nav.scrollLeft + nav.clientWidth) {
      nav.scrollLeft = right + pad - nav.clientWidth;
    }
  }, [active]);

  return (
    <>
      <header
        className={`flex shrink-0 flex-col ${showTabs ? "" : "border-apollo-border border-b"}`}
      >
        {/* Capped + scrollable so an expanded consortium author list (or a
            short landscape phone) can't grow the fixed header past the dialog
            and squeeze the body to 0px (WCAG 1.4.10). The tab bar stays
            outside the cap, always visible. */}
        <div
          className={`flex max-h-[45vh] flex-col gap-3 overflow-y-auto px-5 pt-5 md:px-7 md:pt-6 ${
            showTabs ? "pb-1" : "pb-4"
          }`}
        >
          <div className="flex items-start gap-4">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              {citationJournal || citationTail ? (
                <p className="text-muted-foreground text-[13px] leading-[1.45] [text-wrap:pretty]">
                  <PubJournal as="em" value={citationJournal} className="text-foreground" />
                  {citationJournal && citationTail ? " · " : ""}
                  {citationTail}
                </p>
              ) : null}
              {/* #2209 — this heading is the dialog's `aria-labelledby` target, so a
                  blank title left the whole modal without an accessible name.
                  `pubTitleProps` renders the "Untitled publication" stand-in and
                  carries a matching aria-label. */}
              <h2
                id={titleId}
                {...pubTitleProps(
                  sanitizePubTitle(pub.title),
                  "font-serif text-[22px] font-normal leading-[1.25] [text-wrap:pretty] md:text-[25px]",
                )}
              />
            </div>
            <CloseButton onClose={onClose} />
          </div>
          <AuthorsLine fullAuthors={pub.fullAuthorsString} wcmAuthors={payload.wcmAuthors ?? []} />
          <IdentifiersLine
            pmid={pub.pmid}
            pmcid={pub.pmcid}
            doi={pub.doi}
            ecommonsLink={pub.ecommonsLink}
            pubmedUrl={pub.pubmedUrl}
          />
        </div>
        {showTabs ? (
          // Hairline is an inset shadow on this wrapper, not a border on the
          // scroller: an overflow-x-auto nav also clips on y, which cut the
          // active tab's -mb-px underline to 1px. The buttons' 2px border now
          // sits flush at the nav's bottom edge and paints over the hairline.
          <div className="mt-3.5 shadow-[inset_0_-1px_0_var(--apollo-border)]">
            <nav
              ref={navRef}
              aria-label="Publication sections"
              onScroll={updateNavFade}
              className={`relative flex gap-[22px] overflow-x-auto px-5 [scrollbar-width:none] md:px-7 ${
                navFadeRight
                  ? "[mask-image:linear-gradient(to_right,black_calc(100%-40px),transparent)]"
                  : ""
              }`}
            >
              {tabs.map((t) => {
                const on = t.key === active;
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => goTo(t.key)}
                    aria-current={on ? "true" : undefined}
                    className={`focus-visible:ring-apollo-ring flex shrink-0 items-baseline gap-1.5 rounded-t-sm border-b-2 py-2.5 text-sm whitespace-nowrap focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset ${
                      on
                        ? "text-foreground border-[var(--color-primary-cornell-red)] font-semibold"
                        : "text-muted-foreground hover:text-foreground border-transparent"
                    }`}
                  >
                    {t.label}
                    {t.count ? (
                      <span className="text-muted-foreground text-[12.5px] font-normal tabular-nums">
                        {/* Separator so the accessible name reads "Cited by
                            1,500", not "Cited by1,500". */}
                        <span className="sr-only"> </span>
                        {t.count}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </nav>
          </div>
        ) : null}
      </header>

      <div
        ref={bodyRef}
        onScroll={onBodyScroll}
        data-testid="publication-modal-body"
        className="relative min-h-0 flex-1 overflow-y-auto px-5 pt-1 pb-7 md:px-7"
      >
        <SummarySection pub={pub} />
        <TopicsSection topics={topics} currentTopicSlug={currentTopicSlug} />
        <TermsSection
          families={methodFamilies}
          cores={cores}
          meshTerms={pub.meshTerms}
          pmid={pub.pmid}
        />
        <CitingPubsSection
          pmid={pub.pmid}
          citationCount={pub.citationCount}
          citingPubs={citingPubs}
        />
      </div>
    </>
  );
}

/** Header citation line: `Journal · 2024 · 10(2):100-110`. Volume and pages
 *  join with a colon (citation style); either may be absent. */
function formatCitationContext(pub: PublicationDetailPayload["pub"]): {
  journal: string | null;
  tail: string;
} {
  const journal = pub.journal ? pub.journal : null;
  const tail: string[] = [];
  if (pub.year !== null && pub.year !== undefined) tail.push(String(pub.year));
  const vi = pub.volume ? (pub.issue ? `${pub.volume}(${pub.issue})` : pub.volume) : "";
  const locator = [vi, pub.pages ?? ""].filter((s) => s.length > 0).join(":");
  if (locator) tail.push(locator);
  return { journal, tail: tail.join(" · ") };
}

const AUTHORS_TRUNCATE = 8;

type ByLineAuthor = PublicationDetailPayload["wcmAuthors"][number];

/** Slot each WCM author into the PubMed byline by position. A 0 (rank unknown,
 *  #2227) or out-of-range position can't be placed, so it's appended instead. */
function buildByline(
  fullAuthors: string | null,
  wcm: ByLineAuthor[],
): Array<{ name: string; wcm?: ByLineAuthor }> {
  const names = (fullAuthors ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const items: Array<{ name: string; wcm?: ByLineAuthor }> = names.map((name) => ({ name }));
  const unplaced: ByLineAuthor[] = [];
  for (const a of wcm) {
    const pos = a.position ?? 0;
    const slot = items[pos - 1];
    if (pos > 0 && slot && !slot.wcm) slot.wcm = a;
    else unplaced.push(a);
  }
  return [...items, ...unplaced.map((a) => ({ name: a.name, wcm: a }))];
}

function initials(name: string): string {
  const parts = name.split(/\s+/).filter((p) => /^[A-Za-z]/.test(p));
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase();
}

function AuthorPill({ author }: { author: ByLineAuthor }) {
  const keyAuthor = author.isFirst || author.isLast;
  const cls = `inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border bg-apollo-surface-2 py-0.5 pl-[3px] pr-2.5 text-[13.5px] text-foreground ${
    keyAuthor ? "border-[var(--color-accent-slate)]" : "border-transparent"
  }`;
  const body = (
    <>
      <span
        aria-hidden="true"
        className="bg-apollo-rail text-apollo-bar inline-flex size-[22px] items-center justify-center rounded-full text-[9.5px] font-semibold"
      >
        {initials(author.name)}
      </span>
      {author.name}
    </>
  );
  // #536 / #1026 — hidden identity classes and slug-less scholars stay unlinked.
  if (!author.slug || !isPubliclyDisplayed(author.roleCategory)) {
    return <span className={cls}>{body}</span>;
  }
  return (
    <Link
      href={profilePath(author.slug)}
      className={`${cls} hover:border-[var(--color-accent-slate)]`}
    >
      {body}
    </Link>
  );
}

function AuthorsLine({
  fullAuthors,
  wcmAuthors,
}: {
  fullAuthors: string | null;
  wcmAuthors: ByLineAuthor[];
}) {
  // WCM authors render as profile pills in byline order; everyone else is
  // muted text. Long lists collapse to the first AUTHORS_TRUNCATE entries, with
  // any WCM pills past the cut kept visible after the ellipsis.
  const [expanded, setExpanded] = useState(false);
  const list = buildByline(fullAuthors, wcmAuthors);
  if (list.length === 0) return null;
  const overflows = list.length > AUTHORS_TRUNCATE;
  const visible =
    expanded || !overflows
      ? list
      : [...list.slice(0, AUTHORS_TRUNCATE), ...list.slice(AUTHORS_TRUNCATE).filter((a) => a.wcm)];
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[13.5px] leading-relaxed">
      {visible.map((a, i) => (
        <Fragment key={`${i}-${a.name}`}>
          {!expanded && overflows && i === AUTHORS_TRUNCATE ? (
            <span className="text-muted-foreground">…</span>
          ) : null}
          {a.wcm ? (
            <AuthorPill author={a.wcm} />
          ) : (
            <span className="text-muted-foreground px-0.5 whitespace-nowrap">
              {a.name}
              {i < visible.length - 1 ? "," : ""}
            </span>
          )}
        </Fragment>
      ))}
      {!expanded && overflows && visible.length === AUTHORS_TRUNCATE ? (
        <span className="text-muted-foreground">…</span>
      ) : null}
      {overflows ? (
        <button
          type="button"
          onClick={() => setExpanded((s) => !s)}
          aria-expanded={expanded}
          className={`text-[13px] font-medium ${ACCENT_LINK} hover:underline`}
        >
          {expanded ? "Show fewer" : `Show all ${list.length}`}
        </button>
      ) : null}
    </div>
  );
}

function SummarySection({ pub }: { pub: PublicationDetailPayload["pub"] }) {
  const { synopsis, impactScore, impactJustification, abstract } = pub;
  if (!synopsis && impactScore === null && !abstract) return null;
  const hasTop = Boolean(synopsis) || impactScore !== null;
  return (
    <section data-sec="summary" className="flex flex-col gap-[22px] pt-5">
      {hasTop ? (
        <div
          className={`grid items-start gap-6 ${
            synopsis && impactScore !== null ? "sm:grid-cols-[minmax(0,1fr)_180px]" : ""
          }`}
        >
          {synopsis ? (
            <div className="flex flex-col gap-1.5">
              <SectionHeading>Plain-language synopsis</SectionHeading>
              <p
                className="text-foreground m-0 text-base leading-normal [text-wrap:pretty]"
                dangerouslySetInnerHTML={{ __html: sanitizePubmedHtml(synopsis) }}
              />
            </div>
          ) : null}
          {impactScore !== null ? <ImpactCard impactScore={impactScore} /> : null}
        </div>
      ) : null}
      {impactScore !== null && impactJustification ? (
        <p
          className="text-muted-foreground -mt-2 text-sm leading-normal [text-wrap:pretty]"
          dangerouslySetInnerHTML={{
            __html: sanitizePubmedHtml(impactJustification),
          }}
        />
      ) : null}
      <AbstractBlock abstract={abstract} />
    </section>
  );
}

function ImpactCard({ impactScore }: { impactScore: number }) {
  const rounded = Math.round(impactScore);
  const pct = Math.max(0, Math.min(100, impactScore));
  return (
    <div className="bg-apollo-surface-2 flex flex-col gap-1.5 rounded-[10px] px-3.5 py-3 sm:w-[180px]">
      <div className="flex items-center gap-1.5">
        <SectionHeading>Impact</SectionHeading>
        <SectionInfoLink
          label="About Impact"
          description={IMPACT_INFO_COPY}
          href={methodologyHref("impact")}
        />
      </div>
      <p className="flex items-baseline gap-[3px] whitespace-nowrap">
        <span className="text-[26px] leading-none font-semibold tabular-nums">{rounded}</span>
        <span className="text-muted-foreground text-[13px]">/ 100</span>
      </p>
      <div aria-hidden="true" className="h-1 overflow-hidden rounded-full bg-white">
        <div className="bg-apollo-bar h-full" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function AbstractBlock({ abstract }: { abstract: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const paraRef = useRef<HTMLParagraphElement | null>(null);

  // Measure overflow once after the clamped paragraph mounts. scrollHeight
  // exceeds clientHeight when the text is taller than the line-clamp box;
  // when it isn't, the toggle stays hidden so short abstracts don't carry
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
    <div className="flex flex-col gap-1.5">
      <SectionHeading>Abstract</SectionHeading>
      <p
        ref={paraRef}
        className={`text-foreground m-0 text-[14.5px] leading-[1.6] [text-wrap:pretty] whitespace-pre-line ${
          expanded ? "" : "line-clamp-4"
        }`}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {overflows ? (
        <button
          type="button"
          onClick={() => setExpanded((s) => !s)}
          aria-expanded={expanded}
          className={`self-start text-sm font-medium ${ACCENT_LINK} hover:underline`}
        >
          {expanded ? "Show less" : "Show full abstract"}
        </button>
      ) : null}
    </div>
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
    <section data-sec="areas" className="flex flex-col gap-1 pt-7">
      <div className="mb-1.5 flex items-center gap-2">
        <SectionHeading>Research areas</SectionHeading>
        <SectionInfoLink
          label="About Research areas"
          description={TOPICS_INFO_COPY}
          href={methodologyHref("whyAi")}
        />
        <span className="text-muted-foreground ml-auto text-xs">Relevance</span>
      </div>
      <ul className="flex flex-col gap-1">
        {topics.map((t) => (
          <TopicListItem key={t.topicId} topic={t} isCurrent={t.topicSlug === currentTopicSlug} />
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
  // Parent topic row: bold name + subtopic bullets on the left, relevance bar +
  // 2-decimal score on the right. Every subtopic renders the same (plain
  // foreground link, per the mockup); per-subtopic confidence numbers stay off
  // to keep heavy multi-topic papers readable.
  return (
    <li className="border-apollo-border grid grid-cols-[minmax(0,1fr)_96px] items-start gap-4 border-t py-2.5 sm:grid-cols-[minmax(0,1fr)_120px] sm:gap-5">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <Link
            href={`/topics/${topic.topicSlug}`}
            className={`text-foreground text-[14.5px] font-semibold ${HOVER_ACCENT}`}
          >
            {topic.topicName}
          </Link>
          {isCurrent ? <span className="text-muted-foreground text-xs">(this page)</span> : null}
        </div>
        {topic.subtopics.length > 0 ? (
          <ul className="flex flex-col gap-0.5">
            {topic.subtopics.map((s) => {
              return (
                <li
                  key={s.slug}
                  className="flex items-baseline gap-[7px] text-[13px] leading-[1.4]"
                >
                  <span
                    aria-hidden="true"
                    className="size-1 shrink-0 -translate-y-0.5 rounded-full bg-[var(--color-primary-cornell-red)]"
                  />
                  <Link
                    href={`/topics/${topic.topicSlug}?subtopic=${encodeURIComponent(
                      s.slug,
                    )}#publications`}
                    className={`text-foreground [text-wrap:pretty] ${HOVER_ACCENT}`}
                  >
                    {s.name}
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
      <ScoreBar score={topic.score} label={topic.topicName} className="pt-1.5" />
    </li>
  );
}

/** Methods, core facilities, and MeSH terms — one scroll target ("Methods &
 *  MeSH" tab). Each sub-block is omitted when empty; the whole section is
 *  omitted when all three are. */
function TermsSection({
  families,
  cores,
  meshTerms,
  pmid,
}: {
  families: PublicationDetailMethodFamily[];
  cores: PublicationDetailCore[];
  meshTerms: Array<{ ui: string | null; label: string }>;
  pmid: string;
}) {
  if (families.length === 0 && cores.length === 0 && meshTerms.length === 0) {
    return null;
  }
  return (
    <section data-sec="terms" className="flex flex-col gap-[18px] pt-7">
      <MethodsBlock families={families} pmid={pmid} />
      <CoreFacilitiesBlock cores={cores} />
      <MeshBlock meshTerms={meshTerms} />
    </section>
  );
}

const PILL = "bg-apollo-surface-2 inline-block rounded-full px-2.5 py-[3px] text-[13px]";

function MeshBlock({ meshTerms }: { meshTerms: Array<{ ui: string | null; label: string }> }) {
  if (meshTerms.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <SectionHeading>MeSH terms</SectionHeading>
      <ul className="flex flex-wrap gap-1.5">
        {meshTerms.map((m) => (
          <li key={m.ui ?? m.label} className={`${PILL} text-foreground`}>
            {m.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * #917 — method families (#799/#819) attributed to this pmid, aggregated across
 * the paper's WCM authors and already #800/#801-gated server-side. Labels link to
 * the cross-scholar Method pages when those are enabled (`href` set), else render
 * as plain text. Phase 2 (#917) nests each family's representative tools beneath
 * its label (see {@link MethodToolsLine}). Omitted when the paper has no surfaced
 * family (or the Methods lens is off → empty array).
 */
function MethodsBlock({
  families,
  pmid,
}: {
  families: PublicationDetailMethodFamily[];
  /** The pmid being viewed — lets {@link MethodToolsLine} say "from this paper"
   *  when a snippet's source pmid matches it (#1158). */
  pmid: string;
}) {
  if (families.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <SectionHeading>Methods</SectionHeading>
      <ul className="flex flex-col gap-2.5">
        {families.map((f) => (
          <li key={`${f.supercategory}::${f.familyLabel}`} className="flex flex-col gap-[3px]">
            {f.href ? (
              <Link
                href={f.href}
                className={`text-foreground self-start text-[14.5px] font-semibold ${HOVER_ACCENT}`}
              >
                {f.familyLabel}
              </Link>
            ) : (
              <span className="text-foreground text-[14.5px] font-semibold">{f.familyLabel}</span>
            )}
            {f.tools.length > 0 ? <MethodToolsLine tools={f.tools} pmid={pmid} /> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Core facilities this publication confirmed-used (CoreClaim-merged). Display-only;
 * each pill links to the public `/cores/[coreId]` page when those pages are enabled
 * (`href` non-null), else renders as plain text. Omitted entirely when empty —
 * which is always the case while the `CORE_PUB_MODAL` flag is off.
 */
function CoreFacilitiesBlock({ cores }: { cores: PublicationDetailCore[] }) {
  if (cores.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <SectionHeading>Core facilities</SectionHeading>
      <ul className="flex flex-wrap gap-1.5">
        {cores.map((c) => (
          <li key={c.coreId}>
            {c.href ? (
              <Link href={c.href} className={`${PILL} text-foreground hover:bg-apollo-rail`}>
                {c.name}
              </Link>
            ) : (
              <span className={`${PILL} text-foreground`}>{c.name}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * #917 Phase 2 — a family's representative tools (`exemplarTools`) beneath its
 * label, dot-separated. A tool carrying a #1119 usage snippet (server-gated on
 * `METHODS_LENS_TOOL_CONTEXT`) becomes a HoverTooltip trigger, dotted-underlined
 * to signal it; a tool with no snippet renders as plain muted text. The tooltip
 * frames the snippet honestly: when the snippet's source pmid (#1158) is THIS
 * paper, "Verbatim, from this paper"; otherwise it is representative of the
 * author's usage across their work, "Verbatim, from the author's papers". The
 * source pmid is server-resolved from `scholar_family.exemplarContextPmids` (null
 * on a pre-#1158 row → the representative framing). The matched term is
 * `<mark>`-highlighted inside the sentence. (A clickable source-publication
 * click-through lives in the persistent provenance rail — #1167 — not this
 * ephemeral, pointer-events-none tooltip.)
 */
function MethodToolsLine({ tools, pmid }: { tools: PublicationDetailMethodTool[]; pmid: string }) {
  return (
    <p className="text-muted-foreground text-[13px] leading-[1.45]">
      {tools.map((tool, i) => {
        const fromThisPaper = tool.sourcePmid != null && tool.sourcePmid === pmid;
        const eyebrow = fromThisPaper
          ? "Verbatim, from this paper"
          : "Verbatim, from the author's papers";
        return (
          <Fragment key={tool.name}>
            {i > 0 ? <span aria-hidden="true"> · </span> : null}
            {tool.context ? (
              <HoverTooltip
                text={
                  fromThisPaper
                    ? `Usage of ${tool.name}, verbatim from this paper: ${tool.context}`
                    : `Representative usage of ${tool.name}, verbatim from the author's papers: ${tool.context}`
                }
                body={
                  <span className="block">
                    <span className="mb-1 block text-[10px] font-medium tracking-wide text-white/60 uppercase">
                      {eyebrow}
                    </span>
                    <span>
                      {highlightSnippet(
                        tool.context,
                        tool.name,
                        undefined,
                        "rounded-[2px] bg-white/20 px-0.5 font-medium text-white not-italic",
                      )}
                    </span>
                  </span>
                }
                wide
              >
                <span className="decoration-muted-foreground/50 underline decoration-dotted underline-offset-2">
                  {tool.name}
                </span>
              </HoverTooltip>
            ) : (
              <span>{tool.name}</span>
            )}
          </Fragment>
        );
      })}
    </p>
  );
}

function ExternalArrow() {
  return <ArrowUpRight className="size-3" strokeWidth={2.2} aria-hidden="true" />;
}

const ID_LINK =
  "font-mono text-[12.5px] underline decoration-apollo-border-strong underline-offset-[3px] hover:text-[var(--color-accent-slate)]";
const EXT_LINK = `inline-flex shrink-0 items-center gap-1 whitespace-nowrap font-medium ${ACCENT_LINK} hover:underline`;

function IdentifiersLine({
  pmid,
  pmcid,
  doi,
  ecommonsLink,
  pubmedUrl,
}: {
  pmid: string;
  pmcid: string | null;
  doi: string | null;
  ecommonsLink: string | null;
  pubmedUrl: string | null;
}) {
  // Paper identity sits in the fixed header: PMID / PMCID as mono links with
  // copy buttons, then DOI / eCommons as external linkouts (only when present).
  // External-source pubs (#101) have no PubMed record — show a source label
  // instead of a dead pubmed.ncbi link for their source-prefixed pmid.
  const { isPubmed, sourceLabel } = pubSource(pmid);
  return (
    <div
      aria-label="Identifiers"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]"
    >
      {isPubmed ? (
        <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap">
          <span className="text-muted-foreground">PMID</span>
          <a
            href={pubmedUrl ?? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`}
            target="_blank"
            rel="noopener noreferrer"
            className={ID_LINK}
          >
            {pmid}
          </a>
          <CopyButton value={pmid} label={`Copy PMID ${pmid}`} showLabel />
        </span>
      ) : sourceLabel ? (
        <span className="text-muted-foreground inline-flex items-center">
          Source: {sourceLabel}
        </span>
      ) : null}
      {pmcid ? (
        <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap">
          <span className="text-muted-foreground">PMCID</span>
          <a
            href={`https://www.ncbi.nlm.nih.gov/pmc/articles/${pmcid}/`}
            target="_blank"
            rel="noopener noreferrer"
            className={ID_LINK}
          >
            {pmcid}
          </a>
          <CopyButton value={pmcid} label={`Copy PMCID ${pmcid}`} showLabel />
        </span>
      ) : null}
      {doi ? (
        <a
          href={`https://doi.org/${doi}`}
          target="_blank"
          rel="noopener noreferrer"
          className={EXT_LINK}
        >
          DOI
          <ExternalArrow />
        </a>
      ) : null}
      {ecommonsLink ? (
        <a
          href={ecommonsLink}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="eCommons institutional repository record"
          className={EXT_LINK}
        >
          eCommons
          <ExternalArrow />
        </a>
      ) : null}
    </div>
  );
}

const CITING_PUBS_INITIAL_VISIBLE = 5;

function CitingPubsSection({
  pmid,
  citationCount,
  citingPubs,
}: {
  pmid: string;
  citationCount: number;
  citingPubs: PublicationDetailPayload["citingPubs"];
}) {
  // Header count = the canonical Scopus citation count from
  // `Publication.citationCount` — the headline "this paper has been cited
  // N times" number. The listed citations come from `analysis_nih_cites`,
  // which is iCite-derived and ties to PubMed's own Cited By tab in
  // practice, inner-joined to Scholars-indexed metadata — so the count is
  // labeled "Scopus" and the subhead scopes the list to Scholars (#2201).
  //
  // Pagination: the API caps at 500 rows; the UI further trims to the
  // first CITING_PUBS_INITIAL_VISIBLE on first render with a "Show all N"
  // toggle. Reveal-all is a single click rather than incremental — the
  // additional rows are already in the response so no fetch is needed.
  // For papers with >500 citers (e.g. seminal methods papers, COVID-era
  // outliers) the CSV download is the escape hatch — see
  // `/api/publications/[pmid]/citations.csv`, capped at 50k server-side.
  const [expanded, setExpanded] = useState(false);
  const hasList = citingPubs !== null && citingPubs.length > 0;
  const showCountChip = citationCount > 0;
  // #2201 — gate the download on the LIST, not the total. These are different
  // populations: `citingPubsTotal` counts the iCite edge table unfiltered, while
  // the list (and the CSV) inner-join to WCM-indexed article metadata. On
  // 99 of 238 sampled prod publications the total was non-zero and the list
  // empty, so the link offered a CSV with a header row and no data.
  //
  // `hasList` is exact for "the CSV will contain >= 1 data row" in both
  // postures: on the bridge path list and CSV parse the SAME stored JSON, and
  // on the live path the CSV runs the same inner join with a larger cap, so an
  // empty 500-row window implies an empty 50k one.
  const showCsvDownload = hasList;

  const visible = !hasList
    ? null
    : expanded || citingPubs.length <= CITING_PUBS_INITIAL_VISIBLE
      ? citingPubs
      : citingPubs.slice(0, CITING_PUBS_INITIAL_VISIBLE);

  // #2201 — three different populations, labeled honestly:
  //   - the headline count is the Scopus count (`Publication.citationCount`);
  //   - `citingPubsTotal` is the unfiltered iCite edge count, which is NOT
  //     shown, because neither the list nor the CSV can support it;
  //   - the list (and the CSV) is only the citers indexed in Scholars.
  // So the subhead describes the list alone, and never promises a "full list".
  let subhead: string | null = null;
  if (hasList) {
    subhead =
      citingPubs.length === 1
        ? "1 citing publication in Scholars"
        : `${citingPubs.length.toLocaleString()} most recent citing publications in Scholars`;
  }

  return (
    <section data-sec="cited" className="flex flex-col gap-2.5 pt-7">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <SectionHeading>Cited by</SectionHeading>
        {showCountChip ? (
          <span data-testid="cited-by-count" className="text-sm tabular-nums">
            <span className="font-semibold">{citationCount.toLocaleString()}</span>
            <span className="text-muted-foreground text-xs"> · Scopus</span>
          </span>
        ) : null}
        {showCsvDownload ? (
          <a
            href={`/api/publications/${encodeURIComponent(pmid)}/citations.csv`}
            download
            className={`ml-auto inline-flex items-center gap-[5px] text-[13px] font-medium ${ACCENT_LINK} hover:underline`}
          >
            <Download className="size-[13px]" strokeWidth={2.2} aria-hidden="true" />
            Download these (CSV)
          </a>
        ) : null}
      </div>
      {subhead ? (
        <p className="text-muted-foreground -mt-1 text-[13px] leading-[1.45]">{subhead}</p>
      ) : null}
      {citingPubs === null ? (
        <p className="text-muted-foreground text-sm">
          Citing publication list temporarily unavailable.
        </p>
      ) : citingPubs.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {citationCount > 0
            ? "None of the citing publications are in Scholars yet."
            : "No citing publications."}
        </p>
      ) : (
        <>
          <ul className="flex flex-col">
            {visible?.map((c) => (
              <li
                key={c.pmid}
                className="border-apollo-border flex flex-col gap-[3px] border-t py-2.5"
              >
                <a
                  href={`https://pubmed.ncbi.nlm.nih.gov/${c.pmid}/`}
                  target="_blank"
                  rel="noopener noreferrer"
                  {...pubTitleProps(
                    sanitizePubTitle(c.title),
                    `text-foreground text-sm font-medium leading-[1.4] [text-wrap:pretty] ${HOVER_ACCENT}`,
                  )}
                />
                <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]">
                  <PubJournal value={c.journal} />
                  {c.journal && c.year ? <span aria-hidden="true">·</span> : null}
                  {c.year !== null && c.year !== undefined ? <span>{c.year}</span> : null}
                  {c.journal || c.year ? <span aria-hidden="true">·</span> : null}
                  <span className="inline-flex items-center gap-1">
                    PMID
                    <a
                      href={`https://pubmed.ncbi.nlm.nih.gov/${c.pmid}/`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`font-mono underline decoration-dotted underline-offset-2 ${HOVER_ACCENT}`}
                    >
                      {c.pmid}
                    </a>
                    <CopyButton value={c.pmid} label={`Copy PMID ${c.pmid}`} />
                  </span>
                </div>
              </li>
            ))}
          </ul>
          {citingPubs.length > CITING_PUBS_INITIAL_VISIBLE ? (
            <button
              type="button"
              onClick={() => setExpanded((s) => !s)}
              aria-expanded={expanded}
              className="border-apollo-border-strong bg-background hover:bg-apollo-surface-2 self-start rounded-lg border px-3.5 py-[7px] text-[13.5px]"
            >
              {expanded ? `Show fewer` : `Show all ${citingPubs.length.toLocaleString()}`}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-muted-foreground text-xs font-medium tracking-[0.08em] uppercase">
      {children}
    </h3>
  );
}

const IMPACT_INFO_COPY =
  "An AI-generated research-impact score from 0–100. A language model reads the title, abstract, journal, citation pattern, and iCite signals and scores against a rubric covering novelty, methodology, evidence of influence, translational relevance, and venue prestige. Click for the full methodology.";

const TOPICS_INFO_COPY =
  "ReCiterAI assigns each publication to one or more research areas. The score (0–1) reflects how strongly the paper fits each research area; subareas give finer-grained breakdown. Click for the full methodology.";

function SectionInfoLink({
  label,
  description,
  href,
}: {
  /** Accessible label for the icon link — e.g. "About Impact". */
  label: string;
  /** Tooltip body. One short paragraph; HoverTooltip caps the width and
   *  wraps automatically. */
  description: string;
  /** Methodology page deeplink, e.g. methodologyHref("impact"). */
  href: string;
}) {
  // (i) icon next to AI-derived section headings (#288 PR-B follow-up).
  // Matches the disclosure-tooltip pattern used elsewhere on the site
  // (DisclosureInfoTooltip, profile TopicsSection): HelpCircle icon,
  // muted color, hover/focus tooltip with the description. Clicking the
  // icon opens the methodology page deeplink in a new tab so the modal
  // isn't lost — same trade-off the per-row HoverTooltip on Impact (PR-C
  // #316) makes for the inline justification text.
  return (
    <HoverTooltip text={description} wide>
      <Link
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`${label} (opens methodology page in a new tab)`}
        className="text-muted-foreground hover:text-foreground inline-flex h-4 w-4 items-center justify-center rounded-full"
      >
        <HelpCircle className="size-3.5" aria-hidden="true" />
      </Link>
    </HoverTooltip>
  );
}

function ScoreBar({
  score,
  label,
  className,
}: {
  /** Score in 0..1. Values outside that range get clamped. */
  score: number;
  /** Aria label seed; bar gets "{label} score 0.92" so screen readers
   *  describe what the bar represents. */
  label: string;
  className?: string;
}) {
  const pct = Math.max(0, Math.min(100, score * 100));
  // Low-relevance fits (< 0.50) render a dimmed bar so the strong fits read
  // first, per the mockup.
  return (
    <span className={`flex items-center gap-2 ${className ?? ""}`}>
      <span
        role="img"
        aria-label={`${label} score ${score.toFixed(2)} of 1.00`}
        className="bg-apollo-surface-2 relative h-1 flex-1 overflow-hidden rounded-full"
      >
        <span
          aria-hidden="true"
          className={`bg-apollo-bar block h-full ${score >= 0.5 ? "" : "opacity-45"}`}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="text-muted-foreground w-[30px] text-right text-[12.5px] tabular-nums">
        {score.toFixed(2)}
      </span>
    </span>
  );
}
