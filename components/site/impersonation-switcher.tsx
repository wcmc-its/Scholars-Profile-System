"use client";

import { useEffect, useId, useState } from "react";
import { ClockIcon, EyeIcon, PencilIcon, SearchIcon, XIcon } from "lucide-react";

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
import { mapStartError } from "@/components/edit/view-as-button";

/**
 * The "View as" switcher (#637, impersonation-spec.md §8). A panel opened from
 * the account menu (`account-menu.tsx`) — rendered ONLY when the `/api/auth/session`
 * probe reports `canImpersonate` (R1, the real CWID is a superuser), so a
 * non-superuser never even ships this control.
 *
 * Lets a superuser pick whom to view/act as: a debounced search by name or CWID,
 * a two-way **People · Org unit roles** toggle (everyone, or only org-unit
 * owners/curators — Front page tweaks mockup, 2026-09-30; it was seven
 * unit-kind chips), and a list of assumable targets from
 * `GET /api/impersonation/candidates`. Each row reads `Name` over
 * `cwid · {Owner|Curator} · {unit} ({Dept|Div|Center|Core})` (or `Scholar`), per the
 * real RBAC model (ADR-005 Amendment 1 / #540, widened for cores-as-org-units —
 * a core owner/curator is often non-faculty staff, exactly who "View as" exists
 * to preview). Superusers are pre-filtered server-side (R2), so no row here can
 * escalate.
 *
 * **Confirm semantics (§8).** Choosing a user **always** opens a confirm dialog
 * (`ViewAsConfirmDialog`, below) — it states writes are attributed to the real
 * actor (R3), the confused-deputy guard. The switcher only reports the pick
 * (`onPick`); the account menu closes its popover and owns the dialog, so the
 * picker never sits as a second layer under the dialog's scrim. On confirm,
 * the dialog POSTs `/api/impersonation { targetCwid }` and reloads so the whole
 * app re-renders through the effective seam and the banner appears.
 *
 * **Exact-CWID fallback.** The global roles (`honors_curator`,
 * `data_sharing_viewer`, `development`, `content_editor`,
 * `lib/auth/global-roles.ts`) are valid "View as" targets but never appear in
 * the search results above, which come from our own tables, not ED groups. When a
 * single-token query has zero matches, the empty state offers "View as this
 * exact CWID" — it reuses the same confirm dialog and `startImpersonation`, just
 * with a synthetic candidate built from the typed text instead of a search row;
 * the POST route is the real authority either way and re-validates the target
 * fully regardless of how the CWID was supplied.
 *
 * Search/list state is self-contained, so the panel drops into the account-menu
 * popover with only `onPick` threaded through.
 */

type CandidateRole = "owner" | "curator" | "scholar" | "comms_steward";
type UnitKind = "department" | "division" | "center" | "core" | "institution";

/** A row from `/api/impersonation/candidates` (§7). */
export type Candidate = {
  cwid: string;
  preferredName: string;
  slug: string | null;
  role: CandidateRole;
  unitKind: UnitKind | null;
  unit: string | null;
  /** The exact-CWID fallback's synthetic candidate: its role/unit are unknown. */
  exact?: boolean;
};

/** People = everyone (the route's `all`); Org unit roles = `kind=unit`. */
type Tab = "all" | "unit";
const TABS: ReadonlyArray<{ key: Tab; label: string }> = [
  { key: "all", label: "People" },
  { key: "unit", label: "Org unit roles" },
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
  core: "Core",
  institution: "Institution",
};

/** `Owner · Cardiology (Dept)` for a unit role; plain `Scholar` or
 *  `Communications Steward` for the unit-less roles. */
function describe(c: Candidate): string {
  if (c.role === "scholar" || c.role === "comms_steward") return ROLE_LABEL[c.role];
  const unit = c.unit ? ` · ${c.unit}` : "";
  const kind = c.unitKind ? ` (${KIND_SHORT[c.unitKind]})` : "";
  return `${ROLE_LABEL[c.role]}${unit}${kind}`;
}

/** `cwid · Owner · Cardiology (Dept)` — the CWID lets the pick be checked
 *  against what was typed. The confirm dialog drops the kind (`withKind`
 *  false); the picker rows keep it, the only Dept-vs-Div cue left there. */
function subline(c: Candidate, withKind = true): string {
  if (c.exact) return c.cwid;
  return `${c.cwid} · ${withKind ? describe(c) : describe({ ...c, unitKind: null })}`;
}

/** Client mirror of the server read-time TTL; falls back to 30 min. */
const TTL_MINUTES = Math.round(Number(process.env.NEXT_PUBLIC_IMPERSONATION_TTL_SECONDS ?? 1800) / 60);

export function ImpersonationSwitcher({ onPick }: { onPick: (c: Candidate) => void }) {
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<Tab>("all");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const searchId = useId();
  const hintId = useId();

  // Debounced fetch on query / tab change. The server does the filtering (it
  // also pre-filters superusers for R2); we pass `q` and `kind` through.
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    const id = window.setTimeout(() => {
      const params = new URLSearchParams();
      if (query.trim()) params.set("q", query.trim());
      if (tab !== "all") params.set("kind", tab);
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
          setError("Couldn’t load people. Try again.");
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 200);
    return () => {
      active = false;
      window.clearTimeout(id);
    };
  }, [query, tab]);

  const hasRows = candidates.length > 0;

  // The exact-CWID fallback (see docblock): only offered for a single-token
  // query (a name search has a space; a CWID never does) with no search
  // matches. `role: "scholar"` is a placeholder; `exact` keeps it unrendered.
  const trimmedQuery = query.trim();
  const exactCwidCandidate: Candidate | null =
    !hasRows && trimmedQuery && !trimmedQuery.includes(" ")
      ? { cwid: trimmedQuery, preferredName: trimmedQuery, slug: null, role: "scholar", unitKind: null, unit: null, exact: true }
      : null;

  return (
    <div data-slot="impersonation-switcher" className="flex w-full flex-col gap-2">
      <div>
        <div className="relative">
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          {/* type="text", not "search": the native clear control is a browser-
              blue ×; ours below uses the muted foreground. */}
          <Input
            id={searchId}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or CWID"
            aria-label="Search people to view as"
            aria-describedby={hintId}
            className="h-9 pl-8 pr-8 text-sm"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <XIcon className="size-3.5" aria-hidden="true" />
            </button>
          ) : null}
        </div>
        <p id={hintId} className="mt-1 px-1 text-xs text-muted-foreground">
          Name or CWID
        </p>
      </div>

      <div role="group" aria-label="Show" className="grid grid-cols-2 rounded-md bg-muted p-0.5 text-sm">
        {TABS.map((t) => {
          const selected = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              aria-pressed={selected}
              onClick={() => setTab(t.key)}
              className={`rounded-[5px] px-2 py-1 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                selected
                  ? "bg-background font-medium text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div className="max-h-72 overflow-y-auto" role="list" aria-label="People to view as">
        {loading && !hasRows ? (
          <p className="px-1 py-2 text-xs text-muted-foreground">Searching…</p>
        ) : error ? (
          <p role="alert" className="px-1 py-2 text-xs text-destructive">{error}</p>
        ) : !hasRows ? (
          <div className="px-1 py-2 text-xs text-muted-foreground">
            <p>No matching people.</p>
            {exactCwidCandidate && (
              <button
                type="button"
                onClick={() => onPick(exactCwidCandidate)}
                className="mt-1 text-left font-medium text-primary hover:underline"
                data-testid="impersonation-view-as-exact-cwid"
              >
                View as “{exactCwidCandidate.cwid}” by exact CWID — some roles (CV Generator, Honors
                Curator, Data Sharing Viewer, Development, Content Editor) can’t be searched.
              </button>
            )}
          </div>
        ) : (
          candidates.map((c) => (
            <div
              key={c.cwid}
              role="listitem"
              className="flex items-center gap-2 rounded-sm px-1 py-1.5 hover:bg-accent"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{c.preferredName}</p>
                <p className="truncate text-xs text-muted-foreground">{subline(c)}</p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => onPick(c)}
                data-testid="impersonation-view-as"
              >
                View as
              </Button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * The §8 confirm step, rendered by the account menu outside its (by then
 * closed) popover. `readOnly` = an observer's View as (#2946): writes are
 * refused server-side, so the copy says so instead of promising edits.
 */
export function ViewAsConfirmDialog({
  candidate,
  readOnly = false,
  onClose,
}: {
  candidate: Candidate | null;
  readOnly?: boolean;
  onClose: () => void;
}) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Clear a previous attempt's error when a new target is picked.
  useEffect(() => setError(null), [candidate]);

  async function start(c: Candidate) {
    setStarting(true);
    setError(null);
    // The route's `{ error }` reason (e.g. `target_not_found` on the exact-CWID
    // fallback) — a bare network failure or empty body maps to the generic message.
    let code = "";
    try {
      const res = await fetch("/api/impersonation", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetCwid: c.cwid }),
      });
      if (res.ok) {
        // Reload so every surface re-renders through the effective seam and the
        // banner mounts.
        window.location.reload();
        return;
      }
      code = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? "";
    } catch {
      /* fall through to the error state below */
    }
    setStarting(false);
    setError(mapStartError(code));
  }

  const name = candidate?.preferredName ?? "";
  // A CWID-only synthetic candidate has no first name to use.
  const first = candidate?.exact ? name : name.split(/\s+/)[0];

  return (
    <Dialog open={candidate !== null} onOpenChange={(open) => !open && !starting && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>View as {name}?</DialogTitle>
          {candidate ? <DialogDescription>{subline(candidate, false)}</DialogDescription> : null}
        </DialogHeader>
        <ul className="flex flex-col gap-2.5 text-sm leading-normal">
          <li className="flex gap-2.5">
            <EyeIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            You’ll see Scholars with {first}’s permissions.
          </li>
          <li className="flex gap-2.5">
            <PencilIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {readOnly ? (
              <span>Read-only: you can look, but not save changes.</span>
            ) : (
              <span>
                Edits are saved as {first} and <strong className="font-semibold">logged to you</strong>.
              </span>
            )}
          </li>
          <li className="flex gap-2.5">
            <ClockIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            Ends automatically after {TTL_MINUTES} minutes.
          </li>
        </ul>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={starting}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="apollo"
            onClick={() => candidate && start(candidate)}
            disabled={starting}
            data-testid="impersonation-confirm"
          >
            {starting ? "Starting…" : `Start viewing as ${first}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
