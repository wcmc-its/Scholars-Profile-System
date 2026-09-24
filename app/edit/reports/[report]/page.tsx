/**
 * `/edit/reports/[report]` — the ONE page behind every numbered report of the
 * reports console (registry plan, 2026-09-20). It replaced the seven
 * `app/edit/reports/{1..7}/page.tsx` files, each of which repeated the same
 * frame around a different body; the frame lives here once and the bodies
 * live in the registry (`lib/edit/report-registry.ts`, one entry + one
 * `components/edit/reports/<slug>-body.tsx` per report). A body owns nothing
 * but the report — no session, no gate, no shell, no back link, no header.
 *
 * Routing contract (`[report]` is the segment):
 *   - a NUMBER (`/edit/reports/7`, a `ReportKey`) is the report's permanent
 *     link: it 307s to the report's CURRENT slug with the query string
 *     carried over. A plain `redirect`, never `permanentRedirect` — a browser
 *     caches a 308 for good and the slug is renameable (`report_meta.slug`,
 *     superuser-editable), so a cached 308 would pin a bookmark to a stale
 *     name. The number is the stable key (`report-slug.ts` refuses an
 *     all-digit slug so the two namespaces can't collide); older links —
 *     `app/edit/page.tsx`'s holder redirect, `core-claim-queue.tsx`'s
 *     "Reporting..." — keep the number and ride this redirect on purpose.
 *   - a SLUG (`/edit/reports/mentored-publications`) is the canonical
 *     address: resolved through `loadReportMeta()` (never a constant, since a
 *     superuser can rename it), and what the index links to directly.
 *   - anything else → 404.
 *
 * Two gates, chosen by the registry entry (`ReportDef.gate`), each exactly
 * what the page it replaced enforced:
 *   - `"unit"` (reports 1–6): `resolveNumberedReportCenterCode` with the
 *     kinds `unitKindsFor(n)` allows (`REPORT_NUMBERS_BY_KIND` — center-only
 *     for 1/2/4/5, all four kinds for 3/6; a `?kind=` outside that set is
 *     ignored, so `?kind=core` on report 4 falls back to a center exactly as
 *     before) → `loadReportsContext`; null → the visible 403
 *     (`ForbiddenEditPage`). The popover states the unit rule.
 *   - `"admin"` (report 8): `canViewArticleCountReport` — any unit
 *     administrator, or an `article-count` grant row; the popover lists the
 *     grant rows like the person gate's.
 *   - `"person"` (reports 7, 9): `getReportScopes(session, accessKey)`; an empty
 *     set → `notFound()` BEFORE any data read (the route reads as unbuilt to
 *     someone it was never granted to, like `/edit/data-sharing`). The
 *     popover lists the grant rows for EVERY viewer — who else can open this
 *     is not a secret — with Add / Remove gated on `canManageReportAccess`.
 *
 * Order, unchanged from the seven pages: session → SSO redirect FIRST (before
 * any DB read) → number/slug resolution → the gate → the console tab counts
 * → `ConsoleShell` → "← All reports" → `ReportHeader` (eyebrow, h1, access
 * badge, "Edit details", the body's `subtitle`, the "About this report"
 * disclosure) → the body's `main`. `force-dynamic`, noindex, like every `/edit/*` console page.
 *
 * Loading: no route `loading.tsx` (it replaced the whole page, top bar
 * included, since the shell needs the session). The body streams under
 * `Suspense` with `ReportBodySkeleton`, so only the report area shimmers.
 */
import { Suspense } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { ConsoleShell } from "@/components/edit/console-shell";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { ADMIN_AUDIENCE, type ReportAccessPopoverProps } from "@/components/edit/report-access-popover";
import { ReportHeader } from "@/components/edit/report-header";
import { Skeleton } from "@/components/ui/skeleton";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { canViewArticleCountReport } from "@/lib/edit/article-count-report";
import { db } from "@/lib/db";
import {
  loadReportsContext,
  resolveNumberedReportCenterCode,
  type ReportableUnitKind,
} from "@/lib/edit/cancer-center-reports";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";
import {
  ARTICLE_COUNT_ACCESS_NOTE,
  ARTICLE_COUNT_REPORT,
  getReportScopes,
} from "@/lib/edit/report-access";
import { loadReportAccessPopoverProps } from "@/lib/edit/report-access-popover-props";
import {
  isReportKey,
  loadReportMeta,
  reportPageMetadata,
  type ReportKey,
  type ReportMeta,
} from "@/lib/edit/report-meta";
import {
  REPORTS,
  unitKindsFor,
  type ReportRender,
  type ReportSearchParams,
} from "@/lib/edit/report-registry";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";

export const dynamic = "force-dynamic";

/** The segment as a report: its `report_meta` entry when the segment is the
 *  report's number OR its current slug, else null (a 404). One `cache()`d
 *  `loadReportMeta` read, shared with `generateMetadata` and `ReportHeader`. */
async function resolveSegment(segment: string): Promise<ReportMeta | null> {
  const meta = await loadReportMeta();
  if (isReportKey(segment)) return meta.get(segment) ?? null;
  for (const m of meta.values()) if (m.slug === segment) return m;
  return null;
}

/** The incoming query string, re-serialized for the number → slug redirect
 *  (a repeated key is an array in Next's `searchParams`; each value is kept). */
function querySuffix(searchParams: ReportSearchParams): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) params.append(key, v);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/** `<title>` from `report_meta` (superuser-editable), one cached read shared
 *  with `ReportHeader` below. An unresolvable segment gets the console's
 *  generic title (the page 404s). */
export async function generateMetadata({ params }: { params: Promise<{ report: string }> }) {
  const { report: segment } = await params;
  const meta = await resolveSegment(segment);
  if (meta === null) {
    return { title: "Reports — Scholars Console", robots: { index: false, follow: false } };
  }
  return reportPageMetadata(meta.key);
}

export default async function EditReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ report: string }>;
  searchParams?: Promise<ReportSearchParams>;
}) {
  const { report: segment } = await params;
  const session = await getEffectiveEditSession();
  if (!session) {
    redirect(`/api/auth/saml/login?return=/edit/reports/${encodeURIComponent(segment)}`);
  }

  const sp = (await searchParams) ?? {};
  const meta = await resolveSegment(segment);
  if (meta === null) {
    notFound();
  }
  // The number is the permanent link; the slug is the address. A 307 (not a
  // 308) — see the module comment.
  if (isReportKey(segment)) {
    redirect(`/edit/reports/${meta.slug}${querySuffix(sp)}`);
  }
  const n: ReportKey = meta.key;
  const basePath = `/edit/reports/${meta.slug}`;
  const def = REPORTS[n];

  let back: string;
  // Deferred so the grant list (person gate), the shell counts and the
  // body's own loads all run in ONE `Promise.all` below — report 7's page
  // ran its four reads concurrently before this refactor; a serial chain
  // here would be a latency regression on the heaviest report.
  let loadAccess: () => Promise<ReportAccessPopoverProps>;
  let render: () => Promise<ReportRender>;

  if (def.gate === "unit") {
    const allowedKinds = unitKindsFor(n);
    const center = typeof sp.center === "string" ? sp.center : undefined;
    const kindParam = typeof sp.kind === "string" ? sp.kind : undefined;
    // Only a kind this report serves is honoured; anything else falls back
    // to the resolver's center default, exactly as the per-page `parseKind`
    // (reports 3/6) and the kind-blind pages (1/2/4/5) behaved.
    const requestedKind: ReportableUnitKind | undefined = allowedKinds.find((k) => k === kindParam);
    const { code, kind } = await resolveNumberedReportCenterCode(session, db.read, center, {
      allowedKinds,
      requestedKind,
    });
    const ctx = await loadReportsContext(code, session, db.read, kind);
    if (ctx === null) {
      return (
        <ConsoleShell
          active="reports"
          session={session}
          pendingSlugRequests={null}
          pendingHonors={null}
        >
          <ForbiddenEditPage variant="unit" targetEntity={code} />
        </ConsoleShell>
      );
    }

    // `&kind=` only for a department/division/core, so an existing
    // `?center=<centerCode>` bookmark (implied `kind=center`) keeps its form.
    back =
      kind === "center"
        ? `/edit/reports?center=${encodeURIComponent(code)}`
        : `/edit/reports?center=${encodeURIComponent(code)}&kind=${kind}`;
    loadAccess = async () => ({ mode: "unit" });
    render = () => def.render({ n, code, kind, ctx, session, searchParams: sp, basePath });
  } else if (def.gate === "admin") {
    if (!(await canViewArticleCountReport(session))) notFound();
    back = "/edit/reports";
    loadAccess = async () => ({
      ...(await loadReportAccessPopoverProps(ARTICLE_COUNT_REPORT, session, ARTICLE_COUNT_ACCESS_NOTE)),
      audience: ADMIN_AUDIENCE,
    });
    render = () => def.render({ n, session, searchParams: sp, basePath });
  } else {
    // Row-based gate: an empty scope set reads as an unbuilt route, the same
    // 404 `/edit/data-sharing` gives a non-viewer.
    const scopes = await getReportScopes(session, def.accessKey);
    if (scopes.size === 0) {
      notFound();
    }

    // The grant list is read for EVERY viewer — the popover shows who else
    // can run the report to anyone who can; only Add / Remove ride
    // `canManage`.
    back = "/edit/reports";
    loadAccess = () => loadReportAccessPopoverProps(def.accessKey, session);
    render = () => def.render({ n, scopes, session, searchParams: sp, basePath });
  }

  // The body is NOT awaited here: the shell, back link and header render at
  // once and the body streams in under its own skeleton (the Suspense
  // boundaries below). Started now so it runs alongside the shell reads.
  const rendered = render();
  // Mark it handled so a body that fails before a boundary awaits it is not
  // reported as an unhandled rejection; the boundaries still see the error.
  rendered.catch(() => {});
  const [pendingSlugRequests, pendingHonors, access] = await Promise.all([
    session.isSuperuser && isSlugRequestEnabled()
      ? countPendingSlugRequests(db.read)
      : Promise.resolve(null),
    isHonorsQueueTabVisible(session) ? countPendingHonors(db.read) : Promise.resolve(null),
    loadAccess(),
  ]);
  // Keyed on the query so a filter change (same route, new params) shows the
  // skeleton again instead of leaving the old results up while it loads.
  const bodyKey = querySuffix(sp);
  return (
    <ConsoleShell
      active="reports"
      session={session}
      pendingSlugRequests={pendingSlugRequests}
      pendingHonors={pendingHonors}
      reportsTab
    >
      <Link href={back} className="text-apollo-slate mb-4 inline-block text-sm hover:underline">
        &larr; All reports
      </Link>
      <ReportHeader n={n} session={session} access={access}>
        <Suspense key={bodyKey} fallback={<Skeleton className="h-4 w-96 max-w-full" />}>
          <RenderedPart rendered={rendered} part="subtitle" />
        </Suspense>
      </ReportHeader>
      <Suspense key={bodyKey} fallback={<ReportBodySkeleton />}>
        <RenderedPart rendered={rendered} part="main" />
      </Suspense>
    </ConsoleShell>
  );
}

/** One half of a body's `ReportRender`, once the body resolves. */
async function RenderedPart({
  rendered,
  part,
}: {
  rendered: Promise<ReportRender>;
  part: keyof ReportRender;
}) {
  return (await rendered)[part] ?? null;
}

/** The body's loading state: a filter rail beside tabs and a table. Only the
 *  body — the shell, back link and report title are already on screen. */
function ReportBodySkeleton() {
  return (
    <div aria-busy="true" className="mt-4 flex flex-col gap-6 lg:flex-row lg:items-start">
      <div role="status" className="sr-only">
        Loading report…
      </div>
      <Skeleton className="hidden h-96 rounded-xl lg:block lg:w-64 lg:shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="border-apollo-border flex gap-6 border-b pb-2">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-5 w-28" />
        </div>
        <Skeleton className="mt-4 h-4 w-80 max-w-full" />
        <Skeleton className="mt-4 h-96 w-full rounded-md" />
      </div>
    </div>
  );
}
