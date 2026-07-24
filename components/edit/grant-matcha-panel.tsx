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
 * Eligibility rail / per-row badges / filtered floor are PR2 — not here.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { BrowseList } from "@/components/edit/find-researchers";
import { MatchaPanel, type EligibilityRequirements } from "@/components/edit/matcha-panel";
import type { CareerStage } from "@/lib/career-stage";

type Selected = {
  title: string | null;
  sponsor: string | null;
  askSeed: string;
  /** Derived once per fetched opportunity, so the panel's memo deps stay referentially stable. */
  requirements: EligibilityRequirements;
};

type Status =
  | { kind: "loading" }
  | { kind: "ok"; selected: Selected }
  | { kind: "error"; message: string };

/** Build the ask exactly as find-researchers does: title + blank line + synopsis, empties dropped. */
function buildAskSeed(title: string | null, synopsis: string | null): string {
  return [title, synopsis].filter((s): s is string => Boolean(s && s.trim())).join("\n\n");
}

/** Faculty maps to the three post-training stages; `careerStageBucket` has no "faculty" bucket. */
const FACULTY_STAGES: readonly CareerStage[] = ["early", "mid", "senior"];

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

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
): EligibilityRequirements {
  const flags = asStringArray(eligibilityFlags);
  const map =
    eligibility && typeof eligibility === "object" && !Array.isArray(eligibility)
      ? (eligibility as Record<string, unknown>)
      : {};
  const restricts = asStringArray(map.career_stages).length > 0;

  const allowed: CareerStage[] = [];
  if (flags.includes("student_only")) allowed.push("grad");
  if (flags.includes("faculty_eligible")) allowed.push(...FACULTY_STAGES);
  if (flags.includes("postdoc_eligible")) allowed.push("postdoc");

  return {
    // An empty allowed set would hide EVERYONE off malformed data, so it degrades to "no axis"
    // rather than to an empty page — a filter that can only filter everything is worse than none.
    careerStages: restricts && allowed.length > 0 ? allowed : null,
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
    if (selectedId === null) return;
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
        };
        if (!active) return;
        const askSeed = buildAskSeed(full.title, full.synopsis);
        setStatus(
          askSeed
            ? {
                kind: "ok",
                selected: {
                  title: full.title,
                  sponsor: full.sponsor,
                  askSeed,
                  requirements: requirementsFrom(full.eligibilityFlags, full.eligibility),
                },
              }
            : {
                kind: "error",
                message: "That opportunity has no text to match on. Pick another.",
              },
        );
      })
      .catch(() => {
        if (active) {
          setStatus({ kind: "error", message: "Couldn't load that opportunity. Try again." });
        }
      });
    return () => {
      active = false;
    };
  }, [selectedId]);

  if (selectedId === null) {
    return (
      <div>
        <div className="mb-5">
          <h1 className="mb-1 text-2xl font-semibold tracking-tight">Grant Matcha</h1>
          <p className="text-muted-foreground text-sm">
            Choose a funding opportunity to rank Weill Cornell researchers on its text.
          </p>
        </div>
        <BrowseList hrefFor={(id) => `${pathname}?opp=${encodeURIComponent(id)}`} />
      </div>
    );
  }

  return (
    <div>
      <Link
        href={pathname}
        className="mb-4 inline-flex items-center gap-1 text-sm text-[var(--color-accent-slate)] hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden /> Back to opportunities
      </Link>

      {status.kind === "loading" ? (
        <p className="text-muted-foreground text-sm">Loading opportunity…</p>
      ) : status.kind === "error" ? (
        <p className="text-destructive text-sm">{status.message}</p>
      ) : (
        <>
          <div className="mb-4 min-w-0 text-sm">
            {status.selected.sponsor ? (
              <span className="font-semibold text-[var(--color-accent-slate)]">
                {status.selected.sponsor}
                {" · "}
              </span>
            ) : null}
            <span className="text-foreground">
              {status.selected.title ?? "Untitled opportunity"}
            </span>
          </div>
          <MatchaPanel
            key={selectedId}
            initialDescription={status.selected.askSeed}
            autoRun
            eligibility={status.selected.requirements}
          />
        </>
      )}
    </div>
  );
}
