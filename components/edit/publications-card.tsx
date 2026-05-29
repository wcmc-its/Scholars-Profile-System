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
import { useRouter } from "next/navigation";
import { Eye, EyeOff } from "lucide-react";

import { ConfirmDialog } from "@/components/edit/confirm-dialog";
import { FieldSourceLine } from "@/components/edit/field-source-line";
import { FirstHideNoticeDialog } from "@/components/edit/first-hide-notice-dialog";
import { RequestAChangeDialog } from "@/components/edit/request-a-change-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { PUBLICATION_MANAGER_URL } from "@/lib/edit/request-a-change";
import { cn } from "@/lib/utils";
import type { EditContextPublication } from "@/lib/api/edit-context";

export type PublicationsCardProps = {
  cwid: string;
  publications: ReadonlyArray<EditContextPublication>;
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

export function PublicationsCard({ cwid, publications }: PublicationsCardProps) {
  const router = useRouter();
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
        router.refresh();
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
        router.refresh();
      } catch {
        setError(p.pmid, "We couldn't restore this publication. Please try again.");
      }
    });
  }

  const confirmingPub =
    confirmPmid !== null ? list.find((p) => p.pmid === confirmPmid) ?? null : null;
  const noticePub =
    noticePmid !== null ? list.find((p) => p.pmid === noticePmid) ?? null : null;

  return (
    <Card data-slot="publications-card">
      <CardHeader>
        <CardTitle>My publications</CardTitle>
        <FieldSourceLine attribute="publications" />
        <CardDescription>
          Hide a publication to remove yourself from it on this site. Hiding
          affects this profile only. A paper that isn&apos;t yours keeps
          appearing on internal reports and the Faculty Review Tool until
          it&apos;s corrected in{" "}
          <a
            href={PUBLICATION_MANAGER_URL}
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            Publication Manager
          </a>
          .
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
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
            className="max-w-xs"
            data-testid="publications-filter"
          />
        </div>

        {totalCount === 0 ? (
          <p className="text-sm text-muted-foreground">
            No publications are currently associated with your profile.
          </p>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No publications match &ldquo;{filter}&rdquo;.
          </p>
        ) : (
          <ScrollArea className="h-[60vh] rounded-md border border-border">
            <ul className="divide-y divide-border">
              {grouped.map(({ key, label, items }) => (
                <li key={key}>
                  <h3
                    className="bg-background text-muted-foreground sticky top-0 z-10 px-3 py-2 text-sm font-semibold"
                    data-slot="year-header"
                  >
                    {label}
                  </h3>
                  <ul className="divide-y divide-border">
                    {items.map((p) => (
                      <PublicationRow
                        key={p.pmid}
                        cwid={cwid}
                        pub={p}
                        error={errors.get(p.pmid) ?? null}
                        onHide={() => startHide(p)}
                        onShow={() => show(p)}
                      />
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
      </CardContent>

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
        description="You are the only Weill Cornell author shown on this publication. Hiding it removes the publication from the site entirely until you restore it, or another WCM author is added."
        reasonMode="none"
        confirmLabel="Hide it anyway"
        confirmVariant="destructive"
        onConfirm={async () => {
          if (!confirmingPub) return;
          setConfirmPmid(null);
          hide(confirmingPub.pmid);
        }}
      />
    </Card>
  );
}

function PublicationRow({
  cwid,
  pub,
  error,
  onHide,
  onShow,
}: {
  cwid: string;
  pub: Pub;
  error: string | null;
  onHide: () => void;
  onShow: () => void;
}) {
  return (
    <li className="flex flex-col gap-2 px-3 py-3" data-testid={`pub-row-${pub.pmid}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              "text-base",
              pub.state === "hidden_by_self" && "text-muted-foreground",
            )}
          >
            {pub.title}
          </p>
          <p className="text-sm text-muted-foreground">
            {pub.journal ?? "Unknown journal"} · {pub.year ?? "Year unknown"}
            {pub.state === "hidden_by_self" && (
              <>
                {" · "}
                <Badge>Hidden</Badge>
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
