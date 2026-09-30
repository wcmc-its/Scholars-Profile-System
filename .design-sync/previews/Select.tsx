import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "scholars-profile-system";

function SortSelect(props: React.ComponentProps<typeof Select>) {
  return (
    <Select defaultValue="relevance" {...props}>
      <SelectTrigger className="w-56">
        <SelectValue placeholder="Sort by" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>Sort by</SelectLabel>
          <SelectItem value="relevance">Relevance</SelectItem>
          <SelectItem value="recent">Most recent</SelectItem>
          <SelectItem value="cited">Most cited</SelectItem>
        </SelectGroup>
        <SelectSeparator />
        <SelectGroup>
          <SelectLabel>Scope</SelectLabel>
          <SelectItem value="dept">This department</SelectItem>
          <SelectItem value="all" disabled>
            All of WCM (coming soon)
          </SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

export function Closed() {
  return (
    <div className="p-4">
      <SortSelect />
    </div>
  );
}

export function Open() {
  return (
    <div className="p-4" style={{ minHeight: 260 }}>
      <SortSelect defaultOpen />
    </div>
  );
}

export function SmallSize() {
  return (
    <div className="p-4">
      <Select defaultValue="dept">
        <SelectTrigger size="sm" className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="dept">Department</SelectItem>
          <SelectItem value="center">Center</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
