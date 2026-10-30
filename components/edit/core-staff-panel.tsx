"use client";

/**
 * The editable body of the Staff section on `/edit/core/[coreId]`: find staff
 * by name in the WCM directory (or paste CWIDs in bulk) to add them, remove
 * them one by one. The twin of the "Known clients" dialog
 * (`core-clients-panel.tsx`): the same paste-CWIDs picker and the same
 * one-source-of-truth rule. The list it shows is the `staff` PROP, and every
 * write ends in `router.refresh()`, which re-renders the server page with a
 * fresh list (names resolved Scholar-then-ED by `loadCoreStaff`).
 *
 * Imports only the `CoreStaffRow` TYPE from `@/lib/api/core-staff` (which
 * imports `@/lib/db`); the parser comes from the pure `@/lib/cores/cwid-block`.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";

import {
  DirectoryPeopleTypeahead,
  type DirectoryValue,
} from "@/components/edit/directory-people-typeahead";
import type { CoreStaffRow } from "@/lib/api/core-staff";
import { parseCwidBlock } from "@/lib/cores/cwid-block";
import { stripUnitDisambiguation } from "@/lib/name-sort";

interface CoreStaffPanelProps {
  coreId: string;
  /** The core's curated staff as the server last rendered them. */
  staff: CoreStaffRow[];
}

function addedByLabel(s: CoreStaffRow): string | null {
  if (!s.addedBy) return null;
  return s.addedByName
    ? `added by ${stripUnitDisambiguation(s.addedByName)} (${s.addedBy})`
    : `added by ${s.addedBy}`;
}

function formatAdded(d: Date): string {
  return new Date(d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function CoreStaffPanel({ coreId, staff }: CoreStaffPanelProps) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [addResult, setAddResult] = useState<string | null>(null);
  // `"done"` is terminal: the row leaves the list only when the refreshed
  // payload drops it, and a live Remove on a gone row would earn a 404.
  const [removing, setRemoving] = useState<Map<string, "sending" | "done">>(new Map());
  const [rowErrors, setRowErrors] = useState<Map<string, string>>(new Map());
  const router = useRouter();

  async function submitAdd() {
    const { cwids, invalid } = parseCwidBlock(text);
    if (cwids.length === 0) {
      setAddResult(
        invalid.length > 0
          ? `No valid CWIDs found (ignored: ${invalid.join(", ")}).`
          : "Paste at least one CWID.",
      );
      return;
    }
    if (await postCwids(cwids, invalid)) setText("");
  }

  /** A directory pick adds that one person through the same route as a paste.
   *  Not scholars-only: core staff often have no Scholar profile. */
  async function pickPerson(v: DirectoryValue | null) {
    if (!v) return;
    await postCwids([v.cwid], []);
  }

  /** POSTs to `/api/edit/core-staff` and reports the outcome; true on success. */
  async function postCwids(cwids: string[], invalid: string[]): Promise<boolean> {
    setPending(true);
    setAddResult(null);
    const res = await fetch("/api/edit/core-staff", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ coreId, cwids }),
    }).catch(() => null);
    setPending(false);
    if (!res?.ok) {
      setAddResult("Could not save — try again.");
      return false;
    }
    const data = (await res.json().catch(() => ({}))) as {
      added?: string[];
      alreadyPresent?: string[];
      invalid?: string[];
    };
    const added = data.added ?? [];
    const alreadyPresent = data.alreadyPresent ?? [];
    const allInvalid = [...invalid, ...(data.invalid ?? [])];
    const parts = [`Added ${added.length}.`];
    if (alreadyPresent.length > 0) parts.push(`Already listed: ${alreadyPresent.join(", ")}.`);
    if (allInvalid.length > 0) parts.push(`Not a CWID: ${allInvalid.join(", ")}.`);
    setAddResult(parts.join(" "));
    // A re-added CWID comes back under the same key a remove parked in
    // `removing`; drop it so its Remove button is live again.
    if (added.length > 0) {
      setRemoving((m) => {
        const next = new Map(m);
        for (const c of added) next.delete(c);
        return next;
      });
    }
    if (added.length > 0 || alreadyPresent.length > 0) router.refresh();
    return true;
  }

  async function remove(row: CoreStaffRow) {
    setRowErrors((m) => {
      const next = new Map(m);
      next.delete(row.cwid);
      return next;
    });
    setRemoving((m) => new Map(m).set(row.cwid, "sending"));
    const res = await fetch("/api/edit/core-staff", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ coreId, cwid: row.cwid }),
    }).catch(() => null);
    if (!res?.ok) {
      setRemoving((m) => {
        const next = new Map(m);
        next.delete(row.cwid);
        return next;
      });
      setRowErrors((m) => new Map(m).set(row.cwid, "Could not remove — try again."));
      return;
    }
    setRemoving((m) => new Map(m).set(row.cwid, "done"));
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4" data-slot="core-staff-panel">
      <div>
        <p className="text-foreground mb-2 block text-sm font-medium">
          Add staff by name
        </p>
        <div>
          <DirectoryPeopleTypeahead
            value={null}
            onChange={(v) => void pickPerson(v)}
            placeholder="Search the WCM directory…"
            disabled={pending}
            idPrefix="core-staff-person"
          />
        </div>
      </div>
      <div>
        <label
          htmlFor="core-staff-cwids"
          className="text-foreground mb-2 block text-sm font-medium"
        >
          Or paste CWIDs
        </label>
        <textarea
          id="core-staff-cwids"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setAddResult(null);
          }}
          placeholder="abc1234, xyz5678"
          rows={2}
          className="border-border-strong text-foreground bg-background focus-visible:ring-apollo-maroon w-full rounded-md border px-3 py-2 font-mono text-sm focus-visible:ring-2 focus-visible:outline-none"
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={pending || text.trim().length === 0}
            onClick={submitAdd}
            className="bg-apollo-maroon inline-flex h-9 shrink-0 items-center rounded-md px-3.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {pending ? "Adding…" : "Add staff"}
          </button>
          <p className="text-muted-foreground min-w-0 text-xs">
            Separated by commas, spaces or new lines.
          </p>
        </div>
        {addResult ? (
          <p className="text-muted-foreground mt-3 text-xs" role="status">
            {addResult}
          </p>
        ) : null}
      </div>

      {staff.length === 0 ? (
        <p className="text-muted-foreground text-xs" data-testid="core-staff-empty">
          No staff added yet.
        </p>
      ) : (
        <ul className="flex flex-col" data-slot="core-staff-roster">
          {staff.map((s) => (
            <li
              key={s.cwid}
              className="border-apollo-border flex items-start justify-between gap-3 border-b py-3 text-sm last:border-b-0"
            >
              <span className="min-w-0">
                <span className="flex flex-wrap items-baseline gap-1.5">
                  {s.name ? (
                    s.slug ? (
                      <a
                        href={`/${s.slug}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-foreground font-semibold hover:underline"
                      >
                        {stripUnitDisambiguation(s.name)}
                      </a>
                    ) : (
                      <span className="text-foreground font-semibold">{s.name}</span>
                    )
                  ) : (
                    <span className="text-foreground font-mono font-semibold">{s.cwid}</span>
                  )}
                  {s.name ? (
                    <span className="text-muted-foreground font-mono text-xs">{s.cwid}</span>
                  ) : (
                    <span className="text-muted-foreground text-xs italic">— name not found</span>
                  )}
                </span>
                <span className="text-muted-foreground mt-0.5 block text-xs">
                  {[s.affiliation, addedByLabel(s), formatAdded(s.addedAt)]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                {rowErrors.get(s.cwid) ? (
                  <span className="text-xs text-red-600" role="alert">
                    {rowErrors.get(s.cwid)}
                  </span>
                ) : null}
                <button
                  type="button"
                  disabled={removing.has(s.cwid)}
                  onClick={() => remove(s)}
                  aria-label={`Remove ${s.name ?? s.cwid}`}
                  className="text-muted-foreground hover:text-foreground text-sm underline-offset-2 hover:underline disabled:opacity-50"
                >
                  {removing.get(s.cwid) === "done" ? "Removed" : "Remove"}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
