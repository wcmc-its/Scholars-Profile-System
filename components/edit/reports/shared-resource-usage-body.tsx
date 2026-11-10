/**
 * Report 20 — Shared resource usage body. Unit-gated, center-only
 * (`REPORT_NUMBERS_BY_KIND`). One fiscal quarter of iLab core charges (by the
 * date each was sent to the ERP), split by the PI's program: the center's
 * shared resources (SRs) by program and by all users, the share of members
 * using each SR, every WCM core by program, and the subsidy-by-lab table with
 * its xlsx. Charts are plain CSS bars (no chart library). The counting is
 * `computeSharedResourceUsage` (`lib/edit/shared-resource-usage.ts`).
 */
import * as React from "react";

import { AutoSubmitForm } from "@/components/edit/auto-submit-form";
import { DownloadAside, SELECT } from "@/components/edit/reports/core-report-ui";
import { ReportCard, ReportStats } from "@/components/edit/reports/report-ui";
import { EXTENDED_GROUP_PALETTE } from "@/lib/center-collaboration/graph";
import { nci2aUnitQuery } from "@/lib/edit/nci-2a-report";
import type { ReportRender, UnitReportProps } from "@/lib/edit/report-registry";
import {
  NON_MEMBER,
  parseSharedResourceParams,
  sharedResourceQuery,
  sharePct,
  usd,
  type GroupDollars,
} from "@/lib/edit/shared-resource-usage";
import { loadSharedResourceUsage } from "@/lib/edit/shared-resource-usage.server";
import { cn } from "@/lib/utils";

const ROW = "grid grid-cols-[minmax(0,13rem)_minmax(0,1fr)_5.5rem] items-center gap-3";
const TH =
  "text-muted-foreground px-3 py-2.5 align-bottom text-xs font-semibold tracking-[0.08em] uppercase";
const NON_MEMBER_COLOR = "var(--apollo-signal-none)";

function Section({
  title,
  note,
  testId,
  children,
}: {
  title: string;
  note?: React.ReactNode;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <ReportCard>
      <section data-testid={testId}>
        <h2 className="text-lg font-semibold">{title}</h2>
        {note && <p className="text-muted-foreground mt-1 text-[13px]">{note}</p>}
        <div className="mt-4">{children}</div>
      </section>
    </ReportCard>
  );
}

function Legend({ groups, color }: { groups: readonly string[]; color: (g: string) => string }) {
  return (
    <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-[13px]" aria-label="Legend">
      {groups.map((g) => (
        <li key={g} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block size-3 rounded-sm"
            style={{ background: color(g) }}
          />
          {g}
        </li>
      ))}
    </ul>
  );
}

/** Horizontal stacked bars, one row per SR / core. `scale` null = 100% stacked;
 *  a number = the dollars a full-width bar stands for. Refunds can make a
 *  group negative; a negative segment draws nothing and its figure still shows. */
function StackedBars({
  rows,
  groups,
  color,
  scale,
  testId,
}: {
  rows: ReadonlyArray<{ key: string; label: React.ReactNode } & GroupDollars>;
  groups: readonly string[];
  color: (g: string) => string;
  scale: number | null;
  testId: string;
}) {
  return (
    <ul className="m-0 list-none p-0" data-testid={testId}>
      {rows.map((r) => {
        const parts = groups.map((g) => ({ g, v: r.byGroup[g] ?? 0 })).filter((x) => x.v !== 0);
        const positive = parts.reduce((s, x) => s + Math.max(0, x.v), 0);
        const full = scale ?? positive;
        return (
          <li key={r.key} className="border-apollo-border border-t py-2">
            <div className={ROW}>
              <span className="min-w-0 text-sm">{r.label}</span>
              <span className="bg-apollo-surface-2 flex h-4 overflow-hidden rounded-sm">
                {full > 0 &&
                  parts.map((x) => (
                    <span
                      key={x.g}
                      className="block h-4"
                      title={`${x.g}: ${usd(x.v)} (${sharePct(Math.max(0, x.v), positive)})`}
                      style={{
                        width: `${(Math.max(0, x.v) / full) * 100}%`,
                        background: color(x.g),
                      }}
                    />
                  ))}
              </span>
              <span className="text-right text-sm tabular-nums">{usd(r.total)}</span>
            </div>
            <p className="text-muted-foreground mt-1 text-xs tabular-nums sm:ml-[calc(13rem+0.75rem)]">
              {parts.length
                ? parts
                    .map((x) => `${x.g} ${usd(x.v)} (${sharePct(Math.max(0, x.v), positive)})`)
                    .join(" · ")
                : "No charges"}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

/** One plain bar of `users / members`. */
function ShareBar({
  label,
  users,
  members,
}: {
  label: React.ReactNode;
  users: number;
  members: number;
}) {
  return (
    <div className={cn(ROW, "py-1")}>
      <span className="min-w-0 truncate text-sm">{label}</span>
      <span className="bg-apollo-surface-2 h-3 rounded-sm" aria-hidden>
        <span
          className="bg-apollo-maroon block h-3 rounded-sm"
          style={{ width: `${members > 0 ? (users / members) * 100 : 0}%` }}
        />
      </span>
      <span className="text-right text-sm tabular-nums" title={`${users} of ${members} members`}>
        {sharePct(users, members)}{" "}
        <span className="text-muted-foreground text-xs">
          {users}/{members}
        </span>
      </span>
    </div>
  );
}

export async function renderSharedResourceUsageReport({
  code,
  kind,
  ctx,
  searchParams,
  basePath,
}: UnitReportProps): Promise<ReportRender> {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(searchParams))
    for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) sp.append(k, x);
  const params = parseSharedResourceParams(sp);
  const r = await loadSharedResourceUsage(code, params);
  const u = r.usage;
  const unitQuery = nci2aUnitQuery(code, kind);
  const shownQuarter = r.quarter?.key ?? null;
  const quarterOptions =
    r.quarter && !r.quarters.some((q) => q.key === r.quarter!.key)
      ? [r.quarter, ...r.quarters]
      : r.quarters;
  const coreOptions = [...new Set(u?.labs.map((l) => l.coreName) ?? [])].sort();
  const labs = (u?.labs ?? []).filter((l) => !params.core || l.coreName === params.core);
  const labelOf = new Map(r.programs.map((p) => [p.code, p.label]));
  const groupIndex = new Map((u?.groups ?? []).map((g, i) => [g, i]));
  const color = (g: string) =>
    g === NON_MEMBER
      ? NON_MEMBER_COLOR
      : EXTENDED_GROUP_PALETTE[(groupIndex.get(g) ?? 0) % EXTENDED_GROUP_PALETTE.length];
  const provisional = new Set(r.resources.filter((x) => x.provisional).map((x) => x.name));
  const srLabel = (sr: string) => (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="truncate">{sr}</span>
      {provisional.has(sr) && (
        <span
          className="bg-apollo-amber-tint text-apollo-amber rounded px-1 text-[11px] font-semibold"
          title="The cores counted under this shared resource are not confirmed yet."
        >
          provisional
        </span>
      )}
    </span>
  );
  const srRows = (rows: ReadonlyArray<{ sr: string } & GroupDollars>) =>
    rows.map((x) => ({ ...x, key: x.sr, label: srLabel(x.sr) }));
  const maxCore = Math.max(0, ...(u?.coresByProgram ?? []).map((c) => c.total));
  const srTotal = (u?.srByAll ?? []).reduce((s, x) => s + x.total, 0);

  const filters = (
    <section className="bg-apollo-surface border-apollo-border min-w-0 rounded-[var(--apollo-radius-card)] border">
      <div className="flex flex-wrap items-start justify-between gap-4 px-5 py-4">
        <AutoSubmitForm
          action={basePath}
          className="group flex flex-wrap items-center gap-x-5 gap-y-3"
          data-testid="shared-resource-filters"
        >
          {[...new URLSearchParams(unitQuery).entries()].map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
          <label className="flex items-center gap-1.5 text-sm">
            Quarter
            <select name="quarter" defaultValue={shownQuarter ?? ""} className={SELECT}>
              {quarterOptions.length === 0 && <option value="">No charges loaded</option>}
              {quarterOptions.map((q) => (
                <option key={q.key} value={q.key}>
                  {q.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-sm">
            Lab table core
            <select name="core" defaultValue={params.core ?? ""} className={SELECT}>
              <option value="">All cores</option>
              {params.core && !coreOptions.includes(params.core) && (
                <option value={params.core}>{params.core}</option>
              )}
              {coreOptions.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="border-foreground/40 hover:bg-apollo-surface-2 rounded border px-3 py-1.5 text-sm group-data-[hydrated=true]:hidden"
          >
            Apply
          </button>
        </AutoSubmitForm>
        {u && (
          <DownloadAside
            href={`/api/edit/center/${encodeURIComponent(code)}/shared-resource-usage/xlsx?${sharedResourceQuery({ quarter: shownQuarter, core: params.core })}`}
            note="The subsidy-by-lab table below, with a Criteria sheet."
            testId="shared-resource"
          />
        )}
      </div>
    </section>
  );

  if (!u) {
    const message =
      r.resources.length === 0
        ? `No shared resources are set up for ${ctx.unit.name}.`
        : r.quarter
          ? `No iLab charges were sent to the ERP in ${r.quarter.label}.`
          : "No iLab charges have been loaded yet.";
    return {
      main: (
        <div className="mt-7 flex min-w-0 flex-col gap-5">
          {filters}
          <ReportCard>
            <p className="text-muted-foreground text-sm" data-testid="shared-resource-empty">
              {message}
            </p>
          </ReportCard>
        </div>
      ),
    };
  }

  return {
    subtitle: r.quarter ? (
      <p className="text-muted-foreground text-sm">
        {r.quarter.label}, by the date each charge was sent to the ERP.
      </p>
    ) : undefined,
    main: (
      <div className="mt-7 flex min-w-0 flex-col gap-5">
        {filters}
        <ReportCard>
          <ReportStats
            testId="shared-resource-stats"
            stats={[
              { value: u.chargeCount.toLocaleString(), label: "iLab charge lines" },
              { value: usd(srTotal), label: "Charged at shared resources" },
              { value: u.memberCount.toLocaleString(), label: "Research members in the quarter" },
            ]}
          />
        </ReportCard>

        <Section
          title="1. Shared resources by program"
          note="Charges by research members, split by the PI's program."
          testId="shared-resource-view-1"
        >
          <Legend groups={u.groups} color={color} />
          <StackedBars
            rows={srRows(u.srByProgram)}
            groups={u.groups}
            color={color}
            scale={null}
            testId="sr-by-program"
          />
        </Section>

        <Section
          title="2. Shared resources by all users"
          note={`Every charge at the shared resource: members by program, everyone else as ${NON_MEMBER}.`}
          testId="shared-resource-view-2"
        >
          <Legend groups={[...u.groups, NON_MEMBER]} color={color} />
          <StackedBars
            rows={srRows(u.srByAll)}
            groups={[...u.groups, NON_MEMBER]}
            color={color}
            scale={null}
            testId="sr-by-all"
          />
        </Section>

        <Section
          title="3. Share of each program's members using each shared resource"
          note="Distinct member PIs with a charge at the shared resource, over the program's research members in the quarter."
          testId="shared-resource-view-3"
        >
          <div className="grid gap-5 md:grid-cols-2">
            {u.programShare.map((s) => (
              <div key={s.sr}>
                <h3 className="mb-1 text-sm font-semibold">{srLabel(s.sr)}</h3>
                {u.groups.map((g) => (
                  <ShareBar
                    key={g}
                    label={<span title={labelOf.get(g)}>{g}</span>}
                    users={s.byGroup[g]?.users ?? 0}
                    members={s.byGroup[g]?.members ?? 0}
                  />
                ))}
              </div>
            ))}
          </div>
        </Section>

        <Section
          title="4. Share of all members using each shared resource"
          note="Distinct member PIs with a charge at the shared resource, over all research members in the quarter."
          testId="shared-resource-view-4"
        >
          {u.memberShare.map((s) => (
            <ShareBar key={s.sr} label={srLabel(s.sr)} users={s.users} members={s.members} />
          ))}
        </Section>

        <Section
          title="5. Member use of every WCM core, by program"
          note="Charges by research members at every iLab core, largest first."
          testId="shared-resource-view-5"
        >
          <Legend groups={u.groups} color={color} />
          <StackedBars
            rows={u.coresByProgram.map((c) => ({
              ...c,
              key: c.core,
              label: <span className="truncate">{c.core}</span>,
            }))}
            groups={u.groups}
            color={color}
            scale={maxCore}
            testId="cores-by-program"
          />
        </Section>

        <Section
          title="6. Subsidy by lab"
          note={
            params.core
              ? `${params.core} only. Pick “All cores” above for every core.`
              : "Every core. Pick one above to narrow the table and the download."
          }
          testId="shared-resource-view-6"
        >
          <div className="max-h-[640px] overflow-auto">
            <table
              className="w-full min-w-[720px] border-collapse text-sm"
              data-testid="shared-resource-labs"
            >
              <thead className="bg-apollo-surface-2 sticky top-0 text-left">
                <tr>
                  <th className={cn(TH, "pl-3")}>Core</th>
                  <th className={TH}>Customer lab</th>
                  <th className={TH}>Program</th>
                  <th className={cn(TH, "text-right")}>Charges</th>
                  <th className={cn(TH, "text-right")}>Total</th>
                  <th className={cn(TH, "text-right")}>Subsidy</th>
                </tr>
              </thead>
              <tbody>
                {labs.map((l) => (
                  <tr
                    key={`${l.coreName}|${l.customerLab}|${l.group}`}
                    className="border-apollo-border border-b"
                  >
                    <td className="px-3 py-2">{l.coreName}</td>
                    <td className="px-3 py-2">{l.customerLab}</td>
                    <td className="px-3 py-2">{l.group}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {l.charges.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{usd(l.total)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{usd(l.subsidy)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section title="Data quality" testId="shared-resource-dq">
          <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-[13px]">
            <li>
              Subsidy to labs iLab does not flag MCC:{" "}
              {u.dataQuality.subsidyToNonMcc.lines.toLocaleString()} lines,{" "}
              {usd(u.dataQuality.subsidyToNonMcc.amount)},{" "}
              {u.dataQuality.subsidyToNonMcc.labs.toLocaleString()} labs.
            </li>
            <li>
              Subsidy at cores outside the shared resources: {usd(u.dataQuality.subsidyOutsideSr)}.
            </li>
            <li>
              Labs of research members that iLab does not flag MCC:{" "}
              {u.dataQuality.memberLabsNotFlagged.length.toLocaleString()}
              {u.dataQuality.memberLabsNotFlagged.length > 0 && (
                <details className="mt-1">
                  <summary className="cursor-pointer">Show labs</summary>
                  <p className="mt-1">{u.dataQuality.memberLabsNotFlagged.join("; ")}</p>
                </details>
              )}
            </li>
            <li>
              Program is the PI&apos;s program on the date the charge was sent to the ERP, from the
              center&apos;s research memberships; a PI who was not a research member that day counts
              as {NON_MEMBER}. Dollars are iLab Total Price, the researcher&apos;s and the subsidy
              line together.
            </li>
          </ul>
        </Section>
      </div>
    ),
  };
}
