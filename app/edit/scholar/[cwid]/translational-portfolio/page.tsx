/**
 * `/edit/scholar/[cwid]/translational-portfolio` — report 26 for one scholar
 * (plan 2026-11-27-translational-portfolio-redesign-plan.md, PR 2): where this
 * person's publications sit between basic research and population health,
 * counts only. A sibling of `/edit/scholar/[cwid]/history`, without the
 * editor's chrome; the console shell with Reports active, like the report.
 *
 * Gate (`resolveScholarPortfolioAccess`): report 26 on AND `authorizeCvExport`
 * for this scholar (self, superuser, granted proxy, unit owner or curator,
 * observer), then the editor's existence and #536 hidden-class guards. No
 * session → SAML login with `?return=`; anyone else and any unknown CWID →
 * the same 404, so the page never says whether a CWID exists.
 *
 * The header (the scholar's name as the h1) renders at once; the body streams
 * under a Suspense keyed on the query, so a filter change shows the skeleton
 * (`ScrollToHash` in the body lands the anchor once it is in). The report's
 * filters ride in the URL for the link back. `force-dynamic` + `noindex`.
 */
import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";

import { ConsoleShell } from "@/components/edit/console-shell";
import {
  ScholarPortfolioBody,
  ScholarPortfolioHeader,
  toSearchParams,
} from "@/components/edit/reports/translational-portfolio-scholar-body";
import { Skeleton } from "@/components/ui/skeleton";
import { reportMetaFor } from "@/lib/edit/report-meta";
import { loadPortfolioChoices } from "@/lib/edit/translational-portfolio-report";
import {
  parseScholarPortfolioParams,
  backParams,
  reportHrefFor,
  resolveScholarPortfolioAccess,
  scholarPortfolioPath,
} from "@/lib/edit/translational-portfolio-scholar";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Translational portfolio — Scholars Console",
  robots: { index: false, follow: false },
};

const PATH = "/edit/scholar/[cwid]/translational-portfolio";

export default async function ScholarTranslationalPortfolioPage({
  params,
  searchParams,
}: {
  params: Promise<{ cwid: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { cwid } = await params;
  const sp = (await searchParams) ?? {};
  const access = await resolveScholarPortfolioAccess(cwid, PATH);
  if (access.kind === "login") {
    const qs = toSearchParams(sp).toString();
    redirect(
      `/api/auth/saml/login?return=${encodeURIComponent(`${scholarPortfolioPath(cwid)}${qs ? `?${qs}` : ""}`)}`,
    );
  }
  if (access.kind === "denied") notFound();
  const { session, scholar } = access;

  const p = parseScholarPortfolioParams(toSearchParams(sp));
  const { units } = backParams(p);
  const [meta, unitName] = await Promise.all([
    reportMetaFor("26"),
    units.length > 0
      ? loadPortfolioChoices()
          .then((c) => units.map((u) => c.labels.get(u) ?? u).join(", "))
          .catch(() => "")
      : Promise.resolve(""),
  ]);
  const back = {
    href: reportHrefFor(`/edit/reports/${meta.slug}`, p),
    label: unitName || meta.name || "Translational portfolio",
  };

  return (
    <ConsoleShell
      active="reports"
      session={session}
      pendingSlugRequests={null}
      pendingHonors={null}
      reportsTab
    >
      <div className="flex flex-col gap-2 [print-color-adjust:exact]">
        <ScholarPortfolioHeader scholar={scholar} params={p} back={back} />
        <Suspense
          key={toSearchParams(sp).toString()}
          fallback={<Skeleton className="mt-7 h-[480px] w-full rounded-xl" />}
        >
          <ScholarPortfolioBody scholar={scholar} searchParams={sp} />
        </Suspense>
      </div>
    </ConsoleShell>
  );
}
