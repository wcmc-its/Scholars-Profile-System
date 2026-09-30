import { Switch } from "scholars-profile-system";

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
    <div className="flex items-center gap-3 p-4">
      {children}
      <label htmlFor={id} className="text-sm text-foreground">
        {label}
      </label>
    </div>
  );
}

export function Off() {
  return (
    <Row id="sw-off" label="Show unpublished grants">
      <Switch id="sw-off" />
    </Row>
  );
}

export function On() {
  return (
    <Row id="sw-on" label="Email me new citation alerts">
      <Switch id="sw-on" defaultChecked />
    </Row>
  );
}

export function Disabled() {
  return (
    <Row id="sw-disabled" label="Auto-import from Scopus (admin only)">
      <Switch id="sw-disabled" disabled />
    </Row>
  );
}
