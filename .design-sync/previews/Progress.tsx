import { Progress } from "scholars-profile-system";

function Row({
  label,
  value,
}: {
  label: string;
  value: number;
}) {
  return (
    <div className="flex flex-col gap-1.5 p-4" style={{ width: 320 }}>
      <div className="flex items-center justify-between text-sm text-foreground">
        <span>{label}</span>
        <span className="text-muted-foreground">{value}%</span>
      </div>
      <Progress value={value} />
    </div>
  );
}

export function Started() {
  return <Row label="R01 funding period used" value={25} />;
}

export function InProgress() {
  return <Row label="Profile completeness" value={70} />;
}

export function Complete() {
  return <Row label="Publication import: NIH Grant 5R01CA219442" value={100} />;
}
