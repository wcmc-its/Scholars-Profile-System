"use client";

/**
 * Per-core review queue (the owner surface at /edit/core/[coreId]/review).
 *
 * v2 layout (Core Review Queue v2 mockup, PR A — client-only). The To review
 * tab is three panes:
 *   - LEFT, the scope rail (`ScopeRail`): "By evidence" lists the evidence
 *     groups `evidenceGroupKey` produces, each with its open count and band;
 *     "By person" lists the byline authors this core already holds confirmed
 *     work from, with their prior-confirmed and open counts. Plus a static
 *     "About these signals" note.
 *   - MIDDLE, a compact list: checkbox, title, meta, signal chips, band. A
 *     selection bar confirms or rejects the ticked rows in one bulk request,
 *     and "Reject all N…" rejects every row shown behind an inline guard.
 *   - RIGHT, the focused paper (`FocusedPaper`): Previous/Next, synopsis, the
 *     band meter, Confirm/Reject, reject-with-a-reason chips (sent as the
 *     single-claim route's existing `note`), "Why this surfaced", "Methods
 *     used · context only", and the quotes.
 * Above them: a search box that also takes several PMIDs at once ("Matched X
 * of Y · Elsewhere: …"), a Filters panel with active chips, sort pills, the
 * session line ("This session: N confirmed · M rejected" + Undo last), an
 * inline key hint and a keyboard-shortcuts popover (j/k/a/r/x/u/?, one window
 * listener). A decided paper leaves the list at once, the pane moves on to the
 * next one, and an undo toast offers its Undo for a few seconds.
 *
 * Below `lg` (the console IS used on phones; the designer drew no phone
 * layout, so this is the approved proposal): the rail becomes a select above
 * the list, the list runs full width, and tapping a row opens the paper as a
 * full-screen sheet with its own Close.
 *
 * Vocabulary rules that carried over unchanged from direction A:
 *   - the score reads as a BAND WORD + percent ("Strong 94%"), never a labelled
 *     "Combined likelihood" bar. Bands are Strong >= 0.85, Moderate >= 0.65,
 *     Slight >= 0.40, else Weak;
 *   - the signal count says "N of 4" with all FOUR signals countable, and the
 *     prefilter prior is a footnote, never a counted signal;
 *   - group and rail labels name BANDS, never "likelihood 41-94%";
 *   - a facet value whose count is 0 is not offered (a control that can only
 *     empty the list is not a control);
 *   - PMID/CWID parsing keeps the strict parsers and their rejected-token
 *     reporting; a split-on-any-non-digit form would turn "abc123def" into 123.
 *
 * PR B added the pieces that needed a route or schema change: bulk Revoke /
 * Restore on the Confirmed/Rejected tabs (selection + the inline guard, via
 * `status: "revoked"` on the bulk route; those tabs also get the search box
 * and Filters), and Add PMIDs' "Send to review" mode (`core_queue_add`, shown
 * under the unscored "Added by you" rail group).
 *
 * Still NOT built: the grant-signal rail groups (next PR). Also not built: the core-staff note's
 * "Manage staff" link (the roster lives in ReciterAI's facility dictionary,
 * and SPS has no route that edits it).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, ExternalLink, PenLine, Undo2, X } from "lucide-react";
import type { CoreClientRow } from "@/lib/api/core-clients";
// The PURE half of `lib/api/core-clients.ts`. `excludingOwnPaper` is a VALUE
// import, so it must not come from the loader module — that one constructs prisma
// at module scope and would drag the mariadb driver into this client bundle.
import { excludingOwnPaper, type CoreClientPaperCount } from "@/lib/cores/paper-counts";
import { droppedAuthorCount, stripWcmMarkers } from "@/lib/author-byline";
// See `nameWords`. Dependency-free by design (its own docblock says so), so it
// imports nothing at module scope and is safe in this client bundle.
import { extractLastNameSort, stripUnitDisambiguation } from "@/lib/name-sort";
import type { CoreQueueRow, CoreReviewQueue, QueueScholar } from "@/lib/api/core-queue";
// Pure and import-free, so safe in this client bundle (the loader modules that
// also export these construct prisma at module scope).
import {
  CANDIDATE_DISPLAY_FLOOR_PCT,
  hasOnlyRepeatUserOrWeakMethod,
  isBelowDisplayFloor,
} from "@/lib/cores/review-thresholds";
import { CoreClientsDialog } from "@/components/edit/core-clients-panel";
import {
  AboutSignals,
  ActiveFilterChips,
  FiltersPanel,
  ScopeRail,
  QueueSummary,
  ShortcutsButton,
  KEYS_HINT,
  UndoToast,
  StrengthGlyphs,
  type ActiveChip,
  type FacetGroupView,
  type RailItem,
  type RailMode,
} from "@/components/edit/core-queue-panels";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Input } from "@/components/ui/input";
import { toCsv } from "@/lib/csv";

/** Server-side batch cap on `POST /api/edit/core-claim/bulk` (MAX_BULK_PMIDS).
 *  Mirrored here so an over-long paste is caught before the round-trip, and so
 *  the modal can state the limit. */
export const MAX_CLAIM_PMIDS = 500;

/** The Add PMIDs dialog's two modes (mockup): claim now, or queue for review. */
type AddMode = "claim" | "review";
const ADD_MODES: ReadonlyArray<{ key: AddMode; label: string; sub: string }> = [
  {
    key: "claim",
    label: "Confirm now",
    sub: "You know these used the core. Recorded as your decision, with no evidence trail.",
  },
  {
    key: "review",
    label: "Send to review",
    sub: "Possible uses to check later. They join To review under “Added by you”.",
  },
];

/** What the "Check PMIDs" dry run found. */
interface PmidCheck {
  /** PMIDs the commit would actually write (a claim, or a queue row). */
  wouldWrite: number;
  /** Claim mode: already claimed for this core — writing them again is a no-op.
   *  Send-to-review mode: already on this core's To review list. */
  skipped: number;
  /** Send-to-review mode only: already decided for this core (claimed or
   *  rejected by a person, or confirmed by the engine). */
  decided?: number;
  /** Not ingested by SPS; a claim skips these rather than inventing a row. */
  notFound: string[];
  /** Tokens the paste-parser rejected before the request. */
  invalid: string[];
}

/** A pasted block of PMIDs, split on any run of whitespace/commas. Digit-only
 *  tokens are candidates; anything else is reported back so a typo isn't
 *  silently dropped. Pure — unit-tested without the network. */
export function parsePmidBlock(text: string): { pmids: string[]; invalid: string[] } {
  const tokens = text
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const pmids: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    if (/^[1-9][0-9]*$/.test(t)) {
      if (!seen.has(t)) {
        seen.add(t);
        pmids.push(t);
      }
    } else {
      invalid.push(t);
    }
  }
  return { pmids, invalid };
}

/**
 * The title as the card shows it: PubMed stores a sentence-final period on
 * nearly every title, and the header reads as a heading, not a sentence.
 *
 * Strips ONE trailing "." and nothing else. A trailing "?" or "!" is part of
 * the title's own voice ("Does X cause Y?") and stays, and a "." straight after
 * an uppercase letter is the last stop of an initialism ("... in the U.S."),
 * where dropping it would misspell the word.
 *
 * Display only — the stored title, the CSV citation string and `searchBlob` all
 * keep the raw value. Pure.
 */
/** CSV export column order. Exported so the column CONTRACT stays under test while
 *  the "Download CSV" button is off the toolbar (the mockup moved export into the
 *  reporting view, which is not built). A downloaded CSV's headers are a de-facto
 *  contract for whoever parses the file, so this order must not drift silently. */
export const CSV_HEADERS = [
  "PMID",
  "Title",
  "Authors",
  "Journal",
  "Year",
  "DOI",
  "Status",
  "Likelihood",
  "Citation",
] as const;

/** One CSV row for a queue row, given its already-resolved display status.
 *  Pure: `status` is passed in because deriving it needs component state.
 *  NOTE the deliberate mismatch with the card: the CSV keeps the RAW title (not
 *  `displayTitle`), because an export is a record, not a rendering — a stripped
 *  trailing period would corrupt a citation. (The journal no longer differs: the
 *  card prefers the full title too since round 2.) */
export function csvRow(r: CoreQueueRow, status: string): (string | number)[] {
  const authors = r.fullAuthorsString ?? r.authorsString ?? "";
  // plain Vancouver-ish citation string, PMID-anchored
  const citation =
    [authors, r.title, r.journal, r.year].filter(Boolean).join(". ") + `. PMID: ${r.pmid}.`;
  return [
    r.pmid,
    r.title,
    authors,
    r.journal ?? "",
    r.year ?? "",
    r.doi ?? "",
    status,
    r.likelihood.toFixed(3),
    citation,
  ];
}

export function displayTitle(title: string): string {
  if (!title.endsWith(".")) return title;
  const prev = title.slice(-2, -1);
  if (/[A-Z]/.test(prev)) return title;
  return title.slice(0, -1);
}

/**
 * "Added to PubMed Feb 18, 2026" from a `YYYY-MM-DD` calendar date, or null
 * when there is no date (the caller then falls back to the publication year —
 * an empty slot with a dangling separator is worse than neither).
 *
 * Formatted in UTC on purpose. `dateAddedToEntrez` is a `@db.Date`, which
 * reaches this component as a calendar date with no zone; parsing it as UTC
 * midnight and formatting it in the VIEWER's zone would render the previous day
 * for everyone west of UTC — including every WCM curator. Pure.
 */
export function formatAddedToPubMed(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return `Added to PubMed ${d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  })}`;
}

type Decision = "claimed" | "rejected";
/** Which list the segmented control is showing (only when there's history). */
type QueueView = "review" | "confirmed" | "rejected";
/** Exported for the pure-predicate tests. There is no "all" member: the empty
 *  set IS "no narrowing", and "Clear filters" is the only reset control. */
export type FilterKey = "client" | "ack" | "coauthored" | "noprior" | "llm" | "method";
type SortKey = "likelihood" | "uncertain" | "strongest" | "llm" | "year" | "cites";

type SignalKind = "ack" | "coauthor" | "llm" | "affinity";
interface Signal {
  kind: SignalKind;
  /** 1–4 display strength. */
  dots: number;
  strength: string;
}

/** The four counted core-usage signals (ack, co-author, LLM, repeat-user). The
 *  prefilter prior was the fifth until round 2 demoted it: it is not evidence
 *  about the paper, so it renders as an italic footnote under the signal list
 *  (see `priorFootnote`) and is no longer part of this denominator. */
const SIGNAL_COUNT = 4;
/** Stable tie-break so equal-strength signals keep a deterministic order. */
const KIND_ORDER: Record<SignalKind, number> = {
  ack: 0,
  coauthor: 1,
  llm: 2,
  affinity: 3,
};

/**
 * One table per counted signal: its fixed strength (see `buildSignals`), its
 * name in the summary strip, and the "Signals fired" facet value it drives.
 * `facetValues` and the summary's click-to-filter both read `facet` from here,
 * so a click on a summary row ticks exactly the value the Filters panel shows.
 * Strongest-first, which is the order the summary lists them.
 */
export const SIGNAL_KINDS: ReadonlyArray<{
  kind: SignalKind;
  dots: number;
  strength: string;
  label: string;
  facet: string;
}> = [
  { kind: "ack", dots: 4, strength: "Direct", label: "Acknowledgment", facet: "Acknowledged" },
  {
    kind: "coauthor",
    dots: 3,
    strength: "Strong",
    label: "Staff co-author",
    facet: "Staff co-author",
  },
  { kind: "llm", dots: 2, strength: "Moderate", label: "LLM read", facet: "LLM read" },
  { kind: "affinity", dots: 1, strength: "Weak", label: "Repeat user", facet: "Repeat user" },
];
const SIGNAL_BY_KIND = Object.fromEntries(SIGNAL_KINDS.map((s) => [s.kind, s])) as Record<
  SignalKind,
  (typeof SIGNAL_KINDS)[number]
>;

/**
 * Which of the prefilter's two signals actually produced this prior.
 *
 * `topicalPrior` is ReciterAI's `prefilter_prior`: a noisy-OR of author-affinity
 * (0.6) and bare-descriptor MeSH E-tree membership (0.4), so exactly four values are
 * reachable — 0.76 both, 0.60 author only, 0.40 MeSH only, 0 neither.
 *
 * This exists because the queue used to render all of them as "Topical MeSH match /
 * The paper carries a MeSH descriptor under this core's technique branch". Measured
 * on prod 2026-09-04, that sentence was FALSE on 7,332 of the 9,352 chips live —
 * 100% of core 1's, 94.6% of core 9's, 86.5% of core 5's — and would have been false
 * on every one of core 14's, whose MeSH membership is zero. Decode instead of
 * asserting. Pure.
 */
export function decodeTopicalPrior(prior: number): { mesh: boolean; affinity: boolean } {
  // Compare on the integer percent: the four reachable values are exact there, and
  // float equality against 0.76 is not.
  const pct = Math.round(prior * 100);
  return { mesh: pct === 40 || pct === 76, affinity: pct === 60 || pct === 76 };
}

/**
 * The prefilter prior as a FOOTNOTE, not a counted signal (owner, round 2). It
 * is not evidence about this paper: on an author-only prior it is the
 * repeat-user number a second time, and on a MeSH-only prior it is a descriptor
 * match on the paper's own indexing, never a record of this core doing the work.
 * Demoted, not deleted — a reviewer who can see the score cannot see what moved
 * it unless this stays on screen.
 *
 * Decoded, never asserted (see `decodeTopicalPrior`). The author-only case is
 * the common one and carries the owner's copy verbatim; a footnote that said
 * "no mapped MeSH branch" on the rows where MeSH DID fire would repeat the exact
 * mistake `decodeTopicalPrior` exists to prevent, so those two cases get their
 * own honest sentence — and neither claims the prior is nothing.
 *
 * Null at a prior of 0 or absent: that is the prefilter saying NEITHER of its
 * signals fired — absent evidence, which by the engine's own convention emits no
 * key rather than a zero-valued one (pipeline_cores/combine.py
 * evidence_features). A "0%" footnote would caption a row that has nothing to
 * show. Pure.
 *
 * `repeatUserShown` is REQUIRED, and it is what the card actually rendered, not
 * what the prior decoded to: the affinity halves of this copy point at the
 * repeat-user row ("it only restates..."), and per-person de-duplication can
 * take that row off the card entirely (see `repeatUserFires`). Pointing at a row
 * that is not on screen is the same species of unchecked assertion
 * `decodeTopicalPrior` exists to prevent, so the caller has to say.
 */
export function priorFootnote(prior: number | null, repeatUserShown: boolean): string | null {
  if (prior === null || prior <= 0) return null;
  const pct = Math.round(prior * 100);
  const { mesh, affinity } = decodeTopicalPrior(prior);
  if (mesh && affinity)
    return repeatUserShown
      ? `Not counted as evidence: the topical prior (${pct}%) blends a MeSH-branch match with the repeat-user number it already restates.`
      : `Not counted as evidence: the topical prior (${pct}%) blends a MeSH-branch match with an author's prior use of this core.`;
  if (mesh)
    return `Not counted as evidence: the topical prior (${pct}%) is a MeSH-branch match on the paper's own descriptors, not a record of this core doing the work.`;
  return repeatUserShown
    ? `No evidence found: the topical prior (${pct}%) has no mapped MeSH branch for this core, so it only restates the repeat-user number.`
    : `No evidence found: the topical prior (${pct}%) has no mapped MeSH branch for this core, so it rests on an author's prior use of this core rather than on this paper.`;
}

/**
 * WHO the repeat-user prior is about, derived rather than reported.
 *
 * The engine publishes ONE scalar per row and never records whose it is
 * (`author_affinity` arrives as a bare number, see
 * etl/dynamodb/publication-core-mapper.ts). Round 2 requires the person be named
 * on every row, so the name is computed here instead: the byline WCM author this
 * core already holds the most CONFIRMED papers from, and their own counts are
 * what gets printed. Name and number then come out of one computation and cannot
 * disagree — which is also why the engine's percentage is never printed beside
 * the derived name. Affinity is the largest SHARE, and the largest share need not
 * belong to the largest count.
 *
 * EXCLUDE FIRST, THEN PICK. Anyone another evidence token already names is out of
 * the running before the maximum is taken. Picking the maximum first and testing
 * identity afterwards is the same code with the steps swapped, and it behaves
 * like the rule the owner FORBADE (item 6c): core staff normally hold more of
 * their own core's confirmed papers than anyone else on the byline, so the winner
 * was a staff member on almost every staff-co-authored row, and the second
 * person's independent prior use — the evidence 6c exists to protect — was thrown
 * away with them.
 *
 * Ties keep byline order (first author wins), so the choice is deterministic.
 * `paperCounts` is server-computed and uncapped; `row.wcmAuthors` is capped at 12,
 * so a person buried past the cap is simply not nameable here — which is what the
 * null return is for.
 *
 * A count of ZERO papers names nobody either. The loader never emits one, but
 * `withoutOwnPaper` does: on the Confirmed tab a person whose only confirmed
 * paper is the row on screen comes through at 0, and "has used the core on 0
 * previous occasions" is not a weaker claim than one occasion, it is no claim.
 * The key stays in the map at zero on purpose — see `withoutOwnPaper` for what
 * reads it there. Pure.
 */
export function repeatUser(
  row: CoreQueueRow,
  paperCounts: Readonly<Record<string, CoreClientPaperCount>>,
  clientCwids: ReadonlySet<string> = new Set(),
): { scholar: QueueScholar; counts: CoreClientPaperCount } | null {
  if (row.authorAffinity === null) return null;
  const named = namedByOtherEvidence(row, clientCwids);
  let best: { scholar: QueueScholar; counts: CoreClientPaperCount } | null = null;
  for (const a of row.wcmAuthors) {
    const cwid = a.cwid.toLowerCase();
    if (named.has(cwid)) continue;
    const counts = paperCounts[cwid];
    if (counts && counts.papers > 0 && (!best || counts.papers > best.counts.papers))
      best = { scholar: a, counts };
  }
  return best;
}

/**
 * Lowercased CWIDs the row's OTHER evidence tokens already name: every core-staff
 * co-author, and every known client on the byline. `row.coauthors` rather than
 * `coauthorScholars` so an unresolved staff CWID still de-duplicates;
 * `clientCwids` arrives lowercased (see `evidenceTokens`).
 *
 * Both halves, because both print the person AND the same pile of papers: the
 * "Client co-author" token carries "18 papers, 11 recent" and the repeat-user
 * sentence carries "18 previous occasions" about the same 18. One person, one
 * pile, once (item 6b). Pure.
 */
function namedByOtherEvidence(
  row: CoreQueueRow,
  clientCwids: ReadonlySet<string>,
): ReadonlySet<string> {
  const named = new Set(row.coauthors.map((c) => c.toLowerCase()));
  for (const a of row.wcmAuthors) {
    const cwid = a.cwid.toLowerCase();
    if (clientCwids.has(cwid)) named.add(cwid);
  }
  return named;
}

/**
 * Does the repeat-user signal fire — as a row, as a strip token, and in the
 * count, which is one decision made once so the three cannot disagree.
 *
 * It fires whenever `repeatUser` still has somebody to name. It does NOT fire
 * when this core's counts have nothing further to say about anyone on the byline
 * — either because every counted person is already named by another token (one
 * person's involvement shown twice, and the rendered count DOES fall with it:
 * owner, round 2, item 6b) or because the only counts here are the row's own
 * paper, subtracted back out to zero. The test is PER PERSON on lowercased
 * CWIDs, never "drop repeat-user whenever a staff co-author fired" — a DIFFERENT
 * byline author with prior confirmed use is independent evidence and survives
 * (6c).
 *
 * With no counts at all we can name nobody and nothing is de-duplicated: the
 * engine's unnamed rate is then all that is on file, and dropping a signal on a
 * guess is worse than the fallback sentence `evidenceTokens` prints instead.
 */
function repeatUserFires(
  row: CoreQueueRow,
  paperCounts: Readonly<Record<string, CoreClientPaperCount>>,
  clientCwids: ReadonlySet<string>,
): boolean {
  if (row.authorAffinity === null) return false;
  if (repeatUser(row, paperCounts, clientCwids)) return true;
  // Nobody left to name — two very different reasons, and only one of them is
  // empty: somebody on this byline HAS a count here and it added nothing (drop
  // the signal), or no byline author has a count here at all (keep it, unnamed).
  //
  // The test is KEY PRESENCE, never the number behind it, and never WHO holds
  // the key. A confirmed row takes its own paper back out of these counts
  // (`withoutOwnPaper`) and a byline author can come out at zero — "everything
  // this core holds from them is the row you are looking at", which is not a
  // previous occasion and not a claim to print. That is true of the PLAIN author
  // as much as of the one a staff or client token names: an adjusted zero means
  // nothing further to add, full stop.
  //
  // Reading the zero as "nobody qualifies" fired the unnamed fallback — the row
  // counted as its own evidence, and "N of 4" going UP on the one tab that
  // subtracts. Requiring the zero-holder to ALSO be named by another token (as
  // this did) fixed only the half of that where somebody else had named them.
  return !row.wcmAuthors.some((a) => paperCounts[a.cwid.toLowerCase()]);
}

/**
 * Which of the four counted signals fired for a row. Strength is FIXED PER
 * SIGNAL TYPE — how much that *kind* of evidence should move a reviewer — NOT
 * the model's self-score: ack = Direct (4), core-staff co-author = Strong (3),
 * LLM read = Moderate (2) regardless of score, repeat-user = Weak (1), an
 * indirect prior rather than direct evidence about this specific paper. The raw
 * value rides along as the signal's value line — LLM as a score out of 10, and
 * repeat-user as the named person's own confirmed-paper count.
 *
 * `paperCounts` and `clientCwids` are what make the per-person de-duplication
 * possible: a repeat-user prior about the very person the staff- or
 * client-co-author token names is the same evidence twice, so `repeatUserFires`
 * drops it here and the rendered count DOES fall (owner, round 2). Passing
 * neither names nobody and de-duplicates nothing.
 * Pure; ordered strongest-first.
 */
export function buildSignals(
  row: CoreQueueRow,
  paperCounts: Readonly<Record<string, CoreClientPaperCount>> = {},
  clientCwids: ReadonlySet<string> = new Set(),
): Signal[] {
  const kinds: SignalKind[] = [];
  if (row.signalAck || row.ackAlias) kinds.push("ack");
  if (row.coauthors.length > 0) kinds.push("coauthor");
  if (row.llmScore !== null) kinds.push("llm");
  if (repeatUserFires(row, paperCounts, clientCwids)) kinds.push("affinity");
  return kinds
    .map((kind) => ({
      kind,
      dots: SIGNAL_BY_KIND[kind].dots,
      strength: SIGNAL_BY_KIND[kind].strength,
    }))
    .sort((a, b) => b.dots - a.dots || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}

/** The four score bands. `label` is the whole score vocabulary of this surface —
 *  there is no "Combined likelihood"/"Evidence score" caption anywhere. */
export type BandLabel = "Strong" | "Moderate" | "Slight" | "Weak";
interface Band {
  min: number;
  label: BandLabel;
  /** Tailwind text colour for the band word on a white or neutral ground. */
  text: string;
  /** Tailwind background for the meter fill and the rail's band dot. */
  fill: string;
  /** Tinted ground + border + text for the band pill and the paper pane's score
   *  block. Its own text colour, because the band hue alone can miss AA on its
   *  tint (apollo-green on green-tint is 4.39:1; green-foreground clears it). */
  tint: string;
  /** Tailwind left-border colour for a list row's spine. */
  spine: string;
}
// Hues follow the mockup's warm descent — green, amber, terracotta — on existing
// tokens, with master's four bands and cut-offs unchanged. Moderate moved off
// slate because slate is the FOCUSED row's spine and tint: a Moderate row would
// otherwise read as selected. Slight takes coral ("engine output, not yet
// yours" in globals.css), which is what an unreviewed band is. Weak stays
// neutral: below the display floor, so only floor-exempt rows ever show it.
const BANDS: readonly Band[] = [
  {
    min: 0.85,
    label: "Strong",
    text: "text-apollo-green",
    fill: "bg-apollo-green",
    tint: "bg-apollo-green-tint border-apollo-green-tint-border text-apollo-green-foreground",
    spine: "border-l-apollo-green",
  },
  {
    min: 0.65,
    label: "Moderate",
    text: "text-apollo-amber",
    fill: "bg-apollo-amber",
    tint: "bg-apollo-amber-tint border-apollo-amber-tint-border text-apollo-amber",
    spine: "border-l-apollo-amber",
  },
  {
    min: 0.4,
    label: "Slight",
    text: "text-apollo-coral-foreground",
    fill: "bg-apollo-coral-foreground",
    tint: "bg-apollo-coral-tint border-apollo-coral-tint-border text-apollo-coral-foreground",
    spine: "border-l-apollo-coral-foreground",
  },
  {
    min: 0,
    label: "Weak",
    text: "text-muted-foreground",
    fill: "bg-muted-foreground",
    tint: "bg-apollo-surface-2 border-apollo-border-strong text-[var(--evidence-body)]",
    spine: "border-l-muted-foreground",
  },
];

/** Band for a 0–1 likelihood. Thresholds are inclusive lower bounds, so 0.85 is
 *  Strong, 0.65 Moderate and 0.40 Slight exactly on the boundary. Pure. */
export function likelihoodBand(likelihood: number): Band {
  return BANDS.find((b) => likelihood >= b.min) ?? BANDS[BANDS.length - 1];
}

/** The dense LLM triage score in three tiers — ONE set of cut-offs (8, 6) that
 *  both the pane's words (`llmVerdict`) and the list chip's tint (`llmChipTone`)
 *  read, so the two can never disagree about the same score. Pure. */
export function llmTier(score: number): "core" | "possible" | "little" {
  return score >= 8 ? "core" : score >= 6 ? "possible" : "little";
}

/** What the dense LLM triage score means, in words a reviewer can act on. Pure. */
export function llmVerdict(score: number): string {
  const tier = llmTier(score);
  return tier === "core"
    ? "reads as core work"
    : tier === "possible"
      ? "possibly core work"
      : "little sign of core use";
}

/** A list-row chip's tint: `signal` (slate) for a counted signal that fired,
 *  `amber` for an LLM read in the middle tier, `quiet` (neutral) for a weak LLM
 *  read and for uncounted context — the method tier and a known client. */
export type ChipTone = "signal" | "amber" | "quiet";

/** The LLM chip's tone off `llmTier`. Pure. */
export function llmChipTone(score: number): ChipTone {
  const tier = llmTier(score);
  return tier === "core" ? "signal" : tier === "possible" ? "amber" : "quiet";
}

/** Tailwind classes per chip tone (ground, border, text). */
const CHIP_TONE_CLASS: Record<ChipTone, string> = {
  signal: "border-apollo-slate-tint-border bg-apollo-slate-tint text-apollo-slate",
  amber: "border-apollo-amber-tint-border bg-apollo-amber-tint text-apollo-amber",
  quiet: "border-apollo-border-strong bg-apollo-surface-2 text-[var(--evidence-body)]",
};

/** The rail dot for a pile of papers: the LOWEST band's colour (mockup), so a
 *  group spanning "Slight to Strong" warns with its weakest member. Neutral for
 *  an empty pile. Pure. */
export function bandDot(likelihoods: readonly number[]): string {
  if (likelihoods.length === 0) return "bg-apollo-border-strong";
  return likelihoodBand(Math.min(...likelihoods)).fill;
}

/** One label/value pair in the collapsed evidence strip. */
export interface EvidenceToken {
  label: string;
  value: string;
}

/** "18 papers" / "1 paper". Pure. */
function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * "Samprit Banerjee, 18 papers, 11 recent" — the person's name plus what this
 * core already holds from them. A count of zero is DROPPED rather than printed
 * as "0 papers": a client the core has nothing confirmed from yet should read
 * as a name, not as a person the core has looked at and rejected.
 *
 * HOLDINGS, never "previous occasions": pass the core's counts as the loader
 * built them, never `withoutOwnPaper`'s adjusted copy. The two answer different
 * questions and the same person's number must not disagree between the Review
 * and Confirmed tabs — see `evidenceTokens`.
 *
 * Through `displayName`, like every other name this file prints: the curated
 * collision suffix is a roster disambiguation device, so the raw name put the
 * department inside it ("Alessandro Fichera - Surgery, 18 papers"). Pure.
 */
export function namedWithCounts(
  scholar: QueueScholar,
  counts: Readonly<Record<string, CoreClientPaperCount>>,
): string {
  const name = displayName(scholar.name);
  const c = counts[scholar.cwid.toLowerCase()];
  if (!c || c.papers === 0) return name;
  const papers = plural(c.papers, "paper");
  return c.recent > 0 ? `${name}, ${papers}, ${c.recent} recent` : `${name}, ${papers}`;
}

/**
 * The collapsed evidence line as label/value pairs, so the values carry the
 * weight rather than a run-on sentence. `clientCwids` is the core's own "Known
 * clients" list (lowercased CWIDs) — a byline author on it is a stronger read
 * than a bare WCM co-author, and, because that token NAMES them, one of the two
 * populations the repeat-user line de-duplicates against (`repeatUserFires`).
 *
 * TWO COUNT MAPS, because the two tokens that read them make DIFFERENT
 * statements about the same person. `holdings` is what this core holds from
 * them, full stop, and the client token speaks it ("Kim Client, 18 papers, 11
 * recent"). `priorCounts` is what it held BEFORE the row on screen, and the
 * repeat-user line speaks that ("...on 17 previous occasions"). They are the
 * same map everywhere but the Confirmed tab, which is why `priorCounts`
 * defaults to `holdings`: a candidate's own paper was never inside these counts.
 * `ConfirmedRow` is the one caller that passes both, and it MUST, because
 * handing `withoutOwnPaper`'s adjusted copy to the client token made the same
 * person read "18 papers" on Review and "17 papers" on Confirmed.
 * Pure.
 */
export function evidenceTokens(
  row: CoreQueueRow,
  clientCwids: ReadonlySet<string> = new Set(),
  holdings: Readonly<Record<string, CoreClientPaperCount>> = {},
  priorCounts: Readonly<Record<string, CoreClientPaperCount>> = holdings,
): EvidenceToken[] {
  const tokens: EvidenceToken[] = [];
  if (row.ackAlias) tokens.push({ label: "Acknowledged as", value: `“${row.ackAlias}”` });
  else if (row.signalAck) tokens.push({ label: "Acknowledged", value: "in the full text" });
  // The ONE identity this token puts on screen. `coauthorScholars` is a subset of
  // `coauthors` (a staff CWID with no Scholar row stays only in the latter), so
  // the fallback prints the bare CWID rather than nothing.
  const staffNamed = (row.coauthorScholars[0]?.cwid ?? row.coauthors[0] ?? "").toLowerCase();
  if (row.coauthors.length > 0) {
    tokens.push({
      label: "Staff co-author",
      value: row.coauthorScholars[0] ? displayName(row.coauthorScholars[0].name) : row.coauthors[0],
    });
  }
  // STAFF WINS when one person is both, and the client token drops them rather
  // than the other way round — the same collision the byline chip resolves the
  // same way, and for the same reason: "Staff co-author" is the stronger read
  // (3 dots against a client's 0 — the client token is not even a counted
  // signal), and it is the label the expanded card's own evidence row speaks.
  // Printing "Dana Both" under both labels is one person's involvement shown
  // twice, which item 6b forbids as flatly here as it does for the repeat-user
  // line.
  //
  // The suppression is EXACTLY the person the token above names, and not one
  // person wider. Dropping every `row.coauthors` entry was the wider rule, and
  // it deleted people: the token only ever names the FIRST staff member, so a
  // both-flavour client listed second was suppressed here and named nowhere in
  // the strip — off it entirely, with the 40 confirmed papers the client token
  // would have carried. "Shown twice" is a claim about what is on screen, so
  // what is on screen is what it has to be measured against.
  //
  // The expanded card is unaffected: `CoauthorDetail` lists every staff
  // co-author there, and `namedByOtherEvidence` — a different question, "who
  // does this card name anywhere" — still de-duplicates the repeat-user line
  // against the whole list.
  //
  // The `client` FACET is deliberately untouched: it answers "is a known client
  // on this byline", which stays true of a person the strip credits as staff.
  const clients = row.wcmAuthors.filter(
    (a) => clientCwids.has(a.cwid.toLowerCase()) && a.cwid.toLowerCase() !== staffNamed,
  );
  if (clients.length > 0) {
    tokens.push({
      label: clients.length > 1 ? "Client co-authors" : "Client co-author",
      value: clients.map((c) => namedWithCounts(c, holdings)).join("; "),
    });
  }
  if (repeatUserFires(row, priorCounts, clientCwids)) {
    // ALWAYS name the person (owner, round 2). This REVERSES #2620, which named
    // one only on a single-WCM-author byline on the grounds that a name for the
    // engine's scalar would otherwise be a coin flip printed as a fact. The
    // resolution is not to guess harder but to stop reporting the scalar: the
    // name and the numbers below both come out of `repeatUser`, which derives
    // them from the counts this core actually holds, so they cannot disagree.
    //
    // The fallback keeps the OLD unnamed sentence rather than inventing a name:
    // when no byline author has a confirmed paper here (nobody past the 12-author
    // cap is nameable, and a first-time byline has no counts at all) the engine's
    // percentage is all we honestly have, and it is about "an author" because we
    // do not know which.
    const who = repeatUser(row, priorCounts, clientCwids);
    tokens.push({
      label: "Repeat user",
      value: who
        ? `${displayName(who.scholar.name)} has used the core on ${plural(who.counts.papers, "previous occasion")} (out of ${plural(who.counts.total, "publication")}).`
        : // `?? 0` is unreachable — `repeatUserFires` already required a non-null
          // affinity — and is here only because the guard now lives in that
          // function rather than in a condition TypeScript can narrow on.
          `${Math.round((row.authorAffinity ?? 0) * 100)}% of an author's own work`,
    });
  }
  if (row.llmScore !== null) {
    tokens.push({ label: "LLM on title and abstract", value: llmVerdict(row.llmScore) });
  }
  // Method family is NOT one of the four counted signals -- SIGNAL_COUNT stays 4
  // and buildSignals does not know about it. It appears here, last, because a
  // reviewer should see it without the score claiming to have used it: it is
  // weighted 0.00 in the engine's combine.WEIGHTS and moves no likelihood.
  //
  // Always carry the TIER, never a bare "method family identified". Measured
  // lift inside core 14's own curated list spans 399x (strong) to 1.6x (weak),
  // and flattening that to a boolean is exactly the error per-family tiering
  // exists to prevent.
  if (row.methodTier) tokens.push({ label: "Method family", value: row.methodTier });
  return tokens;
}

/**
 * Which evidence KINDS fired on a row, as a stable grouping key ("ack+coauthor",
 * "llm", "none"). Straight off `buildSignals`, so the group header can never
 * name a pile the card itself does not show: the prefilter prior is absent
 * because it is no longer a signal at all, and a repeat-user prior about a
 * person the staff- or client-co-author token already names collapses into that
 * token's own group — one person, one pile, which is exactly what that group
 * then contains. Pure.
 */
export function evidenceGroupKey(
  row: CoreQueueRow,
  paperCounts: Readonly<Record<string, CoreClientPaperCount>> = {},
  clientCwids: ReadonlySet<string> = new Set(),
): string {
  // A paper a reviewer sent here by PMID is its own pile whatever the engine
  // made of it: the engine did not put it on the queue, a person did.
  if (row.queued) return ADDED_GROUP;
  const kinds = buildSignals(row, paperCounts, clientCwids).map((s) => s.kind);
  return kinds.length === 0 ? "none" : kinds.join("+");
}

/** The evidence vocabulary a group header speaks. "no counted signal" rather
 *  than "no labelled signal": a method-family row lands in this group and DOES
 *  carry a label — its chips, its strip token and its "Methods used" quote are
 *  all on the card. What it does not carry is anything inside the denominator. */
const GROUP_NAMES: Record<string, string> = {
  ack: "acknowledgment",
  coauthor: "staff co-author",
  llm: "LLM read",
  affinity: "repeat user",
  none: "no counted signal",
  added: "added by you",
};

/** The rail group for papers sent to review by PMID ("Add PMIDs → Send to
 *  review", a `core_queue_add` row). Unscored: no band, listed first (mockup). */
export const ADDED_GROUP = "added";
/** Its rail sub-line and list-row band slot (mockup: "Unscored"). */
const ADDED_SUB = "Unscored · added by PMID";

/** "3 papers · acknowledgment + staff co-author" — singular-safe. Pure. */
export function evidenceGroupLabel(key: string, count: number): string {
  const kinds = key
    .split("+")
    .map((k) => GROUP_NAMES[k] ?? k)
    .join(" + ");
  return `${plural(count, "paper")} · ${kinds}`;
}

/**
 * The band spread across a group, in the band vocabulary — never "likelihood
 * 41–94%", which is the caption the score readout deliberately dropped. Empty
 * for a single-row group (that row already carries its own band). Pure.
 */
export function bandRange(likelihoods: readonly number[]): string {
  if (likelihoods.length < 2) return "";
  const low = likelihoodBand(Math.min(...likelihoods)).label;
  const high = likelihoodBand(Math.max(...likelihoods)).label;
  return low === high ? low : `${low} to ${high}`;
}

/** The sort pills the v2 list offers (mockup: Most certain · Uncertain first ·
 *  Newest). `compareBySort` still knows the other three keys, pinned by its own
 *  tests; since the pills replaced the six-option select, nothing on this
 *  surface offers them. */
const SORT_PILLS: { key: SortKey; label: string }[] = [
  { key: "likelihood", label: "Most certain" },
  { key: "uncertain", label: "Uncertain first" },
  { key: "year", label: "Newest" },
];

/** Reject-with-a-reason chips (mockup). The label IS the note: it goes to the
 *  single-claim route's existing `note` field (<= 2,000 chars). The bulk route
 *  takes no note, so these live on the focused paper only. */
export const REJECT_REASONS = [
  "External data, not this core",
  "Method match only",
  "Author used core elsewhere",
] as const;

/** Highest single-signal strength on a row (0 when nothing fired). Deliberately
 *  un-de-duplicated: it is a SORT key, and one that moved with the known-clients
 *  roster would reshuffle the queue on an edit that changed no evidence. The
 *  de-dup can only ever drop the 1-dot repeat-user signal, so the maximum shifts
 *  only on a row carrying nothing else — 1 against 0, where every ordering is as
 *  arbitrary as the next. */
function maxSignalDots(row: CoreQueueRow): number {
  return buildSignals(row).reduce((m, s) => Math.max(m, s.dots), 0);
}

/**
 * Order two candidates for the chosen sort. Pure.
 *   likelihood — engine confidence, high→low (default)
 *   uncertain  — closest to 50/50 first, where a reviewer's call matters most
 *   strongest  — by the single strongest signal, then likelihood
 *   llm        — by dense LLM triage score
 *   year       — newest publication year first, then likelihood
 *   cites      — most-cited first
 */
export function compareBySort(sort: SortKey, a: CoreQueueRow, b: CoreQueueRow): number {
  switch (sort) {
    case "uncertain":
      return Math.abs(a.likelihood - 0.5) - Math.abs(b.likelihood - 0.5);
    case "strongest":
      return maxSignalDots(b) - maxSignalDots(a) || b.likelihood - a.likelihood;
    case "llm":
      return (b.llmScore ?? -1) - (a.llmScore ?? -1);
    case "year":
      return (b.year ?? 0) - (a.year ?? 0) || b.likelihood - a.likelihood;
    case "cites":
      return b.citationCount - a.citationCount;
    default:
      return b.likelihood - a.likelihood;
  }
}

/** Does a candidate match ONE filter key? Exhaustive over `FilterKey` — with the
 *  "All" pill gone there is no catch-all key left to fall through to. */
function matchesFilter(
  row: CoreQueueRow,
  filter: FilterKey,
  clientCwids: ReadonlySet<string>,
): boolean {
  switch (filter) {
    case "client":
      return row.wcmAuthors.some((a) => clientCwids.has(a.cwid.toLowerCase()));
    case "ack":
      return row.signalAck || row.ackAlias !== null;
    case "coauthored":
      return row.coauthors.length > 0;
    case "noprior":
      return row.authorAffinity === null;
    case "llm":
      return row.llmScore !== null;
    // Scoped to strong+moderate on purpose. Over all surfaced rows the WEAK
    // families invert to below background (1.7x -> 0.7x measured on core 14),
    // and 63% of rows carrying a tier are weak -- a facet that returned them
    // would narrow the queue TOWARDS the rows the signal argues against.
    case "method":
      return row.methodTier === "strong" || row.methodTier === "moderate";
  }
}

/**
 * AND-combined match across the ticked facets: a row shows only if EVERY ticked
 * facet matches, so "Acknowledged + Staff co-author" narrows to the rows
 * carrying both. The empty set IS the unnarrowed queue — nothing ticked means no
 * narrowing at all. Dropping a 0-count facet (see `facetCounts` below) keeps a
 * SINGLE tick from ever emptying the queue; an intersection of two live facets
 * still can, which is what the "Nothing matches this filter." state is for.
 * Pure.
 */
export function matchesFilters(
  row: CoreQueueRow,
  filters: ReadonlySet<FilterKey>,
  clientCwids: ReadonlySet<string> = new Set(),
): boolean {
  for (const f of filters) if (!matchesFilter(row, f, clientCwids)) return false;
  return true;
}

/**
 * Everything the free-text filter searches on one row, lowercased and joined.
 *
 * The rule is: search only what the card puts on screen. A reviewer who types a
 * word and gets a row back has to be able to see WHY it came back, or the count
 * line lies to them. So this is the card's own text — title, journal, PMID, the
 * synopsis, the byline, the acknowledgment alias and its captured quote — plus
 * the WCM-byline and core-staff names the evidence rows resolve on expand.
 *
 * Of the fields the artboard's blob searched, method FAMILY names are now here
 * (round 2 selects `methodEvidence` and chips the families at the card top) and
 * the method BAND rides along as the evidence token's own rendered text. Three
 * are still dropped, each because the row doesn't carry it or the card doesn't
 * show it:
 *   - method TOOL names: carried on the row but never rendered — the chips are
 *     one per family, and the tool appears nowhere a reviewer can point at;
 *   - the affinity "who": `authorAffinity` is a bare 0-1 number here, with no
 *     person attached to search on;
 *   - `meshTerms`: on the row, but nothing has rendered it since the Details
 *     disclosure came out — an invisible match is worse than a miss.
 * Pure.
 */
export function searchBlob(row: CoreQueueRow): string {
  return [
    row.title,
    row.journal,
    row.pmid,
    row.synopsis,
    row.authorsString,
    row.ackAlias,
    row.ackSnippet,
    ...row.wcmAuthors.map((a) => a.name),
    ...row.coauthorScholars.map((a) => a.name),
    // The evidence token's own rendered text, verbatim, so both halves a
    // reviewer can SEE match: "method" (the placeholder's promise) and the tier
    // word. Not `row.methodTier` alone — that would match "strong" but not the
    // "method" the placeholder advertises.
    row.methodTier ? `Method family ${row.methodTier}` : null,
    // The chips at the card top, by the same rule: a reviewer who can READ
    // "Flow cytometry" on the card must be able to filter on it. Gated on
    // `methodTier` because the chips are — an untiered row carries families the
    // card never draws, and searching those would put rows back that the
    // reviewer cannot see a reason for. The extractor's quoted sentence is
    // deliberately left out: 500 chars of free text per row would match on words
    // that appear nowhere a reviewer can point at.
    ...(row.methodTier ? row.methodEvidence.map((m) => m.family) : []),
  ]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(" ")
    .toLowerCase();
}

/** Does a row match the free-text filter? A blank query narrows nothing. Pure. */
export function matchesQuery(row: CoreQueueRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || searchBlob(row).includes(q);
}

/**
 * Several PMIDs pasted into the search box, or null for an ordinary text query.
 * Two or more tokens, split on whitespace/commas/semicolons, EVERY one a PMID
 * (digits, no leading zero — the same shape `parsePmidBlock` accepts). One PMID
 * stays a text query: `searchBlob` already carries the PMID, so a lone number
 * matches exactly as it always did. De-duplicated, first-seen order. Pure.
 */
export function parsePmidQuery(query: string): string[] | null {
  const tokens = query
    .trim()
    .split(/[\s,;]+/)
    .filter((t) => t.length > 0);
  if (tokens.length < 2 || !tokens.every((t) => /^[1-9][0-9]*$/.test(t))) return null;
  return [...new Set(tokens)];
}

/** The search box's match: a PMID list matches its members exactly; anything
 *  else is the free-text `matchesQuery`. Pure. */
export function matchesSearch(row: CoreQueueRow, query: string): boolean {
  const pmids = parsePmidQuery(query);
  return pmids ? pmids.includes(row.pmid) : matchesQuery(row, query);
}

/**
 * "Matched 2 of 3 PMIDs here. Elsewhere: 123 (Confirmed)." — what a pasted PMID
 * list found in the scope on screen, and where each miss actually is. `where`
 * answers for one PMID the list does not show. Pure.
 */
export function pmidMatchNote(
  pmids: readonly string[],
  shown: ReadonlySet<string>,
  where: (pmid: string) => string,
): string {
  const missing = pmids.filter((p) => !shown.has(p));
  const head = `Matched ${pmids.length - missing.length} of ${pmids.length} PMIDs here.`;
  if (missing.length === 0) return head;
  return `${head} Elsewhere: ${missing.map((p) => `${p} (${where(p)})`).join(", ")}.`;
}

/**
 * The PMIDs a search names outright — every token PMID-shaped, ONE or more (a
 * lone number is a text query to `matchesSearch`, but it still names a PMID).
 * These reach below the display floor: a reviewer who types a PMID is looking
 * for that paper, and "no match" for a paper that is on the queue would be a
 * lie. Empty for any other query. Pure.
 */
export function searchedPmids(query: string): ReadonlySet<string> {
  const tokens = query
    .trim()
    .split(/[\s,;]+/)
    .filter((t) => t.length > 0);
  return new Set(tokens.length > 0 && tokens.every((t) => /^[1-9][0-9]*$/.test(t)) ? tokens : []);
}

/**
 * The To review candidates the queue works over, with the display floor
 * applied (`isBelowDisplayFloor`, lib/cores/review-thresholds.ts). Below-floor
 * open engine candidates are left out unless `showLow` is on, EXCEPT a row
 * decided this session (it keeps its group membership; the list itself drops
 * it, see `filterRows` in the component) and a row whose PMID the
 * search names (`searchedPmids`). `hidden` is how many the floor left out;
 * `belowFloor` how many sit below it at all (the Show/Hide line's two counts).
 * `weakOnly` is true when every below-floor row carries only repeat-user and/or
 * weak-method evidence (`hasOnlyRepeatUserOrWeakMethod`), which lets that line
 * say what is hidden. Order is preserved. Pure.
 */
export function applyDisplayFloor(
  candidates: readonly CoreQueueRow[],
  opts: { showLow: boolean; decided: ReadonlySet<string>; searched: ReadonlySet<string> },
): { shown: CoreQueueRow[]; hidden: number; belowFloor: number; weakOnly: boolean } {
  const shown: CoreQueueRow[] = [];
  let hidden = 0;
  let belowFloor = 0;
  let weakOnly = true;
  for (const r of candidates) {
    if (!isBelowDisplayFloor(r)) {
      shown.push(r);
      continue;
    }
    belowFloor++;
    if (!hasOnlyRepeatUserOrWeakMethod(r)) weakOnly = false;
    if (opts.showLow || opts.decided.has(r.pmid) || opts.searched.has(r.pmid)) shown.push(r);
    else hidden++;
  }
  return { shown, hidden, belowFloor, weakOnly };
}

/** The Filters panel's groups, in the mockup's order. */
export type FacetKey = "signal" | "llm" | "mstr" | "method" | "person" | "year";
export const FACET_GROUPS: ReadonlyArray<{ key: FacetKey; label: string }> = [
  { key: "signal", label: "Signals fired" },
  { key: "llm", label: "LLM score" },
  { key: "mstr", label: "Method match" },
  { key: "method", label: "Method family" },
  { key: "person", label: "Repeat user" },
  { key: "year", label: "Year" },
];
/** Ticked values per group. Absent or empty means that group narrows nothing. */
export type FacetSelection = Partial<Record<FacetKey, readonly string[]>>;

/**
 * Every facet value one row carries, per group, in the words the Filters panel
 * prints. Built off the same functions the card uses, so a facet can never
 * claim a signal the paper pane does not show:
 *   - signal — `buildSignals` (so the repeat-user de-dup applies), plus a known
 *     client on the byline, which is not a counted signal but is evidence a
 *     reviewer filters on;
 *   - llm — the dense score in the mockup's buckets, or "Not read";
 *   - mstr / method — the tier and the family chips, both gated on `methodTier`
 *     exactly as the card and `searchBlob` gate them;
 *   - person — the repeat user the card NAMES (`repeatUser`), "Unnamed author"
 *     when the signal fires with nobody nameable, and "No prior usage on the
 *     byline" for a null affinity (the old facet of that name). A repeat user
 *     de-duplicated into a staff/client token carries no value here, as it
 *     carries no row on the card;
 *   - year — the publication year, or "No year".
 * Pure.
 */
export function facetValues(
  row: CoreQueueRow,
  paperCounts: Readonly<Record<string, CoreClientPaperCount>> = {},
  clientCwids: ReadonlySet<string> = new Set(),
): Record<FacetKey, string[]> {
  const kinds = new Set(buildSignals(row, paperCounts, clientCwids).map((s) => s.kind));
  const signal: string[] = [];
  if (kinds.has("ack")) signal.push(SIGNAL_BY_KIND.ack.facet);
  if (kinds.has("coauthor")) signal.push(SIGNAL_BY_KIND.coauthor.facet);
  if (matchesFilter(row, "client", clientCwids)) signal.push("Client co-author");
  if (kinds.has("llm")) signal.push(SIGNAL_BY_KIND.llm.facet);
  if (kinds.has("affinity")) signal.push(SIGNAL_BY_KIND.affinity.facet);
  const llm =
    row.llmScore === null
      ? "Not read"
      : row.llmScore <= 3
        ? "0–3"
        : row.llmScore <= 6
          ? "4–6"
          : "7–10";
  const tier = row.methodTier
    ? row.methodTier.charAt(0).toUpperCase() + row.methodTier.slice(1)
    : "None";
  const method = row.methodTier ? [...new Set(row.methodEvidence.map((m) => m.family))] : [];
  let person: string[] = [];
  // A manual row's null affinity is a placeholder (the engine never scored it),
  // not a finding that nobody on the byline used the core before.
  if (row.isManual) person = [];
  else if (row.authorAffinity === null) person = ["No prior usage on the byline"];
  else if (kinds.has("affinity")) {
    const who = repeatUser(row, paperCounts, clientCwids);
    person = [who ? displayName(who.scholar.name) : "Unnamed author"];
  }
  return {
    signal,
    llm: [llm],
    mstr: [tier],
    method,
    person,
    year: [row.year === null ? "No year" : String(row.year)],
  };
}

/** OR within a group, AND across groups (the mockup's semantics). A row with no
 *  value in a ticked group does not match it. The empty selection matches
 *  everything. Pure. */
export function matchesFacets(
  values: Readonly<Record<FacetKey, readonly string[]>>,
  selection: FacetSelection,
): boolean {
  for (const { key } of FACET_GROUPS) {
    const ticked = selection[key];
    if (!ticked || ticked.length === 0) continue;
    if (!values[key].some((v) => ticked.includes(v))) return false;
  }
  return true;
}

/** One rail evidence group: every candidate whose fired kinds share a key, and
 *  how many of them are still undecided. */
export interface EvidenceGroup {
  key: string;
  rows: CoreQueueRow[];
  open: number;
}

/**
 * The rail's "By evidence" list, straight off `evidenceGroupKey` — the same key
 * the card's own signals produce, so a group can never name a pile its papers
 * do not show. Membership is over ALL candidates (a paper decided this session
 * stays in its group, held for its Undo); `open` counts the undecided ones.
 * Groups keep first-appearance order over `candidates`, which the loader ranks
 * by likelihood, so the group holding the surest paper leads. Pure.
 */
export function buildEvidenceGroups(
  candidates: readonly CoreQueueRow[],
  decided: ReadonlyMap<string, unknown>,
  paperCounts: Readonly<Record<string, CoreClientPaperCount>> = {},
  clientCwids: ReadonlySet<string> = new Set(),
): EvidenceGroup[] {
  const byKey = new Map<string, EvidenceGroup>();
  for (const r of candidates) {
    const key = evidenceGroupKey(r, paperCounts, clientCwids);
    let g = byKey.get(key);
    if (!g) {
      g = { key, rows: [], open: 0 };
      byKey.set(key, g);
    }
    g.rows.push(r);
    if (!decided.has(r.pmid)) g.open += 1;
  }
  // "Added by you" leads (mockup): it is the reviewer's own pile, and its rows
  // sit at the end of `candidates` (likelihood 0), which would bury it last.
  const groups = [...byKey.values()];
  const added = groups.findIndex((g) => g.key === ADDED_GROUP);
  if (added > 0) groups.unshift(...groups.splice(added, 1));
  return groups;
}

/** "Acknowledgment + staff co-author" — the group vocabulary as a rail label
 *  (sentence case; `evidenceGroupLabel` is the lowercase inline form). Pure. */
export function evidenceGroupName(key: string): string {
  const s = key
    .split("+")
    .map((k) => GROUP_NAMES[k] ?? k)
    .join(" + ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "Strong band" for one paper or a single-band pile, "Slight to Strong" for a
 *  spread — band words only, never a likelihood range. Pure. */
export function groupBandText(likelihoods: readonly number[]): string {
  if (likelihoods.length === 0) return "";
  const range =
    likelihoods.length === 1 ? likelihoodBand(likelihoods[0]).label : bandRange(likelihoods);
  return range.includes(" to ") ? range : `${range} band`;
}

/** The To review summary strip's left two panels, as numbers. */
export interface OpenSummary {
  /** Open (undecided) candidates among the rows passed in. */
  total: number;
  /** Of those, how many carry two or more counted signals. */
  multiSignal: number;
  /** Open candidates per evidence group, `buildEvidenceGroups` order, empty
   *  groups dropped. */
  groups: { key: string; count: number }[];
  /** Open candidates on which each counted signal fired. */
  signals: Record<SignalKind, number>;
}

/**
 * "Open candidates by evidence" and "Which signals fired" (mockup), off the
 * same `buildEvidenceGroups` / `buildSignals` the rail and the card use, so the
 * strip can never count a pile or a signal the list does not show. The caller
 * passes the rows AFTER the display floor (`applyDisplayFloor`): a candidate the
 * list hides is not an open candidate as far as this strip is concerned (owner,
 * decision 7). Decided rows are skipped — they are on screen only for their
 * Undo. Pure.
 */
export function summarizeOpen(
  rows: readonly CoreQueueRow[],
  decided: ReadonlyMap<string, unknown>,
  paperCounts: Readonly<Record<string, CoreClientPaperCount>> = {},
  clientCwids: ReadonlySet<string> = new Set(),
): OpenSummary {
  const signals: Record<SignalKind, number> = { ack: 0, coauthor: 0, llm: 0, affinity: 0 };
  let total = 0;
  let multiSignal = 0;
  for (const r of rows) {
    if (decided.has(r.pmid)) continue;
    total++;
    const fired = buildSignals(r, paperCounts, clientCwids);
    if (fired.length >= 2) multiSignal++;
    for (const s of fired) signals[s.kind]++;
  }
  const groups = buildEvidenceGroups(rows, decided, paperCounts, clientCwids)
    .filter((g) => g.open > 0)
    .map((g) => ({ key: g.key, count: g.open }));
  return { total, multiSignal, groups, signals };
}

/**
 * This session's reject reasons, counted — only for papers still rejected (an
 * undone rejection takes its reason with it). Most-used first, then by label.
 * The tally is the reviewer's own record: the claim route stores the note on
 * the claim row and its audit row, and nothing sends it to the engine. Pure.
 */
export function reasonTally(
  notes: ReadonlyMap<string, string>,
  decided: ReadonlyMap<string, unknown>,
): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const [pmid, note] of notes) {
    if (decided.get(pmid) !== "rejected") continue;
    counts.set(note, (counts.get(note) ?? 0) + 1);
  }
  return [...counts]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/**
 * The "This session" card's footnote. Says only what the engine actually
 * reads: the writeback mirrors a decision's status and nothing else
 * (lib/cores/claim-writeback.ts), and the next run's only use of it is the
 * repeat-user prior, built from confirmed papers. A reject reason never leaves
 * SPS. No "trains the next run" — it does not. Pure.
 */
export function sessionNote(decidedCount: number, left: number): string {
  if (decidedCount === 0)
    return "Nothing decided yet. Reject reasons are tallied here for your own record; the engine never reads them.";
  return `${plural(left, "candidate")} left to review. Confirmed papers feed the repeat-user prior on the engine’s next run; reject reasons stay with the decision and are not sent to the engine.`;
}

/** One rail person: a WCM byline author this core already holds confirmed work
 *  from, and the candidates they are on. */
export interface RailPerson {
  scholar: QueueScholar;
  counts: CoreClientPaperCount;
  rows: CoreQueueRow[];
  open: number;
}

/**
 * The rail's "By person" list: every WCM byline author of a candidate who has a
 * confirmed paper with this core (`paperCounts`, server-computed and uncapped —
 * the same numbers the repeat-user row prints). One entry per person, keyed on
 * the lowercased CWID, and each candidate listed ONCE under each person on its
 * byline (the mockup's sample data showed one paper twice under one person;
 * that is not the behaviour). Ordered by open candidates, then confirmed
 * papers, then name. Pure.
 */
export function buildRailPeople(
  candidates: readonly CoreQueueRow[],
  decided: ReadonlyMap<string, unknown>,
  paperCounts: Readonly<Record<string, CoreClientPaperCount>>,
): RailPerson[] {
  const byCwid = new Map<string, RailPerson>();
  for (const r of candidates) {
    const seen = new Set<string>();
    for (const a of r.wcmAuthors) {
      const cwid = a.cwid.toLowerCase();
      if (seen.has(cwid)) continue;
      seen.add(cwid);
      const counts = paperCounts[cwid];
      if (!counts || counts.papers <= 0) continue;
      let p = byCwid.get(cwid);
      if (!p) {
        p = { scholar: a, counts, rows: [], open: 0 };
        byCwid.set(cwid, p);
      }
      p.rows.push(r);
      if (!decided.has(r.pmid)) p.open += 1;
    }
  }
  return [...byCwid.values()].sort(
    (a, b) =>
      b.open - a.open ||
      b.counts.papers - a.counts.papers ||
      displayName(a.scholar.name).localeCompare(displayName(b.scholar.name)),
  );
}

interface CoreClaimQueueProps {
  core: CoreReviewQueue["core"];
  candidates: CoreQueueRow[];
  confirmed: CoreQueueRow[];
  /** Previously-rejected pairs (server-loaded) for the Rejected tab. Optional so
   *  the simple all-candidates render stays a single prop set. */
  rejected?: CoreQueueRow[];
  /** The core's current active "Known clients" list (ReciterAI #383 / SPS
   *  #2607). Optional so the simple all-candidates render stays a single prop
   *  set; defaults to empty so the panel still renders (with nothing listed)
   *  when a caller doesn't pass it. */
  clients?: CoreClientRow[];
  /** Papers this core already holds from each known client, keyed by LOWERCASED
   *  cwid — server-computed by `loadCoreClientPaperCounts`. NOT derivable here:
   *  `row.wcmAuthors` is capped at 12 per paper, so folding it would undercount
   *  a client buried in a long byline and print the short number as a fact. */
  paperCounts?: Readonly<Record<string, CoreClientPaperCount>>;
  /** The page's title block (eyebrow, h1, description). v2 puts the header
   *  buttons beside the title (mockup), and the buttons' dialogs are state this
   *  component owns, so the page hands its title in rather than the buttons out. */
  header?: ReactNode;
}

/** The rail's catch-all scope. Real queues split into up to sixteen evidence
 *  combinations, so the list opens on everything rather than on one pile. */
const ALL_SCOPE = "all";

/** One decision batch, for "Undo last": a single paper, or a whole bulk action. */
interface HistoryEntry {
  pmids: string[];
}

/**
 * Which row the pane shows, as an index into `visible` (-1 when nothing is
 * shown). A null `focusPmid` means the first row; a listed one is that row. A
 * pmid that has LEFT the list (decided this session: a decided row no longer
 * shows on To review) falls to whatever now sits at its old position,
 * `lastIndex`: the next row down, or the new last row when it was at the bottom
 * (mockup auto-advance). Bulk decisions and in-flight renders resolve the same
 * way, so no handler has to work out the next row after its await. Pure.
 */
export function resolveFocusIndex(
  visible: readonly { pmid: string }[],
  focusPmid: string | null,
  lastIndex: number,
): number {
  if (visible.length === 0) return -1;
  if (focusPmid === null) return 0;
  const at = visible.findIndex((r) => r.pmid === focusPmid);
  if (at >= 0) return at;
  return Math.min(Math.max(lastIndex, 0), visible.length - 1);
}

/** The undo toast's line after a decision (mockup): "Rejected · Method match
 *  only" for one paper, "Confirmed 12 papers" for a bulk batch. Pure. */
export function decisionToastText(status: Decision, count: number, note?: string): string {
  const word = status === "claimed" ? "Confirmed" : "Rejected";
  if (count > 1) return `${word} ${count} papers`;
  return note ? `${word} · ${note}` : word;
}

/**
 * What the To review list says when it shows no rows. Decided rows leave the
 * list, so an empty list with nothing narrowing it and rows in scope means the
 * reviewer decided every one of them this session -- not a filter miss. Pure.
 */
export function emptyListText(s: {
  noPerson: boolean;
  allDecided: boolean;
  hiddenBelowFloor: number;
  narrowed: boolean;
}): string {
  if (s.noPerson) return "No one to review by yet.";
  if (s.narrowed) return "Nothing matches this filter.";
  if (s.hiddenBelowFloor > 0) {
    return s.allDecided
      ? "All reviewed. Only lower-confidence candidates are left. Show them above."
      : "Only lower-confidence candidates are left. Show them above.";
  }
  return s.allDecided ? "All reviewed. Undo last brings one back." : "Nothing matches this filter.";
}

/** How long the undo toast stays up (mockup). `u` and "Undo last" outlast it. */
const TOAST_MS = 5000;

/** Server-side batch cap on the bulk route (`MAX_BULK_PMIDS`). "Reject all N"
 *  can exceed it on a big core, so bulk actions post in chunks of this size. */
const BULK_CHUNK = 500;

/** Split a bulk batch into route-sized requests, order kept. Pure. */
export function chunkPmids(pmids: readonly string[], size: number = BULK_CHUNK): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < pmids.length; i += size) out.push(pmids.slice(i, i + size));
  return out;
}

/**
 * A paste into the single-line search box, with its line breaks made spaces.
 * An `<input>` strips newlines from its value, so a column of PMIDs copied from
 * a spreadsheet would otherwise land as ONE run of digits ("111\n222" ->
 * "111222") and match nothing. Returns null when the paste has no line break
 * (the browser's own paste is then fine). Pure.
 */
export function pasteAsOneLine(text: string): string | null {
  return /[\r\n]/.test(text) ? text.replace(/\s+/g, " ").trim() : null;
}

/**
 * What a Revoke on the Confirmed tab posts for one row. The soft `revoked` undo
 * only helps when a human claim is what confirms the paper; it reverts the pair
 * to its engine status. So:
 *   - no active claim (`claimed` false) — the ENGINE confirmed it, there is no
 *     claim to revoke, and only a `rejected` override takes it off;
 *   - a claim on top of an engine `confirmed` row — revoking the claim would
 *     leave the engine's own confirmation standing (the row would re-file under
 *     Confirmed on the next load), so this too needs `rejected`;
 *   - anything else (a claimed engine candidate, a manual add, a paper sent to
 *     review) — the soft `revoked`, which the single Undo can reverse exactly.
 * A manual row's `status` is the loader's "confirmed" placeholder, not an
 * engine verdict, hence the `isManual` exclusion. Pure.
 */
export function revokeStatusFor(row: CoreQueueRow): "revoked" | "rejected" {
  if (!row.claimed) return "rejected";
  return row.status === "confirmed" && !row.isManual ? "rejected" : "revoked";
}

/** Where a Confirmed/Rejected row lands after a Revoke/Restore. */
export type UndoDestination = "review" | "confirmed" | "rejected" | "gone";

/**
 * Where one row goes when revoked (Confirmed tab) or restored (Rejected tab),
 * for the bulk guard's copy — "They return to review" is only true of some rows,
 * and a guard that says so of all of them is the thing it exists to prevent:
 *   - a Revoke that has to post `rejected` (see `revokeStatusFor`) moves the
 *     paper to Rejected;
 *   - otherwise the claim is soft-revoked and the pair falls back to its engine
 *     status: an engine `confirmed` row (only reachable on Restore) goes back to
 *     Confirmed; an engine candidate, or a pmid sent to review by hand
 *     (`queued`), returns to review; anything else (a manual add nobody queued,
 *     a below-threshold row) leaves the queue altogether. Pure.
 */
export function undoDestination(row: CoreQueueRow, tab: "confirmed" | "rejected"): UndoDestination {
  if (tab === "confirmed" && revokeStatusFor(row) === "rejected") return "rejected";
  if (row.status === "confirmed" && !row.isManual) return "confirmed";
  if (row.queued || row.status === "candidate") return "review";
  return "gone";
}

/**
 * The inline guard's sentence in front of a bulk Revoke/Restore (grant-signal
 * design delta B.2): "Revoke 12 confirmed papers? They return to review. Each
 * gets its own audit row." When some rows land elsewhere (see
 * `undoDestination`) the middle sentence names the split instead. Pure.
 */
export function historyGuardText(
  tab: "confirmed" | "rejected",
  rows: readonly CoreQueueRow[],
): string {
  const verb = tab === "confirmed" ? "Revoke" : "Restore";
  const n = rows.length;
  const head = `${verb} ${n} ${tab} ${n === 1 ? "paper" : "papers"}?`;
  const counts = new Map<UndoDestination, number>();
  for (const r of rows) {
    const d = undoDestination(r, tab);
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  let middle: string;
  if ((counts.get("review") ?? 0) === n) {
    middle = n === 1 ? "It returns to review." : "They return to review.";
  } else {
    const parts: string[] = [];
    const review = counts.get("review") ?? 0;
    const confirmed = counts.get("confirmed") ?? 0;
    const rejected = counts.get("rejected") ?? 0;
    const gone = counts.get("gone") ?? 0;
    if (review) parts.push(`${review} ${review === 1 ? "returns" : "return"} to review`);
    if (rejected)
      parts.push(
        `${rejected} ${rejected === 1 ? "moves" : "move"} to Rejected (the engine confirmed ${rejected === 1 ? "it" : "them"} on its own)`,
      );
    if (confirmed)
      parts.push(
        `${confirmed} ${confirmed === 1 ? "goes" : "go"} back to Confirmed (the engine confirmed ${confirmed === 1 ? "it" : "them"} on its own)`,
      );
    if (gone) parts.push(`${gone} ${gone === 1 ? "leaves" : "leave"} the queue`);
    middle = `${parts.join(", ")}.`;
    middle = middle.charAt(0).toUpperCase() + middle.slice(1);
  }
  return `${head} ${middle} Each gets its own audit row.`;
}

/** "2,140 hidden: repeat-user evidence only or a weak method match · Show" —
 *  the display floor's one quiet line in the list header; Show/Hide toggles the
 *  below-floor rows in and out. Falls back to "N lower-confidence candidates
 *  hidden (likelihood below 40%)" when a below-floor row carries other evidence
 *  (`weakOnly` false), so the line never describes evidence a row lacks. */
function FloorLine({
  count,
  showing,
  weakOnly,
  onToggle,
}: {
  count: number;
  showing: boolean;
  weakOnly: boolean;
  onToggle: () => void;
}) {
  const n = count.toLocaleString("en-US");
  const state = showing ? "shown" : "hidden";
  return (
    <p data-slot="core-queue-floor" className="text-muted-foreground mt-0.5 text-xs">
      {weakOnly
        ? `${n} ${state}: repeat-user evidence only or a weak method match · `
        : `${n} lower-confidence ${count === 1 ? "candidate" : "candidates"} ${state} (likelihood below ${CANDIDATE_DISPLAY_FLOOR_PCT}%) · `}
      <button
        type="button"
        aria-pressed={showing}
        onClick={onToggle}
        className="text-apollo-slate hover:underline"
      >
        {showing ? "Hide" : "Show"}
      </button>
    </p>
  );
}

export function CoreClaimQueue({
  core,
  candidates,
  confirmed,
  rejected = [],
  clients = [],
  paperCounts = {},
  header,
}: CoreClaimQueueProps) {
  const [decided, setDecided] = useState<Map<string, Decision>>(new Map());
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  // Reject reasons given this session, shown beside the decision ("Rejected ·
  // Method match only"). The server keeps the note; this is only the echo.
  const [notes, setNotes] = useState<ReadonlyMap<string, string>>(() => new Map());
  // Confirmed rows walked back this session — kept visible with an undo.
  const [revokedConfirmed, setRevokedConfirmed] = useState<Set<string>>(new Set());
  // Rejected rows restored this session — kept visible with an undo (mirror of above).
  const [restoredRejected, setRestoredRejected] = useState<Set<string>>(new Set());
  // Confirmed/Rejected tabs: the ticked rows, the inline guard in front of the
  // bulk Revoke/Restore (decision 2 — the same guard as "Reject all N…"), and
  // whether that bulk post is in flight.
  const [histSelected, setHistSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [histArmed, setHistArmed] = useState(false);
  const [histPending, setHistPending] = useState(false);
  // The active tab. Tabs only render when there's history (confirmed/rejected);
  // land on the first non-empty list so a reviewer with no open work sees content.
  const [view, setView] = useState<QueueView>(() =>
    candidates.length > 0
      ? "review"
      : confirmed.length > 0
        ? "confirmed"
        : rejected.length > 0
          ? "rejected"
          : "review",
  );
  // The rail: which pile the list shows. "By evidence" opens on every candidate;
  // "By person" on the first person (see `buildRailPeople` for the order).
  const [mode, setMode] = useState<RailMode>("evidence");
  const [groupKey, setGroupKey] = useState<string>(ALL_SCOPE);
  const [personCwid, setPersonCwid] = useState<string | null>(null);
  // Ticked facet values (Filters panel), OR within a group and AND across.
  const [facets, setFacets] = useState<FacetSelection>({});
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Free text, or several PMIDs (see `parsePmidQuery`). AND-ed with the facets.
  const [query, setQuery] = useState("");
  // Below-floor engine candidates (see `applyDisplayFloor`) are hidden until
  // the reviewer asks for them. Session state only, like the facets.
  const [showLow, setShowLow] = useState(false);
  // Engine likelihood, high→low — the loader's own order, so the list opens on
  // what the engine is surest of (owner's choice; "Uncertain first" is a pill).
  const [sort, setSort] = useState<SortKey>("likelihood");
  // The paper in the right-hand pane. Null means "the first one shown"; a
  // decided paper's pmid holds its old place (see `resolveFocusIndex`).
  const [focusPmid, setFocusPmid] = useState<string | null>(null);
  const lastFocusIndex = useRef(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  // Which bulk decision is in flight, if any — a double-click on "Confirm 2"
  // must not post the same batch twice.
  const [bulkPending, setBulkPending] = useState<Decision | null>(null);
  // The inline guard in front of every bulk REJECT (never a bulk confirm — a
  // wrong confirm shows up on the public core page where someone will notice
  // it; a wrong reject just silently leaves the papers missing). "all" is the
  // mockup's "Reject all N…"; "selected" keeps the guard the selection's own
  // Reject has always had.
  const [armed, setArmed] = useState<"all" | "selected" | null>(null);
  // This session's decision batches, newest last, for "Undo last" / `u`.
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [keysOpen, setKeysOpen] = useState(false);
  // Below `lg` the focused paper is a full-screen sheet, opened by tapping a row.
  const [sheetOpen, setSheetOpen] = useState(false);
  const [copiedPmid, setCopiedPmid] = useState<string | null>(null);
  // Polite SR announcement of the last outcome — the success path is otherwise
  // silent (the pane swaps in place with no focus move), mirroring coi-gap-card.
  const [announce, setAnnounce] = useState("");
  // The undo toast (mockup): the last decision and its Undo, for TOAST_MS. It
  // is visual only; the announcement above already speaks the outcome.
  const [toast, setToast] = useState<{ text: string; tone: Decision | "error" } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = (next: { text: string; tone: Decision | "error" } | null) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = next ? setTimeout(() => setToast(null), TOAST_MS) : null;
    setToast(next);
  };
  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );
  // Manual PMID add: paste a block of known PMIDs and claim them directly,
  // independent of the engine queue (POST /api/edit/core-claim/bulk), or send
  // them to review (POST /api/edit/core-queue-add).
  const [addOpen, setAddOpen] = useState(false);
  // "Confirm now" (claim directly) or "Send to review" (queue for later, a
  // `core_queue_add` row via POST /api/edit/core-queue-add).
  const [addMode, setAddMode] = useState<AddMode>("claim");
  // Mirror of `addMode` for an in-flight check, like `addTextRef` below: a check
  // that lands after the mode changed describes the other mode's commit.
  const addModeRef = useRef<AddMode>("claim");
  const setAddModeTracked = (next: AddMode) => {
    addModeRef.current = next;
    setAddMode(next);
  };
  const [addText, setAddText] = useState("");
  // Mirror of `addText` readable from inside an in-flight async handler, where
  // the captured state value is whatever it was when the handler started.
  const addTextRef = useRef("");
  const setAddTextTracked = (next: string) => {
    addTextRef.current = next;
    setAddText(next);
  };
  const [addPending, setAddPending] = useState(false);
  const [addResult, setAddResult] = useState<string | null>(null);
  // The dry-run outcome. `null` until "Check PMIDs" has run — "Claim
  // publications" stays disabled until then, so nothing is written that the
  // reviewer has not been shown first.
  const [addCheck, setAddCheck] = useState<PmidCheck | null>(null);
  const [addChecking, setAddChecking] = useState(false);
  // "Known clients" (ReciterAI #383 / SPS #2607) — the modal's OPEN/CLOSED
  // state lives here, the same controlled-child pattern as Add PMIDs above.
  //
  // The LIST does not. It is read straight off the `clients` prop, exactly as
  // candidates/confirmed/rejected are: every write in the dialog ends in
  // `router.refresh()`, which hands this component a NEW prop without clearing
  // its state, so a cached copy would discard the refreshed roster on arrival
  // and let `clientCwids` drift from the server-computed `paperCounts`.
  const [clientsOpen, setClientsOpen] = useState(false);
  const router = useRouter();
  const listRef = useRef<HTMLUListElement | null>(null);

  // Name-only clients carry no cwid, so they never join this set — they cannot
  // flag a byline, which is exactly what the modal tells the owner up front.
  const clientCwids: ReadonlySet<string> = new Set(
    clients.flatMap((c) => (c.cwid ? [c.cwid.toLowerCase()] : [])),
  );

  const markPending = (pmid: string) => setPending((s) => new Set(s).add(pmid));
  const clearPending = (pmid: string) =>
    setPending((s) => {
      const next = new Set(s);
      next.delete(pmid);
      return next;
    });
  const setError = (pmid: string, msg: string) => setErrors((m) => new Map(m).set(pmid, msg));
  const clearError = (pmid: string) =>
    setErrors((m) => {
      const next = new Map(m);
      next.delete(pmid);
      return next;
    });

  // Low-level POST to the claim endpoint; returns ok/error, touches no state.
  // `note` rides along only when given — the route stores it (<= 2,000 chars)
  // on the claim row and in its audit row.
  async function postClaim(
    pmid: string,
    status: Decision | "revoked",
    note?: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const res = await fetch("/api/edit/core-claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        note ? { pmid, coreId: core.id, status, note } : { pmid, coreId: core.id, status },
      ),
    });
    if (!res.ok) {
      const data: unknown = await res.json().catch(() => ({}));
      const error =
        data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string"
          ? (data as { error: string }).error
          : `HTTP ${res.status}`;
      return { ok: false, error };
    }
    return { ok: true };
  }

  // Decide a candidate (claimed/rejected) or revoke that decision, reflected
  // locally. Resolves true when the server accepted it.
  async function send(pmid: string, status: Decision | "revoked", note?: string) {
    clearError(pmid);
    markPending(pmid);
    const result = await postClaim(pmid, status, note);
    if (result.ok) {
      setDecided((m) => {
        const next = new Map(m);
        if (status === "revoked") next.delete(pmid);
        else next.set(pmid, status);
        return next;
      });
      setNotes((m) => {
        const next = new Map(m);
        if (status === "rejected" && note) next.set(pmid, note);
        else next.delete(pmid);
        return next;
      });
      const title = candidates.find((c) => c.pmid === pmid)?.title ?? "this publication";
      setAnnounce(
        status === "revoked"
          ? "Undone."
          : `${status === "claimed" ? "Confirmed" : "Rejected"} ${title}.`,
      );
    } else {
      setError(pmid, result.error);
    }
    clearPending(pmid);
    return result.ok;
  }

  /** Decide one paper from the pane, the keys, or a reason chip. On success it
   *  joins the session history, leaves the To review list, and raises the undo
   *  toast; when it was the focused paper the pane moves on to the next one
   *  (`resolveFocusIndex`), so a reviewer can work down a pile with `a`/`r`. */
  async function decide(pmid: string, status: Decision, note?: string) {
    if (pending.has(pmid) || decided.has(pmid)) return;
    const ok = await send(pmid, status, note);
    if (!ok) return;
    setHistory((h) => [...h, { pmids: [pmid] }]);
    showToast({ text: decisionToastText(status, 1, note), tone: status });
  }

  const [undoing, setUndoing] = useState(false);
  /**
   * "Undo last" / `u`: walk back the newest batch. A single decision is one
   * revoke; a bulk batch is revoked one paper at a time on the single-claim route
   * (the bulk route deliberately takes no `revoked`), sequentially so a big batch
   * never fans out into hundreds of parallel requests. Anything that fails stays
   * decided and goes back on the stack; a decided row is off the list, so the
   * failure is told in the toast, whose Undo then retries.
   */
  async function undoLast() {
    const last = history[history.length - 1];
    if (!last || undoing) return;
    setUndoing(true);
    showToast(null);
    setHistory((h) => h.slice(0, -1));
    const failed: string[] = [];
    for (const p of last.pmids) {
      if (!decided.has(p)) continue;
      if (!(await send(p, "revoked"))) failed.push(p);
    }
    if (failed.length) {
      setHistory((h) => [...h, { pmids: failed }]);
      setAnnounce("Undo could not be saved.");
      showToast({ text: "Undo could not be saved", tone: "error" });
    }
    setFocusPmid(last.pmids[0]);
    setUndoing(false);
  }

  /**
   * Decide EVERY hand-selected (or, behind the guard, every shown) row through
   * the bulk endpoint: the upsert + audit + writeback loop runs in one server
   * transaction per request, each paper still getting its own audit row. Chunked
   * at the route's cap; a failed chunk marks its own papers and stops, so
   * nothing past it is posted on a guess.
   */
  async function bulkDecide(pmids: string[], status: Decision) {
    if (pmids.length === 0 || bulkPending !== null) return;
    setArmed(null);
    setBulkPending(status);
    setPending((s) => new Set([...s, ...pmids]));
    const done: string[] = [];
    for (const chunk of chunkPmids(pmids)) {
      const res = await fetch("/api/edit/core-claim/bulk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ coreId: core.id, pmids: chunk, status }),
      }).catch(() => null);
      if (res?.ok !== true) break;
      done.push(...chunk);
    }
    const verb = status === "claimed" ? "Confirmed" : "Rejected";
    const failed = pmids.slice(done.length);
    if (done.length > 0) {
      setDecided((m) => {
        const next = new Map(m);
        for (const p of done) next.set(p, status);
        return next;
      });
      setHistory((h) => [...h, { pmids: done }]);
      showToast({ text: decisionToastText(status, done.length), tone: status });
    }
    if (failed.length === 0) setSelected(new Set());
    else
      setErrors((m) => {
        const next = new Map(m);
        for (const p of failed)
          next.set(p, `bulk ${status === "claimed" ? "confirm" : "reject"} failed`);
        return next;
      });
    setPending((s) => {
      const next = new Set(s);
      for (const p of pmids) next.delete(p);
      return next;
    });
    setBulkPending(null);
    setAnnounce(
      failed.length === 0
        ? `${verb} ${pmids.length} publication${pmids.length === 1 ? "" : "s"}.`
        : `Bulk ${status === "claimed" ? "confirm" : "reject"} could not be saved.`,
    );
  }

  /** "Check PMIDs" — a `dryRun` bulk claim. Same route, same authorization, same
   *  reads; it just stops before the transaction, so what it reports is what a
   *  claim would actually do rather than a client-side guess. */
  async function checkAddPmids() {
    const { pmids, invalid } = parsePmidBlock(addText);
    if (pmids.length === 0) {
      setAddCheck(null);
      setAddResult(
        invalid.length > 0
          ? `No valid PMIDs found (ignored: ${invalid.join(", ")}).`
          : "Paste at least one PMID.",
      );
      return;
    }
    if (pmids.length > MAX_CLAIM_PMIDS) {
      setAddCheck(null);
      setAddResult(`Up to ${MAX_CLAIM_PMIDS} at a time — that paste has ${pmids.length}.`);
      return;
    }
    // The exact text this check describes. A reviewer can edit the textarea
    // while the request is in flight; when it lands we compare against what is
    // in the box NOW and drop the result if it has moved on. Without this the
    // late response re-armed "Claim publications" for a paste that was never
    // checked, and the claim then posted the NEW text.
    const checkedText = addText;
    const checkedMode = addMode;
    const stale = () => checkedText !== addTextRef.current || checkedMode !== addModeRef.current;
    setAddChecking(true);
    setAddResult(null);
    // Send to review is checked by its own route, on the same terms as the claim
    // dry run (shape, cap, authorization, the `publication` existence probe).
    const res = await fetch(
      checkedMode === "review" ? "/api/edit/core-queue-add" : "/api/edit/core-claim/bulk",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          checkedMode === "review"
            ? { coreId: core.id, pmids, dryRun: true }
            : { coreId: core.id, pmids, status: "claimed", dryRun: true },
        ),
      },
    ).catch(() => null);
    if (stale()) return; // stale — the paste or the mode changed
    setAddChecking(false);
    if (!res?.ok) {
      setAddResult("Could not check these — try again.");
      return;
    }
    const data = (await res.json().catch(() => ({}))) as {
      wouldWrite?: number;
      wouldAdd?: number;
      skipped?: number;
      inQueue?: number;
      decided?: number;
      notFound?: string[];
    };
    if (stale()) return; // stale — the paste or the mode changed
    setAddCheck(
      checkedMode === "review"
        ? {
            wouldWrite: data.wouldAdd ?? 0,
            skipped: data.inQueue ?? 0,
            decided: data.decided ?? 0,
            notFound: data.notFound ?? [],
            invalid,
          }
        : {
            wouldWrite: data.wouldWrite ?? 0,
            skipped: data.skipped ?? 0,
            notFound: data.notFound ?? [],
            invalid,
          },
    );
    setAddResult(null);
  }

  // Send a pasted block to review: one `core_queue_add` row per new PMID, so
  // each joins To review under "Added by you" (unscored) until someone decides
  // it. Refresh (not local state) so the page re-fetches them as real rows, and
  // land the reviewer on that pile.
  async function submitSendToReview() {
    const { pmids, invalid } = parsePmidBlock(addText);
    if (pmids.length === 0) return;
    setAddPending(true);
    setAddResult(null);
    const res = await fetch("/api/edit/core-queue-add", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ coreId: core.id, pmids }),
    }).catch(() => null);
    setAddPending(false);
    if (!res?.ok) {
      setAddResult("Could not save — try again.");
      return;
    }
    const data = (await res.json().catch(() => ({}))) as {
      added?: number;
      inQueue?: number;
      decided?: number;
      notFound?: string[];
    };
    const parts = [`Added ${data.added ?? 0} to review.`];
    if (data.inQueue) parts.push(`Already in the queue: ${data.inQueue}.`);
    if (data.decided) parts.push(`Already decided: ${data.decided}.`);
    if (data.notFound?.length) parts.push(`Not found in SPS: ${data.notFound.join(", ")}.`);
    if (invalid.length > 0) parts.push(`Ignored: ${invalid.join(", ")}.`);
    setAddResult(parts.join(" "));
    setAnnounce(parts.join(" "));
    setAddTextTracked("");
    setAddCheck(null);
    if ((data.added ?? 0) > 0) {
      setView("review");
      setMode("evidence");
      setGroupKey(ADDED_GROUP);
      resetForScope();
      router.refresh();
    }
  }

  // Claim a pasted block of known PMIDs directly — the queue's own candidates
  // list plays no part; a pmid the engine never scored (or never will) is
  // claimed anyway, and the server-side existence check catches anything SPS
  // hasn't ingested. Refresh (not local state) so the page re-fetches the newly
  // manual-confirmed rows with their real title/journal/etc.
  async function submitAddPmids() {
    const { pmids, invalid } = parsePmidBlock(addText);
    if (pmids.length === 0) {
      setAddResult(
        invalid.length > 0
          ? `No valid PMIDs found (ignored: ${invalid.join(", ")}).`
          : "Paste at least one PMID.",
      );
      return;
    }
    setAddPending(true);
    setAddResult(null);
    const res = await fetch("/api/edit/core-claim/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ coreId: core.id, pmids, status: "claimed" }),
    }).catch(() => null);
    setAddPending(false);
    if (!res?.ok) {
      setAddResult("Could not save — try again.");
      return;
    }
    const data = (await res.json().catch(() => ({}))) as {
      written?: number;
      skipped?: number;
      notFound?: string[];
    };
    const parts = [`Claimed ${data.written ?? 0}.`];
    if (data.skipped) parts.push(`Already claimed: ${data.skipped}.`);
    if (data.notFound?.length) parts.push(`Not found in SPS: ${data.notFound.join(", ")}.`);
    if (invalid.length > 0) parts.push(`Ignored: ${invalid.join(", ")}.`);
    setAddResult(parts.join(" "));
    setAnnounce(parts.join(" "));
    setAddTextTracked("");
    setAddCheck(null);
    if ((data.written ?? 0) > 0) router.refresh();
  }

  // Walk back a confirmed row: a human claim soft-revokes ("revoked"); an engine
  // confirmation needs a "rejected" override instead (see `revokeStatusFor`).
  async function revokeConfirmed(row: CoreQueueRow) {
    const { pmid, title } = row;
    clearError(pmid);
    markPending(pmid);
    const result = await postClaim(pmid, revokeStatusFor(row));
    if (result.ok) {
      setRevokedConfirmed((s) => new Set(s).add(pmid));
      setAnnounce(`Revoked ${title}.`);
    } else {
      setError(pmid, result.error);
    }
    clearPending(pmid);
  }

  async function undoRevokeConfirmed(pmid: string, wasClaimed: boolean) {
    clearError(pmid);
    markPending(pmid);
    const result = await postClaim(pmid, wasClaimed ? "claimed" : "revoked");
    if (result.ok) {
      setRevokedConfirmed((s) => {
        const next = new Set(s);
        next.delete(pmid);
        return next;
      });
      setAnnounce("Undone.");
    } else {
      setError(pmid, result.error);
    }
    clearPending(pmid);
  }

  // Restore a rejected row: a rejected pair always has a human 'rejected' claim
  // (the engine has no rejected state), so the soft 'revoked' undo clears it on
  // the server, reverting the pair to its engine status. Like the Confirmed-tab
  // Revoke, the row stays here as a "Restored — …/Undo" line for the session; it
  // re-files into the right list (To review / Confirmed) on the next page load.
  async function restoreRejected(pmid: string, title: string) {
    clearError(pmid);
    markPending(pmid);
    const result = await postClaim(pmid, "revoked");
    if (result.ok) {
      setRestoredRejected((s) => new Set(s).add(pmid));
      setAnnounce(`Restored ${title}.`);
    } else {
      setError(pmid, result.error);
    }
    clearPending(pmid);
  }

  /**
   * Bulk Revoke (Confirmed tab) / bulk Restore (Rejected tab), after the inline
   * guard. Each row posts what its single Revoke/Restore would (`revokeStatusFor`
   * on Confirmed, the soft `revoked` on Rejected), grouped by that status and
   * chunked at the bulk route's cap; the route writes one audit row per PMID. A
   * failed chunk marks its own rows and stops, as `bulkDecide` does. Each row
   * that went through joins the session's revoked/restored set, so it keeps its
   * own single-row Undo.
   */
  async function bulkHistory(tab: "confirmed" | "rejected", rows: CoreQueueRow[]) {
    if (rows.length === 0 || histPending) return;
    setHistArmed(false);
    setHistPending(true);
    const pmids = rows.map((r) => r.pmid);
    setPending((s) => new Set([...s, ...pmids]));
    for (const p of pmids) clearError(p);
    const byStatus = new Map<"revoked" | "rejected", string[]>();
    for (const r of rows) {
      const status = tab === "confirmed" ? revokeStatusFor(r) : "revoked";
      byStatus.set(status, [...(byStatus.get(status) ?? []), r.pmid]);
    }
    const done: string[] = [];
    let failed = false;
    for (const [status, group] of byStatus) {
      for (const chunk of chunkPmids(group)) {
        const res = await fetch("/api/edit/core-claim/bulk", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ coreId: core.id, pmids: chunk, status }),
        }).catch(() => null);
        if (res?.ok !== true) {
          failed = true;
          break;
        }
        done.push(...chunk);
      }
      if (failed) break;
    }
    const setTouched = tab === "confirmed" ? setRevokedConfirmed : setRestoredRejected;
    if (done.length > 0) setTouched((s) => new Set([...s, ...done]));
    const doneSet = new Set(done);
    const notDone = pmids.filter((p) => !doneSet.has(p));
    const verb = tab === "confirmed" ? "revoke" : "restore";
    if (notDone.length === 0) setHistSelected(new Set());
    else
      setErrors((m) => {
        const next = new Map(m);
        for (const p of notDone) next.set(p, `bulk ${verb} failed`);
        return next;
      });
    setPending((s) => {
      const next = new Set(s);
      for (const p of pmids) next.delete(p);
      return next;
    });
    setHistPending(false);
    setAnnounce(
      notDone.length === 0
        ? `${tab === "confirmed" ? "Revoked" : "Restored"} ${plural(pmids.length, "publication")}.`
        : `Bulk ${verb} could not be saved.`,
    );
  }

  async function undoRestoreRejected(pmid: string) {
    clearError(pmid);
    markPending(pmid);
    const result = await postClaim(pmid, "rejected");
    if (result.ok) {
      setRestoredRejected((s) => {
        const next = new Set(s);
        next.delete(pmid);
        return next;
      });
      setAnnounce("Undone.");
    } else {
      setError(pmid, result.error);
    }
    clearPending(pmid);
  }

  // Download the queue (both lists) as a CSV citation list, reflecting the current
  // session state. Client-side blob — the rows are already in hand, no API needed.
  //
  // CURRENTLY UNCALLED, ON PURPOSE. The header's "Download CSV" button came out
  // when the toolbar was matched to the mockup ([Known clients] [Add PMIDs]
  // [Reporting...]); the export itself is kept whole because the owner expects
  // to restore an entry point once the reporting view exists. Re-wire it rather
  // than re-write it — deleting it means rebuilding the status/citation/DOI
  // column contract from scratch.
  //
  // With no caller it is also UNTESTED (its test asserted through the button,
  // and now asserts the button's absence) and eslint reports it as an unused
  // var. Both are expected while it waits; restore its coverage with its entry
  // point.
  function downloadCsv() {
    const headers = CSV_HEADERS;
    const statusOf = (pmid: string, base: "candidate" | "confirmed" | "rejected"): string => {
      if (base === "confirmed") return revokedConfirmed.has(pmid) ? "Revoked" : "Confirmed";
      if (base === "rejected") return restoredRejected.has(pmid) ? "Restored" : "Rejected";
      const d = decided.get(pmid);
      return d === "claimed" ? "Confirmed" : d === "rejected" ? "Rejected" : "To review";
    };
    const toRow = (r: CoreQueueRow, base: "candidate" | "confirmed" | "rejected") =>
      csvRow(r, statusOf(r.pmid, base));
    const csv = toCsv(headers, [
      ...candidates.map((r) => toRow(r, "candidate")),
      ...confirmed.map((r) => toRow(r, "confirmed")),
      ...rejected.map((r) => toRow(r, "rejected")),
    ]);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `core-${core.id}-publications.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function copyPmid(pmid: string) {
    // jsdom (and any non-secure context) has no clipboard — the label still
    // flips, so the button is never a dead click in tests or on http.
    void navigator.clipboard?.writeText(pmid);
    setCopiedPmid(pmid);
  }

  // ---- derived: rail, scope, facets, the list -----------------------------

  // The display floor: everything below — the rail, the list, the facet counts,
  // "Select all", "Reject all" — works over `reviewRows`, never `candidates`.
  const floor = applyDisplayFloor(candidates, {
    showLow,
    decided: new Set(decided.keys()),
    searched: searchedPmids(query),
  });
  const reviewRows = floor.shown;
  // Remaining review work. A paper decided this session stays in `reviewRows`
  // (its group keeps it as a member) but leaves the list itself (`filterRows`).
  const remaining = reviewRows.filter((c) => !decided.has(c.pmid)).length;
  // ponytail: every derivation below is recomputed per render, no memo. Fine at
  // the queue sizes cores carry today (low thousands); memoize on
  // [candidates, decided, paperCounts, clients] if a core ever gets much bigger.
  const groups = buildEvidenceGroups(reviewRows, decided, paperCounts, clientCwids);
  const people = buildRailPeople(reviewRows, decided, paperCounts);
  const activeGroup = mode === "evidence" ? (groups.find((g) => g.key === groupKey) ?? null) : null;
  const activePerson =
    mode === "person"
      ? (people.find((p) => p.scholar.cwid.toLowerCase() === personCwid) ?? people[0] ?? null)
      : null;
  const scopeRows =
    mode === "person" ? (activePerson?.rows ?? []) : (activeGroup?.rows ?? reviewRows);
  // The Confirmed/Rejected tabs share the search box and the Filters panel
  // (mockup): same facets, same words, over that tab's rows. The selection
  // there is its own (`histSelected`), and a tab switch clears both.
  const onHistory = view !== "review";
  const historyBase = view === "confirmed" ? confirmed : view === "rejected" ? rejected : [];
  const historyTouched = view === "confirmed" ? revokedConfirmed : restoredRejected;
  // A paper decided this session leaves the To review list (mockup); its Undo
  // is the toast, `u`, and the summary strip's "Undo last".
  const scopeOpen = scopeRows.filter((r) => !decided.has(r.pmid));
  const filterRows = onHistory ? historyBase : scopeOpen;
  // A row walked back on a history tab is held on screen for its own Undo.
  const isHeld = (pmid: string) => onHistory && historyTouched.has(pmid);
  const values = new Map(
    filterRows.map(
      (r) =>
        [
          r.pmid,
          // A confirmed row sits inside its own counts (see `withoutOwnPaper`).
          facetValues(
            r,
            view === "confirmed" ? withoutOwnPaper(r, paperCounts) : paperCounts,
            clientCwids,
          ),
        ] as const,
    ),
  );
  // The search narrows the facet COUNTS too (mockup); the facets do not narrow
  // each other's counts, so a tick never makes its own neighbours vanish.
  const searched = filterRows.filter((r) => matchesSearch(r, query));
  // Apply the facets AND the search (but always keep a held row visible so its
  // Undo stays reachable).
  const matched = filterRows.filter(
    (r) =>
      isHeld(r.pmid) || (matchesSearch(r, query) && matchesFacets(values.get(r.pmid)!, facets)),
  );
  // The To review list sorts; the history tabs keep the loader's order.
  const visible = onHistory ? [] : matched.slice().sort((a, b) => compareBySort(sort, a, b));
  const historyShown = onHistory ? matched : [];
  const historyOpen = historyShown.filter((r) => !historyTouched.has(r.pmid));
  const historySelectedRows = historyOpen.filter((r) => histSelected.has(r.pmid));
  const historyAllChecked =
    historyOpen.length > 0 && historySelectedRows.length === historyOpen.length;
  // Counts over the still-open rows only: a held row is on screen for its undo
  // and must not inflate a facet. A value at 0 is not offered at all unless it
  // is already ticked (then it stays, so it can be unticked).
  const facetGroups: FacetGroupView[] = FACET_GROUPS.map(({ key, label }) => {
    const counts = new Map<string, number>();
    for (const r of searched) {
      if (isHeld(r.pmid)) continue;
      for (const v of values.get(r.pmid)![key]) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const ticked = facets[key] ?? [];
    for (const v of ticked) if (!counts.has(v)) counts.set(v, 0);
    const options = [...counts]
      .sort(
        key === "year"
          ? (a, b) => b[0].localeCompare(a[0])
          : (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
      )
      .map(([value, count]) => ({ value, count, selected: ticked.includes(value) }));
    return { key, label, options };
  }).filter((g) => g.options.length > 0);
  const activeChips: ActiveChip[] = FACET_GROUPS.flatMap(({ key, label }) =>
    (facets[key] ?? []).map((value) => ({ group: key, groupLabel: label, value })),
  );
  const narrowed = activeChips.length > 0 || query.trim().length > 0;

  const focusIndex = resolveFocusIndex(visible, focusPmid, lastFocusIndex.current);
  const focused = focusIndex >= 0 ? visible[focusIndex] : null;
  if (focusIndex >= 0) lastFocusIndex.current = focusIndex;

  // The selection only ever acts on rows the reviewer can SEE: a row ticked and
  // then hidden by a facet or the search drops out of the batch. Acting on rows
  // nobody is looking at is what retiring the high-confidence sweep was for.
  const openShown = visible.filter((r) => !decided.has(r.pmid));
  const selectedPmids = openShown.filter((r) => selected.has(r.pmid)).map((r) => r.pmid);
  const allChecked = openShown.length > 0 && selectedPmids.length === openShown.length;

  // Several PMIDs in the box: say what matched here, and where the rest are.
  const pmidQuery = parsePmidQuery(query);
  const confirmedPmids = new Set(confirmed.map((r) => r.pmid));
  const rejectedPmids = new Set(rejected.map((r) => r.pmid));
  const scopePmids = new Set(scopeRows.map((r) => r.pmid));
  const pmidNote = pmidQuery
    ? pmidMatchNote(pmidQuery, new Set(visible.map((r) => r.pmid)), (p) => {
        const d = decided.get(p);
        if (d) return d === "claimed" ? "Confirmed this session" : "Rejected this session";
        if (confirmedPmids.has(p)) return "Confirmed";
        if (rejectedPmids.has(p)) return "Rejected";
        const row = candidates.find((c) => c.pmid === p);
        if (!row) return "not in this core's queue";
        if (scopePmids.has(p)) return "To review · hidden by filters";
        return `To review · ${evidenceGroupName(evidenceGroupKey(row, paperCounts, clientCwids))}`;
      })
    : null;

  const railItems: RailItem[] =
    mode === "evidence"
      ? [
          {
            key: ALL_SCOPE,
            label: "All candidates",
            sub: plural(groups.length, "evidence group"),
            dot: "bg-apollo-slate",
            count: remaining,
          },
          ...groups.map((g) => ({
            key: g.key,
            label: evidenceGroupName(g.key),
            // "Added by you" has no band: the engine did not score these papers
            // onto the queue, so a band word would put its verdict in its mouth.
            sub: g.key === ADDED_GROUP ? ADDED_SUB : groupBandText(g.rows.map((r) => r.likelihood)),
            // The dot reads the same pile as the band words beside it.
            dot:
              g.key === ADDED_GROUP ? "bg-apollo-slate" : bandDot(g.rows.map((r) => r.likelihood)),
            count: g.open,
          })),
        ]
      : people.map((p) => ({
          key: p.scholar.cwid.toLowerCase(),
          label: displayName(p.scholar.name),
          sub: `${p.counts.papers} prior confirmed${p.scholar.dept ? ` · ${p.scholar.dept}` : ""}`,
          // Scored rows only: a paper sent here by PMID carries a placeholder 0
          // likelihood, which would paint every such person Weak.
          dot: bandDot(p.rows.filter((r) => !r.queued).map((r) => r.likelihood)),
          count: p.open,
        }));
  const railKey =
    mode === "evidence"
      ? (activeGroup?.key ?? ALL_SCOPE)
      : (activePerson?.scholar.cwid.toLowerCase() ?? "");
  const scopeTitle =
    mode === "person"
      ? activePerson
        ? displayName(activePerson.scholar.name)
        : "By person"
      : activeGroup
        ? evidenceGroupName(activeGroup.key)
        : "All candidates";
  const scopeSub =
    mode === "person"
      ? activePerson
        ? `${plural(activePerson.open, "open candidate")} · ${activePerson.counts.papers} of ${plural(activePerson.counts.total, "publication")} already confirmed`
        : ""
      : activeGroup
        ? `${plural(activeGroup.open, "open paper")} · ${
            activeGroup.key === ADDED_GROUP
              ? ADDED_SUB
              : groupBandText(activeGroup.rows.map((r) => r.likelihood))
          }`
        : `${plural(remaining, "open candidate")} across ${plural(groups.length, "evidence group")}`;
  const meshCount = reviewRows.filter(
    (r) => r.topicalPrior !== null && decodeTopicalPrior(r.topicalPrior).mesh,
  ).length;

  // Tabs only earn their place once there's history to switch to; otherwise the
  // queue is the single "To review" view it always was.
  const hasHistory = confirmed.length > 0 || rejected.length > 0;
  const sessionConfirmed = [...decided.values()].filter((d) => d === "claimed").length;
  const sessionRejected = decided.size - sessionConfirmed;
  // The summary strip counts the rows the list SHOWS (`reviewRows`, after the
  // display floor) across the whole queue, not the rail's current pile: it is
  // the queue's overview, and a signal click narrows whatever pile is open.
  const summary = summarizeOpen(reviewRows, decided, paperCounts, clientCwids);

  // ---- scope changes ------------------------------------------------------

  /** Any change of pile drops the selection and disarms the guard: both were
   *  about rows the reviewer is no longer looking at. */
  const resetForScope = () => {
    setFocusPmid(null);
    setSelected(new Set());
    setArmed(null);
  };
  const chooseMode = (m: RailMode) => {
    if (m === mode) return;
    setMode(m);
    resetForScope();
  };
  const chooseScope = (key: string) => {
    if (mode === "evidence") setGroupKey(key);
    else setPersonCwid(key);
    resetForScope();
  };
  const toggleFacet = (group: string, value: string) => {
    setFacets((f) => {
      const k = group as FacetKey;
      const cur = f[k] ?? [];
      return { ...f, [k]: cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value] };
    });
    setFocusPmid(null);
    setArmed(null);
    setHistArmed(false);
  };
  const clearFilters = () => {
    setFacets({});
    setQuery("");
    setArmed(null);
    setHistArmed(false);
  };

  // ---- focus + keyboard ---------------------------------------------------

  function focusRow(pmid: string) {
    setFocusPmid(pmid);
    listRef.current
      ?.querySelector(`[data-pmid="${pmid}"]`)
      // jsdom has no scrollIntoView; the optional call keeps the keys testable.
      ?.scrollIntoView?.({ block: "nearest" });
  }
  function move(dir: 1 | -1) {
    if (visible.length === 0) return;
    const at = Math.max(0, focusIndex);
    const next = visible[Math.min(visible.length - 1, Math.max(0, at + dir))];
    focusRow(next.pmid);
  }
  function toggleSelected(pmid: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (!next.delete(pmid)) next.add(pmid);
      return next;
    });
  }
  function toggleHistSelected(pmid: string) {
    setHistArmed(false);
    setHistSelected((s) => {
      const next = new Set(s);
      if (!next.delete(pmid)) next.add(pmid);
      return next;
    });
  }

  // One window listener for the whole review tab (mockup), re-pointed at the
  // latest render's closures through a ref so it is bound once. It stands down
  // while typing — INPUT, TEXTAREA, SELECT, contenteditable — and under any
  // modifier, so j, k and x stay ordinary letters in the search box and the
  // dialogs; and while either dialog is open, whose focus trap owns the keys.
  const onKey = useRef<(e: globalThis.KeyboardEvent) => void>(() => {});
  onKey.current = (e) => {
    if (view !== "review" || candidates.length === 0 || addOpen || clientsOpen) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k === "j" || k === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (k === "k" || k === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (k === "a" || k === "r") {
      if (focused && !decided.has(focused.pmid)) {
        e.preventDefault();
        void decide(focused.pmid, k === "a" ? "claimed" : "rejected");
      }
    } else if (k === "x") {
      if (focused && !decided.has(focused.pmid)) {
        e.preventDefault();
        toggleSelected(focused.pmid);
      }
    } else if (k === "u") {
      e.preventDefault();
      void undoLast();
    } else if (k === "?") {
      e.preventDefault();
      setKeysOpen((o) => !o);
    } else if (k === "Escape") {
      setKeysOpen(false);
      setSheetOpen(false);
    }
  };
  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => onKey.current(e);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // The focused paper's "Review all N papers by X" — the repeat-user row's jump
  // into By person, keeping this paper in the pane. Only in By evidence (in By
  // person the list already IS that person), and only for someone the rail lists.
  const repeatAction = (() => {
    if (!focused || mode !== "evidence") return null;
    const who = repeatUser(focused, paperCounts, clientCwids);
    const person = who
      ? people.find((p) => p.scholar.cwid.toLowerCase() === who.scholar.cwid.toLowerCase())
      : undefined;
    if (!person) return null;
    const cwid = person.scholar.cwid.toLowerCase();
    return {
      label: `Review all ${plural(person.open, "paper")} by ${displayName(person.scholar.name)}`,
      onClick: () => {
        const keep = focused.pmid;
        setMode("person");
        setPersonCwid(cwid);
        setSelected(new Set());
        setArmed(null);
        setFocusPmid(keep);
      },
    };
  })();

  // The search box, Filters and chips. Shared by To review and the history
  // tabs (mockup); the sort pills and the several-PMID note are To review's.
  const searchBar = (
    <div data-slot="core-queue-search" className="mt-4 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setFocusPmid(null);
            setArmed(null);
            setHistArmed(false);
          }}
          onPaste={(e) => {
            const flat = pasteAsOneLine(e.clipboardData.getData("text"));
            if (flat === null) return;
            e.preventDefault();
            const el = e.currentTarget;
            const start = el.selectionStart ?? el.value.length;
            const end = el.selectionEnd ?? el.value.length;
            setQuery(`${el.value.slice(0, start)}${flat}${el.value.slice(end)}`);
            setFocusPmid(null);
            setArmed(null);
            setHistArmed(false);
          }}
          placeholder="Search title, author, journal, or paste several PMIDs"
          aria-label={onHistory ? `Filter ${view} papers` : "Filter candidates"}
          className="bg-apollo-surface h-9 min-w-0 flex-[1_1_260px] text-[13px]"
        />
        <button
          type="button"
          aria-expanded={filtersOpen}
          aria-controls="core-queue-filters"
          onClick={() => setFiltersOpen((o) => !o)}
          className={`inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-[13px] whitespace-nowrap ${
            activeChips.length > 0 ? "border-apollo-slate" : "border-apollo-border-strong"
          } ${filtersOpen ? "bg-apollo-surface-2" : "bg-apollo-surface"}`}
        >
          Filters
          <span className="bg-apollo-rail rounded-full px-1.5 text-xs text-[var(--evidence-body)] tabular-nums">
            {activeChips.length}
          </span>
        </button>
        {onHistory ? null : (
          <div role="group" aria-label="Sort" className="flex shrink-0 gap-1">
            {SORT_PILLS.map((s) => (
              <button
                key={s.key}
                type="button"
                aria-pressed={sort === s.key}
                onClick={() => setSort(s.key)}
                className={`rounded-full border px-2.5 py-0.5 text-xs whitespace-nowrap ${
                  sort === s.key
                    ? "border-apollo-border-strong bg-apollo-surface"
                    : "border-transparent"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {pmidNote && !onHistory ? (
        <p
          data-slot="core-queue-pmid-note"
          className="border-apollo-border bg-apollo-surface-2 rounded-lg border px-2.5 py-1.5 text-xs leading-normal text-[var(--evidence-body)]"
        >
          {pmidNote}
        </p>
      ) : null}
      {filtersOpen ? (
        <FiltersPanel id="core-queue-filters" groups={facetGroups} onToggle={toggleFacet} />
      ) : null}
      {narrowed ? (
        <ActiveFilterChips chips={activeChips} onRemove={toggleFacet} onClear={clearFilters} />
      ) : null}
    </div>
  );

  const HEADER_BUTTON =
    "border-border-strong text-muted-foreground hover:text-foreground bg-background inline-flex h-8 items-center rounded-md border px-3 text-sm";

  return (
    <div data-slot="core-claim-queue">
      <div aria-live="polite" className="sr-only" data-testid="core-claim-live">
        {announce}
      </div>
      {toast ? (
        <UndoToast
          text={toast.text}
          tone={toast.tone}
          undoing={undoing}
          onUndo={() => void undoLast()}
        />
      ) : null}
      {/* The mockup's header row: the page's title block on the left, the three
          controls on the right, bottom-aligned. The button group carries
          `ml-auto` so it stays right when the title wraps under it. */}
      <div
        data-slot="core-queue-toolbar"
        className="mb-6 flex flex-wrap items-end justify-between gap-4"
      >
        {header ? <div className="min-w-0">{header}</div> : null}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setClientsOpen((v) => !v)}
            aria-pressed={clientsOpen}
            className={HEADER_BUTTON}
          >
            Known clients (<span className="tabular-nums">{clients.length}</span>)
          </button>
          <button
            type="button"
            onClick={() => {
              setAddOpen((v) => !v);
              setAddResult(null);
            }}
            aria-pressed={addOpen}
            className={HEADER_BUTTON}
          >
            Add PMIDs
          </button>
          {/* This core's reports index (3, 6 and the core-only 11–13), the same
              `center=<coreId>&kind=core` scope the index and every report use.
              Same authz on the other side, so it never leads a reviewer to a
              403 they could reach the review queue from. */}
          <a
            href={`/edit/reports?center=${encodeURIComponent(core.id)}&kind=core&scope=core`}
            className={HEADER_BUTTON}
          >
            Reporting
          </a>
        </div>
      </div>

      {/* Both header panels are MODALS, not inline drawers: each is a task with
          its own commit step, and an inline panel pushed the queue down the page
          while it was open. Add PMIDs has the mockup's two modes: "Confirm
          now" (the manual claim) and "Send to review" (a `core_queue_add`
          row; the paper joins To review under "Added by you"). */}
      <Dialog
        open={addOpen}
        onOpenChange={(next) => {
          setAddOpen(next);
          if (!next) {
            setAddTextTracked("");
            setAddResult(null);
            setAddCheck(null);
          }
        }}
      >
        <DialogContent
          data-slot="core-claim-pmid-dialog"
          className="gap-0 p-0 sm:max-w-2xl"
        >
          <DialogHeader className="border-apollo-border border-b px-6 py-5">
            <DialogTitle>Add publications by PMID</DialogTitle>
            <DialogDescription>
              For papers the engine never put in front of you. Confirm the ones you know used this
              core, or send the ones you want to check to review.
            </DialogDescription>
          </DialogHeader>

          <div className="px-6 py-5">
            {/* The two modes (mockup). A mode change drops the check: a dry run
                for one route says nothing about what the other would write. */}
            <div
              role="radiogroup"
              aria-label="What to do with these PMIDs"
              data-slot="core-claim-pmid-modes"
              className="mb-4 grid gap-2 sm:grid-cols-2"
            >
              {ADD_MODES.map((m) => {
                const active = addMode === m.key;
                return (
                  <button
                    key={m.key}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => {
                      if (active) return;
                      setAddModeTracked(m.key);
                      setAddCheck(null);
                      setAddResult(null);
                      setAddChecking(false);
                    }}
                    className={`rounded-lg border px-3 py-2.5 text-left ${
                      active
                        ? "border-apollo-slate bg-apollo-surface shadow-[inset_0_0_0_1px_var(--apollo-slate)]"
                        : "border-apollo-border bg-apollo-surface-2"
                    }`}
                  >
                    <span className="text-foreground block text-sm font-medium">{m.label}</span>
                    <span className="text-muted-foreground mt-0.5 block text-xs leading-snug">
                      {m.sub}
                    </span>
                  </button>
                );
              })}
            </div>
            <label
              htmlFor="core-claim-add-pmids"
              className="text-foreground mb-2 block text-sm font-medium"
            >
              Paste PMIDs
            </label>
            <textarea
              id="core-claim-add-pmids"
              value={addText}
              onChange={(e) => {
                setAddTextTracked(e.target.value);
                // The old check described a paste that no longer exists.
                setAddCheck(null);
              }}
              placeholder="38771290, 37845512&#10;36990455 39914402"
              rows={3}
              className="border-border-strong text-foreground bg-background focus-visible:ring-apollo-maroon w-full rounded-md border px-3 py-2 font-mono text-sm focus-visible:outline-none focus-visible:ring-2"
            />
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={addChecking || addText.trim().length === 0}
                onClick={checkAddPmids}
                className="bg-apollo-maroon inline-flex h-9 shrink-0 items-center rounded-md px-3.5 text-sm font-medium text-white disabled:opacity-50"
              >
                {addChecking ? "Checking…" : "Check PMIDs"}
              </button>
              <p className="text-muted-foreground min-w-0 text-xs">
                Up to {MAX_CLAIM_PMIDS} at a time. Each is checked against Scholars before anything
                is written.
              </p>
            </div>

            {addCheck ? (
              <ul
                className="text-muted-foreground mt-4 flex flex-col gap-1 text-xs"
                data-slot="core-claim-pmid-check"
              >
                <li className="text-foreground">
                  <span className="font-medium tabular-nums">{addCheck.wouldWrite}</span> ready to{" "}
                  {addMode === "review" ? "add to review" : "claim"}.
                </li>
                {addCheck.skipped > 0 ? (
                  <li>
                    <span className="tabular-nums">{addCheck.skipped}</span>{" "}
                    {addMode === "review"
                      ? "already in this core's To review list."
                      : "already claimed for this core."}
                  </li>
                ) : null}
                {addCheck.decided ? (
                  <li>
                    <span className="tabular-nums">{addCheck.decided}</span> already decided for
                    this core (Confirmed or Rejected), not added.
                  </li>
                ) : null}
                {addCheck.notFound.length > 0 ? (
                  <li>Not in Scholars, will be skipped: {addCheck.notFound.join(", ")}.</li>
                ) : null}
                {addCheck.invalid.length > 0 ? (
                  <li>Not a PMID: {addCheck.invalid.join(", ")}.</li>
                ) : null}
              </ul>
            ) : null}
          </div>

          <DialogFooter className="border-apollo-border bg-apollo-surface-2 border-t px-6 py-4">
            {addResult ? (
              <p className="text-muted-foreground mr-auto self-center text-xs" role="status">
                {addResult}
              </p>
            ) : null}
            <button
              type="button"
              onClick={() => {
                setAddOpen(false);
                setAddTextTracked("");
                setAddResult(null);
                setAddCheck(null);
              }}
              className="border-border-strong text-foreground hover:bg-apollo-surface inline-flex h-9 items-center rounded-md border bg-background px-3.5 text-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={addPending || !addCheck || addCheck.wouldWrite === 0}
              onClick={addMode === "review" ? submitSendToReview : submitAddPmids}
              className="bg-apollo-maroon inline-flex h-9 items-center rounded-md px-3.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {addMode === "review"
                ? addPending
                  ? "Adding…"
                  : addCheck && addCheck.wouldWrite > 0
                    ? `Add ${addCheck.wouldWrite} to review`
                    : "Add to review"
                : addPending
                  ? "Claiming…"
                  : "Claim publications"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <CoreClientsDialog
        coreId={core.id}
        open={clientsOpen}
        clients={clients}
        onClose={() => setClientsOpen(false)}
      />

      {/* The tab row (mockup): the view switch on the left; on the To review
          tab, the key hint and the shortcuts popover on the right. The session
          tally and its Undo moved into the summary strip's "This session" card. */}
      <div
        data-slot="core-queue-panel"
        className="border-apollo-border-strong flex flex-wrap items-end justify-between gap-x-3 gap-y-2 border-b"
      >
        {hasHistory ? (
          <ViewTabs
            view={view}
            onView={(v) => {
              if (v === view) return;
              setView(v);
              setArmed(null);
              // The search and the facets are shared across tabs; a value
              // ticked on one tab's rows means nothing on another's.
              setFacets({});
              setQuery("");
              setHistSelected(new Set());
              setHistArmed(false);
            }}
            reviewCount={remaining}
            confirmedCount={confirmed.length}
            rejectedCount={rejected.length}
          />
        ) : (
          <h2 className="mb-2 flex items-baseline gap-2 text-[15px] font-semibold">
            To review
            <span className="text-muted-foreground text-sm font-normal tabular-nums">
              {remaining}
            </span>
          </h2>
        )}
        {view === "review" && candidates.length > 0 ? (
          <div className="text-muted-foreground mb-2 flex flex-wrap items-center gap-3 text-xs">
            {/* Keys are a desktop affordance; on a phone the hint is noise. */}
            <span data-slot="core-queue-keys-hint" className="hidden whitespace-nowrap md:inline">
              {KEYS_HINT}
            </span>
            <ShortcutsButton open={keysOpen} onToggle={() => setKeysOpen((o) => !o)} />
          </div>
        ) : null}
      </div>

      {view === "review" && candidates.length === 0 ? (
        <p className="text-muted-foreground border-apollo-border mt-4 rounded-lg border border-dashed px-4 py-6 text-sm">
          Nothing to review — every candidate publication for this core has been confirmed or
          rejected.
        </p>
      ) : null}

      {view === "review" && candidates.length > 0 ? (
        <>
          <QueueSummary
            total={summary.total}
            multiSignal={summary.multiSignal}
            groups={summary.groups.map((g) => ({
              key: g.key,
              label: evidenceGroupName(g.key),
              count: g.count,
            }))}
            signals={SIGNAL_KINDS.map((s) => ({
              facet: s.facet,
              label: s.label,
              strength: s.strength,
              dots: s.dots,
              count: summary.signals[s.kind],
              active: (facets.signal ?? []).includes(s.facet),
            }))}
            onSignal={(facet) => toggleFacet("signal", facet)}
            session={{
              confirmed: sessionConfirmed,
              rejected: sessionRejected,
              reasons: reasonTally(notes, decided),
              note: sessionNote(decided.size, remaining),
              canUndo: history.length > 0,
              undoing,
              onUndo: () => void undoLast(),
            }}
          />
          {searchBar}

          {/* Three panes at `lg` (mockup); below it the rail is a select, the list
              runs full width, and the paper opens as a full-screen sheet. */}
          <div
            data-slot="core-queue-panes"
            className="mt-4 flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,232px)_minmax(0,1fr)_minmax(0,1.2fr)] lg:items-start lg:gap-5"
          >
            <ScopeRail
              mode={mode}
              onMode={chooseMode}
              items={railItems}
              activeKey={railKey}
              onSelect={chooseScope}
              emptyText="Nobody on these bylines has a confirmed paper with this core yet, so there is no one to review by."
              about={
                <AboutSignals
                  staffCount={core.staffCount}
                  staffTrackedCount={core.staffTrackedCount}
                  meshCount={meshCount}
                />
              }
            />

            <section aria-label="Candidates" className="flex min-w-0 flex-col gap-2.5">
              <div>
                <h2 className="text-base leading-snug font-medium">{scopeTitle}</h2>
                {scopeSub ? (
                  <p className="text-muted-foreground mt-0.5 text-xs">{scopeSub}</p>
                ) : null}
                {(showLow ? floor.belowFloor : floor.hidden) > 0 ? (
                  <FloorLine
                    count={showLow ? floor.belowFloor : floor.hidden}
                    showing={showLow}
                    weakOnly={floor.weakOnly}
                    onToggle={() => {
                      setShowLow((v) => !v);
                      resetForScope();
                    }}
                  />
                ) : null}
              </div>
              <div className="border-apollo-border bg-apollo-surface overflow-hidden rounded-[var(--apollo-radius-card)] border shadow-[var(--apollo-shadow-card)]">
                <div
                  data-slot="core-queue-selection-bar"
                  role="group"
                  aria-label="Selected publications"
                  className={`flex flex-wrap items-center justify-between gap-2 px-3.5 py-2 text-[13px] ${
                    selectedPmids.length > 0 ? "bg-apollo-slate-tint" : "bg-apollo-surface-2"
                  }`}
                >
                  <label className="flex items-center gap-2.5">
                    <input
                      type="checkbox"
                      checked={allChecked}
                      disabled={openShown.length === 0}
                      onChange={() =>
                        setSelected((s) => {
                          const next = new Set(s);
                          for (const r of openShown) {
                            if (allChecked) next.delete(r.pmid);
                            else next.add(r.pmid);
                          }
                          return next;
                        })
                      }
                      className="size-4 accent-[var(--apollo-slate)]"
                    />
                    <span>
                      {selectedPmids.length > 0
                        ? `${selectedPmids.length} of ${openShown.length} selected`
                        : `Select all ${openShown.length} ${narrowed ? "matching" : "shown"}`}
                    </span>
                  </label>
                  <span className="flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={selectedPmids.length === 0 || bulkPending !== null}
                      onClick={() => void bulkDecide(selectedPmids, "claimed")}
                      className="inline-flex h-7 items-center rounded-md bg-[var(--color-accent-slate)] px-2.5 text-xs font-medium text-white disabled:opacity-50"
                    >
                      {bulkPending === "claimed"
                        ? "Confirming…"
                        : selectedPmids.length > 0
                          ? `Confirm ${selectedPmids.length}`
                          : "Confirm"}
                      <span className="sr-only"> selected</span>
                    </button>
                    <button
                      type="button"
                      disabled={selectedPmids.length === 0 || bulkPending !== null}
                      onClick={() => setArmed("selected")}
                      className="border-border-strong bg-background inline-flex h-7 items-center rounded-md border px-2.5 text-xs disabled:opacity-50"
                    >
                      {bulkPending === "rejected"
                        ? "Rejecting…"
                        : selectedPmids.length > 0
                          ? `Reject ${selectedPmids.length}`
                          : "Reject"}
                      <span className="sr-only"> selected</span>
                    </button>
                    {selectedPmids.length === 0 && armed === null && openShown.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => setArmed("all")}
                        className="text-muted-foreground hover:text-foreground px-1 text-xs whitespace-nowrap"
                      >
                        Reject all {openShown.length}…
                      </button>
                    ) : null}
                  </span>
                </div>
                {armed ? (
                  <RejectGuard
                    count={armed === "all" ? openShown.length : selectedPmids.length}
                    what={armed === "all" ? "shown" : "selected"}
                    disabled={bulkPending !== null}
                    onReject={() =>
                      void bulkDecide(
                        armed === "all" ? openShown.map((r) => r.pmid) : selectedPmids,
                        "rejected",
                      )
                    }
                    onCancel={() => setArmed(null)}
                  />
                ) : null}
                <ul ref={listRef} aria-label="Candidate papers">
                  {visible.map((r) => (
                    <QueueListRow
                      key={r.pmid}
                      row={r}
                      mode={mode}
                      focused={focused?.pmid === r.pmid}
                      error={errors.get(r.pmid)}
                      checked={selected.has(r.pmid)}
                      onCheck={() => toggleSelected(r.pmid)}
                      onOpen={() => {
                        setFocusPmid(r.pmid);
                        setSheetOpen(true);
                      }}
                      paperCounts={paperCounts}
                      clientCwids={clientCwids}
                    />
                  ))}
                </ul>
              </div>
              {visible.length === 0 ? (
                <p className="text-muted-foreground border-apollo-border rounded-lg border border-dashed px-4 py-6 text-center text-sm">
                  {emptyListText({
                    noPerson: mode === "person" && !activePerson,
                    allDecided: scopeRows.length > 0 && scopeOpen.length === 0,
                    hiddenBelowFloor: floor.hidden,
                    narrowed,
                  })}
                </p>
              ) : null}
              <p data-slot="core-queue-status" className="text-muted-foreground text-xs">
                Showing {visible.length} of {scopeOpen.length} candidates
              </p>
            </section>

            {focused ? (
              <FocusedPaper
                row={focused}
                position={`${focusIndex + 1} of ${visible.length} shown`}
                hasPrev={focusIndex > 0}
                hasNext={focusIndex < visible.length - 1}
                onPrev={() => move(-1)}
                onNext={() => move(1)}
                sheetOpen={sheetOpen}
                onCloseSheet={() => setSheetOpen(false)}
                clientCwids={clientCwids}
                paperCounts={paperCounts}
                pending={pending.has(focused.pmid)}
                error={errors.get(focused.pmid)}
                copied={copiedPmid === focused.pmid}
                onCopyPmid={() => copyPmid(focused.pmid)}
                onDecide={(status, note) => void decide(focused.pmid, status, note)}
                repeatAction={repeatAction}
              />
            ) : null}
          </div>
        </>
      ) : null}

      {view === "confirmed" || view === "rejected" ? (
        <>
          {searchBar}
          <p className="text-muted-foreground mt-3 text-xs">
            {view === "confirmed"
              ? "Confirmed papers appear on the public core page. Revoking takes a paper off it."
              : "Rejected papers are hidden from public pages. Restoring re-opens a paper."}
          </p>
          <div className="border-apollo-border bg-apollo-surface mt-2 overflow-hidden rounded-[var(--apollo-radius-card)] border shadow-[var(--apollo-shadow-card)]">
            <HistorySelectionBar
              tab={view}
              openCount={historyOpen.length}
              selectedCount={historySelectedRows.length}
              allChecked={historyAllChecked}
              narrowed={narrowed}
              pending={histPending}
              onToggleAll={() => {
                setHistArmed(false);
                setHistSelected((s) => {
                  const next = new Set(s);
                  for (const r of historyOpen) {
                    if (historyAllChecked) next.delete(r.pmid);
                    else next.add(r.pmid);
                  }
                  return next;
                });
              }}
              onArm={() => setHistArmed(true)}
            />
            {histArmed && historySelectedRows.length > 0 ? (
              <HistoryGuard
                tab={view}
                count={historySelectedRows.length}
                text={historyGuardText(view, historySelectedRows)}
                disabled={histPending}
                onConfirm={() => void bulkHistory(view, historySelectedRows)}
                onCancel={() => setHistArmed(false)}
              />
            ) : null}
            <ul
              aria-label={view === "confirmed" ? "Confirmed papers" : "Rejected papers"}
              className="flex flex-col"
            >
              {historyShown.map((row) =>
                view === "confirmed" ? (
                  <ConfirmedRow
                    key={row.pmid}
                    row={row}
                    revoked={revokedConfirmed.has(row.pmid)}
                    pending={pending.has(row.pmid)}
                    error={errors.get(row.pmid)}
                    clientCwids={clientCwids}
                    paperCounts={paperCounts}
                    checked={histSelected.has(row.pmid)}
                    onCheck={() => toggleHistSelected(row.pmid)}
                    onRevoke={() => revokeConfirmed(row)}
                    onUndo={() => undoRevokeConfirmed(row.pmid, row.claimed)}
                  />
                ) : (
                  <RejectedRow
                    key={row.pmid}
                    row={row}
                    restored={restoredRejected.has(row.pmid)}
                    pending={pending.has(row.pmid)}
                    error={errors.get(row.pmid)}
                    checked={histSelected.has(row.pmid)}
                    onCheck={() => toggleHistSelected(row.pmid)}
                    onRestore={() => restoreRejected(row.pmid, row.title)}
                    onUndo={() => undoRestoreRejected(row.pmid)}
                  />
                ),
              )}
            </ul>
          </div>
          {historyShown.length === 0 ? (
            <p className="text-muted-foreground border-apollo-border mt-2 rounded-lg border border-dashed px-4 py-6 text-center text-sm">
              Nothing matches these filters.
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** The inline guard in front of a bulk reject (mockup's "Reject all N shown?"). */
function RejectGuard({
  count,
  what,
  disabled,
  onReject,
  onCancel,
}: {
  count: number;
  what: "shown" | "selected";
  disabled: boolean;
  onReject: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      data-slot="core-queue-reject-guard"
      className="border-apollo-border flex flex-wrap items-center justify-between gap-2 border-t bg-red-50 px-3.5 py-2 text-[13px] text-red-800"
    >
      <span>
        Reject {what === "shown" ? "all " : ""}
        {count} {what}? Each gets its own audit row and can be restored.
      </span>
      <span className="flex gap-1.5">
        <button
          type="button"
          disabled={disabled}
          onClick={onReject}
          className="inline-flex h-7 items-center rounded-md bg-red-700 px-2.5 text-xs font-medium text-white disabled:opacity-50"
        >
          Reject {count}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex h-7 items-center rounded-md px-2.5 text-xs"
        >
          Cancel
        </button>
      </span>
    </div>
  );
}

/**
 * The Confirmed/Rejected tabs' selection bar (mockup): "Select all N" and ONE
 * bulk button, "Revoke N" or "Restore N". The button only arms the inline guard
 * (`HistoryGuard`) — nothing is posted from here. The bar wraps at phone width.
 */
function HistorySelectionBar({
  tab,
  openCount,
  selectedCount,
  allChecked,
  narrowed,
  pending,
  onToggleAll,
  onArm,
}: {
  tab: "confirmed" | "rejected";
  openCount: number;
  selectedCount: number;
  allChecked: boolean;
  narrowed: boolean;
  pending: boolean;
  onToggleAll: () => void;
  onArm: () => void;
}) {
  const verb = tab === "confirmed" ? "Revoke" : "Restore";
  return (
    <div
      data-slot="core-queue-history-bar"
      role="group"
      aria-label={`Selected ${tab} publications`}
      className={`flex flex-wrap items-center justify-between gap-2 px-3.5 py-2 text-[13px] ${
        selectedCount > 0 ? "bg-apollo-slate-tint" : "bg-apollo-surface-2"
      }`}
    >
      <label className="flex items-center gap-2.5">
        <input
          type="checkbox"
          checked={allChecked}
          disabled={openCount === 0}
          onChange={onToggleAll}
          className="size-4 accent-[var(--apollo-slate)]"
        />
        <span>
          {selectedCount > 0
            ? `${selectedCount} of ${openCount} selected`
            : `Select all ${openCount} ${narrowed ? "matching" : "shown"}`}
        </span>
      </label>
      <button
        type="button"
        disabled={selectedCount === 0 || pending}
        onClick={onArm}
        className="border-border-strong bg-background inline-flex h-8 items-center rounded-md border px-3 text-xs disabled:opacity-50"
      >
        {pending
          ? `${tab === "confirmed" ? "Revoking" : "Restoring"}…`
          : selectedCount > 0
            ? `${verb} ${selectedCount}`
            : verb}
        <span className="sr-only"> selected</span>
      </button>
    </div>
  );
}

/**
 * The inline guard in front of a bulk Revoke/Restore — the same pattern as
 * `RejectGuard` (grant-signal design delta B.2: "Revoke 12 confirmed papers?
 * They return to review. Each gets its own audit row." / "Revoke 12" /
 * "Cancel"). The sentence comes from `historyGuardText`.
 */
function HistoryGuard({
  tab,
  count,
  text,
  disabled,
  onConfirm,
  onCancel,
}: {
  tab: "confirmed" | "rejected";
  count: number;
  text: string;
  disabled: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      data-slot="core-queue-history-guard"
      className="border-apollo-border flex flex-wrap items-center justify-between gap-2 border-t bg-amber-50 px-3.5 py-2 text-[13px] text-amber-900"
    >
      <span className="min-w-0">{text}</span>
      <span className="flex gap-1.5">
        <button
          type="button"
          disabled={disabled}
          onClick={onConfirm}
          className="inline-flex h-8 items-center rounded-md bg-amber-800 px-3 text-xs font-medium text-white disabled:opacity-50"
        >
          {tab === "confirmed" ? "Revoke" : "Restore"} {count}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex h-8 items-center rounded-md px-3 text-xs"
        >
          Cancel
        </button>
      </span>
    </div>
  );
}

/**
 * The view switch (To review / Confirmed / Rejected), shown once the queue has
 * history. A bordered TAB STRIP, not pills: the active tab is a raised card that
 * loses its bottom border and so joins the panel body it switches, and its count
 * is a filled maroon badge. Inactive tabs are plain text with a muted count.
 *
 * The semantics are the pills' semantics unchanged — a `role="group"` of
 * `aria-pressed` buttons (a single choice among the ones on offer, where the
 * facets below are multi-select checkboxes), and Confirmed/Rejected render only
 * when their own count is above 0.
 */
function ViewTabs({
  view,
  onView,
  reviewCount,
  confirmedCount,
  rejectedCount,
}: {
  view: QueueView;
  onView: (v: QueueView) => void;
  reviewCount: number;
  confirmedCount: number;
  rejectedCount: number;
}) {
  const tabs: { key: QueueView; label: string; count: number; show: boolean }[] = [
    { key: "review", label: "To review", count: reviewCount, show: true },
    { key: "confirmed", label: "Confirmed", count: confirmedCount, show: confirmedCount > 0 },
    { key: "rejected", label: "Rejected", count: rejectedCount, show: rejectedCount > 0 },
  ];
  return (
    <div className="-mb-px flex flex-wrap items-end gap-1" role="group" aria-label="Queue view">
      {tabs
        .filter((t) => t.show)
        .map((t) => {
          const active = view === t.key;
          return (
            <button
              key={t.key}
              type="button"
              aria-pressed={active}
              onClick={() => onView(t.key)}
              className={`focus-visible:ring-apollo-maroon inline-flex items-center gap-1.5 px-3 py-1.5 text-[13px] focus-visible:outline-none focus-visible:ring-2 ${
                active
                  ? "border-apollo-border bg-apollo-surface text-foreground rounded-t-md border border-b-transparent font-medium"
                  : "text-muted-foreground hover:text-foreground border border-transparent"
              }`}
            >
              {t.label}
              {active ? (
                <span className="bg-apollo-maroon inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-px text-[11px] tabular-nums text-white">
                  {t.count}
                </span>
              ) : (
                <span className="text-muted-foreground tabular-nums">{t.count}</span>
              )}
            </button>
          );
        })}
    </div>
  );
}

/**
 * `paperCounts` with a CONFIRMED row's own paper taken back out of every byline
 * author's numbers, so "previous occasions" means occasions BEFORE this one.
 *
 * `loadCoreClientPaperCounts` counts over `queue.confirmed` and the Confirmed tab
 * renders those same rows, so each of them sits inside its own evidence line: on
 * staging core 14 one person's 46 confirmed cards each read "46 previous
 * occasions" (45), and the 247 people with a single confirmed paper read "1
 * previous occasion" on that very paper, where the truth is none.
 *
 * A person left at zero is never PRINTED as "0 previous occasions" — no previous
 * occasion is not a weak claim, it is no claim — but the key STAYS IN THE MAP at
 * zero, and that distinction is the whole point of this function's shape. A
 * missing key means "this core holds nothing from them"; a zero means "everything
 * it holds from them is the row you are looking at". `repeatUser` and
 * `namedWithCounts` both print nothing off a zero, so the strip falls back exactly
 * as it did when the key was deleted — to the bare name on the client token.
 *
 * `repeatUserFires` is the one reader that needs the difference, and DELETING the
 * key lied to it: it reads presence as "somebody the other tokens already name has
 * a pile here", and with the key gone it saw "nobody on this byline qualifies at
 * all" and fired the unnamed fallback UNDER the staff or client token naming that
 * very person — the F1/F5 duplicate re-opened, with "N of 4" rising on the one tab
 * that subtracts.
 *
 * Only `row.wcmAuthors` is adjusted — nobody else can be named from it — and those
 * come from the same `isConfirmed` byline read the counts do, so the paper really
 * is in there. Pure.
 */
function withoutOwnPaper(
  row: CoreQueueRow,
  paperCounts: Readonly<Record<string, CoreClientPaperCount>>,
): Readonly<Record<string, CoreClientPaperCount>> {
  const out = { ...paperCounts };
  for (const a of row.wcmAuthors) {
    const key = a.cwid.toLowerCase();
    const held = out[key];
    if (held) out[key] = excludingOwnPaper(held, row.year);
  }
  return out;
}

/** One row on the Confirmed/Rejected tabs: a checkbox, the paper, its action. */
const HISTORY_ROW =
  "border-apollo-border flex gap-2.5 border-t px-3.5 py-2.5 text-sm first:border-t-0";

// A confirmed publication with an inline Revoke (kept walk-back-able for the
// session — the one thing this list needs to earn its place below the queue).
//
// It carries the SCORE and the evidence too. A confirmation is not final: the
// engine re-scores every night, so a row confirmed months ago can be one the
// evidence no longer supports, and until now this list showed a reviewer nothing
// to judge that on — title, year, PMID and a Revoke button. Same band and
// "N of 4 signals" the review queue shows, plus the evidence tokens, so
// revisiting a confirmation and re-reviewing it use the same vocabulary.
//
// A MANUAL add has no engine row at all (`isManual`), so it gets the existing
// "Manually added" note and NO score — a 0% band on a human's deliberate
// addition would read as the engine disagreeing, when it simply never scored it.
function ConfirmedRow({
  row,
  revoked,
  pending,
  error,
  checked = false,
  onCheck = () => {},
  onRevoke,
  onUndo,
  clientCwids = new Set<string>(),
  paperCounts = {},
}: {
  row: CoreQueueRow;
  revoked: boolean;
  pending: boolean;
  error: string | undefined;
  /** Ticked for the bulk Revoke. */
  checked?: boolean;
  onCheck?: () => void;
  onRevoke: () => void;
  onUndo: () => void;
  /** The core's known-client CWIDs, so the evidence line reads the same here as
   *  it does on the review queue. */
  clientCwids?: ReadonlySet<string>;
  /** Per-person confirmed-paper counts for this core (see `clientPaperCounts`). */
  paperCounts?: Readonly<Record<string, CoreClientPaperCount>>;
}) {
  if (revoked) {
    return (
      <li className={`${HISTORY_ROW} text-muted-foreground items-center`}>
        <span className="size-4 shrink-0" aria-hidden />
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <Undo2 className="size-3.5 shrink-0 translate-y-0.5" aria-hidden />
          <span className="truncate">{row.title}</span>
          {row.year ? <span className="shrink-0 text-xs">· {row.year}</span> : null}
          <span className="shrink-0 text-xs tabular-nums">· PMID {row.pmid}</span>
          <span className="shrink-0 text-xs italic">— Revoked, re-files on next load</span>
        </span>
        <button
          type="button"
          disabled={pending}
          onClick={onUndo}
          className="border-border-strong text-muted-foreground hover:text-foreground inline-flex h-7 shrink-0 items-center gap-1 rounded-full border bg-background px-2.5 text-xs disabled:opacity-50"
        >
          <Undo2 className="size-3" aria-hidden /> Undo
        </button>
      </li>
    );
  }
  const band = likelihoodBand(row.likelihood);
  // THIS row is inside its own counts — they are computed over `queue.confirmed`,
  // which is the very list being rendered — so every byline author here carries
  // this paper in their own "previous occasions". It comes back out before the
  // strip prints anything. Candidates and rejected rows are untouched: the counts
  // never saw their pmids.
  const ownCounts = withoutOwnPaper(row, paperCounts);
  // BOTH maps, and they go to different tokens. "Previous occasions" is about
  // the papers before this one (`ownCounts`); "18 papers, 11 recent" on the
  // client token is what this core HOLDS from them, which the row on screen is
  // part of. Handing the subtracted copy to both made one person's number
  // disagree with itself across the two tabs — Review "18 papers", Confirmed
  // "17" — for a token whose whole job is to state a holding.
  const tokens = evidenceTokens(row, clientCwids, paperCounts, ownCounts);
  // The signal count is the repeat-user question alone, so it reads the
  // subtracted map: a person whose only confirmed paper is this one adds no
  // previous occasion and the count must not rise on the tab that subtracts.
  const signalCount = buildSignals(row, ownCounts, clientCwids).length;
  return (
    <li className={`${HISTORY_ROW} text-muted-foreground items-start`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={pending}
        onChange={onCheck}
        aria-label={`Select ${row.title}`}
        className="mt-0.5 size-4 shrink-0 accent-[var(--apollo-slate)]"
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <Check className="size-3.5 shrink-0 translate-y-0.5 text-emerald-600" aria-hidden />
          <span className="text-foreground truncate">{row.title}</span>
          {row.year ? <span className="shrink-0 text-xs">· {row.year}</span> : null}
          <span className="shrink-0 text-xs tabular-nums">· PMID {row.pmid}</span>
          {row.isManual ? (
            <span className="text-muted-foreground inline-flex shrink-0 items-center gap-1 text-xs italic">
              <PenLine className="size-3" aria-hidden /> Manually added
            </span>
          ) : null}
        </span>
        {row.isManual ? null : (
          <span
            className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 pl-5 text-[11.5px]"
            data-slot="core-queue-confirmed-evidence"
          >
            <span className={`font-semibold uppercase tracking-[0.04em] ${band.text}`}>
              {band.label} {Math.round(row.likelihood * 100)}%
            </span>
            <span className="text-muted-foreground">
              · {signalCount} of {SIGNAL_COUNT} signals
            </span>
            {tokens.map((t) => (
              <span key={t.label} className="inline-flex items-baseline gap-1">
                <span className="text-muted-foreground/60 font-bold" aria-hidden>
                  ·
                </span>
                <span className="text-muted-foreground">{t.label}</span>
                <span className="text-foreground font-medium">{t.value}</span>
              </span>
            ))}
          </span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {error ? (
          <span className="text-xs text-red-600" role="alert">
            Could not save: {error}
          </span>
        ) : null}
        <button
          type="button"
          disabled={pending}
          onClick={onRevoke}
          className="border-border-strong text-muted-foreground hover:text-foreground inline-flex h-7 items-center gap-1 rounded-full border bg-background px-2.5 text-xs disabled:opacity-50"
        >
          <Undo2 className="size-3" aria-hidden /> Revoke
        </button>
      </span>
    </li>
  );
}

// A previously-rejected publication with an inline Restore — the mirror of
// ConfirmedRow's Revoke. Restore soft-revokes the rejection (re-opens for review).
function RejectedRow({
  row,
  restored,
  pending,
  error,
  checked = false,
  onCheck = () => {},
  onRestore,
  onUndo,
}: {
  row: CoreQueueRow;
  restored: boolean;
  pending: boolean;
  error: string | undefined;
  /** Ticked for the bulk Restore. */
  checked?: boolean;
  onCheck?: () => void;
  onRestore: () => void;
  onUndo: () => void;
}) {
  if (restored) {
    return (
      <li className={`${HISTORY_ROW} text-muted-foreground items-center`}>
        <span className="size-4 shrink-0" aria-hidden />
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <Undo2 className="size-3.5 shrink-0 translate-y-0.5" aria-hidden />
          <span className="truncate">{row.title}</span>
          {row.year ? <span className="shrink-0 text-xs">· {row.year}</span> : null}
          <span className="shrink-0 text-xs tabular-nums">· PMID {row.pmid}</span>
          <span className="shrink-0 text-xs italic">— Restored, re-files on next load</span>
        </span>
        <button
          type="button"
          disabled={pending}
          onClick={onUndo}
          className="border-border-strong text-muted-foreground hover:text-foreground inline-flex h-7 shrink-0 items-center gap-1 rounded-full border bg-background px-2.5 text-xs disabled:opacity-50"
        >
          <Undo2 className="size-3" aria-hidden /> Undo
        </button>
      </li>
    );
  }
  return (
    <li className={`${HISTORY_ROW} text-muted-foreground items-center`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={pending}
        onChange={onCheck}
        aria-label={`Select ${row.title}`}
        className="size-4 shrink-0 accent-[var(--apollo-slate)]"
      />
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <X className="text-muted-foreground size-3.5 shrink-0 translate-y-0.5" aria-hidden />
        <span className="text-foreground truncate">{row.title}</span>
        {row.year ? <span className="shrink-0 text-xs">· {row.year}</span> : null}
        <span className="shrink-0 text-xs tabular-nums">· PMID {row.pmid}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {error ? (
          <span className="text-xs text-red-600" role="alert">
            Could not save: {error}
          </span>
        ) : null}
        <button
          type="button"
          disabled={pending}
          onClick={onRestore}
          className="border-border-strong text-muted-foreground hover:text-foreground inline-flex h-7 items-center gap-1 rounded-full border bg-background px-2.5 text-xs disabled:opacity-50"
        >
          <Undo2 className="size-3" aria-hidden /> Restore
        </button>
      </span>
    </li>
  );
}

/**
 * The short signal chips on a list row (mockup: "Repeat user · Fei Wang",
 * "LLM 2/10", "Method strong"). Same sources as the paper pane — the counted
 * signals off `buildSignals`, a known client on the byline, the method tier —
 * so a chip never names evidence the pane would not show. The repeat-user chip
 * names its person only in By evidence: in By person the whole list is that
 * person, and repeating the name on every row would be noise.
 *
 * Each chip carries its tint (mockup): a counted signal in slate, the LLM chip
 * by `llmChipTone`, and the uncounted context — known client, method tier —
 * neutral, so the eye lands on what the "N of 4" actually counts. Pure.
 */
export function rowChips(
  row: CoreQueueRow,
  paperCounts: Readonly<Record<string, CoreClientPaperCount>>,
  clientCwids: ReadonlySet<string>,
  mode: RailMode,
): { label: string; tone: ChipTone }[] {
  const chips: { label: string; tone: ChipTone }[] = [];
  for (const s of buildSignals(row, paperCounts, clientCwids)) {
    if (s.kind === "ack") chips.push({ label: "Acknowledged", tone: "signal" });
    else if (s.kind === "coauthor") chips.push({ label: "Staff co-author", tone: "signal" });
    else if (s.kind === "llm" && row.llmScore !== null)
      chips.push({ label: `LLM ${row.llmScore}/10`, tone: llmChipTone(row.llmScore) });
    else if (mode === "evidence") {
      const who = repeatUser(row, paperCounts, clientCwids);
      const label = who ? `Repeat user · ${displayName(who.scholar.name)}` : "Repeat user";
      chips.push({ label, tone: "signal" });
    }
  }
  if (matchesFilter(row, "client", clientCwids))
    chips.push({ label: "Client co-author", tone: "quiet" });
  if (row.methodTier) chips.push({ label: `Method ${row.methodTier}`, tone: "quiet" });
  return chips;
}

/**
 * One compact row in the middle pane: checkbox, title, meta, signal chips, band
 * and — once decided this session — its status (mockup). Clicking anywhere but
 * the checkbox focuses the paper; below `lg` that also opens the sheet. The row
 * is two siblings, a checkbox and a button, because a checkbox nested in a
 * button is not valid HTML and would swallow the row click.
 */
function QueueListRow({
  row,
  mode,
  focused,
  error,
  checked,
  onCheck,
  onOpen,
  paperCounts,
  clientCwids,
}: {
  row: CoreQueueRow;
  mode: RailMode;
  focused: boolean;
  error: string | undefined;
  checked: boolean;
  onCheck: () => void;
  onOpen: () => void;
  paperCounts: Readonly<Record<string, CoreClientPaperCount>>;
  clientCwids: ReadonlySet<string>;
}) {
  const band = likelihoodBand(row.likelihood);
  const chips = rowChips(row, paperCounts, clientCwids, mode);
  const meta = [row.journal ?? row.journalAbbrev, row.year, `PMID ${row.pmid}`]
    .filter((v) => v !== null && v !== "")
    .join(" · ");
  return (
    <li
      data-slot="core-queue-row"
      data-pmid={row.pmid}
      aria-current={focused ? "true" : undefined}
      // The spine (mockup): the row's band colour, slate when focused, none for
      // a paper sent here by PMID — it has no band to show. pl is px-3.5 less
      // the 3px spine, so titles stay aligned with the header checkbox.
      className={`border-apollo-border flex gap-2.5 border-t border-l-[3px] py-3 pr-3.5 pl-[11px] first:border-t-0 ${
        focused
          ? "bg-apollo-slate-tint border-l-apollo-slate"
          : `bg-apollo-surface ${row.queued ? "border-l-transparent" : band.spine}`
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onCheck}
        aria-label={`Select ${row.title}`}
        className="mt-1 size-4 shrink-0 accent-[var(--apollo-slate)]"
      />
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 gap-2.5 text-left focus-visible:outline-none"
      >
        <span className="min-w-0 flex-1">
          <span className="text-foreground line-clamp-2 block text-sm leading-snug">
            {displayTitle(row.title)}
          </span>
          <span className="text-muted-foreground mt-0.5 block text-xs">{meta}</span>
          {chips.length > 0 ? (
            <span className="mt-1.5 flex flex-wrap gap-1">
              {chips.map((c) => (
                <span
                  key={c.label}
                  data-tone={c.tone}
                  className={`rounded border px-[7px] py-px text-[11px] ${CHIP_TONE_CLASS[c.tone]}`}
                >
                  {c.label}
                </span>
              ))}
            </span>
          ) : null}
        </span>
        <span className="shrink-0 text-right text-[11px]">
          {row.queued ? (
            // Sent here by PMID: the reviewer's pile, not an engine verdict
            // (mockup "ADDED BY YOU" in slate, no band).
            <span className="text-apollo-slate block font-semibold tracking-[0.06em] uppercase">
              Added by you
            </span>
          ) : (
            <span
              className={`block rounded border px-[7px] py-0.5 font-medium tracking-[0.08em] whitespace-nowrap uppercase ${band.tint}`}
            >
              {band.label} {Math.round(row.likelihood * 100)}%
            </span>
          )}
          {error ? <span className="mt-1 block text-red-700">Not saved</span> : null}
        </span>
      </button>
    </li>
  );
}

/**
 * The right-hand pane: one paper in full (mockup). Everything the old card
 * showed on expand is here from the start — the evidence rows no longer hide
 * behind a disclosure, since the pane holds one paper, not a scroll of them.
 *
 * Below `lg` this is a full-screen sheet: hidden until a row is tapped, then
 * `fixed inset-0` with its own Close. At `lg` it is the sticky third pane and
 * the sheet state is ignored.
 */
function FocusedPaper({
  row,
  position,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  sheetOpen,
  onCloseSheet,
  clientCwids,
  paperCounts,
  pending,
  error,
  copied,
  onCopyPmid,
  onDecide,
  repeatAction,
}: {
  row: CoreQueueRow;
  position: string;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  sheetOpen: boolean;
  onCloseSheet: () => void;
  clientCwids: ReadonlySet<string>;
  /** Per-person confirmed-paper counts for this core (see `clientPaperCounts`). */
  paperCounts: Readonly<Record<string, CoreClientPaperCount>>;
  pending: boolean;
  error: string | undefined;
  copied: boolean;
  onCopyPmid: () => void;
  onDecide: (status: Decision, note?: string) => void;
  repeatAction: { label: string; onClick: () => void } | null;
}) {
  const likelihoodPct = Math.round(row.likelihood * 100);
  const band = likelihoodBand(row.likelihood);
  const signals = buildSignals(row, paperCounts, clientCwids);
  // A known client on the byline: evidence a reviewer weighs, but not one of the
  // four counted signals — so it gets its own uncounted row, in the words (and
  // with the staff-wins de-dup) of the client token `evidenceTokens` builds.
  const clientToken =
    evidenceTokens(row, clientCwids, paperCounts).find((t) =>
      t.label.startsWith("Client co-author"),
    ) ?? null;
  // Gated on the repeat-user row being ON SCREEN, not on the prior's own decode:
  // the affinity copy points at that row, and per-person de-duplication can drop
  // it (round 2).
  const footnote = priorFootnote(
    row.topicalPrior,
    signals.some((s) => s.kind === "affinity"),
  );
  // One chip per family (the extractor emits an entry per family+tool), and the
  // top-ranked entry's sentence as the quote. Both gated on `methodTier`, because
  // both must print it: a bare "Flow cytometry" would be the "method family
  // identified" boolean the per-family tiering exists to prevent.
  const methodFamilies = row.methodTier
    ? [...new Set(row.methodEvidence.map((m) => m.family))]
    : [];
  const methodQuote = row.methodTier
    ? (row.methodEvidence.find((m) => m.sentence)?.sentence ?? null)
    : null;
  // What the pane shows OUTSIDE the four counted signals, so the 0-signal state
  // names it instead of asserting that nothing is shown (round 2).
  const uncounted = [
    row.methodTier ? "method family" : null,
    footnote ? "prefilter prior" : null,
  ].filter((s): s is string => s !== null);
  // The meta line: FULL journal title first, the abbreviation only as a
  // fallback (owner, round 2), then the PubMed date (or the year when PubMed
  // never indexed one), then the PMID. Separators come from what survives.
  const journalLabel = row.journal ?? row.journalAbbrev;
  const addedToPubMed = formatAddedToPubMed(row.dateAddedToEntrez);
  const metaParts: Array<{ key: string; node: ReactNode }> = [];
  if (journalLabel) metaParts.push({ key: "journal", node: <span>{journalLabel}</span> });
  if (addedToPubMed) metaParts.push({ key: "added", node: <span>{addedToPubMed}</span> });
  else if (row.year !== null)
    metaParts.push({ key: "year", node: <span className="tabular-nums">{row.year}</span> });
  metaParts.push({
    key: "pmid",
    node: row.pubmedUrl ? (
      <a
        href={row.pubmedUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="text-apollo-slate inline-flex items-center gap-1 tabular-nums hover:underline"
      >
        PMID {row.pmid} <ExternalLink className="size-3" aria-hidden />
      </a>
    ) : (
      <span className="tabular-nums">PMID {row.pmid}</span>
    ),
  });
  return (
    <article
      data-slot="core-queue-focus"
      data-pmid={row.pmid}
      aria-label={`Candidate: ${row.title}`}
      className={`${
        sheetOpen ? "fixed inset-0 z-40 flex overflow-y-auto" : "hidden"
      } bg-apollo-surface lg:border-apollo-border min-w-0 flex-col gap-4 p-5 lg:sticky lg:inset-auto lg:top-4 lg:z-auto lg:flex lg:overflow-visible lg:rounded-[var(--apollo-radius-card)] lg:border lg:px-[22px] lg:py-5 lg:shadow-[var(--apollo-shadow-card)]`}
    >
      <div className="text-muted-foreground flex items-center justify-between gap-2 text-xs">
        <span>{position}</span>
        <span className="flex items-center gap-1">
          <button
            type="button"
            disabled={!hasPrev}
            onClick={onPrev}
            className="hover:text-foreground rounded-md px-2 py-1 disabled:opacity-40"
          >
            Previous
          </button>
          <button
            type="button"
            disabled={!hasNext}
            onClick={onNext}
            className="hover:text-foreground rounded-md px-2 py-1 disabled:opacity-40"
          >
            Next
          </button>
          <button
            type="button"
            onClick={onCloseSheet}
            aria-label="Close paper"
            className="border-apollo-border-strong text-foreground ml-1 inline-flex size-7 items-center justify-center rounded-md border lg:hidden"
          >
            <X className="size-4" aria-hidden />
          </button>
        </span>
      </div>

      <div>
        {row.authorAffinity === null && !row.isManual ? (
          <p className="mb-1.5">
            <span className="border-border-strong text-muted-foreground bg-apollo-surface-2 inline-block rounded border px-2 py-0.5 text-[11px]">
              No prior core usage anywhere on this byline
            </span>
          </p>
        ) : null}
        <h3 className="text-foreground text-[19px] leading-snug font-medium text-pretty">
          {displayTitle(row.title)}
        </h3>
        <div className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[13px]">
          {metaParts.map((part, i) => (
            <span key={part.key} className="inline-flex items-center gap-1.5">
              {i > 0 ? (
                <span className="text-muted-foreground/60" aria-hidden>
                  ·
                </span>
              ) : null}
              {part.node}
            </span>
          ))}
          <button
            type="button"
            onClick={onCopyPmid}
            title={copied ? "PMID copied" : "Copy PMID"}
            aria-label={copied ? "PMID copied" : "Copy PMID"}
            className="border-border-strong text-muted-foreground hover:text-foreground bg-apollo-surface-2 inline-flex size-5 items-center justify-center rounded border"
          >
            {copied ? (
              <Check className="size-3 text-emerald-600" aria-hidden />
            ) : (
              <Copy className="size-3" aria-hidden />
            )}
          </button>
        </div>
        <Byline row={row} clientCwids={clientCwids} />
        {row.synopsis ? (
          <p className="bg-apollo-surface-2 mt-2.5 rounded-lg px-3 py-2 text-[13px] leading-snug text-[var(--evidence-body)]">
            {row.synopsis}
          </p>
        ) : null}
      </div>

      <div
        data-slot="core-queue-meter"
        // Band-tinted (mockup), so the verdict and the Confirm/Reject it informs
        // read as one block; a paper sent here by PMID has no band to tint by.
        className={`flex flex-wrap items-center gap-3 rounded-[10px] border px-3.5 py-3 ${
          row.queued ? "bg-apollo-surface-2 border-transparent" : band.tint
        }`}
      >
        {row.queued ? (
          // Sent to review by PMID (mockup): no band and no bar. The engine
          // either never scored it or scored it below the queue's threshold,
          // and neither is a verdict to show a reviewer as one.
          <div className="min-w-0 flex-[1_1_140px]">
            <div
              className="text-apollo-slate text-[11px] font-semibold tracking-[0.04em] uppercase"
              data-slot="core-queue-score"
            >
              Added by you
            </div>
            <div className="text-muted-foreground mt-1 text-xs">
              {row.isManual
                ? "Not scored by the engine · added by PMID"
                : `Below the engine threshold · ${signals.length} of ${SIGNAL_COUNT} signals fired`}
            </div>
          </div>
        ) : (
          <div className="min-w-0 flex-[1_1_140px]">
            <div
              className="text-[11px] font-semibold tracking-[0.08em] uppercase"
              data-slot="core-queue-score"
            >
              {band.label} {likelihoodPct}%
            </div>
            <span className="bg-apollo-surface mt-1.5 block h-1 overflow-hidden rounded-full">
              <span
                className={`block h-full rounded-full ${band.fill}`}
                style={{ width: `${likelihoodPct}%` }}
              />
            </span>
            <div className="text-muted-foreground mt-1 text-xs">
              {signals.length} of {SIGNAL_COUNT} signals fired
            </div>
          </div>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={() => onDecide("claimed")}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-[var(--color-accent-slate)] px-3.5 text-sm font-medium text-white disabled:opacity-50"
          >
            <Check className="size-3.5" aria-hidden /> Confirm
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => onDecide("rejected")}
            className="border-border-strong text-foreground bg-background inline-flex h-9 items-center gap-1.5 rounded-md border px-3.5 text-sm disabled:opacity-50"
          >
            <X className="size-3.5" aria-hidden /> Reject
          </button>
        </div>
        <div
          role="group"
          aria-label="Reject with a reason"
          className="text-muted-foreground flex basis-full flex-wrap items-center gap-1.5 text-xs"
        >
          <span>Reject with a reason:</span>
          {REJECT_REASONS.map((reason) => (
            <button
              key={reason}
              type="button"
              disabled={pending}
              onClick={() => onDecide("rejected", reason)}
              className="border-apollo-border-strong bg-apollo-surface text-foreground rounded-full border px-2.5 py-0.5 disabled:opacity-50"
            >
              {reason}
            </button>
          ))}
        </div>
      </div>
      {error ? (
        <p className="-mt-2 text-xs text-red-600" role="alert">
          Could not save: {error}
        </p>
      ) : null}

      <div>
        <p className="text-muted-foreground mb-1 text-[11px] tracking-[0.1em] uppercase">
          Why this surfaced
        </p>
        {row.isManual ? (
          <p
            data-slot="core-queue-added-note"
            className="bg-apollo-surface-2 rounded-lg px-3 py-2.5 text-[12.5px] leading-relaxed text-[var(--evidence-body)]"
          >
            You added this paper by PMID. The engine never scored it for this core, so there is no
            evidence to show; judge it on the paper.
          </p>
        ) : signals.length === 0 ? (
          <p className="bg-apollo-amber-tint border-apollo-amber-tint-border text-apollo-amber rounded-lg border px-3 py-2.5 text-[12.5px] leading-relaxed">
            {/* "counted", not "labelled": the paper can carry labels this list
                does not count — a method family is chipped and quoted on the
                very same pane. So the ending names whatever IS on screen. */}
            No counted signal.{" "}
            {uncounted.length > 0
              ? `The ${uncounted.join(" and ")} on this card ${uncounted.length > 1 ? "are" : "is"} all it carries; judge it on the paper.`
              : "The score moved on engine inputs this queue doesn’t show; judge it on the paper."}
          </p>
        ) : (
          <ul aria-label="evidence">
            {signals.map((s) => (
              <SignalRow
                key={s.kind}
                signal={s}
                row={row}
                paperCounts={paperCounts}
                clientCwids={clientCwids}
                action={s.kind === "affinity" ? repeatAction : null}
              />
            ))}
          </ul>
        )}
        {clientToken ? (
          <div
            data-slot="core-queue-client-row"
            className="border-apollo-border grid grid-cols-[minmax(0,170px)_minmax(0,1fr)] items-start gap-3.5 border-t py-3"
          >
            <div>
              <div className="text-foreground text-[13px] leading-tight font-medium">
                {clientToken.label}
              </div>
              <div className="text-muted-foreground mt-1 text-xs">Known client · not counted</div>
            </div>
            <div className="text-foreground min-w-0 text-[13px] leading-normal font-medium">
              {clientToken.value}
            </div>
          </div>
        ) : null}
        {row.methodTier ? (
          // Deliberately NOT an <li> in the evidence list and NOT in
          // `buildSignals`: the method family is weighted 0.00 in the engine's
          // combine.WEIGHTS and 63% of tiered rows are "weak", where the measured
          // lift inverts to BELOW background. Shown in full, always with its
          // tier, never counted toward SIGNAL_COUNT.
          <div
            data-slot="core-queue-methods"
            className="border-apollo-border grid grid-cols-[minmax(0,170px)_minmax(0,1fr)] items-start gap-3.5 border-t py-3"
          >
            <div>
              <div className="text-foreground text-[13px] leading-tight font-medium">
                Methods used
              </div>
              <div className="text-muted-foreground mt-1 text-xs">
                {row.methodTier} · context only
              </div>
            </div>
            <div className="flex min-w-0 flex-col gap-2">
              <p className="flex flex-wrap gap-1">
                {methodFamilies.map((f) => (
                  <span
                    key={f}
                    className="border-apollo-slate-tint-border bg-apollo-slate-tint text-apollo-slate inline-block rounded-full border px-2 py-0.5 text-xs"
                  >
                    {f}
                  </span>
                ))}
              </p>
              {methodQuote ? (
                <blockquote className="border-apollo-border-strong border-l-2 pl-2.5 text-[13px] leading-normal text-[var(--evidence-body)]">
                  “{methodQuote}”
                </blockquote>
              ) : null}
              <p className="text-muted-foreground text-xs leading-relaxed">
                {row.methodTier} method match — what the paper did, not whether this core did it
              </p>
            </div>
          </div>
        ) : null}
        {footnote ? (
          <p className="text-muted-foreground mt-2 text-[12px] leading-relaxed italic">
            {footnote}
          </p>
        ) : null}
      </div>
    </article>
  );
}

/** One fired signal: label + strength glyphs on the left, the evidence itself on
 *  the right (a value line, a plain-language detail, and the quote when the run
 *  captured one), and an optional link-style action under it (the repeat-user
 *  row's "Review all N papers by X"). */
function SignalRow({
  signal,
  row,
  paperCounts,
  clientCwids,
  action = null,
}: {
  signal: Signal;
  row: CoreQueueRow;
  paperCounts: Readonly<Record<string, CoreClientPaperCount>>;
  /** The same set `buildSignals` de-duplicated against — without it this row
   *  would name a person the pane's other rows already name. */
  clientCwids: ReadonlySet<string>;
  action?: { label: string; onClick: () => void } | null;
}) {
  let label: string;
  let value: string | null = null;
  let detail: ReactNode = null;
  let quote: string | null = null;
  switch (signal.kind) {
    case "ack":
      label = row.ackAlias ? "Named in the acknowledgments" : "Acknowledged in text";
      if (row.ackSnippet) quote = row.ackSnippet;
      else if (row.ackAlias) detail = `Matched “${row.ackAlias}” in the full text`;
      break;
    case "coauthor":
      label = "Staff co-author";
      value = plural(row.coauthors.length, "person", "people");
      detail = <CoauthorDetail row={row} />;
      break;
    case "llm":
      label = "LLM read of title and abstract";
      // The dense triage score stays visible: it is the only place a reviewer
      // can see HOW strongly the model read the paper, and the band word above
      // is about the combined score, not this one.
      value = `${row.llmScore}/10`;
      detail = row.llmRationale;
      break;
    case "affinity": {
      label = "Repeat user";
      const who = repeatUser(row, paperCounts, clientCwids);
      if (who) {
        // The person's OWN counts, not the engine's scalar: `repeatUser` derives
        // both the name and these numbers from the same query, so the sentence
        // can be read as one fact. "last three years" tracks RECENT_PAPER_YEARS
        // (lib/api/core-clients.ts) — spelt out because the row is prose; if that
        // window moves, this word moves with it.
        value = plural(who.counts.papers, "confirmed paper");
        const dept = who.scholar.dept ? `, ${who.scholar.dept}` : "";
        const recent =
          who.counts.recent > 0 ? `, ${who.counts.recent} in the last three years` : "";
        // Through `displayName`, like the byline, the card and the strip: the
        // curated collision suffix already CARRIES a department, so the raw name
        // printed it twice in one sentence — "Alessandro Fichera - Surgery,
        // Surgery. 18 of their 29 publications...".
        detail = `${displayName(who.scholar.name)}${dept}. ${who.counts.papers} of their ${plural(who.counts.total, "publication")} ${who.counts.papers === 1 ? "is" : "are"} confirmed work with this core${recent}.`;
      } else {
        // Nobody on the byline has a confirmed paper here, so there is no name to
        // print and no derived count to print it with. Fall back to what the
        // engine actually published — a RATE post-ReciterAI #382, not a capped
        // strength, which is why the copy says what the percentage is a share OF:
        // a bare number next to "Weak" reads as a regression when the same paper
        // drops from 85% to 6%.
        value = `${Math.round((row.authorAffinity ?? 0) * 100)}%`;
        detail =
          "The largest share of any byline author's own publications that are work with this core";
      }
      break;
    }
  }
  return (
    <li className="border-apollo-border grid grid-cols-[minmax(0,170px)_minmax(0,1fr)] items-start gap-3.5 border-t py-3">
      <div>
        <div className="text-foreground text-[13px] font-medium leading-tight">{label}</div>
        <div className="mt-1 flex items-center gap-1.5">
          <StrengthGlyphs dots={signal.dots} />
          <span className="text-muted-foreground text-[11px]">{signal.strength}</span>
        </div>
      </div>
      <div className="min-w-0">
        {value ? (
          <div className="text-foreground text-[12.5px] font-semibold">{value}</div>
        ) : null}
        {detail ? (
          <div className="text-muted-foreground text-[12.5px] leading-relaxed">{detail}</div>
        ) : null}
        {quote ? (
          <blockquote className="border-border-strong bg-apollo-lock-bg text-foreground mt-1.5 rounded-r-md border-l-2 px-2.5 py-2 text-[12.5px] leading-relaxed">
            “<QuoteWithAlias text={quote} alias={row.ackAlias} />”
          </blockquote>
        ) : null}
        {action ? (
          <button
            type="button"
            onClick={action.onClick}
            className="text-apollo-slate mt-1.5 text-[13px] hover:underline"
          >
            {action.label}
          </button>
        ) : null}
      </div>
    </li>
  );
}

/** The acknowledgment quote with the matched alias highlighted in place — the
 *  alias is not restated above the quote, so the highlight IS the match. */
function QuoteWithAlias({ text, alias }: { text: string; alias: string | null }) {
  const at = alias ? text.toLowerCase().indexOf(alias.toLowerCase()) : -1;
  if (!alias || at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="bg-apollo-amber-tint text-foreground rounded-sm font-semibold">
        {text.slice(at, at + alias.length)}
      </mark>
      {text.slice(at + alias.length)}
    </>
  );
}

/** The staff co-author detail line — linked scholars plus any bare CWIDs. The
 *  department follows the name behind a COMMA, not in parentheses: the mockup
 *  reads this row as "1 person / Evan Sholle, Information Technologies &
 *  Services", and the parenthesised form made the department look like an aside
 *  rather than half of the identification. */
function CoauthorDetail({ row }: { row: CoreQueueRow }) {
  const resolved = row.coauthorScholars;
  const resolvedSet = new Set(resolved.map((s) => s.cwid.toLowerCase()));
  const unresolved = row.coauthors.filter((c) => !resolvedSet.has(c.toLowerCase()));
  if (resolved.length === 0) {
    return (
      <>
        <span className="font-mono text-[12px]">{unresolved.join(", ")}</span> — no Scholar profile
        yet, showing CWID
      </>
    );
  }
  return (
    <>
      {resolved.map((s, i) => (
        <span key={s.cwid}>
          {i > 0 ? "; " : ""}
          <ScholarLink scholar={s} />
          {s.dept ? <span className="text-muted-foreground">, {s.dept}</span> : null}
        </span>
      ))}
      {unresolved.length > 0 ? <span>; {unresolved.join(", ")}</span> : null}
    </>
  );
}

/** Initials for the hovercard avatar: first + last NAME token, so "Samprit
 *  Banerjee" reads "SB" and a single-token collective author reads one letter.
 *  Via `nameWords`, because a curated disambiguation suffix is not part of
 *  anyone's initials — "Alessandro Fichera - Surgery" is AF, not AS. Pure. */
export function initialsOf(name: string): string {
  const parts = nameWords(name);
  if (parts.length === 0) return "?";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : "";
  return (first + last).toUpperCase();
}

/** Why a byline name carries a card. Every resolvable WCM author gets one; the
 *  role is what the card's last line says about them. */
type PersonRole = "staff" | "client" | "wcm";

/**
 * The byline hovercard: avatar initials, full name + CWID, department, and the
 * one line that says WHY this name is marked — "Core staff", "Known client of
 * this core", or, for every other resolvable WCM author, that they are NEITHER.
 * That role line is the whole point of the card; without it a reviewer sees a
 * highlighted name and has to guess which signal it belongs to.
 *
 * The `wcm` role exists because the card used to mount on core staff and known
 * clients only: measured on staging, 29 of the page's 3,497 byline anchors
 * carried one, so a reviewer hovering essentially any name got nothing and
 * reasonably read hover as broken (round 2, item 1). Its line must not imply
 * core usage — a WCM colleague on this byline is a person we can identify, not
 * evidence about this paper, and the whole point of naming the role is that the
 * card never asserts more than it knows.
 *
 * `HoverCard` (not `HoverTooltip`) because the content is a small record, not a
 * sentence — a tooltip's single text line cannot carry four fields.
 *
 * TOUCH: Radix's HoverCardTrigger preventDefaults `touchstart`, which on iOS
 * cancels the synthesized click — a wrapped name would highlight and then do
 * nothing when tapped. The fix is #2588's, verbatim (see `matcha-tab.tsx`): the
 * NAME ITSELF carries `onTouchEnd` — the one trigger event Radix leaves alone —
 * and re-issues the click the browser was denied, so the anchor's own href and
 * target stay the single source of truth. `composeEventHandlers` cannot opt out
 * of Radix's preventDefault; there is no un-prevent.
 */
function PersonHoverCard({
  scholar,
  role,
  children,
}: {
  scholar: QueueScholar;
  role: PersonRole;
  children: ReactNode;
}) {
  return (
    <HoverCard>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent className="w-auto max-w-[19rem] p-4" data-slot="core-queue-person-card">
        <div className="flex items-start gap-3">
          <Avatar>
            <AvatarFallback className="text-[11px] font-medium">
              {initialsOf(scholar.name)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="text-foreground text-sm font-semibold">
              {displayName(scholar.name)}{" "}
              <span className="text-muted-foreground font-normal">({scholar.cwid})</span>
            </p>
            {scholar.dept ? (
              <p className="text-muted-foreground mt-0.5 text-sm">{scholar.dept}</p>
            ) : null}
            <p className="text-foreground mt-2 text-sm">
              {role === "staff"
                ? "Core staff"
                : role === "client"
                  ? "Known client of this core"
                  : "WCM co-author on this paper — not core staff, and not a known client of this core"}
            </p>
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

/**
 * The words of a Scholar's `preferredName` that are actually the name:
 * everything up to and including the surname, lowercased, with the trailing
 * curated collision suffixes dropped — "Alessandro Fichera - Surgery" (#2049),
 * "Jane Doe (Radiology)" (#2214), plus a generational "John Smith III".
 * Untreated, those scholars registered the DEPARTMENT as their surname key
 * ("surgery", "fichera - surgery", never "fichera"), so their byline token could
 * never be expanded or carded — a live counterexample to "every WCM author is
 * expanded", and the reason the avatar read "AS" for Alessandro Fichera.
 *
 * `extractLastNameSort` already strips all three forms and is dependency-free.
 * Its anchor is LOCATED in the word list rather than used on its own, so a
 * compound surname's leading words survive. A name whose punctuation stops the
 * anchor being found falls back to the raw words, which is what this did before.
 *
 * THE ANCHOR MUST NOT BE THE FIRST WORD, and that is not a nicety: the suffix
 * list behind `extractLastNameSort` counts "V", "VI" and "I" as generational, so
 * it reads "Hoang Vi" as the surname "hoang" — leaving one word, from which the
 * key loop below registers NO keys at all and the avatar reads "H". Every Vi,
 * Anh V and Tran I on the roster became permanently unexpandable and uncardable.
 * A generational suffix on a two-word name is not a suffix.
 *
 * NOT for a PubMed byline token: that suffix list treats "I" and "V" as
 * generational, which would swallow the initials of every Ivanova and Volkov.
 * See `BYLINE_SUFFIX`.
 */
function nameWords(name: string): string[] {
  const words = name.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const at = words.lastIndexOf(extractLastNameSort(name));
  return at >= 1 ? words.slice(0, at + 1) : words;
}

/**
 * The name as the byline and its card PRINT it. The curated collision suffixes
 * are a disambiguation device for a roster listing, not part of anybody's name:
 * unstripped, the byline read "Alessandro Fichera - Surgery, Other B" and the
 * card printed the department twice, once inside the name and once on the
 * department line under it. Falls back to the raw name because a name that is
 * ENTIRELY a parenthetical strips to "" (`stripUnitDisambiguation`'s contract).
 */
function displayName(name: string): string {
  return stripUnitDisambiguation(name) || name;
}

/**
 * Generational suffixes as PUBMED writes them, which is not how `NAME_SUFFIXES`
 * in `lib/name-sort.ts` writes them: PubMed normalises the numerals to
 * "Anderson JW 3rd", never "III", and its roman-numeral entries ("I", "V", "VI")
 * are indistinguishable from a real first initial — reusing that list here would
 * refuse to expand every "Ivanova I" and "Volkov V" on the page. None of these
 * can be an initials group, so this list is the safe half of that one.
 *
 * CASE-SENSITIVE, AND TESTED AGAINST THE RAW WORD. Case is the ONLY thing that
 * separates the suffix "Jr" from the initials group "JR", and the loop below
 * used to lowercase the token before testing — destroying the one signal, which
 * cut both ways on the same line: "Garcia Martinez SR" lost "SR" and matched
 * Maria Garcia off the leading word, while "Smith JR" lost its whole initials
 * group and could not reach James Smith at all.
 */
const BYLINE_SUFFIX = /^(Jr|Sr|2nd|3rd|4th)\.?$/;

/**
 * An initials group as PubMed writes it: 1-3 UPPER-CASE letters ("S", "ET",
 * "JW"), which is also raw-cased for the reason above. The token loop used to
 * assume its last word WAS the initials with no check at all, so any two-word
 * token whose second word is a real word looked its FIRST word up as a surname:
 * "Wang Xiaoming" reached the scholar Xin Wang (initial "x", key "wang") and
 * "Kim Group" reached Gina Kim — each renamed, linked and carded as a person
 * who is not that author. A token with no initials group has no first initial
 * to agree with, so it must claim nobody.
 *
 * `\p{Lu}` rather than `[A-Z]` so an accented initial ("Á") is still an initial.
 *
 * THREE IS A DELIBERATE UNDER-MATCH, and it costs us real authors. This repo's
 * own `deriveInitials` (etl/reciter/index.ts) emits ONE LETTER PER GIVEN-NAME
 * PART, so "Maria de los Angeles Rodriguez" composes the token "Rodriguez MDLA"
 * and is left in PubMed form here. Widening to five was tried and reverted: an
 * all-caps given name ("Kim JOHN") is the SAME SHAPE as a four-letter initials
 * group, so the wider class resolved "Kim JOHN" to the scholar Jane Kim — a
 * card asserting the wrong person's CWID and department. Across this whole
 * matcher a missed expansion is an acceptable cost and a wrong name is not, so
 * the cap stays where the ambiguity starts. Raise it only alongside a signal
 * that actually separates the two, not a longer length.
 */
const BYLINE_INITIALS = /^\p{Lu}{1,3}$/u;

/**
 * Lower-case and strip combining marks, so a PubMed byline that dropped the
 * diacritics still reaches the scholar who carries them: "Nino de Rivera S"
 * against "Sara Niño de Rivera". Applied to BOTH sides — the key map and the
 * token's lookup phrase — and to the first-initial comparison, so it is a
 * normalisation and not a fallback: the token still looks up its COMPLETE
 * surname phrase and nothing shorter. Two scholars who differ only by a
 * diacritic now share a key, which `ambiguous` already refuses to resolve.
 */
function foldName(word: string): string {
  return word.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
}

/**
 * Author byline with EVERY resolvable WCM author named in full, linked and
 * carded, and core staff additionally highlighted as a tinted chip — the
 * connection back to the co-author evidence row below.
 * ponytail: best-effort surname match against the flat `authorsString` (the data
 * carries no per-author byline token; this mirrors how profile author-links are
 * overlaid). Unresolved core-staff CWIDs aren't in the byline, so they show only
 * in the evidence row.
 *
 * The byline is therefore MIXED by construction, and the owner accepted that:
 * `publication_author` has rows only for matched WCM authors and its
 * `external_name` is NULL on every row, so there is no stored full name for a
 * non-WCM author anywhere in SPS. They keep the PubMed form because it is the
 * only form we hold.
 */
function Byline({
  row,
  clientCwids = new Set<string>(),
}: {
  row: CoreQueueRow;
  /** The core's known-client CWIDs (lowercased) — a client's card reads "Known
   *  client of this core" instead of the plain WCM co-author line. */
  clientCwids?: ReadonlySet<string>;
}) {
  if (!row.authorsString) return null;
  // `authors_string` marks WCM authors with `((…))`. STRIP BEFORE ANYTHING ELSE.
  // Two bugs rode on not doing it, measured on core 14's live queue (1,453 rows):
  //   - the markup printed raw on 70.4% of rows ("((Traube C))" on screen);
  //   - the staff highlight below matches on the token's LEADING words, which for
  //     a marked author start "((traube", never the surname — so the highlight could
  //     not fire for exactly the authors it exists to mark. Core staff are WCM,
  //     so they are the authors most likely to carry the marker.
  const authors = stripWcmMarkers(row.authorsString);
  // The truncated preview silently drops authors on 68.4% of those rows (worst
  // case 413). Same `+ N more` suffix #2581 put on the topic feed.
  const dropped = droppedAuthorCount(row.authorsString, row.fullAuthorsString);
  // Rendered as its own node, NOT appended to the author text: ", +2 more" is a
  // count of names withheld, and a reader scanning a comma-separated byline
  // reads a bare trailing " + 2 more" as one more author.
  const more =
    dropped > 0 ? (
      <span className="text-muted-foreground/80 whitespace-nowrap">
        , +{dropped} more
      </span>
    ) : null;
  // Surname phrase -> the scholar we can name in full. Core staff FIRST so they
  // win a collision: their chip is the link back to the co-author evidence row,
  // and a plain WCM link there would break that connection.
  //
  // MULTI-WORD SURNAMES: each scholar registers their last word, last two and
  // last three, so a compound surname is reachable whole — PubMed writes
  // "Niño de Rivera S", and keying the scholar "Sara Niño de Rivera" on "rivera"
  // alone left exactly the authors whose names most need expanding unmatched
  // (round 2, item 3). Three words is where real compound surnames stop; the
  // loop also stops one short of the whole name, so a first name can never
  // become a surname key.
  //
  // ONLY THE SCHOLAR SIDE SLICES. A token looks up its COMPLETE surname phrase
  // and nothing shorter (see the token loop). Two consecutive rounds tried to
  // widen the match with a fallback to the phrase's shorter tails, and both
  // produced the same brand-new false positive: "Perez Garcia M" fell through to
  // a one-word key — "perez" in one build, "garcia" in the next — and was
  // renamed, linked and CARDED as an unrelated Maria. A shorter tail of a
  // compound surname is a DIFFERENT surname. Registering the scholar's last
  // one, two and three words is what makes "van der Berg J" reach Jan van der
  // Berg; a fallback on the token side is not needed for it and never was.
  //
  // `ambiguous` holds phrases claimed by more than one scholar IN THIS ROW'S OWN
  // LISTS. Those tokens are left exactly as PubMed wrote them: on a "Kim J /
  // Kim S" byline a surname-only match would print ONE person's full name over
  // BOTH tokens, which is worse than leaving the PubMed form alone. First-initial
  // agreement is required for the same reason. A phrase nothing looks up costs
  // nothing to mark ambiguous. It cannot see a namesake who is NOT in these
  // lists, which is every non-WCM one — that is what the second pass below is
  // for, and why it has to run on the tokens rather than here.
  const known = new Map<string, { scholar: QueueScholar; isStaff: boolean }>();
  const ambiguous = new Set<string>();
  for (const [list, isStaff] of [
    [row.coauthorScholars, true],
    [row.wcmAuthors, false],
  ] as const) {
    for (const sch of list) {
      const words = nameWords(sch.name).map(foldName);
      // `Math.max(1, …)` because a ONE-WORD preferredName ("Sukarno") made this
      // `Math.min(3, 0)` and registered NO keys at all: the loop body never ran,
      // so mononymous scholars were silently unreachable, unlinkable and
      // uncardable. The `length - 1` is still what stops a first name becoming a
      // surname key on every longer name.
      for (let n = 1; n <= Math.min(3, Math.max(1, words.length - 1)); n++) {
        const key = words.slice(-n).join(" ");
        const held = known.get(key);
        if (!held) known.set(key, { scholar: sch, isStaff });
        // Lowercased on both sides, as every other CWID comparison in this
        // feature is: a case difference between the two lists would otherwise
        // read as two people and mark a phrase ambiguous that only one holds.
        else if (held.scholar.cwid.toLowerCase() !== sch.cwid.toLowerCase())
          ambiguous.add(key);
      }
    }
  }
  if (known.size === 0) {
    return (
      <p className="text-muted-foreground mt-1 text-xs" data-slot="core-queue-byline">
        {authors}
        {more}
      </p>
    );
  }
  const tokens = authors.split(", ");
  // PASS 1 — who each token names, or `undefined` for one we leave exactly as
  // PubMed wrote it. Resolved up front because pass 2 has to see every token's
  // answer before any of them is rendered.
  const resolveToken = (tok: string) => {
    // "Sholle ET" -> "e", "Niño de Rivera S" -> "s"; a PubMed byline puts the
    // initials LAST, so everything before them is the surname phrase. A
    // one-word token (a collective author) leaves no initial and no surname,
    // and never claims a scholar. A generational suffix is dropped first
    // because it is not the initials group: "Smith AB Jr" reads its initial
    // off "AB". Left in, it took the initial off "Jr" — "j", which agrees
    // with every John Smith on the roster and renamed, linked and carded the
    // token as him — and it pushed "ab" onto the end of the surname phrase,
    // so the real A.B. Smith could not be reached either.
    //
    // SPLIT RAW, and only fold to the lookup form afterwards: both the suffix
    // strip and the initials test read UPPER-CASE as the thing that says "this
    // is an initials group, not a word". Lowercasing first threw that away.
    const raw = tok
      .trim()
      .split(/\s+/)
      .filter((w) => w && !BYLINE_SUFFIX.test(w));
    // The trailing block has to LOOK like initials before it is treated as
    // them; otherwise the token carries no initials at all and, having nothing
    // to agree with, claims nobody. See `BYLINE_INITIALS`.
    const tail = raw.length > 1 ? raw[raw.length - 1] : "";
    const initial = BYLINE_INITIALS.test(tail) ? foldName(tail[0]) : "";
    // The token's COMPLETE surname phrase, and NOTHING SHORTER — see the key map
    // above for why there is no fallback here.
    const key = raw.slice(0, -1).map(foldName).join(" ");
    const hit = known.get(key);
    // On an ambiguous phrase we do not know WHICH person this token is, so it
    // resolves to nobody and keeps the PubMed form: no rename, no card, and —
    // round 2, item 1b — no LINK either. A link is an assertion too, and the one
    // it used to make was wrong by construction: it pointed at whichever
    // colliding scholar was inserted into `known` first.
    if (!hit || initial.length === 0 || ambiguous.has(key)) return undefined;
    if (foldName(hit.scholar.name.trim()[0] ?? "") !== initial) return undefined;
    // A truncated row (see `wcmAuthorsTruncated`) is the same doubt one step
    // back: `wcmAuthors` is only a PREFIX of the byline, so `ambiguous` was
    // built from an incomplete population and a second holder of this surname
    // past the cap is invisible. CHOSEN: refuse the WCM half of `known` on
    // those rows — the token keeps the PubMed form rather than assert one
    // specific person's name, CWID and department.
    //
    // Core staff are the deliberate exception, and NOT because the cap is
    // harmless to them — a hidden namesake could be theirs too. It is that the
    // cap does not touch what identifies them: `coauthorScholars` is uncapped
    // and independent, so the card names a person we know for certain is a WCM
    // co-author of THIS paper, and the worst the cap can do is tint the wrong
    // one of two identically written tokens (pass 2 catches that whenever both
    // are on screen). Against that, the chip is the byline's only link back to
    // the co-author evidence row, and big-consortium papers — the only ones that
    // truncate — are exactly where a reviewer needs it most.
    if (row.wcmAuthorsTruncated && !hit.isStaff) return undefined;
    return hit;
  };
  const hits = tokens.map(resolveToken);
  // PASS 2 — a scholar claimed by MORE THAN ONE token identifies NEITHER of
  // them. "Kim J, Kim J, Doe A" with one WCM Jane Kim on the row printed her
  // name, her link and her card over BOTH Kim tokens; two same-surname,
  // same-initial tokens cannot be one person, so at least one of those cards
  // stated the wrong CWID and department.
  // `ambiguous` cannot catch this and never could: it is built from `known`, and
  // `publication_author` holds rows ONLY for matched WCM authors — so the
  // namesake who makes the byline ambiguous is, whenever they are not WCM,
  // absent by construction from every list this component receives. The
  // duplicate is only visible on the TOKEN side, after resolution.
  //
  // SWEEPS BOTH POPULATIONS, AND UNIONS THEM. The preview drops authors on
  // 68.4% of core 14's rows, so a namesake past the cut is invisible to a
  // preview-only sweep and the one visible "Kim J" gets renamed, linked and
  // carded as a specific person — on nothing but where PubMed happened to cut.
  // `wcmAuthorsTruncated` does not cover it: that fires on 12 DISTINCT WCM
  // authors, and the row this was found on had exactly one.
  //
  // But the full list cannot REPLACE the preview either, which is the trap the
  // first attempt fell into. `authors_string` and `full_authors_string` come
  // from two different producers — the former is ReCiterDB's pre-composed
  // `analysis_summary_author.authors`, the latter is composed here by
  // `composeAuthorString` — so neither is a subset of the other. An author whose
  // given name is null composes to a BARE surname, a one-word token this
  // resolver deliberately refuses, so a namesake VISIBLE twice on screen can be
  // absent from the full list. Sweeping only the full list then restored the
  // original defect with cards attached. A person is overclaimed when EITHER
  // population shows them more than once.
  const countByCwid = (list: ReadonlyArray<ReturnType<typeof resolveToken>>) => {
    const n = new Map<string, number>();
    for (const hit of list) {
      if (!hit) continue;
      const cwid = hit.scholar.cwid.toLowerCase();
      n.set(cwid, (n.get(cwid) ?? 0) + 1);
    }
    return n;
  };
  const overclaimed = new Set<string>();
  for (const counts of [
    countByCwid(hits),
    // Split the way `countAuthorTokens` does, not on a literal ", " — the two
    // disagreeing meant a namesake written "Doe A,Kim J" merged into its
    // neighbour and the sweep never saw it.
    countByCwid(
      row.fullAuthorsString
        ? stripWcmMarkers(row.fullAuthorsString).split(/,\s*/).map(resolveToken)
        : [],
    ),
  ]) {
    for (const [cwid, n] of counts) if (n > 1) overclaimed.add(cwid);
  }
  return (
    <p className="text-muted-foreground mt-1 text-xs" data-slot="core-queue-byline">
      {tokens.map((tok, i) => {
        const hit = hits[i];
        if (!hit || overclaimed.has(hit.scholar.cwid.toLowerCase()))
          return <span key={i}>{i > 0 ? ", " : ""}{tok}</span>;
        // Staff wins over client when a person is both: the tinted chip is the
        // link back to the co-author evidence row, and demoting it to a plain
        // client link would break that connection (same reason staff win the
        // surname collision above). Everyone else we could identify is `wcm` —
        // every name that survives to here is one we are sure of, so every one
        // of them gets a card (round 2, item 1a).
        const role: PersonRole = hit.isStaff
          ? "staff"
          : clientCwids.has(hit.scholar.cwid.toLowerCase())
            ? "client"
            : "wcm";
        // Full display name: we know WHICH person this token is. Through
        // `displayName`, because the curated collision suffix is a roster
        // device, not part of the name — unstripped this byline read
        // "Alessandro Fichera - Surgery, Other B".
        const label = displayName(hit.scholar.name);
        const nameNode = hit.scholar.slug ? (
          <a
            href={`/${hit.scholar.slug}`}
            target="_blank"
            rel="noopener noreferrer"
            // See PersonHoverCard: on iOS the hover trigger eats this anchor's
            // own click. Every name that reaches here carries a card now, so
            // this is the only thing keeping the profile link tappable.
            onTouchEnd={(e) => {
              e.preventDefault();
              e.currentTarget.click();
            }}
            className={
              role === "staff"
                ? "bg-[var(--color-accent-slate)]/15 text-[var(--color-accent-slate)] rounded px-1 py-px font-medium hover:underline"
                : role === "client"
                  ? // A client is marked in the byline itself, not only by a card
                    // a touch user can never open: without this it renders
                    // identically to any other WCM co-author and the marking is
                    // invisible exactly where hover does not exist.
                    "text-[var(--color-accent-slate)] underline decoration-dotted underline-offset-2"
                  : // Slate is the shared "this name carries a card" colour. A
                    // byline token we could NOT identify never gets it — it keeps
                    // the paragraph's muted grey — so the colour, not the hover,
                    // tells a reviewer which names are worth pointing at.
                    "text-[var(--color-accent-slate)] hover:underline"
            }
          >
            {label}
          </a>
        ) : (
          <span
            className={
              role === "staff"
                ? "bg-[var(--color-accent-slate)]/15 text-[var(--color-accent-slate)] rounded px-1 py-px font-medium"
                : // ED-only: no profile to link, so NOT slate — that colour reads
                  // as a link everywhere else on this line. The dotted underline
                  // is what marks the card, for a client and a plain WCM
                  // co-author alike; the card itself says which they are.
                  "text-foreground underline decoration-dotted underline-offset-2"
            }
          >
            {label}
          </span>
        );
        return (
          <span key={i}>
            {i > 0 ? ", " : ""}
            <PersonHoverCard scholar={hit.scholar} role={role}>
              {nameNode}
            </PersonHoverCard>
          </span>
        );
      })}
      {more}
    </p>
  );
}

/** Link to a scholar's public profile (`/{slug}`), opening in a new tab.
 *  Through `displayName`, like the byline and the person card: the curated
 *  collision suffix is a roster disambiguation device, so the co-author detail
 *  row printed "Alessandro Fichera - Surgery" with the department beside it. */
function ScholarLink({ scholar }: { scholar: QueueScholar }) {
  // ED-only staff (no Scholar row) have no profile to link to — name only.
  if (!scholar.slug) return <span className="text-foreground">{displayName(scholar.name)}</span>;
  return (
    <a
      href={`/${scholar.slug}`}
      target="_blank"
      rel="noopener noreferrer"
      className="text-foreground hover:underline"
    >
      {displayName(scholar.name)}
    </a>
  );
}
