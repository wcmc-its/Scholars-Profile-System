"use client";

import { useEffect, useId, useState } from "react";
import { EyeIcon, SearchIcon } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

/**
 * The "View as" switcher (#637, impersonation-spec.md §8). A panel opened from
 * the account menu (`account-menu.tsx`) — rendered ONLY when the `/api/auth/session`
 * probe reports `canImpersonate` (R1, the real CWID is a superuser), so a
 * non-superuser never even ships this control.
 *
 * Lets a superuser pick whom to view/act as: a debounced search by name or CWID,
 * **unit-kind** filter chips (All · Department · Division · Center · Scholar —
 * the data-scoping axis), and a list of assumable targets from
 * `GET /api/impersonation/candidates`. Each row reads `Name` over
 * `{Owner|Curator} · {unit} ({Dept|Div|Center})` (or `Scholar`), per the real
 * RBAC model (ADR-005 Amendment 1 / #540). Superusers are pre-filtered
 * server-side (R2), so no row here can escalate.
 *
 * **Confirm semantics (§8).** Choosing a user **always** opens a confirm dialog
 * — it states writes are attributed to the real actor (R3), the confused-deputy
 * guard. On confirm, "View as" POSTs `/api/impersonation { targetCwid }` and
 * reloads so the whole app re-renders through the effective seam and the amber
 * banner appears.
 *
 * This is a self-contained panel (its own search/list state) so it can be
 * dropped into the account-menu popover without threading state through it.
 */

type CandidateRole = "owner" | "curator" | "scholar" | "comms_steward";
type UnitKind = "department" | "division" | "center";

/** A row from `/api/impersonation/candidates` (§7). */
type Candidate = {
  cwid: string;
  preferredName: string;
  slug: string | null;
  role: CandidateRole;
  unitKind: UnitKind | null;
  unit: string | null;
};

/** The unit-kind filter chips (§8). `all` clears; `scholar` is the no-grant floor. */
const KIND_FILTERS: ReadonlyArray<{ key: "all" | UnitKind | "scholar"; label: string }> = [
  { key: "all", label: "All" },
  { key: "department", label: "Department" },
  { key: "division", label: "Division" },
  { key: "center", label: "Center" },
  { key: "scholar", label: "Scholar" },
];

const ROLE_LABEL: Record<CandidateRole, string> = {
  owner: "Owner",
  curator: "Curator",
  scholar: "Scholar",
  comms_steward: "Communications Steward",
};

const KIND_SHORT: Record<UnitKind, string> = {
  department: "Dept",
  division: "Div",
  center: "Center",
};

/** `Owner · Cardiology (Dept)` for a unit role; plain `Scholar` or
 *  `Communications Steward` for the unit-less roles. */
function describe(c: Candidate): string {
  if (c.role === "scholar" || c.role === "comms_steward") return ROLE_LABEL[c.role];
  const unit = c.unit ? ` · ${c.unit}` : "";
  const kind = c.unitKind ? ` (${KIND_SHORT[c.unitKind]})` : "";
  return `${ROLE_LABEL[c.role]}${unit}${kind}`;
}

export function ImpersonationSwitcher() {
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | UnitKind | "scholar">("all");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [errored, setErrored] = useState(false);
  // The target awaiting confirmation; null = no dialog open.
  const [pending, setPending] = useState<Candidate | null>(null);
  const [starting, setStarting] = useState(false);

  const searchId = useId();

  // Debounced fetch on query / kind change. The server does the filtering (it
  // also pre-filters superusers for R2); we pass `q` and `kind` through.
  useEffect(() => {
    let active = true;
    setLoading(true);
    setErrored(false);
    const id = window.setTimeout(() => {
      const params = new URLSearchParams();
      if (query.trim()) params.set("q", query.trim());
      if (kindFilter !== "all") params.set("kind", kindFilter);
      const qs = params.toString();
      fetch(`/api/impersonation/candidates${qs ? `?${qs}` : ""}`, {
        cache: "no-store",
        credentials: "same-origin",
      })
        .then((r) => (r.ok ? (r.json() as Promise<Candidate[]>) : Promise.reject(new Error())))
        .then((rows) => {
          if (!active) return;
          setCandidates(Array.isArray(rows) ? rows : []);
        })
        .catch(() => {
          if (!active) return;
          setCandidates([]);
          setErrored(true);
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 200);
    return () => {
      active = false;
      window.clearTimeout(id);
    };
  }, [query, kindFilter]);

  async function startImpersonation(candidate: Candidate) {
    setStarting(true);
    try {
      const res = await fetch("/api/impersonation", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetCwid: candidate.cwid }),
      });
      if (res.ok) {
        // Reload so every surface re-renders through the effective seam and the
        // amber banner mounts.
        window.location.reload();
        return;
      }
    } catch {
      /* fall through to the error state below */
    }
    setStarting(false);
    setPending(null);
    setErrored(true);
  }

  const hasRows = candidates.length > 0;

  return (
    <div data-slot="impersonation-switcher" className="flex w-full flex-col gap-2">
      <p className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        View as
      </p>

      <div className="relative">
        <SearchIcon
          aria-hidden="true"
          className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          id={searchId}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name or CWID"
          aria-label="Search people to view as"
          className="h-8 pl-8 text-sm"
        />
      </div>

      <div role="group" aria-label="Filter by unit" className="flex flex-wrap gap-1">
        {KIND_FILTERS.map((f) => {
          const selected = kindFilter === f.key;
          return (
            <button
              key={f.key}
              type="button"
              aria-pressed={selected}
              onClick={() => setKindFilter(f.key)}
              className={`rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                selected
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              }`}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      <div className="max-h-72 overflow-y-auto" role="list" aria-label="People to view as">
        {loading && !hasRows ? (
          <p className="px-1 py-2 text-xs text-muted-foreground">Searching…</p>
        ) : errored ? (
          <p className="px-1 py-2 text-xs text-destructive">Couldn’t load people. Try again.</p>
        ) : !hasRows ? (
          <p className="px-1 py-2 text-xs text-muted-foreground">No matching people.</p>
        ) : (
          candidates.map((c) => (
            <div
              key={c.cwid}
              role="listitem"
              className="flex items-center gap-2 rounded-sm px-1 py-1.5 hover:bg-accent"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-foreground">{c.preferredName}</p>
                <p className="truncate text-xs text-muted-foreground">{describe(c)}</p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => setPending(c)}
                disabled={starting}
                data-testid="impersonation-view-as"
              >
                <EyeIcon aria-hidden="true" />
                View as
              </Button>
            </div>
          ))
        )}
      </div>

      <Dialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>View as {pending?.preferredName}?</DialogTitle>
            <DialogDescription>
              You will see and act on Scholars exactly as {pending?.preferredName}. Any changes you
              make are applied as them but <strong>logged to you</strong>. Your session auto-returns
              to your own view after the impersonation window expires.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setPending(null)}
              disabled={starting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => pending && startImpersonation(pending)}
              disabled={starting}
              data-testid="impersonation-confirm"
            >
              {starting ? "Starting…" : `View as ${pending?.preferredName ?? "user"}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
