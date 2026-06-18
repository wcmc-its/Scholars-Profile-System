/**
 * CenterProgramCard — the per-program leader + description editor (#1117).
 *
 * A center program (the #552 taxonomy) gains a dedicated page (#1105) that renders
 * its leaders + a prose description, but #1105 shipped no edit UI — they were
 * settable only by backfill. This card is that UI, under the `programs` attribute
 * tab of `/edit/center/[code]` (centers with a program taxonomy only).
 *
 * A program may be CO-LED, so each program shows a LIST of leaders. Every mutation
 * is an immediate POST to `/api/edit/center-program` (no batched save):
 *   - add a leader (directory pick → `add_leader`),
 *   - remove a leader (`remove_leader`),
 *   - toggle a leader's interim flag (`set_leader`),
 *   - reorder leaders (`set_leader` on the two swapped `sortOrder`s),
 *   - edit the program description (`set_description`, Save-gated).
 *
 * Authz is enforced server-side (Curator/Owner/Superuser of the center); this card
 * is only ever rendered for an actor who already passed that gate.
 *
 * The `ZY` "Non-aligned Clinical" catch-all has no public page (#1105), so it is
 * omitted here — a leader on it would render nowhere.
 */
"use client";

import * as React from "react";
import { Check, ChevronDown, ChevronUp, X } from "lucide-react";

import {
  DirectoryPeopleTypeahead,
  type DirectoryValue,
} from "@/components/edit/directory-people-typeahead";
import { EditPanel } from "@/components/edit/edit-panel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/** Mirrors `PROGRAM_PAGE_EXCLUDED_CODES` in `lib/api/centers.ts` (server-only,
 *  can't be imported into a client component). Programs with no page. */
const EXCLUDED_PROGRAM_CODES = new Set(["ZY"]);

const DESCRIPTION_MAX_CHARS = 4000;

type LeaderState = {
  cwid: string;
  name: string | null;
  title: string | null;
  interim: boolean;
  sortOrder: number;
};

export type CenterProgramCardProps = {
  centerCode: string;
  programs: ReadonlyArray<{
    code: string;
    label: string;
    sortOrder: number;
    description: string | null;
    leaders: ReadonlyArray<LeaderState>;
  }>;
};

export function CenterProgramCard({ centerCode, programs }: CenterProgramCardProps) {
  const editable = programs.filter((p) => !EXCLUDED_PROGRAM_CODES.has(p.code));

  return (
    <EditPanel
      slot="center-program-card"
      heading="Programs"
      description="Set each program's leaders and description. These appear on the program's public page."
    >
      {editable.length === 0 ? (
        <p className="text-muted-foreground text-sm">This center has no programs with a page.</p>
      ) : (
        <div className="flex flex-col gap-6" data-testid="center-program-list">
          {editable.map((p) => (
            <ProgramEditor key={p.code} centerCode={centerCode} program={p} />
          ))}
        </div>
      )}
    </EditPanel>
  );
}

function ProgramEditor({
  centerCode,
  program,
}: {
  centerCode: string;
  program: CenterProgramCardProps["programs"][number];
}) {
  const [leaders, setLeaders] = React.useState<LeaderState[]>(() =>
    [...program.leaders].sort((a, b) => a.sortOrder - b.sortOrder || a.cwid.localeCompare(b.cwid)),
  );
  const [adding, setAdding] = React.useState<DirectoryValue | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const descInitial = program.description ?? "";
  const [desc, setDesc] = React.useState(descInitial);
  const [descSaved, setDescSaved] = React.useState(descInitial);
  const [descSavedFlag, setDescSavedFlag] = React.useState(false);
  const descDirty = desc !== descSaved;
  const descOverLimit = desc.length > DESCRIPTION_MAX_CHARS;

  async function post(
    action: string,
    payload: Record<string, unknown>,
  ): Promise<boolean> {
    setError(null);
    try {
      const res = await fetch("/api/edit/center-program", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ centerCode, programCode: program.code, action, ...payload }),
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
    if (leaders.some((l) => l.cwid === adding.cwid)) {
      setError("That person is already a leader of this program.");
      return;
    }
    setBusy(true);
    const nextSort = leaders.length ? Math.max(...leaders.map((l) => l.sortOrder)) + 1 : 0;
    const ok = await post("add_leader", { cwid: adding.cwid, interim: false, sortOrder: nextSort });
    if (ok) {
      setLeaders((prev) => [
        ...prev,
        {
          cwid: adding.cwid,
          name: adding.name,
          title: adding.title,
          interim: false,
          sortOrder: nextSort,
        },
      ]);
      setAdding(null);
    }
    setBusy(false);
  }

  async function removeLeader(cwid: string) {
    if (busy) return;
    setBusy(true);
    const ok = await post("remove_leader", { cwid });
    if (ok) setLeaders((prev) => prev.filter((l) => l.cwid !== cwid));
    setBusy(false);
  }

  async function toggleInterim(cwid: string, interim: boolean) {
    if (busy) return;
    setBusy(true);
    const ok = await post("set_leader", { cwid, interim });
    if (ok) setLeaders((prev) => prev.map((l) => (l.cwid === cwid ? { ...l, interim } : l)));
    setBusy(false);
  }

  async function move(index: number, dir: -1 | 1) {
    const other = index + dir;
    if (busy || other < 0 || other >= leaders.length) return;
    setBusy(true);
    const a = leaders[index];
    const b = leaders[other];
    // Swap the two rows' sortOrder values (two writes).
    const ok1 = await post("set_leader", { cwid: a.cwid, sortOrder: b.sortOrder });
    const ok2 = ok1 && (await post("set_leader", { cwid: b.cwid, sortOrder: a.sortOrder }));
    if (ok2) {
      setLeaders((prev) => {
        const next = prev.map((l) =>
          l.cwid === a.cwid
            ? { ...l, sortOrder: b.sortOrder }
            : l.cwid === b.cwid
              ? { ...l, sortOrder: a.sortOrder }
              : l,
        );
        return next.sort((x, y) => x.sortOrder - y.sortOrder || x.cwid.localeCompare(y.cwid));
      });
    }
    setBusy(false);
  }

  async function saveDescription() {
    if (!descDirty || descOverLimit || busy) return;
    setBusy(true);
    const ok = await post("set_description", { description: desc });
    if (ok) {
      setDescSaved(desc);
      setDescSavedFlag(true);
    }
    setBusy(false);
  }

  return (
    <section
      className="border-apollo-border flex flex-col gap-4 rounded-md border p-4"
      data-testid={`program-editor-${program.code}`}
    >
      <div className="flex items-baseline gap-2">
        <h3 className="text-base font-medium">{program.label}</h3>
        <span className="text-muted-foreground text-xs">{program.code}</span>
      </div>

      {/* Leaders */}
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">{leaders.length === 1 ? "Leader" : "Leaders"}</span>
        {leaders.length === 0 ? (
          <p className="text-muted-foreground text-sm">No leaders set.</p>
        ) : (
          <ul className="flex flex-col gap-1" data-testid={`leaders-${program.code}`}>
            {leaders.map((l, i) => (
              <li
                key={l.cwid}
                className="bg-apollo-surface-2 flex items-center gap-2 rounded-md px-3 py-2"
                data-testid={`leader-${program.code}-${l.cwid}`}
              >
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">{l.name ?? l.cwid}</span>
                  {l.title && (
                    <span className="text-muted-foreground truncate text-xs">{l.title}</span>
                  )}
                </div>
                <label className="flex items-center gap-1.5 text-xs">
                  <Checkbox
                    checked={l.interim}
                    disabled={busy}
                    onCheckedChange={(c) => toggleInterim(l.cwid, c === true)}
                    data-testid={`leader-interim-${program.code}-${l.cwid}`}
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
                    aria-label={`Move ${l.name ?? l.cwid} up`}
                    data-testid={`leader-up-${program.code}-${l.cwid}`}
                  >
                    <ChevronUp className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={busy || i === leaders.length - 1}
                    onClick={() => move(i, 1)}
                    aria-label={`Move ${l.name ?? l.cwid} down`}
                    data-testid={`leader-down-${program.code}-${l.cwid}`}
                  >
                    <ChevronDown className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={busy}
                    onClick={() => removeLeader(l.cwid)}
                    aria-label={`Remove ${l.name ?? l.cwid}`}
                    data-testid={`leader-remove-${program.code}-${l.cwid}`}
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
              idPrefix={`program-leader-${program.code}`}
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
            data-testid={`leader-add-${program.code}`}
          >
            Add
          </Button>
        </div>
      </div>

      {/* Description */}
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Description</span>
        <Textarea
          aria-label={`${program.label} description`}
          value={desc}
          rows={4}
          onChange={(e) => {
            setDesc(e.target.value);
            if (descSavedFlag) setDescSavedFlag(false);
            if (error) setError(null);
          }}
          data-testid={`program-description-${program.code}`}
        />
        <div className="flex items-center justify-between gap-3">
          <span
            aria-live="polite"
            className={cn(
              "text-xs tabular-nums",
              descOverLimit ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {desc.length.toLocaleString()}/{DESCRIPTION_MAX_CHARS.toLocaleString()}
          </span>
          <div className="flex items-center gap-3">
            {descSavedFlag && (
              <span
                role="status"
                aria-live="polite"
                className="text-apollo-green inline-flex items-center gap-1 text-sm"
              >
                <Check className="size-4" />
                Saved
              </span>
            )}
            <Button
              type="button"
              variant="apollo"
              disabled={!descDirty || descOverLimit || busy}
              onClick={saveDescription}
              data-testid={`program-description-save-${program.code}`}
            >
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </section>
  );
}

function mapErrorToMessage(code: string): string {
  switch (code) {
    case "not_curator":
    case "not_superuser":
    case "not_unit_owner":
      return "You no longer have access to this center. Refresh the page and try again.";
    case "invalid_cwid":
      return "That person couldn't be saved. Please try a different selection.";
    case "leader_not_found":
      return "That leader is no longer on this program. Refresh the page and try again.";
    case "description_too_long":
    case "invalid_value":
      return "We couldn't save that. Trim unusual formatting and try again.";
    default:
      return "Something went wrong — your changes weren't saved. Please try again.";
  }
}
