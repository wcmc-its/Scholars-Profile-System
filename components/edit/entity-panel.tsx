/**
 * The shared hide/show panel for the three new whole-entity attributes
 * (Appointments / Education / Funding) — #160 UI follow-up,
 * `self-edit-launch-spec.md` § The shared per-entry row model + § The three
 * new attribute panels.
 *
 * Reuses the `publications-card.tsx` interaction pattern verbatim
 * (`useOptimistic` + `useTransition`, optimistic flip with revert-on-error,
 * inline per-row destructive Alert, `router.refresh()` on commit, filter +
 * scroll for long lists) — but NOT its `state` union: publications keeps its
 * own (`removed_by_admin` ≠ `hidden_by_admin`). The three panels share THIS
 * generic; each supplies its row rendering + copy.
 *
 * Control-rendering rule (one predicate, both surfaces): render **Show** iff
 * `state === 'hidden_by_self'` OR (`mode === 'superuser'` AND
 * `state === 'hidden_by_admin'`); render **Hide** iff `state === 'shown'`;
 * render nothing actionable for `locked`. A superuser **Hide** opens a
 * required-reason dialog; a superuser **Show** of a row the *scholar* hid opens
 * an "override their choice" confirm (OQ 3); every other revoke is direct.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff } from "lucide-react";

import { ConfirmDialog } from "@/components/edit/confirm-dialog";
import { FieldSourceLine } from "@/components/edit/field-source-line";
import { RequestAChangeDialog } from "@/components/edit/request-a-change-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { EditEntityState } from "@/lib/api/edit-context";
import type { RequestAttribute } from "@/lib/edit/request-a-change";

type EntityType = "appointment" | "education" | "grant";

/** Map the entity type to its "Request a change" attribute key. */
const REQUEST_ATTR: Record<EntityType, RequestAttribute> = {
  appointment: "appointments",
  education: "education",
  grant: "funding",
};

/** The minimum shape every entity row carries. */
export type EntityRow = {
  externalId: string;
  state: EditEntityState;
  suppressionId: string | null;
};

export type EntityPanelCopy = {
  heading: string;
  description: string;
  /** Zero-rows-on-file empty state. */
  empty: string;
  /** Count noun — `one` / `other` for pluralization ("1 appointment"). */
  one: string;
  other: string;
  /** Appended to the inline success note after a hide / show (e.g. the
   *  funding-search latency line). Optional. */
  hideNote?: string;
  showNote?: string;
  /** The locked-row explanation (appointments' chair lock). */
  lockedNote?: string;
  /** Placeholder for the filter input when `filterable`. */
  filterPlaceholder?: string;
  filterAriaLabel?: string;
};

export type EntityPanelProps<T extends EntityRow> = {
  cwid: string;
  mode: "self" | "superuser";
  scholarName: string;
  entityType: EntityType;
  entities: ReadonlyArray<T>;
  copy: EntityPanelCopy;
  /** Row title — rendered maroon + semibold. */
  getTitle: (e: T) => string;
  /** Row metadata line under the title. */
  renderMeta: (e: T) => React.ReactNode;
  /** Show a title filter + bounded scroll region (Funding). */
  filterable?: boolean;
  /** `data-slot` for tests (e.g. "appointments-panel"). */
  slot: string;
};

type OptimisticUpdate = { kind: "hide" | "show"; externalId: string };

const HIDE_NOUN: Record<EntityType, string> = {
  appointment: "appointment",
  education: "entry",
  grant: "grant",
};

export function EntityPanel<T extends EntityRow>({
  cwid,
  mode,
  scholarName,
  entityType,
  entities,
  copy,
  getTitle,
  renderMeta,
  filterable = false,
  slot,
}: EntityPanelProps<T>) {
  const router = useRouter();
  const [list, setList] = React.useState<T[]>([...entities]);
  const [, startTransition] = React.useTransition();
  const isSuperuser = mode === "superuser";

  const applyOptimistic = React.useCallback(
    (state: T[], update: OptimisticUpdate): T[] =>
      state.map((e) =>
        e.externalId !== update.externalId
          ? e
          : update.kind === "hide"
            ? { ...e, state: isSuperuser ? "hidden_by_admin" : "hidden_by_self", suppressionId: null }
            : { ...e, state: "shown", suppressionId: null },
      ),
    [isSuperuser],
  );
  const [optimistic, addOptimistic] = React.useOptimistic(list, applyOptimistic);
  const [errors, setErrors] = React.useState<Map<string, string>>(new Map());
  const [filter, setFilter] = React.useState("");
  // The superuser dialogs are keyed by externalId — null when closed.
  const [hideTarget, setHideTarget] = React.useState<string | null>(null);
  const [overrideTarget, setOverrideTarget] = React.useState<string | null>(null);

  const totalCount = list.length;
  const hiddenCount = list.filter((e) => e.state === "hidden_by_self" || e.state === "hidden_by_admin").length;

  const filtered = React.useMemo(() => {
    if (!filterable) return optimistic;
    const q = filter.trim().toLowerCase();
    if (q === "") return optimistic;
    return optimistic.filter((e) => getTitle(e).toLowerCase().includes(q));
  }, [optimistic, filter, filterable, getTitle]);

  function setError(id: string, msg: string | null) {
    setErrors((prev) => {
      const next = new Map(prev);
      if (msg === null) next.delete(id);
      else next.set(id, msg);
      return next;
    });
  }

  function commitLocal(id: string, patch: Partial<T>) {
    setList((prev) => prev.map((e) => (e.externalId === id ? { ...e, ...patch } : e)));
  }

  function hide(externalId: string, reason: string | null) {
    setError(externalId, null);
    startTransition(async () => {
      addOptimistic({ kind: "hide", externalId });
      try {
        const res = await fetch("/api/edit/suppress", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entityType, entityId: externalId, ...(reason ? { reason } : {}) }),
        });
        const data = (await res.json()) as
          | { ok: true; suppressionId: string }
          | { ok: false; error: string };
        if (!res.ok || data.ok !== true) {
          setError(externalId, `We couldn't hide this ${HIDE_NOUN[entityType]}. Please try again.`);
          return; // optimistic reverts when the transition ends
        }
        commitLocal(externalId, {
          state: isSuperuser ? "hidden_by_admin" : "hidden_by_self",
          suppressionId: data.suppressionId,
        } as Partial<T>);
        router.refresh();
      } catch {
        setError(externalId, `We couldn't hide this ${HIDE_NOUN[entityType]}. Please try again.`);
      }
    });
  }

  function show(externalId: string, suppressionId: string | null) {
    if (suppressionId === null) return; // defensive — only hidden rows have a suppressionId
    setError(externalId, null);
    startTransition(async () => {
      addOptimistic({ kind: "show", externalId });
      try {
        const res = await fetch("/api/edit/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ suppressionId }),
        });
        const data = (await res.json()) as
          | { ok: true; suppressionId: string }
          | { ok: false; error: string };
        if (!res.ok || data.ok !== true) {
          setError(externalId, `We couldn't restore this ${HIDE_NOUN[entityType]}. Please try again.`);
          return;
        }
        commitLocal(externalId, { state: "shown", suppressionId: null } as Partial<T>);
        router.refresh();
      } catch {
        setError(externalId, `We couldn't restore this ${HIDE_NOUN[entityType]}. Please try again.`);
      }
    });
  }

  // ---- intent routing (self = direct; superuser = dialog-gated) ------------

  function onHideClick(e: T) {
    if (isSuperuser) setHideTarget(e.externalId);
    else hide(e.externalId, null);
  }
  function onShowClick(e: T) {
    // A superuser un-hiding a row the SCHOLAR hid overrides their choice → confirm.
    if (isSuperuser && e.state === "hidden_by_self") {
      setOverrideTarget(e.externalId);
      return;
    }
    show(e.externalId, e.suppressionId);
  }

  const rows = filtered;
  const targetById = (id: string | null) => (id === null ? null : list.find((e) => e.externalId === id) ?? null);

  const listBody = (
    <ul className="divide-border divide-y" data-slot={`${slot}-list`}>
      {rows.map((e) => (
        <EntityRowView
          key={e.externalId}
          title={getTitle(e)}
          meta={renderMeta(e)}
          state={e.state}
          mode={mode}
          lockedNote={copy.lockedNote}
          error={errors.get(e.externalId) ?? null}
          onHide={() => onHideClick(e)}
          onShow={() => onShowClick(e)}
          testId={`${entityType}-row-${e.externalId}`}
          requestMenu={
            <RequestAChangeDialog
              attribute={REQUEST_ATTR[entityType]}
              cwid={cwid}
              itemLabel={getTitle(e)}
            />
          }
        />
      ))}
    </ul>
  );

  return (
    <section data-slot={slot} className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">{copy.heading}</h2>
        <FieldSourceLine attribute={REQUEST_ATTR[entityType]} />
        <p className="text-muted-foreground text-sm">{copy.description}</p>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm" aria-live="polite">
          <span className="text-foreground font-medium">{totalCount.toLocaleString()}</span>{" "}
          {totalCount === 1 ? copy.one : copy.other}
          {hiddenCount > 0 && (
            <>
              {" · "}
              <span className="text-foreground font-medium">{hiddenCount.toLocaleString()}</span> hidden
            </>
          )}
        </p>
        {filterable && (
          <Input
            type="search"
            aria-label={copy.filterAriaLabel ?? "Filter by title"}
            placeholder={copy.filterPlaceholder ?? "Filter by title…"}
            value={filter}
            onChange={(ev) => setFilter(ev.target.value)}
            className="max-w-xs"
            data-testid={`${slot}-filter`}
          />
        )}
      </div>

      {totalCount === 0 ? (
        <p className="text-muted-foreground text-sm">{copy.empty}</p>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">No matches for &ldquo;{filter}&rdquo;.</p>
      ) : filterable ? (
        <ScrollArea className="border-border h-[60vh] rounded-md border">{listBody}</ScrollArea>
      ) : (
        <div className="border-border rounded-md border">{listBody}</div>
      )}

      <ConfirmDialog
        open={hideTarget !== null}
        onOpenChange={(o) => !o && setHideTarget(null)}
        title={`Hide this ${HIDE_NOUN[entityType]}?`}
        description={`This removes it from ${scholarName}'s public profile.${copy.hideNote ? ` ${copy.hideNote}` : ""}`}
        reasonMode="required-text"
        confirmLabel="Hide"
        confirmVariant="destructive"
        onConfirm={async (reason) => {
          const t = targetById(hideTarget);
          setHideTarget(null);
          if (t) hide(t.externalId, reason);
        }}
      />
      <ConfirmDialog
        open={overrideTarget !== null}
        onOpenChange={(o) => !o && setOverrideTarget(null)}
        title={`Show this ${HIDE_NOUN[entityType]} again?`}
        description={`${scholarName} hid this themselves. Showing it again will override their choice.`}
        reasonMode="none"
        confirmLabel="Show it"
        confirmVariant="default"
        onConfirm={async () => {
          const t = targetById(overrideTarget);
          setOverrideTarget(null);
          if (t) show(t.externalId, t.suppressionId);
        }}
      />
    </section>
  );
}

function EntityRowView({
  title,
  meta,
  state,
  mode,
  lockedNote,
  error,
  onHide,
  onShow,
  testId,
  requestMenu,
}: {
  title: string;
  meta: React.ReactNode;
  state: EditEntityState;
  mode: "self" | "superuser";
  lockedNote?: string;
  error: string | null;
  onHide: () => void;
  onShow: () => void;
  testId: string;
  requestMenu: React.ReactNode;
}) {
  const isSuperuser = mode === "superuser";
  const isHidden = state === "hidden_by_self" || state === "hidden_by_admin";
  // Show iff hidden_by_self, or (superuser AND hidden_by_admin).
  const canShow = state === "hidden_by_self" || (isSuperuser && state === "hidden_by_admin");
  const badgeText =
    state === "hidden_by_admin"
      ? "Hidden by an administrator"
      : state === "hidden_by_self"
        ? isSuperuser
          ? "Hidden by the scholar"
          : "Hidden"
        : null;

  return (
    <li className="flex flex-col gap-2 px-3 py-3" data-testid={testId}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              "text-[var(--apollo-maroon)] font-semibold",
              isHidden && "text-muted-foreground font-normal",
              state === "locked" && "text-foreground",
            )}
          >
            {title}
          </p>
          <div className="text-muted-foreground text-sm">
            {meta}
            {badgeText && (
              <>
                {" · "}
                <Badge variant={state === "hidden_by_admin" ? "destructive" : "secondary"}>{badgeText}</Badge>
              </>
            )}
          </div>
          {state === "locked" && lockedNote && (
            <p className="text-muted-foreground mt-1 text-sm italic">{lockedNote}</p>
          )}
          {state === "hidden_by_admin" && !isSuperuser && (
            <p className="text-muted-foreground mt-1 text-sm">An administrator hid this entry.</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {state === "shown" && (
            <Button type="button" variant="ghost" size="sm" onClick={onHide} data-testid={`${testId}-hide`}>
              <EyeOff />
              Hide
            </Button>
          )}
          {canShow && (
            <Button type="button" variant="ghost" size="sm" onClick={onShow} data-testid={`${testId}-show`}>
              <Eye />
              Show
            </Button>
          )}
          {requestMenu}
        </div>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </li>
  );
}
