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
import type { PopsEnrichment } from "@/lib/edit/cv-export";

const PATH = "/api/edit/cv";
const POPS_PATH = "/api/edit/cv/pops";

/** Consent/transparency copy for the live POPS preview (spec §6b). */
const POPS_USAGE =
  "These clinical credentials come from your WCM physician profile (POPS) and are used to fill your CV's board-certification, training, hospital-appointment, and honors sections. They're shown here so you can see what will be included — they are not added to your public Scholars profile.";

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
  // Live POPS enrichment for the transparency preview (spec §6b). Best-effort:
  // a failure or a non-clinical scholar simply renders no preview. /edit only —
  // this data is never shown on the public profile.
  const [pops, setPops] = React.useState<PopsEnrichment | null>(null);

  React.useEffect(() => {
    const ctrl = new AbortController();
    fetch(`${POPS_PATH}?cwid=${encodeURIComponent(entityId)}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { pops?: PopsEnrichment | null } | null) => {
        if (d?.pops) setPops(d.pops);
      })
      .catch(() => {
        /* best-effort preview — stay silent on failure */
      });
    return () => ctrl.abort();
  }, [entityId]);

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

      {pops && <PopsPreview pops={pops} />}

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

/** Pull a 4-digit year from an ISO/loose date string; "" when absent. */
function popsYear(date: string | null): string {
  if (!date) return "";
  const m = /(\d{4})/.exec(date);
  return m ? m[1]! : "";
}

/** "YYYY–YYYY", "YYYY–Present", "YYYY", or "" — never fabricates a date. */
function popsRange(start: string | null, end: string | null): string {
  const s = popsYear(start);
  const e = popsYear(end) || (start && !end ? "Present" : "");
  if (!s && !e) return "";
  return s && e ? `${s}–${e}` : s || e;
}

export type PopsPreviewGroup = { label: string; section: string; items: string[] };

/**
 * Map a `PopsEnrichment` to the preview's display groups — each tagged with the
 * CV section it feeds — dropping any group with no items. Pure (exported for the
 * unit test). The `→ CV <section>` tags are presentation, so they live here, not
 * in the API response.
 */
export function buildPopsPreviewGroups(pops: PopsEnrichment): PopsPreviewGroup[] {
  return [
    {
      label: "Board certifications",
      section: "Board Certification",
      items: pops.boardCertifications.map((c) =>
        c.specialty ? `${c.board} (${c.specialty})` : c.board,
      ),
    },
    {
      label: "Residency & fellowship training",
      section: "Postdoctoral Training",
      items: pops.training.map((t) => `${t.type} — ${t.institution}`),
    },
    {
      label: "Hospital appointments",
      section: "Positions / Affiliation",
      items: pops.appointments.map((a) => {
        const r = popsRange(a.start, a.end);
        return r ? `${a.title}, ${a.institution} (${r})` : `${a.title}, ${a.institution}`;
      }),
    },
    {
      label: "Honors & awards",
      section: "Honors and Awards",
      items: pops.honors.map((h) => (h.date ? `${h.date} — ${h.name}` : h.name)),
    },
    {
      label: "Degrees",
      section: "Education",
      items: pops.degrees.map(
        (d) => `${d.degree}${d.year ? `, ${d.year}` : ""} — ${d.institution}`,
      ),
    },
    {
      label: "Clinical specialties",
      section: "Clinical Activities",
      items: pops.specialties.length > 0 ? [pops.specialties.join(", ")] : [],
    },
    { label: "NPI", section: "Licensure", items: pops.npi ? [pops.npi] : [] },
  ].filter((g) => g.items.length > 0);
}

/**
 * Live, read-only preview of the POPS (WCM physician-directory) data that will
 * fill this scholar's CV — the §6b transparency surface. Each group is tagged
 * with the CV section it feeds; renders nothing when POPS carries no usable data.
 */
function PopsPreview({ pops }: { pops: PopsEnrichment }) {
  const groups = buildPopsPreviewGroups(pops);
  if (groups.length === 0) return null;

  return (
    <div
      className="border-apollo-border bg-apollo-surface-2 flex flex-col gap-3 rounded-md border p-4"
      data-testid="cv-pops-preview"
    >
      <p className="text-foreground text-sm font-semibold">
        Clinical credentials (from your WCM physician directory)
      </p>
      <p className="text-muted-foreground text-xs">{POPS_USAGE}</p>
      <div className="flex flex-col gap-3">
        {groups.map((g) => (
          <div key={g.label} className="flex flex-col gap-1">
            <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              {g.label}{" "}
              <span className="text-muted-foreground/70 normal-case">→ CV {g.section}</span>
            </p>
            <ul className="flex flex-col gap-1 text-sm">
              {g.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
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
