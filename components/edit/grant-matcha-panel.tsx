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
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { BrowseList } from "@/components/edit/find-researchers";
import { MatchaPanel, type EligibilityRequirements } from "@/components/edit/matcha-panel";
import type { CareerStage } from "@/lib/career-stage";
import { careerStagesOf, facultyPiMayHold } from "@/lib/funding/screening";

type Selected = {
  title: string | null;
  sponsor: string | null;
  askSeed: string;
  /** Derived once per fetched opportunity, so the panel's memo deps stay referentially stable. */
  requirements: EligibilityRequirements;
  /** Why ranking researchers on this award will not work — null when it will. See `askNote`. */
  note: string | null;
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

/** Faculty maps to the three post-training stages; `careerStageBucket` has no "faculty" bucket. */
const FACULTY_STAGES: readonly CareerStage[] = ["early", "mid", "senior"];

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

/**
 * Values that appear in `career_stages` but are NOT career stages (screening spec §3.2 — the
 * extraction contract mixes two axes into one array).
 *
 * 🔴 A role must not trip the restriction signal. Measured on staging 2026-07-28: 27 of 304
 * opportunities carry `clinician`, and on the 2 where it is the ONLY value the rail stated
 * "Required: Early career · Mid career · Senior" — stages taken from the derived flags, which the
 * sponsor never mentioned — while the restriction it DID state (be a clinician) went unshown and
 * unenforced. Dropping roles here makes those 2 render no axis, which is the truth: they state no
 * career-stage requirement.
 *
 * Enforcing the clinician restriction is a separate, larger job (#2042): SPS has `isClinician`, but
 * a second hard axis needs its own gate, badge, floor and relax control for 0.7% of the corpus.
 */
const NON_STAGE_ROLES: ReadonlySet<string> = new Set(["clinician"]);

/**
 * Turn an opportunity's stored eligibility into the axes the rail should render.
 *
 * The RESTRICTION SIGNAL is the structured map's `career_stages` being non-empty — the same test
 * `deriveEligibilityFlagsFromMap` uses (`etl/dynamodb/grant-opportunity-mapper.ts`), where an empty
 * array explicitly means "no person-level restriction". The ALLOWED SET then comes from the derived
 * flags, which are what SPS already reads. Deriving the axis from the flags alone would render it on
 * ~88% of opportunities and bury the officer in a filter that mostly restricts nothing.
 */
export function requirementsFrom(
  eligibilityFlags: unknown,
  eligibility: unknown,
  eligibilityRaw?: unknown,
): EligibilityRequirements {
  const flags = asStringArray(eligibilityFlags);
  const map =
    eligibility && typeof eligibility === "object" && !Array.isArray(eligibility)
      ? (eligibility as Record<string, unknown>)
      : {};
  // Only STAGE values restrict — a role in this array says who may apply, not at what stage.
  const restricts = asStringArray(map.career_stages).some((s) => !NON_STAGE_ROLES.has(s));

  const allowed: CareerStage[] = [];
  if (flags.includes("student_only")) allowed.push("grad");
  if (flags.includes("faculty_eligible")) allowed.push(...FACULTY_STAGES);
  if (flags.includes("postdoc_eligible")) allowed.push("postdoc");

  // The sponsor's own eligibility wording, so the rail can cite what the stage list came from.
  // Usually a short semicolon list ("Faculty Member; Postdoctoral | United States"); the rail
  // clamps it, so no length cap here. Blank when the column is empty — never a fabricated source.
  const source = typeof eligibilityRaw === "string" ? eligibilityRaw.trim() : "";

  return {
    // An empty allowed set would hide EVERYONE off malformed data, so it degrades to "no axis"
    // rather than to an empty page — a filter that can only filter everything is worse than none.
    careerStages: restricts && allowed.length > 0 ? allowed : null,
    stageSource: source || null,
    esiTargeted: map.esi_targeted === true,
    usRequired: map.us_citizen_or_permanent_resident_required === true,
  };
}

export function GrantMatchaPanel() {
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
          synopsis: string | null;
          eligibilityFlags?: unknown;
          eligibility?: unknown;
          eligibilityRaw?: unknown;
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
                  askSeed,
                  requirements: requirementsFrom(
                    full.eligibilityFlags,
                    full.eligibility,
                    full.eligibilityRaw,
                  ),
                  note: askNote(full),
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
        <div className="mb-5">
          <h1 className="mb-1 text-2xl font-bold tracking-tight">Grant Matcha</h1>
          <p className="text-muted-foreground text-sm">
            Choose a funding opportunity to rank Weill Cornell researchers on its text.
          </p>
        </div>
        <BrowseList hrefFor={(id) => `${pathname}?opp=${encodeURIComponent(id)}`} />
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
        <>
          <div className="mb-4 min-w-0 text-sm">
            {current.selected.sponsor ? (
              <span className="font-semibold text-[var(--color-accent-slate)]">
                {current.selected.sponsor}
                {" · "}
              </span>
            ) : null}
            <span className="text-foreground">
              {current.selected.title ?? "Untitled opportunity"}
            </span>
          </div>
          {current.selected.note ? (
            <p className="border-apollo-border bg-apollo-surface-2 text-foreground/90 mb-4 rounded-md border px-3 py-2 text-sm">
              {current.selected.note}
            </p>
          ) : null}
          <MatchaPanel
            key={current.id}
            initialDescription={current.selected.askSeed}
            // A stated reason not to rank replaces the auto-run: the ask is seeded and waiting,
            // but no Bedrock call is billed for a question we already know the answer to.
            autoRun={current.selected.note === null}
            eligibility={current.selected.requirements}
          />
        </>
      )}
    </div>
  );
}
