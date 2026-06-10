"use client";

/**
 * Internal-only "Download the leading scholars" button (#847).
 *
 * Renders a single Download control that POSTs the scope params to
 * /api/export/scholars/{scope} and triggers a Blob anchor download of the
 * dated CSV returned by the server. The roster is the scope's own ranked top
 * 50 (cap is fixed server-side — no confirm dialog), and the CSV never carries
 * a contact column.
 *
 * Visibility: a server component only renders this island when
 * `isScholarListExportEnabled()` is true, so flag-off cached HTML never carries
 * it. On top of that the button probes `/api/auth/session` on mount and renders
 * null for anonymous visitors — public surfaces are served by CloudFront's
 * cacheable default behavior, which strips the Cookie header, so the export is
 * only offered once the client confirms an authenticated session (mirroring
 * `components/site/header-auth-slot.tsx`). The route enforces the 401 itself;
 * this is purely so signed-out users never see a button that would fail.
 */
import { useEffect, useState } from "react";
import { Download, Loader2 } from "lucide-react";

export function ScholarListExportButton({
  scope,
  params,
}: {
  /** Export scope segment — also the route path param. */
  scope: "method-family" | "supercategory" | "topic";
  /** Flat string body the route's per-scope builder reads (e.g. { supercategory, family }). */
  params: Record<string, string>;
  /** Optional roster size hint; unused for gating since the cap is server-side. */
  count?: number;
}) {
  const [authed, setAuthed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/auth/session", { cache: "no-store", credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { authenticated?: boolean } | null) => {
        if (!active || !data?.authenticated) return;
        setAuthed(true);
      })
      .catch(() => {
        /* leave signed-out — the button stays hidden */
      });
    return () => {
      active = false;
    };
  }, []);

  const handleExport = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const resp = await fetch(`/api/export/scholars/${scope}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(params),
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      // Pull filename from the server header so the date stamp matches the rows.
      const disposition = resp.headers.get("Content-Disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(disposition);
      const filename = match?.[1] ?? `${scope}-scholars.csv`;

      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(`Couldn't download: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setBusy(false);
    }
  };

  // Signed-out visitors never see the control (the route would 401 anyway).
  if (!authed) return null;

  return (
    <div className="flex flex-col items-end gap-0.5">
      <button
        type="button"
        onClick={handleExport}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-sm border border-[#c8c6be] bg-white px-3 py-1 text-[13px] text-[#1a1a1a] hover:border-[#2c4f6e] hover:text-[#2c4f6e] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? (
          <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
        ) : (
          <Download aria-hidden className="h-3.5 w-3.5" strokeWidth={2} />
        )}
        Download top 50 (CSV)
      </button>
      {error ? (
        <p className="text-[11px] text-[#a0341c]">{error}</p>
      ) : (
        <p className="text-[11px] text-muted-foreground">Top 50 by publications · internal use</p>
      )}
    </div>
  );
}
