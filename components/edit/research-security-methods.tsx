"use client";

/**
 * The Methods & assumptions section of `/edit/research-security`, collapsed by
 * default: it is longer than most of the tables above it. A link to `#methods`
 * (the screening notice has one) opens it, as does arriving with that hash.
 * The text stays in the document while closed, so find-in-page still works in
 * browsers that search closed <details>.
 */
import { useEffect, useRef, type ReactNode } from "react";

export function MethodsDisclosure({
  id,
  summary,
  className,
  children,
}: {
  id: string;
  summary: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const hash = `#${id}`;
    const open = () => {
      if (ref.current) ref.current.open = true;
    };
    if (window.location.hash === hash) open();
    const onHash = () => {
      if (window.location.hash === hash) open();
    };
    // A second click on the same link changes no hash, so clicks are read too.
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.("a");
      if (a?.getAttribute("href") === hash) open();
    };
    window.addEventListener("hashchange", onHash);
    document.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("hashchange", onHash);
      document.removeEventListener("click", onClick);
    };
  }, [id]);
  return (
    <details ref={ref} id={id} className={className}>
      <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        {summary}
      </summary>
      {children}
    </details>
  );
}
