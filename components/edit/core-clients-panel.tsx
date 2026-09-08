"use client";

/**
 * "Known clients" MODAL — the core owner's roster of people they know use this
 * facility, recorded independently of any publication evidence (ReciterAI #383
 * / SPS #2607, widened here with name-only clients).
 *
 * `CoreClaimQueue` owns the open/closed state and the toolbar button; this
 * renders the dialog body as a controlled child. The roster it lists is the
 * `clients` PROP and nothing else — no copy here, and (since HANDOFF-11 round 4)
 * none in the parent either. Every write below ends in `router.refresh()`, which
 * re-renders the Server Component and delivers a fresh `clients`; while the
 * parent cached that prop in `useState` the refreshed roster was discarded on
 * arrival, so a row a co-owner or a second tab had added could never appear and
 * this dialog's list could only ever move through a fold-back channel that
 * synthesised its rows. One source of truth, the same one the queue's
 * candidates/confirmed/rejected already use.
 *
 * Three things happen in here, in the order the reviewer meets them:
 *   1. paste CWIDs -> "Add clients" resolves them against Scholars, then the
 *      enterprise directory, AND writes the roster rows in ONE round-trip, then
 *      lists who was recorded. This was
 *      two steps until HANDOFF-11 #2 — a "Look up CWIDs" preview, then a commit
 *      button in the footer, which sits below the name-only band and the entire
 *      roster inside a `max-h-[85vh]` scrolling shell. A reviewer looked up
 *      a CWID, read the preview row as the roster row it looks like, never
 *      scrolled to the footer, and no `core_client` row was ever written. One
 *      button cannot be half-pressed.
 *   2. "Or add someone without a CWID" -> a NAME-ONLY client. Roster-only by
 *      construction: with no CWID there is nothing for the byline match to key
 *      on, which the helper text says outright rather than leaving a reviewer to
 *      discover it when the name never flags anything.
 *   3. "On the roster now" -> the active list, each row removable. Remove keys
 *      on the row `id`, never the cwid, because a name-only row has no cwid.
 *
 * `parseCwidBlock` comes from `@/lib/cores/cwid-block` — a pure module with NO
 * `@/lib/db` import, so importing it here never drags `lib/api/core-clients.ts`'s
 * `db` (the mariadb Prisma adapter) into this client bundle. See that shared
 * module's comment for the full trap this avoids
 * (`lib/edit/manageable-units.ts` / `home-panel.tsx`).
 */
import { useState } from "react";
import { useRouter } from "next/navigation";

import type { CoreClientRow } from "@/lib/api/core-clients";
import { parseCwidBlock } from "@/lib/cores/cwid-block";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** One person the add just WROTE, as the route's `added[]` reports them.
 *  `source` is which store held the name — Scholars, then the enterprise
 *  directory for the staff accounts Scholars has no row for. `null` means BOTH
 *  were asked and neither knew the CWID, which is the ONLY case the receipt may
 *  call "not found"; the row is still recorded on purpose. `"unavailable"` means
 *  the directory never answered (down, or past the route's budget), so nothing
 *  is known about this person either way — a state that used to arrive as `null`
 *  and get printed as "not found" about someone the directory does know. */
interface AddedPerson {
  id: string | null;
  cwid: string;
  name: string | null;
  slug: string | null;
  affiliation: string | null;
  source: "scholars" | "directory" | "unavailable" | null;
}

interface CoreClientsDialogProps {
  coreId: string;
  open: boolean;
  /** The core's active roster as the SERVER last rendered it. Read-only here:
   *  writes go to the route and come back through `router.refresh()`. */
  clients: CoreClientRow[];
  onClose: () => void;
}

/** "added by Doug Ballon (djb2001)", falling back to the bare cwid when the actor
 *  has no Scholar row, and to nothing at all when a row was just added in this
 *  session (the POST response carries no actor). */
function addedByLabel(c: CoreClientRow): string | null {
  if (!c.addedBy) return null;
  return c.addedByName
    ? `added by ${c.addedByName} (${c.addedBy})`
    : `added by ${c.addedBy}`;
}

/** "Aug 12, 2026" — the roster's provenance line. */
function formatAdded(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** The receipt's right-hand note: which store named this person, or why none
 *  did. "not found" is a claim about the PERSON, and is reserved for the case
 *  where BOTH stores answered and neither held the CWID. A directory that never
 *  answered has said nothing about them, so it gets its own wording instead —
 *  the row is written either way, and this receipt is the only place a directory
 *  name is ever shown (the roster below resolves names from Scholars alone). */
function sourceNote(source: AddedPerson["source"]): string {
  switch (source) {
    case "scholars":
      return "added from Scholars";
    case "directory":
      return "added from the directory";
    case "unavailable":
      return "added — directory unavailable, name unknown";
    default:
      return "added — not found, recorded anyway";
  }
}

export function CoreClientsDialog({ coreId, open, clients, onClose }: CoreClientsDialogProps) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  // Each band reports its OWN outcome, under its own button. Both used to share
  // one line in the DialogFooter — which sits below the name-only band and the
  // whole roster inside a `max-h-[85vh]` scroller, i.e. the very surface
  // HANDOFF-11 #2 found reviewers never reach. An add that wrote NOTHING (all
  // already listed, or a failed POST) renders no receipt either, so that footer
  // line was the only thing saying so.
  const [addResult, setAddResult] = useState<string | null>(null);
  const [nameResult, setNameResult] = useState<string | null>(null);
  // The last add's receipt: who was actually written. `null` = nothing added in
  // this session yet. Not a preview — every row it holds is already on the
  // roster below, which is why the wording is past tense.
  const [added, setAdded] = useState<AddedPerson[] | null>(null);
  const [name, setName] = useState("");
  const [affiliation, setAffiliation] = useState("");
  const [namePending, setNamePending] = useState(false);
  // Rows this session has asked the server to remove: `"sending"` while the
  // DELETE is in flight, `"done"` once it returned 200. `"done"` is TERMINAL and
  // keeps the button disabled: the roster is the server's list now, so the row
  // only leaves it when the refreshed payload drops it, and a live Remove button
  // on a row that is already gone earns a 404 and a false "Could not remove".
  const [removing, setRemoving] = useState<Map<string, "sending" | "done">>(new Map());
  const [rowErrors, setRowErrors] = useState<Map<string, string>>(new Map());
  const router = useRouter();

  /** Clear EVERY field the dialog owns. The Dialog stays mounted while closed
   *  (it is rendered unconditionally with `open` as a prop), so anything not
   *  reset here survives a close and is still sitting there on the next open —
   *  a half-typed name, or a stale "Could not remove" against a row that is no
   *  longer on the roster.
   *
   *  `removing` is deliberately NOT among them: a row whose DELETE returned 200
   *  is gone server-side whether this dialog is open or shut, and re-enabling
   *  its button on the next open — while a raced payload still lists it — buys
   *  nothing but a second 404. */
  function resetAll() {
    setText("");
    setAdded(null);
    setAddResult(null);
    setNameResult(null);
    setName("");
    setAffiliation("");
    setRowErrors(new Map());
  }

  /** ONE round-trip: a POST with no `mode` resolves the pasted block AND writes
   *  the roster rows in the same request, so there is nothing left to confirm
   *  afterwards. The block is still parsed here first, purely so a paste with no
   *  well-formed CWID in it never becomes a 400. */
  async function submitAdd() {
    const { cwids, invalid } = parseCwidBlock(text);
    if (cwids.length === 0) {
      setAdded(null);
      setAddResult(
        invalid.length > 0
          ? `No valid CWIDs found (ignored: ${invalid.join(", ")}).`
          : "Paste at least one CWID.",
      );
      return;
    }
    setPending(true);
    setAddResult(null);
    const res = await fetch("/api/edit/core-client", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ coreId, cwids }),
    }).catch(() => null);
    setPending(false);
    if (!res?.ok) {
      setAddResult("Could not save — try again.");
      return;
    }
    const data = (await res.json().catch(() => ({}))) as {
      added?: AddedPerson[];
      alreadyPresent?: string[];
      invalid?: string[];
    };
    const addedRows = data.added ?? [];
    const alreadyPresent = data.alreadyPresent ?? [];
    // The route re-parses the block server-side (it never trusts this one), so a
    // malformed token can be reported at either end. Show both.
    const allInvalid = [...invalid, ...(data.invalid ?? [])];
    const parts = [`Added ${addedRows.length}.`];
    if (alreadyPresent.length > 0) parts.push(`Already listed: ${alreadyPresent.join(", ")}.`);
    if (allInvalid.length > 0) parts.push(`Not a CWID: ${allInvalid.join(", ")}.`);
    setAddResult(parts.join(" "));
    setAdded(addedRows);
    setText("");
    // Re-adding a client REVIVES the row it had before (the route upserts on
    // (coreId, cwid) and clears `removedAt`), so it comes back under the very id
    // a remove earlier in this session parked in `removing` — and would come
    // back wearing a dead "Removed" button. Drop exactly what this add wrote.
    if (addedRows.length > 0) {
      setRemoving((m) => {
        const next = new Map(m);
        for (const a of addedRows) if (a.id) next.delete(a.id);
        return next;
      });
    }
    // `alreadyPresent` earns a refresh just as much as `added` does: it is the
    // server saying those CWIDs are on the roster already, and if they are not
    // in `clients` then somebody else put them there (a second tab, a co-owner)
    // and every server-rendered surface on this page is stale. Refreshing only
    // on a write left that reviewer reading "Already listed: jx2001" above a
    // roster with no jx2001 in it. A route that reported neither has told us
    // nothing new about the server, so it earns nothing.
    if (addedRows.length > 0 || alreadyPresent.length > 0) router.refresh();
  }

  async function submitName() {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    setNamePending(true);
    setNameResult(null);
    const res = await fetch("/api/edit/core-client", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        coreId,
        mode: "name",
        displayName: trimmed,
        affiliation: affiliation.trim() || undefined,
      }),
    }).catch(() => null);
    setNamePending(false);
    if (!res?.ok) {
      setNameResult("Could not save — try again.");
      return;
    }
    const data = (await res.json().catch(() => ({}))) as {
      added?: Array<{ id: string; name: string; affiliation: string | null }>;
      alreadyPresent?: string[];
    };
    const added = data.added ?? [];
    if (added.length === 0) {
      setNameResult(`Already on the roster: ${(data.alreadyPresent ?? [trimmed]).join(", ")}.`);
      return;
    }
    setNameResult(`Added ${added[0].name}.`);
    setName("");
    setAffiliation("");
    // The written row reaches the roster the same way every other write does.
    router.refresh();
  }

  async function remove(row: CoreClientRow) {
    setRowErrors((m) => {
      const next = new Map(m);
      next.delete(row.id);
      return next;
    });
    setRemoving((m) => new Map(m).set(row.id, "sending"));
    const res = await fetch("/api/edit/core-client", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      // Always by row id — a name-only row has no cwid to key on.
      body: JSON.stringify({ coreId, id: row.id }),
    }).catch(() => null);
    if (!res?.ok) {
      // Nothing was removed, so the row is live again and must be re-clickable.
      setRemoving((m) => {
        const next = new Map(m);
        next.delete(row.id);
        return next;
      });
      setRowErrors((m) => new Map(m).set(row.id, "Could not remove — try again."));
      return;
    }
    setRemoving((m) => new Map(m).set(row.id, "done"));
    // The receipt is past tense, but "added" stops being true the moment the row
    // comes off the roster — drop the person removed, and only them.
    setAdded((a) => a?.filter((p) => p.cwid !== row.cwid && p.id !== row.id) ?? null);
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          resetAll();
          onClose();
        }
      }}
    >
      {/* p-0 on the shell, padding on each band instead: the header and the
          footer are full-bleed rules, and a uniform p-6 would inset them from
          the dialog edge and break the banding. `gap-0` for the same reason —
          the bands carry their own rhythm. */}
      <DialogContent
        data-slot="core-clients-dialog"
        className="max-h-[85vh] gap-0 overflow-y-auto p-0 sm:max-w-2xl"
      >
        <DialogHeader className="border-apollo-border border-b px-6 py-5">
          <DialogTitle>Known clients of this core</DialogTitle>
          <DialogDescription>
            People you know use this facility, recorded independently of any publication evidence.
            Their names flag matching bylines in the queue.
          </DialogDescription>
        </DialogHeader>

        {/* --- 1. paste + add --- */}
        <div className="border-apollo-border border-b px-6 py-5">
          <label
            htmlFor="core-clients-cwids"
            className="text-foreground mb-2 block text-sm font-medium"
          >
            Paste CWIDs
          </label>
          <textarea
            id="core-clients-cwids"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              // The receipt and status line below describe a paste that no longer
              // exists, and sitting under a fresh one they read as what is about
              // to be added.
              setAdded(null);
              setAddResult(null);
            }}
            placeholder="djb2001, jx2001&#10;ab1234 cd5678"
            rows={3}
            className="border-border-strong text-foreground bg-background focus-visible:ring-apollo-maroon w-full rounded-md border px-3 py-2 font-mono text-sm focus-visible:outline-none focus-visible:ring-2"
          />
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={pending || text.trim().length === 0}
              onClick={submitAdd}
              className="bg-apollo-maroon inline-flex h-9 shrink-0 items-center rounded-md px-3.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {pending ? "Adding…" : "Add clients"}
            </button>
            <p className="text-muted-foreground min-w-0 text-xs">
              Separated by commas, spaces or new lines. Each one is looked up in Scholars, then the
              enterprise directory, and added to the roster straight away; a CWID neither holds is
              still recorded.
            </p>
          </div>

          {/* The outcome of the add, under the button that caused it — including
              every outcome that WROTE NOTHING (all already listed, an
              unparseable paste, a failed POST), which renders no receipt below
              and would otherwise leave a cleared textarea as its only trace. */}
          {addResult ? (
            <p className="text-muted-foreground mt-3 text-xs" role="status">
              {addResult}
            </p>
          ) : null}

          {/* What the add WROTE, not what it would write. A CWID NEITHER store
              holds has no name to print and is recorded anyway — the same
              deliberate behaviour the preview used to announce up front, stated
              here after the fact. An add that wrote nothing renders no list at
              all: the status line above already says why. */}
          {added !== null && added.length > 0 ? (
            <ul className="mt-4 flex flex-col gap-2" data-slot="core-clients-added">
              {added.map((a) => (
                <li key={a.cwid} className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="min-w-0">
                    <span className="text-foreground font-medium">{a.name ?? a.cwid}</span>{" "}
                    <span className="text-muted-foreground font-mono text-xs">{a.cwid}</span>
                    {a.affiliation ? (
                      <span className="text-muted-foreground"> · {a.affiliation}</span>
                    ) : null}
                  </span>
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {sourceNote(a.source)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        {/* --- 2. name-only --- */}
        <div className="border-apollo-border border-b px-6 py-5">
          <p className="text-foreground mb-2 text-sm font-medium">Or add someone without a CWID</p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Full name"
              aria-label="Full name"
              className="border-border-strong text-foreground bg-background focus-visible:ring-apollo-maroon h-9 min-w-0 flex-1 rounded-md border px-3 text-sm focus-visible:outline-none focus-visible:ring-2"
            />
            <input
              type="text"
              value={affiliation}
              onChange={(e) => setAffiliation(e.target.value)}
              placeholder="Affiliation (optional)"
              aria-label="Affiliation (optional)"
              className="border-border-strong text-foreground bg-background focus-visible:ring-apollo-maroon h-9 min-w-0 flex-1 rounded-md border px-3 text-sm focus-visible:outline-none focus-visible:ring-2"
            />
            <button
              type="button"
              disabled={namePending || name.trim().length === 0}
              onClick={submitName}
              className="border-border-strong text-foreground hover:bg-apollo-surface-2 inline-flex h-9 shrink-0 items-center rounded-md border bg-background px-3.5 text-sm disabled:opacity-50"
            >
              {namePending ? "Adding…" : "Add by name"}
            </button>
          </div>
          {nameResult ? (
            <p className="text-muted-foreground mt-3 text-xs" role="status">
              {nameResult}
            </p>
          ) : null}
          <p className="text-muted-foreground mt-2 text-xs">
            A name-only client can&rsquo;t flag a byline automatically; it&rsquo;s recorded for the
            roster.
          </p>
        </div>

        {/* --- 3. the roster --- */}
        <div className="px-6 py-5">
          <p className="text-muted-foreground mb-3 text-[11px] font-medium tracking-[0.09em] uppercase">
            On the roster now
          </p>
          {clients.length === 0 ? (
            <p className="text-muted-foreground text-xs">No known clients yet.</p>
          ) : (
            <ul className="flex flex-col" data-slot="core-clients-roster">
              {clients.map((c) => (
                <li
                  key={c.id}
                  className="border-apollo-border flex items-start justify-between gap-3 border-b py-3 text-sm last:border-b-0"
                >
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-baseline gap-1.5">
                      {c.name ? (
                        c.slug ? (
                          <a
                            href={`/${c.slug}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-foreground font-semibold hover:underline"
                          >
                            {c.name}
                          </a>
                        ) : (
                          <span className="text-foreground font-semibold">{c.name}</span>
                        )
                      ) : (
                        <span className="text-foreground font-mono font-semibold">{c.cwid}</span>
                      )}
                      {c.cwid && c.name ? (
                        <span className="text-muted-foreground font-mono text-xs">{c.cwid}</span>
                      ) : null}
                      {c.cwid === null ? (
                        <span className="text-muted-foreground text-xs italic">
                          name only — no byline match
                        </span>
                      ) : null}
                      {c.cwid && !c.name ? (
                        <span className="text-muted-foreground text-xs italic">
                          — not in Scholars
                        </span>
                      ) : null}
                    </span>
                    <span className="text-muted-foreground mt-0.5 block text-xs">
                      {[c.affiliation, addedByLabel(c), formatAdded(c.addedAt)]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {rowErrors.get(c.id) ? (
                      <span className="text-xs text-red-600" role="alert">
                        {rowErrors.get(c.id)}
                      </span>
                    ) : null}
                    {/* A removed row stays listed until the refreshed payload
                        drops it — so the button says so, rather than sitting
                        there looking like the click did nothing. */}
                    <button
                      type="button"
                      disabled={removing.has(c.id)}
                      onClick={() => remove(c)}
                      className="text-muted-foreground hover:text-foreground text-sm underline-offset-2 hover:underline disabled:opacity-50"
                    >
                      {removing.get(c.id) === "done" ? "Removed" : "Remove"}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <DialogFooter className="border-apollo-border bg-apollo-surface-2 border-t px-6 py-4">
          <button
            type="button"
            onClick={() => {
              resetAll();
              onClose();
            }}
            className="border-border-strong text-foreground hover:bg-apollo-surface inline-flex h-9 items-center rounded-md border bg-background px-3.5 text-sm"
          >
            Close
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
