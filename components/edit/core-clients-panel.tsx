"use client";

/**
 * "Known clients" panel — the CWID-only pass of ReciterAI #383 / SPS #2607.
 * A toolbar button next to "Add PMIDs" on `/edit/core/[coreId]/review` opens
 * a panel: paste a block of CWIDs, POST them to `/api/edit/core-client`, and
 * see the result plus the core's current active client list (each with a
 * Remove control that DELETEs it). Re-renders from each response — no
 * optimistic local guessing beyond folding the server's own `added` rows in.
 *
 * `parseCwidBlock` below is a DELIBERATE DUPLICATE of the pure function of
 * the same name exported (and unit-tested) from `lib/api/core-clients.ts` —
 * not an import of it. That module also exports `loadCoreClients`, which
 * pulls in `@/lib/db` (the mariadb Prisma adapter) at module scope; importing
 * ANY value from it here would drag that whole module — `db` included — into
 * this client bundle right along with it (a value import can't be
 * tree-shaken away from its module's other top-level imports the way a
 * type-only import can). That is exactly the `lib/edit/manageable-units.ts` /
 * `home-panel.tsx` trap this repo already hit once: keep the pure parser
 * duplicated client-side, the same way `parsePmidBlock` lives directly in
 * `core-claim-queue.tsx` rather than being imported from a server loader.
 * The server route re-parses independently anyway (never trusts the client),
 * so the two copies falling out of sync would only ever under- or over-flag
 * client-side, never corrupt what's written.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Users } from "lucide-react";

import type { CoreClientRow } from "@/lib/api/core-clients";

const CWID_PATTERN = /^[a-z]{2,5}[0-9]{1,6}$/;

function parseCwidBlock(text: string): { cwids: string[]; invalid: string[] } {
  const tokens = text
    .split(/[\s,;]+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  const cwids: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    if (CWID_PATTERN.test(t)) {
      if (!seen.has(t)) {
        seen.add(t);
        cwids.push(t);
      }
    } else {
      invalid.push(t);
    }
  }
  return { cwids, invalid };
}

interface CoreClientsPanelProps {
  coreId: string;
  initial: CoreClientRow[];
}

export function CoreClientsPanel({ coreId, initial }: CoreClientsPanelProps) {
  const [open, setOpen] = useState(false);
  const [clients, setClients] = useState<CoreClientRow[]>(initial);
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Set<string>>(new Set());
  const [rowErrors, setRowErrors] = useState<Map<string, string>>(new Map());
  const router = useRouter();

  async function submitAdd() {
    const { cwids, invalid } = parseCwidBlock(text);
    if (cwids.length === 0) {
      setResult(
        invalid.length > 0 ? `No valid CWIDs found (ignored: ${invalid.join(", ")}).` : "Paste at least one CWID.",
      );
      return;
    }
    setPending(true);
    setResult(null);
    const res = await fetch("/api/edit/core-client", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ coreId, cwids }),
    }).catch(() => null);
    setPending(false);
    if (!res?.ok) {
      setResult("Could not save — try again.");
      return;
    }
    const data = (await res.json().catch(() => ({}))) as {
      added?: Array<{ cwid: string; name: string | null }>;
      alreadyPresent?: string[];
      invalid?: string[];
    };
    const added = data.added ?? [];
    const alreadyPresent = data.alreadyPresent ?? [];
    const allInvalid = [...invalid, ...(data.invalid ?? [])];
    const parts = [`Added ${added.length}.`];
    if (alreadyPresent.length > 0) parts.push(`Already listed: ${alreadyPresent.join(", ")}.`);
    if (allInvalid.length > 0) parts.push(`Not a CWID: ${allInvalid.join(", ")}.`);
    setResult(parts.join(" "));
    setText("");
    if (added.length > 0) {
      setClients((prev) => {
        const existing = new Set(prev.map((c) => c.cwid));
        const newRows: CoreClientRow[] = added
          .filter((a) => !existing.has(a.cwid))
          .map((a) => ({ cwid: a.cwid, name: a.name, slug: null, addedAt: new Date(), addedBy: "" }));
        return [...prev, ...newRows];
      });
      router.refresh();
    }
  }

  async function remove(cwid: string) {
    setRowErrors((m) => {
      const next = new Map(m);
      next.delete(cwid);
      return next;
    });
    setRemoving((s) => new Set(s).add(cwid));
    const res = await fetch("/api/edit/core-client", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ coreId, cwid }),
    }).catch(() => null);
    setRemoving((s) => {
      const next = new Set(s);
      next.delete(cwid);
      return next;
    });
    if (!res?.ok) {
      setRowErrors((m) => new Map(m).set(cwid, "Could not remove — try again."));
      return;
    }
    setClients((prev) => prev.filter((c) => c.cwid !== cwid));
    router.refresh();
  }

  return (
    <div data-slot="core-clients-panel">
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          setResult(null);
        }}
        aria-pressed={open}
        className="border-border-strong text-muted-foreground hover:text-foreground inline-flex h-8 items-center gap-1.5 rounded-full border bg-background px-3 text-sm"
      >
        <Users className="size-4" aria-hidden /> Known clients{" "}
        <span className="tabular-nums opacity-80">{clients.length}</span>
      </button>

      {open ? (
        <div className="border-apollo-border bg-apollo-surface mt-2 rounded-lg border p-3">
          <h3 className="text-foreground mb-1.5 text-sm font-medium">Known clients of this core</h3>
          <p className="text-muted-foreground mb-2 text-xs">
            Paste CWIDs of people who use this core, separated by spaces, commas or new lines. Their
            papers get a curated-client signal in the next inference run.
          </p>
          <label htmlFor="core-clients-cwids" className="text-foreground mb-1.5 block text-sm font-medium">
            CWIDs
          </label>
          <textarea
            id="core-clients-cwids"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="djb2001, jx2001&#10;ab1234"
            rows={3}
            className="border-border-strong text-foreground bg-apollo-surface focus-visible:ring-apollo-maroon w-full rounded-md border px-2.5 py-2 text-sm focus-visible:outline-none focus-visible:ring-2"
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              disabled={pending || text.trim().length === 0}
              onClick={submitAdd}
              className="inline-flex h-8 items-center gap-1.5 rounded-full bg-[var(--color-accent-slate)] px-3 text-sm text-white disabled:opacity-50"
            >
              {pending ? "Adding…" : "Add"}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setText("");
                setResult(null);
              }}
              className="border-border-strong text-muted-foreground hover:text-foreground inline-flex h-8 items-center rounded-full border bg-background px-3 text-sm"
            >
              Cancel
            </button>
          </div>
          {result ? (
            <p className="text-muted-foreground mt-2 text-xs" role="status">
              {result}
            </p>
          ) : null}

          {clients.length === 0 ? (
            <p className="text-muted-foreground mt-3 text-xs">No known clients yet.</p>
          ) : (
            <ul className="mt-3 flex flex-col gap-1.5">
              {clients.map((c) => (
                <li key={c.cwid} className="flex items-center justify-between gap-2 text-sm">
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    {c.name ? (
                      c.slug ? (
                        <a
                          href={`/${c.slug}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-foreground hover:underline"
                        >
                          {c.name}
                        </a>
                      ) : (
                        <span className="text-foreground">{c.name}</span>
                      )
                    ) : (
                      <>
                        <span className="text-foreground font-mono text-[13px]">{c.cwid}</span>
                        <span className="text-muted-foreground text-xs italic">— not in Scholars</span>
                      </>
                    )}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {rowErrors.get(c.cwid) ? (
                      <span className="text-xs text-red-600" role="alert">
                        {rowErrors.get(c.cwid)}
                      </span>
                    ) : null}
                    <button
                      type="button"
                      disabled={removing.has(c.cwid)}
                      onClick={() => remove(c.cwid)}
                      className="border-border-strong text-muted-foreground hover:text-foreground inline-flex h-7 items-center rounded-full border bg-background px-2.5 text-xs disabled:opacity-50"
                    >
                      Remove
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
