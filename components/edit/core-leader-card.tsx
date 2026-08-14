/**
 * CoreLeaderCard — the `CoreLeader` list editor (cores-as-org-units P3). A
 * core may be co-led, so leadership is a LIST (`CoreLeader`, 0..N rows), not
 * a single scalar column — same shape as `CenterProgramCard`'s per-program
 * leader list, flattened to one list per core (a core has no program
 * dimension to group by). Every mutation is an immediate POST to
 * `/api/edit/core` (no batched save):
 *   - add a leader (directory pick → `add_leader`),
 *   - remove a leader (`remove_leader`),
 *   - edit a leader's role text (`set_leader` with `role`, committed on blur —
 *     `CoreLeader.role` is an open string, not `CenterProgramLeader.role`'s
 *     closed `leader`/`coe_liaison` vocabulary, so this is a text input, not
 *     a `<select>`),
 *   - toggle a leader's interim flag (`set_leader` with `interim`),
 *   - reorder (`set_leader` on the two swapped `sortOrder`s).
 *
 * Authz is enforced server-side (Owner/Curator/Superuser of the core); this
 * card is only ever rendered for an actor who already passed that gate.
 */
"use client";

import * as React from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";

import {
  DirectoryPeopleTypeahead,
  type DirectoryValue,
} from "@/components/edit/directory-people-typeahead";
import { EditPanel } from "@/components/edit/edit-panel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";

/** `CoreLeader.role`'s schema default. */
const DEFAULT_ROLE = "director";
/** Matches `CoreLeader.role`'s column width (`@db.VarChar(32)`). */
const ROLE_MAX_CHARS = 32;

export type CoreLeaderState = {
  cwid: string;
  name: string | null;
  title: string | null;
  role: string;
  interim: boolean;
  sortOrder: number;
};

export type CoreLeaderCardProps = {
  coreId: string;
  leaders: ReadonlyArray<CoreLeaderState>;
};

function sortLeaders(rows: ReadonlyArray<CoreLeaderState>): CoreLeaderState[] {
  return [...rows].sort((a, b) => a.sortOrder - b.sortOrder || a.cwid.localeCompare(b.cwid));
}

export function CoreLeaderCard({ coreId, leaders }: CoreLeaderCardProps) {
  const [rows, setRows] = React.useState<CoreLeaderState[]>(() => sortLeaders(leaders));
  const [adding, setAdding] = React.useState<DirectoryValue | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // In-flight role text, keyed by cwid — kept local until blur so a free-text
  // field doesn't POST on every keystroke.
  const [roleDrafts, setRoleDrafts] = React.useState<Record<string, string>>({});

  async function post(action: string, payload: Record<string, unknown>): Promise<boolean> {
    setError(null);
    try {
      const res = await fetch("/api/edit/core", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ coreId, action, ...payload }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || data.ok !== true) {
        setError(mapErrorToMessage(data.error ?? ""));
        return false;
      }
      return true;
    } catch {
      setError(mapErrorToMessage(""));
      return false;
    }
  }

  async function addLeader() {
    if (!adding || busy) return;
    if (rows.some((r) => r.cwid === adding.cwid)) {
      setError("That person is already a leader of this core.");
      return;
    }
    setBusy(true);
    const nextSort = rows.length ? Math.max(...rows.map((r) => r.sortOrder)) + 1 : 0;
    const ok = await post("add_leader", {
      cwid: adding.cwid,
      role: DEFAULT_ROLE,
      interim: false,
      sortOrder: nextSort,
    });
    if (ok) {
      setRows((prev) =>
        sortLeaders([
          ...prev,
          {
            cwid: adding.cwid,
            name: adding.name,
            title: adding.title,
            role: DEFAULT_ROLE,
            interim: false,
            sortOrder: nextSort,
          },
        ]),
      );
      setAdding(null);
    }
    setBusy(false);
  }

  async function removeLeader(cwid: string) {
    if (busy) return;
    setBusy(true);
    const ok = await post("remove_leader", { cwid });
    if (ok) setRows((prev) => prev.filter((r) => r.cwid !== cwid));
    setBusy(false);
  }

  async function toggleInterim(cwid: string, interim: boolean) {
    if (busy) return;
    setBusy(true);
    const ok = await post("set_leader", { cwid, interim });
    if (ok) setRows((prev) => prev.map((r) => (r.cwid === cwid ? { ...r, interim } : r)));
    setBusy(false);
  }

  async function commitRole(cwid: string) {
    const draft = roleDrafts[cwid];
    const current = rows.find((r) => r.cwid === cwid);
    if (draft === undefined || !current) return;
    const trimmed = draft.trim();
    setRoleDrafts((prev) => {
      const next = { ...prev };
      delete next[cwid];
      return next;
    });
    if (trimmed === current.role) return; // unchanged — no POST
    if (trimmed.length === 0 || trimmed.length > ROLE_MAX_CHARS) {
      setError(`Role must be 1–${ROLE_MAX_CHARS} characters.`);
      return;
    }
    setBusy(true);
    const ok = await post("set_leader", { cwid, role: trimmed });
    if (ok) setRows((prev) => prev.map((r) => (r.cwid === cwid ? { ...r, role: trimmed } : r)));
    setBusy(false);
  }

  async function move(index: number, dir: -1 | 1) {
    const other = index + dir;
    if (busy || other < 0 || other >= rows.length) return;
    const a = rows[index];
    const b = rows[other];
    setBusy(true);
    // Swap the two rows' sortOrder values (two writes).
    const ok1 = await post("set_leader", { cwid: a.cwid, sortOrder: b.sortOrder });
    const ok2 = ok1 && (await post("set_leader", { cwid: b.cwid, sortOrder: a.sortOrder }));
    if (ok2) {
      setRows((prev) =>
        sortLeaders(
          prev.map((r) =>
            r.cwid === a.cwid
              ? { ...r, sortOrder: b.sortOrder }
              : r.cwid === b.cwid
                ? { ...r, sortOrder: a.sortOrder }
                : r,
          ),
        ),
      );
    }
    setBusy(false);
  }

  return (
    <EditPanel
      slot="core-leader-card"
      headingId="core-leadership-heading"
      heading="Leadership"
      description="The people who lead this core facility. A core may be co-led — add as many as apply."
    >
      <div className="flex flex-col gap-2">
        {rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">No leaders set.</p>
        ) : (
          <ul className="flex flex-col gap-1" data-testid="core-leaders-list">
            {rows.map((r, i) => (
              <li
                key={r.cwid}
                className="bg-apollo-surface-2 flex items-center gap-2 rounded-md px-3 py-2"
                data-testid={`core-leader-${r.cwid}`}
              >
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">{r.name ?? r.cwid}</span>
                  {r.title && (
                    <span className="text-muted-foreground truncate text-xs">{r.title}</span>
                  )}
                </div>
                <label className="flex items-center gap-1.5 text-xs">
                  <span className="sr-only">{`Role for ${r.name ?? r.cwid}`}</span>
                  <Input
                    className="h-8 w-32 text-xs"
                    value={roleDrafts[r.cwid] ?? r.role}
                    disabled={busy}
                    onChange={(e) =>
                      setRoleDrafts((prev) => ({ ...prev, [r.cwid]: e.target.value }))
                    }
                    onBlur={() => commitRole(r.cwid)}
                    aria-label={`Role for ${r.name ?? r.cwid}`}
                    data-testid={`core-leader-role-${r.cwid}`}
                  />
                </label>
                <label className="flex items-center gap-1.5 text-xs">
                  <Checkbox
                    checked={r.interim}
                    disabled={busy}
                    onCheckedChange={(c) => toggleInterim(r.cwid, c === true)}
                    data-testid={`core-leader-interim-${r.cwid}`}
                  />
                  Interim
                </label>
                <div className="flex items-center">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={busy || i === 0}
                    onClick={() => move(i, -1)}
                    aria-label={`Move ${r.name ?? r.cwid} up`}
                    data-testid={`core-leader-up-${r.cwid}`}
                  >
                    <ChevronUp className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={busy || i === rows.length - 1}
                    onClick={() => move(i, 1)}
                    aria-label={`Move ${r.name ?? r.cwid} down`}
                    data-testid={`core-leader-down-${r.cwid}`}
                  >
                    <ChevronDown className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={busy}
                    onClick={() => removeLeader(r.cwid)}
                    aria-label={`Remove ${r.name ?? r.cwid}`}
                    data-testid={`core-leader-remove-${r.cwid}`}
                  >
                    <X className="size-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <DirectoryPeopleTypeahead
              idPrefix="core-leader"
              value={adding}
              placeholder="Add a leader…"
              onChange={(v) => {
                setAdding(v);
                if (error) setError(null);
              }}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={busy || !adding}
            onClick={addLeader}
            data-testid="core-leader-add"
          >
            Add
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </EditPanel>
  );
}

function mapErrorToMessage(code: string): string {
  switch (code) {
    case "not_core_owner":
      return "You no longer have access to this core. Refresh the page and try again.";
    case "invalid_cwid":
      return "That person couldn't be saved. Please try a different selection.";
    case "leader_not_found":
      return "That leader is no longer on this core. Refresh the page and try again.";
    case "invalid_value":
      return "We couldn't save that. Please try again.";
    default:
      return "Something went wrong — your changes weren't saved. Please try again.";
  }
}
