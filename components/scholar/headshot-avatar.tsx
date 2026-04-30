"use client";

import { useState } from "react";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { cn, initials } from "@/lib/utils";

type HeadshotState = "loading" | "image" | "fallback";

const SIZE_CLASS: Record<"sm" | "md" | "lg", string> = {
  sm: "size-6",
  md: "h-12 w-12",
  lg: "h-24 w-24 sm:h-28 sm:w-28",
};

const FALLBACK_TEXT_CLASS: Record<"sm" | "md" | "lg", string> = {
  sm: "text-xs",
  md: "text-sm",
  lg: "text-xl",
};

export function HeadshotAvatar({
  cwid,
  preferredName,
  identityImageEndpoint,
  size,
  className,
}: {
  cwid: string;
  preferredName: string;
  identityImageEndpoint: string;
  size: "sm" | "md" | "lg";
  className?: string;
}) {
  const [imgStatus, setImgStatus] = useState<"loading" | "loaded" | "error">(
    "loading"
  );
  const noImage = !identityImageEndpoint || !cwid;

  const dataState: HeadshotState = noImage
    ? "fallback"
    : imgStatus === "loaded"
      ? "image"
      : imgStatus === "error"
        ? "fallback"
        : "loading";

  return (
    <Avatar
      data-headshot-state={dataState}
      className={cn(SIZE_CLASS[size], "shrink-0", className)}
    >
      {!noImage && (
        <AvatarImage
          src={identityImageEndpoint}
          alt={preferredName}
          className="aspect-square h-full w-full object-cover object-top"
          onLoadingStatusChange={(s) =>
            setImgStatus(
              s === "loaded" ? "loaded" : s === "error" ? "error" : "loading"
            )
          }
        />
      )}
      <AvatarFallback className={FALLBACK_TEXT_CLASS[size]}>
        {initials(preferredName)}
      </AvatarFallback>
    </Avatar>
  );
}
