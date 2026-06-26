/**
 * `CvTool` — the client island for the "CV (WCM format)" Tools panel (CV
 * generator spec §8). Unlike {@link BiosketchTool} (an NDJSON prose stream),
 * this is a one-shot **download tool**: a single primary button POSTs to
 * `POST /api/edit/cv`, receives the assembled `.docx` as an attachment blob, and
 * triggers a browser download (`createObjectURL` + anchor), mirroring the
 * superuser debug-payload download in `biosketch-tool.tsx`.
 *
 * The request runs one Bedrock call (the §15 research-activities summary), so the
 * button shows a disabled "Generating…" state for the few seconds it takes. A
 * pre-stream rejection is a buffered JSON `editError` (`{ ok: false, error }`),
 * mapped to a friendly message exactly like the other `/api/edit/*` clients; a
 * 404 (flag off / no scholar) is surfaced as "not available."
 *
 * Below the button is a STATIC, honest checklist of which WCM sections get
 * auto-filled vs left "N/A" (spec §3/§5) — expectation-setting, not live data.
 * The clinical-only group only fills for faculty with a POPS profile.
 */
"use client";

import * as React from "react";
import { Check, Download, Minus } from "lucide-react";

import { EditPanel } from "@/components/edit/edit-panel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

const PATH = "/api/edit/cv";

// User-facing copy, kept as named constants (one place, asserted in tests).
const NOT_AVAILABLE =
  "CV export isn't available right now. If this keeps happening, contact the Scholars team.";
const INSUFFICIENT =
  "We don't have enough of your work indexed to build a CV yet. Review My Publications first, then try again.";
const FORBIDDEN = "You don't have permission to export this CV.";
const FAILED = "We couldn't build your CV just now. Please try again.";

/** Sections Scholars always fills (the research spine) — spec §5. */
const FILLED_SCHOLARS: readonly string[] = [
  "Bibliography — your confirmed publications, with your name bolded",
  "Research support — your WCM-administered grants",
  "Research activities — an AI-drafted summary of your work",
  "Mentoring — your trainees (only those you haven't hidden)",
  "Professional positions — your appointments",
  "Education — your degrees",
  "Postdoctoral training",
  "Institutional leadership — current Chair / Chief / Director roles",
  "Personal data — your name, and email if it's set to visible",
];

/** Sections that fill ONLY for clinical faculty, from the WCM physician
 *  directory (POPS) — spec §6. Empty for research/PhD faculty. */
const FILLED_CLINICAL: readonly string[] = [
  "Board certifications",
  "Residency & fellowship training",
  "Hospital appointments & affiliation",
  "Honors & awards",
  "NPI number",
];

/** Sections with no source anywhere — emitted as "N/A" for you to complete by
 *  hand (the WCM template forbids deleting sections) — spec §5/§11. */
const LEFT_NA: readonly string[] = [
  "Society memberships",
  "Committee & administrative service",
  "Extramural & editorial service",
  "Invitations to speak",
  "Teaching & educational contributions",
  "Licensure dates",
  "Percent effort",
  "Patents",
];

export type CvToolProps = {
  /** The scholar the CV is generated for (self cwid or the delegated `[cwid]`). */
  entityId: string;
  /**
   * Accepted for rail-registration parity with the other Tools panels. The CV
   * download has no per-run cost or model-selection UI (it's a deterministic
   * document with one fixed M1 call), so these are intentionally unused.
   */
  canSeeCost?: boolean;
  model?: string;
};

export function CvTool({ entityId }: CvToolProps) {
  const [isGenerating, setIsGenerating] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function download() {
    if (isGenerating) return;
    setIsGenerating(true);
    setError(null);
    try {
      const res = await fetch(PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Send both keys so the request satisfies the route whether it reads
        // `entityId` (biosketch-style preamble) or `cwid` (target/defaults-to-session).
        body: JSON.stringify({ entityId, cwid: entityId }),
      });
      // Any non-2xx is a buffered JSON `editError`, not the file — surface it.
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(mapErrorToMessage(res.status, typeof data?.error === "string" ? data.error : ""));
        return;
      }
      // 200 ⇒ the `.docx` attachment bytes; pull the filename from the
      // Content-Disposition header the route set, with a sane fallback.
      const blob = await res.blob();
      const filename = filenameFromResponse(res) ?? "cv-wcm.docx";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError(FAILED);
    } finally {
      setIsGenerating(false);
    }
  }

  return (
    <EditPanel
      slot="cv-tool"
      heading="CV (WCM format)"
      description="Pre-fill the official WCM faculty CV from your Scholars data, then complete the rest. This is a starting point, not a finished CV."
    >
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="apollo"
          onClick={download}
          disabled={isGenerating}
          data-testid="cv-download"
        >
          <Download className="size-4" />
          {isGenerating ? "Generating…" : "Download CV (WCM format)"}
        </Button>
        <span className="text-muted-foreground text-sm">
          {isGenerating
            ? "Drafting your research summary and assembling the document — this can take a few seconds."
            : "Downloads a Word (.docx) file in the WCM faculty CV format."}
        </span>
      </div>

      {error && (
        <Alert variant="destructive" data-testid="cv-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div
        className="border-apollo-border bg-apollo-surface-2 flex flex-col gap-4 rounded-md border p-4"
        data-testid="cv-checklist"
      >
        <p className="text-foreground text-sm font-semibold">What we can fill in</p>

        <ChecklistGroup
          icon="check"
          title="Auto-filled from your Scholars data"
          items={FILLED_SCHOLARS}
        />
        <ChecklistGroup
          icon="check"
          title="Filled for clinical faculty only (from the WCM physician directory)"
          items={FILLED_CLINICAL}
        />
        <ChecklistGroup
          icon="na"
          title={'Left blank ("N/A") for you to complete'}
          items={LEFT_NA}
        />
      </div>
    </EditPanel>
  );
}

/** One labelled group of the fill checklist. `check` ⇒ a filled section,
 *  `na` ⇒ a section we leave as "N/A" (muted). */
function ChecklistGroup({
  icon,
  title,
  items,
}: {
  icon: "check" | "na";
  title: string;
  items: readonly string[];
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{title}</p>
      <ul className="flex flex-col gap-1.5 text-sm">
        {items.map((label) => (
          <li key={label} className="flex items-start gap-2">
            {icon === "check" ? (
              <Check className="text-apollo-maroon mt-0.5 size-4 shrink-0" aria-hidden />
            ) : (
              <Minus className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
            )}
            <span className={icon === "na" ? "text-muted-foreground" : undefined}>{label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Map a route status/error code to a user-facing string. The route's codes:
 *  `not_found` / `scholar_not_found` (404 — flag off or no scholar),
 *  `not_self` / `proxy_conflict` (403), `insufficient_facts` (422), and the
 *  shape/`write_failed` errors that fall to the generic message. */
function mapErrorToMessage(status: number, code: string): string {
  if (status === 404) return NOT_AVAILABLE;
  if (status === 403) return FORBIDDEN;
  switch (code) {
    case "insufficient_facts":
      return INSUFFICIENT;
    case "not_found":
    case "scholar_not_found":
      return NOT_AVAILABLE;
    case "not_self":
    case "proxy_conflict":
      return FORBIDDEN;
    default:
      return FAILED;
  }
}

/** Pull the attachment filename out of the response's Content-Disposition header.
 *  Returns null when absent/unparseable so the caller falls back to a default. */
function filenameFromResponse(res: Response): string | null {
  const cd = res.headers.get("content-disposition");
  if (!cd) return null;
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}
