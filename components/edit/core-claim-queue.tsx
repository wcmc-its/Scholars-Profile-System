"use client";

/**
 * Per-core review queue (the owner surface at /edit/core/[coreId]/review).
 *
 * Ranked candidate rows with a band+percent score readout, a one-line evidence
 * summary that expands into the per-signal breakdown, and per-row actions that
 * POST to /api/edit/core-claim with optimistic local state. A confirm/reject
 * removes the row from the "To review" list; a confirm lifts it into the
 * "Confirmed" list.
 *
 * Layout follows the core-claim-queue artboard (direction A, queue variant):
 *   - the score reads as a BAND WORD + percent ("Strong 94%"), never a labelled
 *     "Combined likelihood" bar. Bands are Strong >= 0.85, Moderate >= 0.65,
 *     Slight >= 0.40, else Weak;
 *   - rows group by which KINDS of evidence fired, with a per-group band range;
 *   - facet pills carry live counts, AND-combine, and are dropped entirely at
 *     count 0 (a pill that can only ever empty the queue is not a control);
 *   - evidence collapses to a token strip and expands to the signal rows.
 *
 * Deliberate departures from the artboard, and why:
 *   - NO bulk "Confirm N high-confidence" sweep, and no 90% hairline tick on the
 *     meter. The sweep was gated on a 0.9 threshold never validated against an
 *     observed confirm rate; with it gone the tick marks nothing a curator can
 *     act on, so drawing it would imply a control that no longer exists.
 *   - the signal count says "N of 4" with all FOUR signals countable (the
 *     artboard's own numerator excluded rows it drew, so it could never reach
 *     its own denominator).
 *   - the group header names BANDS, not "likelihood 41-94%" — the band
 *     vocabulary is the only score vocabulary this surface uses.
 *   - PMID/CWID parsing keeps the shipped strict parsers and their
 *     rejected-token reporting; the artboard's split-on-any-non-digit form
 *     would silently turn "abc123def" into PMID 123.
 *   - the free-text filter box sits IN the tab-strip row (the mockup's own
 *     placement, chosen by the owner), but still renders only on the To review
 *     tab: its filter narrows the review list alone, so drawing it over the
 *     Confirmed and Rejected lists would be a control that does nothing on two
 *     tabs out of three. It has no clear of its own, so "Clear filters" drops
 *     the text with the pills, and the count line and the "Nothing matches this
 *     filter." state both count the query.
 *   - there is no "All" reset pill. "Clear filters" in the status strip is the
 *     single reset affordance, and it appears for a text-only narrowing as well
 *     as a ticked facet.
 *
 *   - the mockup's "Co-author signal draws on N core staff from the facility
 *     dictionary" lock chip is now BUILT, and reads "M of N": ReciterAI
 *     publishes both the LISTED roster size and the TRACKED subset the signal
 *     can actually match (PK=CORE#{id}, SK=STAFF_DICT), and etl/dynamodb
 *     Block 6b lands them on `core.staff_count` / `core.staff_tracked_count`.
 *     The mockup's bare N is the listed count, which is wrong on 9 of the 14
 *     live cores — the very core it draws lists 4 and tracks 1 — so the chip
 *     leads with the tracked number and says outright when the signal cannot
 *     fire at all. Unpublished counts still draw nothing (see `CoreStaffChip`).
 *
 * Drawn in the mockup, NOT built here (no data behind either):
 *   - the chip's "Manage staff" link — the roster lives in ReciterAI's facility
 *     dictionary and SPS has no route that edits it (see the chip below);
 *   - the "Method family identified" facet — no method data reaches
 *     `CoreQueueRow` (see `searchBlob`).
 */
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
  Lock,
  PenLine,
  Undo2,
  X,
} from "lucide-react";
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
import { CoreClientsDialog } from "@/components/edit/core-clients-panel";
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

/** What the "Check PMIDs" dry run found. */
interface PmidCheck {
  /** PMIDs a claim would actually write. */
  wouldWrite: number;
  /** Already claimed for this core — writing them again is a no-op. */
  skipped: number;
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
  const out: Signal[] = [];
  if (row.signalAck || row.ackAlias) out.push({ kind: "ack", dots: 4, strength: "Direct" });
  if (row.coauthors.length > 0) out.push({ kind: "coauthor", dots: 3, strength: "Strong" });
  if (row.llmScore !== null) out.push({ kind: "llm", dots: 2, strength: "Moderate" });
  if (repeatUserFires(row, paperCounts, clientCwids))
    out.push({ kind: "affinity", dots: 1, strength: "Weak" });
  return out.sort((a, b) => b.dots - a.dots || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}

/** The four score bands. `label` is the whole score vocabulary of this surface —
 *  there is no "Combined likelihood"/"Evidence score" caption anywhere. */
export type BandLabel = "Strong" | "Moderate" | "Slight" | "Weak";
interface Band {
  min: number;
  label: BandLabel;
  /** Tailwind text colour for the band word. */
  text: string;
  /** Tailwind background for the meter fill. */
  fill: string;
}
const BANDS: readonly Band[] = [
  { min: 0.85, label: "Strong", text: "text-apollo-green", fill: "bg-apollo-green" },
  { min: 0.65, label: "Moderate", text: "text-apollo-slate", fill: "bg-apollo-slate" },
  { min: 0.4, label: "Slight", text: "text-apollo-amber", fill: "bg-apollo-amber" },
  { min: 0, label: "Weak", text: "text-muted-foreground", fill: "bg-muted-foreground" },
];

/** Band for a 0–1 likelihood. Thresholds are inclusive lower bounds, so 0.85 is
 *  Strong, 0.65 Moderate and 0.40 Slight exactly on the boundary. Pure. */
export function likelihoodBand(likelihood: number): Band {
  return BANDS.find((b) => likelihood >= b.min) ?? BANDS[BANDS.length - 1];
}

/** What the dense LLM triage score means, in words a reviewer can act on. Pure. */
export function llmVerdict(score: number): string {
  return score >= 8
    ? "reads as core work"
    : score >= 6
      ? "possibly core work"
      : "little sign of core use";
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
};

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

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "client", label: "Client co-author" },
  { key: "ack", label: "Acknowledged" },
  { key: "coauthored", label: "Staff co-author" },
  { key: "noprior", label: "No prior usage on the byline" },
  { key: "llm", label: "LLM-flagged" },
  { key: "method", label: "Method family (strong/moderate)" },
];

const SORTS: { key: SortKey; label: string }[] = [
  { key: "likelihood", label: "Most certain first" },
  { key: "uncertain", label: "Most uncertain first" },
  { key: "strongest", label: "Strongest signal" },
  { key: "llm", label: "LLM score" },
  { key: "year", label: "Newest in PubMed" },
  { key: "cites", label: "Most cited" },
];

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
}

export function CoreClaimQueue({
  core,
  candidates,
  confirmed,
  rejected = [],
  clients = [],
  paperCounts = {},
}: CoreClaimQueueProps) {
  const [decided, setDecided] = useState<Map<string, Decision>>(new Map());
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  // Confirmed rows walked back this session — kept visible with an undo.
  const [revokedConfirmed, setRevokedConfirmed] = useState<Set<string>>(new Set());
  // Rejected rows restored this session — kept visible with an undo (mirror of above).
  const [restoredRejected, setRestoredRejected] = useState<Set<string>>(new Set());
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
  // Ticked evidence facets, AND-combined. The empty set IS the unnarrowed queue
  // — there is no "all" member and no "All" pill; "Clear filters" resets.
  const [filter, setFilter] = useState<ReadonlySet<FilterKey>>(() => new Set());
  // Free-text narrowing, AND-ed with the facets (see `searchBlob`). It sits in
  // the tab-strip row (the mockup's placement) but renders on the To review tab
  // ONLY: the count line, the "Clear filters" link and the "Nothing matches this
  // filter." state that report its effect are all review-tab controls, so a box
  // drawn over the Confirmed/Rejected lists would be inert on two tabs of three.
  const [query, setQuery] = useState("");
  // Default to engine likelihood, high→low — the loader's own order, so the queue
  // opens on what the engine is surest of. This is a deliberate override, not the
  // original reasoning: the previous default was "uncertain first", on the ground
  // that the 96%s don't need a human and the 55–75%s do. That argument still
  // holds and that band is still one select away — the owner chose likelihood anyway.
  const [sort, setSort] = useState<SortKey>("likelihood");
  // Rows grouped by which KINDS of evidence fired. On by default (the artboard's
  // own default): the pile a reviewer is looking at is "everything acknowledged",
  // not a flat likelihood ladder.
  const [grouped, setGrouped] = useState(true);
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(() => new Set());
  // Multi-select mode: off by default, so a row's checkbox never competes with
  // its own Confirm/Reject for the first click.
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  // Which bulk decision is in flight, if any. Every per-row button here already
  // carries disabled={pending}; the selection bar needs the same, or a
  // double-click on "Confirm all" posts the same batch twice.
  const [bulkPending, setBulkPending] = useState<Decision | null>(null);
  // Which rows have their evidence expanded (collapsed by default — the token
  // strip is the summary, the signal rows are the read-in-depth).
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [copiedPmid, setCopiedPmid] = useState<string | null>(null);
  // Polite SR announcement of the last outcome — the success path is otherwise
  // silent (the card swaps in place with no focus move), mirroring coi-gap-card.
  const [announce, setAnnounce] = useState("");
  // Manual PMID add: paste a block of known PMIDs and claim them directly,
  // independent of the engine queue (POST /api/edit/core-claim/bulk).
  const [addOpen, setAddOpen] = useState(false);
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
  // "Known clients" (ReciterAI #383 / SPS #2607) — the panel's OPEN/CLOSED
  // state lives here (not in CoreClientsPanel), the same controlled-child
  // pattern as Add PMIDs above, so the panel body can render as a toolbar
  // sibling instead of a toolbar child (see the render below).
  //
  // The LIST does not. It is read straight off the `clients` prop, exactly as
  // candidates/confirmed/rejected are, and for the same reason: every write in
  // the dialog ends in `router.refresh()`, and a refresh re-renders the Server
  // Component and hands this component a NEW prop without clearing its state.
  // `clients` was the one prop in this file cached in `useState` — seeded once
  // and never re-seeded — so that refreshed roster was discarded on arrival: a
  // client a co-owner or a second tab had added could never show up here, and
  // `clientCwids` below could drift out of step with the server-computed
  // `paperCounts` it has to agree with (a byline flagged as a client
  // co-author, with no counts to print for them).
  const [clientsOpen, setClientsOpen] = useState(false);
  const router = useRouter();

  // Name-only clients carry no cwid, so they never join this set — they cannot
  // flag a byline, which is exactly what the modal tells the owner up front.
  const clientCwids: ReadonlySet<string> = new Set(
    clients.flatMap((c) => (c.cwid ? [c.cwid.toLowerCase()] : [])),
  );


  // Tick/untick one facet. Resetting is "Clear filters" below — the only one.
  const toggleFilter = (key: FilterKey) =>
    setFilter((s) => {
      const next = new Set(s);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  // type="search" gives the box the platform's own clear button, but that only
  // drops the text. "Clear filters" is the one link that drops BOTH narrowings,
  // because the count line and the empty state below report them as one — and
  // with the "All" pill retired it is the ONLY reset affordance on this surface,
  // so `narrowed` below has to catch a text-only narrowing too.
  const clearFilters = () => {
    setFilter(new Set());
    setQuery("");
  };
  const narrowed = filter.size > 0 || query.trim().length > 0;

  const toggleIn = (
    set: (fn: (s: ReadonlySet<string>) => ReadonlySet<string>) => void,
    id: string,
  ) =>
    set((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });

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
  async function postClaim(
    pmid: string,
    status: Decision | "revoked",
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const res = await fetch("/api/edit/core-claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pmid, coreId: core.id, status }),
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

  // Decide a candidate (claimed/rejected) or revoke that decision, reflected locally.
  async function send(pmid: string, status: Decision | "revoked") {
    clearError(pmid);
    markPending(pmid);
    const result = await postClaim(pmid, status);
    if (result.ok) {
      setDecided((m) => {
        const next = new Map(m);
        if (status === "revoked") next.delete(pmid);
        else next.set(pmid, status);
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
  }

  /**
   * Decide EVERY hand-selected row in one request. This is the selection bar's
   * action, not a threshold sweep: the rows were picked one at a time (or by
   * "Select N" on a group a reviewer is looking at), so there is no unseen band
   * and nothing to gate on a likelihood number. One request to the bulk
   * endpoint: the upsert + audit + writeback loop runs in a single server
   * transaction (no client-side fan-out / partial-failure spray).
   */
  async function bulkDecide(pmids: string[], status: Decision) {
    if (pmids.length === 0 || bulkPending !== null) return;
    // Only "Reject all" is guarded, and the asymmetry is the point: a wrong bulk
    // CONFIRM shows up on the public core page where someone will notice it, while a
    // wrong bulk REJECT just silently leaves the papers missing. Per-row reject stays
    // unguarded — it is one visible row, and Undo sits right there.
    if (
      status === "rejected" &&
      !window.confirm(
        `Reject ${pmids.length} publication${pmids.length === 1 ? "" : "s"} for this core?`,
      )
    ) {
      return;
    }
    setBulkPending(status);
    setPending((s) => new Set([...s, ...pmids]));
    const res = await fetch("/api/edit/core-claim/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ coreId: core.id, pmids, status }),
    }).catch(() => null);
    const ok = res?.ok === true;
    const verb = status === "claimed" ? "Confirmed" : "Rejected";
    if (ok) {
      setDecided((m) => {
        const next = new Map(m);
        for (const p of pmids) next.set(p, status);
        return next;
      });
      setSelected(new Set());
    } else {
      setErrors((m) => {
        const next = new Map(m);
        for (const p of pmids) next.set(p, `bulk ${status === "claimed" ? "confirm" : "reject"} failed`);
        return next;
      });
    }
    setPending((s) => {
      const next = new Set(s);
      for (const p of pmids) next.delete(p);
      return next;
    });
    setBulkPending(null);
    setAnnounce(
      ok
        ? `${verb} ${pmids.length} publication${pmids.length === 1 ? "" : "s"}.`
        : `Bulk ${status === "claimed" ? "confirm" : "reject"} could not be saved.`,
    );
  }

  // Claim a pasted block of known PMIDs directly — the queue's own candidates
  // list plays no part; a pmid the engine never scored (or never will) is
  // claimed anyway, and the server-side existence check catches anything SPS
  // hasn't ingested. Refresh (not local state) so the page re-fetches the newly
  // manual-confirmed rows with their real title/journal/etc.
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
    setAddChecking(true);
    setAddResult(null);
    const res = await fetch("/api/edit/core-claim/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ coreId: core.id, pmids, status: "claimed", dryRun: true }),
    }).catch(() => null);
    if (checkedText !== addTextRef.current) return; // stale — the paste changed
    setAddChecking(false);
    if (!res?.ok) {
      setAddResult("Could not check these — try again.");
      return;
    }
    const data = (await res.json().catch(() => ({}))) as {
      wouldWrite?: number;
      skipped?: number;
      notFound?: string[];
    };
    if (checkedText !== addTextRef.current) return; // stale — the paste changed
    setAddCheck({
      wouldWrite: data.wouldWrite ?? 0,
      skipped: data.skipped ?? 0,
      notFound: data.notFound ?? [],
      invalid,
    });
    setAddResult(null);
  }

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
  // confirmation has no claim, so it needs a "rejected" override instead.
  async function revokeConfirmed(pmid: string, wasClaimed: boolean, title: string) {
    clearError(pmid);
    markPending(pmid);
    const result = await postClaim(pmid, wasClaimed ? "revoked" : "rejected");
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

  // Remaining review work (decided rows stay visible for undo but don't count).
  const open = candidates.filter((c) => !decided.has(c.pmid));
  const remaining = open.length;
  // Per-facet counts, over the still-open population only — a decided row is
  // held on screen for its undo and must not inflate a facet. These earn their
  // place twice over: the count tells a reviewer what a pill will do BEFORE the
  // click, and a facet counting 0 is dropped from the row entirely rather than
  // rendered as a pill whose only possible outcome is an empty queue.
  // ponytail: six extra passes over `open`, recomputed every render, no memo.
  // Fine at the sizes cores actually queue, but loadCoreReviewQueue has no
  // LIMIT — if one core ever returns thousands of candidates, fold these into a
  // single reduce or wrap them in useMemo([candidates, decided]).
  const facetCounts: Record<FilterKey, number> = {
    client: open.filter((c) => matchesFilter(c, "client", clientCwids)).length,
    ack: open.filter((c) => matchesFilter(c, "ack", clientCwids)).length,
    coauthored: open.filter((c) => matchesFilter(c, "coauthored", clientCwids)).length,
    noprior: open.filter((c) => matchesFilter(c, "noprior", clientCwids)).length,
    llm: open.filter((c) => matchesFilter(c, "llm", clientCwids)).length,
    method: open.filter((c) => matchesFilter(c, "method", clientCwids)).length,
  };
  // Apply the facets AND the free-text query (but always keep a just-decided row
  // visible so undo stays reachable), then sort. Likelihood is the loader's
  // order; LLM re-sorts by score.
  const visible = candidates
    .filter(
      (c) =>
        decided.has(c.pmid) || (matchesFilters(c, filter, clientCwids) && matchesQuery(c, query)),
    )
    .slice()
    .sort((a, b) => compareBySort(sort, a, b));
  // Rows in render order, bucketed by evidence kind when grouping is on. The
  // bucket order follows first appearance in `visible`, so the sort still drives
  // what a reviewer meets first.
  const groups: { key: string; rows: CoreQueueRow[] }[] = [];
  if (grouped) {
    const byKey = new Map<string, CoreQueueRow[]>();
    for (const r of visible) {
      const k = evidenceGroupKey(r, paperCounts, clientCwids);
      const list = byKey.get(k);
      if (list) list.push(r);
      else byKey.set(k, [r]);
    }
    for (const [key, rows] of byKey) groups.push({ key, rows });
  } else {
    groups.push({ key: "all", rows: visible });
  }
  // Intersected with `visible`, not just `decided`: a row you tick and then hide with a
  // facet or the filter box must not be swept up by "Confirm all". Acting on rows the
  // reviewer cannot see is precisely what removing the high-confidence sweep was for, and
  // a Set keeps it O(n) on a queue that can carry a few hundred rows.
  const visiblePmids = new Set(visible.map((r) => r.pmid));
  const selectedPmids = [...selected].filter((p) => !decided.has(p) && visiblePmids.has(p));
  // Tabs only earn their place once there's history to switch to; otherwise the
  // queue is the single "To review" scroll it always was.
  const hasHistory = confirmed.length > 0 || rejected.length > 0;

  return (
    <div data-slot="core-claim-queue">
      <div aria-live="polite" className="sr-only" data-testid="core-claim-live">
        {announce}
      </div>
      {/* The mockup's top row: the core-staff lock chip on the left, the button
          group on the right. `justify-between` is the mockup's split, but the
          button group ALSO carries `ml-auto` — the chip is absent whenever the
          engine has published no staff count, and a lone flex child under
          `justify-between` would slide left, moving the buttons out from under
          the reviewer's cursor for exactly the cores with the least data. */}
      <div
        data-slot="core-queue-toolbar"
        className="mb-2 flex flex-wrap items-center justify-between gap-2"
      >
        <CoreStaffChip staffCount={core.staffCount} staffTrackedCount={core.staffTrackedCount} />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setClientsOpen((v) => !v)}
            aria-pressed={clientsOpen}
            className="border-border-strong text-muted-foreground hover:text-foreground bg-background inline-flex h-8 items-center rounded-md border px-3 text-sm"
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
            className="border-border-strong text-muted-foreground hover:text-foreground bg-background inline-flex h-8 items-center rounded-md border px-3 text-sm"
          >
            Add PMIDs
          </button>
          {/* The mockup's third button. It shipped DISABLED while no core
              reporting route existed; the core-reports widening (2026-09-06)
              gave cores reports 3 and 6, so it is now a real link to this
              core's Publications report. Same authz on the other side — a
              core's owner/curator (or a superuser/comms_steward) passes, and
              nobody else does — so this never leads a reviewer to a 403 they
              could reach the review queue from.
              Styling tracks its two siblings above (rounded-md, no icon): the
              mockup toolbar restyle landed while this branch was open, and the
              link must not quietly bring the old pill back. */}
          <a
            href={`/edit/reports/3?center=${encodeURIComponent(core.id)}&kind=core`}
            className="border-border-strong text-muted-foreground hover:text-foreground bg-background inline-flex h-8 items-center rounded-md border px-3 text-sm"
          >
            Reporting...
          </a>
        </div>
      </div>

      {/* Both toolbar panels are MODALS, not inline drawers: each is a task with
          its own commit step, and an inline panel pushed the queue down the page
          while it was open — the reviewer lost their place in the list they were
          about to act on. Padding lives on the bands inside `DialogContent`
          (which is `p-0`), so the header and footer rules run full-bleed. */}
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
            <DialogTitle>Claim publications by PMID</DialogTitle>
            <DialogDescription>
              For papers you know used this core that the engine never scored. These are recorded
              as your decision, with no evidence trail behind them.
            </DialogDescription>
          </DialogHeader>

          <div className="px-6 py-5">
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
                  <span className="tabular-nums font-medium">{addCheck.wouldWrite}</span> ready to
                  claim.
                </li>
                {addCheck.skipped > 0 ? (
                  <li>
                    <span className="tabular-nums">{addCheck.skipped}</span> already claimed for
                    this core.
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
              onClick={submitAddPmids}
              className="bg-apollo-maroon inline-flex h-9 items-center rounded-md px-3.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {addPending ? "Claiming…" : "Claim publications"}
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

      {/* One bordered panel holding the tab strip, the facets, the controls and
          the status strip, so the active tab reads as connected to the body it
          switches. The head strip is surface-2 and the active tab is surface, so
          the raised tab merges into the panel below it. */}
      <div
        data-slot="core-queue-panel"
        className="border-apollo-border bg-apollo-surface mb-3 overflow-hidden rounded-lg border"
      >
        <div className="border-apollo-border bg-apollo-surface-2 flex flex-wrap items-end gap-x-3 gap-y-2 border-b px-3 pt-2">
          {hasHistory ? (
            <ViewTabs
              view={view}
              onView={setView}
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
            /* "method" is now TRUE, not aspirational: the card renders a
               "Method family <tier>" evidence token and `searchBlob` searches
               that token's text. The individual family and tool NAMES are still
               not searched (`method_evidence` stays out of the loader's
               select) — a query for a specific tool matches nothing. */
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by title, author, journal, PMID or method..."
              aria-label="Filter candidates"
              className="mb-2 ml-auto h-8 w-[330px] max-w-full text-xs"
            />
          ) : null}
        </div>

        {view === "review" && candidates.length > 0 ? (
          <>
            <QueueControls
              filter={filter}
              onToggleFilter={toggleFilter}
              counts={facetCounts}
              sort={sort}
              onSort={setSort}
              grouped={grouped}
              onToggleGrouped={() => setGrouped((g) => !g)}
              selectMode={selectMode}
              onToggleSelectMode={() => {
                setSelectMode((m) => !m);
                if (selectMode) setSelected(new Set());
              }}
            />
            <div
              data-slot="core-queue-status"
              className="border-apollo-border bg-apollo-surface-2 text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 py-2 text-xs"
            >
              <span>
                Showing {visible.length} of {candidates.length} candidates
              </span>
              {narrowed ? (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="text-apollo-slate underline"
                >
                  Clear filters
                </button>
              ) : null}
              <span className="ml-auto">
                Keys: <Kbd>j</Kbd>/<Kbd>k</Kbd> move · <Kbd>a</Kbd> confirm · <Kbd>r</Kbd> reject ·{" "}
                <Kbd>x</Kbd> select · <Kbd>u</Kbd> undo
              </span>
            </div>
          </>
        ) : null}
      </div>

      {view === "review" ? (
        <>
          {candidates.length === 0 ? (
            <p className="text-muted-foreground rounded-lg border border-apollo-border border-dashed px-4 py-6 text-sm">
              Nothing to review — every candidate publication for this core has been confirmed or
              rejected.
            </p>
          ) : visible.length === 0 ? (
            <p className="text-muted-foreground rounded-lg border border-apollo-border border-dashed px-4 py-6 text-sm">
              Nothing matches this filter.
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              {groups.map((g) => {
                const collapsed = collapsedGroups.has(g.key);
                return (
                  <div key={g.key}>
                    {grouped ? (
                      <GroupHeader
                        label={evidenceGroupLabel(g.key, g.rows.length)}
                        range={bandRange(g.rows.map((r) => r.likelihood))}
                        collapsed={collapsed}
                        onToggle={() => toggleIn(setCollapsedGroups, g.key)}
                        onSelectAll={() => {
                          setSelected((s) => new Set([...s, ...g.rows.map((r) => r.pmid)]));
                          setSelectMode(true);
                        }}
                        selectLabel={`Select ${g.rows.length}`}
                      />
                    ) : null}
                    {collapsed ? null : (
                      <ul className="flex flex-col gap-3">
                        {g.rows.map((row) => (
                          <li key={row.pmid}>
                            <CandidateCard
                              row={row}
                              clientCwids={clientCwids}
              paperCounts={paperCounts}
                              decided={decided.get(row.pmid)}
                              pending={pending.has(row.pmid)}
                              error={errors.get(row.pmid)}
                              expanded={expanded.has(row.pmid)}
                              onToggleExpanded={() => toggleIn(setExpanded, row.pmid)}
                              selectMode={selectMode}
                              selected={selected.has(row.pmid)}
                              onToggleSelected={() => toggleIn(setSelected, row.pmid)}
                              // "x" both ticks the row and arms selection mode,
                              // so the shortcut works from the queue's default
                              // (unselectable) state without a mouse trip to
                              // "Select several" first.
                              onSelectShortcut={() => {
                                toggleIn(setSelected, row.pmid);
                                setSelectMode(true);
                              }}
                              copied={copiedPmid === row.pmid}
                              onCopyPmid={() => copyPmid(row.pmid)}
                              onDecide={(status) => send(row.pmid, status)}
                              onUndo={() => send(row.pmid, "revoked")}
                            />
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      ) : null}

      {view === "confirmed" ? (
        <ul className="flex flex-col gap-1.5">
          {confirmed.map((row) => (
            <ConfirmedRow
              key={row.pmid}
              row={row}
              revoked={revokedConfirmed.has(row.pmid)}
              pending={pending.has(row.pmid)}
              error={errors.get(row.pmid)}
              clientCwids={clientCwids}
                              paperCounts={paperCounts}
              onRevoke={() => revokeConfirmed(row.pmid, row.claimed, row.title)}
              onUndo={() => undoRevokeConfirmed(row.pmid, row.claimed)}
            />
          ))}
        </ul>
      ) : null}

      {view === "rejected" ? (
        <ul className="flex flex-col gap-1.5">
          {rejected.map((row) => (
            <RejectedRow
              key={row.pmid}
              row={row}
              restored={restoredRejected.has(row.pmid)}
              pending={pending.has(row.pmid)}
              error={errors.get(row.pmid)}
              onRestore={() => restoreRejected(row.pmid, row.title)}
              onUndo={() => undoRestoreRejected(row.pmid)}
            />
          ))}
        </ul>
      ) : null}

      {view === "review" && selectedPmids.length > 0 ? (
        <div
          data-slot="core-queue-selection-bar"
          className="bg-apollo-bar fixed bottom-5 left-1/2 z-20 flex -translate-x-1/2 items-center gap-3.5 rounded-xl px-4 py-2.5 text-white shadow-lg"
          role="group"
          aria-label="Selected publications"
        >
          <span className="text-[13px] font-medium">
            {selectedPmids.length} paper{selectedPmids.length === 1 ? "" : "s"} selected
          </span>
          <span className="h-5 w-px bg-white/20" aria-hidden />
          <button
            type="button"
            disabled={bulkPending !== null}
            onClick={() => bulkDecide(selectedPmids, "claimed")}
            className="inline-flex h-8 items-center rounded-full bg-[var(--color-accent-slate)] px-3 text-sm font-medium text-white disabled:opacity-50"
          >
            {bulkPending === "claimed" ? "Confirming…" : "Confirm all"}
          </button>
          <button
            type="button"
            disabled={bulkPending !== null}
            onClick={() => bulkDecide(selectedPmids, "rejected")}
            className="inline-flex h-8 items-center rounded-full border border-white/30 px-3 text-sm disabled:opacity-50"
          >
            {bulkPending === "rejected" ? "Rejecting…" : "Reject all"}
          </button>
          <button
            type="button"
            onClick={() => {
              setSelected(new Set());
              setSelectMode(false);
            }}
            className="text-xs text-white/70"
          >
            Clear
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The toolbar's lock chip: what the co-author signal (signal 2) actually has to
 * work with on this core. Both counts come from ReciterAI's facility
 * dictionary via etl/dynamodb Block 6b (`PK=CORE#{id}, SK=STAFF_DICT`) — COUNTS,
 * never the CWIDs, which stay upstream.
 *
 * The two numbers are not interchangeable, and that is the whole reason this
 * chip renders both. `staffCount` is what the dictionary LISTS under the core's
 * `staff:` key. `staffTrackedCount` is how many of those the signal can
 * actually MATCH: pipeline_cores/signals.py `coauthorship_index` reads the
 * core's tracked staff CWIDs, so a listed staff member with no personIdentifier
 * upstream is invisible to it. The two differ on 9 of the 14 live cores; the
 * mockup's own core lists four and tracks one, the longest roster (seven)
 * tracks four, and three cores list staff while tracking none.
 * A chip built on the listed count alone would tell a reviewer the signal
 * "draws on 4 core staff" on exactly the core in the owner's mockup, where it
 * draws on one — the same species of false mechanism claim `decodeTopicalPrior`
 * already put on 7,332 live chips. So the sentence leads with the tracked
 * count and carries the listed one behind it, and the two dead states say so
 * outright rather than naming a number the signal cannot use.
 *
 * Four states:
 *   - counts unpublished (`staffCount` null; `staffTrackedCount` null is the
 *     same case, since the ETL writes the pair together or not at all) —
 *     renders NOTHING, exactly as before this shipped. Not-yet-published must
 *     look like nothing at all, never like an empty roster; the rest of this
 *     queue is built on the same invisible-not-broken property.
 *   - listed 0 — the dictionary lists no staff at all for this core. Its own
 *     sentence: the signal cannot fire, so every candidate the reviewer sees is
 *     carried by the other three signals (round 2 dropped the prefilter prior to
 *     a footnote, so `SIGNAL_COUNT` is 4 and this is one of them).
 *   - listed > 0, tracked 0 — the dictionary lists staff but none of them
 *     resolve. Same conclusion, different cause, and the cause is worth saying:
 *     this one is fixable upstream, "lists none" is not.
 *   - tracked > 0 — the mockup's sentence, "M of N" emphasized.
 *
 * The mockup also draws a "Manage staff" link beside this chip. It is
 * deliberately NOT built: there is no destination — the roster lives in the
 * facility dictionary, not in SPS, and no core-staff role exists to hang an
 * editor off. This toolbar already carries one knowingly-inert control
 * ("Reporting..."); a second would make dead controls the pattern here. It
 * becomes a `/roles` link the day a core-staff role exists.
 */
function CoreStaffChip({
  staffCount,
  staffTrackedCount,
}: {
  staffCount: number | null;
  staffTrackedCount: number | null;
}) {
  if (staffCount === null || staffTrackedCount === null) return null;
  return (
    <span
      data-slot="core-staff-chip"
      className="border-apollo-border bg-apollo-surface-2 text-muted-foreground inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs"
    >
      <Lock className="size-3.5 shrink-0" aria-hidden />
      {staffCount === 0 ? (
        <span>
          The facility dictionary lists no core staff, so the co-author signal cannot fire for this
          core.
        </span>
      ) : staffTrackedCount === 0 ? (
        <span>
          The facility dictionary lists {staffCount} core staff, but none are resolvable, so the
          co-author signal cannot fire for this core.
        </span>
      ) : (
        <span>
          Co-author signal draws on{" "}
          <span className="text-foreground font-semibold">
            {staffTrackedCount} of {staffCount}
          </span>{" "}
          core staff from the facility dictionary
        </span>
      )}
    </span>
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

/** The evidence-group band: a collapse caret, the vocabulary label, the group's
 *  band range, and a "Select N" that arms selection mode on this pile. */
function GroupHeader({
  label,
  range,
  collapsed,
  onToggle,
  onSelectAll,
  selectLabel,
}: {
  label: string;
  range: string;
  collapsed: boolean;
  onToggle: () => void;
  onSelectAll: () => void;
  selectLabel: string;
}) {
  return (
    <div className="bg-apollo-rail border-apollo-rail-border mb-2 flex items-center gap-3 rounded-md border px-3 py-2">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-label="Collapse or expand this group"
        className="border-border-strong text-muted-foreground hover:text-foreground inline-flex size-5 items-center justify-center rounded border bg-background"
      >
        {collapsed ? (
          <ChevronDown className="size-3" aria-hidden />
        ) : (
          <ChevronUp className="size-3" aria-hidden />
        )}
      </button>
      <span className="text-foreground text-xs font-semibold">{label}</span>
      {range ? <span className="text-muted-foreground text-xs">{range}</span> : null}
      <button
        type="button"
        onClick={onSelectAll}
        className="border-border-strong text-apollo-slate ml-auto inline-flex h-6 items-center rounded-full border bg-background px-2.5 text-xs"
      >
        {selectLabel}
      </button>
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
  onRevoke,
  onUndo,
  clientCwids = new Set<string>(),
  paperCounts = {},
}: {
  row: CoreQueueRow;
  revoked: boolean;
  pending: boolean;
  error: string | undefined;
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
      <li className="text-muted-foreground flex items-center justify-between gap-2 text-sm">
        <span className="flex min-w-0 items-baseline gap-2">
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
    <li className="text-muted-foreground flex items-start justify-between gap-2 text-sm">
      <span className="flex min-w-0 flex-col gap-0.5">
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
  onRestore,
  onUndo,
}: {
  row: CoreQueueRow;
  restored: boolean;
  pending: boolean;
  error: string | undefined;
  onRestore: () => void;
  onUndo: () => void;
}) {
  if (restored) {
    return (
      <li className="text-muted-foreground flex items-center justify-between gap-2 text-sm">
        <span className="flex min-w-0 items-baseline gap-2">
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
    <li className="text-muted-foreground flex items-center justify-between gap-2 text-sm">
      <span className="flex min-w-0 items-baseline gap-2">
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

/** The facet row and the controls row, stacked inside the queue panel. The
 *  free-text box is NOT here — it sits in the tab-strip row above (the mockup's
 *  placement), which is why this takes no `query`. */
function QueueControls({
  filter,
  onToggleFilter,
  counts,
  sort,
  onSort,
  grouped,
  onToggleGrouped,
  selectMode,
  onToggleSelectMode,
}: {
  filter: ReadonlySet<FilterKey>;
  onToggleFilter: (f: FilterKey) => void;
  counts: Record<FilterKey, number>;
  sort: SortKey;
  onSort: (s: SortKey) => void;
  grouped: boolean;
  onToggleGrouped: () => void;
  selectMode: boolean;
  onToggleSelectMode: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 px-3 py-2.5">
      {/* The pill row and the text box above are both "filter candidates";
          naming them apart keeps two controls from answering to one name. */}
      <div
        className="flex flex-wrap gap-1.5"
        role="group"
        aria-label="Filter candidates by evidence"
      >
        {/* Every pill is a genuine checkbox — the old "All" reset pill is gone
            (owner decision), so there is no odd button-among-checkboxes left in
            this group. Native Space/Enter activation covers all of them. */}
        {FILTERS.filter((f) => counts[f.key] > 0).map((f) => {
          const checked = filter.has(f.key);
          return (
            <button
              key={f.key}
              type="button"
              role="checkbox"
              aria-checked={checked}
              onClick={() => onToggleFilter(f.key)}
              className={`focus-visible:ring-apollo-maroon rounded-full border px-3 py-1 text-[13px] focus-visible:outline-none focus-visible:ring-2 ${
                checked
                  ? "bg-apollo-maroon border-transparent text-white"
                  : "border-apollo-border text-muted-foreground hover:text-foreground bg-apollo-surface"
              }`}
            >
              {f.label} <span className="tabular-nums opacity-80">{counts[f.key]}</span>
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-pressed={grouped}
          onClick={onToggleGrouped}
          className="border-border-strong text-muted-foreground hover:text-foreground inline-flex h-8 items-center rounded-full border bg-apollo-surface-2 px-3.5 text-xs"
        >
          {grouped ? "Grouped by evidence" : "Group by evidence"}
        </button>
        <button
          type="button"
          aria-pressed={selectMode}
          onClick={onToggleSelectMode}
          className="border-border-strong text-muted-foreground hover:text-foreground inline-flex h-8 items-center rounded-full border bg-apollo-surface-2 px-3.5 text-xs"
        >
          {selectMode ? "Exit selection" : "Select several"}
        </button>
        {/* The label is VISIBLE now and carries the word the options used to
            repeat, so the option text is bare ("Most certain first", not
            "Sort: Most certain first"). htmlFor/id ties the label to the select
            so clicking it focuses the control; aria-label keeps the fuller
            accessible name ("Sort by") the sr-only span used to give it. */}
        <label
          htmlFor="core-queue-sort"
          className="text-muted-foreground ml-1 text-[13px] font-medium"
        >
          Sort
        </label>
        <select
          id="core-queue-sort"
          aria-label="Sort by"
          value={sort}
          onChange={(e) => onSort(e.target.value as SortKey)}
          className="border-border-strong bg-apollo-surface focus-visible:ring-apollo-maroon rounded-md border px-2 py-1 text-[13px] focus-visible:outline-none focus-visible:ring-2"
        >
          {SORTS.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="border-apollo-border rounded border px-1 py-px font-mono text-[10px]">
      {children}
    </kbd>
  );
}

// Focusable shell shared by the active and decided card states — carries the
// keyboard contract (a/r/x/u + j/k/↑/↓), firing only when the card itself is
// focused (not a child button/link/input), so its inner controls keep their
// native behavior. That guard is LOAD-BEARING now that j, k and x are ordinary
// printable characters: the queue's free-text filter box lives outside this
// subtree entirely, and every in-card control (checkbox, Confirm, Reject, the
// evidence disclosure) is a child, so neither can be hijacked by a shortcut.
const CARD_SHELL =
  "bg-apollo-surface rounded-lg border border-apollo-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-apollo-maroon";

function CandidateCard({
  row,
  clientCwids,
  paperCounts,
  decided,
  pending,
  error,
  expanded,
  onToggleExpanded,
  selectMode,
  selected,
  onToggleSelected,
  onSelectShortcut,
  copied,
  onCopyPmid,
  onDecide,
  onUndo,
}: {
  row: CoreQueueRow;
  clientCwids: ReadonlySet<string>;
  /** Per-person confirmed-paper counts for this core (see `clientPaperCounts`). */
  paperCounts: Readonly<Record<string, CoreClientPaperCount>>;
  decided: Decision | undefined;
  pending: boolean;
  error: string | undefined;
  expanded: boolean;
  onToggleExpanded: () => void;
  selectMode: boolean;
  selected: boolean;
  onToggleSelected: () => void;
  /** "x": tick this row AND arm selection mode, so the shortcut works from the
   *  queue's default state. Distinct from `onToggleSelected`, which is the
   *  checkbox's own handler and must not turn the mode on by itself. */
  onSelectShortcut: () => void;
  copied: boolean;
  onCopyPmid: () => void;
  onDecide: (status: Decision) => void;
  onUndo: () => void;
}) {
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return; // only when the shell itself is focused
    const k = e.key.toLowerCase();
    // j/k are the vi-style twins of ArrowDown/ArrowUp, not a second mechanism.
    const down = k === "arrowdown" || k === "j";
    if (down || k === "arrowup" || k === "k") {
      e.preventDefault();
      const li = e.currentTarget.closest("li");
      const sibling = down ? li?.nextElementSibling : li?.previousElementSibling;
      (sibling?.querySelector("[data-card]") as HTMLElement | null)?.focus();
      return;
    }
    if (pending) return;
    if (!decided && k === "a") {
      e.preventDefault();
      onDecide("claimed");
    } else if (!decided && k === "r") {
      e.preventDefault();
      onDecide("rejected");
    } else if (!decided && k === "x") {
      // Selection is a To-review affordance; a decided row has nothing to sweep.
      e.preventDefault();
      onSelectShortcut();
    } else if (decided && k === "u") {
      e.preventDefault();
      onUndo();
    }
  }

  if (decided) {
    // Tint the strip so a confirm vs. reject reads at a glance, not just from the
    // icon — same pattern as opportunity-intake-panel's STATUS_STYLES.
    const tint =
      decided === "claimed" ? "border-emerald-200 bg-emerald-50" : "border-red-200 bg-red-50";
    return (
      <div
        className={`flex items-center justify-between gap-3 rounded-lg border p-4 ${tint} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-apollo-maroon`}
        data-card
        data-pmid={row.pmid}
        tabIndex={0}
        role="group"
        aria-label={`${decided === "claimed" ? "Confirmed" : "Rejected"}: ${row.title}`}
        aria-keyshortcuts="u j k ArrowUp ArrowDown"
        onKeyDown={onKeyDown}
      >
        <div className="flex min-w-0 items-center gap-2 text-sm">
          {decided === "claimed" ? (
            <Check className="size-4 shrink-0 text-emerald-600" aria-hidden />
          ) : (
            <X className="size-4 shrink-0 text-red-600" aria-hidden />
          )}
          <span className={decided === "claimed" ? "text-emerald-800" : "text-red-800"}>
            {decided === "claimed" ? "Confirmed" : "Rejected"}
          </span>
          <span className="text-foreground truncate">{row.title}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {error ? (
            <span className="text-xs text-red-600" role="alert">
              Could not save: {error}
            </span>
          ) : null}
          <button
            type="button"
            disabled={pending}
            onClick={onUndo}
            className="border-border-strong text-muted-foreground hover:text-foreground inline-flex h-8 items-center gap-1.5 rounded-full border bg-background px-3 text-sm disabled:opacity-50"
          >
            <Undo2 className="size-3.5" aria-hidden /> Undo
          </button>
        </div>
      </div>
    );
  }

  const likelihoodPct = Math.round(row.likelihood * 100);
  const band = likelihoodBand(row.likelihood);
  const signals = buildSignals(row, paperCounts, clientCwids);
  const tokens = evidenceTokens(row, clientCwids, paperCounts);
  // Gated on the repeat-user row being ON SCREEN, not on the prior's own decode:
  // the affinity copy points at that row, and per-person de-duplication can drop
  // it, which left the footnote saying "it only restates the repeat-user number"
  // with no such row anywhere on the card (round 2).
  const footnote = priorFootnote(
    row.topicalPrior,
    signals.some((s) => s.kind === "affinity"),
  );
  // Method-family chips at the card top plus the "Methods used" evidence row
  // (mockup). ONE CHIP PER FAMILY: the extractor emits an entry per
  // (family, tool) pair, so a paper that used two tools from the same family
  // would otherwise carry the same chip twice. Only the top-ranked entry carries
  // a `sentence` — that is how lib/api/core-queue.ts bounds the RSC payload — so
  // `find` is the top-ranked one, never an arbitrary pick.
  //
  // Both are gated on `methodTier`, because both must print it: a chip that said
  // only "Flow cytometry" would be the bare "method family identified" the
  // per-family tiering exists to prevent (399x lift at strong, 1.6x at weak).
  const methodFamilies = row.methodTier
    ? [...new Set(row.methodEvidence.map((m) => m.family))]
    : [];
  const methodQuote = row.methodTier
    ? (row.methodEvidence.find((m) => m.sentence)?.sentence ?? null)
    : null;
  // What the card shows OUTSIDE the four counted signals, in the words the card
  // itself uses. The 0-signal empty state names these instead of asserting that
  // nothing is shown: a method-only row rendered "No labelled signal." with its
  // own green chips directly above it and a fully rendered "Methods used" quote
  // directly below — three statements about one row, two of them false (round 2).
  const uncounted = [
    row.methodTier ? "method family" : null,
    footnote ? "prefilter prior" : null,
  ].filter((s): s is string => s !== null);
  // The header's meta line, middot-separated: the journal, when PubMed indexed
  // it, then the PMID. Each part is dropped when its data is missing rather than
  // rendered empty, so the separators are built from what actually survives.
  //
  // FULL title first, the abbreviation only as a fallback (owner, round 2). This
  // REVERSES #2620, whose comment argued the other way — the full title really is
  // a paragraph for a few journals — but "Proc Natl Acad Sci U S A" is not a
  // venue a reviewer can identify at a glance, and identifying the venue is the
  // whole job of this line. The row is `flex-wrap`, so the longest title in
  // PubMed ("Proceedings of the National Academy of Sciences of the United
  // States of America", ~475px at this size) still fits the card's first column
  // beside the date and PMID, and a narrower card moves the later parts onto a
  // second line rather than overflowing.
  const journalLabel = row.journal ?? row.journalAbbrev;
  const addedToPubMed = formatAddedToPubMed(row.dateAddedToEntrez);
  const metaParts: Array<{ key: string; node: ReactNode }> = [];
  if (journalLabel) metaParts.push({ key: "journal", node: <span>{journalLabel}</span> });
  if (addedToPubMed) metaParts.push({ key: "added", node: <span>{addedToPubMed}</span> });
  // No index date on file — the publication year is the only vintage left.
  else if (row.year !== null)
    metaParts.push({ key: "year", node: <span className="tabular-nums">{row.year}</span> });
  metaParts.push({
    key: "pmid",
    // PMID shown verbatim (curators key off it); links to PubMed when present.
    node: row.pubmedUrl ? (
      <a
        href={row.pubmedUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="hover:text-foreground inline-flex items-center gap-1 tabular-nums hover:underline"
      >
        PMID {row.pmid} <ExternalLink className="size-3" aria-hidden />
      </a>
    ) : (
      <span className="tabular-nums">PMID {row.pmid}</span>
    ),
  });
  return (
    <div
      className={`${CARD_SHELL} px-5 py-4`}
      data-card
      data-pmid={row.pmid}
      tabIndex={0}
      role="group"
      aria-label={`Candidate: ${row.title}`}
      aria-keyshortcuts="a r x j k ArrowUp ArrowDown"
      onKeyDown={onKeyDown}
    >
      <div
        className={`grid items-start gap-4 ${
          selectMode
            ? "grid-cols-[26px_minmax(0,1fr)_112px_auto]"
            : "grid-cols-[minmax(0,1fr)_112px_auto]"
        }`}
      >
        {selectMode ? (
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelected}
            aria-label={`Select ${row.title}`}
            className="mt-1.5 size-4"
          />
        ) : null}

        <div className="min-w-0">
          {methodFamilies.length > 0 ? (
            // Green pills at the top of the card, mockup parity. The tier rides
            // WITH them, and the caveat is on screen rather than in a `title`
            // attribute a touch user can never open: these labels come from an
            // extractor reading the paper's own methods text, so they say what
            // the PAPER did — never that this core did it. Uncounted by design;
            // `evidenceTokens` carries the same reasoning at length.
            <p className="mb-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1">
              {methodFamilies.map((f) => (
                <span
                  key={f}
                  className="border-apollo-green-tint-border bg-apollo-green-tint text-apollo-green-foreground inline-block rounded-full border px-2 py-0.5 text-[11px] font-medium"
                >
                  {f}
                </span>
              ))}
              <span className="text-muted-foreground text-[11px]">
                {row.methodTier} method match — what the paper did, not whether this core did it
              </span>
            </p>
          ) : null}
          {row.authorAffinity === null ? (
            <p className="mb-1.5">
              <span className="border-border-strong text-muted-foreground bg-apollo-surface-2 inline-block rounded border px-2 py-0.5 text-[11px]">
                No prior core usage anywhere on this byline
              </span>
            </p>
          ) : null}
          <h3 className="text-foreground text-[15px] font-medium">{displayTitle(row.title)}</h3>
          <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
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
            <p className="bg-muted/60 border-apollo-border text-muted-foreground mt-2.5 rounded-md border px-3 py-2 text-[13px] leading-snug">
              {row.synopsis}
            </p>
          ) : null}

          <button
            type="button"
            onClick={onToggleExpanded}
            aria-expanded={expanded}
            className="border-border-strong bg-apollo-surface-2 mt-2.5 flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left"
          >
            <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1">
              {tokens.length > 0 ? (
                tokens.map((t, i) => (
                  <span key={t.label} className="inline-flex items-baseline gap-1 text-[12.5px]">
                    {i > 0 ? (
                      <span className="text-muted-foreground/60 font-bold" aria-hidden>
                        ·
                      </span>
                    ) : null}
                    <span className="text-muted-foreground">{t.label}</span>
                    <span className="text-foreground font-medium">{t.value}</span>
                  </span>
                ))
              ) : (
                <span className="text-foreground text-[12.5px]">No labelled signal.</span>
              )}
            </span>
            <span
              title={expanded ? "Hide evidence" : "Show evidence"}
              aria-label={expanded ? "Hide evidence" : "Show evidence"}
              className="border-border-strong text-apollo-slate bg-apollo-surface inline-flex size-7 shrink-0 items-center justify-center rounded-lg border"
            >
              {expanded ? (
                <ChevronUp className="size-4" aria-hidden />
              ) : (
                <ChevronDown className="size-4" aria-hidden />
              )}
            </span>
          </button>

          {/* Inside the FIRST GRID COLUMN, not a sibling of the grid. As a
              sibling it spanned the whole card, so it ran past the right edge of
              the collapsed strip it expands — past the score meter and the
              Confirm/Reject buttons — and the two blocks never lined up (round 2,
              item 7). Same column, same width, no `ml-1`: the border rule now
              starts on the strip's own left edge and reads as its continuation. */}
          {expanded ? (
            <div className="border-border-strong mt-3 border-l-2 pl-3.5">
              {signals.length === 0 ? (
                <p className="bg-apollo-amber-tint border-apollo-amber-tint-border text-apollo-amber rounded-lg border px-3 py-2.5 text-[12.5px] leading-relaxed">
                  {/* "counted", not "labelled": the row can carry labels this panel
                      does not count — a method family is chipped, tokened and quoted
                      on the very same card. So the ending names whatever IS on
                      screen, and only the genuinely bare row says the queue is
                      showing nothing. */}
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
                    />
                  ))}
                </ul>
              )}
              {methodQuote ? (
                // Deliberately NOT an <li> inside the evidence list and NOT in
                // `buildSignals`: the method family is weighted 0.00 in the
                // engine's combine.WEIGHTS and 63% of tiered rows are "weak",
                // where the measured lift inverts to BELOW background. So it is
                // shown in full, always with its tier, and never counted toward
                // SIGNAL_COUNT — the same reasoning as the strip token.
                <div className="border-apollo-border grid grid-cols-[200px_minmax(0,1fr)] items-start gap-3.5 border-t py-2.5">
                  <div>
                    <div className="text-foreground text-[12.5px] leading-tight font-semibold">
                      Methods used
                    </div>
                    <div className="text-muted-foreground mt-1 text-[11px]">
                      {row.methodTier} · not counted
                    </div>
                  </div>
                  <div className="min-w-0">
                    <blockquote className="border-border-strong bg-apollo-lock-bg text-foreground rounded-r-md border-l-2 px-2.5 py-2 text-[12.5px] leading-relaxed">
                      “{methodQuote}”
                    </blockquote>
                    <p className="text-muted-foreground mt-1.5 text-[12px] leading-relaxed">
                      Read out of the paper’s own methods text: it says what the paper did, not
                      whether this core did it.
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
          ) : null}
        </div>

        <div>
          <div
            className={`text-[11px] font-semibold uppercase tracking-[0.04em] ${band.text}`}
            data-slot="core-queue-score"
          >
            {band.label} {likelihoodPct}%
          </div>
          <span className="bg-apollo-surface-2 border-apollo-border mt-1 block h-1.5 overflow-hidden rounded-full border">
            <span
              className={`block h-full rounded-full ${band.fill}`}
              style={{ width: `${likelihoodPct}%` }}
            />
          </span>
          <div className="text-muted-foreground mt-1 text-[10.5px]">
            {signals.length} of {SIGNAL_COUNT} signals
          </div>
        </div>

        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={() => onDecide("claimed")}
            className="inline-flex h-8 items-center gap-1.5 rounded-full bg-[var(--color-accent-slate)] px-3 text-sm font-medium text-white disabled:opacity-50"
          >
            <Check className="size-3.5" aria-hidden /> Confirm
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => onDecide("rejected")}
            className="border-border-strong text-muted-foreground hover:text-foreground inline-flex h-8 items-center gap-1.5 rounded-full border bg-background px-3 text-sm disabled:opacity-50"
          >
            <X className="size-3.5" aria-hidden /> Reject
          </button>
        </div>
      </div>

      {error ? (
        <p className="mt-2 text-xs text-red-600" role="alert">
          Could not save: {error}
        </p>
      ) : null}
    </div>
  );
}

/** One fired signal: label + strength glyphs on the left, the evidence itself on
 *  the right (a value line, a plain-language detail, and the quote when the run
 *  captured one). */
function SignalRow({
  signal,
  row,
  paperCounts,
  clientCwids,
}: {
  signal: Signal;
  row: CoreQueueRow;
  paperCounts: Readonly<Record<string, CoreClientPaperCount>>;
  /** The same set `buildSignals` de-duplicated against — without it this row
   *  would name a person the strip above already excluded. */
  clientCwids: ReadonlySet<string>;
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
    <li className="border-apollo-border grid grid-cols-[200px_minmax(0,1fr)] items-start gap-3.5 border-t py-2.5">
      <div>
        <div className="text-foreground text-[12.5px] font-semibold leading-tight">{label}</div>
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

/** Four dots, `dots` of them filled — the fixed per-signal-type strength. */
function StrengthGlyphs({ dots }: { dots: number }) {
  return (
    <span className="flex items-center gap-1" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          className={`size-1.5 rounded-full border ${
            i < dots ? "border-apollo-maroon bg-apollo-maroon" : "border-muted-foreground/40"
          }`}
        />
      ))}
    </span>
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
