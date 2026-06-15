import { ExternalLink } from "lucide-react";

/**
 * #1021 — a small inline outbound link to an org unit's own website, rendered
 * beside the unit NAME in the department / division / center hero. Renders
 * nothing when `url` is empty/null (the feature is dark-by-default — units carry
 * no URL until a curator sets one).
 *
 * Unlike the unit `description` (a paragraph below the name), this is an inline
 * external-link arrow: the visible target is just the arrow, with an accessible
 * label `"{unitName} website"`. Opens in a new tab with `rel="noopener
 * noreferrer"` (the URL is curator-supplied, off-site).
 */
export function UnitWebsiteLink({
  url,
  unitName,
}: {
  url: string | null | undefined;
  unitName: string;
}) {
  if (!url) return null;
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
