import { Input } from "scholars-profile-system";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 p-4" style={{ width: 280 }}>
      <label className="text-sm font-medium text-foreground">{label}</label>
      {children}
    </div>
  );
}

export function Empty() {
  return (
    <Field label="Search publications">
      <Input placeholder="Search by title, journal, or PMID" />
    </Field>
  );
}

export function Filled() {
  return (
    <Field label="Department">
      <Input defaultValue="Department of Medicine" />
    </Field>
  );
}

export function Disabled() {
  return (
    <Field label="Cornell WCM ID">
      <Input defaultValue="pbl2024" disabled />
    </Field>
  );
}

export function Invalid() {
  return (
    <Field label="ORCID iD">
      <Input defaultValue="0000-0002-1825" aria-invalid="true" />
    </Field>
  );
}
