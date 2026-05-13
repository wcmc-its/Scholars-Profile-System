import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";

/**
 * Shared header for PersonPopover bodies — avatar (lg) + name + primary title
 * + dept line. Drops "Weill Cornell Medicine" trailing affiliation everywhere
 * per #242.
 */
export function PersonCardHeader({
  cwid,
  preferredName,
  primaryTitle,
  primaryDepartment,
  identityImageEndpoint,
}: {
  cwid: string;
  preferredName: string;
  primaryTitle: string | null;
  primaryDepartment: string | null;
  identityImageEndpoint: string;
}) {
  return (
    <div className="grid grid-cols-[48px_1fr] items-start gap-3">
      <HeadshotAvatar
        size="md"
        cwid={cwid}
        preferredName={preferredName}
        identityImageEndpoint={identityImageEndpoint}
      />
      <div className="min-w-0">
        <div className="text-sm font-semibold leading-tight">{preferredName}</div>
        {primaryTitle ? (
          <div className="mt-0.5 text-xs leading-snug text-foreground/80">
            {primaryTitle}
          </div>
        ) : null}
        {primaryDepartment ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {primaryDepartment}
          </div>
        ) : null}
      </div>
    </div>
  );
}
