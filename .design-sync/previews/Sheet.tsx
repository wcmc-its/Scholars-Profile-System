import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  Button,
  Badge,
} from "scholars-profile-system";

export function GrantSources() {
  return (
    <Sheet defaultOpen>
      <SheetTrigger asChild>
        <Button variant="outline">View sources</Button>
      </SheetTrigger>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>Data sources</SheetTitle>
          <SheetDescription>
            Records contributing to this grant on Dr. Elena Vasquez&apos;s
            profile.
          </SheetDescription>
        </SheetHeader>
        <div className="grid gap-3 p-4">
          <div className="grid gap-1 rounded-md border border-border p-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-foreground">
                NIH RePORTER
              </p>
              <Badge variant="secondary">Verified</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              R01 HL142384 · NHLBI · synced Aug 12, 2026
            </p>
          </div>
          <div className="grid gap-1 rounded-md border border-border p-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-foreground">
                InfoEd (Weill Cornell)
              </p>
              <Badge variant="outline">Institutional</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              Award #WCM-2024-08831 · synced Aug 10, 2026
            </p>
          </div>
        </div>
        <SheetFooter>
          <Button variant="outline">Close</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

export function EditGrantPanel() {
  return (
    <Sheet defaultOpen>
      <SheetTrigger asChild>
        <Button variant="outline">Edit grant</Button>
      </SheetTrigger>
      <SheetContent side="left">
        <SheetHeader>
          <SheetTitle>Edit grant details</SheetTitle>
          <SheetDescription>
            Update funding details for &ldquo;Endothelial Mechanisms in
            Pulmonary Vascular Remodeling.&rdquo;
          </SheetDescription>
        </SheetHeader>
        <div className="grid gap-3 p-4 text-sm">
          <div>
            <p className="font-medium text-foreground">Funder</p>
            <p className="text-muted-foreground">
              National Heart, Lung, and Blood Institute (NHLBI)
            </p>
          </div>
          <div>
            <p className="font-medium text-foreground">Award number</p>
            <p className="text-muted-foreground">R01 HL142384</p>
          </div>
          <div>
            <p className="font-medium text-foreground">Period</p>
            <p className="text-muted-foreground">Sep 2023 – Aug 2028</p>
          </div>
        </div>
        <SheetFooter>
          <Button variant="outline">Cancel</Button>
          <Button>Save changes</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
