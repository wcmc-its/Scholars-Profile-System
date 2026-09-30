import { Separator } from "scholars-profile-system";

export function HorizontalBetweenSections() {
  return (
    <div className="p-4" style={{ width: 320 }}>
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-foreground">
          Cardiology
        </span>
        <span className="text-xs text-muted-foreground">
          Department of Medicine &middot; 38 faculty
        </span>
      </div>
      <Separator className="my-4" />
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-foreground">
          Endocrinology, Diabetes &amp; Metabolism
        </span>
        <span className="text-xs text-muted-foreground">
          Department of Medicine &middot; 21 faculty
        </span>
      </div>
    </div>
  );
}

export function VerticalBetweenLabels() {
  return (
    <div className="p-4">
      <div className="flex h-10 items-center gap-4 text-sm">
        <span className="text-foreground">42 Publications</span>
        <Separator orientation="vertical" />
        <span className="text-foreground">3 Active Grants</span>
        <Separator orientation="vertical" />
        <span className="text-foreground">7 Co-Investigators</span>
      </div>
    </div>
  );
}
