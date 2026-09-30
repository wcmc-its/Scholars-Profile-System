import { Skeleton } from "scholars-profile-system";

export function ScholarCardLoading() {
  return (
    <div className="flex items-center gap-3 p-4" style={{ width: 320 }}>
      <Skeleton className="h-14 w-14 shrink-0 rounded-full" />
      <div className="min-w-0 flex-1 space-y-2">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-3 w-56" />
      </div>
    </div>
  );
}

export function PublicationRowLoading() {
  return (
    <div className="space-y-2 p-4" style={{ width: 420 }}>
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-3 w-52" />
      <div className="flex flex-wrap gap-1.5 pt-1">
        <Skeleton className="h-6 w-24 rounded-full" />
        <Skeleton className="h-6 w-24 rounded-full" />
        <Skeleton className="h-6 w-20 rounded-full" />
      </div>
    </div>
  );
}

export function GrantsPanelLoading() {
  return (
    <div className="space-y-4 p-4" style={{ width: 380 }}>
      <Skeleton className="h-3 w-24" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="space-y-1.5">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-3 w-40" />
        </div>
      ))}
    </div>
  );
}
