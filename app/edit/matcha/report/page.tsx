/**
 * `/edit/matcha/report?submissionId=…&cwids=a,b,c` — Matcha Phase 4, the printable scouting report.
 *
 * `notFound()` unless BOTH `MATCHA` and `MATCHA_BRIEF` are on (never reveal a dark surface). Gate =
 * the Matcha read gate (superuser / developer / observer), scoped like Recent: a non-privileged
 * officer can open only a search they ran. Read-only, so observers may open it, and no audit row.
 *
 * The selection is checked against the SAVED result: an unknown cwid is ignored, and at most
 * `MATCHA_REPORT_CAP` PIs render. Rendered standalone (no console chrome) so it prints clean.
 * `force-dynamic` + `noindex` like every `/edit/*` page; the edge serves `/edit*` uncached.
 */
import { notFound, redirect } from "next/navigation";

import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { MatchaReportView } from "@/components/edit/matcha-report";
import { isMatchaEnabled } from "@/lib/api/matcha";
import { isMatchaBriefEnabled } from "@/lib/api/matcha-brief";
import { loadMatchaReport, parseReportCwids } from "@/lib/api/matcha-report";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { logEditDenial } from "@/lib/edit/authz";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Scouting report — Scholars Console",
  robots: { index: false, follow: false },
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const one = (v: string | string[] | undefined): string =>
  Array.isArray(v) ? (v[0] ?? "") : (v ?? "");

export default async function MatchaReportPage({ searchParams }: { searchParams: SearchParams }) {
  if (!(isMatchaEnabled() && isMatchaBriefEnabled())) notFound();
  const params = await searchParams;
  const submissionId = one(params.submissionId);
  const cwidsRaw = one(params.cwids);

  const session = await getEffectiveEditSession();
  if (!session) {
    const back = `/edit/matcha/report?submissionId=${encodeURIComponent(submissionId)}&cwids=${encodeURIComponent(cwidsRaw)}`;
    redirect(`/api/auth/saml/login?return=${encodeURIComponent(back)}`);
  }
  if (!(session.isSuperuser || session.isDeveloper || session.isObserver)) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: "sponsor-match",
      path: "/edit/matcha/report",
      reason: "not_developer_get",
    });
    return <ForbiddenEditPage session={session} />;
  }
  if (submissionId.length === 0 || submissionId.length > 64) notFound();

  const report = await loadMatchaReport(session, submissionId, parseReportCwids(cwidsRaw));
  if (!report) notFound();
  return <MatchaReportView report={report} />;
}
