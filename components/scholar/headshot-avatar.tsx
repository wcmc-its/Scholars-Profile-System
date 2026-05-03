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

// Deterministic warm two-tone gradient from a name string.
const GRADIENTS = [
  ["#c2a3a3", "#a07575"],
  ["#a3b4c2", "#7590a0"],
  ["#a3c2b4", "#75a08f"],
  ["#c2b4a3", "#a08f75"],
  ["#b4a3c2", "#8f75a0"],
  ["#c2c2a3", "#a0a075"],
  ["#a3b8c2", "#7598a0"],
  ["#c2a3b4", "#a07590"],
];

function nameGradient(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  const [a, b] = GRADIENTS[Math.abs(h) % GRADIENTS.length];
  return `linear-gradient(135deg, ${a}, ${b})`;
}

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
      <AvatarFallback
        className={FALLBACK_TEXT_CLASS[size]}
        style={{ background: nameGradient(preferredName), color: "rgba(255,255,255,0.92)" }}
      >
        {initials(preferredName)}
      </AvatarFallback>
    </Avatar>
  );
}
