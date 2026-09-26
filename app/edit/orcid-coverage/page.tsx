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
 * No trend — there is no history table (a nightly snapshot row is the 10-line
 * ETL step if one is ever wanted). The only bars are proportions of the
 * current counts.
 *
 * Client islands, view state only: `./how-we-count` (the definitions toggle)
 * and `./coverage-tables` (Summary / All columns, department filter, sort and
 * the top-15 fold). Every number is computed here on the server.
 */
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
  type InferenceSourceCounts,
  type OrcidCoverage,
  NIH_FILTER_LABELS,
  NIH_FILTERS,
  STRONG_MIN_ACCEPTED,
  SUGGEST_MIN_ACCEPTED,
  loadOrcidCoverage,
  orcidCoverageActiveFilters,
  orcidCoverageQuery,
  parseOrcidCoverageParams,
  pct,
} from "@/lib/edit/orcid-coverage";
import { unitLabels } from "@/lib/edit/person-filter";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";
import { canViewUsage } from "@/lib/edit/usage-access";
import { cn } from "@/lib/utils";

import { CoverageTables } from "./coverage-tables";
import { HowWeCount } from "./how-we-count";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "ORCID coverage — Scholars Console",
  robots: { index: false, follow: false },
};

const selectClass = "border-apollo-border rounded border px-2 py-1";

/** The page's card surface — the same white, greige-edged panel as the mockups. */
const cardClass = "border-apollo-border-strong bg-apollo-surface rounded-[13px] border";

/** A headline number: the asserted share, a two-part bar (asserted + strong
 *  inference), and the counts behind it. Always the unfiltered population. */
function Tile({ label, c }: { label: string; c: CoverageCounts }) {
  const w = (n: number) => `${c.people === 0 ? 0 : (100 * n) / c.people}%`;
  return (
    <div className={cn(cardClass, "flex flex-col gap-2.5 px-[18px] py-4")}>
      <div className="text-muted-foreground text-xs font-medium tracking-[0.1em] uppercase">
        {label}
      </div>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[32px] leading-none font-semibold tracking-[-0.01em] tabular-nums">
          {pct(c.orcid, c.people)}
        </span>
        <span className="text-muted-foreground text-sm">
          asserted ·{" "}
          <span className="text-foreground font-medium">{pct(c.orcid + c.strong, c.people)}</span>{" "}
          with strong inference
        </span>
      </div>
      <div
        className="bg-apollo-surface-2 flex h-2.5 overflow-hidden rounded-full"
        aria-hidden="true"
      >
        <div className="bg-apollo-slate h-full" style={{ width: w(c.orcid) }} />
        <div className="bg-apollo-slate/45 h-full" style={{ width: w(c.strong) }} />
      </div>
      <div className="text-muted-foreground flex flex-col gap-0.5 text-[13px] tabular-nums">
        <span>
          <span className="text-foreground font-medium">{c.orcid.toLocaleString()}</span> of{" "}
          {c.people.toLocaleString()} asserted ({c.confirmed.toLocaleString()} confirmed here,{" "}
          {(c.orcid - c.confirmed).toLocaleString()} from Identity or RPM admin)
        </span>
        <span>
          <span className="text-foreground font-medium">+{c.strong.toLocaleString()}</span> more by
          strong inference
        </span>
      </div>
    </div>
  );
}

/** One term in the "How we count" panel. */
function Definition({
  term,
  swatch,
  children,
}: {
  term: string;
  swatch?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        {swatch ? (
          <span className={cn("size-2.5 rounded-[3px]", swatch)} aria-hidden="true" />
        ) : null}
        <span className="text-sm font-semibold">{term}</span>
      </div>
      <span className="text-[13.5px] leading-[1.55] text-pretty text-[color:var(--evidence-body)]">
        {children}
      </span>
    </div>
  );
}

function Definitions() {
  return (
    <div className={cn(cardClass, "grid gap-x-8 gap-y-4 px-[22px] py-[18px] md:grid-cols-2")}>
      <Definition term="Asserted" swatch="bg-apollo-slate">
        Confirmed by the person (or someone editing for them) in this console, on file in WCM
        Identity, or entered by a Publication Manager administrator before that path was retired in
        April 2026. An iD the person removed counts nowhere.
      </Definition>
      <Definition term="Confirmed">
        The subset of asserted iDs confirmed by the person in this console.
      </Definition>
      <Definition term="Inferred, strong" swatch="bg-apollo-slate/45">
        Exactly one iD with strong support: a public WCM email on the registry record (orcid_email),{" "}
        {STRONG_MIN_ACCEPTED}+ shared works (orcid_works), Publication Manager inference with{" "}
        {STRONG_MIN_ACCEPTED}+ accepted and no rejected articles, or both sources agreeing on the
        same iD. A rejected article vetoes an iD.
      </Definition>
      <Definition term="Inferred, weak" swatch="bg-apollo-slate/20">
        No single strong candidate: a name-only registry match, thin support, a contradiction, or
        two or more strong candidate iDs. Inferred iDs never appear on public profiles; they become
        the person&rsquo;s iD only when someone confirms one in this console.
      </Definition>
      <Definition term="&ldquo;Is this your ORCID iD?&rdquo;">
        The prompt in this console uses a lower bar than strong: {SUGGEST_MIN_ACCEPTED} accepted
        article at the person&rsquo;s own byline, none rejected, no competing iD. The person
        confirming it is the safeguard.
      </Definition>
      <Definition term="eRA account">
        Inferred from NIH RePORTER, where every listed PI necessarily holds one. RePORTER lists PIs
        only, so a Co-I or key person on someone else&rsquo;s award has an account we can&rsquo;t
        see. &ldquo;NIH PI, no eRA&rdquo; is a miss in our resolver, not in their account.
      </Definition>
      <Definition term="NIH-funded">
        Any NIH award on file for the person, whatever its dates. People add or confirm their iD
        in Scholars, under Identifiers &amp; profiles.
      </Definition>
    </div>
  );
}

type SourceMethod = { key: string; rule: string; tier: "Strong" | "Weak"; n: number };

function SourceCard({
  title,
  cadence,
  description,
  methods,
}: {
  title: string;
  cadence: string;
  description: string;
  methods: SourceMethod[];
}) {
  return (
    <div className={cn(cardClass, "overflow-hidden")} data-testid="orcid-coverage-source">
      <div className="flex flex-col gap-1 px-[18px] pt-3.5 pb-3">
        <div className="flex flex-wrap items-baseline gap-x-2.5">
          <h3 className="m-0 text-[15px] font-semibold">{title}</h3>
          <span className="text-muted-foreground text-[12.5px]">{cadence}</span>
        </div>
        <p className="text-muted-foreground m-0 text-[13px] leading-normal">{description}</p>
      </div>
      {methods.map((m) => (
        <div
          key={`${m.key}-${m.tier}`}
          className="border-apollo-border grid grid-cols-[minmax(0,1fr)_64px_70px] items-start gap-3 border-t px-[18px] py-2.5"
        >
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="font-mono text-[12.5px] font-semibold">{m.key}</span>
            <span className="text-[13px] leading-[1.45] text-[color:var(--evidence-body)]">
              {m.rule}
            </span>
          </div>
          <span
            className={cn(
              "justify-self-start rounded-full px-2 py-px text-[11.5px] whitespace-nowrap",
              m.tier === "Strong"
                ? "bg-apollo-slate/20 text-apollo-slate"
                : "bg-apollo-slate/10 text-foreground",
            )}
          >
            {m.tier}
          </span>
          <span className="text-right text-sm font-medium tabular-nums">
            {m.n.toLocaleString()}
            <span className="text-muted-foreground block text-[11.5px] font-normal">people</span>
          </span>
        </div>
      ))}
    </div>
  );
}

/** Where the inferred tiers come from: the two pipelines that write
 *  `orcid_candidate`, and how many people each rule currently matches. */
function InferenceSources({ s }: { s: InferenceSourceCounts }) {
  return (
    <section className="flex flex-col gap-3" data-testid="orcid-coverage-sources">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="m-0 text-lg font-semibold">Where inferences come from</h2>
        <span className="text-muted-foreground text-[13px]">
          Both pipelines write to orcid_candidate; neither writes scholar.orcid. Each person gets
          one tier: asserted › strong › weak › none.
        </span>
      </div>
      <div className="grid items-start gap-3.5 lg:grid-cols-2">
        <SourceCard
          title="Publication Manager inference"
          cadence="Nightly · copied from ReCiter Publication Manager"
          description="PubMed author records often carry the author’s ORCID. For each WCM person, Publication Manager counts how many accepted and rejected articles carry a given iD at their byline; the nightly import copies those counts."
          methods={[
            {
              key: "rpm_inferred",
              rule: `${STRONG_MIN_ACCEPTED}+ accepted articles carry the iD and no rejected one`,
              tier: "Strong",
              n: s.rpmStrong,
            },
            {
              key: "rpm_inferred",
              rule: "Fewer accepted articles, or any rejected",
              tier: "Weak",
              n: s.rpmWeak,
            },
          ]}
        />
        <SourceCard
          title="ORCID registry sweep"
          cadence="Weekly · run by Scholars"
          description="Pulls every public ORCID record that mentions WCM by affiliation text, organization identifier, or a public WCM email, then matches each record to a scholar, strongest rule first."
          methods={[
            {
              key: "orcid_email",
              rule: "A public email on the record belongs to exactly one scholar",
              tier: "Strong",
              n: s.registryEmail,
            },
            {
              key: "orcid_works",
              rule: `Name and full first name agree, ${STRONG_MIN_ACCEPTED}+ shared PMIDs/DOIs, no other scholar shares as many`,
              tier: "Strong",
              n: s.registryWorks,
            },
            {
              key: "orcid_name",
              rule: "Name match only, or weaker overlap. Kept as a near-miss",
              tier: "Weak",
              n: s.registryWeak,
            },
          ]}
        />
      </div>
      <p className="text-muted-foreground m-0 text-[12.5px] leading-normal">
        People per rule overlap: one person can match several, and still gets one tier. Rejected
        articles veto an iD: they usually mean it belongs to a homonym. rpm_admin also lives in
        orcid_candidate, but holds iDs Publication Manager administrators typed in, not inferences.
      </p>
    </section>
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
      className={
        inSheet
          ? "group border-apollo-border bg-apollo-surface flex flex-col gap-4 rounded-md border p-3 text-xs"
          : cn(cardClass, "group flex flex-wrap items-end gap-4 px-[18px] py-3.5 text-xs")
      }
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
          Person type narrows the department table only; the units narrow both tables. None selected
          = everyone.
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
  const RoleLabel = `${roleLabel[0].toUpperCase()}${roleLabel.slice(1)}`;
  const unitText =
    params.units.length === 0 ? "" : ` in ${orList(params.units.map((u) => units.get(u) ?? u))}`;
  const nihLabel = params.nih === "all" ? "" : ` · ${NIH_FILTER_LABELS[params.nih]}`;
  return (
    <>
      <div
        className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3"
        data-testid="orcid-coverage-tiles"
      >
        <Tile label="All active people" c={tiles.overall} />
        <Tile label="Full-time faculty" c={tiles.fullTime} />
        <Tile label="NIH-funded full-time faculty" c={tiles.nihFullTime} />
      </div>

      <InferenceSources s={data.sources} />

      {facets === null ? (
        <p
          className="text-muted-foreground m-0 text-xs"
          data-testid="orcid-coverage-filters-unavailable"
        >
          Filters are unavailable right now.
        </p>
      ) : (
        <div>
          <div className="hidden lg:block" data-testid="orcid-coverage-rail">
            <Filters data={data} facets={facets} />
          </div>
          <div className="lg:hidden">
            <FiltersSheet
              activeCount={orcidCoverageActiveFilters(params)}
              testId="orcid-coverage-filters-sheet-trigger"
            >
              <Filters data={data} facets={facets} inSheet />
            </FiltersSheet>
          </div>
        </div>
      )}

      {ignoredLegacyDept && (
        <p className="text-muted-foreground m-0 text-xs" data-testid="orcid-coverage-legacy-dept">
          A department filter from an older link was ignored — pick it under Department / division.
        </p>
      )}

      <CoverageTables
        byRole={data.byRole}
        byDept={data.byDept}
        roleCaption={`Every person type${unitText}${nihLabel}.`}
        deptCaption={`${RoleLabel}${unitText}${nihLabel}, ${
          params.nih === "none"
            ? "sorted by people."
            : "sorted by NIH-funded people without an asserted ORCID iD: the outreach list."
        }`}
        deptScope={params.types.length === 0 ? "All person types" : `${RoleLabel} only`}
        downloadHref={`/edit/orcid-coverage/export${orcidCoverageQuery(params)}`}
        defaultSort={params.nih === "none" ? "people" : "nihNo"}
      />
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
      <div data-testid="orcid-coverage-page" className="flex flex-col gap-[26px]">
        <div className="flex flex-col gap-2.5">
          <h1 className="m-0 text-[30px] leading-tight font-semibold tracking-[-0.01em]">
            ORCID coverage
          </h1>
          <HowWeCount
            intro={
              <>
                How many people have an ORCID iD on file, and how many more we can infer. NIH
                requires an ORCID iD linked to eRA Commons for every SciENcv biosketch, so
                NIH-funded people without one are the outreach list.
              </>
            }
          >
            <Definitions />
          </HowWeCount>
        </div>
        {coverage === null ? (
          <p className="text-muted-foreground m-0" data-testid="orcid-coverage-unavailable">
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
