import { RadioGroup, RadioGroupItem } from "scholars-profile-system";

function OptionRow({
  id,
  label,
  disabled,
}: {
  id: string;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <RadioGroupItem id={id} value={id} disabled={disabled} />
      <label
        htmlFor={id}
        className={disabled ? "text-sm text-muted-foreground" : "text-sm text-foreground"}
      >
        {label}
      </label>
    </div>
  );
}

export function SortOrder() {
  return (
    <div className="p-4">
      <RadioGroup defaultValue="cited" className="gap-3">
        <OptionRow id="cited" label="Most cited" />
        <OptionRow id="recent" label="Most recent" />
        <OptionRow id="alpha" label="Alphabetical" />
      </RadioGroup>
    </div>
  );
}

export function VisibilityWithDisabled() {
  return (
    <div className="p-4">
      <RadioGroup defaultValue="public" className="gap-3">
        <OptionRow id="public" label="Public profile" />
        <OptionRow id="dept-only" label="Department only" />
        <OptionRow id="private" label="Private (requires admin approval)" disabled />
      </RadioGroup>
    </div>
  );
}
