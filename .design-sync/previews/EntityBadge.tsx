import { EntityBadge } from "scholars-profile-system";

const row = "flex flex-wrap items-center gap-2 p-4";

export function AllKinds() {
  return (
    <div className={row}>
      <EntityBadge kind="person" />
      <EntityBadge kind="topic" />
      <EntityBadge kind="subtopic" />
      <EntityBadge kind="department" />
      <EntityBadge kind="division" />
      <EntityBadge kind="center" />
      <EntityBadge kind="institute" />
      <EntityBadge kind="method" />
      <EntityBadge kind="concept" />
    </div>
  );
}

export function InSearchResults() {
  return (
    <div className="flex flex-col gap-2 p-4 text-sm">
      <div className="flex items-center gap-2">
        <EntityBadge kind="person" />
        <span>Elena Voss, MD, PhD</span>
      </div>
      <div className="flex items-center gap-2">
        <EntityBadge kind="topic" />
        <span>Tumor immunology</span>
      </div>
      <div className="flex items-center gap-2">
        <EntityBadge kind="department" />
        <span>Department of Medicine</span>
      </div>
      <div className="flex items-center gap-2">
        <EntityBadge kind="center" />
        <span>Sandra and Edward Meyer Cancer Center</span>
      </div>
      <div className="flex items-center gap-2">
        <EntityBadge kind="method" />
        <span>Single-cell RNA sequencing</span>
      </div>
      <div className="flex items-center gap-2">
        <EntityBadge kind="concept" />
        <span>Tumor Microenvironment</span>
      </div>
    </div>
  );
}
