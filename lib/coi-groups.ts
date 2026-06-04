/**
 * Conflict-of-interest (COI) disclosure grouping + ordering — the single source
 * of truth shared by the public profile's "External relationships" section
 * (`components/profile/profile-view.tsx`) and the read-only Conflicts of
 * Interest panel on `/edit` (`components/edit/coi-card.tsx`).
 *
 * Disclosures are grouped by `activityGroup`; within a group the entity names
 * are deduped and alpha-sorted. Groups themselves follow `COI_GROUP_ORDER`
 * (mockup order), then any unknown groups alpha, then "Other" last. Extracting
 * this here keeps the two surfaces from drifting — the task requires the panel
 * to render in the SAME order as the profile.
 */

/** One disclosure row, narrowed to the two fields grouping needs. */
export type CoiDisclosure = {
  entity: string | null;
  activityGroup: string | null;
};

/** A group with its deduped, alpha-sorted entity names. */
export type CoiGroup = {
  group: string;
  entities: string[];
};

/** Known groups in mockup order; anything else sorts alpha after these, with
 *  the catch-all "Other" pinned last. Mirrors VIVO's group taxonomy. */
export const COI_GROUP_ORDER = [
  "Leadership Roles",
  "Ownership",
  "Advisory/Scientific Board Member",
  "Professional Services",
  "Speaker/Lecturer",
  "Proprietary Interest",
  "Other Interest",
] as const;

/**
 * Group disclosures by `activityGroup`, dedup + alpha-sort entities within each
 * group, and order the groups by `COI_GROUP_ORDER` (then unknown groups alpha,
 * "Other" last). A disclosure with no `entity` is dropped (nothing to show); a
 * null `activityGroup` buckets to "Other".
 */
export function groupCoiDisclosures(disclosures: readonly CoiDisclosure[]): CoiGroup[] {
  const grouped = new Map<string, Set<string>>();
  for (const d of disclosures) {
    if (!d.entity) continue;
    const key = d.activityGroup ?? "Other";
    const set = grouped.get(key) ?? new Set<string>();
    set.add(d.entity);
    grouped.set(key, set);
  }

  const keys = [...grouped.keys()];
  keys.sort((a, b) => {
    if (a === "Other") return 1;
    if (b === "Other") return -1;
    const ia = COI_GROUP_ORDER.indexOf(a as (typeof COI_GROUP_ORDER)[number]);
    const ib = COI_GROUP_ORDER.indexOf(b as (typeof COI_GROUP_ORDER)[number]);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });

  return keys.map((group) => ({
    group,
    entities: [...grouped.get(group)!].sort((a, b) => a.localeCompare(b)),
  }));
}
