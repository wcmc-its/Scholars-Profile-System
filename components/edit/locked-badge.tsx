import { Lock } from "lucide-react";

/**
 * The single "Locked — managed at its source" pill shown at the top of every
 * read-only attribute panel whose data is owned by another system of record
 * (Name & Title, Photo, Conflicts of Interest). One component so the lock
 * affordance reads identically on every surface and can't drift — the lock cue
 * lives here, not on the rail (the rail items carry only the sr-only note).
 * `label` shortens the copy where the pill sits in a heading row (Positions:
 * "Managed at its source"); the styling never varies.
 */
export function LockedBadge({ label = "Locked — managed at its source" }: { label?: string }) {
  return (
    <span className="bg-apollo-lock-bg border-apollo-border-strong inline-flex w-fit items-center gap-[5px] rounded-full border px-[9px] py-[3px] text-[11.5px] font-medium text-[#3d3833]">
      <Lock className="size-3" aria-hidden />
      {label}
    </span>
  );
}
