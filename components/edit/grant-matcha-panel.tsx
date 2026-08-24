"use client";

/**
 * Grant Matcha (PR1) — pick a funding opportunity, then run it through the Matcha spine.
 *
 * The only new thing over `/edit/matcha` is the opportunity picker: on select we fetch the
 * opportunity's full text and seed `<MatchaPanel>` with `title + "\n\n" + synopsis`, running the
 * ask once (`autoRun`). `key={id}` remounts the panel per opportunity so its mount-only auto-run
 * fires fresh each time — the exact seeding `find-researchers` already uses (#1866). Everything
 * downstream (extracted concepts, weight sliders, ranked researchers) is unchanged Matcha.
 *
 * ponytail: the picker IS `find-researchers`'s `<BrowseList>` — same table, same facet rail,
 * same curated-first ordering — parameterized by `hrefFor`. The selection lives in the URL
 * (`?opp=<id>`), not component state, so the page is deep-linkable and browser Back returns to
 * the table.
 *
 * The selected view (matcha-admin Phase 3b, mockup 4) frames the seeded panel with the
 * opportunity's own facts: clamped synopsis, then `OpportunityFactsLine` at the bottom of the
 * request block — every field off the SAME detail fetch that seeds the ask, populated fields
 * only (the always-dashed right rail was removed by owner ruling 2026-08-24). The thin-match
 * caution stays where #2494 put it, inside `MatchaPanel`
 * (`assessMatchSignal`); this surface adds no second banner and never reads the structured
 * matcher's abstain signal.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ArrowLeft, ExternalLink } from "lucide-react";

import {
  BrowseList,
  OpportunityFactsLine,
  SourceBadge,
} from "@/components/edit/opportunity-browse";
import { MatchaPanel, type EligibilityRequirements } from "@/components/edit/matcha-panel";
import type { CareerStage } from "@/lib/career-stage";
import { careerStagesOf, facultyPiMayHold, requirementsFrom } from "@/lib/funding/screening";
import { appealByStageSummary } from "@/lib/match-display";

type Selected = {
  title: string | null;
  sponsor: string | null;
  /** Corpus source (`wcm_curated` etc.) — the header's source pill. */
  source: string | null;
  /** Full synopsis for the clamped header prose (mockup 4) — the ask seed carries it too. */
  synopsis: string | null;
  askSeed: string;
  /** Derived once per fetched opportunity, so the panel's memo deps stay referentially stable. */
  requirements: EligibilityRequirements;
  /** Why ranking researchers on this award will not work — null when it will. See `askNote`. */
  note: string | null;
  /** ReciterAI's {grad, postdoc, early, mid, senior} appeal spread — badge only, not a scoring input. */
  appealByStage: Partial<Record<CareerStage, number>>;
  /** Feeds `OpportunityFactsLine` at the bottom of the request block — missing values stay null and render nothing. */
  facts: {
    awardFloor: number | null;
    awardCeiling: number | null;
    estimatedFunding: number | null;
    numberOfAwards: number | null;
    openDate: string | null;
    dueDate: string | null;
    cfdaList: string[];
    sourceUrl: string | null;
  };
};

/**
 * `id` is the opportunity each payload BELONGS to. It exists because `status` lags the URL by a
 * render — see the staleness guard in the component.
 */
type Status =
  | { kind: "loading" }
  | { kind: "ok"; id: string; selected: Selected }
  | { kind: "error"; id: string; message: string };

/** Build the ask exactly as find-researchers does: title + blank line + synopsis, empties dropped. */
function buildAskSeed(title: string | null, synopsis: string | null): string {
  return [title, synopsis].filter((s): s is string => Boolean(s && s.trim())).join("\n\n");
}

/**
 * Say up front why this opportunity will not rank researchers, instead of spending a Sonnet call
 * to produce a page the officer has to interpret.
 *
 * This is an opportunity-level fact (screening spec §3.1), knowable before the ask runs: an award
 * no faculty PI can hold drops everyone into the eligibility floor, which reads as "Weill Cornell
 * has nobody for this" when the truth is "this award is not for faculty."
 *
 * A note SUPPRESSES the auto-run, it does not block the ask — the seeded text stays in the
 * textarea and the officer can still run it (the relaxation §6 asks for, at the ask level).
 *
 * 🔴 #1919's topic-agnostic case is deliberately NOT here — the signal it proposed does not exist
 * in the corpus. See the note in `lib/funding/screening.ts`.
 */
export function askNote(full: {
  eligibilityFlags?: unknown;
  eligibility?: unknown;
}): string | null {
  if (!facultyPiMayHold(full.eligibilityFlags, full.eligibility)) {
    // §6: name the rule AND the field value that triggered it.
    const stages = careerStagesOf(full.eligibility)
      .map((s) => s.replace(/_/g, " "))
      .join(", ");
    return `No Weill Cornell faculty PI can hold this award${
      stages ? ` — its eligibility names ${stages} only` : ""
    }. Ranking faculty against it will mostly fill the filtered-out floor.`;
  }
  return null;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

// ponytail: char-count heuristic for "long", like `ClampedText`'s — ~2 lines of 13px prose in
// the 820px column, not measured lines.
const SYNOPSIS_CLAMP_THRESHOLD = 200;

/**
 * Detail-header synopsis clamp (Matcha Redesign.dc.html): two lines of the artboard's 13px/1.55
 * greige prose, an inline "Show full text"/"Show less" toggle, and the More-information link
 * BESIDE the toggle rather than a scroll away (same `sourceUrl` the facts line below renders —
 * not new data). Local rather than the shared `ClampedText`: this chrome (clamp height, type, toggle
 * copy) is the artboard's, and re-theming the shared clamp would bleed into the reverse-matcher
 * card that also uses it. Mounted with `key={id}` so a new opportunity starts clamped.
 */
function ClampedSynopsis({ text, sourceUrl }: { text: string; sourceUrl: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > SYNOPSIS_CLAMP_THRESHOLD;
  return (
    <div className="max-w-[820px]">
      <p
        className={`text-[13px] leading-[1.55] whitespace-pre-line text-[#5c574d] ${
          long && !expanded ? "line-clamp-2" : ""
        }`}
      >
        {text}
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-3.5">
        {long ? (
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="text-sm text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
          >
            {expanded ? "Show less" : "Show full text"}
          </button>
        ) : null}
        {sourceUrl ? (
          <a
            href={sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm text-[var(--color-accent-slate)] hover:underline"
          >
            More information <ExternalLink className="size-3.5" aria-hidden />
          </a>
        ) : null}
      </div>
    </div>
  );
}

// `requirementsFrom` (with its `FACULTY_STAGES`/`NON_STAGE_ROLES` helpers) moved to
// `lib/funding/screening.ts` (browse data-wiring 2026-08): the list route now derives
// per-row eligibility labels from it server-side, and a route cannot import a client
// component. Re-exported so existing consumers (and its test suite) keep resolving here.
export { requirementsFrom };

export function GrantMatchaPanel({
  adminEnabled = false,
}: {
  /** `MATCHA_ADMIN` (server-read, threaded as a prop like `intakeEnabled`) — suppress/restore. */
  adminEnabled?: boolean;
} = {}) {
  // Selection lives in the URL (`?opp=`) — deep-linkable, and browser Back returns to the
  // browse table. The page is force-dynamic, so `useSearchParams` needs no Suspense boundary.
  const pathname = usePathname();
  const selectedId = useSearchParams().get("opp");
  const [status, setStatus] = useState<Status>({ kind: "loading" });

  useEffect(() => {
    // Empty (`?opp=`) is not a selection — `get` returns "", not null, so test truthiness.
    if (!selectedId) return;
    let active = true;
    setStatus({ kind: "loading" });
    // The list route omits synopsis; the detail route carries the full text we seed from.
    fetch(`/api/opportunities/${encodeURIComponent(selectedId)}`, {
      cache: "no-store",
      credentials: "same-origin",
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        const full = (await r.json()) as {
          title: string | null;
          sponsor: string | null;
          source?: string | null;
          synopsis: string | null;
          sourceUrl?: string | null;
          openDate?: string | null;
          dueDate?: string | null;
          awardFloor?: number | null;
          awardCeiling?: number | null;
          estimatedFunding?: number | null;
          numberOfAwards?: number | null;
          cfdaList?: unknown;
          eligibilityFlags?: unknown;
          eligibility?: unknown;
          eligibilityRaw?: unknown;
          appealByStage?: unknown;
        };
        if (!active) return;
        const askSeed = buildAskSeed(full.title, full.synopsis);
        setStatus(
          askSeed
            ? {
                kind: "ok",
                id: selectedId,
                selected: {
                  title: full.title,
                  sponsor: full.sponsor,
                  source: full.source ?? null,
                  synopsis: full.synopsis,
                  askSeed,
                  requirements: requirementsFrom(
                    full.eligibilityFlags,
                    full.eligibility,
                    full.eligibilityRaw,
                  ),
                  note: askNote(full),
                  appealByStage: (full.appealByStage ?? {}) as Partial<Record<CareerStage, number>>,
                  facts: {
                    awardFloor: full.awardFloor ?? null,
                    awardCeiling: full.awardCeiling ?? null,
                    estimatedFunding: full.estimatedFunding ?? null,
                    numberOfAwards: full.numberOfAwards ?? null,
                    openDate: full.openDate ?? null,
                    dueDate: full.dueDate ?? null,
                    cfdaList: asStringArray(full.cfdaList),
                    sourceUrl: full.sourceUrl ?? null,
                  },
                },
              }
            : {
                kind: "error",
                id: selectedId,
                message: "That opportunity has no text to match on. Pick another.",
              },
        );
      })
      .catch(() => {
        if (active) {
          setStatus({
            kind: "error",
            id: selectedId,
            message: "Couldn't load that opportunity. Try again.",
          });
        }
      });
    return () => {
      active = false;
    };
  }, [selectedId]);

  if (!selectedId) {
    return (
      <div>
        {/* `freshness` is unconditional here — the pill is part of the grant-matcha Browse
            header for everyone; only the suppress/restore controls are MATCHA_ADMIN-gated.
            The h1 lockup rides in as `header` so BrowseList can lay it out in one row with
            the freshness pill (pill top-right, per the artboard). */}
        <BrowseList
          hrefFor={(id) => `${pathname}?opp=${encodeURIComponent(id)}`}
          freshness
          admin={adminEnabled}
          header={
            <header className="flex min-w-0 flex-col gap-1.5">
              <h1 className="text-2xl font-bold tracking-tight">Grant Matcha</h1>
              {/* Brand rule, same mechanism as the panel-title rule in `edit-panel.tsx`
                  (a sibling span in a flex-col header, not a border-b, not a ::after);
                  this surface is the dominant one, so it carries maroon.
                  The geometry is deliberately NOT shared with edit-panel: this rule is
                  32x3 per `Browse Redesign.dc.html`, while `edit-panel.tsx` renders the
                  panel-title rule `h-1 w-10` (40x4). The divergence is intentional and
                  follows the artboard — it is not drift from edit-panel. */}
              <span aria-hidden className="bg-apollo-maroon h-[3px] w-8 rounded-full" />
              <p className="text-muted-foreground text-sm">
                Choose a funding opportunity to rank Weill Cornell researchers on its text.
              </p>
            </header>
          }
        />
      </div>
    );
  }

  // 🔴 `status` lags the URL by one render: React commits the new `selectedId` BEFORE the fetch
  // effect runs, so state still holds the previous opportunity. `MatchaPanel`'s auto-run is
  // mount-only, so rendering it in that window fires a Bedrock ask seeded from the WRONG grant —
  // and `/api/edit/matcha` retains a submission row for it even on a cache hit. Only trust a
  // payload whose id matches the URL; anything else reads as still-loading.
  const current = status.kind !== "loading" && status.id === selectedId ? status : null;

  return (
    <div>
      <Link
        href={pathname}
        className="mb-4 inline-flex items-center gap-1 text-sm text-[var(--color-accent-slate)] hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden /> Back to opportunities
      </Link>

      {current === null ? (
        <p className="text-muted-foreground text-sm">Loading opportunity…</p>
      ) : current.kind === "error" ? (
        <p className="text-destructive text-sm">{current.message}</p>
      ) : (
        // Header + clamped synopsis + populated facts + caution + the seeded panel,
        // one column. The Duke-style fact rail is gone (owner ruling 2026-08-24) —
        // its facts fold into the bottom of the request block instead.
        <div>
          <div className="min-w-0">
            {/* Artboard header lockup (Matcha Redesign.dc.html): sponsor EYEBROW over the title,
                brand rule, then the chip row. The eyebrow renders ONLY when the corpus carries a
                sponsor — many curated rows have none, and degrading to no eyebrow beats an empty
                slot gapping the title. */}
            {current.selected.sponsor ? (
              <p
                data-slot="opportunity-eyebrow"
                className="mb-1.5 text-xs font-semibold tracking-[0.05em] text-[#6f6a5e] uppercase"
              >
                {current.selected.sponsor}
              </p>
            ) : null}
            <div className="max-w-[820px] text-[22px] leading-[1.3] font-bold tracking-[-0.01em]">
              {current.selected.title ?? "Untitled opportunity"}
            </div>
            {/* Brand rule, same mechanism as the Browse header's (a sibling span, not a
                border-b) — the artboard's 32×3 maroon at radius 2. */}
            <span aria-hidden className="bg-apollo-maroon mt-2.5 mb-3 block h-[3px] w-8 rounded-[2px]" />
            {(() => {
              const appeal = appealByStageSummary(current.selected.appealByStage);
              return appeal || current.selected.source ? (
                <div className="flex flex-wrap items-center gap-2">
                  {/* Lock pill first (the artboard's order): "WCM curated" reads as the
                      console's LOCKED role — lock-bg + lock icon (see SourceBadge). */}
                  <SourceBadge source={current.selected.source} variant="lock" />
                  {appeal ? (
                    <span
                      data-testid="matcha-appeal-badge"
                      className="border-apollo-slate-tint-border bg-apollo-slate-tint text-apollo-slate rounded-full border px-2 py-[2px] text-[11.5px] font-medium"
                    >
                      {appeal}
                    </span>
                  ) : null}
                </div>
              ) : null;
            })()}
            {current.selected.synopsis ? (
              // ClampedSynopsis caps its own width (max-w on its root).
              <div className="mt-3">
                <ClampedSynopsis
                  key={current.id}
                  text={current.selected.synopsis}
                  sourceUrl={current.selected.facts.sourceUrl}
                />
              </div>
            ) : null}
            <div className="max-w-[820px]">
              <OpportunityFactsLine
                {...current.selected.facts}
                // A payload with no synopsis renders no ClampedSynopsis — the facts
                // line is then the only home for the outbound source link.
                showSourceLink={!current.selected.synopsis}
              />
            </div>
            {current.selected.note ? (
              <p className="border-apollo-border bg-apollo-surface-2 text-foreground/90 mt-4 rounded-md border px-3 py-2 text-sm">
                {current.selected.note}
              </p>
            ) : null}
            <div className="mt-4">
              <MatchaPanel
                key={current.id}
                initialDescription={current.selected.askSeed}
                // A stated reason not to rank replaces the auto-run: the ask is seeded and waiting,
                // but no Bedrock call is billed for a question we already know the answer to.
                autoRun={current.selected.note === null}
                eligibility={current.selected.requirements}
                // Redesign 2026-08: the ask here is the opportunity's own title + synopsis, not
                // something the officer typed — owner confirmed editing it back doesn't make
                // sense for source-originated data. `/edit/matcha`'s paste-an-email flow keeps
                // "Edit paste" (this prop's default).
                allowEditPaste={false}
                // Zero-results fix 4 — the nothing-extracted (RM1) empty state links out to the
                // FOA so the officer can fetch the research-strategy text the synopsis lacks.
                // Same `sourceUrl` the facts line and synopsis header already render.
                sourceUrl={current.selected.facts.sourceUrl}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
