/**
 * "Pending in ReCiter" — a dormant, self-only nudge (`SELF_EDIT_RECITER_PENDING_HINT`,
 * off by default; the backing `reciter_pending_suggestion` table is empty until an
 * ETL populates it). It surfaces ReCiter "pending / suggested" candidate
 * publications — papers ReCiter estimates are likely the scholar's but that haven't
 * been claimed yet — so the scholar logs into Publication Manager (ReCiter) to
 * accept or reject them.
 *
 * Posture (mirrors the COI-gap "From your publications" bridge): this is a
 * SUGGESTION, never a verdict. Color tracks confidence, not alarm — amber
 * (40–69) "worth a look", green (≥70) "high confidence". The curation line states
 * plainly that WCM library curators routinely accept/reject these on scholars'
 * behalf, so a pending paper is an opportunity, not a fault.
 *
 * Two display modes by the top suggestion's score:
 *   - HERO (top score ≥ 70): a card with a numeric SCORE chip (green) + the
 *     citation, the authorship-confidence tooltip, and a "+ N-1 more" line.
 *   - REFERRED fallback (top score 40–69, no hero): a softer count + a plain list
 *     of the suggestion titles.
 *
 * The CTA routes to Publication Manager (ReCiter) in a new tab. Renders null when
 * there are no suggestions — the table is empty in the dormant state, so this
 * component contributes nothing until the feature is turned on AND populated.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight, Info } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { PUBLICATION_MANAGER_URL } from "@/lib/edit/request-a-change";
import { cn } from "@/lib/utils";
import type { ReciterSuggestion } from "@/lib/reciter/client";

export type ReciterPendingCardProps = {
  suggestions: ReadonlyArray<ReciterSuggestion>;
  /** `"self"` (default) uses first-person copy ("your profile"); `"superuser"`
   *  reframes it in the third person for an admin curating another scholar's
   *  suggestions, mirroring the COI-gap / Publications cards. */
  mode?: "self" | "superuser";
  /** The target scholar's display name — only used in `"superuser"` mode to
   *  possessivize the third-person copy. */
  scholarName?: string;
};

/** A hero shows only when the top suggestion clears this confidence bar. */
const HERO_SCORE = 70;

const PUBMED_URL = (pmid: string) =>
  `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(pmid)}/`;

export function ReciterPendingCard({
  suggestions,
  mode = "self",
  scholarName = "",
}: ReciterPendingCardProps) {
  if (suggestions.length === 0) return null;

  const n = suggestions.length;
  const top = suggestions[0];
  const hasHero = top.score >= HERO_SCORE;
  const su = mode === "superuser";
  const possessive = su ? `${scholarName}’s` : "your";

  return (
    <div
      data-testid="reciter-pending-bridge"
      className="border-apollo-amber-tint-border bg-apollo-amber-tint flex flex-col gap-3 rounded-md border px-4 py-3.5"
    >
      <div className="min-w-0">
        <p className="text-foreground flex items-center gap-2 text-sm font-semibold">
          <span className="bg-apollo-amber size-[7px] shrink-0 rounded-full" aria-hidden />
          {n === 1
            ? `1 publication may be missing from ${su ? "this" : "your"} profile`
            : `${n} publications may be missing from ${su ? "this" : "your"} profile`}
        </p>
        <p className="text-muted-foreground mt-1 max-w-prose text-[0.8rem] leading-relaxed">
          Candidate articles like {n === 1 ? "this" : "these"} are often accepted or rejected by WCM
          library curators on scholars&rsquo; behalf; the ones still pending may include papers of{" "}
          {su ? "this scholar’s" : "yours"} that aren&rsquo;t on {possessive} profile yet.
        </p>
      </div>

      {hasHero ? (
        <HeroSuggestion suggestion={top} more={n - 1} mode={mode} scholarName={scholarName} />
      ) : (
        <ReferredList suggestions={suggestions} />
      )}

      <div className="flex">
        {/* Front door to Publication Manager — its default landing IS the curate
            page where the scholar accepts/rejects. Intentionally not deep-linked
            (product decision): the scholar lands on the curate view directly. */}
        <Button asChild variant="apollo" size="sm">
          <Link
            href={PUBLICATION_MANAGER_URL}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="reciter-pending-cta"
          >
            Review {n === 1 ? "1 " : `all ${n} `}in ReCiter
            <ArrowRight className="size-4" aria-hidden />
          </Link>
        </Button>
      </div>
    </div>
  );
}

/** The amber/green numeric authorship-confidence chip with an info tooltip. */
function ScoreChip({
  score,
  mode = "self",
  scholarName = "",
}: {
  score: number;
  mode?: "self" | "superuser";
  scholarName?: string;
}) {
  const green = score >= HERO_SCORE;
  const su = mode === "superuser";
  // The authorship-confidence explanation (operator-approved verbatim copy). It
  // is the hover tooltip's content AND an always-present visually-hidden
  // description, so the affordance is keyboard/SR-reachable even when the Radix
  // portal isn't mounted (it mounts only while open). In superuser mode the
  // first-person "yours" / "your" become third-person for the target scholar.
  const whose = su ? `this paper is ${scholarName}’s` : "this paper is yours";
  const possessive = su ? "their" : "your";
  const tooltipCopy = `Authorship confidence — ${score} / 100. ReCiter's empirically-derived estimate of how likely ${whose}, based on ${possessive} name, affiliations, co-authors, topics and grants. Higher means more certain.`;
  return (
    <span
      data-testid="reciter-pending-score-chip"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold",
        green
          ? "text-apollo-green bg-apollo-green-tint border-apollo-green-tint-border"
          : "text-apollo-amber bg-apollo-amber-tint border-apollo-amber-tint-border",
      )}
    >
      <span className="tabular-nums">{score}</span>
      <span className="text-[0.65rem] font-bold tracking-wider uppercase opacity-80">Score</span>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={tooltipCopy}
              className="inline-flex items-center"
            >
              <Info className="size-3.5" aria-hidden />
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">{tooltipCopy}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {/* Always-present mirror of the tooltip copy so the explanation is in the
          DOM even when the Radix portal is closed (hover-only mount). */}
      <span className="sr-only" data-testid="reciter-pending-score-help">
        {tooltipCopy}
      </span>
    </span>
  );
}

/** A single source citation line: preprint badge · date · PMID; title; authors · journal. */
function Citation({ suggestion }: { suggestion: ReciterSuggestion }) {
  const meta: React.ReactNode[] = [];
  if (suggestion.isPreprint) {
    meta.push(
      <span
        key="preprint"
        data-testid="reciter-pending-preprint"
        className="text-apollo-slate bg-apollo-slate-tint border-apollo-slate-tint-border inline-flex items-center rounded-full border px-1.5 py-0.5 text-[0.65rem] font-semibold uppercase"
      >
        Preprint
      </span>,
    );
  }
  if (suggestion.datePublished) meta.push(<span key="date">{suggestion.datePublished}</span>);
  meta.push(
    <a
      key="pmid"
      href={PUBMED_URL(suggestion.pmid)}
      target="_blank"
      rel="noopener noreferrer"
      className="underline"
    >
      PMID {suggestion.pmid}
    </a>,
  );

  return (
    <div className="min-w-0">
      <p className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-[0.75rem]">
        {meta.map((node, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span aria-hidden>·</span>}
            {node}
          </React.Fragment>
        ))}
      </p>
      <p className="text-foreground mt-0.5 text-sm font-medium leading-snug">
        {suggestion.articleTitle}
      </p>
      <p className="text-muted-foreground mt-0.5 text-[0.8rem] leading-snug">
        {suggestion.authors}
        {suggestion.journal ? <> · {suggestion.journal}</> : null}
      </p>
    </div>
  );
}

function HeroSuggestion({
  suggestion,
  more,
  mode = "self",
  scholarName = "",
}: {
  suggestion: ReciterSuggestion;
  more: number;
  mode?: "self" | "superuser";
  scholarName?: string;
}) {
  return (
    <div
      data-testid="reciter-pending-hero"
      className="border-apollo-border bg-apollo-surface flex flex-col gap-2.5 rounded-md border px-3.5 py-3"
    >
      <ScoreChip score={suggestion.score} mode={mode} scholarName={scholarName} />
      <Citation suggestion={suggestion} />
      {more > 0 && (
        <p className="text-muted-foreground text-[0.8rem]">
          + {more} more suggested {more === 1 ? "article" : "articles"} in ReCiter
        </p>
      )}
    </div>
  );
}

function ReferredList({
  suggestions,
}: {
  suggestions: ReadonlyArray<ReciterSuggestion>;
}) {
  const n = suggestions.length;
  return (
    <div data-testid="reciter-pending-referred" className="min-w-0">
      <p className="text-foreground text-sm">
        {n === 1
          ? "1 possible publication to review in ReCiter"
          : `${n} possible publications to review in ReCiter`}
      </p>
      <ul className="text-muted-foreground mt-1.5 flex list-disc flex-col gap-1 pl-5 text-[0.8rem] leading-snug">
        {suggestions.map((s) => (
          <li key={s.pmid}>{s.articleTitle}</li>
        ))}
      </ul>
    </div>
  );
}

/** The API the client loader fetches. The route is the authz point: it returns
 *  `{ suggestions: [] }` when the flag is off, there is no session, or a
 *  non-superuser asks for a cwid that isn't their own — so a dormant page (or an
 *  unauthorized read) never surfaces anything. */
const RECITER_PENDING_ENDPOINT = "/api/edit/reciter-pending";

/**
 * Lazily fetch the target scholar's live ReCiter pending suggestions on mount.
 *
 * Pass `cwid` to read a specific scholar (the superuser-parity case); omit it to
 * read the signed-in identity (the self case). The route authorizes the supplied
 * cwid (a non-superuser may only read their own). Returns the suggestions (empty
 * until the fetch resolves) — the ReCiter engine read happens client-side so the
 * dormant page makes ZERO server round-trip: the loader is only ever rendered
 * when `reciterPendingEnabled` is true. Any non-2xx / parse / network failure
 * degrades silently to `[]` (the route itself also degrades to `[]`).
 */
export function useReciterPendingSuggestions(cwid?: string): ReciterSuggestion[] {
  const [suggestions, setSuggestions] = React.useState<ReciterSuggestion[]>([]);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const url =
          RECITER_PENDING_ENDPOINT +
          (cwid ? "?cwid=" + encodeURIComponent(cwid) : "");
        const res = await fetch(url, {
          method: "GET",
          headers: { accept: "application/json" },
        });
        if (!res.ok) return;
        const data = (await res.json()) as { suggestions?: ReciterSuggestion[] };
        if (!cancelled && Array.isArray(data.suggestions)) {
          setSuggestions(data.suggestions);
        }
      } catch {
        // Network/parse failure — leave the suggestions empty (render nothing).
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cwid]);

  return suggestions;
}

/**
 * Client loader for the full publications-card nudge. Fetches the target
 * scholar's live ReCiter suggestions on mount (self by default, or the supplied
 * `cwid` for a superuser viewing another scholar) and renders
 * {@link ReciterPendingCard} once populated; renders nothing while loading,
 * empty, or on error.
 */
export function ReciterPendingCardClient({
  cwid,
  mode,
  scholarName,
}: {
  cwid?: string;
  mode?: "self" | "superuser";
  scholarName?: string;
} = {}) {
  const suggestions = useReciterPendingSuggestions(cwid);
  if (suggestions.length === 0) return null;
  return <ReciterPendingCard suggestions={suggestions} mode={mode} scholarName={scholarName} />;
}
