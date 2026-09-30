import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  Button,
} from "scholars-profile-system";
import { Info, Download } from "lucide-react";

export function IconLabel() {
  return (
    <TooltipProvider>
      <div className="flex items-center justify-center p-8">
        <Tooltip defaultOpen>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Field help">
              <Info />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Open access version available</TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}

export function ButtonLabel() {
  return (
    <TooltipProvider>
      <div className="flex items-center justify-center p-8">
        <Tooltip defaultOpen>
          <TooltipTrigger asChild>
            <Button variant="outline" size="icon-sm" aria-label="Download CV">
              <Download />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Download CV (PDF)</TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}
