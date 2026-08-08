/**
 * Nci2aCard — the NCI CCSG Data Table 2A review panel (#552-adjacent,
 * `2026-08-08-cancer-center-nci-table-2a-feature-plan.md`), under the
 * `nci-2a` attribute tab of `/edit/center/[code]` (Meyer Cancer Center only —
 * same data-driven "has a program taxonomy" gate as the Programs tab).
 *
 * Every column except two is existing OSRA/InfoEd data. The two judgment
 * columns — Cancer-Relevant % and Program Code (only when no
 * `CenterMembership` resolved one) — arrive `source: "llm"`, Bedrock-
 * proposed and clearly labeled unconfirmed; editing either one here sets
 * `source: "human"` via `PATCH .../nci-2a/[awardId]`, which is what makes the
 * import script's non-clobber contract hold on the next OSRA cycle.
 *
 * v1 scope: program-code editing is per-existing-allocation-row (a select
 * from the center's live program list, or "Unassigned"); ADDING or REMOVING a
 * split row is not built here — the import pipeline itself never proposes a
 * multi-program split yet (`planRow` in the import script), so every award
 * has exactly one allocation row in practice. Extend this if/when content-
 * based splitting (the plan doc's Ex. 3 case) ships.
 *
 * Authz is enforced server-side (Curator/Owner/Superuser of the center); this
 * card is only ever rendered for an actor who already passed that gate.
 */
"use client";

import * as React from "react";

import { EditPanel } from "@/components/edit/edit-panel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

type ProgramOption = { code: string; label: string };

type AllocationRow = {
  id: string;
  programCode: string | null;
  programLabel: string | null;
  programPercent: number;
  source: "membership" | "llm" | "human";
  annualProgramDirectCosts: number | null;
};

type AwardRow = {
  id: string;
  pi: string;
  specificFundingSource: string;
  projectNumber: string;
  projectTitle: string;
  projectStartDate: string;
  projectEndDate: string;
  annualProjectDirectCosts: number;
  cancerRelevantPercent: number | null;
  cancerRelevantPercentSource: "llm" | "human";
  cancerRelevantRationale: string | null;
  cancerRelevantAnnualProjectDc: number | null;
  allocations: AllocationRow[];
};

type LoadedState = { cycle: string | null; programs: ProgramOption[]; awards: AwardRow[] };

const money = (n: number | null) =>
  n == null ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** RFC4180-ish quoting — good enough for the fields here (titles/names may
 *  contain commas or quotes; dates/numbers never do). */
function csvCell(v: string | number | null): string {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(cycle: string, awards: AwardRow[]) {
  const header = [
    "PI",
    "Specific Funding Source",
    "Project Number",
    "Project Start",
    "Project End",
    "Project Title",
    "Annual Project Direct Costs",
    "Cancer-Relevant Percent",
    "Cancer-Relevant Annual Project DC",
    "Program Code",
    "Program Percent",
    "Annual Program Direct Costs",
  ];
  const lines = [header.join(",")];
  for (const a of awards) {
    a.allocations.forEach((al, i) => {
      const first = i === 0;
      lines.push(
        [
          first ? a.pi : "",
          first ? a.specificFundingSource : "",
          first ? a.projectNumber : "",
          first ? a.projectStartDate : "",
          first ? a.projectEndDate : "",
          first ? a.projectTitle : "",
          first ? a.annualProjectDirectCosts : "",
          first ? (a.cancerRelevantPercent ?? "") : "",
          first ? (a.cancerRelevantAnnualProjectDc ?? "") : "",
          al.programCode ?? "",
          al.programPercent,
          al.annualProgramDirectCosts ?? "",
        ]
          .map(csvCell)
          .join(","),
      );
    });
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `nci-table-2a-${cycle}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/** A small "AI-suggested" / "Confirmed" cue — the load-bearing visual contract
 *  from the feature plan: an LLM value must never read as a settled fact. */
function SourceBadge({ source }: { source: "membership" | "llm" | "human" }) {
  if (source === "llm") {
    return (
      <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800">
        AI-suggested
      </span>
    );
  }
  if (source === "human") {
    return (
      <span className="ml-1.5 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-800">
        Confirmed
      </span>
    );
  }
  return null; // "membership" — existing data, not a judgment call; no badge needed.
}

function PercentCell({
  award,
  onSave,
}: {
  award: AwardRow;
  onSave: (value: number) => Promise<void>;
}) {
  const [value, setValue] = React.useState(award.cancerRelevantPercent ?? "");
  const [busy, setBusy] = React.useState(false);

  async function commit() {
    // An empty input (the common case for a not-yet-inferred `null` row) must
    // NEVER commit — `Number("")` is 0, not NaN, so this guard has to be
    // explicit: without it, tabbing into and out of an empty cell silently
    // PATCHes a real 0% onto an award that was never actually reviewed.
    if (value === "") return;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 100) return;
    // `award.cancerRelevantPercent` can be `null` — only compare when it's a
    // real number, or a null-baseline edit (null -> 0) would look "unchanged"
    // (0 === null is false, so this specific case already worked, but the
    // check is written this way so it's correct by construction, not by luck).
    if (award.cancerRelevantPercent !== null && n === award.cancerRelevantPercent) return;
    setBusy(true);
    try {
      await onSave(n);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center">
      <input
        type="number"
        min={0}
        max={100}
        step={1}
        value={value}
        disabled={busy}
        onChange={(e) => setValue(e.target.value === "" ? "" : Number(e.target.value))}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
        title={award.cancerRelevantRationale ?? undefined}
        className="w-16 rounded border border-input bg-background px-1.5 py-0.5 text-right text-sm"
      />
      <SourceBadge source={award.cancerRelevantPercentSource} />
    </div>
  );
}

function ProgramCell({
  allocation,
  programs,
  onSave,
}: {
  allocation: AllocationRow;
  programs: ProgramOption[];
  onSave: (programCode: string | null) => Promise<void>;
}) {
  const [busy, setBusy] = React.useState(false);

  async function commit(next: string) {
    const programCode = next === "" ? null : next;
    if (programCode === allocation.programCode) return;
    setBusy(true);
    try {
      await onSave(programCode);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center">
      <select
        value={allocation.programCode ?? ""}
        disabled={busy}
        onChange={(e) => commit(e.target.value)}
        className="rounded border border-input bg-background px-1.5 py-0.5 text-sm"
      >
        <option value="">— Unassigned —</option>
        {programs.map((p) => (
          <option key={p.code} value={p.code}>
            {p.code} — {p.label}
          </option>
        ))}
      </select>
      <SourceBadge source={allocation.source} />
    </div>
  );
}

export type Nci2aCardProps = { centerCode: string };

export function Nci2aCard({ centerCode }: Nci2aCardProps) {
  const [state, setState] = React.useState<LoadedState | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/edit/center/${encodeURIComponent(centerCode)}/nci-2a`);
      if (!res.ok) {
        setError(`Failed to load (${res.status}).`);
        return;
      }
      setState(await res.json());
    } catch {
      setError("Failed to load.");
    }
  }, [centerCode]);

  React.useEffect(() => {
    load();
  }, [load]);

  async function patchAward(awardId: string, body: Record<string, unknown>) {
    const res = await fetch(`/api/edit/center/${encodeURIComponent(centerCode)}/nci-2a/${awardId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      setError(`Save failed (${res.status}).`);
      return;
    }
    await load(); // simplest-correct: re-fetch rather than hand-reconcile local state
  }

  return (
    <EditPanel
      heading="NCI Table 2A"
      description="Cancer-Relevant Percent and Program Code marked AI-suggested are Bedrock proposals from the project title alone — NCI's own peer-review criteria aren't sourced yet (see the handoff doc). Review and correct before this leaves the building."
      headerAction={
        state?.awards.length ? (
          <Button size="sm" variant="outline" onClick={() => downloadCsv(state.cycle!, state.awards)}>
            Download CSV
          </Button>
        ) : undefined
      }
    >
      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {!state ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : state.awards.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No import cycle found yet. Run the OSRA workbook import
          (<code>scripts/backfills/2026-08-08-cancer-center-nci-2a-import.ts</code>) to populate this tab.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <p className="mb-2 text-xs text-muted-foreground">Cycle: {state.cycle}</p>
          <table className="w-full min-w-[1100px] border-collapse text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-1.5 pr-2">PI</th>
                <th className="py-1.5 pr-2">Funding Source</th>
                <th className="py-1.5 pr-2">Project</th>
                <th className="py-1.5 pr-2 text-right">Annual Direct Costs</th>
                <th className="py-1.5 pr-2">Cancer-Relevant %</th>
                <th className="py-1.5 pr-2 text-right">Cancer-Relevant DC</th>
                <th className="py-1.5 pr-2">Program</th>
                <th className="py-1.5 pr-2 text-right">Annual Program DC</th>
              </tr>
            </thead>
            <tbody>
              {state.awards.map((a) => (
                <React.Fragment key={a.id}>
                  {a.allocations.map((al, i) => (
                    <tr key={al.id} className="border-b border-border/50 align-top">
                      {i === 0 ? (
                        <>
                          <td className="py-1.5 pr-2">{a.pi}</td>
                          <td className="py-1.5 pr-2">{a.specificFundingSource}</td>
                          <td className="py-1.5 pr-2">
                            <div className="font-medium">{a.projectNumber}</div>
                            <div className="text-xs text-muted-foreground">{a.projectTitle}</div>
                          </td>
                          <td className="py-1.5 pr-2 text-right">{money(a.annualProjectDirectCosts)}</td>
                          <td className="py-1.5 pr-2">
                            <PercentCell award={a} onSave={(v) => patchAward(a.id, { cancerRelevantPercent: v })} />
                          </td>
                          <td className="py-1.5 pr-2 text-right">{money(a.cancerRelevantAnnualProjectDc)}</td>
                        </>
                      ) : (
                        <td className="py-1.5 pr-2" colSpan={4} />
                      )}
                      <td className="py-1.5 pr-2">
                        <ProgramCell
                          allocation={al}
                          programs={state.programs}
                          onSave={(programCode) =>
                            patchAward(a.id, {
                              allocations: [{ programCode, programPercent: al.programPercent }],
                            })
                          }
                        />
                      </td>
                      <td className="py-1.5 pr-2 text-right">{money(al.annualProgramDirectCosts)}</td>
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </EditPanel>
  );
}
