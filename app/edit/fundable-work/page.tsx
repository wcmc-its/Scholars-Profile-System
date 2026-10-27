/**
 * `/edit/fundable-work` — WCM conference abstracts and preprints by full-time
 * faculty (postdoc co-authors shown alongside), ranked by an at-ingest LLM read of their private-funding potential
 * (etl/fundable-work). For CTL: which new work to bring to industry and foundations.
 *
 * Audience: the Matcha audience (superuser, development role, observer).
 * `notFound()` while FUNDABLE_WORK is off. Read-only, so there is no API route:
 * this server component is the authorization boundary.
 */
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { ConsoleShell } from "@/components/edit/console-shell";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { logEditDenial } from "@/lib/edit/authz";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";
import { isFundableWorkEnabled, type FundableWorkFunder } from "@/lib/fundable-work";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Fundable work — Scholars Console",
  robots: { index: false, follow: false },
};

const ROW_LIMIT = 300;
const TYPES = [
  { value: "", label: "All" },
  { value: "conference-abstract", label: "Conference abstracts" },
  { value: "preprint", label: "Preprints" },
];
const TYPE_LABEL: Record<string, string> = { "conference-abstract": "Abstract", preprint: "Preprint" };

const chip = "rounded-full border px-3 py-1 text-[13px]";
const chipOn = "border-apollo-slate bg-apollo-slate text-white";
const chipOff = "border-apollo-border-strong text-muted-foreground hover:text-foreground";

export default async function FundableWorkPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; min?: string }>;
}) {
  if (!isFundableWorkEnabled()) notFound();
  const session = await getEffectiveEditSession();
  if (!session) redirect("/api/auth/saml/login?return=/edit/fundable-work");
  if (!(session.isSuperuser || session.isDeveloper || session.isObserver)) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: "fundable-work",
      path: "/edit/fundable-work",
      reason: "not_developer_get",
    });
    return (
      <ConsoleShell active="fundable-work" session={session} pendingSlugRequests={null} pendingHonors={null}>
        <ForbiddenEditPage session={session} />
      </ConsoleShell>
    );
  }

  const params = await searchParams;
  const type = TYPES.some((t) => t.value === params.type) ? params.type! : "";
  const min = Math.min(5, Math.max(1, Number(params.min) || 3));
  const href = (over: { type?: string; min?: number }) => {
    const q = new URLSearchParams();
    const t = over.type ?? type;
    if (t) q.set("type", t);
    q.set("min", String(over.min ?? min));
    return `/edit/fundable-work?${q}`;
  };

  const [works, pendingSlugRequests, pendingHonors] = await Promise.all([
    db.read.fundableWork.findMany({
      where: { score: { gte: min }, ...(type ? { type } : {}) },
      orderBy: [{ score: "desc" }, { publicationDate: "desc" }],
      take: ROW_LIMIT,
      include: {
        authors: {
          include: { scholar: { select: { preferredName: true, slug: true, primaryDepartment: true, roleCategory: true } } },
        },
      },
    }),
    session.isSuperuser && isSlugRequestEnabled() ? countPendingSlugRequests(db.read) : null,
    isHonorsQueueTabVisible(session) ? countPendingHonors(db.read) : null,
  ]);

  return (
    <ConsoleShell
      active="fundable-work"
      session={session}
      pendingSlugRequests={pendingSlugRequests}
      pendingHonors={pendingHonors}
    >
      <div className="flex flex-col gap-5">
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">Fundable work</h1>
          <p className="text-muted-foreground max-w-3xl text-sm">
            Conference abstracts and preprints by full-time faculty from the last two years,
            with postdoc co-authors listed,
            scored 1–5 for industry and foundation funding potential. Scores, pitches and funder
            suggestions are an AI first pass; check them before outreach.
          </p>
        </header>

        <div className="flex flex-wrap items-center gap-2">
          {TYPES.map((t) => (
            <Link key={t.value} href={href({ type: t.value })} className={cn(chip, t.value === type ? chipOn : chipOff)}>
              {t.label}
            </Link>
          ))}
          <span className="text-muted-foreground ml-3 text-[13px]">Minimum score</span>
          {[1, 2, 3, 4, 5].map((n) => (
            <Link key={n} href={href({ min: n })} className={cn(chip, n === min ? chipOn : chipOff)}>
              {n}+
            </Link>
          ))}
        </div>

        <p className="text-muted-foreground text-[13px]">
          {works.length === ROW_LIMIT ? `Top ${ROW_LIMIT}` : works.length} result{works.length === 1 ? "" : "s"}
        </p>

        <ol className="flex flex-col gap-3">
          {works.map((w) => {
            const funders = w.funders as FundableWorkFunder[];
            return (
              <li key={w.id} className="border-apollo-border-strong bg-apollo-surface rounded-[13px] border px-[18px] py-4">
                <div className="flex gap-4">
                  <div
                    className="bg-apollo-surface-2 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-lg font-semibold tabular-nums"
                    aria-label={`Score ${w.score} of 5`}
                  >
                    {w.score}
                  </div>
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <a
                      href={w.doi ? `https://doi.org/${w.doi}` : `https://openalex.org/${w.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium hover:underline"
                    >
                      {w.title}
                    </a>
                    <div className="text-muted-foreground text-[13px]">
                      {TYPE_LABEL[w.type] ?? w.type} · {w.venue ?? "Unknown venue"} ·{" "}
                      {w.publicationDate.toISOString().slice(0, 10)} · {w.stage}
                      {w.modality ? ` · ${w.modality}` : ""}
                    </div>
                    <div className="text-[13px]">
                      {w.authors.map((a, i) => (
                        <span key={a.cwid}>
                          {i > 0 ? "; " : ""}
                          <Link href={`/scholars/${a.scholar.slug}`} className="hover:underline">
                            {a.scholar.preferredName}
                          </Link>
                          <span className="text-muted-foreground">
                            {a.scholar.roleCategory === "postdoc" ? " (postdoc)" : ""}
                            {a.position !== "middle" ? ` (${a.position} author)` : ""}
                            {a.scholar.primaryDepartment ? `, ${a.scholar.primaryDepartment}` : ""}
                          </span>
                        </span>
                      ))}
                    </div>
                    <p className="text-sm">{w.rationale}</p>
                    <details className="text-sm">
                      <summary className="text-apollo-slate cursor-pointer text-[13px] font-medium">
                        Funding pitch and possible funders
                      </summary>
                      <div className="mt-2 flex flex-col gap-3">
                        <p>{w.pitch}</p>
                        {funders.length > 0 ? (
                          <ul className="flex flex-col gap-1">
                            {funders.map((f) => (
                              <li key={f.name}>
                                <span className="font-medium">{f.name}</span>{" "}
                                <span className="text-muted-foreground">({f.kind})</span> — {f.why}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                        <p className="text-muted-foreground text-[13px] whitespace-pre-line">{w.abstract}</p>
                      </div>
                    </details>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </ConsoleShell>
  );
}
