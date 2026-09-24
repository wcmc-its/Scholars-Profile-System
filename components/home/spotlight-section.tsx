/**
 * Home-page Selected research / Spotlight section. Phase 9 SPOTLIGHT-04.
 *
 * Two-column interactive layout per `.planning/source-docs/spotlight-mockup.html`:
 *   - Left pane: the active spotlight (kicker, name, lede, papers with WCM
 *     author chips, browse-all-publications link).
 *   - Right pane: 2-column grid of small button-cards (one per spotlight).
 *     Click swaps the active spotlight. Active card = rail tint + "Showing"
 *     (home refinements mockup, 2026-09-24).
 *
 * Behavior:
 *   - On mount the active card is randomized (the SSR render starts at 0;
 *     useEffect immediately rerolls to avoid a hydration mismatch).
 *   - Auto-advances every AUTO_ADVANCE_MS while the user is not interacting
 *     with the section (hover/focus pauses).
 *   - Representative-paper clicks fire a `spotlight_paper_click` analytics
 *     beacon (PMID + slot + publish cycle) for #286 CTR attribution (#343).
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
import { usePublicationModal } from "@/components/publication/publication-modal";
import { SectionHeading } from "@/components/home/section-heading";
import { SectionInfoButton } from "@/components/shared/section-info-button";
import { sanitizePubmedHtml } from "@/lib/utils";
import { isPubliclyDisplayed } from "@/lib/eligibility";
import { profilePath } from "@/lib/profile-url";
import type { SpotlightAuthor, SpotlightCard } from "@/lib/api/home";

const AUTO_ADVANCE_MS = 10_000;
const AUTHOR_DISPLAY_CAP = 4;

/**
 * `items` is already the final draw — which spotlights to show, and which one
 * starts active, are decided on the server (`selectSpotlightsForRender`, #1709).
 * This component no longer re-picks on mount: doing so discarded the whole
 * server-rendered section at hydration, remounting the left pane and re-firing
 * its author-headshot loads, which is what made the Spotlight look slow to
 * render. The only thing that moves after mount is the auto-advance.
 */
export function SpotlightSection({
  items,
  startIdx = 0,
}: {
  items: SpotlightCard[];
  startIdx?: number;
}) {
  const [activeIdx, setActiveIdx] = useState(startIdx);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    if (items.length === 0) return;
    const interval = setInterval(() => {
      if (pausedRef.current) return;
      setActiveIdx((i) => (i + 1) % items.length);
    }, AUTO_ADVANCE_MS);
    return () => clearInterval(interval);
  }, [items]);

  if (items.length === 0) return null;
  const display = items;
  const active = display[activeIdx] ?? display[0];

  return (
    <section
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      <SectionHeading
        aside={
          <SectionInfoButton label="Spotlight" anchor="spotlight">
            Spotlight rotates subareas with the strongest recent activity at
            WCM, one per research area, refreshed weekly. Subareas are scored
            from ReCiterAI publication scores on PubMed records.
          </SectionInfoButton>
        }
      >
        Spotlight
      </SectionHeading>

      <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-[1.6fr_1fr]">
        <SpotlightDetail card={active} />
        <div className="grid auto-rows-fr grid-cols-1 content-start gap-2 sm:grid-cols-2">
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
  // Land the user on the publication feed for the requested subtopic — not at
  // the top of the topic page. The topic page exposes a stable
  // id="publications" anchor on the SubtopicPublicationLayout root (#3).
  const subtopicBase = `/topics/${card.parentTopicSlug}?subtopic=${card.subtopicId}`;
  const parentHref = `/topics/${card.parentTopicSlug}`;
  // #2218 — null counts mean the (parent, subtopic) pair has no aggregate row:
  // either the subtopic was retired from the taxonomy underneath this artifact,
  // or it has nothing to browse. Either way the three subtopic-scoped deep links
  // have no destination worth sending anyone to, so the title falls back to the
  // parent topic page (which is known to resolve — `getSpotlights` drops cards
  // whose parent does not) and the count line is omitted entirely rather than
  // rendering "0 publications · 0 scholars" beside three real papers.
  const hasPubCount = card.publicationCount !== null;
  const hasScholarCount = card.scholarCount !== null;
  const subtopicHref = hasPubCount ? `${subtopicBase}#publications` : parentHref;
  const pubsHref = `${subtopicBase}#publications`;
  const scholarsHref = `${subtopicBase}#top-scholars`;
  const noUnderlineHover =
    "no-underline hover:underline underline-offset-4 decoration-1";

  return (
    <div
      // `key` retriggers the fade-in transition on activeIdx swap.
      key={card.subtopicId}
      className="animate-in fade-in slide-in-from-bottom-1 border-apollo-border bg-apollo-surface flex min-h-[380px] flex-col rounded-[var(--apollo-radius-card)] border border-t-[3px] border-t-apollo-maroon p-7 shadow-[var(--apollo-shadow-card)] duration-300"
    >
      <a
        href={parentHref}
        aria-label={`View research area ${card.parentTopicLabel}`}
        className={`text-[11px] leading-4 font-semibold tracking-[0.1em] text-[var(--color-primary-cornell-red)] uppercase ${noUnderlineHover}`}
      >
        {card.parentTopicLabel}
      </a>
      <h3 className="mt-2.5 text-[28px] leading-[34px] font-medium tracking-[-0.01em] text-balance">
        <a
          href={subtopicHref}
          aria-label={`View subarea ${card.displayName}`}
          className={`text-zinc-900 ${noUnderlineHover}`}
        >
          {card.displayName}
        </a>
      </h3>
      <p className="text-muted-foreground mt-3.5 max-w-[62ch] text-sm leading-[22px] text-pretty">{card.lede}</p>

      {hasPubCount || hasScholarCount ? (
        <div className="bg-apollo-surface-2 mt-5 flex flex-wrap gap-x-6 gap-y-1 rounded-lg px-3.5 py-2.5 text-sm">
          {hasPubCount ? (
            <a
              href={pubsHref}
              aria-label={`Browse all ${card.publicationCount!.toLocaleString()} publications in ${card.displayName}`}
              className={`text-[var(--color-accent-slate)] ${noUnderlineHover}`}
            >
              <span className="font-semibold">
                {card.publicationCount!.toLocaleString()}
              </span>{" "}
              publications
            </a>
          ) : null}
          {hasScholarCount ? (
            <a
              href={scholarsHref}
              aria-label={`Browse all ${card.scholarCount!.toLocaleString()} scholars working in ${card.displayName}`}
              className={`text-[var(--color-accent-slate)] ${noUnderlineHover}`}
            >
              <span className="font-semibold">
                {card.scholarCount!.toLocaleString()}
              </span>{" "}
              scholars
            </a>
          ) : null}
        </div>
      ) : null}

      <div className="mt-5 flex flex-col">
        <div className="text-muted-foreground mb-1 text-[11px] leading-4 tracking-[0.1em] uppercase">
          Representative papers
        </div>
        {card.papers.map((p, slot) => (
          <PaperRow
            key={p.pmid}
            pmid={p.pmid}
            title={p.title}
            journal={p.journal}
            year={p.year}
            authors={p.authors}
            slot={slot}
            subtopicId={card.subtopicId}
            cycleId={card.artifactVersion}
          />
        ))}
      </div>
      {hasPubCount ? (
        <a href={pubsHref} className={`mt-4 text-sm text-[var(--color-accent-slate)] ${noUnderlineHover}`}>
          See all {card.publicationCount!.toLocaleString()} publications →
        </a>
      ) : null}
    </div>
  );
}

function PaperRow({
  pmid,
  title,
  journal,
  year,
  authors,
  slot,
  subtopicId,
  cycleId,
}: {
  pmid: string;
  title: string;
  journal: string;
  year: number;
  authors: SpotlightAuthor[];
  // Display position 0|1|2 and the publish-cycle ID — beaconed on click so
  // the #286 CTR-across-cycles metric can attribute each click (#343).
  slot: number;
  subtopicId: string;
  cycleId: string;
}) {
  const { open } = usePublicationModal();
  // #811 — never slice off the senior (last) author. SpotlightAuthor carries no
  // isLast flag, but lib/api/home documents the array as byline-position order,
  // so the senior is the last element. On overflow keep the first (CAP-1), the
  // +N pill, then pin the senior last: [First] [Second] … +N more … [Senior].
  // No overflow → render every author in order with no tail and no duplication.
  const hasTail = authors.length > AUTHOR_DISPLAY_CAP;
  const visible = hasTail
    ? authors.slice(0, AUTHOR_DISPLAY_CAP - 1)
    : authors.slice(0, AUTHOR_DISPLAY_CAP);
  const senior = hasTail ? authors[authors.length - 1] : null;
  const overflow = authors.length - visible.length - (senior ? 1 : 0);

  // Fire-and-forget CTR beacon. Mirrors the search-result pattern: the Blob
  // wrapper sets the JSON content-type the route's request.json() expects.
  // Never blocks navigation; no-ops where sendBeacon is unavailable.
  function handleClick() {
    if (typeof navigator === "undefined" || !navigator.sendBeacon) return;
    const payload = {
      event: "spotlight_paper_click",
      pmid,
      slot,
      subtopicId,
      cycleId,
      ts: Date.now(),
    };
    navigator.sendBeacon(
      "/api/analytics",
      new Blob([JSON.stringify(payload)], { type: "application/json" }),
    );
  }

  return (
    <div className="border-apollo-border flex flex-col gap-2 border-b py-3.5">
      {/* Title opens the shared publication modal (#947), mirroring the
          profile/search rows. The spotlight_paper_click CTR beacon (#286/#343)
          still fires alongside open(); PubMed remains reachable from the modal
          identifiers row. */}
      <button
        type="button"
        onClick={() => {
          handleClick();
          open(pmid);
        }}
        className="text-foreground hover:text-apollo-slate hover:decoration-apollo-slate text-left text-[15px] leading-[22px] font-medium text-pretty decoration-1 underline-offset-[3px] transition-colors duration-[120ms] ease-out hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--apollo-ring)]"
        dangerouslySetInnerHTML={{ __html: sanitizePubmedHtml(stripTrailingPeriod(title)) }}
      />
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-[13px] text-zinc-500">
        {visible.map((a) => (
          <AuthorChip key={a.cwid} author={a} />
        ))}
        {overflow > 0 ? <span className="text-zinc-500">+{overflow} more</span> : null}
        {senior ? <AuthorChip key={`senior-${senior.cwid}`} author={senior} /> : null}
      </div>
      <div className="text-muted-foreground text-[13px] leading-[18px]">
        <em dangerouslySetInnerHTML={{ __html: sanitizePubmedHtml(journal) }} />
        {`, ${year}`}
      </div>
    </div>
  );
}

/** PubMed titles end in a period; the card reads cleaner without it. Case is left
 *  as PubMed has it — re-casing Title Case would lowercase proper nouns. */
export function stripTrailingPeriod(title: string): string {
  return title.trim().replace(/\.$/, "");
}

function AuthorChip({ author }: { author: SpotlightAuthor }) {
  const inner = (
    <>
      <HeadshotAvatar
        size="sm"
        cwid={author.cwid}
        preferredName={author.displayName}
        identityImageEndpoint={author.identityImageEndpoint}
      />
      <span className="text-zinc-700">{author.displayName}</span>
    </>
  );
  // #536 — hidden identity class (doctoral student): name + headshot, no link.
  if (!isPubliclyDisplayed(author.roleCategory)) {
    return <span className="inline-flex items-center gap-1.5">{inner}</span>;
  }
  return (
    <a
      href={profilePath(author.profileSlug)}
      className="inline-flex items-center gap-1.5 hover:text-zinc-900 hover:underline"
    >
      {inner}
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
        "flex h-full min-w-0 flex-col gap-1.5 rounded-[10px] border px-3.5 py-3 text-left transition-colors duration-[120ms] ease-out",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--apollo-ring)]",
        // Active = the rail tint + a "Showing" label; the detail pane earns the
        // visual weight, these cards are navigation.
        active
          ? "border-apollo-rail-border bg-apollo-rail"
          : "border-apollo-border bg-apollo-surface hover:border-apollo-border-strong focus-visible:border-apollo-border-strong shadow-[var(--apollo-shadow-card)]",
      ].join(" ")}
    >
      <div className="line-clamp-2 min-h-[30px] text-[10.5px] leading-[15px] font-semibold tracking-[0.1em] text-[var(--color-primary-cornell-red)] uppercase">
        {card.parentTopicLabel}
      </div>
      <div className="text-foreground line-clamp-3 text-[14px] leading-[19px] font-medium text-pretty">
        {card.displayName}
      </div>
      {/* #2218 — same rule as the detail pane: an absent aggregate row is not
          "0 pubs · 0 scholars". Omit the line rather than assert a false zero. */}
      <div className="text-muted-foreground mt-auto flex items-baseline justify-between gap-2 pt-1.5 text-xs">
        {card.publicationCount !== null && card.scholarCount !== null ? (
          <span>
            {card.publicationCount.toLocaleString()} pubs · {card.scholarCount.toLocaleString()} scholars
          </span>
        ) : (
          <span />
        )}
        {active ? <span className="text-foreground text-[11px] font-semibold">Showing</span> : null}
      </div>
    </button>
  );
}
