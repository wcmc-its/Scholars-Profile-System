"use client";

/**
 * "Known clients" MODAL — the core owner's roster of people they know use this
 * facility, recorded independently of any publication evidence (ReciterAI #383
 * / SPS #2607, widened here with an ED lookup step and name-only clients).
 *
 * `CoreClaimQueue` owns the open/closed state and the toolbar button; this
 * renders the dialog body as a controlled child, and folds the server's own
 * `added`/removed rows back into the parent's list through `onClientsChange` —
 * no local `clients` state here.
 *
 * Three things happen in here, in the order the reviewer meets them:
 *   1. paste CWIDs -> "Look up CWIDs" resolves them against Scholars, then the
 *      enterprise directory, and shows WHO was found before anything is
 *      written. The lookup is a real server round-trip through the same
 *      authorization gate as the add (`mode: "lookup"`), not a client-side
 *      preview — so what it shows is what the add will do.
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

/** One looked-up person as `mode: "lookup"` reports them. */
interface ResolvedPerson {
  cwid: string;
  name: string | null;
  dept: string | null;
  slug: string | null;
  source: "scholars" | "directory" | null;
  alreadyPresent: boolean;
}

interface CoreClientsDialogProps {
  coreId: string;
  open: boolean;
  clients: CoreClientRow[];
  onClientsChange: (next: CoreClientRow[]) => void;
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

export function CoreClientsDialog({
  coreId,
  open,
  clients,
  onClientsChange,
  onClose,
}: CoreClientsDialogProps) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  // The lookup step's outcome. `null` = not looked up yet; the "Add clients"
  // footer button stays disabled until it holds something addable, so a reviewer
  // cannot commit a paste they have not seen resolved.
  const [resolved, setResolved] = useState<ResolvedPerson[] | null>(null);
  const [lookupPending, setLookupPending] = useState(false);
  const [name, setName] = useState("");
  const [affiliation, setAffiliation] = useState("");
  const [namePending, setNamePending] = useState(false);
  const [removing, setRemoving] = useState<Set<string>>(new Set());
  const [rowErrors, setRowErrors] = useState<Map<string, string>>(new Map());
  const router = useRouter();

  /** Everything the current lookup would actually write. */
  const addable = (resolved ?? []).filter((r) => !r.alreadyPresent);

  /** Clear EVERY field the dialog owns. The Dialog stays mounted while closed
   *  (it is rendered unconditionally with `open` as a prop), so anything not
   *  reset here survives a close and is still sitting there on the next open —
   *  a half-typed name, or a stale "Could not remove" against a row that is no
   *  longer on the roster. */
  function resetAll() {
    setText("");
    setResolved(null);
    setResult(null);
    setName("");
    setAffiliation("");
    setRowErrors(new Map());
  }

  async function lookUp() {
    const { cwids, invalid } = parseCwidBlock(text);
    if (cwids.length === 0) {
      setResolved(null);
      setResult(
        invalid.length > 0
          ? `No valid CWIDs found (ignored: ${invalid.join(", ")}).`
          : "Paste at least one CWID.",
      );
      return;
    }
    setLookupPending(true);
    setResult(null);
    const res = await fetch("/api/edit/core-client", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ coreId, cwids, mode: "lookup" }),
    }).catch(() => null);
    setLookupPending(false);
    if (!res?.ok) {
      setResult("Could not look these up — try again.");
      return;
    }
    const data = (await res.json().catch(() => ({}))) as {
      resolved?: ResolvedPerson[];
      invalid?: string[];
    };
    setResolved(data.resolved ?? []);
    const allInvalid = [...invalid, ...(data.invalid ?? [])];
    setResult(allInvalid.length > 0 ? `Not a CWID: ${allInvalid.join(", ")}.` : null);
  }

  async function submitAdd() {
    if (addable.length === 0) return;
    setPending(true);
    setResult(null);
    const res = await fetch("/api/edit/core-client", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ coreId, cwids: addable.map((r) => r.cwid) }),
    }).catch(() => null);
    setPending(false);
    if (!res?.ok) {
      setResult("Could not save — try again.");
      return;
    }
    const data = (await res.json().catch(() => ({}))) as {
      added?: Array<{
        id: string | null;
        cwid: string;
        name: string | null;
        slug: string | null;
        affiliation: string | null;
      }>;
      alreadyPresent?: string[];
      invalid?: string[];
    };
    const added = data.added ?? [];
    const alreadyPresent = data.alreadyPresent ?? [];
    const invalid = data.invalid ?? [];
    const parts = [`Added ${added.length}.`];
    if (alreadyPresent.length > 0) parts.push(`Already listed: ${alreadyPresent.join(", ")}.`);
    if (invalid.length > 0) parts.push(`Not a CWID: ${invalid.join(", ")}.`);
    setResult(parts.join(" "));
    setText("");
    setResolved(null);
    if (added.length > 0) {
      const existing = new Set(clients.flatMap((c) => (c.cwid ? [c.cwid.toLowerCase()] : [])));
      const newRows: CoreClientRow[] = added
        .filter((a) => !existing.has(a.cwid.toLowerCase()))
        .map((a) => ({
          // The route returns the row id it just wrote; the cwid is the fallback
          // key only if that read raced, and Remove would then 400 rather than
          // silently remove the wrong row.
          id: a.id ?? a.cwid,
          cwid: a.cwid,
          name: a.name,
          slug: a.slug ?? null,
          affiliation: a.affiliation ?? null,
          addedAt: new Date(),
          addedBy: "",
          addedByName: null,
        }));
      onClientsChange([...clients, ...newRows]);
      router.refresh();
    }
  }

  async function submitName() {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    setNamePending(true);
    setResult(null);
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
      setResult("Could not save — try again.");
      return;
    }
    const data = (await res.json().catch(() => ({}))) as {
      added?: Array<{ id: string; name: string; affiliation: string | null }>;
      alreadyPresent?: string[];
    };
    const added = data.added ?? [];
    if (added.length === 0) {
      setResult(`Already on the roster: ${(data.alreadyPresent ?? [trimmed]).join(", ")}.`);
      return;
    }
    setResult(`Added ${added[0].name}.`);
    setName("");
    setAffiliation("");
    onClientsChange([
      ...clients,
      {
        id: added[0].id,
        cwid: null,
        name: added[0].name,
        slug: null,
        affiliation: added[0].affiliation,
        addedAt: new Date(),
        addedBy: "",
        addedByName: null,
      },
    ]);
    router.refresh();
  }

  async function remove(row: CoreClientRow) {
    setRowErrors((m) => {
      const next = new Map(m);
      next.delete(row.id);
      return next;
    });
    setRemoving((s) => new Set(s).add(row.id));
    const res = await fetch("/api/edit/core-client", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      // Always by row id — a name-only row has no cwid to key on.
      body: JSON.stringify({ coreId, id: row.id }),
    }).catch(() => null);
    setRemoving((s) => {
      const next = new Set(s);
      next.delete(row.id);
      return next;
    });
    if (!res?.ok) {
      setRowErrors((m) => new Map(m).set(row.id, "Could not remove — try again."));
      return;
    }
    onClientsChange(clients.filter((c) => c.id !== row.id));
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

        {/* --- 1. paste + look up --- */}
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
              // The old resolution described a paste that no longer exists.
              setResolved(null);
            }}
            placeholder="djb2001, jx2001&#10;ab1234 cd5678"
            rows={3}
            className="border-border-strong text-foreground bg-background focus-visible:ring-apollo-maroon w-full rounded-md border px-3 py-2 font-mono text-sm focus-visible:outline-none focus-visible:ring-2"
          />
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={lookupPending || text.trim().length === 0}
              onClick={lookUp}
              className="bg-apollo-maroon inline-flex h-9 shrink-0 items-center rounded-md px-3.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {lookupPending ? "Looking up…" : "Look up CWIDs"}
            </button>
            <p className="text-muted-foreground min-w-0 text-xs">
              Separated by commas, spaces or new lines. Each one is looked up in Scholars, then the
              enterprise directory.
            </p>
          </div>

          {resolved !== null ? (
            resolved.length === 0 ? (
              <p className="text-muted-foreground mt-4 text-xs">Nothing to look up.</p>
            ) : (
              <ul className="mt-4 flex flex-col gap-2" data-slot="core-clients-resolved">
                {resolved.map((r) => (
                  <li key={r.cwid} className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="min-w-0">
                      <span className="text-foreground font-medium">{r.name ?? r.cwid}</span>{" "}
                      <span className="text-muted-foreground font-mono text-xs">{r.cwid}</span>
                      {r.dept ? (
                        <span className="text-muted-foreground"> · {r.dept}</span>
                      ) : null}
                    </span>
                    <span className="text-muted-foreground shrink-0 text-xs">
                      {r.alreadyPresent
                        ? "already listed"
                        : r.source === "scholars"
                          ? "Scholars"
                          : r.source === "directory"
                            ? "enterprise directory"
                            : "not found — will still be recorded"}
                    </span>
                  </li>
                ))}
              </ul>
            )
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
                    <button
                      type="button"
                      disabled={removing.has(c.id)}
                      onClick={() => remove(c)}
                      className="text-muted-foreground hover:text-foreground text-sm underline-offset-2 hover:underline disabled:opacity-50"
                    >
                      Remove
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <DialogFooter className="border-apollo-border bg-apollo-surface-2 border-t px-6 py-4">
          {result ? (
            <p className="text-muted-foreground mr-auto self-center text-xs" role="status">
              {result}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => {
              resetAll();
              onClose();
            }}
            className="border-border-strong text-foreground hover:bg-apollo-surface inline-flex h-9 items-center rounded-md border bg-background px-3.5 text-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={pending || addable.length === 0}
            onClick={submitAdd}
            className="bg-apollo-maroon inline-flex h-9 items-center rounded-md px-3.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {pending ? "Adding…" : "Add clients"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
