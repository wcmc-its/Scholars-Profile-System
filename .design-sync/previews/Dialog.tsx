import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Button,
  Textarea,
} from "scholars-profile-system";

export function EditProfile() {
  return (
    <Dialog defaultOpen>
      <DialogTrigger asChild>
        <Button variant="outline">Edit profile</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit research profile</DialogTitle>
          <DialogDescription>
            Update the public summary shown on Dr. Elena Vasquez&apos;s profile,
            Department of Cardiology.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <label className="text-sm font-medium text-foreground" htmlFor="dlg-summary">
            Research summary
          </label>
          <Textarea
            id="dlg-summary"
            className="min-h-20"
            defaultValue="Dr. Vasquez studies vascular remodeling in pulmonary hypertension, focusing on endothelial signaling pathways, with funding from NHLBI."
          />
        </div>
        <DialogFooter>
          <Button variant="outline">Cancel</Button>
          <Button>Save changes</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ConfirmRemoveGrant() {
  return (
    <Dialog defaultOpen>
      <DialogTrigger asChild>
        <Button variant="destructive">Remove grant</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove grant record?</DialogTitle>
          <DialogDescription>
            This removes &ldquo;R01 HL142384 — Endothelial Mechanisms in Pulmonary
            Vascular Remodeling&rdquo; (NHLBI) from Dr. Vasquez&apos;s profile. This
            action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline">Cancel</Button>
          <Button variant="destructive">Remove</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
