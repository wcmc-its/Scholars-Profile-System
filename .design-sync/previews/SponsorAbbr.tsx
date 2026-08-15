import { SponsorAbbr } from "scholars-profile-system";

export function KnownSponsors() {
  return (
    <ul className="flex flex-col gap-1.5 p-4 text-sm">
      <li>
        <SponsorAbbr short="NCI" /> — Grant 5R01CA249876
      </li>
      <li>
        <SponsorAbbr short="NIAID" /> — Grant 1U01AI178432
      </li>
      <li>
        <SponsorAbbr short="DOD" /> — Grant W81XWH-21-1-0456
      </li>
      <li>
        <SponsorAbbr short="ACS" /> — Research Scholar Grant
      </li>
    </ul>
  );
}

export function UnknownSponsorFallback() {
  return (
    <div className="p-4 text-sm">
      Sponsor: <SponsorAbbr short="Chan Zuckerberg Initiative" />
    </div>
  );
}
