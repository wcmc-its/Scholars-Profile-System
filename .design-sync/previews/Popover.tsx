import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  Button,
  Badge,
} from "scholars-profile-system";
import { Filter } from "lucide-react";

export function ScholarQuickInfo() {
  return (
    <div className="p-4">
      <Popover defaultOpen>
        <PopoverTrigger asChild>
          <Button variant="outline">Dr. Elena Vasquez</Button>
        </PopoverTrigger>
        <PopoverContent>
          <div className="grid gap-1">
            <p className="text-sm font-semibold text-foreground">
              Dr. Elena Vasquez, MD, PhD
            </p>
            <p className="text-sm text-muted-foreground">
              Associate Professor, Department of Cardiology
            </p>
            <p className="text-sm text-muted-foreground">
              142 publications · h-index 34
            </p>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

export function FilterMenu() {
  return (
    <div className="p-4">
      <Popover defaultOpen>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm">
            <Filter /> Filter results
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-64">
          <div className="grid gap-2">
            <p className="text-sm font-semibold text-foreground">
              Filter by department
            </p>
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="secondary">Cardiology</Badge>
              <Badge variant="secondary">Oncology</Badge>
              <Badge variant="outline">Neurology</Badge>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
