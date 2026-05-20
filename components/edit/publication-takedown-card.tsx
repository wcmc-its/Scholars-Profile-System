/**
 * The whole-publication takedown card (#356 Phase 7 C7, UI-SPEC §
 * `/edit/publication/[pmid]` Card 2).
 *
 * Three states drive the card's content + control:
 *
 *   1. **On the site** — no takedown, ≥ 1 displayed WCM author. Renders
 *      "Remove from site" → `ConfirmDialog reasonMode='required-text'` →
 *      `POST /api/edit/suppress` (whole-pub takedown, `contributorCwid:null`).
 *   2. **Removed — explicit takedown** — destructive Alert with the reason,
 *      actor cwid, and date. "Restore to site" → `POST /api/edit/revoke`
 *      with no dialog (UI-SPEC § Feedback: restoration is never confirmed).
 *   3. **Dark — zero displayed WCM authors** — info Alert; no control. A
 *      takedown may still be added on top from this state (the same Remove
 *      button is rendered).
 *
 * `router.refresh()` after a successful write picks up cascading state
 * changes from a suppression-OFF re-read on the next render.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { ConfirmDialog } from "@/components/edit/confirm-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { PublicationTakedown } from "@/lib/api/publication-takedown-context";

export type PublicationTakedownCardProps = {
  pmid: string;
  takedown: PublicationTakedown | null;
  derivedDark: boolean;
};

export function PublicationTakedownCard({
  pmid,
  takedown: initialTakedown,
  derivedDark,
}: PublicationTakedownCardProps) {
  const router = useRouter();
  const [takedown, setTakedown] = React.useState<PublicationTakedown | null>(initialTakedown);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function removeFromSite(reason: string | null) {
    setError(null);
    setPending(true);
    try {
      // Dialog's required-text guarantees a non-empty trimmed reason; defensive
      // type narrow keeps the server contract honest.
      const reasonValue = (reason ?? "").trim();
      if (reasonValue.length === 0) {
        setError("A reason is required.");
        throw new Error("missing_reason");
      }
      const res = await fetch("/api/edit/suppress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entityType: "publication",
          entityId: pmid,
          contributorCwid: null,
          reason: reasonValue,
        }),
      });
      const data = (await res.json()) as
        | { ok: true; suppressionId: string }
        | { ok: false; error: string };
      if (!res.ok || data.ok !== true) {
        setError("We couldn't remove this publication. Please try again.");
        throw new Error("suppress_failed");
      }
      setTakedown({
        id: data.suppressionId,
        reason: reasonValue,
        actorCwid: "(you)", // local approximation; router.refresh re-loads with the real value
        createdAt: new Date(),
      });
      setConfirmOpen(false);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  async function restoreToSite() {
    if (takedown === null || pending) return;
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/edit/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suppressionId: takedown.id }),
      });
      const data = (await res.json()) as
        | { ok: true; suppressionId: string }
        | { ok: false; error: string };
      if (!res.ok || data.ok !== true) {
        setError("We couldn't restore this publication. Please try again.");
        return;
      }
      setTakedown(null);
      router.refresh();
    } catch {
      setError("We couldn't restore this publication. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card data-slot="publication-takedown-card">
      <CardHeader>
        <CardTitle>Publication visibility</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {takedown !== null ? (
          <>
            <Alert variant="destructive" data-testid="publication-takedown-removed">
              <AlertDescription>
                <strong>Removed from the site.</strong> Reason:{" "}
                <em>{takedown.reason || "(no reason on file)"}</em>. By{" "}
                <code>{takedown.actorCwid}</code> on{" "}
                <time dateTime={takedown.createdAt.toISOString()}>
                  {takedown.createdAt.toLocaleDateString()}
                </time>
                .
              </AlertDescription>
            </Alert>
            <div>
              <Button
                type="button"
                onClick={restoreToSite}
                disabled={pending}
                data-testid="publication-takedown-restore"
              >
                {pending ? "Working…" : "Restore to site"}
              </Button>
            </div>
          </>
        ) : derivedDark ? (
          <>
            <Alert variant="info" data-testid="publication-takedown-dark">
              <AlertDescription>
                This publication is currently hidden because every Weill Cornell
                author has hidden it. A takedown may still be added on top.
              </AlertDescription>
            </Alert>
            <div>
              <Button
                type="button"
                variant="destructive"
                onClick={() => setConfirmOpen(true)}
                data-testid="publication-takedown-remove"
              >
                Remove from site
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm">This publication is visible on the site.</p>
            <div>
              <Button
                type="button"
                variant="destructive"
                onClick={() => setConfirmOpen(true)}
                data-testid="publication-takedown-remove"
              >
                Remove from site
              </Button>
            </div>
          </>
        )}

        {error && (
          <Alert variant="destructive" data-testid="publication-takedown-error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </CardContent>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Remove this publication from the site?"
        description="The publication will be hidden across the entire site immediately. A reason is required for the audit log — a retraction notice, compliance reference, or ticket link is ideal."
        reasonMode="required-text"
        confirmLabel="Remove publication"
        confirmVariant="destructive"
        onConfirm={removeFromSite}
      />
    </Card>
  );
}
