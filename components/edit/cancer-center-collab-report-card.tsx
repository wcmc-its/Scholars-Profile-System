/**
 * CancerCenterCollabReportCard — the Cancer Center Reports tab
 * (`2026-08-10-cancer-center-collaboration-recommendations-v2-cancer-
 * relevance-plan.md`), under the `reports` attribute of `/edit/center/[code]`
 * (data-driven "has a program taxonomy" gate, same as Programs/NCI Table 2A).
 *
 * A small list/detail shell — `REPORTS` below is the index of everything this
 * tab can show; today there's exactly one. Click a report to open it, "All
 * reports" to go back. Adding a second report is: one more `REPORTS` entry +
 * one more component, not a rewrite of this shell.
 *
 * `CollabCancerRelevanceReport` reads the precomputed `CenterCollabCandidate`
 * table (weekly ETL) via `/api/edit/center/[code]/collab-report` — one fetch,
 * no MeSH matching or DB work at request time. Three sections, all derived
 * client-side from the same loaded rows:
 *   REMOVE                        — current member, zero collaboration. Fixed,
 *                                    not slider-driven (unchanged from v1).
 *   ADD (collaborator + relevant) — non-member, clears BOTH the collaboration
 *                                    AND cancer-relevance bar (AND-gated).
 *   ADD (recruit)                 — non-member, clears the cancer-relevance
 *                                    bar alone AND does NOT already clear the
 *                                    collaboration bar (exclusive of the row
 *                                    above — "not yet connected" is the point).
 * Two threshold controls (collaboration, cancer-relevance), each a
 * percentage/raw-count mode toggle + slider, drive both ADD sections. Each
 * section and control carries a (?) hover explaining the logic in place.
 *
 * Advisory only — no writes. A human applies any recommendation through the
 * existing `/edit` roster editor.
 */
"use client";

import * as React from "react";
import { HelpCircle } from "lucide-react";

import { EditPanel } from "@/components/edit/edit-panel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { HoverTooltip } from "@/components/ui/hover-tooltip";
import { ADD_THRESHOLD, pct } from "@/lib/center-collaboration/recommendations-core";

/** (?) icon that reveals `text` on hover/focus — the "explain the logic here"
 *  affordance next to each section heading / threshold control. */
function InfoHover({ text, label }: { text: string; label: string }) {
  return (
    <HoverTooltip text={text} wide>
      <button
        type="button"
        aria-label={label}
        className="inline-flex size-4 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
      >
        <HelpCircle className="size-3.5" />
      </button>
    </HoverTooltip>
  );
}

type Row = {
  cwid: string;
  surname: string;
  givenName: string;
  primaryDepartment: string;
  totalPapersPostCutoff: number;
  collaborationsWithCenter: number;
  cancerRelatedPapers: number;
  isCurrentMember: boolean;
  currentProgramCode: string | null;
};

type LoadedState = { generatedAt: string | null; rows: Row[] };

type Mode = "percent" | "count";

/** Does `row` clear a threshold on `count` (out of `totalPapersPostCutoff`)? */
function clears(row: Row, count: number, mode: Mode, value: number): boolean {
  return mode === "percent" ? pct(count, row.totalPapersPostCutoff) >= value : count >= value;
}

function ThresholdControl({
  label,
  info,
  mode,
  onModeChange,
  value,
  onValueChange,
  max,
}: {
  label: string;
  info: string;
  mode: Mode;
  onModeChange: (m: Mode) => void;
  value: number;
  onValueChange: (v: number) => void;
  max: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="inline-flex items-center gap-1 font-medium">
        {label}:
        <InfoHover text={info} label={`About the ${label} threshold`} />
      </span>
      <select
        value={mode}
        onChange={(e) => {
          const next = e.target.value as Mode;
          onModeChange(next);
          if (next === "percent") onValueChange(Math.min(value, 100));
        }}
        className="rounded border border-input bg-background px-1.5 py-0.5 text-xs"
      >
        <option value="count">raw count</option>
        <option value="percent">percentage</option>
      </select>
      <input
        type="range"
        min={0}
        max={mode === "percent" ? 100 : max}
        value={value}
        onChange={(e) => onValueChange(Number(e.target.value))}
        className="w-32"
      />
      <span className="w-12 tabular-nums text-muted-foreground">
        {value}
        {mode === "percent" ? "%" : ""}
      </span>
    </div>
  );
}

function SectionHeading({ text, info }: { text: string; info: string }) {
  return (
    <h3 className="mb-2 inline-flex items-center gap-1.5 text-sm font-semibold">
      {text}
      <InfoHover text={info} label={`About ${text}`} />
    </h3>
  );
}

function RowTable({ rows, extraCol }: { rows: Row[]; extraCol?: (r: Row) => React.ReactNode }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">None at this threshold.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[600px] border-collapse text-sm">
        <thead>
          <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="py-1.5 pr-2">Name</th>
            <th className="py-1.5 pr-2">Department</th>
            <th className="py-1.5 pr-2 text-right">Papers</th>
            <th className="py-1.5 pr-2 text-right">Collab.</th>
            <th className="py-1.5 pr-2 text-right">Cancer-Related</th>
            {extraCol && <th className="py-1.5 pr-2">Program</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.cwid} className="border-b border-border/50">
              <td className="py-1.5 pr-2">
                {r.givenName} {r.surname}
              </td>
              <td className="py-1.5 pr-2">{r.primaryDepartment}</td>
              <td className="py-1.5 pr-2 text-right">{r.totalPapersPostCutoff}</td>
              <td className="py-1.5 pr-2 text-right">
                {r.collaborationsWithCenter} ({pct(r.collaborationsWithCenter, r.totalPapersPostCutoff)}%)
              </td>
              <td className="py-1.5 pr-2 text-right">
                {r.cancerRelatedPapers} ({pct(r.cancerRelatedPapers, r.totalPapersPostCutoff)}%)
              </td>
              {extraCol && <td className="py-1.5 pr-2">{extraCol(r)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CollabCancerRelevanceReport({ centerCode }: { centerCode: string }) {
  const [state, setState] = React.useState<LoadedState | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [collabMode, setCollabMode] = React.useState<Mode>("count");
  const [collabValue, setCollabValue] = React.useState<number>(ADD_THRESHOLD);
  const [relevanceMode, setRelevanceMode] = React.useState<Mode>("count");
  const [relevanceValue, setRelevanceValue] = React.useState(3); // MIN_PUBS precedent (disease-taxonomy script)

  React.useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/edit/center/${encodeURIComponent(centerCode)}/collab-report`);
        if (!res.ok) {
          setError(`Failed to load (${res.status}).`);
          return;
        }
        setState(await res.json());
      } catch {
        setError("Failed to load.");
      }
    })();
  }, [centerCode]);

  const maxCollab = Math.max(1, ...(state?.rows.map((r) => r.collaborationsWithCenter) ?? [1]));
  const maxRelevant = Math.max(1, ...(state?.rows.map((r) => r.cancerRelatedPapers) ?? [1]));

  const remove = React.useMemo(
    () => state?.rows.filter((r) => r.isCurrentMember && r.collaborationsWithCenter === 0) ?? [],
    [state],
  );
  const collaboratorAndRelevant = React.useMemo(
    () =>
      state?.rows.filter(
        (r) =>
          !r.isCurrentMember &&
          clears(r, r.collaborationsWithCenter, collabMode, collabValue) &&
          clears(r, r.cancerRelatedPapers, relevanceMode, relevanceValue),
      ) ?? [],
    [state, collabMode, collabValue, relevanceMode, relevanceValue],
  );
  const recruit = React.useMemo(
    () =>
      state?.rows.filter(
        (r) =>
          !r.isCurrentMember &&
          clears(r, r.cancerRelatedPapers, relevanceMode, relevanceValue) &&
          !clears(r, r.collaborationsWithCenter, collabMode, collabValue),
      ) ?? [],
    [state, relevanceMode, relevanceValue, collabMode, collabValue],
  );

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }
  if (!state) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (state.rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No data yet — the weekly report (<code>etl:cancer-center-collab-report</code>) hasn&apos;t run for this
        center.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <p className="text-xs text-muted-foreground">Last refreshed: {new Date(state.generatedAt!).toLocaleString()}</p>

      <section>
        <SectionHeading
          text="REMOVE — active member, zero collaboration"
          info="Full-time faculty who are currently active research members of this center but have zero PubMed co-authorship with any of this center's other active research members. Fixed at zero — not adjustable by the sliders below, unchanged from the standalone v1 report."
        />
        <RowTable rows={remove} extraCol={(r) => r.currentProgramCode ?? "—"} />
      </section>

      <section>
        <div className="mb-2 flex flex-wrap gap-4">
          <ThresholdControl
            label="Collaboration"
            info="How many (or what percent) of a person's papers were co-authored with an active research member of this center. Drives both ADD sections below."
            mode={collabMode}
            onModeChange={setCollabMode}
            value={collabValue}
            onValueChange={setCollabValue}
            max={maxCollab}
          />
          <ThresholdControl
            label="Cancer-relevance"
            info="How many (or what percent) of a person's papers carry a MeSH term under this center's cancer disease taxonomy — independent of collaboration."
            mode={relevanceMode}
            onModeChange={setRelevanceMode}
            value={relevanceValue}
            onValueChange={setRelevanceValue}
            max={maxRelevant}
          />
        </div>
        <SectionHeading
          text="ADD — collaborator + relevant"
          info="Full-time faculty who are NOT center members, already clear the Collaboration threshold above, AND clear the Cancer-relevance threshold — both bars must be cleared."
        />
        <RowTable rows={collaboratorAndRelevant} />
      </section>

      <section>
        <SectionHeading
          text="ADD — recruit (relevant, not yet connected)"
          info="Full-time faculty who are NOT center members and clear the Cancer-relevance threshold on their own body of work, but do NOT already clear the Collaboration threshold — prolific cancer researchers this center hasn't worked with yet. Excludes anyone already listed under &quot;collaborator + relevant&quot; above."
        />
        <RowTable rows={recruit} />
      </section>
    </div>
  );
}

type ReportDef = { key: string; label: string; description: string };

const REPORTS: readonly ReportDef[] = [
  {
    key: "collab-cancer-relevance",
    label: "Collaboration & Cancer-Relevance",
    description:
      "REMOVE / ADD membership recommendations from PubMed co-authorship and MeSH cancer-relevance signals.",
  },
];

export type CancerCenterCollabReportCardProps = { centerCode: string };

export function CancerCenterCollabReportCard({ centerCode }: CancerCenterCollabReportCardProps) {
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null);
  const selected = REPORTS.find((r) => r.key === selectedKey) ?? null;

  return (
    <EditPanel
      heading="Reports"
      description="Advisory only — apply any recommendation through the roster editor. Nothing here writes to the roster."
    >
      {selected ? (
        <div>
          <button
            type="button"
            onClick={() => setSelectedKey(null)}
            className="mb-4 text-sm text-muted-foreground hover:text-foreground"
          >
            &larr; All reports
          </button>
          <h3 className="mb-4 text-base font-semibold">{selected.label}</h3>
          {selected.key === "collab-cancer-relevance" && <CollabCancerRelevanceReport centerCode={centerCode} />}
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {REPORTS.map((r) => (
            <li key={r.key}>
              <button
                type="button"
                onClick={() => setSelectedKey(r.key)}
                className="flex w-full flex-col items-start gap-0.5 py-3 text-left hover:bg-muted/50"
              >
                <span className="text-sm font-medium">{r.label}</span>
                <span className="text-xs text-muted-foreground">{r.description}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </EditPanel>
  );
}
