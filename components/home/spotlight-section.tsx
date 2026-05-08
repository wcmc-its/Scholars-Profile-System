/**
 * Home-page Selected research / Spotlight section. Phase 9 SPOTLIGHT-04.
 *
 * Two-column interactive layout per `.planning/source-docs/spotlight-mockup.html`:
 *   - Left pane: the active spotlight (kicker, name, lede, papers with WCM
 *     author chips, browse-all-publications link).
 *   - Right pane: 2-column grid of small button-cards (one per spotlight).
 *     Click swaps the active spotlight. Active card shows a Cornell-red
 *     left rule + tinted background.
 *
 * Behavior:
 *   - On mount the active card is randomized (the SSR render starts at 0;
 *     useEffect immediately rerolls to avoid a hydration mismatch).
 *   - Auto-advances every AUTO_ADVANCE_MS while the user is not interacting
 *     with the section (hover/focus pauses).
 *
 * Author rule (operator decision 2026-05-07): authors come from SPS
 * `PublicationAuthor` joined to `Scholar` — NOT the artifact's first/last
 * payload. Up to AUTHOR_DISPLAY_CAP chips render inline; the rest are tucked
 * behind a "+N more" suffix.
 *
 * Client Component because it owns the active-index state. The data is
 * loaded server-side via `getSpotlights()` and passed in as props.
 *
 * D-19 LOCKED: `displayName`, `shortDescription`, and `lede` are rendered
 * verbatim. NEVER pass them to an LLM, retrieval, or embedding path.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import { METHODOLOGY_BASE, METHODOLOGY_ANCHORS } from "@/lib/methodology-anchors";
import type { SpotlightAuthor, SpotlightCard } from "@/lib/api/home";

const AUTO_ADVANCE_MS = 10_000;
const AUTHOR_DISPLAY_CAP = 4;
const DISPLAY_LIMIT_SPOTLIGHTS = 8; // surface 8 of however many DAL returned
const DISPLAY_LIMIT_PAPERS = 3;     // surface up to 3 papers per spotlight

function shuffle<T>(arr: readonly T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Stable, deterministic SSR slice — first DISPLAY_LIMIT_SPOTLIGHTS items, first
 * DISPLAY_LIMIT_PAPERS papers each. Picked at server render to avoid hydration
 * mismatch; replaced with a random sample on mount via useEffect.
 */
function ssrSlice(items: SpotlightCard[]): SpotlightCard[] {
  return items.slice(0, DISPLAY_LIMIT_SPOTLIGHTS).map((card) => ({
    ...card,
    papers: card.papers.slice(0, DISPLAY_LIMIT_PAPERS),
  }));
}

function randomSample(items: SpotlightCard[]): SpotlightCard[] {
  return shuffle(items)
    .slice(0, DISPLAY_LIMIT_SPOTLIGHTS)
    .map((card) => ({ ...card, papers: shuffle(card.papers).slice(0, DISPLAY_LIMIT_PAPERS) }));
}

export function SpotlightSection({ items }: { items: SpotlightCard[] }) {
  // Stable SSR slice on first paint; randomSample takes over after mount so
  // each pageload sees a fresh 6-of-N selection with random 2-of-M papers.
  const [display, setDisplay] = useState<SpotlightCard[]>(() => ssrSlice(items));
  const [activeIdx, setActiveIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    if (items.length === 0) return;
    const sample = randomSample(items);
    setDisplay(sample);
    setActiveIdx(Math.floor(Math.random() * sample.length));
    const interval = setInterval(() => {
      if (pausedRef.current) return;
      setActiveIdx((i) => (i + 1) % sample.length);
    }, AUTO_ADVANCE_MS);
    return () => clearInterval(interval);
  }, [items]);

  if (display.length === 0) return null;
  const active = display[activeIdx] ?? display[0];

  return (
    <section
      className="mt-12"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-lg font-semibold">Spotlight</h2>
        <a
          href={`${METHODOLOGY_BASE}#${METHODOLOGY_ANCHORS.spotlight}`}
          className="text-[var(--color-accent-slate)] text-sm font-medium underline-offset-4 hover:underline"
        >
          How this works
        </a>
      </div>
      <p className="text-muted-foreground mt-1 text-sm italic">
        Subtopics with the strongest recent activity at WCM, one per parent area, refreshed weekly.
      </p>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-[1.6fr_1fr]">
        <SpotlightDetail card={active} />
        <div className="grid grid-cols-2 content-start gap-2">
          {display.map((card, i) => (
            <SpotlightCardButton
              key={card.subtopicId}
              card={card}
              active={i === activeIdx}
              onSelect={() => setActiveIdx(i)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Active spotlight (left pane)
// ---------------------------------------------------------------------------

function SpotlightDetail({ card }: { card: SpotlightCard }) {
  // Four navigation targets per spec. Visual treatment: no underline at rest,
  // underline on hover. Text reads as content; hover reveals the affordance.
  // Default <a> cursor handles the pointer state.
  const subtopicHref = `/topics/${card.parentTopicSlug}?subtopic=${card.subtopicId}`;
  const parentHref = `/topics/${card.parentTopicSlug}`;
  const pubsHref = `${subtopicHref}#publications`;
  const scholarsHref = `${subtopicHref}#top-scholars`;
  const noUnderlineHover =
    "no-underline hover:underline underline-offset-4 decoration-1";

  return (
    <div
      // `key` retriggers the fade-in transition on activeIdx swap.
      key={card.subtopicId}
      className="animate-in fade-in slide-in-from-bottom-1 flex min-h-[380px] flex-col gap-4 rounded-xl border border-zinc-200 bg-gradient-to-b from-zinc-50 to-white p-6 duration-300"
    >
      <a
        href={parentHref}
        aria-label={`View parent topic ${card.parentTopicLabel}`}
        className={`text-[10.5px] font-medium uppercase tracking-[0.13em] text-[var(--color-primary-cornell-red)] ${noUnderlineHover}`}
      >
        {card.parentTopicLabel}
      </a>
      <h3 className="font-serif text-3xl font-medium leading-tight tracking-tight">
        <a
          href={subtopicHref}
          aria-label={`View topic page for ${card.displayName}`}
          className={`text-zinc-900 ${noUnderlineHover}`}
        >
          {card.displayName}
        </a>
      </h3>
      <p className="text-muted-foreground text-sm leading-relaxed">{card.lede}</p>

      <div className="flex flex-wrap gap-x-6 gap-y-1 border-y border-zinc-200 py-3 text-sm text-zinc-600">
        <a
          href={pubsHref}
          aria-label={`Browse all ${card.publicationCount.toLocaleString()} publications in ${card.displayName}`}
          className={`text-zinc-600 ${noUnderlineHover}`}
        >
          <span className="font-medium text-zinc-900">
            {card.publicationCount.toLocaleString()}
          </span>{" "}
          publications
        </a>
        <a
          href={scholarsHref}
          aria-label={`Browse all ${card.scholarCount.toLocaleString()} scholars working in ${card.displayName}`}
          className={`text-zinc-600 ${noUnderlineHover}`}
        >
          <span className="font-medium text-zinc-900">
            {card.scholarCount.toLocaleString()}
          </span>{" "}
          scholars
        </a>
      </div>

      <div className="flex flex-col gap-5">
        <div className="text-[10.5px] font-medium uppercase tracking-[0.13em] text-zinc-500">
          Representative papers
        </div>
        {card.papers.map((p) => (
          <PaperRow
            key={p.pmid}
            pmid={p.pmid}
            title={p.title}
            journal={p.journal}
            year={p.year}
            authors={p.authors}
          />
        ))}
      </div>
    </div>
  );
}

function PaperRow({
  pmid,
  title,
  journal,
  year,
  authors,
}: {
  pmid: string;
  title: string;
  journal: string;
  year: number;
  authors: SpotlightAuthor[];
}) {
  const pubmedUrl = `https://pubmed.ncbi.nlm.nih.gov/${pmid}`;
  const visible = authors.slice(0, AUTHOR_DISPLAY_CAP);
  const overflow = authors.length - visible.length;
  return (
    <div className="text-sm leading-snug">
      <a
        href={pubmedUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-zinc-900 hover:underline"
      >
        {title}
      </a>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-zinc-500">
        {visible.map((a) => (
          <AuthorChip key={a.cwid} author={a} />
        ))}
        {overflow > 0 ? <span className="text-zinc-500">+{overflow} more</span> : null}
        <span aria-hidden="true">·</span>
        <span className="italic">
          {journal}, {year}
        </span>
      </div>
    </div>
  );
}

function AuthorChip({ author }: { author: SpotlightAuthor }) {
  return (
    <a
      href={`/scholars/${author.profileSlug}`}
      className="inline-flex items-center gap-1.5 hover:text-zinc-900 hover:underline"
    >
      <HeadshotAvatar
        size="sm"
        cwid={author.cwid}
        preferredName={author.displayName}
        identityImageEndpoint={author.identityImageEndpoint}
      />
      <span className="text-zinc-700">{author.displayName}</span>
    </a>
  );
}

// ---------------------------------------------------------------------------
// Right-pane small card (button)
// ---------------------------------------------------------------------------

function SpotlightCardButton({
  card,
  active,
  onSelect,
}: {
  card: SpotlightCard;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={[
        "flex min-h-[78px] flex-col gap-1 rounded-lg border p-3 text-left transition-all",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary-cornell-red)]",
        // Active = quieter than the spotlight: darker neutral border, hairline
        // crimson left rule, no full-perimeter outline. The spotlight pane
        // earns the visual weight; these cards are navigation.
        active
          ? "border-zinc-400 bg-zinc-50 pl-4 shadow-[inset_2px_0_0_var(--color-primary-cornell-red)]"
          : "border-zinc-200 bg-white hover:-translate-y-px hover:border-zinc-400",
      ].join(" ")}
    >
      <div className="text-[9.5px] font-medium uppercase tracking-[0.09em] text-[var(--color-primary-cornell-red)]">
        {card.parentTopicLabel}
      </div>
      <div className="text-[13px] font-medium leading-tight text-zinc-900">
        {card.displayName}
      </div>
      <div className="mt-auto text-[11px] text-zinc-500">
        <span className="font-medium text-zinc-700">
          {card.publicationCount.toLocaleString()}
        </span>{" "}
        pubs · {card.scholarCount.toLocaleString()} scholars
      </div>
    </button>
  );
}
