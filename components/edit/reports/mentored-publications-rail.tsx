/**
 * Report 7's filter rail (reports redesign, 2026-09-24; mockup
 * `Pub Reports/Mentored Publications Redesign.dc.html`, build spec "Report 7").
 * One GET `AutoSubmitForm` whose sections are the shared `RailSection`s
 * (native `<details>`: a collapsed section's inputs still submit), in the
 * spec's order:
 *   1. Mentorship type — the program pairings (`mtype`)
 *   2. Inferred mentorship — likely / possible (`mtype` too)
 *   3. Graduation year — from / to + "Include learners with no graduation
 *      year" (`grad_from` / `grad_to` / `grad_unknown`, which the parser
 *      folds into the `years` list — every link the page writes still says
 *      `years=`); a gappy selection (an old `years=2019,2027` link) also
 *      rides a hidden `grad_exact`, kept exactly while the selects are
 *      untouched, so another control's change never widens it
 *   4. Counting window (`tail`)
 *   5. Publications (`pubs`)
 *   6. In window — per PUBLICATION (`window`)
 *   7. Author position (`position`)
 *      then Publication year (`pubyear`) — the live Publications tab's Year
 *      facet, kept (not in the spec's list; see the PR body)
 *   8. Mentor (`mentor`)
 *   9. Learners shown — "Hide learners with no publications" (`withpubs`)
 * Sections 1–5 are what the loader reads; 6–9 narrow its result
 * (`applyMentoredPubsFacets`) and carry counts from
 * `mentoredPubsFacetOptions`. Rendered twice by the body — the desktop rail
 * and the phone `FiltersSheet` copy (`idSuffix`), each its own form id; the
 * client island points its hidden `view` / `q` inputs at both.
 *
 * Server component: the checkboxes / radios / selects are plain inputs; only
 * the long lists (`RailChecklist`) and the auto-submit are client islands.
 */
import type * as React from "react";

import { AutoSubmitForm } from "@/components/edit/auto-submit-form";
import { RailChecklist } from "@/components/edit/reports/rail-checklist";
import { RailSection, ReportRail } from "@/components/edit/reports/report-ui";
import { HoverTooltip } from "@/components/ui/hover-tooltip";
import type { MentoredPubsFacetOptions } from "@/lib/edit/mentored-publications-facets";
import {
  gradYearsLabel,
  isGappyYearSelection,
  type MentoredPubsParams,
} from "@/lib/edit/mentored-publications-params";
import {
  MENTORSHIP_TYPE_DESCRIPTION,
  MENTORSHIP_TYPE_LABEL,
  type MentorshipTypeKey,
} from "@/lib/edit/mentorship-type";

/** The two co-authorship inference keys (rail section 2); every other key is
 *  a program pairing (section 1). */
export const INFERRED_TYPE_KEYS: ReadonlyArray<MentorshipTypeKey> = ["likely", "possible"];

export const PUBS_SET_LABEL: Record<MentoredPubsParams["pubs"], string> = {
  mentored: "Co-authored with a mentor",
  all: "All learner publications",
};

export function countingWindowLabel(tail: number): string {
  return `Entry year → graduation + ${tail} ${tail === 1 ? "year" : "years"}`;
}

/** "All 6 program pairings" / "MD, ECR" / "3 selected" / "None". */
function typesSummary(
  keys: ReadonlyArray<MentorshipTypeKey>,
  choices: ReadonlyArray<MentorshipTypeKey>,
  labels: { none: string; all: string },
): string {
  if (keys.length === 0) return labels.none;
  if (keys.length === choices.length && choices.length > 1) return labels.all;
  if (keys.length <= 2) return keys.map((k) => MENTORSHIP_TYPE_LABEL[k]).join(", ");
  return `${keys.length} selected`;
}

function listSummary(labels: string[]): string {
  if (labels.length === 0) return "Any";
  return labels.length <= 2 ? labels.join(", ") : `${labels.length} selected`;
}

const OPTION = "hover:bg-apollo-rail-hover -mx-1.5 flex cursor-pointer items-start gap-2.5 rounded-md px-1.5 py-1 text-sm";
const BOX = "mt-[3px] accent-[var(--apollo-maroon)]";
const SELECT =
  "border-apollo-border-strong bg-apollo-surface h-[34px] w-full rounded-md border px-2 text-sm";
const NOTE = "text-muted-foreground text-xs text-pretty";

/** A plain checkbox row — `name=value` rides the GET form. */
function CheckRow({
  name,
  value,
  checked,
  count,
  children,
}: {
  name: string;
  value: string;
  checked: boolean;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <label className={`${OPTION} ${count === 0 && !checked ? "opacity-50" : ""}`}>
      <input type="checkbox" name={name} value={value} defaultChecked={checked} className={BOX} />
      <span className="min-w-0 flex-1 leading-[1.35]">{children}</span>
      {count !== undefined && (
        <span className="text-muted-foreground text-[13px] tabular-nums">{count.toLocaleString()}</span>
      )}
    </label>
  );
}

/** The mockup's segmented control, as radios (so it submits with no JS). */
function Segmented({
  name,
  value,
  options,
  label,
}: {
  name: string;
  value: string;
  options: ReadonlyArray<readonly [string, string]>;
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="bg-apollo-surface-2 border-apollo-border-strong grid auto-cols-fr grid-flow-col gap-0.5 rounded-lg border p-[3px]"
    >
      {options.map(([v, text]) => (
        <label
          key={v}
          className="text-muted-foreground has-checked:bg-apollo-surface has-checked:text-foreground has-focus-visible:ring-ring cursor-pointer rounded-md px-1.5 py-1.5 text-center text-[13px] leading-tight has-checked:font-semibold has-checked:shadow-sm has-focus-visible:ring-2"
        >
          <input type="radio" name={name} value={v} defaultChecked={v === value} className="sr-only" />
          {text}
        </label>
      ))}
    </div>
  );
}

const CountHead = ({ children }: { children: string }) => (
  <div className="text-muted-foreground -mb-1 flex justify-end text-[11px] tracking-[0.06em] uppercase" aria-hidden>
    {children}
  </div>
);

export function MentoredPublicationsRail({
  basePath,
  params,
  typeChoices,
  yearChoices,
  options,
  resetHref,
  idSuffix = "",
}: {
  basePath: string;
  /** The RESOLVED params (types / years never null). */
  params: MentoredPubsParams;
  typeChoices: ReadonlyArray<MentorshipTypeKey>;
  yearChoices: ReadonlyArray<number | null>;
  options: MentoredPubsFacetOptions;
  resetHref: string | null;
  idSuffix?: string;
}) {
  const types = new Set(params.types ?? []);
  const programChoices = typeChoices.filter((k) => !INFERRED_TYPE_KEYS.includes(k));
  const inferredChoices = typeChoices.filter((k) => INFERRED_TYPE_KEYS.includes(k));
  const years = params.years ?? [];
  const knownChoices = yearChoices.filter((y): y is number => y !== null).sort((a, b) => a - b);
  // years=[] is "all": the full range, unknown included.
  const knownSelected = (years.length === 0 ? knownChoices : years.filter((y): y is number => y !== null)).sort(
    (a, b) => a - b,
  );
  const unknownSelected = years.length === 0 || years.includes(null);
  // Gappy = skips a year that exists (not merely a whole number no class
  // graduated in): the range selects can't express it, so the exact list
  // rides a hidden `grad_exact` the parser honours while they are untouched.
  const gappy = isGappyYearSelection(knownSelected, knownChoices);
  const windowSel = new Set<string>(params.window);
  const position = new Set<string>(params.position);
  const mentorLabels = new Map(options.mentors.map((m) => [m.value, m.label]));

  return (
    <AutoSubmitForm
      id={`mentored-pubs-filters${idSuffix}`}
      action={basePath}
      className="group"
      data-testid={`mentored-pubs-filters${idSuffix}`}
    >
      <ReportRail resetHref={resetHref} help="Filters apply automatically." testId={`mentored-pubs-rail${idSuffix}`}>
        <RailSection
          label="Mentorship type"
          summary={typesSummary(
            programChoices.filter((k) => types.has(k)),
            programChoices,
            { none: "None", all: `All ${programChoices.length} program pairings` },
          )}
          testId="mentored-pubs-section-mtype"
        >
          <div className="flex flex-col">
            {programChoices.map((k) => (
              <CheckRow key={k} name="mtype" value={k} checked={types.has(k)}>
                {/* The hover wraps the TEXT only — never the input, whose
                    click must stay a plain toggle. */}
                <HoverTooltip text={MENTORSHIP_TYPE_DESCRIPTION[k]} wide>
                  <span>{MENTORSHIP_TYPE_LABEL[k]}</span>
                </HoverTooltip>
              </CheckRow>
            ))}
          </div>
        </RailSection>

        {inferredChoices.length > 0 && (
          <RailSection
            label="Inferred mentorship"
            summary={typesSummary(
              inferredChoices.filter((k) => types.has(k)),
              inferredChoices,
              { none: "Not included", all: "Likely and possible" },
            )}
            testId="mentored-pubs-section-inferred"
          >
            <p className={NOTE}>Pairings guessed from co-authorship patterns, not confirmed by a program office.</p>
            <div className="flex flex-col">
              {inferredChoices.map((k) => (
                <CheckRow key={k} name="mtype" value={k} checked={types.has(k)}>
                  <HoverTooltip text={MENTORSHIP_TYPE_DESCRIPTION[k]} wide>
                    <span>{MENTORSHIP_TYPE_LABEL[k]}</span>
                  </HoverTooltip>
                </CheckRow>
              ))}
            </div>
          </RailSection>
        )}

        <RailSection
          label="Graduation year"
          summary={gradYearsLabel(years, yearChoices)}
          defaultOpen
          testId="mentored-pubs-section-years"
        >
          {knownChoices.length > 0 && (
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
              <select
                name="grad_from"
                defaultValue={knownSelected.length > 0 ? String(knownSelected[0]) : ""}
                aria-label="Graduation year from"
                className={SELECT}
              >
                <option value="">None</option>
                {knownChoices.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
              <span className="text-muted-foreground text-[13px]">to</span>
              <select
                name="grad_to"
                defaultValue={knownSelected.length > 0 ? String(knownSelected[knownSelected.length - 1]) : ""}
                aria-label="Graduation year to"
                className={SELECT}
              >
                <option value="">None</option>
                {knownChoices.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </div>
          )}
          {gappy && (
            <>
              <input type="hidden" name="grad_exact" value={knownSelected.join(",")} />
              <p className={NOTE} data-testid="mentored-pubs-years-gappy">
                This link picks {knownSelected.join(", ")}. Changing the range selects every year in between.
              </p>
            </>
          )}
          {yearChoices.includes(null) && (
            <>
              <CheckRow name="grad_unknown" value="1" checked={unknownSelected}>
                Include learners with no graduation year
              </CheckRow>
              <p className={NOTE}>
                The only way to see MD-PhD program-office learners and inferred pairs, which carry no years.
              </p>
            </>
          )}
        </RailSection>

        <RailSection label="Counting window" summary={countingWindowLabel(params.tail)} testId="mentored-pubs-section-tail">
          <p className="text-sm leading-normal">Count publications from entry year through graduation year plus</p>
          <Segmented
            name="tail"
            value={String(params.tail)}
            label="Years after graduation still counted"
            options={[
              ["0", "0 yrs"],
              ["1", "1 yr"],
              ["2", "2 yrs"],
              ["3", "3 yrs"],
            ]}
          />
          <p className={NOTE}>MD learners with no entry year are assumed to have entered four years before graduating.</p>
        </RailSection>

        <RailSection label="Publications" summary={PUBS_SET_LABEL[params.pubs]} testId="mentored-pubs-section-pubs">
          <Segmented
            name="pubs"
            value={params.pubs}
            label="Which publications"
            options={[
              ["mentored", "With a mentor"],
              ["all", "All publications"],
            ]}
          />
        </RailSection>

        <RailSection
          label="In window"
          summary={listSummary(options.window.filter((o) => windowSel.has(o.value)).map((o) => o.label))}
          defaultOpen={params.window.length > 0}
          testId="mentored-pubs-section-window"
        >
          <p className={NOTE}>
            Per publication: inside the learner&rsquo;s counting window, outside it, or unknown (no entry or
            graduation year).
          </p>
          <CountHead>Publications</CountHead>
          <div className="flex flex-col">
            {options.window.map((o) => (
              <CheckRow key={o.value} name="window" value={o.value} checked={windowSel.has(o.value)} count={o.count}>
                {o.label}
              </CheckRow>
            ))}
          </div>
        </RailSection>

        <RailSection
          label="Author position"
          summary={listSummary(options.position.filter((o) => position.has(o.value)).map((o) => o.label))}
          defaultOpen={params.position.length > 0}
          testId="mentored-pubs-section-position"
        >
          <CountHead>Publications</CountHead>
          <div className="flex flex-col">
            {options.position.map((o) => (
              <CheckRow key={o.value} name="position" value={o.value} checked={position.has(o.value)} count={o.count}>
                {o.label}
              </CheckRow>
            ))}
          </div>
        </RailSection>

        <RailSection
          label="Publication year"
          summary={listSummary(params.pubYears.map(String))}
          defaultOpen={params.pubYears.length > 0}
          testId="mentored-pubs-section-pubyear"
        >
          <RailChecklist
            name="pubyear"
            options={options.pubYears}
            selected={params.pubYears.map(String)}
            countLabel="Publications"
            collapseAfter={6}
          />
        </RailSection>

        <RailSection
          label="Mentor"
          summary={listSummary(params.mentors.map((c) => mentorLabels.get(c) ?? c))}
          defaultOpen={params.mentors.length > 0}
          testId="mentored-pubs-section-mentor"
        >
          <RailChecklist
            name="mentor"
            options={options.mentors}
            selected={params.mentors}
            countLabel="Learners"
            collapseAfter={8}
            searchPlaceholder="Search mentors…"
          />
        </RailSection>

        <RailSection
          label="Learners shown"
          summary={params.withPubs ? "Only learners with publications" : "All learners"}
          defaultOpen={params.withPubs}
          testId="mentored-pubs-section-withpubs"
        >
          <CheckRow name="withpubs" value="1" checked={params.withPubs}>
            Hide learners with no publications
          </CheckRow>
        </RailSection>

        {/* No-JS fallback; the form hides it once hydrated. */}
        <div className="border-apollo-rail-border border-t px-[18px] py-3 group-data-[hydrated=true]:hidden">
          <button
            type="submit"
            className="border-apollo-border-strong bg-apollo-surface rounded-md border px-3 py-1.5 text-sm"
          >
            Apply
          </button>
        </div>
      </ReportRail>
    </AutoSubmitForm>
  );
}
