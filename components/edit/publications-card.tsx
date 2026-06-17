/**
 * The My publications card (#356 Phase 6 C7, UI-SPEC § `/edit` Card 3).
 *
 * The filterable, year-grouped list of the scholar's confirmed authorships
 * with optimistic hide/show. A sole-displayed-author hide opens a confirm
 * dialog first (UI-SPEC edge case 11); an admin-removed publication renders
 * an inline explanation and no control (UI-SPEC accessibility — a disabled
 * button would not be keyboard-reachable for its tooltip).
 *
 * Optimistic mechanism (D6.4): `useOptimistic` over a local-state list that
 * commits on a successful POST. On a network/server failure the optimistic
 * state reverts when the transition ends and an inline destructive Alert
 * renders above the row.
 */
"use client";

import * as React from "react";
import { Eye, EyeOff } from "lucide-react";

import { ConfirmDialog } from "@/components/edit/confirm-dialog";
import { EditPanel } from "@/components/edit/edit-panel";
import { FirstHideNoticeDialog } from "@/components/edit/first-hide-notice-dialog";
import { ReciterPendingCardClient } from "@/components/edit/reciter-pending-card";
import { RejectNoticeDialog } from "@/components/edit/reject-notice-dialog";
import { RequestAChangeDialog } from "@/components/edit/request-a-change-dialog";
import { PubJournal, PubTitle } from "@/components/publication/pub-html";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { PUBLICATION_MANAGER_URL } from "@/lib/edit/request-a-change";
import { cn } from "@/lib/utils";
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
type OptimisticUpdate =
  | { kind: "hide"; pmid: string }
  | { kind: "show"; pmid: string };

function applyOptimistic(state: Pub[], update: OptimisticUpdate): Pub[] {
  return state.map((p) => {
    if (p.pmid !== update.pmid) return p;
    if (update.kind === "hide") {
      return { ...p, state: "hidden_by_self", suppressionId: null };
    }
    return { ...p, state: "shown", suppressionId: null };
  });
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
  const [optimistic, addOptimistic] = React.useOptimistic(list, applyOptimistic);
  const [errors, setErrors] = React.useState<Map<string, string>>(new Map());
  const [filter, setFilter] = React.useState("");
  // The sole-author confirm dialog is keyed by pmid — open is null when closed.
  const [confirmPmid, setConfirmPmid] = React.useState<string | null>(null);
  // The first-hide-of-a-session notice (#570), keyed by the pmid that triggered
  // it — null when closed.
  const [noticePmid, setNoticePmid] = React.useState<string | null>(null);
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

  function startHide(p: Pub) {
    // First publication-hide of the session shows the educational notice before
    // anything commits (#570). After it's been seen once, hides proceed straight
    // to the sole-author guard (if any) or the optimistic hide.
    if (!hasAcknowledgedFirstHide()) {
      setNoticePmid(p.pmid);
      return;
    }
    proceedHide(p);
  }

  // The hide path once the first-hide notice is out of the way: the existing
  // sole-displayed-author guard, then the optimistic write.
  function proceedHide(p: Pub) {
    if (p.isSoleDisplayedAuthor) {
      setConfirmPmid(p.pmid);
      return;
    }
    hide(p.pmid);
  }

  // Close the notice without recording an acknowledgment — the Cancel / Esc /
  // backdrop path. The scholar backed out before deciding, so the notice can
  // resurface on their next hide.
  function closeNotice() {
    setNoticePmid(null);
  }

  function hide(pmid: string) {
    setError(pmid, null);
    startTransition(async () => {
      addOptimistic({ kind: "hide", pmid });
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
        if (!res.ok || data.ok !== true) {
          setError(pmid, "We couldn't hide this publication. Please try again.");
          return; // optimistic reverts when the transition ends
        }
        commitLocal((state) =>
          state.map((p) =>
            p.pmid === pmid
              ? { ...p, state: "hidden_by_self", suppressionId: data.suppressionId }
              : p,
          ),
        );
        // No router.refresh(): the optimistic→committed local list is
        // authoritative for this panel on a never-cached page (T3.7).
      } catch {
        setError(pmid, "We couldn't hide this publication. Please try again.");
      }
    });
  }

  function show(p: Pub) {
    if (p.suppressionId === null) return; // defensive — only hidden_by_self rows have a button
    const suppressionId = p.suppressionId;
    setError(p.pmid, null);
    startTransition(async () => {
      addOptimistic({ kind: "show", pmid: p.pmid });
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

  const confirmingPub =
    confirmPmid !== null ? list.find((p) => p.pmid === confirmPmid) ?? null : null;
  const noticePub =
    noticePmid !== null ? list.find((p) => p.pmid === noticePmid) ?? null : null;
  const rejectingPub =
    rejectPmid !== null ? list.find((p) => p.pmid === rejectPmid) ?? null : null;

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
      {reciterPendingEnabled && <ReciterPendingCardClient />}
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
                        onHide={() => startHide(p)}
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

      <FirstHideNoticeDialog
        open={noticePmid !== null}
        onOpenChange={(open) => {
          // Cancel / Esc / backdrop / X — backed out without deciding. Close
          // but do NOT acknowledge, so the notice can resurface next time.
          if (!open) closeNotice();
        }}
        onHide={() => {
          // Informed choice — acknowledge for the session, then resume the hide
          // the scholar initiated, which for a sole-displayed-author paper opens
          // the site-wide removal confirm rather than hiding straight away (no
          // double-prompt).
          const p = noticePub;
          acknowledgeFirstHide();
          closeNotice();
          if (p) proceedHide(p);
        }}
        onNotMine={() => {
          // Informed choice — acknowledge, then let the scholar leave for
          // Publication Manager (the <a> opens it in a new tab). Do NOT hide.
          acknowledgeFirstHide();
          closeNotice();
        }}
      />

      <ConfirmDialog
        open={confirmPmid !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmPmid(null);
        }}
        title="Hide this publication?"
        description={
          su
            ? `${scholarName} is the only Weill Cornell author shown on this publication. Hiding it removes the publication from the site entirely until it is restored, or another WCM author is added.`
            : "You are the only Weill Cornell author shown on this publication. Hiding it removes the publication from the site entirely until you restore it, or another WCM author is added."
        }
        reasonMode="none"
        confirmLabel="Hide it anyway"
        confirmVariant="destructive"
        onConfirm={async () => {
          if (!confirmingPub) return;
          setConfirmPmid(null);
          hide(confirmingPub.pmid);
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
          if (p) startHide(p);
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
  onHide,
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
  onHide: () => void;
  onShow: () => void;
  rejectEnabled: boolean;
  /** Open the "Not mine" reject interstitial (#746). */
  onNotMine: () => void;
}) {
  return (
    <li className="flex flex-col gap-2 px-1 py-4" data-testid={`pub-row-${pub.pmid}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
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
          {pub.state === "shown" && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="min-h-11 md:min-h-8"
              onClick={onHide}
              data-testid={`pub-hide-${pub.pmid}`}
            >
              <EyeOff />
              Hide
            </Button>
          )}
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
          <RequestAChangeDialog attribute="publications" cwid={cwid} itemLabel={pub.title} />
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
