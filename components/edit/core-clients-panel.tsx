"use client";

/**
 * "Known clients" panel BODY — the CWID-only pass of ReciterAI #383 / SPS
 * #2607. `CoreClaimQueue` owns the open/closed state and the toolbar toggle
 * button (mirroring its own "Add PMIDs" pattern); this component renders only
 * the panel content, as a controlled child: paste a block of CWIDs, POST them
 * to `/api/edit/core-client`, and see the result plus the core's current
 * active client list (each with a Remove control that DELETEs it).
 * `onClientsChange` folds the server's own `added`/removed rows back into the
 * parent's list — no local `clients` state here.
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

interface CoreClientsPanelProps {
  coreId: string;
  clients: CoreClientRow[];
  onClientsChange: (next: CoreClientRow[]) => void;
  onClose: () => void;
}

export function CoreClientsPanel({ coreId, clients, onClientsChange, onClose }: CoreClientsPanelProps) {
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
      added?: Array<{ cwid: string; name: string | null; slug: string | null }>;
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
      const existing = new Set(clients.map((c) => c.cwid));
      const newRows: CoreClientRow[] = added
        .filter((a) => !existing.has(a.cwid))
        .map((a) => ({ cwid: a.cwid, name: a.name, slug: a.slug ?? null, addedAt: new Date(), addedBy: "" }));
      onClientsChange([...clients, ...newRows]);
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
    onClientsChange(clients.filter((c) => c.cwid !== cwid));
    router.refresh();
  }

  return (
    <div
      data-slot="core-clients-panel"
      className="border-apollo-border bg-apollo-surface mb-3 rounded-lg border p-3"
    >
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
            setText("");
            setResult(null);
            onClose();
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
  );
}
