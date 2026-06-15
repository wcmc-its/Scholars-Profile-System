"use client";

/**
 * Internal-only "Download the leading scholars" button (#847).
 *
 * Renders a single Download control that POSTs the scope params to
 * /api/export/scholars/{scope} and triggers a Blob anchor download of the
 * dated CSV returned by the server. The roster is the scope's own ranked cohort,
 * exported in full (SPEC §B.3 HARD cap — the server only serves a cohort of <= 50
 * and the parent only renders this island for such a cohort; no confirm dialog).
 *
 * Visibility: a server component only renders this island when
 * `isScholarListExportEnabled()` is true AND the cohort is <= 50 (SPEC §B.3), so
 * flag-off / over-cap cached HTML never carries it. On top of that the button
 * probes `/api/profile/viewer/context` on mount and renders null unless the
 * viewer is INTERNAL — an authenticated session OR (when the network signal is
 * on) an on-WCM-network source IP (#866). Public surfaces are CloudFront-cached
 * with the Cookie header stripped, so visibility can't be decided server-side;
 * the probe resolves it client-side. The route enforces the 401 + the cap itself;
 * this is purely so external / signed-out / over-cap viewers never see a button.
 */
import { useEffect, useState } from "react";
import { Download, Loader2 } from "lucide-react";

export function ScholarListExportButton({
  scope,
  params,
  count,
}: {
  /** Export scope segment — also the route path param. */
  scope: "method-family" | "supercategory" | "topic";
  /** Flat string body the route's per-scope builder reads (e.g. { supercategory, family }). */
  params: Record<string, string>;
  /** Cohort size (<= 50 by the time this renders — SPEC §B.3); shown in the label.
   *  Gating itself is done by the parent + the server, not this hint. */
  count?: number;
}) {
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/profile/viewer/context", { cache: "no-store", credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { internal?: boolean } | null) => {
        if (!active || !data?.internal) return;
        setVisible(true);
      })
      .catch(() => {
        /* leave hidden — external viewers never see the control */
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

  // External viewers never see the control (the route would 401 anyway).
  if (!visible) return null;

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
        {typeof count === "number" ? `Download ${count} scholars (CSV)` : "Download scholars (CSV)"}
      </button>
      {error ? (
        <p className="text-[11px] text-[#a0341c]">{error}</p>
      ) : (
        <p className="text-[11px] text-muted-foreground">Complete cohort · internal use</p>
      )}
    </div>
  );
}
