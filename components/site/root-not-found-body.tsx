"use client";

import { useEffect, useState } from "react";
import { NotFoundContent } from "@/components/site/not-found-content";
import { VIVO_PATTERN } from "@/lib/analytics/vivo-pattern";

/**
 * Root 404 body with the VIVO-migrant copy decided on the client. The root
 * not-found must not read `headers()` (it would force every route dynamic),
 * so the server renders the generic copy and this switches to the "profile may
 * have moved" copy after mount when the path is a legacy `/display/cwid-…`
 * URL, then focuses the search box (what `autoFocus` did when the branch was
 * decided on the server).
 */
export function RootNotFoundBody() {
  const [isVivo, setIsVivo] = useState(false);

  useEffect(() => {
    if (VIVO_PATTERN.test(window.location.pathname)) setIsVivo(true);
  }, []);

  useEffect(() => {
    if (isVivo) document.getElementById("nf-search")?.focus();
  }, [isVivo]);

  return <NotFoundContent isVivo={isVivo} />;
}
