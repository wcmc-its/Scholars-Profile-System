import { AbbrTooltip } from "scholars-profile-system";

const label = "text-sm text-foreground";

/**
 * The tooltip bubble opens on hover/focus via internal React state — there is
 * no prop to force it open, so a static capture can only show the base
 * `short` label at rest (abbr element with title/aria-describedby wiring).
 */
export function MechanismCode() {
  return (
    <div className={`${label} p-4`}>
      Funded under an <AbbrTooltip short="R01" expand="NIH Research Project Grant" /> mechanism.
    </div>
  );
}

export function SponsorCode() {
  return (
    <div className={`${label} p-4`}>
      Sponsor: <AbbrTooltip short="NIAID" expand="National Institute of Allergy and Infectious Diseases" />
    </div>
  );
}

export function NoExpansionFallback() {
  return (
    <div className={`${label} p-4`}>
      Institution: <AbbrTooltip short="Weill Cornell Medicine" expand={null} />
    </div>
  );
}
