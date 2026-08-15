import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
  Button,
} from "scholars-profile-system";
import { ChevronDown } from "lucide-react";

export function PublicationsOverflow() {
  return (
    <div className="p-4" style={{ width: 420 }}>
      <div className="space-y-1 text-sm">
        <p className="font-medium text-foreground">
          Ferroptosis-driven tubular injury in acute kidney disease
        </p>
        <p className="text-muted-foreground">
          Vasquez E, Chen L, Okafor N.{" "}
          <span className="italic">J Am Soc Nephrol.</span> 2025.
        </p>
      </div>

      <Collapsible defaultOpen className="mt-3">
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1 px-0 text-muted-foreground hover:text-foreground"
          >
            <ChevronDown className="size-4" />
            Show 8 more publications
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2 space-y-2 border-t border-border pt-2 text-sm">
          <p className="text-foreground">
            Single-cell transcriptomics of renal tubular repair.{" "}
            <span className="text-muted-foreground italic">Nat Med.</span> 2024.
          </p>
          <p className="text-foreground">
            Iron chelation delays progression of CKD in a murine model.{" "}
            <span className="text-muted-foreground italic">Kidney Int.</span> 2024.
          </p>
          <p className="text-foreground">
            GPX4 depletion sensitizes tubular cells to oxidative stress.{" "}
            <span className="text-muted-foreground italic">Cell Rep.</span> 2023.
          </p>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

export function GrantAwardHistory() {
  return (
    <div className="p-4" style={{ width: 420 }}>
      <div className="rounded-md border border-border p-4">
        <p className="text-sm font-medium text-foreground">
          Mechanisms of ferroptosis in acute kidney injury
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          NIH/NIDDK &middot; R01DK123456 &middot; Principal Investigator
        </p>

        <Collapsible defaultOpen className="mt-3">
          <CollapsibleTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="gap-1 text-xs"
            >
              <ChevronDown className="size-3.5" />
              Show award history
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-3 space-y-2 text-xs text-muted-foreground">
            <div className="flex items-center justify-between">
              <span>Competitive renewal (Year 5)</span>
              <span>2024</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Non-competitive continuation (Year 3)</span>
              <span>2022</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Original award</span>
              <span>2020</span>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </div>
  );
}
