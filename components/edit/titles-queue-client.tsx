/**
 * The Titles queue (`/edit/titles-queue`) — the two interactive pieces of the body, kept
 * out of the server body so it can stay a server component:
 *
 *   RubricDisclosure    "How titles are chosen": one line and a toggle,
 *                       collapsed by default. It opens by itself when the URL
 *                       hash is `#rubric` — the `/edit` title picker's "How
 *                       titles are chosen" link deep-links there, so the
 *                       ladder must be showing when that link lands.
 *   TitleRowDisclosure  one scholar row plus its "Change" panel, which opens
 *                       full-width UNDER the row: every title on record with
 *                       its rank, "Pin this" on each one not displayed, and
 *                       Unpin when a pin is set.
 *
 * The pin panel posts `/api/edit/field` with `primaryTitle` — the SAME write
 * (and audit row) as `TitleField` on `/edit`; this page adds no write path.
 * The route accepts only a title on record (never free text) and `""` to
 * un-pin. After a save the page refreshes so the row, its reasons and the tab
 * counts come back from the server.
 *
 * Imports only `@/lib/scholar-title` and `@/lib/edit/title-dashboard`'s pure
 * `formatTitleRank` — nothing that reaches the database.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TITLE_RANK, TITLE_TIER_LABEL, type TitleOption } from "@/lib/scholar-title";
import { cn } from "@/lib/utils";

/** A ladder rank for display: "4", "8.5"; "—" for unranked. Mirrors
 *  `formatTitleRank` (title-dashboard.ts), which this client file cannot
 *  import without pulling that module's server imports in. */
function rankText(rank: number): string {
  return rank >= TITLE_RANK.unranked ? "—" : String(rank);
}

export function RubricDisclosure({
  summary,
  children,
}: {
  summary: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    const sync = () => {
      if (window.location.hash === "#rubric") setOpen(true);
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  return (
    <section
      id="rubric"
      aria-labelledby="rubric-heading"
      className="bg-apollo-surface border-apollo-border-strong scroll-mt-4 overflow-hidden rounded-[var(--apollo-radius-card)] border"
      data-testid="title-rubric"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls="rubric-body"
        onClick={() => setOpen((o) => !o)}
        className="hover:bg-apollo-surface-2/50 flex w-full flex-wrap items-center gap-x-3.5 gap-y-1 px-5 py-3.5 text-left"
        data-testid="title-rubric-toggle"
      >
        {/* A span: a heading is not allowed inside a button. */}
        <span id="rubric-heading" className="text-[15px] font-semibold">
          How titles are chosen
        </span>
        <span className="text-muted-foreground min-w-[240px] flex-1 text-[13px]">{summary}</span>
        <span className="text-apollo-slate text-[13px] whitespace-nowrap">
          {open ? "Hide ladder ▴" : "Show ladder and rules ▾"}
        </span>
      </button>
      <div id="rubric-body" hidden={!open} className="border-apollo-border border-t px-5 pt-1 pb-5">
        {children}
      </div>
    </section>
  );
}

export type TitleRowDisclosureProps = {
  cwid: string;
  name: string;
  /** Every tier, highest rank first; `value: null` = does not apply. */
  options: TitleOption[];
  /** What is displayed today (`Scholar.primaryTitle`). */
  displayed: string | null;
  /** True when a pin is set. */
  pinned: boolean;
  /** Superuser / comms steward (the pin gate): the Change control. */
  canSet: boolean;
  /** The md+ grid template, shared with the header row. */
  gridClass: string;
  /** The row's cells (server-rendered). */
  children: React.ReactNode;
};

export function TitleRowDisclosure({
  cwid,
  name,
  options,
  displayed,
  pinned,
  canSet,
  gridClass,
  children,
}: TitleRowDisclosureProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const panelId = `title-pin-${cwid}`;

  // One entry per distinct title (two tiers can carry the same string).
  const seen = new Set<string>();
  const candidates = options.filter((o): o is TitleOption & { value: string } => {
    if (o.value === null || seen.has(o.value)) return false;
    seen.add(o.value);
    return true;
  });

  async function post(value: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/edit/field", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          op: "set",
          entityType: "scholar",
          entityId: cwid,
          fieldName: "primaryTitle",
          value,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Could not save. Try again.");
        return;
      }
      setOpen(false);
      router.refresh();
    } catch {
      setError("Could not save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="border-apollo-border border-t first:border-t-0"
      data-testid={`title-row-${cwid}`}
    >
      <div
        className={cn(
          "grid grid-cols-1 gap-x-8 gap-y-2.5 px-[18px] py-3.5 md:items-start",
          gridClass,
        )}
      >
        {children}
        {canSet && (
          <div className="flex md:justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-expanded={open}
              aria-controls={panelId}
              onClick={() => setOpen((o) => !o)}
              className="border-apollo-border-strong bg-apollo-surface h-[30px] px-3 text-[13px]"
              data-testid={`title-change-${cwid}`}
            >
              {open ? "Close" : "Change"}
            </Button>
          </div>
        )}
      </div>
      {canSet && open && (
        <div
          id={panelId}
          className="bg-apollo-page border-apollo-border mx-[18px] mb-4 flex flex-col gap-2.5 rounded-[10px] border px-4 py-3.5"
          data-testid={`title-pin-panel-${cwid}`}
        >
          <p className="text-muted-foreground text-[13px]">
            Pin a title to override the ladder for {name}. Pins are logged and can be removed any
            time.
          </p>
          <ul className="flex flex-col gap-2">
            {candidates.map((c) => {
              const current = c.value === displayed;
              return (
                <li
                  key={c.tier}
                  className="bg-apollo-surface border-apollo-border flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2"
                >
                  <span className="text-muted-foreground w-[52px] font-mono text-xs">
                    rank {rankText(c.rank)}
                  </span>
                  <span className="min-w-[200px] flex-1 text-[13.5px]">
                    {c.value}{" "}
                    <span className="text-muted-foreground text-[12.5px]">
                      · {TITLE_TIER_LABEL[c.tier]}
                    </span>
                  </span>
                  {current ? (
                    <span className="text-muted-foreground text-[12.5px]">Displayed now</span>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      disabled={busy}
                      onClick={() => post(c.value)}
                      className="border-apollo-border-strong bg-apollo-surface h-7 px-2.5 text-[12.5px]"
                      data-testid={`title-pin-${cwid}-${c.tier}`}
                    >
                      Pin this
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
          {pinned && (
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => post("")}
                className="border-apollo-border-strong bg-apollo-surface text-[13px]"
                data-testid={`title-unpin-${cwid}`}
              >
                Unpin
              </Button>
            </div>
          )}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
      )}
    </div>
  );
}
