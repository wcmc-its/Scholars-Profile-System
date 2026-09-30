import { Badge } from "scholars-profile-system";

const row = "flex flex-wrap items-center gap-3 p-4";

export function Variants() {
  return (
    <div className={row}>
      <Badge variant="default">Active grant</Badge>
      <Badge variant="secondary">Emeritus</Badge>
      <Badge variant="outline">Adjunct faculty</Badge>
      <Badge variant="ghost">Draft profile</Badge>
      <Badge variant="link">View full CV</Badge>
      <Badge variant="destructive">Expired</Badge>
    </div>
  );
}

export function GrantStatus() {
  return (
    <div className={row}>
      <Badge variant="default">R01 funded</Badge>
      <Badge variant="secondary">Renewal pending</Badge>
      <Badge variant="outline">No-cost extension</Badge>
      <Badge variant="destructive">Not funded</Badge>
    </div>
  );
}
