/**
 * The shared hide/show panel for the whole-entity attributes Education /
 * Funding / Mentees — #160 UI follow-up, `self-edit-launch-spec.md` § The
 * shared per-entry row model + § The three new attribute panels. (Positions &
 * appointments left this generic for its own `positions-card.tsx`.)
 *
 * SHOW reuses the `publications-card.tsx` interaction pattern verbatim
 * (`useOptimistic` + `useTransition`, optimistic flip with revert-on-error,
 * inline per-row destructive Alert, filter + scroll for long lists) — but NOT
 * its `state` union: publications keeps its own (`removed_by_admin` ≠
 * `hidden_by_admin`).
 *
 * HIDE is a bulk verb, the same one Positions ships (#2716): a `shown` row
 * carries a checkbox, and any selection raises the shared `SelectionBar` whose
 * "Hide from profile" hides every selected row behind ONE confirm, then POSTs
 * /api/edit/suppress once per row.
 *
 * Control-rendering rule (one predicate, both surfaces): render a **checkbox**
 * iff `state === 'shown'`; render **Show** iff `state === 'hidden_by_self'` OR
 * (`mode === 'superuser'` AND `state === 'hidden_by_admin'`); render nothing
 * actionable for `locked`. A superuser bulk hide takes a required reason, the
 * scholar a bare confirm; a superuser **Show** of a row the *scholar* hid opens
 * an "override their choice" confirm (OQ 3); every other revoke is direct.
 */
"use client";

import * as React from "react";
import { Eye } from "lucide-react";

import { ConfirmDialog } from "@/components/edit/confirm-dialog";
import { EditPanel } from "@/components/edit/edit-panel";
import { LockedBadge } from "@/components/edit/locked-badge";
import { RequestAChangeDialog } from "@/components/edit/request-a-change-dialog";
import { SelectionBar, plural } from "@/components/edit/selection-bar";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { EditEntityState } from "@/lib/api/edit-context";
import type { RequestAttribute } from "@/lib/edit/request-a-change";

type EntityType = "appointment" | "education" | "grant" | "mentee";

/** Map the entity type to its "Request a change" attribute key. */
const REQUEST_ATTR: Record<EntityType, RequestAttribute> = {
  appointment: "appointments",
  education: "education",
  grant: "funding",
  mentee: "mentees",
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
  /** Count noun — `one` / `other` for pluralization ("1 appointment"). `one`
   *  also names the entity in the hide/show dialogs and errors. */
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
  /** Row title — rendered as primary ink + medium weight. */
  getTitle: (e: T) => string;
  /** Row metadata line under the title. */
  renderMeta: (e: T) => React.ReactNode;
  /** Show a title filter + bounded scroll region (Funding). */
  filterable?: boolean;
  /** Singular noun for the selection bar's "Also select the N older …" link —
   *  only meaningful on a date-ordered list ("older entry" on Education /
   *  Funding). Omit it and the link never renders (Mentees is name-ordered). */
  extendNoun?: string;
  /** Override the header "Source: <system>" text for a multi-source panel
   *  (Funding mixes InfoEd + "via NIH RePORTER" rows). */
  sourceLabel?: string;
  /** Per-row "Request a change" attribute, when a row's system of record
   *  differs from the panel's (a RePORTER grant routes differently than an
   *  InfoEd one). Defaults to the panel attribute for every row. */
  getRequestAttribute?: (e: T) => RequestAttribute;
  /** A panel-wide control rendered between the count line and the list
   *  (Education's #1997 graduation-year switch). */
  aboveList?: React.ReactNode;
  /** `data-slot` for tests (e.g. "appointments-panel"). */
  slot: string;
};

/** The visible text of a meta line, so two rows with the same title get
 *  distinguishable checkbox labels (the positions-card scheme: title + meta). */
function nodeText(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (React.isValidElement(node))
    return nodeText((node.props as { children?: React.ReactNode }).children);
  return "";
}

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
  extendNoun,
  sourceLabel,
  getRequestAttribute,
  aboveList,
  slot,
}: EntityPanelProps<T>) {
  const [list, setList] = React.useState<T[]>([...entities]);
  const [, startTransition] = React.useTransition();
  const isSuperuser = mode === "superuser";

  // Only SHOW is optimistic: a bulk hide commits row by row as each POST lands,
  // so there is nothing to revert.
  const applyOptimisticShow = React.useCallback(
    (state: T[], externalId: string): T[] =>
      state.map((e) =>
        e.externalId === externalId ? { ...e, state: "shown", suppressionId: null } : e,
      ),
    [],
  );
  const [optimistic, addOptimisticShow] = React.useOptimistic(list, applyOptimisticShow);
  const [errors, setErrors] = React.useState<Map<string, string>>(new Map());
  const [filter, setFilter] = React.useState("");
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = React.useState(false);
  const [bulkError, setBulkError] = React.useState<string | null>(null);
  const [hideOpen, setHideOpen] = React.useState(false);
  // The superuser override dialog is keyed by externalId — null when closed.
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

  /** One suppress write; commits the row locally on success. No
   *  `router.refresh()`: local optimistic→committed state is authoritative and
   *  this page is force-dynamic; a refresh just re-fetches the whole panel
   *  needlessly (vision-round T3.7). */
  async function hideOne(externalId: string, reason: string | null): Promise<boolean> {
    try {
      const res = await fetch("/api/edit/suppress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityType, entityId: externalId, ...(reason ? { reason } : {}) }),
      });
      const data = (await res.json()) as
        | { ok: true; suppressionId: string }
        | { ok: false; error: string };
      if (!res.ok || data.ok !== true) return false;
      commitLocal(externalId, {
        state: isSuperuser ? "hidden_by_admin" : "hidden_by_self",
        suppressionId: data.suppressionId,
      } as Partial<T>);
      return true;
    } catch {
      return false;
    }
  }

  async function hideSelected(reason: string | null) {
    setBulkError(null);
    setBusy(true);
    try {
      const ids = [...selected];
      const results = await Promise.all(ids.map((id) => hideOne(id, reason)));
      const failed = ids.filter((_, i) => !results[i]);
      setSelected(new Set(failed));
      if (failed.length > 0) {
        setBulkError(
          `We couldn't hide ${failed.length} of the selected ${copy.other}. Please try again.`,
        );
      }
    } finally {
      setBusy(false);
    }
  }

  function show(externalId: string, suppressionId: string | null) {
    if (suppressionId === null) return; // defensive — only hidden rows have a suppressionId
    setError(externalId, null);
    startTransition(async () => {
      addOptimisticShow(externalId);
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
          setError(externalId, `We couldn't restore this ${copy.one}. Please try again.`);
          return; // optimistic reverts when the transition ends
        }
        commitLocal(externalId, { state: "shown", suppressionId: null } as Partial<T>);
      } catch {
        setError(externalId, `We couldn't restore this ${copy.one}. Please try again.`);
      }
    });
  }

  function onShowClick(e: T) {
    // A superuser un-hiding a row the SCHOLAR hid overrides their choice → confirm.
    if (isSuperuser && e.state === "hidden_by_self") {
      setOverrideTarget(e.externalId);
      return;
    }
    show(e.externalId, e.suppressionId);
  }

  function toggle(externalId: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(externalId);
      else next.delete(externalId);
      return next;
    });
  }

  const rows = filtered;
  const targetById = (id: string | null) => (id === null ? null : list.find((e) => e.externalId === id) ?? null);

  // The bar counts the SELECTION, not the visible rows: filtering never drops a
  // selected row from the batch, its checkbox just scrolls out of view with it.
  const selectedCount = selected.size;
  const firstSelected = rows.findIndex((e) => selected.has(e.externalId));
  const older =
    firstSelected < 0
      ? []
      : rows
          .slice(firstSelected + 1)
          .filter((e) => e.state === "shown" && !selected.has(e.externalId));

  const them = selectedCount === 1 ? "it" : "them";
  const hideNote = copy.hideNote ? ` ${copy.hideNote}` : "";

  const listBody = (
    // The lighter divide-y between rows keeps individual entries distinct. The
    // stronger top rule (border-strong) that closes the header block lives on
    // the list *container* (below), so in filterable mode it pins to the top of
    // the scroll viewport instead of scrolling away with the first rows.
    <ul
      className="divide-apollo-border divide-y"
      data-slot={`${slot}-list`}
    >
      {rows.map((e) => (
        <EntityRowView
          key={e.externalId}
          title={getTitle(e)}
          meta={renderMeta(e)}
          state={e.state}
          mode={mode}
          lockedNote={copy.lockedNote}
          error={errors.get(e.externalId) ?? null}
          selected={selected.has(e.externalId)}
          onSelect={(on) => toggle(e.externalId, on)}
          onShow={() => onShowClick(e)}
          testId={`${entityType}-row-${e.externalId}`}
          requestMenu={
            <RequestAChangeDialog
              attribute={getRequestAttribute ? getRequestAttribute(e) : REQUEST_ATTR[entityType]}
              cwid={cwid}
              scholarName={scholarName}
              itemLabel={getTitle(e)}
            />
          }
        />
      ))}
    </ul>
  );

  return (
    <EditPanel
      slot={slot}
      attribute={REQUEST_ATTR[entityType]}
      sourceLabel={sourceLabel}
      heading={copy.heading}
      description={copy.description}
    >
      <LockedBadge />

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

      {aboveList}

      {bulkError && (
        <Alert variant="destructive">
          <AlertDescription>{bulkError}</AlertDescription>
        </Alert>
      )}

      {totalCount === 0 ? (
        <p className="text-muted-foreground text-sm">{copy.empty}</p>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">No matches for &ldquo;{filter}&rdquo;.</p>
      ) : filterable ? (
        // Bounded inner scroll on desktop only; on phones an unbounded height
        // lets the page scroll naturally instead of trapping it (T2.5 / 4.5).
        <ScrollArea className="border-apollo-border-strong border-t md:h-[60vh]">
          {listBody}
        </ScrollArea>
      ) : (
        <div className="border-apollo-border-strong border-t">{listBody}</div>
      )}

      <SelectionBar
        count={selectedCount}
        noun={copy.one}
        extendCount={extendNoun ? older.length : 0}
        extendLabelNoun={extendNoun}
        onExtend={() => setSelected(new Set([...selected, ...older.map((e) => e.externalId)]))}
        onHide={() => setHideOpen(true)}
        onClear={() => setSelected(new Set())}
        busy={busy}
      />

      <ConfirmDialog
        open={hideOpen}
        onOpenChange={(o) => !o && setHideOpen(false)}
        // Both modes confirm before hiding (vision-round T2.6) — self gets a
        // lightweight no-reason confirm, a superuser a required-reason one, and
        // the batch takes ONE of them. Parity: the same verb no longer has
        // three different safety models.
        title={`Hide ${plural(selectedCount, copy.one)}?`}
        description={
          isSuperuser
            ? `This removes ${them} from ${scholarName}'s public profile.${hideNote}`
            : `This hides ${them} from your public profile. Hiding is not a correction — ${
                selectedCount === 1 ? "the record stays" : "the records stay"
              } as-is in WCM systems and on internal reports. You can show ${them} again any time.${hideNote}`
        }
        reasonMode={isSuperuser ? "required-text" : "none"}
        confirmLabel="Hide"
        confirmVariant="destructive"
        onConfirm={async (reason) => {
          setHideOpen(false);
          await hideSelected(reason);
        }}
      />
      <ConfirmDialog
        open={overrideTarget !== null}
        onOpenChange={(o) => !o && setOverrideTarget(null)}
        title={`Show this ${copy.one} again?`}
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
    </EditPanel>
  );
}

function EntityRowView({
  title,
  meta,
  state,
  mode,
  lockedNote,
  error,
  selected,
  onSelect,
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
  selected: boolean;
  onSelect: (on: boolean) => void;
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
  const metaLabel = nodeText(meta).trim();

  return (
    <li className="flex flex-col gap-2 py-4" data-testid={testId}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        {state === "shown" ? (
          <label className="hover:bg-apollo-surface-2 -mt-1 -ml-1.5 flex size-[30px] shrink-0 items-center justify-center rounded-[7px]">
            <Checkbox
              className="border-apollo-border-strong size-[18px] border-2"
              checked={selected}
              onCheckedChange={(c) => onSelect(c === true)}
              aria-label={metaLabel ? `Select ${title}, ${metaLabel}` : `Select ${title}`}
            />
          </label>
        ) : (
          <span className="w-6 shrink-0" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              "text-foreground text-[14px] font-normal",
              isHidden && "text-muted-foreground line-through decoration-muted-foreground",
            )}
          >
            {title}
          </p>
          <div className="text-muted-foreground text-sm">
            {meta}
            {badgeText && (
              <>
                {" · "}
                <Badge
                  variant="outline"
                  className="bg-apollo-slate-tint text-apollo-slate border-apollo-slate-tint-border rounded-full"
                >
                  {badgeText}
                </Badge>
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
          {canShow && (
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground focus-visible:ring-apollo-ring inline-flex min-h-11 cursor-pointer items-center gap-1 rounded-md text-xs transition-colors focus-visible:ring-2 focus-visible:outline-none md:min-h-8"
              onClick={onShow}
              data-testid={`${testId}-show`}
            >
              <Eye className="size-3.5" />
              Show
            </button>
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
