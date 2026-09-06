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
 *   - the signal count says "N of 5" with all FIVE signals countable (the
 *     artboard's own numerator excluded two rows it drew, so it could never
 *     reach its own denominator).
 *   - the group header names BANDS, not "likelihood 41-94%" — the band
 *     vocabulary is the only score vocabulary this surface uses.
 *   - the prefilter prior stays a visible signal row rather than the artboard's
 *     dimmed "Not evidence" footnote: `decodeTopicalPrior` gives it a true
 *     reading here (see below), and it has to be visible to be countable.
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
 * Drawn in the mockup, NOT built here (no data behind either):
 *   - the "Co-author signal draws on N core staff from the facility dictionary"
 *     lock chip and its "Manage staff" link — SPS ingests no core-staff
 *     dictionary count, and there is no such route;
 *   - the "Method family identified" facet — no method data reaches
 *     `CoreQueueRow` (see `searchBlob`).
 */
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
  FileText,
  PenLine,
  Plus,
  Undo2,
  Users,
  X,
} from "lucide-react";
import type { CoreClientRow } from "@/lib/api/core-clients";
import type { CoreQueueRow, CoreReviewQueue, QueueScholar } from "@/lib/api/core-queue";
import { CoreClientsPanel } from "@/components/edit/core-clients-panel";
import { HoverTooltip } from "@/components/ui/hover-tooltip";
import { Input } from "@/components/ui/input";
import { toCsv } from "@/lib/csv";

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
 *  NOTE the two deliberate mismatches with the card: the CSV keeps the FULL journal
 *  (not `journalAbbrev`) and the RAW title (not `displayTitle`), because an export is
 *  a record, not a rendering — a stripped trailing period would corrupt a citation. */
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
export type FilterKey = "client" | "ack" | "coauthored" | "noprior" | "llm";
type SortKey = "likelihood" | "uncertain" | "strongest" | "llm" | "year" | "cites";

type SignalKind = "ack" | "coauthor" | "llm" | "affinity" | "topic";
interface Signal {
  kind: SignalKind;
  /** 1–4 display strength. */
  dots: number;
  strength: string;
}

/** The five core-usage signals (ack, co-author, LLM, repeat-user, prefilter prior). */
const SIGNAL_COUNT = 5;
/** Stable tie-break so equal-strength signals keep a deterministic order. */
const KIND_ORDER: Record<SignalKind, number> = {
  ack: 0,
  coauthor: 1,
  llm: 2,
  affinity: 3,
  topic: 4,
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
 * Which of the five signals fired for a row. Strength is FIXED PER SIGNAL TYPE —
 * how much that *kind* of evidence should move a reviewer — NOT the model's
 * self-score: ack = Direct (4), core-staff co-author = Strong (3),
 * LLM read = Moderate (2) regardless of score, repeat-user prior and the
 * prefilter prior = Weak (1) — both are indirect priors, not direct evidence
 * about this specific paper. Note the prefilter prior OVERLAPS the repeat-user
 * one by construction (see decodeTopicalPrior): on an author-only prior the two
 * rows are the same evidence, which is why that case says so out loud rather
 * than reading as independent corroboration. The raw value rides along as the
 * signal's value line — LLM as a score out of 10, and repeat-user as a
 * percentage whose MEANING changed with ReciterAI #382: it used to be a capped
 * strength (values piled on the 0.85 ceiling — 84% of one live queue sat exactly
 * there), and is now a rate, the share of an author's own corpus already given
 * to this core, so the same paper reads single digits where it used to read 85%.
 * Pure; ordered strongest-first.
 */
export function buildSignals(row: CoreQueueRow): Signal[] {
  const out: Signal[] = [];
  if (row.signalAck || row.ackAlias) out.push({ kind: "ack", dots: 4, strength: "Direct" });
  if (row.coauthors.length > 0) out.push({ kind: "coauthor", dots: 3, strength: "Strong" });
  if (row.llmScore !== null) out.push({ kind: "llm", dots: 2, strength: "Moderate" });
  if (row.authorAffinity !== null) out.push({ kind: "affinity", dots: 1, strength: "Weak" });
  // A prior of 0 is the prefilter saying NEITHER of its signals fired — absent
  // evidence, which by the engine's own convention emits no key rather than a
  // zero-valued one (pipeline_cores/combine.py evidence_features). Rendering it
  // would put a "0%" chip on a row that has nothing to show.
  if (row.topicalPrior !== null && row.topicalPrior > 0)
    out.push({ kind: "topic", dots: 1, strength: "Weak" });
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

/**
 * The collapsed evidence line as label/value pairs, so the values carry the
 * weight rather than a run-on sentence. `clientCwids` is the core's own "Known
 * clients" list (lowercased CWIDs) — a byline author on it is a stronger read
 * than a bare WCM co-author. Pure.
 */
export function evidenceTokens(
  row: CoreQueueRow,
  clientCwids: ReadonlySet<string> = new Set(),
): EvidenceToken[] {
  const tokens: EvidenceToken[] = [];
  if (row.ackAlias) tokens.push({ label: "Acknowledged as", value: `“${row.ackAlias}”` });
  else if (row.signalAck) tokens.push({ label: "Acknowledged", value: "in the full text" });
  if (row.coauthors.length > 0) {
    const named = row.coauthorScholars[0]?.name ?? row.coauthors[0];
    tokens.push({ label: "Staff co-author", value: named });
  }
  const clients = row.wcmAuthors.filter((a) => clientCwids.has(a.cwid.toLowerCase()));
  if (clients.length > 0) {
    tokens.push({
      label: clients.length > 1 ? "Client co-authors" : "Client co-author",
      value: clients.map((c) => c.name).join("; "),
    });
  }
  if (row.authorAffinity !== null) {
    tokens.push({
      label: "Repeat user",
      value: `${Math.round(row.authorAffinity * 100)}% of an author's own work`,
    });
  }
  if (row.llmScore !== null) {
    tokens.push({ label: "LLM on title and abstract", value: llmVerdict(row.llmScore) });
  }
  return tokens;
}

/**
 * Which evidence KINDS fired on a row, as a stable grouping key ("ack+coauthor",
 * "llm", "none"). The prefilter prior is left out on purpose: by construction it
 * restates the repeat-user prior (see decodeTopicalPrior), so grouping on it
 * would split one pile of evidence into two under different names. Pure.
 */
export function evidenceGroupKey(row: CoreQueueRow): string {
  const kinds = buildSignals(row)
    .map((s) => s.kind)
    .filter((k) => k !== "topic");
  return kinds.length === 0 ? "none" : kinds.join("+");
}

/** The evidence vocabulary a group header speaks. */
const GROUP_NAMES: Record<string, string> = {
  ack: "acknowledgment",
  coauthor: "staff co-author",
  llm: "LLM read",
  affinity: "repeat user",
  none: "no labelled signal",
};

/** "3 papers · acknowledgment + staff co-author" — singular-safe. Pure. */
export function evidenceGroupLabel(key: string, count: number): string {
  const kinds = key
    .split("+")
    .map((k) => GROUP_NAMES[k] ?? k)
    .join(" + ");
  return `${count} ${count === 1 ? "paper" : "papers"} · ${kinds}`;
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
];

const SORTS: { key: SortKey; label: string }[] = [
  { key: "likelihood", label: "Most certain first" },
  { key: "uncertain", label: "Most uncertain first" },
  { key: "strongest", label: "Strongest signal" },
  { key: "llm", label: "LLM score" },
  { key: "year", label: "Newest in PubMed" },
  { key: "cites", label: "Most cited" },
];

/** Highest single-signal strength on a row (0 when nothing fired). */
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
 * Three fields the artboard's blob searched are dropped, each because the row
 * doesn't carry it or the card doesn't show it:
 *   - method family + tool: now ON the row (`methodTier` / `methodEvidence`,
 *     plumbed from the engine's CORE# items) but deliberately not rendered yet —
 *     whether method is a sixth counted signal or an uncounted chip strip is an
 *     open owner decision, and the `SIGNAL_COUNT = 5` denominator turns on it.
 *     Nothing shows it, so searching it would be an invisible match. NOTE the
 *     filter placeholder DOES say "method" (the owner took the mockup's string)
 *     — that word stays aspirational until the card RENDERS method, not a bug
 *     in this function;
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
}

export function CoreClaimQueue({
  core,
  candidates,
  confirmed,
  rejected = [],
  clients = [],
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
  const [addPending, setAddPending] = useState(false);
  const [addResult, setAddResult] = useState<string | null>(null);
  // "Known clients" (ReciterAI #383 / SPS #2607) — the panel's open/closed
  // state and its list live here (not in CoreClientsPanel), the same
  // controlled-child pattern as Add PMIDs above, so the panel body can render
  // as a toolbar sibling instead of a toolbar child (see the render below).
  const [clientsOpen, setClientsOpen] = useState(false);
  const [clientRows, setClientRows] = useState<CoreClientRow[]>(clients);
  const router = useRouter();

  const clientCwids: ReadonlySet<string> = new Set(clientRows.map((c) => c.cwid.toLowerCase()));

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
    setAddText("");
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
  // ponytail: five extra passes over `open`, recomputed every render, no memo.
  // Fine at the sizes cores actually queue, but loadCoreReviewQueue has no
  // LIMIT — if one core ever returns thousands of candidates, fold these into a
  // single reduce or wrap them in useMemo([candidates, decided]).
  const facetCounts: Record<FilterKey, number> = {
    client: open.filter((c) => matchesFilter(c, "client", clientCwids)).length,
    ack: open.filter((c) => matchesFilter(c, "ack", clientCwids)).length,
    coauthored: open.filter((c) => matchesFilter(c, "coauthored", clientCwids)).length,
    noprior: open.filter((c) => matchesFilter(c, "noprior", clientCwids)).length,
    llm: open.filter((c) => matchesFilter(c, "llm", clientCwids)).length,
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
      const k = evidenceGroupKey(r);
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
      {/* The mockup's top row. Its left half is the "Co-author signal draws on N
          core staff …" lock chip + "Manage staff" link, which is NOT built: SPS
          ingests no core-staff dictionary count and there is no such route, so
          the row is buttons alone, right-aligned. */}
      <div
        data-slot="core-queue-toolbar"
        className="mb-2 flex flex-wrap items-center justify-end gap-2"
      >
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setClientsOpen((v) => !v)}
            aria-pressed={clientsOpen}
            className="border-border-strong text-muted-foreground hover:text-foreground inline-flex h-8 items-center gap-1.5 rounded-full border bg-background px-3 text-sm"
          >
            <Users className="size-4" aria-hidden /> Known clients (
            <span className="tabular-nums">{clientRows.length}</span>)
          </button>
          <button
            type="button"
            onClick={() => {
              setAddOpen((v) => !v);
              setAddResult(null);
            }}
            aria-pressed={addOpen}
            className="border-border-strong text-muted-foreground hover:text-foreground inline-flex h-8 items-center gap-1.5 rounded-full border bg-background px-3 text-sm"
          >
            <Plus className="size-4" aria-hidden /> Add PMIDs
          </button>
          {/* The mockup's third button. There IS no core reporting route in this
              repo, so it ships DISABLED with the reason on it rather than as a
              live control that no-ops — an enabled button that does nothing is
              the failure this codebase keeps getting burned by. */}
          {/* aria-disabled, NOT the native `disabled` attribute. `disabled` removes the
              button from the tab order, which would make the explanation below
              mouse-hover-only — the keyboard and screen-reader users most likely to
              wonder why it does nothing are exactly the ones who could never reach it.
              Focusable + aria-disabled keeps it announced and readable; the click is a
              no-op and the reason is in the accessible name, not just a title. */}
          <button
            type="button"
            aria-disabled="true"
            aria-describedby="core-queue-reporting-why"
            onClick={(e) => e.preventDefault()}
            title="Reporting view is not built yet"
            className="border-border-strong text-muted-foreground inline-flex h-8 cursor-not-allowed items-center gap-1.5 rounded-full border bg-background px-3 text-sm opacity-50"
          >
            <FileText className="size-4" aria-hidden /> Reporting...
          </button>
          <span id="core-queue-reporting-why" className="sr-only">
            Reporting view is not built yet
          </span>
        </div>
      </div>

      {addOpen ? (
        <div className="border-apollo-border bg-apollo-surface mb-3 rounded-lg border p-3">
          <label
            htmlFor="core-claim-add-pmids"
            className="text-foreground mb-1.5 block text-sm font-medium"
          >
            Claim known PMIDs directly
          </label>
          <p className="text-muted-foreground mb-2 text-xs">
            One per line, or comma/space-separated. Independent of the review queue — use this for
            a paper you know used this core that our signals never surfaced.
          </p>
          <textarea
            id="core-claim-add-pmids"
            value={addText}
            onChange={(e) => setAddText(e.target.value)}
            placeholder="39812345, 38209981&#10;37102244"
            rows={3}
            className="border-border-strong text-foreground bg-apollo-surface focus-visible:ring-apollo-maroon w-full rounded-md border px-2.5 py-2 text-sm focus-visible:outline-none focus-visible:ring-2"
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              disabled={addPending || addText.trim().length === 0}
              onClick={submitAddPmids}
              className="inline-flex h-8 items-center gap-1.5 rounded-full bg-[var(--color-accent-slate)] px-3 text-sm text-white disabled:opacity-50"
            >
              {addPending ? "Claiming…" : "Claim"}
            </button>
            <button
              type="button"
              onClick={() => {
                setAddOpen(false);
                setAddText("");
                setAddResult(null);
              }}
              className="border-border-strong text-muted-foreground hover:text-foreground inline-flex h-8 items-center rounded-full border bg-background px-3 text-sm"
            >
              Cancel
            </button>
          </div>
          {addResult ? (
            <p className="text-muted-foreground mt-2 text-xs" role="status">
              {addResult}
            </p>
          ) : null}
        </div>
      ) : null}

      {clientsOpen ? (
        <CoreClientsPanel
          coreId={core.id}
          clients={clientRows}
          onClientsChange={setClientRows}
          onClose={() => setClientsOpen(false)}
        />
      ) : null}

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
            /* "method" is ASPIRATIONAL: `searchBlob` does not search a method
               family or tool because `CoreQueueRow` never carries one. The owner
               chose the mockup's string over the trimmed one; the word starts
               being true when method data reaches this row, and until then a
               method query simply matches nothing. Not a bug — see searchBlob. */
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

// A confirmed publication with an inline Revoke (kept walk-back-able for the
// session — the one thing this list needs to earn its place below the queue).
function ConfirmedRow({
  row,
  revoked,
  pending,
  error,
  onRevoke,
  onUndo,
}: {
  row: CoreQueueRow;
  revoked: boolean;
  pending: boolean;
  error: string | undefined;
  onRevoke: () => void;
  onUndo: () => void;
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
  return (
    <li className="text-muted-foreground flex items-center justify-between gap-2 text-sm">
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
  const signals = buildSignals(row);
  const tokens = evidenceTokens(row, clientCwids);
  // The header's meta line, middot-separated: the abbreviated journal (the full
  // title is a paragraph for some journals), when PubMed indexed it, then the
  // PMID. Each part is dropped when its data is missing rather than rendered
  // empty, so the separators are built from what actually survives.
  const journalLabel = row.journalAbbrev ?? row.journal;
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
          <Byline row={row} />
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

      {expanded ? (
        <div className="border-border-strong mt-3 ml-1 border-l-2 pl-3.5">
          {signals.length === 0 ? (
            <p className="bg-apollo-amber-tint border-apollo-amber-tint-border text-apollo-amber rounded-lg border px-3 py-2.5 text-[12.5px] leading-relaxed">
              No labelled signal. The score moved on engine inputs this queue doesn&rsquo;t show;
              judge it on the paper.
            </p>
          ) : (
            <ul aria-label="evidence">
              {signals.map((s) => (
                <SignalRow key={s.kind} signal={s} row={row} />
              ))}
            </ul>
          )}
        </div>
      ) : null}

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
function SignalRow({ signal, row }: { signal: Signal; row: CoreQueueRow }) {
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
      value = `${row.coauthors.length} ${row.coauthors.length === 1 ? "person" : "people"}`;
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
    case "affinity":
      // Post-ReciterAI #382 this is a RATE, not a capped strength, so the copy has
      // to say what the percentage is a share OF — a bare number next to "Weak"
      // reads as a regression when the same paper drops from 85% to 6%.
      label = "Repeat user";
      value = `${Math.round((row.authorAffinity ?? 0) * 100)}%`;
      detail =
        "The largest share of any byline author's own publications that are work with this core";
      break;
    case "topic": {
      const { mesh, affinity } = decodeTopicalPrior(row.topicalPrior ?? 0);
      label =
        mesh && affinity
          ? "MeSH match + repeat user"
          : mesh
            ? "Topical MeSH match"
            : "Prefilter prior — repeat user, no MeSH match";
      value = `${Math.round((row.topicalPrior ?? 0) * 100)}%`;
      detail =
        mesh && affinity
          ? "Carries a MeSH descriptor under this core's technique branch, and an author with prior confirmed use"
          : mesh
            ? "The paper carries a MeSH descriptor under this core's technique branch"
            : "An author has prior confirmed use of this core. No MeSH descriptor matched — the same evidence as the repeat-user row above";
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

/** The staff co-author detail line — linked scholars (with dept) plus any bare CWIDs. */
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
          {s.dept ? <span className="text-muted-foreground"> ({s.dept})</span> : null}
        </span>
      ))}
      {unresolved.length > 0 ? <span>; {unresolved.join(", ")}</span> : null}
    </>
  );
}

/**
 * Author byline with the core-staff author(s) highlighted as a tinted, linked
 * chip + tooltip — the connection back to the co-author evidence row below.
 * ponytail: best-effort surname match against the flat `authorsString` (the data
 * carries no per-author byline token; this mirrors how profile author-links are
 * overlaid). Unresolved core-staff CWIDs aren't in the byline, so they show only
 * in the evidence row.
 */
function Byline({ row }: { row: CoreQueueRow }) {
  if (!row.authorsString) return null;
  const staffBySurname = new Map<string, QueueScholar>();
  for (const s of row.coauthorScholars) {
    const surname = s.name.trim().split(/\s+/).pop();
    if (surname) staffBySurname.set(surname.toLowerCase(), s);
  }
  if (staffBySurname.size === 0) {
    return <p className="text-muted-foreground mt-1 text-xs">{row.authorsString}</p>;
  }
  const tokens = row.authorsString.split(", ");
  return (
    <p className="text-muted-foreground mt-1 text-xs">
      {tokens.map((tok, i) => {
        const lead = tok.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
        const staff = staffBySurname.get(lead);
        return (
          <span key={i}>
            {i > 0 ? ", " : ""}
            {staff ? (
              <HoverTooltip
                text={`${staff.name} — core staff${staff.dept ? `, ${staff.dept}` : ""}`}
              >
                {staff.slug ? (
                  <a
                    href={`/${staff.slug}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="bg-[var(--color-accent-slate)]/15 text-[var(--color-accent-slate)] rounded px-1 py-px font-medium"
                  >
                    {tok}
                  </a>
                ) : (
                  <span className="bg-[var(--color-accent-slate)]/15 text-[var(--color-accent-slate)] rounded px-1 py-px font-medium">
                    {tok}
                  </span>
                )}
              </HoverTooltip>
            ) : (
              tok
            )}
          </span>
        );
      })}
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

/** Link to a scholar's public profile (`/{slug}`), opening in a new tab. */
function ScholarLink({ scholar }: { scholar: QueueScholar }) {
  // ED-only staff (no Scholar row) have no profile to link to — name only.
  if (!scholar.slug) return <span className="text-foreground">{scholar.name}</span>;
  return (
    <a
      href={`/${scholar.slug}`}
      target="_blank"
      rel="noopener noreferrer"
      className="text-foreground hover:underline"
    >
      {scholar.name}
    </a>
  );
}
