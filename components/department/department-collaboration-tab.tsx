"use client";

/**
 * Department Collaboration tab — the department's co-authorship network, with
 * divisions as the colour groups. A thin wrapper over the shared
 * `UnitCollaborationNetwork` (the same body as the center tab, #1137). Imports
 * only DB-free modules: this is a client component.
 */
import { UnitCollaborationNetwork } from "@/components/shared/unit-collaboration-network";
import type { CollabVocab } from "@/lib/center-collaboration/types";

/** Module-level so the network's memoised graph build sees a stable object. */
const DEPARTMENT_VOCAB: CollabVocab = {
  group: "division",
  groups: "divisions",
  allGroups: "All divisions",
  unitNoun: "department",
  memberNoun: "members",
  unclassifiedLabel: "No division",
};

export function DepartmentCollaborationTab({
  deptSlug,
  deptName,
}: {
  deptSlug: string;
  deptName: string;
}) {
  return (
    <UnitCollaborationNetwork
      dataUrl={`/api/departments/${encodeURIComponent(deptSlug)}/collaboration`}
      exportSlug={deptSlug}
      unitName={deptName}
      vocab={DEPARTMENT_VOCAB}
    />
  );
}
