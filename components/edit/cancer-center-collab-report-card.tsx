/**
 * CancerCenterCollabReportCard — the Cancer Center collaboration-
 * recommendations v2 "Reports" tab (`2026-08-10-cancer-center-collaboration-
 * recommendations-v2-cancer-relevance-plan.md`), under the `reports`
 * attribute of `/edit/center/[code]` (data-driven "has a program taxonomy"
 * gate, same as Programs/NCI Table 2A).
 *
 * Reads the precomputed `CenterCollabCandidate` table (weekly ETL) via
 * `/api/edit/center/[code]/collab-report` — one fetch, no MeSH matching or
 * DB work at request time. Three sections, all derived client-side from the
 * same loaded rows:
 *   REMOVE                    — current member, zero collaboration. Fixed,
 *                                not slider-driven (unchanged from v1).
 *   ADD (collaborator + relevant) — non-member, clears BOTH the collaboration
 *                                AND cancer-relevance bar (AND-gated).
 *   ADD (recruit)              — non-member, clears the cancer-relevance bar
 *                                alone — no collaboration required.
 * Two threshold controls (collaboration, cancer-relevance), each a
 * percentage/raw-count mode toggle + slider, drive both ADD sections.
 *
 * Advisory only — no writes. A human applies any recommendation through the
 * existing `/edit` roster editor.
 */
"use client";

import * as React from "react";

import { EditPanel } from "@/components/edit/edit-panel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ADD_THRESHOLD, pct } from "@/lib/center-collaboration/recommendations-core";

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
  mode,
  onModeChange,
  value,
  onValueChange,
  max,
}: {
  label: string;
  mode: Mode;
  onModeChange: (m: Mode) => void;
  value: number;
  onValueChange: (v: number) => void;
  max: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="font-medium">{label}:</span>
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

export type CancerCenterCollabReportCardProps = { centerCode: string };

export function CancerCenterCollabReportCard({ centerCode }: CancerCenterCollabReportCardProps) {
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
  // Exclusive of collaboratorAndRelevant above: "not yet connected" is the
  // point of this bucket (plan: "surfaces prolific cancer researchers Meyer
  // has never worked with"), so it only lists people who do NOT already
  // clear the collaboration bar — otherwise it's a superset that repeats
  // rows the other ADD table already recommends, under a label saying they
  // haven't been worked with.
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

  return (
    <EditPanel
      heading="Reports"
      description="Collaboration + cancer-relevance recommendations for center membership — advisory only. Apply changes through the roster editor."
    >
      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {!state ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : state.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No data yet — the weekly report (<code>etl:cancer-center-collab-report</code>) hasn&apos;t run for this
          center.
        </p>
      ) : (
        <div className="space-y-6">
          <p className="text-xs text-muted-foreground">Last refreshed: {new Date(state.generatedAt!).toLocaleString()}</p>

          <section>
            <h3 className="mb-2 text-sm font-semibold">REMOVE — active member, zero collaboration</h3>
            <RowTable rows={remove} extraCol={(r) => r.currentProgramCode ?? "—"} />
          </section>

          <section>
            <div className="mb-2 flex flex-wrap gap-4">
              <ThresholdControl label="Collaboration" mode={collabMode} onModeChange={setCollabMode} value={collabValue} onValueChange={setCollabValue} max={maxCollab} />
              <ThresholdControl label="Cancer-relevance" mode={relevanceMode} onModeChange={setRelevanceMode} value={relevanceValue} onValueChange={setRelevanceValue} max={maxRelevant} />
            </div>
            <h3 className="mb-2 text-sm font-semibold">ADD — collaborator + relevant</h3>
            <RowTable rows={collaboratorAndRelevant} />
          </section>

          <section>
            <h3 className="mb-2 text-sm font-semibold">ADD — recruit (relevant, not yet connected)</h3>
            <RowTable rows={recruit} />
          </section>
        </div>
      )}
    </EditPanel>
  );
}
