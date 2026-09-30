import { Textarea } from "scholars-profile-system";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 p-4" style={{ width: 320 }}>
      <label className="text-sm font-medium text-foreground">{label}</label>
      {children}
    </div>
  );
}

export function Empty() {
  return (
    <Field label="Research summary">
      <Textarea placeholder="Briefly describe your current research interests" />
    </Field>
  );
}

export function Filled() {
  return (
    <Field label="Reason for suppression">
      <Textarea defaultValue="Duplicate record already merged into PMID 38221190." />
    </Field>
  );
}

export function Disabled() {
  return (
    <Field label="Bio (locked pending review)">
      <Textarea
        defaultValue="Dr. Nguyen's lab studies vascular biology and endothelial signaling in diabetic retinopathy."
        disabled
      />
    </Field>
  );
}

export function Invalid() {
  return (
    <Field label="Grant abstract">
      <Textarea placeholder="Required for R01 submissions" aria-invalid="true" />
    </Field>
  );
}
