/**
 * ViewAsButton — the per-row "View as" launch shortcut (#729, a #637 follow-on).
 *
 * The impersonation engine already ships (#637/#643/#712): the gated, audited
 * `POST /api/impersonation` route, the amber banner, the account-menu switcher,
 * and the effective-CWID seam. This is purely a CONVENIENCE entry point — a
 * one-click "view as this person" on the Profiles roster rows and the
 * Administrators cards, instead of opening the switcher and searching.
 *
 * It does NOT re-implement any policy: the route enforces R1 (superuser-only,
 * on the REAL cwid), R2 (down-only — can't view as another superuser), R4
 * (same-origin + JSON), and writes the `impersonation_start` audit row attributed
 * to the real human. This button only renders for `canImpersonate` viewers (flag
 * on + superuser) and is hidden on the viewer's own row; the route is the
 * authority boundary regardless. A confirm step (mirroring the switcher's
 * "logged to you" confirm) precedes the POST.
 *
 * On success the route returns 204 + a re-sealed session cookie, so we reload to
 * let the overlay + banner take effect. `onStarted` overrides the reload for tests.
 */
"use client";

import * as React from "react";
import { Eye } from "lucide-react";

import { ConfirmDialog } from "@/components/edit/confirm-dialog";
import { Button } from "@/components/ui/button";

export type ViewAsButtonProps = {
  targetCwid: string;
  targetName: string;
  /** Post-start action; defaults to a full reload so the banner appears. Injectable for tests. */
  onStarted?: () => void;
  size?: React.ComponentProps<typeof Button>["size"];
  variant?: React.ComponentProps<typeof Button>["variant"];
};

/** Map an `/api/impersonation` error reason to a human message. */
function mapStartError(code: string): string {
  switch (code) {
    case "target_is_superuser":
      return "You can’t view as another superuser.";
    case "not_superuser":
      return "Only superusers can use “View as”.";
    case "target_not_found":
      return "That person isn’t an active scholar.";
    default:
      return "Couldn’t start “View as” — please try again.";
  }
}

export function ViewAsButton({
  targetCwid,
  targetName,
  onStarted,
  size = "sm",
  variant = "outline",
}: ViewAsButtonProps) {
  const [open, setOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function start() {
    setError(null);
    let res: Response;
    try {
      res = await fetch("/api/impersonation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetCwid }),
      });
    } catch {
      setOpen(false);
      setError(mapStartError(""));
      return;
    }
    if (res.ok) {
      // 204 + Set-Cookie; reload so the overlay + banner take effect.
      setOpen(false);
      (onStarted ?? (() => window.location.reload()))();
      return;
    }
    let code = "";
    try {
      code = ((await res.json()) as { error?: string }).error ?? "";
    } catch {
      /* no body (e.g. 415) */
    }
    setOpen(false);
    setError(mapStartError(code));
  }

  return (
    <span className="inline-flex flex-col items-end gap-1" data-slot="view-as">
      <Button
        type="button"
        size={size}
        variant={variant}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        data-testid={`view-as-${targetCwid}`}
      >
        <Eye />
        View as
      </Button>
      {error && (
        <span
          role="alert"
          className="text-destructive max-w-[14rem] text-xs"
          data-testid={`view-as-error-${targetCwid}`}
        >
          {error}
        </span>
      )}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`View as ${targetName}?`}
        description={`You’ll browse and edit as ${targetName}. Changes are made as them and logged to you, and a banner stays up until you select “Return to my view”.`}
        reasonMode="none"
        confirmLabel={`View as ${targetName}`}
        confirmVariant="default"
        onConfirm={start}
      />
    </span>
  );
}
