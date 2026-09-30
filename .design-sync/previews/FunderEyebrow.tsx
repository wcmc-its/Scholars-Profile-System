import { FunderEyebrow } from "scholars-profile-system";

const eyebrow = "text-xs font-medium uppercase tracking-wide text-muted-foreground";

export function KnownSponsors() {
  return (
    <div className="flex flex-col gap-2 p-4">
      <FunderEyebrow short="NCI" className={eyebrow} />
      <FunderEyebrow short="NHLBI" className={eyebrow} />
      <FunderEyebrow short="NIAID" className={eyebrow} />
    </div>
  );
}

export function UnknownSponsorFallback() {
  return (
    <div className="p-4">
      <FunderEyebrow short="Doris Duke Charitable Foundation" className={eyebrow} />
    </div>
  );
}
