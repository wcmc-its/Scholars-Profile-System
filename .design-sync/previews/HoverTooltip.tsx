import { HoverTooltip, Badge } from "scholars-profile-system";

/**
 * HoverTooltip's bubble is Radix Tooltip state with no `open`/`defaultOpen`
 * prop exposed to the caller, so it cannot be forced open for a static
 * capture (same limitation as AbbrTooltip). These stories render the
 * resting/closed trigger with realistic content — the composition a
 * designer would actually author, just without the hover bubble visible.
 */

export function AuthorChip() {
  return (
    <div className="p-6">
      <HoverTooltip text="Associate Professor of Medicine, Division of Nephrology">
        <Badge variant="secondary">E. Vasquez</Badge>
      </HoverTooltip>
    </div>
  );
}

export function GrantRoleChip() {
  return (
    <div className="p-6">
      <HoverTooltip text="Principal Investigator" placement="bottom">
        <Badge>PI</Badge>
      </HoverTooltip>
    </div>
  );
}

export function MeshConceptChip() {
  return (
    <div className="p-6">
      <HoverTooltip
        wide
        immediate
        text="Ferroptosis: an iron-dependent form of regulated cell death characterized by lipid peroxidation, distinct from apoptosis and necrosis."
      >
        <Badge variant="outline">Ferroptosis</Badge>
      </HoverTooltip>
    </div>
  );
}
