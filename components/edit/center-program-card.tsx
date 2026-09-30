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
 *   - change a person's leadership type (`set_leader` with `role`),
 *   - reorder within a leadership type (`set_leader` on the two swapped `sortOrder`s),
 *   - edit the program description (`set_description`, Save-gated).
 *
 * Leadership type (#1570) is `leader` or `coe_liaison`. The public program page
 * renders leaders first, then a separate "COE Liaison" card, so this list is sorted
 * the same way and reordering is confined to a single type — moving a leader "down"
 * past a liaison would swap `sortOrder` without changing the rendered order.
 *
 * Authz is enforced server-side (Curator/Owner/Superuser of the center); this card
 * is only ever rendered for an actor who already passed that gate.
 *
 * The `ZY` "Non-aligned Clinical" catch-all has no public page (#1105), so it is
 * omitted here — a leader on it would render nowhere.
 */
"use client";

import * as React from "react";
import { Check, ChevronDown, ChevronRight, ChevronUp, HelpCircle, X } from "lucide-react";

import {
  DirectoryPeopleTypeahead,
  type DirectoryValue,
} from "@/components/edit/directory-people-typeahead";
import { EditPanel } from "@/components/edit/edit-panel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { HoverTooltip } from "@/components/ui/hover-tooltip";
import { Textarea } from "@/components/ui/textarea";
import { COE_HELP } from "@/lib/center-program-roles";
import { cn } from "@/lib/utils";

/** Mirrors `PROGRAM_PAGE_EXCLUDED_CODES` in `lib/api/centers.ts` (server-only,
 *  can't be imported into a client component). Programs with no page. */
const EXCLUDED_PROGRAM_CODES = new Set(["ZY"]);

const DESCRIPTION_MAX_CHARS = 4000;

/** #1570 — mirrors `OrgUnitRoleAssignment.roleKey` for the `center_program`
 *  vocabulary. Leaders render before liaisons. */
type LeaderRole = "leader" | "coe_liaison";

const ROLE_OPTIONS: ReadonlyArray<{ value: LeaderRole; label: string }> = [
  { value: "leader", label: "Leader" },
  { value: "coe_liaison", label: "COE Liaison" },
];

/** Rank, not the role string — "coe_liaison" sorts BEFORE "leader" lexically. */
const roleRank = (role: LeaderRole): number => (role === "coe_liaison" ? 1 : 0);

function sortLeaders(rows: ReadonlyArray<LeaderState>): LeaderState[] {
  return [...rows].sort(
    (a, b) =>
      roleRank(a.role) - roleRank(b.role) ||
      a.sortOrder - b.sortOrder ||
      a.cwid.localeCompare(b.cwid),
  );
}

type LeaderState = {
  cwid: string;
  name: string | null;
  title: string | null;
  interim: boolean;
  role: LeaderRole;
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

export function CenterProgramCard({
  centerCode,
  programs,
  headingId = "center-program-heading",
}: CenterProgramCardProps & {
  /** Heading id — the single-scroll editor renders several sections. */
  headingId?: string;
}) {
  const editable = programs.filter((p) => !EXCLUDED_PROGRAM_CODES.has(p.code));

  // Edit Center mockup (2026-09-25): each program is a collapsible row — a
  // summary line ("2 leaders · 1 COE liaison", an amber "No description" chip)
  // that opens onto the full editor. The first program starts open.
  return (
    <EditPanel
      slot="center-program-card"
      headingId={headingId}
      heading="Programs"
      description="Each program’s leaders and description appear on its own public page."
    >
      {editable.length === 0 ? (
        <p className="text-muted-foreground text-sm">This center has no programs with a page.</p>
      ) : (
        <div className="flex flex-col gap-3" data-testid="center-program-list">
          {editable.map((p, i) => (
            <ProgramEditor key={p.code} centerCode={centerCode} program={p} defaultOpen={i === 0} />
          ))}
        </div>
      )}
    </EditPanel>
  );
}

/** "2 leaders · 1 COE liaison" — the collapsed row's summary. */
export function programLeaderSummary(leaders: ReadonlyArray<{ role: LeaderRole }>): string {
  const lead = leaders.filter((l) => l.role === "leader").length;
  const liaison = leaders.length - lead;
  const parts = [`${lead} leader${lead === 1 ? "" : "s"}`];
  if (liaison > 0) parts.push(`${liaison} COE liaison${liaison === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

function ProgramEditor({
  centerCode,
  program,
  defaultOpen = false,
}: {
  centerCode: string;
  program: CenterProgramCardProps["programs"][number];
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  const bodyId = React.useId();
  const [leaders, setLeaders] = React.useState<LeaderState[]>(() => sortLeaders(program.leaders));
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
    // `sortOrder` is scoped to a leadership type, so the new row sorts after the
    // existing rows of ITS type (always "leader" — switch it with the dropdown).
    const peers = leaders.filter((l) => l.role === "leader");
    const nextSort = peers.length ? Math.max(...peers.map((l) => l.sortOrder)) + 1 : 0;
    const ok = await post("add_leader", {
      cwid: adding.cwid,
      interim: false,
      role: "leader",
      sortOrder: nextSort,
    });
    if (ok) {
      setLeaders((prev) =>
        sortLeaders([
          ...prev,
          {
            cwid: adding.cwid,
            name: adding.name,
            title: adding.title,
            interim: false,
            role: "leader",
            sortOrder: nextSort,
          },
        ]),
      );
      setAdding(null);
    }
    setBusy(false);
  }

  async function changeRole(cwid: string, role: LeaderRole) {
    if (busy) return;
    setBusy(true);
    const ok = await post("set_leader", { cwid, role });
    if (ok) {
      setLeaders((prev) => sortLeaders(prev.map((l) => (l.cwid === cwid ? { ...l, role } : l))));
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
    const a = leaders[index];
    const b = leaders[other];
    // Only within one leadership type: the rendered order is (role, sortOrder), so
    // swapping across the boundary would write two rows and change nothing on screen.
    if (a.role !== b.role) return;
    setBusy(true);
    // Swap the two rows' sortOrder values (two writes).
    const ok1 = await post("set_leader", { cwid: a.cwid, sortOrder: b.sortOrder });
    const ok2 = ok1 && (await post("set_leader", { cwid: b.cwid, sortOrder: a.sortOrder }));
    if (ok2) {
      setLeaders((prev) =>
        sortLeaders(
          prev.map((l) =>
            l.cwid === a.cwid
              ? { ...l, sortOrder: b.sortOrder }
              : l.cwid === b.cwid
                ? { ...l, sortOrder: a.sortOrder }
                : l,
          ),
        ),
      );
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
      className="border-apollo-border-strong overflow-hidden rounded-[10px] border"
      data-testid={`program-editor-${program.code}`}
    >
      <h3 className="m-0">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={bodyId}
          className={cn(
            "hover:bg-apollo-page flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-3 text-left",
            open ? "bg-apollo-page" : "bg-apollo-surface",
          )}
          data-testid={`program-toggle-${program.code}`}
        >
          <ChevronRight
            className={cn(
              "text-muted-foreground size-3.5 shrink-0 transition-transform",
              open && "rotate-90",
            )}
            aria-hidden
          />
          <span className="text-[14.5px] font-[550]">{program.label}</span>
          <span className="text-muted-foreground font-mono text-xs">{program.code}</span>
          <span className="text-muted-foreground ml-auto text-[12.5px] font-normal">
            {programLeaderSummary(leaders)}
          </span>
          {descSaved.trim() === "" && (
            <span
              className="bg-apollo-amber-tint text-apollo-amber rounded-full px-2 py-px text-[11.5px] font-normal"
              data-testid={`program-no-description-${program.code}`}
            >
              No description
            </span>
          )}
        </button>
      </h3>

      <div
        id={bodyId}
        hidden={!open}
        className="border-apollo-border flex flex-col gap-4 border-t px-3.5 pt-3 pb-3.5"
      >
      {/* Leaders */}
      <div className="flex flex-col gap-2">
        <span className="flex items-center gap-1 text-sm font-medium">
          Leadership
          {/* #1570 — "COE" isn't self-evident, and a native <option> can't host a
              tooltip, so the definition lives beside the dropdowns. */}
          <HoverTooltip text={COE_HELP} wide>
            <button
              type="button"
              aria-label="What is a COE Liaison?"
              className="text-muted-foreground hover:text-foreground inline-flex size-5 items-center justify-center rounded-full"
              data-testid={`leadership-help-${program.code}`}
            >
              <HelpCircle className="size-4" />
            </button>
          </HoverTooltip>
        </span>
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
                <label className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
                  <span className="sr-only">{`Leadership type for ${l.name ?? l.cwid}`}</span>
                  <select
                    value={l.role}
                    disabled={busy}
                    onChange={(e) => changeRole(l.cwid, e.target.value as LeaderRole)}
                    className="border-apollo-border bg-apollo-surface-2 text-foreground rounded border px-2 py-1 text-xs"
                    aria-label={`Leadership type for ${l.name ?? l.cwid}`}
                    data-testid={`leader-role-${program.code}-${l.cwid}`}
                  >
                    {ROLE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
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
                    disabled={busy || i === 0 || leaders[i - 1].role !== l.role}
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
                    disabled={busy || i === leaders.length - 1 || leaders[i + 1].role !== l.role}
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
      </div>
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
