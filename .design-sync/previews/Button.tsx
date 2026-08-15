import { Button } from "scholars-profile-system";
import { Download, Trash2 } from "lucide-react";

const row = "flex flex-wrap items-center gap-3 p-4";

export function Variants() {
  return (
    <div className={row}>
      <Button variant="default">Default</Button>
      <Button variant="secondary">Secondary</Button>
      <Button variant="outline">Outline</Button>
      <Button variant="ghost">Ghost</Button>
      <Button variant="link">Link</Button>
      <Button variant="apollo">Apollo</Button>
      <Button variant="destructive">Destructive</Button>
    </div>
  );
}

export function Sizes() {
  return (
    <div className={row}>
      <Button size="xs">Extra small</Button>
      <Button size="sm">Small</Button>
      <Button size="default">Default</Button>
      <Button size="lg">Large</Button>
      <Button size="icon" aria-label="Download">
        <Download />
      </Button>
    </div>
  );
}

export function WithIcon() {
  return (
    <div className={row}>
      <Button variant="default">
        <Download /> Download report
      </Button>
      <Button variant="destructive">
        <Trash2 /> Delete
      </Button>
    </div>
  );
}

export function Disabled() {
  return (
    <div className={row}>
      <Button disabled>Default</Button>
      <Button variant="outline" disabled>
        Outline
      </Button>
      <Button variant="apollo" disabled>
        Apollo
      </Button>
    </div>
  );
}
