import { ExternalLink } from "lucide-react";

/**
 * #1021 — an outbound link to an org unit's own website, rendered in the
 * department / division / center hero. Renders nothing when `url` is
 * empty/null (the feature is dark-by-default — units carry no URL until a
 * curator sets one).
 *
 * Two variants:
 *   - "icon" (default; division page): an inline external-link arrow beside
 *     the unit NAME, with an accessible label `"{unitName} website"`.
 *   - "text" (Unit Page v2; department + center): a visible text label, e.g.
 *     "Department website", plus a small arrow, right-aligned on the eyebrow
 *     row. The accessible name is the visible label.
 *
 * Opens in a new tab with `rel="noopener noreferrer"` (the URL is
 * curator-supplied, off-site).
 */
export function UnitWebsiteLink({
  url,
  unitName,
  variant = "icon",
  label,
}: {
  url: string | null | undefined;
  unitName: string;
  variant?: "icon" | "text";
  /** Visible label for the "text" variant (e.g. "Department website"). */
  label?: string;
}) {
  if (!url) return null;
  if (variant === "text") {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-apollo-slate inline-flex items-center gap-[5px] text-[13px] whitespace-nowrap no-underline hover:underline"
      >
        {label ?? `${unitName} website`}
        <ExternalLink aria-hidden className="size-3" strokeWidth={2} />
      </a>
    );
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${unitName} website`}
      className="text-muted-foreground hover:text-foreground ml-2 inline-flex -translate-y-1 items-center align-middle"
    >
      <ExternalLink aria-hidden className="size-5" strokeWidth={2} />
    </a>
  );
}
