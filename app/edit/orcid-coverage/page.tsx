/**
 * `/edit/orcid-coverage` — what share of our people have an ORCID iD on file
 * in WCM Identity (and an eRA profile), by person type and by department, and
 * where the gaps are. NIH has required an ORCID iD linked to eRA Commons for
 * every SciENcv biosketch since May 2026; the department table sorted by
 * "NIH-funded without ORCID" is the outreach list.
 *
 * Standalone console page like `/edit/usage` (org-wide, not a unit-scoped
 * `/edit/reports/N`): same audience (`canViewUsage` — superuser or any
 * `UnitAdmin` grant), auth re-checked on every GET, aggregates only, one CSV
 * of the department table. Filters are plain `<select>`s in a GET form
 * (`AutoSubmitForm`, report 7's idiom). No charts, no trend — there is no
 * history table (a nightly snapshot row is the 10-line ETL step if one is
 * ever wanted).
 */
import Link from "next/link";
import { redirect } from "next/navigation";

import { AutoSubmitForm } from "@/components/edit/auto-submit-form";
import { ConsoleShell } from "@/components/edit/console-shell";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { logEditDenial } from "@/lib/edit/authz";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";
import {
  type CoverageCounts,
  type CoverageRow,
  type OrcidCoverage,
  NIH_FILTER_LABELS,
  NIH_FILTERS,
  loadOrcidCoverage,
  neither,
  nihNoOrcid,
  orcidCoverageQuery,
  parseOrcidCoverageParams,
  pct,
} from "@/lib/edit/orcid-coverage";
import { PUBLICATION_MANAGER_URL } from "@/lib/edit/request-a-change";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";
import { canViewUsage } from "@/lib/edit/usage-access";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "ORCID coverage — Scholars Profile Console",
  robots: { index: false, follow: false },
};

const thClass = "px-3 py-2 font-medium";
const thNum = `${thClass} text-right`;
const tdClass = "px-3 py-2";
const tdNum = `${tdClass} text-right tabular-nums`;
const selectClass = "border-apollo-border rounded border px-2 py-1";

function Tile({ label, c }: { label: string; c: CoverageCounts }) {
  return (
    <div className="border-apollo-border bg-apollo-surface rounded-md border p-4">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{pct(c.orcid, c.people)}</div>
      <div className="text-muted-foreground mt-1 text-xs tabular-nums">
        {c.orcid.toLocaleString()} of {c.people.toLocaleString()} with an ORCID iD on file
      </div>
    </div>
  );
}

/** Both tables share one column set; the department table adds the outreach
 *  column ("NIH-funded without ORCID") the page sorts it by. */
function CoverageTable({
  caption,
  firstHeader,
  rows,
  testId,
}: {
  caption: React.ReactNode;
  firstHeader: string;
  rows: CoverageRow[];
  testId: string;
}) {
  return (
    <div className="border-apollo-border bg-apollo-surface mt-2 overflow-x-auto rounded-md border">
      <table className="w-full text-sm" data-testid={testId}>
        <caption className="text-muted-foreground px-3 py-2 text-left text-xs">{caption}</caption>
        <thead className="bg-apollo-surface-2 text-muted-foreground text-left">
          <tr className="border-apollo-border border-b">
            <th className={thClass}>{firstHeader}</th>
            <th className={thNum}>People</th>
            <th className={thNum}>ORCID iD</th>
            <th className={thNum}>ORCID %</th>
            <th className={thNum}>eRA profile</th>
            <th className={thNum}>Both</th>
            <th className={thNum}>Neither</th>
            <th className={thNum}>NIH-funded</th>
            <th className={thNum}>NIH-funded, ORCID</th>
            <th className={thNum}>NIH-funded, no ORCID</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className={`${tdClass} text-muted-foreground`} colSpan={10}>
                No one matches these filters.
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.key ?? "__null"} className="border-apollo-border border-b">
                <td className={`${tdClass} break-words`}>{r.label}</td>
                <td className={tdNum}>{r.people.toLocaleString()}</td>
                <td className={tdNum}>{r.orcid.toLocaleString()}</td>
                <td className={tdNum}>{pct(r.orcid, r.people)}</td>
                <td className={tdNum}>{r.era.toLocaleString()}</td>
                <td className={tdNum}>{r.both.toLocaleString()}</td>
                <td className={tdNum}>{neither(r).toLocaleString()}</td>
                <td className={tdNum}>{r.nihPeople.toLocaleString()}</td>
                <td className={tdNum}>
                  {r.nihOrcid.toLocaleString()} ({pct(r.nihOrcid, r.nihPeople)})
                </td>
                <td className={`${tdNum} font-semibold`}>{nihNoOrcid(r).toLocaleString()}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function Filters({ data }: { data: OrcidCoverage }) {
  const { params, roles, depts } = data;
  return (
    <AutoSubmitForm
      action="/edit/orcid-coverage"
      className="group border-apollo-border bg-apollo-surface mt-4 flex flex-wrap items-end gap-4 rounded-md border p-3 text-xs"
      data-testid="orcid-coverage-filters"
    >
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">Person type (department table)</span>
        <select name="role" defaultValue={params.role ?? "all"} className={selectClass}>
          <option value="all">All person types</option>
          {roles.map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">NIH funding</span>
        <select name="nih" defaultValue={params.nih} className={selectClass}>
          {NIH_FILTERS.map((k) => (
            <option key={k} value={k}>
              {NIH_FILTER_LABELS[k]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">Department (person-type table)</span>
        <select name="dept" defaultValue={params.dept ?? "all"} className={selectClass}>
          <option value="all">All departments</option>
          {depts.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </label>
      {/* No-JS fallback; the island hides it once hydrated. */}
      <button
        type="submit"
        className="border-apollo-border hover:bg-apollo-surface-2 rounded border px-3 py-1.5 group-data-[hydrated=true]:hidden"
      >
        Apply
      </button>
    </AutoSubmitForm>
  );
}

function Body({ data }: { data: OrcidCoverage }) {
  const { params, tiles } = data;
  const roleLabel =
    params.role === null
      ? "all person types"
      : (data.roles.find(([k]) => k === params.role)?.[1] ?? params.role);
  const nihLabel = params.nih === "all" ? "" : ` · ${NIH_FILTER_LABELS[params.nih]}`;
  return (
    <>
      <p className="text-muted-foreground mt-2 max-w-prose">
        Share of active people with an <strong>ORCID iD on file in WCM Identity</strong> — the only
        source we read, so someone can hold an ORCID the feed doesn&apos;t know about. A scholar adds
        theirs under Manage profile in{" "}
        <a href={PUBLICATION_MANAGER_URL} className="underline" target="_blank" rel="noreferrer">
          ReCiter
        </a>
        . &ldquo;eRA profile&rdquo; is a RePORTER-resolved NIH profile_id: a proxy for an eRA
        Commons account, not proof — someone funded but without one is as likely a gap in our
        resolver as in their account. NIH requires an ORCID iD linked to eRA Commons for every
        SciENcv biosketch.
      </p>

      <div className="mt-6 grid gap-4 sm:grid-cols-3" data-testid="orcid-coverage-tiles">
        <Tile label="All active people" c={tiles.overall} />
        <Tile label="Full-time faculty" c={tiles.fullTime} />
        <Tile label="NIH-funded full-time faculty" c={tiles.nihFullTime} />
      </div>

      <Filters data={data} />

      <section className="mt-8">
        <h2 className="text-base font-semibold">By person type</h2>
        <CoverageTable
          caption={`Every person type${params.dept ? ` in ${params.dept}` : ""}${nihLabel}. "NIH-funded" = any NIH award on file for the person.`}
          firstHeader="Person type"
          rows={data.byRole}
          testId="orcid-coverage-by-role"
        />
      </section>

      <section className="mt-8">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold">By department</h2>
          <Link
            href={`/edit/orcid-coverage/export${orcidCoverageQuery({ role: params.role, nih: params.nih })}`}
            className="text-xs underline"
            data-testid="orcid-coverage-download"
          >
            Download CSV
          </Link>
        </div>
        <CoverageTable
          caption={`${roleLabel[0].toUpperCase()}${roleLabel.slice(1)}${nihLabel}, sorted by NIH-funded people without an ORCID iD — the outreach list.`}
          firstHeader="Department"
          rows={data.byDept}
          testId="orcid-coverage-by-dept"
        />
      </section>
    </>
  );
}

export default async function EditOrcidCoveragePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getEffectiveEditSession();
  if (!session) {
    redirect("/api/auth/saml/login?return=/edit/orcid-coverage");
  }
  if (!(await canViewUsage(session, db.read))) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: "orcid-coverage",
      path: "/edit/orcid-coverage",
      reason: "not_superuser_or_unit_admin",
    });
    return (
      <ConsoleShell active="orcid-coverage" session={session} pendingSlugRequests={null} pendingHonors={null}>
        <ForbiddenEditPage session={session} />
      </ConsoleShell>
    );
  }

  // Subnav props mirror `/edit/usage`.
  const pendingSlugRequests =
    session.isSuperuser && isSlugRequestEnabled() ? await countPendingSlugRequests(db.read) : null;
  const pendingHonors = isHonorsQueueTabVisible(session) ? await countPendingHonors(db.read) : null;

  const params = parseOrcidCoverageParams(await searchParams);
  let data: OrcidCoverage | null = null;
  try {
    data = await loadOrcidCoverage(db.read, params);
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "orcid_coverage_read_failed",
        path: "/edit/orcid-coverage",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  return (
    <ConsoleShell
      active="orcid-coverage"
      session={session}
      pendingSlugRequests={pendingSlugRequests}
      pendingHonors={pendingHonors}
    >
      <div data-testid="orcid-coverage-page">
        <h1 className="mb-1 text-xl font-bold">ORCID coverage</h1>
        {data === null ? (
          <p className="text-muted-foreground mt-8" data-testid="orcid-coverage-unavailable">
            Coverage data is temporarily unavailable. Please try again later or contact ITS Support
            if this persists.
          </p>
        ) : (
          <Body data={data} />
        )}
      </div>
    </ConsoleShell>
  );
}
