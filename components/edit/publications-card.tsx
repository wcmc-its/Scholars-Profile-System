/**
 * The My publications card (#356 Phase 6 C7, UI-SPEC § `/edit` Card 3).
 *
 * The filterable, year-grouped list of the scholar's confirmed authorships.
 *
 * HIDE is a bulk verb, the same one Positions and the Education / Funding /
 * Mentees panels ship: a `shown` row carries a checkbox, any selection raises
 * the shared `SelectionBar`, and "Hide from profile" POSTs /api/edit/suppress
 * once per selected pmid, committing each row as its write lands. Both guards
 * survive the move off the per-row button and now fire ONCE for the whole
 * batch: the first-hide-of-a-session notice (#570), then the
 * sole-displayed-author confirm (UI-SPEC edge case 11).
 *
 * SHOW stays per-row and optimistic (D6.4): `useOptimistic` over a local-state
 * list that commits on a successful POST; on a network/server failure the
 * optimistic state reverts when the transition ends and an inline destructive
 * Alert renders above the row. An admin-removed publication renders an inline
 * explanation and no control (UI-SPEC accessibility — a disabled button would
 * not be keyboard-reachable for its tooltip).
 */
"use client";

import * as React from "react";
import { Eye } from "lucide-react";

import { ConfirmDialog } from "@/components/edit/confirm-dialog";
import { EditPanel } from "@/components/edit/edit-panel";
import { FirstHideNoticeDialog } from "@/components/edit/first-hide-notice-dialog";
import { ReciterPendingCardClient } from "@/components/edit/reciter-pending-card";
import { RejectNoticeDialog } from "@/components/edit/reject-notice-dialog";
import { RequestAChangeDialog } from "@/components/edit/request-a-change-dialog";
import { SelectionBar, plural } from "@/components/edit/selection-bar";
import { PubJournal, PubTitle } from "@/components/publication/pub-html";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { PUBLICATION_MANAGER_URL } from "@/lib/edit/request-a-change";
import { cn, htmlToPlainText } from "@/lib/utils";
import type { EditContextPublication } from "@/lib/api/edit-context";

export type PublicationsCardProps = {
  cwid: string;
  /** `superuser` reframes the first-person copy to the scholar's name — a
   *  superuser managing another scholar's publications on their behalf. The
   *  write paths already authorize a superuser (suppress / revoke / reject). */
  mode?: "self" | "superuser";
  scholarName?: string;
  publications: ReadonlyArray<EditContextPublication>;
  /**
   * Whether the in-app "Not mine" reject is enabled (`RECITER_REJECT_SEND`,
   * #746). Off (default) ⇒ "Not mine?" keeps the Publication-Manager off-ramp.
   * On ⇒ it opens the soft-warning interstitial that commits a reject + ReCiter
   * gold-standard write.
   */
  rejectEnabled?: boolean;
  /**
   * Whether to mount the live ReCiter pending-articles nudge at the top of the
   * card (`SELF_EDIT_RECITER_PENDING_HINT`). Only the genuine, non-impersonating
   * self page passes `true`, and only when the flag is on; when `true` the client
   * loader lazily fetches `/api/edit/reciter-pending` and renders nothing until
   * (and unless) the engine returns suggestions. Off (default) ⇒ ZERO fetch.
   */
  reciterPendingEnabled?: boolean;
};

/**
 * sessionStorage key for the first-hide-of-a-session notice (#570). Set when the
 * scholar makes an *informed choice* on the notice — "Hide it" or "It's not
 * mine" — but NOT on Cancel/Esc: a scholar who backs out before deciding is
 * re-educated on the next hide (harmless, and the safer direction). Exported
 * for deterministic test setup.
 */
export const FIRST_HIDE_NOTICE_ACK_KEY = "sps.edit.first-hide-notice-ack";

/** Has the scholar already seen the first-hide notice this session? */
function hasAcknowledgedFirstHide(): boolean {
  try {
    return window.sessionStorage.getItem(FIRST_HIDE_NOTICE_ACK_KEY) === "1";
  } catch {
    // sessionStorage unavailable (private mode quota, disabled storage) —
    // degrade to always-show; the notice is informational, never blocking.
    return false;
  }
}

/** Record that the notice has been shown this session. */
function acknowledgeFirstHide(): void {
  try {
    window.sessionStorage.setItem(FIRST_HIDE_NOTICE_ACK_KEY, "1");
  } catch {
    // No-op — see hasAcknowledgedFirstHide.
  }
}

type Pub = EditContextPublication;

/** Only SHOW is optimistic: a bulk hide commits row by row as each POST lands,
 *  so there is nothing to revert. */
function applyOptimisticShow(state: Pub[], pmid: string): Pub[] {
  return state.map((p) => (p.pmid === pmid ? { ...p, state: "shown", suppressionId: null } : p));
}

export function PublicationsCard({
  cwid,
  mode = "self",
  scholarName = "",
  publications,
  rejectEnabled = false,
  reciterPendingEnabled = false,
}: PublicationsCardProps) {
  // Copy reframes for a superuser acting on the scholar's behalf (mirrors the
  // Mentees / Highlights cards): "yourself" → "{Name}", "your profile" →
  // "{Name}'s profile". `possessive` is mid-sentence.
  const su = mode === "superuser";
  const possessive = su ? `${scholarName}’s` : "your";
  const [list, setList] = React.useState<Pub[]>([...publications]);
  const [, startTransition] = React.useTransition();
  const [optimistic, addOptimisticShow] = React.useOptimistic(list, applyOptimisticShow);
  const [errors, setErrors] = React.useState<Map<string, string>>(new Map());
  const [filter, setFilter] = React.useState("");
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = React.useState(false);
  const [bulkError, setBulkError] = React.useState<string | null>(null);
  // The batch waiting on a gate — the first-hide-of-a-session notice (#570),
  // then the sole-displayed-author confirm. Null when that dialog is closed.
  // Both gates take the WHOLE batch, so the single row the reject interstitial
  // reroutes ("Hide it instead") is simply a batch of one.
  const [noticeBatch, setNoticeBatch] = React.useState<Pub[] | null>(null);
  const [confirmBatch, setConfirmBatch] = React.useState<Pub[] | null>(null);
  // The "Not mine" reject interstitial (#746), keyed by the pmid being rejected
  // — null when closed.
  const [rejectPmid, setRejectPmid] = React.useState<string | null>(null);

  const totalCount = list.length;
  const hiddenCount = list.filter((p) => p.state !== "shown").length;

  const filtered = React.useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (q === "") return optimistic;
    return optimistic.filter((p) => p.title.toLowerCase().includes(q));
  }, [optimistic, filter]);

  const grouped = React.useMemo(() => groupByYearDesc(filtered), [filtered]);

  function setError(pmid: string, msg: string | null) {
    setErrors((prev) => {
      const next = new Map(prev);
      if (msg === null) next.delete(pmid);
      else next.set(pmid, msg);
      return next;
    });
  }

  function commitLocal(updater: (state: Pub[]) => Pub[]) {
    setList((prev) => updater(prev));
  }

  function startHide(batch: Pub[]) {
    if (batch.length === 0) return;
    // First publication-hide of the session shows the educational notice before
    // anything commits (#570). After it's been seen once, hides proceed straight
    // to the sole-author guard (if any) or the writes.
    if (!hasAcknowledgedFirstHide()) {
      setNoticeBatch(batch);
      return;
    }
    proceedHide(batch);
  }

  // The hide path once the first-hide notice is out of the way: the existing
  // sole-displayed-author guard — ONE confirm for the batch, not one per row —
  // then the writes.
  function proceedHide(batch: Pub[]) {
    if (batch.some((p) => p.isSoleDisplayedAuthor)) {
      setConfirmBatch(batch);
      return;
    }
    void hideBatch(batch);
  }

  /** One suppress write, committing the row locally on success. No
   *  `router.refresh()`: the committed local list is authoritative for this
   *  panel on a never-cached page (T3.7). */
  async function hideOne(pmid: string): Promise<boolean> {
    try {
      const res = await fetch("/api/edit/suppress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entityType: "publication",
          entityId: pmid,
          contributorCwid: cwid,
        }),
      });
      const data = (await res.json()) as
        | { ok: true; suppressionId: string }
        | { ok: false; error: string };
      if (!res.ok || data.ok !== true) return false;
      commitLocal((state) =>
        state.map((p) =>
          p.pmid === pmid
            ? { ...p, state: "hidden_by_self", suppressionId: data.suppressionId }
            : p,
        ),
      );
      return true;
    } catch {
      return false;
    }
  }

  /** Fan the batch out over `hideOne`; the rows that failed stay selected under
   *  one inline alert so a retry re-sends exactly those. */
  async function hideBatch(batch: Pub[]) {
    setBulkError(null);
    setBusy(true);
    try {
      const results = await Promise.all(batch.map((p) => hideOne(p.pmid)));
      const failed = batch.filter((_, i) => !results[i]);
      setSelected(new Set(failed.map((p) => p.pmid)));
      if (failed.length > 0) {
        setBulkError(
          `We couldn't hide ${failed.length} of the selected publications. Please try again.`,
        );
      }
    } finally {
      setBusy(false);
    }
  }

  function toggle(pmid: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(pmid);
      else next.delete(pmid);
      return next;
    });
  }

  function show(p: Pub) {
    if (p.suppressionId === null) return; // defensive — only hidden_by_self rows have a button
    const suppressionId = p.suppressionId;
    setError(p.pmid, null);
    startTransition(async () => {
      addOptimisticShow(p.pmid);
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
          setError(p.pmid, "We couldn't restore this publication. Please try again.");
          return;
        }
        commitLocal((state) =>
          state.map((pub) =>
            pub.pmid === p.pmid
              ? { ...pub, state: "shown", suppressionId: null }
              : pub,
          ),
        );
      } catch {
        setError(p.pmid, "We couldn't restore this publication. Please try again.");
      }
    });
  }

  // The in-app "Not mine" reject (#746, #570), gated behind `rejectEnabled`
  // (RECITER_REJECT_SEND). POSTs the rejection — which records it locally AND
  // propagates it to ReCiter's gold standard so the misattribution is corrected
  // at the source — then, on success, optimistically REMOVES the row from view
  // (a reject means the paper isn't theirs, so it drops off the profile rather
  // than greying out like a hide). Throws on failure so the interstitial keeps
  // itself open with an inline error — no optimistic-then-revert race.
  async function rejectPub(pmid: string): Promise<void> {
    setError(pmid, null);
    const res = await fetch("/api/edit/reject", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entityId: pmid, contributorCwid: cwid }),
    });
    const data = (await res.json()) as
      | { ok: true; suppressionId: string }
      | { ok: false; error: string };
    if (!res.ok || data.ok !== true) {
      throw new Error("reject_failed");
    }
    commitLocal((state) => state.filter((p) => p.pmid !== pmid));
  }

  const rejectingPub =
    rejectPmid !== null ? list.find((p) => p.pmid === rejectPmid) ?? null : null;

  // Visual order is the year groups, newest first, so "older" in the selection
  // bar means further down that list. The bar counts the SELECTION, not the
  // visible rows: filtering never drops a selected row from the batch.
  const ordered = grouped.flatMap((g) => g.items);
  const firstSelected = ordered.findIndex((p) => selected.has(p.pmid));
  const older =
    firstSelected < 0
      ? []
      : ordered
          .slice(firstSelected + 1)
          .filter((p) => p.state === "shown" && !selected.has(p.pmid));
  const soleCount = confirmBatch?.filter((p) => p.isSoleDisplayedAuthor).length ?? 0;

  return (
    <EditPanel
      slot="publications-card"
      attribute="publications"
      heading={su ? "Publications" : "My publications"}
      description={
        <>
          Hide a publication to remove {su ? scholarName : "yourself"} from it on this site. Hiding
          affects this profile only. A paper that isn&apos;t {possessive} keeps appearing on
          internal reports and the Faculty Review Tool until it&apos;s corrected in{" "}
          <a href={PUBLICATION_MANAGER_URL} target="_blank" rel="noreferrer" className="underline">
            Publication Manager
          </a>
          .
        </>
      }
    >
      {reciterPendingEnabled && (
        <ReciterPendingCardClient cwid={cwid} mode={mode} scholarName={scholarName} />
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground" aria-live="polite">
            <span className="text-foreground font-medium">{totalCount.toLocaleString()}</span>
            {" publications"}
            {hiddenCount > 0 && (
              <>
                {" · "}
                <span className="text-foreground font-medium">
                  {hiddenCount.toLocaleString()}
                </span>
                {" hidden"}
              </>
            )}
          </p>
          <Input
            type="search"
            aria-label="Filter publications by title"
            placeholder="Filter by title…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="border-apollo-border-strong max-w-xs"
            data-testid="publications-filter"
          />
        </div>

        {bulkError && (
          <Alert variant="destructive">
            <AlertDescription>{bulkError}</AlertDescription>
          </Alert>
        )}

        {totalCount === 0 ? (
          <p className="text-sm text-muted-foreground">
            No publications are currently associated with {possessive} profile.
          </p>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No publications match &ldquo;{filter}&rdquo;.
          </p>
        ) : (
          <ScrollArea className="md:h-[60vh]">
            <ul>
              {grouped.map(({ key, label, items }) => (
                <li key={key}>
                  <h3
                    className="bg-background text-apollo-slate sticky top-0 z-10 px-1 py-2 text-xs font-semibold tracking-wide uppercase"
                    data-slot="year-header"
                  >
                    {label}
                  </h3>
                  <ul className="divide-apollo-border divide-y">
                    {items.map((p) => (
                      <PublicationRow
                        key={p.pmid}
                        cwid={cwid}
                        su={su}
                        scholarName={scholarName}
                        pub={p}
                        error={errors.get(p.pmid) ?? null}
                        selected={selected.has(p.pmid)}
                        onSelect={(on) => toggle(p.pmid, on)}
                        onShow={() => show(p)}
                        rejectEnabled={rejectEnabled}
                        onNotMine={() => setRejectPmid(p.pmid)}
                      />
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}

      <SelectionBar
        count={selected.size}
        noun="publication"
        extendCount={older.length}
        extendLabelNoun="older publication"
        onExtend={() => setSelected(new Set([...selected, ...older.map((p) => p.pmid)]))}
        onHide={() => startHide(list.filter((p) => selected.has(p.pmid)))}
        onClear={() => setSelected(new Set())}
        busy={busy}
      />

      <FirstHideNoticeDialog
        open={noticeBatch !== null}
        onOpenChange={(open) => {
          // Cancel / Esc / backdrop / X — backed out without deciding. Close
          // but do NOT acknowledge, so the notice can resurface next time; the
          // selection survives, so the batch is one click from being re-tried.
          if (!open) setNoticeBatch(null);
        }}
        onHide={() => {
          // Informed choice — acknowledge for the session, then resume the hide
          // the scholar initiated, which for a batch holding a sole-displayed-
          // author paper opens the site-wide removal confirm rather than hiding
          // straight away (no double-prompt).
          const batch = noticeBatch;
          acknowledgeFirstHide();
          setNoticeBatch(null);
          if (batch) proceedHide(batch);
        }}
        onNotMine={() => {
          // Informed choice — acknowledge, then let the scholar leave for
          // Publication Manager (the <a> opens it in a new tab). Do NOT hide.
          acknowledgeFirstHide();
          setNoticeBatch(null);
        }}
      />

      <ConfirmDialog
        open={confirmBatch !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmBatch(null);
        }}
        title={`Hide ${plural(confirmBatch?.length ?? 0, "publication")}?`}
        // One dialog for the batch, quoting how many of it are sole-author —
        // not one prompt per row.
        description={`${soleCount} of these ${soleCount === 1 ? "lists" : "list"} ${
          su ? scholarName : "you"
        } as the only displayed Weill Cornell author. Hiding a publication with no other WCM author removes it from the site entirely until it is restored, or another WCM author is added.`}
        reasonMode="none"
        confirmLabel="Hide anyway"
        confirmVariant="destructive"
        onConfirm={async () => {
          const batch = confirmBatch;
          setConfirmBatch(null);
          if (batch) await hideBatch(batch);
        }}
      />

      <RejectNoticeDialog
        open={rejectPmid !== null}
        onOpenChange={(open) => {
          if (!open) setRejectPmid(null);
        }}
        mode={mode}
        scholarName={scholarName}
        pubTitle={rejectingPub?.title ?? ""}
        onReject={async () => {
          if (!rejectingPub) return;
          // Throws on failure → the interstitial keeps itself open with an
          // inline error. On success the row is already gone; close the dialog.
          await rejectPub(rejectingPub.pmid);
          setRejectPmid(null);
        }}
        onHideInstead={() => {
          // "This IS mine, just hide it" — steer to the reversible hide path
          // (which itself shows the first-hide notice the once per session).
          const p = rejectingPub;
          setRejectPmid(null);
          if (p) startHide([p]);
        }}
      />
    </EditPanel>
  );
}

function PublicationRow({
  cwid,
  su,
  scholarName,
  pub,
  error,
  selected,
  onSelect,
  onShow,
  rejectEnabled,
  onNotMine,
}: {
  cwid: string;
  /** Superuser acting on the scholar's behalf — reframes the rejected-row note. */
  su: boolean;
  scholarName: string;
  pub: Pub;
  error: string | null;
  selected: boolean;
  onSelect: (on: boolean) => void;
  onShow: () => void;
  rejectEnabled: boolean;
  /** Open the "Not mine" reject interstitial (#746). */
  onNotMine: () => void;
}) {
  return (
    <li className="flex flex-col gap-2 px-1 py-4" data-testid={`pub-row-${pub.pmid}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        {pub.state === "shown" ? (
          <label className="hover:bg-apollo-surface-2 -mt-1 -ml-1.5 flex size-[30px] shrink-0 items-center justify-center rounded-[7px]">
            <Checkbox
              className="border-apollo-border-strong size-[18px] border-2"
              checked={selected}
              onCheckedChange={(c) => onSelect(c === true)}
              // Plain-text title + journal/year, so two rows sharing a title
              // still read apart (the positions-card scheme). `htmlToPlainText`
              // keeps PubMed's inline `<i>`/`<sub>` markup out of the label.
              aria-label={`Select ${htmlToPlainText(pub.title)}, ${htmlToPlainText(
                pub.journal ?? "Unknown journal",
              )} · ${pub.year ?? "Year unknown"}`}
            />
          </label>
        ) : (
          <span className="w-6 shrink-0" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <PubTitle
            as="p"
            className={cn(
              "text-foreground font-medium",
              (pub.state === "hidden_by_self" || pub.state === "rejected") &&
                "decoration-muted-foreground text-muted-foreground line-through",
            )}
            value={pub.title}
          />
          <p className="text-sm text-muted-foreground">
            <PubJournal as="span" value={pub.journal ?? "Unknown journal"} /> ·{" "}
            {pub.year ?? "Year unknown"}
            {pub.state === "hidden_by_self" && (
              <>
                {" · "}
                <Badge
                  variant="outline"
                  className="bg-apollo-slate-tint text-apollo-slate border-apollo-slate-tint-border rounded-full"
                >
                  Hidden
                </Badge>
              </>
            )}
            {pub.state === "rejected" && (
              <>
                {" · "}
                <Badge
                  variant="outline"
                  className="bg-apollo-slate-tint text-apollo-slate border-apollo-slate-tint-border rounded-full"
                  data-testid={`pub-rejected-badge-${pub.pmid}`}
                >
                  Rejected — correction pending
                </Badge>
              </>
            )}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {pub.state === "hidden_by_self" && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="min-h-11 md:min-h-8"
              onClick={onShow}
              data-testid={`pub-show-${pub.pmid}`}
            >
              <Eye />
              Show
            </Button>
          )}
          {pub.state === "removed_by_admin" && (
            <div className="flex flex-col items-end gap-1">
              <Badge variant="destructive">Removed by an administrator</Badge>
              <span className="text-muted-foreground max-w-xs text-right text-sm">
                An administrator removed this publication site-wide; hiding or
                showing it here has no effect.
              </span>
            </div>
          )}
          {pub.state === "rejected" && (
            // A reject was recorded as a misattribution and sent to ReCiter's
            // gold standard (#746). There is deliberately no Show control —
            // un-hiding locally would leave the upstream reject in place and the
            // two would silently diverge (#750). It is undone at the source.
            <div
              className="flex flex-col items-end gap-1"
              data-testid={`pub-rejected-note-${pub.pmid}`}
            >
              <span className="text-muted-foreground max-w-xs text-right text-sm">
                {su ? (
                  <>
                    This paper was reported as not {scholarName}&apos;s. We&apos;re correcting it at
                    the source; this can&apos;t be undone here.
                  </>
                ) : (
                  <>
                    You reported this paper as not yours. We&apos;re correcting it at the source;
                    this can&apos;t be undone here.
                  </>
                )}
              </span>
            </div>
          )}
          {pub.state !== "removed_by_admin" &&
            pub.state !== "rejected" &&
            // A quiet, standing "Not mine?" affordance — a low-emphasis link, not
            // a third equal-weight button (vision-round finding 4.9).
            (rejectEnabled ? (
              // In-app reject (#746): open the soft-warning interstitial that
              // commits the reject + the ReCiter gold-standard write.
              <Button
                type="button"
                variant="link"
                size="sm"
                className="text-muted-foreground hover:text-foreground h-auto px-0"
                onClick={onNotMine}
                data-testid={`pub-not-mine-${pub.pmid}`}
              >
                Not mine?
              </Button>
            ) : (
              // Off-ramp (default): the Request-a-change router pre-selected to
              // the "not mine" route lands the scholar on the correct-at-source
              // guidance in Publication Manager.
              <RequestAChangeDialog
                attribute="publications"
                cwid={cwid}
                scholarName={scholarName}
                itemLabel={pub.title}
                initialIssueId="publication-not-mine"
                trigger={(open) => (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="text-muted-foreground hover:text-foreground h-auto px-0"
                    onClick={open}
                    data-testid={`pub-not-mine-${pub.pmid}`}
                  >
                    Not mine?
                  </Button>
                )}
              />
            ))}
          <RequestAChangeDialog
            attribute="publications"
            cwid={cwid}
            scholarName={scholarName}
            itemLabel={pub.title}
          />
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

type YearGroup = { key: string; label: string; items: Pub[] };

function groupByYearDesc(pubs: Pub[]): YearGroup[] {
  const groups = new Map<string, Pub[]>();
  for (const p of pubs) {
    const key = p.year !== null ? String(p.year) : "unknown";
    const arr = groups.get(key);
    if (arr) arr.push(p);
    else groups.set(key, [p]);
  }
  const sorted = [...groups.entries()].sort(([a], [b]) => {
    if (a === "unknown") return 1;
    if (b === "unknown") return -1;
    return Number(b) - Number(a);
  });
  return sorted.map(([key, items]) => ({
    key,
    label: key === "unknown" ? "Year unknown" : key,
    items,
  }));
}
