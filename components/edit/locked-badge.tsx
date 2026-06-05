import { Lock } from "lucide-react";

/**
 * The single "Locked — managed at its source" pill shown at the top of every
 * read-only attribute panel whose data is owned by another system of record
 * (Name & Title, Photo, Conflicts of Interest). One component so the lock
 * affordance reads identically on every surface and can't drift — the lock cue
 * lives here, not on the rail (the rail items carry only the sr-only note).
 */
export function LockedBadge() {
  return (
    <span className="bg-apollo-lock-bg border-apollo-border text-muted-foreground inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium">
      <Lock className="size-3" aria-hidden />
      Locked — managed at its source
    </span>
  );
}
