/**
 * "From your publications" — the self-only (and, by operator decision, superuser-
 * proxy) advisory SUB-VIEW of Conflicts of Interest (`SELF_EDIT_COI_GAP_HINT`,
 * dormant). It surfaces relationships named in the "Competing interests"
 * statements of a scholar's OWN PubMed-indexed papers that we could not match to a
 * current Weill Research Gateway disclosure.
 *
 * #1112 REDESIGN. The atomic unit is the MENTION (one paper × one matched
 * organization). The card fetches ONE flat mention set and pivots it ENTIRELY
 * client-side into two views:
 *
 *   - Organization view (default): one card per matched org, with a muted summary
 *     line (year range + attribution split + relationship kinds) and per-mention
 *     rows that show the TRIMMED clause (org + subject highlighted) plus PER-ROW
 *     actions and a "full statement" expand.
 *   - Paper view: one card per competing-interests statement (verbatim fullText),
 *     split into one block per disclosure SUBJECT, each with its OWN footer
 *     actions.
 *
 * The atomic decision is the MENTION (one `candidateId` = one paper × one org).
 * In Organization view a row action resolves ONLY that company's mention — it does
 * NOT clear the paper's other organizations. In Paper view the statement footer
 * resolves all of that statement's currently-current org mentions at once (a
 * convenience batch). Either way the response fans out to the chosen `candidateId`s
 * via the unchanged per-id `/feedback` (or `/restore`) routes, and a mention
 * resolved in one view shows resolved in the other. The feedback SEMANTICS are
 * unchanged (will_disclose → acknowledged; historical / invalid → dismissed); only
 * the client-side fan-out SCOPE and the UI change.
 *
 * HIGHLIGHTING (spec §4): in any rendered clause / statement we mark EXACTLY two
 * things — the matched organization(s) (amber chip) and the SINGLE disclosure
 * subject (self = bold + 1px underline; co-author = purple chip; unknown = no
 * inline mark + a dashed "Subject unclear" tag). Never any other name. Hue is
 * never the only signal: every mark carries an aria-label and attribution is
 * restated in text.
 *
 * Governance posture (non-negotiable — `docs/coi-pubmed-unmatched-feasibility.md`):
 *   - SUGGEST, never accuse. The forbidden vocabulary (undisclosed / failed to
 *     disclose / missing / violation / gap / audit / compliance) appears NOWHERE.
 *   - The verbatim statement is ALWAYS available so the human, not a score,
 *     adjudicates. Confidence is a qualitative tier only — never a percentage,
 *     never the numeric score (which never crosses to the client).
 *   - SPS is NOT the COI system of record: no in-app COI editing. "Review in
 *     Gateway" routes to WRG via the existing `coi` Request-a-Change flow.
 *   - Subject attribution is honest: an unresolved subject is "unclear", NEVER
 *     guessed as the scholar.
 *
 * A (non-impersonating) superuser may view + act on the scholar's behalf, with a
 * confirmation "nag" before any write. Who may load it is enforced upstream
 * (`loadEditContext`) and again at the feedback / restore APIs; this component
 * renders only what it is handed.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowUpRight, ChevronLeft, EyeOff, Info, Lock } from "lucide-react";

import { ConfirmDialog } from "@/components/edit/confirm-dialog";
import { EditPanel } from "@/components/edit/edit-panel";
import { RequestAChangeDialog } from "@/components/edit/request-a-change-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { EditContextCoiGapMention } from "@/lib/api/edit-context";
import {
  computeHighlightSpans,
  humanizeRelationshipKinds,
  type HighlightSpan,
} from "@/lib/coi-gap/mention";
import { FEEDBACK_REASONS, type FeedbackReason } from "@/lib/coi-gap/feedback";

export type CoiGapCardProps = {
  cwid: string;
  /** `superuser` reframes the advisory copy + the privacy chip to the scholar's
   *  name and gates every action behind a confirmation "nag" — a superuser acts
   *  on this sensitive surface on the scholar's behalf (operator decision). */
  mode?: "self" | "superuser";
  /** The scholar's preferred (full) name — drives the reframed copy + the
   *  attribution surname in the summary line. */
  scholarName?: string;
  /** #1112 — the FLAT mention set (one paper × one matched org). Both views are
   *  client-side pivots of this single array (spec §3/§9). */
  mentions?: ReadonlyArray<EditContextCoiGapMention>;
};

const PUBMED_URL = (pmid: string) => `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(pmid)}/`;

/** Sticky group-by preference key (spec §2 — persist last choice per user). */
const GROUP_STORAGE_KEY = "coi-gap:groupBy";

type GroupBy = "organization" | "paper";

/**
 * The scholar's three responses (operator decision — verbatim canonical labels;
 * compliance-reviewed, do NOT alter). Order matches `FEEDBACK_REASONS`. Presented
 * as EQUAL, neutral choices so the response isn't nudged. None of the forbidden
 * accusatory words appear.
 */
const CHOICE_LABEL: Record<FeedbackReason, string> = {
  will_disclose: "I intend to update my COI statement",
  historical: "Historically true but not currently valid",
  invalid: "Not a valid suggestion",
};
/** The shorter recorded form shown once a response is filed (and in the superuser
 *  nag), phrased to read in either voice. */
const ACTED_LABEL: Record<FeedbackReason, string> = {
  will_disclose: "Will update COI statement",
  historical: "Historically true, not currently valid",
  invalid: "Not a valid suggestion",
};

/** Filter (softened, non-task wording — overrides the spec's review-queue copy). */
type ShowFilter = "current" | "set_aside" | "all";
const FILTER_OPTIONS: ReadonlyArray<{ value: ShowFilter; label: string }> = [
  { value: "current", label: "Current" },
  { value: "set_aside", label: "Set aside" },
  { value: "all", label: "All" },
];

/** The last whitespace token of a full name, for the attribution summary line. */
function lastNameOf(full: string): string {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : full.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared highlighting renderer (spec §4) — self-contained inline-style tokens for
// BOTH light + dark, so it never depends on a Tailwind class being present. Marks
// ONLY org(s) + the single subject; everything else is plain text. Each mark
// carries an aria-label and the attribution is ALSO restated in text (summary
// line + subject tag), so hue is never the only signal.
// ─────────────────────────────────────────────────────────────────────────────

/** Two highlight roles only — COMPANY (the named organization) and PERSON (the
 *  named subject, self OR co-author alike). Uses the console's calm tint tokens
 *  (auto light/dark), so marks stay light and consistent with the rest of /edit.
 *  Self vs co-author is conveyed in TEXT — the row's subject tag + the accessible
 *  label — never by color. A small key names the two swatches. The leading
 *  `coi-hl-*` token is a stable hook for tests; the visual is the tint utilities. */
const HL_ORG = "coi-hl-org bg-apollo-amber-tint rounded-[2px] px-0.5 whitespace-nowrap";
const HL_PERSON = "coi-hl-person bg-apollo-slate-tint rounded-[2px] px-0.5 whitespace-nowrap";

/** Marks for a single rendered clause/statement. */
function MarkedText({
  text,
  organizationRaws,
  subjectType,
  subjectMention,
}: {
  text: string;
  organizationRaws: ReadonlyArray<string>;
  subjectType: EditContextCoiGapMention["subjectType"];
  subjectMention: string | null;
}) {
  // unknown subjects mark nothing inline (the dashed tag carries the signal).
  const subjForSpans = subjectType === "unknown" ? null : subjectMention;
  const spans: HighlightSpan[] = computeHighlightSpans(text, organizationRaws, subjForSpans);
  if (spans.length === 0) return <>{text}</>;
  const out: React.ReactNode[] = [];
  let cursor = 0;
  spans.forEach((span, i) => {
    if (span.start > cursor) out.push(<span key={`t${i}`}>{text.slice(cursor, span.start)}</span>);
    if (span.role === "organization") {
      out.push(
        <mark key={`m${i}`} className={HL_ORG} aria-label={`organization: ${span.text}`}>
          {span.text}
        </mark>,
      );
    } else {
      // One PERSON treatment for self and co-author alike; the distinction lives in
      // the accessible label + the row's subject tag, not in color.
      const label =
        subjectType === "self"
          ? "you"
          : subjectType === "coauthor"
            ? `co-author: ${span.text}`
            : `person: ${span.text}`;
      out.push(
        <mark key={`m${i}`} className={HL_PERSON} aria-label={label}>
          {span.text}
        </mark>,
      );
    }
    cursor = span.end;
  });
  if (cursor < text.length) out.push(<span key="tail">{text.slice(cursor)}</span>);
  return <>{out}</>;
}

/** The dashed "Subject unclear" tag (unknown subjects, row/card level). */
function UnclearTag() {
  return (
    <span
      className="border-apollo-border text-muted-foreground inline-flex items-center rounded-full border border-dashed px-2 py-px text-[11px]"
      data-testid="coi-gap-unclear"
    >
      Subject unclear
    </span>
  );
}

/** The right-aligned subject tag for Paper view + the Paper-view sub-block header. */
function SubjectTag({
  subjectType,
  subjectMention,
}: {
  subjectType: EditContextCoiGapMention["subjectType"];
  subjectMention: string | null;
}) {
  if (subjectType === "self") {
    return <span className="text-apollo-slate text-sm font-medium">you</span>;
  }
  if (subjectType === "coauthor") {
    return (
      <span className="text-apollo-slate text-sm font-medium">
        co-author · {subjectMention ?? "unnamed"}
      </span>
    );
  }
  return <UnclearTag />;
}

// ─────────────────────────────────────────────────────────────────────────────
// Decisions are atomic at the MENTION (`candidateId` = one paper × one org), so an
// Organization-view row resolves only that company. A Paper-view footer batches all
// of a statement's currently-current mentions. `${pmid}::${subjectId}` still keys a
// Paper-view subject BLOCK (for grouping + its footer testids), not the decision.
// ─────────────────────────────────────────────────────────────────────────────

const unitKeyOf = (m: EditContextCoiGapMention) => `${m.pmid}::${m.subjectId}`;

export function CoiGapCard({
  cwid,
  mode = "self",
  scholarName = "",
  mentions: mentionsProp = [],
}: CoiGapCardProps) {
  const su = mode === "superuser";
  const backHref = su ? `/edit/scholar/${cwid}?attr=coi` : "/edit?attr=coi";
  const scholarLast = lastNameOf(scholarName) || (su ? "the scholar" : "you");

  // This surface is about the SCHOLAR'S OWN relationships. A co-author's
  // disclosure that merely rode along in a shared paper's statement is not the
  // scholar's to act on, so it is never surfaced here — only `self` and
  // `unknown` (subject-unclear) mentions are. (`edit-context` also excludes
  // co-authors from the projection; this is defence-in-depth.)
  const mentions = React.useMemo(
    () => mentionsProp.filter((m) => m.subjectType !== "coauthor"),
    [mentionsProp],
  );

  // Sticky group-by (spec §2). SSR-safe: start with the default, then read
  // localStorage in an effect (no hydration mismatch).
  const [groupBy, setGroupBy] = React.useState<GroupBy>("organization");
  React.useEffect(() => {
    try {
      const saved = window.localStorage.getItem(GROUP_STORAGE_KEY);
      if (saved === "organization" || saved === "paper") setGroupBy(saved);
    } catch {
      /* private mode / disabled storage — keep the default. */
    }
  }, []);
  const chooseGroup = React.useCallback((g: GroupBy) => {
    setGroupBy(g);
    try {
      window.localStorage.setItem(GROUP_STORAGE_KEY, g);
    } catch {
      /* ignore */
    }
  }, []);

  const [filter, setFilter] = React.useState<ShowFilter>("current");

  // The superuser "nag": confirm before recording any response (or undo). Carries
  // the exact candidate ids the action targets + the org breadth (for the toast).
  // `target` is the chosen reason, or null for an undo. Null when closed.
  const [confirm, setConfirm] = React.useState<{
    ids: string[];
    target: FeedbackReason | null;
    orgCount: number;
  } | null>(null);

  // LOCAL decision overlay, keyed by `candidateId` (the mention). The DB is the
  // source of truth on reload; this reflects optimistic in-session decisions across
  // both views simultaneously. `restored` = explicitly returned to Current.
  const [decided, setDecided] = React.useState<Map<string, FeedbackReason>>(new Map());
  const [restored, setRestored] = React.useState<Set<string>>(new Set());
  const [pending, setPending] = React.useState<Set<string>>(new Set());
  const [errors, setErrors] = React.useState<Map<string, string>>(new Map());

  // A gentle resolve toast (aria-live polite, ~5s) reporting the org breadth; its
  // Undo restores exactly the ids the action set aside.
  const [toast, setToast] = React.useState<{ ids: string[]; orgCount: number; reason: FeedbackReason } | null>(null);
  const toastTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  // Persisted (server-side) set-aside state per `candidateId` — used when there is
  // no local override.
  const { persistedReason, persistedSetAside } = React.useMemo(() => {
    const persistedReason = new Map<string, FeedbackReason>();
    const persistedSetAside = new Set<string>();
    for (const m of mentions) {
      if (m.status === "set_aside") {
        persistedSetAside.add(m.candidateId);
        if (m.reason) persistedReason.set(m.candidateId, m.reason);
      }
    }
    return { persistedReason, persistedSetAside };
  }, [mentions]);

  // The effective decision state for a MENTION: a local override wins; else the
  // persisted server state; `restored` clears it back to Current.
  const effectiveReason = React.useCallback(
    (candId: string): FeedbackReason | null => {
      if (restored.has(candId)) return null;
      if (decided.has(candId)) return decided.get(candId)!;
      if (persistedSetAside.has(candId)) return persistedReason.get(candId) ?? "invalid";
      return null;
    },
    [restored, decided, persistedSetAside, persistedReason],
  );
  const isSetAside = React.useCallback((candId: string) => effectiveReason(candId) !== null, [effectiveReason]);

  function setErrorsFor(ids: string[], msg: string | null) {
    setErrors((prev) => {
      const next = new Map(prev);
      for (const id of ids) {
        if (msg === null) next.delete(id);
        else next.set(id, msg);
      }
      return next;
    });
  }

  // Resolve / undo a set of MENTIONS — flips local state per `candidateId`, then
  // POSTs the existing per-id route for EACH id (a reason → /feedback, an undo →
  // /restore). An Organization row passes ONE id (just that company); a Paper
  // footer passes the statement's currently-current ids. Both routes are idempotent
  // + server-guarded, so a retry converges. On failure we roll the whole batch back.
  function mutate(ids: string[], target: FeedbackReason | null, orgCount: number) {
    if (ids.length === 0) return;
    const previous = new Map<string, FeedbackReason | null>();
    for (const id of ids) previous.set(id, effectiveReason(id));
    setErrorsFor(ids, null);
    setPending((p) => {
      const next = new Set(p);
      for (const id of ids) next.add(id);
      return next;
    });
    // Optimistic local flip.
    if (target === null) {
      setRestored((s) => {
        const next = new Set(s);
        for (const id of ids) next.add(id);
        return next;
      });
      setDecided((m) => {
        const next = new Map(m);
        for (const id of ids) next.delete(id);
        return next;
      });
    } else {
      setRestored((s) => {
        const next = new Set(s);
        for (const id of ids) next.delete(id);
        return next;
      });
      setDecided((m) => {
        const next = new Map(m);
        for (const id of ids) next.set(id, target);
        return next;
      });
      // Gentle resolve toast with the org breadth + Undo (~5s, aria-live polite).
      if (toastTimer.current) clearTimeout(toastTimer.current);
      setToast({ ids, orgCount, reason: target });
      toastTimer.current = setTimeout(() => setToast(null), 5000);
    }
    void (async () => {
      try {
        const results = await Promise.all(
          ids.map(async (id) => {
            const base = `/api/edit/coi-gap/${encodeURIComponent(id)}`;
            const res = await fetch(target === null ? `${base}/restore` : `${base}/feedback`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: target === null ? "{}" : JSON.stringify({ reason: target }),
            });
            const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
            return res.ok && data.ok === true;
          }),
        );
        if (!results.every(Boolean)) {
          rollBack(ids, previous);
          setErrorsFor(ids, "We couldn’t update this just now. Please try again.");
        }
      } catch {
        rollBack(ids, previous);
        setErrorsFor(ids, "We couldn’t update this just now. Please try again.");
      } finally {
        setPending((p) => {
          const next = new Set(p);
          for (const id of ids) next.delete(id);
          return next;
        });
      }
    })();
  }

  function rollBack(ids: string[], previous: Map<string, FeedbackReason | null>) {
    setToast((t) => (t && t.ids.some((id) => ids.includes(id)) ? null : t));
    setRestored((s) => {
      const next = new Set(s);
      for (const id of ids) (previous.get(id) == null ? next.add(id) : next.delete(id));
      return next;
    });
    setDecided((m) => {
      const next = new Map(m);
      for (const id of ids) {
        const p = previous.get(id);
        if (p == null) next.delete(id);
        else next.set(id, p);
      }
      return next;
    });
  }

  // A superuser routes every response through the confirm "nag" first; a scholar
  // records directly on their own suggestions.
  function requestMutate(ids: string[], target: FeedbackReason | null, orgCount: number) {
    if (su) setConfirm({ ids, target, orgCount });
    else mutate(ids, target, orgCount);
  }

  // Which mentions pass the active Show filter.
  const filterMention = React.useCallback(
    (candId: string) => {
      const setAside = isSetAside(candId);
      if (filter === "current") return !setAside;
      if (filter === "set_aside") return setAside;
      return true;
    },
    [filter, isSetAside],
  );

  // Primary counter (spec §2/§7 — HIGH confidence only; Medium excluded). Counts
  // distinct COMPANIES (the Organization-view decision grain): a company is current
  // if any of its high mentions is current, set aside once all are. Softened copy.
  const highByOrg = new Map<string, EditContextCoiGapMention[]>();
  for (const m of mentions) {
    if (m.confidence !== "high") continue;
    const arr = highByOrg.get(m.organization) ?? [];
    arr.push(m);
    highByOrg.set(m.organization, arr);
  }
  let currentCompanies = 0;
  let setAsideCompanies = 0;
  for (const arr of highByOrg.values()) {
    if (arr.some((m) => !isSetAside(m.candidateId))) currentCompanies += 1;
    else setAsideCompanies += 1;
  }
  const voicePoss = su ? "their" : "your";
  const counter =
    currentCompanies === 0 && setAsideCompanies === 0
      ? "Nothing here right now"
      : `${currentCompanies} from ${voicePoss} publications` +
        (setAsideCompanies > 0 ? ` · ${setAsideCompanies} set aside` : "");

  const confirmName = scholarName || "the scholar";

  // ── shared action set ──────────────────────────────────────────────────────
  // `ids` = the candidate ids this action resolves (one for an Org row; the
  // statement's current ids for a Paper footer). `orgCount` is the toast breadth.
  // `scope` keys the testids (the row's candidateId in Org view; the block unitKey
  // in Paper view).
  function ActionSet({
    ids,
    orgCount,
    scope,
    isPending,
  }: {
    ids: string[];
    orgCount: number;
    scope: string;
    isPending: boolean;
  }) {
    return (
      <div className="mt-2 flex flex-wrap gap-2" data-testid={`coi-gap-choices-${scope}`}>
        {FEEDBACK_REASONS.map((r) => (
          <Button
            key={r}
            type="button"
            variant="outline"
            size="sm"
            disabled={isPending}
            onClick={() => requestMutate(ids, r, orgCount)}
            data-testid={`coi-gap-choice-${r}-${scope}`}
          >
            {CHOICE_LABEL[r]}
          </Button>
        ))}
      </div>
    );
  }

  // The settled in-place "set aside" line with Undo (used in both views).
  function SetAsideLine({
    reason,
    ids,
    orgCount,
    scope,
    isPending,
  }: {
    reason: FeedbackReason;
    ids: string[];
    orgCount: number;
    scope: string;
    isPending: boolean;
  }) {
    return (
      <div className="flex items-center justify-between gap-3 opacity-80">
        <span className="text-muted-foreground text-sm" data-testid={`coi-gap-acted-${scope}`}>
          Set aside · {ACTED_LABEL[reason]}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={isPending}
          onClick={() => requestMutate(ids, null, orgCount)}
          data-testid={`coi-gap-undo-${scope}`}
        >
          Undo
        </Button>
      </div>
    );
  }

  function GatewayReview({ label, testid }: { label: string; testid: string }) {
    return (
      <RequestAChangeDialog
        attribute="coi"
        cwid={cwid}
        itemLabel={label}
        triggerTestId={testid}
        trigger={(open) => (
          <button
            type="button"
            onClick={open}
            className="text-apollo-slate inline-flex items-center gap-1 text-[0.85rem] font-medium hover:underline"
          >
            Review in Gateway
            <ArrowUpRight className="size-3.5" aria-hidden />
          </button>
        )}
      />
    );
  }

  // ── ORGANIZATION VIEW ──────────────────────────────────────────────────────
  // Group the mentions by normalized org, then render newest-first rows. Each row
  // belongs to a decision unit; per-row actions resolve that unit.
  type OrgCard = {
    organization: string;
    organizationRaw: string;
    mentions: EditContextCoiGapMention[];
  };
  function buildOrgCards(set: ReadonlyArray<EditContextCoiGapMention>): OrgCard[] {
    const byOrg = new Map<string, OrgCard>();
    for (const m of set) {
      let c = byOrg.get(m.organization);
      if (!c) {
        c = { organization: m.organization, organizationRaw: m.organizationRaw, mentions: [] };
        byOrg.set(m.organization, c);
      }
      c.mentions.push(m);
    }
    for (const c of byOrg.values()) c.mentions.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
    return [...byOrg.values()].sort((a, b) => a.organization.localeCompare(b.organization));
  }

  function OrgCardView({ card, lower }: { card: OrgCard; lower: boolean }) {
    // The summary line attribution split + year range + relationship kinds.
    const years = card.mentions.map((m) => m.year).filter((y): y is number => y != null);
    const minY = years.length ? Math.min(...years) : null;
    const maxY = years.length ? Math.max(...years) : null;
    // Co-authors are filtered out upstream, so a mention is either the scholar's
    // own (`self`) or subject-unclear (`unknown`).
    let selfC = 0;
    let unkC = 0;
    const kinds: string[] = [];
    for (const m of card.mentions) {
      if (m.subjectType === "self") selfC += 1;
      else unkC += 1;
      for (const k of m.relationshipKinds) kinds.push(k);
    }
    const humanKinds = humanizeRelationshipKinds(kinds);
    const attrBits: string[] = [];
    if (selfC > 0) attrBits.push(`${selfC} attributed to ${scholarLast}`);
    if (unkC > 0) attrBits.push(`${unkC} unclear`);
    const attribution = attrBits.join(", ");
    const yearRange = minY != null ? (minY === maxY ? `${minY}` : `${minY}–${maxY}`) : "";
    const summaryParts = [yearRange, attribution, humanKinds.join(" · ")].filter(Boolean);

    // ONE decision per COMPANY: the action fans out to every still-current paper
    // of this org (`currentIds`); once all are set aside the footer collapses to
    // the Set-aside line (Undo restores the whole company).
    const companyIds = card.mentions.map((m) => m.candidateId);
    const currentIds = companyIds.filter((id) => !isSetAside(id));
    const cardPending = companyIds.some((id) => pending.has(id));
    const cardError = companyIds.map((id) => errors.get(id)).find(Boolean) ?? null;

    return (
      <div
        className={cn(
          "border-apollo-border rounded-lg border p-4",
          lower && "border-dashed opacity-95",
        )}
        data-testid={`coi-gap-org-card-${card.organization}`}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="flex items-center gap-2">
            <h3 className="text-foreground text-[17px] font-medium">{card.organizationRaw}</h3>
            <span className="text-muted-foreground text-xs">
              {card.mentions.length} paper{card.mentions.length === 1 ? "" : "s"}
            </span>
            {lower && <LowerFlag />}
          </div>
          <GatewayReview label={card.organizationRaw} testid={`coi-gap-org-review-${card.organization}`} />
        </div>
        {summaryParts.length > 0 && (
          <p className="text-muted-foreground mt-1 text-[13px]" data-testid={`coi-gap-org-summary-${card.organization}`}>
            {summaryParts.join(" · ")}
          </p>
        )}
        <ul className="mt-2">
          {card.mentions.slice(0, COI_GAP_PAPER_EXAMPLE_LIMIT).map((m) => (
            <OrgRow key={m.candidateId} m={m} />
          ))}
        </ul>
        {card.mentions.length > COI_GAP_PAPER_EXAMPLE_LIMIT && (
          <details data-testid={`coi-gap-org-more-${card.organization}`}>
            <summary className="text-apollo-slate mt-1 cursor-pointer text-sm font-medium">
              Show {card.mentions.length - COI_GAP_PAPER_EXAMPLE_LIMIT} more paper
              {card.mentions.length - COI_GAP_PAPER_EXAMPLE_LIMIT === 1 ? "" : "s"}
            </summary>
            <ul className="mt-1">
              {card.mentions.slice(COI_GAP_PAPER_EXAMPLE_LIMIT).map((m) => (
                <OrgRow key={m.candidateId} m={m} />
              ))}
            </ul>
          </details>
        )}
        <div className="border-apollo-border mt-3 border-t pt-3">
          {currentIds.length === 0 ? (
            <SetAsideLine
              reason={effectiveReason(companyIds[0]) ?? "invalid"}
              ids={companyIds}
              orgCount={0}
              scope={card.organization}
              isPending={cardPending}
            />
          ) : (
            <>
              {currentIds.length > 1 && (
                <p
                  className="text-muted-foreground text-xs"
                  data-testid={`coi-gap-org-hint-${card.organization}`}
                >
                  Applies to all {currentIds.length} papers
                </p>
              )}
              <ActionSet
                ids={currentIds}
                orgCount={0}
                scope={card.organization}
                isPending={cardPending}
              />
            </>
          )}
          {cardError && (
            <Alert variant="destructive" className="mt-2">
              <AlertDescription>{cardError}</AlertDescription>
            </Alert>
          )}
        </div>
      </div>
    );
  }

  function OrgRow({ m }: { m: EditContextCoiGapMention }) {
    // A row is a CITATION only — the action lives once at the company-card level,
    // since a decision applies to the whole organization across its papers.
    const [showFull, setShowFull] = React.useState(false);
    return (
      <li
        className="border-apollo-border flex gap-3 border-t py-3 first:border-t-0"
        data-testid={`coi-gap-org-row-${m.candidateId}`}
      >
        <div className="text-muted-foreground w-[84px] shrink-0 text-xs leading-snug">
          {m.year != null && <div>{m.year}</div>}
          <a
            href={PUBMED_URL(m.pmid)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-apollo-slate font-medium underline-offset-2 hover:underline"
          >
            PMID {m.pmid}
          </a>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-foreground text-sm leading-relaxed">
            <MarkedText
              text={m.clause}
              organizationRaws={[m.organizationRaw]}
              subjectType={m.subjectType}
              subjectMention={m.subjectMention}
            />
            {m.subjectType === "unknown" && (
              <>
                {" "}
                <UnclearTag />
              </>
            )}
          </p>
          {m.fullText && m.fullText !== m.clause && (
            <>
              <button
                type="button"
                onClick={() => setShowFull((v) => !v)}
                className="text-apollo-slate mt-1 text-xs font-medium hover:underline"
                data-testid={`coi-gap-fulltext-toggle-${m.candidateId}`}
                aria-expanded={showFull}
              >
                {showFull ? "Hide full statement" : "Full statement"}
              </button>
              {showFull && (
                <p
                  className="text-muted-foreground mt-1 text-[13px] leading-relaxed"
                  data-testid={`coi-gap-fulltext-${m.candidateId}`}
                >
                  <MarkedText
                    text={m.fullText}
                    organizationRaws={[m.organizationRaw]}
                    subjectType={m.subjectType}
                    subjectMention={m.subjectMention}
                  />
                </p>
              )}
            </>
          )}
        </div>
      </li>
    );
  }

  // ── PAPER VIEW ─────────────────────────────────────────────────────────────
  // Group mentions by pmid → statement; within a pmid split into one block per
  // decision unit (subject). Each block has its OWN footer actions.
  type PaperCard = {
    pmid: string;
    year: number | null;
    fullText: string;
    blocks: {
      unitKey: string;
      subjectType: EditContextCoiGapMention["subjectType"];
      subjectMention: string | null;
      organizationRaws: string[];
      /** Every candidate id (company) in this subject's statement — the footer
       *  resolves the currently-current ones in one batch. */
      candidateIds: string[];
    }[];
    lower: boolean;
  };
  function buildPaperCards(set: ReadonlyArray<EditContextCoiGapMention>): PaperCard[] {
    const byPmid = new Map<string, PaperCard>();
    const blockByUnit = new Map<string, PaperCard["blocks"][number]>();
    const seenOrg = new Map<string, Set<string>>();
    const seenCand = new Map<string, Set<string>>();
    for (const m of set) {
      let card = byPmid.get(m.pmid);
      if (!card) {
        card = { pmid: m.pmid, year: m.year, fullText: m.fullText, blocks: [], lower: true };
        byPmid.set(m.pmid, card);
      }
      if (m.confidence === "high") card.lower = false;
      const uk = unitKeyOf(m);
      let block = blockByUnit.get(uk);
      if (!block) {
        block = {
          unitKey: uk,
          subjectType: m.subjectType,
          subjectMention: m.subjectMention,
          organizationRaws: [],
          candidateIds: [],
        };
        blockByUnit.set(uk, block);
        card.blocks.push(block);
        seenOrg.set(uk, new Set());
        seenCand.set(uk, new Set());
      }
      const cset = seenCand.get(uk)!;
      if (!cset.has(m.candidateId)) {
        cset.add(m.candidateId);
        block.candidateIds.push(m.candidateId);
      }
      const oset = seenOrg.get(uk)!;
      const ok = m.organization.toLowerCase();
      if (!oset.has(ok)) {
        oset.add(ok);
        block.organizationRaws.push(m.organizationRaw);
      }
    }
    return [...byPmid.values()].sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || b.pmid.localeCompare(a.pmid));
  }

  function PaperCardView({ card }: { card: PaperCard }) {
    const multi = card.blocks.length > 1;
    const allOrgRaws = card.blocks.flatMap((b) => b.organizationRaws);
    // Single-subject: render the verbatim statement once with that subject's mark.
    const single = card.blocks[0];
    return (
      <div
        className={cn(
          "border-apollo-border rounded-lg border p-4",
          card.lower && "border-dashed opacity-95",
        )}
        data-testid={`coi-gap-paper-card-${card.pmid}`}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-muted-foreground text-[13px]">
            {card.year != null && <>{card.year} · </>}
            <a
              href={PUBMED_URL(card.pmid)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-apollo-slate font-medium underline-offset-2 hover:underline"
            >
              PMID {card.pmid}
            </a>
          </span>
          <div className="flex items-center gap-2">
            {card.lower && <LowerFlag />}
            {!multi && (
              <span data-testid={`coi-gap-paper-subject-${card.pmid}`}>
                <SubjectTag subjectType={single.subjectType} subjectMention={single.subjectMention} />
              </span>
            )}
          </div>
        </div>

        {!multi ? (
          <>
            <p className="text-foreground mt-2 text-sm leading-relaxed">
              <MarkedText
                text={card.fullText}
                organizationRaws={allOrgRaws}
                subjectType={single.subjectType}
                subjectMention={single.subjectMention}
              />
            </p>
            <PaperFooter block={single} />
          </>
        ) : (
          <>
            {/* Multi-subject: render the verbatim statement once (org chips only,
                no single subject mark — there are several), then a per-subject
                block with its own subject mark + footer actions. */}
            <p className="text-foreground mt-2 text-sm leading-relaxed">
              <MarkedText
                text={card.fullText}
                organizationRaws={allOrgRaws}
                subjectType="unknown"
                subjectMention={null}
              />
            </p>
            <ul className="mt-3 flex flex-col gap-3">
              {card.blocks.map((b) => (
                <li
                  key={b.unitKey}
                  className="border-apollo-border rounded-md border p-3"
                  data-testid={`coi-gap-paper-block-${b.unitKey}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <SubjectTag subjectType={b.subjectType} subjectMention={b.subjectMention} />
                    <span className="text-muted-foreground text-xs">
                      {b.organizationRaws.join(", ")}
                    </span>
                  </div>
                  <PaperFooter block={b} />
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    );
  }

  function PaperFooter({ block }: { block: PaperCard["blocks"][number] }) {
    // The footer resolves all of the statement's currently-current companies at
    // once; once every one is set aside it collapses to the Set-aside line.
    const currentIds = block.candidateIds.filter((id) => !isSetAside(id));
    const isPending = block.candidateIds.some((id) => pending.has(id));
    const error = block.candidateIds.map((id) => errors.get(id)).find(Boolean) ?? null;
    return (
      <div className="border-apollo-border mt-3 border-t pt-3">
        {currentIds.length === 0 ? (
          <SetAsideLine
            reason={effectiveReason(block.candidateIds[0]) ?? "invalid"}
            ids={block.candidateIds}
            orgCount={block.candidateIds.length}
            scope={block.unitKey}
            isPending={isPending}
          />
        ) : (
          <>
            <p className="text-muted-foreground text-xs" data-testid={`coi-gap-paper-hint-${block.unitKey}`}>
              Covers all {currentIds.length} organization{currentIds.length === 1 ? "" : "s"}
            </p>
            <ActionSet
              ids={currentIds}
              orgCount={currentIds.length}
              scope={block.unitKey}
              isPending={isPending}
            />
          </>
        )}
        {error && (
          <Alert variant="destructive" className="mt-2">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>
    );
  }

  // ── filtered partitions for the active view (mention-level) ────────────────
  // A half-resolved statement shows only its still-current companies under Current.
  const visibleHighMentions = React.useMemo(
    () => mentions.filter((m) => m.confidence === "high" && filterMention(m.candidateId)),
    [mentions, filterMention],
  );
  const visibleLowerMentions = React.useMemo(
    () => mentions.filter((m) => m.confidence === "low" && filterMention(m.candidateId)),
    [mentions, filterMention],
  );

  const orgCards = buildOrgCards(visibleHighMentions);
  const paperCards = buildPaperCards(visibleHighMentions);
  const lowerOrgCards = buildOrgCards(visibleLowerMentions);
  const lowerPaperCards = buildPaperCards(visibleLowerMentions);
  const lowerUnitCount = visibleLowerMentions.length;

  const isEmptyHigh = visibleHighMentions.length === 0;

  return (
    <>
      <Link
        href={backHref}
        data-testid="coi-gap-back"
        className="text-apollo-slate -mb-1 inline-flex w-fit items-center gap-1 text-sm font-medium hover:underline"
      >
        <ChevronLeft className="size-4" aria-hidden />
        Conflicts of Interest
      </Link>

      <EditPanel
        slot="coi-gap-panel"
        heading={su ? "From the scholar’s publications" : "From your publications"}
        description={
          su
            ? `A courtesy heads-up — relationships named in the “Competing interests” statements of ${scholarName}’s own PubMed-indexed papers that we couldn’t match to a current Weill Research Gateway disclosure. Nothing to fix here; it’s just a chance to flag anything that’s out of date or isn’t theirs.`
            : `A courtesy heads-up — relationships named in the “Competing interests” statements of your own PubMed-indexed papers that we couldn’t match to a current Weill Research Gateway disclosure. Nothing to fix here; it’s just a chance to flag anything that’s out of date or isn’t yours.`
        }
      >
        <p className="text-muted-foreground -mt-1 text-[13px]" data-testid="coi-gap-helper">
          This is a courtesy list, not a to-do — respond only if something’s out of date or isn’t{" "}
          {su ? "theirs" : "yours"}.
        </p>

        <ul className="flex flex-wrap gap-2" data-testid="coi-gap-reassure">
          {su && <ReassureChip icon={EyeOff} label="Visible to administrators and the scholar" />}
          <ReassureChip icon={Info} label="Not a compliance judgement" />
          <ReassureChip icon={Lock} label="Managed in the Gateway, never here" />
        </ul>

        {/* Key — the two things a highlight can mark. Swatches are decorative; the
            words carry the meaning for screen readers. */}
        <div
          className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs"
          data-testid="coi-gap-key"
        >
          <span className="inline-flex items-center gap-1.5">
            <span
              className="border-apollo-amber-tint-border bg-apollo-amber-tint inline-block size-3 rounded-[3px] border"
              aria-hidden
            />
            company
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span
              className="border-apollo-slate-tint-border bg-apollo-slate-tint inline-block size-3 rounded-[3px] border"
              aria-hidden
            />
            person
          </span>
        </div>

        {/* Controls: group-by segmented control + filter + counter. */}
        <div className="border-apollo-border flex flex-wrap items-center justify-between gap-3 border-t pt-3">
          <p className="text-muted-foreground text-sm" data-testid="coi-gap-summary">
            {counter}
          </p>
          <div
            className="flex items-center gap-2"
            role="radiogroup"
            aria-label="Group by"
            data-testid="coi-gap-groupby"
          >
            <span className="text-muted-foreground text-xs">Group by</span>
            <div className="border-apollo-border inline-flex overflow-hidden rounded-md border">
              {(["organization", "paper"] as const).map((g) => (
                <button
                  key={g}
                  type="button"
                  role="radio"
                  aria-checked={groupBy === g}
                  onClick={() => chooseGroup(g)}
                  data-testid={`coi-gap-groupby-${g}`}
                  className={cn(
                    "px-3 py-1 text-[13px] capitalize",
                    groupBy === g
                      ? "bg-apollo-surface-2 text-foreground font-medium"
                      : "text-muted-foreground",
                  )}
                >
                  {g === "organization" ? "Organization" : "Paper"}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1" data-testid="coi-gap-filter">
          {FILTER_OPTIONS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setFilter(f.value)}
              aria-pressed={filter === f.value}
              data-testid={`coi-gap-filter-${f.value}`}
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-xs font-medium",
                filter === f.value
                  ? "border-apollo-slate-tint-border bg-apollo-slate-tint text-apollo-slate"
                  : "border-apollo-border text-muted-foreground",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* The active view (high-confidence). */}
        <div data-slot="coi-gap-panel-list" data-view={groupBy}>
          {isEmptyHigh ? (
            <p className="text-muted-foreground py-4 text-sm" data-testid="coi-gap-empty">
              {filter === "set_aside"
                ? "Nothing set aside yet."
                : `All caught up — nothing from ${voicePoss} publications right now.`}
            </p>
          ) : groupBy === "organization" ? (
            <div className="flex flex-col gap-3">
              {orgCards.map((c) => (
                <OrgCardView key={c.organization} card={c} lower={false} />
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {paperCards.map((c) => (
                <PaperCardView key={c.pmid} card={c} />
              ))}
            </div>
          )}
        </div>

        {/* LOWER-CONFIDENCE — collapsed, EXCLUDED from the primary counter, renders
            into the SAME two-view structure, visibly marked (dashed border + flag). */}
        {lowerUnitCount > 0 && (
          <details data-testid="coi-gap-lower" className="border-apollo-border border-t pt-3">
            <summary className="text-apollo-slate cursor-pointer text-sm font-medium">
              Show {lowerUnitCount} lower-confidence match{lowerUnitCount === 1 ? "" : "es"}
            </summary>
            <p className="text-muted-foreground mt-1.5 text-xs">
              These are weaker matches we’re less sure about.
            </p>
            <div className="mt-2 flex flex-col gap-3">
              {groupBy === "organization"
                ? lowerOrgCards.map((c) => <OrgCardView key={c.organization} card={c} lower />)
                : lowerPaperCards.map((c) => <PaperCardView key={c.pmid} card={c} />)}
            </div>
          </details>
        )}
      </EditPanel>

      {/* Gentle resolve toast (~5s) — Undo, aria-live polite. A Paper-view action
          reports the org breadth (`orgCount > 0`); an Organization (company) action
          covers a single org across its papers, so it just reads "Set aside". */}
      <div aria-live="polite" className="sr-only" data-testid="coi-gap-toast-live">
        {toast
          ? toast.orgCount > 0
            ? `Set aside, covers ${toast.orgCount} organizations.`
            : "Set aside."
          : ""}
      </div>
      {toast && (
        <div
          className="border-apollo-border bg-apollo-surface-2 fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border px-4 py-2.5 text-sm shadow-lg"
          data-testid="coi-gap-toast"
        >
          <span className="text-foreground">
            {toast.orgCount > 0
              ? `Set aside · covers ${toast.orgCount} organization${toast.orgCount === 1 ? "" : "s"}`
              : "Set aside"}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="coi-gap-toast-undo"
            onClick={() => {
              const t = toast;
              setToast(null);
              if (t) requestMutate(t.ids, null, t.orgCount);
            }}
          >
            Undo
          </Button>
        </div>
      )}

      {/* The superuser "nag": confirm before acting on the scholar's private
          suggestions. Self never sees this — `requestMutate` only opens it when su. */}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={`Act on ${confirmName}’s private suggestion?`}
        description={
          `These are ${confirmName}’s private suggestions surfaced from their own publications — ` +
          `visible to administrators and ${confirmName}, never a compliance judgement. ` +
          (confirm && confirm.target !== null
            ? `Recording “${ACTED_LABEL[confirm.target]}” files ${confirmName}’s response and sets it aside. `
            : `Undoing brings this suggestion back to ${confirmName}’s current list. `) +
          `Continue only if you have a legitimate reason to act on their behalf.`
        }
        reasonMode="none"
        confirmLabel="Continue"
        confirmVariant="default"
        onConfirm={() => {
          const c = confirm;
          setConfirm(null);
          if (c) mutate(c.ids, c.target, c.orgCount);
        }}
      />
    </>
  );
}

/** A slate "posture" pill — states the advisory / not-a-judgement framing up front. */
function ReassureChip({
  icon: Icon,
  label,
}: {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  label: string;
}) {
  return (
    <li className="border-apollo-slate-tint-border bg-apollo-slate-tint text-apollo-slate inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium">
      <Icon className="size-3.5" aria-hidden />
      {label}
    </li>
  );
}

/** #1245 — on the organization tab, show up to this many example papers per
 *  organization; the rest hide behind a native <details> disclosure. */
const COI_GAP_PAPER_EXAMPLE_LIMIT = 3;

/** A small muted "lower confidence" flag on each lower-confidence card. */
function LowerFlag() {
  return (
    <span className="text-muted-foreground border-apollo-border rounded-full border px-2 py-0.5 text-[11px]">
      lower confidence
    </span>
  );
}
