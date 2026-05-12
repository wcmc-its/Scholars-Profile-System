import { cn } from "@/lib/utils";

import type { EntityKind } from "@/lib/api/search";

/**
 * Entity-type badge per design spec §17. Seven categories across four color
 * families: yellow (Topic/Subtopic), green (Department/Division), blue
 * (Person), purple (Center), teal (Institute). Subtopic and Division are
 * lighter shades of their parent. The badge is a metadata tag — small (10px),
 * uppercase, non-interactive — and is reusable anywhere Scholars surfaces a
 * heterogeneous list of entity types (autocomplete, search results, taxonomy
 * callout multi-match).
 *
 * Background fills carry the visual weight; no border. All combinations meet
 * WCAG AA contrast for normal text at 10px size.
 */
const KIND_LABEL: Record<EntityKind, string> = {
  person: "Scholar",
  topic: "Topic",
  subtopic: "Subtopic",
  department: "Department",
  division: "Division",
  center: "Center",
  institute: "Institute",
};

export function EntityBadge({
  kind,
  className,
}: {
  kind: EntityKind;
  className?: string;
}) {
  const label = KIND_LABEL[kind];
  return (
    <span
      aria-label={`Result type: ${label}`}
      className={cn("entity-badge", `entity-badge--${kind}`, className)}
    >
      {label}
    </span>
  );
}
