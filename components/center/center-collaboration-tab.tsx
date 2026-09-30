"use client";

/**
 * Cancer Center collaboration network — interactive tab (#1137).
 *
 * A thin wrapper over the shared `UnitCollaborationNetwork` (the full control
 * bar, program picker and vis-network graph live there): points it at the
 * center's route and supplies the "program" wording. See
 * `docs/cancer-center-collaboration-network-spec.md` §6.
 */
import { UnitCollaborationNetwork } from "@/components/shared/unit-collaboration-network";
import type { CollabVocab } from "@/lib/center-collaboration/types";

/** Module-level so the network's memoised graph build sees a stable object. */
const CENTER_VOCAB: CollabVocab = {
  group: "program",
  groups: "programs",
  allGroups: "All programs",
  unitNoun: "center",
  memberNoun: "members",
  unclassifiedLabel: "Unclassified",
};

export function CenterCollaborationTab({
  centerSlug,
  centerName,
}: {
  centerSlug: string;
  /** Center display name — the standalone-HTML export title. */
  centerName: string;
}) {
  return (
    <UnitCollaborationNetwork
      dataUrl={`/api/centers/${encodeURIComponent(centerSlug)}/collaboration`}
      exportSlug={centerSlug}
      unitName={centerName}
      vocab={CENTER_VOCAB}
    />
  );
}
