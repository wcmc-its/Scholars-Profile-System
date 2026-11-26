/** The roster's first address (live 2026-11-25), kept as a redirect to its home under the cancer center. */
import { permanentRedirect } from "next/navigation";

import { PROGRAM_ROSTER_PATH } from "@/lib/edit/program-roster-access";

export default function OldProgramRosterPage() {
  permanentRedirect(PROGRAM_ROSTER_PATH);
}
