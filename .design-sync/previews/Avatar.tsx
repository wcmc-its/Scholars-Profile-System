import {
  Avatar,
  AvatarImage,
  AvatarFallback,
  AvatarBadge,
  AvatarGroup,
  AvatarGroupCount,
} from "scholars-profile-system";
import { BadgeCheck } from "lucide-react";

const row = "flex flex-wrap items-center gap-4 p-4";

export function Sizes() {
  return (
    <div className={row}>
      <Avatar size="sm">
        <AvatarFallback>EV</AvatarFallback>
      </Avatar>
      <Avatar size="default">
        <AvatarFallback>RK</AvatarFallback>
      </Avatar>
      <Avatar size="lg">
        <AvatarFallback>MT</AvatarFallback>
      </Avatar>
    </div>
  );
}

export function WithImage() {
  return (
    <div className={row}>
      <Avatar size="lg">
        <AvatarImage src="https://i.pravatar.cc/150?img=47" alt="Elena Voss, MD, PhD" />
        <AvatarFallback>EV</AvatarFallback>
      </Avatar>
      <Avatar size="default">
        <AvatarImage src="https://i.pravatar.cc/150?img=12" alt="Rajesh Kapoor, PhD" />
        <AvatarFallback>RK</AvatarFallback>
      </Avatar>
    </div>
  );
}

export function CoInvestigatorGroup() {
  return (
    <div className="p-4">
      <AvatarGroup>
        <Avatar>
          <AvatarFallback>EV</AvatarFallback>
        </Avatar>
        <Avatar>
          <AvatarFallback>RK</AvatarFallback>
        </Avatar>
        <Avatar>
          <AvatarFallback>MT</AvatarFallback>
        </Avatar>
        <AvatarGroupCount>+4</AvatarGroupCount>
      </AvatarGroup>
    </div>
  );
}

export function VerifiedProfileBadge() {
  return (
    <div className={row}>
      <Avatar size="lg">
        <AvatarFallback>EV</AvatarFallback>
        <AvatarBadge>
          <BadgeCheck />
        </AvatarBadge>
      </Avatar>
    </div>
  );
}
