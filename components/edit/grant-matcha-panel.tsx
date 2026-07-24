"use client";

/**
 * Grant Matcha (PR1) — pick a funding opportunity, then run it through the Matcha spine.
 *
 * The only new thing over `/edit/matcha` is the opportunity picker: on select we fetch the
 * opportunity's full text and seed `<MatchaPanel>` with `title + "\n\n" + synopsis`, running the
 * ask once (`autoRun`). `key={id}` remounts the panel per opportunity so its mount-only auto-run
 * fires fresh each time — the exact seeding `find-researchers` already uses (#1866). Everything
 * downstream (extracted concepts, weight sliders, ranked researchers) is unchanged Matcha.
 *
 * Eligibility rail / per-row badges / filtered floor are PR2 — not here.
 */
import { useCallback, useEffect, useState } from "react";

import { MatchaPanel } from "@/components/edit/matcha-panel";

type OppListItem = {
  opportunityId: string;
  title: string | null;
  sponsor: string | null;
  mechanism: string | null;
  dueDate: string | null;
};

type Selected = { id: string; title: string | null; sponsor: string | null; askSeed: string };

const INPUT_CLASS =
  "border-border h-9 w-full rounded-md border bg-background px-3 text-sm focus:border-[var(--color-accent-slate)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent-slate)]";

/** Build the ask exactly as find-researchers does: title + blank line + synopsis, empties dropped. */
function buildAskSeed(title: string | null, synopsis: string | null): string {
  return [title, synopsis].filter((s): s is string => Boolean(s && s.trim())).join("\n\n");
}

export function GrantMatchaPanel() {
  const [selected, setSelected] = useState<Selected | null>(null);
  const [pickerOpen, setPickerOpen] = useState(true);
  const [opps, setOpps] = useState<OppListItem[] | null>(null);
  const [query, setQuery] = useState("");
  const [listErr, setListErr] = useState<string | null>(null);
  const [pickErr, setPickErr] = useState<string | null>(null);
  const [selecting, setSelecting] = useState<string | null>(null);

  // ponytail: fetch the curated corpus once (limit 200, curated-first) and filter client-side.
  // The curated awards ARE the tool's point and number in the low hundreds; add server `q` paging
  // if the corpus ever outgrows one page.
  const loadOpps = useCallback(async () => {
    setListErr(null);
    try {
      const r = await fetch("/api/opportunities?limit=200", {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!r.ok) throw new Error(String(r.status));
      const data = (await r.json()) as { opportunities: OppListItem[] };
      setOpps(data.opportunities);
    } catch {
      setListErr("Couldn't load opportunities. Try again.");
    }
  }, []);

  useEffect(() => {
    if (pickerOpen && opps === null) void loadOpps();
  }, [pickerOpen, opps, loadOpps]);

  const pick = useCallback(async (o: OppListItem) => {
    setSelecting(o.opportunityId);
    setPickErr(null);
    try {
      // The list route omits synopsis; the detail route carries the full text we seed from.
      const r = await fetch(`/api/opportunities/${encodeURIComponent(o.opportunityId)}`, {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!r.ok) throw new Error(String(r.status));
      const full = (await r.json()) as { title: string | null; synopsis: string | null };
      const askSeed = buildAskSeed(full.title, full.synopsis);
      if (!askSeed) {
        setPickErr("That opportunity has no text to match on. Pick another.");
        return;
      }
      setSelected({ id: o.opportunityId, title: full.title ?? o.title, sponsor: o.sponsor, askSeed });
      setPickerOpen(false);
    } catch {
      setPickErr("Couldn't load that opportunity. Try again.");
    } finally {
      setSelecting(null);
    }
  }, []);

  const q = query.trim().toLowerCase();
  const filtered = (opps ?? []).filter(
    (o) =>
      !q ||
      [o.title, o.sponsor, o.mechanism].some((s) => (s ?? "").toLowerCase().includes(q)),
  );

  return (
    <div>
      {selected ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 text-sm">
            {selected.sponsor ? (
              <span className="font-semibold text-[var(--color-accent-slate)]">
                {selected.sponsor}
                {" · "}
              </span>
            ) : null}
            <span className="text-foreground">{selected.title ?? "Untitled opportunity"}</span>
          </div>
          <button
            type="button"
            onClick={() => setPickerOpen((v) => !v)}
            className="border-border shrink-0 rounded-md border bg-background px-3 py-1.5 text-sm font-medium hover:bg-[var(--color-apollo-rail-hover)]"
          >
            Change opportunity
          </button>
        </div>
      ) : (
        <div className="mb-2">
          <h1 className="mb-1 text-2xl font-semibold tracking-tight">Grant Matcha</h1>
          <p className="text-muted-foreground text-sm">
            Choose a funding opportunity to rank Weill Cornell researchers on its text.
          </p>
        </div>
      )}

      {(pickerOpen || !selected) && (
        <div className="border-apollo-rail-border bg-apollo-rail mb-5 rounded-xl border p-4">
          <label htmlFor="grant-matcha-oppsearch" className="sr-only">
            Search funding opportunities
          </label>
          <input
            id="grant-matcha-oppsearch"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search funding opportunities by title, sponsor, mechanism…"
            className={INPUT_CLASS}
          />
          {listErr ? (
            <p className="text-destructive mt-3 text-sm">{listErr}</p>
          ) : opps === null ? (
            <p className="text-muted-foreground mt-3 text-sm">Loading opportunities…</p>
          ) : (
            <ul className="mt-3 flex max-h-[320px] list-none flex-col gap-1.5 overflow-auto p-0">
              {filtered.length === 0 ? (
                <li className="text-muted-foreground text-sm">No matching opportunities.</li>
              ) : (
                filtered.map((o) => (
                  <li key={o.opportunityId}>
                    <button
                      type="button"
                      onClick={() => void pick(o)}
                      disabled={selecting !== null}
                      className="border-border hover:border-[var(--color-accent-slate)] w-full rounded-lg border bg-background px-3 py-2.5 text-left text-sm disabled:opacity-60"
                    >
                      <span className="text-foreground font-semibold">
                        {o.title ?? "Untitled opportunity"}
                      </span>
                      <span className="text-muted-foreground mt-0.5 block text-xs">
                        {[o.sponsor, o.mechanism, o.dueDate ? `Due ${o.dueDate.slice(0, 10)}` : null]
                          .filter(Boolean)
                          .join(" · ")}
                        {selecting === o.opportunityId ? " · loading…" : ""}
                      </span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          )}
          {pickErr ? <p className="text-destructive mt-3 text-sm">{pickErr}</p> : null}
        </div>
      )}

      {selected ? (
        <MatchaPanel key={selected.id} initialDescription={selected.askSeed} autoRun />
      ) : null}
    </div>
  );
}
