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
 * of the department table. Filters ride a GET form (`AutoSubmitForm`, report
 * 7's idiom): the shared who-filter (`PersonFilterFacets` — the Profiles
 * roster's person type / department-division / centers / institution facets,
 * `type` + `unit` params, `lib/edit/person-filter.ts`) plus the NIH `<select>`.
 * Below `lg` the filter panel moves into the shared phone `FiltersSheet`
 * (Profiles' pattern). Coverage and facets load independently: no coverage →
 * the "temporarily unavailable" notice; no facets → the numbers still render
 * (the URL's filters still apply) and the panel becomes a one-line notice.
 * No charts, no trend — there is no
 * history table (a nightly snapshot row is the 10-line ETL step if one is
 * ever wanted).
 */
import Link from "next/link";
import { redirect } from "next/navigation";

import { AutoSubmitForm } from "@/components/edit/auto-submit-form";
import { ConsoleShell } from "@/components/edit/console-shell";
import { FiltersSheet } from "@/components/edit/filters-sheet";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { PersonFilterFacets } from "@/components/edit/reports/article-count-facets";
import { loadDataQualityFacets, type DataQualityFacets } from "@/lib/api/data-quality";
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
  STRONG_MIN_ACCEPTED,
  loadOrcidCoverage,
  neither,
  nihNoOrcid,
  piNoEra,
  orcidCoverageActiveFilters,
  orcidCoverageQuery,
  parseOrcidCoverageParams,
  pct,
} from "@/lib/edit/orcid-coverage";
import { unitLabels } from "@/lib/edit/person-filter";
// `ORCID_MANAGE_URL` is per-person (`{cwid}`); this page is aggregate-only, so
// it links the ReCiter front door and names the Manage profile page in prose.
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
        {c.orcid.toLocaleString()} of {c.people.toLocaleString()} with an asserted ORCID iD
      </div>
      <div className="text-muted-foreground mt-0.5 text-xs tabular-nums">
        {c.confirmed.toLocaleString()} confirmed here · {(c.orcid - c.confirmed).toLocaleString()}{" "}
        from Identity or RPM admin
      </div>
      <div className="text-muted-foreground mt-0.5 text-xs tabular-nums">
        +{c.strong.toLocaleString()} strong inference ({pct(c.orcid + c.strong, c.people)} incl.)
      </div>
    </div>
  );
}

/** Both tables share one column set. "NIH-funded, no ORCID" is the outreach
 *  number the department table sorts by. */
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
            <th className={thNum}>Asserted ORCID</th>
            <th className={thNum}>Confirmed</th>
            <th className={thNum}>Asserted %</th>
            <th className={thNum}>Inferred, strong</th>
            <th className={thNum}>Inferred, weak</th>
            <th className={thNum}>eRA account</th>
            <th className={thNum}>Both</th>
            <th className={thNum}>Neither</th>
            <th className={thNum}>NIH-funded</th>
            <th className={thNum}>NIH-funded, asserted</th>
            <th className={thNum}>NIH-funded, no asserted (strong inference)</th>
            <th className={thNum}>NIH PI</th>
            <th className={thNum}>NIH PI, no eRA</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className={`${tdClass} text-muted-foreground`} colSpan={15}>
                No one matches these filters.
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.key ?? "__null"} className="border-apollo-border border-b">
                <td className={`${tdClass} break-words`}>{r.label}</td>
                <td className={tdNum}>{r.people.toLocaleString()}</td>
                <td className={tdNum}>{r.orcid.toLocaleString()}</td>
                <td className={tdNum}>{r.confirmed.toLocaleString()}</td>
                <td className={tdNum}>{pct(r.orcid, r.people)}</td>
                <td className={tdNum}>{r.strong.toLocaleString()}</td>
                <td className={tdNum}>{r.weak.toLocaleString()}</td>
                <td className={tdNum}>{r.era.toLocaleString()}</td>
                <td className={tdNum}>{r.both.toLocaleString()}</td>
                <td className={tdNum}>{neither(r).toLocaleString()}</td>
                <td className={tdNum}>{r.nihPeople.toLocaleString()}</td>
                <td className={tdNum}>
                  {r.nihOrcid.toLocaleString()} ({pct(r.nihOrcid, r.nihPeople)})
                </td>
                <td className={`${tdNum} font-semibold`}>
                  {nihNoOrcid(r).toLocaleString()}{" "}
                  <span className="text-muted-foreground font-normal">
                    ({r.nihStrong.toLocaleString()})
                  </span>
                </td>
                <td className={tdNum}>{r.nihPi.toLocaleString()}</td>
                <td className={tdNum}>{piNoEra(r).toLocaleString()}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function Filters({
  data,
  facets,
  inSheet = false,
}: {
  data: OrcidCoverage;
  facets: DataQualityFacets;
  /** The phone sheet's copy: one column, no page margin. */
  inSheet?: boolean;
}) {
  const { params } = data;
  return (
    <AutoSubmitForm
      action="/edit/orcid-coverage"
      className={`group border-apollo-border bg-apollo-surface flex gap-4 rounded-md border p-3 text-xs ${
        inSheet ? "flex-col" : "mt-4 flex-wrap items-end"
      }`}
      data-testid="orcid-coverage-filters"
    >
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
      <div className="basis-full">
        <PersonFilterFacets
          facets={facets}
          types={params.types}
          units={params.units}
          testId="orcid-coverage-person-facets"
          className={inSheet ? undefined : "grid gap-x-6 sm:grid-cols-2 lg:grid-cols-4"}
        />
        <p className="text-muted-foreground mt-1">
          Person type narrows the department table only; the units narrow both tables. None
          selected = everyone.
        </p>
      </div>
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

/** "A, B or C" — selection criteria in a caption. */
const orList = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}`;

function Body({
  data,
  facets,
  ignoredLegacyDept,
}: {
  data: OrcidCoverage;
  /** null = the facet load failed: numbers render, the filter panel does not. */
  facets: DataQualityFacets | null;
  ignoredLegacyDept: boolean;
}) {
  const { params, tiles } = data;
  const typeLabels = new Map((facets?.roleCategories ?? []).map((o) => [o.value, o.label]));
  const units = facets ? unitLabels(facets) : new Map<string, string>();
  const roleLabel =
    params.types.length === 0
      ? "all person types"
      : orList(params.types.map((t) => typeLabels.get(t) ?? t));
  const unitText =
    params.units.length === 0 ? "" : ` in ${orList(params.units.map((u) => units.get(u) ?? u))}`;
  const nihLabel = params.nih === "all" ? "" : ` · ${NIH_FILTER_LABELS[params.nih]}`;
  return (
    <>
      <p className="text-muted-foreground mt-2 max-w-prose">
        <strong>Asserted ORCID</strong> = on file in WCM Identity, entered by a Publication
        Manager administrator, or confirmed by the person (or someone editing for them) in this
        console; <strong>confirmed</strong> is that last subset. An iD the person removed counts
        nowhere. <strong>Inferred</strong> = the Publication Manager saw an ORCID on
        the person&apos;s PubMed author record across articles they accepted, or the public ORCID
        registry lists a WCM-affiliated iD that matches the person: <em>strong</em> when one ORCID
        is carried by {STRONG_MIN_ACCEPTED}+ accepted articles and no rejected one, or shares{" "}
        {STRONG_MIN_ACCEPTED}+ works between the registry record and the person&apos;s own
        publications, or the registry record carries the person&apos;s WCM email (and whenever
        Publication Manager and the registry agree on the same iD, provided no rejected article
        carried it); <em>weak</em> = no single
        strong candidate (a name-only registry match, thin support, a contradiction, or two or
        more strong candidate ORCIDs). An inference
        never reaches the public profile — it is the &ldquo;is this yours? confirm it&rdquo;
        outreach list; the number in parentheses under NIH-funded is that easy subset. A scholar
        adds theirs under Manage profile in{" "}
        <a href={PUBLICATION_MANAGER_URL} className="underline" target="_blank" rel="noreferrer">
          ReCiter
        </a>
        . &ldquo;eRA account&rdquo; is inferred from NIH RePORTER (a PI listed there necessarily
        holds one); RePORTER lists PIs only, so a Co-I or key person on someone else&apos;s award
        has an account we cannot see — that is why the gap column is &ldquo;NIH PI, no eRA&rdquo;,
        which is a miss in our RePORTER resolver, not in their account. &ldquo;NIH-funded&rdquo; =
        any NIH award on file for the person, whatever its dates. NIH requires an ORCID iD linked to
        eRA Commons for every SciENcv biosketch.
      </p>

      <div className="mt-6 grid gap-4 sm:grid-cols-3" data-testid="orcid-coverage-tiles">
        <Tile label="All active people" c={tiles.overall} />
        <Tile label="Full-time faculty" c={tiles.fullTime} />
        <Tile label="NIH-funded (any award) full-time faculty" c={tiles.nihFullTime} />
      </div>

      {facets === null ? (
        <p
          className="text-muted-foreground mt-4 text-xs"
          data-testid="orcid-coverage-filters-unavailable"
        >
          Filters are unavailable right now.
        </p>
      ) : (
        <>
          <div className="hidden lg:block" data-testid="orcid-coverage-rail">
            <Filters data={data} facets={facets} />
          </div>
          <div className="mt-4 lg:hidden">
            <FiltersSheet
              activeCount={orcidCoverageActiveFilters(params)}
              testId="orcid-coverage-filters-sheet-trigger"
            >
              <Filters data={data} facets={facets} inSheet />
            </FiltersSheet>
          </div>
        </>
      )}

      {ignoredLegacyDept && (
        <p className="text-muted-foreground mt-4 text-xs" data-testid="orcid-coverage-legacy-dept">
          A department filter from an older link was ignored — pick it under Department / division.
        </p>
      )}

      <section className="mt-8">
        <h2 className="text-base font-semibold">By person type</h2>
        <CoverageTable
          caption={`Every person type${unitText}${nihLabel}.`}
          firstHeader="Person type"
          rows={data.byRole}
          testId="orcid-coverage-by-role"
        />
      </section>

      <section className="mt-8">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold">By department</h2>
          <Link
            href={`/edit/orcid-coverage/export${orcidCoverageQuery(params)}`}
            className="text-xs underline"
            data-testid="orcid-coverage-download"
          >
            Download CSV
          </Link>
        </div>
        <CoverageTable
          caption={`${roleLabel[0].toUpperCase()}${roleLabel.slice(1)}${unitText}${nihLabel}, ${
            params.nih === "none"
              ? "sorted by people."
              : "sorted by NIH-funded people without an asserted ORCID iD — the outreach list."
          }`}
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
      <ConsoleShell
        active="orcid-coverage"
        session={session}
        pendingSlugRequests={null}
        pendingHonors={null}
      >
        <ForbiddenEditPage session={session} />
      </ConsoleShell>
    );
  }

  // Subnav props mirror `/edit/usage`.
  const pendingSlugRequests =
    session.isSuperuser && isSlugRequestEnabled() ? await countPendingSlugRequests(db.read) : null;
  const pendingHonors = isHonorsQueueTabVisible(session) ? await countPendingHonors(db.read) : null;

  const { ignoredLegacyDept, ...params } = parseOrcidCoverageParams(await searchParams);
  // Independent loads: a facet failure must not blank the numbers. Nothing here
  // is cached, so a degraded render never outlives this request.
  const [coverageR, facetsR] = await Promise.allSettled([
    loadOrcidCoverage(db.read, params),
    loadDataQualityFacets(db.read),
  ]);
  const logFailure = (event: string, err: unknown) =>
    console.error(
      JSON.stringify({
        event,
        path: "/edit/orcid-coverage",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  if (coverageR.status === "rejected") logFailure("orcid_coverage_read_failed", coverageR.reason);
  if (facetsR.status === "rejected") logFailure("orcid_coverage_facets_failed", facetsR.reason);
  const coverage = coverageR.status === "fulfilled" ? coverageR.value : null;
  const facets = facetsR.status === "fulfilled" ? facetsR.value : null;

  return (
    <ConsoleShell
      active="orcid-coverage"
      session={session}
      pendingSlugRequests={pendingSlugRequests}
      pendingHonors={pendingHonors}
    >
      <div data-testid="orcid-coverage-page">
        <h1 className="mb-1 text-xl font-bold">ORCID coverage</h1>
        {coverage === null ? (
          <p className="text-muted-foreground mt-8" data-testid="orcid-coverage-unavailable">
            Coverage data is temporarily unavailable. Please try again later or contact ITS Support
            if this persists.
          </p>
        ) : (
          <Body data={coverage} facets={facets} ignoredLegacyDept={ignoredLegacyDept} />
        )}
      </div>
    </ConsoleShell>
  );
}
