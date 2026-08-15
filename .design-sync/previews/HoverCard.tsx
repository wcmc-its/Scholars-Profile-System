import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  Avatar,
  AvatarFallback,
} from "scholars-profile-system";

export function CoAuthorPreview() {
  return (
    <div className="p-4">
      <HoverCard open>
        <HoverCardTrigger href="#" className="text-sm font-medium text-primary underline-offset-4 hover:underline">
          Dr. Raj Patel
        </HoverCardTrigger>
        <HoverCardContent className="w-60">
          <div className="flex gap-2">
            <Avatar>
              <AvatarFallback>RP</AvatarFallback>
            </Avatar>
            <div className="grid gap-0.5">
              <p className="text-sm font-semibold text-foreground">
                Dr. Raj Patel, MD
              </p>
              <p className="text-sm text-muted-foreground">
                Hematology &amp; Oncology
              </p>
              <p className="text-sm text-muted-foreground">
                9 shared pubs since 2019
              </p>
            </div>
          </div>
        </HoverCardContent>
      </HoverCard>
    </div>
  );
}

export function GrantFunderPreview() {
  return (
    <div className="p-4">
      <HoverCard open>
        <HoverCardTrigger href="#" className="text-sm font-medium text-primary underline-offset-4 hover:underline">
          NCI
        </HoverCardTrigger>
        <HoverCardContent align="start" className="w-56">
          <div className="grid gap-0.5">
            <p className="text-sm font-semibold text-foreground">
              National Cancer Institute
            </p>
            <p className="text-sm text-muted-foreground">
              Funds 3 active grants in this department, totaling $4.2M in
              annual direct costs.
            </p>
          </div>
        </HoverCardContent>
      </HoverCard>
    </div>
  );
}
