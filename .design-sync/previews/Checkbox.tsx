import { Checkbox } from "scholars-profile-system";

function Row({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 p-4">
      {children}
      <label htmlFor={id} className="text-sm text-foreground">
        {label}
      </label>
    </div>
  );
}

export function Unchecked() {
  return (
    <Row id="cb-unchecked" label="Show only my department">
      <Checkbox id="cb-unchecked" />
    </Row>
  );
}

export function Checked() {
  return (
    <Row id="cb-checked" label="Include emeritus faculty">
      <Checkbox id="cb-checked" defaultChecked />
    </Row>
  );
}

export function Disabled() {
  return (
    <Row id="cb-disabled" label="Sync ORCID publications (admin only)">
      <Checkbox id="cb-disabled" disabled />
    </Row>
  );
}

export function DisabledChecked() {
  return (
    <Row id="cb-disabled-checked" label="Require CWID for profile edits">
      <Checkbox id="cb-disabled-checked" disabled defaultChecked />
    </Row>
  );
}
