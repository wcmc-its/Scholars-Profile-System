/**
 * AdministratorsRoster — the read-only Administrators-tab body (#728 Phase B,
 * `ed-admin-org-unit-roles-spec.md` § 4.2). One card per person, each listing
 * the org units they manage (name + kind badge), the role, and the grant
 * provenance (`UnitAdmin.source`). NO write controls — add/edit/revoke is Phase C.
 *
 * Client component: on mount it batch-fetches the Enterprise Directory once via
 * `GET /api/directory/people?cwids=…` to enrich each person with first/last name,
 * primary title, and email — mirroring how `unit-access-card.tsx` hydrates
 * grantee names. LDAP is unreachable in deployed envs until #443, so this fetch
 * is the ONLY directory access and it must never throw: a 503 / network failure
 * just falls back to the server-provided Scholar name + the #443 note.
 */
"use client";

import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { AdminRosterEntry } from "@/lib/api/administrators-roster";
import type { DirectoryPerson } from "@/lib/sources/ldap";

/** The provenance badge color treatment, keyed on `UnitAdmin.source`. The label
 *  is the human-readable string; `className` is the per-source palette. */
function provenanceBadge(source: string): { label: string; className: string } {
  switch (source) {
    case "manual":
      return { label: "Manual", className: "bg-slate-100 text-slate-700 ring-slate-200" };
    case "ED:DA":
      return {
        label: "ED — Department Administrator",
        className: "bg-blue-50 text-blue-700 ring-blue-200",
      };
    case "ED:DivA":
      return {
        label: "ED — Division Administrator",
        className: "bg-teal-50 text-teal-700 ring-teal-200",
      };
    case "ED:IAMDELA":
      return { label: "ED — IAMDELA", className: "bg-amber-50 text-amber-800 ring-amber-200" };
    case "ED:DivA-IAMDELA":
      return {
        label: "ED — DivA-IAMDELA",
        className: "bg-violet-50 text-violet-700 ring-violet-200",
      };
    default:
      // Unknown future source: show it verbatim in a neutral badge rather than
      // swallow it.
      return { label: source, className: "bg-slate-100 text-slate-700 ring-slate-200" };
  }
}

const KIND_LABEL: Record<AdminRosterEntry["grants"][number]["entityType"], string> = {
  department: "Department",
  division: "Division",
  center: "Center",
};

const PROVENANCE_BADGE_BASE =
  "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1";

const ROLE_PILL_BASE = "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium";

export type AdministratorsRosterProps = {
  entries: ReadonlyArray<AdminRosterEntry>;
  /** True ⇒ "Showing all administrators" (superuser); false ⇒ Owner-scoped. */
  isSuperuser: boolean;
  /**
   * Server-side hint that at least one grantee was unresolved by the Scholar
   * lookup. After client-side directory enrichment we RECOMPUTE the note from
   * the resolved state, so this only seeds the initial render before the
   * directory fetch settles.
   */
  nameResolutionDegraded: boolean;
};

/** A person's enriched display fields, in the resolved precedence order. */
type ResolvedPerson = {
  /** Display name; equals the bare CWID when nothing resolved it. */
  name: string;
  title: string | null;
  email: string | null;
  /** True when neither the directory nor the Scholar table supplied a name. */
  isBareCwid: boolean;
};

export function AdministratorsRoster({
  entries,
  isSuperuser,
  nameResolutionDegraded,
}: AdministratorsRosterProps) {
  // Directory rows keyed by CWID; empty until (and unless) the fetch succeeds.
  const [directory, setDirectory] = React.useState<Map<string, DirectoryPerson>>(new Map());
  // null = not yet attempted; true/false = the fetch settled with this outcome.
  // A failed/unreachable fetch (`fetchOk === false`) means we trust the
  // server-provided `nameResolutionDegraded` seed instead of the recomputed one.
  const [fetchOk, setFetchOk] = React.useState<boolean | null>(null);

  const cwidKey = React.useMemo(
    () => [...new Set(entries.map((e) => e.cwid))].join(","),
    [entries],
  );

  React.useEffect(() => {
    if (cwidKey.length === 0) return;
    const controller = new AbortController();
    (async () => {
      const cwids = cwidKey.split(",");
      // The directory API caps each request at 50 CWIDs (route MAX_CWIDS), so a
      // roster of N people must be fetched in chunks and merged.
      const CHUNK = 50;
      const batches: string[][] = [];
      for (let i = 0; i < cwids.length; i += CHUNK) batches.push(cwids.slice(i, i + CHUNK));
      try {
        const perBatch = await Promise.all(
          batches.map(async (batch) => {
            const res = await fetch(
              `/api/directory/people?cwids=${encodeURIComponent(batch.join(","))}`,
              { signal: controller.signal },
            );
            const data = (await res.json()) as
              | { ok: true; people: DirectoryPerson[] }
              | { ok: false };
            if (!res.ok || data.ok !== true) throw new Error("directory_fetch_failed");
            return data.people;
          }),
        );
        const next = new Map<string, DirectoryPerson>();
        for (const people of perBatch) for (const p of people) next.set(p.cwid, p);
        setDirectory(next);
        setFetchOk(true);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        // Degraded: keep the server names; the note falls back to the seed.
        setFetchOk(false);
      }
    })();
    return () => controller.abort();
  }, [cwidKey]);

  function resolve(entry: AdminRosterEntry): ResolvedPerson {
    const dir = directory.get(entry.cwid);
    // Name: directory "First Last" (or directory display name) → server name → CWID.
    const dirName =
      dir &&
      (dir.firstName || dir.lastName
        ? [dir.firstName, dir.lastName].filter(Boolean).join(" ").trim()
        : dir.name && dir.name !== entry.cwid
          ? dir.name
          : null);
    const serverName = entry.name && entry.name !== entry.cwid ? entry.name : null;
    const name = dirName || serverName || entry.cwid;
    // Title: directory → server → nothing.
    const title = dir?.title ?? entry.title ?? null;
    // Email: directory → nothing.
    const email = dir?.email ?? null;
    return { name, title, email, isBareCwid: name === entry.cwid };
  }

  const resolved = entries.map((e) => ({ entry: e, person: resolve(e) }));

  // Recompute the #443 note from the post-enrichment state. If the directory
  // fetch failed entirely, trust the server's seed instead of the (un-enriched)
  // recomputed value so a transient 503 doesn't hide the note prematurely.
  const anyBareCwid = resolved.some((r) => r.person.isBareCwid);
  const showDegradedNote = fetchOk === false ? nameResolutionDegraded : anyBareCwid;

  const scopeCaption = isSuperuser
    ? "Showing all administrators."
    : "Showing administrators within the units you own.";

  return (
    <div className="flex flex-col gap-4" data-slot="administrators-roster">
      <p className="text-muted-foreground text-sm" data-testid="administrators-scope-caption">
        {scopeCaption}
      </p>

      {showDegradedNote && (
        <p className="text-muted-foreground text-sm" data-testid="administrators-name-degraded-note">
          Some names resolve from the Enterprise Directory and are unavailable until directory
          routing (#443) lands; unit scope, role, and provenance below are accurate.
        </p>
      )}

      {entries.length === 0 ? (
        <p className="text-muted-foreground text-sm" data-testid="administrators-empty">
          {isSuperuser ? "No administrators yet." : "No administrators within your units."}
        </p>
      ) : (
        resolved.map(({ entry, person }) => (
          <Card
            key={entry.cwid}
            className="border-l-2 border-apollo-maroon/60"
            data-testid={`administrators-card-${entry.cwid}`}
          >
            <CardHeader>
              <CardTitle className="text-base">
                <span className="font-medium">{person.name}</span>
                {person.title && (
                  <span className="text-muted-foreground font-normal"> · {person.title}</span>
                )}
                <span className="text-muted-foreground ml-2 text-xs font-normal tabular-nums">
                  {entry.cwid}
                </span>
              </CardTitle>
              {person.email && (
                <a
                  href={`mailto:${person.email}`}
                  className="text-muted-foreground text-xs hover:underline"
                  data-testid={`administrators-email-${entry.cwid}`}
                >
                  {person.email}
                </a>
              )}
            </CardHeader>
            <CardContent>
              <table className="w-full text-sm" data-testid={`administrators-grants-${entry.cwid}`}>
                <thead>
                  <tr className="text-muted-foreground border-border border-b text-left">
                    <th className="py-2 font-medium">Org unit</th>
                    <th className="py-2 font-medium">Role</th>
                    <th className="py-2 font-medium">Provenance</th>
                  </tr>
                </thead>
                <tbody>
                  {entry.grants.map((grant) => {
                    const prov = provenanceBadge(grant.source);
                    return (
                      <tr
                        key={`${grant.entityType}:${grant.entityId}`}
                        className="border-border border-b"
                        data-testid={`administrators-grant-${entry.cwid}-${grant.entityType}-${grant.entityId}`}
                      >
                        <td className="py-2">
                          <span className="font-medium">{grant.unitName}</span>
                          <Badge variant="outline" className="ml-2">
                            {KIND_LABEL[grant.entityType]}
                          </Badge>
                        </td>
                        <td className="py-2">
                          <span
                            className={
                              grant.role === "owner"
                                ? `${ROLE_PILL_BASE} bg-apollo-maroon/10 text-apollo-maroon ring-1 ring-apollo-maroon/20`
                                : `${ROLE_PILL_BASE} bg-slate-100 text-slate-600 ring-1 ring-slate-200`
                            }
                          >
                            {grant.role === "owner" ? "Owner" : "Curator"}
                          </span>
                        </td>
                        <td className="py-2">
                          <span className={`${PROVENANCE_BADGE_BASE} ${prov.className}`}>
                            {prov.label}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
