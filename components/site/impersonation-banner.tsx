"use client";

import { useEffect, useState, type CSSProperties } from "react";

import { useImpersonationProbe } from "@/components/site/use-impersonation-probe";

/**
 * The "View as" impersonation banner (#637, impersonation-spec.md §6/§8, R7/T6).
 *
 * A deliberately **off-brand amber** bar — neither Cornell red (#B31B1B, the
 * header chrome) nor Apollo maroon (#7d1c1c, the /edit editor): impersonation is
 * an exceptional, attention-demanding state and must not blend into either
 * surface. Full-width, sticky to the very top, and it **pushes content down**
 * (it is a flow element, not an overlay) so it can never be missed or hidden
 * behind the header. Non-dismissible (R7) — the only exit is "Return to my view"
 * or auto-expiry.
 *
 * **Client-probed (T6), never server-only.** Mounted in the root layout above
 * the header, it reads its state from `/api/auth/session` via
 * `useImpersonationProbe`. A server-rendered banner would vanish on
 * CloudFront-cached public pages whose Cookie header is stripped at the edge —
 * exactly the pages a superuser QA's. When the probe reports no live overlay
 * (none, past-TTL, or feature flag off) this renders nothing.
 *
 * Editing is live while impersonating (edits authorize as the target but are
 * attributed to the real actor + `impersonated_cwid`, R3), so the copy states
 * plainly that changes are made *as them* and *logged to you* — the confused-
 * deputy mitigation (T6) made explicit in words, not just color.
 *
 * `role="status"` + `aria-live="polite"` announces the state to assistive tech
 * on entry; the "Return to my view" exit is an always-present, keyboard-
 * focusable button. The countdown mirrors the server's read-time TTL
 * (`NEXT_PUBLIC_IMPERSONATION_TTL_SECONDS`, default 1800) measured from the
 * overlay's `startedAt`; it is advisory — the authoritative expiry is the server
 * seam (`lib/auth/effective-identity.ts`).
 */

const AMBER_GRADIENT = "linear-gradient(90deg, #7a4f01 0%, #92611a 100%)";
const AMBER_UNDERLINE = "#f0b429";
const AMBER_TEXT = "#fff8eb";

/**
 * The "Return to my view" button: a light chip on the amber bar, with the focus
 * ring's offset color set to the bar's darker amber (not the page white) so the
 * `focus-visible:ring-offset-2` ring reads correctly against the gradient. The
 * CSS custom property needs the cast — `CSSProperties` has no index signature.
 */
const RETURN_BUTTON_STYLE = {
  backgroundColor: AMBER_TEXT,
  color: "#5a3a00",
  "--tw-ring-offset-color": "#7a4f01",
} as CSSProperties;

const ROLE_LABEL: Record<"owner" | "curator" | "scholar", string> = {
  owner: "Owner",
  curator: "Curator",
  scholar: "Scholar",
};

/** Compact unit-kind suffix for the banner's subject line. */
const KIND_SHORT: Record<"department" | "division" | "center", string> = {
  department: "Dept",
  division: "Div",
  center: "Center",
};

/**
 * The subject descriptor after the name: a plain `Scholar`, or
 * `Owner · {unit} ({Dept|Div|Center})` for a unit owner/curator (ADR-005
 * Amendment 1 role × unit-kind, #540).
 */
function subjectDescriptor(im: {
  role: "owner" | "curator" | "scholar";
  unitKind: "department" | "division" | "center" | null;
  unit: string | null;
}): string {
  if (im.role === "scholar") return ROLE_LABEL.scholar;
  const unit = im.unit ? ` · ${im.unit}` : "";
  const kind = im.unitKind ? ` (${KIND_SHORT[im.unitKind]})` : "";
  return `${ROLE_LABEL[im.role]}${unit}${kind}`;
}

/** Client mirror of the server read-time TTL; falls back to 30 min. */
const TTL_SECONDS = Number(process.env.NEXT_PUBLIC_IMPERSONATION_TTL_SECONDS ?? 1800);

/** Format whole seconds remaining as `m:ss` (clamped at 0). */
function formatRemaining(seconds: number): string {
  const clamped = Math.max(0, Math.floor(seconds));
  const m = Math.floor(clamped / 60);
  const s = clamped % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function ImpersonationBanner() {
  const probe = useImpersonationProbe();
  const impersonating = probe?.impersonating ?? null;

  // Live countdown to the overlay's read-time expiry. `nowSeconds` ticks once a
  // second while a banner is shown; the effect is a no-op (and the interval is
  // never set) when there is no overlay, so a non-impersonating page pays
  // nothing.
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!impersonating) return;
    setNowSeconds(Math.floor(Date.now() / 1000));
    const id = window.setInterval(() => {
      setNowSeconds(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [impersonating]);

  const [returning, setReturning] = useState(false);

  if (!impersonating) return null;

  const realName = probe?.scholar?.preferredName ?? null;
  const firstName = realName ? realName.split(/\s+/)[0] : "you";
  const expiresAt = impersonating.startedAt + TTL_SECONDS;
  const remaining = formatRemaining(expiresAt - nowSeconds);

  async function returnToMyView() {
    setReturning(true);
    try {
      await fetch("/api/impersonation", {
        method: "DELETE",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
      });
    } catch {
      /* best-effort — reload regardless so the cleared cookie takes effect */
    }
    window.location.reload();
  }

  return (
    <div
      role="status"
      aria-live="polite"
      data-slot="impersonation-banner"
      data-testid="impersonation-banner"
      className="sticky top-0 z-[60] w-full"
      style={{
        background: AMBER_GRADIENT,
        borderBottom: `3px solid ${AMBER_UNDERLINE}`,
        color: AMBER_TEXT,
      }}
    >
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-1 px-6 py-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-sm leading-tight">
            <span aria-hidden="true">👁 </span>
            Viewing as{" "}
            <strong className="font-semibold">{impersonating.targetName}</strong>
            {" · "}
            {subjectDescriptor(impersonating)}
          </p>
          <p className="text-xs leading-tight" style={{ color: "#f6e6c4" }}>
            You are {realName ?? "signed in as yourself"}. Changes are made as{" "}
            {firstName} and logged to you.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span
            className="text-xs tabular-nums"
            style={{ color: "#f6e6c4" }}
            aria-label={`Auto-expires in ${remaining}`}
            data-testid="impersonation-countdown"
          >
            Expires in {remaining}
          </span>
          <button
            type="button"
            onClick={returnToMyView}
            disabled={returning}
            data-testid="impersonation-return"
            className="inline-flex items-center rounded-md px-3 py-1 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:opacity-60"
            style={RETURN_BUTTON_STYLE}
          >
            {returning ? "Returning…" : "Return to my view"}
          </button>
        </div>
      </div>
    </div>
  );
}
