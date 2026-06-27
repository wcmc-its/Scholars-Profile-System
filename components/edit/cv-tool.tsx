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
 * Below the button is a LIVE, document-ordered outline of the WCM CV (spec §8):
 * every section A–S in the order it appears in the download, each showing what
 * Scholars/POPS fills (count + a capped item preview) vs left blank to complete
 * by hand. Fetched from `GET /api/edit/cv/outline`; clinical sections come from
 * the scholar's POPS profile.
 */
"use client";

import * as React from "react";
import { Check, Download, Minus } from "lucide-react";

import { EditPanel } from "@/components/edit/edit-panel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { CvOutlineEntry, CvOutlineGroup, PopsEnrichment } from "@/lib/edit/cv-export";

const PATH = "/api/edit/cv";
const POPS_PATH = "/api/edit/cv/pops";
const OUTLINE_PATH = "/api/edit/cv/outline";

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
  // Live document-ordered outline of the CV (spec §8). Best-effort, like POPS.
  const [outline, setOutline] = React.useState<CvOutlineGroup[] | null>(null);

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

  React.useEffect(() => {
    const ctrl = new AbortController();
    fetch(`${OUTLINE_PATH}?cwid=${encodeURIComponent(entityId)}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { outline?: CvOutlineGroup[] | null } | null) => {
        if (d?.outline) setOutline(d.outline);
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

      {outline && <CvOutline groups={outline} />}

      {pops && <PopsPreview pops={pops} />}
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
      items: [
        ...pops.honors.map((h) => (h.date ? `${h.date} — ${h.name}` : h.name)),
        ...(pops.castleConnolly ? ["Castle Connolly Top Doctor"] : []),
      ],
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
    {
      label: "Clinical practices",
      section: "Clinical Activities",
      items: pops.practices.map((pr) => (pr.type ? `${pr.name} (${pr.type})` : pr.name)),
    },
    {
      label: "Areas of expertise",
      section: "Clinical Activities",
      items: pops.expertise.length > 0 ? [pops.expertise.join(", ")] : [],
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

/**
 * Live, document-ordered outline of the WCM CV (spec §8) — every template
 * section AND subsection A–S in download order, fetched from
 * `GET /api/edit/cv/outline`. Each section is a bordered, shaded-header block
 * mirroring the CV document; filled entries show their count + a capped item
 * preview, the rest show why they're blank.
 */
function CvOutline({ groups }: { groups: CvOutlineGroup[] }) {
  return (
    <div className="flex flex-col gap-3" data-testid="cv-outline">
      <div>
        <p className="text-foreground text-sm font-semibold">What&rsquo;s in your CV</p>
        <p className="text-muted-foreground text-xs">
          Every section and subsection of the WCM CV, in the order it appears in the download. We
          pre-fill the entries marked below; the rest keep a blank prompt for you to complete.
          Clinical sections come from your WCM physician directory (POPS) and are not added to your
          public Scholars profile.
        </p>
      </div>
      <div className="flex flex-col gap-3">
        {groups.map((g) => (
          <OutlineGroup key={g.code} group={g} />
        ))}
      </div>
    </div>
  );
}

/** One WCM section as a bordered table-like block (D9D9D9 borders + shaded
 *  header row), mirroring the CV document's house style. */
function OutlineGroup({ group }: { group: CvOutlineGroup }) {
  return (
    <div className="overflow-hidden rounded-md border border-[#D9D9D9]">
      <div className="flex items-center gap-2 border-b border-[#D9D9D9] bg-[#D9D9D9]/40 px-3 py-1.5">
        <span className="text-muted-foreground font-mono text-xs">{group.code}</span>
        <span className="text-foreground text-sm font-semibold">{group.label}</span>
      </div>
      <div className="divide-y divide-[#D9D9D9]">
        {group.entries.map((e, i) => (
          <OutlineEntry key={e.code || i} entry={e} />
        ))}
      </div>
    </div>
  );
}

/** One subsection (or a simple section's sole entry): status icon, optional
 *  code+label, a count/status tag, and the capped item preview ("+N more"). */
function OutlineEntry({ entry: e }: { entry: CvOutlineEntry }) {
  const filled = e.status === "filled";
  const remainder = e.count !== null ? e.count - e.items.length : 0;
  const tag =
    e.status === "generated"
      ? "drafted on download"
      : e.status === "empty"
        ? "none yet"
        : e.status === "todo"
          ? "complete by hand"
          : null;
  return (
    <div className="px-3 py-1.5">
      <div className="flex items-center gap-2 text-sm">
        {filled ? (
          <Check className="text-apollo-maroon size-4 shrink-0" aria-hidden />
        ) : (
          <Minus className="text-muted-foreground size-4 shrink-0" aria-hidden />
        )}
        {e.code && <span className="text-muted-foreground font-mono text-xs">{e.code}</span>}
        {e.label && (
          <span className={filled ? "text-foreground font-medium" : "text-muted-foreground"}>
            {e.label}
          </span>
        )}
        {e.count !== null && e.count > 0 && (
          <span className="text-muted-foreground text-xs">· {e.count}</span>
        )}
        {e.source === "pops" && filled && (
          <span className="text-muted-foreground/70 text-xs">· POPS</span>
        )}
        {tag && <span className="text-muted-foreground/70 text-xs">· {tag}</span>}
      </div>
      {e.items.length > 0 && (
        <ul className="text-muted-foreground mt-0.5 ml-6 flex flex-col gap-0.5 text-xs">
          {e.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
          {remainder > 0 && <li className="italic">+{remainder} more</li>}
        </ul>
      )}
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
