"use client";

import * as React from "react";

/** Scrolls the parent tab strip so the `aria-current` tab is visible (narrow screens start it off-screen). */
export function ScrollActiveTab({ activeKey }: { activeKey: string }) {
  const ref = React.useRef<HTMLSpanElement>(null);
  React.useEffect(() => {
    ref.current?.parentElement
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [activeKey]);
  return <span ref={ref} hidden />;
}
