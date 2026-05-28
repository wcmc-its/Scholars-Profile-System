/**
 * `/about/feedback` — the linkable, server-rendered feedback form
 * (#538 PR-2, docs/feedback-badge-spec.md).
 *
 * Mode determination: contextual when the `from` query param resolves
 * to a same-origin URL (the badge passes `?from=<window.location>` when
 * launching the form); generic otherwise. The `Referer` header is a
 * weaker fallback — it points back here once the form re-renders, so
 * we only trust it on the very first GET.
 *
 * Gated by `FEEDBACK_BADGE_ENABLED` — when off, returns 404 so the
 * route looks like it doesn't exist.
 */
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { FeedbackForm } from "@/components/feedback/feedback-form";
import { getSession } from "@/lib/auth/session-server";
import { db } from "@/lib/db";
import { urlToPageRoute } from "@/lib/feedback/page-route";
import { inferRoleFromCategory } from "@/lib/feedback/q6-inference";
import { validateSameOriginUrl } from "@/lib/feedback/same-origin";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Share feedback — Scholars at WCM",
  description: "Tell us what's working and what isn't on the Scholars Profile System.",
  alternates: { canonical: "/about/feedback" },
};

export default async function FeedbackPage({
  searchParams,
}: {
  searchParams?: Promise<{ from?: string }>;
}) {
  if (process.env.FEEDBACK_BADGE_ENABLED !== "on") {
    notFound();
  }

  const sp = (await searchParams) ?? {};
  const fromParam = sp.from ?? null;

  const hdrs = await headers();
  // Trust `?from=` first (the badge sets it explicitly); fall back to
  // Referer only if it's not the feedback page itself, which would be
  // a re-render after a validation error and is meaningless context.
  const referer = hdrs.get("referer") ?? null;
  const refererSafe =
    referer && !referer.includes("/about/feedback") ? referer : null;

  const pageUrl = validateSameOriginUrl(fromParam) ?? validateSameOriginUrl(refererSafe);
  const pageRoute = pageUrl ? urlToPageRoute(pageUrl) : null;
  const mode: "contextual" | "generic" = pageUrl ? "contextual" : "generic";

  const session = await getSession().catch(() => null);
  const defaultCwid = session?.cwid ?? null;
  const scholar = defaultCwid
    ? await db.read.scholar
        .findUnique({
          where: { cwid: defaultCwid },
          select: { roleCategory: true },
        })
        .catch(() => null)
    : null;
  const defaultRole = inferRoleFromCategory(scholar?.roleCategory);

  return (
    <main className="mx-auto max-w-[640px] px-6 py-10">
      <header className="mb-6">
        <h1 className="text-3xl font-semibold leading-tight">
          {mode === "contextual" ? "Share feedback about this page" : "Share feedback about Scholars"}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          A few quick questions about your visit. All but consent are optional.
        </p>
      </header>
      <FeedbackForm
        mode={mode}
        pageUrl={pageUrl}
        pageRoute={pageRoute}
        defaultCwid={defaultCwid}
        defaultRole={defaultRole}
      />
    </main>
  );
}
