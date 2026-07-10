"use client";

/**
 * CTL sponsor match — paste a commercial sponsor's description (an email or a
 * call transcript), rank WCM researchers on topical fit ALONE
 * (`docs/2026-07-09-ctl-technologies-handoff.md` §2). One POST to
 * `/api/edit/sponsor-match`; no stage axis, no ESI, no intake queue.
 *
 * Rows are a deliberately minimal cut of the Funding-matcher row (that markup
 * is not exported and carries stage/ESI/CSV machinery this surface rejects):
 * linked name → public profile, title/department, the paper-count evidence,
 * and a CTL-IP count badge when the researcher already holds licensable IP.
 */
import { useState } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { initials } from "@/lib/utils";

type TopicContribution = {
  topicId: string;
  contribution: number;
  pubCount: number;
  minYear: number | null;
};

type RankedResearcher = {
  cwid: string;
  slug: string;
  preferredName?: string;
  title?: string | null;
  department?: string | null;
  topicContributions: TopicContribution[];
  defaultScore: number;
  technologyCount?: number;
};

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; researchers: RankedResearcher[] }
  | { kind: "error"; message: string };

export function SponsorMatchPanel() {
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const pending = status.kind === "loading";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pending || description.trim().length === 0) return;
    setStatus({ kind: "loading" });
    try {
      const r = await fetch("/api/edit/sponsor-match", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ description }),
      });
      if (r.ok) {
        const data = (await r.json()) as { researchers?: RankedResearcher[] };
        setStatus({ kind: "ok", researchers: data.researchers ?? [] });
        return;
      }
      setStatus({
        kind: "error",
        message:
          r.status === 403
            ? "You don't have access to the sponsor matcher."
            : "Couldn't rank researchers. Please try again.",
      });
    } catch {
      setStatus({ kind: "error", message: "Couldn't rank researchers. Please try again." });
    }
  }

  return (
    <div data-slot="sponsor-match-panel">
      <div className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight">Sponsor match</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Paste a commercial sponsor&rsquo;s description of their interest and rank Weill
          Cornell researchers by topical fit alone — no career-stage or grant-eligibility
          weighting. Recommendations, not endorsements.
        </p>
      </div>

      <form onSubmit={submit} className="mb-6">
        <label htmlFor="sponsor-description" className="mb-1.5 block text-sm font-medium">
          Sponsor&rsquo;s description
        </label>
        <textarea
          id="sponsor-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={6}
          placeholder="Paste the sponsor's description of their interest…"
          className="border-border w-full rounded-md border bg-background px-3 py-2 text-sm focus:border-[var(--color-accent-slate)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent-slate)]"
          spellCheck={false}
        />
        <button
          type="submit"
          disabled={pending || description.trim().length === 0}
          className="mt-2 inline-flex h-9 items-center rounded-md bg-[var(--color-accent-slate)] px-4 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? "Ranking…" : "Rank researchers"}
        </button>
      </form>

      {status.kind === "loading" ? (
        <div aria-busy="true">
          <p className="text-muted-foreground py-3 text-sm">Ranking researchers…</p>
          <div className="space-y-3">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="border-border rounded-lg border p-4">
                <Skeleton className="h-3 w-1/4" />
                <Skeleton className="mt-2 h-4 w-2/3" />
              </div>
            ))}
          </div>
        </div>
      ) : status.kind === "error" ? (
        <p role="alert" className="text-muted-foreground py-4 text-sm">
          {status.message}
        </p>
      ) : status.kind === "ok" ? (
        status.researchers.length === 0 ? (
          <p className="text-muted-foreground py-4 text-sm">
            No researchers matched this description.
          </p>
        ) : (
          <>
            <h2 className="text-base font-semibold">
              Researchers for this description ({status.researchers.length})
            </h2>
            <ul className="mt-1">
              {status.researchers.map((r, i) => (
                <li key={r.cwid}>
                  <ResearcherRow r={r} rank={i + 1} />
                </li>
              ))}
            </ul>
          </>
        )
      ) : null}
    </div>
  );
}

function ResearcherRow({ r, rank }: { r: RankedResearcher; rank: number }) {
  const name = r.preferredName ?? r.slug ?? r.cwid;
  // One synthetic topic, so the first contribution IS the whole evidence.
  const evidence = r.topicContributions[0];
  const techCount = r.technologyCount ?? 0;
  return (
    <div className="border-t border-border flex gap-3 py-4 first:border-t-0">
      <div className="text-muted-foreground w-5 pt-1 text-right text-sm tabular-nums">{rank}</div>
      <div
        aria-hidden
        className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent-slate)]/15 text-sm font-medium text-[var(--color-accent-slate)]"
      >
        {initials(name)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <a
            href={`/${encodeURIComponent(r.slug)}`}
            className="text-base font-semibold leading-snug text-foreground underline-offset-4 hover:underline"
          >
            {name}
          </a>
          {r.title ? <span className="text-muted-foreground text-sm">{r.title}</span> : null}
        </div>
        {r.department ? <div className="text-muted-foreground text-sm">{r.department}</div> : null}
        {evidence && evidence.pubCount > 0 ? (
          <p className="mt-1.5 text-sm text-foreground/90">
            {evidence.pubCount} matching paper{evidence.pubCount === 1 ? "" : "s"}
            {evidence.minYear ? ` since ${evidence.minYear}` : ""}
          </p>
        ) : null}
        {techCount > 0 ? (
          <span
            title="Licensable technologies this researcher already holds in the CTL portfolio."
            className="mt-1.5 inline-flex rounded-full bg-[var(--color-accent-slate)]/15 px-2 py-0.5 text-xs text-[var(--color-accent-slate)]"
          >
            {techCount} CTL technolog{techCount === 1 ? "y" : "ies"}
          </span>
        ) : null}
      </div>
    </div>
  );
}
